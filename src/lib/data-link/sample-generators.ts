/**
 * Format converters + browser download helper for the integration
 * sample records.
 *
 * IMPORTANT: the four record formats (CSV / XLSX / JSON / GeoJSON) are
 * PURE records — no schema envelope, no companion sheet, no metadata
 * block. That means the file you download is byte-identical to what a
 * user would upload OR what a REST endpoint should return; drop it
 * into either pipeline as-is with zero editing.
 *
 * The schema doc is a SEPARATE download (`schema` format) so users can
 * grab a machine-readable reference for their pipeline docs / tests
 * without polluting the records file.
 *
 * CSV + XLSX preserve the exact column order declared in the spec's
 * `fields` list (no reliance on Object.keys iteration order). JSON
 * emits a bare array so any REST endpoint can return it verbatim.
 * GeoJSON is a standard FeatureCollection with per-record Point /
 * Polygon geometry — no vendor extension keys.
 */

import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import {
  type SampleFormat,
  type SampleRecord,
  type SampleSpec,
} from './sample-records'

const CSV_MIME = 'text/csv;charset=utf-8'
const JSON_MIME = 'application/json;charset=utf-8'
const GEOJSON_MIME = 'application/geo+json;charset=utf-8'
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface SampleFile {
  blob: Blob
  filename: string
  mime: string
}

/**
 * All formats the download menu can produce. The four record formats
 * live in `SampleFormat` inside `sample-records.ts`; `'schema'` is a
 * meta-format only surfaced by this module because it doesn't ship
 * records at all.
 */
export type SampleDownloadFormat = SampleFormat | 'schema'

// ------------------------------------------------------------- helpers

function columnsFor(spec: SampleSpec): string[] {
  return spec.fields.map((f) => f.name)
}

/** Turn nullish values into '' so CSV doesn't render them as "null". */
function csvCell(value: string | number | null | undefined): string | number {
  return value === null || value === undefined ? '' : value
}

// --------------------------------------------------------- CSV / XLSX

function toCsv(spec: SampleSpec): Blob {
  const columns = columnsFor(spec)
  const rows = spec.records.map((r) => columns.map((c) => csvCell(r[c])))
  const text = Papa.unparse({ fields: columns, data: rows })
  return new Blob([text], { type: CSV_MIME })
}

function toXlsx(spec: SampleSpec): Blob {
  const columns = columnsFor(spec)
  const rows = spec.records.map((r) => {
    const out: Record<string, string | number | null> = {}
    for (const col of columns) out[col] = r[col] ?? null
    return out
  })
  // One sheet only — the XLSX parser reads the first non-empty sheet,
  // and any second "schema" sheet would just add friction (and could
  // silently shift the ingest target if someone reorders sheets).
  const records = XLSX.utils.json_to_sheet(rows, { header: columns })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, records, 'records')
  const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return new Blob([buffer], { type: XLSX_MIME })
}

// ---------------------------------------------------------------- JSON

/**
 * Bare array. Both our JSON parser (root array auto-detected) and
 * every mainstream REST client accept this shape verbatim, so users
 * can either upload the file or serve it from `/api/data` unchanged.
 */
function toJson(spec: SampleSpec): Blob {
  const text = JSON.stringify(spec.records, null, 2) + '\n'
  return new Blob([text], { type: JSON_MIME })
}

// ------------------------------------------------------------- GeoJSON

function syntheticPolygon(
  index: number,
): [[number, number], [number, number], [number, number], [number, number], [number, number]] {
  const centerLng = 4.7602 + (index % 5) * 2.5e-4
  const centerLat = 52.3086 + Math.floor(index / 5) * 2e-4
  const dLng = 1.5e-4
  const dLat = 9e-5
  return [
    [centerLng - dLng, centerLat - dLat],
    [centerLng + dLng, centerLat - dLat],
    [centerLng + dLng, centerLat + dLat],
    [centerLng - dLng, centerLat + dLat],
    [centerLng - dLng, centerLat - dLat],
  ]
}

function propertiesFromRecord(
  record: SampleRecord,
  dropKeys: readonly string[],
): SampleRecord {
  const out: SampleRecord = {}
  for (const [k, v] of Object.entries(record)) {
    if (dropKeys.includes(k)) continue
    out[k] = v
  }
  return out
}

function toGeoJson(spec: SampleSpec): Blob {
  if (!spec.geometry) {
    throw new Error(`GeoJSON not supported for kind ${spec.kind}`)
  }
  const features = spec.records.map((r, i) => {
    const lng = typeof r.lng === 'number' ? r.lng : null
    const lat = typeof r.lat === 'number' ? r.lat : null
    let geometry: unknown
    if (spec.geometry === 'Polygon') {
      geometry = { type: 'Polygon', coordinates: [syntheticPolygon(i)] }
    } else if (lng === null || lat === null) {
      geometry = null
    } else {
      geometry = { type: 'Point', coordinates: [lng, lat] }
    }
    return {
      type: 'Feature',
      properties: propertiesFromRecord(r, ['lng', 'lat']),
      geometry,
    }
  })
  // Plain FeatureCollection — no vendor extensions.
  const featureCollection = { type: 'FeatureCollection', features }
  const text = JSON.stringify(featureCollection, null, 2) + '\n'
  return new Blob([text], { type: GEOJSON_MIME })
}

// ---------------------------------------------- schema reference doc

/**
 * Stand-alone machine-readable schema. Users can drop this into their
 * pipeline docs, generate types from it, or check it into their repo
 * as the contract for what fields their integration must produce. NOT
 * intended to be ingested by the importer.
 */
function toSchemaJson(spec: SampleSpec): Blob {
  const doc = {
    kind: spec.kind,
    description: spec.headline,
    upsertKey: 'external_code',
    fields: spec.fields.map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.required ? { required: true } : {}),
      ...(f.recommended ? { recommended: true } : {}),
      ...(f.enumValues ? { enum: [...f.enumValues] } : {}),
      description: f.description,
    })),
  }
  const text = JSON.stringify(doc, null, 2) + '\n'
  return new Blob([text], { type: JSON_MIME })
}

// -------------------------------------------------------- public API

export function generateSample(
  spec: SampleSpec,
  format: SampleDownloadFormat,
): SampleFile {
  if (format !== 'schema' && !spec.formats.includes(format)) {
    throw new Error(`format ${format} not supported for kind ${spec.kind}`)
  }
  const stem = spec.filenameStem ?? `sgv-sample-${spec.kind}`
  switch (format) {
    case 'csv':
      return { blob: toCsv(spec), filename: `${stem}.csv`, mime: CSV_MIME }
    case 'xlsx':
      return { blob: toXlsx(spec), filename: `${stem}.xlsx`, mime: XLSX_MIME }
    case 'json':
      return { blob: toJson(spec), filename: `${stem}.json`, mime: JSON_MIME }
    case 'geojson':
      return {
        blob: toGeoJson(spec),
        filename: `${stem}.geojson`,
        mime: GEOJSON_MIME,
      }
    case 'schema':
      return {
        blob: toSchemaJson(spec),
        filename: `sgv-schema-${spec.kind}.json`,
        mime: JSON_MIME,
      }
  }
}

/**
 * Trigger a browser download of the sample file. Creates an in-memory
 * object URL, clicks a hidden <a>, then revokes the URL on the next
 * task so the download has already latched.
 */
export function downloadSample(spec: SampleSpec, format: SampleDownloadFormat): void {
  const { blob, filename } = generateSample(spec, format)
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

/** Records formats to expose in the download menu. */
export function formatsFor(spec: SampleSpec): readonly SampleFormat[] {
  return spec.formats
}
