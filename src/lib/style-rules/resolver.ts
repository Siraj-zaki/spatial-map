/**
 * Resolver — turns a (rules, bins, viewers) triple into the per-target
 * style overrides the overlays consume.
 *
 * Each rule is processed in priority order:
 *   1. Resolve the source bin set from `rule.source` (or legacy
 *      `sourceShape`, or self).
 *   2. Resolve the target shape set from `rule.target` (or legacy
 *      `targetShapeId`/`targetGridCell`, or every viewer of `scope`).
 *   3. For each target:
 *        a. Pick the bins to evaluate against:
 *           - `self` source → the target's own bin (skipped if absent).
 *           - any other source → the resolved source bin set (shared
 *             across all targets — that's the point of cross-shape
 *             rules).
 *        b. Evaluate conditions (quantified / aggregate as needed).
 *        c. On match, emit the rule's style keyed by the target.
 *   4. Rules run in ascending priority and a later match overwrites an
 *      earlier one, so per target the LAST matching rule in that order
 *      wins.
 *
 * Stadium scale (30k+ seat cells, a rule per seat state) makes this hot:
 * every bin SSE event re-runs it. So:
 *   - Rules are compiled once per rule object (`compileRuleTest`), and
 *     cell keys / own-bin lookups are prepared once per pass and shared
 *     by every rule, instead of per rule × target.
 *   - Override VALUES are shared: every hit of a rule without a label
 *     template gets the same `ResolvedStyle` object, and label hits share
 *     one object per rendered text. An unchanged cell therefore keeps the
 *     same value object from one run to the next.
 *   - The last run is remembered. When only some bins' contents changed
 *     (same rules, same shapes, same addresses), just the keys those bins
 *     drive are re-resolved and the previous maps are copied and patched.
 *     When nothing in a map changed, the previous map — or the whole
 *     previous result — is returned as-is, so downstream memos skip.
 *
 * The entries (key → style) and `count` are identical to a plain run;
 * a patched map may list a newly styled key last instead of in rule
 * order. Every consumer looks entries up by key, never by position.
 */

import type { Bin, BindingKind } from '@/lib/db'
import {
  compileLabelTemplate,
  compileRuleTest,
  sortRulesForEval,
  type CompiledRuleTest,
} from './evaluator'
import type {
  ResolvedStyle,
  SourceSelector,
  StyleRule,
  TargetSelector,
} from './types'

/** Compound key used by grid-cell overrides. */
export function gridCellKey(
  gridId: number,
  row: number,
  col: number,
  level: number,
): string {
  return `${gridId}-${row}-${col}-${level}`
}

/**
 * What an overlay receives. `gridCells` is keyed by the compound
 * string above; `shapes` is keyed by `targetKind:shapeId` so multiple
 * shape kinds can share one map without collision.
 */
export interface ResolvedStyleMaps {
  gridCells: Map<string, ResolvedStyle>
  shapes: Map<string, ResolvedStyle>
  /** Number of unique targets that got at least one rule applied. */
  count: number
}

/**
 * Full inventory of shapes currently on the canvas, used to broadcast
 * a rule to every shape of a kind (e.g. "for every polygon, when…"),
 * since text labels and stairs don't have bins to walk.
 */
export interface ViewerIndex {
  polygons: ReadonlyArray<ZonedShape>
  circles: ReadonlyArray<ZonedShape>
  lines: ReadonlyArray<ZonedShape>
  markers: ReadonlyArray<ZonedShape>
  images: ReadonlyArray<ZonedShape>
  models: ReadonlyArray<ZonedShape>
  textLabels: ReadonlyArray<ZonedShape>
  stairs: ReadonlyArray<ZonedShape>
  /** Ignored when the caller passes `gridCellsFromBins`. */
  gridCells: ReadonlyArray<CellAddress>
}

interface ZonedShape {
  id?: number
  zoneId?: number
}

interface CellAddress {
  gridId: number
  row: number
  col: number
  level: number
  zoneId?: number
}

