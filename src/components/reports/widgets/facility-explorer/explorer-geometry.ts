/**
 * Geometry for the facility explorer: look a report row's shape up in the
 * loaded spatial store (entity_key "<api-kind>:<id>"), outline it for a
 * thumbnail, and box it for the map camera.
 *
 * Outlines are in local metres (x east, y north) around the shape, so a
 * thumbnail keeps the shape's real proportions.
 */

import type { Grid } from '@/lib/db'
import type { DoorShape } from '@/lib/door/types'
import type {
  ImageShape,
  LineShape,
  MarkerShape,
  ModelShape,
  PolygonShape,
  StairShape,
  TextLabelShape,
} from '@/lib/shapes'
import { imageCorners } from '@/lib/image-generators'

export type ExplorerKind = 'polygons' | 'markers' | 'grids' | 'images' | 'lines' | 'doors' | 'stairs' | 'text-labels' | 'models'

export type ExplorerShape =
  | { kind: 'polygons'; shape: PolygonShape }
  | { kind: 'markers'; shape: MarkerShape }
  | { kind: 'grids'; shape: Grid }
  | { kind: 'images'; shape: ImageShape }
  | { kind: 'lines'; shape: LineShape }
  | { kind: 'doors'; shape: DoorShape }
  | { kind: 'stairs'; shape: StairShape }
  | { kind: 'text-labels'; shape: TextLabelShape }
  | { kind: 'models'; shape: ModelShape }

/** The shape arrays the explorer works from (one facility's). */
export interface ExplorerShapes {
  polygons: readonly PolygonShape[]
  markers: readonly MarkerShape[]
  grids: readonly Grid[]
  images: readonly ImageShape[]
  lines: readonly LineShape[]
  doors: readonly DoorShape[]
  stairs: readonly StairShape[]
  textLabels: readonly TextLabelShape[]
  models: readonly ModelShape[]
}

export function parseEntityKey(key: string): { kind: ExplorerKind; id: number } | null {
  const m = /^(polygons|markers|grids|images|lines|doors|stairs|text-labels|models):(\d+)$/.exec(key)
  return m ? { kind: m[1] as ExplorerKind, id: Number(m[2]) } : null
}

export function findShape(shapes: ExplorerShapes, key: string): ExplorerShape | null {
  const ref = parseEntityKey(key)
  if (!ref) return null
  const byId = <T extends { id?: number }>(rows: readonly T[]) => rows.find((r) => r.id === ref.id)
  switch (ref.kind) {
    case 'polygons': { const s = byId(shapes.polygons); return s ? { kind: ref.kind, shape: s } : null }
    case 'markers': { const s = byId(shapes.markers); return s ? { kind: ref.kind, shape: s } : null }
    case 'grids': { const s = byId(shapes.grids); return s ? { kind: ref.kind, shape: s } : null }
    case 'images': { const s = byId(shapes.images); return s ? { kind: ref.kind, shape: s } : null }
    case 'lines': { const s = byId(shapes.lines); return s ? { kind: ref.kind, shape: s } : null }
    case 'doors': { const s = byId(shapes.doors); return s ? { kind: ref.kind, shape: s } : null }
    case 'stairs': { const s = byId(shapes.stairs); return s ? { kind: ref.kind, shape: s } : null }
    case 'text-labels': { const s = byId(shapes.textLabels); return s ? { kind: ref.kind, shape: s } : null }
    case 'models': { const s = byId(shapes.models); return s ? { kind: ref.kind, shape: s } : null }
  }
}

type LngLat = [number, number]
const M_PER_DEG = 111_320

/** Every lng/lat point that defines the shape's footprint. */
export function shapePoints(s: ExplorerShape): LngLat[] {
  switch (s.kind) {
    case 'polygons':
    case 'lines':
      return s.shape.vertices
    case 'doors':
      return s.shape.vertices
    case 'stairs':
      return stairFootprint(s.shape)
    case 'grids':
      return gridCorners(s.shape)
    case 'images':
      return imageCorners(s.shape) ?? []
    case 'markers':
    case 'text-labels':
    case 'models':
      return [s.shape.position]
  }
}

