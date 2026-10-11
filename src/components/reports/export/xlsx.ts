/**
 * Excel (.xlsx) writer for an export document.
 *
 * SheetJS Community Edition (already a dependency) can't write cell styles,
 * so this writes the OOXML parts itself and zips them with SheetJS's
 * bundled CFB/zip writer — no new library. What you get:
 *   - a "Summary" sheet: report, description, facility, generated time,
 *     filters, key figures (KPIs) and a table of contents;
 *   - one sheet per table / chart with typed cells (numbers, real dates,
 *     booleans), number formats that match the widget's format, a styled
 *     header row, conditional-formatting colours, a footer row, frozen
 *     header, autofilter and content-sized columns; right-to-left sheets
 *     for Arabic.
 * Strings are inline (never formulas), so a cell can't execute.
 *
 * Colours are a fixed print-safe palette, not theme tokens: a spreadsheet
 * is a document on white paper regardless of the app's palette or mode.
 */

import * as XLSX from 'xlsx'
import type { ExportBlock, ExportCell, ExportColumn, ExportDocument, ExportTable } from './model'

export interface XlsxOptions {
  values: 'formatted' | 'raw'
  /** Header fill: the report's colour, a neutral grey, or none. */
  colors: 'accent' | 'neutral' | 'none'
  /** Carry conditional-formatting colours into cells. */
  conditionalColors: boolean
  freezeHeader: boolean
  autoFilter: boolean
  accent?: string
  labels: XlsxLabels
}

export interface XlsxLabels {
  summary: string
  generated: string
  facility: string
  filters: string
  keyFigures: string
  change: string
  contents: string
  sheet: string
  rows: string
  capped: string
  description: string
}

// ---- XML helpers -----------------------------------------------------------

// Control characters are invalid in XML 1.0 — Excel refuses the file if any slip in.
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