export interface ResolveStyleOptions {
  zoneId?: number
  viewers?: ViewerIndex
  /**
   * Enumerate grid-cell targets from `bins` — every grid-cell bin with a
   * full address, in bin order, level defaulting to 0 — instead of
   * `viewers.gridCells`. That is the list both pages used to build by
   * hand on every bin change; letting the resolver walk it keeps the
   * viewer index stable across bin events.
   */
  gridCellsFromBins?: boolean
}

const EMPTY_VIEWERS: ViewerIndex = {
  polygons: [],
  circles: [],
  lines: [],
  markers: [],
  images: [],
  models: [],
  textLabels: [],
  stairs: [],
  gridCells: [],
}

type TargetKind = BindingKind | 'text-label' | 'stair'

/** Kinds a `scope: 'any'` rule enumerates, in order (grid cells go last). */
const ANY_KINDS: readonly TargetKind[] = ['polygon', 'circle', 'line', 'marker', 'image', 'model', 'text-label', 'stair']

const VIEWER_FIELDS = ['polygons', 'circles', 'lines', 'markers', 'images', 'models', 'textLabels', 'stairs'] as const

export function resolveStyleMaps(
  rules: ReadonlyArray<StyleRule>,
  bins: ReadonlyArray<Bin>,
  opts: ResolveStyleOptions = {},
): ResolvedStyleMaps {
  // Per-warehouse scoping (strict): when a warehouse is active, only
  // rules explicitly scoped to that warehouse apply — tenant-shared
  // rules (zoneId null/undefined) do NOT. When no warehouse is active,
  // only tenant-shared rules apply. Normalise null/undefined on both
  // sides so a DB null and a JS undefined compare equal.
  const compiled = compileRuleSet(rules, opts.zoneId ?? null)
  if (compiled.rules.length === 0) {
    return { gridCells: new Map(), shapes: new Map(), count: 0 }
  }
  const viewers = opts.viewers ?? EMPTY_VIEWERS
  const fromBins = opts.gridCellsFromBins === true
  const prev = lastPass
  const patched = prev ? tryPatch(prev, compiled, bins, viewers, fromBins) : null
  const next = patched ?? fullPass(compiled, bins, viewers, fromBins, prev)
  lastPass = next
  return next.result
}

// --------------------------------------------------------- compiled rules

/** How a rule enumerates its targets. */
type TargetPlan =
  | { type: 'cells' } // every addressable grid cell
  | { type: 'any' } // every shape of every kind, then every cell
  | { type: 'kind'; kind: TargetKind } // every shape of one kind
  | { type: 'inWarehouse'; kind: TargetKind; zoneId: number }
  /** One shape or one cell. `ownKey` looks up its bin (null: kinds without bins). */
  | { type: 'one'; cell: boolean; key: string; ownKey: string | null }
  | { type: 'none' }

interface CompiledRule extends CompiledRuleTest {
  rule: StyleRule
  source: SourceSelector
  plan: TargetPlan
  /** `single` / `allCellsOf` / `allOfKind` source: one bin set for every target. */
  shared: boolean
  /** Conditions exist and aren't all aggregates (see the empty-source skip). */
  skipWhenSourceEmpty: boolean
  /** The value of every hit that renders no label. */
  plain: ResolvedStyle
  /** Label template renderer; null when the rule sets no label text. */
  label: ((bin: Bin) => string) | null
  /** Rendered label → value, so equal labels share one object across runs. */
  byLabel: Map<string, ResolvedStyle>
  /** Bin → its label value (bins are immutable rows). */
  byBin: WeakMap<Bin, ResolvedStyle>
}

interface CompiledRuleSet {
  zone: number | null
  /** The enabled rules of the zone, sorted for evaluation. */
  sorted: StyleRule[]
  rules: CompiledRule[]
  timeDependent: boolean
  hasShared: boolean
}

/** A runaway label set (e.g. a timestamp template) must not grow forever. */
const MAX_LABEL_VALUES = 200_000

const ruleCache = new WeakMap<StyleRule, CompiledRule>()
const ruleSetCache = new WeakMap<ReadonlyArray<StyleRule>, Map<number | null, CompiledRuleSet>>()
let lastRuleSet: CompiledRuleSet | null = null

