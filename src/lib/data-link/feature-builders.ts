/**
 * Pure GeoJSON builders for every MapDataLinkedOverlay render mode.
 *
 * Moved out of `map-data-linked-overlay.tsx` so the React side only does
 * Mapbox glue, and so each builder can be checked against its previous
 * inline version in a plain node harness. The feature objects, property
 * order and values are exactly what the inline code produced.
 *
 * Two things are new, both invisible in the output:
 *
 *   - Rules are compiled once per (rule array, config) via
 *     `compileEntityRules` instead of re-filtering and re-sorting the rule
 *     catalog for every row.
 *   - The point / badge / heatmap / cone builders take an optional
 *     `RowBuildCache`. With it, a row whose object is unchanged since the
 *     last push (the overlay keeps unchanged rows' identity across
 *     refetches and playback frames) reuses its features — the same
 *     objects — instead of re-resolving its anchor, re-running its rules
 *     and re-stringifying its payload. The cache is dropped whenever any
 *     other input changes (config, rules, shapes, floor scope), and is
 *     bypassed entirely while a rule reads the clock (`olderThan` /
 *     `newerThan`), so a cached row never shows a stale answer.
 *
 * Focus mode (src/lib/focus/) adds three optional inputs, all inert when
 * unset — the builders then return exactly what they did before:
 *
 *   - `focusedKey`: the one row the user asked to see. It passes the
 *     layer filter and the floor gate, is never treated as occluded, and
 *     its features are stamped `focused: true` (a cached copy, so every
 *     other row keeps its feature object). `focusedAnchorOf` reads back
 *     where it was drawn.
 *   - `ghosts` (point modes only): occluded rows are kept, stamped
 *     `occluded: true`, instead of being left out.
 *   - `near` (unclustered point modes only): the focused item's NEAR
 *     column. A row whose drawn point lies in it (`isFocusNearPoint`) is
 *     stamped `focusNear: true`, again on a cached copy, so it fades
 *     instead of crowding the item. Aggregates (clusters, heatmap, tints,
 *     cones, roi rings, tracks) are never stamped.
 */

import type {
  DataLinkConfig,
  DataLinkFilter,
  ElevationSpec,
  EntityEvent,
  EntityState,
} from '@/lib/db'
import type { StyleRule } from '@/lib/style-rules'
import type {
  CircleShape,
  ImageShape,
  LineShape,
  MarkerShape,
  ModelShape,
  PolygonShape,
  StairShape,
  TextLabelShape,
} from '@/lib/shapes'
import { FLAT_SLAB_BASE_M, FLAT_SLAB_THICKNESS_M, POLYGON_MIN_BASE_M, polygonCentroid } from '@/lib/polygon-generators'
import { lineCentroid } from '@/lib/line-generators'
import { buildCircleFeatures } from '@/lib/circle-generators'
import {
  compileEntityRules,
  resolveLabelTemplate,
  type CompiledEntityRules,
} from '@/lib/data-link/style-rule-evaluator'
import {
  EMPTY_MATCH_SNAPSHOT,
  effectiveMatch,
  readPayloadPath,
  resolveMatchTargets,
  resolvePayloadCoord,
  type MatchableShape,
  type MatchStoreSnapshot,
} from '@/lib/data-link/match-resolver'
import {
  evaluateDataLinkFilter,
  passesFloorScope,
  resolveEntityFloor,
  shapeOnEntityFloor,
  type ActiveFloors,
} from '@/lib/data-link/filter-evaluator'
import { isFocusNearPoint, type FocusNearRegion } from '@/lib/focus/focus-near'
import type { DlAnchor } from '@/lib/focus/focus-target'
import { mapboxImageIdFor } from '@/lib/data-link/lucide-icon-sprites'
import type { TableRowEvent } from '@/lib/data-link/table-events-client'

// ---------------------------------------------------------------------------
// Row cache
// ---------------------------------------------------------------------------

/**
 * Per-sub-renderer cache of per-row build results, keyed by row object.
 * `rowsFor(tokens)` hands back the row map for one set of inputs; when any
 * token is a different object than last time, the map starts empty.
 */
export interface RowBuildCache<R> {
  rowsFor: (tokens: readonly unknown[]) => WeakMap<object, R>
  /**
   * A second, independent slot with the same contract: the focused row's
   * build with the floor gate lifted (focus mode), so it never evicts the
   * main slot's entries.
   */
  focusRowsFor: (tokens: readonly unknown[]) => WeakMap<object, R>
}

function tokenSlot<R>(): (next: readonly unknown[]) => WeakMap<object, R> {
  let tokens: readonly unknown[] | null = null
  let rows = new WeakMap<object, R>()
  return (next) => {
    const same =
      tokens !== null &&
      tokens.length === next.length &&
      tokens.every((t, i) => t === next[i])
    if (!same) {
      tokens = next
      rows = new WeakMap()
    }
    return rows
  }
}

export function createRowBuildCache<R>(): RowBuildCache<R> {
  return { rowsFor: tokenSlot<R>(), focusRowsFor: tokenSlot<R>() }
}

// ---------------------------------------------------------------------------
// Focus mode: the focused row, ghost rows and NEAR rows
// ---------------------------------------------------------------------------

/** Where a focused feature was drawn, recorded when it is stamped. */
interface FocusDrawInfo {
  position: [number, number]
  elevationM: number
  /** The bound shape's floor, for shape-anchored modes. */
  shapeFloor: number | null
  payload: Record<string, unknown>
}

const focusedVariants = new WeakMap<GeoJSON.Feature, GeoJSON.Feature>()
const ghostVariants = new WeakMap<GeoJSON.Feature, GeoJSON.Feature>()
const nearVariants = new WeakMap<GeoJSON.Feature, GeoJSON.Feature>()
const focusDrawInfo = new WeakMap<GeoJSON.Feature, FocusDrawInfo>()

/**
 * `f` stamped `focused: true` — one cached copy per feature object, so a
 * row going in and out of focus hands the diff writer the same two
 * objects, and every other row keeps its own.
 */
function markFocused<F extends GeoJSON.Feature>(f: F, info: FocusDrawInfo): F {
  let v = focusedVariants.get(f)
  if (!v) {
    v = { ...f, properties: { ...f.properties, focused: true } }
    focusedVariants.set(f, v)
  }
  focusDrawInfo.set(v, info)
  return v as F
}

/** `f` stamped `occluded: true` (ghost mode), cached per feature object. */
function ghostOf<F extends GeoJSON.Feature>(f: F): F {
  let v = ghostVariants.get(f)
  if (!v) {
    v = { ...f, properties: { ...f.properties, occluded: true } }
    ghostVariants.set(f, v)
  }
  return v as F
}

/**
 * `f` stamped `focusNear: true`, cached per feature object. A ghost copy is
 * its own key, so a row that is both comes out `occluded` + `focusNear`
 * from a separate entry, and the plain copy is never touched.
 */
function nearOf<F extends GeoJSON.Feature>(f: F): F {
  let v = nearVariants.get(f)
  if (!v) {
    v = { ...f, properties: { ...f.properties, focusNear: true } }
    nearVariants.set(f, v)
  }
  return v as F
}

/**
 * `f`, or its `focusNear` copy when its drawn point lies in the focused
 * item's NEAR column (`isFocusNearPoint` on the point and its
 * `elevation`). `f` itself when `near` is null (focus off, no column) or
 * `f` is not a point.
 */
function withNear<F extends GeoJSON.Feature>(f: F, near: FocusNearRegion | null): F {
  if (near === null) return f
  const g: GeoJSON.Geometry | null = f.geometry
  if (g === null || g.type !== 'Point') return f
  const c = g.coordinates
  return isFocusNearPoint(near, [c[0], c[1]], Number(f.properties?.elevation) || 0) ? nearOf(f) : f
}

/** Stamp a feature this push built itself (aggregates: tint, roi). */
function stampFocused<F extends GeoJSON.Feature>(f: F, info: FocusDrawInfo): F {
  f.properties = { ...f.properties, focused: true }
  focusDrawInfo.set(f, info)
  return f
}

function elevationOf(f: GeoJSON.Feature): number {
  const z = Number(f.properties?.elevation ?? 0)
  return Number.isFinite(z) ? z : 0
}

/**
 * The floor a focused row is drawn on: the bound shape's floor when it is
 * drawn on a shape, else the payload's (the `floorScope` value map, then
 * `floorPlanId` / `floorId` / `floor`), an orphan id counting as unknown,
 * else the one floor a `specific` scope names.
 */
export function anchorFloorPlanId(
  payload: Record<string, unknown>,
  config: DataLinkConfig,
  liveFloorPlanIds: ReadonlySet<number> | undefined,
  shapeFloor: number | null,
): number | null {
  if (shapeFloor !== null) return shapeFloor
  const scope = config.fieldMapping.floorScope
  let floor = resolveEntityFloor(payload, null, { field: scope?.field, valueMap: scope?.valueMap })
  if (floor !== null && liveFloorPlanIds && liveFloorPlanIds.size > 0 && !liveFloorPlanIds.has(floor)) {
    floor = null
  }
  if (floor === null && scope?.mode === 'specific' && scope.floorPlanIds?.length === 1) {
    floor = scope.floorPlanIds[0] ?? null
  }
  return floor
}

