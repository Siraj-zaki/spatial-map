/**
 * How a report is recognised wherever it appears — the gallery card, the
 * list row and the viewer header all use these, so a report looks like
 * the same thing everywhere:
 *   - `ReportIcon`   the report's own icon + colour (set in the builder),
 *                    falling back to its class icon.
 *   - `CLASS_META`   label + icon per `classifyReport` class.
 *   - `useStarred` / `StarButton`  per-workspace stars, kept in
 *                    `localStorage['sgv-starred-reports:<tenantId>']`.
 */

import { createElement, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, History, LayoutDashboard, Map as MapIcon, Star, Table2 } from 'lucide-react'
import { iconComponentForId } from '@/lib/lucide-icons'
import { cn } from '@/lib/utils'
import type { Report, ReportClass } from '@/lib/reports-client'

export const CLASS_META: Record<ReportClass, { labelKey: string; fallback: string; icon: typeof Table2 }> = {
  summary: { labelKey: 'reports.classSummary', fallback: 'Summary', icon: BarChart3 },
  detail: { labelKey: 'reports.classDetail', fallback: 'Detail', icon: Table2 },
  map: { labelKey: 'reports.classMap', fallback: 'Map', icon: MapIcon },
  history: { labelKey: 'reports.classHistory', fallback: 'History', icon: History },
  // A report that mixes tables and charts in similar measure.
  mixed: { labelKey: 'reports.classDashboard', fallback: 'Dashboard', icon: LayoutDashboard },
}

export function useStarred(tenantId: number | null): [Set<number>, (id: number) => void] {
  const key = `sgv-starred-reports:${tenantId ?? 'none'}`
  const read = () => {
    try {
      return new Set<number>(JSON.parse(localStorage.getItem(key) || '[]'))
    } catch {
      return new Set<number>()
    }
  }
  const [state, setState] = useState<{ key: string; ids: Set<number> }>(() => ({ key, ids: read() }))
  // Workspace switched → load that workspace's stars (adjust during render).
  if (state.key !== key) setState({ key, ids: read() })
  const toggle = (id: number) => {
    const next = new Set(state.ids)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setState({ key, ids: next })
    try {
      localStorage.setItem(key, JSON.stringify([...next]))
    } catch {
      // storage unavailable — stars last for this session
    }
  }
  return [state.ids, toggle]
}

export function StarButton({
  starred,
  onToggle,
  name,
  className,
  plain = false,
}: {
  starred: boolean
  onToggle: () => void
  name: string
  className?: string
  /** No floating chip background — for use on a plain surface (viewer header). */
  plain?: boolean
}) {
  const { t } = useTranslation()
  const label = starred
    ? t('reports.unstar', { defaultValue: 'Unstar {{name}}', name })
    : t('reports.star', { defaultValue: 'Star {{name}}', name })
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      aria-pressed={starred}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        plain ? 'hover:bg-accent' : 'bg-background/85 shadow-sm ring-1 ring-border backdrop-blur',
        starred ? 'text-warning' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      <Star className={cn('h-4 w-4 transition-transform motion-reduce:transition-none', starred && 'scale-110 fill-current')} aria-hidden />
    </button>
  )
}

/** The report's own icon + colour (set in the builder); falls back to its type icon. */
export function ReportIcon({
  report,
  fallback,
  size = 'md',
}: {
  report: Report
  fallback: typeof Table2
  size?: 'sm' | 'md' | 'lg'
}) {
  const color = report.color || undefined
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center border',
        size === 'lg' ? 'h-12 w-12 rounded-xl' : size === 'md' ? 'h-9 w-9 rounded-lg' : 'h-7 w-7 rounded-md',
        !color && 'bg-muted/50 text-muted-foreground',
      )}
      style={color ? { color, background: `${color}14`, borderColor: `${color}33` } : undefined}
    >
      {createElement(iconComponentForId(report.icon) ?? fallback, {
        className: size === 'lg' ? 'h-6 w-6' : size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5',
        'aria-hidden': true,
      })}
    </div>
  )
}
