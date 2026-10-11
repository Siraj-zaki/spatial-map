/**
 * Chart widgets for the Report Viewer, on Recharts (shadcn-style themed
 * wrappers). Five kinds read the same executor result:
 *   - line / bar / area — `bindings.xAxis` is the category or time column,
 *     one series per `bindings.series[]` entry
 *   - pie / donut — `bindings.xAxis` labels, `series[0]` values
 * Missing columns render a "Column X not in result" card, never a crash.
 *
 * Colour: a single-series chart wears the report's own colour
 * (`ReportAccentContext`, the colour its gallery thumbnail already uses),
 * so the page and its card read as one thing. Several series, and pie
 * slices, use the categorical `--chart-1…7` tokens; `--chart-8` is the
 * neutral "Other" slice. `bindings.colors` overrides both.
 *
 * Reading: one themed tooltip (series names humanised, values in the
 * viewer's locale), compact axis numbers (12K), ISO dates shortened on
 * the axis, long category labels clipped. Hovering a bar or slice dims
 * the rest. Pies sort largest-first, fold the tail into "Other", show
 * blank labels as "Not set", and list value + share beside the plot
 * (below it when the card is narrow); a donut carries its total in the
 * middle. Plots grow in on first render unless reduced motion is on.
 */

import { createContext, useContext, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { humanizeColumn } from '@/lib/reports/humanize-column'
import { cn } from '@/lib/utils'
import type { ChartBindings, ReportWidget, RunColumn, RunReportResult } from '@/lib/reports-client'

/** The report's own colour (hex from the builder), for single-series charts. */
export const ReportAccentContext = createContext<string | undefined>(undefined)
/** True in the print / export view: charts draw their final frame at once. */
export const ReportStaticContext = createContext(false)

const PALETTE = [1, 2, 3, 4, 5, 6, 7].map((i) => `hsl(var(--chart-${i}))`)
const OTHER_COLOR = 'hsl(var(--chart-8))'
const MAX_SLICES = 7
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/

/** Build the { xValue, series1, series2, ... } array Recharts expects. */
function buildChartData(
  bindings: ChartBindings,
  result: RunReportResult,
): { data: Array<Record<string, unknown>>; xKey: string; missingColumns: string[] } {
  const xKey = bindings.xAxis ?? ''
  const missing: string[] = []
  const colIdx: Record<string, number> = {}
  for (const name of [xKey, ...(bindings.series ?? [])]) {
    if (!name) continue
    const i = result.columns.findIndex((c: RunColumn) => c.name === name)
    if (i === -1) missing.push(name)
    else colIdx[name] = i
  }
  const data = result.rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const [name, idx] of Object.entries(colIdx)) out[name] = row[idx]
    return out
  })
  return { data, xKey, missingColumns: missing }
}

/** Locale formatters shared by axes, tooltips and legends. */
function useFormat() {
  const { i18n } = useTranslation()
  return useMemo(() => {
    const locale = i18n.language
    const full = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
    const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
    const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
    const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
    const asNumber = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
    return {
      value: (v: unknown) => {
        const n = asNumber(v)
        return Number.isFinite(n) ? full.format(n) : v == null || v === '' ? '—' : String(v)
      },
      tick: (v: unknown) => {
        const n = asNumber(v)
        return Number.isFinite(n) ? compact.format(n) : String(v ?? '')
      },
      category: (v: unknown, max = 14) => {
        const s = String(v ?? '')
        if (ISO_DATE.test(s) && !Number.isNaN(Date.parse(s))) return day.format(Date.parse(s))
        return s.length > max ? `${s.slice(0, max - 1)}…` : s
      },
      label: (v: unknown) => {
        const s = String(v ?? '')
        if (ISO_DATE.test(s) && !Number.isNaN(Date.parse(s))) {
          return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', ...(s.length > 10 ? { timeStyle: 'short' } : {}) }).format(Date.parse(s))
        }
        return s
      },
      pct: (n: number) => pct.format(n),
      compact: (n: number) => compact.format(n),
    }
  }, [i18n.language])
}

function useChartMotion() {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const still = useContext(ReportStaticContext)
  return { isAnimationActive: !reduced && !still, animationDuration: 650, animationEasing: 'ease-out' as const }
}

/** SVG ids can't carry React's `:r1:`-style ids inside `url(#…)`. */
function useSvgId(prefix: string) {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
}

function ChartFallback({ widget, message }: { widget: ReportWidget; message: string }) {
  return (
    <div className="flex h-full min-h-[10rem] flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      {widget.title && <h3 className="truncate px-4 pt-4 text-sm font-medium">{widget.title}</h3>}
      <div className="flex flex-1 items-center justify-center px-4 py-8 text-center text-sm text-muted-foreground">{message}</div>
    </div>
  )
}

