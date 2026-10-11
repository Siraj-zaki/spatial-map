/**
 * GeoJSON adapter — supports the two intents users have for spatial
 * payloads:
 *
 *  1. **Shape import** — turn each Feature into a saved
 *     polygon / line / marker row. This is the typical "the warehouse
 *     gave us a CAD export of zones, drop them on the map" flow.
 *
 *  2. **Data join** — treat each Feature.properties bag as a row and
 *     bind it to an existing shape (by externalCode or shape name).
 *     This is the typical "they gave us bin codes with positions but
 *     we already have the racks drawn" flow.
 *
 * `parseGeoJsonFile()` produces a result that supports both flows
 * without re-parsing — the dialog branches on the user's pick.
 */

import type { Feature, FeatureCollection, Geometry, Position } from 'geojson'
import type { ParsedFile } from './types'

const MAX_FILE_BYTES = 10 * 1024 * 1024

export class GeoJsonParseError extends Error {}

/** What shape kind a Feature.geometry maps to in our schema. */
export type GeoJsonShapeKind = 'polygon' | 'line' | 'marker' | 'unsupported'

/** One Feature, classified and normalised. Multi-* geometries fan out
 * into multiple entries so the downstream commit can write one shape
 * per ring / part. */
export interface ProcessedGeoJsonFeature {
  /** Index of the SOURCE feature (the one in the original collection). */
  sourceIndex: number
  /** A second number to disambiguate multi-* fan-outs (`0` if single). */
  partIndex: number
  kind: GeoJsonShapeKind
  /** Best-effort name pulled from properties.name / .title / .id, falling back to "Feature N". */
  suggestedName: string
  /** Geometry payload, ready to drop into the matching Dexie row. */
  geometry:
    | { kind: 'polygon'; vertices: [number, number][] }
    | { kind: 'line'; vertices: [number, number][] }
    | { kind: 'marker'; position: [number, number] }
    | { kind: 'unsupported'; reason: string }
  /** Original feature `properties` (kept intact, never flattened here). */
  properties: Record<string, unknown>
}

export interface ParsedGeoJson {
  /** Every feature in source order, after multi-* fan-out. */
  features: ProcessedGeoJsonFeature[]
  /** Counts by kind — handy for the mode picker. */
  counts: {
    polygon: number
    line: number
    marker: number
    unsupported: number
    total: number
  }
  /** Workbook-level metadata (for parity with xlsx/json `meta`). */
  totalBytes: number
  parsedAt: Date
  /**
   * Flattened representation for the data-join flow — each feature
   * becomes one ParsedFile row where columns are the union of every
   * property key seen. Lazy because most users only need one mode.
   */
  asParsedFile(): ParsedFile
}

