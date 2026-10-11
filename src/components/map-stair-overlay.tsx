/**
 * Stair rendering. Single `geojson` source + one `fill-extrusion` layer
 * driving `fill-extrusion-base` / `fill-extrusion-height` per feature
 * via `['get', …]`, exactly the pattern Mapbox uses in its 3D indoor
 * floorplan example. One stair = N polygon features (one per step) so
 * the whole staircase repaints from a single setData call when the
 * draft changes — no layer churn on every slider move.
 */

import type { Feature, FeatureCollection, Point, Polygon } from 'geojson'
import type { GeoJSONSource, Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

/** Layers a click or hover can land on. */
const HIT_LAYERS = [STEP_LAYER, GLASS_LAYER, MOTION_LAYER, ICON_LAYER, HIT_FILL_LAYER]

const IS_HIT = ['==', ['get', 'hit'], true]
const NOT_HIT = ['!=', ['get', 'hit'], true]
const IS_GLASS = ['all', ['==', ['get', 'glass'], true], NOT_HIT]
const NOT_GLASS = ['all', ['!=', ['get', 'glass'], true], NOT_HIT]
const NO_SHAPE_FILTER = ['!=', ['get', 'shapeId'], -1]

const EMPTY_FC: FeatureCollection<Polygon, StairFeatureProps> = {
  type: 'FeatureCollection',
  features: [],
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
  const animatedStairs = useMemo(() => {
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
  const meshLayersRef = useRef<{ solid: LiftMeshLayer; glass: LiftMeshLayer } | null>(null)
  if (meshLayersRef.current === null) {
    meshLayersRef.current = {
      solid: new LiftMeshLayer(MESH_LAYER),
      glass: new LiftMeshLayer(GLASS_MESH_LAYER, true),
    }
  }

  // ---- Source + layer mount ----------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!map.getSource(STEP_SOURCE)) {
      try {
        map.addSource(STEP_SOURCE, {
          type: 'geojson',
          data: EMPTY_FC,
          lineMetrics: true,
        })
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filter: NOT_GLASS as any,
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
      } catch (err) {
        console.warn('[stair-overlay] addLayer failed', err)
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
      } catch (err) {
        console.warn('[stair-overlay] hit layer failed', err)
      }
    }
    const meshLayers = meshLayersRef.current
    if (meshLayers) {
      try {
        if (!map.getLayer(MESH_LAYER)) map.addLayer(meshLayers.solid)
        if (!map.getLayer(GLASS_MESH_LAYER)) map.addLayer(meshLayers.glass)
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

  // Push the latest FeatureCollection into the committed source.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(STEP_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    src.setData(stepFeatures as unknown as Parameters<GeoJSONSource['setData']>[0])
  }, [map, styleLoaded, styleGen, stepFeatures])

  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(ICON_SOURCE) as GeoJSONSource | undefined
    src?.setData(iconFeatures as unknown as Parameters<GeoJSONSource['setData']>[0])
  }, [map, styleLoaded, styleGen, iconFeatures])

  // Stair and lift meshes. The transforming stair is drawn from the in-flight
  // copy instead (pushInflight), like its extruded parts.
  const baseMeshesRef = useRef(meshData)
  useEffect(() => {
    baseMeshesRef.current = meshData
    const layers = meshLayersRef.current
    if (!layers) return
    const skip = transformState ? `${transformState.stairId}:` : null
    layers.solid.setMeshes(skip ? meshData.solid.filter((m) => !m.key.startsWith(skip)) : meshData.solid)
    layers.glass.setMeshes(skip ? meshData.glass.filter((m) => !m.key.startsWith(skip)) : meshData.glass)
  }, [meshData, transformState])

  // Remove the mesh layers with the overlay.
  useEffect(() => {
    const layers = meshLayersRef.current
    return () => {
      if (!map || !layers) return
      for (const id of [MESH_LAYER, GLASS_MESH_LAYER]) {
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
    // Solid and glass layers share a source, so each filter combines the
    // glass split with the transform exclusion.
    const filters: [string, unknown][] = [
      [STEP_LAYER, ['all', NOT_GLASS, shapeFilter]],
      [GLASS_LAYER, ['all', IS_GLASS, shapeFilter]],
      [HIT_FILL_LAYER, ['all', IS_HIT, shapeFilter]],
      [STEP_BORDER_LAYER, shapeFilter],
      [SELECTION_LAYER, shapeFilter],
      [ICON_LAYER, shapeFilter],
    ]
    for (const [layerId, filter] of filters) {
      if (!map.getLayer(layerId)) continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setFilter(layerId, filter as any)
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
    for (const layerId of [STEP_LAYER, GLASS_LAYER, HIT_FILL_LAYER, STEP_BORDER_LAYER, SELECTION_LAYER, ICON_LAYER, MOTION_LAYER, MOTION_BORDER_LAYER]) {
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
  const transformChangeRef = useRef(onTransformChange)
  // eslint-disable-next-line react-hooks/refs -- latest-value ref, read/written outside effects intentionally
  transformChangeRef.current = onTransformChange
  const transformEndRef = useRef(onTransformEnd)
  // eslint-disable-next-line react-hooks/refs -- latest-value ref, read/written outside effects intentionally
  transformEndRef.current = onTransformEnd

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
        hits = map.queryRenderedFeatures(bbox, { layers: HIT_LAYERS.filter((id) => map.getLayer(id)) })
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
        hits = map.queryRenderedFeatures(bbox, { layers: HIT_LAYERS.filter((id) => map.getLayer(id)) })
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
