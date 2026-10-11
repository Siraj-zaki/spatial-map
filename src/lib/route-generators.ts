/**
 * Route (wayfinding path) generators.
 *
 * Produces the GeoJSON the `MapRouteOverlay` feeds to Mapbox. Each route
 * becomes:
 *   - one LineString feature (the polyline stroke, painted per type)
 *   - N-1 Point features at each interior segment's midpoint carrying a
 *     `bearing` property — rendered as a directional arrow symbol so
 *     users can see the direction of travel at a glance
 *   - N Point features at each waypoint (dots that the future
 *     pathfinding graph will treat as nodes)
 *   - optionally one Point at start/middle/end for the label
 *
 * Kept intentionally close in shape to `line-generators.ts` so the
 * overlay can mirror the polygon/line paint-expression conventions:
 * `elevation` is stamped on every feature so the symbol layers can lift
 * onto the floor plan's altitude via `symbol-z-offset`. Colour is stamped
 * so a single per-route paint expression handles both the config-supplied
 * override AND the type-driven default (`ROUTE_TYPE_COLORS[type]`).
 */

import { bearing as turfBearing, distance as turfDistance, along as turfAlong, lineString as turfLineString } from '@turf/turf'
import type { RouteShape, RouteShapeConfig, RouteType } from './shapes'
import { ROUTE_TYPE_COLORS } from './shapes'

/** Feature.properties stamped on the LineString stroke. */
interface RouteStrokeProps {
  id: number | undefined
  name: string
  color: string
  width: number
  opacity: number
  dash: RouteShapeConfig['dash']
  elevation: number
  routeType: RouteType
  /** Preview flag — used by the paint to render an in-flight route as
   *  slightly translucent + amber-tinted so the user tells committed
   *  from in-progress at a glance. */
  preview: 0 | 1
  /** Snap flag — set to 1 on the preview stroke when the cursor is
   *  currently snapping onto another route's vertex, so the paint
   *  expression can flip the preview to a "you're connecting" green. */
  snapped: 0 | 1
}

/**
 * Resolve the paint colour: user override wins, then the type-driven
 * default, then a safe fallback. The overlay pushes this into the
 * feature so the layer's paint can be a single `['get', 'color']`.
 */
export function routeColorFor(config: RouteShapeConfig): string {
  return config.color ?? ROUTE_TYPE_COLORS[config.type] ?? '#3b82f6'
}

/** Build the polyline stroke for one route. */
export function buildRouteStrokeFeature(
  route: RouteShape,
  overrides?: {
    preview?: boolean
    snapped?: boolean
    colorOverride?: string
    configOverride?: RouteShapeConfig
  },
): GeoJSON.Feature<GeoJSON.LineString, RouteStrokeProps> | null {
  const config = overrides?.configOverride ?? route.config
  if (route.vertices.length < 2) return null
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: route.vertices },
    properties: {
      id: route.id,
      name: route.name,
      color: overrides?.colorOverride ?? routeColorFor(config),
      width: config.width,
      opacity: config.opacity,
      dash: config.dash,
      elevation: config.elevation,
      routeType: config.type,
      preview: overrides?.preview ? 1 : 0,
      snapped: overrides?.snapped ? 1 : 0,
    },
  }
}

/**
 * Build waypoint dot features — one per vertex. Users see these as
 * small solid circles along the path; when pathfinding ships, each
 * dot is a graph node the solver can start / end / route through.
 */
export function buildRouteWaypointFeatures(
  route: RouteShape,
): GeoJSON.Feature<GeoJSON.Point>[] {
  const out: GeoJSON.Feature<GeoJSON.Point>[] = []
  const color = routeColorFor(route.config)
  for (let i = 0; i < route.vertices.length; i++) {
    const v = route.vertices[i]
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: v },
      properties: {
        id: route.id,
        color,
        elevation: route.config.elevation,
        waypointIndex: i,
        // Start / end vertices are painted slightly larger so users
        // can identify the path's direction without hovering.
        endpoint: i === 0 ? 'start' : i === route.vertices.length - 1 ? 'end' : 'middle',
      },
    })
  }
  return out
}

/**
 * Build directional arrows along the path. One arrow per segment
 * placed at the segment midpoint with a `bearing` property (0 = north,
 * 90 = east). The overlay's arrow symbol layer rotates the glyph by
 * that value so the arrow always points along the direction of travel.
 *
 * When `spacingMeters` is set (from `config.arrowSpacing`) we insert
 * additional arrows between vertices for long segments so the flow
 * stays legible on stretched-out paths.
 */
export function buildRouteArrowFeatures(
  route: RouteShape,
): GeoJSON.Feature<GeoJSON.Point>[] {
  const out: GeoJSON.Feature<GeoJSON.Point>[] = []
  if (!route.config.showArrows) return out
  if (route.vertices.length < 2) return out
  const color = routeColorFor(route.config)
  const spacingKm = Math.max(0.5, route.config.arrowSpacing) / 1000
  for (let i = 0; i < route.vertices.length - 1; i++) {
    const a = route.vertices[i]
    const b = route.vertices[i + 1]
    const brng = turfBearing(a, b)
    const segKm = turfDistance(a, b, { units: 'kilometers' })
    // Always at least one arrow at the midpoint of the segment. For
    // longer segments, insert additional arrows at `spacingKm`
    // intervals so a 20 m aisle doesn't look devoid of flow.
    const arrows = Math.max(1, Math.floor(segKm / spacingKm))
    const segFeature = turfLineString([a, b])
    for (let k = 1; k <= arrows; k++) {
      const t = k / (arrows + 1)
      const pt = turfAlong(segFeature, segKm * t, { units: 'kilometers' })
      out.push({
        type: 'Feature',
        geometry: pt.geometry,
        properties: {
          id: route.id,
          color,
          elevation: route.config.elevation,
          bearing: brng,
          size: route.config.arrowSize,
        },
      })
    }
  }
  return out
}

