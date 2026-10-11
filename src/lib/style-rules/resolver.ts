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
 *   4. First-priority match wins per target.
 */

import type { Bin, BindingKind } from '@/lib/db'
import {
  evaluateRule,
  renderLabelTemplate,
  sortRulesForEval,
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
  gridCells: ReadonlyArray<{ gridId: number; row: number; col: number; level: number; zoneId?: number }>
}

interface ZonedShape {
  id?: number
  zoneId?: number
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

export function resolveStyleMaps(
  rules: ReadonlyArray<StyleRule>,
  bins: ReadonlyArray<Bin>,
  opts: { zoneId?: number; viewers?: ViewerIndex } = {},
): ResolvedStyleMaps {
  // Per-warehouse scoping (strict): when a warehouse is active, only
  // rules explicitly scoped to that warehouse apply — tenant-shared
  // rules (zoneId null/undefined) do NOT. When no warehouse is active,
  // only tenant-shared rules apply. Normalise null/undefined on both
  // sides so a DB null and a JS undefined compare equal.
  const activeZone = opts.zoneId ?? null
  const enabled = rules.filter(
    (r) =>
      r.enabled &&
      r.id !== undefined &&
      (r.zoneId ?? null) === activeZone,
  )
  const gridCells = new Map<string, ResolvedStyle>()
  const shapes = new Map<string, ResolvedStyle>()
  let count = 0
  if (enabled.length === 0) {
    return { gridCells, shapes, count }
  }

  const viewers = opts.viewers ?? EMPTY_VIEWERS
  const binIndex = indexBins(bins)
  const sorted = sortRulesForEval(enabled)

  for (const rule of sorted) {
    const source = normaliseSource(rule)
    const target = normaliseTarget(rule)

    // For sources that don't depend on the target (everything except
    // `self`), resolve the bin set once and share it across every
    // target. For `self`, we look up per-target inside the loop.
    const sharedSource: ReadonlyArray<Bin> | null =
      source.type === 'self' ? null : resolveSourceBins(source, binIndex)

    // Skip the rule entirely when the source can never produce data —
    // e.g. linked to a shape that doesn't exist. Without a source the
    // condition has nothing to evaluate against and `self` rules need
    // per-target bins anyway, handled inside the loop.
    if (source.type !== 'self' && sharedSource && sharedSource.length === 0 && rule.conditions.length > 0) {
      // Aggregate conditions over an empty set may still match
      // (`count` op `0`); don't skip if the rule only uses aggregates.
      const allAggregate = rule.conditions.every(
        (c) => 'type' in c && c.type === 'aggregate',
      )
      if (!allAggregate) continue
    }

    const targets = resolveTargets(target, rule, viewers)
    for (const t of targets) {
      const sourceBins =
        sharedSource ?? ownBinForTarget(t, binIndex)
      if (!sourceBins) continue
      if (!evaluateRule(rule, sourceBins)) continue
      const representativeBin = sourceBins[0]
      const renderedStyle =
        rule.style.labelText !== undefined && representativeBin
          ? {
              ...rule.style,
              labelText: renderLabelTemplate(rule.style.labelText, representativeBin),
            }
          : rule.style
      const resolved: ResolvedStyle = {
        ruleId: rule.id!,
        ruleName: rule.name,
        style: renderedStyle,
      }
      writeResolved(t, resolved, gridCells, shapes, () => count++)
    }
  }

  return { gridCells, shapes, count }
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

// --------------------------------------------------------- source resolution

interface BinIndex {
  byShape: Map<string, Bin>
  byCell: Map<string, Bin>
  byGrid: Map<number, Bin[]>
  byKind: Map<BindingKind, Bin[]>
}

function indexBins(bins: ReadonlyArray<Bin>): BinIndex {
  const byShape = new Map<string, Bin>()
  const byCell = new Map<string, Bin>()
  const byGrid = new Map<number, Bin[]>()
  const byKind = new Map<BindingKind, Bin[]>()
  for (const bin of bins) {
    const arr = byKind.get(bin.targetKind) ?? []
    arr.push(bin)
    byKind.set(bin.targetKind, arr)
    if (bin.targetKind === 'grid-cell') {
      if (
        bin.gridId === undefined ||
        bin.row === undefined ||
        bin.col === undefined
      ) {
        continue
      }
      byCell.set(`${bin.gridId}:${bin.row}:${bin.col}:${bin.level ?? 0}`, bin)
      const g = byGrid.get(bin.gridId) ?? []
      g.push(bin)
      byGrid.set(bin.gridId, g)
    } else if (bin.shapeId !== undefined) {
      byShape.set(`${bin.targetKind}:${bin.shapeId}`, bin)
    }
  }
  return { byShape, byCell, byGrid, byKind }
}

function resolveSourceBins(source: SourceSelector, index: BinIndex): Bin[] {
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
      return index.byGrid.get(source.gridId) ?? []
    case 'allOfKind': {
      const list = index.byKind.get(source.kind) ?? []
      if (source.zoneId === undefined) return list
      // The bin row doesn't carry zoneId today, so warehouse scoping
      // can't be enforced inside the resolver. Callers that need this
      // should filter the `bins` argument before passing it in.
      return list
    }
  }
}

// --------------------------------------------------------- target resolution

interface ResolvedTarget {
  kind: TargetKind
  id?: number
  cell?: { gridId: number; row: number; col: number; level: number }
}

function resolveTargets(
  target: TargetSelector,
  rule: StyleRule,
  viewers: ViewerIndex,
): ResolvedTarget[] {
  switch (target.type) {
    case 'shape':
      return [{ kind: target.kind, id: target.id }]
    case 'cell':
      return [
        {
          kind: 'grid-cell',
          cell: {
            gridId: target.gridId,
            row: target.row,
            col: target.col,
            level: target.level ?? 0,
          },
        },
      ]
    case 'inWarehouse':
      return shapesOfKind(target.kind, viewers)
        .filter((s) => s.zoneId === target.zoneId)
        .map((s) => ({ kind: target.kind, id: s.id! }))
    case 'all': {
      if (rule.scope === 'any') {
        const kinds: TargetKind[] = ['polygon', 'circle', 'line', 'marker', 'image', 'model', 'text-label', 'stair']
        const out: ResolvedTarget[] = []
        for (const k of kinds) {
          for (const s of shapesOfKind(k, viewers)) {
            if (s.id !== undefined) out.push({ kind: k, id: s.id })
          }
        }
        for (const c of viewers.gridCells) {
          out.push({ kind: 'grid-cell', cell: c })
        }
        return out
      }
      if (rule.scope === 'grid-cell') {
        // Without a viewer enumeration of every cell we fall back to
        // every cell that already has a bin. Callers wanting empty
        // cells covered should feed `viewers.gridCells` from the grid
        // generator.
        return viewers.gridCells.map((c) => ({ kind: 'grid-cell', cell: c }))
      }
      const list = shapesOfKind(rule.scope, viewers)
      return list
        .filter((s) => s.id !== undefined)
        .map((s) => ({ kind: rule.scope as TargetKind, id: s.id }))
    }
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
    case 'grid-cell':  return []
  }
}

function ownBinForTarget(t: ResolvedTarget, index: BinIndex): Bin[] | null {
  if (t.kind === 'grid-cell' && t.cell) {
    const hit = index.byCell.get(`${t.cell.gridId}:${t.cell.row}:${t.cell.col}:${t.cell.level}`)
    return hit ? [hit] : null
  }
  if (t.kind === 'text-label' || t.kind === 'stair') return null
  if (t.id === undefined) return null
  const hit = index.byShape.get(`${t.kind}:${t.id}`)
  return hit ? [hit] : null
}

function writeResolved(
  t: ResolvedTarget,
  resolved: ResolvedStyle,
  gridCells: Map<string, ResolvedStyle>,
  shapes: Map<string, ResolvedStyle>,
  bump: () => void,
): void {
  if (t.kind === 'grid-cell' && t.cell) {
    const key = gridCellKey(t.cell.gridId, t.cell.row, t.cell.col, t.cell.level)
    if (!gridCells.has(key)) bump()
    gridCells.set(key, resolved)
    return
  }
  if (t.id === undefined) return
  const key = `${t.kind}:${t.id}`
  if (!shapes.has(key)) bump()
  shapes.set(key, resolved)
}
