import { useEffect, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import mapboxgl, {
  type Map as MapboxMapInstance,
  type GeoJSONSource,
} from 'mapbox-gl'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import { buildGridFromLine } from '@/lib/grid-generators'
import {
  cellRingCentroid,
  committedCellRing,
  gridBlockersOf,
  gridCellRule,
  onNextCameraSettle,
  stableCollection,
  trackCameraMotion,
  type CollectionSlot,
  type CommittedLine,
  type GridCellRule,
} from '@/components/map-grid-overlay'
import type { Bin, BinStatus } from '@/lib/db'
import { BinPopupContent } from '@/components/bin-popup-content'
import { whenStyleLoaded } from '@/lib/mapbox-style-ready'
import { isFocusFlying } from '@/lib/focus/focus-camera'
import { canLiftExtrusions, FOCUS_LIFT_STATE, withFocusLift } from '@/lib/focus/focus-fade'
import { useFocusBlockers, useFocusScene, type FocusBlockers, type FocusScene } from '@/lib/focus/focus-scene'

const SOURCE_ID = 'bin-status-source'
const LAYER_ID = 'bin-status-layer'

// Dedicated source/layer for the hover-highlight outline. Owned by this
// overlay so we don't have to mutate the grid overlay's paint expressions
// or feature ids. The source carries 0 or 1 feature — the cell currently
// under the cursor; the line layer paints a cyan stroke at the cell's
// altitude so the highlight follows 3D extrusions.
const HOVER_SOURCE = 'data-link-hover-source'
const HOVER_LAYER = 'data-link-hover-line-layer'

/**
 * The grid overlay's cell layers the hover popup listens on — layer ids
 * owned by `map-grid-overlay.tsx`, hardcoded on purpose (part of the
 * public layer contract that overlay exports). The 3D extrusion is split
 * across 11 opacity-bucket layers (`grid-extrude-layer-op0` … `-op100`)
 * since Mapbox doesn't support data-driven `fill-extrusion-opacity`;
 * without enumerating them the hover popup silently dies over
 * 3D-extruded racks. One shared array: Mapbox's `off` needs the same
 * layer list it was given to `on`.
 */
const GRID_HOVER_LAYERS: string[] = [
  'grid-fill-layer',
  ...[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((b) => `grid-extrude-layer-op${b}`),
]

// Solid hex colors. `fill-extrusion-color` strips alpha so we set
// translucency via `fill-extrusion-opacity` on the layer instead.
const STATUS_COLORS: Record<BinStatus, string> = {
  empty: '#94a3b8',     // unused — empty bins are filtered out before render
  occupied: '#3b82f6',  // blue-500
  reserved: '#f59e0b',  // amber-500
}
/** Layer-wide opacity for the status tint. Matches the prior 0.55 visual. */
const STATUS_TINT_OPACITY = 0.55

/**
 * Focus mode (src/lib/focus/). The tint follows its racks: a rack the grid
 * overlay lifts onto a faded twin — `focusTier` 'ghost' (a line-of-sight
 * blocker) or 'near' (in the NEAR column around the item) — loses its
 * tint where its cells fade. The layer colour is wrapped once with
 * `withFocusLift` and the tint features carry id = gridId, so one
 * feature-state write per rack hides its bands (GL 3.25 only — the same
 * `canLiftExtrusions` gate as the grid overlay). A multi-level rack's
 * bands are full-size boxes; left at 0.55 they would hide the focused item
 * the faded rack no longer does.
 *  - 'whole' rack (`gridCellRule`, the grid overlay's per-cell test): the
 *    whole tint is lifted.
 *  - 'cells' rack (much larger than the 5 m region): the tint is lifted
 *    too, and its cells that do NOT fade are redrawn on REST_LAYER — the
 *    same paint at the same constant opacity, colour not wrapped — so only
 *    the tints of fading cells go.
 * Every other rack's tint, and the layer itself, stay exactly as with
 * focus off (no layer dim, no ordering pin). The rest twin is installed on
 * first use, right after LAYER_ID, and removed when focus ends; changes of
 * the same focus land at the next camera settle (`onNextCameraSettle`),
 * with the grid overlay's twins. Outside a focus provider nothing is
 * installed or written.
 */
const LIFTABLE = canLiftExtrusions()
const REST_SOURCE = 'bin-status-focus-rest-source'
const REST_LAYER = 'bin-status-focus-rest-layer'

/** The tint colour by status (no focus wrapper). */
function plainTintColor(): mapboxgl.ExpressionSpecification {
  return [
    'match',
    ['get', 'binStatus'],
    'occupied', STATUS_COLORS.occupied,
    'reserved', STATUS_COLORS.reserved,
    // Fallthrough: status the layer can't tint. Won't be visible
    // because `fill-extrusion-opacity` below + the upstream filter
    // (empty bins are skipped at the source level) keep it hidden.
    '#000000',
  ]
}

/**
 * The tint colour by status — wrapped with `withFocusLift` where lifting
 * works (no `focusLift` feature-state → exactly the plain colour).
 */
function binTintColor(): mapboxgl.ExpressionSpecification {
  const color = plainTintColor()
  return LIFTABLE ? withFocusLift(color) : color
}

const EMPTY_TINTS: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] }

