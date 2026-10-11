/**
 * Door geometry generators.
 *
 * Every door is built around a 2D local frame anchored at `vertices[0]`
 * with +x running along the opening toward `vertices[1]` and +y running
 * to the left of that heading. All math happens in meters in this frame
 * (small-area equirectangular projection) and is only converted back to
 * lng/lat when emitting GeoJSON.
 *
 * The renderer expects three slices:
 *   - `polygons` — frame jambs + leaf bodies (drive `fill-extrusion-*`).
 *   - `lines`    — swing arcs (drive a dashed line layer).
 *   - `labels`   — single point per door (drives a symbol layer).
 *
 * Each emitted feature carries the same `DoorFeatureProps` so the
 * overlay can read `base_height`, `height`, `color`, and `opacity`
 * directly through `['get', …]` paint expressions, matching the
 * existing stair/polygon pattern in this codebase.
 */

import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson'
import type { DoorConfig, DoorFeatureProps, DoorShape } from './types'

const METERS_PER_DEG_LAT = 111_320

/**
 * Lighten / darken a `#rrggbb` colour by mixing it with white / black.
 * `amount` is 0..1; small values give subtle highlights / shadows
 * suitable for distinguishing panel insets and the doorknob from the
 * base leaf colour without recoloring the door entirely. Falls back to
 * the input string if parsing fails so a malformed colour can't crash
 * the renderer.
 */
function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function parseHex(hex: string): [number, number, number] | null {
  if (typeof hex !== 'string') return null
  let s = hex.trim()
  if (s.startsWith('#')) s = s.slice(1)
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  if (s.length !== 6) return null
  const r = parseInt(s.slice(0, 2), 16)
  const g = parseInt(s.slice(2, 4), 16)
  const b = parseInt(s.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
  return [r, g, b]
}

function toHex([r, g, b]: [number, number, number]): string {
  const toPair = (n: number) => clampByte(n).toString(16).padStart(2, '0')
  return `#${toPair(r)}${toPair(g)}${toPair(b)}`
}

export function darkenHex(hex: string, amount: number): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  const k = 1 - Math.max(0, Math.min(1, amount))
  return toHex([rgb[0] * k, rgb[1] * k, rgb[2] * k])
}

function metersToLngDelta(meters: number, lat: number): number {
  return meters / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))
}

function metersToLatDelta(meters: number): number {
  return meters / METERS_PER_DEG_LAT
}

/**
 * Opening width in meters between the two door anchors. Used by the
 * side-panel's width slider to display the current value and to
 * compute a target width when the user drags it.
 */
export function doorWidthMeters(
  vertices: ReadonlyArray<[number, number]>,
): number {
  if (vertices.length < 2) return 0
  const [v0, v1] = vertices
  const midLat = (v0[1] + v1[1]) / 2
  const dx = (v1[0] - v0[0]) * METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
  const dy = (v1[1] - v0[1]) * METERS_PER_DEG_LAT
  return Math.hypot(dx, dy)
}

/**
 * Rotates the door around its midpoint by `degrees`. Both vertices
 * move so the opening width is preserved. Positive degrees rotate
 * counter-clockwise (standard math convention).
 */
export function rotateDoorVertices(
  vertices: ReadonlyArray<[number, number]>,
  degrees: number,
): [[number, number], [number, number]] {
  const [v0, v1] = vertices
  const rad = (degrees * Math.PI) / 180
  const midLat = (v0[1] + v1[1]) / 2
  const midLng = (v0[0] + v1[0]) / 2
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // Convert each vertex to a meter offset from the midpoint, rotate,
  // then convert back to lng/lat using the midpoint's latitude.
  const rotateOne = (p: [number, number]): [number, number] => {
    const dxM = (p[0] - midLng) * METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
    const dyM = (p[1] - midLat) * METERS_PER_DEG_LAT
    const rxM = dxM * cos - dyM * sin
    const ryM = dxM * sin + dyM * cos
    return [
      midLng + metersToLngDelta(rxM, midLat),
      midLat + metersToLatDelta(ryM),
    ]
  }
  return [rotateOne(v0), rotateOne(v1)]
}

