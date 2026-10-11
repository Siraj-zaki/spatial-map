/**
 * Export options (remembered per browser) and the one function that turns
 * an export document into a download for CSV / Excel / JSON. PDF goes
 * through `ReportPrintView`; PNG through `png.ts`.
 */

import type { TFunction } from 'i18next'
import { tableToCsv, type CsvDelimiter } from './csv'
import { documentToJson } from './json'
import { downloadBlob, safeFileName, type ExportDocument, type ExportScope } from './model'
import { documentToXlsx } from './xlsx'
import type { PrintOptions } from './print-view'

export type ExportFormat = 'pdf' | 'xlsx' | 'csv' | 'json'

export interface ExportSettings {
  scope: ExportScope
  values: 'formatted' | 'raw'
  csv: { delimiter: CsvDelimiter; bom: boolean; guardFormulas: boolean; header: boolean }
  xlsx: { colors: 'accent' | 'neutral' | 'none'; conditionalColors: boolean; freezeHeader: boolean; autoFilter: boolean }
  pdf: PrintOptions
  json: { rows: 'objects' | 'arrays'; includeText: boolean; pretty: boolean }
  png: { scale: 2 | 3; background: 'light' | 'dark' }
}

export const DEFAULT_SETTINGS: ExportSettings = {
  scope: 'view',
  values: 'formatted',
  csv: { delimiter: ',', bom: true, guardFormulas: true, header: true },
  xlsx: { colors: 'accent', conditionalColors: true, freezeHeader: true, autoFilter: true },
  pdf: { paper: 'a4', orientation: 'portrait', color: 'color', includeFilters: true, includeTimestamp: true },
  json: { rows: 'objects', includeText: false, pretty: true },
  png: { scale: 2, background: 'light' },
}

const KEY = 'sgv-report-export'

export function loadSettings(): ExportSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<ExportSettings>
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      csv: { ...DEFAULT_SETTINGS.csv, ...saved.csv },
      xlsx: { ...DEFAULT_SETTINGS.xlsx, ...saved.xlsx },
      pdf: { ...DEFAULT_SETTINGS.pdf, ...saved.pdf },
      json: { ...DEFAULT_SETTINGS.json, ...saved.json },
      png: { ...DEFAULT_SETTINGS.png, ...saved.png },
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: ExportSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // storage unavailable — options last for this visit
  }
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * Write and download CSV / Excel / JSON. Returns the file names written.
 * CSV holds one table, so several widgets become several files.
 */
export async function exportDocument(
  doc: ExportDocument,
  format: Exclude<ExportFormat, 'pdf'>,
  s: ExportSettings,
  t: TFunction,
  accent?: string,
): Promise<string[]> {
  const base = safeFileName(doc.report.name)
  if (format === 'xlsx') {
    const bytes = documentToXlsx(doc, {
      values: s.values,
      colors: s.xlsx.colors,
      conditionalColors: s.xlsx.conditionalColors,
      freezeHeader: s.xlsx.freezeHeader,
      autoFilter: s.xlsx.autoFilter,
      accent,
      labels: {
        summary: t('reports.export.sheetSummary', { defaultValue: 'Summary' }),
        generated: t('reports.export.generated', { defaultValue: 'Generated' }),
        facility: t('reports.export.facility', { defaultValue: 'Facility' }),
        filters: t('reports.export.filters', { defaultValue: 'Filters' }),
        keyFigures: t('reports.export.keyFigures', { defaultValue: 'Key figures' }),
        change: t('reports.export.change', { defaultValue: 'Change' }),
        contents: t('reports.export.contents', { defaultValue: 'Contents' }),
        sheet: t('reports.export.sheet', { defaultValue: 'Sheet' }),
        rows: t('reports.export.rowsLabel', { defaultValue: 'Rows' }),
        capped: t('reports.export.cappedShort', { defaultValue: 'Capped at the query’s row limit' }),
        description: t('reports.export.description', { defaultValue: 'Description' }),
      },
    })
    const name = `${doc.blocks.length === 1 ? safeFileName(`${doc.report.name} - ${doc.blocks[0].title}`) : base}.xlsx`
    downloadBlob(new Blob([bytes as BlobPart], { type: XLSX_MIME }), name)
    return [name]
  }
  if (format === 'json') {
    const name = `${doc.blocks.length === 1 ? safeFileName(`${doc.report.name} - ${doc.blocks[0].title}`) : base}.json`
    downloadBlob(new Blob([documentToJson(doc, s.json)], { type: 'application/json;charset=utf-8' }), name)
    return [name]
  }
  const names: string[] = []
  const tables = doc.blocks.filter((b) => b.table && b.table.columns.length)
  for (const [i, b] of tables.entries()) {
    const csv = tableToCsv(b.table!, { delimiter: s.csv.delimiter, values: s.values, header: s.csv.header, bom: s.csv.bom, guardFormulas: s.csv.guardFormulas })
    const name = `${safeFileName(`${doc.report.name} - ${b.title}`)}.csv`
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name)
    names.push(name)
    // Browsers drop rapid back-to-back downloads; space them out.
    if (i < tables.length - 1) await new Promise((r) => setTimeout(r, 350))
  }
  return names
}

/** Tab-separated text for pasting straight into a spreadsheet. */
export function tableToClipboardText(doc: ExportDocument, s: ExportSettings): string {
  const b = doc.blocks.find((x) => x.table)
  if (!b?.table) return ''
  return tableToCsv(b.table, { delimiter: '\t', values: s.values, header: true, bom: false, guardFormulas: false }).replace(/\r\n$/, '')
}