/**
 * Where the focused row was drawn in `features` (the first feature a
 * builder stamped `focused`), or null when none of them is.
 */
export function focusedAnchorOf(
  features: readonly GeoJSON.Feature[],
  config: DataLinkConfig,
  liveFloorPlanIds: ReadonlySet<number> | undefined,
): DlAnchor | null {
  for (const f of features) {
    const info = focusDrawInfo.get(f)
    if (!info) continue
    return {
      position: info.position,
      elevationM: info.elevationM,
      floorPlanId: anchorFloorPlanId(info.payload, config, liveFloorPlanIds, info.shapeFloor),
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Match snapshot narrowing
// ---------------------------------------------------------------------------

/**
 * True when resolving this config can read `snapshot.bins`: a `bin.*`
 * shape side (`external-code`, or an attribute-join on
 * `bin.externalCode` / `bin.customProp`). Every other mode reads only
 * the `targetKind` slice (`shapesForKind`), or nothing (coord).
 */
export function matchReadsBins(config: DataLinkConfig): boolean {
  const match = effectiveMatch(config)
  return (
    match.mode === 'external-code' ||
    (match.mode === 'attribute-join' &&
      (match.join?.shapeFieldSource ?? '').startsWith('bin.'))
  )
}

/**
 * A snapshot holding `shapes` in `kind`'s slot and `bins`, empty
 * elsewhere — everything `resolveMatchTargets` reads for a config of
 * that `targetKind`, so it resolves exactly as against the full store.
 * Lets the overlay subscribe to (and re-push on) just those slices.
 */
export function narrowMatchSnapshot(
  kind: DataLinkConfig['targetKind'],
  shapes: readonly MatchableShape[],
  bins: MatchStoreSnapshot['bins'],
): MatchStoreSnapshot {
  const base: MatchStoreSnapshot = { ...EMPTY_MATCH_SNAPSHOT, bins }
  switch (kind) {
    case 'polygon':    return { ...base, polygons: shapes as readonly PolygonShape[] }
    case 'circle':     return { ...base, circles: shapes as readonly CircleShape[] }
    case 'marker':     return { ...base, markers: shapes as readonly MarkerShape[] }
    case 'line':       return { ...base, lines: shapes as readonly LineShape[] }
    case 'stair':      return { ...base, stairs: shapes as readonly StairShape[] }
    case 'door':       return { ...base, doors: shapes as MatchStoreSnapshot['doors'] }
    case 'image':      return { ...base, images: shapes as readonly ImageShape[] }
    case 'model':      return { ...base, models: shapes as readonly ModelShape[] }
    case 'text-label': return { ...base, textLabels: shapes as readonly TextLabelShape[] }
    default:           return base
  }
}

/**
 * Whether the shapes a config of this `targetKind` binds to have arrived
 * (a non-empty slice; the store and share payloads load a kind at once),
 * or the config doesn't bind to shapes at all. Until then a row that
 * resolves to no anchor may only be waiting for its shape — focus mode
 * doesn't report it as "not drawn" yet.
 */
export function matchShapesLoaded(
  config: DataLinkConfig,
  snapshot: MatchStoreSnapshot,
): boolean {
  if (effectiveMatch(config).mode === 'coord') return true
  switch (config.targetKind) {
    case 'polygon':    return snapshot.polygons.length > 0
    case 'circle':     return snapshot.circles.length > 0
    case 'marker':     return snapshot.markers.length > 0
    case 'line':       return snapshot.lines.length > 0
    case 'stair':      return snapshot.stairs.length > 0
    case 'door':       return snapshot.doors.length > 0
    case 'image':      return snapshot.images.length > 0
    case 'model':      return snapshot.models.length > 0
    case 'text-label': return snapshot.textLabels.length > 0
    default:           return true
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (unchanged from the overlay)
// ---------------------------------------------------------------------------

/**
 * Coerce a payload coord value to a finite number, or `undefined` when
 * the value can't be parsed. Handles the three common cases: native
 * number, numeric string (`"-121.76"` — how file-imported rows land in
 * `data_source_rows.payload`), and missing / non-numeric values.
 */
export function coerceCoord(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * v5.4 — adapt a `data_source_row_events` list to the `EntityState`
 * shape the heatmap sub-renderer already consumes, so the history vs
 * live source swap is invisible to the render code. `entityKey` is
 * preserved so tooltips still identify the record; `payload` is the
 * per-event snapshot so lng/lat & style-rule inputs come out of it
 * unchanged. `streamId` is a synthetic negative placeholder — nothing
 * downstream keys off it once `sourceId` is set, but a numeric value
 * keeps existing code happy.
 *
 * One EntityState per event object, so a re-render keeps row identity.
 */
const entityForEvent = new WeakMap<TableRowEvent, EntityState>()

export function eventsToEntities(events: readonly TableRowEvent[]): EntityState[] {
  return events.map((e) => {
    const hit = entityForEvent.get(e)
    if (hit) return hit
    const ts = new Date(e.ts)
    const out: EntityState = {
      entityKey: e.entityKey,
      streamId: -1,
      payload: e.payload,
      lastSeenAt: ts,
      updatedAt: ts,
    }
    entityForEvent.set(e, out)
    return out
  })
}

/**
 * Compute the centroid for any shape kind the resolver may return.
 */
export function centroidForShape(
  shape: MatchableShape,
  kind: DataLinkConfig['targetKind'],
): [number, number] | null {
  switch (kind) {
    case 'polygon': {
      const p = shape as PolygonShape
      return p.vertices.length >= 3 ? polygonCentroid(p.vertices) : null
    }
    case 'circle': {
      const c = shape as CircleShape
      if (c.center) return c.center
      if (c.start && c.current) {
        return [(c.start[0] + c.current[0]) / 2, (c.start[1] + c.current[1]) / 2]
      }
      return null
    }
    case 'marker': return (shape as MarkerShape).position
    case 'line': {
      const l = shape as LineShape
      return l.vertices.length >= 2 ? lineCentroid(l.vertices) : null
    }
    case 'model': return (shape as ModelShape).position
    default: return null
  }
}

/**
 * Altitude of a shape's TOP face in metres. Used where a data-link
 * feature has to sit ON a shape (the tint fill) rather than at it.
 * Matches the slab exactly as its overlay draws it: a shape with a height
 * floors its base at `minBase` and its thickness at 0.05 m; a 0-height one
 * at `flat` (map-polygon-overlay: FLAT_SLAB_BASE_M + FLAT_SLAB_THICKNESS_M;
 * circles keep `minBase` + 0.05). A tint at elevation + height (0 for a
 * flat area) would sit inside that slab and never show.
 */
/** How map-polygon-overlay draws a 0-height area (see slabTopM). */
const POLYGON_FLAT_SLAB = { base: FLAT_SLAB_BASE_M, thickness: FLAT_SLAB_THICKNESS_M }

export function slabTopM(
  shape: { config?: { elevation?: number; height?: number } },
  minBase: number,
  flat: { base: number; thickness: number } = { base: minBase, thickness: 0.05 },
): number {
  const e = shape.config?.elevation
  const h = shape.config?.height
  const base = typeof e === 'number' && Number.isFinite(e) ? e : 0
  const height = typeof h === 'number' && Number.isFinite(h) ? h : 0
  if (height > 0) return Math.max(base, minBase) + Math.max(height, 0.05)
  return Math.max(base, flat.base) + flat.thickness
}

/**
 * Metres above ground for one entity, in preference order:
 *
 *   1. the payload's own `elevationField` — the source knows its true
 *      altitude best (e.g. RTLS with vertical accuracy);
 *   2. the altitude of the shape it is anchored to — a sensor bolted to
 *      a first-floor rack belongs at that rack's height even when the
 *      payload says nothing about z;
 *   3. ground.
 *
 * Tier 2 is what puts every shape-anchored render mode on the right
 * floor without asking the operator to emit z per row.
 */
export function resolveAnchorElevation(
  payload: Record<string, unknown>,
  config: DataLinkConfig,
  shape: MatchableShape | null,
): number {
  const fromSpec = resolveFromElevationSpec(payload, config.fieldMapping.elevation)
  if (fromSpec !== undefined) return fromSpec
  // Legacy path — configs written before v5.3 only had `elevationField`.
  const legacyKey = config.fieldMapping.elevationField
  if (legacyKey) {
    const raw = readPayloadPath(payload, legacyKey)
    // File-imported sources keep every value as a string, so coerce
    // rather than type-check (same reasoning as coerceCoord).
    const parsed = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  const z = (shape as { config?: { elevation?: number } } | null)?.config
    ?.elevation
  return typeof z === 'number' && Number.isFinite(z) ? z : 0
}

/**
 * v5.3 elevation spec evaluator. Returns `undefined` when the spec
 * can't produce a definite number for this record — the caller then
 * falls through to the shape-anchor / legacy path so a partly-typed
 * spec doesn't silently pin every marker to 0.
 */
export function resolveFromElevationSpec(
  payload: Record<string, unknown>,
  spec: ElevationSpec | undefined,
): number | undefined {
  if (!spec) return undefined
  switch (spec.kind) {
    case 'static':
      return Number.isFinite(spec.value) ? spec.value : undefined
    case 'field': {
      if (!spec.field) return undefined
      const raw = readPayloadPath(payload, spec.field)
      const parsed = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    case 'rules': {
      for (const rule of spec.rules) {
        if (!rule.field || !rule.op) continue
        const raw = readPayloadPath(payload, rule.field)
        if (raw === undefined || raw === null) continue
        const haystack = String(raw)
        const needle = rule.match
        let hit = false
        switch (rule.op) {
          case 'equals':
            hit = haystack === needle
            break
          case 'contains':
            hit = haystack.includes(needle)
            break
          case 'startsWith':
            hit = haystack.startsWith(needle)
            break
          case 'endsWith':
            hit = haystack.endsWith(needle)
            break
        }
        if (hit && Number.isFinite(rule.value)) return rule.value
      }
      return typeof spec.fallback === 'number' && Number.isFinite(spec.fallback)
        ? spec.fallback
        : undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Entity → anchor resolution
// ---------------------------------------------------------------------------

export interface EntityAnchor {
  shape: MatchableShape | null
  position: [number, number]
  elevation: number
}

export interface AnchorScope {
  /** v4 — drop entities whose resolved floor doesn't match. */
  activeFloorPlanId?: ActiveFloors
  /** Set of currently-live floor plan ids for orphan detection. */
  liveFloorPlanIds?: ReadonlySet<number>
  /** v4 — drop entities whose payload fails the layer filter. */
  filter?: DataLinkFilter | null
  /**
   * Focus mode: this row passes the filter and floor gate, is never
   * occluded, and its features are stamped `focused: true`.
   */
  focusedKey?: string | null
  /**
   * Ghost mode (point-on-shape / gauge only): occluded rows are kept,
   * stamped `occluded: true`, instead of being left out.
   */
  ghosts?: boolean
  /**
   * Focus mode (point-on-shape / gauge only): the focused item's NEAR
   * column (`FocusScene.near.region`). Every other row's marker / badge
   * drawn inside it is stamped `focusNear: true` (a cached copy).
   */
  near?: FocusNearRegion | null
}

export interface RowAnchors {
  anchors: EntityAnchor[]
  /** The row produced at least one anchor. */
  matched: boolean
  /** The resolver's reason when it matched nothing at all, else null. */
  reason: string | null
}

/**
 * Every anchor one (already filter-passed) entity resolves to: one per
 * matched shape on the active floor, or its own coordinate in coord mode.
 * Exactly the per-entity body of `forEachEntityAnchor`.
 */
function resolveRowAnchors(
  entity: EntityState,
  config: DataLinkConfig,
  snapshot: MatchStoreSnapshot,
  activeFloor: ActiveFloors,
  liveIds: ReadonlySet<number> | undefined,
): RowAnchors {
  const floorScope = config.fieldMapping.floorScope
  const result = resolveMatchTargets(entity.payload, config, snapshot)
  if (result.kind === 'coord') {
    // Coord path — no shape anchor. Floor gate is payload-only, but
    // still respects the config's floorScope and treats orphan floors
    // as unknown so a stale id doesn't hide the row.
    if (!passesFloorScope(entity.payload, floorScope, activeFloor, liveIds)) {
      return { anchors: [], matched: false, reason: null }
    }
    return {
      anchors: [{
        shape: null,
        position: result.position,
        elevation: resolveAnchorElevation(entity.payload, config, null),
      }],
      matched: true,
      reason: null,
    }
  }
  if (result.kind !== 'shapes') {
    return { anchors: [], matched: false, reason: result.kind === 'none' ? result.reason : null }
  }
  const anchors: EntityAnchor[] = []
  for (const shape of result.shapes) {
    // Shape-anchored path: pass the matched shape's floor as the
    // fallback source for `auto` mode. `passesFloorScope` still wins
    // the mode (`all` / `specific` short-circuit before the shape
    // floor is read).
    const shapeFloor =
      (shape as unknown as { floorPlanId?: number }).floorPlanId ?? null
    if (
      !shapeOnEntityFloor(entity.payload, floorScope, shapeFloor) ||
      !passesFloorScope(
        entity.payload,
        floorScope,
        activeFloor,
        liveIds,
        shapeFloor,
      )
    ) {
      continue
    }
    const pos = centroidForShape(shape, config.targetKind)
    if (!pos) continue
    anchors.push({
      shape,
      position: pos,
      elevation: resolveAnchorElevation(entity.payload, config, shape),
    })
  }
  return { anchors, matched: anchors.length > 0, reason: null }
}

/**
 * The focused row's anchors: the ones it has on the active floor(s), or —
 * when the floor gate leaves it none — the ones it has on any floor, so a
 * row the user asked to see is drawn where it lives. (`shapeOnEntityFloor`
 * still applies: a name join never paints a same-named room elsewhere.)
 */
export function resolveFocusedRowAnchors(
  entity: EntityState,
  config: DataLinkConfig,
  snapshot: MatchStoreSnapshot,
  activeFloor: ActiveFloors,
  liveIds: ReadonlySet<number> | undefined,
): RowAnchors {
  const gated = resolveRowAnchors(entity, config, snapshot, activeFloor, liveIds)
  if (gated.anchors.length > 0 || activeFloor === null) return gated
  return resolveRowAnchors(entity, config, snapshot, null, liveIds)
}

/** `${configId}|${reason}` pairs already reported. */
const warnedNoMatch = new Set<string>()

/**
 * Debug aid: when a layer has entities flowing in but none of them
 * resolve to an anchor, the sub-renderer renders 0 features and the
 * layer appears empty on the map. Log the first failure reason so
 * the operator can see WHY the match is failing (e.g. payloadField
 * not present, shape name not in store, targetShapeId stale) and
 * fix the config without bouncing through the data-link manager.
 * Once per config and reason — pushes are frequent.
 */
function warnNoMatches(
  entities: readonly EntityState[],
  config: DataLinkConfig,
  matched: number,
  firstReason: string | null,
): void {
  if (!(entities.length > 0 && matched === 0 && firstReason !== null)) return
  const onceKey = `${config.id}|${firstReason}`
  if (warnedNoMatch.has(onceKey)) return
  warnedNoMatch.add(onceKey)
  const firstEntity = entities[0]
  const match = config.fieldMapping?.match
  const joinDesc =
    match?.mode === 'attribute-join' || match?.mode === 'external-code'
      ? `${match.mode}(payloadField="${match.join?.payloadField}", shapeSide=${match.join?.shapeFieldSource}${match.join?.shapeField ? `(${match.join.shapeField})` : ''})`
      : match?.mode ?? 'coord'
  console.warn(
    `[data-link] no entities matched for "${config.name}"\n` +
      `  renderMode: ${config.renderMode}\n` +
      `  targetKind: ${config.targetKind}\n` +
      `  match: ${joinDesc}\n` +
      `  entityCount: ${entities.length}\n` +
      `  firstReason: ${firstReason}\n` +
      `  firstEntity.entityKey: ${firstEntity?.entityKey ?? '(none)'}\n` +
      `  firstEntity.position: ${JSON.stringify(firstEntity?.position ?? null)}\n` +
      `  firstEntity.payload: ${JSON.stringify(firstEntity?.payload ?? {})}`,
  )
}

/**
 * v2 iterator — feeds each (entity, matched-shape) pair to the
 * caller's build function. Attribute-join with multiple matches yields
 * one call per pair. Explicit-shape yields at most one. Coord mode
 * yields at most one with `shape=null` + the payload's own position.
 *
 * The `snapshot` argument is a live reference to the useSpatialStore
 * slices the resolver reads (bins + every shape kind).
 *
 * `elevation` is resolved here rather than in each sub-renderer so that
 * every mode lands on the same floor for the same entity.
 */
export function forEachEntityAnchor(
  entities: readonly EntityState[],
  config: DataLinkConfig,
  snapshot: MatchStoreSnapshot,
  visit: (a: EntityAnchor & { entity: EntityState }) => void,
  opts?: AnchorScope,
): void {
  const activeFloor = opts?.activeFloorPlanId ?? null
  const liveIds = opts?.liveFloorPlanIds
  const filter = opts?.filter ?? null
  const focusedKey = opts?.focusedKey ?? null
  let matched = 0
  let firstReason: string | null = null
  for (const entity of entities) {
    const isFocus = focusedKey !== null && entity.entityKey === focusedKey
    // v4 — payload filter first (cheapest, drops before match).
    if (!isFocus && filter && !evaluateDataLinkFilter(entity.payload, filter)) continue
    const row = isFocus
      ? resolveFocusedRowAnchors(entity, config, snapshot, activeFloor, liveIds)
      : resolveRowAnchors(entity, config, snapshot, activeFloor, liveIds)
    if (firstReason === null && row.reason !== null) firstReason = row.reason
    for (const a of row.anchors) visit({ entity, ...a })
    if (row.matched) matched++
  }
  warnNoMatches(entities, config, matched, firstReason)
}

/**
 * Cached flavour of `forEachEntityAnchor` for builders whose output per
 * (entity, anchor) is a pure function of the row: `build` runs once per
 * row object and its features are reused while the cache holds. Occluded
 * rows still resolve (they count as matched, as before) but contribute
 * no features — or, for `pointSymbols` builders with `opts.ghosts`,
 * contribute their features stamped `occluded: true`.
 *
 * The focused row (`opts.focusedKey`) skips the filter, draws on any floor
 * when the active one leaves it no anchor (`resolveFocusedRowAnchors`),
 * and its features are stamped `focused: true`. For `pointSymbols`
 * builders, every other feature drawn inside `opts.near` is stamped
 * `focusNear: true`.
 */
function collectAnchoredFeatures<F extends GeoJSON.Feature>(
  entities: readonly EntityState[],
  config: DataLinkConfig,
  snapshot: MatchStoreSnapshot,
  styleRules: ReadonlyArray<StyleRule>,
  opts: AnchorScope,
  occludedKeys: ReadonlySet<string>,
  cache: RowBuildCache<{ row: RowAnchors; features: F[] }> | undefined,
  build: (e: EntityState, anchor: EntityAnchor, payloadJson: string) => F,
  /** Point-symbol modes (point-on-shape, gauge): ghosts and NEAR stamps apply. */
  pointSymbols: boolean,
): F[] {
  const activeFloor = opts.activeFloorPlanId ?? null
  const liveIds = opts.liveFloorPlanIds
  const filter = opts.filter ?? null
  const focusedKey = opts.focusedKey ?? null
  const ghosts = pointSymbols && opts.ghosts === true
  const near = pointSymbols ? opts.near ?? null : null
  const rules = compileEntityRules(styleRules, config.styleRuleIds)
  const tokens = [config, styleRules, snapshot, activeFloor, liveIds]
  const cacheable = cache !== undefined && !rules.timeDependent
  const rows = cacheable ? cache.rowsFor(tokens) : null
  const buildEntry = (e: EntityState, row: RowAnchors) => {
    const features: F[] = []
    if (row.anchors.length > 0) {
      const payloadJson = JSON.stringify(e.payload)
      for (const a of row.anchors) features.push(build(e, a, payloadJson))
    }
    return { row, features }
  }
  const out: F[] = []
  let matched = 0
  let firstReason: string | null = null
  for (const e of entities) {
    const isFocus = focusedKey !== null && e.entityKey === focusedKey
    if (!isFocus && filter && !evaluateDataLinkFilter(e.payload, filter)) continue
    let entry = rows?.get(e)
    if (!entry) {
      entry = buildEntry(e, resolveRowAnchors(e, config, snapshot, activeFloor, liveIds))
      rows?.set(e, entry)
    }
    if (firstReason === null && entry.row.reason !== null) firstReason = entry.row.reason
    if (entry.row.matched) matched++
    if (isFocus) {
      // Drawn where it is on the active floor(s); else on its own floor
      // (the same rule `resolveFocusedRowAnchors` applies).
      let drawn = entry
      if (drawn.row.anchors.length === 0 && activeFloor !== null) {
        const focusRows = cacheable ? cache.focusRowsFor(tokens) : null
        let ungated = focusRows?.get(e)
        if (!ungated) {
          ungated = buildEntry(e, resolveRowAnchors(e, config, snapshot, null, liveIds))
          focusRows?.set(e, ungated)
        }
        drawn = ungated
      }
      const anchors = drawn.row.anchors
      for (let i = 0; i < drawn.features.length; i++) {
        const a = anchors[i]!
        out.push(markFocused(drawn.features[i]!, {
          position: a.position,
          elevationM: a.elevation,
          shapeFloor: (a.shape as { floorPlanId?: number } | null)?.floorPlanId ?? null,
          payload: e.payload,
        }))
      }
      continue
    }
    // v5.4 — hard-hide: occluded entities never enter the source (ghost
    // mode keeps them, stamped `occluded: true`).
    if (occludedKeys.has(e.entityKey)) {
      if (ghosts) for (const f of entry.features) out.push(withNear(ghostOf(f), near))
      continue
    }
    for (const f of entry.features) out.push(withNear(f, near))
  }
  warnNoMatches(entities, config, matched, firstReason)
  return out
}

// ---------------------------------------------------------------------------
// point-at-coord / history-movement
// ---------------------------------------------------------------------------

export interface CoordFeaturesResult {
  /** One feature per drawable row (the manual-cluster leaves). */
  features: GeoJSON.Feature<GeoJSON.Point>[]
  /** What goes into the source: `features`, or their manual clusters. */
  outFeatures: GeoJSON.Feature<GeoJSON.Point>[]
  /** True when `outFeatures` is the manual-cluster aggregation. */
  manualClusterActive: boolean
  /**
   * The focused row's feature (stamped `focused: true`), or null. Never
   * folded into a manual-cluster bubble; left out of `outFeatures` when
   * `splitFocused` asked for it (a natively clustered source, where the
   * caller draws it on its own source).
   */
  focused: GeoJSON.Feature<GeoJSON.Point> | null
}

/** Focus-mode inputs of `buildCoordFeatures`; all inert when unset. */
export interface CoordFocusOptions {
  /** The focused row: never occluded, stamped `focused: true`. */
  focusedKey?: string | null
  /** Keep occluded rows, stamped `occluded: true` (unclustered configs). */
  ghosts?: boolean
  /**
   * The focused item's NEAR column: every other row drawn inside it is
   * stamped `focusNear: true` (a cached copy). Ignored for a clustered
   * config (`style.cluster`), whose bubbles aggregate rows.
   */
  near?: FocusNearRegion | null
  /** Leave the focused feature out of `outFeatures` (native clusters). */
  splitFocused?: boolean
  /**
   * Skip the `clusterGroupField` aggregation: runtime clustering
   * (`@/lib/data-link/point-clusters`) is on and groups the rows itself.
   */
  skipGroupCluster?: boolean
}

interface CoordContext {
  lngKey: string
  latKey: string
  labelKey: string
  colorKey: string | undefined
  elevationKey: string | undefined
  groupKey: string | undefined
  roomElevationById: Map<number, number>
  iconName: string
}

/**
 * Build the GeoJSON features for a point-at-coord config from the field
 * mapping. Skips entities whose payload doesn't yield a usable (lng, lat)
 * — those won't render, but we don't error, since the ingest pipeline
 * accepts arbitrary payloads.
 */
export function buildCoordFeatures(
  config: DataLinkConfig,
  entities: readonly EntityState[],
  styleRules: ReadonlyArray<StyleRule>,
  polygons?: ReadonlyArray<PolygonShape>,
  /** v5.4 — entity keys currently occluded; those rows are skipped. */
  occludedKeys?: ReadonlySet<string>,
  cache?: RowBuildCache<GeoJSON.Feature<GeoJSON.Point> | null>,
  focus?: CoordFocusOptions,
): CoordFeaturesResult {
  const focusedKey = focus?.focusedKey ?? null
  const ghosts = focus?.ghosts === true
  const near = config.style.cluster === true ? null : focus?.near ?? null
  const groupKey = config.fieldMapping.clusterGroupField
  const rules = compileEntityRules(styleRules, config.styleRuleIds)
  const rows = cache && !rules.timeDependent
    ? cache.rowsFor([config, styleRules, groupKey ? polygons : null])
    : null

  // Polygon-id → elevation lookup. Built once per feature push so the
  // fallback in the loop below is O(1). Only populated when the user
  // has set `clusterGroupField` (typically `currentRoomId`); otherwise
  // there's no join key so the fallback can't fire.
  //
  // When the entity payload doesn't carry an `elevation` field, we
  // lift the marker to the room's own altitude. This is what makes
  // the mock work without emitting elevation per row — the polygon
  // knows how high its floor is (from config.elevation), and every
  // marker in that room inherits that height.
  let ctx: CoordContext | null = null
  const context = (): CoordContext => {
    if (ctx) return ctx
    const roomElevationById = new Map<number, number>()
    if (groupKey && polygons) {
      for (const p of polygons) {
        if (p.id === undefined) continue
        const z = p.config?.elevation
        if (typeof z === 'number' && Number.isFinite(z)) {
          roomElevationById.set(p.id, z)
        }
      }
    }
    ctx = {
      lngKey: config.fieldMapping.coordFields?.lng ?? 'lng',
      latKey: config.fieldMapping.coordFields?.lat ?? 'lat',
      labelKey: config.fieldMapping.labelField ?? 'label',
      colorKey: config.fieldMapping.colorField,
      elevationKey: config.fieldMapping.elevationField,
      groupKey,
      roomElevationById,
      // Per-feature icon id — the sub-renderer's install pass
      // registered `dl-icon-<id>-<color>` via ensureDataLinkSpritesFor()
      // before this feature-push runs, so referencing the mapbox image
      // name here just works. Falls back to `map-pin` @ default color.
      iconName: mapboxImageIdFor(
        config.style.defaultIcon ?? 'map-pin',
        config.style.iconColor,
      ),
    }
    return ctx
  }

  const features: GeoJSON.Feature<GeoJSON.Point>[] = []
  let focused: GeoJSON.Feature<GeoJSON.Point> | null = null
  for (const e of entities) {
    const isFocus = focusedKey !== null && e.entityKey === focusedKey
    // v5.4 — hard-hide via source. When the analytic occlusion pass
    // has marked this entity's key, we skip it entirely — no
    // feature enters the source, so Mapbox has nothing to draw,
    // hit-test, or hover. Opacity / filter-based approaches leak
    // through `queryRenderedFeatures` and let the user click on
    // invisible markers; skipping at push time is the only way to
    // guarantee "if it's behind something, it doesn't exist".
    // Focus mode: the focused row is never hidden, and ghost mode keeps
    // occluded rows as `occluded: true` copies (drawn faint, clickable).
    const occluded = !isFocus && occludedKeys !== undefined && occludedKeys.has(e.entityKey)
    if (occluded && !ghosts) continue
    let f = rows?.get(e)
    if (f === undefined) {
      f = buildCoordFeature(e, config, rules.evaluate, context())
      rows?.set(e, f)
    }
    if (!f) continue
    if (isFocus) {
      f = markFocused(f, {
        position: [f.geometry.coordinates[0], f.geometry.coordinates[1]],
        elevationM: elevationOf(f),
        shapeFloor: null,
        payload: e.payload,
      })
      focused = f
    } else {
      if (occluded) f = ghostOf(f)
      // Drawn in the focused item's NEAR column: fades (FOCUS_FACTOR.near).
      f = withNear(f, near)
    }
    features.push(f)
  }

  // Manual clustering by `clusterGroupField`. Since Mapbox's built-in
  // cluster is geographic-only, we group features here by their
  // `groupKey` (e.g. `currentRoomId`). Groups with more than one point
  // are replaced by a single aggregate feature at the group's centroid
  // with `manualCluster: true` + `point_count: N`. Groups of size 1
  // pass through as individual features. This guarantees no bubble
  // ever straddles a group boundary — the same room's markers merge,
  // and adjacent rooms stay visually distinct.
  //
  // Only runs when `clusterGroupField` is set AND the config asks for
  // cluster mode. Otherwise the raw feature list is pushed and the
  // native cluster (or no cluster at all) draws it.
  let outFeatures: GeoJSON.Feature<GeoJSON.Point>[] = features
  const manualClusterActive =
    config.style.cluster === true && !!groupKey && features.length > 0 && !focus?.skipGroupCluster
  if (manualClusterActive) {
    const groups = new Map<string, GeoJSON.Feature<GeoJSON.Point>[]>()
    for (const f of features) {
      // The focused row is drawn on its own, after the bubbles.
      if (f === focused) continue
      const k = String(f.properties?.groupKey ?? '__ungrouped__')
      const arr = groups.get(k)
      if (arr) arr.push(f)
      else groups.set(k, [f])
    }
    outFeatures = []
    for (const arr of groups.values()) {
      if (arr.length === 1) {
        outFeatures.push(arr[0])
        continue
      }
      let cx = 0
      let cy = 0
      let cz = 0
      for (const f of arr) {
        cx += f.geometry.coordinates[0]
        cy += f.geometry.coordinates[1]
        cz += Number(f.properties?.elevation ?? 0)
      }
      cx /= arr.length
      cy /= arr.length
      cz /= arr.length
      const sample = arr[0].properties ?? {}
      outFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [cx, cy] },
        properties: {
          manualCluster: true,
          point_count: arr.length,
          point_count_abbreviated: String(arr.length),
          groupKey: sample.groupKey,
          elevation: cz,
          // Preserve the config id so the click handler can trace back.
          configId: sample.configId,
        },
      })
    }
    if (focused && !focus?.splitFocused) outFeatures.push(focused)
  } else if (focused && focus?.splitFocused) {
    outFeatures = features.filter((f) => f !== focused)
  }
  return { features, outFeatures, manualClusterActive, focused }
}

/** One row's point-at-coord feature, or null when it has no coordinate. */
function buildCoordFeature(
  e: EntityState,
  config: DataLinkConfig,
  evaluateRules: CompiledEntityRules['evaluate'],
  ctx: CoordContext,
): GeoJSON.Feature<GeoJSON.Point> | null {
  const { lngKey, latKey, labelKey, colorKey, elevationKey, groupKey, roomElevationById } = ctx
  // Prefer the payload's coord fields (arbitrary schema); fall
  // back to the backend-extracted `position` (only present when
  // the ingest included a top-level `[lng, lat]`).
  // Supports the same array-index / dotted-path syntax the resolver
  // uses (`currentPosition[0]`, `location.lng`, plain key), so a
  // REST source that only exposes an array position works without
  // a translation layer.
  let lng: number | undefined
  let lat: number | undefined
  const rawLng = readPayloadPath(e.payload, lngKey)
  const rawLat = readPayloadPath(e.payload, latKey)
  // File-imported sources (CSV / XLSX / JSON) preserve every value
  // as a string in `data_source_rows.payload` — the parser doesn't
  // coerce because a JSONB column is schema-less. Number() + isFinite
  // handles that path AND the native-number path from streaming
  // publishers uniformly.
  const numLng = coerceCoord(rawLng)
  const numLat = coerceCoord(rawLat)
  if (numLng !== undefined && numLat !== undefined) {
    lng = numLng
    lat = numLat
  } else if (e.position) {
    lng = e.position[0]
    lat = e.position[1]
  }
  if (lng === undefined || lat === undefined) return null

  // Read the elevation (metres above ground) — used by Mapbox
  // symbol layers to lift the marker + icon + label off the floor
  // plan raster to their real z.
  //
  // Three sources, in order of preference:
  //
  //   1. v5.3 `elevation` spec (static / field / rules) — the
  //      layer author's explicit intent wins.
  //   2. Legacy `elevationField` on the payload (pre-v5.3 configs).
  //   3. The ROOM's elevation via the polygon lookup built above.
  //      Kicks in when the entity payload has no z but the config
  //      has `clusterGroupField` mapping the payload → a polygon id
  //      (e.g. `currentRoomId`). Lets a REST source that only
  //      knows "you're in room 42" render on the right floor.
  //
  // Silent 0 when nothing hits — old data links keep rendering at
  // ground level.
  let elevationM = 0
  let elevationFromPayload = false
  const specHit = resolveFromElevationSpec(e.payload, config.fieldMapping.elevation)
  if (specHit !== undefined) {
    elevationM = specHit
    elevationFromPayload = true
  } else if (elevationKey) {
    const rawZ = readPayloadPath(e.payload, elevationKey)
    const parsed = typeof rawZ === 'number' ? rawZ : Number(rawZ)
    if (Number.isFinite(parsed)) {
      elevationM = parsed
      elevationFromPayload = true
    }
  }
  if (!elevationFromPayload && groupKey && roomElevationById.size > 0) {
    const rawGroup = readPayloadPath(e.payload, groupKey)
    // Polygon ids are integers in Postgres → the group value may
    // arrive as either a number OR its stringified form (JSON
    // preserves numeric strings sometimes). Try both.
    const asNum =
      typeof rawGroup === 'number' ? rawGroup : Number(rawGroup)
    if (Number.isFinite(asNum) && roomElevationById.has(asNum)) {
      elevationM = roomElevationById.get(asNum) ?? 0
    }
  }

  let label =
    typeof e.payload[labelKey] === 'string' || typeof e.payload[labelKey] === 'number'
      ? String(e.payload[labelKey])
      : e.entityKey
  let color =
    colorKey && typeof e.payload[colorKey] === 'string'
      ? (e.payload[colorKey] as string)
      : undefined
  let opacity: number | undefined

  // Slice-4 style-rule overrides: rules matched by the entity's
  // payload can override color/label/opacity before the paint
  // expressions consume them.
  const override = evaluateRules(e.payload)
  if (override) {
    if (override.fillColor) color = override.fillColor
    if (override.iconColor) color = override.iconColor
    if (override.labelText)
      label = resolveLabelTemplate(override.labelText, e.payload)
    if (override.fillOpacity !== undefined) opacity = override.fillOpacity / 100
  }

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      entityKey: e.entityKey,
      streamId: e.streamId,
      configId: config.id,
      label,
      color,
      opacity,
      elevation: elevationM,
      icon: ctx.iconName,
      // v5.4 — analytic occlusion flag. Occluded rows never reach this
      // point (they are skipped above, or ghost mode stamps an
      // `occluded: true` copy), so it is always false here.
      occluded: false,
      // v4 — feature-level size stamps. The disc + icon layers use
      // `['coalesce', ['get', 'discSize'], 22]` / `['coalesce',
      // ['get', 'iconSize'], 0.7]` at install so re-emitting the
      // source (via source.setData) picks up any slider change on
      // the fast path. See Mapbox perf guide + the
      // docs/pitfalls-frontend.md pitfall note on setLayoutProperty
      // text-size lag.
      discSize: config.style.markerSize ?? 22,
      iconSize: config.style.iconSize ?? 0.7,
      // groupKey is used by the manual cluster aggregator below.
      // Stamped even when the config doesn't cluster, so a later
      // toggle to enable clustering doesn't require a full source
      // rebuild.
      groupKey:
        groupKey && readPayloadPath(e.payload, groupKey) !== undefined
          ? String(readPayloadPath(e.payload, groupKey))
          : null,
      payload: JSON.stringify(e.payload),
    },
  }
}

// ---------------------------------------------------------------------------
// point-on-shape
// ---------------------------------------------------------------------------

/**
 * N sensors mounted on one shape: one point (+ label) per entity at the
 * bound shape's centroid. Attribute-join can hit several shapes; each hit
 * gets its own marker.
 */
export function buildPointOnShapeFeatures(
  entities: readonly EntityState[],
  config: DataLinkConfig,
  snapshot: MatchStoreSnapshot,
  styleRules: ReadonlyArray<StyleRule>,
  opts: AnchorScope,
  occludedKeys: ReadonlySet<string>,
  cache?: RowBuildCache<{ row: RowAnchors; features: GeoJSON.Feature<GeoJSON.Point>[] }>,
): GeoJSON.Feature<GeoJSON.Point>[] {
  const labelKey = config.fieldMapping.labelField ?? 'label'
  const colorKey = config.fieldMapping.colorField
  const iconName = mapboxImageIdFor(
    config.style.defaultIcon ?? 'map-pin',
    config.style.iconColor,
  )
  const evaluate = compileEntityRules(styleRules, config.styleRuleIds).evaluate
  return collectAnchoredFeatures(
    entities, config, snapshot, styleRules, opts, occludedKeys, cache,
    (e, { position, elevation }, payloadJson) => {
      let label =
        typeof e.payload[labelKey] === 'string' || typeof e.payload[labelKey] === 'number'
          ? String(e.payload[labelKey])
          : e.entityKey
      let color =
        colorKey && typeof e.payload[colorKey] === 'string'
          ? (e.payload[colorKey] as string)
          : undefined
      let opacity: number | undefined
      const override = evaluate(e.payload)
      if (override) {
        if (override.fillColor) color = override.fillColor
        if (override.iconColor) color = override.iconColor
        if (override.labelText)
          label = resolveLabelTemplate(override.labelText, e.payload)
        if (override.fillOpacity !== undefined)
          opacity = override.fillOpacity / 100
      }
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: position },
        properties: {
          entityKey: e.entityKey,
          streamId: e.streamId,
          configId: config.id,
          label,
          color,
          opacity,
          elevation,
          icon: iconName,
          // Occluded rows contribute no features (ghost mode adds an
          // `occluded: true` copy instead), so always false here.
          occluded: false,
          // v4 — feature-level sizes, read by data-driven expressions
          // on the disc + icon layers. Fast source.setData update path.
          discSize: config.style.markerSize ?? 11,
          iconSize: config.style.iconSize ?? 0.7,
          payload: payloadJson,
        },
      }
    },
    true,
  )
}

// ---------------------------------------------------------------------------
// gauge-on-shape
// ---------------------------------------------------------------------------

/** Value badge stacked at a shape's centroid, one per (entity, shape). */
export function buildGaugeFeatures(
  entities: readonly EntityState[],
  config: DataLinkConfig,
  snapshot: MatchStoreSnapshot,
  styleRules: ReadonlyArray<StyleRule>,
  opts: AnchorScope,
  occludedKeys: ReadonlySet<string>,
  cache?: RowBuildCache<{ row: RowAnchors; features: GeoJSON.Feature<GeoJSON.Point>[] }>,
): GeoJSON.Feature<GeoJSON.Point>[] {
  // Uses the mapping's labelField as the value source; if the caller
  // hasn't set one, falls back to a `value` key (common convention
  // for sensor payloads). Future: a dedicated valueField on the
  // mapping — for now labelField ?? 'value' keeps the surface small.
  const valueKey = config.fieldMapping.labelField ?? 'value'
  const evaluate = compileEntityRules(styleRules, config.styleRuleIds).evaluate
  return collectAnchoredFeatures(
    entities, config, snapshot, styleRules, opts, occludedKeys, cache,
    (e, { position, elevation }, payloadJson) => {
      const raw = e.payload[valueKey]
      let value =
        typeof raw === 'string' || typeof raw === 'number'
          ? String(raw)
          : e.entityKey
      let color: string | undefined
      let opacity: number | undefined
      const override = evaluate(e.payload)
      if (override) {
        if (override.fillColor) color = override.fillColor
        if (override.iconColor) color = override.iconColor
        if (override.labelText)
          value = resolveLabelTemplate(override.labelText, e.payload)
        if (override.fillOpacity !== undefined)
          opacity = override.fillOpacity / 100
      }
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: position },
        properties: {
          entityKey: e.entityKey,
          streamId: e.streamId,
          configId: config.id,
          value,
          label: value,
          color,
          opacity,
          elevation,
          badgeSize: config.style.badgeSize ?? 18,
          // Occluded rows contribute no features (ghost mode adds an
          // `occluded: true` copy instead), so always false here.
          occluded: false,
          payload: payloadJson,
        },
      }
    },
    true,
  )
}

// ---------------------------------------------------------------------------
// fov-cone
// ---------------------------------------------------------------------------

/**
 * Camera field-of-view triangle rooted at each anchor. Field keys are
 * hardcoded per the current design; future work can expose them as
 * `config.fieldMapping.fovFields.{yaw,fov,distance}`.
 */
export function buildFovFeatures(
  entities: readonly EntityState[],
  config: DataLinkConfig,
  snapshot: MatchStoreSnapshot,
  styleRules: ReadonlyArray<StyleRule>,
  opts: AnchorScope,
  occludedKeys: ReadonlySet<string>,
  cache?: RowBuildCache<{ row: RowAnchors; features: GeoJSON.Feature<GeoJSON.Polygon>[] }>,
): GeoJSON.Feature<GeoJSON.Polygon>[] {
  const YAW_KEY = 'yaw'
  const FOV_KEY = 'fovDeg'
  const DIST_KEY = 'viewDistanceM'
  const metersPerDegLat = 111320
  const evaluate = compileEntityRules(styleRules, config.styleRuleIds).evaluate
  return collectAnchoredFeatures(
    entities, config, snapshot, styleRules, opts, occludedKeys, cache,
    (e, { position: anchor, elevation }, payloadJson) => {
      const yaw = typeof e.payload[YAW_KEY] === 'number' ? (e.payload[YAW_KEY] as number) : 0
      const fovDeg =
        typeof e.payload[FOV_KEY] === 'number' ? (e.payload[FOV_KEY] as number) : 60
      const dist =
        typeof e.payload[DIST_KEY] === 'number' ? (e.payload[DIST_KEY] as number) : 10
      const halfFov = ((fovDeg / 2) * Math.PI) / 180
      const yawRad = (yaw * Math.PI) / 180
      // Rough m → deg conversion at the anchor's latitude. Computed
      // per-anchor because attribute-join can spread the cones across
      // shapes at different latitudes.
      const metersPerDegLng = 111320 * Math.cos((anchor[1] * Math.PI) / 180)

      const baseCenterMx = Math.sin(yawRad) * dist
      const baseCenterMy = Math.cos(yawRad) * dist
      const halfBase = dist * Math.tan(halfFov)
      const perpMx = Math.cos(yawRad)
      const perpMy = -Math.sin(yawRad)

      const leftM: [number, number] = [
        baseCenterMx - perpMx * halfBase,
        baseCenterMy - perpMy * halfBase,
      ]
      const rightM: [number, number] = [
        baseCenterMx + perpMx * halfBase,
        baseCenterMy + perpMy * halfBase,
      ]

      const toLngLat = (mx: number, my: number): [number, number] => [
        anchor[0] + mx / metersPerDegLng,
        anchor[1] + my / metersPerDegLat,
      ]

      const apex = anchor
      const left = toLngLat(leftM[0], leftM[1])
      const right = toLngLat(rightM[0], rightM[1])
      const ring: [number, number][] = [apex, left, right, apex]

      let color: string | undefined
      let opacity: number | undefined
      const override = evaluate(e.payload)
      if (override) {
        if (override.fillColor) color = override.fillColor
        if (override.iconColor && !color) color = override.iconColor
        if (override.fillOpacity !== undefined)
          opacity = override.fillOpacity / 100
      }
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {
          entityKey: e.entityKey,
          streamId: e.streamId,
          configId: config.id,
          color,
          opacity,
          elevation,
          payload: payloadJson,
        },
      }
    },
    false,
  )
}

// ---------------------------------------------------------------------------
// heatmap
// ---------------------------------------------------------------------------

/**
 * One weighted point per record (live rows or history events). Coord
 * lookup via resolvePayloadCoord() so legacy configs AND explicit
 * `match.mode='coord'` configs both work through the same code path.
 */
export function buildHeatmapFeatures(
  entities: readonly EntityState[],
  config: DataLinkConfig,
  styleRules: ReadonlyArray<StyleRule>,
  opts: AnchorScope,
  occludedKeys: ReadonlySet<string>,
  cache?: RowBuildCache<GeoJSON.Feature<GeoJSON.Point> | null>,
): GeoJSON.Feature<GeoJSON.Point>[] {
  const activeFloor = opts.activeFloorPlanId ?? null
  const liveIds = opts.liveFloorPlanIds
  const filter = opts.filter ?? null
  const focusedKey = opts.focusedKey ?? null
  const rules = compileEntityRules(styleRules, config.styleRuleIds)
  const tokens = [config, styleRules, activeFloor, liveIds]
  const cacheable = cache !== undefined && !rules.timeDependent
  const rows = cacheable ? cache.rowsFor(tokens) : null
  const features: GeoJSON.Feature<GeoJSON.Point>[] = []
  for (const e of entities) {
    if (focusedKey !== null && e.entityKey === focusedKey) {
      // Focus mode: never occluded, filter and floor gate lifted.
      const focusRows = cacheable ? cache.focusRowsFor(tokens) : null
      let f = focusRows?.get(e)
      if (f === undefined) {
        f = buildHeatmapFeature(e, config, rules.evaluate, null, liveIds)
        focusRows?.set(e, f)
      }
      if (f) {
        features.push(markFocused(f, {
          position: [f.geometry.coordinates[0], f.geometry.coordinates[1]],
          elevationM: elevationOf(f),
          shapeFloor: null,
          payload: e.payload,
        }))
      }
      continue
    }
    // v5.4 — hard-hide: occluded entities do not contribute to density.
    if (occludedKeys.has(e.entityKey)) continue
    // Layer filter + floor gate. Heatmap has no matched shape, so
    // `passesFloorScope` reads floor from the payload only (and
    // treats orphan ids as unknown).
    if (filter && !evaluateDataLinkFilter(e.payload, filter)) continue
    let f = rows?.get(e)
    if (f === undefined) {
      f = buildHeatmapFeature(e, config, rules.evaluate, activeFloor, liveIds)
      rows?.set(e, f)
    }
    if (f) features.push(f)
  }
  return features
}

function buildHeatmapFeature(
  e: EntityState,
  config: DataLinkConfig,
  evaluate: CompiledEntityRules['evaluate'],
  activeFloor: ActiveFloors,
  liveIds: ReadonlySet<number> | undefined,
): GeoJSON.Feature<GeoJSON.Point> | null {
  if (
    !passesFloorScope(
      e.payload,
      config.fieldMapping.floorScope,
      activeFloor,
      liveIds,
    )
  ) {
    return null
  }
  const position = resolvePayloadCoord(e.payload, config)
  if (!position) return null
  const [rawLng, rawLat] = position
  let color: string | undefined
  let opacity: number | undefined
  const override = evaluate(e.payload)
  if (override) {
    if (override.fillColor) color = override.fillColor
    if (override.iconColor && !color) color = override.iconColor
    if (override.fillOpacity !== undefined)
      opacity = override.fillOpacity / 100
  }
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [rawLng, rawLat] },
    properties: {
      entityKey: e.entityKey,
      streamId: e.streamId,
      configId: config.id,
      // v5: heatmap-weight expression coalesces on `weight`, so
      // rules that lower a point's opacity (e.g. "weak-signal RFID"
      // at 40%) also lower its contribution to the density gradient.
      // Defaults to 1 when no rule matches.
      weight: opacity ?? 1,
      color,
      opacity,
      // Only feeds the high-zoom dot layer — the heatmap pass
      // itself is screen-space and has no notion of altitude.
      elevation: resolveAnchorElevation(e.payload, config, null),
      payload: JSON.stringify(e.payload),
    },
  }
}