export function xmlEscape(s: string): string {
  return s
    .replace(ILLEGAL_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function colName(i: number): string {
  let n = i + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Excel serial date (local wall-clock time, matching what the report shows). */
function excelSerial(v: unknown): number | null {
  if (typeof v !== 'string' && !(v instanceof Date)) return null
  if (typeof v === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
    if (dateOnly) return Date.UTC(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]) / 86400000 + 25569
  }
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return (d.getTime() - d.getTimezoneOffset() * 60000) / 86400000 + 25569
}

const MAX_CELL = 32767

/** Excel forbids : \ / ? * [ ] in sheet names, caps them at 31 chars, and reserves "History". */
export function sheetName(raw: string, taken: Set<string>): string {
  let base = raw.replace(/[:\\/?*[\]]/g, ' ').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim() || 'Sheet'
  if (base.toLowerCase() === 'history') base = `${base} (data)`
  base = base.slice(0, 31)
  let name = base
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`
    name = base.slice(0, 31 - suffix.length) + suffix
  }
  taken.add(name.toLowerCase())
  return name
}

// ---- Styles ------------------------------------------------------------------

const TONE_COLORS: Record<string, { font: string; fill?: string; bold?: boolean; strike?: boolean }> = {
  success: { font: 'FF15803D', fill: 'FFECFDF5', bold: true },
  warn: { font: 'FFB45309', fill: 'FFFFFBEB', bold: true },
  danger: { font: 'FFB91C1C', fill: 'FFFEF2F2', bold: true },
  info: { font: 'FF1D4ED8', fill: 'FFEFF6FF', bold: true },
  purple: { font: 'FF7C3AED', fill: 'FFF5F3FF', bold: true },
  muted: { font: 'FF6B7280' },
  bold: { font: 'FF111827', bold: true },
  strike: { font: 'FF6B7280', strike: true },
}

function argb(hex: string | undefined, fallback: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
  return m ? `FF${m[1].toUpperCase()}` : fallback
}

function isDark(argbColor: string): boolean {
  const r = parseInt(argbColor.slice(2, 4), 16)
  const g = parseInt(argbColor.slice(4, 6), 16)
  const b = parseInt(argbColor.slice(6, 8), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b < 150
}

interface StyleKey {
  numFmt: number
  font: string
  fill: string
  align?: 'left' | 'center' | 'right'
  border?: boolean
  wrap?: boolean
}

class StyleSheet {
  private numFmts = new Map<string, number>()
  private fonts: string[] = ['<font><sz val="11"/><color rgb="FF111827"/><name val="Calibri"/><family val="2"/></font>']
  private fontIdx = new Map<string, number>([['', 0]])
  private fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']
  private fillIdx = new Map<string, number>([['', 0]])
  private xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']
  private xfIdx = new Map<string, number>()

  numFmt(code: string): number {
    const builtIn: Record<string, number> = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '@': 49, DATE: 14, DATETIME: 22 }
    if (code in builtIn) return builtIn[code]
    let id = this.numFmts.get(code)
    if (id === undefined) {
      id = 164 + this.numFmts.size
      this.numFmts.set(code, id)
    }
    return id
  }

  font(spec: { color?: string; bold?: boolean; strike?: boolean; size?: number }): string {
    const key = JSON.stringify(spec)
    if (!this.fontIdx.has(key)) {
      this.fontIdx.set(key, this.fonts.length)
      this.fonts.push(
        `<font>${spec.bold ? '<b/>' : ''}${spec.strike ? '<strike/>' : ''}<sz val="${spec.size ?? 11}"/><color rgb="${spec.color ?? 'FF111827'}"/><name val="Calibri"/><family val="2"/></font>`,
      )
    }
    return key
  }

  fill(color: string | undefined): string {
    if (!color) return ''
    if (!this.fillIdx.has(color)) {
      this.fillIdx.set(color, this.fills.length)
      this.fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`)
    }
    return color
  }

  xf(k: StyleKey): number {
    const key = JSON.stringify(k)
    let idx = this.xfIdx.get(key)
    if (idx === undefined) {
      idx = this.xfs.length
      this.xfIdx.set(key, idx)
      const fontId = this.fontIdx.get(k.font) ?? 0
      const fillId = this.fillIdx.get(k.fill) ?? 0
      const align = k.align || k.wrap ? `<alignment${k.align ? ` horizontal="${k.align}"` : ''}${k.wrap ? ' wrapText="1" vertical="top"' : ''}/>` : ''
      this.xfs.push(
        `<xf numFmtId="${k.numFmt}" fontId="${fontId}" fillId="${fillId}" borderId="${k.border ? 1 : 0}" xfId="0"${k.numFmt ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${k.border ? ' applyBorder="1"' : ''}${align ? ' applyAlignment="1"' : ''}>${align}</xf>`,
      )
    }
    return idx
  }

  xml(): string {
    const numFmts = [...this.numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xmlEscape(code)}"/>`)
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` : '') +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    )
  }
}

// ---- Sheets ------------------------------------------------------------------

interface SheetOut {
  name: string
  xml: string
  filterRef?: string
}

function decimalsIn(values: unknown[]): number {
  let max = 0
  for (const v of values.slice(0, 1000)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || Number.isInteger(v)) continue
    const s = String(v)
    const d = s.includes('e-') ? 6 : (s.split('.')[1]?.length ?? 0)
    max = Math.max(max, Math.min(d, 6))
  }
  return max
}

function numFmtFor(col: ExportColumn, values: unknown[], styles: StyleSheet, opts: XlsxOptions): number {
  const fmt = col.format ?? (col.type === 'date' ? 'date' : col.type === 'datetime' ? 'datetime' : col.type === 'number' ? 'number' : 'text')
  if (opts.values === 'raw') return fmt === 'date' || fmt === 'datetime' ? styles.numFmt('@') : 0
  switch (fmt) {
    case 'number': {
      const d = decimalsIn(values)
      return styles.numFmt(d ? `#,##0.${'0'.repeat(Math.min(d, 4))}` : '#,##0')
    }
    case 'percent':
      return styles.numFmt('0.0%')
    case 'currency':
      return styles.numFmt('"$"#,##0.00')
    case 'date':
      return styles.numFmt('DATE')
    case 'datetime':
      return styles.numFmt('DATETIME')
    default:
      return 0
  }
}

