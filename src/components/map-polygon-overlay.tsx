import {
  buildPolygonChainFeature,
  buildPolygonFeature,
  buildPolygonFeatureCollection,
  polygonCentroid,
  type PolygonProps,
} from '@/lib/polygon-generators'
import { destination as turfDestination, point as turfPoint } from '@turf/turf'
import { rotatePointAround } from '@/lib/image-generators'
import { higherPriorityAt } from '@/lib/overlay-hit-priority'
import type { PolygonShape } from '@/lib/shapes'
import {
  TRANSFORM_ICON,
  readThemePrimaryForegroundHex,
  readThemePrimaryHex,
  registerTransformHandleIcons,
  subscribeThemeChanges,
} from '@/lib/map-transform-handles'
import type { GeoJSONSource, Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import { useEffect, useMemo, useRef, useState } from 'react'

interface MapPolygonOverlayProps {
  map: MapboxMapInstance | null
  polygons?: ReadonlyArray<PolygonShape>
  /** Live-draw vertex chain — committed-but-not-saved points. */
  liveVertices?: ReadonlyArray<[number, number]>
  /** Cursor lng/lat for the "next edge" preview. Null when no draw is active. */
  liveCursor?: [number, number] | null
  /**
   * Style for the in-progress draw preview. When the chain reaches ≥3
   * points it materializes as a translucent fill of this color too.
   */
  liveConfig?: PolygonShape['config']
  selectedPolygonIds?: ReadonlySet<number>
  onPolygonClick?: (id: number, originalEvent: MouseEvent) => void
  onMapClickEmpty?: () => void
  committedVisible?: boolean
  selectionEnabled?: boolean
  /**
   * When true, bypass the `higherPriorityAt` bail and the
   * `defaultPrevented` bail so the polygon fill claims the click even
   * when a higher-priority overlay (marker, model, stair, door, line,
   * text) sits above it. Used by /view's route-picking mode where the
   * user's intent is "capture whichever polygon my cursor is over".
   * Defaults to false — normal selection flows are unchanged.
   */
  forceClickCapture?: boolean
  transformState?: { polygonId: number; kind: 'move' | 'rotate' | 'edit' } | null
  onTransformChange?: (
    patch: {
      vertices?: [number, number][]
      rotation?: number
    },
    commit: boolean
  ) => void
  /**
   * Per-shape style overrides pushed in by the style-rules engine. When a
   * polygon id is present in this map, its paint props are replaced with
   * the override values at build time.
   */
  shapeStyleOverrides?: ReadonlyMap<number, import('@/lib/polygon-generators').PolygonStyleOverride> | null
}

const FILL_SOURCE = 'polygon-fill-source'
const LINE_LAYER = 'polygon-line-layer'

// `fill-extrusion-opacity` rejects ALL data expressions (including
// feature-state) in Mapbox GL JS 3.x. To still get per-shape opacity in
// 3D we precreate N layers — one per discrete opacity bucket (every 10%) —
// each carrying its own constant `fill-extrusion-opacity`. The
// generator stamps `properties.opacityBucket` (0, 10, …, 100) and each
// layer's filter routes the feature into the matching bucket.
const OPACITY_BUCKETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const
const EXTRUDE_LAYER_BASE = 'polygon-extrude-layer'
const EXTRUDE_LAYER_IDS = OPACITY_BUCKETS.map((b) => `${EXTRUDE_LAYER_BASE}-op${b}`)
const extrudeLayerId = (bucket: number) => `${EXTRUDE_LAYER_BASE}-op${bucket}`

// Minimum `fill-extrusion-base` for every polygon slab, so a "flat"
// polygon (user elevation = 0, height = 0) still renders as a
// paper-thin extrusion sitting above a ground-floor plan. The plan now
// renders at its exact elevation (FloorPlanLayer, which also loses any
// coplanar depth tie on purpose), so this is margin rather than a fix;
// it dates from the old elevated raster, which sat at 0.1 m. 11 cm is
// imperceptible at warehouse scale.
const POLYGON_MIN_BASE_M = 0.11
const SELECTION_LAYER = 'polygon-selection-line-layer'
const SELECTION_TINT_LAYER = 'polygon-selection-tint-layer'
const LABEL_SOURCE = 'polygon-label-source'
// Billboard label — screen-space, always facing camera. Handles the
// `labelFlat != true` case (the default).
const LABEL_LAYER = 'polygon-label-layer'
// Flat label — lies on the polygon's top face, pitches and rotates
// with the map. Handles the `labelFlat == true` case. Two layers are
// needed because `text-pitch-alignment` / `text-rotation-alignment`
// are not data-driven in Mapbox GL JS 3.x.
const LABEL_LAYER_FLAT = 'polygon-label-layer-flat'
const CLIP_SOURCE = 'polygon-clip-source'
const CLIP_LAYER = 'polygon-clip-layer'
const CHAIN_SOURCE = 'polygon-chain-source'
const CHAIN_LINE_LAYER = 'polygon-chain-line-layer'
const CHAIN_VERTEX_LAYER = 'polygon-chain-vertex-layer'
const TRANSFORM_SOURCE = 'polygon-transform-source'
const TRANSFORM_LAYER = 'polygon-transform-layer'
const TRANSFORM_ICON_LAYER = 'polygon-transform-icon-layer'
// Per-vertex edit handles. `VERTEX_LAYER` is a solid orange circle at
// every polygon vertex; `MIDPOINT_LAYER` is a smaller hollow circle at
// each edge midpoint the user can click to insert a new vertex there.
// The two feed the same GeoJSON source (routed by `kind` filter) so
// drag hit-testing does a single query.
const EDIT_HANDLES_SOURCE = 'polygon-edit-handles-source'
const VERTEX_LAYER = 'polygon-edit-vertex-layer'
const MIDPOINT_LAYER = 'polygon-edit-midpoint-layer'
// In-flight sources — hold ONLY the polygon currently being moved /
// rotated / edited. Filter out the transforming id from the committed
// EXTRUDE-op* / LINE / LABEL layers while the drag is live, and push
// the fresh geometry into the in-flight source from the drag handler's
// RAF. Same pattern as the line/door/image overlays. The extrude
// in-flight layer is a single fill-extrusion (opacity is set as a
// constant paint prop from the transforming polygon's config on
// transform start — Mapbox 3.x rejects data expressions on
// `fill-extrusion-opacity`).
const FILL_INFLIGHT_SOURCE = 'polygon-fill-inflight-source'
const EXTRUDE_INFLIGHT_LAYER = 'polygon-extrude-inflight-layer'
const LINE_INFLIGHT_LAYER = 'polygon-line-inflight-layer'
const SELECTION_INFLIGHT_LAYER = 'polygon-selection-inflight-layer'
const SELECTION_TINT_INFLIGHT_LAYER = 'polygon-selection-tint-inflight-layer'
const LABEL_INFLIGHT_SOURCE = 'polygon-label-inflight-source'
const LABEL_INFLIGHT_LAYER = 'polygon-label-inflight-layer'

/**
 * Polygon rendering — fill / extrusion / border / clip / labels, plus
 * a live-draw layer for the in-progress vertex chain and a transform
 * handle for move/rotate. Mirrors MapCircleOverlay's architecture so
 * the visual + interaction patterns stay consistent across shape kinds.
 */
export function MapPolygonOverlay({
  map,
  polygons,
  liveVertices,
  liveCursor,
  liveConfig,
  selectedPolygonIds,
  onPolygonClick,
  onMapClickEmpty,
  committedVisible = true,
  selectionEnabled = true,
  transformState = null,
  onTransformChange,
  shapeStyleOverrides = null,
  forceClickCapture = false,
}: MapPolygonOverlayProps) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  // `styleGen` increments on every `style.load` event. Including it in
  // the source/layer setup effect's deps forces a clean re-mount on
  // every basemap swap — Mapbox wipes all user-added layers when the
  // new style loads, so the effect's cleanup runs (a no-op because the
  // layers are already gone) and the body re-adds them. Without this,
  // a swap leaves `styleLoaded` already true and the setup effect
  // never re-runs, so layers stay removed.
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

  // (Removed) The old URL-polling effect detected style swaps by
  // diffing `style.sprite`/`style.name` and flipped `styleLoaded` to
  // force a re-mount. Now obsolete: the `style.load` listener above
  // bumps `styleGen` on every swap, and that counter is in every
  // effect's deps below, so setup re-runs deterministically. Leaving
  // the polling in fought the new mechanism by resetting `styleLoaded`
  // after a swap when there was nothing to bring it back.

  // ---- Theme-tinted handle icons -----------------------------------------
  // Read `--primary` / `--primary-foreground` and subscribe to `<html>`
  // classlist changes so palette / light-dark toggles re-tint every
  // handle without a page reload. See `map-image-overlay.tsx` for the
  // same pattern; the shared helper lives at `@/lib/map-transform-handles`.
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
  // Re-register icons on every relevant change. Mapbox drops all
  // registered images on style swap, so `styleGen` re-runs this.
  useEffect(() => {
    if (!map || !styleLoaded) return
    registerTransformHandleIcons(map, primaryHex, primaryFgHex)
  }, [map, styleLoaded, styleGen, primaryHex, primaryFgHex])

  // ---- Data --------------------------------------------------------------
  // Live preview polygon — appears once the user has dropped at least 2
  // vertices and the cursor is tracking (so the closed ring has ≥3 points).
  // Mirrors MapCircleOverlay's pattern: the preview rides in the same fill
  // FeatureCollection as committed shapes so it picks up all the same paint
  // (fill + extrusion + clip). The chain layer below still renders dots +
  // dashed edges so the user can see exactly where each click landed.
  const livePreview = useMemo<PolygonShape | null>(() => {
    if (!liveConfig) return null
    const verts = (liveVertices ?? []) as [number, number][]
    const ring: [number, number][] = liveCursor ? [...verts, liveCursor] : verts
    if (ring.length < 3) return null
    return {
      name: '',
      vertices: ring,
      rotation: 0,
      visible: true,
      unit: 'm',
      config: liveConfig,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  }, [liveVertices, liveCursor, liveConfig])

  const fc = useMemo(
    () => buildPolygonFeatureCollection(polygons ?? [], livePreview, shapeStyleOverrides),
    [polygons, livePreview, shapeStyleOverrides]
  )

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

  // Label data — one Point per polygon at its centroid. Mirrors the grid
  // overlay pattern: a Polygon-source symbol layer interacts unreliably
  // with `symbol-z-offset` / `symbol-z-elevate`, but a Point source with
  // an explicit altitude lifts cleanly. The centroid is rotation-invariant
  // (polygon rotation pivots on the centroid) so we can compute it from
  // the unrotated vertex array.
  const labelPointData = useMemo<
    GeoJSON.FeatureCollection<GeoJSON.Point, PolygonProps> | null
  >(() => {
    const list = polygons ?? []
    if (list.length === 0) return null
    const features: GeoJSON.Feature<GeoJSON.Point, PolygonProps>[] = []
    for (const s of list) {
      if (s.visible === false) continue
      if (!s.config.showLabels) continue
      // No name-fallback — an empty Label field means no label rendered.
      // Match the rule used by polygon-generators.propsFor.
      const labelText = s.config.label?.trim() ?? ''
      if (labelText === '') continue
      const center = polygonCentroid(s.vertices)
      if (!center || s.id === undefined) continue
      // Apply the user's label offset (meters, in the polygon's local
      // unrotated frame). turf.destination converts a bearing +
      // distance from the centroid into a lng/lat, staying accurate at
      // any latitude without our own meters→degrees math. Bearing is
      // clockwise from north; adding `s.rotation` matches turf's
      // `transformRotate` sign convention (used for the polygon's own
      // rotation elsewhere), so the offset rotates WITH the shape.
      const offX = s.config.labelOffsetX ?? 0
      const offY = s.config.labelOffsetY ?? 0
      let anchor: [number, number] = center
      if (offX !== 0 || offY !== 0) {
        const distance = Math.hypot(offX, offY)
        const localBearing = (Math.atan2(offX, offY) * 180) / Math.PI
        const bearing = localBearing + (s.rotation ?? 0)
        const moved = turfDestination(turfPoint(center), distance, bearing, {
          units: 'meters',
        })
        anchor = moved.geometry.coordinates as [number, number]
      }
      features.push({
        type: 'Feature',
        properties: {
          id: `polygon-label-${s.id}`,
          polygonId: s.id,
          color: s.config.color,
          borderColor: s.config.borderColor,
          borderWidth: s.config.borderWidth,
          opacity: s.config.opacity,
          opacityBucket: Math.max(0, Math.min(100, Math.round(s.config.opacity / 10) * 10)),
          colorRgba: '',
          elevation: s.config.elevation,
          height: s.config.height,
          showLabels: true,
          label: labelText,
          labelSize: s.config.labelSize,
          labelColor: s.config.labelColor,
          labelAltitude: s.config.labelAltitude,
          labelFlat: s.config.labelFlat ?? false,
          receiveShadows: s.config.receiveShadows ?? true,
        },
        geometry: { type: 'Point', coordinates: anchor },
      })
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [polygons])

  // Chain layer feeds two paint passes: a dashed line for the edges
  // and a circle layer at each committed vertex.
  const chainData = useMemo<
    GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.Point> | null
  >(() => {
    const verts = liveVertices ?? []
    if (verts.length === 0) return null
    const features: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.Point>[] = []
    if (liveConfig) {
      const chain = buildPolygonChainFeature(
        verts as [number, number][],
        liveCursor ?? null,
        liveConfig
      )
      if (chain) features.push(chain)
    }
    // Stamp `elevation` on the vertex Points so the chain vertex
    // layer can lift them to the tool's configured altitude via
    // `symbol-z-offset`. Only `elevation` — NOT `elevation + height`.
    // The draw tool defines WHERE the shape sits; `height` is the
    // shape's extrusion added on top after commit. Chaining at
    // elevation + height would show the guide floating on the ROOF of
    // a would-be extrusion, which isn't what the user is tracing.
    const vertexElev = liveConfig?.elevation ?? 0
    for (const v of verts) {
      features.push({
        type: 'Feature',
        properties: { elevation: vertexElev },
        geometry: { type: 'Point', coordinates: v },
      })
    }
    return { type: 'FeatureCollection', features }
  }, [liveVertices, liveCursor, liveConfig])

  // ---- Layer setup -------------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    try {
      if (!map.getSource(FILL_SOURCE)) {
        // `lineMetrics: true` — see the matching note in
        // `map-circle-overlay.tsx`. Silences the Mapbox "line-progress
        // evaluation requires enabling 'lineMetrics'" warning that
        // fires on every tile parse against the polygon-line-layer.
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
      if (!map.getSource(EDIT_HANDLES_SOURCE)) {
        map.addSource(EDIT_HANDLES_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }

      // One fill-extrusion layer per opacity bucket. Each carries a
      // CONSTANT `fill-extrusion-opacity` (the bucket value / 100) and
      // selects features whose generator-stamped `opacityBucket` matches
      // its bucket. Pre-creating all 11 layers up front avoids any layer
      // add/remove churn when shapes change opacity — the user's edits
      // just shuffle features between existing layers.
      //
      // Every polygon — including "flat" ones with elevation = 0 and
      // height = 0 — flows through these bucket layers. The old `fill`-
      // type layer for the flat case rendered at Z = 0 and lost the
      // paint-order battle against the alpha-blended floor raster below
      // ~zoom 20.5, so the interior of every room disappeared on zoom
      // out. Routing flat polygons through fill-extrusion with a base
      // floored at POLYGON_MIN_BASE_M puts them 1 cm above the raster's
      // own minimum elevation, so they always paint on top.
      for (const bucket of OPACITY_BUCKETS) {
        const layerId = extrudeLayerId(bucket)
        if (map.getLayer(layerId)) continue
        try {
          map.addLayer({
            id: layerId,
            type: 'fill-extrusion',
            source: FILL_SOURCE,
            filter: ['==', ['get', 'opacityBucket'], bucket],
            paint: {
              // `fill-extrusion-color` IGNORES alpha — solid hex only.
              'fill-extrusion-color': ['get', 'color'],
              // Constant per layer. The "data-driven opacity" comes from
              // routing each feature to its matching bucket layer above.
              'fill-extrusion-opacity': bucket / 100,
              // Base floored at POLYGON_MIN_BASE_M so flat polygons
              // clear the raster; elevated polygons keep their user-set
              // elevation.
              'fill-extrusion-base': [
                'max',
                ['to-number', ['get', 'elevation']],
                POLYGON_MIN_BASE_M,
              ],
              // Top floored at `base + 5 cm`. Zero-thickness slabs
              // z-fight with themselves and with nearby extrusions /
              // rasters, blinking in and out as pitch / zoom shift
              // depth-buffer precision. 5 cm is invisible at warehouse
              // scale but gives Mapbox a real volume to render.
              'fill-extrusion-height': [
                '+',
                ['max', ['to-number', ['get', 'elevation']], POLYGON_MIN_BASE_M],
                ['max', ['to-number', ['get', 'height']], 0.05],
              ],
              // Vertical gradient darkens the extrusion at its base.
              // For a paper-thin (5 cm) elevated slab sitting on top
              // of a floor plan, the gradient collapses across a tiny
              // vertical span and paints the whole polygon dark — at
              // low zoom + oblique pitch the polygon reads as a
              // shadow blob against the raster and disappears.
              // Disabled so elevation-only polygons stay solid.
              'fill-extrusion-vertical-gradient': false,
              // Full emissive by default so the polygon top face is
              // immune to directional light + shadow occlusion (at
              // zoom < ~20 in top-down view, otherwise the sun-vs-
              // normal angle darkens the top to near-black and the
              // polygon reads as vanished over the emissive raster).
              // When `receiveShadows` is true (opt-in per shape) drop
              // to 0.5 so shadows from taller shapes visibly darken
              // this face — enable this on "floor slab" polygons that
              // walls stand on.
              'fill-extrusion-emissive-strength': [
                'case',
                ['coalesce', ['get', 'receiveShadows'], true],
                0.5,
                1,
              ],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-cast-shadows' as any]: true,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-ambient-occlusion-intensity' as any]: 0.35,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ['fill-extrusion-ambient-occlusion-radius' as any]: 2.5,
            },
          })
        } catch (err) {
          console.warn('[MapPolygonOverlay] failed to add extrude bucket', bucket, err)
        }
      }
      if (!map.getLayer(LINE_LAYER)) {
        map.addLayer({
          id: LINE_LAYER,
          type: 'line',
          source: FILL_SOURCE,
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
      // Whole-area tint over selected polygons — a low-opacity
      // theme-primary fill-extrusion at the polygon's altitude. The
      // border-only affordance was easy to miss on busy maps; a soft
      // wash makes "which polygon am I editing?" unambiguous.
      // Positioned BEFORE the outline in insertion order so the border
      // draws on top of the fill.
      if (!map.getLayer(SELECTION_TINT_LAYER)) {
        const tintLayerDef = {
          id: SELECTION_TINT_LAYER,
          type: 'fill-extrusion',
          source: FILL_SOURCE,
          filter: ['==', ['get', 'polygonId'], -1],
          paint: {
            'fill-extrusion-color': '#facc15', // theme effect overwrites
            'fill-extrusion-opacity': 0.18,
            // Same base/height floors as the bucket layers so the tint
            // on a flat polygon (elevation = 0, height = 0) sits above
            // the raster instead of vanishing into it at low zoom.
            'fill-extrusion-base': [
              'max',
              ['coalesce', ['to-number', ['get', 'elevation']], 0],
              POLYGON_MIN_BASE_M,
            ],
            'fill-extrusion-height': [
              '+',
              [
                'max',
                ['coalesce', ['to-number', ['get', 'elevation']], 0],
                POLYGON_MIN_BASE_M,
              ],
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
      if (!map.getLayer(SELECTION_LAYER)) {
        map.addLayer({
          id: SELECTION_LAYER,
          type: 'line',
          source: FILL_SOURCE,
          filter: ['==', ['get', 'polygonId'], -1],
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
      // Drop the LABEL_LAYER if a previous build left it in a stale
      // shape: bound to FILL_SOURCE (pre-Point-source rewrite),
      // missing the labelFlat partition filter (pre-flat-label change),
      // or still carrying `text-allow-overlap: true` (pre-overlap-fix
      // change — we now want the label to hide when it collides). Any
      // of these means the stale layer would give the wrong behaviour
      // after HMR; force a re-mount.
      const existingLabel = map.getStyle()?.layers?.find((l) => l.id === LABEL_LAYER) as
        | { source?: string; filter?: unknown; layout?: Record<string, unknown> }
        | undefined
      if (
        existingLabel &&
        (existingLabel.source !== LABEL_SOURCE ||
          existingLabel.filter === undefined ||
          existingLabel.layout?.['text-allow-overlap'] === true)
      ) {
        try { map.removeLayer(LABEL_LAYER) } catch { /* ignore */ }
      }
      const existingLabelFlat = map.getStyle()?.layers?.find((l) => l.id === LABEL_LAYER_FLAT) as
        | { layout?: Record<string, unknown> }
        | undefined
      if (existingLabelFlat && existingLabelFlat.layout?.['text-allow-overlap'] === true) {
        try { map.removeLayer(LABEL_LAYER_FLAT) } catch { /* ignore */ }
      }
      // Shared paint expressions — both label variants read the same
      // config fields. Text rotation is intentionally left at Mapbox's
      // default (0) so the label always reads map-north-up: rotating
      // the polygon moves the label's ANCHOR (via the offset math
      // above) but never spins the text itself.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const labelPaint: any = {
        'text-color': ['coalesce', ['get', 'labelColor'], '#ffffff'],
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.2,
        'text-emissive-strength': 1,
        // Absolute label altitude = polygon top + user lift. Sits flush
        // on the roof for 3D polygons; sits at ground (+ labelAltitude)
        // for flat ones.
        'symbol-z-offset': [
          '+',
          ['coalesce', ['get', 'elevation'], 0],
          ['coalesce', ['get', 'height'], 0],
          ['coalesce', ['get', 'labelAltitude'], 0],
        ],
      }
      if (!map.getLayer(LABEL_LAYER)) {
        // Billboard variant — screen-space text always facing the
        // camera. Point-source symbol at each polygon's centroid (see
        // `labelPointData`). `symbol-z-elevate: false` + explicit
        // `symbol-z-offset` lifts cleanly for both flat and extruded
        // polygons; a Polygon source could drop labels on flat shapes
        // because symbol-z-elevate has no extrusion to anchor to.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const layout: any = {
          'text-field': ['coalesce', ['get', 'label'], ''],
          'text-size': ['coalesce', ['get', 'labelSize'], 12],
          'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
          'text-anchor': 'center',
          'text-padding': 2,
          'symbol-placement': 'point',
          // Overlap detection ON: a polygon label hides if it would
          // collide with another already-placed label (from any overlay
          // or the basemap), and it also reserves its own footprint so
          // other labels avoid it. Trade-off — labels sitting near dense
          // basemap text (street names, POIs) may not render; that's
          // preferable to stacked, unreadable text.
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'symbol-z-elevate': false,
        }
        map.addLayer({
          id: LABEL_LAYER,
          type: 'symbol',
          source: LABEL_SOURCE,
          filter: ['!=', ['get', 'labelFlat'], true],
          layout,
          paint: labelPaint,
        })
      }
      if (!map.getLayer(LABEL_LAYER_FLAT)) {
        // Flat variant — text lies on the polygon's top face and
        // pitches / rotates with the map, so it reads like signage
        // painted on the surface. `text-pitch-alignment: 'map'` +
        // `text-rotation-alignment: 'map'` are layout-only, not
        // data-driven in Mapbox GL JS 3.x, which is why this needs to
        // live in its own layer rather than being toggled per-feature.
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
      if (!map.getLayer(CLIP_LAYER)) {
        try {
          map.addLayer({
            id: CLIP_LAYER,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            type: 'clip' as any,
            source: CLIP_SOURCE,
            layout: {
              'clip-layer-types': ['symbol', 'model'],
              'clip-layer-scope': ['basemap'],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          })
        } catch (err) {
          if (import.meta.env.DEV) {
            console.debug('[MapPolygonOverlay] clip layer not supported', err)
          }
        }
      }
      // Chain — dashed line for in-progress edges. Lifted to
      // `elevation + height` (roof of the would-be extrusion) via
      // `line-z-offset` so a polygon drawn on a floor plan at
      // altitude renders its in-progress edges AT that altitude, not
      // dumped on the ground where they'd visibly drift from the
      // raster whenever the user pitches / pans the map.
      if (!map.getLayer(CHAIN_LINE_LAYER)) {
        map.addLayer({
          id: CHAIN_LINE_LAYER,
          type: 'line',
          source: CHAIN_SOURCE,
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: {
            'line-color': '#fbbf24',
            'line-width': 2,
            'line-dasharray': [2, 2],
          },
          layout: {
            'line-elevation-reference': 'sea',
            // Elevation only — see the vertex feature comment above
            // for why `height` is deliberately not added here.
            'line-z-offset': ['coalesce', ['get', 'elevation'], 0],
          },
        })
      }
      // Chain vertex dots — implemented as `symbol` (not `circle`)
      // because Mapbox's `circle` layer has no `circle-z-offset` in
      // 3.25, only `circle-elevation-reference`, which anchors to
      // features rather than accepting an absolute altitude. Symbols
      // have `symbol-z-offset`, so a bullet glyph gives us the same
      // dot affordance as before but with proper 3D lift.
      if (!map.getLayer(CHAIN_VERTEX_LAYER)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const layout: any = {
          'text-field': '●',
          'text-font': ['literal', ['Open Sans Semibold', 'Arial Unicode MS Bold']],
          'text-size': 16,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          // false → symbol sits at the point's ground position + the
          // z-offset. `true` would auto-lift to nearby extrusion tops,
          // which would tug the dots up onto the previewed polygon
          // and make it impossible to see where the next click will
          // land.
          'symbol-z-elevate': false,
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const paint: any = {
          'text-color': '#fbbf24',
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
          'text-emissive-strength': 1,
          // Elevation only — see the vertex feature comment above.
          'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
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
      // Transform handle — symbol layer with theme-tinted canvas icons.
      // Mirrors the image overlay: `symbol-z-elevate: true` keeps the
      // handle above all 3D content (buildings, other extrusions), and
      // `symbol-z-offset` positions it at the polygon's top face
      // (elevation + height) so it appears where the polygon visually
      // sits, not on the ground.
      //
      // HMR safety: if a previous build left a `type: 'circle'`
      // TRANSFORM_LAYER on the map, force-remove it so the new symbol
      // definition below actually applies. Without this the guarded
      // `if (!getLayer)` would skip the re-add and the user keeps
      // seeing the old hardcoded-orange circle.
      const existingTransform = map.getStyle()?.layers?.find(
        (l) => l.id === TRANSFORM_LAYER,
      ) as { type?: string } | undefined
      if (existingTransform && existingTransform.type !== 'symbol') {
        try { map.removeLayer(TRANSFORM_LAYER) } catch { /* ignore */ }
      }
      // TRANSFORM_ICON_LAYER is defunct — the single symbol layer
      // draws the whole handle including its inner glyph. Remove any
      // stale copy from previous builds so cleanup ordering isn't
      // wedged by a hanging reference.
      try {
        if (map.getLayer(TRANSFORM_ICON_LAYER)) {
          map.removeLayer(TRANSFORM_ICON_LAYER)
        }
      } catch { /* ignore */ }

      if (!map.getLayer(TRANSFORM_LAYER)) {
        // Cast whole def once — Mapbox 3.25 typings don't yet include
        // symbol-elevation-reference / symbol-z-offset paint props.
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
            // Per-kind icon rotation — same expression as image
            // overlay. See map-image-overlay.tsx for the rationale.
            // Polygon rotate has 2 handles (start vertex + furthest-
            // from-start "opposite" vertex). Start curl faces one way
            // (270°/NW), opposite curl faces the other (90°/SE); both
            // rotate WITH the polygon so they always face outward
            // from the centroid at whichever direction the vertex sits.
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
            // symbol-z-elevate is DELIBERATELY false for polygon
            // handles. When true, Mapbox lifts the symbol to the top
            // of the extrusion at its XY then adds symbol-z-offset ON
            // TOP of that — so an offset of (elevation + height) ends
            // up at 2 × (elevation + height), floating twice as high
            // as the polygon it edits. With false, the offset alone
            // is authoritative (absolute altitude via `sea` reference).
            // Occlusion by other 3D content is handled by the
            // moveLayer effect keeping these layers at the top of
            // the layer stack.
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
      // Edit handles — vertex + midpoint symbol layers. Circle layers
      // were used previously but they don't support `circle-z-offset`
      // in Mapbox 3.25, so on an elevated polygon the handles rendered
      // on the ground (visually disconnected from the polygon they
      // edit). Symbol layers with `symbol-z-offset` lift them cleanly
      // to the polygon's top face.
      const existingVertex = map.getStyle()?.layers?.find(
        (l) => l.id === VERTEX_LAYER,
      ) as { type?: string } | undefined
      if (existingVertex && existingVertex.type !== 'symbol') {
        try { map.removeLayer(VERTEX_LAYER) } catch { /* ignore */ }
      }
      const existingMidpoint = map.getStyle()?.layers?.find(
        (l) => l.id === MIDPOINT_LAYER,
      ) as { type?: string } | undefined
      if (existingMidpoint && existingMidpoint.type !== 'symbol') {
        try { map.removeLayer(MIDPOINT_LAYER) } catch { /* ignore */ }
      }
      if (!map.getLayer(VERTEX_LAYER)) {
        const vertexLayerDef = {
          id: VERTEX_LAYER,
          type: 'symbol',
          source: EDIT_HANDLES_SOURCE,
          filter: ['==', ['get', 'kind'], 'vertex'],
          layout: {
            'icon-image': TRANSFORM_ICON.vertex,
            'icon-size': 1,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            // symbol-z-elevate is DELIBERATELY false for polygon
            // handles. When true, Mapbox lifts the symbol to the top
            // of the extrusion at its XY then adds symbol-z-offset ON
            // TOP of that — so an offset of (elevation + height) ends
            // up at 2 × (elevation + height), floating twice as high
            // as the polygon it edits. With false, the offset alone
            // is authoritative (absolute altitude via `sea` reference).
            // Occlusion by other 3D content is handled by the
            // moveLayer effect keeping these layers at the top of
            // the layer stack.
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
        map.addLayer(vertexLayerDef)
      }
      if (!map.getLayer(MIDPOINT_LAYER)) {
        const midpointLayerDef = {
          id: MIDPOINT_LAYER,
          type: 'symbol',
          source: EDIT_HANDLES_SOURCE,
          filter: ['==', ['get', 'kind'], 'midpoint'],
          layout: {
            'icon-image': TRANSFORM_ICON.midpoint,
            'icon-size': 1,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            // symbol-z-elevate is DELIBERATELY false for polygon
            // handles. When true, Mapbox lifts the symbol to the top
            // of the extrusion at its XY then adds symbol-z-offset ON
            // TOP of that — so an offset of (elevation + height) ends
            // up at 2 × (elevation + height), floating twice as high
            // as the polygon it edits. With false, the offset alone
            // is authoritative (absolute altitude via `sea` reference).
            // Occlusion by other 3D content is handled by the
            // moveLayer effect keeping these layers at the top of
            // the layer stack.
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
        map.addLayer(midpointLayerDef)
      }

      // ---- In-flight sources + layers (transforming polygon) ------------
      // Same paint recipes as FILL / EXTRUDE / LINE / SELECTION / LABEL
      // so the moving polygon renders identically. Single-feature source
      // → per-frame updates cost O(1) turf.buffer / rotateRing instead
      // of O(N_polygons). No filters — the source itself is gated by
      // the transform-active population effect.
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
      if (!map.getLayer(EXTRUDE_INFLIGHT_LAYER)) {
        // Catches every in-flight polygon (flat or elevated). Mirrors
        // the committed bucket-layer base/height floors so the moving
        // shape doesn't pop up 11 cm at the moment of transform start.
        map.addLayer({
          id: EXTRUDE_INFLIGHT_LAYER,
          type: 'fill-extrusion',
          source: FILL_INFLIGHT_SOURCE,
          paint: {
            'fill-extrusion-color': ['get', 'color'],
            // Constant per-layer opacity — the in-flight population
            // effect rewrites this via `setPaintProperty` on transform
            // start using the moving polygon's config.opacity, matching
            // the bucket the committed extrude would land in.
            'fill-extrusion-opacity': 1,
            'fill-extrusion-base': [
              'max',
              ['to-number', ['get', 'elevation']],
              POLYGON_MIN_BASE_M,
            ],
            'fill-extrusion-height': [
              '+',
              ['max', ['to-number', ['get', 'elevation']], POLYGON_MIN_BASE_M],
              ['max', ['to-number', ['get', 'height']], 0.05],
            ],
            'fill-extrusion-vertical-gradient': false,
            // Match the committed bucket layers — data-driven so a
            // shape that opts into receiveShadows keeps that behaviour
            // while it's being transformed.
            'fill-extrusion-emissive-strength': [
              'case',
              ['coalesce', ['get', 'receiveShadows'], true],
              0.5,
              1,
            ],
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
      // Selection tint mirror — no filter (in-flight source holds only
      // the transforming polygon). Theme-tinted via the same
      // setPaintProperty effect that targets SELECTION_TINT_LAYER.
      if (!map.getLayer(SELECTION_TINT_INFLIGHT_LAYER)) {
        const tintInflightDef = {
          id: SELECTION_TINT_INFLIGHT_LAYER,
          type: 'fill-extrusion',
          source: FILL_INFLIGHT_SOURCE,
          paint: {
            'fill-extrusion-color': '#facc15',
            'fill-extrusion-opacity': 0.18,
            'fill-extrusion-base': [
              'max',
              ['coalesce', ['to-number', ['get', 'elevation']], 0],
              POLYGON_MIN_BASE_M,
            ],
            'fill-extrusion-height': [
              '+',
              [
                'max',
                ['coalesce', ['to-number', ['get', 'elevation']], 0],
                POLYGON_MIN_BASE_M,
              ],
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
      console.warn('[MapPolygonOverlay] ensure layers failed', err)
    }

    return () => {
      for (const id of [
        MIDPOINT_LAYER,
        VERTEX_LAYER,
        TRANSFORM_ICON_LAYER,
        TRANSFORM_LAYER,
        CHAIN_VERTEX_LAYER,
        CHAIN_LINE_LAYER,
        CLIP_LAYER,
        LABEL_INFLIGHT_LAYER,
        LABEL_LAYER_FLAT,
        LABEL_LAYER,
        SELECTION_INFLIGHT_LAYER,
        SELECTION_TINT_INFLIGHT_LAYER,
        LINE_INFLIGHT_LAYER,
        EXTRUDE_INFLIGHT_LAYER,
        SELECTION_LAYER,
        SELECTION_TINT_LAYER,
        LINE_LAYER,
        ...EXTRUDE_LAYER_IDS,
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
        CHAIN_SOURCE,
        TRANSFORM_SOURCE,
        EDIT_HANDLES_SOURCE,
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
    // styleGen is in the deps so every style.load triggers a fresh
    // setup pass — Mapbox wipes our sources/layers on swap and the
    // boolean styleLoaded stays true across the swap, so without this
    // counter the effect never re-runs.
  }, [map, styleLoaded, styleGen])

  // ---- Push data ---------------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(FILL_SOURCE) as GeoJSONSource | undefined
    if (src) {
      src.setData(
        fc as GeoJSON.FeatureCollection<GeoJSON.Polygon, PolygonProps>
      )
    }
    const labelSrc = map.getSource(LABEL_SOURCE) as GeoJSONSource | undefined
    if (labelSrc) {
      labelSrc.setData(
        (labelPointData ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection
      )
    }
    const clipSrc = map.getSource(CLIP_SOURCE) as GeoJSONSource | undefined
    if (clipSrc) {
      clipSrc.setData(clipData ?? { type: 'FeatureCollection', features: [] })
    }
    const chainSrc = map.getSource(CHAIN_SOURCE) as GeoJSONSource | undefined
    if (chainSrc) {
      chainSrc.setData(chainData ?? { type: 'FeatureCollection', features: [] })
    }
  }, [map, styleLoaded, styleGen, fc, labelPointData, clipData, chainData])

  // Selection filter — mirrored to the whole-area tint layer so the
  // wash appears and disappears with the border in perfect sync.
  // Composed with the transform exclusion: while a transform is active,
  // the committed halo/tint are suppressed and SELECTION_INFLIGHT_LAYER
  // / SELECTION_TINT_INFLIGHT_LAYER pick them up on the in-flight
  // source, so the highlight tracks the moving polygon at full quality.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const ids = selectedPolygonIds && selectedPolygonIds.size > 0
      ? [...selectedPolygonIds]
      : [-1]
    const excludeId = transformState?.polygonId
    const idFilter = ['in', ['get', 'polygonId'], ['literal', ids]]
    const filter = excludeId != null
      ? ['all', idFilter, ['!=', ['get', 'polygonId'], excludeId]]
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setFilter(SELECTION_TINT_LAYER, filter as any)
      }
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, selectedPolygonIds, transformState])

  // ---- Exclusion filter (committed base layers) ------------------------
  // While a transform is active, hide the moving polygon from the
  // committed EXTRUDE / LINE / LABEL layers so it doesn't render twice
  // — once at its stale committed geometry, once at its live drag
  // position on FILL_INFLIGHT_SOURCE. Cleared when no transform is
  // active. EXTRUDE_LAYER_op* already carry a bucket filter we preserve
  // by composing.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const excludeId = transformState?.polygonId
    const notMe = excludeId != null
      ? ['!=', ['get', 'polygonId'], excludeId]
      : null
    // EXTRUDE_LAYER_op* — each has a single bucket predicate.
    for (const bucket of OPACITY_BUCKETS) {
      const layerId = extrudeLayerId(bucket)
      try {
        if (!map.getLayer(layerId)) continue
        const bucketFilter: unknown[] = ['==', ['get', 'opacityBucket'], bucket]
        const filter: unknown[] = notMe
          ? ['all', bucketFilter, notMe]
          : bucketFilter
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setFilter(layerId, filter as any)
      } catch { /* ignore */ }
    }
    // LINE_LAYER: no default filter → notMe alone.
    try {
      if (map.getLayer(LINE_LAYER)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setFilter(LINE_LAYER, (notMe ?? null) as any)
      }
    } catch { /* ignore */ }
    // LABEL_LAYER + LABEL_LAYER_FLAT: no default filter → notMe alone.
    for (const layerId of [LABEL_LAYER, LABEL_LAYER_FLAT]) {
      try {
        if (map.getLayer(layerId)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map.setFilter(layerId, (notMe ?? null) as any)
        }
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, transformState])

  // Visibility toggle.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const vis = committedVisible ? 'visible' : 'none'
    for (const id of [
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

  // Push the theme primary hex into every "which polygon am I picking?"
  // cue so palette / light-dark toggles retint them live. Also targets
  // the in-flight halo + tint mirrors so the moving polygon's highlight
  // matches. Mapbox's setPaintProperty is a no-op when the value is
  // unchanged.
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
    // Live draw chain (in-progress polygon vertex chain) — retint the
    // dashed line + vertex dots to match the palette.
    try {
      if (map.getLayer(CHAIN_LINE_LAYER)) {
        map.setPaintProperty(CHAIN_LINE_LAYER, 'line-color', primaryHex)
      }
    } catch { /* ignore */ }
    try {
      if (map.getLayer(CHAIN_VERTEX_LAYER)) {
        map.setPaintProperty(CHAIN_VERTEX_LAYER, 'text-color', primaryHex)
      }
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, primaryHex])

  // Keep the selection tint, outline, in-flight surfaces, transform
  // handle, and edit handles at the top of the layer stack. Other
  // overlays register unslotted layers after us — without periodic
  // moveLayer calls, late-added extrusions would sit above these UI
  // layers and occlude them at grazing pitches. moveLayer with no
  // beforeId slides the target to the very top of the stack; calling
  // in this order leaves the edit handles topmost so users can always
  // grab them.
  //
  // Deps include `transformState` so the transform / in-flight layers
  // re-elevate the moment the user clicks Move / Rotate / Edit;
  // otherwise overlays that mounted after us in the tree occlude the
  // handles and there's nothing visible to grab. `polygons` +
  // `selectedPolygonIds` are intentionally OMITTED — the drag handler
  // bypasses React state during a drag so `polygons` doesn't churn,
  // and per-selection re-elevation was purely defensive.
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const id of [
      SELECTION_TINT_LAYER,
      SELECTION_LAYER,
      EXTRUDE_INFLIGHT_LAYER,
      LINE_INFLIGHT_LAYER,
      SELECTION_TINT_INFLIGHT_LAYER,
      SELECTION_INFLIGHT_LAYER,
      LABEL_INFLIGHT_LAYER,
      TRANSFORM_LAYER,
      VERTEX_LAYER,
      MIDPOINT_LAYER,
    ]) {
      try {
        if (map.getLayer(id)) map.moveLayer(id)
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, transformState])

  // ---- Click handling ----------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded || !selectionEnabled) return

    /**
     * Pick the topmost polygon feature under a screen point. When a flat
     * fill (ground floor) and an extruded polygon (upper floor) both
     * cover the cursor, Mapbox's per-layer `click` delivery order isn't
     * guaranteed to put the visually-on-top feature first, so we look
     * at the full hit stack and choose by elevation:
     *   1. Highest `properties.elevation` wins — that's the extrusion
     *      base, so higher floors beat the ground.
     *   2. Ties broken by largest `properties.height` so a taller
     *      extrude beats a co-floor flat polygon.
     *   3. Final tie-break: painter order (first index = topmost from
     *      Mapbox's depth sort, last drawn).
     */
    const topmostPolygonAt = (
      e: MapMouseEvent,
    ): { id: number } | null => {
      const layers = EXTRUDE_LAYER_IDS.filter((l) => map.getLayer(l))
      if (layers.length === 0) return null
      const hits = map.queryRenderedFeatures(e.point, { layers })
      if (hits.length === 0) return null
      let best: { id: number; elevation: number; height: number; idx: number } | null = null
      for (let i = 0; i < hits.length; i++) {
        const props = hits[i].properties ?? {}
        const rawId = (props as Record<string, unknown>).polygonId
        if (typeof rawId !== 'number') continue
        const rawElev = (props as Record<string, unknown>).elevation
        const elevation = typeof rawElev === 'number' ? rawElev : 0
        const rawHeight = (props as Record<string, unknown>).height
        const height = typeof rawHeight === 'number' ? rawHeight : 0
        const cand = { id: rawId, elevation, height, idx: i }
        if (
          best === null ||
          cand.elevation > best.elevation ||
          (cand.elevation === best.elevation && cand.height > best.height) ||
          (cand.elevation === best.elevation && cand.height === best.height && cand.idx < best.idx)
        ) {
          best = cand
        }
      }
      return best ? { id: best.id } : null
    }

    const handlePolygonClick = (e: MapMouseEvent) => {
      // `forceClickCapture` skips the two "defer to a higher overlay"
      // guards so route-picking mode always wins the click. Normal
      // selection flows leave it false → existing priority order intact.
      if (!forceClickCapture) {
        if (e.originalEvent?.defaultPrevented) return
        if (higherPriorityAt(map, e.point, 'polygon')) return
      }
      const top = topmostPolygonAt(e)
      if (!top) return
      e.preventDefault()
      e.originalEvent?.preventDefault?.()
      onPolygonClick?.(top.id, e.originalEvent)
    }
    const handleMapClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      // Don't fire the "deselect on empty map" path if a higher overlay
      // is about to claim — we'd flicker the polygon selection off, then
      // the higher overlay would set its own selection.
      if (higherPriorityAt(map, e.point, 'polygon')) return
      // Ignore clicks that landed on a vertex / midpoint edit handle —
      // those are consumed by the edit-mode drag effect. Otherwise a
      // click on a handle at an empty part of the map would deselect
      // the polygon and immediately kill edit mode.
      const handleLayers = [VERTEX_LAYER, MIDPOINT_LAYER].filter((l) => map.getLayer(l))
      if (handleLayers.length > 0) {
        const handleHits = map.queryRenderedFeatures(e.point, { layers: handleLayers })
        if (handleHits.length > 0) return
      }
      const layers = EXTRUDE_LAYER_IDS.filter((l) => map.getLayer(l))
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
    // Per-bucket-layer handlers keep Mapbox's cursor hover populated,
    // but the per-event `features` array is ignored — `topmostPolygonAt`
    // re-queries the full stack so the upper-floor extrusion wins even
    // when Mapbox delivered the ground-level bucket's event first.
    for (const id of EXTRUDE_LAYER_IDS) {
      map.on('click', id, handlePolygonClick)
      map.on('mouseenter', id, handleEnter)
      map.on('mouseleave', id, handleLeave)
    }
    map.on('click', handleMapClick)
    return () => {
      for (const id of EXTRUDE_LAYER_IDS) {
        map.off('click', id, handlePolygonClick)
        map.off('mouseenter', id, handleEnter)
        map.off('mouseleave', id, handleLeave)
      }
      map.off('click', handleMapClick)
    }
  }, [map, styleLoaded, styleGen, selectionEnabled, onPolygonClick, onMapClickEmpty, forceClickCapture])

  // ---- Transform handle --------------------------------------------------
  const transformChangeRef = useRef(onTransformChange)
  useEffect(() => {
    transformChangeRef.current = onTransformChange
  }, [onTransformChange])

  const transformContextRef = useRef<{
    polygon: PolygonShape
    anchor: [number, number]
    center: [number, number]
    rotateCorners: [number, number][] | null
  } | null>(null)

  // Resolve the polygon being transformed + handle anchors.
  //
  // move   → single handle at centroid.
  // rotate → FOUR handles at the axis-aligned bbox corners of the
  //          rotated polygon (TL, TR, BR, BL). Users grab any corner
  //          and drag around the centroid to rotate. Bbox is computed
  //          from the ROTATED vertex ring so the corners visually
  //          hug the polygon at its current orientation, matching the
  //          floor plan / raster orientation the polygon was drawn
  //          against.
  // edit   → per-vertex + per-midpoint handles emitted separately.
  const transformContext = useMemo(() => {
    if (!transformState || !polygons) return null
    const p = polygons.find((x) => x.id === transformState.polygonId)
    if (!p) return null
    const center = polygonCentroid(p.vertices)
    if (!center) return null
    let anchor: [number, number] = center
    let rotateCorners: [number, number][] | null = null
    if (transformState.kind === 'rotate' && p.vertices.length >= 2) {
      // TWO rotate handles at the polygon's most distant vertex
      // pair — `verts[0]` (the first-drawn vertex, our "start"
      // reference) and whichever vertex is furthest from it.
      //
      // Simpler + far more usable than the previous 4-corner OBB:
      // a thin diagonal polygon would end up with a giant enclosing
      // rectangle whose corners floated outside the actual shape.
      // Two vertices on the shape itself always sit on the polygon
      // and give the user a clean lever pair.
      //
      // "Furthest from start" (not verts[last]) because in a closed
      // polygon verts[0] and verts[last] are adjacent along the
      // closing edge — those two handles would sit inches apart.
      // Furthest-from-start reliably picks a diametrically-opposite
      // vertex regardless of how the ring was drawn.
      const start = p.vertices[0]
      let farthestIdx = 1
      let maxDist = -Infinity
      for (let i = 1; i < p.vertices.length; i++) {
        const dx = p.vertices[i][0] - start[0]
        const dy = p.vertices[i][1] - start[1]
        const d = dx * dx + dy * dy
        if (d > maxDist) {
          maxDist = d
          farthestIdx = i
        }
      }
      const opposite = p.vertices[farthestIdx]
      rotateCorners = [
        rotatePointAround(start, center, p.rotation),
        rotatePointAround(opposite, center, p.rotation),
      ]
      anchor = rotateCorners[0]
    }
    return { polygon: p, anchor, center, rotateCorners }
  }, [transformState, polygons])

  useEffect(() => {
    transformContextRef.current = transformContext
  }, [transformContext])

  // Push handle position into the transform source. Move emits a
  // single feature at the centroid; rotate emits 4 corner features
  // (one per bbox corner). Edit mode is separate and uses a distinct
  // source further below.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    if (!transformContext || !transformState || transformState.kind === 'edit') {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    // Read elevation + height from the polygon's config so the symbol
    // layer's z-offset lifts the handle to the top face of the extrusion.
    // Coalesce mimics the polygon generator's paint expressions.
    const p = transformContext.polygon
    const elev = p.config.elevation ?? 0
    const hgt = p.config.height ?? 0
    const features: GeoJSON.Feature<GeoJSON.Point>[] = []
    if (transformState.kind === 'rotate' && transformContext.rotateCorners) {
      // 4 corner handles at the bbox of the rotated ring. Users grab
      // any one to swing the polygon around its centroid.
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
            imageRotation: p.rotation ?? 0,
            elevation: elev,
            height: hgt,
          },
        })
      }
    } else {
      // Move — single handle at the centroid.
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: transformContext.anchor },
        properties: {
          kind: transformState.kind,
          iconId: TRANSFORM_ICON[transformState.kind as 'move' | 'rotate'],
          cornerIndex: -1,
          imageRotation: p.rotation ?? 0,
          elevation: elev,
          height: hgt,
        },
      })
    }
    src.setData({ type: 'FeatureCollection', features })
  }, [map, styleLoaded, styleGen, transformContext, transformState])

  // ---- In-flight source population ------------------------------------
  // When a transform starts, immediately push the target polygon's fill
  // feature + label point into the in-flight sources so the moving
  // polygon renders identically from the moment transformState flips.
  // Also pins the EXTRUDE_INFLIGHT_LAYER opacity to the transforming
  // polygon's config.opacity — the paint prop is per-layer constant,
  // so we rewrite it on activation. On transform end, empties the
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
    const poly = transformContext.polygon
    const fillFeat = buildPolygonFeature(poly)
    fillSrc?.setData(
      fillFeat
        ? { type: 'FeatureCollection', features: [fillFeat] }
        : emptyFC,
    )
    // Label: reuse the label-source shape used for LABEL_LAYER. Only
    // emit when the polygon opts into a label.
    const showLabels = poly.config.showLabels ?? false
    const labelText = poly.config.label?.trim() ?? ''
    if (showLabels && labelText !== '' && poly.id !== undefined) {
      const centroid = polygonCentroid(poly.vertices)
      if (centroid) {
        labelSrc?.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                id: `polygon-label-${poly.id}`,
                polygonId: poly.id,
                color: poly.config.color,
                opacity: poly.config.opacity,
                elevation: poly.config.elevation ?? 0,
                height: poly.config.height ?? 0,
                showLabels: true,
                label: labelText,
                labelSize: poly.config.labelSize,
                labelColor: poly.config.labelColor,
              },
              geometry: { type: 'Point', coordinates: centroid },
            },
          ],
        })
      } else {
        labelSrc?.setData(emptyFC)
      }
    } else {
      labelSrc?.setData(emptyFC)
    }
    // Sync EXTRUDE_INFLIGHT_LAYER opacity to the polygon's config so
    // the moving 3D fill matches what the committed opacity-bucket
    // layer would render at.
    try {
      const op = Math.max(0, Math.min(1, (poly.config.opacity ?? 100) / 100))
      map.setPaintProperty(EXTRUDE_INFLIGHT_LAYER, 'fill-extrusion-opacity', op)
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, transformState, transformContext])

  // Edit-mode handles — one Point per vertex + one per edge midpoint.
  // The drag / click handler below reads `vertexIndex` / `edgeIndex`
  // out of the feature properties to know which ring position to touch.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(EDIT_HANDLES_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    if (!transformState || transformState.kind !== 'edit' || !transformContext) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    const p = transformContext.polygon
    const verts = p.vertices
    const editCenter = transformContext.center
    // Stamp elevation + height on every edit handle so the layer's
    // symbol-z-offset lifts them to the polygon's top face. Without
    // these, an elevated polygon (e.g. floor 2 at 4 m) would have its
    // vertex handles floating on the ground plane, disconnected from
    // the shape they edit.
    //
    // Rotate every emitted position from vertex space → world space
    // by `p.rotation` around the centroid. `p.vertices` are stored
    // pre-rotation (rotation is applied at render time in
    // `polygon-generators.ts::rotateRing`), so a naive emission
    // would drop handles at the polygon's CREATION location, not
    // its current rendered location. Using `rotatePointAround`
    // (turf-based) guarantees the direction matches the render.
    const elev = p.config.elevation ?? 0
    const hgt = p.config.height ?? 0
    const rot = p.rotation ?? 0
    const features: GeoJSON.Feature<GeoJSON.Point>[] = []
    for (let i = 0; i < verts.length; i++) {
      const vWorld = rotatePointAround(verts[i], editCenter, rot)
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: vWorld },
        properties: {
          kind: 'vertex',
          vertexIndex: i,
          elevation: elev,
          height: hgt,
        },
      })
      const next = verts[(i + 1) % verts.length]
      const midLocal: [number, number] = [
        (verts[i][0] + next[0]) / 2,
        (verts[i][1] + next[1]) / 2,
      ]
      const midWorld = rotatePointAround(midLocal, editCenter, rot)
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: midWorld },
        properties: {
          kind: 'midpoint',
          edgeIndex: i,
          elevation: elev,
          height: hgt,
        },
      })
    }
    src.setData({ type: 'FeatureCollection', features })
  }, [map, styleLoaded, styleGen, transformState, transformContext])

  // Drag handling — mousedown / RAF-coalesced mousemove / mouseup cycle.
  // Bypasses React state during drag: writes go straight to the
  // in-flight FILL / LABEL sources + TRANSFORM_SOURCE via setData; only
  // mouseup fires `onTransformChange(patch, true)` to commit. Since the
  // spatial store isn't touched between mousedown and mouseup, the
  // parent's `polygonsForOverlay` reference stays stable and the
  // shared `fc` / `labelPointData` / `clipData` memos DON'T rebuild
  // every polygon's features on every mousemove.
  const dragRef = useRef<{
    dragging: boolean
    kind: 'move' | 'rotate' | null
    originalPolygon: PolygonShape | null
    originalCenter: [number, number] | null
    originalAnchor: [number, number] | null
    originalRotation: number
    downHandleAngle: number
    pendingCursor: [number, number] | null
    rafId: number
  } | null>(null)

  useEffect(() => {
    if (!map || !styleLoaded || !transformState) return
    // Edit mode has its own effect below (vertex/midpoint handles) —
    // don't bind the single-anchor drag path here.
    if (transformState.kind === 'edit') return

    if (!dragRef.current) {
      dragRef.current = {
        dragging: false,
        kind: null,
        originalPolygon: null,
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

    // Compute the patch for the current cursor. Returns null when the
    // drag state is incomplete.
    const computePatch = (
      cursor: [number, number],
    ): { vertices?: [number, number][]; rotation?: number } | null => {
      const orig = drag.originalPolygon
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

    // Push the patched polygon into the in-flight fill/label sources +
    // update the transform handle position. Cost per frame: 1 ×
    // buildPolygonFeature + N × setData (N ≤ 3).
    const pushInflight = (patch: {
      vertices?: [number, number][]
      rotation?: number
    }) => {
      const orig = drag.originalPolygon
      if (!orig) return
      const patched: PolygonShape = { ...orig, ...patch }
      const fillFeat = buildPolygonFeature(patched)
      const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
      const fillSrc = map.getSource(FILL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      fillSrc?.setData(
        fillFeat
          ? { type: 'FeatureCollection', features: [fillFeat] }
          : emptyFC,
      )
      // Label follows the centroid.
      const labelSrc = map.getSource(LABEL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      if (labelSrc) {
        const showLabels = patched.config.showLabels ?? false
        const labelText = patched.config.label?.trim() ?? ''
        const center = polygonCentroid(patched.vertices)
        if (showLabels && labelText !== '' && center && patched.id !== undefined) {
          labelSrc.setData({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {
                  id: `polygon-label-${patched.id}`,
                  polygonId: patched.id,
                  color: patched.config.color,
                  opacity: patched.config.opacity,
                  elevation: patched.config.elevation ?? 0,
                  height: patched.config.height ?? 0,
                  showLabels: true,
                  label: labelText,
                  labelSize: patched.config.labelSize,
                  labelColor: patched.config.labelColor,
                },
                geometry: { type: 'Point', coordinates: center },
              },
            ],
          })
        } else {
          labelSrc.setData(emptyFC)
        }
      }
      // Follow the moving polygon with the transform handles.
      const transformSrc = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
      if (transformSrc) {
        const elev = patched.config.elevation ?? 0
        const hgt = patched.config.height ?? 0
        const features: GeoJSON.Feature<GeoJSON.Point>[] = []
        if (drag.kind === 'rotate') {
          // Recompute the 4 rotated bbox corners for the handles.
          const rotatedRing = patched.vertices.map((v) =>
            rotatePointAround(v, drag.originalCenter!, patched.rotation),
          )
          let minLng = Infinity, minLat = Infinity
          let maxLng = -Infinity, maxLat = -Infinity
          for (const [lng, lat] of rotatedRing) {
            if (lng < minLng) minLng = lng
            if (lng > maxLng) maxLng = lng
            if (lat < minLat) minLat = lat
            if (lat > maxLat) maxLat = lat
          }
          const corners: [number, number][] = [
            [minLng, maxLat], [maxLng, maxLat],
            [maxLng, minLat], [minLng, minLat],
          ]
          for (let i = 0; i < corners.length; i++) {
            features.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: corners[i] },
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
          const center = polygonCentroid(patched.vertices)
          if (center) {
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

    // RAF flusher — runs at most once per paint frame regardless of how
    // many mousemove events Mapbox fires between paints.
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
      drag.kind = transformState.kind === 'rotate' ? 'rotate' : 'move'
      drag.originalPolygon = ctx.polygon
      drag.originalCenter = ctx.center
      drag.originalRotation = ctx.polygon.rotation
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
      if (drag.rafId !== 0) {
        cancelAnimationFrame(drag.rafId)
        drag.rafId = 0
      }
      drag.pendingCursor = null
      const patch = computePatch(cursor)
      drag.originalPolygon = null
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

  // Component-scoped drag state for edit mode. MUST live outside the
  // effect body because the effect re-runs on every mousemove (each
  // draft update changes `transformContext`, which is in the effect's
  // deps). A local `const drag = {...}` inside the effect would reset
  // `dragging` to `false` between re-runs, so the vertex "moves a bit
  // and stops". The ref preserves the drag state across every re-run.
  const editDragRef = useRef<{
    dragging: boolean
    vertexIndex: number
    originalVertices: [number, number][] | null
    originalPolygon: PolygonShape | null
    originalCenter: [number, number] | null
    pendingCursor: [number, number] | null
    rafId: number
  } | null>(null)

  // ---- Edit-mode drag: vertex drag, midpoint-insert, alt-click delete ----
  //
  // Vertex + midpoint drags follow the same RAF-bypass pattern as
  // move/rotate: mousedown captures original state to a ref, mousemove
  // buffers the cursor + schedules an RAF, RAF flush computes the new
  // vertex list and pushes DIRECTLY to FILL_INFLIGHT_SOURCE +
  // EDIT_HANDLES_SOURCE, mouseup commits via `transformChangeRef(patch,
  // true)`. Alt-click delete and midpoint-insert stay commit-only —
  // they're single-click operations, not per-mousemove.
  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!transformState || transformState.kind !== 'edit') return

    const canvas = map.getCanvas()

    if (!editDragRef.current) {
      editDragRef.current = {
        dragging: false,
        vertexIndex: -1,
        originalVertices: null,
        originalPolygon: null,
        originalCenter: null,
        pendingCursor: null,
        rafId: 0,
      }
    }
    const drag = editDragRef.current

    const pushInflight = (nextVertices: [number, number][]) => {
      const orig = drag.originalPolygon
      if (!orig) return
      const patched: PolygonShape = { ...orig, vertices: nextVertices }
      const fillFeat = buildPolygonFeature(patched)
      const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
      const fillSrc = map.getSource(FILL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      fillSrc?.setData(
        fillFeat
          ? { type: 'FeatureCollection', features: [fillFeat] }
          : emptyFC,
      )
      // Re-emit edit handles at the new vertex positions so the dragged
      // vertex + siblings track the drag.
      const handlesSrc = map.getSource(EDIT_HANDLES_SOURCE) as GeoJSONSource | undefined
      if (handlesSrc && drag.originalCenter) {
        const elev = patched.config.elevation ?? 0
        const hgt = patched.config.height ?? 0
        const rot = patched.rotation ?? 0
        const features: GeoJSON.Feature<GeoJSON.Point>[] = []
        for (let i = 0; i < nextVertices.length; i++) {
          const vWorld = rotatePointAround(nextVertices[i], drag.originalCenter, rot)
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: vWorld },
            properties: {
              kind: 'vertex',
              vertexIndex: i,
              elevation: elev,
              height: hgt,
            },
          })
          const next = nextVertices[(i + 1) % nextVertices.length]
          const midLocal: [number, number] = [
            (nextVertices[i][0] + next[0]) / 2,
            (nextVertices[i][1] + next[1]) / 2,
          ]
          const midWorld = rotatePointAround(midLocal, drag.originalCenter, rot)
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: midWorld },
            properties: {
              kind: 'midpoint',
              edgeIndex: i,
              elevation: elev,
              height: hgt,
            },
          })
        }
        handlesSrc.setData({ type: 'FeatureCollection', features })
      }
    }

    const computeNextVertices = (cursor: [number, number]): [number, number][] | null => {
      const orig = drag.originalVertices
      if (!orig || drag.vertexIndex < 0 || !drag.originalPolygon || !drag.originalCenter) {
        return null
      }
      const rot = drag.originalPolygon.rotation ?? 0
      const cursorLocal = rotatePointAround(cursor, drag.originalCenter, -rot)
      const next = orig.slice() as [number, number][]
      next[drag.vertexIndex] = cursorLocal
      return next
    }

    const flushEditFrame = () => {
      drag.rafId = 0
      if (!drag.dragging || !drag.pendingCursor) return
      const next = computeNextVertices(drag.pendingCursor)
      if (!next) return
      pushInflight(next)
    }
    const scheduleFlush = () => {
      if (drag.rafId !== 0) return
      drag.rafId = requestAnimationFrame(flushEditFrame)
    }

    const onMouseDown = (e: MapMouseEvent) => {
      const ctx = transformContextRef.current
      if (!ctx) return
      // Alt/Option-click on a vertex → delete it (min 3 vertices).
      // Commit-only path; no drag state to set up.
      const domEv = e.originalEvent as MouseEvent | undefined
      if (
        domEv?.altKey &&
        ctx.polygon.vertices.length > 3 &&
        map.getLayer(VERTEX_LAYER)
      ) {
        const hits = map.queryRenderedFeatures(e.point, { layers: [VERTEX_LAYER] })
        if (hits.length > 0) {
          const rawIdx = hits[0].properties?.vertexIndex
          if (typeof rawIdx === 'number') {
            const next = ctx.polygon.vertices.filter((_, i) => i !== rawIdx)
            transformChangeRef.current?.({ vertices: next }, true)
            e.preventDefault?.()
            return
          }
        }
      }

      // Vertex handle → grab-and-drag reposition.
      if (map.getLayer(VERTEX_LAYER)) {
        const hits = map.queryRenderedFeatures(e.point, { layers: [VERTEX_LAYER] })
        if (hits.length > 0) {
          const rawIdx = hits[0].properties?.vertexIndex
          if (typeof rawIdx === 'number') {
            drag.dragging = true
            drag.vertexIndex = rawIdx
            drag.originalVertices = [...ctx.polygon.vertices]
            drag.originalPolygon = ctx.polygon
            drag.originalCenter = ctx.center
            map.dragPan.disable()
            canvas.style.cursor = 'grabbing'
            e.preventDefault?.()
            return
          }
        }
      }

      // Midpoint handle → insert a new vertex at that midpoint AND
      // immediately grab it for drag. The initial insert commits
      // synchronously (so the store sees the new vertex), then the
      // ongoing drag reuses the RAF/bypass path with the new index.
      if (map.getLayer(MIDPOINT_LAYER)) {
        const hits = map.queryRenderedFeatures(e.point, { layers: [MIDPOINT_LAYER] })
        if (hits.length > 0) {
          const rawEdge = hits[0].properties?.edgeIndex
          if (typeof rawEdge === 'number') {
            const orig = ctx.polygon.vertices
            const insertAt = rawEdge + 1
            const a = orig[rawEdge]
            const b = orig[(rawEdge + 1) % orig.length]
            const midLocal: [number, number] = [
              (a[0] + b[0]) / 2,
              (a[1] + b[1]) / 2,
            ]
            const next: [number, number][] = [
              ...orig.slice(0, insertAt),
              midLocal,
              ...orig.slice(insertAt),
            ]
            drag.dragging = true
            drag.vertexIndex = insertAt
            drag.originalVertices = next
            drag.originalPolygon = { ...ctx.polygon, vertices: next }
            drag.originalCenter = ctx.center
            // Commit the vertex insert so the store sees the new
            // vertex count. The subsequent RAF-driven drag will
            // reposition the same index without further commits until
            // mouseup.
            transformChangeRef.current?.({ vertices: next }, true)
            map.dragPan.disable()
            canvas.style.cursor = 'grabbing'
            e.preventDefault?.()
            return
          }
        }
      }
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
      const next = computeNextVertices(cursor)
      drag.originalPolygon = null
      drag.originalCenter = null
      drag.originalVertices = null
      drag.vertexIndex = -1
      if (next) transformChangeRef.current?.({ vertices: next }, true)
    }
    const onEnterVertex = () => {
      if (!drag.dragging) canvas.style.cursor = 'grab'
    }
    const onEnterMidpoint = () => {
      if (!drag.dragging) canvas.style.cursor = 'copy'
    }
    const onLeave = () => {
      if (!drag.dragging) canvas.style.cursor = ''
    }

    map.on('mousedown', onMouseDown)
    map.on('mousemove', onMouseMove)
    map.on('mouseup', onMouseUp)
    map.on('mouseenter', VERTEX_LAYER, onEnterVertex)
    map.on('mouseleave', VERTEX_LAYER, onLeave)
    map.on('mouseenter', MIDPOINT_LAYER, onEnterMidpoint)
    map.on('mouseleave', MIDPOINT_LAYER, onLeave)
    return () => {
      map.off('mousedown', onMouseDown)
      map.off('mousemove', onMouseMove)
      map.off('mouseup', onMouseUp)
      map.off('mouseenter', VERTEX_LAYER, onEnterVertex)
      map.off('mouseleave', VERTEX_LAYER, onLeave)
      map.off('mouseenter', MIDPOINT_LAYER, onEnterMidpoint)
      map.off('mouseleave', MIDPOINT_LAYER, onLeave)
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
