/**
 * AlertRuleDialog — create or edit an alert rule: facility + table, the
 * rule type (a row matches · matches for N minutes · not updated for N
 * minutes · number of matching rows), the condition (the data-link filter
 * builder over the table's fields), severity, the item's name field, the
 * message template, recipients, cooldown. A live preview shows what the
 * rule catches right now.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { FilterTreeBuilder, emptyGroup } from '@/components/data-link/filter-tree-builder'
import {
  createAlertRule,
  previewAlertRule,
  updateAlertRule,
  type AlertComparison,
  type AlertRule,
  type AlertRuleInput,
  type AlertRuleKind,
  type AlertRulePreview,
  type AlertSeverity,
} from '@/lib/alerts-client'
import { fetchDataSourceSchema, type DataSourceSchema } from '@/lib/data-link/query-client'
import type { DataSource, Zone } from '@/lib/db'
import type { ReportMemberCandidate } from '@/lib/reports-client'
import { cn } from '@/lib/utils'

const KINDS: Array<{ kind: AlertRuleKind; key: string; fallback: string; hintKey: string; hint: string }> = [
  { kind: 'condition', key: 'alerts.kind.condition', fallback: 'A row matches', hintKey: 'alerts.kind.conditionHint', hint: 'Alert as soon as an item matches the condition.' },
  { kind: 'duration', key: 'alerts.kind.duration', fallback: 'Matches for a while', hintKey: 'alerts.kind.durationHint', hint: 'Alert when an item keeps matching for a set time.' },
  { kind: 'stale', key: 'alerts.kind.stale', fallback: 'Not updated', hintKey: 'alerts.kind.staleHint', hint: 'Alert when an item hasn’t been updated or seen for a set time.' },
  { kind: 'count', key: 'alerts.kind.count', fallback: 'Number of items', hintKey: 'alerts.kind.countHint', hint: 'Alert when the number of matching items crosses a threshold.' },
]
const COMPARISONS: Array<[AlertComparison, string]> = [['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '=']]
const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const
const FIELD = 'h-9 w-full rounded-md border bg-background px-2 text-sm'

const blank = (zoneId: number | null): AlertRuleInput => ({
  zoneId, sourceId: 0, name: '', description: '', kind: 'condition', condition: emptyGroup(), durationSec: 600, staleField: '',
  comparison: 'gt', threshold: 0, severity: 'warning', message: '', labelField: '', recipientRoles: [], recipientUserIds: [],
  cooldownSec: 300, enabled: true,
})

export function AlertRuleDialog({
  open,
  onOpenChange,
  rule,
  zones,
  sources,
  members,
  defaultZoneId,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Set to edit; null for a new rule. */
  rule: AlertRule | null
  zones: Zone[]
  sources: DataSource[]
  members: ReportMemberCandidate[]
  defaultZoneId: number | null
  onSaved: (rule: AlertRule) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<AlertRuleInput>(() => (rule ? { ...rule } : blank(defaultZoneId)))
  const [schema, setSchema] = useState<{ sourceId: number; schema: DataSourceSchema } | null>(null)
  const [preview, setPreview] = useState<{ key: string; result?: AlertRulePreview; error?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const patch = (p: Partial<AlertRuleInput>) => setDraft((d) => ({ ...d, ...p }))

  const tables = useMemo(
    () => sources.filter((s) => (s.kind as string) !== 'facility' && (draft.zoneId === null || s.zoneId === draft.zoneId || s.zoneId == null)),
    [sources, draft.zoneId],
  )
  const fields = schema?.sourceId === draft.sourceId ? schema.schema.fields : []
  const timeFields = fields.filter((f) => f.type === 'date')
  const textFields = fields.filter((f) => f.type === 'string')

  useEffect(() => {
    if (!draft.sourceId) return
    let cancelled = false
    fetchDataSourceSchema(draft.sourceId)
      .then((s) => !cancelled && setSchema({ sourceId: draft.sourceId, schema: s }))
      .catch(() => !cancelled && setSchema({ sourceId: draft.sourceId, schema: { fields: [], rowCount: 0 } }))
    return () => {
      cancelled = true
    }
  }, [draft.sourceId])

  // Live preview, debounced.
  const previewKey = JSON.stringify(draft)
  useEffect(() => {
    if (!draft.sourceId || !draft.name.trim()) return
    let cancelled = false
    const h = window.setTimeout(() => {
      previewAlertRule(draft)
        .then((result) => !cancelled && setPreview({ key: previewKey, result }))
        .catch((e: unknown) => !cancelled && setPreview({ key: previewKey, error: e instanceof Error ? e.message : String(e) }))
    }, 450)
    return () => {
      cancelled = true
      window.clearTimeout(h)
    }
    // previewKey stands for the whole draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey])

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      onSaved(rule ? await updateAlertRule(rule.id, draft) : await createAlertRule(draft))
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  const minutes = Math.round(draft.durationSec / 60)
  const toggleIn = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v))
  const canSave = draft.name.trim() !== '' && draft.sourceId > 0 && !saving
  const p = preview?.key === previewKey ? preview : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 pb-4 pt-5">
          <DialogTitle>{rule ? t('alerts.rule.editTitle', { defaultValue: 'Edit alert rule' }) : t('alerts.rule.newTitle', { defaultValue: 'New alert rule' })}</DialogTitle>
          <DialogDescription>
            {t('alerts.rule.body', { defaultValue: 'Checked on the server every 15 seconds. An alert opens when an item breaches the rule and closes itself when it stops.' })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-4">
          <label className="block space-y-1">
            <span className="text-xs font-medium">{t('alerts.rule.name', { defaultValue: 'Name' })}</span>
            <Input value={draft.name} maxLength={120} onChange={(e) => patch({ name: e.target.value })} placeholder={t('alerts.rule.namePlaceholder', { defaultValue: 'e.g. Cold room above 8 °C' })} />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium">{t('alerts.rule.facility', { defaultValue: 'Facility' })}</span>
              <select className={FIELD} value={draft.zoneId ?? ''} onChange={(e) => patch({ zoneId: e.target.value ? Number(e.target.value) : null, sourceId: 0 })}>
                <option value="">{t('alerts.rule.anyFacility', { defaultValue: 'Workspace-wide' })}</option>
                {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium">{t('alerts.rule.table', { defaultValue: 'Table' })}</span>
              <select className={FIELD} value={draft.sourceId || ''} onChange={(e) => patch({ sourceId: Number(e.target.value), condition: emptyGroup(), labelField: '', staleField: '' })}>
                <option value="">{t('alerts.rule.pickTable', { defaultValue: 'Pick a table…' })}</option>
                {tables.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          </div>

          <div className="space-y-1">
            <span className="text-xs font-medium">{t('alerts.rule.type', { defaultValue: 'Alert when…' })}</span>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
              {KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  role="radio"
                  aria-checked={draft.kind === k.kind}
                  onClick={() => patch({ kind: k.kind, durationSec: k.kind === 'stale' ? 1800 : k.kind === 'duration' ? 600 : draft.durationSec })}
                  className={cn('rounded-lg border p-3 text-start transition-colors', draft.kind === k.kind ? 'border-primary bg-primary/5' : 'hover:bg-accent')}
                >
                  <span className="block text-sm font-medium">{t(k.key, { defaultValue: k.fallback })}</span>
                  <span className="block text-xs text-muted-foreground">{t(k.hintKey, { defaultValue: k.hint })}</span>
                </button>
              ))}
            </div>
          </div>

          {draft.sourceId > 0 && (
            <div className="space-y-1">
              <span className="text-xs font-medium">
                {draft.kind === 'stale' || draft.kind === 'count'
                  ? t('alerts.rule.conditionOptional', { defaultValue: 'Which items (optional — none means every item)' })
                  : t('alerts.rule.condition', { defaultValue: 'Condition' })}
              </span>
              <div className="rounded-lg border p-2">
                <FilterTreeBuilder value={draft.condition} schema={schema?.sourceId === draft.sourceId ? schema.schema : null} onChange={(condition) => patch({ condition })} />
              </div>
            </div>
          )}

          {(draft.kind === 'duration' || draft.kind === 'stale') && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-medium">
                  {draft.kind === 'duration' ? t('alerts.rule.forMinutes', { defaultValue: 'For at least (minutes)' }) : t('alerts.rule.silentMinutes', { defaultValue: 'Not updated for (minutes)' })}
                </span>
                <Input type="number" min={1} value={minutes} onChange={(e) => patch({ durationSec: Math.max(1, Number(e.target.value) || 1) * 60 })} />
              </label>
              {draft.kind === 'stale' && (
                <label className="space-y-1">
                  <span className="text-xs font-medium">{t('alerts.rule.timeField', { defaultValue: 'Time to check' })}</span>
                  <select className={FIELD} value={draft.staleField} onChange={(e) => patch({ staleField: e.target.value })}>
                    <option value="">{t('alerts.rule.rowUpdated', { defaultValue: 'When the row last changed' })}</option>
                    {timeFields.map((f) => <option key={f.field} value={f.field}>{f.field}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}

          {draft.kind === 'count' && (
            <div className="flex items-end gap-2">
              <label className="space-y-1">
                <span className="text-xs font-medium">{t('alerts.rule.countIs', { defaultValue: 'Number of items is' })}</span>
                <select className={cn(FIELD, 'w-20')} value={draft.comparison} onChange={(e) => patch({ comparison: e.target.value as AlertComparison })}>
                  {COMPARISONS.map(([v, s]) => <option key={v} value={v}>{s}</option>)}
                </select>
              </label>
              <Input type="number" min={0} className="w-28" value={draft.threshold} onChange={(e) => patch({ threshold: Math.max(0, Number(e.target.value) || 0) })} aria-label={t('alerts.rule.threshold', { defaultValue: 'Threshold' })} />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <span className="text-xs font-medium">{t('alerts.rule.severity', { defaultValue: 'Severity' })}</span>
              <div className="inline-flex w-full rounded-md border p-0.5" role="radiogroup">
                {(['info', 'warning', 'critical'] as AlertSeverity[]).map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={draft.severity === s} onClick={() => patch({ severity: s })}
                    className={cn('h-8 flex-1 rounded text-xs font-medium', draft.severity === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                    {t(`alerts.severity.${s}`, { defaultValue: s })}
                  </button>
                ))}
              </div>
            </div>
            {draft.kind !== 'count' && (
              <label className="space-y-1">
                <span className="text-xs font-medium">{t('alerts.rule.itemName', { defaultValue: 'Item name from' })}</span>
                <select className={FIELD} value={draft.labelField} onChange={(e) => patch({ labelField: e.target.value })}>
                  <option value="">{t('alerts.rule.rowKey', { defaultValue: 'The row key' })}</option>
                  {textFields.map((f) => <option key={f.field} value={f.field}>{f.field}</option>)}
                </select>
              </label>
            )}
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-medium">{t('alerts.rule.message', { defaultValue: 'Message' })}</span>
            <Input value={draft.message} maxLength={300} onChange={(e) => patch({ message: e.target.value })}
              placeholder={draft.kind === 'count'
                ? t('alerts.rule.countPlaceholder', { a: '{{count}}', defaultValue: '{{a}} items low on stock' })
                : t('alerts.rule.messagePlaceholder', { a: '{{item}}', b: '{{status}}', defaultValue: '{{a}} is {{b}}' })} />
            <span className="block text-xs text-muted-foreground">
              {/* The template syntax goes in as values so i18next leaves it alone. */}
              {t('alerts.rule.messageHint', { a: '{{field}}', b: '{{item}}', c: '{{count}}', defaultValue: 'Use {{a}} for any field of the row, {{b}} for its name, {{c}} for a count rule. Empty = the rule’s name and the item.' })}
            </span>
          </label>

          <div className="space-y-1">
            <span className="text-xs font-medium">{t('alerts.rule.notify', { defaultValue: 'Notify' })}</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {ROLES.map((role) => (
                <label key={role} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={draft.recipientRoles.includes(role)} onChange={(e) => patch({ recipientRoles: toggleIn(draft.recipientRoles, role, e.target.checked) })} />
                  {t(`alerts.role.${role}`, { defaultValue: role })}
                </label>
              ))}
            </div>
            {members.length > 0 && (
              <details className="rounded-md border px-2 py-1 text-sm">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {t('alerts.rule.people', { count: draft.recipientUserIds.length, defaultValue: 'Specific people ({{count}})' })}
                </summary>
                <div className="max-h-40 space-y-1 overflow-y-auto py-1">
                  {members.map((m) => (
                    <label key={m.userId} className="flex items-center gap-1.5">
                      <input type="checkbox" className="h-4 w-4 accent-primary" checked={draft.recipientUserIds.includes(m.userId)} onChange={(e) => patch({ recipientUserIds: toggleIn(draft.recipientUserIds, m.userId, e.target.checked) })} />
                      <span className="truncate">{m.userEmail}</span>
                    </label>
                  ))}
                </div>
              </details>
            )}
            <span className="block text-xs text-muted-foreground">
              {t('alerts.rule.notifyHint', { defaultValue: 'They get the bell badge and a pop-up. Nobody picked = everyone. Every member can see every alert on the Alerts page.' })}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              {t('alerts.rule.cooldown', { defaultValue: 'Don’t reopen within (minutes)' })}
              <Input type="number" min={0} className="h-8 w-20" value={Math.round(draft.cooldownSec / 60)} onChange={(e) => patch({ cooldownSec: Math.max(0, Number(e.target.value) || 0) * 60 })} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
              {t('alerts.rule.enabled', { defaultValue: 'On' })}
            </label>
          </div>

          {draft.sourceId > 0 && draft.name.trim() && (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm" aria-live="polite">
              {!p ? (
                <span className="text-muted-foreground">{t('alerts.rule.previewing', { defaultValue: 'Checking…' })}</span>
              ) : p.error ? (
                <span className="text-danger">{p.error}</span>
              ) : draft.kind === 'count' ? (
                <span>
                  {t('alerts.rule.previewCount', { count: p.result?.count ?? 0, defaultValue: '{{count}} matching items now' })}
                  {' · '}
                  {(p.result?.matching ?? 0) > 0 ? t('alerts.rule.wouldFire', { defaultValue: 'would alert now' }) : t('alerts.rule.wouldNotFire', { defaultValue: 'would not alert now' })}
                </span>
              ) : (
                <>
                  <span className="font-medium">
                    {draft.kind === 'duration'
                      ? t('alerts.rule.previewMatching', { count: p.result?.matching ?? 0, defaultValue: '{{count}} items match now (they alert once they’ve matched long enough)' })
                      : t('alerts.rule.previewItems', { count: p.result?.matching ?? 0, defaultValue: '{{count}} items would alert now' })}
                  </span>
                  {(p.result?.samples.length ?? 0) > 0 && (
                    <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                      {p.result!.samples.map((s) => <li key={s.key} className="truncate">• {s.message}</li>)}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
          <p className="text-xs text-danger">{saveError}</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
            <Button onClick={() => void save()} disabled={!canSave}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('alerts.rule.save', { defaultValue: 'Save rule' })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
