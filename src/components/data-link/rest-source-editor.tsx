/**
 * RestSourceEditor — create / edit a REST API integration.
 *
 * Three sections, top to bottom, in the order people fill them:
 *   1. Connection      name, method + URL, authentication (segmented),
 *                      plus a collapsed "Request options" (headers, POST
 *                      body, response format, JSON root path).
 *   2. Test            "Test connection" runs TWO checks:
 *                        - server-side (`POST /data-sources/test-rest`):
 *                          status, format, row count, columns, sample rows;
 *                        - browser-side (`fetchRestSource`): scheduled and
 *                          "Run now" syncs fetch FROM THE BROWSER, so an API
 *                          that our server can reach but that blocks the
 *                          browser (CORS) would test green and then fail
 *                          every sync. That case gets its own warning.
 *   3. Data & schedule what the rows are (entity kind) and when to sync
 *                      (manual / when a map opens / every N — presets).
 *
 * Saving validates name + http(s) URL, reports failures inline, toasts on
 * success. Closing with unsaved edits asks first.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, ChevronDown, CircleAlert, Loader2, Plus, TriangleAlert, Trash2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { EntityKindPicker } from '@/components/data-link/entity-kind-picker'
import { UncontrolledMaskedSecretInput } from '@/components/data-link/secret-input'
import { apiPost } from '@/lib/api-client'
import { createBinSource, fetchRestSource, updateBinSource, type RestSourceConfig } from '@/lib/data-link'
import type { DataSource } from '@/lib/db'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'

type AuthMode = 'none' | 'apiKey' | 'bearer' | 'custom'
type Schedule = NonNullable<DataSource['schedule']>

interface TestResponse {
  ok: boolean
  status: number
  statusText: string
  contentType: string
  bytes: number
  kind: string
  columns: string[]
  sampleRows: Array<Record<string, string>>
  rowRead: number
  errors: string[]
  fetchError?: string
  parseError?: string
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; server: TestResponse | null; serverError?: string; browserOk: boolean | null; browserError?: string }

const INTERVAL_PRESETS = [60, 300, 900, 3600]

/** The column the saved mapping matches rows on (`match.*`), if any. */
function mappedKey(source: DataSource | null): string {
  const fields = source?.mapping?.fields ?? {}
  return Object.entries(fields).find(([, target]) => String(target).startsWith('match.'))?.[0] ?? ''
}

/** Best guess at the column that identifies a row. */
function suggestRowKey(columns: string[]): string {
  const base = (c: string) => c.split('.').pop()!.toLowerCase()
  const exact = ['external_code', 'externalcode', 'entitykey', 'entity_key', 'id', 'code', 'key', 'sku', 'uuid']
  for (const want of exact) {
    const hit = columns.find((c) => base(c) === want)
    if (hit) return hit
  }
  return columns.find((c) => /(_id|id|_code|code)$/i.test(base(c))) ?? ''
}

