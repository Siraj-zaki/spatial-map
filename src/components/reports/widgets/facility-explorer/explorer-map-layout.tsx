/**
 * The facility explorer laid out as a full-page map (report layout
 * `map`, src/lib/reports/map-layout.ts). The explorer keeps its own state
 * (selection, floor, tab) and hands its pieces in; this arranges them as
 * frosted-glass panels over the map (`.sgv-glass`, index.css):
 *
 *   desktop — one 16 px grid: top bar across (with the floor dropdown);
 *             below it the list (left), a Details | Insights panel
 *             (right), and between them the key numbers, spread evenly. Panels slide in staggered on load and
 *             slide out when hidden — they're never unmounted mid-motion;
 *   phone   — top bar (floor dropdown included) over the map, one bottom panel with
 *             List / Insights / Details tabs.
 *
 * The map always fills the whole area; panels never resize it, they pass
 * their footprint to the camera (`insets`) so a framed item lands in the
 * visible gap.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, FileText, List, PanelLeftClose, PanelLeftOpen, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { MapInsets } from './facility-map'
import type { MapStyleId } from '@/components/mapbox-map'

export interface MapInsight {
  id: string
  title?: string
  kind: string
  node: ReactNode
}

/** What the full-map page puts around the explorer. */
export interface ExplorerMapChrome {
  /** The top bar, given the explorer's floor picker and cluster control to place in it. */
  renderTopBar: (floorPicker: ReactNode, clusterControl?: ReactNode) => ReactNode
  kpis: ReactNode[]
  insights: MapInsight[]
  panels: { list: boolean; insights: boolean; kpis: boolean }
  setPanel: (panel: 'list' | 'insights' | 'kpis', on: boolean) => void
  /** The viewer's basemap. */
  mapStyle?: MapStyleId
}

const LIST_W = 344
const RIGHT_W = 392
const GAP = 16

const stagger = (i: number) => ({ '--sgv-i': i }) as CSSProperties

/** Card height per widget kind inside the Insights panel. */
function insightHeight(kind: string): string | undefined {
  if (kind === 'note' || kind === 'alert' || kind === 'markdown') return undefined
  if (kind === 'table' || kind === 'dataTable' || kind === 'editableTable' || kind === 'history') return '22rem'
  return '17rem'
}

/** The widgets' own cards inside a glass panel: lighter, so the panel reads as one surface. */
const INNER_CARDS = '[&_.rounded-xl.border]:border-border/60 [&_.rounded-xl.border]:bg-card/70 [&_.rounded-xl.border]:shadow-none'