// ---------------------------------------------------------------------------
// shape-tint
// ---------------------------------------------------------------------------

/** `id → shape`, first occurrence wins (what `Array.find` returned). */
const shapeIndexCache = new WeakMap<ReadonlyArray<{ id?: number }>, Map<number, unknown>>()

function firstById<T extends { id?: number }>(shapes: ReadonlyArray<T>, id: number): T | undefined {
  if (Number.isNaN(id)) return shapes.find((x) => x.id === id)
  let byId = shapeIndexCache.get(shapes) as Map<number, T> | undefined
  if (!byId) {
    byId = new Map()
    for (const s of shapes) {
      if (s.id !== undefined && !byId.has(s.id)) byId.set(s.id, s)
    }
    shapeIndexCache.set(shapes, byId as Map<number, unknown>)
  }
  return byId.get(id)
}

/**
 * Tint fill over every bound polygon / circle. v2: iterate entities →
 * resolveMatchTargets → union of matched shape ids → one tinted feature
 * per shape. Attribute-join hits ALL matching shapes; explicit-shape
 * falls back to the single target as before. `snapshot` is the resolver
 * snapshot (the tint's own polygons / circles + store slices).
 */
export function buildShapeTintFeatures(
  entities: readonly EntityState[],
  config: DataLinkConfig,
  snapshot: MatchStoreSnapshot,
  polygons: ReadonlyArray<PolygonShape>,
  circles: ReadonlyArray<CircleShape>,
  styleRules: ReadonlyArray<StyleRule>,
  opts: AnchorScope,
  occludedKeys: ReadonlySet<string>,
): GeoJSON.Feature<GeoJSON.Polygon>[] {
  const activeFloorPlanId = opts.activeFloorPlanId
  const liveFloorPlanIds = opts.liveFloorPlanIds
  const filter = opts.filter
  const focusedKey = opts.focusedKey ?? null
  const evaluate = compileEntityRules(styleRules, config.styleRuleIds).evaluate

  // shapeId → { color?, opacity?, payload? } — last write wins when
  // multiple entities target the same shape.
  const perShape = new Map<
    number,
    { color?: string; opacity?: number; payload?: Record<string, unknown> }
  >()
  /** Focus mode: the shapes the focused row tints (drawn at full opacity). */
  let focusShapes: Set<number> | null = null
  let focusPayload: Record<string, unknown> | null = null

  // If the config has no entities YET but IS bound to a single shape
  // (explicit or legacy), still tint that shape with the defaults so
  // the visual isn't invisible until the first stream event.
  const alwaysTintFallback = (() => {
    const result = resolveMatchTargets({}, config, snapshot)
    if (result.kind === 'shapes') {
      for (const s of result.shapes) {
        if (s.id !== undefined && !perShape.has(s.id)) {
          perShape.set(s.id, {})
        }
      }
    }
  })

  if (entities.length === 0) {
    alwaysTintFallback()
  } else {
    for (const e of entities) {
      // Focus mode: the focused row is never occluded and skips the
      // filter and the active-floor gate.
      const isFocus = focusedKey !== null && e.entityKey === focusedKey
      // v5.4 — hard-hide: occluded entities do not tint their shape.
      if (!isFocus && occludedKeys.has(e.entityKey)) continue
      // v4 — layer filter first (cheapest gate).
      if (!isFocus && filter && !evaluateDataLinkFilter(e.payload, filter)) continue
      const target = resolveMatchTargets(e.payload, config, snapshot)
      if (target.kind !== 'shapes') continue
      const override = evaluate(e.payload)
      const patch: {
        color?: string
        opacity?: number
        payload?: Record<string, unknown>
      } = {}
      if (override?.fillColor) patch.color = override.fillColor
      else if (override?.iconColor) patch.color = override.iconColor
      if (override?.fillOpacity !== undefined) patch.opacity = override.fillOpacity / 100
      patch.payload = e.payload as Record<string, unknown>
      for (const s of target.shapes) {
        if (s.id === undefined) continue
        // Floor gate honours the config's floorScope + treats orphan
        // shape/payload floor references as unknown. The tinted shape's
        // own floorPlanId is passed as the fallback for `auto` mode.
        const shapeFloor =
          (s as unknown as { floorPlanId?: number }).floorPlanId ?? null
        if (
          !shapeOnEntityFloor(e.payload as Record<string, unknown>, config.fieldMapping.floorScope, shapeFloor) ||
          !passesFloorScope(
            e.payload as Record<string, unknown>,
            config.fieldMapping.floorScope,
            isFocus ? null : (activeFloorPlanId ?? null),
            liveFloorPlanIds,
            shapeFloor,
          )
        ) {
          continue
        }
        perShape.set(s.id, patch)
        if (isFocus) {
          ;(focusShapes ??= new Set()).add(s.id)
          focusPayload = e.payload as Record<string, unknown>
        }
      }
    }
  }

  const features: GeoJSON.Feature<GeoJSON.Polygon>[] = []
  for (const [shapeId, styleForShape] of perShape) {
    const props = {
      configId: config.id,
      color: styleForShape.color,
      opacity: styleForShape.opacity,
      payload: styleForShape.payload
        ? JSON.stringify(styleForShape.payload)
        : undefined,
    }
    // The focused row's tint, when its own write won the shape.
    const focusedShape =
      focusShapes !== null &&
      focusShapes.has(shapeId) &&
      focusPayload !== null &&
      styleForShape.payload === focusPayload
    if (config.targetKind === 'polygon') {
      const p = firstById(polygons, shapeId)
      if (p && p.vertices.length >= 3) {
        const ring: [number, number][] = [...p.vertices, p.vertices[0]]
        const f: GeoJSON.Feature<GeoJSON.Polygon> = {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ring] },
          // Top face, not the base: tinting an extruded room at its
          // base would bury the tint inside the solid. A flat room
          // still draws as a thin slab, so use its drawn top.
          properties: { ...props, elevation: slabTopM(p, POLYGON_MIN_BASE_M, POLYGON_FLAT_SLAB) },
        }
        if (focusedShape) {
          stampFocused(f, {
            position: polygonCentroid(p.vertices) ?? p.vertices[0],
            elevationM: slabTopM(p, POLYGON_MIN_BASE_M, POLYGON_FLAT_SLAB),
            shapeFloor: p.floorPlanId ?? null,
            payload: focusPayload!,
          })
        }
        features.push(f)
      }
    } else if (config.targetKind === 'circle') {
      const c = firstById(circles, shapeId)
      if (c) {
        const center = focusedShape ? centroidForShape(c, 'circle') : null
        for (const feat of buildCircleFeatures(c)) {
          const f: GeoJSON.Feature<GeoJSON.Polygon> = {
            type: 'Feature',
            geometry: feat.geometry,
            properties: { ...props, elevation: slabTopM(c, 0) },
          }
          if (center) {
            stampFocused(f, {
              position: center,
              elevationM: slabTopM(c, 0),
              shapeFloor: c.floorPlanId ?? null,
              payload: focusPayload!,
            })
          }
          features.push(f)
        }
      }
    }
  }
  return features
}

