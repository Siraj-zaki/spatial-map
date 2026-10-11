/**
 * Lightweight SVG chart atoms.
 *
 * Used by the dashboard's analytics section. We hand-roll instead of
 * pulling in recharts because the datasets are small (≤ a few hundred
 * bins per warehouse for v1), the chart shapes are simple, and we save
 * ~150 KB of bundle. Each component is self-contained — no shared
 * scale machinery, no theming layer.
 */

import { cn } from '@/lib/utils'

// ---------------------------------------------------------------- Donut

export interface DonutSlice {
  label: string
  value: number
  color: string
}

/**
 * Single-ring donut. We render arc paths manually so the slices can
 * carry per-segment colours without recharts' scale plumbing.
 */
export function Donut({
  slices,
  size = 140,
  thickness = 22,
  className,
}: {
  slices: ReadonlyArray<DonutSlice>
  size?: number
  thickness?: number
  className?: string
}) {
  const total = slices.reduce((acc, s) => acc + s.value, 0)
  const radius = size / 2
  const inner = radius - thickness

  if (total === 0) {
    // Render a neutral ring when there's nothing to chart yet.
    return (
      <svg width={size} height={size} className={cn('flex-shrink-0', className)}>
        <circle cx={radius} cy={radius} r={radius - thickness / 2}
          fill="none" stroke="hsl(var(--muted))" strokeWidth={thickness} />
      </svg>
    )
  }

  // Pre-compute every slice's start/end angle so the render walk doesn't
  // accumulate state across iterations.
  const startAt = -Math.PI / 2 // 12 o'clock
  const angles: Array<{ start: number; end: number }> = []
  let cursor = startAt
  for (const slice of slices) {
    const sweep = (slice.value / total) * Math.PI * 2
    angles.push({ start: cursor, end: cursor + sweep })
    cursor += sweep
  }

  return (
    <svg width={size} height={size} className={cn('flex-shrink-0', className)}>
      {slices.map((slice, i) => {
        if (slice.value === 0) return null
        const { start, end } = angles[i]
        const sweep = end - start
        const x0 = radius + Math.cos(start) * radius
        const y0 = radius + Math.sin(start) * radius
        const x1 = radius + Math.cos(end) * radius
        const y1 = radius + Math.sin(end) * radius
        const xi0 = radius + Math.cos(end) * inner
        const yi0 = radius + Math.sin(end) * inner
        const xi1 = radius + Math.cos(start) * inner
        const yi1 = radius + Math.sin(start) * inner
        const largeArc = sweep > Math.PI ? 1 : 0
        const d = [
          `M ${x0} ${y0}`,
          `A ${radius} ${radius} 0 ${largeArc} 1 ${x1} ${y1}`,
          `L ${xi0} ${yi0}`,
          `A ${inner} ${inner} 0 ${largeArc} 0 ${xi1} ${yi1}`,
          'Z',
        ].join(' ')
        return <path key={i} d={d} fill={slice.color} />
      })}
      <circle cx={radius} cy={radius} r={inner} fill="hsl(var(--card))" />
    </svg>
  )
}

// ---------------------------------------------------------------- Horizontal bars

export interface HBarRow {
  label: string
  value: number
  color: string
  /** Optional caption shown after the bar (e.g. "42 (35%)"). */
  caption?: string
}

export function HorizontalBars({
  rows,
  className,
}: {
  rows: ReadonlyArray<HBarRow>
  className?: string
}) {
  const max = rows.reduce((acc, r) => Math.max(acc, r.value), 0) || 1
  return (
    <div className={cn('space-y-1.5', className)}>
      {rows.map((row, i) => {
        const pct = (row.value / max) * 100
        return (
          <div key={i} className="space-y-0.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="truncate">{row.label}</span>
              <span className="font-mono text-muted-foreground">
                {row.caption ?? row.value.toLocaleString()}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full transition-[width] duration-300 ease-out"
                style={{ width: `${pct}%`, backgroundColor: row.color }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- Pareto

export interface ParetoEntry {
  label: string
  value: number
  cumulativeShare: number
  color: string
}

/**
 * Pareto bars: vertical value bars + a cumulative-share line on top.
 * Useful for ABC charts where you want to see both the value per item
 * and how quickly the top items dominate the total.
 */
export function ParetoChart({
  entries,
  width = 320,
  height = 140,
  maxBars = 40,
  className,
}: {
  entries: ReadonlyArray<ParetoEntry>
  width?: number
  height?: number
  maxBars?: number
  className?: string
}) {
  const list = entries.slice(0, maxBars)
  if (list.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center text-[11px] text-muted-foreground border border-dashed rounded',
          className,
        )}
        style={{ width, height }}
      >
        Not enough data
      </div>
    )
  }
  const maxVal = list.reduce((acc, e) => Math.max(acc, e.value), 0) || 1
  const pad = { top: 6, right: 4, bottom: 6, left: 4 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const barW = innerW / list.length
  return (
    <svg
      width={width}
      height={height}
      className={cn('flex-shrink-0', className)}
      role="img"
      aria-label="Pareto chart"
    >
      {/* Bars */}
      {list.map((entry, i) => {
        const h = (entry.value / maxVal) * innerH
        return (
          <rect
            key={i}
            x={pad.left + i * barW + 0.5}
            y={pad.top + (innerH - h)}
            width={Math.max(0.5, barW - 1)}
            height={h}
            fill={entry.color}
            rx={1}
          />
        )
      })}
      {/* Cumulative-share line */}
      <polyline
        points={list
          .map((e, i) => {
            const x = pad.left + i * barW + barW / 2
            const y = pad.top + (1 - e.cumulativeShare) * innerH
            return `${x},${y}`
          })
          .join(' ')}
        fill="none"
        stroke="hsl(var(--foreground))"
        strokeOpacity={0.5}
        strokeWidth={1.25}
      />
      {/* 80% threshold guideline */}
      <line
        x1={pad.left}
        x2={pad.left + innerW}
        y1={pad.top + 0.2 * innerH}
        y2={pad.top + 0.2 * innerH}
        stroke="hsl(var(--foreground))"
        strokeOpacity={0.18}
        strokeDasharray="3 3"
        strokeWidth={1}
      />
    </svg>
  )
}
