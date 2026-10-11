/**
 * Thin wrapper around SheetJS that returns the canonical ParsedFile
 * shape so the rest of the import pipeline (preview, target resolver,
 * commit) doesn't need to know we accept Excel files.
 *
 * Sheet handling: an XLSX workbook can contain many sheets. v1 picks
 * the first non-empty sheet and lists the others on `ParsedFile.meta`
 * so the UI can offer a sheet picker later. Passing
 * `opts.sheetName` overrides the default selection.
 *
 * Memory note: the npm-distributed `xlsx` package has a public
 * advisory (GHSA-4r6h-8v6p-xvw6) for crafted-input prototype
 * pollution. Our use case is a user uploading their own data file —
 * not third-party content — so the practical risk is low, but if the
 * audit warning becomes blocking we can swap to `exceljs` without
 * touching callers.
 */

import * as XLSX from 'xlsx'
import type { ParsedFile } from './types'

const MAX_FILE_BYTES = 10 * 1024 * 1024

export class XlsxParseError extends Error {}

export interface XlsxParseOptions {
  /** Pick a specific worksheet by name. Defaults to the first non-empty sheet. */
  sheetName?: string
}

/**
 * Parse an XLSX (or XLS) file into a ParsedFile. Values are coerced to
 * strings — the import pipeline's `buildPatch` does type coercion later
 * so we have one place to handle parse errors.
 */
export async function parseXlsxFile(
  file: File,
  opts: XlsxParseOptions = {},
): Promise<ParsedFile> {
  if (file.size > MAX_FILE_BYTES) {
    throw new XlsxParseError(
      `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`,
    )
  }
  let workbook: XLSX.WorkBook
  try {
    const buf = await file.arrayBuffer()
    workbook = XLSX.read(buf, { type: 'array' })
  } catch (err) {
    throw new XlsxParseError(
      `Could not read workbook: ${(err as Error).message}`,
    )
  }

  const sheetNames = workbook.SheetNames
  if (sheetNames.length === 0) {
    throw new XlsxParseError('Workbook has no sheets')
  }

  const pickedName = opts.sheetName ?? pickFirstNonEmptySheet(workbook) ?? sheetNames[0]
  const sheet = workbook.Sheets[pickedName]
  if (!sheet) {
    throw new XlsxParseError(`Sheet "${pickedName}" not found in workbook`)
  }

  // `sheet_to_json` with `header: 1` gives us an array-of-arrays so we
  // can treat the first row as headers ourselves (matches the CSV path's
  // `header: true` behavior). `defval: ''` ensures missing cells become
  // empty strings, not undefined, so downstream code doesn't need null
  // guards. `raw: false` returns the *formatted* cell text — that
  // matches what the user sees in Excel and what they'd write in a CSV
  // (e.g. dates render as ISO strings rather than serial numbers).
  let rawRows: unknown[][]
  try {
    rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false,
    })
  } catch (err) {
    throw new XlsxParseError(
      `Could not read sheet "${pickedName}": ${(err as Error).message}`,
    )
  }

  if (rawRows.length === 0) {
    return {
      columns: [],
      rows: [],
      errors: [`Sheet "${pickedName}" is empty`],
      totalBytes: file.size,
      parsedAt: new Date(),
      meta: { kind: 'xlsx', sheetNames, sheetName: pickedName },
    }
  }

  // First row is the header. Trim each header to match the CSV
  // pipeline's whitespace handling.
  const headerRow = rawRows[0]
  const columns = headerRow.map((c) => String(c ?? '').trim()).filter((c) => c.length > 0)

  if (columns.length === 0) {
    throw new XlsxParseError(
      `Sheet "${pickedName}" has no header row — the first row must contain column names`,
    )
  }

  const rows: Record<string, string>[] = []
  for (let r = 1; r < rawRows.length; r++) {
    const raw = rawRows[r]
    const out: Record<string, string> = {}
    let hasAnyValue = false
    for (let c = 0; c < columns.length; c++) {
      const value = raw[c]
      const cell = value === null || value === undefined ? '' : String(value).trim()
      out[columns[c]] = cell
      if (cell.length > 0) hasAnyValue = true
    }
    // Treat fully-blank rows as end-of-data — many WMS exports trail
    // hundreds of empty rows after the real data.
    if (hasAnyValue) rows.push(out)
  }

  return {
    columns,
    rows,
    errors: [],
    totalBytes: file.size,
    parsedAt: new Date(),
    meta: { kind: 'xlsx', sheetNames, sheetName: pickedName },
  }
}

/**
 * Pick the first sheet that has at least one data row. If every sheet
 * is empty we fall back to the first one so the caller gets a real
 * sheet name back instead of `undefined`.
 */
function pickFirstNonEmptySheet(workbook: XLSX.WorkBook): string | null {
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const ref = sheet['!ref']
    if (!ref) continue
    // A `!ref` like "A1:C1" means only the header row — still pickable.
    return name
  }
  return null
}