// ---------------------------------------------------------------------------
// track
// ---------------------------------------------------------------------------

/**
 * Per-entity breadcrumb LineString + head point. Groups events by
 * entityKey, sorts by ts ascending, connects the dots.
 */
export function buildTrackFeatures(
  events: readonly EntityEvent[],
  config: DataLinkConfig,
  styleRules: ReadonlyArray<StyleRule>,
  opts: AnchorScope,
  occludedKeys: ReadonlySet<string>,
): {
  lineFeatures: GeoJSON.Feature<GeoJSON.LineString>[]
  headFeatures: GeoJSON.Feature<GeoJSON.Point>[]
} {
  const activeFloorPlanId = opts.activeFloorPlanId
  const liveFloorPlanIds = opts.liveFloorPlanIds
  const filter = opts.filter
  const focusedKey = opts.focusedKey ?? null
  const evaluate = compileEntityRules(styleRules, config.styleRuleIds).evaluate
  // Bucket by entity key. v2: coord read via resolvePayloadCoord()
  // so track shares the same coord path as heatmap + point-at-coord.
  const buckets = new Map<string, Array<{ event: EntityEvent; pos: [number, number] }>>()
  for (const e of events) {
    // Focus mode: the focused track is never occluded and skips the
    // filter and the floor gate.
    const isFocus = focusedKey !== null && e.entityKey === focusedKey
    if (!isFocus) {
      // v5.4 — hard-hide: drop every event belonging to an occluded track.
      if (occludedKeys.has(e.entityKey)) continue
      // Layer filter + floor gate. Track has no matched shape, so
      // `passesFloorScope` reads floor from the payload only (and
      // treats orphan ids as unknown).
      if (filter && !evaluateDataLinkFilter(e.payload, filter)) continue
      if (
        !passesFloorScope(
          e.payload,
          config.fieldMapping.floorScope,
          activeFloorPlanId ?? null,
          liveFloorPlanIds,
        )
      ) {
        continue
      }
    }
    const pos = resolvePayloadCoord(e.payload, config)
    if (!pos) continue
    const bucket = buckets.get(e.entityKey) ?? []
    bucket.push({ event: e, pos })
    buckets.set(e.entityKey, bucket)
  }

  const lineFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = []
  const headFeatures: GeoJSON.Feature<GeoJSON.Point>[] = []
  for (const [entityKey, entries] of buckets) {
    // Sort ascending by ts so the LineString flows past → present.
    entries.sort((a, b) => a.event.ts.getTime() - b.event.ts.getTime())
    const bucket = entries.map((x) => x.event)
    const coords: [number, number][] = entries.map((x) => x.pos)
    // Style-rule override applies against the most recent event's
    // payload — one entity's whole track shares the same color.
    const latestEvent = bucket[bucket.length - 1]
    let color: string | undefined
    let opacity: number | undefined
    let label: string | undefined
    const override = latestEvent
      ? evaluate(latestEvent.payload)
      : null
    if (override) {
      if (override.fillColor) color = override.fillColor
      if (override.iconColor && !color) color = override.iconColor
      if (override.labelText)
        label = resolveLabelTemplate(override.labelText, latestEvent.payload)
      if (override.fillOpacity !== undefined)
        opacity = override.fillOpacity / 100
    }
    const trackPayload = latestEvent
      ? JSON.stringify(latestEvent.payload)
      : undefined
    // `line-z-offset` lifts a whole feature, not a vertex, so the
    // breadcrumb rides at the floor the entity is on NOW. A track
    // that crossed floors mid-history is drawn at its latest one.
    const trackElevation = latestEvent
      ? resolveAnchorElevation(latestEvent.payload, config, null)
      : 0
    if (coords.length >= 2) {
      lineFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {
          entityKey,
          configId: config.id,
          color,
          opacity,
          label,
          elevation: trackElevation,
          payload: trackPayload,
        },
      })
    }
    const latest = coords[coords.length - 1]
    if (latest) {
      const head: GeoJSON.Feature<GeoJSON.Point> = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: latest },
        properties: {
          entityKey,
          configId: config.id,
          color,
          opacity,
          label,
          elevation: trackElevation,
          payload: trackPayload,
        },
      }
      if (entityKey === focusedKey && latestEvent) {
        stampFocused(head, {
          position: [latest[0], latest[1]],
          elevationM: trackElevation,
          shapeFloor: null,
          payload: latestEvent.payload,
        })
      }
      headFeatures.push(head)
    }
  }
  return { lineFeatures, headFeatures }
}

