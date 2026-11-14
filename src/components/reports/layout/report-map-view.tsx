/**
 * Full-map report view (`layout.kind = 'map'`, or a viewer's Page → Map
 * switch). The report's facility map & list fills the page; everything
 * else floats over it — see src/lib/reports/map-layout.ts for the slots
 * and widgets/facility-explorer/explorer-map-layout.tsx for the panels.
 *
 * This file owns the floating top bar (back, name, facility, freshness;
 * then icon groups: floors · live · filters · page/map · map style &
 * panels · share & export · Edit), the KPI chips, which widgets are on (per viewer,
 * in localStorage) and the keyboard shortcuts: L list · I insights ·
 * F filters.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  Contrast,
  Download,
  Filter,
  Globe2,
  History,
  LayoutList,
  Link2,
  Map as MapIcon,
  Moon,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Route,
  Share2,
  SlidersHorizontal,
  Square,
  Sun,
  Sunset,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DEFAULT_MAP_STYLE, MAP_STYLE_IDS, defaultStyleLabel, normalizeStyleId, type MapStyleId } from '@/components/mapbox-map'
import { CountUp } from '@/components/count-up'
import { FacilityExplorerWidget } from '@/components/reports/widgets/facility-explorer/facility-explorer-widget'
import type { ExplorerMapChrome, MapInsight } from '@/components/reports/widgets/facility-explorer/explorer-map-layout'
import { ParamFields, useActiveParamCount } from '@/components/reports/params/params-bar'
import { CLASS_META, ReportIcon, StarButton } from '@/components/reports/report-identity'
import { useWidgetKindLabel } from '@/components/reports/builder/wizard/widget-kinds'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import { fullTime } from '@/lib/relative-time'
import { classifyReport, formatReportValue, type QueryRunResult, type Report, type ReportSpec, type ReportWidget } from '@/lib/reports-client'
import { mapSlots } from '@/lib/reports/map-layout'
import type { ReportRuntimeStore } from '@/lib/reports/report-runtime-store'
import type { ReportSpecV2, ReportWidgetV2 } from '@/lib/reports/v2-types'

const glass = 'sgv-glass'

type PanelKey = 'list' | 'insights' | 'kpis'
interface MapPrefs {
  list: boolean
  insights: boolean
  kpis: boolean
  /** Auto-refresh every N seconds; 0 = paused. */
  live: number
  /** The basemap (the viewer's style list). */
  mapStyle?: MapStyleId
  /** Widgets the viewer turned off (default on) / on (hidden at first). */
  off: string[]
  on: string[]
}
const DEFAULT_PREFS: MapPrefs = { list: true, insights: true, kpis: true, live: 30, off: [], on: [] }
const LIVE_CHOICES = [10, 30, 60, 300] as const

function usePrefs(reportId: number): [MapPrefs, (patch: Partial<MapPrefs>) => void] {
  const key = `sgv-report-map:${reportId}`
  const [prefs, setPrefs] = useState<MapPrefs>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<MapPrefs>) } : DEFAULT_PREFS
    } catch {
      return DEFAULT_PREFS
    }
  })
  const update = useCallback(
    (patch: Partial<MapPrefs>) =>
      setPrefs((prev) => {
        const next = { ...prev, ...patch }
        try {
          localStorage.setItem(key, JSON.stringify(next))
        } catch {
          /* a convenience — the view works without it */
        }
        return next
      }),
    [key],
  )
  return [prefs, update]
}

export interface MapViewActions {
  facility: string | null
  anyRunning: boolean
  updatedAt: number | null
  starred: boolean
  onToggleStar: () => void
  onRefresh: () => void
  /** A background re-run: no spinner, no dimmed widgets. */
  onQuietRefresh: () => void
  /** Copy this page's link. Unset on a public link's page. */
  onShare?: () => void
  /** Manage public links (report editors only). */
  onShareDialog?: () => void
  /** Unset when nothing in the report can be exported. */
  onExport?: () => void
  /** Unset when the viewer can't edit. */
  onEdit?: () => void
  /** A master report's setup (owners / admins). */
  onMasterSetup?: () => void
  /** Unset on a public link's page. */
  onHistory?: () => void
  onPageView: () => void
  /** A public link's page: no way back into the app, no star. */
  shared?: boolean
}

