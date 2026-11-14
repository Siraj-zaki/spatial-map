import {
  buildCircleFeatureCollection,
  buildCircleFeatures,
  type CirclePolygonProps,
} from '@/lib/circle-generators'
import { taperedSolidMeshes } from '@/lib/sloped-mesh'
import { useShapeMeshLayers } from '@/hooks/useShapeMeshLayers'
import { sameClipFootprints, syncBasemapClipLayer, useBasemapClipNeeded } from '@/lib/basemap-clip'
import { destination as turfDestination, point as turfPoint } from '@turf/turf'
import { higherPriorityAt } from '@/lib/overlay-hit-priority'
import {
  hintLayerEmpty,
  registerLayerFeaturePredicate,
  type LayerFeaturePredicate,
} from '@/lib/empty-layer-gate'
import { useGraphicsSettings } from '@/lib/graphics-settings'
import { patchFeatureCollection } from '@/lib/focus/focus-fade'
import {
  cutRegionContains,
  focusCutRegion,
  focusFadeCollection,
  isCutWorthy,
  meshCutAway,
  type FocusPiece,
} from '@/lib/focus/focus-cutaway'
import {
  blockerIdsOf,
  blockerPierceOf,
  focusFactor,
  useFocusBlockers,
  useFocusScene,
} from '@/lib/focus/focus-scene'
import { stableDerivedCollection } from '@/components/map-line-overlay'
import type { CircleShape } from '@/lib/shapes'
import {
  TRANSFORM_ICON,
  readThemePrimaryForegroundHex,
  readThemePrimaryHex,
  registerTransformHandleIcons,
  subscribeThemeChanges,
} from '@/lib/map-transform-handles'
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapboxMapInstance,
  MapMouseEvent,
} from 'mapbox-gl'
import { useEffect, useMemo, useRef, useState } from 'react'

interface MapCircleOverlayProps {
  map: MapboxMapInstance | null
  /** Committed circles (single + grid sub-modes). */
  circles?: ReadonlyArray<CircleShape>
  /** A draft shape used for in-progress drawing (preview). */
  livePreview?: CircleShape | null
  selectedCircleIds?: ReadonlySet<number>
  onCircleClick?: (id: number, originalEvent: MouseEvent) => void
  onMapClickEmpty?: () => void
  committedVisible?: boolean
  /**
   * When false, clicks on circles pass through to the map (no
   * `preventDefault`, no selection callback). Set to false during
   * create-* tool modes so the user can drop a new shape directly on
   * top of an existing circle.
   */
  selectionEnabled?: boolean
  /**
   * When set, the overlay renders an interactive drag handle for the
   * given circle. Dragging the handle fires `onTransformChange` with
   * patch values (center for single mode, start+current for grid mode);
   * `commit` is true on dragend so the caller can persist.
   */
  transformState?: { circleId: number; kind: 'move' | 'rotate' } | null
  onTransformChange?: (
    patch: {
      center?: [number, number]
      start?: [number, number]
      current?: [number, number]
      rotation?: number
    },
    commit: boolean
  ) => void
  /** Per-shape style overrides from the style-rules engine. */
  shapeStyleOverrides?: ReadonlyMap<number, import('@/lib/circle-generators').CircleStyleOverride> | null
}

const FILL_SOURCE = 'circle-fill-source'
const FILL_LAYER = 'circle-fill-layer'
const LINE_LAYER = 'circle-line-layer'

// `fill-extrusion-opacity` rejects data expressions in Mapbox GL JS 3.x,
// so per-shape opacity goes through one constant-opacity layer per
// bucket. The generator stamps `properties.opacityBucket` (0–100, rounded
// to nearest 10) and each layer filters its features in.
const OPACITY_BUCKETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const
const EXTRUDE_LAYER_BASE = 'circle-extrude-layer'
const EXTRUDE_LAYER_IDS = OPACITY_BUCKETS.map((b) => `${EXTRUDE_LAYER_BASE}-op${b}`)
const extrudeLayerId = (bucket: number) => `${EXTRUDE_LAYER_BASE}-op${bucket}`
const SELECTION_LAYER = 'circle-selection-line-layer'
const SELECTION_TINT_LAYER = 'circle-selection-tint-layer'
// Tapered / dome circles are drawn as meshes (useShapeMeshLayers); their
// extruded feature stays in the zero-opacity bucket as the click target, so
// the roof outline and the extruded selection wash must skip it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NOT_MESHED: any = ['!=', ['get', 'meshed'], true]
// Focus mode (src/lib/focus): a faded circle also carries its fade factor
// as `focusFade`, so the border fades with the fill. No feature carries it
// while nothing is focused, so the border draws at 1, its old default.
const FOCUS_FADE_PROP = 'focusFade'
const BORDER_OPACITY = ['coalesce', ['get', FOCUS_FADE_PROP], 1] as ExpressionSpecification

// ---- Focus mode: circle-grid rows (local cut-away) -------------------------
// A circle grid is many features sharing one `circleId`. When a near /
// blocker grid is much larger than its cut region (isCutWorthy over the
// union bbox and summed area of its pieces), only the pieces whose ring
// centroid lies in the region fade — each whole — and the rest stay as
// drawn. Pure lookups, cached per collection / geometry object, built
// lazily (only for a faded row) and never per frame.

const METERS_PER_DEG = 111_320

interface GridRowIndex {
  /** circleId → piece geometries, only for ids with more than one piece (grid rows). */
  pieces: Map<number, GeoJSON.Polygon[]>
  /** circleId → isCutWorthy of that row. */
  worthy: Map<number, boolean>
}

const gridRowIndexCache = new WeakMap<object, GridRowIndex>()

function gridRowsOf(fc: GeoJSON.FeatureCollection<GeoJSON.Polygon, CirclePolygonProps>): GridRowIndex {
  let idx = gridRowIndexCache.get(fc)
  if (!idx) {
    const pieces = new Map<number, GeoJSON.Polygon[]>()
    for (const f of fc.features) {
      const id = f.properties.circleId
      if (id === undefined) continue
      const list = pieces.get(id)
      if (list) list.push(f.geometry)
      else pieces.set(id, [f.geometry])
    }
    for (const [id, list] of pieces) if (list.length < 2) pieces.delete(id)
    idx = { pieces, worthy: new Map() }
    gridRowIndexCache.set(fc, idx)
  }
  return idx
}

function gridRowCutWorthy(idx: GridRowIndex, id: number): boolean {
  let hit = idx.worthy.get(id)
  if (hit === undefined) {
    let w = Infinity
    let s = Infinity
    let e = -Infinity
    let n = -Infinity
    let area = 0
    for (const g of idx.pieces.get(id) ?? []) {
      const ring = g.coordinates[0]
      if (!ring || ring.length < 3) continue
      const kx = Math.cos((ring[0][1] * Math.PI) / 180) * METERS_PER_DEG
      let a = 0
      for (let p = 0, q = ring.length - 1; p < ring.length; q = p++) {
        a += ring[q][0] * kx * (ring[p][1] * METERS_PER_DEG) - ring[p][0] * kx * (ring[q][1] * METERS_PER_DEG)
        if (ring[p][0] < w) w = ring[p][0]
        if (ring[p][0] > e) e = ring[p][0]
        if (ring[p][1] < s) s = ring[p][1]
        if (ring[p][1] > n) n = ring[p][1]
      }
      area += Math.abs(a / 2)
    }
    hit = isCutWorthy([w, s, e, n], area)
    idx.worthy.set(id, hit)
  }
  return hit
}

const ringCentroidCache = new WeakMap<object, readonly [number, number]>()

/** Mean of a piece's outer-ring vertices (closing vertex excluded), cached per geometry. */
function ringCentroid(g: GeoJSON.Polygon): readonly [number, number] {
  let hit = ringCentroidCache.get(g)
  if (!hit) {
    const ring = g.coordinates[0] ?? []
    const last = ring.length - 1
    const closed = last > 0 && ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1]
    const count = closed ? last : ring.length
    let x = 0
    let y = 0
    for (let i = 0; i < count; i++) {
      x += ring[i][0]
      y += ring[i][1]
    }
    hit = count > 0 ? [x / count, y / count] : [NaN, NaN]
    ringCentroidCache.set(g, hit)
  }
  return hit
}

const LABEL_SOURCE = 'circle-label-source'
// Billboard label — screen-space, always facing camera (default,
// `labelFlat != true`).
const LABEL_LAYER = 'circle-label-layer'
// Flat label — lies on the circle's top face and pitches / rotates
// with the map (`labelFlat == true`). Two layers because
// `text-pitch-alignment` / `text-rotation-alignment` are not
// data-driven in Mapbox GL JS 3.x.
const LABEL_LAYER_FLAT = 'circle-label-layer-flat'
const CLIP_SOURCE = 'circle-clip-source'
const CLIP_LAYER = 'circle-clip-layer'
const TRANSFORM_SOURCE = 'circle-transform-source'
const TRANSFORM_LAYER = 'circle-transform-layer'
const TRANSFORM_ICON_LAYER = 'circle-transform-icon-layer'
// In-flight sources — hold ONLY the circle currently being moved /
// rotated. Filter out the transforming id from FILL / EXTRUDE-op* /
// LINE / LABEL layers while the drag is live; push the fresh geometry
// into FILL_INFLIGHT_SOURCE from the drag handler's RAF. Same pattern
// as the line / polygon / door overlays. `EXTRUDE_INFLIGHT_LAYER`
// carries a constant fill-extrusion-opacity — the in-flight population
// effect rewrites it via `setPaintProperty` on transform start using
// the moving circle's config.opacity (matching whatever bucket the
// committed extrude would render at). Mapbox 3.x rejects data
// expressions on `fill-extrusion-opacity` (per-layer property).
const FILL_INFLIGHT_SOURCE = 'circle-fill-inflight-source'
const FILL_INFLIGHT_LAYER = 'circle-fill-inflight-layer'
const EXTRUDE_INFLIGHT_LAYER = 'circle-extrude-inflight-layer'
const LINE_INFLIGHT_LAYER = 'circle-line-inflight-layer'
const SELECTION_INFLIGHT_LAYER = 'circle-selection-inflight-layer'
const SELECTION_TINT_INFLIGHT_LAYER = 'circle-selection-tint-inflight-layer'
const LABEL_INFLIGHT_SOURCE = 'circle-label-inflight-source'
const LABEL_INFLIGHT_LAYER = 'circle-label-inflight-layer'

