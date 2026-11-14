import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CountUp } from '@/components/count-up'
import { formatReportValue, type ReportFieldType, type ReportWidget, type RunReportResult } from '@/lib/reports-client'

/** BigValue widget bindings — extends KpiBindings with a Delta channel. */
interface BigValueBindings {
  value: string
  label?: string
  /** Column name that carries the delta (e.g. "changePct"). */
  delta?: string
  /** How to interpret the delta column: percent already formatted, or a
   *  raw number that should render with sign only. */
  deltaFormat?: 'percent' | 'number'
  /** When true, an up-arrow means good (green) and down means bad (red).
   *  Some metrics invert this — reversed=true makes down=good. */
  reversed?: boolean
  rowIndex?: number
  prefix?: string
  suffix?: string
  format?: 'number' | 'percent' | 'currency' | 'text' | 'date'
  /** Max fraction digits for a plain number (e.g. 1 for an average). */
  decimals?: number
  tone?: 'blue' | 'purple' | 'emerald' | 'amber'
}

// Saved `tone` values map onto the categorical chart tokens, so a KPI
// and the chart beside it can share a colour. Shown as a small dot by the
// label — the value itself stays in the foreground colour for contrast.
const TONES = {
  blue: 'bg-chart-1',
  emerald: 'bg-chart-2',
  purple: 'bg-chart-3',
  amber: 'bg-chart-4',
} as const

const CARD = 'flex h-full min-h-[6.5rem] flex-col justify-center rounded-xl border bg-card px-5 py-4 shadow-sm'

/**
 * Compact KPI + optional Delta indicator — the pattern Evidence's
 * BigValue popularised. Renders large value with a coloured trend
 * pill below.
 */
export function BigValueWidget({
  widget,
  result,
  locale,
}: {
  widget: ReportWidget
  result: RunReportResult
  locale: string
}) {
  const { t } = useTranslation()
  const b = (widget.bindings ?? {}) as BigValueBindings
  const tone = TONES[b.tone ?? 'blue']
  const rowIdx = b.rowIndex ?? 0
  const row = result.rows[rowIdx]

  const valueIdx = result.columns.findIndex((c) => c.name === b.value)
  if (valueIdx === -1) {
    return (
      <div className={CARD}>
        {widget.title && <p className="mb-1 truncate text-xs text-muted-foreground">{widget.title}</p>}
        <p className="text-sm text-muted-foreground">
          {t('reports.widgets.bigValue.missingColumn', {
            column: b.value,
            defaultValue: 'Column "{{column}}" not in result',
          })}
        </p>
      </div>
    )
  }
  if (!row) {
    return (
      <div className={CARD}>
        {widget.title && <p className="mb-1 truncate text-xs text-muted-foreground">{widget.title}</p>}
        <p className="text-sm text-muted-foreground">
          {t('reports.widgets.bigValue.noRows', { defaultValue: 'No data' })}
        </p>
      </div>
    )
  }

  const columnType: ReportFieldType = result.columns[valueIdx].type
  const raw = row[valueIdx]
  // One formatter for the static value and the count-up, so `decimals`
  // holds once the animation lands (it used to finish on the raw float).
  const formatNumber = (n: number) =>
    typeof b.decimals === 'number' && (!b.format || b.format === 'number')
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: b.decimals }).format(n)
      : formatReportValue(n, columnType, b.format, locale)
  const formatted = typeof raw === 'number' ? formatNumber(raw) : formatReportValue(raw, columnType, b.format, locale)
  const label = b.label
    ? String(row[result.columns.findIndex((c) => c.name === b.label)] ?? '')
    : widget.title

  // Delta rendering.
  let deltaEl: React.ReactNode = null
  if (b.delta) {
    const deltaIdx = result.columns.findIndex((c) => c.name === b.delta)
    if (deltaIdx >= 0 && row[deltaIdx] !== undefined && row[deltaIdx] !== null) {
      const rawDelta = Number(row[deltaIdx])
      if (Number.isFinite(rawDelta)) {
        const positive = rawDelta > 0
        const isGood = b.reversed ? !positive : positive
        const Icon = positive ? ArrowUp : ArrowDown
        const deltaText =
          b.deltaFormat === 'percent'
            ? `${positive ? '+' : ''}${rawDelta.toFixed(1)}%`
            : `${positive ? '+' : ''}${rawDelta.toLocaleString(locale)}`
        deltaEl = (
          <span
            className={cn(
              'mt-2 inline-flex w-fit items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium',
              isGood ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
            )}
          >
            <Icon className="w-3 h-3" />
            {deltaText}
          </span>
        )
      }
    }
  }

  return (
    <div className={CARD}>
      {label && (
        <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', tone)} aria-hidden />
          <span className="truncate">{label}</span>
        </div>
      )}
      <div className="truncate text-xl font-semibold leading-none tracking-tight tabular-nums sm:text-2xl lg:text-[28px]" title={`${b.prefix ?? ''}${formatted}${b.suffix ?? ''}`}>
        {b.prefix}
        {/* Numbers count up the first time they appear (static under
            reduced motion); integers stay whole on the way. */}
        {typeof raw === 'number' && Number.isFinite(raw) ? (
          <CountUp value={raw} format={(n) => formatNumber(Number.isInteger(raw) ? Math.round(n) : n)} />
        ) : (
          formatted
        )}
        {b.suffix}
      </div>
      {deltaEl}
    </div>
  )
}
