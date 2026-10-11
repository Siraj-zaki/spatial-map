/**
 * Comprehensive shape exporter.
 *
 * Backs the "Export shapes…" dialog on the map toolbar. Covers every
 * shape kind in the editor:
 *
 *   grid | polygon | circle | line | route | marker |
 *   image | imagePlane | model | stair | door | text
 *
 * Formats:
 *   - GeoJSON — FeatureCollection with per-feature `properties.kind`.
 *               Full geometry preserved (Point/Line/Polygon/etc).
 *   - JSON    — `{ polygons: [...], markers: [...], ... }` object
 *               envelope keyed by kind. Records are the flat form used
 *               for CSV/XLSX — geometry as JSON-string when multi-vertex.
 *   - XLSX    — one worksheet per kind (only kinds with records).
 *   - CSV     — single kind only (UI blocks multi-kind CSV).
 *
 * The record form is deliberately close to the import samples' schema
 * so users can round-trip: export a warehouse, tweak in Excel, upload
 * as an integration source with minimal editing.
 */

import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import type { Grid } from '@/lib/db'
import type {
  CircleShape,
  ImagePlaneShape,
  ImageShape,
  LineShape,
  MarkerShape,
  ModelShape,
  PolygonShape,
  RouteShape,
  StairShape,
  TextLabelShape,
} from '@/lib/shapes'
import type { DoorShape } from '@/lib/door/types'

// ------------------------------------------------------------- types

/**
 * Every shape kind the exporter can serialize. String keys match the
 * spatial store's plural table names where they differ (imagePlane vs
 * `imagePlanes`, textLabel vs `text_labels`, etc.).
 */
export type ExportableKind =
  | 'grid'
  | 'polygon'
  | 'circle'
  | 'line'
  | 'route'
  | 'marker'
  | 'image'
  | 'imagePlane'
  | 'model'
  | 'stair'
  | 'door'
  | 'text'

export const ALL_EXPORTABLE_KINDS: readonly ExportableKind[] = [
  'grid',
  'polygon',
  'circle',
  'line',
  'route',
  'marker',
  'image',
  'imagePlane',
  'model',
  'stair',
  'door',
  'text',
]

/** Sources of shapes to export — one array per kind. */
export interface ExportSource {
  grids?: readonly Grid[]
  polygons?: readonly PolygonShape[]
  circles?: readonly CircleShape[]
  lines?: readonly LineShape[]
  routes?: readonly RouteShape[]
  markers?: readonly MarkerShape[]
  images?: readonly ImageShape[]
  imagePlanes?: readonly ImagePlaneShape[]
  models?: readonly ModelShape[]
  stairs?: readonly StairShape[]
  doors?: readonly DoorShape[]
  textLabels?: readonly TextLabelShape[]
}

export type ExportFormat = 'geojson' | 'json' | 'xlsx' | 'csv'

export interface ExportScope {
  /** Which kinds to include. Empty array = nothing. */
  kinds: readonly ExportableKind[]
  /**
   * When set for a kind, only shapes whose id is in the set are
   * exported. Missing kind = export ALL shapes of that kind.
   */
  selectedIds?: Partial<Record<ExportableKind, ReadonlySet<number>>>
  /** Optional warehouse scope. When set, drops shapes with a mismatched `zoneId`. */
  zoneId?: number | null
}

export interface ExportOptions {
  format: ExportFormat
  scope: ExportScope
  /** Include every field of `config` in the output. Default true. */
  includeConfig?: boolean
  /** Include `createdAt` / `updatedAt`. Default false. */
  includeTimestamps?: boolean
  /**
   * Suggested filename stem (without extension). Falls back to a
   * generated name including scope + kind count.
   */
  filenameStem?: string
}

export interface ExportFile {
  blob: Blob
  filename: string
  mime: string
}

// ---------------------------------------------------------- constants

const GEOJSON_MIME = 'application/geo+json;charset=utf-8'
const JSON_MIME = 'application/json;charset=utf-8'
const CSV_MIME = 'text/csv;charset=utf-8'
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// ------------------------------------------------- per-kind mappers

/** Everything a mapper produces for a single shape. */
interface MappedShape {
  feature: GeoJSON.Feature
  record: Record<string, unknown>
}