function compileRuleSet(rules: ReadonlyArray<StyleRule>, zone: number | null): CompiledRuleSet {
  let byZone = ruleSetCache.get(rules)
  const hit = byZone?.get(zone)
  if (hit) return hit
  const enabled = rules.filter(
    (r) =>
      r.enabled &&
      r.id !== undefined &&
      (r.zoneId ?? null) === zone,
  )
  const sorted = sortRulesForEval(enabled)
  let set: CompiledRuleSet
  // A re-listed rules array holding the same rule objects compiles to the
  // same set, so the next run can still patch the last one.
  if (lastRuleSet && lastRuleSet.zone === zone && sameItems(lastRuleSet.sorted, sorted)) {
    set = lastRuleSet
  } else {
    const compiled = sorted.map(compileRule)
    set = {
      zone,
      sorted,
      rules: compiled,
      timeDependent: compiled.some((r) => r.timeDependent),
      hasShared: compiled.some((r) => r.shared),
    }
  }
  if (!byZone) ruleSetCache.set(rules, (byZone = new Map()))
  byZone.set(zone, set)
  lastRuleSet = set
  return set
}

function compileRule(rule: StyleRule): CompiledRule {
  const cached = ruleCache.get(rule)
  if (cached) return cached
  const source = normaliseSource(rule)
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : []
  const labelText = rule.style?.labelText
  const compiled: CompiledRule = {
    ...compileRuleTest(rule),
    rule,
    source,
    plan: planTargets(normaliseTarget(rule), rule),
    // An unrecognised source type reads the target's own bin, like `self`.
    shared: source.type === 'single' || source.type === 'allCellsOf' || source.type === 'allOfKind',
    skipWhenSourceEmpty:
      conditions.length > 0 &&
      // Aggregate conditions over an empty set may still match
      // (`count` op `0`); don't skip if the rule only uses aggregates.
      !conditions.every((c) => 'type' in c && c.type === 'aggregate'),
    plain: { ruleId: rule.id!, ruleName: rule.name, style: rule.style },
    label: labelText !== undefined ? compileLabelTemplate(labelText) : null,
    byLabel: new Map(),
    byBin: new WeakMap(),
  }
  ruleCache.set(rule, compiled)
  return compiled
}

function planTargets(target: TargetSelector, rule: StyleRule): TargetPlan {
  switch (target.type) {
    case 'shape': {
      if (target.id === undefined) return { type: 'none' }
      const key = `${target.kind}:${target.id}`
      const hasBin = target.kind !== 'text-label' && target.kind !== 'stair'
      return { type: 'one', cell: false, key, ownKey: hasBin ? key : null }
    }
    case 'cell': {
      const level = target.level ?? 0
      return {
        type: 'one',
        cell: true,
        key: gridCellKey(target.gridId, target.row, target.col, level),
        ownKey: `${target.gridId}:${target.row}:${target.col}:${level}`,
      }
    }
    case 'inWarehouse':
      return { type: 'inWarehouse', kind: target.kind, zoneId: target.zoneId }
    case 'all':
      if (rule.scope === 'any') return { type: 'any' }
      // Without a viewer enumeration of every cell we fall back to
      // every cell that already has a bin (see `gridCellsFromBins`).
      if (rule.scope === 'grid-cell') return { type: 'cells' }
      return { type: 'kind', kind: rule.scope as TargetKind }
    default:
      return { type: 'none' }
  }
}

/** The value a hit of this rule writes, for a target whose source starts with `bin`. */
function styleFor(cr: CompiledRule, bin: Bin | undefined): ResolvedStyle {
  if (!cr.label || !bin) return cr.plain
  const known = cr.byBin.get(bin)
  if (known) return known
  const text = cr.label(bin)
  let value = cr.byLabel.get(text)
  if (!value) {
    if (cr.byLabel.size >= MAX_LABEL_VALUES) cr.byLabel.clear()
    value = {
      ruleId: cr.plain.ruleId,
      ruleName: cr.plain.ruleName,
      style: { ...cr.rule.style, labelText: text },
    }
    cr.byLabel.set(text, value)
  }
  cr.byBin.set(bin, value)
  return value
}

