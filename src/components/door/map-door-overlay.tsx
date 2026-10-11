/**
 * Map overlay for the door tool.
 *
 * Renders every committed door as a built mesh (door/mesh.ts: frame and
 * architrave, leaves with moulded panels, lever handles, hinges; glass
 * wings for revolving doors) on two custom mesh layers. The fill-extrusion
 * jambs / leaves / lintel stay as invisible click and selection targets.
 * Dashed line layers draw swing arcs, a symbol layer the labels.
 * Optionally renders a translucent live preview while the user is
 * drawing — matches the `livePreview` shape `MapStairOverlay` uses so
 * the host route can drive both with the same anchor-accumulation
 * pattern.
 *
 * Layer/source ids use a `door-tool-` prefix so they can't collide with
 * any other shape overlay's namespace.
 */

import type {
  GeoJSONSource,
  Map as MapboxMapInstance,
  MapMouseEvent,
} from 'mapbox-gl'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LiftMeshLayer, placeMesh, type LiftMeshData } from '@/lib/lift-mesh-layer'
import { buildDoorMesh } from '@/lib/door/mesh'
import {
  buildDoorFeaturesRaw,
  doorsToFeatureCollections,
  resizeDoorVertices,
  rotateDoorVertices,
} from '@/lib/door/generators'
import { higherPriorityAt } from '@/lib/overlay-hit-priority'
import {
  TRANSFORM_ICON,
  readThemePrimaryForegroundHex,
  readThemePrimaryHex,
  registerTransformHandleIcons,
  subscribeThemeChanges,
} from '@/lib/map-transform-handles'
import type { DoorConfig, DoorShape } from '@/lib/door/types'
import {
  buildOccluders,
  computeOccludedIds,
  type GridOccluderInput,
  type OccludableTarget,
} from '@/lib/marker-occlusion'
import type {
  CircleShape,
  ImageShape,
  LineShape,
  PolygonShape,
  StairShape,
} from '@/lib/shapes'

const POLY_SOURCE = 'door-tool-poly-source'
const FILL_LAYER = 'door-tool-fill-layer'
const OUTLINE_LAYER = 'door-tool-outline-layer'
const SELECTION_LAYER = 'door-tool-selection-layer'

const ARC_SOURCE = 'door-tool-arc-source'
const ARC_LAYER = 'door-tool-arc-layer'

const LABEL_SOURCE = 'door-tool-label-source'
const LABEL_LAYER = 'door-tool-label-layer'

const PREVIEW_POLY_SOURCE = 'door-tool-preview-poly-source'
const PREVIEW_POLY_LAYER = 'door-tool-preview-poly-layer'
const PREVIEW_ARC_SOURCE = 'door-tool-preview-arc-source'
const PREVIEW_ARC_LAYER = 'door-tool-preview-arc-layer'
const PREVIEW_GUIDE_SOURCE = 'door-tool-preview-guide-source'
const PREVIEW_GUIDE_LAYER = 'door-tool-preview-guide-layer'

const TRANSFORM_SOURCE = 'door-tool-transform-source'
const TRANSFORM_LAYER = 'door-tool-transform-layer'
const TRANSFORM_LAYER_HALO = 'door-tool-transform-layer-halo'

// In-flight sources — hold ONLY the door currently being moved/rotated/
// scaled. Filter out the transforming id from the committed FILL/OUTLINE/
// ARC/LABEL layers while the drag is live, and push the fresh feature
// set to the in-flight sources from the drag handler's RAF. Cost is
// O(1) buildDoorFeaturesRaw per frame instead of O(N_doors) — plus,
// critically, doors don't hit the useDoorStore during the drag, so
// `attachedDoorsByLineId` in the parent stays reference-stable and the
// wall overlay's `wallFc` doesn't re-tessellate every wall on every
// mousemove (the "wall recut cascade" — see file comment above).
const POLY_INFLIGHT_SOURCE = 'door-tool-poly-inflight-source'
const FILL_INFLIGHT_LAYER = 'door-tool-fill-inflight-layer'
const OUTLINE_INFLIGHT_LAYER = 'door-tool-outline-inflight-layer'
const SELECTION_INFLIGHT_LAYER = 'door-tool-selection-inflight-layer'
const ARC_INFLIGHT_SOURCE = 'door-tool-arc-inflight-source'
const ARC_INFLIGHT_LAYER = 'door-tool-arc-inflight-layer'
const LABEL_INFLIGHT_SOURCE = 'door-tool-label-inflight-source'
const LABEL_INFLIGHT_LAYER = 'door-tool-label-inflight-layer'

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] }

// Built doors (door/mesh.ts). The glass layer holds revolving-door glass.
const MESH_LAYER = 'door-tool-mesh-layer'
const GLASS_MESH_LAYER = 'door-tool-glass-mesh-layer'

interface DoorMeshes {
  solid: LiftMeshData
  glass: LiftMeshData
}

function doorMeshes(id: number, vertices: [[number, number], [number, number]], config: DoorConfig): DoorMeshes | null {
  const m = buildDoorMesh(vertices, config)
  if (!m) return null
  return {
    solid: placeMesh(m.solid.positions, m.solid.colors, vertices[0], [0, 0], 0, `${id}:solid`),
    glass: placeMesh(m.glass.positions, m.glass.colors, vertices[0], [0, 0], 0, `${id}:glass`),
  }
}

/** Meshes per door row, rebuilt only when the row object changes. */
const meshCache = new WeakMap<DoorShape, DoorMeshes | null>()
function cachedDoorMeshes(door: DoorShape): DoorMeshes | null {
  if (meshCache.has(door)) return meshCache.get(door) ?? null
  const m = doorMeshes(door.id, door.vertices, door.config)
  meshCache.set(door, m)
  return m
}

export type DoorTransformKind = 'move' | 'rotate' | 'scale'

