/**
 * Floor-plan image scale calibration.
 *
 * A plan that only prints room areas (or a few dimensions) has no known
 * overall size. The user marks rooms or known lengths on the placed image
 * and types their real value; each mark implies a scale factor, and the
 * image is resized about its centre by the geometric mean of those
 * factors — so the user's one known lat/lng (the centre) stays put.
 *
 * Marks are stored in the image's own normalised frame (u, v in 0..1,
 * v down) rather than lng/lat, so they ride along when the image is
 * scaled, rotated or moved and every mark can report how far off it
 * still is after the change. Real plans — hand-drawn or AI-rendered —
 * rarely agree with themselves to the percent, so per-mark error is what
 * lets the user spot and untick the outliers.
 */

import type { ImageShape } from '@/lib/shapes'
import { angleDeg, fromLocal, toLocal, type LngLat } from './geometry'

const DEG = Math.PI / 180

export interface ImageFrame {
  center: LngLat
  /** Metres along the image's own x axis (pre-rotation width). */
  width: number
  /** Metres along the image's own y axis. */
  height: number
  /** Clockwise degrees, as stored on the image. */
  rotation: number
}

export type CalibrationKind = 'length' | 'area'

export interface CalibrationSample {
  id: string
  kind: CalibrationKind
  /** First point / corner, image-normalised. */
  a: [number, number]
  /** Second point / opposite corner, image-normalised. */
  b: [number, number]
  /** Real value: metres for a length, m² for an area. */
  real: number
  enabled: boolean
}

export function imageFrame(image: Pick<ImageShape, 'start' | 'current' | 'rotation'>): ImageFrame | null {
  if (!image.start || !image.current) return null
  const center: LngLat = [
    (image.start[0] + image.current[0]) / 2,
    (image.start[1] + image.current[1]) / 2,
  ]
  const [w, h] = toLocal(image.start, image.current)
  const width = Math.abs(w)
  const height = Math.abs(h)
  if (width < 1e-6 || height < 1e-6) return null
  return { center, width, height, rotation: image.rotation ?? 0 }
}

/** World lng/lat → image-normalised (u right, v down). */
export function lngLatToImageUV(frame: ImageFrame, p: LngLat): [number, number] {
  const [x, y] = toLocal(frame.center, p)
  const t = frame.rotation * DEG
  // Undo the clockwise image rotation (rotate counter-clockwise by t).
  const xr = x * Math.cos(t) - y * Math.sin(t)
  const yr = x * Math.sin(t) + y * Math.cos(t)
  return [xr / frame.width + 0.5, 0.5 - yr / frame.height]
}

export function imageUVToLngLat(frame: ImageFrame, uv: [number, number]): LngLat {
  const xr = (uv[0] - 0.5) * frame.width
  const yr = (0.5 - uv[1]) * frame.height
  const t = frame.rotation * DEG
  // Re-apply the clockwise rotation.
  const x = xr * Math.cos(t) + yr * Math.sin(t)
  const y = -xr * Math.sin(t) + yr * Math.cos(t)
  return fromLocal(frame.center, [x, y])
}

/** The sample's outline in lng/lat: two points for a length, four corners for an area. */
export function sampleOutline(frame: ImageFrame, s: Pick<CalibrationSample, 'kind' | 'a' | 'b'>): LngLat[] {
  if (s.kind === 'length') return [imageUVToLngLat(frame, s.a), imageUVToLngLat(frame, s.b)]
  return [
    imageUVToLngLat(frame, s.a),
    imageUVToLngLat(frame, [s.b[0], s.a[1]]),
    imageUVToLngLat(frame, s.b),
    imageUVToLngLat(frame, [s.a[0], s.b[1]]),
  ]
}

/** What the mark measures on the image as it is placed now (m or m²). */
export function sampleMeasured(frame: ImageFrame, s: Pick<CalibrationSample, 'kind' | 'a' | 'b'>): number {
  const dx = (s.b[0] - s.a[0]) * frame.width
  const dy = (s.b[1] - s.a[1]) * frame.height
  return s.kind === 'length' ? Math.hypot(dx, dy) : Math.abs(dx * dy)
}

/** Uniform scale this one mark asks for. */
export function sampleFactor(frame: ImageFrame, s: CalibrationSample): number | null {
  const measured = sampleMeasured(frame, s)
  if (measured < 1e-9 || s.real <= 0) return null
  const ratio = s.real / measured
  return s.kind === 'length' ? ratio : Math.sqrt(ratio)
}

/** Geometric mean of every enabled mark's factor; null with none usable. */
export function combinedFactor(frame: ImageFrame, samples: ReadonlyArray<CalibrationSample>): number | null {
  let logSum = 0
  let n = 0
  for (const s of samples) {
    if (!s.enabled) continue
    const f = sampleFactor(frame, s)
    if (f === null || !Number.isFinite(f)) continue
    logSum += Math.log(f)
    n++
  }
  return n > 0 ? Math.exp(logSum / n) : null
}

/** Fractional error of a mark if the image were scaled by `factor` (+0.05 = 5 % too big). */
export function sampleErrorAfter(frame: ImageFrame, s: CalibrationSample, factor: number): number | null {
  const measured = sampleMeasured(frame, s)
  if (measured < 1e-9 || s.real <= 0) return null
  const scaled = s.kind === 'length' ? measured * factor : measured * factor * factor
  return scaled / s.real - 1
}

/**
 * Rotation that makes the world line a→b run exactly east–west or
 * north–south (whichever it is already closest to), about the image
 * centre. Returned in the image's clockwise convention, in (-180, 180].
 */
export function straightenedRotation(frame: ImageFrame, a: LngLat, b: LngLat): number {
  const alpha = angleDeg(a, b)
  const target = Math.round(alpha / 90) * 90
  // A clockwise turn of δ lowers the line's counter-clockwise angle by δ.
  let next = frame.rotation + (alpha - target)
  next = ((next % 360) + 360) % 360
  if (next > 180) next -= 360
  return Math.round(next * 100) / 100
}

/** The image bbox moved so its centre sits on `center`. */
export function recenterImageBbox(
  image: Pick<ImageShape, 'start' | 'current'>,
  center: LngLat,
): { start: [number, number]; current: [number, number] } {
  const cLng = (image.start[0] + image.current[0]) / 2
  const cLat = (image.start[1] + image.current[1]) / 2
  const dLng = center[0] - cLng
  const dLat = center[1] - cLat
  return {
    start: [image.start[0] + dLng, image.start[1] + dLat],
    current: [image.current[0] + dLng, image.current[1] + dLat],
  }
}
