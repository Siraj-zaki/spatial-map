/**
 * Image-overlay helpers.
 *
 * Image shapes are rendered through Mapbox's native `image` source + a
 * `raster` layer (one source/layer per shape). The source needs the four
 * lng/lat corners of the quad — those are computed here from the
 * `start`/`current` bbox + `rotation` so the persisted geometry stays
 * compact and matches the way circle-grid stores its bbox.
 *
 * A parallel polygon feature (covering the same four corners) feeds a
 * GeoJSON source used purely for hit testing — raster layers don't
 * answer `queryRenderedFeatures` reliably, so the click target is the
 * invisible polygon on top of each image.
 */

import {
  polygon as turfPolygon,
  point as turfPoint,
  transformRotate,
  distance as turfDistance,
} from '@turf/turf'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import type { ImageCrop, ImageShape } from './shapes'

export interface ImageProps {
  id: string
  imageId?: number
  rotation: number
  opacity: number
  showLabels: boolean
  label?: string
  labelSize?: number
  labelColor?: string
  preview?: boolean
  /**
   * Base altitude in metres, mirroring `ImageShapeConfig.elevation`.
   * Consumed by the SELECTION_TINT_LAYER's fill-extrusion base/height
   * expressions so the tint sits at the same world Z as the raster.
   * Optional so pre-elevation shapes are backfilled to 0 at read time.
   */
  elevation?: number
}

export type ImageFeature = Feature<Polygon, ImageProps>

/**
 * Bounding-box center of the user-defined `start` / `current` corners.
 * Returns null when the bbox is degenerate (zero area) OR when the row
 * is missing one of the corners — defensive against pre-bbox image rows
 * still sitting in IndexedDB from older schemas.
 */
export function imageBboxCenter(shape: {
  start?: [number, number]
  current?: [number, number]
}): [number, number] | null {
  if (!shape.start || !shape.current) return null
  const [sLng, sLat] = shape.start
  const [cLng, cLat] = shape.current
  if (Math.abs(sLng - cLng) < 1e-12 && Math.abs(sLat - cLat) < 1e-12) {
    return null
  }
  return [(sLng + cLng) / 2, (sLat + cLat) / 2]
}

/**
 * Width × height in METERS of the bounding box (pre-rotation). Used by
 * the side panel's read-only size display.
 */
export function imageBboxSizeMeters(shape: {
  start?: [number, number]
  current?: [number, number]
}): { width: number; height: number } {
  if (!shape.start || !shape.current) return { width: 0, height: 0 }
  const [sLng, sLat] = shape.start
  const [cLng, cLat] = shape.current
  const widthPt: [number, number] = [cLng, sLat]
  const heightPt: [number, number] = [sLng, cLat]
  return {
    width: turfDistance(shape.start, widthPt, { units: 'meters' }),
    height: turfDistance(shape.start, heightPt, { units: 'meters' }),
  }
}

/**
 * Scale the bbox around its center by `factor`. Returns null if the bbox
 * is degenerate. Rotation is preserved (it's applied at render time from
 * the axis-aligned start/current).
 */
export function scaleImageBbox(
  shape: { start?: [number, number]; current?: [number, number] },
  factor: number
): { start: [number, number]; current: [number, number] } | null {
  if (!shape.start || !shape.current) return null
  const [sLng, sLat] = shape.start
  const [cLng, cLat] = shape.current
  const centerLng = (sLng + cLng) / 2
  const centerLat = (sLat + cLat) / 2
  const halfLng = (cLng - sLng) / 2
  const halfLat = (cLat - sLat) / 2
  return {
    start: [centerLng - halfLng * factor, centerLat - halfLat * factor],
    current: [centerLng + halfLng * factor, centerLat + halfLat * factor],
  }
}

/**
 * Resize the bbox's width to `widthMeters` while keeping its center and
 * height. Returns null if the current bbox is degenerate.
 */
