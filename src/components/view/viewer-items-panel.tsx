/**
 * The facility viewer's "Live data" panel — the report map's list + key
 * numbers, built from the map's own data layers instead of report queries:
 *
 * - One count card per visible data layer (rows on the floors shown, after
 *   the layer's filters), with its most common status values. A card is the
 *   tab: it switches the list below to that layer.
 * - The list: a status dot in the row's style-rule colour (else the layer's
 *   colour), the row's label (`fieldMapping.labelField`, else its key) and a
 *   one-line summary; search narrows it. A click focuses the row on the map
 *   (the same path as the Layers panel's "Show on map"); the focused row is
 *   highlighted.
 * - Rows come from the same `layer-rows` query (same key) the map draws, so
 *   the panel adds no requests and refreshes with the Live pill.
 * - Collapses to a pill; `L` toggles it; remembered per browser. Starts
 *   closed below `md`, where it would cover the map.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { List, PanelLeftClose, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CountUp } from '@/components/count-up'
import type { DataLinkConfig, DataLinkFilter, EntityState } from '@/lib/db'
import type { StyleRule } from '@/lib/style-rules'
import { fetchLayerRows } from '@/lib/data-link/layer-rows'
import { activeFloorKey, evaluateDataLinkFilter, passesFloorScope, type ActiveFloors } from '@/lib/data-link/filter-evaluator'
import { compileEntityRules } from '@/lib/data-link/style-rule-evaluator'
import { useLayerPollMs } from '@/lib/data-link/layer-refresh'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { useApiQuery } from '@/lib/useApiQuery'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/utils'

const OPEN_KEY = 'sgv-viewer-items'
const LIST_CAP = 200
const STATUS_FIELDS = ['status', 'state', 'signal'] as const
const SUMMARY_FIELDS = ['status', 'state', 'zone', 'location', 'floor', 'read_point'] as const

/** One layer's rows on the floors shown — the map's own query (same key, shared cache). */
function useLayerRowsFor(config: DataLinkConfig, activeFloors: ActiveFloors, filter: DataLinkFilter | null | undefined, liveFloorPlanIds: ReadonlySet<number>) {
  const tenantId = useCurrentTenantId()
  const pollMs = useLayerPollMs()
  const query = useApiQuery(
    () => fetchLayerRows(config, { filter, activeFloorPlanId: activeFloors }),
    ['layer-rows', tenantId, config.sourceId ?? `stream:${config.streamId}`, activeFloorKey(activeFloors), JSON.stringify(filter ?? null)],
    { intervalMs: pollMs },
  )
  const scope = config.fieldMapping.floorScope
  const rows = useMemo(
    () =>
      (query.data ?? []).filter(
        (e) => (!filter || evaluateDataLinkFilter(e.payload, filter)) && passesFloorScope(e.payload, scope, activeFloors ?? null, liveFloorPlanIds),
      ),
    [query.data, filter, scope, activeFloors, liveFloorPlanIds],
  )
  return { rows, loading: query.data === undefined }
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v)
}

function statusField(rows: readonly EntityState[]): string | null {
  const sample = rows.slice(0, 20)
  return STATUS_FIELDS.find((f) => sample.some((r) => str(r.payload[f]) !== '')) ?? null
}

/** Each layer reports its rows up (a hook per layer, so layers can come and go). */
function LayerRowsProbe({
  config,
  activeFloors,
  filter,
  liveFloorPlanIds,
  onRows,
}: {
  config: DataLinkConfig
  activeFloors: ActiveFloors
  filter: DataLinkFilter | null | undefined
  liveFloorPlanIds: ReadonlySet<number>
  onRows: (id: number, rows: readonly EntityState[] | null) => void
}) {
  const { rows, loading } = useLayerRowsFor(config, activeFloors, filter, liveFloorPlanIds)
  const id = config.id as number
  useEffect(() => {
    onRows(id, loading ? null : rows)
  }, [id, rows, loading, onRows])
  useEffect(() => () => onRows(id, null), [id, onRows])
  return null
}