// ---- Empty-layer gate (src/lib/empty-layer-gate.ts) ----------------------
// Most opacity buckets hold no circle, and FILL_LAYER is empty unless a
// circle is fully flat, yet Mapbox re-evaluates every visible layer on
// every frame. Each of these layers registers a JS test mirroring its
// filter and the gate hides it while no FILL_SOURCE feature passes. The
// `!= circleId` clause the exclusion effect adds during a transform is
// deliberately not mirrored: there the test is a superset, which can keep
// a layer visible but never hide a feature the filter draws. See
// `map-polygon-overlay.tsx` for the same wiring.
type CircleGateFeature = {
  properties?: { opacityBucket?: unknown; elevation?: unknown; height?: unknown } | null
}
// FILL_LAYER: `['all', ['==', ['get', 'elevation'], 0], ['==', ['get', 'height'], 0]]`.
// Mapbox's `==` is strict equality, no coercion.
const flatFillTest = (f: CircleGateFeature): boolean =>
  f.properties?.elevation === 0 && f.properties?.height === 0
// `['any', ['>', ['get', 'elevation'], 0], ['>', ['get', 'height'], 0]]`.
// Mapbox wraps each `get` of an order comparison in a number assertion, so
// a non-number elevation throws and fails the WHOLE filter (`height` is
// never consulted); `any` short-circuits on the first true.
const extrudedTest = (f: CircleGateFeature): boolean => {
  const elevation = f.properties?.elevation
  if (typeof elevation !== 'number') return false
  if (elevation > 0) return true
  const height = f.properties?.height
  return typeof height === 'number' && height > 0
}
// EXTRUDE op<b>: `['all', ['==', ['get', 'opacityBucket'], b], <extruded>]`.
const extrudeBucketTest =
  (bucket: number) =>
  (f: CircleGateFeature): boolean =>
    f.properties?.opacityBucket === bucket && extrudedTest(f)
const GATED_FILL_LAYERS: ReadonlyMap<string, (f: CircleGateFeature) => boolean> = new Map([
  [FILL_LAYER, flatFillTest] as const,
  ...OPACITY_BUCKETS.map((b) => [extrudeLayerId(b), extrudeBucketTest(b)] as const),
])
// Filter-empty (`circleId == -1`) while nothing is selected → hinted empty.
const GATED_SELECTION_LAYERS = [SELECTION_LAYER, SELECTION_TINT_LAYER] as const

/**
 * Hide deferral for the gated layers — see GateHold in
 * `map-polygon-overlay.tsx`. Showing is immediate; a layer that may still
 * be drawing the previous tiles stays visible until the first frame in
 * which FILL_SOURCE is fully loaded again, so a circle changing bucket
 * (opacity edit, live-data restyle) never blinks out for a re-tile.
 */
interface GateHold {
  /** Gated fill layers whose filter matched ≥1 feature in the last FILL_SOURCE push. */
  matched: Set<string>
  /** Layers kept visible until FILL_SOURCE has re-tiled the change that emptied them. */
  held: Set<string>
  /** True while the selection layers may be drawing a highlight. */
  selectionShown: boolean
  /** Detaches the pending release listener, when one is armed. */
  disarm: (() => void) | null
}

function gatePredicate(
  hold: GateHold,
  layerId: string,
  test: (f: CircleGateFeature) => boolean,
): LayerFeaturePredicate {
  return (f) => hold.held.has(layerId) || test(f)
}

/**
 * Shadows ON (Graphics → Shadows) pins the gated layers that cast shadows:
 * no predicate and no empty hint, which leaves them under the plain
 * source-count gate they had before they were gated here. Mapbox anchors
 * its ground-shadow pass after the last visible shadow caster, so hiding
 * an empty caster (op10…op100, the selection tint) would brighten or
 * darken every 2D layer in between, e.g. on every select / deselect. Full
 * explanation at `pinnedShadowCaster` in `map-polygon-overlay.tsx`.
 * Shadows OFF (the default) keeps full gating.
 */
function pinnedShadowCaster(map: MapboxMapInstance, layerId: string): boolean {
  return useGraphicsSettings.getState().shadows && layerHasShadowPass(map, layerId)
}

/**
 * Mirrors Mapbox's per-type `hasShadowPass()`. Fill-extrusion reads
 * `fill-extrusion-cast-shadows`, whose spec default (unset, so `undefined`
 * here) is true; a fill (FILL_LAYER) has one only with a
 * `fill-elevation-reference` other than 'none'; line and symbol layers
 * never do. When unsure it answers true, which keeps a layer visible: that
 * costs perf, never pixels.
 */
function layerHasShadowPass(map: MapboxMapInstance, layerId: string): boolean {
  try {
    const type = map.getLayer(layerId)?.type
    if (type === 'fill-extrusion') {
      return map.getPaintProperty(layerId, 'fill-extrusion-cast-shadows') !== false
    }
    if (type === 'fill') {
      const ref = map.getLayoutProperty(layerId, 'fill-elevation-reference')
      return ref !== undefined && ref !== 'none'
    }
    return type === 'model'
  } catch {
    return true
  }
}

/** (Re-)register a gated fill layer's predicate, or none while it is a pinned shadow caster. */
function applyFillGate(
  map: MapboxMapInstance,
  hold: GateHold,
  layerId: string,
  test: (f: CircleGateFeature) => boolean,
): void {
  registerLayerFeaturePredicate(
    map,
    layerId,
    pinnedShadowCaster(map, layerId) ? null : gatePredicate(hold, layerId, test),
  )
}

/** Hint a selection layer empty (nothing selected), unless it is a pinned shadow caster. */
function hintSelectionEmpty(map: MapboxMapInstance, layerId: string): void {
  hintLayerEmpty(map, layerId, !pinnedShadowCaster(map, layerId))
}

/** Graphics → Shadows flipped: re-apply the gated shadow casters under the new pin state. */
function reapplyShadowPins(map: MapboxMapInstance, hold: GateHold): void {
  // The pin only ever changes a layer that has a shadow pass. A layer
  // missing mid style swap has none here; the setup pass registers it anew.
  for (const [layerId, test] of GATED_FILL_LAYERS) {
    if (layerHasShadowPass(map, layerId)) applyFillGate(map, hold, layerId, test)
  }
  // While a selection is shown (or held until its re-tile) the hints stay
  // cleared; the release or the next selection change re-hints under the
  // new state.
  if (!hold.selectionShown) {
    for (const id of GATED_SELECTION_LAYERS) {
      if (layerHasShadowPass(map, id)) hintSelectionEmpty(map, id)
    }
  }
}

/** Un-hold every held layer: fill layers get re-counted, selection layers hinted empty. */
function releaseGateHolds(map: MapboxMapInstance, hold: GateHold): void {
  const ids = [...hold.held]
  hold.held.clear()
  for (const id of ids) {
    const test = GATED_FILL_LAYERS.get(id)
    if (test) {
      applyFillGate(map, hold, id, test)
    } else {
      // Only held while nothing is selected (a selection un-holds them).
      hold.selectionShown = false
      hintSelectionEmpty(map, id)
    }
  }
}

/**
 * Release the held layers on the first `render` in which FILL_SOURCE is
 * loaded (`render` fires after `style.update` applied any pending reload).
 */
function armGateRelease(map: MapboxMapInstance, hold: GateHold): void {
  if (hold.disarm) return
  const onRender = () => {
    try {
      if (!map.getSource(FILL_SOURCE) || !map.isSourceLoaded(FILL_SOURCE)) return
    } catch {
      return
    }
    map.off('render', onRender)
    hold.disarm = null
    releaseGateHolds(map, hold)
  }
  map.on('render', onRender)
  hold.disarm = () => map.off('render', onRender)
}

/**
 * Renders saved circles (both single and circle-grid sub-modes) as
 * Mapbox polygon layers. Mirrors the grid overlay's architecture:
 *   - one geojson source with every circle polygon feature
 *   - a flat `fill` layer for 2D circles (height = 0 AND elevation = 0)
 *   - a `fill-extrusion` layer for 3D circles (gated by `height > 0 OR
 *     elevation > 0` — same trick as the grid overlay)
 *   - a `line` layer for borders
 *   - a filtered selection `line` layer drawn on top
 *   - a `symbol` layer for labels (centroid-anchored)
 */
