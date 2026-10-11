/**
 * Layout step — "Full map" mode. A diagram of where everything floats,
 * and per widget its slot (KPI strip / Insights / Hidden at first —
 * `layout.mapSlots`, see src/lib/reports/map-layout.ts) and order. The
 * full map is built around a facility map & list; when the report has
 * none this offers one (one click when the report's source suggests it).
 */

import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, EyeOff, Gauge, Info, List, MapPinned, Palette, Plus, Sparkles, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { canSitOnMap, mapExplorer, mapSlotOf } from '@/lib/reports/map-layout'
import { readExplorerBindings } from '@/lib/reports/explorer-spec'
import { facilityEntityName } from '@/lib/reports/facility-sources'
import type { MapSlot, ReportSpecV2, ReportWidgetV2, WidgetKindV2 } from '@/lib/reports/v2-types'
import { useWizard } from '../wizard-state'
import { useWidgetKindLabel } from '../widget-kinds'
import { useExplorerActions, useExplorerData, useExplorerSuggestion } from '../use-explorer-setup'

const SLOTS: Array<{ id: MapSlot; icon: LucideIcon; key: string; fallback: string }> = [
  { id: 'kpi', icon: Gauge, key: 'reports.wizard.mapLayout.slot.kpi', fallback: 'Key numbers' },
  { id: 'insights', icon: Sparkles, key: 'reports.wizard.mapLayout.slot.insights', fallback: 'Insights' },
  { id: 'hidden', icon: EyeOff, key: 'reports.wizard.mapLayout.slot.hidden', fallback: 'Hidden at first' },
]

const isNumber = (k: WidgetKindV2) => k === 'kpi' || k === 'bigValue'

