/**
 * PDF export through the browser's print engine ("Save as PDF").
 *
 * Renders a print-only copy of the report into <body>, laid out off-screen
 * at the paper's content width so charts measure correctly, then prints:
 * header (name, description, facility, generated time, filters), KPI cards,
 * charts (the real widgets, drawn without animation), full tables (every
 * row in the chosen scope, header repeated on each page, rows never split),
 * text widgets. Light colours are forced for paper; greyscale optional.
 * `index.css` (`html.sgv-printing-report`) hides the app while printing.
 */

import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Widget } from '@/components/reports/widgets'
import { ReportAccentContext, ReportStaticContext } from '@/components/reports/chart-widgets'
import { themeClass, CONDITION_STYLES } from '@/lib/reports/condition-styles'
import type { QueryRunResult, ReportSpec, ReportWidget } from '@/lib/reports-client'
import type { ReportSpecV2 } from '@/lib/reports/v2-types'
import type { ExportBlock, ExportDocument } from './model'

export interface PrintOptions {
  paper: 'a4' | 'letter'
  orientation: 'portrait' | 'landscape'
  color: 'color' | 'grey'
  includeFilters: boolean
  includeTimestamp: boolean
}

/** Content width in CSS px at 96 dpi, after 12 mm margins. */
function contentWidth(o: PrintOptions): number {
  const mm = o.paper === 'a4' ? (o.orientation === 'portrait' ? 210 : 297) : o.orientation === 'portrait' ? 215.9 : 279.4
  return Math.floor(((mm - 24) / 25.4) * 96)
}

const TONE_CLASS = new Map(CONDITION_STYLES.map((s) => [s.id, themeClass(s.className)]))