export function ReportMapView({
  report,
  spec,
  store,
  explorer,
  queryResults,
  queryPhase,
  locale,
  renderWidget,
  actions,
}: {
  report: Report
  spec: ReportSpecV2
  store: ReportRuntimeStore
  explorer: ReportWidgetV2
  queryResults: Record<string, QueryRunResult | undefined>
  queryPhase: Record<string, string>
  locale: string
  renderWidget: (w: ReportWidgetV2) => ReactNode
  actions: MapViewActions
}) {
  const wide = useMediaQuery('(min-width: 1024px)')
  const [prefs, setPrefs] = usePrefs(report.id)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const slots = useMemo(() => mapSlots(spec), [spec])
  const hasParams = (spec.params?.length ?? 0) > 0

  const isOn = useCallback(
    (w: ReportWidgetV2, hiddenAtFirst: boolean) => (hiddenAtFirst ? prefs.on.includes(w.id) : !prefs.off.includes(w.id)),
    [prefs.on, prefs.off],
  )
  const toggleWidget = (w: ReportWidgetV2, hiddenAtFirst: boolean, on: boolean) => {
    if (hiddenAtFirst) setPrefs({ on: on ? [...prefs.on, w.id] : prefs.on.filter((id) => id !== w.id) })
    else setPrefs({ off: on ? prefs.off.filter((id) => id !== w.id) : [...prefs.off, w.id] })
  }
  const setPanel = useCallback((panel: PanelKey, on: boolean) => setPrefs({ [panel]: on }), [setPrefs])
  const live = useLiveRefresh(prefs.live, actions.anyRunning, actions.updatedAt, actions.onQuietRefresh)
  const mapStyle = normalizeStyleId(prefs.mapStyle ?? DEFAULT_MAP_STYLE)

  // Hidden-at-first widgets the viewer turned on join their natural slot.
  const kpiWidgets = [...slots.kpi.filter((w) => isOn(w, false)), ...slots.hidden.filter((w) => (w.kind === 'kpi' || w.kind === 'bigValue') && isOn(w, true))]
  const insightWidgets = [...slots.insights.filter((w) => isOn(w, false)), ...slots.hidden.filter((w) => w.kind !== 'kpi' && w.kind !== 'bigValue' && isOn(w, true))]

  // L / I / F — never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, select, [contenteditable], [role=dialog], [role=menu], [role=listbox][aria-multiselectable]')) return
      const k = e.key.toLowerCase()
      if (k === 'l') setPanel('list', !prefs.list)
      else if (k === 'i') setPanel('insights', !prefs.insights)
      else if (k === 'f' && hasParams) setFiltersOpen((v) => !v)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prefs.list, prefs.insights, hasParams, setPanel])

  const chrome: ExplorerMapChrome = {
    renderTopBar: (floorPicker, clusterControl) => (
      <TopBar
        floorPicker={floorPicker}
        clusterControl={clusterControl}
        report={report}
        store={store}
        wide={wide}
        hasParams={hasParams}
        filtersOpen={filtersOpen}
        onFiltersOpen={setFiltersOpen}
        actions={actions}
        live={{ every: prefs.live, ...live, onChange: (every) => setPrefs({ live: every }) }}
        viewMenu={
          <ViewMenu
            mapStyle={mapStyle}
            onMapStyle={(id) => setPrefs({ mapStyle: id })}
            prefs={prefs}
            setPanel={setPanel}
            hasKpis={slots.kpi.length + slots.hidden.filter((w) => w.kind === 'kpi' || w.kind === 'bigValue').length > 0}
            widgets={[
              ...slots.kpi.map((w) => ({ w, hidden: false })),
              ...slots.insights.map((w) => ({ w, hidden: false })),
              ...slots.hidden.map((w) => ({ w, hidden: true })),
            ]}
            isOn={isOn}
            onToggle={toggleWidget}
          />
        }
      />
    ),
    kpis: kpiWidgets.map((w) => (
      <MapKpiChip key={w.id} widget={w} result={w.queryRef ? queryResults[w.queryRef] : undefined} phase={w.queryRef ? queryPhase[w.queryRef] : undefined} locale={locale} />
    )),
    insights: insightWidgets.map<MapInsight>((w) => ({ id: w.id, title: w.title, kind: w.kind, node: renderWidget(w) })),
    panels: { list: prefs.list, insights: prefs.insights, kpis: prefs.kpis },
    setPanel,
    mapStyle,
  }

  const qr = explorer.queryRef ? queryResults[explorer.queryRef] : undefined
  const legacy = { runId: 0, columns: qr?.columns ?? [], rows: qr?.rows ?? [], rowCount: qr?.rowCount ?? 0, msElapsed: qr?.msElapsed ?? 0, spec: {} as ReportSpec }
  return (
    <div className="relative h-full w-full">
      <FacilityExplorerWidget widget={explorer as unknown as ReportWidget} result={legacy} locale={locale} chrome={chrome} />
    </div>
  )
}