/**
 * Build one label feature per route. Position depends on
 * `config.labelPosition`: start = first vertex, end = last vertex,
 * middle = along-the-path midpoint. Follows the same convention as
 * line labels.
 */
export function buildRouteLabelFeature(
  route: RouteShape,
): GeoJSON.Feature<GeoJSON.Point> | null {
  if (!route.config.showLabels) return null
  const text = route.config.label.trim() || route.name
  if (!text) return null
  if (route.vertices.length < 2) return null
  let anchor: [number, number]
  if (route.config.labelPosition === 'start') {
    anchor = route.vertices[0]
  } else if (route.config.labelPosition === 'end') {
    anchor = route.vertices[route.vertices.length - 1]
  } else {
    // Midpoint by along-the-path arc length.
    const seg = turfLineString(route.vertices)
    const totalKm = turfDistance(route.vertices[0], route.vertices[route.vertices.length - 1], {
      units: 'kilometers',
    })
    // Total path length ≥ endpoint chord length, so this is an
    // approximation for the visible label position. Good enough for
    // straight-ish paths; users rarely need pixel-perfect label
    // placement for a route.
    anchor = turfAlong(seg, totalKm / 2, { units: 'kilometers' }).geometry.coordinates as [number, number]
  }
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: anchor },
    properties: {
      id: route.id,
      text,
      color: route.config.labelColor,
      size: route.config.labelSize,
      elevation: route.config.elevation,
    },
  }
}

/**
 * Build every feature collection the overlay needs for a set of
 * routes plus an optional live-draw preview route. Preview vertices
 * are rendered from `liveVertices` + optional `liveCursor` (trailing
 * edge) using the `liveConfig` so users see the actual style they're
 * placing.
 */
export function buildRouteFeatureCollections(
  routes: readonly RouteShape[],
  livePreview?: {
    vertices: [number, number][]
    cursor: [number, number] | null
    config: RouteShapeConfig
    name?: string
    /** True when the cursor is currently snapping onto another route's
     *  vertex — flips the preview stroke to green so the user sees the
     *  "you're about to connect" signal. */
    snapped?: boolean
  } | null,
): {
  strokes: GeoJSON.FeatureCollection<GeoJSON.LineString>
  waypoints: GeoJSON.FeatureCollection<GeoJSON.Point>
  arrows: GeoJSON.FeatureCollection<GeoJSON.Point>
  labels: GeoJSON.FeatureCollection<GeoJSON.Point>
} {
  const strokes: GeoJSON.Feature<GeoJSON.LineString>[] = []
  const waypoints: GeoJSON.Feature<GeoJSON.Point>[] = []
  const arrows: GeoJSON.Feature<GeoJSON.Point>[] = []
  const labels: GeoJSON.Feature<GeoJSON.Point>[] = []
  for (const r of routes) {
    if (r.visible === false) continue
    const stroke = buildRouteStrokeFeature(r)
    if (stroke) strokes.push(stroke)
    for (const w of buildRouteWaypointFeatures(r)) waypoints.push(w)
    for (const a of buildRouteArrowFeatures(r)) arrows.push(a)
    const l = buildRouteLabelFeature(r)
    if (l) labels.push(l)
  }
  if (livePreview) {
    // Build a fake RouteShape for the in-progress path so all the
    // existing helpers Just Work. The `preview` flag on the stroke
    // properties tells the paint expression to render as translucent
    // amber overlay so it reads as "in progress" without conflicting
    // with the committed route colours.
    const chainVerts = [
      ...livePreview.vertices,
      ...(livePreview.cursor ? [livePreview.cursor] : []),
    ] as [number, number][]
    if (chainVerts.length >= 2) {
      const now = new Date()
      const fakeRoute: RouteShape = {
        id: undefined,
        name: livePreview.name ?? 'Route',
        vertices: chainVerts,
        rotation: 0,
        config: livePreview.config,
        visible: true,
        zoneId: undefined,
        unit: 'm',
        createdAt: now,
        updatedAt: now,
      }
      const stroke = buildRouteStrokeFeature(fakeRoute, {
        preview: true,
        snapped: livePreview.snapped,
      })
      if (stroke) strokes.push(stroke)
      for (const w of buildRouteWaypointFeatures(fakeRoute)) waypoints.push(w)
      for (const a of buildRouteArrowFeatures(fakeRoute)) arrows.push(a)
    }
  }
  return {
    strokes: { type: 'FeatureCollection', features: strokes },
    waypoints: { type: 'FeatureCollection', features: waypoints },
    arrows: { type: 'FeatureCollection', features: arrows },
    labels: { type: 'FeatureCollection', features: labels },
  }
}

/** Total path length in metres — for the drawing HUD. */
export function routeLengthMeters(vertices: readonly [number, number][]): number {
  if (vertices.length < 2) return 0
  let total = 0
  for (let i = 1; i < vertices.length; i++) {
    total += turfDistance(vertices[i - 1], vertices[i], { units: 'kilometers' }) * 1000
  }
  return total
}