export function resizeImageBboxWidthMeters(
  shape: { start?: [number, number]; current?: [number, number] },
  widthMeters: number
): { start: [number, number]; current: [number, number] } | null {
  if (!shape.start || !shape.current) return null
  const size = imageBboxSizeMeters(shape)
  if (size.width <= 1e-9) return null
  const ratio = widthMeters / size.width
  const [sLng, sLat] = shape.start
  const [cLng, cLat] = shape.current
  const centerLng = (sLng + cLng) / 2
  const halfLng = (cLng - sLng) / 2 * ratio
  return {
    start: [centerLng - halfLng, sLat],
    current: [centerLng + halfLng, cLat],
  }
}

/**
 * Resize the bbox's height to `heightMeters` while keeping its center
 * and width. Returns null if the current bbox is degenerate.
 */
export function resizeImageBboxHeightMeters(
  shape: { start?: [number, number]; current?: [number, number] },
  heightMeters: number
): { start: [number, number]; current: [number, number] } | null {
  if (!shape.start || !shape.current) return null
  const size = imageBboxSizeMeters(shape)
  if (size.height <= 1e-9) return null
  const ratio = heightMeters / size.height
  const [sLng, sLat] = shape.start
  const [cLng, cLat] = shape.current
  const centerLat = (sLat + cLat) / 2
  const halfLat = (cLat - sLat) / 2 * ratio
  return {
    start: [sLng, centerLat - halfLat],
    current: [cLng, centerLat + halfLat],
  }
}

/**
 * Rotate a lng/lat point around a pivot by `deg` degrees using the same
 * turf great-circle math that `imageCorners` uses to rotate the bbox
 * itself. Same-engine round-tripping means rotate → unrotate is
 * numerically idempotent even at long distances / high latitudes.
 * A zero angle short-circuits so the common unrotated case avoids the
 * feature allocation.
 */
export function rotatePointAround(
  pt: [number, number],
  pivot: [number, number],
  deg: number,
): [number, number] {
  if (Math.abs(deg) < 1e-9) return pt
  const rotated = transformRotate(turfPoint(pt), deg, { pivot })
  return rotated.geometry.coordinates as [number, number]
}

/**
 * Return the crop rect only if it's non-trivial (any positive edge AND
 * the horizontal + vertical sums stay strictly < 100). Returns null
 * otherwise so callers can short-circuit to the full-image path.
 * Percentages are clamped into [0, 100).
 */
export function effectiveImageCrop(crop: ImageCrop | undefined): ImageCrop | null {
  if (!crop) return null
  const top = Math.max(0, Math.min(100, crop.top))
  const right = Math.max(0, Math.min(100, crop.right))
  const bottom = Math.max(0, Math.min(100, crop.bottom))
  const left = Math.max(0, Math.min(100, crop.left))
  if (top + bottom >= 100 || left + right >= 100) return null
  if (top === 0 && right === 0 && bottom === 0 && left === 0) return null
  return { top, right, bottom, left }
}

/**
 * A stable, short key describing a crop. Used as part of cache keys
 * (cropped-image data URL cache, source-remount detection). Null
 * crop → `'none'`.
 */
export function imageCropSignature(crop: ImageCrop | undefined): string {
  const eff = effectiveImageCrop(crop)
  if (!eff) return 'none'
  return `${eff.top}|${eff.right}|${eff.bottom}|${eff.left}`
}

/**
 * Compute the four lng/lat corners Mapbox's `image` source expects, in
 * the documented order: [top-left, top-right, bottom-right, bottom-left].
 * Rotation is applied around the bbox center.
 *
 * `imageCorners` operates on the FULL image bbox — used by hit
 * testing, the selection outline, transform handles, and the clip
 * layer. For the raster's own source coordinates use
 * `imageCroppedCorners`, which shrinks the axis-aligned bbox by the
 * crop percentages before rotating.
 *
 * Returns null when the bbox has zero area — caller should skip
 * rendering in that case.
 */