function cellXml(ref: string, cell: ExportCell, col: ExportColumn | undefined, style: number, values: XlsxOptions['values']): string {
  const s = style ? ` s="${style}"` : ''
  const raw = cell.raw
  if (raw === null || raw === undefined || raw === '') return style ? `<c r="${ref}"${s}/>` : ''
  if (typeof raw === 'number' && Number.isFinite(raw)) return `<c r="${ref}"${s}><v>${raw}</v></c>`
  if (typeof raw === 'boolean') return `<c r="${ref}"${s} t="b"><v>${raw ? 1 : 0}</v></c>`
  const isDate = col && (col.type === 'date' || col.type === 'datetime' || col.format === 'date' || col.format === 'datetime')
  if (isDate && values === 'formatted') {
    const serial = excelSerial(raw)
    if (serial !== null) return `<c r="${ref}"${s}><v>${serial}</v></c>`
  }
  if (col?.type === 'number' && typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return `<c r="${ref}"${s}><v>${Number(raw)}</v></c>`
  }
  const text = (typeof raw === 'object' ? JSON.stringify(raw) : String(raw)).slice(0, MAX_CELL)
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`
}

function textCell(ref: string, text: string, style: number): string {
  return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text.slice(0, MAX_CELL))}</t></is></c>`
}

function sheetXml(rows: string[], widths: number[], opts: { freeze?: boolean; filterRef?: string; rtl: boolean }): string {
  const view = `<sheetViews><sheetView workbookViewId="0"${opts.rtl ? ' rightToLeft="1"' : ''}>${
    opts.freeze ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : ''
  }</sheetView></sheetViews>`
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w.toFixed(1)}" customWidth="1"/>`).join('')}</cols>` : ''
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    view +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    cols +
    `<sheetData>${rows.join('')}</sheetData>` +
    (opts.filterRef ? `<autoFilter ref="${opts.filterRef}"/>` : '') +
    '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>'
  )
}

function widthFor(texts: string[]): number {
  let max = 0
  for (const t of texts.slice(0, 500)) {
    const longestLine = t.split('\n').reduce((m, l) => Math.max(m, [...l].length), 0)
    max = Math.max(max, longestLine)
  }
  return Math.max(8, Math.min(60, max * 1.15 + 2))
}

