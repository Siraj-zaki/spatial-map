import {
  buildAxisGuideFeature,
  buildLineChainFeature,
  buildLineFeature,
  buildLineFeatureCollection,
  buildLineWallBorderCollection,
  buildLineWallCollection,
  buildLineWallFeature,
  buildSnapTargetFeature,
  lineCentroid,
  lineLabelAnchor,
  type LineProps,
  rotateLine,
} from '@/lib/line-generators'
import { leaningWallMeshes } from '@/lib/sloped-mesh'
import { useShapeMeshLayers } from '@/hooks/useShapeMeshLayers'
import type { LineSnap } from '@/lib/line-snap'
import { higherPriorityAt } from '@/lib/overlay-hit-priority'
import { rotatePointAround } from '@/lib/image-generators'
import {
  TRANSFORM_ICON,
  readThemePrimaryForegroundHex,
  readThemePrimaryHex,
  registerTransformHandleIcons,
  subscribeThemeChanges,
} from '@/lib/map-transform-handles'
import type { LineShape, LineShapeConfig } from '@/lib/shapes'
import { registerLayerFeaturePredicate, type LayerFeaturePredicate } from '@/lib/empty-layer-gate'
import { useGraphicsSettings } from '@/lib/graphics-settings'
import { patchFeatureCollection } from '@/lib/focus/focus-fade'
import {
  cutRegionContains,
  focusCutRegion,
  focusFadeCollection,
  focusFadeLineCollection,
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
import type { GeoJSONSource, Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import { useEffect, useMemo, useRef, useState } from 'react'

interface MapLineOverlayProps {
  map: MapboxMapInstance | null
  lines?: ReadonlyArray<LineShape>
  liveVertices?: ReadonlyArray<[number, number]>
  liveCursor?: [number, number] | null
  liveConfig?: LineShapeConfig
  selectedLineIds?: ReadonlySet<number>
  onLineClick?: (id: number, originalEvent: MouseEvent) => void
  onMapClickEmpty?: () => void
  committedVisible?: boolean
  selectionEnabled?: boolean
  transformState?: { lineId: number; kind: 'move' | 'rotate' } | null
  onTransformChange?: (
    patch: { vertices?: [number, number][]; rotation?: number },
    commit: boolean
  ) => void
  /** Per-shape style overrides from the style-rules engine. */
  shapeStyleOverrides?: ReadonlyMap<number, import('@/lib/line-generators').LineStyleOverride> | null
  /**
   * Doors attached to each wall (keyed by LineShape.id). Each door's
   * opening footprint is subtracted from the wall's fill-extrusion
   * so the wall renders with a real hole where the door sits. See
   * `buildLineWallFeature`'s `attachedDoors` option. Missing entries
   * mean "no attached doors" and the wall renders solid as before.
   */
  attachedDoorsByLineId?: ReadonlyMap<number, ReadonlyArray<import('@/lib/door/types').DoorShape>> | null
  /**
   * Snap decision for the current live-draw cursor (see
   * `@/lib/line-snap`). Drives the chain paint (green when snapped,
   * amber otherwise) plus the ring-around-endpoint and axis-guide
   * indicators. `null` = tool not active OR no chain yet.
   */
  liveSnap?: LineSnap | null
}

const LINE_SOURCE = 'line-source'
// Casing/border layer — rendered BEFORE the main stroke so the border
// color forms an outline on either side. Only visible when a shape has
// `config.borderWidth > 0`; features with borderWidth === 0 paint a
// zero-width line and are effectively invisible without needing a
// separate filter.
const LINE_BORDER_LAYER = 'line-border-layer'
const LINE_LAYER = 'line-stroke-layer'
const SELECTION_LAYER = 'line-selection-layer'
const SELECTION_TINT_LAYER = 'line-selection-tint-layer'
const WALL_SOURCE = 'line-wall-source'
// `fill-extrusion-opacity` rejects ALL data expressions (including
// feature-state) in Mapbox GL JS 3.x. To still get per-line opacity in
// the 3D wall, we pre-create one fill-extrusion layer per discrete
// opacity bucket (every 10%), each carrying its own constant
// `fill-extrusion-opacity`. The generator stamps `properties.opacityBucket`
// on every wall feature and each layer's filter routes the feature into
// the matching bucket. Same trick the grid overlay uses for cells.
const OPACITY_BUCKETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const
const WALL_LAYER_BASE = 'line-wall-layer'
const WALL_LAYER_IDS = OPACITY_BUCKETS.map((b) => `${WALL_LAYER_BASE}-op${b}`)
const wallLayerId = (bucket: number) => `${WALL_LAYER_BASE}-op${bucket}`
// Outline traced round the walls at their roof height, from its own
// source: one border round each group of touching walls of the same
// height (`buildLineWallBorderCollection`), so a joint draws one line,
// not each wall's own crossing outline. Each stretch reads the
// borderColor + borderWidth of the wall it runs along. Empty for flat
// lines, so this layer paints nothing for those.
const WALL_BORDER_SOURCE = 'line-wall-border-source'
const WALL_BORDER_LAYER = 'line-wall-border-layer'
// Leaning walls are drawn as meshes (useShapeMeshLayers); their extruded
// feature stays in the zero-opacity bucket as the click target, so the
// roof outline and the extruded selection wash must skip it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NOT_MESHED: any = ['!=', ['get', 'meshed'], true]
// Height of the wall roof the stroke rides on — a leaning wall's top isn't
// above its line, so its stroke stays at the base.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ROOF_HEIGHT: any = ['case', ['==', ['get', 'meshed'], true], 0, ['coalesce', ['get', 'height'], 0]]
const LABEL_SOURCE = 'line-label-source'
const LABEL_LAYER = 'line-label-layer'
// Focus mode (src/lib/focus): a faded line's label carries the fade factor
// as `focusFade`, so it fades with its stroke and wall. No label carries it
// while nothing is focused, so `text-opacity` stays 1, its old default.
const FOCUS_FADE_PROP = 'focusFade'
const CHAIN_SOURCE = 'line-chain-source'
const CHAIN_LINE_LAYER = 'line-chain-line-layer'
const CHAIN_VERTEX_LAYER = 'line-chain-vertex-layer'
const TRANSFORM_SOURCE = 'line-transform-source'
const TRANSFORM_LAYER = 'line-transform-layer'
const TRANSFORM_ICON_LAYER = 'line-transform-icon-layer'
// Live-draw snap indicators. `AXIS_GUIDE_LAYER` is a long dashed ray
// along the cardinal axis the cursor has snapped to; `SNAP_TARGET_LAYER`
// is a green ring around the endpoint the cursor has snapped to.
const AXIS_GUIDE_SOURCE = 'line-axis-guide-source'
const AXIS_GUIDE_LAYER = 'line-axis-guide-layer'
const SNAP_TARGET_SOURCE = 'line-snap-target-source'
const SNAP_TARGET_LAYER = 'line-snap-target-layer'
const SNAP_TARGET_HALO_LAYER = 'line-snap-target-halo-layer'
// Live-draw wall preview — an extruded polygon that follows the chain
// while the user is still drawing, so a wall with height > 0 shows
// its actual 3D form as it's being placed instead of only the flat
// chain guide.
const PREVIEW_WALL_SOURCE = 'line-preview-wall-source'
const PREVIEW_WALL_LAYER = 'line-preview-wall-layer'
// In-flight sources — hold ONLY the line currently being moved/rotated
// so its per-frame turf.buffer / turf.transformRotate cost is O(1)
// instead of O(N_walls) that a rebuild of the committed WALL_SOURCE
// would incur. The committed LINE_LAYER / WALL_LAYER_op* / LABEL_LAYER
// filter the transforming id OUT while the drag is live, so the two
// halves compose into a single visual with no phantom underneath.
// Populated + consumed exclusively by the drag handler + the transform-
// activation effect — never by React state during drag.
const LINE_INFLIGHT_SOURCE = 'line-inflight-source'
const LINE_INFLIGHT_BORDER_LAYER = 'line-inflight-border-layer'
const LINE_INFLIGHT_LAYER = 'line-inflight-layer'
const WALL_INFLIGHT_SOURCE = 'line-wall-inflight-source'
const WALL_INFLIGHT_LAYER = 'line-wall-inflight-layer'
const WALL_INFLIGHT_BORDER_LAYER = 'line-wall-inflight-border-layer'
// Halo + tint on the in-flight source so the selection highlight
// tracks the moving line at full quality. Only render anything when
// the in-flight source is non-empty (i.e. a transform is active).
const SELECTION_INFLIGHT_LAYER = 'line-selection-inflight-layer'
const SELECTION_TINT_INFLIGHT_LAYER = 'line-selection-tint-inflight-layer'

// ---- Empty-layer gate predicates (lib/empty-layer-gate.ts) ----------------
// Each one is a JS transcription of a layer filter this overlay sets, so the
// gate can hide a layer whose filter passes nothing (empty opacity buckets,
// the selection layers with nothing selected) — Mapbox re-evaluates every
// visible layer each frame even when it draws nothing. Registered right
// after every `addLayer` / `setFilter` of that layer, with the same inputs.
// Mapbox `get` reads a missing property as null and `==` / `!=` / `in` are
// strict, so `?.` + `??` + `===` match it value for value.

/** WALL_LAYER_op<bucket>: `['==', ['coalesce', ['get', 'opacityBucket'], 100], bucket]`, plus `['!=', ['get', 'lineId'], excludeId]` while a transform is active. */
export function lineWallBucketPredicate(bucket: number, excludeId?: number | null): LayerFeaturePredicate {
  return (f) => {
    const p = f.properties
    if ((p?.opacityBucket ?? 100) !== bucket) return false
    return excludeId == null || p?.lineId !== excludeId
  }
}

/** WALL_BORDER_LAYER: NOT_MESHED, plus the transform exclusion while one is active. */
export function lineWallBorderPredicate(excludeId?: number | null): LayerFeaturePredicate {
  return (f) => {
    const p = f.properties
    if (p?.meshed === true) return false
    return excludeId == null || p?.lineId !== excludeId
  }
}

/** SELECTION_LAYER: `['in', ['get', 'lineId'], ['literal', ids]]`, plus the transform exclusion while one is active. */
export function lineSelectionPredicate(ids: ReadonlyArray<number>, excludeId?: number | null): LayerFeaturePredicate {
  const selected = new Set<unknown>(ids)
  return (f) => {
    const id = f.properties?.lineId
    if (!selected.has(id)) return false
    return excludeId == null || id !== excludeId
  }
}

/** SELECTION_TINT_LAYER: the selection filter AND NOT_MESHED. */
export function lineSelectionTintPredicate(ids: ReadonlyArray<number>, excludeId?: number | null): LayerFeaturePredicate {
  const selection = lineSelectionPredicate(ids, excludeId)
  return (f) => f.properties?.meshed !== true && selection(f)
}

/** The selection layers' addLayer filter, `['==', ['get', 'lineId'], -1]`. */
export const lineSelectionSentinelPredicate: LayerFeaturePredicate = (f) => f.properties?.lineId === -1

// ---- Empty-layer gate: hide deferral + shadow-pass parity -----------------

/** A layer an overlay gates with a predicate (see GatedLayerHold). */
export interface GatedLayerSpec {
  sourceId: string
  /** The layer's `fill-extrusion-cast-shadows` (spec default `true`); false for line / symbol layers. */
  castsShadows: boolean
}

type GateFeature = Parameters<LayerFeaturePredicate>[0]

interface GatedLayerState {
  spec: GatedLayerSpec
  /** JS mirror of the filter currently set on the layer. */
  test: LayerFeaturePredicate
  /** Held, or a shadow caster while shadows are on: the gate must count every feature. */
  pinned: boolean
  /** What the gate counts. One stable function per layer; reads `pinned` / `test` at count time. */
  predicate: LayerFeaturePredicate
}

/**
 * Wraps `registerLayerFeaturePredicate` for one overlay instance so that a
 * predicate never hides a layer that may still be drawing, and never moves
 * the ground-shadow pass. Used by the line, stair, door and text-label
 * overlays; map-polygon-overlay.tsx carries the same hold as its GateHold.
 *
 * Hide deferral. Mapbox GL 3.25 builds no bucket for a layer whose
 * visibility is 'none', so the gate's synchronous show only draws once the
 * source has re-tiled, while a hide applies on the very next frame. When a
 * feature leaves the last member of a gated layer (a wall from bucket 50 to
 * 60, a label switching alignment, the transform exclusion, a cleared
 * selection), the old layer would vanish a worker round trip before the new
 * tiles draw the feature anywhere else. Before the predicates, the old tiles
 * kept drawing it in its old layer until the new ones replaced them. So a
 * layer whose filter stops matching is HELD visible until the first
 * `render` in which its source is loaded again, and only then re-counted
 * (and hidden). Shows stay synchronous, so a new selection never lags.
 *
 * Shadow pass. With Graphics > Shadows on, Mapbox draws the ground-shadow
 * pass right after the last visible shadow-casting layer in style order
 * (ShadowRenderer.updateShadowParameters), and the 2D layers ordered before
 * it get shaded by it. Hiding an empty caster would move that pass, so
 * while shadows are on a caster keeps the gate's source-count rule
 * (visible whenever its source has a feature), exactly as before the
 * predicates.
 *
 * Call `register` (in place of `registerLayerFeaturePredicate`) right after
 * every `addLayer` / `setFilter` of a gated layer, `push` right BEFORE
 * every `setData` of a gated source, `resetSource` when that source is
 * (re)created empty, and `attach` once per map.
 */
export class GatedLayerHold {
  private readonly specs: ReadonlyMap<string, GatedLayerSpec>
  private readonly layers = new Map<string, GatedLayerState>()
  /** Layers whose test passed ≥1 feature at their last push / register. */
  private readonly matched = new Set<string>()
  /** Layers kept visible until their source has re-tiled the change that emptied them. */
  private readonly held = new Set<string>()
  /** source id → features of its last push. */
  private readonly features = new Map<string, ReadonlyArray<GateFeature>>()
  private shadows = false
  private armed: { map: MapboxMapInstance; onRender: () => void } | null = null

  constructor(specs: ReadonlyMap<string, GatedLayerSpec>) {
    this.specs = specs
  }

  /** Follow the Graphics > Shadows setting. Returns the unmount cleanup. */
  attach(map: MapboxMapInstance): () => void {
    const sync = () => this.setShadows(map, useGraphicsSettings.getState().shadows)
    sync()
    const unsubscribe = useGraphicsSettings.subscribe(sync)
    return () => {
      unsubscribe()
      this.disarm()
    }
  }

  /** The source was (re)created empty, so none of its old tiles are on screen. */
  resetSource(sourceId: string): void {
    this.features.delete(sourceId)
    for (const [layerId, layer] of this.layers) {
      if (layer.spec.sourceId !== sourceId) continue
      this.matched.delete(layerId)
      this.held.delete(layerId)
      this.pin(layerId, layer)
    }
  }

  /** Gate `layerId` on `test`, a JS mirror of the filter just set on it. */
  register(map: MapboxMapInstance, layerId: string, test: LayerFeaturePredicate): void {
    const spec = this.specs.get(layerId)
    if (!spec) {
      registerLayerFeaturePredicate(map, layerId, test)
      return
    }
    let layer = this.layers.get(layerId)
    if (!layer) {
      const state: GatedLayerState = {
        spec,
        test,
        pinned: false,
        predicate: (f) => state.pinned || state.test(f),
      }
      layer = state
      this.layers.set(layerId, layer)
    }
    layer.test = test
    this.track(layerId, layer)
    registerLayerFeaturePredicate(map, layerId, layer.predicate)
    this.arm(map)
  }

  /** Call right BEFORE `setData(fc)` on a gated source: the gate re-counts inside it. */
  push(map: MapboxMapInstance, sourceId: string, fc: { features: ReadonlyArray<unknown> }): void {
    this.features.set(sourceId, fc.features as ReadonlyArray<GateFeature>)
    for (const [layerId, layer] of this.layers) {
      if (layer.spec.sourceId === sourceId) this.track(layerId, layer)
    }
    this.arm(map)
  }

  /** A layer that matched before but not now may still be drawing the old tiles: hold it. */
  private track(layerId: string, layer: GatedLayerState): void {
    if (this.matches(layer)) this.matched.add(layerId)
    else if (this.matched.delete(layerId)) this.held.add(layerId)
    this.pin(layerId, layer)
  }

  private matches(layer: GatedLayerState): boolean {
    const features = this.features.get(layer.spec.sourceId)
    if (!features) return false
    try {
      return features.some((f) => layer.test(f))
    } catch {
      return true
    }
  }

  private pin(layerId: string, layer: GatedLayerState): void {
    layer.pinned = this.held.has(layerId) || (layer.spec.castsShadows && this.shadows)
  }

  private setShadows(map: MapboxMapInstance, on: boolean): void {
    if (on === this.shadows) return
    this.shadows = on
    for (const [layerId, layer] of this.layers) {
      if (!layer.spec.castsShadows) continue
      this.pin(layerId, layer)
      if (map.getLayer(layerId)) registerLayerFeaturePredicate(map, layerId, layer.predicate)
    }
  }

  /**
   * Release held layers on the first `render` in which their source is
   * loaded. `render` fires after `style.update` has started any pending
   * reload, so "loaded" there means the tiles on screen were built from
   * the latest `setData` / filter.
   */
  private arm(map: MapboxMapInstance): void {
    if (this.held.size === 0 || this.armed?.map === map) return
    this.disarm()
    const onRender = () => {
      for (const layerId of [...this.held]) {
        const layer = this.layers.get(layerId)
        if (layer && !gatedSourceSettled(map, layer.spec.sourceId)) continue
        this.held.delete(layerId)
        if (!layer) continue
        this.pin(layerId, layer)
        if (map.getLayer(layerId)) registerLayerFeaturePredicate(map, layerId, layer.predicate)
      }
      if (this.held.size === 0) this.disarm()
    }
    map.on('render', onRender)
    this.armed = { map, onRender }
  }

  private disarm(): void {
    if (!this.armed) return
    this.armed.map.off('render', this.armed.onRender)
    this.armed = null
  }
}

/** True once `sourceId`'s tiles reflect its latest data and filters (or the source is gone). */
function gatedSourceSettled(map: MapboxMapInstance, sourceId: string): boolean {
  try {
    return !map.getSource(sourceId) || map.isSourceLoaded(sourceId)
  } catch {
    return true
  }
}

// ---- Focus mode: stable derived collections --------------------------------

/** base collection → its last focus-derived copy (see stableDerivedCollection). */
const lastDerived = new WeakMap<object, { features: ReadonlyArray<unknown> }>()

function sameItems(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * `next`, a copy-on-write derivative of `base` (a focus fade or tier stamp
 * from `@/lib/focus/focus-fade`), or the previous derivative of the same
 * `base` when it holds the very same feature objects. The fade helpers
 * cache each faded feature, but always return a NEW collection object when
 * anything is faded. So a focus change that leaves this overlay's fades as
 * they were (a NEAR column that differs only in other kinds, a data-link
 * anchor arriving, a camera settle that only changed other kinds'
 * blockers) would otherwise
 * re-push the whole source. Returning the earlier object keeps the push
 * effect's dependency unchanged. `next === base` (nothing faded) passes
 * straight through.
 */
export function stableDerivedCollection<T extends { features: ReadonlyArray<unknown> }>(base: T, next: T): T {
  if (next === base) return base
  const prev = lastDerived.get(base) as T | undefined
  if (prev && sameItems(prev.features, next.features)) return prev
  lastDerived.set(base, next)
  return next
}

/** `line:<id>` / `line:<id>#cut` (a leaning-wall mesh key) → id. */
function lineIdOfMeshKey(key: string): number | undefined {
  if (!key.startsWith('line:')) return undefined
  const hash = key.indexOf('#')
  const id = Number(key.slice(5, hash < 0 ? undefined : hash))
  return Number.isInteger(id) ? id : undefined
}

/** Every layer this overlay gates with a predicate. */
const LINE_GATED_LAYERS: ReadonlyMap<string, GatedLayerSpec> = new Map<string, GatedLayerSpec>([
  // The 0% bucket doesn't cast (see its paint); every other bucket does.
  ...OPACITY_BUCKETS.map((b) => [wallLayerId(b), { sourceId: WALL_SOURCE, castsShadows: b > 0 }] as const),
  [WALL_BORDER_LAYER, { sourceId: WALL_BORDER_SOURCE, castsShadows: false }],
  // fill-extrusion without an explicit cast-shadows: the spec default, true.
  [SELECTION_TINT_LAYER, { sourceId: WALL_SOURCE, castsShadows: true }],
  [SELECTION_LAYER, { sourceId: LINE_SOURCE, castsShadows: false }],
])

/**
 * Polyline rendering — line stroke, optional 3D wall via buffered
 * polygon extrusion, selection halo with z-offset, label at
 * start/middle/end, live-draw chain, and transform handles. Same
 * architecture as the polygon overlay, narrowed to LineString.
 */
export function MapLineOverlay({
  map,
  lines,
  liveVertices,
  liveCursor,
  liveConfig,
  selectedLineIds,
  onLineClick,
  onMapClickEmpty,
  committedVisible = true,
  selectionEnabled = true,
  transformState = null,
  onTransformChange,
  shapeStyleOverrides = null,
  attachedDoorsByLineId = null,
  liveSnap = null,
}: MapLineOverlayProps) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  // `styleGen` increments on each style.load — see matching note in
  // `map-polygon-overlay.tsx`. Without this counter, basemap swaps
  // leave `styleLoaded` already true and the source/layer effect
  // never re-runs, so Mapbox-wiped layers stay gone.
  const [styleGen, setStyleGen] = useState(0)

  // ---- Style readiness ---------------------------------------------------
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

  // ---- Theme-tinted handle icons -----------------------------------------
  // Same pattern as image + polygon overlays. See
  // `@/lib/map-transform-handles` for the shared render + subscription.
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

  // ---- Data --------------------------------------------------------------
  const fc = useMemo(
    () => buildLineFeatureCollection(lines ?? [], shapeStyleOverrides),
    [lines, shapeStyleOverrides]
  )

  const wallFc = useMemo(
    () => buildLineWallCollection(lines ?? [], shapeStyleOverrides, attachedDoorsByLineId),
    [lines, shapeStyleOverrides, attachedDoorsByLineId]
  )

  const wallBorderFc = useMemo(() => buildLineWallBorderCollection(wallFc), [wallFc])

  // ---- Focus mode (src/lib/focus) ----------------------------------------
  // While an item is focused, only two kinds of line fade: the walls
  // between the camera and the item (blockers, FOCUS_FACTOR.ghost) and the
  // ones right next to it (the NEAR column, FOCUS_FACTOR.near). Every other
  // line keeps its feature objects. `fill-extrusion-opacity` is a per-layer
  // constant, so a faded wall MOVES to a lower bucket layer: a
  // copy-on-write post-pass re-stamps `opacity` / `opacityBucket` (the
  // stroke, casing and wall-roof outline read `opacity` directly). Kept out
  // of the `fc` / `wallFc` memos, which run a turf buffer and the door
  // cutouts per wall, so a blocker change at camera settle never rebuilds
  // them. With nothing focused the memos below hand back `fc` / `wallFc` /
  // `labelData` themselves, so no push re-runs. Selection, exclusion and
  // transform logic stay on the originals.
  //
  // Local cut-away (focus-cutaway.ts): a near / blocker line much bigger
  // than its region (a long wall, the stadium canopy) fades only inside it
  // — the item column, plus the discs where the line of sight pierces a
  // blocker. A wall polygon splits into an 'in' and an 'out' feature, a
  // stroke at the region boundary; both keep the line's `lineId` and
  // feature id, so clicks / selection (by `lineId`) still find it. The
  // short cross edge WALL_BORDER draws at a cut is accepted.
  // DOOR CHOICE: `wallFc` is already punched by the attached doors'
  // opening footprints, and the split runs on that punched polygon, so a
  // door opening stays exact on both pieces; lintels are door-overlay
  // features and are unaffected. A leaning wall (meshed hit target) is
  // never split into pieces: its built MESH is split per triangle instead
  // (`meshCutAway`), so its lean — closed loop and 'in' side included — is
  // untouched.
  const focusScene = useFocusScene()
  const focusBlockers = useFocusBlockers()
  // Same Set / Map while the line blockers and their pierce discs are
  // unchanged: other kinds' blocker changes don't re-push these sources.
  const lineBlockers = blockerIdsOf(focusBlockers, 'lines')
  const linePierce = blockerPierceOf(focusBlockers, 'lines')
  /** Fade factor / cut region by line id, or null while nothing is focused. */
  const lineFocus = useMemo(() => {
    if (!focusScene.active) return null
    return {
      factorOf: (id: number | undefined): number =>
        id === undefined ? 1 : focusFactor(focusScene, focusBlockers, 'lines', id),
      regionOf: (id: number | undefined) =>
        id === undefined ? null : focusCutRegion(focusScene, focusBlockers, 'lines', id),
    }
    // `focusBlockers` is read only through its line set and pierce map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusScene, lineBlockers, linePierce])
  const fadedFc = useMemo<
    GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString, LineProps & { focusPiece?: FocusPiece }>
  >(
    () =>
      lineFocus
        ? stableDerivedCollection(
            fc as GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString, LineProps & { focusPiece?: FocusPiece }>,
            focusFadeLineCollection(
              fc,
              (f) => lineFocus.factorOf(f.properties.lineId),
              (f) => lineFocus.regionOf(f.properties.lineId),
            ),
          )
        : fc,
    [fc, lineFocus],
  )
  // The roof outline fades with its walls, per stretch (each carries the
  // `lineId` of the wall it runs along).
  const fadedWallBorderFc = useMemo<
    GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString, LineProps & { focusPiece?: FocusPiece }>
  >(
    () =>
      lineFocus
        ? stableDerivedCollection(
            wallBorderFc as GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString, LineProps & { focusPiece?: FocusPiece }>,
            focusFadeLineCollection(
              wallBorderFc,
              (f) => lineFocus.factorOf(f.properties.lineId),
              (f) => lineFocus.regionOf(f.properties.lineId),
            ),
          )
        : wallBorderFc,
    [wallBorderFc, lineFocus],
  )
  const fadedWallFc = useMemo<
    GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, LineProps & { focusPiece?: FocusPiece }>
  >(
    () =>
      lineFocus
        ? stableDerivedCollection(
            wallFc as GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, LineProps & { focusPiece?: FocusPiece }>,
            focusFadeCollection(
              wallFc,
              (f) => lineFocus.factorOf(f.properties.lineId),
              (f) => lineFocus.regionOf(f.properties.lineId),
            ),
          )
        : wallFc,
    [wallFc, lineFocus],
  )

  // Leaning walls (sloped-mesh.ts). The one being moved / rotated shows as
  // its in-flight extrusion until it's dropped. Built from `wallFc`
  // (focus-independent), so leaving focus hands back the very same array.
  // While focused they're built from `fadedWallFc` (a whole-faded leaning
  // wall carries its faded `opacity` → translucent mesh layer), then
  // `meshCutAway` splits a big near / blocker wall per triangle (inside:
  // `line:<id>#cut` at the tier's alpha).
  const baseWallMeshes = useMemo(
    () =>
      leaningWallMeshes(lines ?? [], wallFc.features, rotateLine, {
        selectedIds: selectedLineIds,
        tint: primaryHex,
        skipId: transformState?.lineId ?? null,
      }),
    [lines, wallFc, selectedLineIds, primaryHex, transformState],
  )
  const wallMeshes = useMemo(() => {
    if (!lineFocus) return baseWallMeshes
    const built =
      fadedWallFc === wallFc
        ? baseWallMeshes
        : leaningWallMeshes(lines ?? [], fadedWallFc.features, rotateLine, {
            selectedIds: selectedLineIds,
            tint: primaryHex,
            skipId: transformState?.lineId ?? null,
          })
    return meshCutAway(
      built,
      (key) => lineFocus.regionOf(lineIdOfMeshKey(key)),
      (key) => lineFocus.factorOf(lineIdOfMeshKey(key)),
    )
  }, [baseWallMeshes, lineFocus, fadedWallFc, wallFc, lines, selectedLineIds, primaryHex, transformState])
  useShapeMeshLayers(map, styleLoaded, styleGen, 'line', wallMeshes, committedVisible)

  // Chain layer feeds two paint passes: a dashed line for the edges
  // and a symbol layer at each committed vertex. The chain LineString
  // carries `snapKind` (endpoint / axis-horizontal / axis-vertical /
  // none) so the paint expression can swap the colour + dash pattern
  // without React re-mounting the source.
  const chainData = useMemo<
    GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.Point> | null
  >(() => {
    const verts = liveVertices ?? []
    if (verts.length === 0) return null
    const features: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.Point>[] = []
    if (liveConfig) {
      // Use the SNAPPED cursor (liveSnap?.position) for the trailing
      // preview edge — otherwise the guide extends to the raw cursor
      // and the user sees an "almost snapped" line that jitters off
      // the target. When there's no snap, position equals raw cursor.
      const previewCursor = liveSnap?.position ?? liveCursor ?? null
      const chain = buildLineChainFeature(
        verts as [number, number][],
        previewCursor,
        liveConfig,
        liveSnap?.kind ?? 'none',
      )
      if (chain) features.push(chain)
    }
    // Stamp `elevation`, `height`, + `snapped` on each vertex Point so
    // the chain vertex symbol layer can (a) lift them onto the roof
    // of the preview wall via `symbol-z-offset = elevation + height`,
    // and (b) recolour the final "preview" vertex green when it's
    // the snapped one. Only the FINAL vertex is treated as the
    // preview (its coord equals `previewCursor`); committed vertices
    // stay amber.
    const vertexElev = liveConfig?.elevation ?? 0
    const vertexHeight = liveConfig?.height ?? 0
    const snapKind = liveSnap?.kind ?? 'none'
    for (const v of verts) {
      features.push({
        type: 'Feature',
        properties: {
          elevation: vertexElev,
          height: vertexHeight,
          snapped: 0,
        },
        geometry: { type: 'Point', coordinates: v },
      })
    }
    // The trailing preview vertex (at the snapped position) — coloured
    // by snapKind so the user sees the green ring "lock" onto the
    // target the moment they hover close enough.
    const previewCursor = liveSnap?.position ?? liveCursor ?? null
    if (previewCursor) {
      features.push({
        type: 'Feature',
        properties: {
          elevation: vertexElev,
          height: vertexHeight,
          snapped: snapKind === 'none' ? 0 : 1,
        },
        geometry: { type: 'Point', coordinates: previewCursor },
      })
    }
    return { type: 'FeatureCollection', features }
  }, [liveVertices, liveCursor, liveConfig, liveSnap])

  // Axis guide + snap target — decoupled from `chainData` so their
  // sources refresh independently of the main chain. Empty collections
  // when no relevant snap is active; the layers just render nothing.
  const axisGuideData = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!liveSnap || (liveSnap.kind !== 'axis-horizontal' && liveSnap.kind !== 'axis-vertical')) {
      return null
    }
    const from = liveVertices && liveVertices.length > 0
      ? liveVertices[liveVertices.length - 1]
      : null
    if (!from || !liveSnap.axisGuideEnd) return null
    const feat = buildAxisGuideFeature(
      from as [number, number],
      liveSnap.axisGuideEnd,
      liveSnap.kind,
    )
    if (!feat) return null
    return { type: 'FeatureCollection', features: [feat] }
  }, [liveSnap, liveVertices])

  const snapTargetData = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!liveSnap || liveSnap.kind !== 'endpoint' || !liveSnap.targetVertex) return null
    const feat = buildSnapTargetFeature(liveSnap.targetVertex)
    if (!feat) return null
    return { type: 'FeatureCollection', features: [feat] }
  }, [liveSnap])

  // Live-draw wall preview — only when the tool's config has any
  // vertical span (`height > 0` OR `elevation > 0`). Reuses the same
  // `buildLineWallFeature` the committed walls use so the preview
  // renders with identical geometry — just at reduced opacity so the
  // user can see the chain guide + vertex dots on top.
  //
  // Feeds a dedicated fill-extrusion layer so opacity can be
  // constant (no bucketing needed for the preview — there's only
  // ever ONE feature at a time) and the wall paint can dim to make
  // the "preview" state visually obvious.
  const previewWallData = useMemo<GeoJSON.FeatureCollection | null>(() => {
    const verts = liveVertices ?? []
    if (verts.length === 0 || !liveConfig) return null
    const hasSpan = (liveConfig.height ?? 0) > 0 || (liveConfig.elevation ?? 0) > 0
    if (!hasSpan) return null
    const previewCursor = liveSnap?.position ?? liveCursor ?? null
    const chainVerts = previewCursor ? [...verts, previewCursor] : [...verts]
    if (chainVerts.length < 2) return null
    // Build a synthetic LineShape for buildLineWallFeature to consume.
    // `visible: true` + rotation 0 mirror what a fresh commit would
    // produce, so the preview matches what the user will get.
    const fakeShape = {
      name: 'preview',
      vertices: chainVerts as [number, number][],
      rotation: 0,
      config: liveConfig,
      visible: true,
      unit: 'm',
    } as unknown as LineShape
    const wall = buildLineWallFeature(fakeShape, { preview: true })
    if (!wall) return null
    return { type: 'FeatureCollection', features: [wall] }
  }, [liveVertices, liveCursor, liveSnap, liveConfig])

  // Label data — one Point at the configured anchor per line.
  const labelData = useMemo<
    GeoJSON.FeatureCollection<GeoJSON.Point, LineProps> | null
  >(() => {
    const list = lines ?? []
    if (list.length === 0) return null
    const features: GeoJSON.Feature<GeoJSON.Point, LineProps>[] = []
    for (const s of list) {
      if (s.visible === false) continue
      if (!s.config.showLabels || s.config.label.trim() === '') continue
      if (s.vertices.length < 2 || s.id === undefined) continue
      const anchor = lineLabelAnchor(s.vertices, s.config.labelPosition)
      if (!anchor) continue
      features.push({
        type: 'Feature',
        properties: {
          id: `line-label-${s.id}`,
          lineId: s.id,
          color: s.config.color,
          width: s.config.width,
          opacity: s.config.opacity,
          opacityBucket: Math.max(
            0,
            Math.min(100, Math.round((s.config.opacity ?? 100) / 10) * 10),
          ),
          dashCode: 0,
          elevation: s.config.elevation,
          height: s.config.height,
          showLabels: true,
          label: s.config.label,
          labelSize: s.config.labelSize,
          labelColor: s.config.labelColor,
          labelPosition: s.config.labelPosition,
        },
        geometry: { type: 'Point', coordinates: anchor },
      })
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [lines])

  // Focus mode: a faded line's label fades with it (FOCUS_FADE_PROP feeds
  // LABEL_LAYER's `text-opacity`). A line drawn cut away (a split stroke,
  // wall or mesh) fades its label only when the label's anchor lies in the
  // cut region. `labelData` itself while nothing is focused.
  const fadedLabelData = useMemo(() => {
    if (!labelData || !lineFocus) return labelData
    const cut = new Set<number>()
    for (const f of fadedFc.features) {
      if (f.properties.focusPiece && f.properties.lineId !== undefined) cut.add(f.properties.lineId)
    }
    for (const f of fadedWallFc.features) {
      if (f.properties.focusPiece && f.properties.lineId !== undefined) cut.add(f.properties.lineId)
    }
    for (const m of wallMeshes) {
      if (!m.key.endsWith('#cut')) continue
      const id = lineIdOfMeshKey(m.key)
      if (id !== undefined) cut.add(id)
    }
    return stableDerivedCollection(
      labelData,
      patchFeatureCollection(
        labelData,
        (f) => {
          const id = f.properties.lineId
          const factor = lineFocus.factorOf(id)
          if (factor === 1) return null
          if (id !== undefined && cut.has(id)) {
            const region = lineFocus.regionOf(id)
            const [lng, lat] = f.geometry.coordinates
            if (!region || !cutRegionContains(region, lng, lat)) return null
          }
          return String(factor)
        },
        (props, tag) => ({ ...props, [FOCUS_FADE_PROP]: Number(tag) }),
      ),
    )
  }, [labelData, lineFocus, fadedFc, fadedWallFc, wallMeshes])

  // ---- Empty-layer gate --------------------------------------------------
  // Every gate predicate goes through this hold (GatedLayerHold): a layer
  // whose filter stops matching stays visible until its source re-tiles,
  // and shadow casters keep the source-count rule while shadows are on.
  const gateHoldRef = useRef(new GatedLayerHold(LINE_GATED_LAYERS))
  useEffect(() => {
    if (!map) return
    return gateHoldRef.current.attach(map)
  }, [map])

  // ---- Layer setup -------------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const gateHold = gateHoldRef.current
    try {
      if (!map.getSource(LINE_SOURCE)) {
        // `lineMetrics: true` — silences the "line-progress evaluation
        // requires enabling 'lineMetrics'" warning Mapbox emits per
        // tile parse against `line-stroke-layer`. See the matching
        // notes in `map-circle-overlay.tsx` and `map-polygon-overlay.tsx`.
        map.addSource(LINE_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          lineMetrics: true,
        })
        gateHold.resetSource(LINE_SOURCE)
      }
      if (!map.getSource(WALL_SOURCE)) {
        map.addSource(WALL_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
        gateHold.resetSource(WALL_SOURCE)
      }
      if (!map.getSource(WALL_BORDER_SOURCE)) {
        map.addSource(WALL_BORDER_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
        gateHold.resetSource(WALL_BORDER_SOURCE)
      }
      if (!map.getSource(LABEL_SOURCE)) {
        map.addSource(LABEL_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getSource(CHAIN_SOURCE)) {
        map.addSource(CHAIN_SOURCE, {
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
      if (!map.getSource(AXIS_GUIDE_SOURCE)) {
        map.addSource(AXIS_GUIDE_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getSource(SNAP_TARGET_SOURCE)) {
        map.addSource(SNAP_TARGET_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getSource(PREVIEW_WALL_SOURCE)) {
        map.addSource(PREVIEW_WALL_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getSource(LINE_INFLIGHT_SOURCE)) {
        // `lineMetrics: true` mirrors LINE_SOURCE — same paint pipeline.
        map.addSource(LINE_INFLIGHT_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          lineMetrics: true,
        })
      }
      if (!map.getSource(WALL_INFLIGHT_SOURCE)) {
        map.addSource(WALL_INFLIGHT_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }

      // Casing/border underlay. Same source as the main stroke, drawn
      // FIRST so the main stroke paints on top and only the borderWidth
      // px on each side stays visible. Uses solid caps because a dashed
      // casing under a dashed stroke reads as flicker. `line-z-offset`
      // is 2 mm below the main stroke so the two layers don't fight
      // for the same depth pixel at long view distances.
      if (!map.getLayer(LINE_BORDER_LAYER)) {
        map.addLayer({
          id: LINE_BORDER_LAYER,
          type: 'line',
          source: LINE_SOURCE,
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ROOF_HEIGHT,
              0.018,
            ],
          },
          paint: {
            'line-color': ['coalesce', ['get', 'borderColor'], '#000000'],
            // Width = stroke width + 2 × borderWidth on each side, so
            // the casing is invisible when borderWidth == 0. Matches
            // the additive convention polygons/circles use.
            'line-width': [
              '+',
              ['to-number', ['get', 'width']],
              ['*', 2, ['coalesce', ['to-number', ['get', 'borderWidth']], 0]],
            ],
            'line-opacity': ['/', ['to-number', ['get', 'opacity']], 100],
            'line-emissive-strength': 1,
          },
        })
      }

      // Main line stroke. Both `line-dasharray` and `line-cap` are
      // data-driven via `match` on `dashCode` (Mapbox GL JS ≥ 2.3).
      //
      // `line-cap` MUST switch to `butt` for dashed/dotted patterns
      // — a `round` cap adds a half-width-radius semicircle to each
      // dash end which fills small gaps and makes the pattern look
      // solid. The dotted gap is wide enough (3×width) that even
      // with butt caps the dots stay visually distinct.
      if (!map.getLayer(LINE_LAYER)) {
        map.addLayer({
          id: LINE_LAYER,
          type: 'line',
          source: LINE_SOURCE,
          layout: {
            'line-cap': [
              'match',
              ['get', 'dashCode'],
              1, 'butt',
              2, 'butt',
              'round',
            ],
            'line-join': 'round',
            'line-elevation-reference': 'sea',
            // Lift the stroke just above the wall roof so it stays
            // visible on tall 3D walls. Epsilon must be large enough
            // to win WebGL's depth test at long view distances — a
            // sub-mm offset gets quantized away by the depth buffer
            // and the stroke vanishes under the roof. 2 cm matches
            // the grid border treatment.
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ROOF_HEIGHT,
              0.02,
            ],
          },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['to-number', ['get', 'width']],
            'line-opacity': ['/', ['to-number', ['get', 'opacity']], 100],
            'line-emissive-strength': 1,
            'line-dasharray': [
              'match',
              ['get', 'dashCode'],
              1, ['literal', [4, 2]],
              2, ['literal', [1, 3]],
              ['literal', [1, 0]],
            ],
          },
        })
      }

      // Whole-wall tint over selected lines — a low-opacity
      // theme-primary fill-extrusion over the wall footprint at the
      // wall's altitude. Filter is dynamic (`imageId in selectedIds`
      // pattern). Only emits when the line has a wall (elevation > 0
      // OR height > 0); WALL_SOURCE is empty for flat lines, so the
      // layer naturally renders nothing for them.
      if (!map.getLayer(SELECTION_TINT_LAYER)) {
        const tintLayerDef = {
          id: SELECTION_TINT_LAYER,
          type: 'fill-extrusion',
          source: WALL_SOURCE,
          filter: ['==', ['get', 'lineId'], -1],
          paint: {
            'fill-extrusion-color': '#facc15', // theme effect overwrites
            'fill-extrusion-opacity': 0.22,
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
        gateHold.register(map, SELECTION_TINT_LAYER, lineSelectionSentinelPredicate)
      }
      // Selection halo. Sits 0.5 cm above the regular stroke so the
      // outline lands cleanly on top of it without z-fighting.
      // Theme-tinted via the setPaintProperty effect below.
      if (!map.getLayer(SELECTION_LAYER)) {
        map.addLayer({
          id: SELECTION_LAYER,
          type: 'line',
          source: LINE_SOURCE,
          filter: ['==', ['get', 'lineId'], -1],
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ROOF_HEIGHT,
              0.025,
            ],
          },
          paint: {
            'line-color': '#fde047', // theme effect overwrites
            'line-width': ['+', ['to-number', ['get', 'width']], 4],
            'line-opacity': 0.85,
            'line-blur': 0.5,
            'line-emissive-strength': 1,
          },
        })
        gateHold.register(map, SELECTION_LAYER, lineSelectionSentinelPredicate)
      }

      // 3D wall — buffered polygon extruded. Only renders when at least
      // one of elevation / height is > 0 (the wall collection is empty
      // otherwise, so the layers just draw nothing).
      //
      // One fill-extrusion layer per opacity bucket, each with a
      // CONSTANT `fill-extrusion-opacity` — Mapbox 3.x rejects data
      // expressions on that paint property, so we route features by
      // their pre-stamped `opacityBucket` via filter. The `coalesce`
      // default sends preview features (no stamped bucket) to the
      // 100% layer so they never silently disappear.
      for (const bucket of OPACITY_BUCKETS) {
        const layerId = wallLayerId(bucket)
        if (map.getLayer(layerId)) continue
        try {
          map.addLayer({
            id: layerId,
            type: 'fill-extrusion',
            source: WALL_SOURCE,
            filter: [
              '==',
              ['coalesce', ['get', 'opacityBucket'], 100],
              bucket,
            ],
            paint: {
              'fill-extrusion-color': ['get', 'color'],
              'fill-extrusion-base': ['to-number', ['get', 'elevation']],
              // Floor the wall top at `base + 5 cm`. Same rationale as
              // in `map-polygon-overlay.tsx`: a zero-thickness wall
              // (elevation > 0, height = 0) degenerates and flickers.
              // At warehouse scale 5 cm is invisible.
              'fill-extrusion-height': [
                '+',
                ['to-number', ['get', 'elevation']],
                ['max', ['to-number', ['get', 'height']], 0.05],
              ],
              'fill-extrusion-opacity': bucket / 100,
              // Vertical gradient off — see `map-polygon-overlay.tsx`.
              // A 5 cm wall placed on top of an elevated floor plan
              // would otherwise render as a shadow blob at low zoom.
              'fill-extrusion-vertical-gradient': false,
              // The 0% bucket is invisible (incl. leaning walls' hit
              // targets) — it must not cast a box-shaped shadow.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-cast-shadows' as any]: bucket > 0,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-ambient-occlusion-intensity' as any]: 0.35,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-ambient-occlusion-radius' as any]: 2.5,
            },
          })
          gateHold.register(map, layerId, lineWallBucketPredicate(bucket))
        } catch (err) {
          console.warn('[MapLineOverlay] failed to add wall bucket', bucket, err)
        }
      }

      // 3D wall border — traces the roof of the walls so a shape with
      // borderWidth > 0 gets a visible outline (mirrors the polygon/rack
      // border pattern). Sits 1 cm above the wall roof so it doesn't
      // z-fight the fill-extrusion. A stretch ends where the next wall's
      // side takes over, usually at a corner: square caps close that
      // corner (a closed ring has no caps).
      if (!map.getLayer(WALL_BORDER_LAYER)) {
        map.addLayer({
          id: WALL_BORDER_LAYER,
          type: 'line',
          source: WALL_BORDER_SOURCE,
          filter: NOT_MESHED,
          layout: {
            'line-cap': 'square',
            'line-join': 'miter',
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ['coalesce', ['get', 'height'], 0],
              0.01,
            ],
          },
          paint: {
            'line-color': ['coalesce', ['get', 'borderColor'], '#000000'],
            'line-width': ['coalesce', ['to-number', ['get', 'borderWidth']], 0],
            'line-opacity': ['/', ['to-number', ['get', 'opacity']], 100],
            'line-emissive-strength': 1,
          },
        })
        gateHold.register(map, WALL_BORDER_LAYER, lineWallBorderPredicate())
      }

      // Labels — placed at an absolute altitude via `symbol-z-offset`.
      // Keeping `symbol-z-elevate: false` so the offset isn't double-
      // counted on top of an extrusion roof, and flat lines still
      // anchor reliably at ground.
      if (!map.getLayer(LABEL_LAYER)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const layout: any = {
          'text-field': ['coalesce', ['get', 'label'], ''],
          'text-size': ['coalesce', ['get', 'labelSize'], 12],
          'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
          'text-anchor': 'center',
          'text-offset': ['literal', [0, -1.2]],
          'text-allow-overlap': false,
          'symbol-z-elevate': false,
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const paint: any = {
          'text-color': ['coalesce', ['get', 'labelColor'], '#ffffff'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.2,
          'text-emissive-strength': 1,
          // Focus mode: 1 (the default) unless the line is faded.
          'text-opacity': ['coalesce', ['get', FOCUS_FADE_PROP], 1],
          'symbol-z-offset': [
            '+',
            ['coalesce', ['get', 'elevation'], 0],
            ['coalesce', ['get', 'height'], 0],
          ],
        }
        map.addLayer({
          id: LABEL_LAYER,
          type: 'symbol',
          source: LABEL_SOURCE,
          layout,
          paint,
        })
      }

      // Live-draw wall preview — extrudes the chain as a 3D wall using
      // the tool's active config so the user sees the actual solid
      // they're about to place, not just a flat guide. Semi-transparent
      // + amber (or green when snapped) so it reads as "in progress"
      // vs. the committed walls. Constant paint — the preview source
      // holds at most ONE feature so no opacity bucketing is needed.
      if (!map.getLayer(PREVIEW_WALL_LAYER)) {
        map.addLayer({
          id: PREVIEW_WALL_LAYER,
          type: 'fill-extrusion',
          source: PREVIEW_WALL_SOURCE,
          paint: {
            'fill-extrusion-color': '#fbbf24', // amber to match the chain
            'fill-extrusion-base': ['to-number', ['get', 'elevation']],
            'fill-extrusion-height': [
              '+',
              ['to-number', ['get', 'elevation']],
              ['max', ['to-number', ['get', 'height']], 0.05],
            ],
            // 55% opacity — solid enough to read as a wall, translucent
            // enough that the chain vertex dots + amber guide line
            // painted on the roof stay visible.
            'fill-extrusion-opacity': 0.55,
            'fill-extrusion-vertical-gradient': false,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-cast-shadows' as any]: false,
          },
        })
      }
      // In-flight wall + stroke — mirrors the committed WALL_LAYER_op*
      // + LINE_LAYER paint pipeline but reads from a single-feature
      // source so per-frame updates cost O(1) turf.buffer, not O(N).
      // `fill-extrusion-opacity` is a per-layer constant (data
      // expressions are forbidden for that prop), so the drag handler
      // rewrites it via `setPaintProperty` on drag start using the
      // dragging line's config.opacity.
      if (!map.getLayer(WALL_INFLIGHT_LAYER)) {
        map.addLayer({
          id: WALL_INFLIGHT_LAYER,
          type: 'fill-extrusion',
          source: WALL_INFLIGHT_SOURCE,
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-base': ['to-number', ['get', 'elevation']],
            'fill-extrusion-height': [
              '+',
              ['to-number', ['get', 'elevation']],
              ['max', ['to-number', ['get', 'height']], 0.05],
            ],
            'fill-extrusion-opacity': 1,
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
      // 3D wall border outline for the in-flight (transforming) wall —
      // mirrors WALL_BORDER_LAYER on the single-feature source.
      if (!map.getLayer(WALL_INFLIGHT_BORDER_LAYER)) {
        map.addLayer({
          id: WALL_INFLIGHT_BORDER_LAYER,
          type: 'line',
          source: WALL_INFLIGHT_SOURCE,
          layout: {
            'line-cap': 'butt',
            'line-join': 'miter',
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ['coalesce', ['get', 'height'], 0],
              0.01,
            ],
          },
          paint: {
            'line-color': ['coalesce', ['get', 'borderColor'], '#000000'],
            'line-width': ['coalesce', ['to-number', ['get', 'borderWidth']], 0],
            'line-opacity': ['/', ['to-number', ['get', 'opacity']], 100],
            'line-emissive-strength': 1,
          },
        })
      }
      // Casing/border underlay for the in-flight (transforming) line —
      // mirrors LINE_BORDER_LAYER so the border stays consistent while
      // the shape is being moved/rotated.
      if (!map.getLayer(LINE_INFLIGHT_BORDER_LAYER)) {
        map.addLayer({
          id: LINE_INFLIGHT_BORDER_LAYER,
          type: 'line',
          source: LINE_INFLIGHT_SOURCE,
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ROOF_HEIGHT,
              0.018,
            ],
          },
          paint: {
            'line-color': ['coalesce', ['get', 'borderColor'], '#000000'],
            'line-width': [
              '+',
              ['to-number', ['get', 'width']],
              ['*', 2, ['coalesce', ['to-number', ['get', 'borderWidth']], 0]],
            ],
            'line-opacity': ['/', ['to-number', ['get', 'opacity']], 100],
            'line-emissive-strength': 1,
          },
        })
      }
      if (!map.getLayer(LINE_INFLIGHT_LAYER)) {
        map.addLayer({
          id: LINE_INFLIGHT_LAYER,
          type: 'line',
          source: LINE_INFLIGHT_SOURCE,
          layout: {
            'line-cap': [
              'match',
              ['get', 'dashCode'],
              1, 'butt',
              2, 'butt',
              'round',
            ],
            'line-join': 'round',
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ROOF_HEIGHT,
              0.02,
            ],
          },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['to-number', ['get', 'width']],
            'line-opacity': ['/', ['to-number', ['get', 'opacity']], 100],
            'line-emissive-strength': 1,
            'line-dasharray': [
              'match',
              ['get', 'dashCode'],
              1, ['literal', [4, 2]],
              2, ['literal', [1, 3]],
              ['literal', [1, 0]],
            ],
          },
        })
      }
      // Selection tint + halo mirrors for the in-flight source — same
      // paint recipe as the committed SELECTION_*_LAYER but with no
      // per-feature filter (the source only ever holds the transforming
      // line). Renders nothing when the source is empty, so no
      // visibility toggle is needed.
      if (!map.getLayer(SELECTION_TINT_INFLIGHT_LAYER)) {
        const tintInflightDef = {
          id: SELECTION_TINT_INFLIGHT_LAYER,
          type: 'fill-extrusion',
          source: WALL_INFLIGHT_SOURCE,
          paint: {
            'fill-extrusion-color': '#facc15',
            'fill-extrusion-opacity': 0.22,
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
          source: LINE_INFLIGHT_SOURCE,
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ROOF_HEIGHT,
              0.025,
            ],
          },
          paint: {
            'line-color': '#fde047',
            'line-width': ['+', ['to-number', ['get', 'width']], 4],
            'line-opacity': 0.85,
            'line-blur': 0.5,
            'line-emissive-strength': 1,
          },
        })
      }
      // Chain layers for live-draw. Both are lifted to
      // `elevation + height` (roof of the would-be wall) via
      // `line-z-offset` / `symbol-z-offset` so drawing an aisle on
      // top of an elevated floor plan actually TRACKS the plan
      // instead of showing the guide dumped on the ground.
      //
      // Snap-aware paint: when the chain's `snapped` property is 1,
      // the line renders as a SOLID GREEN 3px line so the user gets
      // instant "you're connecting / on-axis" feedback. When 0, it's
      // the original amber dashed guide. Data-driven `case`
      // expressions keep this in one paint update — no
      // remove/re-add cycle when snap flips.
      if (!map.getLayer(CHAIN_LINE_LAYER)) {
        map.addLayer({
          id: CHAIN_LINE_LAYER,
          type: 'line',
          source: CHAIN_SOURCE,
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: {
            'line-color': [
              'case',
              ['==', ['coalesce', ['get', 'snapped'], 0], 1],
              '#22c55e',   // green-500 — snapped (connected / on-axis)
              '#fbbf24',   // amber-400 — free draw
            ],
            'line-width': [
              'case',
              ['==', ['coalesce', ['get', 'snapped'], 0], 1],
              3,
              2,
            ],
            'line-opacity': 0.95,
            'line-emissive-strength': 1,
            'line-dasharray': [
              'case',
              ['==', ['coalesce', ['get', 'snapped'], 0], 1],
              ['literal', [1, 0]], // solid when snapped
              ['literal', [2, 2]], // dashed while free
            ],
          },
          layout: {
            'line-cap': 'round',
            'line-join': 'round',
            'line-elevation-reference': 'sea',
            // Sit on the ROOF of the preview wall (`elevation + height`)
            // + a 2 cm epsilon so the guide isn't clipped by the top
            // face's depth value. Same treatment the committed
            // LINE_LAYER stroke uses to stay visible on tall 3D walls.
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ROOF_HEIGHT,
              0.02,
            ],
          },
        })
      }
      // Vertex dots as a symbol layer — see rationale in the polygon
      // overlay: `circle` has no `circle-z-offset` in Mapbox 3.25,
      // so we render a bullet glyph via symbol which does. The
      // preview (last) vertex flips green when snapped so the
      // "you're locked on" feedback happens on both line + dot.
      if (!map.getLayer(CHAIN_VERTEX_LAYER)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const layout: any = {
          'text-field': '●',
          'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
          'text-size': [
            'case',
            ['==', ['coalesce', ['get', 'snapped'], 0], 1],
            22,
            16,
          ],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'symbol-z-elevate': false,
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const paint: any = {
          'text-color': [
            'case',
            ['==', ['coalesce', ['get', 'snapped'], 0], 1],
            '#22c55e',
            '#fbbf24',
          ],
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
          'text-emissive-strength': 1,
          // Vertex dots also sit on the preview-wall roof so a wall
          // with height > 0 doesn't visually swallow them.
          'symbol-z-offset': [
            '+',
            ['coalesce', ['get', 'elevation'], 0],
            ['coalesce', ['get', 'height'], 0],
            0.03,
          ],
        }
        map.addLayer({
          id: CHAIN_VERTEX_LAYER,
          type: 'symbol',
          source: CHAIN_SOURCE,
          filter: ['==', ['geometry-type'], 'Point'],
          layout,
          paint,
        })
      }
      // Axis guide — long dashed green ray extending along the
      // cardinal axis (in the floor-plan's rotation frame) the cursor
      // has snapped to. Invisible when the guide source is empty.
      if (!map.getLayer(AXIS_GUIDE_LAYER)) {
        map.addLayer({
          id: AXIS_GUIDE_LAYER,
          type: 'line',
          source: AXIS_GUIDE_SOURCE,
          paint: {
            'line-color': '#22c55e',
            'line-width': 1.5,
            'line-opacity': 0.6,
            'line-dasharray': [4, 4],
            'line-emissive-strength': 1,
          },
          layout: {
            'line-cap': 'butt',
            'line-elevation-reference': 'sea',
          },
        })
      }
      // Snap target — a green ring around the endpoint the cursor is
      // snapping to so the user knows "release here to connect".
      // Two circle layers: an outer halo + an inner dot.
      if (!map.getLayer(SNAP_TARGET_HALO_LAYER)) {
        map.addLayer({
          id: SNAP_TARGET_HALO_LAYER,
          type: 'circle',
          source: SNAP_TARGET_SOURCE,
          paint: {
            'circle-radius': 14,
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': '#22c55e',
            'circle-stroke-width': 3,
            'circle-opacity': 0.9,
            'circle-emissive-strength': 1,
          },
        })
      }
      if (!map.getLayer(SNAP_TARGET_LAYER)) {
        map.addLayer({
          id: SNAP_TARGET_LAYER,
          type: 'circle',
          source: SNAP_TARGET_SOURCE,
          paint: {
            'circle-radius': 5,
            'circle-color': '#22c55e',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
            'circle-emissive-strength': 1,
          },
        })
      }

      // Transform handles — theme-tinted symbol layer with canvas
      // icons. Move gets a single centroid handle; rotate gets 4
      // handles at the OBB corners (see transformContext below).
      // Same pattern as map-polygon-overlay.tsx.
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
            // Line rotate has 2 handles (start + end). Base curl
            // rotations chosen so the arrow visually points OUTWARD
            // along the line's canonical axis: start (cornerIndex 0)
            // → 270° (curl NW quadrant, points "away from end"), end
            // (cornerIndex 1) → 90° (curl SE quadrant, points "away
            // from start"). Adding `imageRotation` = line rotation
            // keeps the curls tracking the rotated line.
            'icon-rotate': [
              'match',
              ['get', 'kind'],
              'move', 0,
              'rotate',
              [
                '+',
                [
                  'match',
                  ['get', 'cornerIndex'],
                  0, 270,
                  1, 90,
                  0,
                ],
                ['coalesce', ['to-number', ['get', 'imageRotation']], 0],
              ],
              0,
            ],
            // z-elevate false — same rationale as polygon: with
            // z-elevate true Mapbox stacks the offset on TOP of the
            // extrusion top, giving 2 × (elevation + height).
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
    } catch (err) {
      console.warn('[MapLineOverlay] ensure layers failed', err)
    }

    return () => {
      for (const id of [
        SNAP_TARGET_LAYER,
        SNAP_TARGET_HALO_LAYER,
        AXIS_GUIDE_LAYER,
        TRANSFORM_ICON_LAYER,
        TRANSFORM_LAYER,
        CHAIN_VERTEX_LAYER,
        CHAIN_LINE_LAYER,
        PREVIEW_WALL_LAYER,
        SELECTION_INFLIGHT_LAYER,
        SELECTION_TINT_INFLIGHT_LAYER,
        LINE_INFLIGHT_LAYER,
        LINE_INFLIGHT_BORDER_LAYER,
        WALL_INFLIGHT_LAYER,
        WALL_INFLIGHT_BORDER_LAYER,
        LABEL_LAYER,
        WALL_BORDER_LAYER,
        ...WALL_LAYER_IDS,
        SELECTION_TINT_LAYER,
        SELECTION_LAYER,
        LINE_LAYER,
        LINE_BORDER_LAYER,
      ]) {
        try {
          if (map.getLayer(id)) map.removeLayer(id)
        } catch {
          /* ignore */
        }
      }
      for (const id of [
        LINE_SOURCE,
        WALL_SOURCE,
        WALL_BORDER_SOURCE,
        LABEL_SOURCE,
        CHAIN_SOURCE,
        TRANSFORM_SOURCE,
        AXIS_GUIDE_SOURCE,
        SNAP_TARGET_SOURCE,
        PREVIEW_WALL_SOURCE,
        LINE_INFLIGHT_SOURCE,
        WALL_INFLIGHT_SOURCE,
      ]) {
        try {
          if (map.getSource(id)) map.removeSource(id)
        } catch {
          /* ignore */
        }
      }
    }
    // styleGen forces re-mount on every basemap swap (see note above).
  }, [map, styleLoaded, styleGen])

  // ---- Push committed data -----------------------------------------------
  // Split from live-draw so a mousemove during draw/transform doesn't
  // re-run turf.buffer on every committed wall. One effect per source, fed
  // the focus-faded collections (which ARE `fc` / `wallFc` / `labelData`
  // while nothing is focused): a fade change pushes only the sources whose
  // features it changed, and a style-rule tick no longer re-pushes the
  // unchanged labels.
  // gateHold.push before each gated source's setData: a layer the new
  // data empties (a wall's last bucket mate re-bucketed, or a focus fade
  // moving it to a lower bucket) is held visible until the source
  // re-tiles, so the wall never drops out between them.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const lineSrc = map.getSource(LINE_SOURCE) as GeoJSONSource | undefined
    if (lineSrc) {
      gateHoldRef.current.push(map, LINE_SOURCE, fadedFc)
      lineSrc.setData(fadedFc as GeoJSON.FeatureCollection)
    }
  }, [map, styleLoaded, styleGen, fadedFc])

  useEffect(() => {
    if (!map || !styleLoaded) return
    const wallSrc = map.getSource(WALL_SOURCE) as GeoJSONSource | undefined
    if (wallSrc) {
      gateHoldRef.current.push(map, WALL_SOURCE, fadedWallFc)
      wallSrc.setData(fadedWallFc as GeoJSON.FeatureCollection)
    }
  }, [map, styleLoaded, styleGen, fadedWallFc])

  useEffect(() => {
    if (!map || !styleLoaded) return
    const borderSrc = map.getSource(WALL_BORDER_SOURCE) as GeoJSONSource | undefined
    if (borderSrc) {
      gateHoldRef.current.push(map, WALL_BORDER_SOURCE, fadedWallBorderFc)
      borderSrc.setData(fadedWallBorderFc as GeoJSON.FeatureCollection)
    }
  }, [map, styleLoaded, styleGen, fadedWallBorderFc])

  useEffect(() => {
    if (!map || !styleLoaded) return
    const labelSrc = map.getSource(LABEL_SOURCE) as GeoJSONSource | undefined
    if (labelSrc) {
      labelSrc.setData(
        fadedLabelData ?? { type: 'FeatureCollection', features: [] }
      )
    }
  }, [map, styleLoaded, styleGen, fadedLabelData])

  // ---- Push live-draw data -----------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const chainSrc = map.getSource(CHAIN_SOURCE) as GeoJSONSource | undefined
    if (chainSrc) {
      chainSrc.setData(chainData ?? { type: 'FeatureCollection', features: [] })
    }
    const axisSrc = map.getSource(AXIS_GUIDE_SOURCE) as GeoJSONSource | undefined
    if (axisSrc) {
      axisSrc.setData(axisGuideData ?? { type: 'FeatureCollection', features: [] })
    }
    const snapSrc = map.getSource(SNAP_TARGET_SOURCE) as GeoJSONSource | undefined
    if (snapSrc) {
      snapSrc.setData(snapTargetData ?? { type: 'FeatureCollection', features: [] })
    }
    const previewWallSrc = map.getSource(PREVIEW_WALL_SOURCE) as GeoJSONSource | undefined
    if (previewWallSrc) {
      previewWallSrc.setData(previewWallData ?? { type: 'FeatureCollection', features: [] })
    }
  }, [map, styleLoaded, styleGen, chainData, axisGuideData, snapTargetData, previewWallData])

  // Selection filter — mirrored to the whole-wall tint layer so the
  // wash appears + disappears with the outline in perfect sync. When a
  // transform is active we ALSO exclude the transforming id from the
  // committed selection layers — the SELECTION_INFLIGHT_LAYER +
  // SELECTION_TINT_INFLIGHT_LAYER pick up the highlight on the moving
  // (in-flight) source so the halo tracks the drag at full quality.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const ids = selectedLineIds && selectedLineIds.size > 0
      ? [...selectedLineIds]
      : [-1]
    const excludeId = transformState?.lineId
    const idFilter = ['in', ['get', 'lineId'], ['literal', ids]]
    const filter = excludeId != null
      ? ['all', idFilter, ['!=', ['get', 'lineId'], excludeId]]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : (idFilter as unknown as any)
    // The gate predicates are swapped in the same synchronous pass as the
    // filters, so a new selection's halo shows from the very next frame; a
    // cleared one is held until LINE_SOURCE / WALL_SOURCE re-tile, the
    // moment its halo leaves the screen anyway (GatedLayerHold).
    try {
      if (map.getLayer(SELECTION_LAYER)) {
        map.setFilter(SELECTION_LAYER, filter)
        gateHoldRef.current.register(map, SELECTION_LAYER, lineSelectionPredicate(ids, excludeId))
      }
    } catch { /* ignore */ }
    try {
      if (map.getLayer(SELECTION_TINT_LAYER)) {
        // A leaning wall shows its selection on the mesh instead.
        map.setFilter(SELECTION_TINT_LAYER, ['all', filter, NOT_MESHED])
        gateHoldRef.current.register(map, SELECTION_TINT_LAYER, lineSelectionTintPredicate(ids, excludeId))
      }
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, selectedLineIds, transformState])

  // ---- Exclusion filter (committed base layers) --------------------------
  // While a transform is active, hide the moving line from the committed
  // LINE_LAYER / WALL_LAYER_op* / LABEL_LAYER so it doesn't render twice
  // (once at its stale committed geometry, once on the in-flight source
  // at its live drag position). Cleared when no transform is active.
  // A bucket / border layer the exclusion empties (the moving wall was its
  // only member) is held visible by GatedLayerHold until WALL_SOURCE
  // re-tiles, so the committed copy leaves on the same frame as before.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const excludeId = transformState?.lineId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exclusion: any = excludeId != null
      ? ['!=', ['get', 'lineId'], excludeId]
      : null
    try {
      if (map.getLayer(LINE_LAYER)) map.setFilter(LINE_LAYER, exclusion)
    } catch { /* ignore */ }
    try {
      // Border underlay uses the same source — mirror the exclusion
      // so the transforming line doesn't leave a stale casing behind.
      if (map.getLayer(LINE_BORDER_LAYER)) map.setFilter(LINE_BORDER_LAYER, exclusion)
    } catch { /* ignore */ }
    try {
      // Hide the transforming line's stretches of the roof outline the
      // same way the buckets hide its extrusion.
      if (map.getLayer(WALL_BORDER_LAYER)) {
        map.setFilter(WALL_BORDER_LAYER, exclusion ? ['all', exclusion, NOT_MESHED] : NOT_MESHED)
        gateHoldRef.current.register(map, WALL_BORDER_LAYER, lineWallBorderPredicate(excludeId))
      }
    } catch { /* ignore */ }
    try {
      if (map.getLayer(LABEL_LAYER)) map.setFilter(LABEL_LAYER, exclusion)
    } catch { /* ignore */ }
    for (const bucket of OPACITY_BUCKETS) {
      const layerId = wallLayerId(bucket)
      try {
        if (!map.getLayer(layerId)) continue
        const bucketFilter = ['==', ['coalesce', ['get', 'opacityBucket'], 100], bucket]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const merged: any = excludeId != null
          ? ['all', bucketFilter, ['!=', ['get', 'lineId'], excludeId]]
          : bucketFilter
        map.setFilter(layerId, merged)
        gateHoldRef.current.register(map, layerId, lineWallBucketPredicate(bucket, excludeId))
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, transformState])

  // Visibility toggle.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const vis = committedVisible ? 'visible' : 'none'
    for (const id of [
      LINE_BORDER_LAYER,
      LINE_LAYER,
      ...WALL_LAYER_IDS,
      WALL_BORDER_LAYER,
      SELECTION_TINT_LAYER,
      SELECTION_LAYER,
      LABEL_LAYER,
    ]) {
      try {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis)
      } catch {
        /* ignore */
      }
    }
  }, [map, styleLoaded, styleGen, committedVisible])

  // Push the theme primary hex into every "which line am I picking?"
  // paint prop. Same pattern as polygon overlay. Chain preview + snap
  // indicators + wall preview also retint so the live-draw UX stays
  // palette-coherent.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const trySetPaint = (id: string, prop: string, value: unknown) => {
      try {
        if (map.getLayer(id)) {
          // Mapbox's setPaintProperty type is narrow to a union of all
          // known prop names — cast so the helper accepts any layer's
          // paint prop by string.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map.setPaintProperty(id, prop as any, value)
        }
      } catch { /* ignore */ }
    }
    trySetPaint(SELECTION_LAYER, 'line-color', primaryHex)
    trySetPaint(SELECTION_TINT_LAYER, 'fill-extrusion-color', primaryHex)
    trySetPaint(SELECTION_INFLIGHT_LAYER, 'line-color', primaryHex)
    trySetPaint(SELECTION_TINT_INFLIGHT_LAYER, 'fill-extrusion-color', primaryHex)
    trySetPaint(CHAIN_LINE_LAYER, 'line-color', primaryHex)
    trySetPaint(CHAIN_VERTEX_LAYER, 'text-color', primaryHex)
    trySetPaint(PREVIEW_WALL_LAYER, 'fill-extrusion-color', primaryHex)
  }, [map, styleLoaded, styleGen, primaryHex])

  // Keep selection tint, outline, in-flight surfaces, and transform
  // handle at the top of the layer stack so late-added overlays can't
  // occlude them. Deps include `transformState` so the transform layer
  // re-elevates the moment the user clicks Move / Rotate / Scale —
  // otherwise overlays that mounted AFTER us in the tree occlude the
  // handle and the user sees nothing to grab. `transformState` doesn't
  // churn during drag (the RAF bypass keeps it stable), so per-frame
  // cost is nil.
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const id of [
      WALL_INFLIGHT_LAYER,
      WALL_INFLIGHT_BORDER_LAYER,
      // Border BEFORE the stroke so the casing stays underneath the
      // main line. Reversing order here would cover the stroke.
      LINE_INFLIGHT_BORDER_LAYER,
      LINE_INFLIGHT_LAYER,
      SELECTION_TINT_LAYER,
      SELECTION_LAYER,
      SELECTION_TINT_INFLIGHT_LAYER,
      SELECTION_INFLIGHT_LAYER,
      TRANSFORM_LAYER,
    ]) {
      try {
        if (map.getLayer(id)) map.moveLayer(id)
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, transformState])

  // ---- Click handling ----------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded || !selectionEnabled) return
    const onLayerClick = (
      e: MapMouseEvent & { features?: GeoJSON.Feature[] }
    ) => {
      if (e.originalEvent?.defaultPrevented) return
      // Defer to higher-priority kinds (model, text) when also at this
      // point. See lib/overlay-hit-priority.
      if (higherPriorityAt(map, e.point, 'line')) return
      const feat = e.features?.[0]
      if (!feat) return
      const id = feat.properties?.lineId
      if (typeof id === 'number') {
        e.preventDefault()
        // Flag the DOM event so lower-priority overlays (image, grid,
        // polygon, circle) see the click was consumed.
        e.originalEvent?.preventDefault?.()
        onLineClick?.(id, e.originalEvent)
      }
    }
    const onMapClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      if (higherPriorityAt(map, e.point, 'line')) return
      const layers = [LINE_LAYER, ...WALL_LAYER_IDS].filter((l) => map.getLayer(l))
      if (layers.length === 0) return
      const hits = map.queryRenderedFeatures(e.point, { layers })
      if (hits.length === 0) onMapClickEmpty?.()
    }
    const onEnter = () => {
      map.getCanvas().style.cursor = 'pointer'
    }
    const onLeave = () => {
      map.getCanvas().style.cursor = ''
    }
    map.on('click', LINE_LAYER, onLayerClick)
    map.on('mouseenter', LINE_LAYER, onEnter)
    map.on('mouseleave', LINE_LAYER, onLeave)
    for (const id of WALL_LAYER_IDS) {
      map.on('click', id, onLayerClick)
      map.on('mouseenter', id, onEnter)
      map.on('mouseleave', id, onLeave)
    }
    map.on('click', onMapClick)
    return () => {
      map.off('click', LINE_LAYER, onLayerClick)
      map.off('mouseenter', LINE_LAYER, onEnter)
      map.off('mouseleave', LINE_LAYER, onLeave)
      for (const id of WALL_LAYER_IDS) {
        map.off('click', id, onLayerClick)
        map.off('mouseenter', id, onEnter)
        map.off('mouseleave', id, onLeave)
      }
      map.off('click', onMapClick)
    }
  }, [map, styleLoaded, styleGen, selectionEnabled, onLineClick, onMapClickEmpty])

  // ---- Transform handle --------------------------------------------------
  const transformChangeRef = useRef(onTransformChange)
  useEffect(() => {
    transformChangeRef.current = onTransformChange
  }, [onTransformChange])

  // Mirror `attachedDoorsByLineId` into a ref so the drag handler can
  // rebuild the in-flight wall with door openings punched at the RIGHT
  // door footprints without the handler re-mounting on prop identity
  // change. See docs/pitfalls-frontend.md — attachedDoors is a
  // stable Map whose entries change rarely; deps on the prop would
  // otherwise tear down the mousedown/mousemove bindings mid-drag.
  const attachedDoorsRef = useRef(attachedDoorsByLineId)
  useEffect(() => {
    attachedDoorsRef.current = attachedDoorsByLineId
  }, [attachedDoorsByLineId])

  const transformContextRef = useRef<{
    line: LineShape
    anchor: [number, number]
    center: [number, number]
    rotateCorners: [number, number][] | null
  } | null>(null)

  // Move → single handle at centroid.
  // Rotate → TWO handles at the line's endpoints (verts[0] and
  //   verts[last]), rotated by ln.rotation via turf. A simple wall
  //   only needs a lever at each end — the 4-corner bbox pattern
  //   we use for the whole-shape polygon/image looks oversized on
  //   a thin line and produces a bounding rectangle disconnected
  //   from the wall itself. Two endpoint handles read as "grab
  //   either end and swing".
  const transformContext = useMemo(() => {
    if (!transformState || !lines) return null
    const ln = lines.find((x) => x.id === transformState.lineId)
    if (!ln) return null
    const center = lineCentroid(ln.vertices)
    if (!center) return null
    let anchor: [number, number] = center
    let rotateCorners: [number, number][] | null = null
    if (transformState.kind === 'rotate' && ln.vertices.length >= 2) {
      const startLocal = ln.vertices[0]
      const endLocal = ln.vertices[ln.vertices.length - 1]
      rotateCorners = [
        rotatePointAround(startLocal, center, ln.rotation),
        rotatePointAround(endLocal, center, ln.rotation),
      ]
      anchor = rotateCorners[0]
    }
    return { line: ln, anchor, center, rotateCorners }
  }, [transformState, lines])

  useEffect(() => {
    transformContextRef.current = transformContext
  }, [transformContext])

  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    if (!transformContext || !transformState) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    const ln = transformContext.line
    const elev = ln.config.elevation ?? 0
    const hgt = ln.config.height ?? 0
    const features: GeoJSON.Feature<GeoJSON.Point>[] = []
    if (transformState.kind === 'rotate' && transformContext.rotateCorners) {
      for (let i = 0; i < transformContext.rotateCorners.length; i++) {
        features.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: transformContext.rotateCorners[i],
          },
          properties: {
            kind: 'rotate',
            iconId: TRANSFORM_ICON.rotate,
            cornerIndex: i,
            imageRotation: ln.rotation ?? 0,
            elevation: elev,
            height: hgt,
          },
        })
      }
    } else {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: transformContext.anchor },
        properties: {
          kind: transformState.kind,
          iconId: TRANSFORM_ICON[transformState.kind as 'move' | 'rotate'],
          cornerIndex: -1,
          imageRotation: ln.rotation ?? 0,
          elevation: elev,
          height: hgt,
        },
      })
    }
    src.setData({ type: 'FeatureCollection', features })
  }, [map, styleLoaded, styleGen, transformContext, transformState])

  // ---- In-flight source population ---------------------------------------
  // When a transform starts, immediately push the target line's features
  // into LINE_INFLIGHT + WALL_INFLIGHT so the moving line is visible from
  // the moment the transform state flips (before the user drags). Also
  // pins the WALL_INFLIGHT_LAYER opacity to the line's config value — the
  // paint prop is per-layer constant, so we rewrite it on activation.
  // On transform end (transformState → null), empties the sources so no
  // ghost feature stays after the committed source rebuilds.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const lineSrc = map.getSource(LINE_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    const wallSrc = map.getSource(WALL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
    if (!transformState || !transformContext) {
      lineSrc?.setData(emptyFC)
      wallSrc?.setData(emptyFC)
      return
    }
    const ln = transformContext.line
    const lineFeat = buildLineFeature(ln)
    const attached = ln.id !== undefined
      ? attachedDoorsRef.current?.get(ln.id) ?? undefined
      : undefined
    const wallFeat = buildLineWallFeature(ln, { attachedDoors: attached })
    lineSrc?.setData(
      lineFeat
        ? { type: 'FeatureCollection', features: [lineFeat] }
        : emptyFC,
    )
    wallSrc?.setData(
      wallFeat
        ? { type: 'FeatureCollection', features: [wallFeat] }
        : emptyFC,
    )
    try {
      const op = Math.max(0, Math.min(1, (ln.config.opacity ?? 100) / 100))
      map.setPaintProperty(WALL_INFLIGHT_LAYER, 'fill-extrusion-opacity', op)
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, transformState, transformContext])

  const dragRef = useRef<{
    dragging: boolean
    kind: 'move' | 'rotate' | null
    originalLine: LineShape | null
    originalCenter: [number, number] | null
    originalAnchor: [number, number] | null
    originalRotation: number
    downHandleAngle: number
    // RAF-coalescing state — the mousemove handler writes here without
    // scheduling work; a single requestAnimationFrame reads and flushes.
    pendingCursor: [number, number] | null
    rafId: number
  } | null>(null)

  useEffect(() => {
    if (!map || !styleLoaded || !transformState) return

    if (!dragRef.current) {
      dragRef.current = {
        dragging: false,
        kind: null,
        originalLine: null,
        originalCenter: null,
        originalAnchor: null,
        originalRotation: 0,
        downHandleAngle: 0,
        pendingCursor: null,
        rafId: 0,
      }
    }
    const drag = dragRef.current
    const canvas = map.getCanvas()

    // Compute (patchedVertices, patchedRotation) for the current cursor.
    // Returns `null` when the drag state is incomplete (drag hasn't
    // started yet or the ref was cleared mid-flight).
    const computePatch = (
      cursor: [number, number],
    ): { vertices?: [number, number][]; rotation?: number } | null => {
      const orig = drag.originalLine
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
      const dLng = cursor[0] - drag.originalAnchor[0]
      const dLat = cursor[1] - drag.originalAnchor[1]
      const moved = orig.vertices.map(
        ([lng, lat]) => [lng + dLng, lat + dLat] as [number, number],
      )
      return { vertices: moved }
    }

    // Build the synthetic shape for the current patch + shove its
    // features into the in-flight sources plus the transform handle
    // source. Never touches React state. Cost: 1 × buildLineFeature +
    // 1 × buildLineWallFeature + 3 × setData per RAF tick.
    const pushInflight = (
      patch: { vertices?: [number, number][]; rotation?: number },
    ) => {
      const orig = drag.originalLine
      if (!orig) return
      const patched: LineShape = { ...orig, ...patch }
      const lineFeat = buildLineFeature(patched)
      const attached = orig.id !== undefined
        ? attachedDoorsRef.current?.get(orig.id) ?? undefined
        : undefined
      const wallFeat = buildLineWallFeature(patched, { attachedDoors: attached })
      const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
      const lineSrc = map.getSource(LINE_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      const wallSrc = map.getSource(WALL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      lineSrc?.setData(
        lineFeat
          ? { type: 'FeatureCollection', features: [lineFeat] }
          : emptyFC,
      )
      wallSrc?.setData(
        wallFeat
          ? { type: 'FeatureCollection', features: [wallFeat] }
          : emptyFC,
      )
      // Follow the moving line with the transform handles so users
      // can grab them again mid-drag if they release + regrab.
      const transformSrc = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
      if (transformSrc) {
        const center = lineCentroid(patched.vertices)
        const elev = patched.config.elevation ?? 0
        const hgt = patched.config.height ?? 0
        const features: GeoJSON.Feature<GeoJSON.Point>[] = []
        if (center) {
          if (drag.kind === 'rotate' && patched.vertices.length >= 2) {
            const startLocal = patched.vertices[0]
            const endLocal = patched.vertices[patched.vertices.length - 1]
            const rotated: [number, number][] = [
              rotatePointAround(startLocal, center, patched.rotation),
              rotatePointAround(endLocal, center, patched.rotation),
            ]
            for (let i = 0; i < rotated.length; i++) {
              features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: rotated[i] },
                properties: {
                  kind: 'rotate',
                  iconId: TRANSFORM_ICON.rotate,
                  cornerIndex: i,
                  imageRotation: patched.rotation ?? 0,
                  elevation: elev,
                  height: hgt,
                },
              })
            }
          } else if (drag.kind === 'move') {
            features.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: center },
              properties: {
                kind: 'move',
                iconId: TRANSFORM_ICON.move,
                cornerIndex: -1,
                imageRotation: patched.rotation ?? 0,
                elevation: elev,
                height: hgt,
              },
            })
          }
        }
        transformSrc.setData({ type: 'FeatureCollection', features })
      }
    }

    // The RAF flusher — reads the latest pointer position from the ref,
    // computes the patch, and pushes to in-flight sources. Runs at most
    // once per paint frame regardless of how many mousemove events
    // Mapbox fires between paints.
    const flushDragFrame = () => {
      drag.rafId = 0
      if (!drag.dragging || !drag.pendingCursor) return
      const cursor = drag.pendingCursor
      const patch = computePatch(cursor)
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
      drag.originalLine = ctx.line
      drag.originalCenter = ctx.center
      drag.originalRotation = ctx.line.rotation
      const rawIdx = hits[0]?.properties?.cornerIndex
      const clickedIdx =
        typeof rawIdx === 'number' && rawIdx >= 0 && rawIdx <= 3 ? rawIdx : -1
      if (
        transformState.kind === 'rotate' &&
        clickedIdx >= 0 &&
        ctx.rotateCorners
      ) {
        drag.originalAnchor = ctx.rotateCorners[clickedIdx]
      } else {
        drag.originalAnchor = ctx.anchor
      }
      drag.downHandleAngle = Math.atan2(
        drag.originalAnchor[1] - ctx.center[1],
        drag.originalAnchor[0] - ctx.center[0],
      )
      map.dragPan.disable()
      canvas.style.cursor =
        transformState.kind === 'rotate' ? 'crosshair' : 'grabbing'
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
      // Cancel any pending RAF; we're about to commit the final patch
      // and the parent will unset transformState → in-flight population
      // effect will empty the sources for us.
      if (drag.rafId !== 0) {
        cancelAnimationFrame(drag.rafId)
        drag.rafId = 0
      }
      drag.pendingCursor = null
      const patch = computePatch(cursor)
      // Clear original state BEFORE calling into the parent — the
      // commit unsets transformState which re-runs the effect chain;
      // stale refs would otherwise confuse the next drag.
      drag.originalLine = null
      drag.originalCenter = null
      drag.originalAnchor = null
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

  // The live-draw measurement readout (segment, total, angle, typed
  // length) is drawn by `MapMeasureOverlay` for every vertex tool.
  return null
}
