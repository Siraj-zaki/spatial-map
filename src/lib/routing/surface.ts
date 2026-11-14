/**
 * The surface a route walks on: the floor, or the top of a raised area
 * standing on it (a floor-area slab, a room drawn 1 m tall). A route drawn
 * at the floor's own height runs inside those extrusions and is hidden, so
 * each leg is lifted onto whatever it crosses — stepping up at the edges.
 *
 * Shared with the mobile app (route ribbons, the walker, the pins), so both
 * lift a route by the same rule.
 */

import { POLYGON_MIN_BASE_M } from '@/lib/polygon-generators'
import type { PolygonShape } from '@/lib/shapes'
import type { LngLat } from './types'

/** A raised walkable polygon: where it starts and its top surface height. */
export interface ElevatedPolygon {
  vertices: LngLat[]
  /** Metres above sea level of its underside (its `elevation`). */
  baseZ: number
  /** Metres above sea level to draw a route while over this polygon. */
  topZ: number
}

/** The polygons with a height, at the top the map draws (map-polygon-overlay SLAB_TOP). */
export function raisedSurfaces(polygons: ReadonlyArray<Pick<PolygonShape, 'vertices' | 'visible' | 'config'>>): ElevatedPolygon[] {
  const out: ElevatedPolygon[] = []
  for (const p of polygons) {
    if (p.visible === false || p.vertices.length < 3) continue
    const elev = p.config?.elevation ?? 0
    const h = p.config?.height ?? 0
    const topZ = h > 0 ? Math.max(elev, POLYGON_MIN_BASE_M) + Math.max(h, 0.05) : 0
    if (topZ <= 0.001) continue
    out.push({ vertices: p.vertices as LngLat[], baseZ: elev, topZ })
  }
  return out
}

/**
 * The ones standing on a floor at `floorZ`, by height: their base from just
 * under the floor up to head height (a room drawn at this floor's height
 * counts even if it was saved on another floor).
 */
export function surfacesOnFloor(polys: ReadonlyArray<ElevatedPolygon>, floorZ: number): ElevatedPolygon[] {
  return polys.filter((p) => p.baseZ >= floorZ - 0.6 && p.baseZ < floorZ + 2)
}

/** Even-odd point-in-polygon on a lng/lat ring. */
function pointInRing(p: LngLat, ring: ReadonlyArray<LngLat>): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersect = yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/** Height of the walking surface at `p`: the floor, or a raised polygon on it. */
export function surfaceAt(p: LngLat, floorZ: number, polys: ReadonlyArray<ElevatedPolygon>): number {
  let best = floorZ
  for (const poly of polys) if (poly.topZ > best && pointInRing(p, poly.vertices)) best = poly.topZ
  return best
}

/**
 * Slice one leg into runs of constant surface height, densified at 0.5 m
 * so a step up onto a raised polygon lands near its edge. Adjacent runs
 * share the boundary point at two heights — a clean step in 3D.
 */
export function legRuns(
  path: ReadonlyArray<LngLat>,
  floorZ: number,
  polys: ReadonlyArray<ElevatedPolygon>,
): Array<{ coordinates: LngLat[]; z: number }> {
  if (path.length < 2) return []
  const DEG = (Math.PI * 6378137) / 180
  const samples: Array<{ p: LngLat; z: number }> = []
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]
    const b = path[i + 1]
    const cosLat = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180))
    const len = Math.hypot((b[0] - a[0]) * DEG * cosLat, (b[1] - a[1]) * DEG)
    const steps = Math.max(1, Math.ceil(len / 0.5))
    for (let k = i > 0 ? 1 : 0; k <= steps; k++) {
      const t = k / steps
      const p: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      samples.push({ p, z: surfaceAt(p, floorZ, polys) })
    }
  }
  const out: Array<{ coordinates: LngLat[]; z: number }> = []
  let run: LngLat[] = [samples[0].p]
  let runZ = samples[0].z
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]
    run.push(s.p)
    if (s.z === runZ) continue
    out.push({ coordinates: run, z: runZ })
    run = [s.p]
    runZ = s.z
  }
  out.push({ coordinates: run, z: runZ })
  return out
}
