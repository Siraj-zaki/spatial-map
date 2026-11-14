/**
 * Stair rendering. Single `geojson` source + one `fill-extrusion` layer
 * driving `fill-extrusion-base` / `fill-extrusion-height` per feature
 * via `['get', …]`, exactly the pattern Mapbox uses in its 3D indoor
 * floorplan example. One stair = N polygon features (one per step) so
 * the whole staircase repaints from a single setData call when the
 * draft changes — no layer churn on every slider move.
 */

import type { Feature, FeatureCollection, Point, Polygon } from 'geojson'
import type {
  ExpressionSpecification,
  FillExtrusionLayerSpecification,
  GeoJSONSource,
  Map as MapboxMapInstance,
  MapMouseEvent,
} from 'mapbox-gl'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LiftMeshLayer, type LiftMeshData } from '@/lib/lift-mesh-layer'
import {
  buildStairFeatures,
  liftIconFeatures,
  stairMeshes,
  stairToFeatureCollection,
  type LiftIconProps,
  type StairFeatureProps,
} from '@/lib/stair-generators'
import { registerLiftIcons } from '@/lib/lift-icons'
import { useGraphicsSettings } from '@/lib/graphics-settings'
import { resolveLiftLevels } from '@/lib/vertical-transport-generators'
import { higherPriorityAt } from '@/lib/overlay-hit-priority'
import {
  TRANSFORM_ICON,
  readThemePrimaryForegroundHex,
  readThemePrimaryHex,
  registerTransformHandleIcons,
  subscribeThemeChanges,
} from '@/lib/map-transform-handles'
import { isLiftType, type StairShape } from '@/lib/shapes'
import type { LayerFeaturePredicate } from '@/lib/empty-layer-gate'
import { hasMapLayer, rootLayerOrder } from '@/lib/data-link/dl-layer-stack'
import { fadeMeshData, patchFeatureCollection } from '@/lib/focus/focus-fade'
import {
  FOCUS_FACTOR,
  blockerIdsOf,
  focusTier,
  useFocusBlockers,
  useFocusScene,
  type FocusTier,
} from '@/lib/focus/focus-scene'
import { GatedLayerHold, stableDerivedCollection, type GatedLayerSpec } from '@/components/map-line-overlay'

interface MapStairOverlayProps {
  map: MapboxMapInstance | null
  stairs?: ReadonlyArray<StairShape>
  /**
   * In-progress draw preview. `vertices` carries the anchors the user
   * has placed so far plus the cursor as the trailing element, so the
   * preview always has at least 2 vertices and adapts to whatever
   * `config.stairType` expects (straight/U need 2; L needs 3 once the
   * corner is placed). `null` when no draw is active or no anchor is
   * placed yet.
   */
  livePreview?: {
    vertices: [number, number][]
    config: StairShape['config']
  } | null
  selectedStairIds?: ReadonlySet<number>
  onStairClick?: (id: number, originalEvent: MouseEvent) => void
  onMapClickEmpty?: () => void
  committedVisible?: boolean
  selectionEnabled?: boolean
  transformState?: { stairId: number; kind: 'move' | 'rotate' } | null
  onTransformChange?: (
    patch: { vertices?: [number, number][]; rotation?: number },
    commit: boolean,
  ) => void
  onTransformEnd?: () => void
  /**
   * Floor-plan elevations (ImageShape id → metres). Lifts linked to
   * floors take their heights from here, so they keep meeting their
   * floors when a floor plan's elevation changes.
   */
  floorElevations?: ReadonlyMap<number, number>
}

const STEP_SOURCE = 'stair-step-source'
const STEP_LAYER = 'stair-step-layer'
// Focus mode (src/lib/focus) tier twins of STEP_LAYER. `fill-extrusion-
// opacity` is a per-layer constant and STEP_LAYER has no opacity buckets,
// so a faded stair's solid parts are stamped `focusTier: 'near' | 'ghost'`
// and drawn by these instead (STEP_LAYER skips any stamped feature). Same
// spec at FOCUS_FACTOR's opacity, shadows off. Nothing is stamped while
// nothing is focused, so the gate keeps both hidden. overlay-hit-priority
// maps both ids to 'stair' (a faded stair keeps its clicks over areas);
// this overlay's own HIT_LAYERS has them too.
const STEP_NEAR_LAYER = 'stair-step-near-layer'
const STEP_GHOST_LAYER = 'stair-step-ghost-layer'
const STEP_BORDER_LAYER = 'stair-step-border-layer'
const SELECTION_LAYER = 'stair-selection-layer'
const PREVIEW_SOURCE = 'stair-preview-source'
const PREVIEW_LAYER = 'stair-preview-layer'
const TRANSFORM_SOURCE = 'stair-transform-source'
const TRANSFORM_LAYER = 'stair-transform-layer'
const INFLIGHT_SOURCE = 'stair-inflight-source'
const INFLIGHT_LAYER = 'stair-inflight-layer'
const INFLIGHT_BORDER_LAYER = 'stair-inflight-border-layer'
// Lift glass (elevator shafts, escalator balustrades) — translucent, so
// it gets its own layer; the solid layers above filter it out.
const GLASS_LAYER = 'stair-glass-layer'
// Wayfinding icons at every escalator end and elevator stop.
const ICON_SOURCE = 'stair-lift-icon-source'
const ICON_LAYER = 'stair-lift-icon-layer'
// Moving escalator treads (only for escalators with `animated`).
const MOTION_SOURCE = 'stair-motion-source'
const MOTION_LAYER = 'stair-motion-layer'
const MOTION_BORDER_LAYER = 'stair-motion-border-layer'
const GLASS_OPACITY = 0.42
/** Nominal tread travel per second, in treads (≈ 0.5 m/s on a 0.4 m step). */
const TREADS_PER_SECOND = 1.25
/** Motion frame budget — the treads don't need 60 fps. */
const MOTION_FRAME_MS = 50

// Built stairs and lifts (treads, soffits, railings, trusses, glass,
// shafts) — custom mesh layers, since extrusions can only be vertical boxes.
const MESH_LAYER = 'stair-lift-mesh-layer'
const GLASS_MESH_LAYER = 'stair-lift-glass-mesh-layer'
// Focus mode: solid meshes of faded stairs, alpha × FOCUS_FACTOR. Solid
// shading, no depth write (a faded solid must not hide what's behind it).
// Inserted before GLASS_MESH_LAYER so lift glass stays the last pane drawn.
// Empty, and never written, until something is focused.
const FADED_MESH_LAYER = 'stair-mesh-faded-layer'
const NO_MESHES: LiftMeshData[] = []

/** Stair id of a mesh (`${stairId}:solid` / `${stairId}:glass`, stairMeshes keys). */
function meshStairId(key: string): number | undefined {
  const i = key.indexOf(':')
  const id = i > 0 ? Number(key.slice(0, i)) : NaN
  return Number.isFinite(id) ? id : undefined
}

/** Meshes per stair row, rebuilt only when the row or floor heights change. */
const meshCache = new WeakMap<StairShape, { fe: ReadonlyMap<number, number> | undefined; meshes: ReturnType<typeof stairMeshes> }>()
function cachedStairMeshes(s: StairShape, fe: ReadonlyMap<number, number> | undefined) {
  const hit = meshCache.get(s)
  if (hit && hit.fe === fe) return hit.meshes
  const meshes = stairMeshes(s, fe)
  meshCache.set(s, { fe, meshes })
  return meshes
}

// Invisible click targets: elevators and built stairs are drawn as
// meshes, which queryRenderedFeatures can't see, so zero-opacity
// extrusions (the elevator prism, a stair's step boxes) are what clicks
// and hovers land on.
const HIT_FILL_LAYER = 'stair-lift-hit-layer'

