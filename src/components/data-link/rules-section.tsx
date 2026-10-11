/**
 * Rules — "when X happens, do Y" automations over live data.
 *
 * Triggers: CV detection in a shape, sensor reading over/under a
 * threshold, RFID tag read in an area, asset entering/leaving an area,
 * shipment state change. Actions: advance a shipment, set a bin status,
 * raise an alert, call a stream's outbound, notify a webhook, set a
 * facility status.
 *
 * The list reads each rule as a sentence (`describeTrigger` /
 * `describeAction`, translated), with an on/off switch (toast), fire
 * count + last fired, and delete behind a ConfirmDialog. "Add rule" opens
 * the builder in a dialog: a When card, a Then card, cooldown, and a live
 * preview of the sentence. Owners/admins manage; others read.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { CircleAlert, Loader2, Plus, Trash2, Workflow, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { RoleGate } from '@/components/feedback/role-gate'
import { apiDb } from '@/lib/api-db'
import { useApiQuery, queryCache } from '@/lib/useApiQuery'
import {
  type AlertLevel,
  type BinStatus,
  type CorrelationAction,
  type CorrelationRule,
  type CorrelationTrigger,
  type ShipmentState,
} from '@/lib/db'
import { useCurrentTenantId } from '@/lib/data-link'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'

const SHIPMENT_STATE_OPTIONS: ShipmentState[] = ['scheduled', 'arrived', 'docked', 'loading', 'departed', 'cancelled']
const BIN_STATUS_OPTIONS: BinStatus[] = ['empty', 'occupied', 'reserved']

// ============================================================ sentences

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function describeTrigger(tr: CorrelationTrigger, t: TFunction): string {
  switch (tr.kind) {
    case 'cv-detection':
      return t('rules.when.cv', {
        defaultValue: '{{count}}+ “{{object}}” detections in {{shape}} #{{id}} within {{seconds}} s',
        count: tr.minCount ?? 1,
        object: tr.objectClass || t('rules.anything', { defaultValue: 'objects' }),
        shape: tr.targetShapeKind ?? 'shape',
        id: tr.targetShapeId ?? '?',
        seconds: Math.round((tr.windowMs ?? 10000) / 1000),
      })
    case 'sensor-reading':
      return t('rules.when.sensor', {
        defaultValue: 'sensor {{sensor}} reads {{op}} {{threshold}}',
        sensor: tr.sensorId || t('rules.anySensor', { defaultValue: '(any)' }),
        op: tr.op,
        threshold: tr.threshold,
      })
    case 'rfid-read':
      return tr.tagIdPattern
        ? t('rules.when.rfidPattern', { defaultValue: 'a tag containing “{{pattern}}” is read in area #{{id}}', pattern: tr.tagIdPattern, id: tr.polygonId })
        : t('rules.when.rfid', { defaultValue: 'any RFID tag is read in area #{{id}}', id: tr.polygonId })
    case 'asset-position':
      return tr.direction === 'enter'
        ? t('rules.when.assetEnter', { defaultValue: 'an asset{{pattern}} enters area #{{id}}', pattern: tr.assetIdPattern ? ` “${tr.assetIdPattern}”` : '', id: tr.polygonId })
        : t('rules.when.assetLeave', { defaultValue: 'an asset{{pattern}} leaves area #{{id}}', pattern: tr.assetIdPattern ? ` “${tr.assetIdPattern}”` : '', id: tr.polygonId })
    case 'shipment-state-change':
      return tr.doorId !== undefined
        ? t('rules.when.shipmentDoor', { defaultValue: 'a shipment at door #{{door}} becomes {{states}}', door: tr.doorId, states: tr.toStates.join(' / ') })
        : t('rules.when.shipment', { defaultValue: 'a shipment becomes {{states}}', states: tr.toStates.join(' / ') })
  }
}

export function describeAction(a: CorrelationAction, t: TFunction): string {
  switch (a.kind) {
    case 'advance-shipment-state':
      return a.doorId !== undefined
        ? t('rules.then.shipmentDoor', { defaultValue: 'move the shipment at door #{{door}} to {{state}}', door: a.doorId, state: a.to })
        : t('rules.then.shipment', { defaultValue: 'move the shipment to {{state}}', state: a.to })
    case 'set-bin-status':
      return t('rules.then.bin', { defaultValue: 'mark bin {{bin}} as {{status}}', bin: a.binExternalCode ?? (a.binId !== undefined ? `#${a.binId}` : ''), status: a.status })
    case 'emit-alert':
      return t('rules.then.alert', { defaultValue: 'raise a {{level}} alert: “{{message}}”', level: a.level, message: a.messageTemplate })
    case 'call-outbound':
      return t('rules.then.outbound', { defaultValue: 'send an update through stream #{{id}} ({{method}})', id: a.streamId, method: a.method ?? 'POST' })
    case 'notify-webhook':
      return t('rules.then.webhook', { defaultValue: 'notify {{host}}', host: host(a.url) })
    case 'set-zone-status':
      return t('rules.then.zone', { defaultValue: 'set facility #{{id}} to “{{status}}”', id: a.zoneId, status: a.status })
  }
}

// ============================================================ list

export function RulesSection({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const query = useApiQuery(
    async () => {
      const rows = await apiDb.correlationRules.toArray()
      return tenantId === null ? rows : rows.filter((r) => r.tenantId === undefined || r.tenantId === tenantId)
    },
    ['correlationRules', tenantId],
    { intervalMs: 5000 },
  )
  const rules = useMemo(() => [...(query.data ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)), [query.data])
  const [addOpen, setAddOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<CorrelationRule | null>(null)
  const [deleting, setDeleting] = useState(false)

  const toggle = async (rule: CorrelationRule) => {
    if (rule.id === undefined) return
    try {
      await apiDb.correlationRules.update(rule.id, { enabled: !rule.enabled, updatedAt: new Date() })
      queryCache.invalidate('correlationRules')
      queryCache.invalidate('correlationRules-count')
      toast.success(
        rule.enabled
          ? t('rules.paused', { defaultValue: '“{{name}}” paused', name: rule.name })
          : t('rules.resumed', { defaultValue: '“{{name}}” is on', name: rule.name }),
      )
    } catch (err) {
      toast.error(t('rules.toggleFailed', { defaultValue: 'Couldn’t change the rule' }), { description: (err as Error).message })
    }
  }

  const doDelete = async () => {
    if (pendingDelete?.id === undefined) return
    setDeleting(true)
    try {
      await apiDb.correlationRules.delete(pendingDelete.id)
      queryCache.invalidate('correlationRules')
      queryCache.invalidate('correlationRules-count')
      toast.success(t('rules.deleted', { defaultValue: '“{{name}}” deleted', name: pendingDelete.name }))
      setPendingDelete(null)
    } catch (err) {
      toast.error(t('rules.deleteFailed', { defaultValue: 'Couldn’t delete the rule' }), { description: (err as Error).message })
    } finally {
      setDeleting(false)
    }
  }

  const addButton = (
    <RoleGate allowed={canManage} message={t('common.needsAdmin', { defaultValue: 'Only workspace owners and admins can do this.' })}>
      <Button onClick={() => setAddOpen(true)} disabled={!canManage}>
        <Plus className="h-4 w-4" />
        {t('rules.add', { defaultValue: 'Add rule' })}
      </Button>
    </RoleGate>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('rules.intro', { defaultValue: 'Automations that watch live data and act on it — a dock starts loading when people are seen there, an alert when a freezer warms up.' })}
        </p>
        {rules.length > 0 && addButton}
      </div>

      {query.isLoading && !query.data ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : rules.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title={t('rules.emptyTitle', { defaultValue: 'No rules yet' })}
          description={t('rules.emptyBody', { defaultValue: 'Example: when 3+ people are seen in area #42 for 10 seconds, move the docked shipment to loading.' })}
          action={addButton}
        />
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} canManage={canManage} onToggle={() => void toggle(rule)} onDelete={() => setPendingDelete(rule)} />
          ))}
        </ul>
      )}

      {addOpen && <RuleBuilderDialog onClose={() => setAddOpen(false)} />}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('rules.deleteTitle', { defaultValue: 'Delete “{{name}}”?', name: pendingDelete?.name ?? '' })}
        description={t('rules.deleteBody', { defaultValue: 'It stops firing straight away. To stop it for a while instead, switch it off.' })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        onConfirm={() => void doDelete()}
        busy={deleting}
      />
    </div>
  )
}

function RuleRow({ rule, canManage, onToggle, onDelete }: { rule: CorrelationRule; canManage: boolean; onToggle: () => void; onDelete: () => void }) {
  const { t, i18n } = useTranslation()
  const last = rule.lastFiredAt ? new Date(rule.lastFiredAt).toISOString() : undefined
  return (
    <li className={cn('group flex items-start gap-4 rounded-xl border bg-card px-4 py-3.5 transition-opacity', !rule.enabled && 'opacity-70')}>
      <Switch
        checked={rule.enabled}
        onCheckedChange={onToggle}
        disabled={!canManage}
        className="mt-0.5"
        aria-label={rule.enabled ? t('rules.turnOff', { defaultValue: 'Turn off {{name}}', name: rule.name }) : t('rules.turnOn', { defaultValue: 'Turn on {{name}}', name: rule.name })}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{rule.name}</p>
          {!rule.enabled && <Badge variant="muted">{t('rules.off', { defaultValue: 'Off' })}</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{t('rules.whenLabel', { defaultValue: 'When' })}</span> {describeTrigger(rule.trigger, t)}
          {', '}
          <span className="font-medium text-foreground">{t('rules.thenLabel', { defaultValue: 'then' })}</span> {describeAction(rule.action, t)}
        </p>
      </div>
      <div className="hidden shrink-0 flex-col items-end text-xs text-muted-foreground sm:flex">
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Zap className="h-3 w-3" aria-hidden />
          {t('rules.fires', { defaultValue: '{{count}} fires', count: rule.fireCount })}
        </span>
        <span title={last ? fullTime(last, i18n.language) : undefined}>
          {last ? relativeTime(last, i18n.language) : t('rules.neverFired', { defaultValue: 'never fired' })}
        </span>
      </div>
      {canManage && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground opacity-0 hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={onDelete}
          aria-label={t('rules.deleteNamed', { defaultValue: 'Delete {{name}}', name: rule.name })}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </li>
  )
}

// ============================================================ builder

/** Label + control. Module-level so inputs keep their identity (and focus) across renders. */
function Field({ id, label, children }: { id?: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

const selectCls =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

function RuleBuilderDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const [name, setName] = useState('')
  const [triggerKind, setTriggerKind] = useState<CorrelationTrigger['kind']>('cv-detection')
  // cv-detection
  const [objectClass, setObjectClass] = useState('person')
  const [minCount, setMinCount] = useState('3')
  const [targetShapeKind, setTargetShapeKind] = useState('polygon')
  const [targetShapeId, setTargetShapeId] = useState('')
  const [windowSec, setWindowSec] = useState('10')
  // sensor-reading
  const [sensorId, setSensorId] = useState('')
  const [op, setOp] = useState<'>' | '<' | '>=' | '<='>('>')
  const [threshold, setThreshold] = useState('')
  // rfid-read / asset-position
  const [polygonId, setPolygonId] = useState('')
  const [pattern, setPattern] = useState('')
  const [assetDirection, setAssetDirection] = useState<'enter' | 'leave'>('enter')
  // shipment-state-change
  const [toStates, setToStates] = useState<ShipmentState[]>(['loading'])
  const [triggerDoorId, setTriggerDoorId] = useState('')
  // action
  const [actionKind, setActionKind] = useState<CorrelationAction['kind']>('advance-shipment-state')
  const [shipmentTo, setShipmentTo] = useState<ShipmentState>('loading')
  const [actionDoorId, setActionDoorId] = useState('')
  const [binExternalCode, setBinExternalCode] = useState('')
  const [binStatus, setBinStatus] = useState<BinStatus>('occupied')
  const [alertLevel, setAlertLevel] = useState<AlertLevel>('warn')
  const [alertTemplate, setAlertTemplate] = useState('')
  const [outboundStreamId, setOutboundStreamId] = useState('')
  const [outboundMethod, setOutboundMethod] = useState<'POST' | 'PATCH' | 'PUT'>('POST')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookBody, setWebhookBody] = useState('{"text":"Rule {ruleName} fired"}')
  const [zoneId, setZoneId] = useState('')
  const [zoneStatus, setZoneStatus] = useState('alert')
  const [cooldownSec, setCooldownSec] = useState('5')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const num = (s: string) => (s.trim() === '' ? undefined : Number(s))
  const bad = (field: string) => t('rules.errNumber', { defaultValue: '{{field}} must be a number.', field })

  const buildTrigger = (): CorrelationTrigger | string => {
    switch (triggerKind) {
      case 'cv-detection': {
        const id = num(targetShapeId)
        if (id !== undefined && !Number.isFinite(id)) return bad(t('rules.f.shapeId', { defaultValue: 'Shape id' }))
        return {
          kind: 'cv-detection',
          objectClass: objectClass.trim() || undefined,
          minCount: Number.parseInt(minCount, 10) || 1,
          targetShapeKind: targetShapeKind as Extract<CorrelationTrigger, { kind: 'cv-detection' }>['targetShapeKind'],
          targetShapeId: id,
          windowMs: (Number(windowSec) || 10) * 1000,
        }
      }
      case 'sensor-reading': {
        const thr = Number.parseFloat(threshold)
        if (!Number.isFinite(thr)) return bad(t('rules.f.threshold', { defaultValue: 'Threshold' }))
        return { kind: 'sensor-reading', sensorId: sensorId.trim() || undefined, op, threshold: thr }
      }
      case 'rfid-read': {
        const id = Number.parseInt(polygonId, 10)
        if (!Number.isFinite(id)) return bad(t('rules.f.areaId', { defaultValue: 'Area id' }))
        return { kind: 'rfid-read', polygonId: id, tagIdPattern: pattern.trim() || undefined }
      }
      case 'asset-position': {
        const id = Number.parseInt(polygonId, 10)
        if (!Number.isFinite(id)) return bad(t('rules.f.areaId', { defaultValue: 'Area id' }))
        return { kind: 'asset-position', polygonId: id, direction: assetDirection, assetIdPattern: pattern.trim() || undefined }
      }
      case 'shipment-state-change': {
        if (toStates.length === 0) return t('rules.errStates', { defaultValue: 'Pick at least one shipment state.' })
        const door = num(triggerDoorId)
        if (door !== undefined && !Number.isFinite(door)) return bad(t('rules.f.doorId', { defaultValue: 'Door id' }))
        return { kind: 'shipment-state-change', toStates, doorId: door }
      }
    }
  }

  const buildAction = (): CorrelationAction | string => {
    switch (actionKind) {
      case 'advance-shipment-state': {
        const door = num(actionDoorId)
        if (door !== undefined && !Number.isFinite(door)) return bad(t('rules.f.doorId', { defaultValue: 'Door id' }))
        return { kind: 'advance-shipment-state', to: shipmentTo, doorId: door }
      }
      case 'set-bin-status':
        return { kind: 'set-bin-status', status: binStatus, binExternalCode: binExternalCode.trim() || undefined }
      case 'emit-alert':
        if (!alertTemplate.trim()) return t('rules.errMessage', { defaultValue: 'Write the alert message.' })
        return { kind: 'emit-alert', level: alertLevel, messageTemplate: alertTemplate.trim() }
      case 'call-outbound': {
        const sid = Number.parseInt(outboundStreamId, 10)
        if (!Number.isFinite(sid)) return bad(t('rules.f.streamId', { defaultValue: 'Stream id' }))
        return { kind: 'call-outbound', streamId: sid, method: outboundMethod }
      }
      case 'notify-webhook':
        try {
          new URL(webhookUrl.trim())
        } catch {
          return t('rules.errUrl', { defaultValue: 'Enter the full webhook URL.' })
        }
        if (!webhookBody.trim()) return t('rules.errBody', { defaultValue: 'Write the message body.' })
        return { kind: 'notify-webhook', url: webhookUrl.trim(), bodyTemplate: webhookBody.trim() }
      case 'set-zone-status': {
        const zid = Number.parseInt(zoneId, 10)
        if (!Number.isFinite(zid)) return bad(t('rules.f.facilityId', { defaultValue: 'Facility id' }))
        if (!zoneStatus.trim()) return t('rules.errStatus', { defaultValue: 'Write the status text.' })
        return { kind: 'set-zone-status', zoneId: zid, status: zoneStatus.trim() }
      }
    }
  }

  const trig = buildTrigger()
  const act = buildAction()
  const preview =
    typeof trig !== 'string' && typeof act !== 'string'
      ? `${t('rules.whenLabel', { defaultValue: 'When' })} ${describeTrigger(trig, t)}, ${t('rules.thenLabel', { defaultValue: 'then' })} ${describeAction(act, t)}.`
      : null

  const save = async () => {
    setError(null)
    if (!name.trim()) return setError(t('rules.errName', { defaultValue: 'Give the rule a name.' }))
    if (typeof trig === 'string') return setError(trig)
    if (typeof act === 'string') return setError(act)
    setBusy(true)
    try {
      const now = new Date()
      await apiDb.correlationRules.add({
        name: name.trim(),
        enabled: true,
        trigger: trig,
        action: act,
        cooldownMs: (Number(cooldownSec) || 0) * 1000 || undefined,
        fireCount: 0,
        tenantId: tenantId ?? undefined,
        createdAt: now,
        updatedAt: now,
      })
      queryCache.invalidate('correlationRules')
      queryCache.invalidate('correlationRules-count')
      toast.success(t('rules.created', { defaultValue: '“{{name}}” is on', name: name.trim() }))
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[92dvh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 pb-4 pt-6">
          <DialogTitle>{t('rules.add', { defaultValue: 'Add rule' })}</DialogTitle>
          <DialogDescription>{t('rules.addBody', { defaultValue: 'Pick what to watch for and what to do when it happens.' })}</DialogDescription>
        </DialogHeader>
        <form
          id="rule-form"
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Field id="rule-name" label={t('rules.f.name', { defaultValue: 'Name' })}>
            <Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('rules.namePlaceholder', { defaultValue: 'e.g. Dock 4 starts loading' })} autoFocus />
          </Field>

          {/* When */}
          <div className="space-y-4 rounded-xl border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="secondary">{t('rules.whenLabel', { defaultValue: 'When' })}</Badge>
              <select aria-label={t('rules.triggerKind', { defaultValue: 'Trigger' })} value={triggerKind} onChange={(e) => setTriggerKind(e.target.value as CorrelationTrigger['kind'])} className={cn(selectCls, 'w-auto flex-1')}>
                <option value="cv-detection">{t('rules.k.cv', { defaultValue: 'A camera sees something in a shape' })}</option>
                <option value="sensor-reading">{t('rules.k.sensor', { defaultValue: 'A sensor crosses a threshold' })}</option>
                <option value="rfid-read">{t('rules.k.rfid', { defaultValue: 'An RFID tag is read in an area' })}</option>
                <option value="asset-position">{t('rules.k.asset', { defaultValue: 'An asset enters or leaves an area' })}</option>
                <option value="shipment-state-change">{t('rules.k.shipment', { defaultValue: 'A shipment changes state' })}</option>
              </select>
            </div>
            {triggerKind === 'cv-detection' && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field id="r-count" label={t('rules.f.minCount', { defaultValue: 'At least' })}><Input id="r-count" type="number" min={1} value={minCount} onChange={(e) => setMinCount(e.target.value)} /></Field>
                <Field id="r-class" label={t('rules.f.objectClass', { defaultValue: 'Object' })}><Input id="r-class" value={objectClass} onChange={(e) => setObjectClass(e.target.value)} placeholder="person" /></Field>
                <Field id="r-window" label={t('rules.f.window', { defaultValue: 'Within (seconds)' })}><Input id="r-window" type="number" min={1} value={windowSec} onChange={(e) => setWindowSec(e.target.value)} /></Field>
                <Field id="r-shapekind" label={t('rules.f.shapeKind', { defaultValue: 'Shape type' })}>
                  <select id="r-shapekind" value={targetShapeKind} onChange={(e) => setTargetShapeKind(e.target.value)} className={selectCls}>
                    <option value="polygon">{t('rules.shape.polygon', { defaultValue: 'Area (polygon)' })}</option>
                    <option value="circle">{t('rules.shape.circle', { defaultValue: 'Circle' })}</option>
                    <option value="marker">{t('rules.shape.marker', { defaultValue: 'Marker' })}</option>
                    <option value="model">{t('rules.shape.model', { defaultValue: '3D model' })}</option>
                  </select>
                </Field>
                <Field id="r-shapeid" label={t('rules.f.shapeId', { defaultValue: 'Shape id' })}><Input id="r-shapeid" inputMode="numeric" value={targetShapeId} onChange={(e) => setTargetShapeId(e.target.value)} placeholder="42" /></Field>
              </div>
            )}
            {triggerKind === 'sensor-reading' && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field id="r-sensor" label={t('rules.f.sensorId', { defaultValue: 'Sensor' })}><Input id="r-sensor" dir="ltr" value={sensorId} onChange={(e) => setSensorId(e.target.value)} placeholder={t('rules.anySensorPlaceholder', { defaultValue: 'Any sensor' })} /></Field>
                <Field id="r-op" label={t('rules.f.op', { defaultValue: 'Reads' })}>
                  <select id="r-op" value={op} onChange={(e) => setOp(e.target.value as typeof op)} className={selectCls}>
                    <option value=">">{t('rules.op.gt', { defaultValue: 'above' })}</option>
                    <option value=">=">{t('rules.op.gte', { defaultValue: 'at or above' })}</option>
                    <option value="<">{t('rules.op.lt', { defaultValue: 'below' })}</option>
                    <option value="<=">{t('rules.op.lte', { defaultValue: 'at or below' })}</option>
                  </select>
                </Field>
                <Field id="r-thr" label={t('rules.f.threshold', { defaultValue: 'Threshold' })}><Input id="r-thr" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="10" /></Field>
              </div>
            )}
            {(triggerKind === 'rfid-read' || triggerKind === 'asset-position') && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field id="r-area" label={t('rules.f.areaId', { defaultValue: 'Area id' })}><Input id="r-area" inputMode="numeric" value={polygonId} onChange={(e) => setPolygonId(e.target.value)} placeholder="42" /></Field>
                {triggerKind === 'asset-position' && (
                  <Field id="r-dir" label={t('rules.f.direction', { defaultValue: 'When it' })}>
                    <select id="r-dir" value={assetDirection} onChange={(e) => setAssetDirection(e.target.value as 'enter' | 'leave')} className={selectCls}>
                      <option value="enter">{t('rules.dir.enter', { defaultValue: 'enters' })}</option>
                      <option value="leave">{t('rules.dir.leave', { defaultValue: 'leaves' })}</option>
                    </select>
                  </Field>
                )}
                <Field id="r-pattern" label={triggerKind === 'rfid-read' ? t('rules.f.tagPattern', { defaultValue: 'Tag id contains' }) : t('rules.f.assetPattern', { defaultValue: 'Asset id contains' })}>
                  <Input id="r-pattern" dir="ltr" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={t('rules.optionalPlaceholder', { defaultValue: 'Optional' })} />
                </Field>
              </div>
            )}
            {triggerKind === 'shipment-state-change' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">{t('rules.f.toStates', { defaultValue: 'Becomes any of' })}</p>
                  <div className="flex flex-wrap gap-2">
                    {SHIPMENT_STATE_OPTIONS.map((s) => {
                      const on = toStates.includes(s)
                      return (
                        <button
                          key={s}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setToStates((cur) => (on ? cur.filter((x) => x !== s) : [...cur, s]))}
                          className={cn('rounded-full border px-3 py-1 text-xs capitalize transition-colors', on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent')}
                        >
                          {s}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <Field id="r-tdoor" label={t('rules.f.doorOptional', { defaultValue: 'Only at door (id)' })}><Input id="r-tdoor" inputMode="numeric" value={triggerDoorId} onChange={(e) => setTriggerDoorId(e.target.value)} placeholder={t('rules.optionalPlaceholder', { defaultValue: 'Optional' })} className="sm:max-w-[12rem]" /></Field>
              </div>
            )}
          </div>

          {/* Then */}
          <div className="space-y-4 rounded-xl border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="secondary">{t('rules.thenLabelCap', { defaultValue: 'Then' })}</Badge>
              <select aria-label={t('rules.actionKind', { defaultValue: 'Action' })} value={actionKind} onChange={(e) => setActionKind(e.target.value as CorrelationAction['kind'])} className={cn(selectCls, 'w-auto flex-1')}>
                <option value="advance-shipment-state">{t('rules.a.shipment', { defaultValue: 'Move a shipment to a state' })}</option>
                <option value="set-bin-status">{t('rules.a.bin', { defaultValue: 'Set a bin’s status' })}</option>
                <option value="emit-alert">{t('rules.a.alert', { defaultValue: 'Raise an alert' })}</option>
                <option value="notify-webhook">{t('rules.a.webhook', { defaultValue: 'Send a webhook (Slack, Teams, …)' })}</option>
                <option value="call-outbound">{t('rules.a.outbound', { defaultValue: 'Send an update through a stream' })}</option>
                <option value="set-zone-status">{t('rules.a.zone', { defaultValue: 'Set a facility status' })}</option>
              </select>
            </div>
            {actionKind === 'advance-shipment-state' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="a-state" label={t('rules.f.state', { defaultValue: 'New state' })}>
                  <select id="a-state" value={shipmentTo} onChange={(e) => setShipmentTo(e.target.value as ShipmentState)} className={cn(selectCls, 'capitalize')}>
                    {SHIPMENT_STATE_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </Field>
                <Field id="a-door" label={t('rules.f.doorOptional', { defaultValue: 'Only at door (id)' })}><Input id="a-door" inputMode="numeric" value={actionDoorId} onChange={(e) => setActionDoorId(e.target.value)} placeholder={t('rules.optionalPlaceholder', { defaultValue: 'Optional' })} /></Field>
              </div>
            )}
            {actionKind === 'set-bin-status' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="a-bin" label={t('rules.f.bin', { defaultValue: 'Bin code' })}><Input id="a-bin" dir="ltr" value={binExternalCode} onChange={(e) => setBinExternalCode(e.target.value)} placeholder="BIN-007" /></Field>
                <Field id="a-binstatus" label={t('rules.f.binStatus', { defaultValue: 'Status' })}>
                  <select id="a-binstatus" value={binStatus} onChange={(e) => setBinStatus(e.target.value as BinStatus)} className={cn(selectCls, 'capitalize')}>
                    {BIN_STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
            {actionKind === 'emit-alert' && (
              <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <Field id="a-level" label={t('rules.f.level', { defaultValue: 'Level' })}>
                  <select id="a-level" value={alertLevel} onChange={(e) => setAlertLevel(e.target.value as AlertLevel)} className={selectCls}>
                    <option value="info">{t('rules.level.info', { defaultValue: 'Info' })}</option>
                    <option value="warn">{t('rules.level.warn', { defaultValue: 'Warning' })}</option>
                    <option value="critical">{t('rules.level.critical', { defaultValue: 'Critical' })}</option>
                  </select>
                </Field>
                <Field id="a-msg" label={t('rules.f.message', { defaultValue: 'Message' })}><Input id="a-msg" value={alertTemplate} onChange={(e) => setAlertTemplate(e.target.value)} placeholder={t('rules.messagePlaceholder', { defaultValue: 'Tag {tagId} entered {shapeId}' })} /></Field>
              </div>
            )}
            {actionKind === 'notify-webhook' && (
              <div className="space-y-3">
                <Field id="a-url" label={t('rules.f.webhookUrl', { defaultValue: 'Webhook URL' })}><Input id="a-url" dir="ltr" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" className="font-mono text-sm" /></Field>
                <Field id="a-body" label={t('rules.f.body', { defaultValue: 'Message body (JSON)' })}>
                  <textarea id="a-body" dir="ltr" rows={3} value={webhookBody} onChange={(e) => setWebhookBody(e.target.value)} className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                </Field>
              </div>
            )}
            {actionKind === 'call-outbound' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="a-stream" label={t('rules.f.streamId', { defaultValue: 'Stream id' })}><Input id="a-stream" inputMode="numeric" value={outboundStreamId} onChange={(e) => setOutboundStreamId(e.target.value)} placeholder="3" /></Field>
                <Field id="a-method" label={t('integrations.rest.method', { defaultValue: 'Method' })}>
                  <select id="a-method" value={outboundMethod} onChange={(e) => setOutboundMethod(e.target.value as typeof outboundMethod)} className={cn(selectCls, 'font-mono')}>
                    <option value="POST">POST</option>
                    <option value="PATCH">PATCH</option>
                    <option value="PUT">PUT</option>
                  </select>
                </Field>
              </div>
            )}
            {actionKind === 'set-zone-status' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="a-zone" label={t('rules.f.facilityId', { defaultValue: 'Facility id' })}><Input id="a-zone" inputMode="numeric" value={zoneId} onChange={(e) => setZoneId(e.target.value)} placeholder="1" /></Field>
                <Field id="a-zstatus" label={t('rules.f.statusText', { defaultValue: 'Status' })}><Input id="a-zstatus" value={zoneStatus} onChange={(e) => setZoneStatus(e.target.value)} placeholder="alert" /></Field>
              </div>
            )}
          </div>

          <Field id="r-cooldown" label={t('rules.f.cooldown', { defaultValue: 'Wait between fires (seconds)' })}>
            <Input id="r-cooldown" type="number" min={0} value={cooldownSec} onChange={(e) => setCooldownSec(e.target.value)} className="sm:max-w-[12rem]" />
          </Field>

          <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm" aria-live="polite">
            <p className="text-xs font-medium text-muted-foreground">{t('rules.preview', { defaultValue: 'This rule reads' })}</p>
            <p className="mt-1">{preview ?? <span className="text-muted-foreground">{t('rules.previewIncomplete', { defaultValue: 'Fill in the highlighted fields to see the rule.' })}</span>}</p>
          </div>
        </form>
        <div className="space-y-3 border-t px-6 py-4">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" form="rule-form" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
              {t('rules.createButton', { defaultValue: 'Turn rule on' })}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
