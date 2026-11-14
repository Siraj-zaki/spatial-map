import { booleanPointInPolygon } from '@turf/turf'
import type { GeoJSONFeature, Map as MapboxMapInstance, PointLike } from 'mapbox-gl'

import { FLAT_SLAB_BASE_M, FLAT_SLAB_THICKNESS_M, POLYGON_MIN_BASE_M } from '@/lib/polygon-generators'

/**
 * Ray-cast the click's screen point against a horizontal plane at
 * `altitudeMeters` (world-relative) and return the lng/lat where the
 * intersection lands. Mapbox's built-in `map.unproject` / the
 * `MapMouseEvent.lngLat` always hit the ground plane (z = 0), so
 * clicking on top of an elevated floor plan gives back the lng/lat of
 * the ground point *under* the raster — which then drifts visibly from
 * the click when we render the vertex dot lifted to `elevation`
 * (parallax at pitch). Casting against the elevated plane instead
 * makes the click land on the point of the raster the user was
 * actually pointing at, and the rendered dot ends up exactly under
 * the cursor.
 *
 * Uses Mapbox's own `map.unproject(point, altitude)`, which casts the
 * ray through the inverse pixel matrix. Don't cast from
 * `getFreeCameraOptions().position` instead: below 15° pitch the
 * Standard style blends in an orthographic camera, whose rays are
 * parallel and don't start at that position, so the vertex landed
 * metres from the cursor in the top-down view and only lined up once
 * the map was tilted (2026-11-03). No terrain is ever set, so the
 * altitude argument is always honoured.
 */
export function unprojectAtAltitude(
  map: MapboxMapInstance,
  point: { x: number; y: number },
  altitudeMeters: number,
): { lng: number; lat: number } {
  const ll = map.unproject(
    point as PointLike,
    altitudeMeters > 0 ? altitudeMeters : 0,
  )
  return { lng: ll.lng, lat: ll.lat }
}

// ---- Clicks on what the user sees ----------------------------------------

/** Same buckets as the shape overlays; bucket 0 (invisible) never takes a click. */
const OPACITY_BUCKETS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const

type Props = Record<string, unknown> | null | undefined
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0

/** Top of a rendered shape, by the same rules its overlay draws it with. */
const SURFACES: ReadonlyArray<{ prefix: string; top: (p: Props) => number }> = [
  {
    // map-polygon-overlay SLAB_BASE / SLAB_TOP.
    prefix: 'polygon-extrude-layer-op',
    top: (p) => {
      const h = num(p?.height)
      const elev = num(p?.elevation)
      return h > 0
        ? Math.max(elev, POLYGON_MIN_BASE_M) + Math.max(h, 0.05)
        : Math.max(elev, FLAT_SLAB_BASE_M) + FLAT_SLAB_THICKNESS_M
    },
  },
  { prefix: 'line-wall-layer-op', top: (p) => num(p?.elevation) + Math.max(num(p?.height), 0.05) },
  { prefix: 'grid-extrude-layer-op', top: (p) => num(p?.elevation) + Math.max(num(p?.height), 0.05) },
  { prefix: 'circle-extrude-layer-op', top: (p) => num(p?.elevation) + Math.max(num(p?.height), 0.05) },
]

/** Only surfaces on the floor being drawn on count: a slab just under it
 *  up to a storey-high wall on it. Other floors never take the click. */
const BELOW_M = 0.6
const ABOVE_M = 4.5

/**
 * Where the click lands on the scene the user is looking at. A draw tool
 * places shapes at its own elevation, but the user points at what is
 * drawn: the top of a floor slab, a room, a wall or a rack, which can sit
 * a little above that elevation (a 0.5 m floor-area slab, a 3 m wall). Cast
 * at the tool's elevation alone, the click lands a pitch-dependent
 * distance away from the cursor — the "starts a bit away from the wall"
 * bug on upper floors.
 *
 * So: among the visible surfaces under the cursor that belong to this
 * floor, take the highest one whose TOP face the cursor ray actually
 * hits (inside its footprint — a ray through a side face doesn't count)
 * and use that hit's lng/lat. With nothing under the cursor, the tool's
 * own elevation plane — the previous behaviour.
 */
export function unprojectOnScene(
  map: MapboxMapInstance,
  point: { x: number; y: number },
  floorAltitudeMeters: number,
): { lng: number; lat: number } {
  const fallback = unprojectAtAltitude(map, point, floorAltitudeMeters)
  const layers: string[] = []
  const surfaceOf = new Map<string, (typeof SURFACES)[number]>()
  try {
    for (const s of SURFACES) {
      for (const b of OPACITY_BUCKETS) {
        const id = `${s.prefix}${b}`
        if (map.getLayer(id)) {
          layers.push(id)
          surfaceOf.set(id, s)
        }
      }
    }
  } catch {
    return fallback
  }
  if (layers.length === 0) return fallback
  let feats: GeoJSONFeature[]
  try {
    feats = map.queryRenderedFeatures([point.x, point.y], { layers })
  } catch {
    return fallback
  }
  let best: { lng: number; lat: number } | null = null
  let bestTop = -Infinity
  for (const f of feats) {
    const surface = surfaceOf.get((f.layer as { id?: string } | undefined)?.id ?? '')
    if (!surface) continue
    const g = f.geometry
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue
    const top = surface.top(f.properties as Props)
    if (top <= bestTop || top < floorAltitudeMeters - BELOW_M || top > floorAltitudeMeters + ABOVE_M) continue
    const hit = unprojectAtAltitude(map, point, top)
    if (!booleanPointInPolygon([hit.lng, hit.lat], g)) continue
    best = hit
    bestTop = top
  }
  return best ?? fallback
}