function dataSheet(table: ExportTable, styles: StyleSheet, opts: XlsxOptions, rtl: boolean): { xml: string; filterRef?: string } {
  const headerColor = opts.colors === 'accent' ? argb(opts.accent, 'FF4F46E5') : opts.colors === 'neutral' ? 'FFF3F4F6' : undefined
  const headerFont = styles.font({ bold: true, color: headerColor && isDark(headerColor) ? 'FFFFFFFF' : 'FF111827' })
  const align = (a: ExportColumn['align']) => (a === 'end' ? 'right' : a === 'center' ? 'center' : 'left') as StyleKey['align']
  const headerStyles = table.columns.map((c) => styles.xf({ numFmt: 0, font: headerFont, fill: styles.fill(headerColor), align: align(c.align), border: true }))
  const fmts = table.columns.map((c, i) => numFmtFor(c, table.rows.map((r) => r[i]?.raw), styles, opts))
  // A whole number in a column with decimals reads "3", not "3.0".
  const intFmt = styles.numFmt('#,##0')
  const fmtFor = (ci: number, raw: unknown) => {
    const col = table.columns[ci]
    const plainNumber = opts.values === 'formatted' && (col.format ?? (col.type === 'number' ? 'number' : '')) === 'number'
    return plainNumber && typeof raw === 'number' && Number.isInteger(raw) ? intFmt : fmts[ci]
  }
  const plainFont = styles.font({})
  const rows: string[] = []
  rows.push(`<row r="1">${table.columns.map((c, i) => textCell(`${colName(i)}1`, c.label, headerStyles[i])).join('')}</row>`)
  table.rows.forEach((row, ri) => {
    const r = ri + 2
    const cells = row.map((cell, ci) => {
      const col = table.columns[ci]
      const tone = opts.conditionalColors && opts.colors !== 'none' && cell.tone ? TONE_COLORS[cell.tone] : undefined
      const font = tone ? styles.font({ color: tone.font, bold: tone.bold, strike: tone.strike }) : plainFont
      const style = styles.xf({ numFmt: fmtFor(ci, cell.raw), font, fill: styles.fill(tone?.fill), align: col.align === 'start' ? undefined : align(col.align) })
      return cellXml(`${colName(ci)}${r}`, cell, col, style, opts.values)
    })
    rows.push(`<row r="${r}">${cells.join('')}</row>`)
  })
  const lastDataRow = table.rows.length + 1
  if (table.footer) {
    const r = lastDataRow + 1
    const font = styles.font({ bold: true })
    const fill = styles.fill(opts.colors === 'none' ? undefined : 'FFF9FAFB')
    rows.push(
      `<row r="${r}">${table.footer
        .map((cell, ci) => {
          const col = table.columns[ci]
          const style = styles.xf({ numFmt: cell && typeof cell.raw === 'number' ? fmtFor(ci, cell.raw) : 0, font, fill, align: align(col.align), border: true })
          return cell ? cellXml(`${colName(ci)}${r}`, cell, col, style, opts.values) : `<c r="${colName(ci)}${r}" s="${style}"/>`
        })
        .join('')}</row>`,
    )
  }
  const widths = table.columns.map((c, i) => widthFor([c.label, ...table.rows.map((r) => r[i]?.text ?? '')]))
  const filterRef = opts.autoFilter && table.columns.length ? `A1:${colName(table.columns.length - 1)}${Math.max(lastDataRow, 2)}` : undefined
  return { xml: sheetXml(rows, widths, { freeze: opts.freezeHeader, filterRef, rtl }), filterRef }
}