/** What focus mode wants the tints to show. */
export interface BinFocusPlan {
  /** focusKey; '' = focus off. */
  key: string
  /** Racks whose tint is lifted out of LAYER_ID. */
  lifted: ReadonlySet<number>
  liftedKey: string
  /** REST_SOURCE content: the non-fading tints of 'cells' racks (null = empty). */
  rest: FeatureCollection<Polygon> | null
}

const NO_RACKS: ReadonlySet<number> = new Set()
const BIN_FOCUS_OFF: BinFocusPlan = Object.freeze({ key: '', lifted: NO_RACKS, liftedKey: '', rest: null })

type TintFeature = Feature<Polygon>

/** The tint features of each rack, cached per source collection. */
const tintsByGridCache = new WeakMap<FeatureCollection<Polygon>, Map<number, TintFeature[]>>()
function tintsByGrid(data: FeatureCollection<Polygon>): Map<number, TintFeature[]> {
  let out = tintsByGridCache.get(data)
  if (out) return out
  out = new Map()
  for (const f of data.features) {
    const gid = (f.properties as { gridId?: unknown } | null)?.gridId
    if (typeof gid !== 'number') continue
    let list = out.get(gid)
    if (!list) {
      list = []
      out.set(gid, list)
    }
    list.push(f)
  }
  tintsByGridCache.set(data, out)
  return out
}

/** A rack's tints whose cell `rule` does not fade, cached per (list, rule). */
const restTintCache = new WeakMap<readonly TintFeature[], WeakMap<GridCellRule, TintFeature[]>>()
function restTintsOf(list: readonly TintFeature[], rule: GridCellRule): TintFeature[] {
  let byRule = restTintCache.get(list)
  const hit = byRule?.get(rule)
  if (hit) return hit
  const out: TintFeature[] = []
  for (const f of list) {
    const p = f.properties as { row?: unknown; col?: unknown; level?: unknown } | null
    const row = typeof p?.row === 'number' ? p.row : NaN
    const col = typeof p?.col === 'number' ? p.col : NaN
    const level = typeof p?.level === 'number' ? p.level : 0
    const c = cellRingCentroid(f.geometry.coordinates[0])
    if (!rule.fades(row, col, level, c[0], c[1])) out.push(f)
  }
  if (!byRule) {
    byRule = new WeakMap()
    restTintCache.set(list, byRule)
  }
  byRule.set(rule, out)
  return out
}

/** What the focus pass last wrote on one map (tied to the source objects it wrote to). */
export interface BinFocusRuntime {
  map: MapboxMapInstance | null
  /** Latest plan (the component sets it; a deferred pass reads it). */
  plan: BinFocusPlan
  /** The plan the lifts / rest twin on the map belong to. */
  applied: BinFocusPlan
  /** The source object the lifts were written to. */
  liftSource: unknown
  written: Set<number>
  /** The REST_SOURCE object `restData` went to. */
  restSource: unknown
  restData: FeatureCollection<Polygon> | null
  disarmSettle: (() => void) | null
  disarmRender: (() => void) | null
}

export function createBinFocusRuntime(): BinFocusRuntime {
  return {
    map: null,
    plan: BIN_FOCUS_OFF,
    applied: BIN_FOCUS_OFF,
    liftSource: null,
    written: new Set(),
    restSource: null,
    restData: null,
    disarmSettle: null,
    disarmRender: null,
  }
}

/** `style.getOwnLayer` (the live layer object) — `map.getLayer` serialises it. */
function hasOwnLayer(map: MapboxMapInstance, id: string): boolean {
  const style = (map as unknown as { style?: { getOwnLayer?: (id: string) => unknown } }).style
  try {
    if (style && typeof style.getOwnLayer === 'function') return !!style.getOwnLayer(id)
    return !!map.getLayer(id)
  } catch {
    return false
  }
}

/** The first own root layer after `id` (undefined: none, or `id` missing — append). */
function layerAfter(map: MapboxMapInstance, id: string): string | undefined {
  const order = (map as unknown as { style?: { _order?: unknown } }).style?._order
  if (!Array.isArray(order)) return undefined
  const ids = order as string[]
  const i = ids.indexOf(id)
  if (i < 0) return undefined
  // Imported (basemap) layers read `id\u001fscope`; addLayer can't anchor on them.
  for (let k = i + 1; k < ids.length; k++) if (!ids[k].includes('\u001f')) return ids[k]
  return undefined
}

