/**
 * /alerts — the alerts the server-side engine raised (active first, by
 * severity) with Acknowledge / Resolve / Show on map, filtered by status,
 * facility and severity; and the Rules tab (list, on/off, edit, delete,
 * New rule). Refreshes every 20 s and on `alerts` SSE events (AlertsBell).
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { BellOff, Check, CheckCheck, MapPin, PencilLine, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PageContainer, rise } from '@/components/page-shell'
import { EmptyState } from '@/components/empty-state'
import { QueryError } from '@/components/feedback/query-error'
import { AlertRuleDialog } from '@/components/alerts/alert-rule-dialog'
import { alertMapHref } from '@/components/alerts/alerts-bell'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import {
  acknowledgeAlert,
  deleteAlertRule,
  listAlertRules,
  listAlerts,
  resolveAlert,
  updateAlertRule,
  SEVERITY_TONE,
  type AlertEvent,
  type AlertRule,
  type AlertSeverity,
} from '@/lib/alerts-client'
import { apiDb } from '@/lib/api-db'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { listReportMemberCandidates } from '@/lib/reports-client'
import { toast } from '@/lib/toast-store'
import { queryCache, useApiQuery } from '@/lib/useApiQuery'
import { cn } from '@/lib/utils'

const SELECT = 'h-8 rounded-md border bg-background px-2 text-sm'

export default function AlertsPage() {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const { can } = useWorkspaceRole()
  const canRespond = can('alerts.respond')
  const canEdit = can('alerts.manage')
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'rules' ? 'rules' : 'alerts'
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }

  const zones = useApiQuery(() => apiDb.zones.toArray(), ['alerts-zones', tenantId], { intervalMs: 0 })
  const sources = useApiQuery(() => apiDb.dataSources.toArray(), ['alerts-sources', tenantId], { intervalMs: 0 })
  const members = useApiQuery(() => listReportMemberCandidates().catch(() => []), ['alerts-members', tenantId], { intervalMs: 0, enabled: canEdit })
  const [editing, setEditing] = useState<AlertRule | 'new' | null>(null)
  const zoneId = Number(params.get('facility')) || null

  return (
    <PageContainer className="gap-6">
      <header {...rise(0, 'flex flex-wrap items-start justify-between gap-4')}>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('alerts.title', { defaultValue: 'Alerts' })}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t('alerts.pageBody', { defaultValue: 'Rules watch your tables on the server and raise an alert when an item breaches one — it closes itself once the item is back to normal.' })}
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" />
            {t('alerts.newRule', { defaultValue: 'New rule' })}
          </Button>
        )}
      </header>

      <div {...rise(1, 'flex flex-wrap items-center gap-2')}>
        <div className="inline-flex rounded-lg bg-muted p-0.5" role="tablist">
          {(['alerts', 'rules'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setParam('tab', k === 'rules' ? 'rules' : null)}
              className={cn('h-8 rounded-md px-3 text-sm font-medium', tab === k ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {k === 'alerts' ? t('alerts.tabAlerts', { defaultValue: 'Alerts' }) : t('alerts.tabRules', { defaultValue: 'Rules' })}
            </button>
          ))}
        </div>
        <select className={SELECT} value={zoneId ?? ''} onChange={(e) => setParam('facility', e.target.value || null)} aria-label={t('alerts.rule.facility', { defaultValue: 'Facility' })}>
          <option value="">{t('alerts.allFacilities', { defaultValue: 'All facilities' })}</option>
          {(zones.data ?? []).map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
        </select>
      </div>

      <div {...rise(2, 'pb-8')}>
        {tab === 'alerts' ? (
          <AlertsList zoneId={zoneId} canEdit={canRespond} />
        ) : (
          <RulesList zoneId={zoneId} canEdit={canEdit} sources={sources.data ?? []} zonesById={new Map((zones.data ?? []).map((z) => [z.id!, z.name]))} onEdit={setEditing} />
        )}
      </div>

      {editing && (
        <AlertRuleDialog
          open
          onOpenChange={(o) => !o && setEditing(null)}
          rule={editing === 'new' ? null : editing}
          zones={zones.data ?? []}
          sources={sources.data ?? []}
          members={members.data ?? []}
          defaultZoneId={zoneId}
          onSaved={(r) => {
            setEditing(null)
            toast.success(t('alerts.ruleSaved', { name: r.name, defaultValue: '{{name}} saved — checked within 15 seconds' }))
            queryCache.invalidate('alerts-rules')
            queryCache.invalidate('alerts-page')
          }}
        />
      )}
    </PageContainer>
  )
}

function AlertsList({ zoneId, canEdit }: { zoneId: number | null; canEdit: boolean }) {
  const { t, i18n } = useTranslation()
  const tenantId = useCurrentTenantId()
  const [status, setStatus] = useState<'active' | 'resolved' | ''>('active')
  const [severity, setSeverity] = useState<AlertSeverity | ''>('')
  const q = useApiQuery(() => listAlerts({ status, zoneId, severity, limit: 300 }), ['alerts-page', tenantId, status, zoneId, severity], { intervalMs: 20_000 })
  const [busy, setBusy] = useState<number | null>(null)

  const act = async (a: AlertEvent, fn: () => Promise<void>, done: string) => {
    setBusy(a.id)
    try {
      await fn()
      toast.success(done)
    } catch {
      toast.error(t('alerts.actionFailed', { defaultValue: 'Couldn’t update the alert' }))
    } finally {
      setBusy(null)
      queryCache.invalidate('alerts-page')
      queryCache.invalidate('alert-summary')
      queryCache.invalidate('alert-latest')
    }
  }
  const statusLabel = (a: AlertEvent) =>
    a.status === 'open'
      ? t('alerts.status.open', { defaultValue: 'Open' })
      : a.status === 'acknowledged'
        ? t('alerts.status.acknowledged', { defaultValue: 'Acknowledged' })
        : a.autoResolved
          ? t('alerts.status.autoResolved', { defaultValue: 'Back to normal' })
          : t('alerts.status.resolved', { defaultValue: 'Resolved' })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border p-0.5" role="group">
          {(['active', 'resolved', ''] as const).map((s) => (
            <button key={s || 'all'} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}
              className={cn('h-7 rounded px-3 text-xs font-medium', status === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {s === 'active' ? t('alerts.filterActive', { defaultValue: 'Active' }) : s === 'resolved' ? t('alerts.filterResolved', { defaultValue: 'Resolved' }) : t('alerts.filterAll', { defaultValue: 'All' })}
            </button>
          ))}
        </div>
        <select className={SELECT} value={severity} onChange={(e) => setSeverity(e.target.value as AlertSeverity | '')} aria-label={t('alerts.rule.severity', { defaultValue: 'Severity' })}>
          <option value="">{t('alerts.allSeverities', { defaultValue: 'Every severity' })}</option>
          {(['critical', 'warning', 'info'] as const).map((s) => <option key={s} value={s}>{t(`alerts.severity.${s}`, { defaultValue: s })}</option>)}
        </select>
      </div>

      {q.error && !q.data ? (
        <QueryError error={q.error} onRetry={q.mutate} what={t('alerts.what', { defaultValue: 'the alerts' })} />
      ) : !q.data ? (
        <div className="space-y-2" aria-busy>{[0, 1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />)}</div>
      ) : q.data.length === 0 ? (
        <EmptyState icon={BellOff} title={status === 'active' ? t('alerts.emptyActive', { defaultValue: 'All clear' }) : t('alerts.empty', { defaultValue: 'No alerts' })}
          description={status === 'active' ? t('alerts.emptyActiveBody', { defaultValue: 'Nothing breaches a rule right now.' }) : undefined} />
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {q.data.map((a) => {
            const href = alertMapHref(a)
            return (
              <li key={a.id} className={cn('flex flex-wrap items-start gap-3 px-4 py-3', a.status === 'resolved' && 'opacity-70')}>
                <span className={cn('mt-1 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase', SEVERITY_TONE[a.severity].badge)}>
                  {t(`alerts.severity.${a.severity}`, { defaultValue: a.severity })}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{a.message}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {a.zoneName && <span>{a.zoneName}</span>}
                    <span>{a.ruleName}</span>
                    <span title={fullTime(a.openedAt, i18n.language)}>{t('alerts.opened', { when: relativeTime(a.openedAt, i18n.language), defaultValue: 'Opened {{when}}' })}</span>
                    <span>{statusLabel(a)}{a.resolvedAt ? ` · ${relativeTime(a.resolvedAt, i18n.language)}` : ''}</span>
                    {a.forMe && a.status !== 'resolved' && <span className="text-foreground">{t('alerts.forYou', { defaultValue: 'For you' })}</span>}
                  </p>
                  {a.note && <p className="mt-1 text-xs">{a.note}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {href && (
                    <Button asChild variant="ghost" size="sm" className="h-8">
                      <a href={href}><MapPin className="h-3.5 w-3.5" />{t('alerts.showOnMap', { defaultValue: 'Show on map' })}</a>
                    </Button>
                  )}
                  {canEdit && a.status === 'open' && (
                    <Button variant="outline" size="sm" className="h-8" disabled={busy === a.id}
                      onClick={() => void act(a, () => acknowledgeAlert(a.id), t('alerts.acknowledged', { defaultValue: 'Acknowledged' }))}>
                      <Check className="h-3.5 w-3.5" />{t('alerts.acknowledge', { defaultValue: 'Acknowledge' })}
                    </Button>
                  )}
                  {canEdit && a.status !== 'resolved' && (
                    <Button variant="outline" size="sm" className="h-8" disabled={busy === a.id}
                      onClick={() => void act(a, () => resolveAlert(a.id), t('alerts.resolvedToast', { defaultValue: 'Resolved' }))}>
                      <CheckCheck className="h-3.5 w-3.5" />{t('alerts.resolve', { defaultValue: 'Resolve' })}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function RulesList({ zoneId, canEdit, sources, zonesById, onEdit }: {
  zoneId: number | null
  canEdit: boolean
  sources: Array<{ id?: number; name: string }>
  zonesById: Map<number, string>
  onEdit: (r: AlertRule) => void
}) {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const rules = useApiQuery(() => listAlertRules(zoneId), ['alerts-rules', tenantId, zoneId], { intervalMs: 30_000 })
  const active = useApiQuery(() => listAlerts({ status: 'active', zoneId, limit: 1000 }), ['alerts-page', tenantId, 'rules', zoneId], { intervalMs: 30_000 })
  const counts = useMemo(() => {
    const m = new Map<number, number>()
    for (const a of active.data ?? []) m.set(a.ruleId, (m.get(a.ruleId) ?? 0) + 1)
    return m
  }, [active.data])
  const sourceName = (id: number) => sources.find((s) => s.id === id)?.name ?? `#${id}`
  // On/off flips show at once; the next load confirms them.
  const [flipped, setFlipped] = useState<Record<number, boolean>>({})
  const rows = rules.data?.map((r) => (r.id in flipped ? { ...r, enabled: flipped[r.id] } : r))

  const summary = (r: AlertRule) => {
    const mins = Math.round(r.durationSec / 60)
    switch (r.kind) {
      case 'duration': return t('alerts.summary.duration', { minutes: mins, defaultValue: 'Matches for {{minutes}} min' })
      case 'stale': return t('alerts.summary.stale', { minutes: mins, defaultValue: 'Not updated for {{minutes}} min' })
      case 'count': return t('alerts.summary.count', { op: { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' }[r.comparison], n: r.threshold, defaultValue: 'Matching items {{op}} {{n}}' })
      default: return t('alerts.summary.condition', { defaultValue: 'A row matches' })
    }
  }
  const toggle = async (r: AlertRule, enabled: boolean) => {
    setFlipped((f) => ({ ...f, [r.id]: enabled }))
    try {
      await updateAlertRule(r.id, { ...r, enabled })
    } catch {
      toast.error(t('alerts.actionFailed', { defaultValue: 'Couldn’t update the alert' }))
    }
    queryCache.invalidate('alerts-rules')
  }
  const remove = async (r: AlertRule) => {
    if (!window.confirm(t('alerts.confirmDelete', { name: r.name, defaultValue: 'Delete the rule “{{name}}” and its alerts?' }))) return
    await deleteAlertRule(r.id).catch(() => toast.error(t('alerts.actionFailed', { defaultValue: 'Couldn’t update the alert' })))
    queryCache.invalidate('alerts-rules')
    queryCache.invalidate('alerts-page')
  }

  if (rules.error && !rows) return <QueryError error={rules.error} onRetry={rules.mutate} what={t('alerts.rulesWhat', { defaultValue: 'the alert rules' })} />
  if (!rows) return <div className="space-y-2" aria-busy>{[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-muted" />)}</div>
  if (rows.length === 0) return <EmptyState icon={BellOff} title={t('alerts.noRules', { defaultValue: 'No alert rules yet' })} description={t('alerts.noRulesBody', { defaultValue: 'Create a rule to be told when an item breaches it.' })} />

  return (
    <ul className="divide-y rounded-xl border bg-card">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', SEVERITY_TONE[r.severity].dot)} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{r.name}</p>
            <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              <span>{r.zoneId ? zonesById.get(r.zoneId) ?? '' : t('alerts.rule.anyFacility', { defaultValue: 'Workspace-wide' })}</span>
              <span>{sourceName(r.sourceId)}</span>
              <span>{summary(r)}</span>
              <span>{t(`alerts.severity.${r.severity}`, { defaultValue: r.severity })}</span>
              {(counts.get(r.id) ?? 0) > 0 && <span className="text-foreground">{t('alerts.activeCount', { count: counts.get(r.id), defaultValue: '{{count}} active' })}</span>}
            </p>
            {r.lastError && <p className="mt-0.5 text-xs text-danger">{r.lastError}</p>}
          </div>
          {canEdit && (
            <div className="flex items-center gap-1">
              <Switch checked={r.enabled} onCheckedChange={(on) => void toggle(r, on)} aria-label={t('alerts.rule.enabled', { defaultValue: 'On' })} />
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => onEdit(r)} aria-label={t('common.edit', { defaultValue: 'Edit' })}><PencilLine className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-danger hover:bg-danger/10 hover:text-danger" onClick={() => void remove(r)} aria-label={t('common.delete', { defaultValue: 'Delete' })}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