export function imageCorners(shape: {
  start?: [number, number]
  current?: [number, number]
  rotation: number
}): [[number, number], [number, number], [number, number], [number, number]] | null {
  const center = imageBboxCenter(shape)
  if (!center || !shape.start || !shape.current) return null
  const [sLng, sLat] = shape.start
  const [cLng, cLat] = shape.current
  const minLng = Math.min(sLng, cLng)
  const maxLng = Math.max(sLng, cLng)
  const minLat = Math.min(sLat, cLat)
  const maxLat = Math.max(sLat, cLat)
  // Axis-aligned corners — TL, TR, BR, BL (mapbox order).
  const axisAligned: [number, number][] = [
    [minLng, maxLat],
    [maxLng, maxLat],
    [maxLng, minLat],
    [minLng, minLat],
  ]
  if (Math.abs(shape.rotation) < 1e-6) {
    return [
      axisAligned[0],
      axisAligned[1],
      axisAligned[2],
      axisAligned[3],
    ]
  }
  // Use turf so the rotation respects the great-circle math turf uses
  // elsewhere (same engine as polygon/line rotation), keeping the
  // raster's rotation pivot consistent with how we draw the hit polygon.
  // Pivot on the true bbox center — `imageBboxCenter` is what the
  // transform-handle UI uses, and earlier we passed `turfCentroid` of
  // the CLOSED ring, which averages the duplicated top-left corner
  // twice and biased the pivot toward the top-left.
  let rotated: Feature<Polygon>
  try {
    // Need a closed ring (5 points) for turf polygon.
    const ring: [number, number][] = [...axisAligned, axisAligned[0]]
    const poly = turfPolygon([ring])
    rotated = transformRotate(poly, shape.rotation, { pivot: center })
  } catch {
    return [
      axisAligned[0],
      axisAligned[1],
      axisAligned[2],
      axisAligned[3],
    ]
  }
  const coords = rotated.geometry.coordinates[0] as [number, number][]
  return [coords[0], coords[1], coords[2], coords[3]]
}

/**
 * Same as `imageCorners`, but shrinks the axis-aligned bbox inward by
 * the shape's crop percentages before applying rotation. The rotation
 * pivots on the FULL bbox center (not the cropped center) so a cropped
 * image stays visually anchored where the user placed it — only its
 * on-map footprint shrinks. When there is no effective crop, this
 * degenerates to `imageCorners`.
 */
export function imageCroppedCorners(shape: ImageShape): [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] | null {
  const crop = effectiveImageCrop(shape.config.crop)
  if (!crop) return imageCorners(shape)
  const center = imageBboxCenter(shape)
  if (!center || !shape.start || !shape.current) return null
  const [sLng, sLat] = shape.start
  const [cLng, cLat] = shape.current
  const minLng = Math.min(sLng, cLng)
  const maxLng = Math.max(sLng, cLng)
  const minLat = Math.min(sLat, cLat)
  const maxLat = Math.max(sLat, cLat)
  const width = maxLng - minLng
  const height = maxLat - minLat
  // Crop percentages carve inward from each edge of the full bbox. The
  // horizontal + vertical sums are guaranteed < 100 by
  // `effectiveImageCrop`, so `croppedWidth` / `croppedHeight` are > 0.
  const croppedMinLng = minLng + (width * crop.left) / 100
  const croppedMaxLng = maxLng - (width * crop.right) / 100
  const croppedMinLat = minLat + (height * crop.bottom) / 100
  const croppedMaxLat = maxLat - (height * crop.top) / 100
  const axisAligned: [number, number][] = [
    [croppedMinLng, croppedMaxLat],
    [croppedMaxLng, croppedMaxLat],
    [croppedMaxLng, croppedMinLat],
    [croppedMinLng, croppedMinLat],
  ]
  if (Math.abs(shape.rotation) < 1e-6) {
    return [
      axisAligned[0],
      axisAligned[1],
      axisAligned[2],
      axisAligned[3],
    ]
  }
  let rotated: Feature<Polygon>
  try {
    const ring: [number, number][] = [...axisAligned, axisAligned[0]]
    const poly = turfPolygon([ring])
    rotated = transformRotate(poly, shape.rotation, { pivot: center })
  } catch {
    return [
      axisAligned[0],
      axisAligned[1],
      axisAligned[2],
      axisAligned[3],
    ]
  }
  const coords = rotated.geometry.coordinates[0] as [number, number][]
  return [coords[0], coords[1], coords[2], coords[3]]
}