/** Layers a click or hover can land on (a faded escalator's steps are on the tier layers). */
const HIT_LAYERS = [STEP_LAYER, STEP_NEAR_LAYER, STEP_GHOST_LAYER, GLASS_LAYER, MOTION_LAYER, ICON_LAYER, HIT_FILL_LAYER]

const IS_HIT = ['==', ['get', 'hit'], true]
const NOT_HIT = ['!=', ['get', 'hit'], true]
const IS_GLASS = ['all', ['==', ['get', 'glass'], true], NOT_HIT]
const NOT_GLASS = ['all', ['!=', ['get', 'glass'], true], NOT_HIT]
const NO_SHAPE_FILTER = ['!=', ['get', 'shapeId'], -1]

/** A focus tier that moves a stair's solid parts to a tier layer. */
type StepTier = 'near' | 'ghost'
const FOCUS_TIER_PROP = 'focusTier'
// Focus mode: the fade factor of a faded stair, on every feature of it, so
// STEP_BORDER_LAYER's outlines fade with the steps. Absent = 1.
const FOCUS_FADE_PROP = 'focusFade'
/** STEP_BORDER_LAYER's `line-opacity` as installed, and whenever no stair is faded. */
const STEP_BORDER_OPACITY = 0.9
/**
 * STEP_BORDER_LAYER's `line-opacity` while at least one stair is faded:
 * 0.9 × the stair's `focusFade` (absent = 1). Swapped in only then, so
 * with focus off the layer keeps the constant it had before focus mode.
 */
const STEP_BORDER_OPACITY_FADED: ExpressionSpecification = ['*', STEP_BORDER_OPACITY, ['coalesce', ['get', FOCUS_FADE_PROP], 1]]
/** STEP_LAYER's tier clause: no tier stamped. */
const NO_TIER = ['!', ['has', FOCUS_TIER_PROP]]
const tierIs = (tier: StepTier) => ['==', ['get', FOCUS_TIER_PROP], tier]
const STEP_TIER_LAYERS: ReadonlyArray<readonly [string, StepTier]> = [
  [STEP_NEAR_LAYER, 'near'],
  [STEP_GHOST_LAYER, 'ghost'],
]
/** A faded stair's tier, or null (focus / normal: drawn as before). */
function stepTierOf(tier: FocusTier): StepTier | null {
  return tier === 'near' || tier === 'ghost' ? tier : null
}

/** Step features as this overlay pushes them (focus stamps included). */
type StepProps = StairFeatureProps & { focusTier?: StepTier; focusFade?: number }

// ---- Empty-layer gate predicates (lib/empty-layer-gate.ts) ----------------
// JS transcriptions of the filters above, so the gate can hide a layer whose
// filter passes nothing. On most facilities that is every one of the solid /
// glass split layers: stairs and elevators are drawn as meshes, and their
// extruded features all carry `hit: true` (invisible click targets), which
// NOT_GLASS and IS_GLASS both exclude; only escalators emit non-hit parts
// (comb plates + static treads), and no generator stamps `glass: true` any
// more (lift glass is mesh). Registered right after every `addLayer` /
// `setFilter` of the layer, with the same inputs. Mapbox `get` reads a
// missing property as null and `==` / `!=` / `in` are strict, so `?.` +
// `===` match it value for value.
type StairSplit = 'solid' | 'glass' | 'hit'
type GateProps = Parameters<LayerFeaturePredicate>[0]['properties']
const SPLIT_TESTS: Record<StairSplit, (p: GateProps) => boolean> = {
  // NOT_GLASS: ['all', ['!=', ['get', 'glass'], true], NOT_HIT]
  solid: (p) => p?.glass !== true && p?.hit !== true,
  // IS_GLASS: ['all', ['==', ['get', 'glass'], true], NOT_HIT]
  glass: (p) => p?.glass === true && p?.hit !== true,
  // IS_HIT: ['==', ['get', 'hit'], true]
  hit: (p) => p?.hit === true,
}

/**
 * The exclusion effect's `shapeFilter`: `['!=', ['get', 'shapeId'], excludeId]`
 * while a transform is active, else NO_SHAPE_FILTER (`!= -1`).
 */
export function stairShapeFilterPredicate(excludeId: number | null | undefined): LayerFeaturePredicate {
  const blocked = excludeId != null ? excludeId : -1
  return (f) => f.properties?.shapeId !== blocked
}

/**
 * STEP_LAYER (`'solid'`, NOT_GLASS), GLASS_LAYER (IS_GLASS) or HIT_FILL_LAYER
 * (IS_HIT). Without `shapeFilter` it mirrors the addLayer filter; with it,
 * the exclusion effect's `['all', <split>, shapeFilter]`.
 */
export function stairSplitPredicate(split: StairSplit, shapeFilter?: LayerFeaturePredicate): LayerFeaturePredicate {
  const test = SPLIT_TESTS[split]
  return shapeFilter ? (f) => test(f.properties) && shapeFilter(f) : (f) => test(f.properties)
}

/**
 * STEP_LAYER (`tier` null: `['all', NOT_GLASS, ['!', ['has', 'focusTier']]]`)
 * or a focus tier layer (`['all', NOT_GLASS, ['==', ['get', 'focusTier'], tier]]`);
 * with `shapeFilter`, the exclusion effect's `['all', …, shapeFilter]`.
 * `has` is true for a present-but-null property, so the STEP_LAYER mirror
 * (`== null`) is a superset there, never a subset.
 */
export function stairStepPredicate(tier: StepTier | null, shapeFilter?: LayerFeaturePredicate): LayerFeaturePredicate {
  const solid = SPLIT_TESTS.solid
  const tierTest: (p: GateProps) => boolean =
    tier === null ? (p) => p?.[FOCUS_TIER_PROP] == null : (p) => p?.[FOCUS_TIER_PROP] === tier
  return shapeFilter
    ? (f) => solid(f.properties) && tierTest(f.properties) && shapeFilter(f)
    : (f) => solid(f.properties) && tierTest(f.properties)
}

/**
 * SELECTION_LAYER as the selection effect filters it: `== -1` with nothing
 * selected, `== id` for one, `in [ids]` for several (also its addLayer
 * filter when `ids` is empty).
 */
export function stairSelectionPredicate(ids: ReadonlyArray<number>): LayerFeaturePredicate {
  if (ids.length === 0) return (f) => f.properties?.shapeId === -1
  if (ids.length === 1) {
    const only = ids[0]
    return (f) => f.properties?.shapeId === only
  }
  const selected = new Set<unknown>(ids)
  return (f) => selected.has(f.properties?.shapeId)
}

/**
 * The layers gated through GatedLayerHold (map-line-overlay.tsx), which
 * holds an emptied layer until STEP_SOURCE re-tiles and keeps the shadow
 * casters on the source-count rule while shadows are on. `castsShadows`
 * mirrors each layer's paint: STEP_LAYER sets it, HIT_FILL_LAYER leaves the
 * spec default (true), GLASS_LAYER and the focus tier layers turn it off,
 * SELECTION_LAYER is a line. The tier layers are therefore never pinned
 * for shadows: hidden while nothing is focused, shown the moment a stamp
 * lands (and STEP_LAYER held until STEP_SOURCE re-tiles), hidden late on exit.
 */
const STAIR_GATED_LAYERS: ReadonlyMap<string, GatedLayerSpec> = new Map<string, GatedLayerSpec>([
  [STEP_LAYER, { sourceId: STEP_SOURCE, castsShadows: true }],
  [STEP_NEAR_LAYER, { sourceId: STEP_SOURCE, castsShadows: false }],
  [STEP_GHOST_LAYER, { sourceId: STEP_SOURCE, castsShadows: false }],
  [GLASS_LAYER, { sourceId: STEP_SOURCE, castsShadows: false }],
  [HIT_FILL_LAYER, { sourceId: STEP_SOURCE, castsShadows: true }],
  [SELECTION_LAYER, { sourceId: STEP_SOURCE, castsShadows: false }],
])