export function ViewerItemsPanel({
  configs,
  activeFloors,
  configFilters,
  liveFloorPlanIds,
  styleRules,
  focusedKey,
  onFocus,
}: {
  configs: readonly DataLinkConfig[]
  activeFloors: ActiveFloors
  configFilters?: Readonly<Record<number, DataLinkFilter | null>>
  liveFloorPlanIds: ReadonlySet<number>
  styleRules: ReadonlyArray<StyleRule>
  /** The focused data-link row (`configId:entityKey`), highlighted in the list. */
  focusedKey: string | null
  onFocus: (config: DataLinkConfig, entity: EntityState) => void
}) {
  const { t, i18n } = useTranslation()
  const narrow = useMediaQuery('(max-width: 767px)')
  const [open, setOpenRaw] = useState(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) return false
    try {
      return localStorage.getItem(OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  const setOpen = (next: boolean) => {
    setOpenRaw(next)
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0')
    } catch {
      /* a remembered choice is a convenience */
    }
  }
  // `L` toggles the panel (as on a report map), never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'l' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return
      setOpenRaw((o) => {
        try {
          localStorage.setItem(OPEN_KEY, o ? '0' : '1')
        } catch {
          /* convenience only */
        }
        return !o
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const layers = useMemo(() => configs.filter((c) => c.id !== undefined && (c.sourceId != null || c.streamId != null)), [configs])
  const [rowsBy, setRowsBy] = useState<Record<number, readonly EntityState[] | null>>({})
  const onRows = useMemo(
    () => (id: number, rows: readonly EntityState[] | null) =>
      setRowsBy((prev) => (prev[id] === rows ? prev : { ...prev, [id]: rows })),
    [],
  )
  const [tabId, setTabId] = useState<number | null>(null)
  const tab = layers.find((c) => c.id === tabId) ?? layers[0]
  const [q, setQ] = useState('')

  const nf = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language])
  const total = layers.reduce((n, c) => n + (rowsBy[c.id as number]?.length ?? 0), 0)

  const tabRows = tab ? rowsBy[tab.id as number] ?? null : null
  const rules = useMemo(() => (tab ? compileEntityRules(styleRules, tab.styleRuleIds ?? []) : null), [styleRules, tab])
  const labelKey = tab?.fieldMapping.labelField
  const list = useMemo(() => {
    if (!tabRows) return []
    const needle = q.trim().toLowerCase()
    const rows = needle
      ? tabRows.filter((r) => r.entityKey.toLowerCase().includes(needle) || Object.values(r.payload).some((v) => str(v).toLowerCase().includes(needle)))
      : tabRows
    return [...rows].sort((a, b) => (str(labelKey ? a.payload[labelKey] : '') || a.entityKey).localeCompare(str(labelKey ? b.payload[labelKey] : '') || b.entityKey, i18n.language, { numeric: true }))
  }, [tabRows, q, labelKey, i18n.language])

  if (layers.length === 0) return null

  const probes = layers.map((c) => (
    <LayerRowsProbe key={c.id} config={c} activeFloors={activeFloors} filter={configFilters?.[c.id as number]} liveFloorPlanIds={liveFloorPlanIds} onRows={onRows} />
  ))

  if (!open) {
    return (
      <>
        {probes}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          className="absolute start-4 top-[4.25rem] z-10 h-9 gap-2 rounded-full border-border/60 bg-background/70 pl-3 pr-3 shadow-lg shadow-black/5 backdrop-blur-xl hover:bg-background/90"
          aria-label={t('view.items.open', { defaultValue: 'Show live data' })}
        >
          <List className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-medium">{t('view.items.title', { defaultValue: 'Live data' })}</span>
          <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{nf.format(total)}</span>
        </Button>
      </>
    )
  }

  return (
    <>
      {probes}
      <section
        aria-label={t('view.items.title', { defaultValue: 'Live data' })}
        className={cn(
          'sgv-rise absolute start-4 top-[4.25rem] z-10 flex w-[min(20rem,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/80 shadow-xl shadow-black/10 backdrop-blur-xl',
          narrow ? 'bottom-4' : 'bottom-32',
        )}
      >
        <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <List className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold">{t('view.items.title', { defaultValue: 'Live data' })}</h2>
          <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{nf.format(total)}</span>
          <Button variant="ghost" size="icon" className="ms-auto h-7 w-7" onClick={() => setOpen(false)} aria-label={t('view.items.close', { defaultValue: 'Hide live data' })} title={t('view.items.closeHint', { defaultValue: 'Hide (L)' })}>
            <PanelLeftClose className="h-4 w-4 rtl:-scale-x-100" />
          </Button>
        </header>

        {/* Count cards — one per layer; the card is the tab. */}
        <div className="grid shrink-0 grid-cols-2 gap-1.5 overflow-y-auto border-b border-border/60 p-2" style={{ maxHeight: '11.5rem' }}>
          {layers.map((c) => {
            const rows = rowsBy[c.id as number]
            const on = c.id === tab?.id
            const sf = rows ? statusField(rows) : null
            const top = sf && rows ? topValues(rows, sf, 2) : []
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setTabId(c.id as number)
                  setQ('')
                }}
                aria-pressed={on}
                className={cn(
                  'min-w-0 rounded-xl border px-2.5 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  on ? 'border-primary/60 bg-primary/10' : 'border-border/60 bg-card/60 hover:bg-accent',
                )}
              >
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c.style.defaultColor ?? 'hsl(var(--primary))' }} aria-hidden />
                  <span className="truncate">{c.name}</span>
                </span>
                <span className="block text-lg font-semibold leading-tight tabular-nums">{rows ? <CountUp value={rows.length} /> : '–'}</span>
                {top.length > 0 && (
                  <span className="block truncate text-[10px] text-muted-foreground">{top.map(([v, n]) => `${nf.format(n)} ${v}`).join(' · ')}</span>
                )}
              </button>
            )
          })}
        </div>

        <div className="relative shrink-0 px-2 pt-2">
          <Search className="pointer-events-none absolute start-4 top-1/2 mt-1 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('view.items.search', { name: tab?.name ?? '', defaultValue: 'Search {{name}}…' })}
            aria-label={t('view.items.search', { name: tab?.name ?? '', defaultValue: 'Search {{name}}…' })}
            className="h-8 w-full rounded-lg border bg-background/70 ps-7 pe-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-2" aria-label={tab?.name}>
          {tabRows === null ? (
            Array.from({ length: 6 }, (_, i) => <li key={i} className="h-10 animate-pulse rounded-lg bg-muted/60" />)
          ) : list.length === 0 ? (
            <li className="px-2 py-6 text-center text-xs text-muted-foreground">
              {q ? t('view.items.noMatch', { defaultValue: 'Nothing matches.' }) : t('view.items.empty', { defaultValue: 'No items on the floors shown.' })}
            </li>
          ) : (
            list.slice(0, LIST_CAP).map((r) => {
              const override = rules?.evaluate(r.payload)
              const color = override?.iconColor ?? override?.fillColor ?? tab?.style.defaultColor ?? 'hsl(var(--primary))'
              const title = (labelKey && str(r.payload[labelKey])) || r.entityKey
              const summary = SUMMARY_FIELDS.map((f) => str(r.payload[f]))
                .filter((v, i, all) => v !== '' && v !== title && all.indexOf(v) === i)
                .slice(0, 3)
                .join(' · ')
              const focused = focusedKey === `${tab?.id}:${r.entityKey}`
              return (
                <li key={r.entityKey}>
                  <button
                    type="button"
                    onClick={() => tab && onFocus(tab, r)}
                    aria-current={focused || undefined}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      focused ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-accent',
                    )}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-background" style={{ background: color }} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{title}</span>
                      {summary && <span className="block truncate text-[11px] text-muted-foreground">{summary}</span>}
                    </span>
                  </button>
                </li>
              )
            })
          )}
          {list.length > LIST_CAP && (
            <li className="px-2 py-2 text-center text-[11px] text-muted-foreground">
              {t('view.items.capped', { shown: nf.format(LIST_CAP), total: nf.format(list.length), defaultValue: 'Showing {{shown}} of {{total}} — search to narrow.' })}
            </li>
          )}
        </ul>
      </section>
    </>
  )
}

function topValues(rows: readonly EntityState[], field: string, n: number): [string, number][] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const v = str(r.payload[field])
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n)
}