/**
 * Shifts both vertices by the given meter offset in the GEOGRAPHIC
 * frame (east = +x, north = +y).
 *
 * Useful as a low-level translate. UI callers should usually prefer
 * `nudgeDoorVerticesLocal` so the user-perceived "left/right/up/down"
 * matches the door's own axis instead of the basemap's compass.
 */
export function nudgeDoorVertices(
  vertices: ReadonlyArray<[number, number]>,
  dxMeters: number,
  dyMeters: number,
): [[number, number], [number, number]] {
  const [v0, v1] = vertices
  const midLat = (v0[1] + v1[1]) / 2
  const dLng = metersToLngDelta(dxMeters, midLat)
  const dLat = metersToLatDelta(dyMeters)
  return [
    [v0[0] + dLng, v0[1] + dLat],
    [v1[0] + dLng, v1[1] + dLat],
  ]
}

/**
 * Shifts the door in the LOCAL frame defined by its own heading
 * (v0 → v1).
 *
 *   - `alongMeters`     — positive = forward along the opening (toward v1).
 *   - `perpMeters`      — positive = to the left of the opening direction,
 *                         i.e. the swing-in side under the door tool's
 *                         convention.
 *
 * This is the right helper for nudge UI: when the user draws a door on
 * a wall that's rotated 30° relative to north, "left" along the wall is
 * an axis the user can see; "west on the map" is not. The local frame
 * is also independent of map bearing, so rotating the basemap doesn't
 * suddenly flip the arrow-key meanings.
 */
export function nudgeDoorVerticesLocal(
  vertices: ReadonlyArray<[number, number]>,
  alongMeters: number,
  perpMeters: number,
): [[number, number], [number, number]] {
  const [v0, v1] = vertices
  const midLat = (v0[1] + v1[1]) / 2
  const dx = (v1[0] - v0[0]) * METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
  const dy = (v1[1] - v0[1]) * METERS_PER_DEG_LAT
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) {
    // Degenerate door — fall through to a geographic-frame nudge so the
    // user can still recover the shape by pressing arrows.
    return nudgeDoorVertices(vertices, alongMeters, perpMeters)
  }
  const ux = dx / len
  const uy = dy / len
  // Left-perpendicular: (-uy, ux).
  const px = -uy
  const py = ux
  const dxMeters = alongMeters * ux + perpMeters * px
  const dyMeters = alongMeters * uy + perpMeters * py
  return nudgeDoorVertices(vertices, dxMeters, dyMeters)
}

/**
 * Returns new vertices with the same v0 + heading, but `widthMeters`
 * apart. Pass values ≥ 0.01 m — values smaller than that produce a
 * degenerate door and the renderer would emit nothing.
 *
 * Used by the side-panel slider so the user can resize a door
 * without redrawing it.
 */
export function resizeDoorVertices(
  vertices: ReadonlyArray<[number, number]>,
  widthMeters: number,
): [[number, number], [number, number]] {
  const current = doorWidthMeters(vertices)
  const [v0, v1] = vertices
  if (current < 1e-6) {
    // Degenerate input — fall back to placing v1 due east of v0 so the
    // door has a sane heading the user can then rotate.
    const midLat = v0[1]
    return [
      [v0[0], v0[1]],
      [v0[0] + metersToLngDelta(widthMeters, midLat), v0[1]],
    ]
  }
  const scale = widthMeters / current
  const midLat = (v0[1] + v1[1]) / 2
  const dxMeters = (v1[0] - v0[0]) * METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
  const dyMeters = (v1[1] - v0[1]) * METERS_PER_DEG_LAT
  const newDxMeters = dxMeters * scale
  const newDyMeters = dyMeters * scale
  const newMidLat = v0[1] + metersToLatDelta(newDyMeters / 2)
  return [
    [v0[0], v0[1]],
    [
      v0[0] + metersToLngDelta(newDxMeters, newMidLat),
      v0[1] + metersToLatDelta(newDyMeters),
    ],
  ]
}

export interface LocalFrame {
  v0: [number, number]
  midLat: number
  /** Opening width in meters. */
  width: number
  /** Unit vector along opening (planar meter frame). */
  ux: number
  uy: number
  /** Perpendicular unit vector (left of run). */
  px: number
  py: number
}