/**
 * Card + title; the plot fills whatever height the card gets (the canvas
 * cell's, or a 14rem minimum in document flow). The plot sits in an
 * absolutely-positioned box because ResponsiveContainer needs a parent
 * with a definite size, which a flex item sized only by min-height isn't.
 */
function ChartFrame({ widget, aside, children }: { widget: ReportWidget; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[14rem] flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      {(widget.title || aside) && (
        <div className="flex items-baseline gap-3 px-4 pt-4">
          {widget.title && <h3 className="min-w-0 truncate text-sm font-medium">{widget.title}</h3>}
          {aside && <div className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">{aside}</div>}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {/* Plots stay LTR in RTL locales: SVG text anchors flip under
            dir=rtl and the axis labels clip at the card edge. */}
        <div className="absolute inset-x-2 bottom-2 top-3" dir="ltr">
          {children}
        </div>
      </div>
    </div>
  )
}

interface TooltipEntry {
  dataKey?: string | number
  name?: string | number
  value?: unknown
  color?: string
  payload?: { fill?: string; share?: number }
}

/** The one tooltip every chart uses — themed, humanised, localised. */
function ChartTooltip({
  active,
  payload,
  label,
  seriesName,
  showLabel = true,
}: {
  active?: boolean
  payload?: ReadonlyArray<TooltipEntry>
  label?: unknown
  seriesName: (key: string) => string
  showLabel?: boolean
}) {
  const f = useFormat()
  if (!active || !payload?.length) return null
  return (
    <div className="min-w-[9rem] max-w-[16rem] rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      {showLabel && label !== undefined && label !== '' && <div className="mb-1.5 truncate font-medium">{f.label(label)}</div>}
      <div className="space-y-1">
        {payload.map((p, i) => (
          <div key={String(p.dataKey ?? p.name ?? i)} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: p.payload?.fill ?? p.color }} aria-hidden />
            <span className="min-w-0 truncate text-muted-foreground">{seriesName(String(showLabel ? (p.dataKey ?? p.name) : p.name))}</span>
            <span className="ms-auto ps-3 font-medium tabular-nums">
              {f.value(p.value)}
              {p.payload?.share !== undefined && <span className="ms-1.5 font-normal text-muted-foreground">{f.pct(p.payload.share)}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

const AXIS = {
  stroke: 'hsl(var(--muted-foreground))',
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const

// -------------------------------------------------------- Line / Bar / Area

function XYChart({ widget, result, variant }: { widget: ReportWidget; result: RunReportResult; variant: 'line' | 'bar' | 'area' }) {
  const { t } = useTranslation()
  const f = useFormat()
  const motion = useChartMotion()
  const accent = useContext(ReportAccentContext)
  const gid = useSvgId('g')
  const [hover, setHover] = useState<number | null>(null)
  const bindings = useMemo(() => (widget.bindings ?? {}) as ChartBindings, [widget.bindings])
  const { data, xKey, missingColumns } = useMemo(() => buildChartData(bindings, result), [bindings, result])
  const series = bindings.series ?? []
  const colors =
    bindings.colors && bindings.colors.length > 0 ? bindings.colors : series.length === 1 && accent ? [accent] : PALETTE
  const seriesName = (key: string) => bindings.seriesLabels?.[key] ?? humanizeColumn(key)

  if (!xKey || series.length === 0) {
    return (
      <ChartFallback
        widget={widget}
        message={t('reports.chartNoBindings', { defaultValue: 'Pick an X axis and at least one series column to render the chart.' })}
      />
    )
  }
  if (missingColumns.length > 0) {
    return (
      <ChartFallback
        widget={widget}
        message={t('reports.chartMissingColumns', { defaultValue: 'Column(s) not in result: {{list}}', list: missingColumns.join(', ') })}
      />
    )
  }
  if (data.length === 0) {
    return <ChartFallback widget={widget} message={t('reports.chartNoRows', { defaultValue: 'No rows to plot.' })} />
  }

  const showLegend = !bindings.hideLegend && series.length > 1
  const common = {
    data,
    margin: { top: 4, right: 8, bottom: 0, left: 0 },
    onMouseMove: (s: { activeTooltipIndex?: number | string | null }) =>
      setHover(s?.activeTooltipIndex == null ? null : Number(s.activeTooltipIndex)),
    onMouseLeave: () => setHover(null),
  }
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
      <XAxis dataKey={xKey} {...AXIS} tickMargin={8} minTickGap={16} tickFormatter={(v) => f.category(v)} />
      <YAxis {...AXIS} width={44} tickFormatter={(v) => f.tick(v)} />
      <Tooltip
        cursor={variant === 'bar' ? { fill: 'hsl(var(--muted) / 0.5)', radius: 6 } : { stroke: 'hsl(var(--border))' }}
        content={(p) => <ChartTooltip {...(p as object)} seriesName={seriesName} />}
      />
      {showLegend && (
        <Legend
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
          formatter={(value) => <span className="text-muted-foreground">{seriesName(String(value))}</span>}
        />
      )}
    </>
  )
  const gradients = (
    <defs>
      {series.map((s, i) => (
        <linearGradient key={s} id={`${gid}-${i}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors[i % colors.length]} stopOpacity={variant === 'bar' ? 1 : 0.32} />
          <stop offset="100%" stopColor={colors[i % colors.length]} stopOpacity={variant === 'bar' ? 0.72 : 0.02} />
        </linearGradient>
      ))}
    </defs>
  )

  return (
    <ChartFrame widget={widget}>
      <ResponsiveContainer width="100%" height="100%">
        {variant === 'bar' ? (
          <BarChart {...common} barCategoryGap="22%">
            {gradients}
            {axes}
            {series.map((s, i) => (
              <Bar
                key={s}
                dataKey={s}
                name={s}
                fill={`url(#${gid}-${i})`}
                stackId={bindings.stacked ? 'stack' : undefined}
                radius={bindings.stacked ? (i === series.length - 1 ? [6, 6, 0, 0] : 0) : [6, 6, 0, 0]}
                maxBarSize={44}
                {...motion}
              >
                {data.map((_, di) => (
                  <Cell
                    key={di}
                    fillOpacity={hover === null || hover === di ? 1 : 0.4}
                    style={{ transition: 'fill-opacity 160ms ease-out' }}
                  />
                ))}
              </Bar>
            ))}
          </BarChart>
        ) : variant === 'line' ? (
          <LineChart {...common}>
            {axes}
            {series.map((s, i) => (
              <Line
                key={s}
                type="monotone"
                dataKey={s}
                name={s}
                stroke={colors[i % colors.length]}
                strokeWidth={2.25}
                dot={data.length <= 24 ? { r: 3, strokeWidth: 0, fill: colors[i % colors.length] } : false}
                activeDot={{ r: 5, strokeWidth: 2, stroke: 'hsl(var(--card))' }}
                {...motion}
              />
            ))}
          </LineChart>
        ) : (
          <AreaChart {...common}>
            {gradients}
            {axes}
            {series.map((s, i) => (
              <Area
                key={s}
                type="monotone"
                dataKey={s}
                name={s}
                stroke={colors[i % colors.length]}
                strokeWidth={2}
                fill={`url(#${gid}-${i})`}
                fillOpacity={1}
                stackId={bindings.stacked ? 'stack' : undefined}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }}
                {...motion}
              />
            ))}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </ChartFrame>
  )
}

// -------------------------------------------------------- Pie / Donut

/** Width of an element, tracked — pies put the legend beside or below.
 *  A callback ref, so it still attaches when the element first appears
 *  on a later render (after a "No rows" card, say). */
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, width]
}

function PieOrDonut({ widget, result, variant }: { widget: ReportWidget; result: RunReportResult; variant: 'pie' | 'donut' }) {
  const { t } = useTranslation()
  const f = useFormat()
  const motion = useChartMotion()
  const [hover, setHover] = useState<number | null>(null)
  const [boxRef, width] = useWidth()
  const bindings = (widget.bindings ?? {}) as ChartBindings
  const labelCol = bindings.xAxis
  const valueCol = bindings.series?.[0]
  const labelIdx = result.columns.findIndex((c) => c.name === labelCol)
  const valueIdx = result.columns.findIndex((c) => c.name === valueCol)

  const slices = useMemo(() => {
    if (labelIdx === -1 || valueIdx === -1) return []
    const blank = t('reports.chartBlank', { defaultValue: 'Not set' })
    const rows = result.rows
      .map((row) => {
        const raw = row[labelIdx]
        const name = raw == null || String(raw).trim() === '' ? blank : String(raw)
        const v = row[valueIdx]
        return { name, value: typeof v === 'number' ? v : Number(v) }
      })
      .filter((d) => Number.isFinite(d.value) && d.value > 0)
      .sort((a, b) => b.value - a.value)
    const own = bindings.colors && bindings.colors.length > 0 ? bindings.colors : PALETTE
    let list = rows.map((d, i) => ({ ...d, fill: own[i % own.length] }))
    if (list.length > MAX_SLICES) {
      const head = list.slice(0, MAX_SLICES - 1)
      const rest = list.slice(MAX_SLICES - 1)
      list = [
        ...head,
        {
          name: t('reports.chartOther', { defaultValue: 'Other ({{count}})', count: rest.length }),
          value: rest.reduce((s, d) => s + d.value, 0),
          fill: OTHER_COLOR,
        },
      ]
    }
    const total = list.reduce((s, d) => s + d.value, 0)
    return list.map((d) => ({ ...d, share: total > 0 ? d.value / total : 0 }))
  }, [result.rows, labelIdx, valueIdx, bindings.colors, t])

  if (!labelCol || !valueCol) {
    return (
      <ChartFallback
        widget={widget}
        message={t('reports.chartPieNoBindings', { defaultValue: 'Pick a label column (xAxis) and a value column (series[0]).' })}
      />
    )
  }
  if (labelIdx === -1 || valueIdx === -1) {
    return (
      <ChartFallback
        widget={widget}
        message={t('reports.chartMissingColumns', {
          defaultValue: 'Column(s) not in result: {{list}}',
          list: [labelIdx === -1 ? labelCol : null, valueIdx === -1 ? valueCol : null].filter(Boolean).join(', '),
        })}
      />
    )
  }
  if (slices.length === 0) {
    return <ChartFallback widget={widget} message={t('reports.chartNoRows', { defaultValue: 'No rows to plot.' })} />
  }

  const total = slices.reduce((s, d) => s + d.value, 0)
  const wide = width >= 440
  const showLegend = !bindings.hideLegend

  return (
    <div className="flex h-full min-h-[16rem] flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-baseline gap-3 px-4 pt-4">
        {widget.title && <h3 className="min-w-0 truncate text-sm font-medium">{widget.title}</h3>}
        {variant === 'pie' && (
          <span className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {t('reports.chartTotal', { defaultValue: 'Total {{value}}', value: f.value(total) })}
          </span>
        )}
      </div>
      <div ref={boxRef} className={cn('flex min-h-0 flex-1 gap-3 p-3', wide ? 'flex-row items-center' : 'flex-col')}>
        <div className={cn('relative min-h-[9rem]', wide ? 'h-full flex-1' : 'flex-1')} dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              {/* A donut names the hovered slice in its middle; a tooltip
                  there would sit on top of it. */}
              {variant === 'pie' && <Tooltip content={(p) => <ChartTooltip {...(p as object)} showLabel={false} seriesName={(s) => s} />} />}
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius="92%"
                innerRadius={variant === 'donut' ? '64%' : 0}
                paddingAngle={variant === 'donut' ? 2 : 0}
                cornerRadius={variant === 'donut' ? 4 : 0}
                stroke="hsl(var(--card))"
                strokeWidth={variant === 'donut' ? 0 : 2}
                onMouseEnter={(_, i) => setHover(i)}
                onMouseLeave={() => setHover(null)}
                {...motion}
              >
                {slices.map((d, i) => (
                  <Cell key={d.name} fill={d.fill} fillOpacity={hover === null || hover === i ? 1 : 0.35} style={{ transition: 'fill-opacity 160ms ease-out', outline: 'none' }} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          {variant === 'donut' && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-xl font-semibold tabular-nums leading-tight">
                {hover !== null && slices[hover] ? f.compact(slices[hover].value) : f.compact(total)}
              </span>
              <span className="max-w-[7rem] truncate text-[11px] text-muted-foreground">
                {hover !== null && slices[hover] ? slices[hover].name : t('reports.chartTotalLabel', { defaultValue: 'Total' })}
              </span>
            </div>
          )}
        </div>
        {showLegend && (
          <ul
            className={cn(
              'text-xs',
              wide ? 'w-[46%] max-w-[16rem] shrink-0 space-y-1.5' : 'flex flex-wrap justify-center gap-x-3 gap-y-1',
            )}
            aria-label={widget.title}
          >
            {slices.map((d, i) => (
              <li
                key={d.name}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded px-1 transition-opacity',
                  hover !== null && hover !== i && 'opacity-50',
                )}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: d.fill }} aria-hidden />
                <span className={cn('min-w-0 truncate', wide ? 'flex-1' : 'max-w-[8rem]')} title={d.name}>
                  {d.name}
                </span>
                {wide && <span className="shrink-0 tabular-nums text-muted-foreground">{f.value(d.value)}</span>}
                <span className={cn('shrink-0 tabular-nums', wide ? 'w-12 text-end font-medium' : 'text-muted-foreground')}>{f.pct(d.share)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// -------------------------------------------------------- dispatch

/** Renders a chart widget (line/bar/area/pie/donut). Returns null for anything else. */
export function ChartWidget({ widget, result }: { widget: ReportWidget; result: RunReportResult }) {
  switch (widget.kind) {
    case 'line':
      return <XYChart widget={widget} result={result} variant="line" />
    case 'bar':
      return <XYChart widget={widget} result={result} variant="bar" />
    case 'area':
      return <XYChart widget={widget} result={result} variant="area" />
    case 'pie':
      return <PieOrDonut widget={widget} result={result} variant="pie" />
    case 'donut':
      return <PieOrDonut widget={widget} result={result} variant="donut" />
    default:
      return null
  }
}