/** [west, south, east, north] or null. */
export function shapeBounds(s: ExplorerShape): [number, number, number, number] | null {
  const pts = shapePoints(s)
  if (pts.length === 0) return null
  let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    w = Math.min(w, x); e = Math.max(e, x); so = Math.min(so, y); n = Math.max(n, y)
  }
  return Number.isFinite(w) ? [w, so, e, n] : null
}

/** Rack rectangle, rotated about its start corner like the grid renderer. */
function gridCorners(g: Grid): LngLat[] {
  const [x0, y0] = g.start
  const [x1, y1] = g.current
  const rect: LngLat[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  const deg = g.config.rotation ?? 0
  if (!deg) return rect
  const rad = (deg * Math.PI) / 180
  const k = Math.cos((y0 * Math.PI) / 180)
  return rect.map(([x, y]) => {
    const dx = (x - x0) * k
    const dy = y - y0
    return [x0 + (dx * Math.cos(rad) + dy * Math.sin(rad)) / k, y0 - dx * Math.sin(rad) + dy * Math.cos(rad)]
  })
}

/** A stair run is two points (bottom → top) and a width in metres. */
function stairFootprint(s: StairShape): LngLat[] {
  const [a, b] = s.vertices
  if (!a || !b) return s.vertices
  const k = Math.cos((a[1] * Math.PI) / 180) * M_PER_DEG
  const dx = (b[0] - a[0]) * k
  const dy = (b[1] - a[1]) * M_PER_DEG
  const len = Math.hypot(dx, dy) || 1
  const half = Math.max(0.4, s.config.width ?? 1.2) / 2
  const nx = (-dy / len) * half
  const ny = (dx / len) * half
  const off = (p: LngLat, sx: number, sy: number): LngLat => [p[0] + sx / k, p[1] + sy / M_PER_DEG]
  return [off(a, nx, ny), off(b, nx, ny), off(b, -nx, -ny), off(a, -nx, -ny)]
}

/** Points in local metres, y up. */
export function toMetres(pts: readonly LngLat[]): [number, number][] {
  if (pts.length === 0) return []
  const lat0 = pts[0][1]
  const lng0 = pts[0][0]
  const k = Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG
  return pts.map(([x, y]) => [(x - lng0) * k, (y - lat0) * M_PER_DEG])
}

/**
 * Fit metre points into a w×h box (with padding), y flipped for SVG.
 * Returns the projected points and the scale used (px per metre).
 */
export function fitToBox(pts: readonly [number, number][], w: number, h: number, pad: number): { pts: [number, number][]; scale: number } {
  if (pts.length === 0) return { pts: [], scale: 1 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  const spanX = Math.max(maxX - minX, 1e-6)
  const spanY = Math.max(maxY - minY, 1e-6)
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY)
  const offX = (w - spanX * scale) / 2
  const offY = (h - spanY * scale) / 2
  return {
    pts: pts.map(([x, y]) => [offX + (x - minX) * scale, h - (offY + (y - minY) * scale)]),
    scale,
  }
}

/** Grid cell counts, mirroring grid-generators' floor(span / cell). */
export function gridCellCounts(g: Grid): { cols: number; rows: number } {
  const k = Math.cos((g.start[1] * Math.PI) / 180) * M_PER_DEG
  const w = Math.abs(g.current[0] - g.start[0]) * k
  const d = Math.abs(g.current[1] - g.start[1]) * M_PER_DEG
  const cw = g.config.xSize || 1
  const ch = g.config.ySize || 1
  return { cols: Math.max(1, Math.floor(w / cw + 1e-6)), rows: Math.max(1, Math.floor(d / ch + 1e-6)) }
}