/** Add REST_SOURCE / REST_LAYER (empty, right after LAYER_ID) unless there. */
function installRestTwin(map: MapboxMapInstance): void {
  try {
    if (!map.getSource(REST_SOURCE)) map.addSource(REST_SOURCE, { type: 'geojson', data: EMPTY_TINTS })
    if (!hasOwnLayer(map, REST_LAYER)) {
      map.addLayer(
        {
          id: REST_LAYER,
          type: 'fill-extrusion',
          source: REST_SOURCE,
          paint: {
            'fill-extrusion-color': plainTintColor(),
            'fill-extrusion-base': ['coalesce', ['get', 'base'], 0],
            'fill-extrusion-height': ['coalesce', ['get', 'top'], 0],
            'fill-extrusion-opacity': STATUS_TINT_OPACITY,
            'fill-extrusion-vertical-gradient': false,
          },
        },
        hasOwnLayer(map, LAYER_ID) ? layerAfter(map, LAYER_ID) : undefined,
      )
    }
  } catch { /* style torn down / mid swap: the next pass retries */ }
}

function removeRestTwin(map: MapboxMapInstance): void {
  try {
    if (hasOwnLayer(map, REST_LAYER)) map.removeLayer(REST_LAYER)
    if (map.getSource(REST_SOURCE)) map.removeSource(REST_SOURCE)
  } catch { /* style torn down */ }
}

/** Lift every rack of the applied plan not lifted yet (one feature-state write each). */
function writeTintLifts(map: MapboxMapInstance, rt: BinFocusRuntime): void {
  if (!map.getSource(SOURCE_ID) || map.getSource(SOURCE_ID) !== rt.liftSource) return
  for (const id of rt.applied.lifted) {
    if (rt.written.has(id)) continue
    try {
      map.setFeatureState({ source: SOURCE_ID, id }, { [FOCUS_LIFT_STATE]: true })
    } catch { /* source went away */ }
    rt.written.add(id)
  }
}

function applyBinFocus(map: MapboxMapInstance, rt: BinFocusRuntime, plan: BinFocusPlan): void {
  const src = map.getSource(SOURCE_ID)
  if (src !== rt.liftSource) {
    rt.liftSource = src
    rt.written = new Set()
  }
  // 1. Un-lift first: LAYER_ID draws the tint again before the rest twin
  //    lets go of it — both for a frame, never neither.
  if (src) {
    for (const id of [...rt.written]) {
      if (plan.lifted.has(id)) continue
      try {
        map.removeFeatureState({ source: SOURCE_ID, id }, FOCUS_LIFT_STATE)
      } catch { /* source went away */ }
      rt.written.delete(id)
    }
  }
  // 2. The rest twin: installed on first use, emptied while focus has no
  //    'cells' rack, removed when focus ends.
  let pushed = false
  if (plan.key === '') {
    if (rt.restSource !== null || map.getSource(REST_SOURCE)) removeRestTwin(map)
    rt.restSource = null
    rt.restData = null
  } else if (plan.rest || rt.restData) {
    if (plan.rest) installRestTwin(map)
    const rest = map.getSource(REST_SOURCE) as GeoJSONSource | undefined
    if (rest !== rt.restSource) {
      rt.restSource = rest ?? null
      rt.restData = null
    }
    if (rest && plan.rest !== rt.restData) {
      rest.setData(plan.rest ?? EMPTY_TINTS)
      rt.restData = plan.rest
      pushed = plan.rest !== null
    }
  }
  rt.applied = plan
  // 3. Lifts: once the rest twin has drawn what it took over.
  let pending = false
  for (const id of plan.lifted) {
    if (!rt.written.has(id)) {
      pending = true
      break
    }
  }
  if (!pending) return
  if (!pushed) {
    writeTintLifts(map, rt)
    return
  }
  if (rt.disarmRender) return
  const onRender = () => {
    try {
      if (map.getSource(REST_SOURCE) && !map.isSourceLoaded(REST_SOURCE)) return
    } catch { /* fall through: lift anyway */ }
    map.off('render', onRender)
    rt.disarmRender = null
    writeTintLifts(map, rt)
  }
  map.on('render', onRender)
  rt.disarmRender = () => map.off('render', onRender)
  map.triggerRepaint()
}

/**
 * Bring the map to `rt.plan` — the grid overlay's rule: entering, leaving
 * and switching focus (and a focus fly) apply at once; any other change of
 * the same focus waits for the next camera settle, so the rest twin is
 * never re-uploaded mid-move. `settled`: called from that settle.
 */