interface MapDoorOverlayProps {
  map: MapboxMapInstance | null
  doors: ReadonlyArray<DoorShape>
  selectedDoorIds?: ReadonlySet<number>
  /**
   * In-progress draw preview. `vertices` carries the anchors the user
   * has placed so far plus the cursor as the trailing element. Pass
   * `null` when no draw is active or fewer than 2 anchors+cursor are
   * available. Mirrors `MapStairOverlay`'s `livePreview` prop.
   */
  livePreview?: {
    vertices: [number, number][]
    config: DoorConfig
  } | null
  /**
   * When set, the overlay renders an orange drag handle on the
   * specified door and forwards vertex updates via `onTransformChange`
   * on every mousemove (commit=false) and once on mouseup (commit=true).
   * Modeled on `MapImageOverlay`'s `transformState`.
   */
  transformState?: { doorId: number; kind: DoorTransformKind } | null
  onTransformChange?: (
    nextVertices: [[number, number], [number, number]],
    commit: boolean,
  ) => void
  onDoorClick?: (id: number, originalEvent: MouseEvent) => void
  onMapClickEmpty?: () => void
  committedVisible?: boolean
  selectionEnabled?: boolean
  /**
   * Geometry the door labels can hide behind. Same shape the marker
   * and text-label overlays accept. Feeds an analytic occlusion pass
   * that flips `feature-state.occluded` per label on every camera
   * move — same trick `map-text-label-overlay` uses to fold floor-
   * plate hiding into a symbol layer. Omit to leave labels always
   * visible (pre-occlusion behaviour).
   */
  occluders?: {
    images?: ReadonlyArray<ImageShape>
    polygons?: ReadonlyArray<PolygonShape>
    circles?: ReadonlyArray<CircleShape>
    lines?: ReadonlyArray<LineShape>
    stairs?: ReadonlyArray<StairShape>
    grids?: ReadonlyArray<GridOccluderInput>
  }
  /** Master switch — matches the sibling flag on the marker/text overlays. */
  occlusionEnabled?: boolean
}

