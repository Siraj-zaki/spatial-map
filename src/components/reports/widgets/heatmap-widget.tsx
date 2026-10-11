import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { ReportWidget, RunReportResult } from '@/lib/reports-client'

interface HeatmapBindings {
  /** Column carrying the row axis category. */
  xAxis: string
  /** Column carrying the column axis category. */
  yAxis: string
  /** Column carrying the numeric intensity — colour depth per cell. */
  value: string
  /** Optional formatter for cell tooltips. */
  format?: 'number' | 'percent'
}

/**
 * Grid heatmap — one coloured cell per (xAxis, yAxis) pair, intensity
 * driven by `value`. Built with CSS grid + linear interpolation
 * against the theme primary token; no external library needed.
 */
export function HeatmapWidget({
  widget,
  result,
}: {
  widget: ReportWidget
  result: RunReportResult
}) {
  const { t } = useTranslation()
  const b = (widget.bindings ?? {}) as HeatmapBindings

  const xIdx = result.columns.findIndex((c) => c.name === b.xAxis)
  const yIdx = result.columns.findIndex((c) => c.name === b.yAxis)
  const vIdx = result.columns.findIndex((c) => c.name === b.value)

  // Computed before the missing-bindings return: hooks must run on every
  // render, or the widget crashes when bindings go from invalid to valid.
  const { xs, ys, grid, min, max } = useMemo(() => {
    const xSet = new Set<string>()
    const ySet = new Set<string>()
    const cellMap = new Map<string, number>()
    let mn = Infinity
    let mx = -Infinity
    for (const row of result.rows) {
      const x = String(row[xIdx])
      const y = String(row[yIdx])
      const v = Number(row[vIdx])
      xSet.add(x)
      ySet.add(y)
      if (Number.isFinite(v)) {
        cellMap.set(`${x}|${y}`, v)
        if (v < mn) mn = v
        if (v > mx) mx = v
      }
    }
    return {
      xs: [...xSet].sort(),
      ys: [...ySet].sort(),
      grid: cellMap,
      min: mn === Infinity ? 0 : mn,
      max: mx === -Infinity ? 0 : mx,
    }
  }, [result.rows, xIdx, yIdx, vIdx])

  if (xIdx === -1 || yIdx === -1 || vIdx === -1) {
    return (
      <div className="flex h-full min-h-[10rem] items-center justify-center rounded-xl border bg-card p-4 text-center text-sm text-muted-foreground shadow-sm">
        {t('reports.widgets.heatmap.missingBindings', {
          defaultValue: 'Heatmap requires xAxis / yAxis / value columns',
        })}
      </div>
    )
  }

  const intensity = (v: number | undefined): number => {
    if (v === undefined || !Number.isFinite(v)) return 0
    if (max === min) return 0.5
    return (v - min) / (max - min)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border bg-card p-4 shadow-sm">
      {widget.title && <div className="mb-2 truncate text-sm font-medium">{widget.title}</div>}
      <div className="flex-1 min-h-0 overflow-x-auto">
        <table className="text-[10px]">
          <thead>
            <tr>
              <th></th>
              {xs.map((x) => (
                <th key={x} className="px-1 py-1 font-normal text-muted-foreground whitespace-nowrap">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ys.map((y) => (
              <tr key={y}>
                <th className="pe-2 py-1 font-normal text-muted-foreground text-right whitespace-nowrap">{y}</th>
                {xs.map((x) => {
                  const v = grid.get(`${x}|${y}`)
                  const a = intensity(v)
                  return (
                    <td key={x} className="p-0">
                      <div
                        className={cn(
                          'w-8 h-8 flex items-center justify-center rounded-sm',
                          'text-[10px] tabular-nums transition-colors',
                        )}
                        style={{
                          background: `hsl(var(--primary) / ${a * 0.85 + 0.05})`,
                          color: a > 0.5 ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
                        }}
                        title={v !== undefined ? String(v) : '—'}
                      >
                        {v !== undefined ? Math.round(v) : ''}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