export function syncBinFocus(map: MapboxMapInstance, rt: BinFocusRuntime, settled = false): void {
  if (rt.map !== map) {
    const plan = rt.plan
    disposeBinFocusRuntime(rt)
    rt.map = map
    rt.plan = plan
  }
  const plan = rt.plan
  const applied = rt.applied
  const same = plan.key === applied.key && plan.liftedKey === applied.liftedKey && plan.rest === applied.rest
  if (!settled && !same && plan.key !== '' && plan.key === applied.key && !isFocusFlying(map)) {
    if (!rt.disarmSettle) {
      rt.disarmSettle = onNextCameraSettle(map, () => {
        rt.disarmSettle = null
        if (rt.map === map) syncBinFocus(map, rt, true)
      })
    }
    return
  }
  if (rt.disarmSettle) {
    rt.disarmSettle()
    rt.disarmSettle = null
  }
  applyBinFocus(map, rt, plan)
}

/** Stop listening, drop the rest twin, forget the map (unmount / map change). */
function disposeBinFocusRuntime(rt: BinFocusRuntime): void {
  rt.disarmSettle?.()
  rt.disarmRender?.()
  const map = rt.map
  // After `map.remove()` the style is gone (and so is the twin).
  if (map && rt.restSource !== null && (map as unknown as { style?: unknown }).style) removeRestTwin(map)
  Object.assign(rt, createBinFocusRuntime())
}

export type LiftedSlot = { key: string; set: ReadonlySet<number> } | null

/**
 * The tint plan for one focus scene: every near / blocker rack is lifted;
 * a 'cells' rack's non-fading tints go to the rest twin. `slots` keep the
 * lifted set and the rest collection by identity while unchanged.
 */
export function buildBinFocusPlan(
  scene: FocusScene,
  blockers: FocusBlockers,
  committedLines: readonly CommittedLine[],
  data: FeatureCollection<Polygon> | null,
  slots: { rest: { current: CollectionSlot<Polygon> }; lifted: { current: LiftedSlot } },
): BinFocusPlan {
  if (!LIFTABLE || !scene.active) return BIN_FOCUS_OFF
  const lifted: number[] = []
  const restLists: TintFeature[][] = []
  const tints = data ? tintsByGrid(data) : null
  for (const cl of committedLines) {
    if (cl.visible === false) continue
    let cells
    try {
      cells = rackCells(cl)
    } catch {
      continue
    }
    const rule = gridCellRule(scene, blockers, cl.id, cells)
    if (!rule) continue
    lifted.push(cl.id)
    if (rule.plan.mode !== 'cells') continue
    const list = tints?.get(cl.id)
    if (!list) continue
    const rest = restTintsOf(list, rule)
    if (rest.length > 0) restLists.push(rest)
  }
  const liftedKey = lifted.sort((a, b) => a - b).join(',')
  let liftedSet = slots.lifted.current?.key === liftedKey ? slots.lifted.current.set : null
  if (!liftedSet) {
    liftedSet = lifted.length > 0 ? new Set(lifted) : NO_RACKS
    slots.lifted.current = { key: liftedKey, set: liftedSet }
  }
  const rest = restLists.length > 0 ? stableCollection<Polygon>(slots.rest, restLists) : null
  return { key: scene.key, lifted: liftedSet, liftedKey, rest }
}

interface MapBinOverlayProps {
  map: MapboxMapInstance | null
  /** Same shape array the grid overlay renders — we re-build the cells so we can stamp per-cell binStatus. */
  committedLines: CommittedLine[]
  /** All bin rows for the warehouses on the map. Filtered down per grid below. */
  bins: ReadonlyArray<Bin>
  /** Master visibility toggle (matches the racks-visible toolbar toggle). */
  visible: boolean
}

/**
 * Paints a translucent status tint on top of saved rack cells that have
 * a bin row attached. Cells without a row are not drawn (the underlying
 * rack styling shows through). Renders as a 3D fill-extrusion so the
 * tint sits at the correct altitude on multi-level pallet racks:
 * `fill-extrusion-base = baseElevation + level * levelHeight`. For
 * single-level grids (legacy behaviour, `levels === 1`), the extrusion
 * collapses to height 0 and is invisible — clicks fall through to the
 * regular grid overlay either way.
 *
 * Click handling is intentionally not added here — clicks fall through
 * to the grid overlay's click handler, which already knows how to pick
 * (gridId, row, col, level) and open the bin editor.
 */
/**
 * A rack's cells, rebuilt only when the rack's config object or corners
 * change — the store keeps an unchanged rack's config the same object, so
 * dragging one rack's slider no longer re-tessellates every rack here.
 */
