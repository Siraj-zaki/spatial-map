/**
 * Focus mode — bringing the camera to a focused item with a clear line
 * of sight when there is one.
 *
 * `planFocusCamera` frames the item (fit its bounds, or zoom in on a
 * point), then probes candidate pitches / bearings WITHOUT moving the
 * map: for each candidate it predicts where the free camera would sit
 * and asks the occluder index (`collectOccluders`, own prisms excluded)
 * whether anything stands between that camera and the item's samples.
 * The first clear candidate wins; with none clear it steepens the pitch
 * and leaves the rest to the faded blockers (`focus-blockers.ts`).
 *
 * Camera prediction. GL JS places the free camera at
 *   centre − forward · d,  d = cameraToCenterDistance / worldSize
 *   cameraToCenterDistance = 0.5 · H / tan(fov / 2)   (fov = 0.6435 rad)
 *   worldSize = 512 · 2^zoom
 * i.e. x = Cx − d·sinP·sinB, y = Cy + d·sinP·cosB, z = d·cosP in Mercator
 * (`Transform._computeCameraPosition`, 3.25). The scale is calibrated once
 * per call against the live `getFreeCameraOptions().position`, so a
 * different fov / pixel ratio can't skew it; `map.transform` is never read.
 *
 * The look-at point is shifted so the item — not the ground under it —
 * lands on the visible centre: forward by altitude · tan(pitch) (exact
 * along the central ray), and sideways / along the view by the padding
 * offset. The move is then a plain `center` + zoom / pitch / bearing, with
 * NO `padding` option: GL keeps a camera padding as global map state
 * after an ease, which would shift every later fit and zoom.
 *
 * 'reveal' (a map click on the item) is the light touch: no framing and
 * no line-of-sight probe — the user just clicked it, so it is visible.
 * When the item sits outside the padded canvas (e.g. under the drawer
 * that is about to open) the camera pans just enough to bring it 32 px
 * inside, keeping zoom, pitch and bearing; otherwise it doesn't move.
 */

import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'

import { collectOccluders, occluderIndexFor, type OccluderIndex, type OccluderPrism } from '@/lib/occluder-index'

import { isOwnPrismKey, type ResolvedFocus } from './focus-target'

/**
 * always = frame the item; ifNeeded = frame it only when off-screen
 * (padded) or every sample is blocked; reveal = pan just enough to bring
 * it inside the padded canvas (zoom / pitch / bearing kept, no probe).
 */
export type FocusCameraMode = 'always' | 'ifNeeded' | 'reveal'

export interface FocusPadding {
  top: number
  right: number
  bottom: number
  left: number
}

export interface FocusCameraOptions {
  mode: FocusCameraMode
  /** Screen area the item must land in (e.g. the drawer's width on its side). */
  padding?: FocusPadding
  /** Preferred bearing (e.g. the item floor's rotation); default the current one. */
  bearing?: number
  maxZoom?: number
  minZoom?: number
  /** ms; default 900 (450 for 'reveal'), always 0 under prefers-reduced-motion. */
  duration?: number
}

export interface FocusCameraPlan {
  /** Look-at centre passed to the move, [lng, lat]. */
  center: [number, number]
  zoom: number
  pitch: number
  bearing: number
  padding: FocusPadding
  /** Every sample has a clear line of sight from `position`. */
  clear: boolean
  /** Predicted free-camera position (Mercator) at the end of the move. */
  position: { x: number; y: number; z: number }
}

const FOV = 0.6435011087932844
const NO_PADDING: FocusPadding = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })
/** Extra margin around an area item's bounds, px per side. */
const FIT_MARGIN_PX = 40
const POINT_ZOOM = 19.5
const POINT_MIN_ZOOM = 17
const POINT_MAX_ZOOM = 21
const AREA_MAX_ZOOM = 20.5
const PROBE_PITCHES = [45, 60, 70]
const PROBE_BEARING_OFFSETS = [45, -45, 90, -90, 180]
const BLOCKED_FALLBACK_PITCH = 50
/** Moves longer than this use flyTo (zoom out / in); shorter ones ease. */
const FLY_DISTANCE_M = 300
const DEFAULT_DURATION_MS = 900
const REVEAL_DURATION_MS = 450
/** 'reveal' brings the item this far inside the padded canvas, px. */
const REVEAL_INSET_PX = 32
/** A 'reveal' pan longer than this fraction of the canvas width frames the item instead. */
const REVEAL_MAX_SHIFT = 0.45

const DEG = Math.PI / 180

interface SamplePoint {
  x: number
  y: number
  z: number
  alt: number
  floorPlanId: number | undefined
}