/**
 * Convert a normalized [0,1] image UV coordinate (y-down, as produced
 * by any vision-language model) into a Mapbox lng/lat for a placed
 * ImageShape. Exact JS mirror of `UVToLngLat` in
 * `backend/internal/ai/coords.go` — the AI floor plan detection flow
 * uses the Go version on the wire; this JS version is here so the SPA
 * can preview region-select bboxes and nudged detections without a
 * server round-trip.
 *
 * CONTRACT: assumes the *cropped* image was sent to the model. So (u,v)
 * is against the cropped image bounds, not the full source. When there
 * is no crop, cropped bounds == full bounds so the common case still
 * works. Rotation is applied around the FULL bbox center (matches
 * `imageCroppedCorners`).
 */
export function imageUVToLngLat(
  shape: {
    start?: [number, number]
    current?: [number, number]
    rotation: number
    config?: { crop?: ImageCrop }
  },
  u: number,
  v: number,
): [number, number] | null {
  if (!shape.start || !shape.current) return null
  const [sLng, sLat] = shape.start
  const [cLng, cLat] = shape.current
  const minLng = Math.min(sLng, cLng)
  const maxLng = Math.max(sLng, cLng)
  const minLat = Math.min(sLat, cLat)
  const maxLat = Math.max(sLat, cLat)
  const width = maxLng - minLng
  const height = maxLat - minLat

  // Apply the crop the same way imageCroppedCorners does. A null /
  // trivial crop reduces to the full bbox.
  const crop = effectiveImageCrop(shape.config?.crop)
  const cropTop = crop?.top ?? 0
  const cropRight = crop?.right ?? 0
  const cropBottom = crop?.bottom ?? 0
  const cropLeft = crop?.left ?? 0

  const croppedMinLng = minLng + (width * cropLeft) / 100
  const croppedMaxLng = maxLng - (width * cropRight) / 100
  const croppedMinLat = minLat + (height * cropBottom) / 100
  const croppedMaxLat = maxLat - (height * cropTop) / 100

  // v=0 is the TOP of the image → maxLat; v=1 is bottom → minLat.
  const rawLng = croppedMinLng + u * (croppedMaxLng - croppedMinLng)
  const rawLat = croppedMaxLat - v * (croppedMaxLat - croppedMinLat)

  if (Math.abs(shape.rotation) < 1e-9) {
    return [rawLng, rawLat]
  }
  // Use turf so rotation stays great-circle-exact with the forward math
  // in imageCroppedCorners (which also uses transformRotate). Pivot is
  // the FULL bbox center, not the cropped center.
  const center: [number, number] = [(minLng + maxLng) / 2, (minLat + maxLat) / 2]
  return rotatePointAround([rawLng, rawLat], center, shape.rotation)
}

/**
 * Inverse of `imageUVToLngLat`: convert a Mapbox lng/lat coordinate back
 * to the image's normalized UV [0, 1] space (y-down convention). Needed
 * for the AI Map tool's region-select drag interaction — the user drags
 * on the map in lng/lat, we need to send the region as UV coords the
 * backend can crop by.
 *
 * Steps (mirror of imageUVToLngLat in reverse):
 *  1. Un-rotate: rotate the point AROUND the FULL bbox center by
 *     `-shape.rotation` so we're in the axis-aligned frame.
 *  2. Compute the CROPPED bbox in world coords (same formulas as
 *     imageCroppedCorners), then interpolate the point's position
 *     across it: u = (lng - croppedMinLng) / (croppedMaxLng - croppedMinLng)
 *     and v (y-flipped): v = (croppedMaxLat - lat) / (croppedMaxLat - croppedMinLat).
 *
 * Returns `null` when the shape lacks corners or the cropped bbox is
 * degenerate. Values are NOT clamped to [0, 1] — the caller (drag
 * handler) clamps at the boundary of the image intentionally.
 */
