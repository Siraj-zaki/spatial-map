/**
 * Sidebar section listing every configured DataSource. One-click
 * re-run for REST sources (file sources show a hint about re-picking
 * the file instead). Lives at the bottom of the idle-mode side panel,
 * right below the Style Rules section.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Copy,
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Label } from '@/components/ui/label'
import {
  Section,
  matchesWorkspaceQuery,
  useWorkspaceQuery,
} from '@/components/side-panel'
import { apiDb } from '@/lib/api-db'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { type DataSource, type WebhookSourceConfig } from '@/lib/db'
import { useApiQuery } from '@/lib/useApiQuery'
import {
  rerunDataSource,
  RerunError,
  deleteBinSource,
  updateBinSource,
  getMergeMode,
  setMergeMode,
  isIntegrationLinkedError,
  formatIntegrationLinkedMessage,
  type MergeMode,
} from '@/lib/data-link'

export function DataSourcesSection({ zoneId = null }: { zoneId?: number | null } = {}) {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const allSourcesQuery = useApiQuery(
    () => apiDb.dataSources.toArray().then((rows) => rows.sort((a, b) => a.name.localeCompare(b.name))),
    ['dataSources', tenantId],
    // Event-driven: fetch once on mount and refresh only when a mutation
    // invalidates the dataSources namespace. No timer polling.
    { intervalMs: 0 },
  )
  const allSources = allSourcesQuery.data ?? []
  const query = useWorkspaceQuery()
  // Warehouse-scoped visibility. When an active warehouse is set, hide
  // sources bound to a DIFFERENT warehouse — a user editing Airport
  // should not see (or accidentally rerun) sources that only exist for
  // Hospital. Sources with `zoneId === undefined` are treated as
  // "unscoped / tenant-global" and stay visible everywhere (that's what
  // pre-scope sources look like on old data).
  const sources = allSources
    .filter((s) => {
      if (zoneId === null || zoneId === undefined) return true
      if (s.zoneId === undefined || s.zoneId === null) return true
      return s.zoneId === zoneId
    })
    .filter((s) => matchesWorkspaceQuery(s.name, query))
  const [busyId, setBusyId] = useState<number | null>(null)
  const [errors, setErrors] = useState<Map<number, string>>(new Map())
  // Drop the whole section while a non-empty query has zero matches —
  // same pattern as the saved-shape sections. With no query the
  // section keeps rendering so the empty-state hint stays discoverable.
  if (query.trim().length > 0 && sources.length === 0) return null

  const handleRerun = async (source: DataSource) => {
    if (source.id === undefined) return
    setBusyId(source.id)
    setErrors((m) => {
      const next = new Map(m)
      next.delete(source.id!)
      return next
    })
    try {
      await rerunDataSource(source)
    } catch (err) {
      const msg = err instanceof RerunError ? err.message : (err as Error).message
      setErrors((m) => new Map(m).set(source.id!, msg))
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (id: number) => {
    if (
      !confirm(
        t('integrations.confirmDelete', {
          defaultValue:
            'Delete this integration and every row/file/event it ingested? This cannot be undone.',
        }),
      )
    ) {
      return
    }
    setErrors((m) => {
      const next = new Map(m)
      next.delete(id)
      return next
    })
    try {
      await deleteBinSource(id)
    } catch (err) {
      const msg = isIntegrationLinkedError(err)
        ? formatIntegrationLinkedMessage(err, t)
        : (err as Error).message
      setErrors((m) => new Map(m).set(id, msg))
    }
  }

  return (
    <Section title="Data sources" icon={Cloud}>
      {sources.length === 0 && (
        <div className="px-3 py-3 text-[11px] text-muted-foreground border border-dashed rounded-md text-center">
          No sources yet. Import data (file or URL) to add one.
        </div>
      )}

      <div className="space-y-1">
        {sources.map((source) => (
          <DataSourceRow
            key={source.id}
            source={source}
            busy={busyId === source.id}
            error={errors.get(source.id ?? -1) ?? null}
            onRerun={() => void handleRerun(source)}
            onDelete={() => source.id !== undefined && void handleDelete(source.id)}
          />
        ))}
      </div>
    </Section>
  )
}

function DataSourceRow({
  source,
  busy,
  error,
  onRerun,
  onDelete,
}: {
  source: DataSource
  busy: boolean
  error: string | null
  onRerun: () => void
  onDelete: () => void
}) {
  const canRerun = source.kind === 'rest' || source.kind === 'webhook'
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleScheduleChange = async (next: DataSource['schedule']) => {
    if (source.id === undefined) return
    await updateBinSource(source.id, { schedule: next, updatedAt: new Date() })
  }
  const handleIntervalChange = async (sec: number) => {
    if (source.id === undefined) return
    await updateBinSource(source.id, {
      // Floor at 5 seconds. Any lower and the fetch → parse → import
      // pipeline can't keep up on a busy machine and the scheduler
      // starts stacking runs.
      intervalSeconds: Math.max(5, sec | 0),
      updatedAt: new Date(),
    })
  }
  const currentMergeMode = getMergeMode(source)
  const handleMergeModeChange = async (mode: MergeMode) => {
    await setMergeMode(source, mode)
  }

  /**
   * Preset choices for the schedule dropdown. `on-load` and `manual`
   * stay as first-class options; every other value collapses onto
   * `schedule: 'interval'` with a specific `intervalSeconds`. `custom`
   * keeps whatever the user typed into the number field.
   */
  const INTERVAL_PRESETS: Array<{ value: string; label: string; seconds?: number }> = [
    { value: 'manual', label: 'Never — manual only' },
    { value: 'on-load', label: 'Once, on page load' },
    { value: '5', label: 'Every 5 seconds', seconds: 5 },
    { value: '15', label: 'Every 15 seconds', seconds: 15 },
    { value: '30', label: 'Every 30 seconds', seconds: 30 },
    { value: '60', label: 'Every 1 minute', seconds: 60 },
    { value: '300', label: 'Every 5 minutes', seconds: 300 },
    { value: '900', label: 'Every 15 minutes', seconds: 900 },
    { value: 'custom', label: 'Custom interval…' },
  ]
  // Match the current schedule + interval to a preset value. When
  // schedule is `interval` and the number is one of the presets, pick
  // that value; otherwise fall through to `custom` so the number field
  // stays editable.
  const currentPreset = (() => {
    if (source.schedule === 'manual') return 'manual'
    if (source.schedule === 'on-load') return 'on-load'
    const s = String(source.intervalSeconds ?? '')
    const hit = INTERVAL_PRESETS.find((p) => p.value === s)
    return hit ? hit.value : 'custom'
  })()

  const onPresetChange = async (value: string) => {
    if (value === 'manual') {
      await handleScheduleChange('manual')
      return
    }
    if (value === 'on-load') {
      await handleScheduleChange('on-load')
      return
    }
    if (value === 'custom') {
      // Flip to interval mode with the current custom value (or 60s
      // default). The custom input becomes editable underneath so the
      // user can dial it in.
      if (source.id === undefined) return
      await updateBinSource(source.id, {
        schedule: 'interval',
        intervalSeconds: source.intervalSeconds ?? 60,
        updatedAt: new Date(),
      })
      return
    }
    const secs = Number(value)
    if (Number.isFinite(secs) && source.id !== undefined) {
      await updateBinSource(source.id, {
        schedule: 'interval',
        intervalSeconds: secs,
        updatedAt: new Date(),
      })
    }
  }
  const status = source.lastResult
  const webhookConfig =
    source.kind === 'webhook'
      ? (source.config as unknown as WebhookSourceConfig)
      : null
  const webhookUrl = webhookConfig
    ? `${webhookConfig.workerBaseUrl.replace(/\/+$/, '')}/api/v1/webhooks/${webhookConfig.sourceToken}`
    : null
  const handleCopyUrl = async () => {
    if (!webhookUrl) return
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="border rounded-md overflow-hidden bg-background/40">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded((v) => !v)
          }
        }}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-accent/30 transition-colors cursor-pointer"
      >
        <div className="flex items-center justify-center w-6 h-6 rounded bg-primary/10 text-primary flex-shrink-0">
          <KindIcon kind={source.kind} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{source.name}</div>
          <div className="text-[10px] text-muted-foreground font-mono flex items-center gap-1.5 truncate">
            <span className="uppercase">{source.kind}</span>
            {source.schedule === 'interval' && source.intervalSeconds && (
              <span className="text-primary/80">
                · every {formatInterval(source.intervalSeconds)}
              </span>
            )}
            {source.schedule === 'on-load' && (
              <span className="text-primary/80">· on load</span>
            )}
            {source.schedule === 'interval' &&
              source.kind === 'rest' &&
              currentMergeMode === 'replace-all' && (
                <span className="text-primary/70">· replace-all</span>
              )}
            {status && (
              <span
                className={
                  status === 'ok'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : status === 'error'
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-amber-600 dark:text-amber-400'
                }
              >
                · {status}
              </span>
            )}
            {source.lastRunAt && (
              <span className="text-muted-foreground/70 truncate">
                · {timeAgo(source.lastRunAt)}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRerun()
          }}
          disabled={!canRerun || busy}
          className="flex items-center justify-center w-6 h-6 rounded hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={
            source.kind === 'webhook'
              ? 'Drain webhook queue'
              : canRerun
                ? 'Re-run import'
                : 'Re-pick the file from the import wizard to refresh this source'
          }
        >
          {busy ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="flex items-center justify-center w-6 h-6 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
          title="Delete source"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
      {expanded && canRerun && (
        <div className="border-t bg-background/60 px-2.5 py-2 space-y-2">
          <div className="space-y-1">
            <Label className="text-[10px]">Refresh schedule</Label>
            <select
              value={currentPreset}
              onChange={(e) => void onPresetChange(e.target.value)}
              className="h-7 w-full text-xs rounded border border-input bg-background px-1.5"
            >
              {INTERVAL_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            {currentPreset === 'custom' && (
              <div className="pt-1">
                <Label className="text-[10px]">Custom interval (seconds)</Label>
                <input
                  type="number"
                  min={5}
                  value={source.intervalSeconds ?? 60}
                  onChange={(e) => void handleIntervalChange(Number(e.target.value))}
                  className="h-7 w-full text-xs font-mono rounded border border-input bg-background px-1.5"
                />
                <p className="text-[10px] text-muted-foreground pt-0.5">
                  Minimum 5s. The scheduler runs while at least one tab is
                  open; picks up where it left off on tab reopen.
                </p>
              </div>
            )}
          </div>
          {source.kind === 'rest' && (
            <div className="space-y-1">
              <Label className="text-[10px]">When new data arrives</Label>
              <select
                value={currentMergeMode}
                onChange={(e) => void handleMergeModeChange(e.target.value as MergeMode)}
                className="h-7 w-full text-xs rounded border border-input bg-background px-1.5"
              >
                <option value="replace-all">
                  Replace all — endpoint is source of truth (no duplicates)
                </option>
                <option value="append">
                  Append — every poll adds rows (for event feeds)
                </option>
              </select>
              <p className="text-[10px] text-muted-foreground pt-0.5">
                {currentMergeMode === 'append'
                  ? 'Existing rows are kept; each poll appends new ones. Use for event/delta APIs.'
                  : 'Existing rows are purged before each poll. Use when the endpoint returns the CURRENT full state (assets, patients, staff).'}
              </p>
            </div>
          )}
          {webhookConfig && webhookUrl && (
            <div className="space-y-1.5 pt-1">
              <Label className="text-[10px]">Webhook URL</Label>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 text-[10px] font-mono px-2 py-1 rounded border border-input bg-background/80 truncate" title={webhookUrl}>
                  {webhookUrl}
                </code>
                <button
                  type="button"
                  onClick={handleCopyUrl}
                  className="flex items-center justify-center w-6 h-6 rounded hover:bg-accent transition-colors"
                  title="Copy URL"
                >
                  {copied ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>
              {webhookConfig.lastEventAt && (
                <div className="text-[10px] text-muted-foreground">
                  Last event: {timeAgo(webhookConfig.lastEventAt)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="px-2 py-1.5 border-t bg-rose-500/5 text-[10px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5">
          <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
          <span className="whitespace-pre-line break-words" title={error}>{error}</span>
        </div>
      )}
    </div>
  )
}

function KindIcon({ kind }: { kind: DataSource['kind'] }) {
  if (kind === 'rest' || kind === 'webhook') return <Cloud className="w-3 h-3" />
  if (kind === 'ok' as never) return <CheckCircle2 className="w-3 h-3" />
  return <FileText className="w-3 h-3" />
}

function timeAgo(date: Date | string): string {
  const t = typeof date === 'string' ? Date.parse(date) : date.getTime()
  const diff = Date.now() - t
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

/** Friendly "1m" / "30s" / "5m" pill for the header row. */
function formatInterval(sec: number): string {
  if (sec >= 3600) return `${Math.round(sec / 3600)}h`
  if (sec >= 60) return `${Math.round(sec / 60)}m`
  return `${sec}s`
}