function projectSamples(resolved: ResolvedFocus): SamplePoint[] {
  const out: SamplePoint[] = []
  for (const s of resolved.samples) {
    const alt = Math.max(0, s.elevationM ?? 0)
    const p = mapboxgl.MercatorCoordinate.fromLngLat([s.position[0], s.position[1]], alt)
    out.push({ x: p.x, y: p.y, z: p.z, alt, floorPlanId: s.floorPlanId })
  }
  return out
}

// One scratch list; `collectOccluders` is synchronous and so is every use.
const scratch: OccluderPrism[] = []

function sampleBlocked(
  index: OccluderIndex,
  cam: { x: number; y: number; z: number },
  s: SamplePoint,
  resolved: ResolvedFocus,
): boolean {
  scratch.length = 0
  collectOccluders(index, cam.x, cam.y, cam.z, s.x, s.y, s.z, s.alt, s.floorPlanId, scratch)
  let blocked = false
  for (const p of scratch) {
    if (!isOwnPrismKey(resolved, p.key)) {
      blocked = true
      break
    }
  }
  scratch.length = 0
  return blocked
}

function canvasSize(map: MapboxMapInstance): { width: number; height: number } {
  const c = map.getContainer()
  const canvas = map.getCanvas()
  return {
    width: c?.clientWidth || canvas?.clientWidth || 0,
    height: c?.clientHeight || canvas?.clientHeight || 0,
  }
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

function wrapBearing(b: number): number {
  let x = ((b + 180) % 360 + 360) % 360 - 180
  if (x === -180) x = 180
  return x
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Camera → look-at distance in Mercator units, before calibration. */
function rawDistance(heightPx: number, zoom: number): number {
  return (0.5 * heightPx) / Math.tan(FOV / 2) / (512 * Math.pow(2, zoom))
}

/** Scale between the formula and GL's real camera, measured at the current view. */
function calibration(map: MapboxMapInstance, heightPx: number): number {
  try {
    const pos = map.getFreeCameraOptions().position
    const d0 = rawDistance(heightPx, map.getZoom())
    if (!pos || !(d0 > 0)) return 1
    const c = mapboxgl.MercatorCoordinate.fromLngLat(map.getCenter(), 0)
    const k = Math.hypot(pos.x - c.x, pos.y - c.y, pos.z - c.z) / d0
    return Number.isFinite(k) && k > 0.2 && k < 5 ? k : 1
  } catch {
    return 1
  }
}

function cameraPositionAt(
  lookAt: { x: number; y: number },
  zoom: number,
  pitchDeg: number,
  bearingDeg: number,
  heightPx: number,
  k: number,
): { x: number; y: number; z: number } {
  const d = k * rawDistance(heightPx, zoom)
  const p = pitchDeg * DEG
  const b = bearingDeg * DEG
  return {
    x: lookAt.x - d * Math.sin(p) * Math.sin(b),
    y: lookAt.y + d * Math.sin(p) * Math.cos(b),
    z: d * Math.cos(p),
  }
}

/**
 * Ground look-at point that puts `target` (at `altitudeM`) on the centre
 * of the padded area for this zoom / pitch / bearing.
 */
function lookAtFor(
  target: readonly [number, number],
  altitudeM: number,
  zoom: number,
  pitchDeg: number,
  bearingDeg: number,
  pad: FocusPadding,
  distance: number,
): { x: number; y: number } {
  const t = mapboxgl.MercatorCoordinate.fromLngLat([target[0], target[1]], 0)
  const hM = mapboxgl.MercatorCoordinate.fromLngLat([target[0], target[1]], Math.max(0, altitudeM)).z
  const p = Math.min(pitchDeg, 85) * DEG
  const b = bearingDeg * DEG
  const cosP = Math.max(0.2, Math.cos(p))
  // Mercator x east, y south. Screen-right and forward (up the screen) on the ground.
  const rx = Math.cos(b)
  const ry = Math.sin(b)
  const fx = Math.sin(b)
  const fy = -Math.cos(b)
  const ws = 512 * Math.pow(2, zoom)
  // Where the item must appear relative to the canvas centre (px).
  const ox = (pad.left - pad.right) / 2
  const oy = (pad.top - pad.bottom) / 2
  // An elevated item sits nearer the camera than the ground under the
  // centre (by altitude / cos(pitch) along the central ray), so a pixel
  // there spans less ground: scale the padding shift by its depth ratio.
  const depth = distance > 0 ? Math.max(0.05, 1 - hM / (distance * cosP)) : 1
  // The central ray through an elevated point meets the ground
  // altitude · tan(pitch) further on (exact). Screen y is foreshortened
  // by cos(pitch) near the centre (approximate for a vertical shift).
  const along = hM * Math.tan(p) + (oy * depth) / (ws * cosP)
  const across = (-ox * depth) / ws
  return {
    x: t.x + fx * along + rx * across,
    y: t.y + fy * along + ry * across,
  }
}

function toLngLat(m: { x: number; y: number }): [number, number] {
  const ll = new mapboxgl.MercatorCoordinate(m.x, m.y, 0).toLngLat()
  return [ll.lng, ll.lat]
}

function isArea(resolved: ResolvedFocus): resolved is ResolvedFocus & { bounds: [number, number, number, number] } {
  const b = resolved.bounds
  if (!b) return false
  return Math.abs(b[2] - b[0]) > 1e-9 || Math.abs(b[3] - b[1]) > 1e-9
}

interface Frame {
  zoom: number
  lookAt: { x: number; y: number }
}

function framer(
  map: MapboxMapInstance,
  resolved: ResolvedFocus,
  opts: FocusCameraOptions,
  pad: FocusPadding,
  heightPx: number,
  k: number,
) {
  const currentZoom = map.getZoom()
  const area = isArea(resolved) ? resolved.bounds : null
  const target: [number, number] = area
    ? [(area[0] + area[2]) / 2, (area[1] + area[3]) / 2]
    : [resolved.position[0], resolved.position[1]]
  const pointZoom = clamp(
    Math.max(currentZoom, POINT_ZOOM),
    opts.minZoom ?? POINT_MIN_ZOOM,
    opts.maxZoom ?? POINT_MAX_ZOOM,
  )
  const cache = new Map<string, Frame>()
  return (pitch: number, bearing: number): Frame => {
    const id = `${pitch}|${bearing}`
    const hit = cache.get(id)
    if (hit) return hit
    let zoom = pointZoom
    if (area) {
      const [w, s, e, n] = area
      const maxZoom = opts.maxZoom ?? AREA_MAX_ZOOM
      let fit: number | undefined
      try {
        const cam = map.cameraForBounds(
          [
            [w, s],
            [e, n],
          ],
          {
            padding: {
              top: pad.top + FIT_MARGIN_PX,
              right: pad.right + FIT_MARGIN_PX,
              bottom: pad.bottom + FIT_MARGIN_PX,
              left: pad.left + FIT_MARGIN_PX,
            },
            bearing,
            pitch,
            maxZoom,
          },
        )
        fit = typeof cam?.zoom === 'number' && Number.isFinite(cam.zoom) ? cam.zoom : undefined
      } catch {
        fit = undefined
      }
      zoom = Math.min(fit ?? currentZoom, maxZoom)
      if (opts.minZoom !== undefined) zoom = Math.max(zoom, opts.minZoom)
    }
    const distance = k * rawDistance(heightPx, zoom)
    const frame = { zoom, lookAt: lookAtFor(target, resolved.altitudeM, zoom, pitch, bearing, pad, distance) }
    cache.set(id, frame)
    return frame
  }
}

/** The anchor's screen point lifted to its altitude, or null when it can't be projected. */
function anchorScreenPoint(map: MapboxMapInstance, resolved: ResolvedFocus): { x: number; y: number } | null {
  try {
    const pt = map.project([resolved.position[0], resolved.position[1]])
    // `project` places the point on the ground; lift it to its altitude
    // (screen-space rise ≈ metres · px-per-metre · sin(pitch)).
    const ws = 512 * Math.pow(2, map.getZoom())
    const pxPerM = mapboxgl.MercatorCoordinate.fromLngLat([resolved.position[0], resolved.position[1]], 1).z * ws
    const x = pt.x
    const y = pt.y - Math.max(0, resolved.altitudeM) * pxPerM * Math.sin(map.getPitch() * DEG)
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
  } catch {
    return null
  }
}

/**
 * Anchor inside the padded canvas AND at least one sample unblocked from
 * the current camera.
 */
export function isFocusInView(
  map: MapboxMapInstance,
  resolved: ResolvedFocus,
  prisms: ReadonlyArray<OccluderPrism>,
  padding?: FocusPadding,
): boolean {
  const pad = padding ?? NO_PADDING
  const { width, height } = canvasSize(map)
  if (!(width > 0 && height > 0)) return false
  const pt = anchorScreenPoint(map, resolved)
  if (!pt) return false
  const { x, y } = pt
  if (!(x >= pad.left && x <= width - pad.right && y >= pad.top && y <= height - pad.bottom)) return false
  if (prisms.length === 0) return true
  const cam = map.getFreeCameraOptions().position
  if (!cam) return true
  const index = occluderIndexFor(prisms)
  for (const s of projectSamples(resolved)) {
    if (!sampleBlocked(index, cam, s, resolved)) return true
  }
  return false
}

/**
 * 'reveal': null when the anchor is already inside the padded canvas
 * (inset by REVEAL_INSET_PX), else a pan of the current view that moves
 * it to the nearest point of that rectangle. undefined = can't plan a
 * pan (no canvas, projection failed, or the shift is too long) — frame
 * the item as 'ifNeeded' would.
 */
function planReveal(
  map: MapboxMapInstance,
  resolved: ResolvedFocus,
  pad: FocusPadding,
): FocusCameraPlan | null | undefined {
  const { width, height } = canvasSize(map)
  if (!(width > 0 && height > 0)) return undefined
  const p = anchorScreenPoint(map, resolved)
  if (!p) return undefined
  let x0 = pad.left + REVEAL_INSET_PX
  let x1 = width - pad.right - REVEAL_INSET_PX
  let y0 = pad.top + REVEAL_INSET_PX
  let y1 = height - pad.bottom - REVEAL_INSET_PX
  if (x0 > x1) x0 = x1 = (x0 + x1) / 2
  if (y0 > y1) y0 = y1 = (y0 + y1) / 2
  if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return null
  const tx = clamp(p.x, x0, x1)
  const ty = clamp(p.y, y0, y1)
  if (Math.hypot(p.x - tx, p.y - ty) > REVEAL_MAX_SHIFT * width) return undefined
  let center: [number, number]
  try {
    // A pan (zoom / pitch / bearing kept) translates the camera; a world
    // point then appears where the point one translation back appeared
    // before. So find Q, the point AT THE ITEM'S ALTITUDE seen at the
    // target pixel (the camera ray through `unproject`'s ground hit), and
    // translate by item − Q: the item lands on that pixel exactly, at any
    // pitch (a shift measured on the ground at the canvas centre would
    // over- or under-shoot an elevated item off the centre row).
    const cam = map.getFreeCameraOptions().position
    if (!cam) return undefined
    const item = mapboxgl.MercatorCoordinate.fromLngLat(
      [resolved.position[0], resolved.position[1]],
      Math.max(0, resolved.altitudeM),
    )
    const ground = mapboxgl.MercatorCoordinate.fromLngLat(map.unproject([tx, ty]), 0)
    const t = (cam.z - item.z) / (cam.z - ground.z)
    if (!(t > 0) || !Number.isFinite(t)) return undefined
    const qx = cam.x + t * (ground.x - cam.x)
    const qy = cam.y + t * (ground.y - cam.y)
    const c = mapboxgl.MercatorCoordinate.fromLngLat(map.getCenter(), 0)
    center = toLngLat({ x: c.x + item.x - qx, y: c.y + item.y - qy })
  } catch {
    return undefined
  }
  if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) return undefined
  const zoom = map.getZoom()
  const pitch = map.getPitch()
  const bearing = map.getBearing()
  const k = calibration(map, height)
  return {
    center,
    zoom,
    pitch,
    bearing,
    padding: { ...pad },
    clear: true,
    position: cameraPositionAt(mapboxgl.MercatorCoordinate.fromLngLat(center, 0), zoom, pitch, bearing, height, k),
  }
}

/** The plan and whether it is a 'reveal' pan (eased, short) rather than a framing move. */
function planCamera(
  map: MapboxMapInstance,
  resolved: ResolvedFocus,
  prisms: ReadonlyArray<OccluderPrism>,
  opts: FocusCameraOptions,
): { plan: FocusCameraPlan | null; reveal: boolean } {
  if (opts.mode === 'reveal') {
    const plan = planReveal(map, resolved, opts.padding ?? NO_PADDING)
    if (plan !== undefined) return { plan, reveal: true }
    return { plan: planFocusCamera(map, resolved, prisms, { ...opts, mode: 'ifNeeded' }), reveal: false }
  }
  return { plan: planFocusCamera(map, resolved, prisms, opts), reveal: false }
}

/**
 * null = no move needed ('ifNeeded' with the item already on screen and
 * visible; 'reveal' with it already inside the padded canvas).
 */
export function planFocusCamera(
  map: MapboxMapInstance,
  resolved: ResolvedFocus,
  prisms: ReadonlyArray<OccluderPrism>,
  opts: FocusCameraOptions,
): FocusCameraPlan | null {
  if (opts.mode === 'reveal') return planCamera(map, resolved, prisms, opts).plan
  const pad = opts.padding ?? NO_PADDING
  if (opts.mode === 'ifNeeded' && isFocusInView(map, resolved, prisms, pad)) return null
  const { height } = canvasSize(map)
  const heightPx = height > 0 ? height : 800
  const k = calibration(map, heightPx)
  const maxPitch = typeof map.getMaxPitch === 'function' ? map.getMaxPitch() : 85
  const p0 = clamp(map.getPitch(), 0, maxPitch)
  const b0 = wrapBearing(opts.bearing ?? map.getBearing())
  const frameAt = framer(map, resolved, opts, pad, heightPx, k)
  const index = prisms.length > 0 ? occluderIndexFor(prisms) : null
  const samples = index ? projectSamples(resolved) : []

  const pitches = [p0]
  for (const p of PROBE_PITCHES) if (p > p0 + 0.5 && p <= maxPitch) pitches.push(p)
  const candidates: [number, number][] = pitches.map((p) => [p, b0])
  for (const off of PROBE_BEARING_OFFSETS) {
    for (const p of pitches) candidates.push([p, wrapBearing(b0 + off)])
  }

  const planFor = (pitch: number, bearing: number, clear: boolean): FocusCameraPlan => {
    const frame = frameAt(pitch, bearing)
    return {
      center: toLngLat(frame.lookAt),
      zoom: frame.zoom,
      pitch,
      bearing,
      padding: { ...pad },
      clear,
      position: cameraPositionAt(frame.lookAt, frame.zoom, pitch, bearing, heightPx, k),
    }
  }

  for (const [pitch, bearing] of candidates) {
    if (!index) return planFor(pitch, bearing, true)
    const frame = frameAt(pitch, bearing)
    const cam = cameraPositionAt(frame.lookAt, frame.zoom, pitch, bearing, heightPx, k)
    let clear = true
    for (const s of samples) {
      if (sampleBlocked(index, cam, s, resolved)) {
        clear = false
        break
      }
    }
    if (clear) return planFor(pitch, bearing, true)
  }
  return planFor(clamp(Math.max(p0, BLOCKED_FALLBACK_PITCH), 0, maxPitch), b0, false)
}

const lastPlans = new WeakMap<MapboxMapInstance, { key: string; plan: FocusCameraPlan }>()
const flying = new WeakMap<MapboxMapInstance, object>()

function metresBetween(a: { lng: number; lat: number }, b: readonly [number, number]): number {
  const k = Math.cos(((a.lat + b[1]) / 2) * DEG)
  const dx = (a.lng - b[0]) * k * 111_320
  const dy = (a.lat - b[1]) * 111_320
  return Math.hypot(dx, dy)
}

/**
 * Plan and start the move. Records the plan (`lastFocusCameraPlan`, which
 * seeds the blocker set at the destination) and flags the map as flying
 * until the move's `moveend` (`isFocusFlying`). A 'reveal' pan always
 * eases (default 450 ms); a framing move flies when it is long.
 */
export function flyToFocus(
  map: MapboxMapInstance,
  resolved: ResolvedFocus,
  prisms: ReadonlyArray<OccluderPrism>,
  opts: FocusCameraOptions,
): FocusCameraPlan | null {
  const { plan, reveal } = planCamera(map, resolved, prisms, opts)
  if (!plan) return null
  const duration = prefersReducedMotion()
    ? 0
    : Math.max(0, opts.duration ?? (reveal ? REVEAL_DURATION_MS : DEFAULT_DURATION_MS))
  // End any running move first: its `moveend` must not clear our flag.
  map.stop()
  lastPlans.set(map, { key: resolved.key, plan })
  const token = {}
  flying.set(map, token)
  const onEnd = () => {
    map.off('moveend', onEnd)
    if (flying.get(map) === token) flying.delete(map)
  }
  // Registered before the move: a 0 ms move ends synchronously.
  map.on('moveend', onEnd)
  const camera = {
    center: plan.center,
    zoom: plan.zoom,
    pitch: plan.pitch,
    bearing: plan.bearing,
    duration,
    essential: true,
  }
  if (!reveal && duration > 0 && metresBetween(map.getCenter(), plan.center) > FLY_DISTANCE_M) map.flyTo(camera)
  else map.easeTo(camera)
  return plan
}

/** Between flyToFocus start and its moveend. */
export function isFocusFlying(map: MapboxMapInstance): boolean {
  return flying.has(map)
}

export function lastFocusCameraPlan(map: MapboxMapInstance): { key: string; plan: FocusCameraPlan } | null {
  return lastPlans.get(map) ?? null
}