const cellCache = new WeakMap<object, { id: number; start: unknown; current: unknown; cells: ReturnType<typeof buildGridFromLine>['cells'] }>()
function rackCells(cl: CommittedLine) {
  const hit = cellCache.get(cl.config)
  if (hit && hit.id === cl.id && hit.start === cl.start && hit.current === cl.current) return hit.cells
  const cells = buildGridFromLine(cl.start, cl.current, cl.config, { committed: true, gridId: cl.id }).cells
  cellCache.set(cl.config, { id: cl.id, start: cl.start, current: cl.current, cells })
  return cells
}

export function MapBinOverlay({
  map,
  committedLines,
  bins,
  visible,
}: MapBinOverlayProps) {
  // Build cell features for every saved bin. We have to re-run the
  // grid builder because the bin row only carries the (gridId, row,
  // col, level) key — the geometry lives on the parent grid.
  const data = useMemo<FeatureCollection<Polygon> | null>(() => {
    if (!visible || bins.length === 0 || committedLines.length === 0) return null
    // Group bins by `gridId` then by `"row-col-level"` for cheap
    // lookup when iterating the rebuilt cells. A flat Map keyed on the
    // triplet would also work but the two-level structure lets us skip
    // grids whose bins are all empty without rebuilding their cells.
    const byGrid = new Map<number, Map<string, Bin>>()
    for (const b of bins) {
      // v7+: bins may also target non-grid shapes; this overlay paints
      // grid-cell status tints only, so skip anything else.
      if (b.targetKind !== 'grid-cell' || b.gridId === undefined) continue
      let inner = byGrid.get(b.gridId)
      if (!inner) {
        inner = new Map()
        byGrid.set(b.gridId, inner)
      }
      inner.set(`${b.row}-${b.col}-${b.level ?? 0}`, b)
    }

    const features: Feature<Polygon>[] = []
    for (const cl of committedLines) {
      // Hidden rack → hide its bins too, so the layer toggle actually
      // clears everything the user associates with the rack.
      if (cl.visible === false) continue
      const binsForGrid = byGrid.get(cl.id)
      if (!binsForGrid) continue
      let cells
      try {
        cells = rackCells(cl)
      } catch (err) {
        console.warn('[MapBinOverlay] grid build failed', err, cl)
        continue
      }
      const totalLevels = Math.max(1, Math.floor(cl.config.levels ?? 1))
      const levelHeight = Math.max(0, cl.config.levelHeight ?? 0)
      const levelGap = Math.max(0, cl.config.levelGap ?? 0)
      for (const c of cells) {
        const level = c.properties.level ?? 0
        const key = `${c.properties.row}-${c.properties.col}-${level}`
        const bin = binsForGrid.get(key)
        if (!bin) continue
        // Skip empty bins — they're indistinguishable from "no bin row"
        // visually and we don't want to repaint over the rack color.
        if (bin.status === 'empty') continue
        // Compute the tint band's base + height. For single-level
        // grids we collapse to a thin band on top of the cell so the
        // tint is visible without ballooning into the air. For
        // multi-level racks each level's band hugs its own shelf.
        // The pitch is `levelHeight + levelGap` to match
        // `buildSquareGrid`'s altitude formula — otherwise tints land
        // in the wrong shelf when `levelGap > 0`.
        // The cell's own elevation already carries the level offset and,
        // on a raked path grid, its row's rise.
        const cellBase =
          c.properties.elevation ??
          (cl.config.elevation ?? 0) + (totalLevels > 1 ? level * (levelHeight + levelGap) : 0)
        const base = totalLevels > 1 ? cellBase : cellBase + (cl.config.height ?? 0)
        const top =
          totalLevels > 1 ? base + levelHeight : base + 0.01
        features.push({
          type: 'Feature',
          // One id per rack: focus mode hides a faded (near / blocking)
          // rack's tint with a single feature-state write. (Nothing
          // queries this layer.)
          id: cl.id,
          properties: {
            gridId: cl.id,
            row: c.properties.row,
            col: c.properties.col,
            level,
            binStatus: bin.status,
            base,
            top,
          },
          geometry: c.geometry,
        })
      }
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [committedLines, bins, visible])

  useEffect(() => {
    if (!map) return
    const apply = () => {
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getLayer(LAYER_ID)) {
        // We use fill-extrusion (not flat fill) so multi-level racks
        // can have each level's tint sit at its own altitude. For
        // legacy single-level grids the base equals the grid's
        // elevation+height and the band is 0.01 m thick — visually
        // identical to a flat fill but renders in 3D, which keeps the
        // paint expression uniform.
        map.addLayer({
          id: LAYER_ID,
          type: 'fill-extrusion',
          source: SOURCE_ID,
          paint: {
            'fill-extrusion-color': binTintColor(),
            'fill-extrusion-base': ['coalesce', ['get', 'base'], 0],
            'fill-extrusion-height': ['coalesce', ['get', 'top'], 0],
            // `fill-extrusion-color` strips alpha — drive translucency
            // through the dedicated opacity property instead. Constant
            // for now; data-driven per-status pulse / heatmap is Phase 2.
            'fill-extrusion-opacity': STATUS_TINT_OPACITY,
            'fill-extrusion-vertical-gradient': false,
          },
        })
      }
      const src = map.getSource(SOURCE_ID) as GeoJSONSource | undefined
      if (src) src.setData(data ?? { type: 'FeatureCollection', features: [] })

      // Hover-highlight scaffolding. Source starts empty; the mousemove
      // handler below populates it with the cell currently under the
      // cursor. Line layer sits on top of everything (added last) so the
      // highlight is never occluded by other overlays.
      if (!map.getSource(HOVER_SOURCE)) {
        map.addSource(HOVER_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getLayer(HOVER_LAYER)) {
        map.addLayer({
          id: HOVER_LAYER,
          type: 'line',
          source: HOVER_SOURCE,
          paint: {
            // Cyan — distinct from the yellow selection outline and the
            // blue/amber status tints, so all three can coexist visually.
            'line-color': '#22d3ee',
            'line-width': 3,
            'line-opacity': 0.95,
            // We deliberately leave `line-occlusion-opacity` at its
            // spec default of 0 so a 3D model / building in front of
            // the rack hides the hover outline it occludes (otherwise
            // the cyan line ghosts through every occluder). The 2 cm
            // epsilon in `line-z-offset` below already wins the depth
            // test against the rack's own roof.
            // Keep the highlight fully bright over lit 3D extrusions in
            // the Mapbox Standard style (v3 lighting model).
            'line-emissive-strength': 1,
          },
          layout: {
            // Sit the outline just above the cell's top surface in 3D so
            // it's visible on extruded racks. Falls back to ground level
            // when elevation/height aren't present in the feature.
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ['coalesce', ['get', 'height'], 0],
              0.02,
            ],
          },
        })
      }
    }
    if (map.isStyleLoaded()) apply()
    else map.once('style.load', apply)
    return () => {
      // Don't remove the source/layer on every re-render; only on full
      // unmount. We detect "real" unmount by checking the map instance
      // is still valid and removing safely.
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
        if (map.getLayer(HOVER_LAYER)) map.removeLayer(HOVER_LAYER)
        if (map.getSource(HOVER_SOURCE)) map.removeSource(HOVER_SOURCE)
      } catch {
        // Map already torn down — ignore.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  useEffect(() => {
    if (!map) return
    // A data update can land while Mapbox is mid-style-change (common
    // when the toolbar layer toggle re-orders sibling overlays' layers,
    // which triggers a synchronous style rebuild). Silently returning on
    // `!isStyleLoaded()` — the pre-fix behaviour — leaves stale features
    // in the source until the next data reference change; for the hide
    // path (`data === null` twice in a row) that "next change" never
    // comes and the racks stayed visible after the toggle.
    //
    // `whenStyleLoaded` uses both a `style.load` listener AND a poll —
    // the poll is critical because `style.load` only fires on a fresh
    // `setStyle()`, not on a transient `isStyleLoaded()===false` during
    // layer churn (which is exactly the case that regressed here).
    return whenStyleLoaded(map, () => {
      const src = map.getSource(SOURCE_ID) as GeoJSONSource | undefined
      if (src) src.setData(data ?? { type: 'FeatureCollection', features: [] })
    }, '[MapBinOverlay:setData]')
  }, [map, data])

  // ---- Focus mode -------------------------------------------------------
  // Per rack, the grid overlay's cell rule (`gridCellRule`): 'whole' racks
  // lose their whole tint, 'cells' racks keep the tints of their cells that
  // don't fade on the rest twin. The grid set / pierce discs / blocking
  // cells only (`gridBlockersOf`), so another kind's blockers changing
  // rebuilds nothing; the rest collection keeps its identity while its
  // per-rack lists do, so an unchanged plan writes nothing.
  const focusScene = useFocusScene()
  const gridFocusBlockers = gridBlockersOf(useFocusBlockers())
  const restSlot = useRef<CollectionSlot<Polygon>>(null)
  const liftedSlot = useRef<LiftedSlot>(null)
  // The slots are memo caches written idempotently during render, like the
  // grid overlay's per-source slots.
  const focusPlan = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      buildBinFocusPlan(focusScene, gridFocusBlockers, committedLines, data, { rest: restSlot, lifted: liftedSlot }),
    [focusScene, gridFocusBlockers, committedLines, data],
  )
  const focusRtRef = useRef<BinFocusRuntime | null>(null)
  useEffect(() => {
    if (!map) return
    trackCameraMotion(map)
    const rt = (focusRtRef.current ??= createBinFocusRuntime())
    return () => disposeBinFocusRuntime(rt)
  }, [map])
  useEffect(() => {
    if (!map) return
    const rt = (focusRtRef.current ??= createBinFocusRuntime())
    rt.plan = focusPlan
    // The pass skips a source that isn't there yet (style still loading);
    // `data` is a dep so it catches up with the first push.
    syncBinFocus(map, rt)
  }, [map, focusPlan, data])

  // ---- Hover popup ------------------------------------------------------
  // Originally bound to `bin-status-layer`, but that layer filters out
  // bins with status='empty' (the default for imports without a status
  // column), so freshly-imported bins had no hit target. We now listen
  // on the grid overlay's own cell layers — those always exist for any
  // saved grid — and look the bin up by (gridId, row, col, level). The
  // popup only renders when the bin actually carries some data, so
  // hovering empty cells stays clean.
  const binsRef = useRef(bins)
  useEffect(() => {
    binsRef.current = bins
  }, [bins])
  const popupRef = useRef<mapboxgl.Popup | null>(null)
  const popupRootRef = useRef<Root | null>(null)
  const popupNodeRef = useRef<HTMLElement | null>(null)

  // Ref-mirror so the hover handler can find a hovered cell's grid
  // without re-subscribing when the array changes.
  const committedLinesRef = useRef(committedLines)
  useEffect(() => {
    committedLinesRef.current = committedLines
  }, [committedLines])

  useEffect(() => {
    if (!map) return

    // What the hover source holds now, so a mousemove that lands on the
    // same cell (with the same outline and altitude) skips the setData.
    let shown: { ring: unknown; elevation: number; height: number } | null = null
    const setHoverFeature = (
      f: mapboxgl.MapboxGeoJSONFeature | null,
      ring: GeoJSON.Position[] | null = null,
    ) => {
      const src = map.getSource(HOVER_SOURCE) as GeoJSONSource | undefined
      if (!src) return
      if (!f) {
        shown = null
        src.setData({ type: 'FeatureCollection', features: [] })
        return
      }
      const elevation = (f.properties as { elevation?: number } | null)?.elevation ?? 0
      const height = (f.properties as { height?: number } | null)?.height ?? 0
      if (ring && shown && shown.ring === ring && Object.is(shown.elevation, elevation) && Object.is(shown.height, height)) return
      shown = ring ? { ring, elevation, height } : null
      src.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            // Forward elevation/height so the line layer's z-offset
            // expression places the outline at the cell's top in 3D.
            properties: { elevation, height },
            geometry: ring ? { type: 'Polygon', coordinates: [ring] } : (f.geometry as Polygon),
          },
        ],
      })
    }

    // Track which cell is currently rendered inside the popup. Calling
    // `mapboxgl.Popup.addTo()` on an already-attached popup destructively
    // re-attaches the DOM (replaying the CSS entry animation) and
    // re-renders React with the same bin reconciles cheaply but
    // unnecessarily — so we short-circuit both when nothing changed.
    let renderedCellKey: string | null = null

    // One delegated listener over every grid cell layer (one query per
    // mousemove instead of twelve). It used to be one listener per layer,
    // fired in GRID_HOVER_LAYERS order, so the hover ended on the top hit
    // of the LAST layer under the cursor — the same pick is made here from
    // the combined hit list.
    const onMove = (e: mapboxgl.MapLayerMouseEvent) => {
      const hits = e.features ?? []
      let f: mapboxgl.MapboxGeoJSONFeature | undefined
      for (let i = GRID_HOVER_LAYERS.length - 1; i >= 0 && !f; i--) {
        f = hits.find((h) => h.layer?.id === GRID_HOVER_LAYERS[i])
      }
      if (!f) return clearHover()
      const props = f.properties as
        | { gridId?: number; row?: number; col?: number; level?: number }
        | undefined
      if (
        !props ||
        typeof props.gridId !== 'number' ||
        typeof props.row !== 'number' ||
        typeof props.col !== 'number'
      ) {
        return clearHover()
      }
      const level = typeof props.level === 'number' ? props.level : 0
      // Highlight outline always paints — even on cells without linked
      // data — so the user gets a clear "this cell is under your cursor"
      // affordance. The popup below is gated on bin content. The outline
      // is the cell itself (the rendered feature is its tile copy, which
      // can be cut off at a tile edge); the tile copy is the fallback.
      const gridId = props.gridId
      const cl = committedLinesRef.current.find((l) => l.id === gridId)
      setHoverFeature(f, cl ? committedCellRing(cl, props.row, props.col, level) : null)
      map.getCanvas().style.cursor = 'pointer'

      const bin = binsRef.current.find(
        (b) =>
          b.targetKind === 'grid-cell' &&
          b.gridId === props.gridId &&
          b.row === props.row &&
          b.col === props.col &&
          (b.level ?? 0) === level,
      )
      if (!bin || !hasMeaningfulData(bin)) {
        if (popupRef.current?.isOpen()) popupRef.current.remove()
        renderedCellKey = null
        return
      }
      if (!popupRef.current) {
        popupRef.current = new mapboxgl.Popup({
          closeButton: false,
          closeOnClick: false,
          // 12px lift so the popup tail sits just above the cursor instead
          // of obscuring the hovered cell.
          offset: 12,
          className: 'bin-hover-popup',
          maxWidth: '340px',
        })
      }
      if (!popupNodeRef.current) {
        popupNodeRef.current = document.createElement('div')
        popupRootRef.current = createRoot(popupNodeRef.current)
        popupRef.current.setDOMContent(popupNodeRef.current)
      }
      const cellKey = `${props.gridId}:${props.row}:${props.col}:${level}`
      if (renderedCellKey !== cellKey) {
        popupRootRef.current?.render(<BinPopupContent bin={bin} />)
        renderedCellKey = cellKey
      }
      popupRef.current.setLngLat(e.lngLat)
      if (!popupRef.current.isOpen()) popupRef.current.addTo(map)
    }
    const clearHover = () => {
      if (popupRef.current?.isOpen()) popupRef.current.remove()
      renderedCellKey = null
      setHoverFeature(null)
      // Reset cursor only when we set it — the grid overlay sets its own
      // cursors for click-to-select / draw modes, so we don't want to
      // stomp those.
      if (map.getCanvas().style.cursor === 'pointer') {
        map.getCanvas().style.cursor = ''
      }
    }
    const hidePopup = clearHover
    map.on('mousemove', GRID_HOVER_LAYERS, onMove)
    map.on('mouseleave', GRID_HOVER_LAYERS, hidePopup)
    return () => {
      map.off('mousemove', GRID_HOVER_LAYERS, onMove)
      map.off('mouseleave', GRID_HOVER_LAYERS, hidePopup)
      // After `map.remove()` runs (e.g. on unmount or route change —
      // the sibling `MapboxMap` cleanup tears down the map before this
      // one fires), the map's internal `style` is undefined, so
      // `hidePopup -> setHoverFeature -> map.getSource` crashes with
      // "Cannot read properties of undefined (reading 'getOwnSource')".
      // Skip the hover-state cleanup in that case — the popup and
      // hover source are gone with the map anyway.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((map as any).style) hidePopup()
      else if (popupRef.current?.isOpen()) popupRef.current.remove()
      // Defer unmount past the current render commit — unmounting a
      // root synchronously inside an effect cleanup triggers a React
      // warning. Re-mount happens on the next effect run.
      if (popupRootRef.current) {
        const root = popupRootRef.current
        popupRootRef.current = null
        popupNodeRef.current = null
        queueMicrotask(() => root.unmount())
      }
    }
  }, [map])

  return null
}