export function MapCircleOverlay({
  map,
  circles,
  livePreview,
  selectedCircleIds,
  onCircleClick,
  onMapClickEmpty,
  committedVisible = true,
  selectionEnabled = true,
  transformState = null,
  onTransformChange,
  shapeStyleOverrides = null,
}: MapCircleOverlayProps) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  // `styleGen` bumps on every style.load — see matching note in
  // `map-polygon-overlay.tsx`. Source/layer effect deps include it so
  // basemap swaps trigger a fresh setup pass.
  const [styleGen, setStyleGen] = useState(0)
  // Empty-layer gate bookkeeping (see GateHold). Survives style swaps on
  // purpose: a stale `matched` / `selectionShown` can only over-hold, i.e.
  // keep a layer visible one re-tile longer.
  const gateHoldRef = useRef<GateHold>({
    matched: new Set(),
    held: new Set(),
    selectionShown: false,
    disarm: null,
  })

  // ---- Style readiness (matches the grid overlay pattern) ----------------
  useEffect(() => {
    if (!map) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStyleLoaded(false)
      return
    }
    const setReady = () => {
      setStyleLoaded(true)
      setStyleGen((g) => g + 1)
    }
    if (map.isStyleLoaded()) {
      setReady()
      return
    }
    const interval = setInterval(() => {
      if (map.isStyleLoaded()) {
        setReady()
        clearInterval(interval)
      }
    }, 100)
    map.on('style.load', setReady)
    map.on('load', setReady)
    return () => {
      clearInterval(interval)
      map.off('style.load', setReady)
      map.off('load', setReady)
    }
  }, [map])

  // (Removed) Old URL-polling style-swap detector. The `style.load`
  // listener above now bumps `styleGen`; see notes in
  // `map-polygon-overlay.tsx`.

  // Whether the current basemap has anything a clip layer can hide
  // (`src/lib/basemap-clip.ts`). CLIP_LAYER only exists while true.
  const basemapClip = useBasemapClipNeeded(map)

  // ---- Theme-tinted handle icons -----------------------------------------
  const [primaryHex, setPrimaryHex] = useState<string>(() =>
    readThemePrimaryHex(),
  )
  const [primaryFgHex, setPrimaryFgHex] = useState<string>(() =>
    readThemePrimaryForegroundHex(),
  )
  useEffect(() => {
    const refresh = () => {
      setPrimaryHex(readThemePrimaryHex())
      setPrimaryFgHex(readThemePrimaryForegroundHex())
    }
    refresh()
    return subscribeThemeChanges(refresh)
  }, [])
  useEffect(() => {
    if (!map || !styleLoaded) return
    registerTransformHandleIcons(map, primaryHex, primaryFgHex)
  }, [map, styleLoaded, styleGen, primaryHex, primaryFgHex])

  // ---- Build the feature collection (committed + live preview) -----------
  const fc = useMemo(
    () => buildCircleFeatureCollection(circles ?? [], livePreview, shapeStyleOverrides),
    [circles, livePreview, shapeStyleOverrides]
  )

  // ---- Focus mode (src/lib/focus) ----------------------------------------
  // Same post-pass as `map-polygon-overlay.tsx`: while an item is focused,
  // only the circles between the camera and the item (blockers) and the
  // ones in its NEAR column move to lower opacity buckets (re-stamped
  // `opacity` / `opacityBucket`, + `focusFade` for the border); FILL_LAYER
  // (flat circles) reads `opacity` directly. Every other circle keeps its
  // feature object. Grid-mode circles share their `circleId`, so a whole
  // circle grid fades as one shape. With nothing focused, or nothing to
  // fade, `fc` ITSELF comes back. Clip footprints, labels and the
  // selection / exclusion filters stay on `fc`.
  //
  // Local cut-away (focus-cutaway.ts), as in `map-polygon-overlay.tsx`: a
  // single circle much bigger than its region splits into an 'in' and an
  // 'out' feature with the SAME `circleId` / feature id (clicks resolve by
  // `circleId`); a big circle grid fades only the pieces whose centroid
  // lies in the region (see gridRowsOf); a tapered / dome circle keeps its
  // hit target and its mesh is split per triangle (`meshCutAway`).
  const focusScene = useFocusScene()
  const focusBlockers = useFocusBlockers()
  // Same Set / Map while the circle blockers and their pierce discs are
  // unchanged: other kinds' blocker changes don't re-push this source.
  const circleBlockers = blockerIdsOf(focusBlockers, 'circles')
  const circlePierce = blockerPierceOf(focusBlockers, 'circles')
  /** Fade factor / cut region by circle id, or null while nothing is focused. */
  const circleFocus = useMemo(() => {
    if (!focusScene.active) return null
    return {
      factorOf: (id: number | undefined): number =>
        id === undefined ? 1 : focusFactor(focusScene, focusBlockers, 'circles', id),
      regionOf: (id: number | undefined) =>
        id === undefined ? null : focusCutRegion(focusScene, focusBlockers, 'circles', id),
    }
    // `focusBlockers` is read only through its circle set and pierce map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusScene, circleBlockers, circlePierce])
  const fadedFc = useMemo<
    GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, CirclePolygonProps & { focusPiece?: FocusPiece }>
  >(() => {
    if (!circleFocus) return fc
    // Factor of one feature. The live-draw preview has no id and is never
    // faded. A piece of a cut-worthy grid row fades (whole) only when its
    // centroid lies in the row's region; a small row fades whole.
    const factorOf = (f: { geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon; properties: { circleId?: number } }) => {
      const id = f.properties.circleId
      const factor = circleFocus.factorOf(id)
      if (factor === 1 || id === undefined || f.geometry.type !== 'Polygon') return factor
      const rows = gridRowsOf(fc)
      if (!rows.pieces.has(id) || !gridRowCutWorthy(rows, id)) return factor
      const region = circleFocus.regionOf(id)
      if (!region) return factor
      const [lng, lat] = ringCentroid(f.geometry)
      return cutRegionContains(region, lng, lat) ? factor : 1
    }
    // Grid-row pieces never split (regionOf null): they fade whole or not.
    const regionOf = (f: { properties: { circleId?: number } }) => {
      const id = f.properties.circleId
      if (id === undefined || gridRowsOf(fc).pieces.has(id)) return null
      return circleFocus.regionOf(id)
    }
    // stableDerivedCollection: a scene change that leaves this overlay's
    // fades as they were (the NEAR column of another kind, a data-link
    // anchor arriving) hands back the previous object, so nothing re-pushes.
    // `focusFade` (the border) goes on faded features and 'in' pieces; an
    // 'out' piece keeps the full border, cut arc included.
    return stableDerivedCollection(
      fc as GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, CirclePolygonProps & { focusPiece?: FocusPiece }>,
      patchFeatureCollection(
        focusFadeCollection(fc, factorOf, regionOf),
        (f) => {
          const factor = factorOf(f)
          return factor === 1 || f.properties.focusPiece === 'out' ? null : String(factor)
        },
        (props, tag) => ({ ...props, [FOCUS_FADE_PROP]: Number(tag) }),
      ),
    )
  }, [fc, circleFocus])

  // Tapered / dome circles (sloped-mesh.ts) — cones, domes, silos. The one
  // being moved shows as its in-flight extrusion until it's dropped. Built
  // from `fc` (focus-independent), so leaving focus hands back the very
  // same array. While focused they're built from `fadedFc` (a whole-faded
  // solid carries its faded `opacity` → translucent mesh layer), then
  // `meshCutAway` splits a big near / blocker solid per triangle (inside:
  // `circle:<id>#cut` at the tier's alpha). Meshed circles are single and
  // never split into pieces, so every meshed feature is still a Polygon.
  const baseSolidMeshes = useMemo(
    () =>
      taperedSolidMeshes('circle', circles ?? [], fc.features, {
        selectedIds: selectedCircleIds,
        tint: primaryHex,
        skipId: transformState?.circleId ?? null,
      }),
    [circles, fc, selectedCircleIds, primaryHex, transformState],
  )
  const solidMeshes = useMemo(() => {
    if (!circleFocus) return baseSolidMeshes
    const built =
      fadedFc === fc
        ? baseSolidMeshes
        : taperedSolidMeshes(
            'circle',
            circles ?? [],
            fadedFc.features.filter((f) => f.properties.meshed === true) as GeoJSON.Feature<GeoJSON.Polygon, CirclePolygonProps>[],
            {
              selectedIds: selectedCircleIds,
              tint: primaryHex,
              skipId: transformState?.circleId ?? null,
            },
          )
    const idOfKey = (key: string): number | undefined => {
      const id = Number(key.slice(key.indexOf(':') + 1))
      return Number.isInteger(id) ? id : undefined
    }
    return meshCutAway(
      built,
      (key) => circleFocus.regionOf(idOfKey(key)),
      (key) => circleFocus.factorOf(idOfKey(key)),
    )
  }, [baseSolidMeshes, circleFocus, fadedFc, fc, circles, selectedCircleIds, primaryHex, transformState])
  useShapeMeshLayers(map, styleLoaded, styleGen, 'circle', solidMeshes, committedVisible)

  // Clip footprint: one polygon per circle. Fed to the `clip` layer so
  // Mapbox erases basemap 3D buildings + symbols *under* every circle,
  // mirroring how the grid overlay carves out its bbox. Only emits
  // features when there's something visible; otherwise the layer renders
  // an empty FeatureCollection (no-op).
  const clipData = useMemo<GeoJSON.FeatureCollection<GeoJSON.Polygon> | null>(() => {
    if (fc.features.length === 0) return null
    const features: GeoJSON.Feature<GeoJSON.Polygon>[] = []
    for (const f of fc.features) {
      const ring = f.geometry.coordinates[0]
      if (!ring || ring.length < 4) continue
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      })
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [fc])

  // Label data — one Point per circle-polygon feature at its centroid.
  // We mirror the grid overlay's pattern: a Point-source symbol layer
  // with explicit `symbol-z-offset` lifts labels reliably for both flat
  // and 3D shapes, whereas a Polygon source can drop labels entirely
  // when `symbol-z-elevate` has no extrusion to anchor to.
  const labelPointData = useMemo<
    GeoJSON.FeatureCollection<GeoJSON.Point, CirclePolygonProps> | null
  >(() => {
    if (fc.features.length === 0) return null
    const features: GeoJSON.Feature<GeoJSON.Point, CirclePolygonProps>[] = []
    for (const f of fc.features) {
      const props = f.properties
      if (!props.showLabels) continue
      if (!props.label || props.label.trim() === '') continue
      const ring = f.geometry.coordinates[0] as [number, number][]
      let sx = 0
      let sy = 0
      const n = ring.length - 1
      if (n <= 0) continue
      for (let i = 0; i < n; i++) {
        sx += ring[i][0]
        sy += ring[i][1]
      }
      const center: [number, number] = [sx / n, sy / n]
      // Apply the user's label offset (meters, in the shape's local
      // unrotated frame). See the polygon overlay for the same math —
      // turf.destination handles meters→lng/lat at any latitude, and
      // adding `shapeRotation` to the bearing makes the offset rotate
      // WITH the shape so the label stays anchored to the same spot
      // relative to the circle's geometry.
      const offX = props.labelOffsetX ?? 0
      const offY = props.labelOffsetY ?? 0
      let anchor: [number, number] = center
      if (offX !== 0 || offY !== 0) {
        const distance = Math.hypot(offX, offY)
        const localBearing = (Math.atan2(offX, offY) * 180) / Math.PI
        const bearing = localBearing + (props.shapeRotation ?? 0)
        const moved = turfDestination(turfPoint(center), distance, bearing, {
          units: 'meters',
        })
        anchor = moved.geometry.coordinates as [number, number]
      }
      features.push({
        type: 'Feature',
        properties: props,
        geometry: { type: 'Point', coordinates: anchor },
      })
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [fc])

  // ---- Register sources + layers when style is ready ---------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const gateHold = gateHoldRef.current
    try {
      if (!map.getSource(FILL_SOURCE)) {
        // `lineMetrics: true` — silences the "line-progress evaluation
        // requires enabling 'lineMetrics'" warning Mapbox emits on
        // every tile parse. The circle line stroke layer's paint has
        // an implicit line-progress evaluation path that needs it.
        // Enabling metrics has no runtime cost when unused.
        map.addSource(FILL_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          lineMetrics: true,
        })
      }
      if (!map.getSource(LABEL_SOURCE)) {
        map.addSource(LABEL_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getSource(CLIP_SOURCE)) {
        map.addSource(CLIP_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getSource(TRANSFORM_SOURCE)) {
        map.addSource(TRANSFORM_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }

      // 2D fill — only features that are flat (no elevation, no extrusion).
      if (!map.getLayer(FILL_LAYER)) {
        map.addLayer({
          id: FILL_LAYER,
          type: 'fill',
          source: FILL_SOURCE,
          filter: [
            'all',
            ['==', ['get', 'elevation'], 0],
            ['==', ['get', 'height'], 0],
          ],
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': ['/', ['to-number', ['get', 'opacity']], 100],
          },
        })
      }

      // One fill-extrusion layer per opacity bucket. Each carries a
      // CONSTANT `fill-extrusion-opacity` and filters to features whose
      // generator-stamped `opacityBucket` matches its bucket. See the
      // polygon overlay for the full rationale.
      for (const bucket of OPACITY_BUCKETS) {
        const layerId = extrudeLayerId(bucket)
        if (map.getLayer(layerId)) continue
        try {
          map.addLayer({
            id: layerId,
            type: 'fill-extrusion',
            source: FILL_SOURCE,
            filter: [
              'all',
              ['==', ['get', 'opacityBucket'], bucket],
              [
                'any',
                ['>', ['get', 'elevation'], 0],
                ['>', ['get', 'height'], 0],
              ],
            ],
            paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-opacity': bucket / 100,
              'fill-extrusion-base': ['to-number', ['get', 'elevation']],
              // Guarantee a 5 cm minimum thickness. See the matching
              // comment in `map-polygon-overlay.tsx`: a zero-thickness
              // fill-extrusion (base == top) degenerates and flickers
              // across zoom / pitch as GPU depth precision changes,
              // and can knock out overlapping raster layers (like a
              // floor-plan image right beneath it) too.
              'fill-extrusion-height': [
                '+',
                ['to-number', ['get', 'elevation']],
                ['max', ['to-number', ['get', 'height']], 0.05],
              ],
              // Disabled — see the matching comment in
              // `map-polygon-overlay.tsx`. A 5 cm elevation-only slab
              // paints as a shadow blob otherwise.
              'fill-extrusion-vertical-gradient': false,
              // The 0% bucket is invisible (incl. tapered circles' hit
              // targets) — it must not cast a box-shaped shadow.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-cast-shadows' as any]: bucket > 0,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-ambient-occlusion-intensity' as any]: 0.35,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-ambient-occlusion-radius' as any]: 2.5,
            },
          })
        } catch (err) {
          console.warn('[MapCircleOverlay] failed to add extrude bucket', bucket, err)
        }
      }
      // Gate FILL_LAYER + the bucket layers on their filters (see
      // GATED_FILL_LAYERS). The gate drops registrations with the layer, so
      // every setup pass re-registers. Shadow casters are skipped while
      // Shadows is on (pinnedShadowCaster).
      for (const [layerId, test] of GATED_FILL_LAYERS) {
        applyFillGate(map, gateHold, layerId, test)
      }
      if (gateHold.held.size > 0) armGateRelease(map, gateHold)

      // Border line — lifted to the top of the extrusion via `line-z-offset`
      // so it never sits on the ground while the cylinder sits in the air.
      // `line-elevation-reference: 'sea'` says the offset is from z=0
      // (sea level), and the offset itself is `elevation + height + 0.1m`
      // (epsilon keeps the line just above the top face — without it the
      // border loses the depth test against the opaque top).
      if (!map.getLayer(LINE_LAYER)) {
        map.addLayer({
          id: LINE_LAYER,
          type: 'line',
          source: FILL_SOURCE,
          filter: NOT_MESHED,
          paint: {
            'line-color': ['get', 'borderColor'],
            'line-width': ['to-number', ['get', 'borderWidth']],
            // Render at full color regardless of the v3 lighting model so
            // the border is visible on top of a lit 3D extrusion top.
            'line-emissive-strength': 1,
            // Focus mode: fades with the fill (FOCUS_FADE_PROP).
            'line-opacity': BORDER_OPACITY,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ['coalesce', ['get', 'height'], 0],
              0.0001,
            ],
          },
        })
      }

      // Whole-shape selection tint — theme-primary fill-extrusion over
      // the circle interior at its 3D altitude. Same paper-slab trick
      // (min height 5 cm) that prevents grazing-pitch flicker on flat
      // circles.
      if (!map.getLayer(SELECTION_TINT_LAYER)) {
        const tintLayerDef = {
          id: SELECTION_TINT_LAYER,
          type: 'fill-extrusion',
          source: FILL_SOURCE,
          filter: ['==', ['get', 'circleId'], -1],
          paint: {
            'fill-extrusion-color': '#facc15', // theme effect overwrites
            'fill-extrusion-opacity': 0.18,
            'fill-extrusion-base': [
              'coalesce',
              ['to-number', ['get', 'elevation']],
              0,
            ],
            'fill-extrusion-height': [
              '+',
              ['coalesce', ['to-number', ['get', 'elevation']], 0],
              [
                'max',
                ['coalesce', ['to-number', ['get', 'height']], 0],
                0.05,
              ],
            ],
            'fill-extrusion-vertical-gradient': false,
            'fill-extrusion-emissive-strength': 1,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any
        map.addLayer(tintLayerDef)
      }
      // Selection halo — same z-offset trick so the selected border tracks
      // the top of the extrusion too. Theme-tinted via a setPaintProperty
      // effect below.
      if (!map.getLayer(SELECTION_LAYER)) {
        map.addLayer({
          id: SELECTION_LAYER,
          type: 'line',
          source: FILL_SOURCE,
          // Filter is replaced in a separate effect when selection changes
          // (Mapbox doesn't let you use a data-driven `feature-state` for
          // line layers across all versions — a filter is simplest).
          filter: ['==', ['get', 'circleId'], -1],
          paint: {
            'line-color': '#fde047', // theme effect overwrites
            'line-width': 3,
            'line-blur': 0.5,
            'line-emissive-strength': 1,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ['coalesce', ['get', 'height'], 0],
              0.0001,
            ],
          },
        })
      }

      // Drop a stale LABEL_LAYER left over from a previous build if it
      // is bound to FILL_SOURCE (pre-Point-source rewrite), missing the
      // labelFlat partition filter (pre-flat-label change), or still
      // carrying `text-allow-overlap: true` (pre-overlap-fix change).
      // Any of these means the stale layer would give the wrong
      // behaviour after HMR; force a re-mount.
      const existingCircleLabel = map.getStyle()?.layers?.find((l) => l.id === LABEL_LAYER) as
        | { source?: string; filter?: unknown; layout?: Record<string, unknown> }
        | undefined
      if (
        existingCircleLabel &&
        (existingCircleLabel.source !== LABEL_SOURCE ||
          existingCircleLabel.filter === undefined ||
          existingCircleLabel.layout?.['text-allow-overlap'] === true)
      ) {
        try { map.removeLayer(LABEL_LAYER) } catch { /* ignore */ }
      }
      const existingCircleLabelFlat = map.getStyle()?.layers?.find((l) => l.id === LABEL_LAYER_FLAT) as
        | { layout?: Record<string, unknown> }
        | undefined
      if (existingCircleLabelFlat && existingCircleLabelFlat.layout?.['text-allow-overlap'] === true) {
        try { map.removeLayer(LABEL_LAYER_FLAT) } catch { /* ignore */ }
      }
      // Labels — placed at an absolute altitude via `symbol-z-offset`,
      // sourced from a Point-only LABEL_SOURCE. See the grid overlay for
      // the same pattern; using a Polygon source here can cause Mapbox
      // to drop labels on flat shapes because `symbol-z-elevate` has no
      // extrusion to anchor to. Requires Mapbox GL JS v3.7+. Text
      // rotation is intentionally left at Mapbox's default (0) so the
      // label always reads map-north-up: rotating the circle moves the
      // label's ANCHOR (via the offset math above) but never spins the
      // text itself.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const labelPaint: any = {
        'text-color': ['coalesce', ['get', 'labelColor'], '#ffffff'],
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.2,
        'text-emissive-strength': 1,
        // Absolute label altitude = circle top + user lift.
        'symbol-z-offset': [
          '+',
          ['coalesce', ['get', 'elevation'], 0],
          ['coalesce', ['get', 'height'], 0],
          ['coalesce', ['get', 'labelAltitude'], 0],
        ],
      }
      if (!map.getLayer(LABEL_LAYER)) {
        // Billboard variant — screen-space text always facing camera.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const labelLayout: any = {
          'text-field': ['coalesce', ['get', 'label'], ''],
          'text-size': ['coalesce', ['get', 'labelSize'], 12],
          'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
          'text-anchor': 'center',
          'text-padding': 2,
          'symbol-placement': 'point',
          // Overlap detection ON: a circle label hides if it would
          // collide with another already-placed label (from any overlay
          // or the basemap), and reserves its own footprint so other
          // labels avoid it. Trade-off — labels sitting near dense
          // basemap text may not render; that's preferable to stacked,
          // unreadable text.
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-z-elevate': false,
        }
        map.addLayer({
          id: LABEL_LAYER,
          type: 'symbol',
          source: LABEL_SOURCE,
          filter: ['!=', ['get', 'labelFlat'], true],
          layout: labelLayout,
          paint: labelPaint,
        })
      }
      if (!map.getLayer(LABEL_LAYER_FLAT)) {
        // Flat variant — text lies on the circle's top face and
        // pitches / rotates with the map. `text-pitch-alignment: 'map'`
        // + `text-rotation-alignment: 'map'` are layout-only, not
        // data-driven, hence the separate layer.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const layoutFlat: any = {
          'text-field': ['coalesce', ['get', 'label'], ''],
          'text-size': ['coalesce', ['get', 'labelSize'], 12],
          'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
          'text-anchor': 'center',
          'text-padding': 2,
          'symbol-placement': 'point',
          // Same overlap rule as the billboard variant — see above.
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-z-elevate': false,
          'text-pitch-alignment': 'map',
          'text-rotation-alignment': 'map',
        }
        map.addLayer({
          id: LABEL_LAYER_FLAT,
          type: 'symbol',
          source: LABEL_SOURCE,
          filter: ['==', ['get', 'labelFlat'], true],
          layout: layoutFlat,
          paint: labelPaint,
        })
      }

      // CLIP_LAYER sits here (before TRANSFORM_LAYER) — added by the
      // basemap-clip effect below, only on styles where it clips anything.

      // HMR guards for the old circle-typed transform layer + the
      // defunct TRANSFORM_ICON_LAYER (was a rotate-hint dot; the new
      // symbol layer bakes the rotate glyph directly into the icon).
      const existingTransform = map.getStyle()?.layers?.find(
        (l) => l.id === TRANSFORM_LAYER,
      ) as { type?: string } | undefined
      if (existingTransform && existingTransform.type !== 'symbol') {
        try { map.removeLayer(TRANSFORM_LAYER) } catch { /* ignore */ }
      }
      try {
        if (map.getLayer(TRANSFORM_ICON_LAYER)) {
          map.removeLayer(TRANSFORM_ICON_LAYER)
        }
      } catch { /* ignore */ }
      // Theme-tinted symbol handle. Circle has 2 kinds: move (single
      // handle at center / bbox midpoint) and rotate (single handle
      // at the rotated top-right corner). Both use one feature at a
      // time — no multi-corner emission needed.
      if (!map.getLayer(TRANSFORM_LAYER)) {
        const transformLayerDef = {
          id: TRANSFORM_LAYER,
          type: 'symbol',
          source: TRANSFORM_SOURCE,
          layout: {
            'icon-image': [
              'coalesce',
              ['get', 'iconId'],
              TRANSFORM_ICON.move,
            ],
            'icon-size': 1,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            // Move icon stays screen-space; rotate curl follows the
            // circle's rotation so it faces outward.
            'icon-rotate': [
              'match',
              ['get', 'kind'],
              'rotate',
              ['coalesce', ['to-number', ['get', 'imageRotation']], 0],
              0,
            ],
            'symbol-z-elevate': false,
            'symbol-elevation-reference': 'sea',
          },
          paint: {
            'icon-emissive-strength': 1,
            'symbol-z-offset': [
              '+',
              ['coalesce', ['to-number', ['get', 'elevation']], 0],
              ['coalesce', ['to-number', ['get', 'height']], 0],
            ],
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any
        map.addLayer(transformLayerDef)
      }

      // ---- In-flight sources + layers (transforming circle) ------------
      // Same paint recipes as FILL / EXTRUDE / LINE / SELECTION / LABEL
      // so the moving circle renders identically. Single-shape source →
      // per-frame updates cost O(1) buildCircleFeatures instead of
      // O(N_circles). No filters — the source itself is gated by the
      // transform-active population effect.
      if (!map.getSource(FILL_INFLIGHT_SOURCE)) {
        map.addSource(FILL_INFLIGHT_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getSource(LABEL_INFLIGHT_SOURCE)) {
        map.addSource(LABEL_INFLIGHT_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getLayer(FILL_INFLIGHT_LAYER)) {
        map.addLayer({
          id: FILL_INFLIGHT_LAYER,
          type: 'fill',
          source: FILL_INFLIGHT_SOURCE,
          filter: [
            'all',
            ['==', ['get', 'elevation'], 0],
            ['==', ['get', 'height'], 0],
          ],
          paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': ['/', ['to-number', ['get', 'opacity']], 100],
          },
        })
      }
      if (!map.getLayer(EXTRUDE_INFLIGHT_LAYER)) {
        map.addLayer({
          id: EXTRUDE_INFLIGHT_LAYER,
          type: 'fill-extrusion',
          source: FILL_INFLIGHT_SOURCE,
          filter: [
            'any',
            ['>', ['get', 'elevation'], 0],
            ['>', ['get', 'height'], 0],
          ],
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-opacity': 1,
            'fill-extrusion-base': ['to-number', ['get', 'elevation']],
            'fill-extrusion-height': [
              '+',
              ['to-number', ['get', 'elevation']],
              ['max', ['to-number', ['get', 'height']], 0.05],
            ],
            'fill-extrusion-vertical-gradient': false,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-cast-shadows' as any]: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-ambient-occlusion-intensity' as any]: 0.35,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-ambient-occlusion-radius' as any]: 2.5,
          },
        })
      }
      if (!map.getLayer(LINE_INFLIGHT_LAYER)) {
        map.addLayer({
          id: LINE_INFLIGHT_LAYER,
          type: 'line',
          source: FILL_INFLIGHT_SOURCE,
          paint: {
            'line-color': ['get', 'borderColor'],
            'line-width': ['to-number', ['get', 'borderWidth']],
            'line-emissive-strength': 1,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ['coalesce', ['get', 'height'], 0],
              0.0001,
            ],
          },
        })
      }
      if (!map.getLayer(SELECTION_TINT_INFLIGHT_LAYER)) {
        const tintInflightDef = {
          id: SELECTION_TINT_INFLIGHT_LAYER,
          type: 'fill-extrusion',
          source: FILL_INFLIGHT_SOURCE,
          paint: {
            'fill-extrusion-color': '#facc15',
            'fill-extrusion-opacity': 0.18,
            'fill-extrusion-base': [
              'coalesce',
              ['to-number', ['get', 'elevation']],
              0,
            ],
            'fill-extrusion-height': [
              '+',
              ['coalesce', ['to-number', ['get', 'elevation']], 0],
              [
                'max',
                ['coalesce', ['to-number', ['get', 'height']], 0],
                0.05,
              ],
            ],
            'fill-extrusion-vertical-gradient': false,
            'fill-extrusion-emissive-strength': 1,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any
        map.addLayer(tintInflightDef)
      }
      if (!map.getLayer(SELECTION_INFLIGHT_LAYER)) {
        map.addLayer({
          id: SELECTION_INFLIGHT_LAYER,
          type: 'line',
          source: FILL_INFLIGHT_SOURCE,
          paint: {
            'line-color': '#fde047',
            'line-width': 3,
            'line-blur': 0.5,
            'line-emissive-strength': 1,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ['coalesce', ['get', 'height'], 0],
              0.0002,
            ],
          },
        })
      }
      if (!map.getLayer(LABEL_INFLIGHT_LAYER)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const layout: any = {
          'text-field': ['coalesce', ['get', 'label'], ''],
          'text-size': ['coalesce', ['get', 'labelSize'], 12],
          'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
          'text-anchor': 'center',
          'text-padding': 2,
          'symbol-placement': 'point',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-z-elevate': false,
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const paint: any = {
          'text-color': ['coalesce', ['get', 'labelColor'], '#ffffff'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.2,
          'text-emissive-strength': 1,
          'symbol-z-offset': [
            '+',
            ['coalesce', ['get', 'elevation'], 0],
            ['coalesce', ['get', 'height'], 0],
          ],
        }
        map.addLayer({
          id: LABEL_INFLIGHT_LAYER,
          type: 'symbol',
          source: LABEL_INFLIGHT_SOURCE,
          layout,
          paint,
        })
      }
    } catch (err) {
      console.warn('[MapCircleOverlay] ensure layers failed', err)
    }

    return () => {
      gateHold.disarm?.()
      gateHold.disarm = null
      for (const id of [
        TRANSFORM_ICON_LAYER,
        TRANSFORM_LAYER,
        CLIP_LAYER,
        LABEL_INFLIGHT_LAYER,
        LABEL_LAYER_FLAT,
        LABEL_LAYER,
        SELECTION_INFLIGHT_LAYER,
        SELECTION_TINT_INFLIGHT_LAYER,
        LINE_INFLIGHT_LAYER,
        EXTRUDE_INFLIGHT_LAYER,
        FILL_INFLIGHT_LAYER,
        SELECTION_LAYER,
        SELECTION_TINT_LAYER,
        LINE_LAYER,
        ...EXTRUDE_LAYER_IDS,
        FILL_LAYER,
      ]) {
        try {
          if (map.getLayer(id)) map.removeLayer(id)
        } catch {
          /* ignore */
        }
      }
      for (const id of [
        FILL_SOURCE,
        LABEL_SOURCE,
        CLIP_SOURCE,
        TRANSFORM_SOURCE,
        FILL_INFLIGHT_SOURCE,
        LABEL_INFLIGHT_SOURCE,
      ]) {
        try {
          if (map.getSource(id)) map.removeSource(id)
        } catch {
          /* ignore */
        }
      }
    }
    // styleGen forces re-mount on every basemap swap.
  }, [map, styleLoaded, styleGen])

  // ---- Basemap clip layer ------------------------------------------------
  // Erases basemap buildings/symbols inside every circle so the 3D
  // extrusion isn't intersected by Mapbox's own building models. Runs right
  // after the setup pass above (same commit on style.load), so CLIP_LAYER
  // lands at its old slot before TRANSFORM_LAYER; the setup cleanup still
  // removes it ahead of CLIP_SOURCE. See `map-polygon-overlay.tsx`.
  useEffect(() => {
    if (!map || !styleLoaded) return
    syncBasemapClipLayer(map, {
      layerId: CLIP_LAYER,
      sourceId: CLIP_SOURCE,
      needed: basemapClip,
      beforeId: TRANSFORM_LAYER,
      visible: committedVisible,
      label: 'MapCircleOverlay',
    })
  }, [map, styleLoaded, styleGen, basemapClip, committedVisible])

  // ---- Push data into the sources ----------------------------------------
  // FILL_SOURCE gets the focus-faded collection (`fadedFc`, which IS `fc`
  // while nothing is focused). It has its own effect so a fade change
  // (focus enter / exit, a blocker change at camera settle) pushes this
  // source once and leaves the label source alone.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(FILL_SOURCE) as
      | (mapboxgl.GeoJSONSource | undefined)
      | undefined
    if (src) {
      // A gated layer that matched the previous push but not this one may
      // still be drawing the previous tiles: hold it visible until they're
      // replaced (GateHold). Must happen before setData, where the gate
      // re-counts. A focus fade moves circles between buckets the same
      // way, so it shows the new bucket now and hides the old one late.
      const hold = gateHoldRef.current
      const matched = new Set<string>()
      for (const [layerId, test] of GATED_FILL_LAYERS) {
        if (fadedFc.features.some(test)) matched.add(layerId)
      }
      for (const layerId of hold.matched) {
        if (!matched.has(layerId)) hold.held.add(layerId)
      }
      hold.matched = matched
      src.setData(fadedFc)
      if (hold.held.size > 0) armGateRelease(map, hold)
    }
  }, [map, styleLoaded, styleGen, fadedFc])

  useEffect(() => {
    if (!map || !styleLoaded) return
    const labelSrc = map.getSource(LABEL_SOURCE) as
      | (mapboxgl.GeoJSONSource | undefined)
      | undefined
    if (labelSrc) {
      labelSrc.setData(
        (labelPointData ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection
      )
    }
  }, [map, styleLoaded, styleGen, labelPointData])

  // Clip footprints get their own push, skipped when the source already
  // holds the same rings (`fc` is rebuilt on every style-rule resolve) or
  // while CLIP_LAYER is absent. See the matching note in
  // `map-polygon-overlay.tsx`.
  const lastClipPushRef = useRef<{
    source: GeoJSONSource
    data: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null
  } | null>(null)
  useEffect(() => {
    if (!map || !styleLoaded || !basemapClip) return
    const clipSrc = map.getSource(CLIP_SOURCE) as GeoJSONSource | undefined
    if (!clipSrc) return
    const last = lastClipPushRef.current
    if (last && last.source === clipSrc && sameClipFootprints(last.data, clipData)) return
    clipSrc.setData(clipData ?? { type: 'FeatureCollection', features: [] })
    lastClipPushRef.current = { source: clipSrc, data: clipData }
  }, [map, styleLoaded, styleGen, basemapClip, clipData])

  // ---- Update the selection filter when selection changes ----------------
  // Composed with the transform exclusion: while a transform is active,
  // the committed halo/tint are suppressed and SELECTION_INFLIGHT_LAYER
  // / SELECTION_TINT_INFLIGHT_LAYER pick them up on the moving circle.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const hasSelection = !!selectedCircleIds && selectedCircleIds.size > 0
    const ids = hasSelection ? [...selectedCircleIds] : [-1]
    const excludeId = transformState?.circleId
    const idFilter = ['in', ['get', 'circleId'], ['literal', ids]]
    const filter = excludeId != null
      ? ['all', idFilter, ['!=', ['get', 'circleId'], excludeId]]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : (idFilter as unknown as any)
    try {
      if (map.getLayer(SELECTION_LAYER)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setFilter(SELECTION_LAYER, filter as any)
      }
    } catch { /* ignore */ }
    try {
      if (map.getLayer(SELECTION_TINT_LAYER)) {
        // A tapered circle shows its selection on the mesh instead.
        map.setFilter(SELECTION_TINT_LAYER, ['all', filter, NOT_MESHED])
      }
    } catch { /* ignore */ }
    // Empty-layer gate: with nothing selected both filters match no id, so
    // the layers are hinted empty. A new selection un-hints them right here,
    // alongside its setFilter, so the highlight can't lag. Clearing a shown
    // selection defers the hint until FILL_SOURCE has re-tiled the cleared
    // filter (GateHold) — the moment today's highlight disappears.
    const hold = gateHoldRef.current
    if (hasSelection) {
      hold.selectionShown = true
      for (const id of GATED_SELECTION_LAYERS) {
        hold.held.delete(id)
        hintLayerEmpty(map, id, false)
      }
    } else if (hold.selectionShown) {
      for (const id of GATED_SELECTION_LAYERS) hold.held.add(id)
      armGateRelease(map, hold)
    } else {
      for (const id of GATED_SELECTION_LAYERS) hintSelectionEmpty(map, id)
    }
  }, [map, styleLoaded, styleGen, selectedCircleIds, transformState])

  // ---- Empty-layer gate × Shadows (see pinnedShadowCaster) --------------
  // A store subscription rather than a React dep: it runs synchronously
  // inside `setShadows`, in the same task as the `applyLights` that
  // flips the light's `cast-shadows`, so no frame mixes the two states.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const hold = gateHoldRef.current
    return useGraphicsSettings.subscribe((state, prev) => {
      if (state.shadows !== prev.shadows) reapplyShadowPins(map, hold)
    })
  }, [map, styleLoaded])

  // ---- Exclusion filter (committed base layers) ------------------------
  // While a transform is active, hide the moving circle from the
  // committed FILL / EXTRUDE-op* / LINE / LABEL layers so it doesn't
  // render twice — once at its stale committed geometry, once at its
  // live drag position on FILL_INFLIGHT_SOURCE. Cleared when no
  // transform is active. FILL and EXTRUDE-op* already carry filters
  // we preserve by composing.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const excludeId = transformState?.circleId
    const notMe = excludeId != null
      ? ['!=', ['get', 'circleId'], excludeId]
      : null
    // FILL_LAYER — has an `all [elevation=0, height=0]` filter.
    try {
      if (map.getLayer(FILL_LAYER)) {
        const base: unknown[] = [
          'all',
          ['==', ['get', 'elevation'], 0],
          ['==', ['get', 'height'], 0],
        ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const filter: any = notMe ? [...base, notMe] : base
        map.setFilter(FILL_LAYER, filter)
      }
    } catch { /* ignore */ }
    // EXTRUDE_LAYER_op* — bucket + elevation/height any-filter.
    for (const bucket of OPACITY_BUCKETS) {
      const layerId = extrudeLayerId(bucket)
      try {
        if (!map.getLayer(layerId)) continue
        const base: unknown[] = [
          'all',
          ['==', ['get', 'opacityBucket'], bucket],
          [
            'any',
            ['>', ['get', 'elevation'], 0],
            ['>', ['get', 'height'], 0],
          ],
        ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const filter: any = notMe ? [...base, notMe] : base
        map.setFilter(layerId, filter)
      } catch { /* ignore */ }
    }
    // LINE_LAYER skips meshed circles (their roof outline would float).
    try {
      if (map.getLayer(LINE_LAYER)) map.setFilter(LINE_LAYER, notMe ? ['all', notMe, NOT_MESHED] : NOT_MESHED)
    } catch { /* ignore */ }
    // LABEL_LAYER + LABEL_LAYER_FLAT — no default filter.
    for (const layerId of [LABEL_LAYER, LABEL_LAYER_FLAT]) {
      try {
        if (map.getLayer(layerId)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map.setFilter(layerId, (notMe ?? null) as any)
        }
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, transformState])

  // ---- Visibility toggle -------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const vis = committedVisible ? 'visible' : 'none'
    for (const id of [
      FILL_LAYER,
      ...EXTRUDE_LAYER_IDS,
      LINE_LAYER,
      SELECTION_TINT_LAYER,
      SELECTION_LAYER,
      LABEL_LAYER,
      LABEL_LAYER_FLAT,
      CLIP_LAYER,
    ]) {
      try {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis)
      } catch {
        /* ignore */
      }
    }
  }, [map, styleLoaded, styleGen, committedVisible])

  // Theme paint effect — push primary hex into selection outline +
  // tint (both committed and in-flight). Retints live on palette /
  // mode swaps. Mapbox's setPaintProperty is a no-op when unchanged.
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const id of [SELECTION_LAYER, SELECTION_INFLIGHT_LAYER]) {
      try {
        if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', primaryHex)
      } catch { /* ignore */ }
    }
    for (const id of [SELECTION_TINT_LAYER, SELECTION_TINT_INFLIGHT_LAYER]) {
      try {
        if (map.getLayer(id)) {
          map.setPaintProperty(id, 'fill-extrusion-color', primaryHex)
        }
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, primaryHex])

  // Keep tint + outline + in-flight surfaces + transform handle at the
  // top of the layer stack. Deps include `transformState` so handles
  // re-elevate the moment the user clicks Move / Rotate; omitting it
  // hides the handle behind overlays that mounted after us. `circles`
  // + `selectedCircleIds` are OMITTED — the drag handler bypasses React
  // state during a drag, so `circles` doesn't churn.
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const id of [
      SELECTION_TINT_LAYER,
      SELECTION_LAYER,
      FILL_INFLIGHT_LAYER,
      EXTRUDE_INFLIGHT_LAYER,
      LINE_INFLIGHT_LAYER,
      SELECTION_TINT_INFLIGHT_LAYER,
      SELECTION_INFLIGHT_LAYER,
      LABEL_INFLIGHT_LAYER,
      TRANSFORM_LAYER,
    ]) {
      try {
        if (map.getLayer(id)) map.moveLayer(id)
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, transformState])

  // ---- Click handling ----------------------------------------------------
  // Skipped entirely when `selectionEnabled` is false (a create-* tool is
  // active) — clicks pass through to the map's own handlers so the user
  // can drop a new shape on top of an existing circle.
  useEffect(() => {
    if (!map || !styleLoaded || !selectionEnabled) return
    const handleCircleClick = (
      e: MapMouseEvent & { features?: GeoJSON.Feature[] }
    ) => {
      if (e.originalEvent?.defaultPrevented) return
      // Defer when a more specific kind is also at the click point (model,
      // line, etc.) — see lib/overlay-hit-priority for the protocol.
      if (higherPriorityAt(map, e.point, 'circle')) return
      const feat = e.features?.[0]
      if (!feat) return
      const id = feat.properties?.circleId
      if (typeof id === 'number') {
        e.preventDefault()
        e.originalEvent?.preventDefault?.()
        onCircleClick?.(id, e.originalEvent)
      }
    }
    const handleMapClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      if (higherPriorityAt(map, e.point, 'circle')) return
      const layers = [FILL_LAYER, ...EXTRUDE_LAYER_IDS].filter((l) => map.getLayer(l))
      if (layers.length === 0) return
      const hits = map.queryRenderedFeatures(e.point, { layers })
      if (hits.length === 0) onMapClickEmpty?.()
    }
    const handleEnter = () => {
      map.getCanvas().style.cursor = 'pointer'
    }
    const handleLeave = () => {
      map.getCanvas().style.cursor = ''
    }
    map.on('click', FILL_LAYER, handleCircleClick)
    map.on('mouseenter', FILL_LAYER, handleEnter)
    map.on('mouseleave', FILL_LAYER, handleLeave)
    for (const id of EXTRUDE_LAYER_IDS) {
      map.on('click', id, handleCircleClick)
      map.on('mouseenter', id, handleEnter)
      map.on('mouseleave', id, handleLeave)
    }
    map.on('click', handleMapClick)
    return () => {
      map.off('click', FILL_LAYER, handleCircleClick)
      map.off('mouseenter', FILL_LAYER, handleEnter)
      map.off('mouseleave', FILL_LAYER, handleLeave)
      for (const id of EXTRUDE_LAYER_IDS) {
        map.off('click', id, handleCircleClick)
        map.off('mouseenter', id, handleEnter)
        map.off('mouseleave', id, handleLeave)
      }
      map.off('click', handleMapClick)
    }
  }, [map, styleLoaded, styleGen, selectionEnabled, onCircleClick, onMapClickEmpty])

  // ---- Transform handle (drag-to-move / drag-to-rotate) -----------------
  // Modeled on the grid overlay: a Mapbox `circle` paint layer reads
  // from `TRANSFORM_SOURCE`, which carries a single Point feature at
  // the handle position. Mouse events are wired on the map (not the
  // layer) so the drag continues even if the cursor slips off the dot.

  const transformChangeRef = useRef(onTransformChange)
  useEffect(() => {
    transformChangeRef.current = onTransformChange
  }, [onTransformChange])

  // Resolve the circle being transformed + the handle's anchor point.
  // `kind === 'move'` puts the handle at the move anchor (center / bbox
  // midpoint). `kind === 'rotate'` puts it at the rotated top-right
  // bbox corner so dragging it swings the bbox around its center.
  const transformContext = useMemo(() => {
    if (!transformState || !circles) return null
    const c = circles.find((x) => x.id === transformState.circleId)
    if (!c) return null
    let center: [number, number] | null = null
    if (c.mode === 'single' && c.center) {
      center = c.center
    } else if (c.mode === 'grid' && c.start && c.current) {
      center = [
        (c.start[0] + c.current[0]) / 2,
        (c.start[1] + c.current[1]) / 2,
      ]
    }
    if (!center) return null

    let anchor: [number, number]
    if (transformState.kind === 'rotate') {
      if (c.mode !== 'grid' || !c.start || !c.current) return null
      const maxLng = Math.max(c.start[0], c.current[0])
      const maxLat = Math.max(c.start[1], c.current[1])
      const vx = maxLng - center[0]
      const vy = maxLat - center[1]
      const rad = (c.rotation * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      anchor = [
        center[0] + vx * cos - vy * sin,
        center[1] + vx * sin + vy * cos,
      ]
    } else {
      anchor = center
    }
    return { circle: c, anchor, center }
  }, [transformState, circles])

  // Push handle position into the transform source. Empty FeatureCollection
  // when no transform is active = the circle paint layer renders nothing.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    if (!transformContext || !transformState) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    const c = transformContext.circle
    const kind = transformState.kind
    src.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: transformContext.anchor },
          properties: {
            kind,
            iconId: TRANSFORM_ICON[kind],
            imageRotation: c.rotation ?? 0,
            elevation: c.config.elevation ?? 0,
            height: c.config.height ?? 0,
          },
        },
      ],
    })
  }, [map, styleLoaded, styleGen, transformContext, transformState])

  // Mirror `transformContext` into a ref so the drag handler doesn't
  // re-mount when the memo identity changes.
  const transformContextRef = useRef(transformContext)
  useEffect(() => {
    transformContextRef.current = transformContext
  }, [transformContext])

  // ---- In-flight source population ------------------------------------
  // When a transform starts, immediately push the target circle's
  // features + label point into the in-flight sources so the moving
  // circle renders identically from the moment transformState flips.
  // Also pins the EXTRUDE_INFLIGHT_LAYER opacity via `setPaintProperty`
  // from the circle's config.opacity. On transform end, empties the
  // sources so no ghost feature lingers after the committed source
  // rebuilds.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const fillSrc = map.getSource(FILL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    const labelSrc = map.getSource(LABEL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
    if (!transformState || !transformContext) {
      fillSrc?.setData(emptyFC)
      labelSrc?.setData(emptyFC)
      return
    }
    const c = transformContext.circle
    const feats = buildCircleFeatures(c)
    fillSrc?.setData({
      type: 'FeatureCollection',
      features: feats as unknown as GeoJSON.Feature[],
    })
    // Label at the center (if enabled).
    const showLabels = c.config.showLabels ?? false
    const labelText = c.config.label?.trim() ?? ''
    if (showLabels && labelText !== '' && c.id !== undefined) {
      labelSrc?.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              id: `circle-label-${c.id}`,
              circleId: c.id,
              color: c.config.color,
              opacity: c.config.opacity,
              elevation: c.config.elevation ?? 0,
              height: c.config.height ?? 0,
              showLabels: true,
              label: labelText,
              labelSize: c.config.labelSize,
              labelColor: c.config.labelColor,
            },
            geometry: { type: 'Point', coordinates: transformContext.center },
          },
        ],
      })
    } else {
      labelSrc?.setData(emptyFC)
    }
    try {
      const op = Math.max(0, Math.min(1, (c.config.opacity ?? 100) / 100))
      map.setPaintProperty(EXTRUDE_INFLIGHT_LAYER, 'fill-extrusion-opacity', op)
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, transformState, transformContext])

  // Drag handling — mousedown / RAF-coalesced mousemove / mouseup cycle.
  // Bypasses React state during drag: writes go straight to the
  // in-flight FILL / LABEL sources + TRANSFORM_SOURCE via setData; only
  // mouseup fires `onTransformChange(patch, true)` to commit. Since the
  // spatial store isn't touched between mousedown and mouseup, the
  // parent's `circlesForOverlay` reference stays stable and the shared
  // `fc` / `labelPointData` / `clipData` memos DON'T rebuild every
  // circle's features on every mousemove.
  const dragRef = useRef<{
    dragging: boolean
    kind: 'move' | 'rotate' | null
    originalCircle: CircleShape | null
    originalAnchor: [number, number] | null
    originalCenter: [number, number] | null
    originalRotation: number
    downHandleAngle: number
    pendingCursor: [number, number] | null
    rafId: number
  } | null>(null)

  useEffect(() => {
    if (!map || !styleLoaded || !transformState) return

    if (!dragRef.current) {
      dragRef.current = {
        dragging: false,
        kind: null,
        originalCircle: null,
        originalAnchor: null,
        originalCenter: null,
        originalRotation: 0,
        downHandleAngle: 0,
        pendingCursor: null,
        rafId: 0,
      }
    }
    const drag = dragRef.current
    const canvas = map.getCanvas()

    const computePatch = (
      cursor: [number, number],
    ): {
      center?: [number, number]
      start?: [number, number]
      current?: [number, number]
      rotation?: number
    } | null => {
      const orig = drag.originalCircle
      if (!orig || !drag.originalAnchor || !drag.originalCenter) return null
      if (drag.kind === 'rotate') {
        const newAngle = Math.atan2(
          cursor[1] - drag.originalCenter[1],
          cursor[0] - drag.originalCenter[0],
        )
        const deltaDeg = ((newAngle - drag.downHandleAngle) * 180) / Math.PI
        let next = drag.originalRotation + deltaDeg
        while (next > 180) next -= 360
        while (next < -180) next += 360
        return { rotation: next }
      }
      if (orig.mode === 'single') {
        return { center: cursor }
      }
      const dLng = cursor[0] - drag.originalAnchor[0]
      const dLat = cursor[1] - drag.originalAnchor[1]
      if (!orig.start || !orig.current) return null
      return {
        start: [orig.start[0] + dLng, orig.start[1] + dLat],
        current: [orig.current[0] + dLng, orig.current[1] + dLat],
      }
    }

    const pushInflight = (patch: {
      center?: [number, number]
      start?: [number, number]
      current?: [number, number]
      rotation?: number
    }) => {
      const orig = drag.originalCircle
      if (!orig) return
      const patched: CircleShape = { ...orig, ...patch }
      const feats = buildCircleFeatures(patched)
      const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
      const fillSrc = map.getSource(FILL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      fillSrc?.setData({
        type: 'FeatureCollection',
        features: feats as unknown as GeoJSON.Feature[],
      })
      // Compute new center for label + handle.
      let newCenter: [number, number] | null = null
      if (patched.mode === 'single' && patched.center) {
        newCenter = patched.center
      } else if (patched.mode === 'grid' && patched.start && patched.current) {
        newCenter = [
          (patched.start[0] + patched.current[0]) / 2,
          (patched.start[1] + patched.current[1]) / 2,
        ]
      }
      // Label follows the center.
      const labelSrc = map.getSource(LABEL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      if (labelSrc) {
        const showLabels = patched.config.showLabels ?? false
        const labelText = patched.config.label?.trim() ?? ''
        if (showLabels && labelText !== '' && newCenter && patched.id !== undefined) {
          labelSrc.setData({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {
                  id: `circle-label-${patched.id}`,
                  circleId: patched.id,
                  color: patched.config.color,
                  opacity: patched.config.opacity,
                  elevation: patched.config.elevation ?? 0,
                  height: patched.config.height ?? 0,
                  showLabels: true,
                  label: labelText,
                  labelSize: patched.config.labelSize,
                  labelColor: patched.config.labelColor,
                },
                geometry: { type: 'Point', coordinates: newCenter },
              },
            ],
          })
        } else {
          labelSrc.setData(emptyFC)
        }
      }
      // Follow the moving circle with the transform handle.
      const transformSrc = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
      if (transformSrc && newCenter && drag.kind) {
        let anchor: [number, number]
        if (drag.kind === 'rotate') {
          if (patched.mode === 'grid' && patched.start && patched.current) {
            const maxLng = Math.max(patched.start[0], patched.current[0])
            const maxLat = Math.max(patched.start[1], patched.current[1])
            const vx = maxLng - newCenter[0]
            const vy = maxLat - newCenter[1]
            const rad = (patched.rotation * Math.PI) / 180
            const cos = Math.cos(rad)
            const sin = Math.sin(rad)
            anchor = [
              newCenter[0] + vx * cos - vy * sin,
              newCenter[1] + vx * sin + vy * cos,
            ]
          } else {
            anchor = newCenter
          }
        } else {
          anchor = newCenter
        }
        transformSrc.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: anchor },
              properties: {
                kind: drag.kind,
                iconId: TRANSFORM_ICON[drag.kind],
                imageRotation: patched.rotation ?? 0,
                elevation: patched.config.elevation ?? 0,
                height: patched.config.height ?? 0,
              },
            },
          ],
        })
      }
    }

    const flushDragFrame = () => {
      drag.rafId = 0
      if (!drag.dragging || !drag.pendingCursor) return
      const patch = computePatch(drag.pendingCursor)
      if (!patch) return
      pushInflight(patch)
    }
    const scheduleFlush = () => {
      if (drag.rafId !== 0) return
      drag.rafId = requestAnimationFrame(flushDragFrame)
    }

    const onMouseDown = (e: MapMouseEvent) => {
      if (!map.getLayer(TRANSFORM_LAYER)) return
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [TRANSFORM_LAYER],
      })
      if (hits.length === 0) return
      const ctx = transformContextRef.current
      if (!ctx) return
      drag.dragging = true
      drag.kind = transformState.kind
      drag.originalCircle = ctx.circle
      drag.originalAnchor = ctx.anchor
      drag.originalCenter = ctx.center
      drag.originalRotation = ctx.circle.rotation
      drag.downHandleAngle = Math.atan2(
        ctx.anchor[1] - ctx.center[1],
        ctx.anchor[0] - ctx.center[0],
      )
      map.dragPan.disable()
      canvas.style.cursor = transformState.kind === 'rotate' ? 'crosshair' : 'grabbing'
      e.preventDefault?.()
    }

    const onMouseMove = (e: MapMouseEvent) => {
      if (!drag.dragging) return
      drag.pendingCursor = [e.lngLat.lng, e.lngLat.lat]
      scheduleFlush()
    }
    const onMouseUp = (e: MapMouseEvent) => {
      if (!drag.dragging) return
      drag.dragging = false
      map.dragPan.enable()
      canvas.style.cursor = ''
      const cursor: [number, number] = [e.lngLat.lng, e.lngLat.lat]
      if (drag.rafId !== 0) {
        cancelAnimationFrame(drag.rafId)
        drag.rafId = 0
      }
      drag.pendingCursor = null
      const patch = computePatch(cursor)
      drag.originalCircle = null
      drag.originalAnchor = null
      drag.originalCenter = null
      drag.kind = null
      if (patch) transformChangeRef.current?.(patch, true)
    }
    const onEnter = () => {
      if (!drag.dragging) {
        canvas.style.cursor =
          transformState.kind === 'rotate' ? 'crosshair' : 'grab'
      }
    }
    const onLeave = () => {
      if (!drag.dragging) canvas.style.cursor = ''
    }

    map.on('mousedown', onMouseDown)
    map.on('mousemove', onMouseMove)
    map.on('mouseup', onMouseUp)
    map.on('mouseenter', TRANSFORM_LAYER, onEnter)
    map.on('mouseleave', TRANSFORM_LAYER, onLeave)
    return () => {
      map.off('mousedown', onMouseDown)
      map.off('mousemove', onMouseMove)
      map.off('mouseup', onMouseUp)
      map.off('mouseenter', TRANSFORM_LAYER, onEnter)
      map.off('mouseleave', TRANSFORM_LAYER, onLeave)
      map.dragPan.enable()
      canvas.style.cursor = ''
      if (drag.rafId !== 0) {
        cancelAnimationFrame(drag.rafId)
        drag.rafId = 0
      }
    }
  }, [map, styleLoaded, styleGen, transformState])

  return null
}
