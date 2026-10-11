/**
 * External REST polling binding editor for a thing-type table.
 *
 * Backed by the authed `/api/v1/tables/:id/source` endpoints (POST
 * set, GET read, DELETE clear). The backend stores the binding in
 * `data_sources.config` JSONB (`pollUrl`, `pollHeaders`, `pollJsonPath`,
 * `pollEntityKeyField`, `pollFieldMapping`, `pollPositionLatField`,
 * `pollPositionLngField`) + `interval_seconds`. The polling worker
 * (`backend/internal/polling/worker.go`) ticks every 60s, queries for
 * due sources with non-empty `pollUrl`, fetches the URL, walks the
 * JSON path, applies the field mapping, and upserts rows via the
 * shared `handlers.UpsertTableRow` helper — same validation + audit
 * trail as bearer-token writes.
 *
 * The panel opens with a status line (connected or not, interval, last
 * run + result), then the form. Save/stop report through toasts; stop
 * asks first (it silently ends ingestion). Owner/admin only — other
 * roles see the config read-only. `bare` drops the built-in heading when
 * the host card already has one; `fields` feeds suggestions for the
 * mapping's internal side.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, Loader2, Plus, Trash2 } from 'lucide-react'
import { apiDelete, apiGet, apiPost } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { QueryError } from '@/components/feedback/query-error'
import { RoleGate } from '@/components/feedback/role-gate'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { toast } from '@/lib/toast-store'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import type { FieldDefinitionResponse } from '@/lib/tables-client'

interface ExternalSourceConfig {
  pollUrl: string
  pollHeaders: Record<string, string>
  pollJsonPath: string
  pollEntityKeyField: string
  pollFieldMapping: Record<string, string>
  pollPositionLatField: string
  pollPositionLngField: string
  intervalSeconds: number
  lastRunAt?: string
  lastResult?: string
}

const EMPTY: ExternalSourceConfig = {
  pollUrl: '',
  pollHeaders: {},
  pollJsonPath: '',
  pollEntityKeyField: 'id',
  pollFieldMapping: {},
  pollPositionLatField: '',
  pollPositionLngField: '',
  intervalSeconds: 60,
}

const MIN_INTERVAL = 30

export function TableExternalSourcePanel({
  tableId,
  bare = false,
  fields,
}: {
  tableId: number
  bare?: boolean
  fields?: FieldDefinitionResponse[]
}) {
  const { t, i18n } = useTranslation()
  const { canManage } = useWorkspaceRole()
  const [reloadToken, setReloadToken] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; cfg: ExternalSourceConfig; error: unknown } | null>(null)
  const [cfg, setCfg] = useState<ExternalSourceConfig>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)

  const queryKey = `${tableId}:${reloadToken}`
  useEffect(() => {
    let cancelled = false
    apiGet<ExternalSourceConfig>(`/tables/${tableId}/source`)
      .then((res) => {
        if (cancelled) return
        // An unbound table reports interval 0 — show the default instead.
        const next = { ...EMPTY, ...res, intervalSeconds: res.intervalSeconds >= MIN_INTERVAL ? res.intervalSeconds : EMPTY.intervalSeconds }
        setLoaded({ key: queryKey, cfg: next, error: null })
        setCfg(next)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 404 means no binding yet — that's the normal empty state.
        const notFound = (err as { status?: number }).status === 404
        setLoaded({ key: queryKey, cfg: EMPTY, error: notFound ? null : err })
        setCfg(EMPTY)
      })
    return () => {
      cancelled = true
    }
  }, [tableId, queryKey])

  const saved = loaded?.cfg ?? EMPTY
  const connected = saved.pollUrl.trim() !== ''
  const failed = !!saved.lastResult && /error|fail|status [45]\d\d/i.test(saved.lastResult)

  const validate = (): string | null => {
    const url = cfg.pollUrl.trim()
    if (!url) return t('tables.poll.urlRequired', { defaultValue: 'Enter the URL to poll.' })
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error()
    } catch {
      return t('tables.poll.urlInvalid', { defaultValue: 'Enter a full http:// or https:// URL.' })
    }
    if (!(cfg.intervalSeconds >= MIN_INTERVAL)) {
      return t('tables.poll.intervalMin', { defaultValue: 'Poll at most every {{n}} seconds.', n: MIN_INTERVAL })
    }
    return null
  }

  const save = async () => {
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const clean = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([k]) => k.trim() !== ''))
      await apiPost(`/tables/${tableId}/source`, {
        pollUrl: cfg.pollUrl.trim(),
        pollHeaders: clean(cfg.pollHeaders),
        pollJsonPath: cfg.pollJsonPath.trim(),
        pollEntityKeyField: cfg.pollEntityKeyField.trim() || 'id',
        pollFieldMapping: clean(cfg.pollFieldMapping),
        pollPositionLatField: cfg.pollPositionLatField.trim(),
        pollPositionLngField: cfg.pollPositionLngField.trim(),
        intervalSeconds: cfg.intervalSeconds,
      })
      toast.success(t('tables.poll.saved', { defaultValue: 'Polling saved' }), {
        description: t('integrations.externalSource.saved', { defaultValue: 'Saved. The worker picks up changes within 60s.' }),
      })
      setReloadToken((n) => n + 1)
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const stop = async () => {
    setSaving(true)
    setError(null)
    try {
      await apiDelete(`/tables/${tableId}/source`)
      setConfirmStop(false)
      toast.success(t('integrations.externalSource.cleared', { defaultValue: 'Polling stopped.' }))
      setReloadToken((n) => n + 1)
    } catch (err: unknown) {
      setError((err as Error).message)
      setConfirmStop(false)
    } finally {
      setSaving(false)
    }
  }

  const heading = bare ? null : (
    <div>
      <h3 className="text-sm font-semibold">{t('integrations.externalSource.title', { defaultValue: 'External REST polling' })}</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">
        {t('integrations.externalSource.description', {
          defaultValue:
            'Bind this table to an external REST endpoint. The polling worker fetches the URL on a schedule, walks a JSON path to find the array of items, and upserts them as rows.',
        })}
      </p>
    </div>
  )

  if (loaded === null) {
    return (
      <div className="space-y-4" aria-busy>
        {heading}
        <Skeleton className="h-12 w-full rounded-lg" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-9 md:col-span-2" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      </div>
    )
  }
  if (loaded?.error) {
    return (
      <div className="space-y-4">
        {heading}
        <QueryError
          compact
          error={loaded.error}
          onRetry={() => setReloadToken((n) => n + 1)}
          what={t('tables.poll.what', { defaultValue: 'the polling settings' })}
        />
      </div>
    )
  }

  const disabled = !canManage || saving
  const fieldListId = `poll-fields-${tableId}`

  return (
    <div className="space-y-5">
      {heading}

      {/* Status */}
      <div className="flex items-start gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <span
          className={cn(
            'mt-1.5 h-2 w-2 shrink-0 rounded-full',
            !connected ? 'bg-muted-foreground/40' : failed ? 'bg-danger' : 'bg-success',
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">
            {!connected
              ? t('tables.poll.off', { defaultValue: 'Not polling' })
              : t('tables.poll.on', { defaultValue: 'Polling every {{n}} s', n: saved.intervalSeconds })}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {!connected ? (
              t('tables.poll.offHint', { defaultValue: 'Fill in the URL below and save to start.' })
            ) : saved.lastRunAt ? (
              <span title={fullTime(saved.lastRunAt, i18n.language)}>
                {t('tables.poll.lastRun', { defaultValue: 'Last run {{when}}', when: relativeTime(saved.lastRunAt, i18n.language) })}
              </span>
            ) : (
              t('tables.poll.notRunYet', { defaultValue: 'Waiting for the first run (within a minute).' })
            )}
          </p>
          {connected && saved.lastResult && (
            <code className={cn('mt-1.5 block break-words font-mono text-xs', failed ? 'text-danger' : 'text-muted-foreground')} dir="ltr">
              {saved.lastResult}
            </code>
          )}
        </div>
      </div>

      <fieldset disabled={disabled} className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor={`poll-url-${tableId}`}>{t('integrations.externalSource.url', { defaultValue: 'Poll URL' })}</Label>
          <Input
            id={`poll-url-${tableId}`}
            type="url"
            dir="ltr"
            value={cfg.pollUrl}
            onChange={(e) => setCfg((c) => ({ ...c, pollUrl: e.target.value }))}
            placeholder="https://api.example.com/v1/items"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`poll-interval-${tableId}`}>
            {t('integrations.externalSource.interval', { defaultValue: 'Interval (seconds)' })}
          </Label>
          <Input
            id={`poll-interval-${tableId}`}
            type="number"
            min={MIN_INTERVAL}
            step={30}
            value={cfg.intervalSeconds}
            onChange={(e) => setCfg((c) => ({ ...c, intervalSeconds: Number(e.target.value) || 0 }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`poll-key-${tableId}`}>
            {t('tables.poll.keyField', { defaultValue: 'Row key field in the response' })}
          </Label>
          <Input
            id={`poll-key-${tableId}`}
            dir="ltr"
            value={cfg.pollEntityKeyField}
            onChange={(e) => setCfg((c) => ({ ...c, pollEntityKeyField: e.target.value }))}
            placeholder="id"
          />
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor={`poll-jsonpath-${tableId}`}>
            {t('tables.poll.jsonPath', { defaultValue: 'Where the items are (JSON path)' })}
          </Label>
          <Input
            id={`poll-jsonpath-${tableId}`}
            dir="ltr"
            value={cfg.pollJsonPath}
            onChange={(e) => setCfg((c) => ({ ...c, pollJsonPath: e.target.value }))}
            placeholder="data.items"
          />
          <p className="text-xs text-muted-foreground">
            {t('integrations.externalSource.jsonPathHint', {
              defaultValue: 'Dotted path through nested objects. Empty means the root is the array.',
            })}
          </p>
        </div>

        <div className="md:col-span-2">
          <KeyValueEditor
            label={t('integrations.externalSource.headers', { defaultValue: 'Headers' })}
            addLabel={t('tables.poll.addHeader', { defaultValue: 'Add header' })}
            placeholderKey="Authorization"
            placeholderValue="Bearer …"
            map={cfg.pollHeaders}
            onChange={(m) => setCfg((c) => ({ ...c, pollHeaders: m }))}
          />
        </div>
        <div className="md:col-span-2">
          <KeyValueEditor
            label={t('integrations.externalSource.fieldMapping', { defaultValue: 'Field mapping (external → internal)' })}
            addLabel={t('tables.poll.addMapping', { defaultValue: 'Add mapping' })}
            placeholderKey="external_name"
            placeholderValue="field_key"
            valueListId={fields?.length ? fieldListId : undefined}
            map={cfg.pollFieldMapping}
            onChange={(m) => setCfg((c) => ({ ...c, pollFieldMapping: m }))}
          />
          {fields && fields.length > 0 && (
            <datalist id={fieldListId}>
              {fields.map((f) => (
                <option key={f.id} value={f.fieldKey}>
                  {f.fieldLabel}
                </option>
              ))}
            </datalist>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`poll-lat-${tableId}`}>{t('integrations.externalSource.positionLat', { defaultValue: 'Position lat field' })}</Label>
          <Input
            id={`poll-lat-${tableId}`}
            dir="ltr"
            value={cfg.pollPositionLatField}
            onChange={(e) => setCfg((c) => ({ ...c, pollPositionLatField: e.target.value }))}
            placeholder="lat"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`poll-lng-${tableId}`}>{t('integrations.externalSource.positionLng', { defaultValue: 'Position lng field' })}</Label>
          <Input
            id={`poll-lng-${tableId}`}
            dir="ltr"
            value={cfg.pollPositionLngField}
            onChange={(e) => setCfg((c) => ({ ...c, pollPositionLngField: e.target.value }))}
            placeholder="lng"
          />
        </div>
      </fieldset>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 whitespace-pre-line break-words">{error}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <RoleGate allowed={canManage} message={t('common.needsAdmin', { defaultValue: 'Only workspace owners and admins can do this.' })}>
          <Button onClick={() => void save()} disabled={disabled}>
            {saving && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
            {connected
              ? t('tables.poll.saveChanges', { defaultValue: 'Save changes' })
              : t('tables.poll.start', { defaultValue: 'Start polling' })}
          </Button>
        </RoleGate>
        {connected && canManage && (
          <Button variant="ghost" className="text-muted-foreground hover:bg-danger/10 hover:text-danger" onClick={() => setConfirmStop(true)} disabled={saving}>
            {t('integrations.externalSource.clear', { defaultValue: 'Stop polling' })}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={t('tables.poll.stopTitle', { defaultValue: 'Stop polling?' })}
        description={t('tables.poll.stopBody', {
          defaultValue: 'New items from this URL stop arriving. Rows already imported stay, and you can start again any time.',
        })}
        confirmLabel={t('integrations.externalSource.clear', { defaultValue: 'Stop polling' })}
        onConfirm={() => void stop()}
        busy={saving}
      />
    </div>
  )
}

function KeyValueEditor({
  label,
  addLabel,
  placeholderKey,
  placeholderValue,
  valueListId,
  map,
  onChange,
}: {
  label: string
  addLabel: string
  placeholderKey: string
  placeholderValue: string
  valueListId?: string
  map: Record<string, string>
  onChange: (m: Record<string, string>) => void
}) {
  const { t } = useTranslation()
  const entries = Object.entries(map)
  const update = (oldKey: string, newKey: string, val: string) => {
    // Rebuild in order so renaming a key doesn't move its row.
    const next: Record<string, string> = {}
    for (const [k, v] of entries) {
      if (k === oldKey) next[newKey] = val
      else next[k] = v
    }
    onChange(next)
  }
  const remove = (key: string) => {
    const next = { ...map }
    delete next[key]
    onChange(next)
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {/* One blank row at a time — keys are the map's identity. */}
        <Button size="sm" variant="ghost" className="h-7" onClick={() => onChange({ ...map, '': '' })} type="button" disabled={'' in map}>
          <Plus className="h-3.5 w-3.5" />
          {addLabel}
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          {t('tables.poll.none', { defaultValue: 'None yet.' })}
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-2">
              <Input value={k} dir="ltr" placeholder={placeholderKey} onChange={(e) => update(k, e.target.value, v)} className="flex-1" aria-label={`${label} ${i + 1}`} />
              <span className="text-muted-foreground rtl:rotate-180" aria-hidden>→</span>
              <Input
                value={v}
                dir="ltr"
                placeholder={placeholderValue}
                list={valueListId}
                onChange={(e) => update(k, k, e.target.value)}
                className="flex-1"
                aria-label={`${label} ${i + 1} ${t('tables.poll.value', { defaultValue: 'value' })}`}
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9 shrink-0 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                onClick={() => remove(k)}
                type="button"
                title={t('common.remove', { defaultValue: 'Remove' })}
                aria-label={t('common.remove', { defaultValue: 'Remove' })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
