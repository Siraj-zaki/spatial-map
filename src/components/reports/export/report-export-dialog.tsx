/**
 * "Export report" dialog: pick a format (PDF, Excel, CSV, JSON), the
 * widgets to include and the options for that format, then export.
 * Options are remembered per browser (`export-settings.ts`).
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Braces, FileSpreadsheet, FileText, Loader2, Printer } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast-store'
import type { ReportWidgetV2 } from '@/lib/reports/v2-types'
import { CHART_KINDS, DATA_KINDS, type ExportDocument } from './model'
import { exportDocument, loadSettings, saveSettings, type ExportFormat, type ExportSettings } from './export-settings'

const PRINTABLE_SKIP = new Set(['divider', 'map', 'sankey', 'tabs', 'accordion', 'dimensionGrid', 'facilityExplorer'])

/** Which widgets a format can carry. */
export function widgetsFor(format: ExportFormat, widgets: ReportWidgetV2[]): ReportWidgetV2[] {
  if (format === 'pdf') return widgets.filter((w) => !PRINTABLE_SKIP.has(w.kind))
  if (format === 'csv') return widgets.filter((w) => w.kind === 'table' || w.kind === 'dataTable' || w.kind === 'editableTable' || CHART_KINDS.has(w.kind) || w.kind === 'heatmap')
  if (format === 'json') return widgets.filter((w) => DATA_KINDS.has(w.kind) || w.kind === 'markdown' || w.kind === 'note' || w.kind === 'alert')
  return widgets.filter((w) => DATA_KINDS.has(w.kind))
}

function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              'min-w-0 flex-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              value === o.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 py-1">
      <span className="min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        {hint && <span className="block text-[11px] leading-snug text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  )
}