// --------------------------------------------------------- normalisation

/**
 * Read the rule's source — preferring the new `source` selector, then
 * the legacy `sourceShape`, then `self`.
 */
function normaliseSource(rule: StyleRule): SourceSelector {
  if (rule.source) return rule.source
  if (rule.sourceShape) return { type: 'single', shape: rule.sourceShape }
  return { type: 'self' }
}

/**
 * Read the rule's target — preferring the new `target` selector, then
 * the legacy `targetGridCell` / `targetShapeId`, then `all`.
 */
function normaliseTarget(rule: StyleRule): TargetSelector {
  if (rule.target) return rule.target
  if (rule.targetGridCell) {
    return {
      type: 'cell',
      gridId: rule.targetGridCell.gridId,
      row: rule.targetGridCell.row,
      col: rule.targetGridCell.col,
      level: rule.targetGridCell.level,
    }
  }
  if (rule.targetShapeId !== undefined) {
    const kind = (rule.scope === 'any' ? 'polygon' : rule.scope) as TargetKind
    return { type: 'shape', kind, id: rule.targetShapeId }
  }
  return { type: 'all' }
}

// --------------------------------------------------------- bins + targets

interface BinIndex {
  /** `kind:shapeId` → the last bin with that address. */
  byShape: Map<string, Bin>
  /** `gridId:row:col:level` → the last bin with that address. */
  byCell: Map<string, Bin>
  /** Built on demand for `allCellsOf` / `allOfKind` sources. */
  byGrid?: Map<number, Bin[]>
  byKind?: Map<BindingKind, Bin[]>
}

/** The grid-cell targets, as parallel lists. */
interface CellTargets {
  /** Output keys (`gridCellKey`). */
  keys: string[]
  /** `byCell` keys of each target's own bin. */
  ownKeys: string[]
  /** The viewer list these came from; null when enumerated from bins. */
  list: ReadonlyArray<CellAddress> | null
  /** Own keys present, built when a patch first needs it. */
  ownKeySet?: Set<string>
}

function indexBins(bins: ReadonlyArray<Bin>, cells: CellTargets | null): BinIndex {
  const byShape = new Map<string, Bin>()
  const byCell = new Map<string, Bin>()
  for (const bin of bins) {
    if (bin.targetKind === 'grid-cell') {
      if (
        bin.gridId === undefined ||
        bin.row === undefined ||
        bin.col === undefined
      ) {
        continue
      }
      const level = bin.level ?? 0
      const ownKey = `${bin.gridId}:${bin.row}:${bin.col}:${level}`
      byCell.set(ownKey, bin)
      if (cells) {
        cells.keys.push(gridCellKey(bin.gridId, bin.row, bin.col, level))
        cells.ownKeys.push(ownKey)
      }
    } else if (bin.shapeId !== undefined) {
      byShape.set(`${bin.targetKind}:${bin.shapeId}`, bin)
    }
  }
  return { byShape, byCell }
}

/** The per-grid / per-kind lists, in bin order (as the original index built them). */
function ensureGroupIndex(index: BinIndex, bins: ReadonlyArray<Bin>): void {
  if (index.byGrid && index.byKind) return
  const byGrid = new Map<number, Bin[]>()
  const byKind = new Map<BindingKind, Bin[]>()
  for (const bin of bins) {
    const arr = byKind.get(bin.targetKind) ?? []
    arr.push(bin)
    byKind.set(bin.targetKind, arr)
    if (bin.targetKind === 'grid-cell') {
      if (bin.gridId === undefined || bin.row === undefined || bin.col === undefined) continue
      const g = byGrid.get(bin.gridId) ?? []
      g.push(bin)
      byGrid.set(bin.gridId, g)
    }
  }
  index.byGrid = byGrid
  index.byKind = byKind
}

function cellsFromList(list: ReadonlyArray<CellAddress>): CellTargets {
  const keys: string[] = new Array(list.length)
  const ownKeys: string[] = new Array(list.length)
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    keys[i] = gridCellKey(c.gridId, c.row, c.col, c.level)
    ownKeys[i] = `${c.gridId}:${c.row}:${c.col}:${c.level}`
  }
  return { keys, ownKeys, list }
}

