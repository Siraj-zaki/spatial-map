import {
  buildImageFeatureCollection,
  effectiveImageCrop,
  imageBboxCenter,
  imageCorners,
  imageCroppedCorners,
  rotatePointAround,
  type ImageProps,
  imageLngLatToUV,
} from '@/lib/image-generators'
import { urlForImage } from '@/lib/binary-store'
import type { ImageShape, LineShape } from '@/lib/shapes'
import { wallOutline } from '@/lib/floor-base'
import { buffer as turfBuffer } from '@turf/turf'
import {
  TRANSFORM_ICON,
  readThemePrimaryForegroundHex,
  readThemePrimaryHex,
  registerTransformHandleIcons,
  subscribeThemeChanges,
} from '@/lib/map-transform-handles'
import {
  FloorPlanLayer,
  styleHasSlot,
  type FloorPlanLayerState,
  type FloorPlanUV,
} from '@/lib/floor-plan-layer'
import type {
  GeoJSONSource,
  Map as MapboxMapInstance,
  MapMouseEvent,
} from 'mapbox-gl'
import { useEffect, useMemo, useRef, useState } from 'react'

interface MapImageOverlayProps {
  map: MapboxMapInstance | null
  /** Committed images. */
  images?: ReadonlyArray<ImageShape>
  /** Live in-progress draw preview (drag from mousedown to mouseup). */
  livePreview?: ImageShape | null
  selectedImageIds?: ReadonlySet<number>
  onImageClick?: (id: number, originalEvent: MouseEvent) => void
  onMapClickEmpty?: () => void
  /** Master visibility toggle. */
  committedVisible?: boolean
  /**
   * When false, clicks on images pass through to the map so a create-*
   * tool can drop a new shape on top of an existing image. Same gate as
   * the polygon overlay.
   */
  selectionEnabled?: boolean
  /**
   * When set, an interactive move/rotate/scale transform runs on the
   * given image. The overlay renders a theme-tinted drag handle
   * (canvas-painted glyph in the palette's `--primary` colour, always
   * visible above 3D content) and forwards new geometry up via
   * `onTransformChange`; `commit` fires on mouseup.
   */
  transformState?: {
    imageId: number
    kind: 'move' | 'rotate' | 'scale'
  } | null
  /**
   * Walls of every floor (any visibility), for the "hide outside walls"
   * floor-plan mask. Omit to disable masking.
   */
  wallLines?: ReadonlyArray<LineShape>
  onTransformChange?: (
    patch: {
      start?: [number, number]
      current?: [number, number]
      rotation?: number
    },
    commit: boolean
  ) => void
}

// Shared sources / layers (one of each, regardless of how many images).
const HIT_SOURCE = 'image-hit-source'
const HIT_LAYER = 'image-hit-layer'
const SELECTION_TINT_LAYER = 'image-selection-tint-layer'
const SELECTION_LAYER = 'image-selection-layer'
const PREVIEW_OUTLINE_LAYER = 'image-preview-outline-layer'
const LABEL_SOURCE = 'image-label-source'
const LABEL_LAYER = 'image-label-layer'
const TRANSFORM_SOURCE = 'image-transform-source'
const TRANSFORM_LAYER = 'image-transform-layer'
const TRANSFORM_ICON_LAYER = 'image-transform-icon-layer'
const CLIP_SOURCE = 'image-clip-source'
const CLIP_LAYER = 'image-clip-layer'
// In-flight sources — hold ONLY the image currently being moved / rotated
// / scaled. Filter out the transforming id from HIT / SELECTION / LABEL
// layers while the drag is live, and push the fresh geometry into the
// in-flight sources from the drag handler's RAF. This means the shared
// `fc` / `labelPointData` / `clipData` useMemos DON'T rebuild all N
// images' features every mousemove — the per-image raster's own
// `setCoordinates` remains the only per-frame work for the moving image.
const HIT_INFLIGHT_SOURCE = 'image-hit-inflight-source'
const HIT_INFLIGHT_LAYER = 'image-hit-inflight-layer'
const SELECTION_TINT_INFLIGHT_LAYER = 'image-selection-tint-inflight-layer'
const SELECTION_INFLIGHT_LAYER = 'image-selection-inflight-layer'
const LABEL_INFLIGHT_SOURCE = 'image-label-inflight-source'
const LABEL_INFLIGHT_LAYER = 'image-label-inflight-layer'

const rasterLayerId = (id: number) => `image-raster-layer-${id}`
const previewLayerId = 'image-raster-preview-layer'

/** Texture-space window for the shape's crop (percent inward per edge). */
function cropUV(img: ImageShape): FloorPlanUV | undefined {
  const crop = effectiveImageCrop(img.config.crop)
  if (!crop) return undefined
  return {
    u0: crop.left / 100,
    v0: crop.top / 100,
    u1: 1 - crop.right / 100,
    v1: 1 - crop.bottom / 100,
  }
}

/**
 * What the floor-plan layer draws for an image: the cropped quad (the
 * crop shrinks the footprint, rotated around the FULL bbox centre — see
 * `imageCroppedCorners`) with the matching texture window, at the
 * shape's exact elevation.
 */
/**
 * "Hide outside walls" mask for an image: the outer outline of the walls
 * on its floor, grown by `clipMargin`, in full-image UV. Null when the
 * option is off or the floor has no walls.
 */
function wallMaskUV(img: ImageShape, lines: ReadonlyArray<LineShape> | undefined): number[][][][] | null {
  if (!img.config.clipToWalls || img.id === undefined || !lines) return null
  // Walls on this floor; failing that, walls not assigned to any floor
  // (single-floor facilities often leave floorPlanId empty).
  const own = lines.filter((l) => l.floorPlanId === img.id)
  const outline = wallOutline(own.length > 0 ? own : lines.filter((l) => l.floorPlanId === undefined || l.floorPlanId === null))
  if (!outline) return null
  const margin = Math.max(0, img.config.clipMargin ?? 0.5)
  let area = outline
  if (margin > 0) {
    try {
      area = (turfBuffer(outline, margin, { units: 'meters' }) as typeof outline | undefined) ?? outline
    } catch {
      area = outline
    }
  }
  const full = { ...img, config: { ...img.config, crop: undefined } }
  const polys = area.geometry.type === 'Polygon' ? [area.geometry.coordinates] : area.geometry.coordinates
  const out: number[][][][] = []
  for (const poly of polys) {
    const rings: number[][][] = []
    for (const ring of poly) {
      const uv = ring.map(([lng, lat]) => imageLngLatToUV(full, lng, lat)).filter((p): p is [number, number] => p !== null)
      if (uv.length >= 3) rings.push(uv)
    }
    if (rings.length) out.push(rings)
  }
  return out.length ? out : null
}