export function ReportExportDialog({
  open,
  onOpenChange,
  widgets,
  initialFormat,
  initialWidgetIds,
  buildDoc,
  accent,
  onPrint,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  widgets: ReportWidgetV2[]
  initialFormat?: ExportFormat
  initialWidgetIds?: string[]
  buildDoc: (widgetIds: string[], s: ExportSettings) => ExportDocument
  accent?: string
  /** PDF: hand the document + options to the print view. */
  onPrint: (doc: ExportDocument, s: ExportSettings) => void
}) {
  const { t } = useTranslation()
  const [format, setFormat] = useState<ExportFormat>(initialFormat ?? 'pdf')
  const [s, setS] = useState<ExportSettings>(loadSettings)
  const available = useMemo(() => widgetsFor(format, widgets), [format, widgets])
  const [picked, setPicked] = useState<Set<string> | null>(initialWidgetIds ? new Set(initialWidgetIds) : null)
  const selected = available.filter((w) => (picked ? picked.has(w.id) : true))
  const [busy, setBusy] = useState(false)
  const update = (patch: Partial<ExportSettings>) => setS((prev) => ({ ...prev, ...patch }))

  const selectedKey = selected.map((w) => w.id).join(',')
  const preview = useMemo(
    () => (open && selectedKey ? buildDoc(selectedKey.split(','), s) : null),
    [open, selectedKey, buildDoc, s],
  )
  const capped = preview?.blocks.filter((b) => b.truncated) ?? []
  const csvFiles = format === 'csv' ? (preview?.blocks.filter((b) => b.table?.columns.length).length ?? 0) : 0

  const formats: { id: ExportFormat; label: string; hint: string; icon: typeof FileText }[] = [
    { id: 'pdf', label: 'PDF', hint: t('reports.export.pdfHint', { defaultValue: 'The report as it looks — charts, colours, full tables. Print or save.' }), icon: Printer },
    { id: 'xlsx', label: t('reports.export.excel', { defaultValue: 'Excel' }), hint: t('reports.export.xlsxHint', { defaultValue: 'A sheet per table and chart, real numbers and dates, colours kept.' }), icon: FileSpreadsheet },
    { id: 'csv', label: 'CSV', hint: t('reports.export.csvHint', { defaultValue: 'Plain rows for any tool. One file per table.' }), icon: FileText },
    { id: 'json', label: 'JSON', hint: t('reports.export.jsonHint', { defaultValue: 'Structured data with column types, for developers and APIs.' }), icon: Braces },
  ]

  const run = async () => {
    if (!preview) return
    saveSettings(s)
    if (format === 'pdf') {
      onOpenChange(false)
      onPrint(preview, s)
      return
    }
    setBusy(true)
    try {
      const names = await exportDocument(preview, format, s, t, accent)
      toast.success(
        names.length === 1
          ? t('reports.export.done', { name: names[0], defaultValue: 'Exported {{name}}' })
          : t('reports.export.doneMany', { count: names.length, defaultValue: 'Exported {{count}} files' }),
      )
      onOpenChange(false)
    } catch (err) {
      toast.error(t('reports.export.failed', { defaultValue: 'Export failed' }), { description: err instanceof Error ? err.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  const rowsOption = (format === 'xlsx' || format === 'csv' || format === 'json' || format === 'pdf') && (
    <Seg
      label={t('reports.export.rows', { defaultValue: 'Rows' })}
      value={s.scope}
      onChange={(v) => update({ scope: v })}
      options={[
        { value: 'view', label: t('reports.export.scopeView', { defaultValue: 'As on screen' }) },
        { value: 'all', label: t('reports.export.scopeAll', { defaultValue: 'All loaded rows' }) },
      ]}
    />
  )
  const valuesOption = (format === 'xlsx' || format === 'csv') && (
    <Seg
      label={t('reports.export.values', { defaultValue: 'Values' })}
      value={s.values}
      onChange={(v) => update({ values: v })}
      options={[
        { value: 'formatted', label: t('reports.export.formatted', { defaultValue: 'Formatted' }) },
        { value: 'raw', label: t('reports.export.raw', { defaultValue: 'Raw' }) },
      ]}
    />
  )

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="grid max-h-[min(92dvh,860px)] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-1 border-b px-5 pb-4 pt-5 text-start">
          <DialogTitle>{t('reports.export.title', { defaultValue: 'Export report' })}</DialogTitle>
          <DialogDescription>{t('reports.export.subtitle', { defaultValue: 'Choose a format, what to include and how it should look.' })}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain px-5 py-4">
          <div role="radiogroup" aria-label={t('reports.export.format', { defaultValue: 'Format' })} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {formats.map((f) => {
              const on = format === f.id
              return (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setFormat(f.id)}
                  className={cn(
                    'flex flex-col items-start gap-1 rounded-xl border p-3 text-start transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    on ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:border-primary/40 hover:bg-accent/40',
                  )}
                >
                  <f.icon className={cn('h-5 w-5', on ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                  <span className="text-sm font-semibold">{f.label}</span>
                  <span className="text-[11px] leading-snug text-muted-foreground">{f.hint}</span>
                </button>
              )
            })}
          </div>

          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section aria-label={t('reports.export.include', { defaultValue: 'Include' })} className="min-w-0 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold">{t('reports.export.include', { defaultValue: 'Include' })}</h3>
                {available.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setPicked(selected.length === available.length ? new Set() : null)}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {selected.length === available.length ? t('reports.export.none', { defaultValue: 'Clear' }) : t('reports.export.all', { defaultValue: 'Select all' })}
                  </button>
                )}
              </div>
              {available.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  {t('reports.export.nothing', { defaultValue: 'No widget in this report can be exported in this format.' })}
                </p>
              ) : (
                <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
                  {available.map((w, i) => {
                    const on = picked ? picked.has(w.id) : true
                    return (
                      <li key={w.id}>
                        <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-accent/40">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => {
                              const next = new Set(picked ?? available.map((x) => x.id))
                              if (on) next.delete(w.id)
                              else next.add(w.id)
                              setPicked(next)
                            }}
                            className="h-3.5 w-3.5 accent-primary"
                          />
                          <span dir="auto" className="min-w-0 flex-1 truncate text-sm">
                            {w.title?.trim() || t('reports.export.untitled', { n: i + 1, defaultValue: 'Widget {{n}}' })}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">{t(`reports.export.kind.${w.kind}`, { defaultValue: w.kind })}</span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section aria-label={t('reports.export.options', { defaultValue: 'Options' })} className="min-w-0 space-y-3">
              <h3 className="text-xs font-semibold">{t('reports.export.options', { defaultValue: 'Options' })}</h3>
              {rowsOption}
              {valuesOption}

              {format === 'pdf' && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Seg label={t('reports.export.paper', { defaultValue: 'Paper' })} value={s.pdf.paper} onChange={(v) => update({ pdf: { ...s.pdf, paper: v } })} options={[{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }]} />
                    <Seg
                      label={t('reports.export.orientation', { defaultValue: 'Orientation' })}
                      value={s.pdf.orientation}
                      onChange={(v) => update({ pdf: { ...s.pdf, orientation: v } })}
                      options={[
                        { value: 'portrait', label: t('reports.export.portrait', { defaultValue: 'Portrait' }) },
                        { value: 'landscape', label: t('reports.export.landscape', { defaultValue: 'Landscape' }) },
                      ]}
                    />
                  </div>
                  <Seg
                    label={t('reports.export.colour', { defaultValue: 'Colour' })}
                    value={s.pdf.color}
                    onChange={(v) => update({ pdf: { ...s.pdf, color: v } })}
                    options={[
                      { value: 'color', label: t('reports.export.colourFull', { defaultValue: 'Colour' }) },
                      { value: 'grey', label: t('reports.export.colourGrey', { defaultValue: 'Greyscale' }) },
                    ]}
                  />
                  <Toggle checked={s.pdf.includeFilters} onChange={(v) => update({ pdf: { ...s.pdf, includeFilters: v } })} label={t('reports.export.includeFilters', { defaultValue: 'Show applied filters' })} />
                  <Toggle checked={s.pdf.includeTimestamp} onChange={(v) => update({ pdf: { ...s.pdf, includeTimestamp: v } })} label={t('reports.export.includeTimestamp', { defaultValue: 'Show when it was generated' })} />
                  <p className="text-[11px] leading-snug text-muted-foreground">{t('reports.export.pdfHow', { defaultValue: 'Your browser’s print dialog opens — choose “Save as PDF” as the destination.' })}</p>
                </>
              )}

              {format === 'xlsx' && (
                <>
                  <Seg
                    label={t('reports.export.headerColour', { defaultValue: 'Header colour' })}
                    value={s.xlsx.colors}
                    onChange={(v) => update({ xlsx: { ...s.xlsx, colors: v } })}
                    options={[
                      { value: 'accent', label: t('reports.export.accent', { defaultValue: 'Report colour' }) },
                      { value: 'neutral', label: t('reports.export.neutral', { defaultValue: 'Neutral' }) },
                      { value: 'none', label: t('reports.export.noColour', { defaultValue: 'None' }) },
                    ]}
                  />
                  <Toggle checked={s.xlsx.conditionalColors} onChange={(v) => update({ xlsx: { ...s.xlsx, conditionalColors: v } })} label={t('reports.export.conditional', { defaultValue: 'Keep conditional colours' })} hint={t('reports.export.conditionalHint', { defaultValue: 'Cells highlighted by table rules keep their colour.' })} />
                  <Toggle checked={s.xlsx.freezeHeader} onChange={(v) => update({ xlsx: { ...s.xlsx, freezeHeader: v } })} label={t('reports.export.freeze', { defaultValue: 'Freeze header row' })} />
                  <Toggle checked={s.xlsx.autoFilter} onChange={(v) => update({ xlsx: { ...s.xlsx, autoFilter: v } })} label={t('reports.export.autoFilter', { defaultValue: 'Add filter buttons' })} />
                </>
              )}

              {format === 'csv' && (
                <>
                  <Seg
                    label={t('reports.export.delimiter', { defaultValue: 'Separator' })}
                    value={s.csv.delimiter}
                    onChange={(v) => update({ csv: { ...s.csv, delimiter: v } })}
                    options={[
                      { value: ',', label: t('reports.export.comma', { defaultValue: 'Comma' }) },
                      { value: ';', label: t('reports.export.semicolon', { defaultValue: 'Semicolon' }) },
                      { value: '\t', label: t('reports.export.tab', { defaultValue: 'Tab' }) },
                    ]}
                  />
                  <Toggle checked={s.csv.header} onChange={(v) => update({ csv: { ...s.csv, header: v } })} label={t('reports.export.headerRow', { defaultValue: 'Header row' })} />
                  <Toggle checked={s.csv.bom} onChange={(v) => update({ csv: { ...s.csv, bom: v } })} label={t('reports.export.bom', { defaultValue: 'Excel-friendly encoding' })} hint={t('reports.export.bomHint', { defaultValue: 'Adds a byte-order mark so Excel reads accents, Arabic and Chinese correctly.' })} />
                  <Toggle checked={s.csv.guardFormulas} onChange={(v) => update({ csv: { ...s.csv, guardFormulas: v } })} label={t('reports.export.guard', { defaultValue: 'Protect against formulas' })} hint={t('reports.export.guardHint', { defaultValue: 'Text starting with = + - @ gets an apostrophe so spreadsheets never run it.' })} />
                </>
              )}

              {format === 'json' && (
                <>
                  <Seg
                    label={t('reports.export.rowShape', { defaultValue: 'Rows as' })}
                    value={s.json.rows}
                    onChange={(v) => update({ json: { ...s.json, rows: v } })}
                    options={[
                      { value: 'objects', label: t('reports.export.objects', { defaultValue: 'Objects' }) },
                      { value: 'arrays', label: t('reports.export.arrays', { defaultValue: 'Arrays' }) },
                    ]}
                  />
                  <Toggle checked={s.json.includeText} onChange={(v) => update({ json: { ...s.json, includeText: v } })} label={t('reports.export.includeText', { defaultValue: 'Include displayed text' })} hint={t('reports.export.includeTextHint', { defaultValue: 'Adds the formatted text next to the raw values.' })} />
                  <Toggle checked={s.json.pretty} onChange={(v) => update({ json: { ...s.json, pretty: v } })} label={t('reports.export.pretty', { defaultValue: 'Readable formatting' })} />
                </>
              )}
            </section>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3">
          <div className="me-auto min-w-0 space-y-0.5 text-xs">
            {capped.length > 0 && (
              <p className="flex items-start gap-1.5 text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('reports.export.cappedWarning', { count: capped.length, defaultValue: '{{count}} tables reached their query’s row limit — there may be more rows.' })}
              </p>
            )}
            {csvFiles > 1 && <p className="text-muted-foreground">{t('reports.export.csvMany', { count: csvFiles, defaultValue: '{{count}} CSV files will download.' })}</p>}
          </div>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button size="sm" onClick={() => void run()} disabled={busy || selected.length === 0}>
            {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
            {format === 'pdf' ? t('reports.export.print', { defaultValue: 'Open print dialog' }) : t('reports.export.download', { defaultValue: 'Download' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