function summarySheet(doc: ExportDocument, sheets: { name: string; block: ExportBlock }[], styles: StyleSheet, opts: XlsxOptions, rtl: boolean): string {
  const L = opts.labels
  const title = styles.xf({ numFmt: 0, font: styles.font({ bold: true, size: 16 }), fill: '' })
  const section = styles.xf({ numFmt: 0, font: styles.font({ bold: true, color: 'FF374151' }), fill: styles.fill(opts.colors === 'none' ? undefined : 'FFF3F4F6'), border: true })
  const label = styles.xf({ numFmt: 0, font: styles.font({ color: 'FF6B7280' }), fill: '' })
  const wrap = styles.xf({ numFmt: 0, font: styles.font({}), fill: '', wrap: true })
  const when = styles.xf({ numFmt: styles.numFmt('DATETIME'), font: styles.font({}), fill: '', align: 'left' })
  const plain = styles.xf({ numFmt: 0, font: styles.font({}), fill: '' })
  const capped = styles.xf({ numFmt: 0, font: styles.font({ color: 'FFB45309' }), fill: '' })
  const rows: string[] = []
  let r = 1
  const push = (cells: string) => rows.push(`<row r="${r}">${cells}</row>`)
  push(textCell(`A${r}`, doc.report.name, title))
  r++
  if (doc.report.description) {
    push(textCell(`A${r}`, L.description, label) + textCell(`B${r}`, doc.report.description, wrap))
    r++
  }
  push(textCell(`A${r}`, L.generated, label) + cellXml(`B${r}`, { raw: doc.report.generatedAt, text: '' }, { key: '', label: '', type: 'datetime', align: 'start' }, when, 'formatted'))
  r++
  if (doc.report.facility) {
    push(textCell(`A${r}`, L.facility, label) + textCell(`B${r}`, doc.report.facility, plain))
    r++
  }
  if (doc.report.filters.length) {
    r++
    push(textCell(`A${r}`, L.filters, section) + textCell(`B${r}`, '', section) + textCell(`C${r}`, '', section))
    r++
    for (const f of doc.report.filters) {
      push(textCell(`A${r}`, f.label, label) + textCell(`B${r}`, f.value, plain))
      r++
    }
  }
  const kpis = doc.blocks.filter((b) => b.kpi)
  if (kpis.length) {
    r++
    push(textCell(`A${r}`, L.keyFigures, section) + textCell(`B${r}`, '', section) + textCell(`C${r}`, L.change, section))
    r++
    for (const b of kpis) {
      push(textCell(`A${r}`, b.title, label) + textCell(`B${r}`, b.kpi!.value.text, plain) + (b.kpi!.delta ? textCell(`C${r}`, b.kpi!.delta, plain) : ''))
      r++
    }
  }
  if (sheets.length) {
    r++
    push(textCell(`A${r}`, L.contents, section) + textCell(`B${r}`, L.sheet, section) + textCell(`C${r}`, L.rows, section))
    r++
    for (const s of sheets) {
      push(
        textCell(`A${r}`, s.block.title, plain) +
          textCell(`B${r}`, s.name, plain) +
          `<c r="C${r}" s="${plain}"><v>${s.block.table?.rows.length ?? 0}</v></c>` +
          (s.block.truncated ? textCell(`D${r}`, L.capped, capped) : ''),
      )
      r++
    }
  }
  const longest = Math.max(28, ...sheets.map((x) => [...x.block.title].length), ...doc.report.filters.map((f) => [...f.label].length))
  return sheetXml(rows, [Math.min(60, longest * 1.1 + 2), 48, 14, 36], { rtl })
}

export function documentToXlsx(doc: ExportDocument, opts: XlsxOptions): Uint8Array {
  const styles = new StyleSheet()
  const rtl = doc.report.locale.startsWith('ar')
  const taken = new Set<string>()
  const summaryName = sheetName(opts.labels.summary, taken)
  const dataBlocks = doc.blocks.filter((b) => b.table && b.table.columns.length)
  const named = dataBlocks.map((block) => ({ name: sheetName(block.title, taken), block }))
  const sheets: SheetOut[] = named.map(({ name, block }) => {
    const out = dataSheet(block.table!, styles, opts, rtl)
    return { name, xml: out.xml, filterRef: out.filterRef }
  })
  sheets.unshift({ name: summaryName, xml: summarySheet(doc, named, styles, opts, rtl) })

  const quote = (n: string) => `'${n.replace(/'/g, "''")}'`
  const definedNames = sheets
    .map((s, i) => (s.filterRef ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlEscape(quote(s.name))}!${s.filterRef.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : ''))
    .join('')
  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '</Relationships>',
    'docProps/core.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${xmlEscape(doc.report.name)}</dc:title><dc:creator>Spatial Map</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${doc.report.generatedAt.toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>` +
      '</cp:coreProperties>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
      (definedNames ? `<definedNames>${definedNames}</definedNames>` : '') +
      '</workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
  }
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = s.xml
  })
  // Styles last: every sheet registers its formats / fonts / fills first.
  files['xl/styles.xml'] = styles.xml()

  const CFB = XLSX.CFB
  const zip = CFB.utils.cfb_new()
  const enc = new TextEncoder()
  for (const [path, content] of Object.entries(files)) CFB.utils.cfb_add(zip, `/${path}`, enc.encode(content))
  const out = CFB.write(zip, { fileType: 'zip', type: 'array' }) as ArrayLike<number>
  return out instanceof Uint8Array ? out : new Uint8Array(out)
}