/** True when the bin carries at least one user-visible field. */
export function hasMeaningfulData(bin: Bin): boolean {
  if (bin.externalCode) return true
  if (bin.sku) return true
  if (typeof bin.capacity === 'number') return true
  if (bin.notes) return true
  if (bin.status && bin.status !== 'empty') return true
  if (bin.customProperties && Object.keys(bin.customProperties).length > 0) return true
  return false
}

/**
 * Build the popup HTML body. Plain string instead of React because
 * mapboxgl.Popup wants a DOM string and round-tripping through React
 * portals for a hover tooltip is more machinery than the surface
 * deserves. We HTML-escape user-supplied strings (externalCode, custom
 * property values) since they can come from imported CSVs.
 */
export function renderPopupHtml(bin: Bin): string {
  const esc = (s: unknown) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  const lines: string[] = []
  if (bin.externalCode) {
    lines.push(
      `<div class="bin-popup-code">${esc(bin.externalCode)}</div>`,
    )
  }
  if (bin.sku) {
    lines.push(`<div class="bin-popup-row"><span>SKU</span><span>${esc(bin.sku)}</span></div>`)
  }
  if (typeof bin.capacity === 'number') {
    lines.push(
      `<div class="bin-popup-row"><span>Capacity</span><span>${esc(bin.capacity.toLocaleString())}</span></div>`,
    )
  }
  if (bin.status && bin.status !== 'empty') {
    lines.push(
      `<div class="bin-popup-row"><span>Status</span><span class="bin-popup-status bin-popup-status-${esc(bin.status)}">${esc(bin.status)}</span></div>`,
    )
  }
  // Top 4 custom properties — keep the popup compact.
  const entries = Object.entries(bin.customProperties ?? {}).slice(0, 4)
  for (const [k, v] of entries) {
    lines.push(`<div class="bin-popup-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
  }
  if (lines.length === 0) {
    lines.push(`<div class="bin-popup-empty">No linked data</div>`)
  }
  return `<div class="bin-popup">${lines.join('')}</div>`
}