function TableBlock({ block }: { block: ExportBlock }) {
  const { t } = useTranslation()
  const table = block.table!
  const align = (a: string) => (a === 'end' ? 'text-end' : a === 'center' ? 'text-center' : 'text-start')
  return (
    <section className="sgv-print-block">
      <h2 className="mb-2 text-[13pt] font-semibold">{block.title}</h2>
      {table.rows.length === 0 ? (
        <p className="text-[9pt] text-muted-foreground">{t('reports.export.noRows', { defaultValue: 'No rows.' })}</p>
      ) : (
        <table className="w-full border-collapse text-[8.5pt]">
          <thead>
            <tr className="border-b-2 border-foreground/30">
              {table.columns.map((c) => (
                <th key={c.key} className={cn('px-1.5 py-1 font-semibold', align(c.align))}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={ri} className="border-b border-border">
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    dir="auto"
                    className={cn('px-1.5 py-[3px] align-top tabular-nums', align(table.columns[ci].align), cell.tone && TONE_CLASS.get(cell.tone))}
                  >
                    {cell.text}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {table.footer && (
            <tfoot>
              <tr className="border-t-2 border-foreground/30 font-semibold">
                {table.footer.map((cell, ci) => (
                  <td key={ci} className={cn('px-1.5 py-1 tabular-nums', align(table.columns[ci].align))}>{cell?.text ?? ''}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      )}
      {block.truncated && (
        <p className="mt-1 text-[8pt] text-warning">
          {t('reports.export.cappedNote', { count: block.limit ?? block.table!.rows.length, defaultValue: 'Showing the first {{count}} rows (the query’s row limit).' })}
        </p>
      )}
    </section>
  )
}

export function ReportPrintView({
  doc,
  spec,
  queryResults,
  locale,
  accent,
  options,
  onDone,
}: {
  doc: ExportDocument
  spec: ReportSpecV2
  queryResults: Record<string, QueryRunResult | undefined>
  locale: string
  accent?: string
  options: PrintOptions
  onDone: () => void
}) {
  const { t } = useTranslation()
  const width = contentWidth(options)
  const widgets = useMemo(() => new Map((spec.widgets ?? []).map((w) => [w.id, w])), [spec.widgets])

  useEffect(() => {
    const html = document.documentElement
    const wasDark = html.classList.contains('dark')
    const page = document.createElement('style')
    page.setAttribute('data-sgv-print-page', '')
    page.textContent = `@page { size: ${options.paper === 'a4' ? 'A4' : 'letter'} ${options.orientation}; margin: 12mm; }`
    let restored = false
    // Undo everything printing changed (also on unmount / StrictMode re-run).
    const restore = () => {
      if (restored) return
      restored = true
      html.classList.remove('sgv-printing-report')
      if (wasDark) {
        html.classList.remove('light')
        html.classList.add('dark')
      }
      page.remove()
      window.removeEventListener('afterprint', finish)
    }
    let done = false
    const finish = () => {
      restore()
      if (done) return
      done = true
      onDone()
    }
    // Paper is white: print with the light tokens whatever the app mode.
    if (wasDark) {
      html.classList.remove('dark')
      html.classList.add('light')
    }
    document.head.appendChild(page)
    window.addEventListener('afterprint', finish)
    // Let charts measure the print width and draw before the dialog opens.
    let fallback = 0
    const timer = window.setTimeout(() => {
      html.classList.add('sgv-printing-report')
      window.print()
      // Some browsers return from print() without firing afterprint.
      fallback = window.setTimeout(finish, 500)
    }, 900)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(fallback)
      restore()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Consecutive KPIs share one row of cards, like on screen.
  const groups: (ExportBlock | ExportBlock[])[] = []
  for (const b of doc.blocks) {
    const last = groups[groups.length - 1]
    if (b.type === 'kpi') {
      if (Array.isArray(last)) last.push(b)
      else groups.push([b])
    } else groups.push(b)
  }

  const renderWidget = (b: ExportBlock) => {
    const w = widgets.get(b.widgetId)
    if (!w) return null
    const qr = w.queryRef ? queryResults[w.queryRef] : undefined
    const result = { runId: 0, columns: qr?.columns ?? [], rows: qr?.rows ?? [], rowCount: qr?.rowCount ?? 0, msElapsed: 0, spec: {} as ReportSpec }
    return <Widget widget={w as unknown as ReportWidget} result={result} locale={locale} />
  }

  const generated = doc.report.generatedAt.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })

  return createPortal(
    <div
      className={cn('sgv-report-print bg-background text-foreground', options.color === 'grey' && 'sgv-print-grey')}
      style={{ width }}
      dir={locale.startsWith('ar') ? 'rtl' : 'ltr'}
      aria-hidden
    >
      <ReportStaticContext.Provider value>
        <ReportAccentContext.Provider value={accent}>
          <header className="mb-5 border-b-2 pb-3" style={{ borderColor: accent || undefined }}>
            <h1 className="text-[20pt] font-bold leading-tight">{doc.report.name}</h1>
            {doc.report.description && <p className="mt-1 text-[10pt] text-muted-foreground">{doc.report.description}</p>}
            {(options.includeTimestamp || doc.report.facility) && (
              <p className="mt-1.5 text-[9pt] text-muted-foreground">
                {[doc.report.facility, options.includeTimestamp ? t('reports.export.generatedAt', { when: generated, defaultValue: 'Generated {{when}}' }) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
            {options.includeFilters && doc.report.filters.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5 text-[8.5pt]">
                {doc.report.filters.map((f) => (
                  <li key={f.label} className="rounded border px-1.5 py-0.5">
                    <span className="text-muted-foreground">{f.label}:</span> {f.value}
                  </li>
                ))}
              </ul>
            )}
          </header>

          <div className="space-y-6">
            {groups.map((g, i) =>
              Array.isArray(g) ? (
                <div key={`k${i}`} className="sgv-print-block grid grid-cols-4 gap-3">
                  {g.map((b) => (
                    <div key={b.widgetId} className="rounded-lg border p-3">
                      <p className="truncate text-[8.5pt] text-muted-foreground">{b.title}</p>
                      <p className="mt-1 text-[16pt] font-bold tabular-nums">{b.kpi?.value.text || '—'}</p>
                      {b.kpi?.delta && <p className={cn('text-[8.5pt] font-medium', b.kpi.delta.startsWith('-') ? 'text-danger' : 'text-success')}>{b.kpi.delta}</p>}
                    </div>
                  ))}
                </div>
              ) : g.type === 'table' ? (
                <TableBlock key={g.widgetId} block={g} />
              ) : g.type === 'chart' ? (
                <section key={g.widgetId} className="sgv-print-block">
                  <div className="h-[300px] [&>*]:h-full">{renderWidget(g)}</div>
                </section>
              ) : g.type === 'text' ? (
                <section key={g.widgetId} className="sgv-print-block">{renderWidget(g)}</section>
              ) : g.kind === 'history' ? (
                <section key={g.widgetId} className="sgv-print-block">
                  <div className="h-[340px] [&>*]:h-full">{renderWidget(g)}</div>
                </section>
              ) : null,
            )}
          </div>
        </ReportAccentContext.Provider>
      </ReportStaticContext.Provider>
    </div>,
    document.body,
  )
}