/** Returns null when the two anchors are coincident (degenerate door). */
export function makeFrame(v0: [number, number], v1: [number, number]): LocalFrame | null {
  const midLat = (v0[1] + v1[1]) / 2
  const dx = (v1[0] - v0[0]) * METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
  const dy = (v1[1] - v0[1]) * METERS_PER_DEG_LAT
  const width = Math.hypot(dx, dy)
  if (width < 1e-6) return null
  return {
    v0,
    midLat,
    width,
    ux: dx / width,
    uy: dy / width,
    px: -dy / width,
    py: dx / width,
  }
}

function localToLngLat(frame: LocalFrame, local: [number, number]): [number, number] {
  const [lx, ly] = local
  const mx = lx * frame.ux + ly * frame.px
  const my = lx * frame.uy + ly * frame.py
  return [
    frame.v0[0] + metersToLngDelta(mx, frame.midLat),
    frame.v0[1] + metersToLatDelta(my),
  ]
}

function ringToCoords(
  frame: LocalFrame,
  localRing: [number, number][],
): [number, number][] {
  const coords = localRing.map((p) => localToLngLat(frame, p))
  // Close the ring — GeoJSON Polygons must repeat the first vertex.
  coords.push(coords[0])
  return coords
}

/**
 * Maps the discrete `state` into a radian sweep. Kept as a function so
 * future states (e.g. `'half'`, `'quarter'`) can hook in without
 * touching call sites.
 */
function effectiveOpenRad(cfg: DoorConfig): number {
  const max = (cfg.openAngle * Math.PI) / 180
  switch (cfg.state) {
    case 'closed':
      return 0
    case 'ajar':
      return max / 2
    case 'open':
      return max
  }
}

// ---------------------------------------------------------------------------
// Jambs (frame)
// ---------------------------------------------------------------------------

function buildJambs(frame: LocalFrame, cfg: DoorConfig): [number, number][][] {
  if (!cfg.showFrame) return []
  const fw = Math.max(0.01, cfg.frameWidth)
  const ft = Math.max(0.01, cfg.frameThickness) / 2
  // Each jamb is a rectangle in the local frame; centred on y = 0 so
  // the visible faces sit symmetrically across the opening line.
  const left: [number, number][] = [
    [-fw, -ft],
    [0, -ft],
    [0, ft],
    [-fw, ft],
  ]
  const right: [number, number][] = [
    [frame.width, -ft],
    [frame.width + fw, -ft],
    [frame.width + fw, ft],
    [frame.width, ft],
  ]
  return [left, right]
}

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

/**
 * Geometry record for a single leaf — the body polygon plus enough
 * metadata to compute panel insets and a doorknob without re-deriving
 * the leaf's local axes downstream.
 */
export interface LeafGeom {
  /** Closed polygon corners (pivot, tip, tipThick, pivotThick). */
  ring: [number, number][]
  /** Hinge anchor in the door's local meter frame. */
  pivot: [number, number]
  /** Free-end anchor (opposite the hinge). */
  tip: [number, number]
  /** Unit vector from pivot toward tip. */
  ux: number
  uy: number
  /** Unit vector perpendicular to the leaf, pointing to its thick side. */
  px: number
  py: number
  /** Leaf length along (ux, uy), meters. */
  length: number
  /** Leaf thickness along (px, py), meters. */
  thick: number
  /**
   * `false` for sliding / revolving panels, where doorknobs read as
   * out of place and panel detailing is conventionally simpler.
   */
  hinged: boolean
}

/**
 * Build a hinged leaf as a 4-vertex polygon. The leaf extends from
 * `pivot` along the direction `baseRad + swingSign * openRad`, has
 * length `leafLen`, and `leafThick` on the side perpendicular to the
 * swing arc (so when the door is open, the thin tip points away from
 * the room and the broad face reads correctly in 3D).
 */