// ─────────────────────────────────────────────── top bar

/** An icon button's tooltip (its accessible name stays on the button). */
function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

const ICON_BTN = 'h-8 w-8 shrink-0 p-0'
const Sep = () => <span className="mx-0.5 hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden />

/**
 * Left: back · icon · name / facility · freshness. Right, in groups:
 * floors · live + filters · page/map · map style & panels · share ·
 * Edit. Everything else lives in those menus, so the bar stays calm.
 */
function TopBar({
  report,
  store,
  wide,
  hasParams,
  filtersOpen,
  onFiltersOpen,
  actions,
  live,
  floorPicker,
  clusterControl,
  viewMenu,
}: {
  report: Report
  store: ReportRuntimeStore
  wide: boolean
  hasParams: boolean
  filtersOpen: boolean
  onFiltersOpen: (open: boolean) => void
  actions: MapViewActions
  live: { every: number; remaining: number | null; now: number; onChange: (every: number) => void }
  floorPicker: ReactNode
  /** The explorer map's "Cluster items" control (after Filters, phones too). */
  clusterControl?: ReactNode
  viewMenu: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const active = useActiveParamCount(store)
  const meta = CLASS_META[classifyReport(report.spec)]
  const facility =
    report.zoneId == null ? t('reports.facilityShared', { defaultValue: 'Shared' }) : (actions.facility ?? t('reports.viewer.facility', { defaultValue: 'Facility' }))
  const filtersLabel = t('reports.mapView.filtersKey', { defaultValue: 'Filters (F)' })

  return (
    <TooltipProvider delayDuration={250}>
      <header className={cn(glass, 'flex items-center gap-1.5 px-2 py-2 sm:gap-2 sm:px-3')}>
        {!actions.shared && (
          <Tip label={t('reports.backToDirectory', { defaultValue: 'All reports' })}>
            <Button asChild variant="ghost" size="sm" className={ICON_BTN}>
              <Link to="/reports" aria-label={t('reports.backToDirectory', { defaultValue: 'All reports' })}>
                <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
              </Link>
            </Button>
          </Tip>
        )}
        <div className="hidden shrink-0 sm:block">
          <ReportIcon report={report} fallback={meta.icon} size="sm" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <h1 className="truncate text-sm font-semibold leading-5">{report.name}</h1>
            {!actions.shared && (
              <StarButton plain starred={actions.starred} onToggle={actions.onToggleStar} name={report.name} className="hidden shrink-0 sm:inline-flex" />
            )}
          </div>
          <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            <span className="truncate">{facility}</span>
            <span className="inline-flex shrink-0 items-center gap-1">
              <span className={cn('h-1.5 w-1.5 rounded-full', actions.anyRunning ? 'animate-pulse bg-info motion-reduce:animate-none' : 'bg-success')} aria-hidden />
              {actions.anyRunning ? (
                t('reports.viewer.refreshing', { defaultValue: 'Refreshing…' })
              ) : actions.updatedAt ? (
                <span className="hidden tabular-nums sm:inline" title={fullTime(new Date(actions.updatedAt).toISOString(), i18n.language)}>
                  {t('reports.viewer.updated', { defaultValue: 'Updated {{when}}', when: agoText(live.now - actions.updatedAt, i18n.language) })}
                </span>
              ) : null}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
          {floorPicker}
          {floorPicker && <Sep />}
          <LivePill every={live.every} remaining={live.remaining} pulseKey={actions.updatedAt} onChange={live.onChange} onRefresh={actions.onRefresh} running={actions.anyRunning} />
          {hasParams && (
            <Popover open={filtersOpen} onOpenChange={onFiltersOpen}>
              <Tip label={filtersLabel}>
                <PopoverTrigger asChild>
                  <Button variant={active > 0 ? 'secondary' : 'ghost'} size="sm" className={cn(ICON_BTN, 'relative')} aria-label={filtersLabel}>
                    <Filter className="h-4 w-4" />
                    {active > 0 && (
                      <span className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground">
                        {active}
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
              </Tip>
              <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1.5rem)] p-0">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <span className="text-sm font-medium">{t('reports.mapView.filters', { defaultValue: 'Filters' })}</span>
                  {active > 0 && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => store.getState().resetAll()}>
                      <RotateCcw className="h-3 w-3" />
                      {t('reports.params.resetAll', { defaultValue: 'Reset all' })}
                    </Button>
                  )}
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-3">
                  <ParamFields store={store} stacked />
                </div>
              </PopoverContent>
            </Popover>
          )}
          {clusterControl}
          {wide && <Sep />}
          {wide && <ViewSwitch onPage={actions.onPageView} iconOnly />}
          {wide && viewMenu}
          {wide && (actions.onShare || actions.onExport || actions.onHistory) && <ShareMenu actions={actions} />}
          {wide && <Sep />}
          {wide && actions.onMasterSetup && (
            <Tip label={t('reports.master.setupItem', { defaultValue: 'Set up master report…' })}>
              <Button variant="ghost" size="sm" className={ICON_BTN} onClick={actions.onMasterSetup} aria-label={t('reports.master.setupItem', { defaultValue: 'Set up master report…' })}>
                <SlidersHorizontal className="h-4 w-4" />
              </Button>
            </Tip>
          )}
          {actions.onEdit && (
            <Button size="sm" className="hidden h-8 shrink-0 sm:inline-flex" onClick={actions.onEdit}>
              <PencilLine className="h-3.5 w-3.5" />
              {t('reports.editReport', { defaultValue: 'Edit' })}
            </Button>
          )}
          {!wide && <CompactMenu actions={actions} viewMenu={viewMenu} />}
        </div>
      </header>
    </TooltipProvider>
  )
}