export function RestSourceEditor({
  open,
  existing,
  onOpenChange,
}: {
  open: boolean
  existing: DataSource | null
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const cfg0 = (existing?.config ?? {}) as Partial<RestSourceConfig>

  const initial = useMemo(
    () => ({
      name: existing?.name ?? '',
      entityKind: existing?.entityKind ?? 'marker',
      url: cfg0.url ?? '',
      method: (cfg0.method ?? 'GET') as 'GET' | 'POST',
      authMode: (cfg0.authMode ?? 'none') as AuthMode,
      apiKey: cfg0.apiKey ?? '',
      bearerToken: cfg0.bearerToken ?? '',
      headers: cfg0.headers && Object.keys(cfg0.headers).length > 0
        ? Object.entries(cfg0.headers).map(([key, value]) => ({ key, value: String(value) }))
        : [],
      body: cfg0.body ?? '',
      responseFormat: (cfg0.responseFormat ?? 'auto') as 'auto' | 'json' | 'csv' | 'geojson',
      rootPath: cfg0.rootPath ?? '',
      rowKey: mappedKey(existing),
      schedule: (existing?.schedule ?? 'manual') as Schedule,
      intervalSeconds: existing?.intervalSeconds ?? 300,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [existing?.id],
  )

  const [form, setForm] = useState(initial)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))
  const [advancedOpen, setAdvancedOpen] = useState(
    initial.headers.length > 0 || initial.method === 'POST' || initial.rootPath !== '' || initial.responseFormat !== 'auto',
  )
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const dirty = JSON.stringify(form) !== JSON.stringify(initial)

  const buildConfig = (): RestSourceConfig => {
    const headers: Record<string, string> = {}
    for (const h of form.headers) if (h.key.trim()) headers[h.key.trim()] = h.value.trim()
    return {
      url: form.url.trim(),
      method: form.method,
      authMode: form.authMode,
      apiKey: form.authMode === 'apiKey' ? form.apiKey : undefined,
      bearerToken: form.authMode === 'bearer' ? form.bearerToken : undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: form.method === 'POST' && form.body.trim() !== '' ? form.body : undefined,
      responseFormat: form.responseFormat === 'auto' ? undefined : form.responseFormat,
      rootPath: form.rootPath.trim() !== '' ? form.rootPath.trim() : undefined,
    }
  }

  const urlError = (() => {
    const u = form.url.trim()
    if (!u) return t('integrations.rest.urlRequired', { defaultValue: 'Enter the API’s URL.' })
    try {
      const parsed = new URL(u)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch {
      return t('integrations.rest.urlInvalid', { defaultValue: 'Enter a full http:// or https:// URL.' })
    }
    return null
  })()

  const runTest = async () => {
    if (urlError) {
      setError(urlError)
      return
    }
    setError(null)
    setTest({ phase: 'running' })
    const cfg = buildConfig()
    let server: TestResponse | null = null
    let serverError: string | undefined
    try {
      server = await apiPost<TestResponse>('/data-sources/test-rest', {
        ...cfg,
        method: cfg.method ?? 'GET',
        authMode: cfg.authMode ?? 'none',
      })
    } catch (err) {
      serverError = (err as Error).message
    }
    // Syncs run in the browser — check it can fetch too (CORS).
    let browserOk: boolean | null = null
    let browserError: string | undefined
    if (server && !server.fetchError) {
      try {
        await fetchRestSource(cfg)
        browserOk = true
      } catch (err) {
        browserOk = false
        browserError = (err as Error).message
      }
    }
    setTest({ phase: 'done', server, serverError, browserOk, browserError })
    if (server?.columns?.length && !form.rowKey) set('rowKey', suggestRowKey(server.columns))
  }

  // Bring the result into view — it lands below the fold on short screens.
  const resultRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (test.phase === 'done') resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [test.phase])

  const save = async () => {
    if (!form.name.trim()) {
      setError(t('integrations.rest.nameRequired', { defaultValue: 'Give the integration a name.' }))
      return
    }
    if (urlError) {
      setError(urlError)
      return
    }
    if (!form.rowKey.trim()) {
      setError(t('integrations.rest.rowKeyRequired', { defaultValue: 'Pick the column that identifies each row — without it every row is skipped.' }))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const now = new Date()
      // Replace any previous match column; keep other mapped fields.
      const kept = Object.fromEntries(
        Object.entries(existing?.mapping?.fields ?? {}).filter(([, target]) => !String(target).startsWith('match.')),
      )
      const mapping = { ...(existing?.mapping ?? {}), fields: { ...kept, [form.rowKey.trim()]: 'match.externalCode' } }
      const patch = {
        name: form.name.trim(),
        entityKind: form.entityKind,
        config: { ...buildConfig() },
        mapping,
        schedule: form.schedule,
        intervalSeconds: form.schedule === 'interval' ? form.intervalSeconds : undefined,
        updatedAt: now,
      }
      if (existing?.id !== undefined) {
        await updateBinSource(existing.id, patch)
        toast.success(t('integrations.rest.saved', { defaultValue: '{{name}} saved', name: patch.name }))
      } else {
        await createBinSource({ ...patch, kind: 'rest', createdAt: now })
        toast.success(t('integrations.rest.created', { defaultValue: '{{name}} connected', name: patch.name }), {
          description: t('integrations.rest.createdBody', { defaultValue: 'Run it once to pull the first rows.' }),
        })
      }
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const requestClose = () => {
    if (saving) return
    if (dirty) setConfirmDiscard(true)
    else onOpenChange(false)
  }

  const authOptions: Array<{ value: AuthMode; label: string }> = [
    { value: 'none', label: t('integrations.rest.authNone', { defaultValue: 'None' }) },
    { value: 'apiKey', label: t('integrations.rest.authApiKey', { defaultValue: 'API key' }) },
    { value: 'bearer', label: t('integrations.rest.authBearer', { defaultValue: 'Bearer token' }) },
    { value: 'custom', label: t('integrations.rest.authCustom', { defaultValue: 'Custom headers' }) },
  ]
  const scheduleOptions: Array<{ value: Schedule; label: string; hint: string }> = [
    { value: 'manual', label: t('integrations.rest.scheduleManual', { defaultValue: 'Manually' }), hint: t('integrations.rest.scheduleManualHint', { defaultValue: 'Only when you press Run now.' }) },
    { value: 'on-load', label: t('integrations.rest.scheduleOnLoad', { defaultValue: 'When a map opens' }), hint: t('integrations.rest.scheduleOnLoadHint', { defaultValue: 'Fresh data each time someone opens a facility.' }) },
    { value: 'interval', label: t('integrations.rest.scheduleInterval', { defaultValue: 'On a timer' }), hint: t('integrations.rest.scheduleIntervalHint', { defaultValue: 'Repeats while a map is open.' }) },
  ]
  const fmtInterval = (s: number) =>
    s >= 3600
      ? t('integrations.rest.everyHours', { defaultValue: 'Every {{count}} h', count: s / 3600 })
      : t('integrations.rest.everyMinutes', { defaultValue: 'Every {{count}} min', count: Math.round(s / 60) })

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}>
        <DialogContent className="flex max-h-[92dvh] flex-col gap-0 p-0 sm:max-w-2xl">
          <DialogHeader className="border-b px-6 pb-4 pt-6">
            <DialogTitle>
              {existing
                ? t('integrations.rest.editTitle', { defaultValue: 'Edit REST API' })
                : t('integrations.rest.newTitle', { defaultValue: 'Connect a REST API' })}
            </DialogTitle>
            <DialogDescription>
              {t('integrations.rest.intro', { defaultValue: 'Pull JSON, GeoJSON or CSV from an HTTP endpoint and keep it in sync.' })}
            </DialogDescription>
          </DialogHeader>

          <form
            id="rest-source-form"
            className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-5"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            {/* 1 — Connection */}
            <Step n={1} title={t('integrations.rest.stepConnection', { defaultValue: 'Connection' })}>
              <div className="space-y-1.5">
                <Label htmlFor="rest-name">{t('integrations.rest.name', { defaultValue: 'Name' })}</Label>
                <Input id="rest-name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={t('integrations.rest.namePlaceholder', { defaultValue: 'e.g. WMS bin levels' })} maxLength={120} autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rest-url">{t('integrations.rest.url', { defaultValue: 'Endpoint' })}</Label>
                <div className="flex rounded-md shadow-sm">
                  <select
                    aria-label={t('integrations.rest.method', { defaultValue: 'Method' })}
                    value={form.method}
                    onChange={(e) => set('method', e.target.value as 'GET' | 'POST')}
                    className="h-9 rounded-s-md border border-e-0 border-input bg-muted/50 px-2.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                  <Input
                    id="rest-url"
                    dir="ltr"
                    value={form.url}
                    onChange={(e) => {
                      set('url', e.target.value)
                      setTest({ phase: 'idle' })
                    }}
                    placeholder="https://api.example.com/v1/items"
                    className="rounded-s-none font-mono text-sm shadow-none"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t('integrations.rest.auth', { defaultValue: 'Authentication' })}</Label>
                <div role="radiogroup" aria-label={t('integrations.rest.auth', { defaultValue: 'Authentication' })} className="flex w-fit flex-wrap gap-1 rounded-lg bg-muted p-1">
                  {authOptions.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={form.authMode === o.value}
                      onClick={() => set('authMode', o.value)}
                      className={cn(
                        'rounded-md px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        form.authMode === o.value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                {form.authMode === 'apiKey' && (
                  <UncontrolledMaskedSecretInput label="X-Api-Key" value={form.apiKey} onChange={(v) => set('apiKey', v)} placeholder={t('integrations.rest.apiKeyPlaceholder', { defaultValue: 'Paste the API key' })} />
                )}
                {form.authMode === 'bearer' && (
                  <UncontrolledMaskedSecretInput label="Authorization: Bearer" value={form.bearerToken} onChange={(v) => set('bearerToken', v)} placeholder={t('integrations.rest.bearerPlaceholder', { defaultValue: 'Paste the token' })} />
                )}
                {form.authMode === 'custom' && (
                  <p className="text-xs text-muted-foreground">{t('integrations.rest.customHint', { defaultValue: 'Add the headers your API expects under Request options.' })}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {t('integrations.rest.secretsHint', { defaultValue: 'Keys are stored with the integration and only sent to this endpoint.' })}
                </p>
              </div>

              <details
                className="group rounded-lg border"
                open={advancedOpen || form.authMode === 'custom'}
                onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
                  {t('integrations.rest.advanced', { defaultValue: 'Request options' })}
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
                </summary>
                <div className="space-y-4 border-t px-3 py-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>{t('integrations.rest.headers', { defaultValue: 'Headers' })}</Label>
                      <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => set('headers', [...form.headers, { key: '', value: '' }])}>
                        <Plus className="h-3.5 w-3.5" />
                        {t('integrations.rest.addHeader', { defaultValue: 'Add header' })}
                      </Button>
                    </div>
                    {form.headers.length === 0 ? (
                      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">{t('integrations.rest.noHeaders', { defaultValue: 'No extra headers.' })}</p>
                    ) : (
                      form.headers.map((h, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Input dir="ltr" value={h.key} onChange={(e) => set('headers', form.headers.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder={t('integrations.rest.headerName', { defaultValue: 'Header name' })} aria-label={t('integrations.rest.headerName', { defaultValue: 'Header name' })} className="flex-1 font-mono text-xs" />
                          <Input dir="ltr" value={h.value} onChange={(e) => set('headers', form.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={t('integrations.rest.headerValue', { defaultValue: 'Value' })} aria-label={t('integrations.rest.headerValue', { defaultValue: 'Value' })} className="flex-1 font-mono text-xs" />
                          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground hover:bg-danger/10 hover:text-danger" onClick={() => set('headers', form.headers.filter((_, j) => j !== i))} aria-label={t('common.remove', { defaultValue: 'Remove' })}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                  {form.method === 'POST' && (
                    <div className="space-y-1.5">
                      <Label htmlFor="rest-body">{t('integrations.rest.body', { defaultValue: 'Request body' })}</Label>
                      <textarea id="rest-body" dir="ltr" value={form.body} onChange={(e) => set('body', e.target.value)} rows={3} placeholder='{"query": "…"}' className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                    </div>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="rest-format">{t('integrations.rest.format', { defaultValue: 'Response format' })}</Label>
                      <select id="rest-format" value={form.responseFormat} onChange={(e) => set('responseFormat', e.target.value as typeof form.responseFormat)} className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                        <option value="auto">{t('integrations.rest.formatAuto', { defaultValue: 'Detect automatically' })}</option>
                        <option value="json">JSON</option>
                        <option value="geojson">GeoJSON</option>
                        <option value="csv">CSV</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="rest-root">{t('integrations.rest.rootPath', { defaultValue: 'Where the items are (JSON path)' })}</Label>
                      <Input id="rest-root" dir="ltr" value={form.rootPath} onChange={(e) => set('rootPath', e.target.value)} placeholder="data.items" className="font-mono text-sm" />
                    </div>
                  </div>
                </div>
              </details>
            </Step>

            {/* 2 — Test */}
            <Step n={2} title={t('integrations.rest.stepTest', { defaultValue: 'Test' })} hint={t('integrations.rest.stepTestHint', { defaultValue: 'Check we can reach it and see what comes back — before you save.' })}>
              <Button type="button" variant="outline" onClick={() => void runTest()} disabled={test.phase === 'running'}>
                {test.phase === 'running' ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Zap className="h-4 w-4" />}
                {test.phase === 'running' ? t('integrations.rest.testing', { defaultValue: 'Testing…' }) : t('integrations.rest.test', { defaultValue: 'Test connection' })}
              </Button>
              {test.phase === 'done' && (
                <div ref={resultRef}>
                  <TestResult test={test} />
                </div>
              )}
            </Step>

            {/* 3 — Data & schedule */}
            <Step n={3} title={t('integrations.rest.stepData', { defaultValue: 'Data & schedule' })}>
              <EntityKindPicker
                value={form.entityKind}
                onChange={(v) => set('entityKind', v)}
                columns={test.phase === 'done' ? test.server?.columns : undefined}
                label={t('integrations.rest.kind', { defaultValue: 'What kind of data is this?' })}
              />
              <div className="space-y-1.5">
                <Label htmlFor="rest-key">{t('integrations.rest.rowKey', { defaultValue: 'Row key' })}</Label>
                {test.phase === 'done' && (test.server?.columns?.length ?? 0) > 0 ? (
                  <select id="rest-key" dir="ltr" value={form.rowKey} onChange={(e) => set('rowKey', e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                    <option value="">{t('integrations.rest.rowKeyPick', { defaultValue: 'Choose a column…' })}</option>
                    {test.server!.columns.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                ) : (
                  <Input id="rest-key" dir="ltr" value={form.rowKey} onChange={(e) => set('rowKey', e.target.value)} placeholder="id" className="font-mono text-sm" />
                )}
                <p className="text-xs text-muted-foreground">
                  {t('integrations.rest.rowKeyHint', { defaultValue: 'The column that identifies each row. A row with a key that’s already stored updates it instead of adding a duplicate.' })}
                </p>
              </div>
              <div className="space-y-2">
                <Label>{t('integrations.rest.schedule', { defaultValue: 'Sync' })}</Label>
                <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
                  {scheduleOptions.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={form.schedule === o.value}
                      onClick={() => set('schedule', o.value)}
                      className={cn(
                        'rounded-lg border px-3 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        form.schedule === o.value ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent/50',
                      )}
                    >
                      <span className="block text-sm font-medium">{o.label}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{o.hint}</span>
                    </button>
                  ))}
                </div>
                {form.schedule === 'interval' && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {INTERVAL_PRESETS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => set('intervalSeconds', s)}
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs transition-colors',
                          form.intervalSeconds === s ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent',
                        )}
                      >
                        {fmtInterval(s)}
                      </button>
                    ))}
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      {t('integrations.rest.customSeconds', { defaultValue: 'or every' })}
                      <Input
                        type="number"
                        min={10}
                        value={form.intervalSeconds}
                        onChange={(e) => set('intervalSeconds', Math.max(10, Number(e.target.value) || 60))}
                        className="h-7 w-20 text-xs tabular-nums"
                        aria-label={t('integrations.rest.intervalSeconds', { defaultValue: 'Interval in seconds' })}
                      />
                      {t('integrations.rest.seconds', { defaultValue: 'seconds' })}
                    </span>
                  </div>
                )}
              </div>
            </Step>
          </form>

          <div className="space-y-3 border-t px-6 py-4">
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 break-words">{error}</span>
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={requestClose} disabled={saving}>
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button type="submit" form="rest-source-form" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
                {existing ? t('integrations.rest.saveChanges', { defaultValue: 'Save changes' }) : t('integrations.rest.connect', { defaultValue: 'Connect API' })}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={t('integrations.rest.discardTitle', { defaultValue: 'Discard your changes?' })}
        description={t('integrations.rest.discardBody', { defaultValue: 'What you entered for this API won’t be saved.' })}
        confirmLabel={t('integrations.rest.discard', { defaultValue: 'Discard' })}
        onConfirm={() => {
          setConfirmDiscard(false)
          onOpenChange(false)
        }}
      />
    </>
  )
}

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-x-4 gap-y-3 sm:grid-cols-[28px_minmax(0,1fr)]">
      <span className="hidden h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground sm:flex" aria-hidden>
        {n}
      </span>
      <div className="min-w-0 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {children}
      </div>
    </section>
  )
}

function TestResult({ test }: { test: Extract<TestState, { phase: 'done' }> }) {
  const { t } = useTranslation()
  const s = test.server
  if (!s || test.serverError || s.fetchError) {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">{t('integrations.rest.unreachable', { defaultValue: 'Couldn’t reach this endpoint' })}</p>
          <p className="mt-0.5 break-words text-xs text-muted-foreground" dir="ltr">{s?.fetchError ?? test.serverError}</p>
        </div>
      </div>
    )
  }
  if (s.parseError) {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">
            {t('integrations.rest.unreadable', { defaultValue: 'Reached it, but couldn’t read the response ({{type}})', type: s.contentType || s.kind })}
          </p>
          <p className="mt-0.5 break-words text-xs text-muted-foreground" dir="ltr">{s.parseError}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('integrations.rest.unreadableHint', { defaultValue: 'Try setting the response format or JSON path under Request options.' })}</p>
        </div>
      </div>
    )
  }
  const cols = s.columns.slice(0, 6)
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-sm">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium">
            {t('integrations.rest.connected', { defaultValue: 'Connected — {{count}} rows found', count: s.rowRead })}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {s.statusText.startsWith(String(s.status)) ? s.statusText : `${s.status} ${s.statusText}`} · {s.kind.toUpperCase()} · {t('integrations.rest.columnsCount', { defaultValue: '{{count}} columns', count: s.columns.length })}
          </p>
        </div>
      </div>
      {test.browserOk === false && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">{t('integrations.rest.corsTitle', { defaultValue: 'Your browser is blocked from this API' })}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('integrations.rest.corsBody', {
                defaultValue: 'Syncs run in the browser, so they’ll fail until the API allows requests from {{origin}} (CORS).',
                origin: window.location.origin,
              })}
            </p>
          </div>
        </div>
      )}
      {cols.length > 0 && s.sampleRows.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <p className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
            {t('integrations.rest.sample', { defaultValue: 'First rows' })}
            {s.columns.length > cols.length && ` · ${t('integrations.rest.moreColumns', { defaultValue: '+{{count}} more columns', count: s.columns.length - cols.length })}`}
          </p>
          <div className="max-h-48 overflow-auto">
            <table className="w-full text-xs" dir="ltr">
              <thead className="sticky top-0 bg-card">
                <tr>
                  {cols.map((c) => (
                    <th key={c} className="whitespace-nowrap border-b px-3 py-1.5 text-start font-medium text-muted-foreground">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.sampleRows.slice(0, 5).map((row, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {cols.map((c) => (
                      <td key={c} className="max-w-[160px] truncate whitespace-nowrap px-3 py-1.5 font-mono" title={row[c] ?? ''}>{row[c] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