function sameCellList(a: ReadonlyArray<CellAddress>, b: ReadonlyArray<CellAddress>): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (x.gridId !== y.gridId || x.row !== y.row || x.col !== y.col || x.level !== y.level) return false
  }
  return true
}

function resolveSourceBins(source: SourceSelector, index: BinIndex, bins: ReadonlyArray<Bin>): ReadonlyArray<Bin> {
  switch (source.type) {
    case 'self':
      return [] // handled per-target
    case 'single': {
      const link = source.shape
      const hit =
        link.kind === 'grid-cell'
          ? index.byCell.get(`${link.gridId}:${link.row}:${link.col}:${link.level ?? 0}`)
          : index.byShape.get(`${link.kind}:${link.shapeId}`)
      return hit ? [hit] : []
    }
    case 'allCellsOf':
      ensureGroupIndex(index, bins)
      return index.byGrid!.get(source.gridId) ?? []
    case 'allOfKind':
      // The bin row doesn't carry zoneId today, so warehouse scoping
      // (`source.zoneId`) can't be enforced inside the resolver. Callers
      // that need this should filter the `bins` argument before passing it in.
      ensureGroupIndex(index, bins)
      return index.byKind!.get(source.kind) ?? []
    default:
      return []
  }
}

function shapesOfKind(
  kind: TargetKind,
  viewers: ViewerIndex,
): ReadonlyArray<ZonedShape> {
  switch (kind) {
    case 'polygon':    return viewers.polygons
    case 'circle':     return viewers.circles
    case 'line':       return viewers.lines
    case 'marker':     return viewers.markers
    case 'image':      return viewers.images
    case 'model':      return viewers.models
    case 'text-label': return viewers.textLabels
    case 'stair':      return viewers.stairs
    default:           return []
  }
}

// --------------------------------------------------------- full pass

/** Which shapes of a kind a rule targets: all, or those whose `zoneId` equals this one's. */
type ZoneFilter = { zoneId: number | undefined }
const ANY_ZONE: ZoneFilter = { zoneId: undefined }

/** A shared-source rule's outcome for a run: the value its targets get, or null. */
type SharedOutcome = ResolvedStyle | null

/** Everything a later run needs to patch this one. */
interface PassState {
  compiled: CompiledRuleSet
  bins: ReadonlyArray<Bin>
  viewers: ViewerIndex
  fromBins: boolean
  cells: CellTargets
  index: BinIndex
  /** Per rule (same order as `compiled.rules`); unused for self rules. */
  shared: SharedOutcome[]
  result: ResolvedStyleMaps
  /** `kind:id` keys of each kind's shapes, built when a patch first needs them. */
  shapeKeys?: Map<string, Set<string>>
}

let lastPass: PassState | null = null