/** Bbox → 5-vertex closed ring (last vertex = first). */
function bboxToRing(
  bbox: [number, number, number, number],
): [number, number][] {
  const [minLng, minLat, maxLng, maxLat] = bbox
  return [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat],
  ]
}

function closePolygonRing(vertices: readonly [number, number][]): [number, number][] {
  if (vertices.length === 0) return []
  const first = vertices[0]
  const last = vertices[vertices.length - 1]
  const closed: [number, number][] = [...vertices]
  if (first[0] !== last[0] || first[1] !== last[1]) closed.push(first)
  return closed
}

/** Base fields on every record — shared bookkeeping. */
function baseRecord(
  kind: ExportableKind,
  shape: {
    id?: number
    name: string
    zoneId?: number
    floorPlanId?: number
    visible?: boolean
    createdAt?: Date | number
    updatedAt?: Date | number
  },
  includeTimestamps: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: shape.id ?? null,
    kind,
    name: shape.name,
    zoneId: shape.zoneId ?? null,
    floorPlanId: shape.floorPlanId ?? null,
    visible: shape.visible ?? true,
  }
  if (includeTimestamps) {
    out.createdAt = toIso(shape.createdAt)
    out.updatedAt = toIso(shape.updatedAt)
  }
  return out
}

function toIso(v: Date | number | undefined): string | null {
  if (v === undefined || v === null) return null
  const d = v instanceof Date ? v : new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function mergeConfig(
  record: Record<string, unknown>,
  config: Record<string, unknown> | undefined,
  includeConfig: boolean,
): void {
  if (!includeConfig || !config) return
  for (const [k, v] of Object.entries(config)) {
    // Flatten primitives + basic types; skip functions and complex
    // structures (materials, node overrides) which would bloat the row.
    if (v === null || v === undefined) {
      record[`config.${k}`] = null
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      record[`config.${k}`] = v
    } else {
      record[`config.${k}`] = JSON.stringify(v)
    }
  }
}

// ---- grid -----------------------------------------------------------

function mapGrid(g: Grid, opts: ExportOptions): MappedShape {
  const bbox: [number, number, number, number] = [
    Math.min(g.start[0], g.current[0]),
    Math.min(g.start[1], g.current[1]),
    Math.max(g.start[0], g.current[0]),
    Math.max(g.start[1], g.current[1]),
  ]
  const record = baseRecord('grid', g, !!opts.includeTimestamps)
  record.startLng = g.start[0]
  record.startLat = g.start[1]
  record.currentLng = g.current[0]
  record.currentLat = g.current[1]
  mergeConfig(record, g.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [bboxToRing(bbox)] },
      properties: { ...record },
    },
    record,
  }
}

// ---- polygon --------------------------------------------------------

function mapPolygon(p: PolygonShape, opts: ExportOptions): MappedShape {
  const ring = closePolygonRing(p.vertices)
  const record = baseRecord('polygon', p, !!opts.includeTimestamps)
  record.rotation = p.rotation
  record.role = p.role ?? null
  record.vertexCount = p.vertices.length
  record.vertices = JSON.stringify(p.vertices)
  mergeConfig(record, p.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { ...record },
    },
    record,
  }
}

// ---- circle ---------------------------------------------------------

