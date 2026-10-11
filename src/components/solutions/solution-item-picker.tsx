/**
 * Choose what a solution holds: facilities, reports, user tables and
 * integrations, one tab each, with search, per-tab select-all / clear,
 * and "Suggested" marks from the template's keywords.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, FileBarChart, Plug, Search, Sparkles, Table as TableIcon, Warehouse } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { matchesKeywords } from '@/lib/solution-templates'
import type { SolutionItems } from '@/lib/solutions-client'
import type { SolutionCatalog } from './use-solution-catalog'

type Tab = 'zones' | 'reports' | 'tables' | 'integrations'

interface Row {
  id: number
  name: string
  meta?: string
}

export function SolutionItemPicker({
  catalog,
  value,
  onChange,
  keywords = [],
}: {
  catalog: SolutionCatalog
  value: Required<SolutionItems>
  onChange: (next: Required<SolutionItems>) => void
  keywords?: string[]
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('zones')
  const [query, setQuery] = useState('')

  const zoneNames = useMemo(() => new Map(catalog.zones.map((z) => [z.id!, z.name])), [catalog.zones])
  const rows: Record<Tab, Row[]> = useMemo(
    () => ({
      zones: catalog.zones.map((z) => ({ id: z.id!, name: z.name, meta: z.address || undefined })),
      reports: catalog.reports.map((r) => ({ id: r.id, name: r.name, meta: r.zoneId ? zoneNames.get(r.zoneId) : t('solutions.sharedReport', { defaultValue: 'All facilities' }) })),
      tables: catalog.tables.map((s) => ({ id: s.id!, name: s.name, meta: s.zoneId ? zoneNames.get(s.zoneId) : undefined })),
      integrations: catalog.integrations.map((s) => ({ id: s.id!, name: s.name, meta: s.kind.toUpperCase() + (s.zoneId && zoneNames.get(s.zoneId) ? ` · ${zoneNames.get(s.zoneId)}` : '') })),
    }),
    [catalog, zoneNames, t],
  )

  // Tables and integrations share the data-source id set.
  const selected = (k: Tab) => new Set(k === 'zones' ? value.zoneIds : k === 'reports' ? value.reportIds : value.dataSourceIds)
  const setFor = (k: Tab, ids: Set<number>) => {
    if (k === 'zones') onChange({ ...value, zoneIds: [...ids] })
    else if (k === 'reports') onChange({ ...value, reportIds: [...ids] })
    else {
      // Keep the other data-source tab's picks.
      const other = new Set(rows[k === 'tables' ? 'integrations' : 'tables'].map((r) => r.id))
      const keep = value.dataSourceIds.filter((id) => other.has(id))
      onChange({ ...value, dataSourceIds: [...new Set([...keep, ...ids])] })
    }
  }

  const tabs: { id: Tab; label: string; icon: typeof Warehouse }[] = [
    { id: 'zones', label: t('solutions.kind.facilities', { defaultValue: 'Facilities' }), icon: Warehouse },
    { id: 'reports', label: t('solutions.kind.reports', { defaultValue: 'Reports' }), icon: FileBarChart },
    { id: 'tables', label: t('solutions.kind.tables', { defaultValue: 'Tables' }), icon: TableIcon },
    { id: 'integrations', label: t('solutions.kind.integrations', { defaultValue: 'Integrations' }), icon: Plug },
  ]
  const countIn = (k: Tab) => {
    const sel = selected(k)
    return rows[k].filter((r) => sel.has(r.id)).length
  }

  const sel = selected(tab)
  const q = query.trim().toLowerCase()
  const shown = rows[tab].filter((r) => !q || r.name.toLowerCase().includes(q) || (r.meta ?? '').toLowerCase().includes(q))
  const allShownOn = shown.length > 0 && shown.every((r) => sel.has(r.id))

  return (
    <div className="space-y-3">
      <div role="tablist" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:grid-cols-4">
        {tabs.map((tb) => {
          const n = countIn(tb.id)
          const active = tab === tb.id
          return (
            <button
              key={tb.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(tb.id)}
              className={cn(
                'flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <tb.icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{tb.label}</span>
              <span className={cn('rounded-full px-1.5 text-[10px] tabular-nums', n > 0 ? 'bg-primary text-primary-foreground' : 'bg-background/60')}>
                {n}/{rows[tb.id].length}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('solutions.searchItems', { defaultValue: 'Search…' })}
            aria-label={t('solutions.searchItems', { defaultValue: 'Search…' })}
            className="h-8 w-full rounded-md border bg-card ps-8 pe-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <button
          type="button"
          disabled={shown.length === 0}
          onClick={() => {
            const next = new Set(sel)
            for (const r of shown) {
              if (allShownOn) next.delete(r.id)
              else next.add(r.id)
            }
            setFor(tab, next)
          }}
          className="shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
        >
          {allShownOn ? t('solutions.clearShown', { defaultValue: 'Clear' }) : t('solutions.selectShown', { defaultValue: 'Select all' })}
        </button>
      </div>

      {catalog.isLoading ? (
        <div className="space-y-1.5" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-md" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {q
            ? t('solutions.noMatch', { query: query.trim(), defaultValue: 'Nothing matches “{{query}}”' })
            : t(`solutions.emptyKind.${tab}`, { defaultValue: 'Nothing here yet in this workspace.' })}
        </p>
      ) : (
        <ul className="sgv-fade divide-y rounded-lg border" role="listbox" aria-multiselectable="true">
          {shown.map((r) => {
            const on = sel.has(r.id)
            const suggested = !on && matchesKeywords(`${r.name} ${r.meta ?? ''}`, keywords)
            return (
              <li key={r.id} role="option" aria-selected={on}>
                <button
                  type="button"
                  onClick={() => {
                    const next = new Set(sel)
                    if (on) next.delete(r.id)
                    else next.add(r.id)
                    setFor(tab, next)
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-start transition-colors hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none"
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background',
                    )}
                    aria-hidden
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span dir="auto" className="block truncate text-sm font-medium">{r.name}</span>
                    {r.meta && <span dir="auto" className="block truncate text-xs text-muted-foreground">{r.meta}</span>}
                  </span>
                  {suggested && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      <Sparkles className="h-3 w-3" aria-hidden />
                      {t('solutions.suggested', { defaultValue: 'Suggested' })}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