function fullPass(
  compiled: CompiledRuleSet,
  bins: ReadonlyArray<Bin>,
  viewers: ViewerIndex,
  fromBins: boolean,
  prev: PassState | null,
): PassState {
  const viewerCells = viewers.gridCells ?? []
  // Reuse the previous run's index and cell enumeration when they still
  // describe these bins / cells (e.g. only the rules changed).
  let index: BinIndex
  let cells: CellTargets
  if (prev && prev.bins === bins && prev.fromBins === fromBins && (fromBins || sameCellList(prev.cells.list!, viewerCells))) {
    index = prev.index
    cells = prev.cells
  } else if (fromBins) {
    cells = { keys: [], ownKeys: [], list: null }
    index = indexBins(bins, cells)
  } else {
    index = prev && prev.bins === bins ? prev.index : indexBins(bins, null)
    cells = prev && !prev.fromBins && sameCellList(prev.cells.list!, viewerCells) ? prev.cells : cellsFromList(viewerCells)
  }

  const gridCells = new Map<string, ResolvedStyle>()
  const shapes = new Map<string, ResolvedStyle>()
  const shared: SharedOutcome[] = new Array(compiled.rules.length).fill(null)

  // Own bins of the cell targets, looked up once for every rule.
  let cellOwn: (Bin | undefined)[] | null = null
  const ownOfCells = () => {
    if (!cellOwn) {
      const { ownKeys } = cells
      cellOwn = new Array(ownKeys.length)
      for (let i = 0; i < ownKeys.length; i++) cellOwn[i] = index.byCell.get(ownKeys[i])
    }
    return cellOwn
  }

  const writeCells = (cr: CompiledRule, value: SharedOutcome) => {
    const { keys } = cells
    if (cr.shared) {
      if (value) for (let i = 0; i < keys.length; i++) gridCells.set(keys[i], value)
      return
    }
    const own = ownOfCells()
    for (let i = 0; i < keys.length; i++) {
      const bin = own[i]
      if (bin === undefined || !cr.testOne(bin)) continue
      gridCells.set(keys[i], styleFor(cr, bin))
    }
  }

  const writeShape = (cr: CompiledRule, value: SharedOutcome, key: string, ownKey: string | null) => {
    if (cr.shared) {
      if (value) shapes.set(key, value)
      return
    }
    if (ownKey === null) return
    const bin = index.byShape.get(ownKey)
    if (bin === undefined || !cr.testOne(bin)) return
    shapes.set(key, styleFor(cr, bin))
  }

  const writeKind = (cr: CompiledRule, value: SharedOutcome, kind: TargetKind, zone: ZoneFilter = ANY_ZONE) => {
    const hasBin = kind !== 'text-label' && kind !== 'stair'
    for (const s of shapesOfKind(kind, viewers)) {
      if (s.id === undefined) continue
      if (zone !== ANY_ZONE && s.zoneId !== zone.zoneId) continue
      const key = `${kind}:${s.id}`
      writeShape(cr, value, key, hasBin ? key : null)
    }
  }

  for (let r = 0; r < compiled.rules.length; r++) {
    const cr = compiled.rules[r]
    let value: SharedOutcome = null
    if (cr.shared) {
      // For sources that don't depend on the target (everything except
      // `self`), resolve the bin set once and share it across every
      // target.
      const source = resolveSourceBins(cr.source, index, bins)
      // Skip the rule entirely when the source can never produce data —
      // e.g. linked to a shape that doesn't exist.
      if (source.length === 0 && cr.skipWhenSourceEmpty) continue
      if (cr.test(source)) value = styleFor(cr, source[0])
      shared[r] = value
      if (!value) continue
    }
    const plan = cr.plan
    switch (plan.type) {
      case 'cells':
        writeCells(cr, value)
        break
      case 'any':
        for (const kind of ANY_KINDS) writeKind(cr, value, kind)
        writeCells(cr, value)
        break
      case 'kind':
        writeKind(cr, value, plan.kind)
        break
      case 'inWarehouse':
        writeKind(cr, value, plan.kind, plan)
        break
      case 'one':
        if (plan.cell) {
          if (cr.shared) gridCells.set(plan.key, value!)
          else {
            const bin = plan.ownKey === null ? undefined : index.byCell.get(plan.ownKey)
            if (bin !== undefined && cr.testOne(bin)) gridCells.set(plan.key, styleFor(cr, bin))
          }
        } else {
          writeShape(cr, value, plan.key, plan.ownKey)
        }
        break
      case 'none':
        break
    }
  }

  // Hand back the previous maps when nothing in them changed.
  const prevResult = prev?.result
  const sameCells = prevResult !== undefined && sameEntries(prevResult.gridCells, gridCells)
  const sameShapes = prevResult !== undefined && sameEntries(prevResult.shapes, shapes)
  const result =
    sameCells && sameShapes
      ? prevResult!
      : {
          gridCells: sameCells ? prevResult!.gridCells : gridCells,
          shapes: sameShapes ? prevResult!.shapes : shapes,
          count: gridCells.size + shapes.size,
        }
  return { compiled, bins, viewers, fromBins, cells, index, shared, result }
}

/** Same keys, each with the same value object. */
function sameEntries(a: Map<string, ResolvedStyle>, b: Map<string, ResolvedStyle>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of b) if (a.get(k) !== v) return false
  return true
}

