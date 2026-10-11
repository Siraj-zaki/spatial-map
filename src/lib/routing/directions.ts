/**
 * Turn-by-turn directions generator.
 *
 * Given a polyline of lng/lat waypoints, produce a list of Instructions
 * — the same shape a car GPS uses: "In 30 m, turn right", "In 12 m,
 * arrive". Purely a function of geometry; nothing here knows about
 * roads or aisles.
 *
 * The routing pipeline hands us a corner-only polyline (thanks to
 * line-of-sight simplification), so consecutive waypoints already
 * represent turning points. For each interior waypoint we compute the
 * bearing change and classify it into a discrete turn kind. The first
 * instruction is always `start` (with initial heading) and the last
 * is always `arrive`.
 *
 * All distances are metres. Bearings are compass degrees (0 = north,
 * 90 = east, cw positive).
 */

export type TurnKind =
  | 'start'
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'sharp-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'u-turn'
  | 'arrive'

export interface Instruction {
  /** Discrete turn kind — drives the icon + verb in the UI. */
  kind: TurnKind
  /**
   * Distance from the PREVIOUS instruction, in metres. For the very
   * first instruction (`start`) this is 0 and for `arrive` it's the
   * length of the final segment.
   */
  distanceMeters: number
  /**
   * Cumulative distance from the route start to this instruction,
   * in metres. Used to display "in 30 m, turn right" style copy.
   */
  cumulativeMeters: number
  /**
   * Compass bearing of the OUTGOING segment (the direction the user
   * will be walking after executing this instruction). Undefined for
   * `arrive`.
   */
  outgoingBearingDeg?: number
  /** Signed bearing change at this waypoint, in degrees. Undefined for start/arrive. */
  turnAngleDeg?: number
  /** The lng/lat of the waypoint this instruction sits at. */
  position: [number, number]
}

const R_EARTH = 6378137

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Great-circle distance in metres. */
function haversine(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180
  const dLat = (b[1] - a[1]) * toRad
  const dLng = (b[0] - a[0]) * toRad
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.sqrt(s))
}

/** Initial compass bearing FROM a TO b, in degrees [0, 360). */
function bearing(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180
  const lat1 = a[1] * toRad
  const lat2 = b[1] * toRad
  const dLng = (b[0] - a[0]) * toRad
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  const deg = (Math.atan2(y, x) * 180) / Math.PI
  return (deg + 360) % 360
}

/**
 * Normalise a bearing DELTA to the shortest signed arc in [-180, 180].
 * Positive = clockwise (right turn), negative = counter-clockwise (left).
 */
function normalizeAngle(deg: number): number {
  let d = ((deg + 180) % 360) - 180
  if (d <= -180) d += 360
  return d
}

/**
 * Classify a signed turn angle (degrees) into a TurnKind. Thresholds
 * chosen to match the buckets pedestrian GPS apps use — anything
 * under 15° reads as "keep straight" and anything past 160° is a
 * u-turn. The middle buckets are wide enough that small routing
 * jitter doesn't cause an instruction to flip between "slight" and
 * "regular" on similar geometry.
 */
function turnKindFromAngle(angleDeg: number): TurnKind {
  const abs = Math.abs(angleDeg)
  if (abs < 15) return 'straight'
  if (abs >= 160) return 'u-turn'
  const right = angleDeg > 0
  if (abs < 40) return right ? 'slight-right' : 'slight-left'
  if (abs < 100) return right ? 'right' : 'left'
  return right ? 'sharp-right' : 'sharp-left'
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Convert a route polyline into a list of turn-by-turn instructions.
 * Returns an empty array when the polyline has fewer than 2 points.
 *
 * The consumer can rely on the following invariants:
 *   - `result[0].kind === 'start'` when the polyline has ≥2 points.
 *   - `result[result.length - 1].kind === 'arrive'` (same condition).
 *   - Cumulative distances are strictly non-decreasing.
 *   - `distanceMeters` of `start` is 0.
 */
export function generateInstructions(
  waypoints: ReadonlyArray<[number, number]>,
): Instruction[] {
  if (waypoints.length < 2) return []

  const out: Instruction[] = []
  const initialBearing = bearing(waypoints[0], waypoints[1])
  out.push({
    kind: 'start',
    distanceMeters: 0,
    cumulativeMeters: 0,
    outgoingBearingDeg: initialBearing,
    position: waypoints[0],
  })

  let cumulative = 0
  let prevBearing = initialBearing

  // Track the length of the current "run" — we accumulate segment
  // lengths until we hit an actual turn (not just a jog) and then
  // emit ONE instruction summarising the distance the user should
  // travel before that turn.
  let runLength = haversine(waypoints[0], waypoints[1])

  for (let i = 1; i < waypoints.length - 1; i++) {
    const nextBearing = bearing(waypoints[i], waypoints[i + 1])
    const turnAngle = normalizeAngle(nextBearing - prevBearing)
    const kind = turnKindFromAngle(turnAngle)

    if (kind !== 'straight') {
      cumulative += runLength
      out.push({
        kind,
        distanceMeters: runLength,
        cumulativeMeters: cumulative,
        outgoingBearingDeg: nextBearing,
        turnAngleDeg: turnAngle,
        position: waypoints[i],
      })
      runLength = 0
    }

    runLength += haversine(waypoints[i], waypoints[i + 1])
    prevBearing = nextBearing
  }

  // Final `arrive` instruction covers the last run.
  cumulative += runLength
  out.push({
    kind: 'arrive',
    distanceMeters: runLength,
    cumulativeMeters: cumulative,
    position: waypoints[waypoints.length - 1],
  })

  return out
}

/**
 * Human-friendly metre formatter for UI copy. Below 100 m we snap to
 * whole metres; above that we snap to 5 m so the readout doesn't
 * jitter every render.
 */
export function formatDistanceMeters(m: number): string {
  if (m < 1) return `${Math.round(m * 100)} cm`
  if (m < 100) return `${Math.round(m)} m`
  const rounded = Math.round(m / 5) * 5
  if (rounded < 1000) return `${rounded} m`
  return `${(rounded / 1000).toFixed(rounded < 10000 ? 2 : 1)} km`
}

/**
 * Rough walking-time estimate at 1.35 m/s (average adult walking
 * pace, WHO figure). Emits a coarse minutes-only string for the
 * summary card — precision beyond 1 min is theatre.
 */
export function estimateWalkingMinutes(distanceMeters: number): number {
  const seconds = distanceMeters / 1.35
  return Math.max(1, Math.round(seconds / 60))
}

/**
 * Cardinal compass label for the start instruction ("Head north-west").
 * Buckets bearings into the 8-way rose so the copy stays readable —
 * "334°" doesn't help a human walking a warehouse aisle.
 */
export function cardinalFromBearing(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8
  return dirs[idx]
}