function mapCircle(c: CircleShape, opts: ExportOptions): MappedShape {
  const record = baseRecord('circle', c, !!opts.includeTimestamps)
  record.mode = c.mode
  record.rotation = c.rotation
  record.role = c.role ?? null
  if (c.mode === 'single') {
    record.lng = c.center?.[0] ?? null
    record.lat = c.center?.[1] ?? null
    record.radius_m = c.radius ?? null
  } else {
    record.startLng = c.start?.[0] ?? null
    record.startLat = c.start?.[1] ?? null
    record.currentLng = c.current?.[0] ?? null
    record.currentLat = c.current?.[1] ?? null
    record.cellRadius_m = c.cellRadius ?? null
    record.cellSize_m = c.cellSize ?? null
  }
  mergeConfig(record, c.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  // Geometry: point at the center for single, bbox polygon for grid.
  let geometry: GeoJSON.Geometry
  if (c.mode === 'single' && c.center) {
    geometry = { type: 'Point', coordinates: c.center }
  } else if (c.start && c.current) {
    const bbox: [number, number, number, number] = [
      Math.min(c.start[0], c.current[0]),
      Math.min(c.start[1], c.current[1]),
      Math.max(c.start[0], c.current[0]),
      Math.max(c.start[1], c.current[1]),
    ]
    geometry = { type: 'Polygon', coordinates: [bboxToRing(bbox)] }
  } else {
    geometry = { type: 'Point', coordinates: [0, 0] }
  }
  return {
    feature: { type: 'Feature', geometry, properties: { ...record } },
    record,
  }
}

// ---- line -----------------------------------------------------------

function mapLine(l: LineShape, opts: ExportOptions): MappedShape {
  const record = baseRecord('line', l, !!opts.includeTimestamps)
  record.rotation = l.rotation
  record.vertexCount = l.vertices.length
  record.vertices = JSON.stringify(l.vertices)
  mergeConfig(record, l.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: l.vertices },
      properties: { ...record },
    },
    record,
  }
}

// ---- route ----------------------------------------------------------

function mapRoute(r: RouteShape, opts: ExportOptions): MappedShape {
  const record = baseRecord('route', r, !!opts.includeTimestamps)
  record.rotation = r.rotation
  record.vertexCount = r.vertices.length
  record.vertices = JSON.stringify(r.vertices)
  mergeConfig(record, r.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: r.vertices },
      properties: { ...record },
    },
    record,
  }
}

// ---- marker ---------------------------------------------------------

function mapMarker(m: MarkerShape, opts: ExportOptions): MappedShape {
  const record = baseRecord('marker', m, !!opts.includeTimestamps)
  record.lng = m.position[0]
  record.lat = m.position[1]
  record.bearing = m.bearing
  mergeConfig(record, m.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: m.position },
      properties: { ...record },
    },
    record,
  }
}

// ---- image ----------------------------------------------------------

function mapImage(img: ImageShape, opts: ExportOptions): MappedShape {
  const bbox: [number, number, number, number] = [
    Math.min(img.start[0], img.current[0]),
    Math.min(img.start[1], img.current[1]),
    Math.max(img.start[0], img.current[0]),
    Math.max(img.start[1], img.current[1]),
  ]
  const record = baseRecord('image', img, !!opts.includeTimestamps)
  record.startLng = img.start[0]
  record.startLat = img.start[1]
  record.currentLng = img.current[0]
  record.currentLat = img.current[1]
  record.rotation = img.rotation
  record.imageUrl = img.imageUrl ?? null
  record.mimeType = img.mimeType
  record.naturalWidth = img.naturalWidth
  record.naturalHeight = img.naturalHeight
  mergeConfig(record, img.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [bboxToRing(bbox)] },
      properties: { ...record },
    },
    record,
  }
}

// ---- imagePlane -----------------------------------------------------

function mapImagePlane(p: ImagePlaneShape, opts: ExportOptions): MappedShape {
  const record = baseRecord('imagePlane', p, !!opts.includeTimestamps)
  record.lng = p.position[0]
  record.lat = p.position[1]
  record.imageUrl = p.imageUrl
  record.mimeType = p.mimeType ?? null
  record.naturalWidth = p.naturalWidth ?? null
  record.naturalHeight = p.naturalHeight ?? null
  mergeConfig(record, p.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: p.position },
      properties: { ...record },
    },
    record,
  }
}

// ---- model ----------------------------------------------------------

function mapModel(m: ModelShape, opts: ExportOptions): MappedShape {
  const record = baseRecord('model', m, !!opts.includeTimestamps)
  record.lng = m.position[0]
  record.lat = m.position[1]
  mergeConfig(record, m.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: m.position },
      properties: { ...record },
    },
    record,
  }
}

// ---- stair ----------------------------------------------------------

function mapStair(s: StairShape, opts: ExportOptions): MappedShape {
  const record = baseRecord('stair', s, !!opts.includeTimestamps)
  record.rotation = s.rotation
  record.vertexCount = s.vertices.length
  record.vertices = JSON.stringify(s.vertices)
  mergeConfig(record, s.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: s.vertices },
      properties: { ...record },
    },
    record,
  }
}