function floorPlanState(img: ImageShape, visible: boolean, mask: number[][][][] | null = null): FloorPlanLayerState | null {
  const corners = imageCroppedCorners(img)
  if (!corners) return null
  return {
    mask,
    url: urlForImage(img),
    corners,
    uv: cropUV(img),
    elevation: img.config.elevation ?? 0,
    opacity: Math.max(0, Math.min(1, (img.config.opacity ?? 100) / 100)),
    visible,
  }
}

/**
 * Add the layer if the current style doesn't have it yet (first mount,
 * or a basemap swap dropped it). Standard styles put it in the `top`
 * slot: below every unslotted overlay, above the basemap's own layers.
 * Styles without that slot fall back to just under the image hit layer.
 */
function mountFloorPlanLayer(map: MapboxMapInstance, layer: FloorPlanLayer) {
  if (map.getLayer(layer.id)) return
  const useSlot = styleHasSlot(map, 'top')
  layer.slot = useSlot ? 'top' : undefined
  try {
    map.addLayer(layer, useSlot ? undefined : map.getLayer(HIT_LAYER) ? HIT_LAYER : undefined)
  } catch (err) {
    console.warn('[MapImageOverlay] floor-plan layer add failed', err)
  }
}

/**
 * Renders image-overlay shapes (floor plans) with one `FloorPlanLayer`
 * per shape — a custom WebGL layer that draws the image as a textured
 * quad at its exact elevation (see src/lib/floor-plan-layer.ts for why
 * not a `raster` layer). A shared GeoJSON polygon source carries the bbox quads
 * (in lng/lat space) and feeds three render passes:
 *
 *   - hit-test layer (transparent fill, picks up clicks)
 *   - selection outline (theme-primary border, live-updated on palette /
 *     light-dark swaps via `setPaintProperty`)
 *   - label layer (symbol text)
 *
 * Move / rotate / scale use a symbol-typed transform handle layer with
 * theme-tinted canvas icons (see `src/lib/map-transform-handles.ts`):
 * the handle sits at the image's elevation in world Z
 * (`symbol-z-offset`), stays above 3D content (`symbol-z-elevate`), and
 * is re-elevated to the top of the layer stack whenever other overlays
 * mount so it can never be occluded by a later-added extrusion.
 */