export function imageLngLatToUV(
  shape: {
    start?: [number, number]
    current?: [number, number]
    rotation: number
    config?: { crop?: ImageCrop }
  },
  lng: number,
  lat: number,
): [number, number] | null {
  if (!shape.start || !shape.current) return null
  const [sLng, sLat] = shape.start
  const [cLng, cLat] = shape.current
  const minLng = Math.min(sLng, cLng)
  const maxLng = Math.max(sLng, cLng)
  const minLat = Math.min(sLat, cLat)
  const maxLat = Math.max(sLat, cLat)
  const width = maxLng - minLng
  const height = maxLat - minLat

  // Un-rotate around FULL bbox center. Zero rotation short-circuits.
  let workLng = lng
  let workLat = lat
  if (Math.abs(shape.rotation) >= 1e-9) {
    const center: [number, number] = [(minLng + maxLng) / 2, (minLat + maxLat) / 2]
    const un = rotatePointAround([lng, lat], center, -shape.rotation)
    workLng = un[0]
    workLat = un[1]
  }

  // Apply the cropped-bbox math the same way imageCroppedCorners does.
  const crop = effectiveImageCrop(shape.config?.crop)
  const cropTop = crop?.top ?? 0
  const cropRight = crop?.right ?? 0
  const cropBottom = crop?.bottom ?? 0
  const cropLeft = crop?.left ?? 0
  const croppedMinLng = minLng + (width * cropLeft) / 100
  const croppedMaxLng = maxLng - (width * cropRight) / 100
  const croppedMinLat = minLat + (height * cropBottom) / 100
  const croppedMaxLat = maxLat - (height * cropTop) / 100

  const denomX = croppedMaxLng - croppedMinLng
  const denomY = croppedMaxLat - croppedMinLat
  if (denomX <= 0 || denomY <= 0) return null

  // v is y-DOWN, so (workLat === croppedMaxLat) → v=0 (image top).
  const u = (workLng - croppedMinLng) / denomX
  const v = (croppedMaxLat - workLat) / denomY
  return [u, v]
}

/**
 * The bbox quad as a GeoJSON polygon feature, used as the invisible
 * click target on top of the raster layer (raster layers don't answer
 * `queryRenderedFeatures` reliably for click tests).
 */
export function buildImageFeature(
  shape: ImageShape,
  opts?: { preview?: boolean }
): ImageFeature | null {
  const corners = imageCorners(shape)
  if (!corners) return null
  const ring: [number, number][] = [
    corners[0],
    corners[1],
    corners[2],
    corners[3],
    corners[0],
  ]
  return {
    type: 'Feature',
    properties: {
      id: `image-${shape.id ?? 'preview'}`,
      imageId: shape.id,
      rotation: shape.rotation,
      opacity: shape.config.opacity,
      showLabels: shape.config.showLabels,
      label: shape.config.label,
      labelSize: shape.config.labelSize,
      labelColor: shape.config.labelColor,
      preview: opts?.preview ?? false,
      elevation: shape.config.elevation ?? 0,
    },
    geometry: { type: 'Polygon', coordinates: [ring] },
  }
}

/**
 * FeatureCollection of bbox polygons for all visible images plus an
 * optional live preview during drawing. Feeds the hit-test + selection
 * outline + label layers.
 */