export function ExplorerMapLayout({
  wide,
  chrome,
  title,
  count,
  tabsBar,
  list,
  detail,
  onCloseDetail,
  floorPicker,
  clusterControl,
  loading,
  renderMap,
  onKeyDown,
}: {
  wide: boolean
  chrome: ExplorerMapChrome
  title: string
  count: number | null
  tabsBar: ReactNode
  list: ReactNode
  detail: ReactNode | null
  onCloseDetail: () => void
  /** The floor dropdown (null for a one-floor facility) — goes in the top bar. */
  floorPicker: ReactNode
  /** The map's "Cluster items" control (null when the tab can't cluster) — top bar, after Filters. */
  clusterControl?: ReactNode
  loading: ReactNode
  renderMap: (insets: MapInsets) => ReactNode
  onKeyDown: (e: React.KeyboardEvent) => void
}) {
  const { t } = useTranslation()
  const { panels, setPanel } = chrome
  const kpis = panels.kpis ? chrome.kpis : []
  const insights = panels.insights ? chrome.insights : []

  // Right panel tab: a pick opens Details, closing it goes back to Insights.
  const [rightTab, setRightTab] = useState<'details' | 'insights'>('insights')
  const [hadDetail, setHadDetail] = useState(false)
  if ((detail !== null) !== hadDetail) {
    setHadDetail(detail !== null)
    setRightTab(detail !== null ? 'details' : 'insights')
  }

  // Where the panels start (below the top bar) and the KPI strip's
  // height, for the camera.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const kpiRef = useRef<HTMLDivElement | null>(null)
  const [geo, setGeo] = useState({ top: 0, kpi: 0 })
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const measure = () => setGeo({ top: body.offsetTop, kpi: kpiRef.current?.offsetHeight ?? 0 })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(body)
    if (kpiRef.current) ro.observe(kpiRef.current)
    if (body.parentElement) ro.observe(body.parentElement)
    return () => ro.disconnect()
  }, [wide, kpis.length])

  if (!wide) {
    return (
      <PhoneLayout
        chrome={chrome}
        title={title}
        count={count}
        tabsBar={tabsBar}
        list={list}
        detail={detail}
        floorPicker={floorPicker}
        clusterControl={clusterControl}
        loading={loading}
        renderMap={renderMap}
        onKeyDown={onKeyDown}
        kpis={kpis}
        insights={insights}
      />
    )
  }

  const listOpen = panels.list
  const hasInsights = insights.length > 0
  const tab: 'details' | 'insights' = detail === null ? 'insights' : !hasInsights ? 'details' : rightTab
  const rightOpen = detail !== null || hasInsights
  const insets: MapInsets = {
    top: geo.top + (kpis.length ? geo.kpi + GAP : 0),
    left: listOpen ? LIST_W + GAP * 2 : 0,
    right: rightOpen ? RIGHT_W + GAP * 2 : 0,
    bottom: 40,
  }
  const middle: CSSProperties = { insetInlineStart: listOpen ? LIST_W + GAP : 0, insetInlineEnd: rightOpen ? RIGHT_W + GAP : 0 }
  const rightLabel = tab === 'details' ? t('reports.mapView.details', { defaultValue: 'Details' }) : t('reports.mapView.insights', { defaultValue: 'Insights' })
  const closeLabel = tab === 'details' ? t('common.close', { defaultValue: 'Close' }) : t('reports.mapView.hideInsights', { defaultValue: 'Hide insights (I)' })

  return (
    <div className="relative h-full w-full overflow-hidden bg-muted/40" onKeyDown={onKeyDown}>
      {renderMap(insets)}
      {loading}
      {/* z-10: above Mapbox's own controls. pb-9 keeps the bottom strip
          (logo, scale, attribution — Mapbox requires them visible) clear. */}
      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col gap-4 p-4 pb-9">
        <div className="sgv-enter-down pointer-events-auto" style={stagger(0)}>
          {chrome.renderTopBar(floorPicker, clusterControl)}
        </div>

        <div ref={bodyRef} className="relative min-h-0 flex-1">
          {/* List — the entrance runs on the wrapper, the slide on the panel,
              so a finished entrance never pins the panel open. */}
          <div className="sgv-enter-left pointer-events-none absolute inset-y-0 start-0" style={{ ...stagger(1), width: LIST_W }}>
            <aside
              data-open={listOpen}
              aria-hidden={!listOpen}
              className="sgv-glass sgv-glass-dense sgv-panel-left pointer-events-auto flex h-full flex-col overflow-hidden"
              aria-label={title}
            >
              <div className="flex items-center gap-2 px-4 pb-2 pt-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <List className="h-3.5 w-3.5" aria-hidden />
                </span>
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
                {count !== null && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{count}</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  tabIndex={listOpen ? 0 : -1}
                  onClick={() => setPanel('list', false)}
                  aria-label={t('reports.mapView.hideList', { defaultValue: 'Hide the list (L)' })}
                  title={t('reports.mapView.hideList', { defaultValue: 'Hide the list (L)' })}
                >
                  <PanelLeftClose className="h-4 w-4 rtl:rotate-180" />
                </Button>
              </div>
              {tabsBar && <div className="overflow-x-auto px-3 pb-2">{tabsBar}</div>}
              <div className="min-h-0 flex-1 border-t border-border/60">{list}</div>
            </aside>
          </div>
          <button
            type="button"
            data-open={!listOpen}
            tabIndex={listOpen ? -1 : 0}
            aria-hidden={listOpen}
            onClick={() => setPanel('list', true)}
            className="sgv-glass sgv-fade-swap pointer-events-auto absolute bottom-0 start-0 inline-flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium hover:bg-accent/60"
            title={t('reports.mapView.showList', { defaultValue: 'Show the list (L)' })}
          >
            <PanelLeftOpen className="h-4 w-4 rtl:rotate-180" aria-hidden />
            <span className="max-w-[12rem] truncate">{title}</span>
            {count !== null && <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{count}</span>}
          </button>

          {/* Between the panels: the key numbers along the top */}
          <div className="sgv-glide pointer-events-none absolute inset-y-0" style={middle}>
            {kpis.length > 0 && (
              <div
                ref={kpiRef}
                // One row always: cards share the width, and scroll sideways
                // when the gap between the panels is narrow (never a tall
                // stack covering the map).
                className="sgv-enter-down pointer-events-auto -mx-1 grid grid-flow-col gap-3 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]"
                style={{ ...stagger(2), gridAutoColumns: 'minmax(9.5rem, 1fr)' }}
                role="group"
                aria-label={t('reports.mapView.kpis', { defaultValue: 'Key numbers' })}
              >
                {kpis}
              </div>
            )}
          </div>

          {/* Details | Insights */}
          <div className="sgv-enter-right pointer-events-none absolute inset-y-0 end-0" style={{ ...stagger(3), width: RIGHT_W }}>
            <aside
              data-open={rightOpen}
              aria-hidden={!rightOpen}
              aria-label={rightLabel}
              className="sgv-glass sgv-glass-dense sgv-panel-right pointer-events-auto flex h-full flex-col overflow-hidden"
            >
              <div className="flex items-center gap-2 px-3 pb-2 pt-3">
                {detail !== null && hasInsights ? (
                  <div className="inline-flex rounded-lg bg-muted/80 p-0.5" role="tablist">
                    <RightTab active={tab === 'details'} onClick={() => setRightTab('details')} icon={FileText}>
                      {t('reports.mapView.details', { defaultValue: 'Details' })}
                    </RightTab>
                    <RightTab active={tab === 'insights'} onClick={() => setRightTab('insights')} icon={Sparkles} badge={insights.length}>
                      {t('reports.mapView.insights', { defaultValue: 'Insights' })}
                    </RightTab>
                  </div>
                ) : (
                  <h2 className="flex items-center gap-2 ps-1 text-sm font-semibold">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      {tab === 'details' ? <FileText className="h-3.5 w-3.5" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
                    </span>
                    {rightLabel}
                  </h2>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ms-auto h-7 w-7 p-0"
                  tabIndex={rightOpen ? 0 : -1}
                  onClick={() => (tab === 'details' ? onCloseDetail() : setPanel('insights', false))}
                  aria-label={closeLabel}
                  title={closeLabel}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 border-t border-border/60">
                {tab === 'details' && detail !== null ? (
                  <div key="details" className="sgv-fade flex h-full min-h-0 flex-col">
                    {detail}
                  </div>
                ) : (
                  <div key="insights" className={cn('sgv-fade h-full space-y-3 overflow-y-auto overscroll-contain p-3', INNER_CARDS)}>
                    {insights.map((w) => (
                      <InsightCard key={w.id} insight={w} />
                    ))}
                  </div>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}

function RightTab({
  active,
  onClick,
  icon: Icon,
  badge,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: typeof Sparkles
  badge?: number
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {children}
      {badge !== undefined && <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{badge}</span>}
    </button>
  )
}

function InsightCard({ insight }: { insight: MapInsight }) {
  const h = insightHeight(insight.kind)
  return (
    <div data-map-insight={insight.id} className={cn(h && '[&>*]:h-full')} style={h ? { height: h } : undefined}>
      {insight.node}
    </div>
  )
}

type PhoneTab = 'list' | 'insights' | 'details'

function PhoneLayout({
  chrome,
  title,
  count,
  tabsBar,
  list,
  detail,
  floorPicker,
  clusterControl,
  loading,
  renderMap,
  onKeyDown,
  kpis,
  insights,
}: {
  chrome: ExplorerMapChrome
  title: string
  count: number | null
  tabsBar: ReactNode
  list: ReactNode
  detail: ReactNode | null
  floorPicker: ReactNode
  clusterControl?: ReactNode
  loading: ReactNode
  renderMap: (insets: MapInsets) => ReactNode
  /** The explorer's keys (Esc lets go of the picked item, ↑/↓ step). */
  onKeyDown: (e: React.KeyboardEvent) => void
  kpis: ReactNode[]
  insights: MapInsight[]
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<PhoneTab>('list')
  // A record picked on the map or in the list opens Details.
  const [hadDetail, setHadDetail] = useState(false)
  if ((detail !== null) !== hadDetail) {
    setHadDetail(detail !== null)
    if (detail !== null) {
      setTab('details')
      setOpen(true)
    } else if (tab === 'details') {
      setTab('list')
    }
  }
  const hasInsights = kpis.length > 0 || insights.length > 0
  // The camera keeps picks above the bottom panel: its real height.
  const sheetRef = useRef<HTMLElement | null>(null)
  const [sheetH, setSheetH] = useState(56)
  useLayoutEffect(() => {
    const el = sheetRef.current
    if (!el) return
    const measure = () => setSheetH(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const tabs: Array<{ id: PhoneTab; label: string; badge?: number | null }> = [
    { id: 'list', label: title, badge: count },
    ...(hasInsights ? [{ id: 'insights' as const, label: t('reports.mapView.insights', { defaultValue: 'Insights' }) }] : []),
    ...(detail ? [{ id: 'details' as const, label: t('reports.mapView.details', { defaultValue: 'Details' }) }] : []),
  ]

  return (
    <div className="relative h-full w-full overflow-hidden bg-muted/40" onKeyDown={onKeyDown}>
      {renderMap({ top: 76, bottom: sheetH })}
      {loading}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-2 p-2">
        <div className="sgv-enter-down pointer-events-auto" style={stagger(0)}>
          {chrome.renderTopBar(floorPicker, clusterControl)}
        </div>
      </div>
      <section
        ref={sheetRef}
        className="sgv-glass sgv-glass-dense sgv-enter-up absolute inset-x-0 bottom-0 z-20 flex flex-col overflow-hidden rounded-b-none"
        style={{ ...stagger(2), height: open ? '55%' : undefined }}
      >
        <div className="mx-auto mt-1.5 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden />
        <div className="flex items-center gap-1 px-2 py-1.5">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist">
            {tabs.map((tb) => (
              <button
                key={tb.id}
                type="button"
                role="tab"
                aria-selected={open && tab === tb.id}
                onClick={() => {
                  setTab(tb.id)
                  setOpen(true)
                }}
                className={cn(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors',
                  open && tab === tb.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                <span className="max-w-[9rem] truncate">{tb.label}</span>
                {tb.badge != null && <span className="tabular-nums opacity-80">{tb.badge}</span>}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 shrink-0 p-0"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? t('reports.mapView.collapse', { defaultValue: 'Show more map' }) : t('reports.mapView.expand', { defaultValue: 'Show the panel' })}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
        </div>
        {open && (
          <div className="min-h-0 flex-1 overflow-hidden border-t border-border/60">
            {tab === 'list' && (
              <div key="list" className="sgv-fade flex h-full min-h-0 flex-col">
                {tabsBar && <div className="overflow-x-auto border-b border-border/60 px-2 py-1.5">{tabsBar}</div>}
                <div className="min-h-0 flex-1">{list}</div>
              </div>
            )}
            {tab === 'insights' && (
              <div key="insights" className={cn('sgv-fade h-full space-y-3 overflow-y-auto overscroll-contain p-3', INNER_CARDS)}>
                {kpis.length > 0 && <div className="grid grid-cols-2 gap-2">{kpis}</div>}
                {insights.map((w) => (
                  <InsightCard key={w.id} insight={w} />
                ))}
              </div>
            )}
            {tab === 'details' && detail && (
              <div key="details" className="sgv-fade flex h-full min-h-0 flex-col">
                {detail}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
