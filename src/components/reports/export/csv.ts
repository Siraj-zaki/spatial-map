/**
 * CSV writer (RFC 4180) for one exported table.
 *
 * - A field is quoted when it holds the separator, a quote, CR or LF, or
 *   leading/trailing spaces; quotes inside are doubled. Lines end in CRLF.
 * - Formula guard (on by default): a text cell starting with = + - @ tab
 *   or CR is prefixed with an apostrophe, so a spreadsheet shows it rather
 *   than running it (CSV / formula injection). Real numbers — including
 *   negatives — are left alone.
 * - Optional UTF-8 byte-order mark so Excel opens Arabic / Chinese / accents
 *   correctly instead of guessing a legacy code page.
 */

import type { ExportCell, ExportTable } from './model'

export type CsvDelimiter = ',' | ';' | '\t'

export interface CsvOptions {
  delimiter: CsvDelimiter
  /** 'formatted' = what the report shows; 'raw' = stored values, ISO dates. */
  values: 'formatted' | 'raw'
  header: boolean
  bom: boolean
  guardFormulas: boolean
}

const FORMULA_START = /^[=+\-@\t\r]/

function rawText(cell: ExportCell): string {
  const v = cell.raw
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function escapeCsvField(value: string, delimiter: CsvDelimiter, isNumber = false, guard = true): string {
  let v = value
  if (guard && !isNumber && FORMULA_START.test(v)) v = `'${v}`
  const needsQuotes = v.includes(delimiter) || v.includes('"') || v.includes('\n') || v.includes('\r') || /^\s|\s$/.test(v)
  return needsQuotes ? `"${v.replace(/"/g, '""')}"` : v
}

export function tableToCsv(table: ExportTable, opts: CsvOptions): string {
  const lines: string[] = []
  const field = (s: string, isNum = false) => escapeCsvField(s, opts.delimiter, isNum, opts.guardFormulas)
  if (opts.header) lines.push(table.columns.map((c) => field(c.label)).join(opts.delimiter))
  for (const row of table.rows) {
    lines.push(
      row
        .map((cell) => {
          const isNum = typeof cell.raw === 'number' && Number.isFinite(cell.raw)
          // The guard is for text that could run as a formula; a value that
          // is a number underneath ("-1,234", "-12 %") is never prefixed.
          return field(opts.values === 'raw' ? rawText(cell) : cell.text, isNum)
        })
        .join(opts.delimiter),
    )
  }
  if (table.footer) {
    lines.push(table.footer.map((cell) => (cell ? field(opts.values === 'raw' ? rawText(cell) : cell.text, typeof cell.raw === 'number') : '')).join(opts.delimiter))
  }
  return (opts.bom ? '﻿' : '') + lines.join('\r\n') + '\r\n'
}