export async function parseGeoJsonFile(file: File): Promise<ParsedGeoJson> {
  if (file.size > MAX_FILE_BYTES) {
    throw new GeoJsonParseError(
      `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`,
    )
  }
  let text: string
  try {
    text = await file.text()
  } catch (err) {
    throw new GeoJsonParseError(`Could not read file: ${(err as Error).message}`)
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch (err) {
    throw new GeoJsonParseError(`Malformed JSON: ${(err as Error).message}`)
  }

  const sourceFeatures = extractFeatures(payload)
  if (sourceFeatures.length === 0) {
    throw new GeoJsonParseError(
      'No features found. Expected a FeatureCollection or a single Feature with valid geometry.',
    )
  }

  const features: ProcessedGeoJsonFeature[] = []
  for (let i = 0; i < sourceFeatures.length; i++) {
    const feat = sourceFeatures[i]
    const props = (feat.properties ?? {}) as Record<string, unknown>
    const baseName = pickName(props, i, feat.id)
    const partsFromGeometry = explodeGeometry(feat.geometry)
    if (partsFromGeometry.length === 0) {
      features.push({
        sourceIndex: i,
        partIndex: 0,
        kind: 'unsupported',
        suggestedName: baseName,
        geometry: { kind: 'unsupported', reason: 'Missing or empty geometry' },
        properties: props,
      })
      continue
    }
    for (let p = 0; p < partsFromGeometry.length; p++) {
      const part = partsFromGeometry[p]
      const name =
        partsFromGeometry.length > 1
          ? `${baseName} (part ${p + 1})`
          : baseName
      features.push({
        sourceIndex: i,
        partIndex: p,
        kind: part.kind,
        suggestedName: name,
        geometry: part as ProcessedGeoJsonFeature['geometry'],
        properties: props,
      })
    }
  }

  const counts = {
    polygon: features.filter((f) => f.kind === 'polygon').length,
    line: features.filter((f) => f.kind === 'line').length,
    marker: features.filter((f) => f.kind === 'marker').length,
    unsupported: features.filter((f) => f.kind === 'unsupported').length,
    total: features.length,
  }

  const result: ParsedGeoJson = {
    features,
    counts,
    totalBytes: file.size,
    parsedAt: new Date(),
    asParsedFile: () => buildParsedFileFromFeatures(features, file.size),
  }
  return result
}

// --------------------------------------------------------------- internals

/** Accept FeatureCollection, lone Feature, or a Geometry (wrapped as a feature). */
function extractFeatures(payload: unknown): Feature[] {
  if (!payload || typeof payload !== 'object') return []
  const p = payload as { type?: unknown; features?: unknown; geometry?: unknown }
  if (p.type === 'FeatureCollection' && Array.isArray((p as FeatureCollection).features)) {
    return ((p as FeatureCollection).features ?? []).filter(
      (f): f is Feature => f !== null && typeof f === 'object',
    )
  }
  if (p.type === 'Feature') {
    return [p as Feature]
  }
  // Bare geometry — synthesize a single empty-properties feature so the
  // downstream walker still works.
  if (typeof p.type === 'string' && p.geometry === undefined) {
    return [
      {
        type: 'Feature',
        properties: {},
        geometry: payload as Geometry,
      },
    ]
  }
  return []
}

/**
 * Turn a Feature.geometry into 1+ shape-typed parts. Multi-* geometries
 * fan out: a MultiPolygon with 3 polygon rings produces 3 entries; the
 * downstream commit writes 3 polygon rows. GeometryCollection unwraps.
 */
function explodeGeometry(geom: Geometry | null): ProcessedGeoJsonFeature['geometry'][] {
  if (!geom || typeof geom !== 'object') return []
  switch (geom.type) {
    case 'Point': {
      const pos = toLngLat(geom.coordinates)
      return pos ? [{ kind: 'marker', position: pos }] : []
    }
    case 'MultiPoint': {
      const positions = (geom.coordinates ?? []).map(toLngLat).filter((p): p is [number, number] => p !== null)
      return positions.map((p) => ({ kind: 'marker' as const, position: p }))
    }
    case 'LineString': {
      const verts = toLngLatList(geom.coordinates ?? [])
      if (verts.length < 2) return [{ kind: 'unsupported', reason: 'LineString needs ≥2 points' }]
      return [{ kind: 'line', vertices: verts }]
    }
    case 'MultiLineString': {
      const parts: ProcessedGeoJsonFeature['geometry'][] = []
      for (const ring of geom.coordinates ?? []) {
        const verts = toLngLatList(ring)
        if (verts.length >= 2) parts.push({ kind: 'line', vertices: verts })
      }
      return parts.length > 0 ? parts : [{ kind: 'unsupported', reason: 'MultiLineString has no valid lines' }]
    }
    case 'Polygon': {
      // GeoJSON polygons may have holes; we only persist the outer ring
      // since our polygon shape doesn't support holes. The user can
      // re-draw holes by hand if they need them.
      const outer = (geom.coordinates ?? [])[0] ?? []
      const verts = stripClosingDuplicate(toLngLatList(outer))
      if (verts.length < 3) return [{ kind: 'unsupported', reason: 'Polygon outer ring needs ≥3 points' }]
      return [{ kind: 'polygon', vertices: verts }]
    }
    case 'MultiPolygon': {
      const parts: ProcessedGeoJsonFeature['geometry'][] = []
      for (const poly of geom.coordinates ?? []) {
        const outer = poly[0] ?? []
        const verts = stripClosingDuplicate(toLngLatList(outer))
        if (verts.length >= 3) parts.push({ kind: 'polygon', vertices: verts })
      }
      return parts.length > 0 ? parts : [{ kind: 'unsupported', reason: 'MultiPolygon has no valid rings' }]
    }
    case 'GeometryCollection': {
      const parts: ProcessedGeoJsonFeature['geometry'][] = []
      for (const sub of geom.geometries ?? []) parts.push(...explodeGeometry(sub))
      return parts.length > 0 ? parts : [{ kind: 'unsupported', reason: 'Empty GeometryCollection' }]
    }
    default:
      return [{ kind: 'unsupported', reason: `Unsupported geometry type "${(geom as { type: string }).type}"` }]
  }
}

function toLngLat(pos: Position | undefined): [number, number] | null {
  if (!Array.isArray(pos) || pos.length < 2) return null
  const lng = Number(pos[0])
  const lat = Number(pos[1])
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return [lng, lat]
}

function toLngLatList(coords: Position[] | undefined): [number, number][] {
  if (!Array.isArray(coords)) return []
  return coords.map(toLngLat).filter((p): p is [number, number] => p !== null)
}

/**
 * GeoJSON polygons end with a copy of the first vertex to close the
 * ring. Our PolygonShape doesn't store the duplicate (the renderer
 * closes the path), so strip it if it's there.
 */
function stripClosingDuplicate(verts: [number, number][]): [number, number][] {
  if (verts.length < 2) return verts
  const first = verts[0]
  const last = verts[verts.length - 1]
  if (first[0] === last[0] && first[1] === last[1]) return verts.slice(0, -1)
  return verts
}

const NAME_KEYS = ['name', 'Name', 'NAME', 'title', 'Title', 'label', 'Label']

function pickName(
  props: Record<string, unknown>,
  index: number,
  id: string | number | undefined,
): string {
  for (const k of NAME_KEYS) {
    const v = props[k]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  if (typeof id === 'string' && id.trim().length > 0) return id.trim()
  if (typeof id === 'number') return `Feature ${id}`
  return `Feature ${index + 1}`
}

/**
 * Flatten every feature's properties bag into a `ParsedFile` so the
 * data-join flow can reuse the CSV-style preview/match pipeline.
 * Nested objects → JSON-stringified (same convention as `json-parser`).
 */
function buildParsedFileFromFeatures(
  features: ProcessedGeoJsonFeature[],
  totalBytes: number,
): ParsedFile {
  const seen = new Set<string>()
  const columns: string[] = []
  const stringified = features.map((f) => {
    const flat: Record<string, string> = {}
    for (const [k, v] of Object.entries(f.properties)) {
      flat[k] = stringifyValue(v)
      if (!seen.has(k)) {
        seen.add(k)
        columns.push(k)
      }
    }
    return flat
  })
  const rows = stringified.map((r) => {
    const dense: Record<string, string> = {}
    for (const col of columns) dense[col] = r[col] ?? ''
    return dense
  })
  return {
    columns,
    rows,
    errors: [],
    totalBytes,
    parsedAt: new Date(),
    meta: { kind: 'geojson' },
  }
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  const t = typeof v
  if (t === 'string') return (v as string).trim()
  if (t === 'number' || t === 'boolean') return String(v)
  return JSON.stringify(v)
}
