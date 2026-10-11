/**
 * JSON export: report metadata, filters, and per widget its columns (with
 * types and formats) and rows — typed raw values, as objects keyed by
 * column or as arrays, optionally alongside the displayed text.
 */

import type { ExportCell, ExportDocument } from './model'

export interface JsonOptions {
  rows: 'objects' | 'arrays'
  /** Also include each cell's displayed text. */
  includeText: boolean
  pretty: boolean
}

function rawValue(c: ExportCell | null | undefined): unknown {
  if (!c) return null
  const v = c.raw
  if (v === undefined) return null
  if (typeof v === 'number' && !Number.isFinite(v)) return null
  return v instanceof Date ? v.toISOString() : v
}

export function documentToJson(doc: ExportDocument, opts: JsonOptions): string {
  const out = {
    report: {
      name: doc.report.name,
      description: doc.report.description || undefined,
      facility: doc.report.facility,
      generatedAt: doc.report.generatedAt.toISOString(),
      filters: doc.report.filters,
    },
    widgets: doc.blocks
      .filter((b) => b.type !== 'other')
      .map((b) => {
        const base: Record<string, unknown> = { id: b.widgetId, title: b.title, kind: b.kind }
        if (b.kpi) {
          base.value = rawValue(b.kpi.value)
          if (opts.includeText) base.text = b.kpi.value.text
          if (b.kpi.delta) base.change = b.kpi.delta
        }
        if (b.text !== undefined) base.content = b.text
        if (b.table) {
          const keys = b.table.columns.map((c) => c.key)
          base.columns = b.table.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, format: c.format }))
          base.rows = b.table.rows.map((row) =>
            opts.rows === 'arrays'
              ? row.map((c) => rawValue(c))
              : Object.fromEntries(keys.map((k, i) => [k, rawValue(row[i])])),
          )
          if (opts.includeText) {
            base.text = b.table.rows.map((row) => (opts.rows === 'arrays' ? row.map((c) => c.text) : Object.fromEntries(keys.map((k, i) => [k, row[i]?.text ?? '']))))
          }
          if (b.table.footer) base.footer = b.table.footer.map((c) => rawValue(c))
          base.rowCount = b.table.rows.length
          if (b.truncated) base.truncated = true
        }
        return base
      }),
  }
  return JSON.stringify(out, null, opts.pretty ? 2 : undefined)
}
