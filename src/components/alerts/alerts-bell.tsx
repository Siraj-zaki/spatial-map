/**
 * AlertsBell — the top bar's alerts button: unread count (alerts for me
 * opened since I last opened it), a popover with the latest active alerts,
 * and a toast when a new alert for me opens. Polls every 20 s and refreshes
 * at once on an `alerts` SSE event.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { Bell, MapPin } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getAlertSummary, listAlerts, markAlertsSeen, SEVERITY_TONE, type AlertEvent } from '@/lib/alerts-client'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { facilityViewerDataHref } from '@/lib/reports/facility-sources'
import { relativeTime } from '@/lib/relative-time'
import { toast } from '@/lib/toast-store'
import { queryCache, useApiQuery } from '@/lib/useApiQuery'
import { subscribeExternalSSE } from '@/lib/useSSE'
import { cn } from '@/lib/utils'

export function alertMapHref(a: AlertEvent): string | null {
  return a.entityKey ? facilityViewerDataHref(a.dataLinkId, a.entityKey, a.zoneId) : null
}

export function AlertsBell() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const tenantId = useCurrentTenantId()
  const [open, setOpen] = useState(false)
  const summary = useApiQuery(getAlertSummary, ['alert-summary', tenantId], { intervalMs: 20_000, enabled: tenantId !== null })
  const latest = useApiQuery(() => listAlerts({ status: 'active', limit: 20 }), ['alert-latest', tenantId], { intervalMs: 20_000, enabled: tenantId !== null })

  useEffect(
    () =>
      subscribeExternalSSE((kind) => {
        if (kind !== 'alerts') return
        queryCache.invalidate('alert-summary')
        queryCache.invalidate('alert-latest')
        queryCache.invalidate('alerts-page')
      }),
    [],
  )

  // Toast alerts for me that opened since the last look (not the backlog on load).
  const known = useRef<Set<number> | null>(null)
  useEffect(() => {
    const rows = latest.data
    if (!rows) return
    if (known.current === null) {
      known.current = new Set(rows.map((a) => a.id))
      return
    }
    for (const a of rows) {
      if (known.current.has(a.id)) continue
      known.current.add(a.id)
      if (!a.forMe || a.status !== 'open') continue
      const show = a.severity === 'critical' ? toast.error : toast.info
      show(a.message, {
        description: [a.zoneName, a.ruleName].filter(Boolean).join(' · '),
        action: { label: t('alerts.view', { defaultValue: 'View' }), onClick: () => navigate('/alerts') },
      })
    }
  }, [latest.data, navigate, t])

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next && (summary.data?.unread ?? 0) > 0) {
      void markAlertsSeen()
        .then(() => queryCache.invalidate('alert-summary'))
        .catch(() => {
          /* the badge clears on the next poll */
        })
    }
  }

  const unread = summary.data?.unread ?? 0
  const critical = summary.data?.critical ?? 0
  const label = t('alerts.bell', { count: unread, defaultValue: 'Alerts' })
  const rows = (latest.data ?? []).slice(0, 6)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-8 w-8" aria-label={unread ? `${label} (${unread})` : label} title={label}>
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span
              className={cn(
                'absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums text-white',
                critical > 0 ? 'bg-danger' : 'bg-warning',
              )}
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-1.5rem)] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">{t('alerts.title', { defaultValue: 'Alerts' })}</span>
          <span className="text-xs text-muted-foreground">
            {t('alerts.activeCount', { count: summary.data?.active ?? 0, defaultValue: '{{count}} active' })}
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('alerts.noneActive', { defaultValue: 'No active alerts.' })}</p>
        ) : (
          <ul className="max-h-[60vh] divide-y overflow-y-auto">
            {rows.map((a) => {
              const href = alertMapHref(a)
              return (
                <li key={a.id} className="flex items-start gap-2.5 px-3 py-2.5">
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_TONE[a.severity].dot)} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm">{a.message}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[a.zoneName, relativeTime(a.openedAt, i18n.language)].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  {href && (
                    <Button asChild variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0">
                      <a href={href} aria-label={t('alerts.showOnMap', { defaultValue: 'Show on map' })} title={t('alerts.showOnMap', { defaultValue: 'Show on map' })}>
                        <MapPin className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <div className="border-t p-2">
          <Button asChild variant="ghost" size="sm" className="w-full" onClick={() => setOpen(false)}>
            <Link to="/alerts">{t('alerts.viewAll', { defaultValue: 'View all alerts' })}</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