/** Share & export: copy the link, export, run history. */
function ShareMenu({ actions }: { actions: MapViewActions }) {
  const { t } = useTranslation()
  const label = t('reports.mapView.shareMenu', { defaultValue: 'Share & export' })
  return (
    <DropdownMenu>
      <Tip label={label}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={ICON_BTN} aria-label={label}>
            <Share2 className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-56">
        {actions.onShareDialog && (
          <DropdownMenuItem onSelect={actions.onShareDialog}>
            <Globe2 className="me-2 h-4 w-4" />
            {t('reports.share.menuItem', { defaultValue: 'Share link…' })}
          </DropdownMenuItem>
        )}
        {actions.onShare && (
          <DropdownMenuItem onSelect={actions.onShare}>
            <Link2 className="me-2 h-4 w-4" />
            {t('reports.mapView.copyLink', { defaultValue: 'Copy link' })}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={actions.onExport} disabled={!actions.onExport}>
          <Download className="me-2 h-4 w-4" />
          {t('reports.export.menuItem', { defaultValue: 'Export…' })}
        </DropdownMenuItem>
        {actions.onHistory && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={actions.onHistory}>
              <History className="me-2 h-4 w-4" />
              {t('reports.viewer.runHistory', { defaultValue: 'Run history' })}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Phones: one menu for everything that doesn't fit. */
function CompactMenu({ actions, viewMenu }: { actions: MapViewActions; viewMenu: ReactNode }) {
  const { t } = useTranslation()
  return (
    <>
      {viewMenu}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={ICON_BTN} aria-label={t('reports.viewerMoreActions', { defaultValue: 'More actions' })}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={actions.onPageView}>
            <LayoutList className="me-2 h-4 w-4" />
            {t('reports.mapView.pageView', { defaultValue: 'Page view' })}
          </DropdownMenuItem>
          {actions.onEdit && (
            <DropdownMenuItem onSelect={actions.onEdit}>
              <PencilLine className="me-2 h-4 w-4" />
              {t('reports.editReport', { defaultValue: 'Edit' })}
            </DropdownMenuItem>
          )}
          {actions.onMasterSetup && (
            <DropdownMenuItem onSelect={actions.onMasterSetup}>
              <SlidersHorizontal className="me-2 h-4 w-4" />
              {t('reports.master.setupItem', { defaultValue: 'Set up master report…' })}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {actions.onShareDialog && (
            <DropdownMenuItem onSelect={actions.onShareDialog}>
              <Globe2 className="me-2 h-4 w-4" />
              {t('reports.share.menuItem', { defaultValue: 'Share link…' })}
            </DropdownMenuItem>
          )}
          {actions.onShare && (
            <DropdownMenuItem onSelect={actions.onShare}>
              <Link2 className="me-2 h-4 w-4" />
              {t('reports.mapView.copyLink', { defaultValue: 'Copy link' })}
            </DropdownMenuItem>
          )}
          {actions.onExport && (
            <DropdownMenuItem onSelect={actions.onExport}>
              <Download className="me-2 h-4 w-4" />
              {t('reports.export.menuItem', { defaultValue: 'Export…' })}
            </DropdownMenuItem>
          )}
          {actions.onHistory && (
            <DropdownMenuItem onSelect={actions.onHistory}>
              <History className="me-2 h-4 w-4" />
              {t('reports.viewer.runHistory', { defaultValue: 'Run history' })}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

/** Page / Map switch. `onPage` set = currently on the map, and vice versa. */
export function ViewSwitch({ onPage, onMap, className, iconOnly = false }: { onPage?: () => void; onMap?: () => void; className?: string; iconOnly?: boolean }) {
  const { t } = useTranslation()
  const onMapNow = Boolean(onPage)
  const item = (active: boolean, onClick: (() => void) | undefined, Icon: typeof MapIcon, label: string) => {
    const btn = (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        aria-label={iconOnly ? label : undefined}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md text-xs font-medium transition-colors',
          iconOnly ? 'w-7 justify-center' : 'px-2',
          active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {!iconOnly && label}
      </button>
    )
    return iconOnly ? <Tip label={label}>{btn}</Tip> : btn
  }
  return (
    <div className={cn('inline-flex shrink-0 rounded-lg bg-muted p-0.5', className)} role="group" aria-label={t('reports.mapView.view', { defaultValue: 'View' })}>
      {item(!onMapNow, onPage, LayoutList, t('reports.mapView.page', { defaultValue: 'Page' }))}
      {item(onMapNow, onMap, MapIcon, t('reports.mapView.map', { defaultValue: 'Map' }))}
    </div>
  )
}

/** Each basemap's icon in the style list (lucide, no colours). */
export const STYLE_ICON: Partial<Record<string, typeof MapIcon>> = {
  standard: MapIcon,
  'standard-simple': Square,
  'monochrome-light': Contrast,
  'monochrome-dark': Contrast,
  dusk: Sunset,
  streets: Route,
  dark: Moon,
  light: Sun,
}

/** Translated basemap name (`reports.mapView.styles.<id>`; a new style
 *  in map-styles.json falls back to its id, title-cased). */
export function useStyleLabel(): (id: MapStyleId) => string {
  const { t } = useTranslation()
  return (id) => t(`reports.mapView.styles.${id}`, { defaultValue: defaultStyleLabel(id) })
}

/** Map style · panels · widgets — one menu. */
function ViewMenu({
  mapStyle,
  onMapStyle,
  prefs,
  setPanel,
  hasKpis,
  widgets,
  isOn,
  onToggle,
}: {
  mapStyle: MapStyleId
  onMapStyle: (id: MapStyleId) => void
  prefs: MapPrefs
  setPanel: (panel: PanelKey, on: boolean) => void
  hasKpis: boolean
  widgets: Array<{ w: ReportWidgetV2; hidden: boolean }>
  isOn: (w: ReportWidgetV2, hidden: boolean) => boolean
  onToggle: (w: ReportWidgetV2, hidden: boolean, on: boolean) => void
}) {
  const { t } = useTranslation()
  const kindLabel = useWidgetKindLabel()
  const styleLabel = useStyleLabel()
  const keep = (e: Event) => e.preventDefault()
  const label = t('reports.mapView.viewOptions', { defaultValue: 'Map style & panels' })
  return (
    <DropdownMenu>
      <Tip label={label}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={ICON_BTN} aria-label={label}>
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="max-h-[75vh] w-72 overflow-y-auto">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t('reports.mapView.mapStyle', { defaultValue: 'Map style' })}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mapStyle} onValueChange={(v) => onMapStyle(v as MapStyleId)} className="grid grid-cols-2 gap-1 px-1 pb-1">
          {MAP_STYLE_IDS.map((id) => {
            const Icon = STYLE_ICON[id] ?? MapIcon
            const on = id === mapStyle
            return (
              <DropdownMenuRadioItem
                key={id}
                value={id}
                onSelect={keep}
                className={cn(
                  'flex-col items-start gap-1 rounded-lg border py-2 pl-2.5 pr-2 text-xs [&>span:first-child]:hidden',
                  on ? 'border-primary bg-primary/10' : 'border-border/60',
                )}
              >
                <Icon className={cn('h-4 w-4', on ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                <span className="truncate font-medium">{styleLabel(id)}</span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t('reports.mapView.panels', { defaultValue: 'Panels' })}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={prefs.list} onSelect={keep} onCheckedChange={(v) => setPanel('list', Boolean(v))}>
          {t('reports.mapView.list', { defaultValue: 'List' })}
          <kbd className="ms-auto text-[10px] text-muted-foreground">L</kbd>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={prefs.insights} onSelect={keep} onCheckedChange={(v) => setPanel('insights', Boolean(v))}>
          {t('reports.mapView.insights', { defaultValue: 'Insights' })}
          <kbd className="ms-auto text-[10px] text-muted-foreground">I</kbd>
        </DropdownMenuCheckboxItem>
        {hasKpis && (
          <DropdownMenuCheckboxItem checked={prefs.kpis} onSelect={keep} onCheckedChange={(v) => setPanel('kpis', Boolean(v))}>
            {t('reports.mapView.kpis', { defaultValue: 'Key numbers' })}
          </DropdownMenuCheckboxItem>
        )}
        {widgets.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t('reports.mapView.widgets', { defaultValue: 'Widgets' })}</DropdownMenuLabel>
            {widgets.map(({ w, hidden }) => (
              <DropdownMenuCheckboxItem key={w.id} checked={isOn(w, hidden)} onSelect={keep} onCheckedChange={(v) => onToggle(w, hidden, Boolean(v))}>
                <span className="truncate">{w.title || kindLabel(w.kind)}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ─────────────────────────────────────────────── KPI chip

const TONE_DOT: Record<string, string> = { blue: 'bg-chart-1', emerald: 'bg-chart-2', purple: 'bg-chart-3', amber: 'bg-chart-4' }

/** A KPI / big value as a glass card: counts up on arrival, and a value
 *  that changes on a refresh glows once with its ↑ / ↓ difference. */
function MapKpiChip({
  widget,
  result,
  phase,
  locale,
}: {
  widget: ReportWidgetV2
  result: QueryRunResult | undefined
  phase: string | undefined
  locale: string
}) {
  const b = (widget.bindings ?? {}) as {
    value?: string
    label?: string
    tone?: string
    format?: 'number' | 'percent' | 'currency' | 'text' | 'date'
    decimals?: number
    prefix?: string
    suffix?: string
    rowIndex?: number
  }
  const row = result?.rows[b.rowIndex ?? 0]
  const idx = result ? result.columns.findIndex((c) => c.name === b.value) : -1
  const raw = row && idx >= 0 ? row[idx] : undefined
  const type = result && idx >= 0 ? result.columns[idx].type : 'number'
  const fmt = (v: unknown) =>
    typeof b.decimals === 'number' && typeof v === 'number' && (!b.format || b.format === 'number')
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: b.decimals }).format(v)
      : formatReportValue(v, type, b.format, locale)

  // A changed value glows once and shows its difference for a few seconds.
  const [seen, setSeen] = useState(raw)
  const [flash, setFlash] = useState<{ diff: number; n: number } | null>(null)
  if (raw !== seen) {
    if (typeof raw === 'number' && typeof seen === 'number' && raw !== seen) setFlash({ diff: raw - seen, n: (flash?.n ?? 0) + 1 })
    setSeen(raw)
  }
  useEffect(() => {
    if (!flash) return
    const h = window.setTimeout(() => setFlash(null), 6000)
    return () => window.clearTimeout(h)
  }, [flash])

  const card = cn(glass, 'flex min-w-0 flex-col justify-center rounded-xl px-4 py-2.5')
  if (!result) {
    return (
      <div className={card} aria-busy={phase !== undefined && phase !== 'idle'}>
        <Skeleton className="h-2.5 w-20" />
        <Skeleton className="mt-2 h-6 w-16" />
      </div>
    )
  }
  const labelIdx = b.label ? result.columns.findIndex((c) => c.name === b.label) : -1
  const label = labelIdx >= 0 && row ? String(row[labelIdx] ?? '') : widget.title
  const full = raw === undefined || raw === null ? '—' : `${b.prefix ?? ''}${fmt(raw)}${b.suffix ?? ''}`
  const up = flash !== null && flash.diff > 0
  return (
    <div className={cn(card, 'relative')} title={label ? `${label}: ${full}` : full}>
      {/* Its own element, keyed per change, so the glow replays without
          remounting the value (which would replay the count-up). */}
      {flash && <span key={flash.n} className={cn('pointer-events-none absolute inset-0 rounded-xl', up ? 'sgv-kpi-up' : 'sgv-kpi-down')} aria-hidden />}
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[b.tone ?? 'blue'] ?? TONE_DOT.blue)} aria-hidden />
        <span className="truncate">{label}</span>
        {flash && (
          <span className={cn('sgv-fade ms-auto inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums', up ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger')}>
            {up ? <ArrowUp className="h-2.5 w-2.5" aria-hidden /> : <ArrowDown className="h-2.5 w-2.5" aria-hidden />}
            {fmt(Math.abs(flash.diff))}
          </span>
        )}
      </span>
      <span className="mt-0.5 truncate text-xl font-semibold leading-tight tracking-tight tabular-nums">
        {typeof raw === 'number' ? (
          <>
            {b.prefix}
            <CountUp value={raw} format={(n) => fmt(Number.isInteger(raw) ? Math.round(n) : n)} />
            {b.suffix}
          </>
        ) : (
          full
        )}
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────── live refresh

/**
 * Re-runs the report every `every` seconds (0 = paused), counted from
 * when the last run finished, never while one is running or the tab is
 * hidden. Returns the seconds left and a 1 s clock for "4s ago".
 */
export function useLiveRefresh(every: number, running: boolean, updatedAt: number | null, run: () => void): { remaining: number | null; now: number } {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(h)
  }, [])
  const [mountedAt] = useState(() => Date.now())
  const base = updatedAt ?? mountedAt
  const remaining = every > 0 ? Math.max(0, Math.ceil(every - (now - base) / 1000)) : null
  const fired = useRef<number | null>(null)
  useEffect(() => {
    if (remaining !== 0 || running || document.hidden || fired.current === base) return
    fired.current = base
    run()
  }, [remaining, running, base, run])
  return { remaining, now }
}

/** "4s ago" / "3 min ago" — locale-aware, short. */
function agoText(ms: number, locale: string): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' })
  if (s < 60) return rtf.format(-s, 'second')
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute')
  return rtf.format(-Math.round(s / 3600), 'hour')
}

export function LivePill({
  every,
  remaining,
  pulseKey,
  onChange,
  onRefresh,
  running,
}: {
  every: number
  remaining: number | null
  pulseKey: number | null
  onChange: (every: number) => void
  onRefresh: () => void
  running: boolean
}) {
  const { t, i18n } = useTranslation()
  const on = every > 0
  const choiceLabel = (n: number) =>
    new Intl.NumberFormat(i18n.language, { style: 'unit', unit: n >= 60 ? 'minute' : 'second', unitDisplay: 'long' }).format(n >= 60 ? n / 60 : n)
  const r = 12
  const c = 2 * Math.PI * r
  const progress = on && remaining !== null ? remaining / every : 0
  const label = on && remaining !== null ? t('reports.mapView.nextIn', { s: remaining, defaultValue: 'Live — next update in {{s}} s' }) : t('reports.mapView.paused', { defaultValue: 'Paused' })
  return (
    <DropdownMenu>
      <Tip label={label}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
              on ? 'text-success hover:bg-success/10' : 'text-muted-foreground hover:bg-accent',
            )}
          >
            {/* The ring empties towards the next update. */}
            <svg width="28" height="28" viewBox="0 0 28 28" className="absolute -rotate-90" aria-hidden>
              <circle cx="14" cy="14" r={r} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
              {on && (
                <circle cx="14" cy="14" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-1000 motion-safe:ease-linear" />
              )}
            </svg>
            <span key={pulseKey ?? 0} className={cn('relative h-2 w-2 rounded-full', on ? 'sgv-live-dot bg-success text-success' : 'bg-muted-foreground')} aria-hidden />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onRefresh} disabled={running}>
          <RefreshCw className={cn('me-2 h-4 w-4', running && 'animate-spin motion-reduce:animate-none')} />
          {t('reports.mapView.refreshNow', { defaultValue: 'Refresh now' })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t('reports.mapView.autoRefresh', { defaultValue: 'Update automatically' })}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={String(every)} onValueChange={(v) => onChange(Number(v))}>
          {LIVE_CHOICES.map((n) => (
            <DropdownMenuRadioItem key={n} value={String(n)}>
              {t('reports.mapView.every', { when: choiceLabel(n), defaultValue: 'Every {{when}}' })}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="0">{t('reports.mapView.pause', { defaultValue: 'Pause updates' })}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