export function MapDoorOverlay({
  map,
  doors,
  selectedDoorIds,
  livePreview,
  transformState,
  onTransformChange,
  onDoorClick,
  onMapClickEmpty,
  committedVisible = true,
  selectionEnabled = true,
  occluders,
  occlusionEnabled = true,
}: MapDoorOverlayProps) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  // `styleGen` bumps on every style.load — see matching note in
  // `map-polygon-overlay.tsx`.
  const [styleGen, setStyleGen] = useState(0)

  // ---- Style readiness (mirrors stair / polygon overlay) ----------------
  useEffect(() => {
    if (!map) return
    let cancelled = false
    const ready = () => {
      if (cancelled) return
      setStyleLoaded(true)
      setStyleGen((g) => g + 1)
    }
    if (map.isStyleLoaded()) {
      queueMicrotask(ready)
      return
    }
    // Poll until the style is loaded, THEN stop. Without `clearInterval` on
    // success the interval keeps calling `ready()` every 100ms forever and
    // React bails with "Maximum update depth exceeded".
    const interval = setInterval(() => {
      if (map.isStyleLoaded()) {
        ready()
        clearInterval(interval)
      }
    }, 100)
    map.on('style.load', ready)
    map.on('load', ready)
    return () => {
      cancelled = true
      clearInterval(interval)
      map.off('style.load', ready)
      map.off('load', ready)
    }
  }, [map])

  // ---- Theme-tinted handle icons -----------------------------------------
  // Same pattern as image / polygon / line / grid overlays.
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

  // ---- Build the committed feature collections --------------------------
  const collections = useMemo(() => {
    if (!committedVisible) {
      return {
        polygons: EMPTY_FC,
        lines: EMPTY_FC,
        labels: EMPTY_FC,
      }
    }
    return doorsToFeatureCollections(doors)
  }, [doors, committedVisible])

  // ---- Live preview FC --------------------------------------------------
  const preview = useMemo(() => {
    if (!livePreview) return null
    if (livePreview.vertices.length < 2) return null
    const v0 = livePreview.vertices[0]
    const v1 = livePreview.vertices[1]
    return buildDoorFeaturesRaw([v0, v1], livePreview.config, -1, 'preview')
  }, [livePreview])

  // ---- Built-door meshes ------------------------------------------------
  const meshData = useMemo(() => {
    const solid: LiftMeshData[] = []
    const glass: LiftMeshData[] = []
    if (committedVisible) {
      for (const d of doors) {
        if (!d.visible) continue
        const m = cachedDoorMeshes(d)
        if (!m) continue
        solid.push(m.solid)
        glass.push(m.glass)
      }
    }
    return { solid, glass }
  }, [doors, committedVisible])
  const meshLayersRef = useRef<{ solid: LiftMeshLayer; glass: LiftMeshLayer } | null>(null)
  if (meshLayersRef.current === null) {
    meshLayersRef.current = {
      solid: new LiftMeshLayer(MESH_LAYER),
      glass: new LiftMeshLayer(GLASS_MESH_LAYER, true),
    }
  }

  // ---- Mount sources + layers ------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return

    // Polygons (frame + leaves)
    if (!map.getSource(POLY_SOURCE)) {
      try {
        map.addSource(POLY_SOURCE, { type: 'geojson', data: EMPTY_FC, lineMetrics: true })
      } catch (err) {
        console.warn('[door-overlay] poly source failed', err)
        return
      }
    }
    if (!map.getLayer(FILL_LAYER)) {
      try {
        map.addLayer({
          id: FILL_LAYER,
          type: 'fill-extrusion',
          source: POLY_SOURCE,
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-base': ['to-number', ['get', 'base_height']],
            'fill-extrusion-height': ['to-number', ['get', 'height']],
            // Invisible click / hover target — the door is drawn by the
            // mesh layers. Mapbox skips drawing at 0 but still hit-tests.
            'fill-extrusion-opacity': 0,
            // Mapbox v3 shadow stack — same constants the line/stair
            // overlays use so doors blend visually with adjacent walls
            // and stairs (matching gradient, shadow cast, AO).
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
        console.warn('[door-overlay] fill layer failed', err)
      }
    }
    const meshLayers = meshLayersRef.current
    if (meshLayers) {
      try {
        if (!map.getLayer(MESH_LAYER)) map.addLayer(meshLayers.solid)
        if (!map.getLayer(GLASS_MESH_LAYER)) map.addLayer(meshLayers.glass)
      } catch (err) {
        console.warn('[door-overlay] mesh layers failed', err)
      }
    }
    if (!map.getLayer(OUTLINE_LAYER)) {
      try {
        map.addLayer({
          id: OUTLINE_LAYER,
          type: 'line',
          source: POLY_SOURCE,
          paint: {
            'line-color': '#1f2937',
            'line-width': 1.0,
            // The mesh shades its own edges; box-top outlines would float
            // around the built door.
            'line-opacity': 0,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': ['+', ['to-number', ['get', 'height']], 0.0005],
          },
        })
      } catch (err) {
        console.warn('[door-overlay] outline layer failed', err)
      }
    }
    if (!map.getLayer(SELECTION_LAYER)) {
      try {
        map.addLayer({
          id: SELECTION_LAYER,
          type: 'line',
          source: POLY_SOURCE,
          paint: {
            'line-color': '#f59e0b',
            'line-width': 2.5,
            'line-emissive-strength': 1,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': ['+', ['to-number', ['get', 'height']], 0.001],
          },
          // Default filter excludes everything; the selection-sync
          // effect rewrites this to match selected door ids.
          filter: ['==', ['get', 'doorId'], -1],
        })
      } catch (err) {
        console.warn('[door-overlay] selection layer failed', err)
      }
    }

    // Arcs
    if (!map.getSource(ARC_SOURCE)) {
      try {
        map.addSource(ARC_SOURCE, { type: 'geojson', data: EMPTY_FC, lineMetrics: true })
      } catch (err) {
        console.warn('[door-overlay] arc source failed', err)
        return
      }
    }
    if (!map.getLayer(ARC_LAYER)) {
      try {
        map.addLayer({
          id: ARC_LAYER,
          type: 'line',
          source: ARC_SOURCE,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1.2,
            'line-opacity': ['to-number', ['get', 'opacity']],
            'line-dasharray': [2.5, 1.5],
            'line-emissive-strength': 1,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': ['to-number', ['get', 'base_height']],
          },
        })
      } catch (err) {
        console.warn('[door-overlay] arc layer failed', err)
      }
    }

    // Labels
    if (!map.getSource(LABEL_SOURCE)) {
      try {
        map.addSource(LABEL_SOURCE, {
          type: 'geojson',
          data: EMPTY_FC,
          // Expose `properties.doorId` as the feature-state key so the
          // occlusion pass can `setFeatureState({id: doorId, occluded})`
          // without regenerating the whole FC on every camera move.
          // Each door produces exactly one label feature, so doorId is
          // a unique promoteId for the label source.
          promoteId: 'doorId',
        })
      } catch (err) {
        console.warn('[door-overlay] label source failed', err)
        return
      }
    }
    if (!map.getLayer(LABEL_LAYER)) {
      try {
        map.addLayer({
          id: LABEL_LAYER,
          type: 'symbol',
          source: LABEL_SOURCE,
          layout: {
            'text-field': ['get', 'text'],
            'text-size': ['to-number', ['get', 'textSize']],
            'text-anchor': 'center',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'symbol-z-elevate': true,
            // Note: `symbol-z-offset` was removed — it's not in the
            // Mapbox 3.25 style spec and emits an "unknown property"
            // warning. Doors sit at ground level so the offset was
            // effectively zero anyway. Re-add when we bump Mapbox.
          },
          paint: {
            'text-color': ['get', 'textColor'],
            // Fold analytic occlusion into text-opacity: hidden labels
            // become opacity 0 while everything else keeps the authored
            // per-feature opacity. Mirrors the text-label overlay pattern.
            'text-opacity': [
              'case',
              ['boolean', ['feature-state', 'occluded'], false],
              0,
              ['to-number', ['get', 'opacity']],
            ],
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.2,
            // Force x-ray (1) so the GL depth buffer doesn't second-guess
            // our analytic pass — same reasoning as map-text-label-overlay.
            'text-occlusion-opacity': 1,
          },
        })
      } catch (err) {
        console.warn('[door-overlay] label layer failed', err)
      }
    }

    // ---- In-flight sources + layers (transforming door) -----------------
    // Same paint recipes as the committed FILL/OUTLINE/ARC/LABEL layers so
    // the moving door renders identically. Single-feature sources so
    // buildDoorFeaturesRaw runs once per drag frame regardless of how
    // many doors exist in the warehouse. No filters — the sources
    // themselves are gated by the transform-active population effect.
    if (!map.getSource(POLY_INFLIGHT_SOURCE)) {
      try {
        map.addSource(POLY_INFLIGHT_SOURCE, { type: 'geojson', data: EMPTY_FC, lineMetrics: true })
      } catch (err) {
        console.warn('[door-overlay] poly inflight source failed', err)
      }
    }
    if (!map.getLayer(FILL_INFLIGHT_LAYER)) {
      try {
        map.addLayer({
          id: FILL_INFLIGHT_LAYER,
          type: 'fill-extrusion',
          source: POLY_INFLIGHT_SOURCE,
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-base': ['to-number', ['get', 'base_height']],
            'fill-extrusion-height': ['to-number', ['get', 'height']],
            // Hit target only; the moving door's mesh is pushed live.
            'fill-extrusion-opacity': 0,
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
        console.warn('[door-overlay] fill inflight layer failed', err)
      }
    }
    if (!map.getLayer(OUTLINE_INFLIGHT_LAYER)) {
      try {
        map.addLayer({
          id: OUTLINE_INFLIGHT_LAYER,
          type: 'line',
          source: POLY_INFLIGHT_SOURCE,
          paint: {
            'line-color': '#1f2937',
            'line-width': 1.0,
            // The mesh shades its own edges; box-top outlines would float
            // around the built door.
            'line-opacity': 0,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': ['+', ['to-number', ['get', 'height']], 0.0005],
          },
        })
      } catch (err) {
        console.warn('[door-overlay] outline inflight layer failed', err)
      }
    }
    // Selection halo on the in-flight source — mirrors SELECTION_LAYER
    // but reads POLY_INFLIGHT_SOURCE. No filter needed (source only
    // holds the one transforming door). Theme-tinted via the same
    // paint-color effect that already targets SELECTION_LAYER.
    if (!map.getLayer(SELECTION_INFLIGHT_LAYER)) {
      try {
        map.addLayer({
          id: SELECTION_INFLIGHT_LAYER,
          type: 'line',
          source: POLY_INFLIGHT_SOURCE,
          paint: {
            'line-color': '#f59e0b',
            'line-width': 2.5,
            'line-emissive-strength': 1,
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': ['+', ['to-number', ['get', 'height']], 0.001],
          },
        })
      } catch (err) {
        console.warn('[door-overlay] selection inflight layer failed', err)
      }
    }
    if (!map.getSource(ARC_INFLIGHT_SOURCE)) {
      try {
        map.addSource(ARC_INFLIGHT_SOURCE, { type: 'geojson', data: EMPTY_FC, lineMetrics: true })
      } catch (err) {
        console.warn('[door-overlay] arc inflight source failed', err)
      }
    }
    if (!map.getLayer(ARC_INFLIGHT_LAYER)) {
      try {
        map.addLayer({
          id: ARC_INFLIGHT_LAYER,
          type: 'line',
          source: ARC_INFLIGHT_SOURCE,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1.2,
            'line-opacity': ['to-number', ['get', 'opacity']],
            'line-dasharray': [2.5, 1.5],
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': ['to-number', ['get', 'base_height']],
          },
        })
      } catch (err) {
        console.warn('[door-overlay] arc inflight layer failed', err)
      }
    }
    if (!map.getSource(LABEL_INFLIGHT_SOURCE)) {
      try {
        map.addSource(LABEL_INFLIGHT_SOURCE, { type: 'geojson', data: EMPTY_FC })
      } catch (err) {
        console.warn('[door-overlay] label inflight source failed', err)
      }
    }
    if (!map.getLayer(LABEL_INFLIGHT_LAYER)) {
      try {
        map.addLayer({
          id: LABEL_INFLIGHT_LAYER,
          type: 'symbol',
          source: LABEL_INFLIGHT_SOURCE,
          layout: {
            'text-field': ['get', 'text'],
            'text-size': ['to-number', ['get', 'textSize']],
            'text-anchor': 'center',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'symbol-z-elevate': true,
            // See LABEL_LAYER: symbol-z-offset removed for spec drift.
          },
          paint: {
            'text-color': ['get', 'textColor'],
            'text-opacity': ['to-number', ['get', 'opacity']],
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.2,
          },
        })
      } catch (err) {
        console.warn('[door-overlay] label inflight layer failed', err)
      }
    }
  }, [map, styleLoaded, styleGen])

  // ---- Push committed data ---------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const polySrc = map.getSource(POLY_SOURCE) as GeoJSONSource | undefined
    const arcSrc = map.getSource(ARC_SOURCE) as GeoJSONSource | undefined
    const labelSrc = map.getSource(LABEL_SOURCE) as GeoJSONSource | undefined
    polySrc?.setData(collections.polygons as Parameters<GeoJSONSource['setData']>[0])
    arcSrc?.setData(collections.lines as Parameters<GeoJSONSource['setData']>[0])
    labelSrc?.setData(collections.labels as Parameters<GeoJSONSource['setData']>[0])
  }, [map, styleLoaded, styleGen, collections])

  // Built-door meshes. The transforming door is drawn from its live copy
  // (pushInflightMesh) instead.
  const baseMeshesRef = useRef(meshData)
  useEffect(() => {
    baseMeshesRef.current = meshData
    const layers = meshLayersRef.current
    if (!layers) return
    const skip = transformState ? `${transformState.doorId}:` : null
    layers.solid.setMeshes(skip ? meshData.solid.filter((m) => !m.key.startsWith(skip)) : meshData.solid)
    layers.glass.setMeshes(skip ? meshData.glass.filter((m) => !m.key.startsWith(skip)) : meshData.glass)
  }, [meshData, transformState])
  const pushInflightMesh = useCallback(
    (id: number, vertices: [[number, number], [number, number]], config: DoorConfig) => {
      const layers = meshLayersRef.current
      if (!layers) return
      const m = doorMeshes(id, vertices, config)
      const prefix = `${id}:`
      const base = baseMeshesRef.current
      layers.solid.setMeshes([...base.solid.filter((x) => !x.key.startsWith(prefix)), ...(m ? [m.solid] : [])])
      layers.glass.setMeshes([...base.glass.filter((x) => !x.key.startsWith(prefix)), ...(m ? [m.glass] : [])])
    },
    [],
  )
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

  // ---- Label occlusion (same solver as markers / text labels) ----------
  // Door labels sit at the top of the door (elevation + doorHeight) and
  // otherwise poke through 3D geometry the same way text labels did
  // before v5.4. Run the analytic solver on every `move` and flip
  // `feature-state.occluded` on the label source so the layer's paint
  // expression fades the hidden ones to opacity 0.
  const occludeImages = occluders?.images
  const occludePolygons = occluders?.polygons
  const occludeCircles = occluders?.circles
  const occludeLines = occluders?.lines
  const occludeStairs = occluders?.stairs
  const occludeGrids = occluders?.grids
  const prisms = useMemo(
    () =>
      occlusionEnabled
        ? buildOccluders({
            images: occludeImages,
            polygons: occludePolygons,
            circles: occludeCircles,
            lines: occludeLines,
            stairs: occludeStairs,
            grids: occludeGrids,
          })
        : [],
    [
      occlusionEnabled,
      occludeImages,
      occludePolygons,
      occludeCircles,
      occludeLines,
      occludeStairs,
      occludeGrids,
    ],
  )
  const occludedIdsRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (!map || !styleLoaded) return
    const targets: OccludableTarget[] = []
    if (committedVisible) {
      for (const d of doors) {
        if (d.id === undefined) continue
        if (d.visible === false) continue
        const [v0, v1] = d.vertices
        const position: [number, number] = [
          (v0[0] + v1[0]) / 2,
          (v0[1] + v1[1]) / 2,
        ]
        // Label rides at the door's top — same altitude the generator
        // stamps on the label feature's `base_height`.
        const elevationM =
          (d.config.elevation ?? 0) + Math.max(0.01, d.config.doorHeight ?? 0)
        targets.push({
          id: d.id,
          position,
          elevationM,
          floorPlanId: d.floorPlanId,
        })
      }
    }
    const apply = () => {
      const nextOccluded = computeOccludedIds(map, targets, prisms)
      const prev = occludedIdsRef.current
      for (const id of prev) {
        if (nextOccluded.has(id)) continue
        try {
          map.setFeatureState(
            { source: LABEL_SOURCE, id },
            { occluded: false },
          )
        } catch { /* source went away */ }
      }
      for (const id of nextOccluded) {
        try {
          map.setFeatureState(
            { source: LABEL_SOURCE, id },
            { occluded: true },
          )
        } catch { /* source went away */ }
      }
      occludedIdsRef.current = nextOccluded
    }
    apply()
    map.on('move', apply)
    return () => {
      map.off('move', apply)
    }
  }, [map, styleLoaded, doors, prisms, committedVisible])

  // ---- Selection filter ------------------------------------------------
  // Composes with the transform exclusion — while a transform is
  // active, the halo is suppressed on the committed source and picked
  // up by SELECTION_INFLIGHT_LAYER (which reads POLY_INFLIGHT_SOURCE
  // and has no filter). This mirrors the line overlay pattern.
  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!map.getLayer(SELECTION_LAYER)) return
    const ids = selectedDoorIds && selectedDoorIds.size > 0 ? [...selectedDoorIds] : []
    const idFilter =
      ids.length === 0
        ? ['==', ['get', 'doorId'], -1]
        : ids.length === 1
          ? ['==', ['get', 'doorId'], ids[0]]
          : ['in', ['get', 'doorId'], ['literal', ids]]
    const excludeId = transformState?.doorId
    const filter = excludeId != null
      ? ['all', idFilter, ['!=', ['get', 'doorId'], excludeId]]
      : idFilter
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.setFilter(SELECTION_LAYER, filter as any)
    } catch {
      /* ignore */
    }
  }, [map, styleLoaded, styleGen, selectedDoorIds, transformState])

  // ---- Exclusion filter (committed base layers) ------------------------
  // While a transform is active, hide the moving door from the
  // committed FILL / OUTLINE / ARC / LABEL layers so it doesn't render
  // twice (once at its stale committed geometry, once on the in-flight
  // source at its live drag position). Cleared when no transform is
  // active. Same pattern as the line overlay.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const excludeId = transformState?.doorId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: any = excludeId != null
      ? ['!=', ['get', 'doorId'], excludeId]
      : null
    for (const id of [FILL_LAYER, OUTLINE_LAYER, ARC_LAYER, LABEL_LAYER]) {
      try {
        if (map.getLayer(id)) map.setFilter(id, filter)
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, transformState])

  // Theme-tint the selection outline (committed + in-flight).
  // setPaintProperty is a no-op when the colour hasn't changed, so
  // this is safe to run per render.
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const id of [SELECTION_LAYER, SELECTION_INFLIGHT_LAYER]) {
      try {
        if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', primaryHex)
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, primaryHex])

  // Keep the selection outline, in-flight surfaces, and transform handle
  // at the top of the layer stack — otherwise late-added overlays can
  // push above. Deps include `transformState` so the transform layer
  // re-elevates the moment the user clicks Move / Rotate / Scale;
  // omitting it hides the handle behind overlays that mounted after us.
  // `transformState` doesn't churn during drag (RAF bypass keeps it
  // stable), so per-frame cost is nil.
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const id of [
      FILL_INFLIGHT_LAYER,
      OUTLINE_INFLIGHT_LAYER,
      ARC_INFLIGHT_LAYER,
      LABEL_INFLIGHT_LAYER,
      SELECTION_LAYER,
      SELECTION_INFLIGHT_LAYER,
      TRANSFORM_LAYER,
    ]) {
      try {
        if (map.getLayer(id)) map.moveLayer(id)
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, transformState])

  // ---- Live preview: polygons + arc + guide line -----------------------
  useEffect(() => {
    if (!map || !styleLoaded) return

    // Strip preview layers/sources when no preview is active.
    if (!preview || !livePreview) {
      for (const id of [PREVIEW_POLY_LAYER, PREVIEW_ARC_LAYER, PREVIEW_GUIDE_LAYER]) {
        if (map.getLayer(id)) {
          try { map.removeLayer(id) } catch { /* ignore */ }
        }
      }
      for (const id of [PREVIEW_POLY_SOURCE, PREVIEW_ARC_SOURCE, PREVIEW_GUIDE_SOURCE]) {
        if (map.getSource(id)) {
          try { map.removeSource(id) } catch { /* ignore */ }
        }
      }
      return
    }

    const polyFC = { type: 'FeatureCollection' as const, features: preview.polygons }
    const arcFC = { type: 'FeatureCollection' as const, features: preview.lines }

    if (!map.getSource(PREVIEW_POLY_SOURCE)) {
      try {
        map.addSource(PREVIEW_POLY_SOURCE, { type: 'geojson', data: polyFC })
      } catch (err) {
        console.warn('[door-overlay] preview poly source failed', err)
      }
    } else {
      const src = map.getSource(PREVIEW_POLY_SOURCE) as GeoJSONSource
      src.setData(polyFC as Parameters<GeoJSONSource['setData']>[0])
    }
    if (!map.getLayer(PREVIEW_POLY_LAYER)) {
      try {
        map.addLayer({
          id: PREVIEW_POLY_LAYER,
          type: 'fill-extrusion',
          source: PREVIEW_POLY_SOURCE,
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            'fill-extrusion-base': ['to-number', ['get', 'base_height']],
            'fill-extrusion-height': ['to-number', ['get', 'height']],
            'fill-extrusion-opacity': 0.55,
            // Same shadow stack as the committed layer so the preview
            // looks like the real thing (with reduced opacity).
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
        console.warn('[door-overlay] preview poly layer failed', err)
      }
    }

    if (!map.getSource(PREVIEW_ARC_SOURCE)) {
      try {
        map.addSource(PREVIEW_ARC_SOURCE, { type: 'geojson', data: arcFC })
      } catch (err) {
        console.warn('[door-overlay] preview arc source failed', err)
      }
    } else {
      const src = map.getSource(PREVIEW_ARC_SOURCE) as GeoJSONSource
      src.setData(arcFC as Parameters<GeoJSONSource['setData']>[0])
    }
    if (!map.getLayer(PREVIEW_ARC_LAYER)) {
      try {
        map.addLayer({
          id: PREVIEW_ARC_LAYER,
          type: 'line',
          source: PREVIEW_ARC_SOURCE,
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1.2,
            'line-opacity': 0.55,
            'line-dasharray': [2.5, 1.5],
          },
          layout: {
            'line-elevation-reference': 'sea',
            'line-z-offset': ['to-number', ['get', 'base_height']],
          },
        })
      } catch (err) {
        console.warn('[door-overlay] preview arc layer failed', err)
      }
    }

    // Guide line from v0 to cursor — gives the user immediate
    // feedback on opening width as they drag.
    if (livePreview.vertices.length >= 2) {
      const v0 = livePreview.vertices[0]
      const v1 = livePreview.vertices[livePreview.vertices.length - 1]
      const guideElevation = livePreview.config.elevation ?? 0
      const guide = {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            properties: { base_height: guideElevation },
            geometry: {
              type: 'LineString' as const,
              coordinates: [v0, v1] as [number, number][],
            },
          },
        ],
      }
      if (!map.getSource(PREVIEW_GUIDE_SOURCE)) {
        try {
          map.addSource(PREVIEW_GUIDE_SOURCE, { type: 'geojson', data: guide })
        } catch (err) {
          console.warn('[door-overlay] preview guide source failed', err)
        }
      } else {
        const src = map.getSource(PREVIEW_GUIDE_SOURCE) as GeoJSONSource
        src.setData(guide as Parameters<GeoJSONSource['setData']>[0])
      }
      if (!map.getLayer(PREVIEW_GUIDE_LAYER)) {
        try {
          map.addLayer({
            id: PREVIEW_GUIDE_LAYER,
            type: 'line',
            source: PREVIEW_GUIDE_SOURCE,
            paint: {
              'line-color': '#f59e0b',
              'line-width': 1.5,
              'line-opacity': 0.85,
              'line-dasharray': [1.5, 1.5],
            },
            layout: {
              'line-elevation-reference': 'sea',
              'line-z-offset': ['to-number', ['get', 'base_height']],
            },
          })
        } catch (err) {
          console.warn('[door-overlay] preview guide layer failed', err)
        }
      }
    }
  }, [map, styleLoaded, styleGen, preview, livePreview])

  // ---- Click selection --------------------------------------------------
  const onDoorClickRef = useRef(onDoorClick)
  const onMapClickEmptyRef = useRef(onMapClickEmpty)
  const selectionEnabledRef = useRef(selectionEnabled)
  useEffect(() => { onDoorClickRef.current = onDoorClick }, [onDoorClick])
  useEffect(() => { onMapClickEmptyRef.current = onMapClickEmpty }, [onMapClickEmpty])
  useEffect(() => { selectionEnabledRef.current = selectionEnabled }, [selectionEnabled])

  useEffect(() => {
    if (!map || !styleLoaded) return
    const HIT_BUFFER = 4

    const onClick = (e: MapMouseEvent) => {
      if (!selectionEnabledRef.current) return
      // Cross-overlay click protocol: every shape overlay marks
      // `defaultPrevented` on BOTH the Mapbox `MapMouseEvent` and the
      // underlying DOM event after a successful hit, and bails on
      // either flag when it sees one. Without checking both, a
      // neighbouring overlay (which previously won the race and
      // claimed the click) can still re-route this handler into the
      // empty-click path and clobber the selection we are about to
      // set. Matches the contract used by map-polygon-overlay.
      if (e.defaultPrevented) return
      if (e.originalEvent?.defaultPrevented) return
      // Defer to higher-priority kinds at the click point.
      if (higherPriorityAt(map, e.point, 'door')) return
      const bbox: [[number, number], [number, number]] = [
        [e.point.x - HIT_BUFFER, e.point.y - HIT_BUFFER],
        [e.point.x + HIT_BUFFER, e.point.y + HIT_BUFFER],
      ]
      let hits: GeoJSON.Feature[]
      try {
        // Query every visible door layer at the click point. Including
        // OUTLINE_LAYER lets the user click on a door's edge — which
        // is what most people aim for when the body of the door is
        // narrow at zoom-out — and still register a hit.
        hits = map.queryRenderedFeatures(bbox, {
          layers: [FILL_LAYER, OUTLINE_LAYER, ARC_LAYER, LABEL_LAYER].filter(
            (id) => map.getLayer(id),
          ),
        }) as GeoJSON.Feature[]
      } catch {
        return
      }
      if (hits.length === 0) {
        // Don't fire onMapClickEmpty if another overlay already
        // claimed the click for one of its own shapes — otherwise we
        // would clear that shape's selection on the same click that
        // set it. We've already bailed on `defaultPrevented` above,
        // so reaching here means no other overlay handled the click.
        onMapClickEmptyRef.current?.()
        return
      }
      const first = hits[0]
      const id = first.properties?.doorId
      if (typeof id !== 'number') return
      // Claim the click on BOTH event flavors so every other shape
      // overlay (regardless of which flag it checks) bails out.
      e.preventDefault()
      e.originalEvent?.preventDefault?.()
      onDoorClickRef.current?.(id, e.originalEvent as MouseEvent)
    }

    map.on('click', onClick)
    return () => { map.off('click', onClick) }
  }, [map, styleLoaded, styleGen])

  // ---- Visibility toggle (committed layers only) ------------------------
  // In-flight layers stay visible regardless — they only render when the
  // drag handler has pushed features to them, and a user hiding the
  // door layer mid-drag is a non-issue.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const visibility = committedVisible ? 'visible' : 'none'
    for (const id of [FILL_LAYER, OUTLINE_LAYER, ARC_LAYER, LABEL_LAYER, SELECTION_LAYER]) {
      if (!map.getLayer(id)) continue
      try { map.setLayoutProperty(id, 'visibility', visibility) } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, committedVisible])

  // ---- Transform handle (modeled on map-image-overlay) ------------------
  // Anchor placement per kind:
  //   - move   → midpoint of v0/v1 (centre of the opening).
  //   - rotate → a lever pulled 0.6 m out perpendicular to the opening
  //              on the swing-in side, so the visible drag direction
  //              maps naturally to angle change.
  //   - scale  → v1 (the end of the opening); dragging it grows/shrinks
  //              the door while keeping v0 anchored.
  const transformChangeRef = useRef(onTransformChange)
  useEffect(() => { transformChangeRef.current = onTransformChange }, [onTransformChange])

  const transformContext = useMemo(() => {
    if (!transformState) return null
    const door = doors.find((d) => d.id === transformState.doorId)
    if (!door) return null
    const [v0, v1] = door.vertices
    const center: [number, number] = [(v0[0] + v1[0]) / 2, (v0[1] + v1[1]) / 2]
    if (transformState.kind === 'move') {
      return { door, anchor: center, center }
    }
    if (transformState.kind === 'scale') {
      return { door, anchor: v1, center }
    }
    // rotate — perpendicular lever from centre.
    const dxLng = v1[0] - v0[0]
    const dyLat = v1[1] - v0[1]
    // Half-width in degrees so the lever sits a bit outside the door body.
    const halfLng = dxLng / 2
    const halfLat = dyLat / 2
    // Left-perpendicular in lng/lat space — visually close enough for
    // drag UX (rotation handle just needs a stable reference angle).
    const anchor: [number, number] = [center[0] - halfLat, center[1] + halfLng]
    return { door, anchor, center }
  }, [transformState, doors])

  // Mount the handle source + layer (one-time per style).
  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!map.getSource(TRANSFORM_SOURCE)) {
      try {
        map.addSource(TRANSFORM_SOURCE, { type: 'geojson', data: EMPTY_FC })
      } catch (err) {
        console.warn('[door-overlay] transform source failed', err)
        return
      }
    }
    // HMR guards — force-remove the old circle-typed halo + main
    // layers so the new symbol layer below actually mounts.
    const existingHalo = map.getStyle()?.layers?.find(
      (l) => l.id === TRANSFORM_LAYER_HALO,
    ) as { type?: string } | undefined
    if (existingHalo) {
      try { map.removeLayer(TRANSFORM_LAYER_HALO) } catch { /* ignore */ }
    }
    const existingMain = map.getStyle()?.layers?.find(
      (l) => l.id === TRANSFORM_LAYER,
    ) as { type?: string } | undefined
    if (existingMain && existingMain.type !== 'symbol') {
      try { map.removeLayer(TRANSFORM_LAYER) } catch { /* ignore */ }
    }
    // Single theme-tinted symbol layer. Icon-image driven by kind
    // (move cross / rotate curl / scale double-arrow). Door has 3
    // handle positions total (move → midpoint, rotate → perpendicular
    // lever, scale → v1) but ONLY ONE handle is ever shown at a time,
    // so a single layer is enough. z-elevate false + z-offset from
    // the feature's height (top of the door leaf) lifts the handle
    // to the door's own roof.
    if (!map.getLayer(TRANSFORM_LAYER)) {
      try {
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
            'symbol-z-elevate': false,
            'symbol-elevation-reference': 'sea',
          },
          paint: {
            'icon-emissive-strength': 1,
            'symbol-z-offset': [
              'coalesce',
              ['to-number', ['get', 'height']],
              0,
            ],
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any
        map.addLayer(transformLayerDef)
      } catch (err) {
        console.warn('[door-overlay] transform layer failed', err)
      }
    }
  }, [map, styleLoaded, styleGen])

  // Push handle position into the transform source.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    if (!transformContext || !transformState) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    // Compute door's top face altitude: elevation + doorHeight.
    // Feed this as `height` on the feature so the layer's
    // symbol-z-offset expression lands the handle on the door's
    // roof regardless of leaf/frame extrusion details.
    const doorTopAltitude =
      (transformContext.door.config.elevation ?? 0) +
      (transformContext.door.config.doorHeight ?? 0)
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
            height: doorTopAltitude,
          },
        },
      ],
    })
  }, [map, styleLoaded, styleGen, transformContext, transformState])

  // ---- In-flight source population --------------------------------------
  // When a transform starts, immediately push the target door's rendered
  // feature set (polygons + arcs + labels) into the in-flight sources so
  // the moving door is visible from the moment transformState flips
  // (before the user drags). On transform end, empties the sources so
  // no ghost feature lingers after the committed source rebuilds.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const polySrc = map.getSource(POLY_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    const arcSrc = map.getSource(ARC_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    const labelSrc = map.getSource(LABEL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    if (!transformState || !transformContext) {
      polySrc?.setData(EMPTY_FC)
      arcSrc?.setData(EMPTY_FC)
      labelSrc?.setData(EMPTY_FC)
      return
    }
    const door = transformContext.door
    const feats = buildDoorFeaturesRaw(
      door.vertices,
      door.config,
      door.id,
      door.name ?? 'door',
    )
    polySrc?.setData({ type: 'FeatureCollection', features: feats.polygons })
    arcSrc?.setData({ type: 'FeatureCollection', features: feats.lines })
    labelSrc?.setData({ type: 'FeatureCollection', features: feats.labels })
    pushInflightMesh(door.id, door.vertices, door.config)
  }, [map, styleLoaded, styleGen, transformState, transformContext, pushInflightMesh])

  // Mirror `transformContext` into a ref so the drag effect can read
  // the latest without listing it as a dep (re-mounting on every
  // context change tears down the mousedown/mousemove bindings mid-
  // drag). Fresh transformContext is captured once at drag start via
  // onMouseDown.
  const transformContextRef = useRef(transformContext)
  useEffect(() => {
    transformContextRef.current = transformContext
  }, [transformContext])

  // Drag — mousedown / RAF-coalesced mousemove / mouseup cycle. Bypasses
  // React state during drag: writes go straight to the in-flight sources
  // via setData; only mouseup fires `onTransformChange(patch, true)` to
  // commit. Since the store isn't touched between mousedown and mouseup,
  // the parent's `attachedDoorsByLineId` reference stays stable and the
  // line overlay's `wallFc` DOESN'T re-tessellate every wall on every
  // mousemove — the "wall recut cascade" is the biggest perf trap for
  // wall-attached doors, and this is where we sidestep it.
  const dragRef = useRef<{
    dragging: boolean
    kind: 'move' | 'rotate' | 'scale' | null
    originalDoor: DoorShape | null
    originalCenter: [number, number] | null
    originalAnchor: [number, number] | null
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
        originalDoor: null,
        originalCenter: null,
        originalAnchor: null,
        downHandleAngle: 0,
        pendingCursor: null,
        rafId: 0,
      }
    }
    const drag = dragRef.current
    const canvas = map.getCanvas()

    // Compute the next vertex pair for the current cursor. Returns null
    // when the drag state is incomplete.
    const computeNext = (
      cursor: [number, number],
    ): [[number, number], [number, number]] | null => {
      const orig = drag.originalDoor?.vertices
      const center = drag.originalCenter
      const anchor = drag.originalAnchor
      if (!orig || !center || !anchor) return null
      if (drag.kind === 'rotate') {
        const newAngle = Math.atan2(cursor[1] - center[1], cursor[0] - center[0])
        const deltaDeg = ((newAngle - drag.downHandleAngle) * 180) / Math.PI
        return rotateDoorVertices(orig, deltaDeg)
      }
      if (drag.kind === 'scale') {
        const [v0] = orig
        const dxLng = cursor[0] - v0[0]
        const dyLat = cursor[1] - v0[1]
        const midLat = (v0[1] + cursor[1]) / 2
        const dxM = dxLng * 111_320 * Math.cos((midLat * Math.PI) / 180)
        const dyM = dyLat * 111_320
        const newWidth = Math.max(0.1, Math.hypot(dxM, dyM))
        return resizeDoorVertices(orig, newWidth)
      }
      // Move
      const dLng = cursor[0] - anchor[0]
      const dLat = cursor[1] - anchor[1]
      const [v0, v1] = orig
      return [
        [v0[0] + dLng, v0[1] + dLat],
        [v1[0] + dLng, v1[1] + dLat],
      ]
    }

    // Compute where the transform handle sits for a given vertex pair.
    // Kept in sync with the `transformContext` memo above so the handle
    // tracks the moving door consistently.
    const handleAnchorFor = (
      nextVerts: [[number, number], [number, number]],
    ): [number, number] => {
      const [v0, v1] = nextVerts
      const center: [number, number] = [
        (v0[0] + v1[0]) / 2,
        (v0[1] + v1[1]) / 2,
      ]
      if (drag.kind === 'move') return center
      if (drag.kind === 'scale') return v1
      const dxLng = v1[0] - v0[0]
      const dyLat = v1[1] - v0[1]
      const halfLng = dxLng / 2
      const halfLat = dyLat / 2
      return [center[0] - halfLat, center[1] + halfLng]
    }

    // Push feature set + handle into the in-flight sources. Cost per
    // frame: 1 × buildDoorFeaturesRaw + 4 × setData.
    const pushInflight = (nextVerts: [[number, number], [number, number]]) => {
      const orig = drag.originalDoor
      if (!orig) return
      const feats = buildDoorFeaturesRaw(
        nextVerts,
        orig.config,
        orig.id,
        orig.name ?? 'door',
      )
      const polySrc = map.getSource(POLY_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      const arcSrc = map.getSource(ARC_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      const labelSrc = map.getSource(LABEL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      polySrc?.setData({ type: 'FeatureCollection', features: feats.polygons })
      arcSrc?.setData({ type: 'FeatureCollection', features: feats.lines })
      labelSrc?.setData({ type: 'FeatureCollection', features: feats.labels })
      pushInflightMesh(orig.id, nextVerts, orig.config)
      // Follow the moving door with the transform handle.
      const transformSrc = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
      if (transformSrc && drag.kind) {
        const doorTopAltitude =
          (orig.config.elevation ?? 0) + (orig.config.doorHeight ?? 0)
        transformSrc.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: {
                type: 'Point',
                coordinates: handleAnchorFor(nextVerts),
              },
              properties: {
                kind: drag.kind,
                iconId: TRANSFORM_ICON[drag.kind],
                height: doorTopAltitude,
              },
            },
          ],
        })
      }
    }

    // RAF flusher — runs at most once per paint frame regardless of how
    // many mousemove events Mapbox fires between paints.
    const flushDragFrame = () => {
      drag.rafId = 0
      if (!drag.dragging || !drag.pendingCursor) return
      const next = computeNext(drag.pendingCursor)
      if (!next) return
      pushInflight(next)
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
      drag.originalDoor = ctx.door
      drag.originalCenter = ctx.center
      drag.originalAnchor = ctx.anchor
      drag.downHandleAngle = Math.atan2(
        ctx.anchor[1] - ctx.center[1],
        ctx.anchor[0] - ctx.center[0],
      )
      map.dragPan.disable()
      canvas.style.cursor =
        transformState.kind === 'rotate'
          ? 'crosshair'
          : transformState.kind === 'scale'
            ? 'nwse-resize'
            : 'grabbing'
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
      // effect will empty the sources.
      if (drag.rafId !== 0) {
        cancelAnimationFrame(drag.rafId)
        drag.rafId = 0
      }
      drag.pendingCursor = null
      const next = computeNext(cursor)
      // Clear original state BEFORE calling into the parent — the
      // commit unsets transformState which re-runs the effect chain;
      // stale refs would otherwise confuse the next drag.
      drag.originalDoor = null
      drag.originalCenter = null
      drag.originalAnchor = null
      drag.kind = null
      if (next) transformChangeRef.current?.(next, true)
    }
    const onEnter = () => {
      if (!drag.dragging) {
        canvas.style.cursor =
          transformState.kind === 'rotate'
            ? 'crosshair'
            : transformState.kind === 'scale'
              ? 'nwse-resize'
              : 'grab'
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
  }, [map, styleLoaded, styleGen, transformState, pushInflightMesh])

  // Cleanup on unmount. Skip entirely if the map's style has already been
  // torn down — calling map.getLayer in that state throws because Mapbox's
  // internal style object is undefined. This happens when StrictMode (dev)
  // or the parent unmounts the MapboxMap before this effect's cleanup runs.
  useEffect(() => {
    return () => {
      if (!map) return
      // `map.style` is internal but the only reliable way to check whether
      // the style has been disposed; `_removed` is set by Mapbox after remove().
      const style = (map as unknown as { style?: unknown; _removed?: boolean }).style
      const removed = (map as unknown as { _removed?: boolean })._removed
      if (!style || removed) return
      const layers = [
        TRANSFORM_LAYER, TRANSFORM_LAYER_HALO,
        PREVIEW_GUIDE_LAYER, PREVIEW_ARC_LAYER, PREVIEW_POLY_LAYER,
        LABEL_INFLIGHT_LAYER, ARC_INFLIGHT_LAYER,
        SELECTION_INFLIGHT_LAYER, OUTLINE_INFLIGHT_LAYER, FILL_INFLIGHT_LAYER,
        LABEL_LAYER, ARC_LAYER, SELECTION_LAYER, OUTLINE_LAYER, FILL_LAYER,
      ]
      const sources = [
        TRANSFORM_SOURCE,
        PREVIEW_GUIDE_SOURCE, PREVIEW_ARC_SOURCE, PREVIEW_POLY_SOURCE,
        LABEL_INFLIGHT_SOURCE, ARC_INFLIGHT_SOURCE, POLY_INFLIGHT_SOURCE,
        LABEL_SOURCE, ARC_SOURCE, POLY_SOURCE,
      ]
      for (const id of layers) {
        try {
          if (map.getLayer(id)) map.removeLayer(id)
        } catch { /* style torn down mid-cleanup */ }
      }
      for (const id of sources) {
        try {
          if (map.getSource(id)) map.removeSource(id)
        } catch { /* style torn down mid-cleanup */ }
      }
    }
  }, [map])

  return null
}