// ---- door -----------------------------------------------------------

function mapDoor(d: DoorShape, opts: ExportOptions): MappedShape {
  const record = baseRecord('door', d, !!opts.includeTimestamps)
  record.rotation = d.rotation ?? 0
  record.startLng = d.vertices[0][0]
  record.startLat = d.vertices[0][1]
  record.endLng = d.vertices[1][0]
  record.endLat = d.vertices[1][1]
  mergeConfig(record, d.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: d.vertices },
      properties: { ...record },
    },
    record,
  }
}

// ---- text label -----------------------------------------------------

function mapTextLabel(t: TextLabelShape, opts: ExportOptions): MappedShape {
  const record = baseRecord('text', t, !!opts.includeTimestamps)
  record.lng = t.position[0]
  record.lat = t.position[1]
  record.rotation = t.rotation
  mergeConfig(record, t.config as unknown as Record<string, unknown>, opts.includeConfig ?? true)
  return {
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: t.position },
      properties: { ...record },
    },
    record,
  }
}

// -------------------------------------------------------- selection

/** Filter a shape array by the selection set + zone scope. */
function scopeShapes<T extends { id?: number; zoneId?: number }>(
  shapes: readonly T[] | undefined,
  kind: ExportableKind,
  scope: ExportScope,
): T[] {
  if (!shapes || shapes.length === 0) return []
  const selected = scope.selectedIds?.[kind]
  const zoneId = scope.zoneId
  return shapes.filter((s) => {
    if (selected && s.id !== undefined && !selected.has(s.id)) return false
    if (zoneId !== undefined && zoneId !== null && s.zoneId !== zoneId) return false
    return true
  })
}

// -------------------------------------------------------- assembly

interface CollectedGroup {
  kind: ExportableKind
  records: Record<string, unknown>[]
  features: GeoJSON.Feature[]
}

/** Run every requested kind's mapper and collect grouped output. */
function collect(source: ExportSource, options: ExportOptions): CollectedGroup[] {
  const out: CollectedGroup[] = []
  const scope = options.scope

  const push = <T extends { id?: number; zoneId?: number }>(
    kind: ExportableKind,
    arr: readonly T[] | undefined,
    mapper: (s: T, opts: ExportOptions) => MappedShape,
  ) => {
    if (!scope.kinds.includes(kind)) return
    const filtered = scopeShapes(arr, kind, scope)
    if (filtered.length === 0) return
    const mapped = filtered.map((s) => mapper(s, options))
    out.push({
      kind,
      records: mapped.map((m) => m.record),
      features: mapped.map((m) => m.feature),
    })
  }

  push('grid', source.grids, mapGrid)
  push('polygon', source.polygons, mapPolygon)
  push('circle', source.circles, mapCircle)
  push('line', source.lines, mapLine)
  push('route', source.routes, mapRoute)
  push('marker', source.markers, mapMarker)
  push('image', source.images, mapImage)
  push('imagePlane', source.imagePlanes, mapImagePlane)
  push('model', source.models, mapModel)
  push('stair', source.stairs, mapStair)
  push('door', source.doors, mapDoor)
  push('text', source.textLabels, mapTextLabel)

  return out
}

/** Union of every column that appears in any record — deterministic order. */
function collectColumns(records: Record<string, unknown>[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      if (!seen.has(key)) {
        seen.add(key)
        ordered.push(key)
      }
    }
  }
  return ordered
}

function toCell(v: unknown): string | number | null {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string' || typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return JSON.stringify(v)
}

// ---- GeoJSON --------------------------------------------------------

function assembleGeoJson(groups: CollectedGroup[]): Blob {
  const features: GeoJSON.Feature[] = []
  for (const g of groups) features.push(...g.features)
  const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
  return new Blob([JSON.stringify(fc, null, 2) + '\n'], { type: GEOJSON_MIME })
}

// ---- JSON envelope --------------------------------------------------

function assembleJson(groups: CollectedGroup[]): Blob {
  const envelope: Record<string, Record<string, unknown>[]> = {}
  for (const g of groups) envelope[g.kind] = g.records
  return new Blob([JSON.stringify(envelope, null, 2) + '\n'], { type: JSON_MIME })
}

