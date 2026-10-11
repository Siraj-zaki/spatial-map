import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { ReportStaticContext } from '../chart-widgets'
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts'
import type { ReportWidget, RunReportResult } from '@/lib/reports-client'

interface ScatterBindings {
  xAxis: string
  yAxis: string
  /** Optional bubble-size column (turns the chart into a bubble chart). */
  size?: string
  /** Optional colour/grouping column. */
  color?: string
}

/**
 * XY scatter (or bubble when `size` is bound). Uses the existing
 * recharts primitive — one Cartesian plot with clickable points.
 */
export function ScatterWidget({
  widget,
  result,
}: {
  widget: ReportWidget
  result: RunReportResult
}) {
  const { t } = useTranslation()
  const still = useContext(ReportStaticContext)
  const b = (widget.bindings ?? {}) as ScatterBindings

  const xIdx = result.columns.findIndex((c) => c.name === b.xAxis)
  const yIdx = result.columns.findIndex((c) => c.name === b.yAxis)
  const sIdx = b.size ? result.columns.findIndex((c) => c.name === b.size) : -1

  if (xIdx === -1 || yIdx === -1) {
    return (
      <div className="flex h-full min-h-[10rem] items-center justify-center rounded-xl border bg-card p-4 text-center text-sm text-muted-foreground shadow-sm">
        {t('reports.widgets.scatter.missingAxes', { defaultValue: 'X or Y column not in result' })}
      </div>
    )
  }

  const data = result.rows.map((row) => ({
    x: Number(row[xIdx]),
    y: Number(row[yIdx]),
    z: sIdx >= 0 ? Number(row[sIdx]) : undefined,
  }))

  return (
    <div className="flex h-full min-h-[14rem] flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      {widget.title && <div className="truncate px-4 pt-4 text-sm font-medium">{widget.title}</div>}
      <div className="min-h-0 flex-1" dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 12, right: 16, bottom: 20, left: 12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis type="number" dataKey="x" name={b.xAxis} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis type="number" dataKey="y" name={b.yAxis} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            {sIdx >= 0 && <ZAxis type="number" dataKey="z" range={[40, 400]} name={b.size} />}
            <Tooltip
              cursor={{ strokeDasharray: '3 3', stroke: 'hsl(var(--muted-foreground))' }}
              contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
            />
            <Scatter data={data} fill="hsl(var(--primary))" isAnimationActive={!still} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