export function MapLayoutEditor({ preview, kindIcon }: { preview: ReportSpecV2; kindIcon: Partial<Record<WidgetKindV2, LucideIcon>> }) {
  const { t } = useTranslation()
  const kindLabel = useWidgetKindLabel()
  const { draft, update, goTo } = useWizard()
  const { sourceHints, zones, dataLinks } = useExplorerData()
  const { defaultZone, addExplorer } = useExplorerActions(zones)
  const hasAnyExplorer = draft.extraWidgets.some((w) => w.kind === 'facilityExplorer')
  const suggestion = useExplorerSuggestion({ sourceId: draft.sourceRef?.id, hasExplorer: hasAnyExplorer, sourceHints, dataLinks, defaultZone })

  const hidden = new Set(draft.hiddenWidgetIds)
  const shown: ReportSpecV2 = { ...preview, widgets: (preview.widgets ?? []).filter((w) => !hidden.has(w.id)) }
  const explorer = mapExplorer(shown)
  const widgets = [...(shown.widgets ?? [])]
    .filter(canSitOnMap)
    .sort((a, b) => (a.order ?? a.position?.y ?? 0) - (b.order ?? b.position?.y ?? 0))
  const slotOf = (w: ReportWidgetV2) => mapSlotOf(w, draft.layout)
  const count = (slot: MapSlot) => widgets.filter((w) => slotOf(w) === slot).length

  const setSlot = (w: ReportWidgetV2, slot: MapSlot) =>
    update({ layout: { ...(draft.layout ?? { kind: 'map' }), mapSlots: { ...(draft.layout?.mapSlots ?? {}), [w.id]: slot } } })

  // Order: only the author's own widgets move (generated ones are fixed).
  const extraIdx = (id: string) => draft.extraWidgets.findIndex((x) => x.id === id)
  const move = (w: ReportWidgetV2, dir: -1 | 1) => {
    const list = widgets.filter((x) => extraIdx(x.id) >= 0)
    const i = list.findIndex((x) => x.id === w.id)
    const other = list[i + dir]
    if (!other) return
    const next = [...draft.extraWidgets]
    const a = extraIdx(w.id)
    const b = extraIdx(other.id)
    ;[next[a], next[b]] = [next[b], next[a]]
    next.forEach((x, j) => (x.order = 20 + j))
    update({ extraWidgets: next })
  }
  const movable = widgets.filter((x) => extraIdx(x.id) >= 0)

  const explorerTitle = explorer
    ? explorer.title || (() => {
        const tab = readExplorerBindings(explorer).tabs[0]
        return tab ? tab.title || facilityEntityName(tab.entity, tab.label) : ''
      })()
    : ''

  return (
    <div className="space-y-4">
      {!explorer && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
          <MapPinned className="h-5 w-5 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 flex-1 text-xs">
            <div className="font-medium text-foreground">
              {t('reports.wizard.mapLayout.needsExplorer', { defaultValue: 'A full map is built around a facility map & list' })}
            </div>
            <div className="text-muted-foreground">
              {hasAnyExplorer
                ? t('reports.wizard.mapLayout.finishExplorer', { defaultValue: 'Pick its facility and what it lists in the Widgets step.' })
                : t('reports.wizard.mapLayout.addExplorerHint', { defaultValue: 'Its list floats on the left, the picked record on the right, and your other widgets around it.' })}
            </div>
          </div>
          {suggestion ? (
            <Button size="sm" className="h-8" onClick={() => addExplorer(suggestion.bindings, suggestion.name)}>
              <Plus className="h-3.5 w-3.5" />
              {t('reports.wizard.mapLayout.addSuggested', { name: suggestion.name, defaultValue: 'Add a map & list of {{name}}' })}
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-8" onClick={() => goTo('widgets')}>
              {hasAnyExplorer
                ? t('reports.wizard.mapLayout.goWidgets', { defaultValue: 'Go to Widgets' })
                : t('reports.wizard.mapLayout.setUp', { defaultValue: 'Set one up in Widgets' })}
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),minmax(0,1.1fr)]">
        <MapSchematic list={explorerTitle} kpis={count('kpi')} insights={count('insights')} ready={Boolean(explorer)} />

        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('reports.wizard.mapLayout.widgets', { defaultValue: 'Where each widget goes' })}
          </div>
          {widgets.length === 0 ? (
            <p className="rounded-md border-2 border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              {t('reports.wizard.mapLayout.noWidgets', { defaultValue: 'No other widgets — the map and its list fill the page. Add KPIs or charts in the Widgets step.' })}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {widgets.map((w) => {
                const Icon = kindIcon[w.kind] ?? Palette
                const slot = slotOf(w)
                const mi = movable.findIndex((x) => x.id === w.id)
                return (
                  <li key={w.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-2 py-1.5">
                    <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-[10rem] flex-1">
                      <span className="block truncate text-xs font-medium">{w.title || kindLabel(w.kind)}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">{kindLabel(w.kind)}</span>
                    </span>
                    <div className="inline-flex shrink-0 rounded-md border border-border p-0.5" role="radiogroup" aria-label={t('reports.wizard.mapLayout.slotFor', { name: w.title || kindLabel(w.kind), defaultValue: 'Where {{name}} goes' })}>
                      {SLOTS.map((s) => {
                        const disabled = s.id === 'kpi' && !isNumber(w.kind)
                        const active = slot === s.id
                        const SIcon = s.icon
                        return (
                          <button
                            key={s.id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            disabled={disabled}
                            onClick={() => setSlot(w, s.id)}
                            title={disabled ? t('reports.wizard.mapLayout.kpiOnly', { defaultValue: 'Only KPIs and big values fit the number strip' }) : undefined}
                            className={cn(
                              'inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                              active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                            )}
                          >
                            <SIcon className="h-3 w-3" aria-hidden />
                            <span className="hidden sm:inline">{t(s.key, { defaultValue: s.fallback })}</span>
                          </button>
                        )
                      })}
                    </div>
                    {mi >= 0 && (
                      <div className="flex shrink-0">
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={mi === 0} onClick={() => move(w, -1)} aria-label={t('reports.builderWidgetMoveUp', { defaultValue: 'Move up' })}>
                          <ArrowUp className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={mi === movable.length - 1} onClick={() => move(w, 1)} aria-label={t('reports.builderWidgetMoveDown', { defaultValue: 'Move down' })}>
                          <ArrowDown className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      <p className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {t('reports.wizard.mapLayout.viewerHint', {
          defaultValue: 'Viewers can switch to the page layout from the header and turn any panel or widget on or off. Exports and PDFs always use the page layout.',
        })}
      </p>
    </div>
  )
}

/** A to-scale sketch of the full-map page. */
function MapSchematic({ list, kpis, insights, ready }: { list: string; kpis: number; insights: number; ready: boolean }) {
  const { t } = useTranslation()
  const block = 'absolute rounded-md border bg-card/95 shadow-sm'
  return (
    <figure className="space-y-1.5">
      <div
        className="relative aspect-[16/10] overflow-hidden rounded-lg border bg-muted"
        style={{
          backgroundImage: 'linear-gradient(hsl(var(--border)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
        aria-hidden
      >
        <div className="absolute inset-[18%] rounded-md border-2 border-dashed border-primary/30 bg-primary/5" />
        <div className={cn(block, 'inset-x-[3%] top-[4%] h-[9%]')} />
        {kpis > 0 && (
          <div className="absolute inset-x-[3%] top-[16%] flex h-[9%] gap-[1.5%]">
            {Array.from({ length: Math.min(kpis, 5) }, (_, i) => (
              <div key={i} className="h-full w-[15%] rounded-md border bg-card/95 shadow-sm" />
            ))}
          </div>
        )}
        <div className={cn(block, 'start-[3%] w-[26%] bottom-[4%] flex flex-col gap-[6%] p-[2%]', ready ? 'border-primary/50' : 'border-dashed opacity-60')} style={{ top: kpis > 0 ? '28%' : '16%' }}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-[6%] rounded-sm bg-muted" />
          ))}
        </div>
        {insights > 0 && (
          <div className={cn(block, 'end-[3%] w-[28%] bottom-[4%] flex flex-col gap-[4%] p-[2%]')} style={{ top: kpis > 0 ? '28%' : '16%' }}>
            {Array.from({ length: Math.min(insights, 3) }, (_, i) => (
              <div key={i} className="flex-1 rounded-sm bg-muted" />
            ))}
          </div>
        )}
        <div className="absolute bottom-[4%] start-1/2 h-[6%] w-[16%] -translate-x-1/2 rounded-md border bg-card/95 shadow-sm rtl:translate-x-1/2" />
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <List className="h-3 w-3" aria-hidden />
          {ready ? list : t('reports.wizard.mapLayout.noList', { defaultValue: 'No map & list yet' })}
        </span>
        <span className="inline-flex items-center gap-1">
          <Gauge className="h-3 w-3" aria-hidden />
          {t('reports.wizard.mapLayout.kpiCount', { count: kpis, defaultValue: '{{count}} key numbers' })}
        </span>
        <span className="inline-flex items-center gap-1">
          <Sparkles className="h-3 w-3" aria-hidden />
          {t('reports.wizard.mapLayout.insightCount', { count: insights, defaultValue: '{{count}} insights' })}
        </span>
      </figcaption>
    </figure>
  )
}