// ---------------------------------------------------------------------------
// roi-pulse
// ---------------------------------------------------------------------------

/**
 * One ring per matched shape (attribute-join can hit many); the count on
 * each ring is the number of entities whose payload resolved to that
 * particular shape. Explicit-shape produces exactly one ring.
 */
export function buildRoiFeatures(
  entities: readonly EntityState[],
  config: DataLinkConfig,
  snapshot: MatchStoreSnapshot,
  styleRules: ReadonlyArray<StyleRule>,
  opts: AnchorScope,
  occludedKeys: ReadonlySet<string>,
): GeoJSON.Feature<GeoJSON.Point>[] {
  const evaluate = compileEntityRules(styleRules, config.styleRuleIds).evaluate
  const focusedKey = opts.focusedKey ?? null
  // Group by (matched shape id, or the coord anchor as a fallback).
  // First entity's style-rule override becomes the ring's colour.
  const perAnchor = new Map<
    string,
    {
      position: [number, number]
      elevation: number
      shapeFloor: number | null
      entities: EntityState[]
      color?: string
      opacity?: number
      payload?: Record<string, unknown>
      /** Focus mode: the focused row counts toward this ring. */
      focus?: EntityState
    }
  >()

  forEachEntityAnchor(
    entities,
    config,
    snapshot,
    ({ entity: e, shape, position, elevation }) => {
      const isFocus = focusedKey !== null && e.entityKey === focusedKey
      // v5.4 — hard-hide: don't count occluded entities toward the ring
      // (the focused row is never occluded).
      if (!isFocus && occludedKeys.has(e.entityKey)) return
      const key = shape?.id !== undefined ? `s:${shape.id}` : `p:${position[0]},${position[1]}`
      let bucket = perAnchor.get(key)
      if (!bucket) {
        bucket = {
          position,
          elevation,
          shapeFloor: (shape as { floorPlanId?: number } | null)?.floorPlanId ?? null,
          entities: [],
        }
        perAnchor.set(key, bucket)
      }
      if (isFocus) bucket.focus = e
      bucket.entities.push(e)
      if (!bucket.color) {
        const override = evaluate(e.payload)
        if (override) {
          if (override.fillColor) bucket.color = override.fillColor
          if (override.iconColor && !bucket.color) bucket.color = override.iconColor
          if (override.fillOpacity !== undefined)
            bucket.opacity = override.fillOpacity / 100
          bucket.payload = e.payload
        }
      }
      if (!bucket.payload) bucket.payload = e.payload
    },
    opts,
  )

  // One row per anchor (a reader, a door sensor) always counts "1";
  // show its `labelField` value instead when one is configured.
  const labelField = config.fieldMapping.labelField
  const badgeText = (bucket: { entities: EntityState[] }): string => {
    if (labelField && bucket.entities.length === 1) {
      const v = readPayloadPath(bucket.entities[0].payload, labelField)
      if (v !== undefined && v !== null && v !== '') return String(v)
    }
    return String(bucket.entities.length)
  }
  const features: GeoJSON.Feature<GeoJSON.Point>[] = []
  for (const bucket of perAnchor.values()) {
    const f: GeoJSON.Feature<GeoJSON.Point> = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: bucket.position },
      properties: {
        configId: config.id,
        count: badgeText(bucket),
        color: bucket.color,
        opacity: bucket.opacity,
        elevation: bucket.elevation,
        payload: bucket.payload ? JSON.stringify(bucket.payload) : undefined,
      },
    }
    if (bucket.focus) {
      stampFocused(f, {
        position: bucket.position,
        elevationM: bucket.elevation,
        shapeFloor: bucket.shapeFloor,
        payload: bucket.focus.payload,
      })
    }
    features.push(f)
  }
  return features
}
