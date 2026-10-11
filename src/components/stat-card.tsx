/**
 * The one KPI card used across the app (replaces the dashboard CountTile,
 * the warehouses/tables StatCard copies and the reports StatPill).
 *
 * Label + monochrome icon on top, the value, then ONE supporting line:
 * a positive delta ("+2 in 30 days"), a hint, or a progress bar. Links
 * when `to` is set. Colour is reserved for meaning (success delta,
 * warning/danger progress) — no rainbow icon chips.
 */

import type { LucideIcon } from 'lucide-react'
import { TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Skeleton } from '@/components/ui/skeleton'
import { CountUp } from '@/components/count-up'
import { cn } from '@/lib/utils'

export interface StatCardProps {
  icon: LucideIcon
  label: string
  value: string | number
  hint?: string
  /** Positive change to celebrate, e.g. { value: 2, label: 'in 30 days' }. Hidden when 0. */
  delta?: { value: number; label: string }
  /** 0–1. Renders a bar; turns warning ≥ 0.8 and danger ≥ 0.95 when `progressTone` is 'capacity'. */
  progress?: number
  progressTone?: 'neutral' | 'capacity'
  to?: string
  loading?: boolean
  className?: string
}

export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  delta,
  progress,
  progressTone = 'neutral',
  to,
  loading,
  className,
}: StatCardProps) {
  const { i18n } = useTranslation()
  const display = typeof value === 'number' ? <CountUp value={value} /> : value
  const pct = progress === undefined ? undefined : Math.max(0, Math.min(1, progress))
  const barTone =
    progressTone === 'capacity' && pct !== undefined
      ? pct >= 0.95
        ? 'bg-danger'
        : pct >= 0.8
          ? 'bg-warning'
          : 'bg-primary'
      : 'bg-primary'

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-7 w-20" />
      ) : (
        <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{display}</p>
      )}
      {!loading && pct !== undefined && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="presentation">
          <div className={cn('h-full rounded-full transition-[width] duration-500', barTone)} style={{ width: `${pct * 100}%` }} />
        </div>
      )}
      {!loading && delta && delta.value > 0 ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <TrendingUp className="h-3 w-3 text-success" aria-hidden />
          <span className="font-medium text-success">+{delta.value.toLocaleString(i18n.language)}</span>
          {delta.label}
        </p>
      ) : (
        !loading && hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
      )}
    </>
  )

  const base = cn('block rounded-xl border bg-card p-4 text-card-foreground shadow-sm sm:p-5', className)
  if (!to) return <div className={base}>{body}</div>
  return (
    <Link
      to={to}
      className={cn(
        base,
        'sgv-lift hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {body}
    </Link>
  )
}
