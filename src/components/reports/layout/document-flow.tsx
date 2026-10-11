import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { ReportSpecV2, ReportWidgetV2, WidgetKindV2 } from '@/lib/reports/v2-types'

/**
 * DocumentFlow — Evidence-style vertical layout for widgets. Reads
 * widgets in `order` (with position.y fallback for migrated grid
 * specs), then:
 *
 *   1. Groups leading KPI / BigValue widgets into one horizontal
 *      strip at top (2–4 up depending on how many exist).
 *   2. Below the strip, widgets flow single-column full-width.
 *   3. A widget with `columnSpan: 2` pairs with the next such widget
 *      into a 2-col row (or renders half-width alone if no partner).
 *
 * Everything sits inside a max-width container so long reports read
 * like a document, not a wall of pixel-perfect widgets.
 */
export function DocumentFlow({
  spec,
  renderWidget,
}: {
  spec: ReportSpecV2
  /** Cell renderer — the caller injects the runtime-store-aware
   *  widget renderer so this layout stays framework-agnostic. */
  renderWidget: (widget: ReportWidgetV2) => React.ReactNode
}) {
  const { t } = useTranslation()
  const widgets = useMemo(() => spec.widgets ?? [], [spec.widgets])

  // Sort by explicit order first, then by grid Y (so grid-migrated
  // specs still get a sensible top-to-bottom flow), then by X.
  const sorted = useMemo(() => {
    return [...widgets].sort((a, b) => {
      const oa = a.order ?? Number.POSITIVE_INFINITY
      const ob = b.order ?? Number.POSITIVE_INFINITY
      if (oa !== ob) return oa - ob
      // Document-flow widgets may have no grid position at all.
      const ay = a.position?.y ?? 0
      const by = b.position?.y ?? 0
      if (ay !== by) return ay - by
      return (a.position?.x ?? 0) - (b.position?.x ?? 0)
    })
  }, [widgets])

  // Split into leading KPI strip + body flow.
  const { strip, body } = useMemo(() => splitLeadingKpis(sorted), [sorted])

  if (widgets.length === 0) {
    return (
      <div className="text-center py-14 px-4 border-2 border-dashed rounded-xl bg-card/40">
        <p className="text-sm font-medium">
          {t('reports.viewerNoWidgetsTitle', { defaultValue: 'No widgets to render' })}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {t('reports.viewerNoWidgetsBody', {
            defaultValue: 'Add a KPI, table, or chart to this report to see data here.',
          })}
        </p>
      </div>
    )
  }

  // Each block rises in, staggered in reading order.
  let n = 0
  const rise = () => ({ className: 'sgv-rise', style: { '--sgv-i': n++ } as React.CSSProperties })

  return (
    <div className="flex flex-col gap-6 pb-8">
      {strip.length > 0 && (
        <div
          className={cn(
            'grid gap-3',
            strip.length === 1 && 'grid-cols-1',
            strip.length === 2 && 'grid-cols-2',
            strip.length === 3 && 'grid-cols-2 sm:grid-cols-3',
            strip.length >= 4 && 'grid-cols-2 lg:grid-cols-4',
          )}
        >
          {strip.map((w) => {
            const r = rise()
            return (
              <div key={w.id} className={cn('min-h-[100px]', r.className)} style={r.style}>
                {renderWidget(w)}
              </div>
            )
          })}
        </div>
      )}
      <div className="flex flex-col gap-4">
        {pairColumnSpans(body).map((row, i) => (
          // A lone half-width widget keeps its half (md+) rather than
          // stretching across the page.
          <div
            key={rowKey(row, i)}
            className={cn(row.length > 1 || row[0].columnSpan === 2 ? 'grid grid-cols-1 gap-4 md:grid-cols-2' : 'w-full')}
          >
            {row.map((w) => {
              const r = rise()
              return (
                <div key={w.id} className={cn(!COMPACT_KINDS.includes(w.kind) && 'min-h-[220px]', r.className)} style={r.style}>
                  {renderWidget(w)}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

const KPI_KINDS: readonly WidgetKindV2[] = ['kpi', 'bigValue']

/** Widgets that size to their content: text blocks, and tables (a
 *  two-row table must not reserve a chart's 220 px). */
const COMPACT_KINDS: readonly string[] = ['divider', 'markdown', 'note', 'alert', 'dataTable', 'editableTable', 'table']

/** Consecutive KPI/BigValue widgets at the start become the top strip. */
function splitLeadingKpis(sorted: ReportWidgetV2[]) {
  const strip: ReportWidgetV2[] = []
  let i = 0
  for (; i < sorted.length; i++) {
    const w = sorted[i]
    if (!(KPI_KINDS as readonly string[]).includes(w.kind)) break
    strip.push(w)
    // Cap the strip at 4 — anything past that flows into the body.
    if (strip.length >= 4) {
      i++
      break
    }
  }
  return { strip, body: sorted.slice(i) }
}

/** Pair adjacent `columnSpan:2` widgets into 2-col rows; everything
 *  else lands full-width by itself. */
function pairColumnSpans(body: ReportWidgetV2[]): ReportWidgetV2[][] {
  const rows: ReportWidgetV2[][] = []
  let i = 0
  while (i < body.length) {
    const w = body[i]
    if ((w.columnSpan ?? 0) === 2) {
      // If the next widget is also columnSpan:2, pair them.
      const next = body[i + 1]
      if (next && next.columnSpan === 2) {
        rows.push([w, next])
        i += 2
        continue
      }
      // Unpaired — render alone in a 2-col row so it still fills half.
      rows.push([w])
      i += 1
      continue
    }
    // Default: full-width solo row.
    rows.push([w])
    i += 1
  }
  return rows
}

/** Stable-ish key for a row of 1–2 widgets. */
function rowKey(row: ReportWidgetV2[], index: number): string {
  return row.map((w) => w.id).join('|') || `row-${index}`
}