const EMPTY_FC: FeatureCollection<Polygon, StairFeatureProps> = {
  type: 'FeatureCollection',
  features: [],
}

/** STEP_LAYER's paint at `opacity` — the focus tier twins use it with shadows off. */
function stepPaint(opacity: number, castShadows: boolean): FillExtrusionLayerSpecification['paint'] {
  return {
    'fill-extrusion-color': ['get', 'color'],
    'fill-extrusion-base': ['to-number', ['get', 'base_height']],
    'fill-extrusion-height': ['to-number', ['get', 'height']],
    'fill-extrusion-opacity': opacity,
    'fill-extrusion-vertical-gradient': true,
    'fill-extrusion-cast-shadows': castShadows,
    'fill-extrusion-ambient-occlusion-intensity': 0.35,
    'fill-extrusion-ambient-occlusion-radius': 2.5,
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Midpoint of a stair's run (mean of first two vertices). */
function stairMidpoint(vertices: [number, number][]): [number, number] | null {
  if (vertices.length < 2) return null
  return [
    (vertices[0][0] + vertices[1][0]) / 2,
    (vertices[0][1] + vertices[1][1]) / 2,
  ]
}

/** Rotate a point around a pivot by `deg` degrees. */
function rotatePoint(
  pt: [number, number],
  pivot: [number, number],
  deg: number,
): [number, number] {
  if (Math.abs(deg) < 1e-9) return pt
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = pt[0] - pivot[0]
  const dy = pt[1] - pivot[1]
  return [pivot[0] + dx * cos - dy * sin, pivot[1] + dx * sin + dy * cos]
}

export function MapStairOverlay({
  map,
  stairs,
  livePreview,
  selectedStairIds,
  onStairClick,
  onMapClickEmpty,
  committedVisible = true,
  selectionEnabled = true,
  transformState,
  onTransformChange,
  onTransformEnd,
  floorElevations,
}: MapStairOverlayProps) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  // `styleGen` bumps on every style.load — see matching note in
  // `map-polygon-overlay.tsx`. Source/layer effect deps include it so
  // basemap swaps trigger a fresh setup pass.
  const [styleGen, setStyleGen] = useState(0)

  // ---- Style readiness ---------------------------------------------------
  // Two layers of detection, mirroring MapPolygonOverlay because this is
  // the only pattern that survives the race where the map's `load` and
  // `style.load` events fire BEFORE this effect mounts its listeners:
  //   1) Check `map.isStyleLoaded()` synchronously — covers late-mount.
  //   2) Listen for 'style.load' / 'load' — covers future style switches.
  //   3) Poll every 100 ms — covers the case where the events already
  //      fired AND `isStyleLoaded()` was false at mount time but flips
  //      true shortly afterwards (Mapbox's load progression isn't
  //      single-event; sprites / sources resolve in stages).
  // Without (3), the source/layer effect stays gated on `styleLoaded:
  // false` forever and nothing ever paints.
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

  // ---- Theme icons -------------------------------------------------------
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
    registerLiftIcons(map, primaryHex, primaryFgHex)
  }, [map, styleLoaded, styleGen, primaryHex, primaryFgHex])

  // Escalators whose treads move. Respect the OS "reduce motion" setting
  // and never animate an out-of-service unit.
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  // ---- Focus mode (src/lib/focus) ----------------------------------------
  // While an item is focused, only two kinds of stair / lift fade: the ones
  // between the camera and the item (blockers, tier 'ghost') and the ones
  // right next to it (the NEAR column, tier 'near'). The focused stair
  // itself is tier 'focus' and every other one 'normal' — both drawn
  // exactly as before. Solid step parts of a faded stair move to the tier
  // layers (stamped `focusTier`), meshes to FADED_MESH_LAYER (alpha ×
  // factor), and every feature of it carries `focusFade` for the outlines.
  // Glass and the HIT_FILL click prisms keep their layers. Lift icons are
  // left as they are. With nothing focused `stairTierOf` is null and every
  // memo below hands back its input, so no push re-runs.
  const focusScene = useFocusScene()
  const focusBlockers = useFocusBlockers()
  // Same Set while the stair blockers are unchanged: other kinds' blocker
  // changes don't re-push STEP_SOURCE.
  const stairBlockers = blockerIdsOf(focusBlockers, 'stairs')
  /** Focus tier of a stair id, or null while nothing is focused. */
  const stairTierOf = useMemo(() => {
    if (!focusScene.active) return null
    return (id: number | undefined): FocusTier => focusTier(focusScene, focusBlockers, 'stairs', id)
    // `focusBlockers` is read only through its stair set (`stairBlockers`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusScene, stairBlockers])

  const animatedBase = useMemo(() => {
    if (reducedMotion || !stairs || !committedVisible) return []
    return stairs.filter(
      (s) =>
        s.id !== undefined &&
        s.visible !== false &&
        s.config.stairType === 'escalator' &&
        s.config.animated === true &&
        s.config.status !== 'out-of-service',
    )
  }, [stairs, committedVisible, reducedMotion])
  // Focus mode: a faded escalator stands still. Its treads go back to the
  // static STEP_SOURCE, where they fade with the rest of it (MOTION_SOURCE
  // is rewritten ~20×/s and has no tier layers). A string key, so a focus
  // change that pauses the same escalators keeps `animatedStairs` (and the
  // step features) as they were. '' while nothing is focused.
  const pausedKey = useMemo(() => {
    if (!stairTierOf) return ''
    const ids: number[] = []
    for (const s of animatedBase) {
      if (stepTierOf(stairTierOf(s.id)) !== null) ids.push(s.id as number)
    }
    return ids.join(',')
  }, [animatedBase, stairTierOf])
  const animatedStairs = useMemo(() => {
    if (pausedKey === '') return animatedBase
    const paused = new Set(pausedKey.split(',').map(Number))
    return animatedBase.filter((s) => !paused.has(s.id as number))
  }, [animatedBase, pausedKey])
  const animatedIds = useMemo(() => new Set(animatedStairs.map((s) => s.id)), [animatedStairs])

  // Build the combined FeatureCollection — every committed stair plus
  // any in-flight preview — once per render. Each feature carries the
  // shapeId so click hit-tests can resolve back to the source row.
  const stepFeatures = useMemo<FeatureCollection<Polygon, StairFeatureProps>>(() => {
    const features: Feature<Polygon, StairFeatureProps>[] = []
    if (stairs && committedVisible) {
      for (const s of stairs) {
        if (s.visible === false) continue
        if (s.id === undefined) continue
        if (!Array.isArray(s.vertices) || s.vertices.length < 2) continue
        const fc = stairToFeatureCollection(s, {
          floorElevations,
          motion: animatedIds.has(s.id) ? 'static' : 'all',
        })
        for (const f of fc.features) features.push(f)
      }
    }
    return { type: 'FeatureCollection', features }
  }, [stairs, committedVisible, floorElevations, animatedIds])

  // Focus mode: stamp a faded stair's features (copy-on-write, cached per
  // feature and tag). Solid parts get `focusTier` (→ a tier layer) and
  // `focusFade`; glass / click prisms only `focusFade` (outline). The same
  // collection object as long as the stamps are the same.
  const tieredStepFeatures = useMemo<FeatureCollection<Polygon, StepProps>>(() => {
    if (!stairTierOf) return stepFeatures
    const base = stepFeatures as FeatureCollection<Polygon, StepProps>
    return stableDerivedCollection(
      base,
      patchFeatureCollection(
        base,
        (f) => {
          const tier = stepTierOf(stairTierOf(f.properties.shapeId))
          if (tier === null) return null
          // SPLIT_TESTS.solid: what STEP_LAYER / the tier layers draw.
          const solid = f.properties.glass !== true && f.properties.hit !== true
          // Namespaced: the patch cache keys on (feature, tag) only.
          return solid ? tier : `outline:${tier}`
        },
        (props, tag) => {
          if (tag === 'near' || tag === 'ghost') {
            return { ...props, [FOCUS_TIER_PROP]: tag, [FOCUS_FADE_PROP]: FOCUS_FACTOR[tag] }
          }
          return { ...props, [FOCUS_FADE_PROP]: FOCUS_FACTOR[tag === 'outline:ghost' ? 'ghost' : 'near'] }
        },
      ),
    )
  }, [stepFeatures, stairTierOf])
  // Whether some pushed step feature carries `focusFade` (drives the
  // STEP_BORDER_LAYER opacity swap). The stamped collection is a different
  // object only when something was stamped; the scan confirms it.
  const anyStairFaded = useMemo(
    () =>
      tieredStepFeatures !== stepFeatures &&
      tieredStepFeatures.features.some((f) => f.properties[FOCUS_FADE_PROP] !== undefined),
    [tieredStepFeatures, stepFeatures],
  )

  const iconFeatures = useMemo<FeatureCollection<Point, LiftIconProps>>(() => {
    const features: Feature<Point, LiftIconProps>[] = []
    if (stairs && committedVisible) {
      for (const s of stairs) {
        if (s.visible === false || s.id === undefined || !isLiftType(s.config.stairType)) continue
        features.push(...liftIconFeatures(s, floorElevations))
      }
    }
    return { type: 'FeatureCollection', features }
  }, [stairs, committedVisible, floorElevations])

  const meshData = useMemo(() => {
    const solid: LiftMeshData[] = []
    const glass: LiftMeshData[] = []
    if (stairs && committedVisible) {
      for (const s of stairs) {
        if (s.visible === false) continue
        const m = cachedStairMeshes(s, floorElevations)
        if (!m) continue
        solid.push(m.solid)
        glass.push(m.glass)
      }
    }
    return { solid, glass }
  }, [stairs, committedVisible, floorElevations])
  // Focus mode: a faded stair's solid mesh goes to FADED_MESH_LAYER and its
  // glass is faded in place (alpha × factor; fadeMeshData caches per mesh
  // and factor, and keeps the key, so only those stairs re-upload). With
  // nothing faded, `meshData`'s own arrays and no faded meshes.
  const routedMeshes = useMemo(() => {
    if (!stairTierOf) return { solid: meshData.solid, glass: meshData.glass, faded: NO_MESHES }
    const solid: LiftMeshData[] = []
    const faded: LiftMeshData[] = []
    for (const m of meshData.solid) {
      const factor = FOCUS_FACTOR[stairTierOf(meshStairId(m.key))]
      if (factor < 1) faded.push(fadeMeshData(m, factor))
      else solid.push(m)
    }
    let glassFaded = false
    const glass = meshData.glass.map((m) => {
      const factor = FOCUS_FACTOR[stairTierOf(meshStairId(m.key))]
      if (factor >= 1) return m
      glassFaded = true
      return fadeMeshData(m, factor)
    })
    if (faded.length === 0 && !glassFaded) return { solid: meshData.solid, glass: meshData.glass, faded: NO_MESHES }
    return { solid, glass: glassFaded ? glass : meshData.glass, faded }
  }, [meshData, stairTierOf])
  const meshLayersRef = useRef<{ solid: LiftMeshLayer; glass: LiftMeshLayer; faded: LiftMeshLayer } | null>(null)
  if (meshLayersRef.current === null) {
    meshLayersRef.current = {
      solid: new LiftMeshLayer(MESH_LAYER),
      glass: new LiftMeshLayer(GLASS_MESH_LAYER, true),
      // Translucent, solid shading (not glass).
      faded: new LiftMeshLayer(FADED_MESH_LAYER, true, false),
    }
  }

  // ---- Empty-layer gate --------------------------------------------------
  // Every gate predicate goes through this hold (GatedLayerHold).
  const gateHoldRef = useRef(new GatedLayerHold(STAIR_GATED_LAYERS))
  useEffect(() => {
    if (!map) return
    return gateHoldRef.current.attach(map)
  }, [map])

  // ---- Source + layer mount ----------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const gateHold = gateHoldRef.current
    if (!map.getSource(STEP_SOURCE)) {
      try {
        map.addSource(STEP_SOURCE, {
          type: 'geojson',
          data: EMPTY_FC,
          lineMetrics: true,
        })
        gateHold.resetSource(STEP_SOURCE)
      } catch (err) {
        console.warn('[stair-overlay] addSource failed', err)
        return
      }
    }
    if (!map.getLayer(STEP_LAYER)) {
      try {
        map.addLayer({
          id: STEP_LAYER,
          type: 'fill-extrusion',
          source: STEP_SOURCE,
          // NO_TIER: a focus-faded stair's steps are drawn by the tier layers.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filter: ['all', NOT_GLASS, NO_TIER] as any,
          paint: stepPaint(1, true),
        })
        gateHold.register(map, STEP_LAYER, stairStepPredicate(null))
      } catch (err) {
        console.warn('[stair-overlay] addLayer failed', err)
      }
    }
    // Focus tier twins, directly after STEP_LAYER in tier order (the
    // translucent-order pass then files them with the other translucent
    // extrusions, as it does every opacity bucket). Hidden by the gate
    // until a stamp lands.
    let afterId = STEP_LAYER
    for (const [layerId, tier] of STEP_TIER_LAYERS) {
      const after = afterId
      afterId = layerId
      if (map.getLayer(layerId)) continue
      try {
        const order = rootLayerOrder(map)
        const at = order.indexOf(after)
        // Skip imported basemap ids (`id\u001fscope`) — never a valid anchor here.
        const beforeId = at >= 0 ? order.slice(at + 1).find((id) => !id.includes('\u001f')) : undefined
        map.addLayer(
          {
            id: layerId,
            type: 'fill-extrusion',
            source: STEP_SOURCE,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            filter: ['all', NOT_GLASS, tierIs(tier)] as any,
            paint: stepPaint(FOCUS_FACTOR[tier], false),
          },
          beforeId,
        )
        gateHold.register(map, layerId, stairStepPredicate(tier))
      } catch (err) {
        console.warn('[stair-overlay] focus tier layer failed', layerId, err)
      }
    }
    if (!map.getLayer(GLASS_LAYER)) {
      try {
        map.addLayer({
          id: GLASS_LAYER,
          type: 'fill-extrusion',
          source: STEP_SOURCE,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filter: IS_GLASS as any,
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-base': ['to-number', ['get', 'base_height']],
            'fill-extrusion-height': ['to-number', ['get', 'height']],
            'fill-extrusion-opacity': GLASS_OPACITY,
            'fill-extrusion-vertical-gradient': false,
            'fill-extrusion-emissive-strength': 0.6,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-cast-shadows' as any]: false,
          },
        })
        gateHold.register(map, GLASS_LAYER, stairSplitPredicate('glass'))
      } catch (err) {
        console.warn('[stair-overlay] glass layer failed', err)
      }
    }
    if (!map.getLayer(HIT_FILL_LAYER)) {
      try {
        map.addLayer({
          id: HIT_FILL_LAYER,
          type: 'fill-extrusion',
          source: STEP_SOURCE,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filter: IS_HIT as any,
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-base': ['to-number', ['get', 'base_height']],
            'fill-extrusion-height': ['to-number', ['get', 'height']],
            'fill-extrusion-opacity': 0,
          },
        })
        gateHold.register(map, HIT_FILL_LAYER, stairSplitPredicate('hit'))
      } catch (err) {
        console.warn('[stair-overlay] hit layer failed', err)
      }
    }
    const meshLayers = meshLayersRef.current
    if (meshLayers) {
      try {
        if (!map.getLayer(MESH_LAYER)) map.addLayer(meshLayers.solid)
        if (!map.getLayer(GLASS_MESH_LAYER)) map.addLayer(meshLayers.glass)
        if (!map.getLayer(FADED_MESH_LAYER)) map.addLayer(meshLayers.faded, GLASS_MESH_LAYER)
      } catch (err) {
        console.warn('[stair-overlay] mesh layers failed', err)
      }
    }
    if (!map.getSource(MOTION_SOURCE)) {
      try {
        map.addSource(MOTION_SOURCE, { type: 'geojson', data: EMPTY_FC })
      } catch { /* ignore */ }
    }
    if (!map.getLayer(MOTION_LAYER)) {
      try {
        map.addLayer({
          id: MOTION_LAYER,
          type: 'fill-extrusion',
          source: MOTION_SOURCE,
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-base': ['to-number', ['get', 'base_height']],
            'fill-extrusion-height': ['to-number', ['get', 'height']],
            'fill-extrusion-opacity': 1,
            'fill-extrusion-vertical-gradient': true,
          },
        })
        map.addLayer({
          id: MOTION_BORDER_LAYER,
          type: 'line',
          source: MOTION_SOURCE,
          paint: {
            'line-color': ['get', 'borderColor'],
            'line-width': ['coalesce', ['to-number', ['get', 'borderWidth']], 1],
            'line-opacity': 0.9,
            'line-emissive-strength': 1,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': ['+', ['to-number', ['get', 'height']], 0.0005],
          },
        })
      } catch { /* ignore */ }
    }
    if (!map.getSource(ICON_SOURCE)) {
      try {
        map.addSource(ICON_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      } catch { /* ignore */ }
    }
    if (!map.getLayer(ICON_LAYER)) {
      try {
        map.addLayer({
          id: ICON_LAYER,
          type: 'symbol',
          source: ICON_SOURCE,
          layout: {
            'icon-image': [
              'concat',
              'sgv-lift-',
              ['get', 'icon'],
              ['case', ['==', ['get', 'outOfService'], true], '-oos', ''],
            ],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-offset': [0, 1.5],
            'text-anchor': 'top',
            'text-optional': true,
            'symbol-z-elevate': false,
            'symbol-elevation-reference': 'sea',
          },
          paint: {
            'icon-emissive-strength': 1,
            'text-emissive-strength': 1,
            // text-color / text-halo-color follow the palette — set by the
            // effect below, which also runs right after this one.
            'text-halo-width': 1.2,
            'symbol-z-offset': ['to-number', ['get', 'z']],
            // Hide behind floors and walls above: icons on a lower floor
            // must not show through the slab of the floor being viewed.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['icon-occlusion-opacity' as any]: 0,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['text-occlusion-opacity' as any]: 0,
          },
        })
      } catch (err) {
        console.warn('[stair-overlay] icon layer failed', err)
      }
    }
    if (!map.getLayer(STEP_BORDER_LAYER)) {
      try {
        map.addLayer({
          id: STEP_BORDER_LAYER,
          type: 'line',
          source: STEP_SOURCE,
          paint: {
            'line-color': ['get', 'borderColor'],
            // borderWidth is stamped on each step feature by the
            // stair generator. `coalesce` protects preview/legacy
            // features that don't carry the property.
            'line-width': [
              'coalesce',
              ['to-number', ['get', 'borderWidth']],
              1.2,
            ],
            // Constant, as before focus mode. The border-opacity effect
            // swaps in STEP_BORDER_OPACITY_FADED only while a stair is faded.
            'line-opacity': STEP_BORDER_OPACITY,
            'line-emissive-strength': 1,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['to-number', ['get', 'height']],
              0.0005,
            ],
          },
        })
      } catch (err) {
        console.warn('[stair-overlay] border layer failed', err)
      }
    }
    if (!map.getLayer(SELECTION_LAYER)) {
      try {
        map.addLayer({
          id: SELECTION_LAYER,
          type: 'line',
          source: STEP_SOURCE,
          paint: {
            'line-color': '#f59e0b',
            'line-width': 2.5,
            'line-emissive-strength': 1,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['to-number', ['get', 'height']],
              0.001,
            ],
          },
          filter: ['==', ['get', 'shapeId'], -1],
        })
        gateHold.register(map, SELECTION_LAYER, stairSelectionPredicate([]))
      } catch (err) {
        console.warn('[stair-overlay] selection layer failed', err)
      }
    }

    // ---- Transform handle layer (symbol) ---------------------------------
    if (!map.getSource(TRANSFORM_SOURCE)) {
      try {
        map.addSource(TRANSFORM_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      } catch { /* ignore */ }
    }
    if (!map.getLayer(TRANSFORM_LAYER)) {
      try {
        map.addLayer({
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
            'icon-rotate': [
              'match',
              ['get', 'kind'],
              'move', 0,
              'rotate', [
                '+',
                ['match', ['get', 'cornerIndex'], 0, 270, 1, 90, 0],
                ['coalesce', ['to-number', ['get', 'imageRotation']], 0],
              ],
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
        })
      } catch { /* ignore */ }
    }

    // ---- In-flight source + layers (for live preview during transform) ---
    if (!map.getSource(INFLIGHT_SOURCE)) {
      try {
        map.addSource(INFLIGHT_SOURCE, { type: 'geojson', data: EMPTY_FC, lineMetrics: true })
      } catch { /* ignore */ }
    }
    if (!map.getLayer(INFLIGHT_LAYER)) {
      try {
        map.addLayer({
          id: INFLIGHT_LAYER,
          type: 'fill-extrusion',
          source: INFLIGHT_SOURCE,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filter: NOT_HIT as any,
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-base': ['to-number', ['get', 'base_height']],
            'fill-extrusion-height': ['to-number', ['get', 'height']],
            'fill-extrusion-opacity': 1,
            'fill-extrusion-vertical-gradient': true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-cast-shadows' as any]: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-ambient-occlusion-intensity' as any]: 0.35,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-ambient-occlusion-radius' as any]: 2.5,
          },
        })
      } catch { /* ignore */ }
    }
    if (!map.getLayer(INFLIGHT_BORDER_LAYER)) {
      try {
        map.addLayer({
          id: INFLIGHT_BORDER_LAYER,
          type: 'line',
          source: INFLIGHT_SOURCE,
          paint: {
            'line-color': ['get', 'borderColor'],
            'line-width': 1.2,
            'line-opacity': 0.9,
            'line-emissive-strength': 1,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['to-number', ['get', 'height']],
              0.0005,
            ],
          },
        })
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen])

  // Push the latest FeatureCollection into the committed source — the
  // focus-stamped one, which IS `stepFeatures` while nothing is focused and
  // keeps its identity while the stamps don't change (so the push re-runs
  // only when they do).
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(STEP_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    // Before setData, where the gate re-counts: a layer this push empties
    // is held until STEP_SOURCE re-tiles (GatedLayerHold). A focus stamp
    // shows its tier layer now and holds STEP_LAYER the same way.
    gateHoldRef.current.push(map, STEP_SOURCE, tieredStepFeatures)
    src.setData(tieredStepFeatures as unknown as Parameters<GeoJSONSource['setData']>[0])
  }, [map, styleLoaded, styleGen, tieredStepFeatures])

  // Focus mode: STEP_BORDER_LAYER's outlines fade with their stair. The
  // layer is installed with the constant 0.9 (focus off draws exactly as
  // before) and switches to the data-driven STEP_BORDER_OPACITY_FADED only
  // while some stair is faded — a data-driven setPaintProperty re-tiles
  // STEP_SOURCE, so it is written once on the way in and once on the way
  // out, and only when the live value differs (never while focus is off).
  // Declared after the STEP_SOURCE push, so it lands after the stamped push
  // when turning on and after the unstamped one when turning off; styleGen
  // re-applies it after a style re-install (which brings back the constant).
  useEffect(() => {
    if (!map || !styleLoaded || !hasMapLayer(map, STEP_BORDER_LAYER)) return
    const next = anyStairFaded ? STEP_BORDER_OPACITY_FADED : STEP_BORDER_OPACITY
    try {
      if (JSON.stringify(map.getPaintProperty(STEP_BORDER_LAYER, 'line-opacity')) === JSON.stringify(next)) return
      map.setPaintProperty(STEP_BORDER_LAYER, 'line-opacity', next)
    } catch { /* style mid-swap: the next styleGen re-applies */ }
  }, [map, styleLoaded, styleGen, anyStairFaded])

  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(ICON_SOURCE) as GeoJSONSource | undefined
    src?.setData(iconFeatures as unknown as Parameters<GeoJSONSource['setData']>[0])
  }, [map, styleLoaded, styleGen, iconFeatures])

  // Stair and lift meshes. The transforming stair is drawn from the in-flight
  // copy instead (pushInflight), like its extruded parts.
  const baseMeshesRef = useRef(routedMeshes)
  // Whether FADED_MESH_LAYER holds meshes: it is written only while focus
  // mode uses it (and once more to empty it), never on a map that doesn't.
  const fadedMeshesShownRef = useRef(false)
  useEffect(() => {
    baseMeshesRef.current = routedMeshes
    const layers = meshLayersRef.current
    if (!layers) return
    const skip = transformState ? `${transformState.stairId}:` : null
    const pick = (list: LiftMeshData[]) => (skip ? list.filter((m) => !m.key.startsWith(skip)) : list)
    layers.solid.setMeshes(pick(routedMeshes.solid))
    layers.glass.setMeshes(pick(routedMeshes.glass))
    const faded = pick(routedMeshes.faded)
    if (faded.length > 0 || fadedMeshesShownRef.current) {
      layers.faded.setMeshes(faded)
      fadedMeshesShownRef.current = faded.length > 0
    }
  }, [routedMeshes, transformState])

  // Remove the mesh layers with the overlay.
  useEffect(() => {
    const layers = meshLayersRef.current
    return () => {
      if (!map || !layers) return
      for (const id of [MESH_LAYER, FADED_MESH_LAYER, GLASS_MESH_LAYER]) {
        try {
          if (map.getLayer(id)) map.removeLayer(id)
        } catch { /* map gone */ }
      }
    }
  }, [map])

  // Icon label colours follow the palette.
  useEffect(() => {
    if (!map || !styleLoaded || !map.getLayer(ICON_LAYER)) return
    try {
      map.setPaintProperty(ICON_LAYER, 'text-color', primaryHex)
      map.setPaintProperty(ICON_LAYER, 'text-halo-color', primaryFgHex)
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, primaryHex, primaryFgHex])

  // ---- Moving escalator treads -----------------------------------------
  // Only the treads of animated escalators live in MOTION_SOURCE; the
  // rest of each escalator stays in the static source. ~20 fps setData of
  // a few dozen quads — and nothing at all when no escalator animates, so
  // the map can go idle.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(MOTION_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    if (animatedStairs.length === 0) {
      src.setData(EMPTY_FC as unknown as Parameters<GeoJSONSource['setData']>[0])
      return
    }
    const excludeId = transformState?.stairId
    let raf = 0
    let last = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - last < MOTION_FRAME_MS) return
      last = now
      const phase = ((now / 1000) * TREADS_PER_SECOND) % 1
      const features: Feature<Polygon, StairFeatureProps>[] = []
      for (const s of animatedStairs) {
        if (s.id === excludeId) continue
        features.push(...stairToFeatureCollection(s, { floorElevations, motion: 'treads', phase }).features)
      }
      src.setData({ type: 'FeatureCollection', features } as unknown as Parameters<GeoJSONSource['setData']>[0])
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [map, styleLoaded, styleGen, animatedStairs, floorElevations, transformState])

  // ---- Exclusion filter during transform ---------------------------------
  // While a transform is active, hide the transforming stair's committed
  // features so only the in-flight copy renders.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const excludeId = transformState?.stairId
    const shapeFilter = excludeId != null
      ? ['!=', ['get', 'shapeId'], excludeId]
      : NO_SHAPE_FILTER
    const shapePredicate = stairShapeFilterPredicate(excludeId)
    // Solid and glass layers share a source, so each filter combines the
    // glass split (and, for the solid layer and its focus tier twins, the
    // tier clause) with the transform exclusion. The third entry is the
    // matching empty-layer gate predicate (null: the layer is never empty
    // while its source has features, so the source count alone gates it).
    // This write replaces the selection effect's SELECTION_LAYER filter
    // too, so its predicate is replaced along with it. A layer the
    // exclusion empties (the moving escalator was STEP_LAYER's only
    // member) is held visible until STEP_SOURCE re-tiles (GatedLayerHold).
    const filters: [string, unknown, LayerFeaturePredicate | null][] = [
      [STEP_LAYER, ['all', NOT_GLASS, NO_TIER, shapeFilter], stairStepPredicate(null, shapePredicate)],
      ...STEP_TIER_LAYERS.map(
        ([layerId, tier]) =>
          [layerId, ['all', NOT_GLASS, tierIs(tier), shapeFilter], stairStepPredicate(tier, shapePredicate)] as [
            string,
            unknown,
            LayerFeaturePredicate,
          ],
      ),
      [GLASS_LAYER, ['all', IS_GLASS, shapeFilter], stairSplitPredicate('glass', shapePredicate)],
      [HIT_FILL_LAYER, ['all', IS_HIT, shapeFilter], stairSplitPredicate('hit', shapePredicate)],
      [STEP_BORDER_LAYER, shapeFilter, null],
      [SELECTION_LAYER, shapeFilter, shapePredicate],
      [ICON_LAYER, shapeFilter, null],
    ]
    for (const [layerId, filter, predicate] of filters) {
      if (!map.getLayer(layerId)) continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setFilter(layerId, filter as any)
        if (predicate) gateHoldRef.current.register(map, layerId, predicate)
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, transformState])

  // Toggle layer visibility — Mapbox layers default to 'visible', so
  // `committedVisible: false` would otherwise leave the stair painted.
  // Lift wayfinding icons also follow the "Lift icons" display setting.
  const liftIcons = useGraphicsSettings((s) => s.liftIcons)
  useEffect(() => {
    if (!map || !styleLoaded) return
    const visibility = committedVisible ? 'visible' : 'none'
    meshLayersRef.current?.solid.setVisible(committedVisible)
    meshLayersRef.current?.glass.setVisible(committedVisible)
    meshLayersRef.current?.faded.setVisible(committedVisible)
    for (const layerId of [STEP_LAYER, STEP_NEAR_LAYER, STEP_GHOST_LAYER, GLASS_LAYER, HIT_FILL_LAYER, STEP_BORDER_LAYER, SELECTION_LAYER, ICON_LAYER, MOTION_LAYER, MOTION_BORDER_LAYER]) {
      if (!map.getLayer(layerId)) continue
      try {
        map.setLayoutProperty(layerId, 'visibility', layerId === ICON_LAYER && !liftIcons ? 'none' : visibility)
      } catch {
        /* ignore */
      }
    }
  }, [map, styleLoaded, styleGen, committedVisible, liftIcons])

  // Theme-tinted selection outline.
  useEffect(() => {
    if (!map || !styleLoaded) return
    try {
      if (map.getLayer(SELECTION_LAYER)) {
        map.setPaintProperty(SELECTION_LAYER, 'line-color', primaryHex)
      }
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, primaryHex])

  // Selection outline.
  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!map.getLayer(SELECTION_LAYER)) return
    const ids = selectedStairIds && selectedStairIds.size > 0 ? [...selectedStairIds] : []
    const filter =
      ids.length === 0
        ? ['==', ['get', 'shapeId'], -1]
        : ids.length === 1
          ? ['==', ['get', 'shapeId'], ids[0]]
          : ['in', ['get', 'shapeId'], ['literal', ids]]
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.setFilter(SELECTION_LAYER, filter as any)
      // Same synchronous pass as the filter: a new selection's outline
      // shows from the very next frame.
      gateHoldRef.current.register(map, SELECTION_LAYER, stairSelectionPredicate(ids))
    } catch {
      /* ignore */
    }
  }, [map, styleLoaded, styleGen, selectedStairIds])

  // ---- Transform context -------------------------------------------------
  // Computes the centroid and rotate-mode corner handles for the
  // currently transforming stair.
  const transformContextRef = useRef<{
    stair: StairShape
    center: [number, number]
    anchor: [number, number]
    rotateCorners: [number, number][] | null
  } | null>(null)

  const transformContext = useMemo(() => {
    if (!transformState || !stairs) return null
    const s = stairs.find((x) => x.id === transformState.stairId)
    if (!s) return null
    const center = stairMidpoint(s.vertices)
    if (!center) return null
    let anchor: [number, number] = center
    let rotateCorners: [number, number][] | null = null

    if (transformState.kind === 'rotate' && s.vertices.length >= 2) {
      const v0 = s.vertices[0]
      const v1 = s.vertices[1]
      rotateCorners = [
        rotatePoint(v0, center, s.rotation ?? 0),
        rotatePoint(v1, center, s.rotation ?? 0),
      ]
      anchor = rotateCorners[0]
    }
    return { stair: s, center, anchor, rotateCorners }
  }, [transformState, stairs])
  useEffect(() => {
    transformContextRef.current = transformContext
  }, [transformContext])

  // ---- Push transform handle features ------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    if (!transformContext || !transformState) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    const s = transformContext.stair
    let elev = s.config.baseElevation ?? 0
    let hgt = (s.config.stepCount ?? 1) * (s.config.riserHeight ?? 0.18)
    if (isLiftType(s.config.stairType)) {
      const levels = resolveLiftLevels(s.config, floorElevations)
      elev = levels.base
      hgt = levels.rise
    }
    const features: Feature<Point>[] = []

    if (transformState.kind === 'rotate' && transformContext.rotateCorners) {
      for (let i = 0; i < transformContext.rotateCorners.length; i++) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: transformContext.rotateCorners[i] },
          properties: {
            kind: 'rotate',
            iconId: TRANSFORM_ICON.rotate,
            cornerIndex: i,
            imageRotation: s.rotation ?? 0,
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
          iconId: TRANSFORM_ICON[transformState.kind],
          cornerIndex: -1,
          imageRotation: s.rotation ?? 0,
          elevation: elev,
          height: hgt,
        },
      })
    }
    src.setData({ type: 'FeatureCollection', features })
  }, [map, styleLoaded, styleGen, transformContext, transformState, floorElevations])

  // Meshes follow a move / rotate drag live.
  const pushInflightMesh = useCallback(
    (patched: StairShape) => {
      const layers = meshLayersRef.current
      if (!layers) return
      const m = stairMeshes(patched, floorElevations)
      const prefix = `${patched.id}:`
      const base = baseMeshesRef.current
      layers.solid.setMeshes([...base.solid.filter((x) => !x.key.startsWith(prefix)), ...(m ? [m.solid] : [])])
      layers.glass.setMeshes([...base.glass.filter((x) => !x.key.startsWith(prefix)), ...(m ? [m.glass] : [])])
    },
    [floorElevations],
  )

  // ---- Push in-flight features during transform --------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(INFLIGHT_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    if (!transformContext || !transformState) {
      src.setData(EMPTY_FC as unknown as Parameters<GeoJSONSource['setData']>[0])
      return
    }
    const fc = stairToFeatureCollection(transformContext.stair, { floorElevations })
    src.setData(fc as unknown as Parameters<GeoJSONSource['setData']>[0])
    pushInflightMesh(transformContext.stair)
    // Sync opacity
    try {
      const op = Math.max(0, Math.min(1, (transformContext.stair.config.opacity ?? 100) / 100))
      map.setPaintProperty(INFLIGHT_LAYER, 'fill-extrusion-opacity', op)
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, transformContext, transformState, floorElevations, pushInflightMesh])

  // ---- Elevate transform + in-flight layers above committed --------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const id of [SELECTION_LAYER, INFLIGHT_LAYER, INFLIGHT_BORDER_LAYER, TRANSFORM_LAYER]) {
      try { if (map.getLayer(id)) map.moveLayer(id) } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, transformState])

  // ---- Live preview (drawing mode) ---------------------------------------
  const previewFC = useMemo<FeatureCollection<Polygon, StairFeatureProps> | null>(() => {
    if (!livePreview) return null
    if (livePreview.vertices.length < 2) return null
    return buildStairFeatures(livePreview.vertices, livePreview.config, undefined, { floorElevations })
  }, [livePreview, floorElevations])

  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!previewFC) {
      if (map.getLayer(PREVIEW_LAYER)) {
        try { map.removeLayer(PREVIEW_LAYER) } catch { /* ignore */ }
      }
      if (map.getSource(PREVIEW_SOURCE)) {
        try { map.removeSource(PREVIEW_SOURCE) } catch { /* ignore */ }
      }
      return
    }
    if (!map.getSource(PREVIEW_SOURCE)) {
      try {
        map.addSource(PREVIEW_SOURCE, { type: 'geojson', data: previewFC as unknown as Parameters<GeoJSONSource['setData']>[0], lineMetrics: true })
      } catch (err) {
        console.warn('[map-stair-overlay] preview addSource failed', err)
        return
      }
    } else {
      const src = map.getSource(PREVIEW_SOURCE) as GeoJSONSource | undefined
      src?.setData(previewFC as unknown as Parameters<GeoJSONSource['setData']>[0])
    }
    if (!map.getLayer(PREVIEW_LAYER)) {
      try {
        map.addLayer({
          id: PREVIEW_LAYER,
          type: 'fill-extrusion',
          source: PREVIEW_SOURCE,
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-base': ['to-number', ['get', 'base_height']],
            'fill-extrusion-height': ['to-number', ['get', 'height']],
            'fill-extrusion-opacity': 0.6,
            'fill-extrusion-vertical-gradient': true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-cast-shadows' as any]: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-ambient-occlusion-intensity' as any]: 0.35,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['fill-extrusion-ambient-occlusion-radius' as any]: 2.5,
          },
        })
      } catch (err) {
        console.warn('[map-stair-overlay] preview addLayer failed', err)
      }
    }
  }, [map, styleLoaded, styleGen, previewFC])

  // ---- Drag interaction for transform handles ----------------------------
  // Synced inside the commit (a layout effect runs before the browser can
  // dispatch another event), so the drag handlers always see the
  // callbacks of the committed render.
  const transformChangeRef = useRef(onTransformChange)
  const transformEndRef = useRef(onTransformEnd)
  useLayoutEffect(() => {
    transformChangeRef.current = onTransformChange
    transformEndRef.current = onTransformEnd
  }, [onTransformChange, onTransformEnd])

  const dragRef = useRef<{
    dragging: boolean
    kind: 'move' | 'rotate' | null
    originalStair: StairShape | null
    originalCenter: [number, number] | null
    originalAnchor: [number, number] | null
    originalRotation: number
    downHandleAngle: number
    pendingCursor: [number, number] | null
    rafId: number
  }>({
    dragging: false,
    kind: null,
    originalStair: null,
    originalCenter: null,
    originalAnchor: null,
    originalRotation: 0,
    downHandleAngle: 0,
    pendingCursor: null,
    rafId: 0,
  })

  const computePatch = useCallback(
    (cursor: [number, number]): { vertices?: [number, number][]; rotation?: number } | null => {
      const drag = dragRef.current
      const orig = drag.originalStair
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
      // Move: translate all vertices by cursor delta.
      const dLng = cursor[0] - drag.originalAnchor[0]
      const dLat = cursor[1] - drag.originalAnchor[1]
      const moved = orig.vertices.map(
        ([lng, lat]) => [lng + dLng, lat + dLat] as [number, number],
      )
      return { vertices: moved }
    },
    [],
  )

  const pushInflight = useCallback(
    (patch: { vertices?: [number, number][]; rotation?: number }) => {
      const ctx = transformContextRef.current
      if (!ctx) return
      const src = map?.getSource(INFLIGHT_SOURCE) as GeoJSONSource | undefined
      if (!src) return
      const patched: StairShape = {
        ...ctx.stair,
        ...(patch.vertices ? { vertices: patch.vertices } : {}),
        ...(patch.rotation != null ? { rotation: patch.rotation } : {}),
      }
      const fc = stairToFeatureCollection(patched, { floorElevations })
      src.setData(fc as unknown as Parameters<GeoJSONSource['setData']>[0])
      pushInflightMesh(patched)
    },
    [map, floorElevations, pushInflightMesh],
  )

  const flushDragFrame = useCallback(() => {
    const drag = dragRef.current
    drag.rafId = 0
    if (!drag.dragging || !drag.pendingCursor) return
    const patch = computePatch(drag.pendingCursor)
    if (!patch) return
    pushInflight(patch)
  }, [computePatch, pushInflight])

  const scheduleFlush = useCallback(() => {
    const drag = dragRef.current
    if (drag.rafId !== 0) return
    drag.rafId = requestAnimationFrame(flushDragFrame)
  }, [flushDragFrame])

  // ---- Click selection + transform handle interaction --------------------
  const onStairClickRef = useRef(onStairClick)
  const onMapClickEmptyRef = useRef(onMapClickEmpty)
  const selectionEnabledRef = useRef(selectionEnabled)
  useEffect(() => { onStairClickRef.current = onStairClick }, [onStairClick])
  useEffect(() => { onMapClickEmptyRef.current = onMapClickEmpty }, [onMapClickEmpty])
  useEffect(() => { selectionEnabledRef.current = selectionEnabled }, [selectionEnabled])

  useEffect(() => {
    if (!map || !styleLoaded) return

    const HIT_BUFFER = 4

    // ---- Transform handle mouse events -----------------------------------
    const onMouseDown = (e: MapMouseEvent) => {
      if (!map.getLayer(TRANSFORM_LAYER)) return
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [TRANSFORM_LAYER],
      })
      if (hits.length === 0) return
      const ctx = transformContextRef.current
      if (!ctx) return
      const drag = dragRef.current
      drag.dragging = true
      drag.kind = transformState?.kind === 'rotate' ? 'rotate' : 'move'
      drag.originalStair = ctx.stair
      drag.originalCenter = ctx.center
      drag.originalRotation = ctx.stair.rotation ?? 0

      const rawIdx = hits[0]?.properties?.cornerIndex
      const clickedIdx = typeof rawIdx === 'number' && rawIdx >= 0 && rawIdx <= 1 ? rawIdx : -1
      if (transformState?.kind === 'rotate' && clickedIdx >= 0 && ctx.rotateCorners) {
        drag.originalAnchor = ctx.rotateCorners[clickedIdx]
      } else {
        drag.originalAnchor = ctx.anchor
      }
      drag.downHandleAngle = Math.atan2(
        drag.originalAnchor[1] - ctx.center[1],
        drag.originalAnchor[0] - ctx.center[0],
      )

      map.dragPan.disable()
      map.getCanvas().style.cursor = transformState?.kind === 'rotate' ? 'crosshair' : 'grabbing'
      e.preventDefault?.()
    }

    const onMouseMove = (e: MapMouseEvent) => {
      const drag = dragRef.current
      if (!drag.dragging) return
      drag.pendingCursor = [e.lngLat.lng, e.lngLat.lat]
      scheduleFlush()
    }

    const onMouseUp = (e: MapMouseEvent) => {
      const drag = dragRef.current
      if (!drag.dragging) return
      drag.dragging = false
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''
      const cursor: [number, number] = [e.lngLat.lng, e.lngLat.lat]

      if (drag.rafId !== 0) {
        cancelAnimationFrame(drag.rafId)
        drag.rafId = 0
      }
      drag.pendingCursor = null

      const patch = computePatch(cursor)
      drag.originalStair = null
      drag.originalCenter = null
      drag.originalAnchor = null
      drag.kind = null

      if (patch) transformChangeRef.current?.(patch, true)
      transformEndRef.current?.()
    }

    const onEnter = () => {
      const drag = dragRef.current
      if (!drag.dragging) {
        map.getCanvas().style.cursor = transformState?.kind === 'rotate' ? 'crosshair' : 'grab'
      }
    }
    const onLeave = () => {
      const drag = dragRef.current
      if (!drag.dragging) map.getCanvas().style.cursor = ''
    }

    // ---- Click selection -------------------------------------------------
    const onClick = (e: MapMouseEvent) => {
      if (!selectionEnabledRef.current) return
      if (e.originalEvent?.defaultPrevented) return
      // Defer to higher-priority kinds (model, text) at the click point.
      if (higherPriorityAt(map, e.point, 'stair')) return
      const bbox: [[number, number], [number, number]] = [
        [e.point.x - HIT_BUFFER, e.point.y - HIT_BUFFER],
        [e.point.x + HIT_BUFFER, e.point.y + HIT_BUFFER],
      ]
      let hits: GeoJSON.Feature[]
      try {
        hits = map.queryRenderedFeatures(bbox, { layers: HIT_LAYERS.filter((id) => hasMapLayer(map, id)) })
      } catch {
        return
      }
      if (hits.length === 0) {
        onMapClickEmptyRef.current?.()
        return
      }
      const shapeId = hits[0].properties?.shapeId
      if (typeof shapeId !== 'number') return
      e.preventDefault()
      e.originalEvent?.preventDefault?.()
      onStairClickRef.current?.(shapeId, e.originalEvent as MouseEvent)
    }

    const onMove = (e: MapMouseEvent) => {
      if (!selectionEnabledRef.current) return
      const bbox: [[number, number], [number, number]] = [
        [e.point.x - HIT_BUFFER, e.point.y - HIT_BUFFER],
        [e.point.x + HIT_BUFFER, e.point.y + HIT_BUFFER],
      ]
      let hits: GeoJSON.Feature[]
      try {
        hits = map.queryRenderedFeatures(bbox, { layers: HIT_LAYERS.filter((id) => hasMapLayer(map, id)) })
      } catch {
        return
      }
      if (map.getCanvas().style.cursor === 'crosshair') return
      map.getCanvas().style.cursor = hits.length > 0 ? 'pointer' : ''
    }

    map.on('mousedown', onMouseDown)
    map.on('mousemove', onMouseMove)
    map.on('mouseup', onMouseUp)
    map.on('mouseenter', TRANSFORM_LAYER, onEnter)
    map.on('mouseleave', TRANSFORM_LAYER, onLeave)
    map.on('click', onClick)
    map.on('mousemove', onMove)
    return () => {
      map.off('mousedown', onMouseDown)
      map.off('mousemove', onMouseMove)
      map.off('mouseup', onMouseUp)
      map.off('mouseenter', TRANSFORM_LAYER, onEnter)
      map.off('mouseleave', TRANSFORM_LAYER, onLeave)
      map.off('click', onClick)
      map.off('mousemove', onMove)
    }
  }, [map, styleLoaded, styleGen, transformState, computePatch, scheduleFlush])

  return null
}