function sameItems<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// --------------------------------------------------------- patch

/** More changed bins than this share of all bins: a full pass is cheaper. */
const PATCH_MAX_SHARE = 0.25

/**
 * Re-resolve only the keys whose own bin changed, when that provably
 * gives the same entries as a full pass: same compiled rules (none
 * reading the clock), same shapes, same cell targets, same bin
 * addresses, and no changed bin inside a shared source. Returns null to
 * ask for a full pass.
 */
function tryPatch(
  prev: PassState,
  compiled: CompiledRuleSet,
  bins: ReadonlyArray<Bin>,
  viewers: ViewerIndex,
  fromBins: boolean,
): PassState | null {
  if (prev.compiled !== compiled || compiled.timeDependent || prev.fromBins !== fromBins) return null
  if (prev.viewers !== viewers) {
    for (const f of VIEWER_FIELDS) if (prev.viewers[f] !== viewers[f]) return null
    if (!fromBins && !sameCellList(prev.cells.list!, viewers.gridCells ?? [])) return null
  }
  const before = prev.bins
  if (before === bins) return { ...prev, viewers }
  if (before.length !== bins.length) return null

  const changed: number[] = []
  const limit = Math.max(16, bins.length * PATCH_MAX_SHARE)
  for (let i = 0; i < bins.length; i++) {
    if (before[i] === bins[i]) continue
    const o = before[i]
    const n = bins[i]
    // A moved or re-kinded bin changes which targets exist: full pass.
    if (
      o.targetKind !== n.targetKind ||
      o.gridId !== n.gridId ||
      o.row !== n.row ||
      o.col !== n.col ||
      o.level !== n.level ||
      o.shapeId !== n.shapeId
    ) {
      return null
    }
    changed.push(i)
    if (changed.length > limit) return null
  }
  if (compiled.hasShared) {
    for (const i of changed) if (inSharedSource(compiled, bins[i])) return null
  }

  const index = prev.index
  // The per-grid / per-kind lists still hold the old objects; only shared
  // sources read them, so drop them and let the next full pass rebuild.
  index.byGrid = undefined
  index.byKind = undefined
  const cellKeys = new Map<string, string>() // own key → output key
  const shapeKeys = new Map<string, TargetKind>() // `kind:id` → kind
  for (const i of changed) {
    const o = before[i]
    const n = bins[i]
    if (n.targetKind === 'grid-cell') {
      if (n.gridId === undefined || n.row === undefined || n.col === undefined) continue
      const level = n.level ?? 0
      const ownKey = `${n.gridId}:${n.row}:${n.col}:${level}`
      // A duplicate address that isn't the effective bin drives nothing.
      if (index.byCell.get(ownKey) !== o) continue
      index.byCell.set(ownKey, n)
      cellKeys.set(ownKey, gridCellKey(n.gridId, n.row, n.col, level))
    } else if (n.shapeId !== undefined) {
      const key = `${n.targetKind}:${n.shapeId}`
      if (index.byShape.get(key) !== o) continue
      index.byShape.set(key, n)
      shapeKeys.set(key, n.targetKind)
    }
  }

  const state: PassState = { ...prev, bins, viewers, index }
  let gridCells: Map<string, ResolvedStyle> | null = null
  let shapes: Map<string, ResolvedStyle> | null = null
  const prevCells = prev.result.gridCells
  const prevShapes = prev.result.shapes

  for (const [ownKey, key] of cellKeys) {
    const value = resolveCell(state, ownKey)
    if (value === prevCells.get(key)) continue
    gridCells ??= new Map(prevCells)
    if (value) gridCells.set(key, value)
    else gridCells.delete(key)
  }
  for (const [key, kind] of shapeKeys) {
    const value = resolveShape(state, key, kind)
    if (value === prevShapes.get(key)) continue
    shapes ??= new Map(prevShapes)
    if (value) shapes.set(key, value)
    else shapes.delete(key)
  }
  if (gridCells || shapes) {
    const g = gridCells ?? prevCells
    const s = shapes ?? prevShapes
    state.result = { gridCells: g, shapes: s, count: g.size + s.size }
  }
  return state
}