// ---- XLSX (one sheet per kind) --------------------------------------

function assembleXlsx(groups: CollectedGroup[]): Blob {
  const wb = XLSX.utils.book_new()
  for (const g of groups) {
    const cols = collectColumns(g.records)
    const rows = g.records.map((r) => {
      const out: Record<string, unknown> = {}
      for (const c of cols) out[c] = toCell(r[c])
      return out
    })
    const ws = XLSX.utils.json_to_sheet(rows, { header: cols })
    XLSX.utils.book_append_sheet(wb, ws, sheetNameFor(g.kind))
  }
  if (groups.length === 0) {
    // Empty workbook — add a placeholder sheet so xlsx doesn't error.
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['no shapes']]), 'empty')
  }
  const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return new Blob([buffer], { type: XLSX_MIME })
}

// ---- CSV (single-kind only) -----------------------------------------

function assembleCsv(groups: CollectedGroup[]): Blob {
  if (groups.length > 1) {
    throw new Error('CSV export requires exactly one kind. Use XLSX for multi-kind exports.')
  }
  const rows = groups[0]?.records ?? []
  const cols = collectColumns(rows)
  const text = Papa.unparse({
    fields: cols,
    data: rows.map((r) => cols.map((c) => toCell(r[c]))),
  })
  return new Blob([text], { type: CSV_MIME })
}

// -------------------------------------------------------- filename

function sheetNameFor(kind: ExportableKind): string {
  // Excel sheet names: max 31 chars, no [ ] : * ? / \.
  // Our kind literals are all safe already.
  return kind
}

function defaultFilenameStem(options: ExportOptions, groups: CollectedGroup[]): string {
  if (options.filenameStem) return options.filenameStem
  const total = groups.reduce((n, g) => n + g.records.length, 0)
  if (groups.length === 1) {
    return `sgv-export-${groups[0].kind}-${total}`
  }
  return `sgv-export-${total}shapes-${groups.length}kinds`
}

// ----------------------------------------------------------- public

export function countByKind(source: ExportSource, scope: ExportScope): Record<ExportableKind, number> {
  const out = {} as Record<ExportableKind, number>
  for (const k of ALL_EXPORTABLE_KINDS) out[k] = 0
  const noScope: ExportScope = { ...scope, kinds: ALL_EXPORTABLE_KINDS }
  out.grid = scopeShapes(source.grids, 'grid', noScope).length
  out.polygon = scopeShapes(source.polygons, 'polygon', noScope).length
  out.circle = scopeShapes(source.circles, 'circle', noScope).length
  out.line = scopeShapes(source.lines, 'line', noScope).length
  out.route = scopeShapes(source.routes, 'route', noScope).length
  out.marker = scopeShapes(source.markers, 'marker', noScope).length
  out.image = scopeShapes(source.images, 'image', noScope).length
  out.imagePlane = scopeShapes(source.imagePlanes, 'imagePlane', noScope).length
  out.model = scopeShapes(source.models, 'model', noScope).length
  out.stair = scopeShapes(source.stairs, 'stair', noScope).length
  out.door = scopeShapes(source.doors, 'door', noScope).length
  out.text = scopeShapes(source.textLabels, 'text', noScope).length
  return out
}

export function exportShapes(source: ExportSource, options: ExportOptions): ExportFile {
  const groups = collect(source, options)
  const stem = defaultFilenameStem(options, groups)
  switch (options.format) {
    case 'geojson':
      return { blob: assembleGeoJson(groups), filename: `${stem}.geojson`, mime: GEOJSON_MIME }
    case 'json':
      return { blob: assembleJson(groups), filename: `${stem}.json`, mime: JSON_MIME }
    case 'xlsx':
      return { blob: assembleXlsx(groups), filename: `${stem}.xlsx`, mime: XLSX_MIME }
    case 'csv':
      return { blob: assembleCsv(groups), filename: `${stem}.csv`, mime: CSV_MIME }
  }
}

/**
 * Trigger a browser download of the export. Creates an object URL,
 * clicks a hidden anchor, then revokes on the next tick.
 */
export function downloadShapes(source: ExportSource, options: ExportOptions): void {
  const { blob, filename } = exportShapes(source, options)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
