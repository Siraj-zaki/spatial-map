/**
 * Thin wrapper around PapaParse that returns the canonical ParsedFile
 * shape. Runs on the main thread; for the MVP we cap files at ~10 MB
 * (PapaParse handles larger but the field-mapping UI gets sluggish past
 * ~50k rows). If profiling shows we need it, we can swap this for a
 * Comlink-wrapped Web Worker without touching callers.
 */

import Papa from 'papaparse'
import type { ParsedFile } from './types'

const MAX_FILE_BYTES = 10 * 1024 * 1024

export class CsvParseError extends Error {}

export async function parseCsvFile(file: File): Promise<ParsedFile> {
  if (file.size > MAX_FILE_BYTES) {
    throw new CsvParseError(
      `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`,
    )
  }
  return new Promise((resolve, reject) => {
    Papa.parse<CsvRowRaw>(file, {
      header: true,
      // `dynamicTyping` would coerce "123" to 123 inside Papa, but we
      // keep everything as strings here and coerce later in the
      // resolver — gives us per-field error reporting.
      dynamicTyping: false,
      skipEmptyLines: 'greedy',
      // Trim whitespace around values; CSV exports from Excel often
      // pad columns with trailing spaces and that breaks string match.
      transform: (value) => (typeof value === 'string' ? value.trim() : value),
      complete: (results) => {
        // PapaParse's `Papa.ParseError[]` carries `{ type, code, message, row? }`.
        const errors = results.errors.map((e) => {
          const row = typeof e.row === 'number' ? ` (row ${e.row + 1})` : ''
          return `${e.message}${row}`
        })
        const columns = results.meta.fields ?? []
        const rows = (results.data as CsvRowRaw[]).map((r) => {
          const out: Record<string, string> = {}
          for (const col of columns) {
            const v = r[col]
            out[col] = v === null || v === undefined ? '' : String(v)
          }
          return out
        })
        resolve({
          columns,
          rows,
          errors,
          totalBytes: file.size,
          parsedAt: new Date(),
        })
      },
      error: (err) => reject(new CsvParseError(err.message)),
    })
  })
}

/** Internal — what PapaParse hands us before normalisation. */
type CsvRowRaw = Record<string, string | number | boolean | null>

/**
 * Heuristic field-mapping suggestion. Given the source columns, guess
 * which Bin field each one is likely targeting. The UI uses this to
 * pre-populate the mapping step so the user only confirms instead of
 * filling everything by hand.
 *
 * Returns `null` for columns it can't guess; the caller should default
 * those to `{ kind: 'ignore' }`.
 */
export function suggestFieldTarget(column: string): SuggestedTarget | null {
  const key = column.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
  // Built-in matches first — exact-ish synonyms.
  if (/^(externalcode|bincode|wmscode|locationcode|locator|barcode)$/.test(key)) {
    return { kind: 'builtin', field: 'externalCode' }
  }
  if (/^(sku|itemcode|productcode|article|partno|partnumber)$/.test(key)) {
    return { kind: 'builtin', field: 'sku' }
  }
  if (/^(capacity|qty|quantity|units|pallets|count|stock|onhand|onhandqty)$/.test(key)) {
    return { kind: 'builtin', field: 'capacity' }
  }
  if (/^(notes?|comment|remarks?|memo|description)$/.test(key)) {
    return { kind: 'builtin', field: 'notes' }
  }
  if (/^(status|state|condition)$/.test(key)) {
    return { kind: 'builtin', field: 'status' }
  }
  // Anything else with a name worth keeping → custom property.
  if (key.length > 0) {
    return { kind: 'custom', key }
  }
  return null
}

export type SuggestedTarget =
  | { kind: 'builtin'; field: 'externalCode' | 'sku' | 'capacity' | 'notes' | 'status' }
  | { kind: 'custom'; key: string }
