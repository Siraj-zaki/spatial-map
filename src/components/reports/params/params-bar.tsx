import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'zustand'
import { ChevronDown, ChevronUp, Filter, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ReportRuntimeStore } from '@/lib/reports/report-runtime-store'
import { ParamInput } from './param-input'
import { resolveParamOptions } from './resolve-options'

/**
 * Viewer's parameter bar. Collapsed by default — shows a one-line
 * chip strip summarising active params. Expanded reveals every
 * declared param as its typed input.
 *
 * Wires directly into the runtime store, so an expanded change kicks
 * the store's `setParam(id, value, 'user')` which persists to URL +
 * schedules re-runs of dependent queries.
 */
export function ParamsBar({ store }: { store: ReportRuntimeStore }) {
  const { t } = useTranslation()
  const spec = useStore(store, (s) => s.spec)
  const params = useStore(store, (s) => s.params)
  // Bar starts expanded — a viewer opened for the first time should
  // immediately see which filters are available, not a collapsed
  // one-line chip strip that hides them behind a click.
  const [open, setOpen] = useState(true)

  const declared = spec.params ?? []
  const activeCount = useMemo(
    () => declared.filter((p) => params[p.id]?.userSet).length,
    [declared, params],
  )

  if (declared.length === 0) return null

  const handleResetAll = () => store.getState().resetAll()

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/40 transition-colors"
        aria-expanded={open}
      >
        <Filter className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">
          {t('reports.params.bar.summary', {
            count: declared.length,
            active: activeCount,
            defaultValue: '{{count}} filters · {{active}} active',
          })}
        </span>
        <div className="flex-1 min-w-0 flex gap-1 items-center overflow-hidden">
          {declared
            .filter((p) => params[p.id]?.userSet)
            .slice(0, 4)
            .map((p) => (
              <Chip key={p.id} label={p.label ?? p.id} value={params[p.id]?.value} />
            ))}
          {activeCount > 4 && (
            <span className="text-xs text-muted-foreground">
              {t('reports.params.bar.moreChips', { count: activeCount - 4, defaultValue: '+{{count}} more' })}
            </span>
          )}
        </div>
        {activeCount > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              handleResetAll()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                handleResetAll()
              }
            }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" />
            {t('reports.params.resetAll', { defaultValue: 'Reset all' })}
          </span>
        )}
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="border-t border-border p-3">
          <ParamFields store={store} />
        </div>
      )}
    </div>
  )
}

/**
 * Every declared param's input, wrapped in a row (the bar) or stacked
 * (`stacked` — the full-map layout's Filters popover).
 */
export function ParamFields({ store, stacked = false }: { store: ReportRuntimeStore; stacked?: boolean }) {
  const spec = useStore(store, (s) => s.spec)
  const params = useStore(store, (s) => s.params)
  const queryResults = useStore(store, (s) => s.queryResults)
  const queryPhase = useStore(store, (s) => s.queryPhase)
  const queryErrors = useStore(store, (s) => s.queryErrors)
  return (
    <div className={stacked ? 'flex flex-col gap-3' : 'flex flex-wrap gap-4'}>
      {(spec.params ?? []).map((p) => {
        const resolved = resolveParamOptions(p, queryResults, queryPhase, queryErrors)
        return (
          <div key={p.id} className={cn('flex flex-col gap-1', !stacked && 'min-w-[10rem]')}>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {p.label ?? p.id}
            </label>
            <ParamInput
              param={p}
              value={params[p.id]?.value}
              userSet={Boolean(params[p.id]?.userSet)}
              onChange={(v) => store.getState().setParam(p.id, v, 'user')}
              onReset={() => store.getState().resetParam(p.id)}
              optionsResolved={resolved.options}
              optionsLoading={resolved.loading}
              optionsError={resolved.error}
            />
          </div>
        )
      })}
    </div>
  )
}

/** How many params the viewer has set, for summaries outside the bar. */
export function useActiveParamCount(store: ReportRuntimeStore): number {
  const spec = useStore(store, (s) => s.spec)
  const params = useStore(store, (s) => s.params)
  return useMemo(() => (spec.params ?? []).filter((p) => params[p.id]?.userSet).length, [spec.params, params])
}

/** Compact rendering of one active param — shown inside the collapsed strip. */
function Chip({ label, value }: { label: string; value: unknown }) {
  const display = useMemo(() => formatChipValue(value), [value])
  return (
    <span
      className={cn(
        'text-xs px-2 py-0.5 rounded border border-border bg-background',
        'inline-flex items-center gap-1 max-w-[10rem]',
      )}
    >
      <span className="text-muted-foreground truncate">{label}:</span>
      <span className="font-medium truncate">{display}</span>
    </span>
  )
}

function formatChipValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (Array.isArray(v)) return v.length === 0 ? '—' : `${v.length} selected`
  if (typeof v === 'object') {
    const r = v as { start?: string; end?: string; low?: number; high?: number }
    if (r.start !== undefined || r.end !== undefined) return `${r.start ?? '—'} → ${r.end ?? '—'}`
    if (r.low !== undefined || r.high !== undefined) return `${r.low ?? '—'} … ${r.high ?? '—'}`
    return JSON.stringify(v)
  }
  return String(v)
}
