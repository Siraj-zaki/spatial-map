/**
 * Phase 8b — floating alerts panel for the editor.
 *
 * Renders the unacknowledged tail of `db.alerts` in the top-right
 * corner of the map. Color-coded by level (info / warn / critical),
 * each row carries an inline acknowledge button. When no
 * unacknowledged alerts exist the panel is hidden so it doesn't
 * compete with the toolbar.
 *
 * The component subscribes via `useLiveQuery`, so a rule fire that
 * inserts a new alert row repaints within Dexie's normal observable
 * cycle — no extra polling.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  Check,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
} from 'lucide-react'
import { apiDb } from '@/lib/api-db'
import { useApiQuery } from '@/lib/useApiQuery'
import type { Alert } from '@/lib/db'
import { useCurrentTenantId } from '@/lib/data-link'
import { cn } from '@/lib/utils'

const MAX_VISIBLE = 6
const SHELF_DURATION_MS = 60 * 60 * 1000 // hide alerts older than 1 hour by default

interface AlertsPanelProps {
  /** Disable data fetching. Used in the layout editor to avoid polling
   *  the alerts table while the user is drawing geometry. */
  enabled?: boolean
}

export function AlertsPanel({ enabled = true }: AlertsPanelProps = {}) {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const { data: all = [] } = useApiQuery(
    async () => {
      const rows = await apiDb.alerts.toArray()
      rows.sort((a, b) => b.ts.getTime() - a.ts.getTime())
      const tail = rows.slice(0, 50)
      if (tenantId === null) return tail
      return tail.filter(
        (a) => a.tenantId === undefined || a.tenantId === tenantId,
      )
    },
    ['alerts', tenantId],
    { enabled },
  )
  const [recentCutoff] = useState(() => Date.now() - SHELF_DURATION_MS)
  const active = all.filter(
    (a) => !a.acknowledged && a.ts.getTime() >= recentCutoff,
  )
  const [collapsed, setCollapsed] = useState(false)
  const [ackingAll, setAckingAll] = useState(false)

  if (active.length === 0) return null

  const visible = collapsed ? [] : active.slice(0, MAX_VISIBLE)
  const overflow = collapsed ? active.length : Math.max(0, active.length - MAX_VISIBLE)

  // All at once (not one by one), with the button busy until done.
  const ackAll = async () => {
    if (ackingAll) return
    const now = new Date()
    setAckingAll(true)
    try {
      await Promise.all(
        active.filter((a) => a.id !== undefined).map((a) => apiDb.alerts.update(a.id!, { acknowledged: true, acknowledgedAt: now })),
      )
    } finally {
      setAckingAll(false)
    }
  }

  return (
    <div
      className={cn(
        'pointer-events-none fixed top-3 right-3 z-50',
        'flex flex-col items-end gap-1.5 max-w-[360px]',
      )}
      role="status"
    >
      <div
        className={cn(
          'pointer-events-auto inline-flex items-center gap-2 px-2 py-1 rounded-md border',
          'bg-card/95 backdrop-blur-sm shadow-sm',
          'text-[11px]',
        )}
      >
        <Bell className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
        <span className="font-semibold">
          {t('alerts.count', { count: active.length })}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="ms-1 px-1 rounded hover:bg-muted/60 text-muted-foreground transition-colors"
          title={collapsed ? t('alerts.expand') : t('alerts.collapse')}
          aria-label={collapsed ? t('alerts.expand') : t('alerts.collapse')}
        >
          {collapsed ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronUp className="w-3 h-3" />
          )}
        </button>
        <button
          type="button"
          onClick={() => void ackAll()}
          disabled={ackingAll}
          aria-busy={ackingAll}
          className="inline-flex items-center gap-1 px-1.5 rounded text-[10px] font-semibold text-success hover:bg-success/10 transition-colors disabled:opacity-70"
          title={t('alerts.ackAll')}
          aria-label={t('alerts.ackAll')}
        >
          {ackingAll && <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden />}
          {t('alerts.ackAllShort')}
        </button>
      </div>
      {visible.map((a) => (
        <AlertCard key={a.id} alert={a} />
      ))}
      {overflow > 0 && !collapsed && (
        <div className="pointer-events-auto text-[10px] text-muted-foreground bg-card/90 backdrop-blur-sm px-2 py-1 rounded-md border">
          {t('alerts.more', { count: overflow })}
        </div>
      )}
    </div>
  )
}

function AlertCard({ alert }: { alert: Alert }) {
  const { t } = useTranslation()
  const [acking, setAcking] = useState(false)
  const handleAck = async () => {
    if (alert.id === undefined || acking) return
    setAcking(true)
    try {
      await apiDb.alerts.update(alert.id, {
        acknowledged: true,
        acknowledgedAt: new Date(),
      })
    } finally {
      setAcking(false)
    }
  }
  const { icon: Icon, bg, fg, border } = levelTokens(alert.level)
  return (
    <div
      className={cn(
        'pointer-events-auto w-full',
        'flex items-start gap-2 px-2.5 py-2 rounded-md border shadow-sm',
        bg,
        border,
      )}
    >
      <Icon className={cn('w-4 h-4 mt-0.5 flex-shrink-0', fg)} />
      <div className="flex-1 min-w-0">
        <div className={cn('text-xs font-semibold leading-tight', fg)}>
          {alert.ruleName}
        </div>
        <div className="text-[11px] mt-0.5 leading-snug break-words">
          {alert.message}
        </div>
        <div className="text-[10px] text-muted-foreground font-mono mt-1">
          {timeAgo(alert.ts, t)}
          {alert.entityRef && (
            <span className="ms-2">· {alert.entityRef}</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void handleAck()}
        className={cn(
          'flex items-center justify-center w-5 h-5 rounded flex-shrink-0',
          'hover:bg-muted/50 text-muted-foreground transition-colors',
        )}
        title={t('alerts.acknowledge')}
        aria-label={t('alerts.acknowledgeAlert')}
        disabled={acking}
        aria-busy={acking}
      >
        {acking ? <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" /> : <Check className="w-3 h-3" />}
      </button>
    </div>
  )
}

function levelTokens(level: Alert['level']) {
  if (level === 'critical') {
    return {
      icon: AlertCircle,
      bg: 'bg-rose-500/12 backdrop-blur-sm',
      fg: 'text-rose-700 dark:text-rose-300',
      border: 'border-rose-500/40',
    }
  }
  if (level === 'warn') {
    return {
      icon: AlertTriangle,
      bg: 'bg-amber-500/12 backdrop-blur-sm',
      fg: 'text-amber-700 dark:text-amber-300',
      border: 'border-amber-500/40',
    }
  }
  return {
    icon: Info,
    bg: 'bg-sky-500/12 backdrop-blur-sm',
    fg: 'text-sky-700 dark:text-sky-300',
    border: 'border-sky-500/40',
  }
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string

function timeAgo(date: Date, t: TFunc): string {
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) return t('alerts.timeAgo.justNow')
  if (diff < 3_600_000) return t('alerts.timeAgo.minutesAgo', { count: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('alerts.timeAgo.hoursAgo', { count: Math.floor(diff / 3_600_000) })
  return t('alerts.timeAgo.daysAgo', { count: Math.floor(diff / 86_400_000) })
}