function buildHingedLeaf(
  pivot: [number, number],
  baseRad: number,
  leafLen: number,
  leafThick: number,
  swingSign: number,
  openRad: number,
): LeafGeom {
  const totalRad = baseRad + swingSign * openRad
  const cos = Math.cos(totalRad)
  const sin = Math.sin(totalRad)
  // Perpendicular to the leaf's axis, biased to the swing side.
  const px = -sin * swingSign
  const py = cos * swingSign
  const tip: [number, number] = [
    pivot[0] + cos * leafLen,
    pivot[1] + sin * leafLen,
  ]
  const ring: [number, number][] = [
    pivot,
    tip,
    [tip[0] + px * leafThick, tip[1] + py * leafThick],
    [pivot[0] + px * leafThick, pivot[1] + py * leafThick],
  ]
  return {
    ring,
    pivot,
    tip,
    ux: cos,
    uy: sin,
    px,
    py,
    length: leafLen,
    thick: leafThick,
    hinged: true,
  }
}

export function buildLeaves(frame: LocalFrame, cfg: DoorConfig): LeafGeom[] {
  const openRad = effectiveOpenRad(cfg)
  const swingSign = cfg.swingDirection === 'inward' ? 1 : -1
  const lt = Math.max(0.005, cfg.leafThickness)

  // Helper for non-hinged variants (sliding / revolving) — wraps a
  // pre-built ring as a LeafGeom with `hinged: false` so the detail
  // pass knows to skip moldings/handle on it.
  const wrapStaticLeaf = (
    ring: [number, number][],
    pivot: [number, number],
    tip: [number, number],
    uxIn: number,
    uyIn: number,
    pxIn: number,
    pyIn: number,
    length: number,
    thick: number,
  ): LeafGeom => ({
    ring,
    pivot,
    tip,
    ux: uxIn,
    uy: uyIn,
    px: pxIn,
    py: pyIn,
    length,
    thick,
    hinged: false,
  })

  switch (cfg.kind) {
    case 'single': {
      const isLeft = cfg.hingeSide === 'left'
      const pivot: [number, number] = isLeft ? [0, 0] : [frame.width, 0]
      const baseRad = isLeft ? 0 : Math.PI
      return [buildHingedLeaf(pivot, baseRad, frame.width, lt, swingSign, openRad)]
    }
    case 'double': {
      const half = frame.width / 2
      // Both leaves rotate the same physical direction. Because leaf 2's
      // base angle is π (it extends in -x when closed), we negate its
      // swingSign to make it sweep toward the same perpendicular side as
      // leaf 1.
      const leafL = buildHingedLeaf([0, 0], 0, half, lt, swingSign, openRad)
      const leafR = buildHingedLeaf(
        [frame.width, 0],
        Math.PI,
        half,
        lt,
        -swingSign,
        openRad,
      )
      return [leafL, leafR]
    }
    case 'sliding': {
      // The panel translates along ±x. Pocket on `hingeSide` absorbs it.
      const slidePct =
        cfg.state === 'closed' ? 0 : cfg.state === 'ajar' ? 0.5 : 1
      const dir = cfg.hingeSide === 'left' ? -1 : 1
      const offset = dir * frame.width * slidePct
      const side = swingSign
      const yA = 0
      const yB = lt * side
      const x0 = offset
      const x1 = offset + frame.width
      const ring: [number, number][] = [
        [x0, yA],
        [x1, yA],
        [x1, yB],
        [x0, yB],
      ]
      return [
        wrapStaticLeaf(
          ring,
          [x0, yA],
          [x1, yA],
          1, 0, 0, side,
          frame.width,
          lt,
        ),
      ]
    }
    case 'revolving': {
      const cx = frame.width / 2
      const center: [number, number] = [cx, 0]
      const radius = frame.width / 2
      const half = lt / 2
      // `closed` shows the cross at its base orientation; `ajar`/`open`
      // rotate the whole assembly. swingSign flips direction.
      const rotate = (cfg.state === 'closed' ? 0 : openRad) * swingSign
      const leaves: LeafGeom[] = []
      for (let i = 0; i < 4; i++) {
        const base = (i * Math.PI) / 2 + rotate
        const cos = Math.cos(base)
        const sin = Math.sin(base)
        const px = -sin
        const py = cos
        const tip: [number, number] = [
          center[0] + cos * radius,
          center[1] + sin * radius,
        ]
        const ring: [number, number][] = [
          [center[0] + px * -half, center[1] + py * -half],
          [tip[0] + px * -half, tip[1] + py * -half],
          [tip[0] + px * half, tip[1] + py * half],
          [center[0] + px * half, center[1] + py * half],
        ]
        leaves.push(
          wrapStaticLeaf(ring, center, tip, cos, sin, px, py, radius, lt),
        )
      }
      return leaves
    }
  }
}