/** Could this bin be part of a shared (non-self) source of any rule? */
function inSharedSource(compiled: CompiledRuleSet, bin: Bin): boolean {
  for (const cr of compiled.rules) {
    if (!cr.shared) continue
    const s = cr.source
    switch (s.type) {
      case 'single': {
        const link = s.shape
        if (link.kind === 'grid-cell') {
          if (
            bin.targetKind === 'grid-cell' &&
            `${link.gridId}:${link.row}:${link.col}:${link.level ?? 0}` === `${bin.gridId}:${bin.row}:${bin.col}:${bin.level ?? 0}`
          ) {
            return true
          }
        } else if (`${link.kind}:${link.shapeId}` === `${bin.targetKind}:${bin.shapeId}`) {
          return true
        }
        break
      }
      case 'allCellsOf':
        if (bin.targetKind === 'grid-cell' && bin.gridId === s.gridId) return true
        break
      case 'allOfKind':
        if (bin.targetKind === s.kind) return true
        break
      default:
        return true
    }
  }
  return false
}

/** The last rule (in evaluation order) that writes the cell with this own key, as a full pass would. */
function resolveCell(state: PassState, ownKey: string): ResolvedStyle | undefined {
  const own = state.index.byCell.get(ownKey)
  const enumerated = state.fromBins || cellOwnKeys(state.cells).has(ownKey)
  let value: ResolvedStyle | undefined
  const rules = state.compiled.rules
  for (let r = 0; r < rules.length; r++) {
    const cr = rules[r]
    const plan = cr.plan
    const targeted =
      plan.type === 'cells' || plan.type === 'any'
        ? enumerated
        : plan.type === 'one' && plan.cell && plan.ownKey === ownKey
    if (!targeted) continue
    if (cr.shared) {
      if (state.shared[r]) value = state.shared[r]!
    } else if (own !== undefined && cr.testOne(own)) {
      value = styleFor(cr, own)
    }
  }
  return value
}

/** The last rule (in evaluation order) that writes this shape key, as a full pass would. */
function resolveShape(state: PassState, key: string, kind: TargetKind): ResolvedStyle | undefined {
  const own = kind === 'text-label' || kind === 'stair' ? undefined : state.index.byShape.get(key)
  let value: ResolvedStyle | undefined
  const rules = state.compiled.rules
  for (let r = 0; r < rules.length; r++) {
    const cr = rules[r]
    const plan = cr.plan
    let targeted: boolean
    switch (plan.type) {
      case 'any':
        targeted = ANY_KINDS.includes(kind) && shapeKeySet(state, kind).has(key)
        break
      case 'kind':
        targeted = plan.kind === kind && shapeKeySet(state, kind).has(key)
        break
      case 'inWarehouse':
        targeted = plan.kind === kind && shapeKeySet(state, kind, plan).has(key)
        break
      case 'one':
        targeted = !plan.cell && plan.key === key
        break
      default:
        targeted = false
    }
    if (!targeted) continue
    if (cr.shared) {
      if (state.shared[r]) value = state.shared[r]!
    } else if (own !== undefined && cr.testOne(own)) {
      value = styleFor(cr, own)
    }
  }
  return value
}

function cellOwnKeys(cells: CellTargets): Set<string> {
  return (cells.ownKeySet ??= new Set(cells.ownKeys))
}

/** `kind:id` keys of the kind's shapes (optionally only those in one warehouse). */
function shapeKeySet(state: PassState, kind: TargetKind, zone: ZoneFilter = ANY_ZONE): Set<string> {
  const cacheKey = zone === ANY_ZONE ? kind : `${kind}@${zone.zoneId}`
  const cache = (state.shapeKeys ??= new Map())
  let set = cache.get(cacheKey)
  if (!set) {
    set = new Set()
    for (const s of shapesOfKind(kind, state.viewers)) {
      if (s.id === undefined) continue
      if (zone !== ANY_ZONE && s.zoneId !== zone.zoneId) continue
      set.add(`${kind}:${s.id}`)
    }
    cache.set(cacheKey, set)
  }
  return set
}