export function MapImageOverlay({
  map,
  images,
  livePreview = null,
  selectedImageIds,
  onImageClick,
  onMapClickEmpty,
  committedVisible = true,
  selectionEnabled = true,
  transformState = null,
  onTransformChange,
  wallLines,
}: MapImageOverlayProps) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  // `styleGen` bumps on every style.load — see matching note in
  // `map-polygon-overlay.tsx`. Source/layer effect deps include it so
  // basemap swaps trigger a fresh setup pass.
  const [styleGen, setStyleGen] = useState(0)

  // ---- Style readiness (same pattern as polygon overlay) -----------------
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

  // ---- Data --------------------------------------------------------------
  const fc = useMemo(
    () => buildImageFeatureCollection(images ?? [], livePreview),
    [images, livePreview]
  )

  // Label data — one Point per image at the bbox center. Mirrors the
  // grid / polygon / circle pattern: a Point source + symbol layer is
  // far more reliable for `symbol-z-elevate` / `symbol-z-offset` than
  // a Polygon source.
  const labelPointData = useMemo<
    GeoJSON.FeatureCollection<GeoJSON.Point, ImageProps> | null
  >(() => {
    const list = images ?? []
    if (list.length === 0) return null
    const features: GeoJSON.Feature<GeoJSON.Point, ImageProps>[] = []
    for (const img of list) {
      if (img.visible === false) continue
      if (!img.config.showLabels) continue
      const labelText =
        img.config.label && img.config.label.trim() !== ''
          ? img.config.label
          : (img.name ?? '')
      if (labelText.trim() === '') continue
      const center = imageBboxCenter(img)
      if (!center || img.id === undefined) continue
      features.push({
        type: 'Feature',
        properties: {
          id: `image-label-${img.id}`,
          imageId: img.id,
          rotation: img.rotation,
          opacity: img.config.opacity,
          showLabels: true,
          label: labelText,
          labelSize: img.config.labelSize,
          labelColor: img.config.labelColor,
        },
        geometry: { type: 'Point', coordinates: center },
      })
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [images])

  // Clip footprints — one polygon per committed image (live preview is
  // excluded so the basemap doesn't flash buildings in and out while the
  // user is still dragging the bbox). Fed to the `clip` layer so Mapbox
  // erases basemap 3D buildings + symbols underneath each image, matching
  // the grid / circle / polygon overlays. Only emits features when there
  // is something to clip; otherwise the layer renders empty.
  const clipData = useMemo<GeoJSON.FeatureCollection<GeoJSON.Polygon> | null>(() => {
    const list = images ?? []
    if (list.length === 0) return null
    const features: GeoJSON.Feature<GeoJSON.Polygon>[] = []
    for (const img of list) {
      if (img.visible === false) continue
      const corners = imageCorners(img)
      if (!corners) continue
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
        },
      })
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [images])

  // ---- Shared layer setup ------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    try {
      if (!map.getSource(HIT_SOURCE)) {
        map.addSource(HIT_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getSource(LABEL_SOURCE)) {
        map.addSource(LABEL_SOURCE, {
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
      if (!map.getSource(CLIP_SOURCE)) {
        map.addSource(CLIP_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }

      // Hit layer — transparent fill so clicks land on the bbox quad.
      // The raster layer underneath does the actual visual rendering.
      if (!map.getLayer(HIT_LAYER)) {
        map.addLayer({
          id: HIT_LAYER,
          type: 'fill',
          source: HIT_SOURCE,
          filter: ['!=', ['get', 'preview'], true],
          paint: {
            'fill-color': '#000000',
            'fill-opacity': 0,
          },
        })
      }
      // Selection tint — semi-transparent theme-primary fill over the
      // whole image bbox when selected. Renders as a paper-thin
      // fill-extrusion at the raster's altitude so the tint reads
      // correctly under pitch (the flat `fill` alternative would sit
      // on the ground plane and drift out from under a raised floor
      // plan). Border-only selection was legible on hover but easy to
      // miss when the map is busy; the whole-area wash makes the
      // "which image am I editing?" answer unambiguous.
      if (!map.getLayer(SELECTION_TINT_LAYER)) {
        const tintLayerDef = {
          id: SELECTION_TINT_LAYER,
          type: 'fill-extrusion',
          source: HIT_SOURCE,
          filter: ['==', ['get', 'imageId'], -1],
          paint: {
            'fill-extrusion-color': '#facc15', // placeholder — theme effect overwrites
            'fill-extrusion-opacity': 0.18,
            // Base at the shape's elevation, height 5 cm above it —
            // the "min-thickness paper slab" trick from AGENTS.md
            // that prevents the layer from vanishing at grazing
            // pitch / low zoom. Vertical gradient disabled because
            // gradient over a 5 cm span collapses to near-black.
            'fill-extrusion-base': [
              'coalesce',
              ['to-number', ['get', 'elevation']],
              0,
            ],
            'fill-extrusion-height': [
              '+',
              ['coalesce', ['to-number', ['get', 'elevation']], 0],
              0.05,
            ],
            'fill-extrusion-vertical-gradient': false,
            'fill-extrusion-emissive-strength': 1,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any
        map.addLayer(tintLayerDef)
      }
      // Selection outline.
      if (!map.getLayer(SELECTION_LAYER)) {
        map.addLayer({
          id: SELECTION_LAYER,
          type: 'line',
          source: HIT_SOURCE,
          filter: ['==', ['get', 'imageId'], -1],
          paint: {
            'line-color': '#fde047',
            'line-width': 3,
            'line-blur': 0.5,
            'line-emissive-strength': 1,
          },
        })
      }
      // Dashed outline for the live-draw preview bbox.
      if (!map.getLayer(PREVIEW_OUTLINE_LAYER)) {
        map.addLayer({
          id: PREVIEW_OUTLINE_LAYER,
          type: 'line',
          source: HIT_SOURCE,
          filter: ['==', ['get', 'preview'], true],
          paint: {
            'line-color': '#fbbf24',
            'line-width': 2,
            'line-dasharray': [2, 2],
          },
        })
      }
      // Drop a stale LABEL_LAYER left over from the pre-Point-source
      // build (still bound to HIT_SOURCE) so HMR picks up the new wiring.
      const existingImageLabel = map.getStyle()?.layers?.find((l) => l.id === LABEL_LAYER) as
        | { source?: string }
        | undefined
      if (existingImageLabel && existingImageLabel.source !== LABEL_SOURCE) {
        try { map.removeLayer(LABEL_LAYER) } catch { /* ignore */ }
      }
      // Label layer (symbol over center) — Point-source so labels render
      // reliably even on flat images. Mirrors the grid / polygon / circle
      // pattern. Images are always flat so no `symbol-z-offset` is
      // needed; label sits at ground.
      if (!map.getLayer(LABEL_LAYER)) {
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
        }
        map.addLayer({
          id: LABEL_LAYER,
          type: 'symbol',
          source: LABEL_SOURCE,
          layout,
          paint,
        })
      }
      // Transform handle — symbol layer with theme-tinted canvas icons.
      // Why symbol (not circle):
      //   - Mapbox 3.25 has no `circle-z-offset`, so a circle handle
      //     always sat on the ground plane regardless of the image's
      //     `config.elevation`. Symbols support `symbol-z-offset` +
      //     `symbol-elevation-reference: 'sea'` — the handle lifts to
      //     the shape's altitude in world Z so it appears exactly where
      //     the user perceives the floor plan sitting.
      //   - Circles participate in the depth test, so any 3D
      //     fill-extrusion at the same elevation (e.g. a rack polygon
      //     next to the floor plan) occluded the handle. `symbol-z-elevate:
      //     true` forces the handle to render above all 3D content,
      //     giving the "always-visible HUD" behaviour a transform
      //     control should have.
      //   - Icons are canvas bitmaps painted with the current theme's
      //     `--primary` colour (see `map-transform-handles.ts`), so the
      //     handles match whatever palette + mode the user has picked
      //     instead of showing a hardcoded orange dot.
      //
      // TRANSFORM_ICON_LAYER (kept as a module-level constant for
      // cleanup / removal ordering) is now unused — the single symbol
      // layer draws the whole handle including its inner glyph. The
      // constant survives so the removeLayer loop below doesn't need
      // conditional logic per style version.
      // HMR safety: if a previous build left a `type: 'circle'`
      // TRANSFORM_LAYER (or any other stale type) alive on the map, the
      // guarded `if (!getLayer)` below would skip re-adding — the user
      // would keep seeing the old hardcoded-orange circle handle
      // forever. Mirror the LABEL_LAYER stale-check pattern above.
      const existingTransform = map.getStyle()?.layers?.find(
        (l) => l.id === TRANSFORM_LAYER,
      ) as { type?: string } | undefined
      if (existingTransform && existingTransform.type !== 'symbol') {
        try { map.removeLayer(TRANSFORM_LAYER) } catch { /* ignore */ }
      }
      if (!map.getLayer(TRANSFORM_LAYER)) {
        // Whole-def cast keeps the source clean — Mapbox 3.25's TS
        // typings don't yet include every new symbol elevation prop
        // (`symbol-elevation-reference`, `symbol-z-offset` as paint,
        // `symbol-z-elevate`) but the runtime accepts them.
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
            // Per-corner icon orientation:
            //
            // Scale glyph (NW-SE diagonal double-arrow, drawn in the
            // canvas as a "\"): rotate 90° for TR (1) and BL (3) so
            // it becomes a "/" (NE-SW) matching those corners' resize
            // axis. TL (0) + BR (2) keep the default 0°.
            //
            // Rotate glyph (curl in the top-right quadrant of the
            // canvas by default): rotate 270° for TL (0), 0° for TR
            // (1), 90° for BR (2), 180° for BL (3) so the curl always
            // faces outward from the image centre — the visual reads
            // as "grab this corner and pivot around the middle".
            //
            // Move features carry cornerIndex = -1 so both matches
            // fall through to 0 (no rotation).
            // Per-kind icon orientation.
            //
            // move   → always 0° (screen-space). A 4-directional cross
            //          tilted with the image would render as a diamond,
            //          which reads as "move diagonally" instead of
            //          "move freely". Move is world-space anyway.
            //
            // scale  → per-corner base (0° or 90°) only, no image
            //          rotation added. This keeps the diagonal double-
            //          arrow visually readable at any image rotation —
            //          users see "\" or "/" and immediately understand
            //          the resize axis. Adding image rotation made the
            //          arrows tilt into off-axis directions that looked
            //          arbitrary and disconnected from the resize
            //          gesture (which is still along the corner's true
            //          diagonal — the icon just doesn't advertise it).
            //
            // rotate → per-corner base (270/0/90/180) + image rotation.
            //          The curl MUST track the image so it always
            //          faces outward from the image centre at each
            //          corner. Without this, on a 90°-rotated image
            //          the curl at corner 0 (now visually at top-right)
            //          would still point top-left — reading as inward.
            'icon-rotate': [
              'match',
              ['get', 'kind'],
              'move', 0,
              'scale',
              [
                'case',
                [
                  'any',
                  ['==', ['get', 'cornerIndex'], 1],
                  ['==', ['get', 'cornerIndex'], 3],
                ],
                90,
                0,
              ],
              'rotate',
              [
                '+',
                [
                  'match',
                  ['get', 'cornerIndex'],
                  0, 270,
                  1, 0,
                  2, 90,
                  3, 180,
                  0,
                ],
                ['coalesce', ['to-number', ['get', 'imageRotation']], 0],
              ],
              0,
            ],
            // Force the handle above all 3D content (extrusions,
            // buildings, models). `symbol-z-elevate: true` moves it
            // out of the depth-tested pool onto Mapbox's HUD pass.
            'symbol-z-elevate': true,
            // Peg the offset to absolute world Z rather than terrain,
            // matching the raster's `raster-elevation-reference`.
            'symbol-elevation-reference': 'sea',
          },
          paint: {
            'icon-emissive-strength': 1,
            // Position handle at the image's altitude. Coalesce guards
            // against pre-elevation shapes that never had the field.
            'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any
        map.addLayer(transformLayerDef)
      }

      // Clip layer — erases basemap buildings + symbols inside every
      // image footprint so an uploaded floor plan / site photo doesn't
      // get visually intersected by Mapbox's own 3D buildings. Mapbox
      // GL JS v3 + Standard style only; gracefully ignored elsewhere.
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any)
        } catch (err) {
          if (import.meta.env.DEV) {
            console.debug('[MapImageOverlay] clip layer not supported by this style', err)
          }
        }
      }

      // In-flight sources + layers (transforming image). Same paint
      // recipes as HIT_LAYER / SELECTION_TINT_LAYER / SELECTION_LAYER /
      // LABEL_LAYER so the moving image renders identically. No filters
      // — the sources themselves are gated by the transform-active
      // population effect.
      if (!map.getSource(HIT_INFLIGHT_SOURCE)) {
        map.addSource(HIT_INFLIGHT_SOURCE, {
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
      if (!map.getLayer(HIT_INFLIGHT_LAYER)) {
        map.addLayer({
          id: HIT_INFLIGHT_LAYER,
          type: 'fill',
          source: HIT_INFLIGHT_SOURCE,
          paint: {
            'fill-color': '#000000',
            'fill-opacity': 0,
          },
        })
      }
      // Selection tint on the in-flight source — mirrors SELECTION_TINT_LAYER
      // paint. Theme-tinted via the same setPaintProperty effect that
      // targets SELECTION_TINT_LAYER.
      if (!map.getLayer(SELECTION_TINT_INFLIGHT_LAYER)) {
        const tintInflightDef = {
          id: SELECTION_TINT_INFLIGHT_LAYER,
          type: 'fill-extrusion',
          source: HIT_INFLIGHT_SOURCE,
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
              0.05,
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
          source: HIT_INFLIGHT_SOURCE,
          paint: {
            'line-color': '#fde047',
            'line-width': 3,
            'line-blur': 0.5,
            'line-emissive-strength': 1,
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
      console.warn('[MapImageOverlay] ensure layers failed', err)
    }

    return () => {
      for (const id of [
        CLIP_LAYER,
        TRANSFORM_ICON_LAYER,
        TRANSFORM_LAYER,
        LABEL_INFLIGHT_LAYER,
        SELECTION_INFLIGHT_LAYER,
        SELECTION_TINT_INFLIGHT_LAYER,
        HIT_INFLIGHT_LAYER,
        LABEL_LAYER,
        PREVIEW_OUTLINE_LAYER,
        SELECTION_LAYER,
        SELECTION_TINT_LAYER,
        HIT_LAYER,
      ]) {
        try {
          if (map.getLayer(id)) map.removeLayer(id)
        } catch {
          /* ignore */
        }
      }
      for (const id of [
        HIT_SOURCE,
        LABEL_SOURCE,
        TRANSFORM_SOURCE,
        CLIP_SOURCE,
        HIT_INFLIGHT_SOURCE,
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

  // ---- Theme-tinted transform-handle icons ------------------------------
  // Register the move / rotate / scale icons with the map whenever the
  // theme's `--primary` colour changes (palette pick or light/dark
  // toggle) OR the basemap style reloads (Mapbox drops all registered
  // images on style swap, so we have to re-register on `styleGen` bump).
  // Live palette swaps then update instantly without needing the user
  // to reselect the shape.
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

  // Push the theme primary colour into the selection outline, the
  // whole-area selection tint, the in-flight equivalents, and the
  // live-preview outline so every "which image am I picking?" cue
  // matches the palette instead of showing hardcoded yellow / orange.
  // Mapbox's `setPaintProperty` is safe to call every render — a
  // no-op when the value is unchanged.
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
    try {
      if (map.getLayer(PREVIEW_OUTLINE_LAYER)) {
        map.setPaintProperty(PREVIEW_OUTLINE_LAYER, 'line-color', primaryHex)
      }
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, primaryHex])

  // Keep the transform handle + selection outline + in-flight surfaces
  // at the top of the layer stack. Other overlays (polygon, circle,
  // grid, model, line, stair, door, image-plane) all register their
  // own unslotted layers, and Mapbox draws unslotted layers in
  // insertion order. Whichever overlay mounts LAST wins — so a handle
  // registered when the image overlay mounted (early in the tree)
  // inevitably ends up under everything that mounted later.
  // `moveLayer(id)` with no `beforeId` slides the target layer to the
  // very top of the stack. Deps include `transformState` because when
  // the user clicks Move / Rotate / Scale, the handle has to be
  // clickable IMMEDIATELY — other overlays that mounted after us in
  // the tree will otherwise occlude the transform layer. `images` +
  // `selectedImageIds` are intentionally OMITTED — the drag handler
  // bypasses React state during a drag so `images` doesn't churn,
  // and per-selection re-elevation was purely defensive.
  useEffect(() => {
    if (!map || !styleLoaded) return
    // Move in bottom-to-top order so the final stack reads:
    //   tint → selection outline → in-flight tint / halo → transform.
    for (const id of [
      SELECTION_TINT_LAYER,
      SELECTION_LAYER,
      HIT_INFLIGHT_LAYER,
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

  // ---- Floor-plan layers ---------------------------------------------------
  // One FloorPlanLayer (a Mapbox custom layer, see src/lib/floor-plan-layer.ts)
  // per visible image. It replaced `image` source + `raster` layer with
  // `raster-elevation`, whose experimental elevated path made the plan
  // vanish when zoomed in without tilt and hid shapes standing on it at
  // mid zooms. The custom layer draws the image at its exact elevation,
  // crops with texture coordinates (no canvas re-encode) and takes new
  // corners in place, so move / rotate / scale drags stay smooth.
  const floorLayersRef = useRef<Map<number, FloorPlanLayer>>(new Map())
  // "Hide outside walls" masks, rebuilt only when images or walls change
  // (not on camera moves / unrelated renders).
  const masks = useMemo(() => {
    const m = new Map<number, number[][][][] | null>()
    for (const img of images ?? []) if (img.id !== undefined) m.set(img.id, wallMaskUV(img, wallLines))
    return m
  }, [images, wallLines])
  useEffect(() => {
    if (!map || !styleLoaded) return
    const layers = floorLayersRef.current
    const wantedIds = new Set<number>()
    for (const img of images ?? []) {
      if (img.id === undefined || img.visible === false) continue
      const state = floorPlanState(img, committedVisible, masks.get(img.id) ?? null)
      if (!state) continue
      wantedIds.add(img.id)
      let layer = layers.get(img.id)
      if (layer) {
        layer.update(state)
      } else {
        layer = new FloorPlanLayer(rasterLayerId(img.id), state)
        layers.set(img.id, layer)
      }
      mountFloorPlanLayer(map, layer)
    }
    // Drop layers for images that no longer exist (or were hidden).
    for (const [id, layer] of layers) {
      if (wantedIds.has(id)) continue
      try {
        if (map.getLayer(layer.id)) map.removeLayer(layer.id)
      } catch {
        /* ignore */
      }
      layers.delete(id)
    }
  }, [map, styleLoaded, styleGen, images, committedVisible, masks])

  // Cleanup on unmount — remove every floor-plan layer we added.
  useEffect(() => {
    const layers = floorLayersRef.current
    return () => {
      const m = map
      if (!m) return
      for (const layer of layers.values()) {
        try {
          if (m.getLayer(layer.id)) m.removeLayer(layer.id)
        } catch {
          /* ignore */
        }
      }
      layers.clear()
      try {
        if (m.getLayer(previewLayerId)) m.removeLayer(previewLayerId)
      } catch {
        /* ignore */
      }
    }
  }, [map])

  // ---- Live preview (during drag-to-place) ---------------------------------
  // Same renderer at 70% of the configured opacity; new corners every
  // mousemove go straight into the layer.
  const previewLayerRef = useRef<FloorPlanLayer | null>(null)
  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!livePreview) {
      try {
        if (map.getLayer(previewLayerId)) map.removeLayer(previewLayerId)
      } catch {
        /* ignore */
      }
      previewLayerRef.current = null
      return
    }
    const state = floorPlanState(livePreview, true)
    if (!state) return
    state.opacity *= 0.7
    let layer = previewLayerRef.current
    if (layer) {
      layer.update(state)
    } else {
      layer = new FloorPlanLayer(previewLayerId, state)
      previewLayerRef.current = layer
    }
    mountFloorPlanLayer(map, layer)
  }, [map, styleLoaded, styleGen, livePreview])

  // ---- Push hit-test / selection / label data ---------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(HIT_SOURCE) as GeoJSONSource | undefined
    if (src) {
      src.setData(fc as GeoJSON.FeatureCollection<GeoJSON.Polygon, ImageProps>)
    }
    const labelSrc = map.getSource(LABEL_SOURCE) as GeoJSONSource | undefined
    if (labelSrc) {
      labelSrc.setData(
        (labelPointData ?? { type: 'FeatureCollection', features: [] }) as GeoJSON.FeatureCollection
      )
    }
    const clipSrc = map.getSource(CLIP_SOURCE) as GeoJSONSource | undefined
    if (clipSrc) {
      clipSrc.setData(
        clipData ?? { type: 'FeatureCollection', features: [] }
      )
    }
  }, [map, styleLoaded, styleGen, fc, labelPointData, clipData])

  // Selection filter. Mirrored to the whole-area tint layer so the
  // wash appears + disappears with the border in perfect sync. Composed
  // with the transform exclusion — while a transform is active, the
  // committed halo/tint are suppressed and the in-flight
  // SELECTION_INFLIGHT_LAYER / SELECTION_TINT_INFLIGHT_LAYER paint
  // takes over (they read the HIT_INFLIGHT_SOURCE which holds the
  // moving image's geometry).
  useEffect(() => {
    if (!map || !styleLoaded) return
    const ids =
      selectedImageIds && selectedImageIds.size > 0
        ? [...selectedImageIds]
        : [-1]
    const excludeId = transformState?.imageId
    const idFilter = ['in', ['get', 'imageId'], ['literal', ids]]
    const filter = excludeId != null
      ? ['all', idFilter, ['!=', ['get', 'imageId'], excludeId]]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : (idFilter as unknown as any)
    try {
      if (map.getLayer(SELECTION_LAYER)) {
        map.setFilter(SELECTION_LAYER, filter)
      }
    } catch { /* ignore */ }
    try {
      if (map.getLayer(SELECTION_TINT_LAYER)) {
        map.setFilter(SELECTION_TINT_LAYER, filter)
      }
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, selectedImageIds, transformState])

  // ---- Exclusion filter (committed hit + label layers) -----------------
  // While a transform is active, hide the moving image from HIT_LAYER
  // and LABEL_LAYER so it doesn't render twice — once at its stale
  // committed geometry (via the shared hit / label collections), and
  // once on HIT_INFLIGHT_LAYER / LABEL_INFLIGHT_LAYER at its live drag
  // position. HIT_LAYER already carries a `!= preview` filter that we
  // preserve by composing. Cleared when no transform is active.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const excludeId = transformState?.imageId
    // HIT_LAYER: preserve the existing `!= preview` filter.
    try {
      if (map.getLayer(HIT_LAYER)) {
        const notPreview = ['!=', ['get', 'preview'], true]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const filter: any = excludeId != null
          ? ['all', notPreview, ['!=', ['get', 'imageId'], excludeId]]
          : notPreview
        map.setFilter(HIT_LAYER, filter)
      }
    } catch { /* ignore */ }
    // LABEL_LAYER: no default filter.
    try {
      if (map.getLayer(LABEL_LAYER)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const filter: any = excludeId != null
          ? ['!=', ['get', 'imageId'], excludeId]
          : null
        map.setFilter(LABEL_LAYER, filter)
      }
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, transformState])

  // Visibility toggle for the shared layers (per-image raster layers are
  // toggled inside the sync effect above).
  useEffect(() => {
    if (!map || !styleLoaded) return
    const vis = committedVisible ? 'visible' : 'none'
    for (const id of [HIT_LAYER, SELECTION_TINT_LAYER, SELECTION_LAYER, LABEL_LAYER]) {
      try {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis)
      } catch {
        /* ignore */
      }
    }
  }, [map, styleLoaded, styleGen, committedVisible])

  // ---- Click / hover handling -------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded || !selectionEnabled) return
    // Image is the LOWEST-priority shape — a floor-plan typically
    // covers the entire workspace, so every click on a rack / line /
    // polygon / circle inevitably also overlaps the image. The DOM
    // `defaultPrevented` gate only catches the case where a higher-
    // priority shape's click handler ran FIRST. But Mapbox dispatches
    // layer-click listeners in registration order, and the image
    // overlay registers first (its layer is the bottom of the visual
    // stack, so it mounts first). Without an explicit priority
    // check, the image handler runs ahead of every other shape and
    // wins every click. Hardcoding the higher-priority layer ids is
    // ugly but reliable — they are stable module-level constants in
    // the other overlay files.
    // NOTE: the extrude layers for grid/polygon/circle are split into
    // 11 per-opacity-bucket layers (each suffixed `-op0` … `-op100`),
    // because Mapbox doesn't support data-driven `fill-extrusion-opacity`.
    // Listing the unsuffixed base name here is a silent no-op — it
    // simply doesn't match any real layer, and the image then wins
    // every click on a 3D-extruded shape. Enumerate all buckets.
    const OPACITY_BUCKETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const extrudeBuckets = (base: string) =>
      OPACITY_BUCKETS.map((b) => `${base}-op${b}`)
    const HIGHER_PRIORITY_LAYERS = [
      // grid (map-grid-overlay)
      'grid-fill-layer',
      'grid-line-layer',
      ...extrudeBuckets('grid-extrude-layer'),
      // circle (map-circle-overlay)
      'circle-fill-layer',
      ...extrudeBuckets('circle-extrude-layer'),
      'circle-line-layer',
      // polygon (map-polygon-overlay)
      ...extrudeBuckets('polygon-extrude-layer'),
      'polygon-line-layer',
      // line (map-line-overlay)
      'line-stroke-layer',
      'line-wall-layer',
    ]
    const handleImageClick = (
      e: MapMouseEvent & { features?: GeoJSON.Feature[] }
    ) => {
      if (e.originalEvent?.defaultPrevented) return
      // Defer to any higher-priority shape at the click point. Without
      // this, clicking a rack or a drawn line / polygon / circle would
      // also select the floor-plan image underneath.
      //
      // Model layers are dynamic (`model-shapes-layer-<sanitizedAssetId>`,
      // one per distinct asset id) so we can't list them at module load —
      // resolve them from the current style at click time.
      const styleLayers = (map.getStyle()?.layers ?? []) as Array<{ id: string }>
      const dynamicModelLayers = styleLayers
        .filter((l) => l.id.startsWith('model-shapes-layer-'))
        .map((l) => l.id)
      const presentHigherLayers = [
        ...HIGHER_PRIORITY_LAYERS.filter((l) => map.getLayer(l)),
        ...dynamicModelLayers,
      ]
      if (presentHigherLayers.length > 0) {
        // Use a small bbox instead of `e.point` so we hit-test against a
        // 12×12 px window. Mapbox's `model` layer type often misses
        // single-pixel hits on mesh edges — this matches the buffer the
        // model overlay uses for its own click handler.
        const HIT_BUFFER = 6
        const bbox: [[number, number], [number, number]] = [
          [e.point.x - HIT_BUFFER, e.point.y - HIT_BUFFER],
          [e.point.x + HIT_BUFFER, e.point.y + HIT_BUFFER],
        ]
        const blocking = map.queryRenderedFeatures(bbox, {
          layers: presentHigherLayers,
        })
        if (blocking.length > 0) return
      }
      const feat = e.features?.[0]
      if (!feat) return
      const id = feat.properties?.imageId
      if (typeof id === 'number') {
        e.preventDefault()
        e.originalEvent?.preventDefault?.()
        onImageClick?.(id, e.originalEvent)
      }
    }
    const handleMapClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      if (!map.getLayer(HIT_LAYER)) return
      const hits = map.queryRenderedFeatures(e.point, { layers: [HIT_LAYER] })
      if (hits.length === 0) onMapClickEmpty?.()
    }
    const handleEnter = () => {
      map.getCanvas().style.cursor = 'pointer'
    }
    const handleLeave = () => {
      map.getCanvas().style.cursor = ''
    }
    map.on('click', HIT_LAYER, handleImageClick)
    map.on('click', handleMapClick)
    map.on('mouseenter', HIT_LAYER, handleEnter)
    map.on('mouseleave', HIT_LAYER, handleLeave)
    return () => {
      map.off('click', HIT_LAYER, handleImageClick)
      map.off('click', handleMapClick)
      map.off('mouseenter', HIT_LAYER, handleEnter)
      map.off('mouseleave', HIT_LAYER, handleLeave)
    }
  }, [map, styleLoaded, styleGen, selectionEnabled, onImageClick, onMapClickEmpty])

  // ---- Transform handle (modeled on polygon overlay) --------------------
  const transformChangeRef = useRef(onTransformChange)
  useEffect(() => {
    transformChangeRef.current = onTransformChange
  }, [onTransformChange])

  // Compute the handle position(s) from the current image.
  //   - Move   → single handle at bbox center.
  //   - Scale  → FOUR handles, one at each rotated bbox corner
  //              (TL, TR, BR, BL per `imageCorners`). Dragging any
  //              corner scales from that corner; the diagonally
  //              opposite corner stays fixed on the map.
  //   - Rotate → FOUR handles, one at each rotated bbox corner.
  //              Dragging any corner rotates the image around its
  //              centre by the angular delta between the corner's
  //              original position and the cursor (both relative to
  //              centre).
  //
  // `handleCorners` unifies both 4-handle modes so the push effect
  // and drag logic don't need to know which one is active — they
  // just iterate the corners. `anchor` is the fallback used only by
  // the move gesture (which has no corners).
  const transformContext = useMemo(() => {
    if (!transformState || !images) return null
    const img = images.find((x) => x.id === transformState.imageId)
    if (!img) return null
    const center = imageBboxCenter(img)
    if (!center) return null
    if (transformState.kind === 'move') {
      return {
        image: img,
        anchor: center,
        center,
        handleCorners: null as [number, number][] | null,
      }
    }
    const corners = imageCorners(img)
    if (!corners) return null
    // Both scale AND rotate paint at the 4 corners.
    return {
      image: img,
      // Retained as a fallback; onMouseDown reads the clicked
      // feature's cornerIndex when available.
      anchor: corners[0],
      center,
      handleCorners: [corners[0], corners[1], corners[2], corners[3]],
    }
  }, [transformState, images])

  // Push handle position into the transform source.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    if (!transformContext || !transformState) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    // Stamp the icon id + shape elevation on every handle feature so
    // the symbol layer's `icon-image` picks the right glyph (move /
    // rotate / scale) and `symbol-z-offset` lifts the handle to the
    // image's altitude. Elevation is coerced through max(0.1, elevation)
    // to mirror the raster's own 10 cm minimum, so the handle stays
    // glued to the same world Z as the raster it belongs to (avoids a
    // per-zoom visual drift when the image sits at elevation 0).
    //
    // Scale emits four features (one per rotated bbox corner), each
    // stamped with `cornerIndex: 0..3` so:
    //   - The drag onMouseDown can attribute the click to a specific
    //     corner and pick the diagonally opposite as the fixed anchor.
    //   - The layer's `icon-rotate` expression can flip the double-
    //     arrow glyph 90° for TR / BL corners so it visually reads as
    //     the NE-SW diagonal instead of the NW-SE default.
    //   - The mousemove cursor handler can switch between
    //     nwse-resize (TL / BR) and nesw-resize (TR / BL).
    const elevationForHandle = Math.max(
      0.1,
      transformContext.image.config.elevation ?? 0,
    )
    // Stamp the image's current rotation on every handle feature so
    // the icon-rotate expression can add it to the per-corner base
    // offset — the scale arrows then visually track the diagonal of
    // the rotated bbox, and the rotate curls track the corner they
    // sit at even when the image is rotated 45° / 90° / etc.
    const imageRotation = transformContext.image.rotation ?? 0
    const features: GeoJSON.Feature<GeoJSON.Point>[] = []
    if (transformContext.handleCorners) {
      // Both scale AND rotate render 4 corner handles. The kind flag
      // on each feature selects which glyph the icon-image expression
      // picks (scale vs rotate) and drives the per-corner drag logic
      // in onMouseDown.
      for (let i = 0; i < transformContext.handleCorners.length; i++) {
        features.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: transformContext.handleCorners[i],
          },
          properties: {
            kind: transformState.kind,
            iconId: TRANSFORM_ICON[transformState.kind],
            elevation: elevationForHandle,
            cornerIndex: i,
            imageRotation,
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
          elevation: elevationForHandle,
          // Sentinel — the icon-rotate + cursor logic reads it and
          // treats missing / -1 as "no corner assignment" (single
          // handle, default orientation).
          cornerIndex: -1,
          imageRotation,
        },
      })
    }
    src.setData({ type: 'FeatureCollection', features })
  }, [map, styleLoaded, styleGen, transformContext, transformState])

  // Mirror `transformContext` into a ref so the drag effect can read
  // the latest without re-mounting event listeners on every context
  // change. Fresh transformContext is captured once at drag start via
  // onMouseDown.
  const transformContextRef = useRef(transformContext)
  useEffect(() => {
    transformContextRef.current = transformContext
  }, [transformContext])

  // ---- In-flight source population --------------------------------------
  // When a transform starts, immediately push the target image's hit
  // polygon + label point into the in-flight sources so the moving
  // image renders identically from the moment transformState flips
  // (before the user drags). On transform end, empties the sources so
  // no ghost feature lingers after the committed source rebuilds.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const hitSrc = map.getSource(HIT_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    const labelSrc = map.getSource(LABEL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
    const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
    if (!transformState || !transformContext) {
      hitSrc?.setData(emptyFC)
      labelSrc?.setData(emptyFC)
      return
    }
    const img = transformContext.image
    const corners = imageCorners(img)
    if (!corners || img.id === undefined) {
      hitSrc?.setData(emptyFC)
      labelSrc?.setData(emptyFC)
      return
    }
    // Hit polygon — mirrors buildImageFeatureCollection's per-image
    // feature shape so paint expressions on HIT_INFLIGHT_LAYER +
    // SELECTION_TINT_INFLIGHT_LAYER read the same `elevation` /
    // `imageId` properties.
    hitSrc?.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            imageId: img.id,
            elevation: img.config.elevation ?? 0,
            preview: false,
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
          },
        },
      ],
    })
    // Label point (only if labels are enabled).
    if (
      img.config.showLabels &&
      (img.config.label?.trim() || img.name?.trim())
    ) {
      const labelText = img.config.label?.trim()
        ? img.config.label
        : (img.name ?? '')
      const center = imageBboxCenter(img)
      if (center) {
        labelSrc?.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                imageId: img.id,
                rotation: img.rotation,
                opacity: img.config.opacity,
                showLabels: true,
                label: labelText,
                labelSize: img.config.labelSize,
                labelColor: img.config.labelColor,
              },
              geometry: { type: 'Point', coordinates: center },
            },
          ],
        })
      } else {
        labelSrc?.setData(emptyFC)
      }
    } else {
      labelSrc?.setData(emptyFC)
    }
  }, [map, styleLoaded, styleGen, transformState, transformContext])

  // Drag handling — single mousedown/move/up cycle. Move translates both
  // bbox corners by the cursor delta; rotate computes the angle between
  // the original handle and the cursor, both relative to the center.
  const dragRef = useRef<{
    dragging: boolean
    kind: 'move' | 'rotate' | 'scale' | null
    originalImage: ImageShape | null
    originalCenter: [number, number] | null
    originalAnchor: [number, number] | null
    originalRotation: number
    downHandleAngle: number
    // Scale-only: the diagonally-opposite corner captured at mousedown
    // in world (post-rotation) coords. This is the point that must stay
    // glued to the map while the user drags the scale handle — replaces
    // the old, brittle "keep `orig.start` fixed" assumption, which broke
    // whenever the persisted `start` wasn't the geographic top-left
    // (i.e. whenever the user drew the original bbox in any direction
    // other than TL → BR).
    originalFixedCorner: [number, number] | null
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
        originalImage: null,
        originalCenter: null,
        originalAnchor: null,
        originalRotation: 0,
        downHandleAngle: 0,
        originalFixedCorner: null,
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
    ): {
      start?: [number, number]
      current?: [number, number]
      rotation?: number
    } | null => {
      const orig = drag.originalImage
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
      if (drag.kind === 'scale') {
        const fixed = drag.originalFixedCorner
        if (!fixed) return null
        const newCenter: [number, number] = [
          (fixed[0] + cursor[0]) / 2,
          (fixed[1] + cursor[1]) / 2,
        ]
        const theta = orig.rotation
        const unrotatedFixed = rotatePointAround(fixed, newCenter, -theta)
        const unrotatedCursor = rotatePointAround(cursor, newCenter, -theta)
        return { start: unrotatedFixed, current: unrotatedCursor }
      }
      // Move
      const dLng = cursor[0] - drag.originalAnchor[0]
      const dLat = cursor[1] - drag.originalAnchor[1]
      return {
        start: [orig.start[0] + dLng, orig.start[1] + dLat],
        current: [orig.current[0] + dLng, orig.current[1] + dLat],
      }
    }

    // Push the patched image into (a) the transforming image's raster
    // source via `setCoordinates` — Mapbox 3.x's fast path, no
    // re-tessellation, and (b) the in-flight hit + label sources so
    // the tint / halo / label track the moving image. All-Mapbox path,
    // no React state, no useMemo recomputation.
    const pushInflight = (patch: {
      start?: [number, number]
      current?: [number, number]
      rotation?: number
    }) => {
      const orig = drag.originalImage
      if (!orig || orig.id === undefined) return
      const patched: ImageShape = { ...orig, ...patch }
      // Floor-plan layer — new corners in place, drawn on the next frame.
      // Driven from the drag handler's RAF so React is untouched.
      const corners = imageCroppedCorners(patched)
      if (!corners) return
      floorLayersRef.current.get(orig.id)?.update({ corners })
      // In-flight hit polygon — uses `imageCorners` (uncropped) so the
      // hit-test / halo / tint always cover the full bbox users click,
      // matching the committed `buildImageFeatureCollection` behaviour.
      const fullCorners = imageCorners(patched)
      const hitSrc = map.getSource(HIT_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      if (hitSrc && fullCorners) {
        hitSrc.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                imageId: orig.id,
                elevation: patched.config.elevation ?? 0,
                preview: false,
              },
              geometry: {
                type: 'Polygon',
                coordinates: [[
                  fullCorners[0],
                  fullCorners[1],
                  fullCorners[2],
                  fullCorners[3],
                  fullCorners[0],
                ]],
              },
            },
          ],
        })
      }
      // In-flight label — repositions to the new center. Skip when
      // labels aren't enabled so we don't emit a bogus feature.
      const labelSrc = map.getSource(LABEL_INFLIGHT_SOURCE) as GeoJSONSource | undefined
      if (labelSrc) {
        const labelActive =
          patched.config.showLabels &&
          ((patched.config.label?.trim() ?? '') !== '' ||
            (patched.name?.trim() ?? '') !== '')
        const center = imageBboxCenter(patched)
        if (labelActive && center) {
          const labelText = patched.config.label?.trim()
            ? patched.config.label
            : (patched.name ?? '')
          labelSrc.setData({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {
                  imageId: orig.id,
                  rotation: patched.rotation,
                  opacity: patched.config.opacity,
                  showLabels: true,
                  label: labelText,
                  labelSize: patched.config.labelSize,
                  labelColor: patched.config.labelColor,
                },
                geometry: { type: 'Point', coordinates: center },
              },
            ],
          })
        }
      }
      // Follow the moving image with the transform handles.
      const transformSrc = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
      if (transformSrc) {
        const elevationForHandle = Math.max(
          0.1,
          patched.config.elevation ?? 0,
        )
        const imageRotation = patched.rotation ?? 0
        const kind = drag.kind
        const features: GeoJSON.Feature<GeoJSON.Point>[] = []
        if (kind === 'move') {
          const center = imageBboxCenter(patched)
          if (center) {
            features.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: center },
              properties: {
                kind: 'move',
                iconId: TRANSFORM_ICON.move,
                elevation: elevationForHandle,
                cornerIndex: -1,
                imageRotation,
              },
            })
          }
        } else if ((kind === 'scale' || kind === 'rotate') && fullCorners) {
          for (let i = 0; i < fullCorners.length; i++) {
            features.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: fullCorners[i] },
              properties: {
                kind,
                iconId: TRANSFORM_ICON[kind],
                elevation: elevationForHandle,
                cornerIndex: i,
                imageRotation,
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
      drag.kind = transformState.kind
      drag.originalImage = ctx.image
      drag.originalCenter = ctx.center
      drag.originalRotation = ctx.image.rotation
      // Read the clicked corner's index (both scale and rotate paint
      // 4 corner handles). Move mode has no cornerIndex → -1.
      const rawIdx = hits[0]?.properties?.cornerIndex
      const cornersAtDown = imageCorners(ctx.image)
      const clickedCornerIdx =
        typeof rawIdx === 'number' && rawIdx >= 0 && rawIdx <= 3
          ? rawIdx
          : -1

      if (transformState.kind === 'scale') {
        if (clickedCornerIdx >= 0 && cornersAtDown) {
          drag.originalAnchor = cornersAtDown[clickedCornerIdx]
          // Diagonal opposite: TL(0)↔BR(2), TR(1)↔BL(3).
          drag.originalFixedCorner =
            cornersAtDown[(clickedCornerIdx + 2) % 4]
          // Per-corner cursor: TL / BR resize along NW-SE, TR / BL
          // along NE-SW.
          canvas.style.cursor =
            clickedCornerIdx === 0 || clickedCornerIdx === 2
              ? 'nwse-resize'
              : 'nesw-resize'
        } else {
          // Fallback if the click didn't attribute to a numbered
          // corner — mirrors the pre-4-corner behaviour.
          drag.originalAnchor = cornersAtDown
            ? cornersAtDown[2]
            : ctx.anchor
          drag.originalFixedCorner = cornersAtDown ? cornersAtDown[0] : null
          canvas.style.cursor = 'nwse-resize'
        }
      } else if (transformState.kind === 'rotate') {
        drag.originalAnchor =
          clickedCornerIdx >= 0 && cornersAtDown
            ? cornersAtDown[clickedCornerIdx]
            : ctx.anchor
        drag.originalFixedCorner = null
        canvas.style.cursor = 'crosshair'
      } else {
        // Move
        drag.originalAnchor = ctx.anchor
        drag.originalFixedCorner = null
        canvas.style.cursor = 'grabbing'
      }

      drag.downHandleAngle = Math.atan2(
        (drag.originalAnchor?.[1] ?? 0) - ctx.center[1],
        (drag.originalAnchor?.[0] ?? 0) - ctx.center[0],
      )
      map.dragPan.disable()
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
      // Clear original state BEFORE calling into the parent — the
      // commit unsets transformState which re-runs the effect chain;
      // stale refs would otherwise confuse the next drag.
      drag.originalImage = null
      drag.originalCenter = null
      drag.originalAnchor = null
      drag.originalFixedCorner = null
      drag.kind = null
      if (patch) transformChangeRef.current?.(patch, true)
    }
    const cursorForCorner = (idx: number | undefined): string =>
      idx === 0 || idx === 2 ? 'nwse-resize' : 'nesw-resize'

    // Combined enter + hover cursor. For scale we have four handles
    // sharing one layer, so `mouseenter` (which fires once per layer
    // entry) can't tell us which corner is under the cursor when the
    // user moves between corners without leaving the layer. Bind a
    // layer-scoped `mousemove` too — it fires per movement inside the
    // layer, giving us the current feature every frame.
    const onHover = (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drag.dragging) return
      if (transformState.kind === 'rotate') {
        canvas.style.cursor = 'crosshair'
        return
      }
      if (transformState.kind === 'move') {
        canvas.style.cursor = 'grab'
        return
      }
      // scale — per-corner cursor
      const idx = e.features?.[0]?.properties?.cornerIndex as number | undefined
      canvas.style.cursor = cursorForCorner(idx)
    }
    const onLeave = () => {
      if (!drag.dragging) canvas.style.cursor = ''
    }

    map.on('mousedown', onMouseDown)
    map.on('mousemove', onMouseMove)
    map.on('mouseup', onMouseUp)
    map.on('mouseenter', TRANSFORM_LAYER, onHover)
    map.on('mousemove', TRANSFORM_LAYER, onHover)
    map.on('mouseleave', TRANSFORM_LAYER, onLeave)
    return () => {
      map.off('mousedown', onMouseDown)
      map.off('mousemove', onMouseMove)
      map.off('mouseup', onMouseUp)
      map.off('mouseenter', TRANSFORM_LAYER, onHover)
      map.off('mousemove', TRANSFORM_LAYER, onHover)
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