// ---------------------------------------------------------------------------
// Swing arcs
// ---------------------------------------------------------------------------

function arcPoints(
  pivot: [number, number],
  baseRad: number,
  sweepRad: number,
  radius: number,
  segs: number,
): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    const theta = baseRad + sweepRad * t
    pts.push([
      pivot[0] + Math.cos(theta) * radius,
      pivot[1] + Math.sin(theta) * radius,
    ])
  }
  return pts
}

function buildArcs(frame: LocalFrame, cfg: DoorConfig): [number, number][][] {
  if (!cfg.showSwingArc) return []
  if (cfg.kind === 'sliding') return []
  if (cfg.kind === 'revolving') {
    const cx = frame.width / 2
    const r = frame.width / 2
    const segs = 48
    const ring: [number, number][] = []
    for (let i = 0; i <= segs; i++) {
      const t = (i / segs) * Math.PI * 2
      ring.push([cx + Math.cos(t) * r, Math.sin(t) * r])
    }
    return [ring]
  }
  const maxRad = (cfg.openAngle * Math.PI) / 180
  const swingSign = cfg.swingDirection === 'inward' ? 1 : -1
  const segs = Math.max(8, Math.ceil((cfg.openAngle / 90) * 16))
  if (cfg.kind === 'single') {
    const isLeft = cfg.hingeSide === 'left'
    const pivot: [number, number] = isLeft ? [0, 0] : [frame.width, 0]
    const baseRad = isLeft ? 0 : Math.PI
    return [arcPoints(pivot, baseRad, swingSign * maxRad, frame.width, segs)]
  }
  // double
  const half = frame.width / 2
  return [
    arcPoints([0, 0], 0, swingSign * maxRad, half, segs),
    arcPoints([frame.width, 0], Math.PI, -swingSign * maxRad, half, segs),
  ]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DoorFeaturesResult {
  polygons: Feature<Polygon, DoorFeatureProps>[]
  lines: Feature<LineString, DoorFeatureProps>[]
  labels: Feature<Point, DoorFeatureProps>[]
}

const EMPTY_RESULT: DoorFeaturesResult = {
  polygons: [],
  lines: [],
  labels: [],
}

export function buildDoorFeatures(shape: DoorShape): DoorFeaturesResult {
  return buildDoorFeaturesRaw(shape.vertices, shape.config, shape.id, shape.name)
}

/**
 * Lower-level builder used by both committed shapes and live-preview
 * (where there isn't an id yet). Pass `id = -1` for preview rendering
 * — negative ids never collide with the door store's positive
 * counter, so selection filters can still safely use this id space.
 */
export function buildDoorFeaturesRaw(
  vertices: [[number, number], [number, number]],
  cfg: DoorConfig,
  id: number,
  name: string,
): DoorFeaturesResult {
  const frame = makeFrame(vertices[0], vertices[1])
  if (!frame) return EMPTY_RESULT

  const baseHeight = Math.max(0, cfg.elevation)
  const topHeight = baseHeight + Math.max(0.01, cfg.doorHeight)
  // Leaves stop just shy of the frame top so the layered render reads
  // as "frame around leaf" rather than identical-height stacks fighting.
  const leafTop = baseHeight + Math.max(0.01, cfg.doorHeight) * 0.96
  const opacityNorm = Math.max(0, Math.min(1, cfg.opacity / 100))

  const polygons: Feature<Polygon, DoorFeatureProps>[] = []
  const lines: Feature<LineString, DoorFeatureProps>[] = []
  const labels: Feature<Point, DoorFeatureProps>[] = []

  // Frame jambs.
  const jambs = buildJambs(frame, cfg)
  for (let i = 0; i < jambs.length; i++) {
    polygons.push({
      type: 'Feature',
      id: `${id}-frame-${i}`,
      properties: {
        doorId: id,
        kind: 'frame',
        base_height: baseHeight,
        height: topHeight,
        color: cfg.frameColor,
        opacity: opacityNorm,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [ringToCoords(frame, jambs[i])],
      },
    })
  }

  // Leaves. Panels, handles and hinges are drawn by the door mesh
  // (door/mesh.ts) — fill-extrusion could only stack them on top of the
  // leaf. These boxes are the invisible click / selection targets.
  const leaves = buildLeaves(frame, cfg)
  for (let i = 0; i < leaves.length; i++) {
    polygons.push({
      type: 'Feature',
      id: `${id}-leaf-${i}`,
      properties: {
        doorId: id,
        kind: 'leaf',
        base_height: baseHeight,
        height: leafTop,
        color: cfg.leafColor,
        opacity: opacityNorm,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [ringToCoords(frame, leaves[i].ring)],
      },
    })
  }

  // Lintel — header bar spanning the top of the opening between the
  // two jambs. Reads as the door's frame top in 3D and as a clear
  // "opening here" cue from above. Skipped for revolving (it would
  // intersect the rotating leaves and look wrong).
  if (cfg.showFrame && cfg.kind !== 'revolving') {
    const lintelHalfThick = Math.max(0.01, cfg.frameThickness) / 2
    const lintelTop = baseHeight + Math.max(0.01, cfg.doorHeight) * 1.04
    const lintelBase = baseHeight + Math.max(0.01, cfg.doorHeight) * 0.95
    const lintelRing: [number, number][] = [
      [0, -lintelHalfThick],
      [frame.width, -lintelHalfThick],
      [frame.width, lintelHalfThick],
      [0, lintelHalfThick],
    ]
    polygons.push({
      type: 'Feature',
      id: `${id}-lintel`,
      properties: {
        doorId: id,
        kind: 'lintel',
        base_height: lintelBase,
        height: lintelTop,
        color: darkenHex(cfg.frameColor, 0.12),
        opacity: opacityNorm,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [ringToCoords(frame, lintelRing)],
      },
    })
  }

  // Swing arcs.
  const arcs = buildArcs(frame, cfg)
  for (let i = 0; i < arcs.length; i++) {
    const coords = arcs[i].map((p) => localToLngLat(frame, p))
    lines.push({
      type: 'Feature',
      id: `${id}-arc-${i}`,
      properties: {
        doorId: id,
        kind: 'arc',
        // Swing arcs ride just above the floor — visible from above
        // without z-fighting with the basemap or the leaf body.
        base_height: baseHeight + 0.01,
        height: baseHeight + 0.02,
        color: cfg.arcColor,
        opacity: opacityNorm,
      },
      geometry: { type: 'LineString', coordinates: coords },
    })
  }

  // Single label point at the opening centre, lifted to door top.
  if (cfg.showLabels) {
    const text = (cfg.label && cfg.label.trim()) || name
    if (text) {
      const centre = localToLngLat(frame, [frame.width / 2, 0])
      labels.push({
        type: 'Feature',
        id: `${id}-label`,
        properties: {
          doorId: id,
          kind: 'label',
          base_height: topHeight,
          height: topHeight,
          color: cfg.labelColor,
          opacity: opacityNorm,
          text,
          textColor: cfg.labelColor,
          textSize: cfg.labelSize,
        },
        geometry: { type: 'Point', coordinates: centre },
      })
    }
  }

  return { polygons, lines, labels }
}

/**
 * Convenience: collapse a list of doors into the three flat
 * FeatureCollections the overlay binds to each source.
 */
export function doorsToFeatureCollections(doors: ReadonlyArray<DoorShape>): {
  polygons: FeatureCollection<Polygon, DoorFeatureProps>
  lines: FeatureCollection<LineString, DoorFeatureProps>
  labels: FeatureCollection<Point, DoorFeatureProps>
} {
  const polygons: Feature<Polygon, DoorFeatureProps>[] = []
  const lines: Feature<LineString, DoorFeatureProps>[] = []
  const labels: Feature<Point, DoorFeatureProps>[] = []
  for (const door of doors) {
    if (!door.visible) continue
    const r = buildDoorFeatures(door)
    polygons.push(...r.polygons)
    lines.push(...r.lines)
    labels.push(...r.labels)
  }
  return {
    polygons: { type: 'FeatureCollection', features: polygons },
    lines: { type: 'FeatureCollection', features: lines },
    labels: { type: 'FeatureCollection', features: labels },
  }
}
