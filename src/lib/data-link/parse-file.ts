/**
 * Format-agnostic file parser. The import pipeline (preview, resolver,
 * commit) only ever sees `ParsedFile`s — this module is the seam where
 * we decide whether to call PapaParse, SheetJS, or a JSON adapter based
 * on the picked file.
 *
 * Adding a new format is two steps: write a parser that returns
 * `ParsedFile`, then add a branch here.
 */

import { parseCsvFile } from './csv-parser'
import { parseGeoJsonFile } from './geojson-parser'
import { parseJsonFile } from './json-parser'
import { parseXlsxFile } from './xlsx-parser'
import type { ParsedFile } from './types'

/** Discriminator for `ImportPlan.source.kind` — kept in sync with `ParsedFileMeta`. */
export type FileKind = 'csv' | 'xlsx' | 'json' | 'geojson'

const EXT_TO_KIND: Record<string, FileKind> = {
  csv: 'csv',
  tsv: 'csv', // PapaParse autodetects tabs; we route tsv through it.
  txt: 'csv',
  xlsx: 'xlsx',
  xls: 'xlsx',
  xlsm: 'xlsx',
  json: 'json',
  geojson: 'geojson',
}

/**
 * Best-effort guess at the file's format. Uses the extension first
 * (cheap, reliable for files the user picked themselves) and falls
 * back to the MIME type for drag-drop sources that strip extensions.
 * Returns `null` when we genuinely don't know — callers should reject.
 */
export function detectFileKind(file: File): FileKind | null {
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  if (ext in EXT_TO_KIND) return EXT_TO_KIND[ext]
  const mime = file.type
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') return 'csv'
  if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel'
  ) {
    return 'xlsx'
  }
  if (mime === 'application/json') return 'json'
  if (mime === 'application/geo+json') return 'geojson'
  return null
}

/**
 * Parse a file into the canonical row/column ParsedFile shape.
 *
 * GeoJSON has TWO valid intents (import as new shapes / join to existing
 * shapes); this dispatcher always returns the *data-join* flattening so
 * the existing CSV-style pipeline keeps working. The shape-import path
 * uses `parseGeoJsonFile` directly — the dialog branches on the user's
 * pick.
 */
export async function parseFile(file: File): Promise<ParsedFile> {
  const kind = detectFileKind(file)
  if (kind === null) {
    throw new UnsupportedFormatError(
      `Can't parse "${file.name}" — supported formats are CSV, TSV, Excel (.xlsx / .xls), JSON, and GeoJSON.`,
    )
  }
  switch (kind) {
    case 'csv':
      return parseCsvFile(file)
    case 'xlsx':
      return parseXlsxFile(file)
    case 'json':
      return parseJsonFile(file)
    case 'geojson': {
      const parsed = await parseGeoJsonFile(file)
      return parsed.asParsedFile()
    }
  }
}

export class UnsupportedFormatError extends Error {}
