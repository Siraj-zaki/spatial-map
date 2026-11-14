/**
 * MasterReportDialog — set up (or update) a facility's master report:
 * its name, which data layers it shows and in what order, per layer a
 * count card and a status chart (pick the field), the viewer filters
 * (fields the chosen layers share, with how each is shown) and whether it
 * opens on the map or the page.
 *
 * Opens with the stored setup; layers linked since then come in ticked with
 * a "New" badge. Saving updates the same report and keeps what an author
 * added in the builder (src/lib/reports/master-report.ts).
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Loader2, Map as MapIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  chartFields,
  initialMasterSetup,
  loadMasterInputs,
  masterFilterCandidates,
  saveMasterReport,
  type MasterInputs,
  type MasterReportSetup,
  type MasterReportText,
} from '@/lib/reports/master-report'
import type { Report } from '@/lib/reports-client'
import type { ViewerFilterKind } from '@/lib/reports/v2-types'

const KIND_LABEL: Record<ViewerFilterKind, string> = {
  dropdown: 'Dropdown',
  multi: 'Pick several',
  buttons: 'Buttons',
  search: 'Search box',
  dateRange: 'Date range',
  yesNo: 'Yes / No',
}
const FILTERS_SHOWN = 6
const SELECT = 'h-8 rounded-md border bg-background px-2 text-xs'

export function MasterReportDialog({
  open,
  onOpenChange,
  zoneId,
  facilityName,
  text,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  zoneId: number
  facilityName: string
  text: MasterReportText
  onSaved: (report: Report) => void
}) {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState<{ inputs: MasterInputs; fresh: Set<number> } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [setup, setSetup] = useState<MasterReportSetup | null>(null)
  const [moreFilters, setMoreFilters] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  // Mounted only while open, so this loads once per opening.
  useEffect(() => {
    let cancelled = false
    loadMasterInputs(zoneId)
      .then((inputs) => {
        if (cancelled) return
        const { setup, fresh } = initialMasterSetup(inputs, text.name)
        setLoaded({ inputs, fresh })
        setSetup(setup)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [zoneId, text.name])

  const inputs = loaded?.inputs
  const chosen = useMemo(() => setup?.layers.map((l) => l.linkId) ?? [], [setup])
  const candidates = useMemo(() => (inputs ? masterFilterCandidates(inputs, chosen) : []), [inputs, chosen])

  if (!open) return null
  const patch = (p: Partial<MasterReportSetup>) => setSetup((s) => (s ? { ...s, ...p } : s))
  const fieldsOf = (linkId: number) => {
    const l = inputs?.links.find((x) => x.id === linkId)
    return l ? (inputs?.fieldsBySource.get(l.sourceId as number) ?? []) : []
  }
  const modeLabel = (mode: string) =>
    mode === 'history-movement'
      ? t('reports.master.mode.history', { defaultValue: 'History' })
      : mode === 'shape-tint'
        ? t('reports.master.mode.tint', { defaultValue: 'Area tint' })
        : mode === 'point-at-coord'
          ? t('reports.master.mode.points', { defaultValue: 'Points' })
          : t('reports.master.mode.other', { defaultValue: 'Layer' })

  // Chosen layers in their order, then the rest.
  const rows = inputs && setup
    ? [
        ...setup.layers.map((s) => ({ link: inputs.links.find((l) => l.id === s.linkId)!, s })),
        ...inputs.links.filter((l) => !chosen.includes(l.id as number)).map((link) => ({ link, s: null })),
      ]
    : []
  const toggleLayer = (linkId: number, on: boolean) => {
    if (!setup) return
    if (!on) return patch({ layers: setup.layers.filter((l) => l.linkId !== linkId) })
    const chart = chartFields(fieldsOf(linkId)).find((f) => /(^|_)(status|state)$/i.test(f.key))?.key ?? null
    patch({ layers: [...setup.layers, { linkId, kpi: true, chart }] })
  }
  const setLayer = (linkId: number, p: { kpi?: boolean; chart?: string | null }) =>
    setup && patch({ layers: setup.layers.map((l) => (l.linkId === linkId ? { ...l, ...p } : l)) })
  const move = (i: number, by: -1 | 1) => {
    if (!setup) return
    const layers = [...setup.layers]
    const j = i + by
    if (j < 0 || j >= layers.length) return
    ;[layers[i], layers[j]] = [layers[j], layers[i]]
    patch({ layers })
  }
  const filterOf = (field: string) => setup?.filters.find((f) => f.field === field)
  const toggleFilter = (field: string, kind: ViewerFilterKind, on: boolean) =>
    setup && patch({ filters: on ? [...setup.filters, { field, kind, label: '' }] : setup.filters.filter((f) => f.field !== field) })
  const setFilterKind = (field: string, kind: ViewerFilterKind) =>
    setup && patch({ filters: setup.filters.map((f) => (f.field === field ? { ...f, kind } : f)) })
  // Ticked filters always show, even past the fold.
  const shownFilters = moreFilters ? candidates : candidates.filter((c, i) => i < FILTERS_SHOWN || filterOf(c.field.key))

  const save = async () => {
    if (!inputs || !setup) return
    setSaving(true)
    setSaveError(false)
    try {
      onSaved(await saveMasterReport(inputs, setup, text))
    } catch {
      setSaveError(true)
      setSaving(false)
    }
  }

  const existing = inputs?.existing ?? null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <MapIcon className="h-5 w-5" aria-hidden />
            {t('reports.master.setupTitle', { defaultValue: 'Master report' })}
            <span className="truncate text-sm font-normal text-muted-foreground">— {facilityName}</span>
          </DialogTitle>
          <DialogDescription>
            {t('reports.master.setupBody', {
              defaultValue: 'Choose what the live master report shows: which data layers are on the map, what each one adds, and the filters.',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-4">
          {loadError ? (
            <p role="alert" className="text-sm text-danger">{t('reports.master.loadFailed', { defaultValue: 'Couldn’t load this facility’s data layers.' })}</p>
          ) : !inputs || !setup ? (
            <div className="space-y-2" aria-busy>
              {[0, 1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />)}
            </div>
          ) : inputs.links.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{t('reports.master.noLayers', { defaultValue: 'This facility has no linked data yet — link a table to it first.' })}</p>
          ) : (
            <>
              <label className="block space-y-1">
                <span className="text-xs font-medium">{t('reports.master.nameLabel', { defaultValue: 'Name' })}</span>
                <Input value={setup.name} maxLength={128} onChange={(e) => patch({ name: e.target.value })} />
              </label>

              <section className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{t('reports.master.layersTitle', { defaultValue: 'Data layers' })}</p>
                  <span className="text-xs text-muted-foreground">
                    {t('reports.master.layersCount', { n: setup.layers.length, total: inputs.links.length, defaultValue: '{{n}} of {{total}}' })}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('reports.master.layersHint', { defaultValue: 'Each layer is a tab on the map, in this order. Pick what it adds to the report.' })}
                </p>
                <ul className="divide-y rounded-lg border">
                  {rows.map(({ link, s }) => {
                    const id = link.id as number
                    const i = s ? setup.layers.indexOf(s) : -1
                    const charts = chartFields(fieldsOf(id))
                    return (
                      <li key={id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2', !s && 'opacity-60')}>
                        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                          <input type="checkbox" checked={Boolean(s)} onChange={(e) => toggleLayer(id, e.target.checked)} className="h-4 w-4 accent-primary" />
                          <span className="truncate font-medium">{link.name || `#${id}`}</span>
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{modeLabel(link.renderMode)}</span>
                          {loaded?.fresh.has(id) && (
                            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{t('reports.master.new', { defaultValue: 'New' })}</span>
                          )}
                        </label>
                        {s && (
                          <div className="flex items-center gap-2">
                            <label className="flex items-center gap-1.5 text-xs">
                              <input type="checkbox" checked={s.kpi} onChange={(e) => setLayer(id, { kpi: e.target.checked })} className="h-3.5 w-3.5 accent-primary" />
                              {t('reports.master.count', { defaultValue: 'Count' })}
                            </label>
                            <select
                              value={s.chart ?? ''}
                              onChange={(e) => setLayer(id, { chart: e.target.value || null })}
                              className={cn(SELECT, 'max-w-[10rem]')}
                              aria-label={t('reports.master.chart', { defaultValue: 'Chart' })}
                              disabled={charts.length === 0}
                            >
                              <option value="">{t('reports.master.noChart', { defaultValue: 'No chart' })}</option>
                              {charts.map((f) => (
                                <option key={f.key} value={f.key}>
                                  {t('reports.master.chartBy', { field: f.label || f.key, defaultValue: 'Chart by {{field}}' })}
                                </option>
                              ))}
                            </select>
                            <div className="flex">
                              <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={i <= 0} onClick={() => move(i, -1)} aria-label={t('reports.master.moveUp', { defaultValue: 'Move up' })}>
                                <ArrowUp className="h-3.5 w-3.5" />
                              </Button>
                              <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={i >= setup.layers.length - 1} onClick={() => move(i, 1)} aria-label={t('reports.master.moveDown', { defaultValue: 'Move down' })}>
                                <ArrowDown className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>

              <section className="space-y-2">
                <p className="text-sm font-medium">{t('reports.master.filtersTitle', { defaultValue: 'Filters' })}</p>
                <p className="text-xs text-muted-foreground">
                  {t('reports.master.filtersHint', { defaultValue: 'A filter narrows every chosen layer whose table has the field — on the map, in the counts and in the charts.' })}
                </p>
                {candidates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('reports.master.noFilters', { defaultValue: 'The chosen layers have no fields to filter by.' })}</p>
                ) : (
                  <ul className="divide-y rounded-lg border">
                    {shownFilters.map((c) => {
                      const f = filterOf(c.field.key)
                      return (
                        <li key={c.field.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                          <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                            <input type="checkbox" checked={Boolean(f)} onChange={(e) => toggleFilter(c.field.key, c.kinds[0], e.target.checked)} className="h-4 w-4 accent-primary" />
                            <span className="truncate">{c.field.label || c.field.key}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {t('reports.master.inLayers', { count: c.layers, defaultValue: 'in {{count}} layers' })}
                            </span>
                          </label>
                          {f && c.kinds.length > 1 && (
                            <select value={f.kind} onChange={(e) => setFilterKind(c.field.key, e.target.value as ViewerFilterKind)} className={SELECT} aria-label={t('reports.master.filterKind', { defaultValue: 'Shown as' })}>
                              {c.kinds.map((k) => (
                                <option key={k} value={k}>
                                  {t(`reports.wizard.viewerFilters.kind.${k}`, { defaultValue: KIND_LABEL[k] })}
                                </option>
                              ))}
                            </select>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
                {candidates.length > FILTERS_SHOWN && (
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setMoreFilters((v) => !v)}>
                    {moreFilters
                      ? t('reports.master.showFewer', { defaultValue: 'Show fewer' })
                      : t('reports.master.showMore', { count: candidates.length - FILTERS_SHOWN, defaultValue: 'Show {{count}} more' })}
                  </Button>
                )}
              </section>

              <div className="flex items-center justify-between gap-3 text-sm">
                <span>{t('reports.share.openAs', { defaultValue: 'Opens on' })}</span>
                <div className="inline-flex rounded-md border p-0.5" role="group">
                  {(['map', 'page'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={setup.view === v}
                      onClick={() => patch({ view: v })}
                      className={cn('h-7 rounded px-3 text-xs font-medium transition-colors', setup.view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                    >
                      {v === 'map' ? t('reports.mapView.mapView', { defaultValue: 'Map view' }) : t('reports.mapView.pageView', { defaultValue: 'Page view' })}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3">
          <p className={cn('text-xs', saveError ? 'text-danger' : 'text-muted-foreground')}>
            {saveError
              ? t('reports.master.failed', { defaultValue: 'Couldn’t build the master report.' })
              : setup && setup.layers.length === 0
                ? t('reports.master.noneSelected', { defaultValue: 'Choose at least one layer.' })
                : existing
                  ? t('reports.master.updateHint', { defaultValue: 'Updating keeps the widgets and changes you made in the builder.' })
                  : null}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button onClick={() => void save()} disabled={saving || !setup || setup.layers.length === 0}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {existing ? t('reports.master.update', { defaultValue: 'Update report' }) : t('reports.master.create', { defaultValue: 'Create report' })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