export function buildImageFeatureCollection(
  shapes: ReadonlyArray<ImageShape>,
  livePreview: ImageShape | null
): FeatureCollection<Polygon, ImageProps> {
  const features: ImageFeature[] = []
  for (const s of shapes) {
    if (s.visible === false) continue
    const f = buildImageFeature(s)
    if (f) features.push(f)
  }
  if (livePreview) {
    const f = buildImageFeature(livePreview, { preview: true })
    if (f) features.push(f)
  }
  return { type: 'FeatureCollection', features }
}

/**
 * Canvas-crop the image at `sourceUrl` by the given percentages and
 * return a data URL. Cached in-memory keyed by (url, crop signature)
 * so subsequent renders / re-mounts hit the cache instead of decoding
 * again. Cache is bounded to a small LRU because cropped PNGs on a
 * 4-5 MB source can themselves be a couple MB — an unbounded cache
 * would grow without limit as users tweak the crop sliders.
 *
 * Returns null on load failure — caller should fall back to the
 * uncropped URL. Non-URL sources (blob:, data:) are supported since
 * we set `img.crossOrigin` only when the URL looks remote.
 */
const CROP_CACHE_LIMIT = 8
const cropCache = new Map<string, string>()

function rememberCrop(key: string, dataUrl: string) {
  cropCache.set(key, dataUrl)
  // Trim oldest — Map preserves insertion order, so the first key IS
  // the oldest. We only need to trim one per insert since we never
  // add more than one per call.
  if (cropCache.size > CROP_CACHE_LIMIT) {
    const firstKey = cropCache.keys().next().value
    if (firstKey !== undefined) cropCache.delete(firstKey)
  }
}

export async function getCroppedImageDataUrl(
  sourceUrl: string,
  crop: ImageCrop,
): Promise<string | null> {
  const eff = effectiveImageCrop(crop)
  if (!eff) return null
  const key = `${sourceUrl}::${imageCropSignature(eff)}`
  const cached = cropCache.get(key)
  if (cached) {
    // Refresh LRU position.
    cropCache.delete(key)
    cropCache.set(key, cached)
    return cached
  }
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      // Only stamp crossOrigin for remote http(s) URLs. `blob:` and
      // `data:` reject when crossOrigin is set (they aren't CORS
      // resources) — that was the cause of a first pass returning
      // "Failed to decode" every time.
      if (/^https?:/i.test(sourceUrl)) el.crossOrigin = 'anonymous'
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('load failed'))
      el.src = sourceUrl
    })
    const sourceW = img.naturalWidth || 1
    const sourceH = img.naturalHeight || 1
    // Pixel offsets — Math.round keeps the output aligned to whole
    // source pixels so we don't introduce sub-pixel blurring.
    const sx = Math.round((sourceW * eff.left) / 100)
    const sy = Math.round((sourceH * eff.top) / 100)
    const sw = Math.max(1, Math.round(sourceW * (1 - (eff.left + eff.right) / 100)))
    const sh = Math.max(1, Math.round(sourceH * (1 - (eff.top + eff.bottom) / 100)))
    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
    // PNG preserves any transparency (blueprints with alpha), which
    // JPEG would flatten to black. Size delta is minor at these
    // dimensions vs. the impact of transcoding a transparent floor
    // plan to black.
    const dataUrl = canvas.toDataURL('image/png')
    rememberCrop(key, dataUrl)
    return dataUrl
  } catch {
    return null
  }
}

/**
 * Read an uploaded image file as a base64 data URL plus its intrinsic
 * pixel size. We need the natural dimensions for the side-panel
 * thumbnail and so future Shift-drag aspect-lock can preserve the
 * source ratio.
 */
export function readImageFile(
  file: File
): Promise<{
  dataUrl: string
  mimeType: string
  naturalWidth: number
  naturalHeight: number
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl) {
        reject(new Error('Empty file'))
        return
      }
      const img = new Image()
      img.onerror = () => reject(new Error('Failed to decode image'))
      img.onload = () => {
        resolve({
          dataUrl,
          mimeType: file.type || 'image/png',
          naturalWidth: img.naturalWidth || 1,
          naturalHeight: img.naturalHeight || 1,
        })
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  })
}
