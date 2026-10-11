/**
 * ReportViewer — loads a report, migrates the spec to v2, spins up a
 * per-open runtime store, then hands off to ReportViewerBody. The
 * outer shell owns loading + error state ONLY — every hook that
 * subscribes to the runtime store lives inside the body so React sees
 * a stable hook order once the body mounts.
 *
 * The two-component split is deliberate. Zustand's `useStore`
 * internally consumes multiple hook slots via
 * `useSyncExternalStoreWithSelector`. Rendering `useStore`-using
 * subcomponents conditionally on `store && …` while ReportViewer
 * itself keeps calling hooks caused the fiber tree to change shape
 * mid-render and tripped React's rules-of-hooks detector. Splitting
 * the body into its own component guarantees the store subscribers
 * only exist inside a fiber that never renders without a valid store.
 *
 * Page (2026-09 redesign): back link; header with the report's own icon
 * + colour, star, description, class + facility + freshness ("Updated 2
 * minutes ago", live while re-running); actions Refresh / Share (copies
 * the URL, which carries the current filter values) / Export (CSV per
 * query that has rows) / Edit, all folded into ⋯ on phones. Loading is a
 * skeleton of the header + grid; each widget shows a kind-shaped
 * skeleton while its query runs and an inline error with Retry if it
 * fails. Run history opens as a non-modal side panel.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useStore } from 'zustand'
import {
  Building2,
  ChevronLeft,
  CircleAlert,
  Download,
  FileSearch,
  Globe2,
  History,
  Link2,
  Map as MapIcon,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PageContainer, rise } from '@/components/page-shell'
import { EmptyState } from '@/components/empty-state'
import { QueryError } from '@/components/feedback/query-error'
import { Widget } from '@/components/reports/widgets'
import { buildExportDocument, downloadBlob, safeFileName, type ExportDocument } from '@/components/reports/export/model'
import { exportDocument, loadSettings, tableToClipboardText, type ExportSettings } from '@/components/reports/export/export-settings'
import { chartToPng, kpiToPng } from '@/components/reports/export/png'
import { ReportExportDialog } from '@/components/reports/export/report-export-dialog'
import { ReportPrintView } from '@/components/reports/export/print-view'
import { ReportExportContext, WidgetExportMenu, exportableKinds, type ReportExportActions } from '@/components/reports/export/widget-export-menu'
import { ReportAccentContext } from '@/components/reports/chart-widgets'
import { ReportQueryContext } from '@/components/reports/report-query-context'
import { ParamsBar } from '@/components/reports/params/params-bar'
import { ReportCanvas } from '@/components/reports/layout/report-canvas'
import { DocumentFlow } from '@/components/reports/layout/document-flow'
import { ReportMapView, ViewSwitch } from '@/components/reports/layout/report-map-view'
import { CLASS_META, ReportIcon, StarButton, useStarred } from '@/components/reports/report-identity'
import { ApiError } from '@/lib/api-client'
import { apiDb } from '@/lib/api-db'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { toast } from '@/lib/toast-store'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import {
  classifyReport,
  getReport,
  listReportRuns,
  type QueryRunResult,
  type Report,
  type ReportRun,
  type ReportSpec,
  type ReportWidget,
} from '@/lib/reports-client'
import { migrateToV2 } from '@/lib/reports/spec-migrate'
import { withAutoPositions } from '@/lib/reports/auto-positions'
import { mapExplorer } from '@/lib/reports/map-layout'
import { createReportRuntimeStore, type ReportRuntimeStore } from '@/lib/reports/report-runtime-store'
import type { ReportSpecV2, ReportWidgetV2 } from '@/lib/reports/v2-types'
import type { CanvasItem } from '@/components/reports/layout/canvas-types'

interface Loaded {
  key: string
  report: Report | null
  spec: ReportSpecV2 | null
  store: ReportRuntimeStore | null
  error: unknown
}

/** Shell — loads the report and owns the not-found / error / loading
 *  states. Never subscribes to the runtime store. */
export function ReportViewer() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const reportId = Number(id)
  const validId = Number.isInteger(reportId) && reportId > 0

  const [reloadToken, setReloadToken] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const queryKey = `${reportId}:${reloadToken}`

  useEffect(() => {
    if (!validId) return
    let cancelled = false
    getReport(reportId)
      .then((r) => {
        if (cancelled) return
        const v2 = migrateToV2(r.spec)
        const s = createReportRuntimeStore(r.id, v2)
        setLoaded({ key: queryKey, report: r, spec: v2, store: s, error: null })
        void s.getState().runAll()
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoaded({ key: queryKey, report: null, spec: null, store: null, error })
      })
    return () => {
      cancelled = true
    }
  }, [reportId, validId, queryKey])

  const retry = useCallback(() => setReloadToken((n) => n + 1), [])
  const current = loaded?.key === queryKey ? loaded : null
  const notFound = !validId || (current?.error instanceof ApiError && current.error.status === 404)

  const back = (
    <Link
      to="/reports"
      className="inline-flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
      {t('reports.backToDirectory', { defaultValue: 'All reports' })}
    </Link>
  )

  if (notFound) {
    return (
      <PageContainer className="gap-6">
        {back}
        <EmptyState
          icon={FileSearch}
          title={t('reports.viewer.notFoundTitle', { defaultValue: 'Report not found' })}
          description={t('reports.viewer.notFoundBody', {
            defaultValue: 'It may have been archived, or it belongs to another workspace.',
          })}
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/reports">{t('reports.backToDirectory', { defaultValue: 'All reports' })}</Link>
            </Button>
          }
        />
      </PageContainer>
    )
  }

  if (current?.error) {
    return (
      <PageContainer className="gap-6">
        {back}
        <QueryError error={current.error} onRetry={retry} what={t('reports.viewer.what', { defaultValue: 'this report' })} />
      </PageContainer>
    )
  }

  if (!current?.report || !current.spec || !current.store) {
    return (
      <PageContainer className="gap-6">
        {back}
        <ViewerSkeleton />
      </PageContainer>
    )
  }

  return (
    <ReportViewerBody
      // A fresh store per load: remount so no subscriber outlives it.
      key={current.key}
      report={current.report}
      spec={current.spec}
      store={current.store}
      back={back}
      onEdit={() => navigate(`/reports/${current.report!.id}/edit`)}
    />
  )
}

/** Body — mounts only when `store` is guaranteed non-null. Every
 *  `useStore` call inside here (either directly or via subcomponents)
 *  sees a stable store instance for the fiber's whole lifetime. */
function ReportViewerBody({
  report,
  spec,
  store,
  back,
  onEdit,
}: {
  report: Report
  spec: ReportSpecV2
  store: ReportRuntimeStore
  back: React.ReactNode
  onEdit: () => void
}) {
  const { t, i18n } = useTranslation()
  const [historyOpen, setHistoryOpen] = useState(false)
  const tenantId = useCurrentTenantId()
  const [starred, toggleStar] = useStarred(tenantId)

  // Store subscriptions live here at the top of the body so their
  // hook slots are stable for the entire fiber's lifetime.
  const queryResults = useStore(store, (s) => s.queryResults)
  const queryPhase = useStore(store, (s) => s.queryPhase)
  const queryErrors = useStore(store, (s) => s.queryErrors)

  // A manual refresh reads as "refreshing" for at least 600 ms: local
  // queries can land in under 100, and a spinner that flashes for one
  // frame looks like the click did nothing.
  const [manualRefresh, setManualRefresh] = useState(false)
  const queriesRunning = useMemo(() => Object.values(queryPhase).some((p) => p !== 'idle'), [queryPhase])
  const anyRunning = queriesRunning || manualRefresh
  const updatedAt = useLastUpdated(store)

  const [facility, setFacility] = useState<string | null>(null)
  useEffect(() => {
    if (report.zoneId == null) return
    let cancelled = false
    apiDb.zones
      .toArray()
      .then((zones) => {
        if (!cancelled) setFacility(zones.find((z) => z.id === report.zoneId)?.name ?? null)
      })
      .catch(() => {
        /* the chip is optional context */
      })
    return () => {
      cancelled = true
    }
  }, [report.zoneId])

  const refresh = () => {
    setManualRefresh(true)
    void Promise.allSettled([store.getState().runAll(), new Promise((r) => window.setTimeout(r, 600))]).then(() =>
      setManualRefresh(false),
    )
  }
  const retryQuery = (name: string) => void store.getState().runQueries([name], { force: true })
  // Widgets that read several queries (the facility explorer) and refresh
  // the page after an edit made inside them.
  const queryContext = useMemo(
    () => ({ results: queryResults, phases: queryPhase, refresh: () => void store.getState().runAll() }),
    [queryResults, queryPhase, store],
  )

  // ---- export -------------------------------------------------------
  const [exportDialog, setExportDialog] = useState<{ widgetIds?: string[] } | null>(null)
  const [printing, setPrinting] = useState<{ doc: ExportDocument; settings: ExportSettings } | null>(null)
  const buildDoc = useCallback(
    (widgetIds: string[] | undefined, settings: ExportSettings) =>
      buildExportDocument({
        report,
        spec,
        queryResults,
        params: store.getState().params,
        locale: i18n.language,
        scope: settings.scope,
        facility,
        widgetIds,
        untitled: (n) => t('reports.export.untitled', { n, defaultValue: 'Widget {{n}}' }),
      }),
    [report, spec, queryResults, store, i18n.language, facility, t],
  )
  const exportActions = useMemo<ReportExportActions>(
    () => ({
      openDialog: (widgetId) => setExportDialog({ widgetIds: widgetId ? [widgetId] : undefined }),
      quick: (widgetId, kind) => {
        const settings = loadSettings()
        const doc = buildDoc([widgetId], settings)
        const block = doc.blocks[0]
        if (!block) return
        void (async () => {
          try {
            if (kind === 'copy') {
              const text = block.table
                ? tableToClipboardText(doc, settings)
                : block.kpi
                  ? block.kpi.value.text
                  : (block.text ?? '')
              await navigator.clipboard.writeText(text)
              toast.success(t('reports.export.copied', { defaultValue: 'Copied' }))
              return
            }
            if (kind === 'png') {
              const name = `${safeFileName(`${report.name} - ${block.title}`)}.png`
              const blob = block.kpi
                ? await kpiToPng(block.title, block.kpi.value.text, block.kpi.delta, settings.png)
                : await chartToPng(document.querySelector<HTMLElement>(`[data-export-widget="${CSS.escape(widgetId)}"]`)!, block.title, settings.png)
              downloadBlob(blob, name)
              toast.success(t('reports.export.done', { name, defaultValue: 'Exported {{name}}' }))
              return
            }
            const names = await exportDocument(doc, kind, settings, t, report.color || undefined)
            if (names.length) toast.success(t('reports.export.done', { name: names[0], defaultValue: 'Exported {{name}}' }))
          } catch (err) {
            toast.error(t('reports.export.failed', { defaultValue: 'Export failed' }), { description: err instanceof Error ? err.message : undefined })
          }
        })()
      },
    }),
    [buildDoc, report.name, report.color, t],
  )
  const hasExportable = (spec.widgets ?? []).some((w) => exportableKinds(w.kind).length > 0)

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      toast.success(t('reports.viewer.linkCopied', { defaultValue: 'Link copied' }), {
        description: t('reports.viewer.linkCopiedBody', { defaultValue: 'It opens with the filters you have set now.' }),
      })
    } catch {
      toast.error(t('reports.viewer.copyFailed', { defaultValue: 'Couldn’t copy the link' }))
    }
  }

  const cls = classifyReport(report.spec)
  const meta = CLASS_META[cls]
  const hasParams = !spec.layout?.hideParamsBar && (spec.params?.length ?? 0) > 0

  // Page or full map: the author's layout first, then the viewer's own
  // pick for this report (remembered in this browser).
  const explorer = useMemo(() => mapExplorer(spec), [spec])
  const viewKey = `sgv-report-view:${report.id}`
  const [view, setView] = useState<'page' | 'map'>(() => {
    if (!explorer) return 'page'
    let saved: string | null = null
    try {
      saved = localStorage.getItem(viewKey)
    } catch {
      /* private mode — fall back to the author's pick */
    }
    if (saved === 'map' || saved === 'page') return saved
    return spec.layout?.kind === 'map' ? 'map' : 'page'
  })
  const switchView = (v: 'page' | 'map') => {
    setView(v)
    try {
      localStorage.setItem(viewKey, v)
    } catch {
      /* remembered for this visit only */
    }
  }
  // `quiet`: the full map re-runs in the background — widgets keep their
  // last values instead of dimming every 30 s.
  const renderCell = (widget: ReportWidgetV2, quiet = false) => {
    const p = widget.queryRef ? queryPhase[widget.queryRef] : 'idle'
    return (
    <WidgetCell
      widget={widget}
      queryResults={queryResults}
      phase={quiet && p === 'refreshing' ? 'idle' : p}
      error={widget.queryRef ? queryErrors[widget.queryRef] : undefined}
      locale={i18n.language}
      onRetry={retryQuery}
    />
    )
  }
  const overlays = (
    <>
      {historyOpen && <RunHistoryPanel open={historyOpen} onOpenChange={setHistoryOpen} reportId={report.id} />}
      {exportDialog && (
        <ReportExportDialog
          open
          onOpenChange={(o) => !o && setExportDialog(null)}
          widgets={spec.widgets ?? []}
          initialWidgetIds={exportDialog.widgetIds}
          initialFormat={exportDialog.widgetIds ? 'xlsx' : undefined}
          buildDoc={buildDoc}
          accent={report.color || undefined}
          onPrint={(doc, settings) => setPrinting({ doc, settings })}
        />
      )}
      {printing && (
        <ReportPrintView
          doc={printing.doc}
          spec={spec}
          queryResults={queryResults}
          locale={i18n.language}
          accent={report.color || undefined}
          options={printing.settings.pdf}
          onDone={() => setPrinting(null)}
        />
      )}
    </>
  )

  if (view === 'map' && explorer) {
    return (
      <ReportAccentContext.Provider value={report.color || undefined}>
        <ReportExportContext.Provider value={exportActions}>
          <ReportQueryContext.Provider value={queryContext}>
            <ReportMapView
              report={report}
              spec={spec}
              store={store}
              explorer={explorer}
              queryResults={queryResults}
              queryPhase={queryPhase}
              locale={i18n.language}
              renderWidget={(w) => renderCell(w, true)}
              actions={{
                facility,
                anyRunning,
                updatedAt,
                starred: starred.has(report.id),
                onToggleStar: () => toggleStar(report.id),
                onRefresh: refresh,
                onQuietRefresh: () => void store.getState().runAll(),
                onShare: () => void share(),
                onExport: hasExportable ? () => setExportDialog({}) : undefined,
                onEdit: report.canEdit ? onEdit : undefined,
                onHistory: () => setHistoryOpen(true),
                onPageView: () => switchView('page'),
              }}
            />
          </ReportQueryContext.Provider>
        </ReportExportContext.Provider>
        {overlays}
      </ReportAccentContext.Provider>
    )
  }

  return (
    <PageContainer className="gap-6">
      <div {...rise(0)}>{back}</div>

      <header {...rise(1, 'flex items-start justify-between gap-4')}>
        <div className="flex min-w-0 items-start gap-4">
          <div className="hidden sm:block">
            <ReportIcon report={report} fallback={meta.icon} size="lg" />
          </div>
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-start gap-1.5 sm:items-center">
              <h1 className="line-clamp-2 break-words text-2xl font-semibold tracking-tight sm:truncate sm:text-[28px] sm:leading-9">{report.name}</h1>
              <StarButton plain starred={starred.has(report.id)} onToggle={() => toggleStar(report.id)} name={report.name} className="shrink-0" />
            </div>
            {report.description && (
              <p className="line-clamp-2 max-w-3xl text-sm text-muted-foreground">{report.description}</p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                {report.zoneId == null ? <Globe2 className="h-3.5 w-3.5" aria-hidden /> : <Building2 className="h-3.5 w-3.5" aria-hidden />}
                {report.zoneId == null
                  ? t('reports.facilityShared', { defaultValue: 'Shared' })
                  : (facility ?? t('reports.viewer.facility', { defaultValue: 'Facility' }))}
              </span>
              <span>{t(meta.labelKey, { defaultValue: meta.fallback })}</span>
              <span className="inline-flex items-center gap-1.5" aria-live="polite">
                <span
                  className={cn('h-1.5 w-1.5 rounded-full', anyRunning ? 'animate-pulse bg-info motion-reduce:animate-none' : 'bg-success')}
                  aria-hidden
                />
                {anyRunning ? (
                  t('reports.viewer.refreshing', { defaultValue: 'Refreshing…' })
                ) : updatedAt ? (
                  <span title={fullTime(new Date(updatedAt).toISOString(), i18n.language)}>
                    {t('reports.viewer.updated', {
                      defaultValue: 'Updated {{when}}',
                      when: relativeTime(new Date(updatedAt).toISOString(), i18n.language),
                    })}
                  </span>
                ) : null}
              </span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {explorer && <ViewSwitch onMap={() => switchView('map')} className="hidden sm:inline-flex" />}
          <Button
            variant="outline"
            size="icon"
            className="hidden sm:inline-flex"
            onClick={refresh}
            disabled={anyRunning}
            aria-label={t('reports.viewerRefresh', { defaultValue: 'Refresh' })}
            title={t('reports.viewerRefresh', { defaultValue: 'Refresh' })}
          >
            <RefreshCw className={cn('h-4 w-4', anyRunning && 'animate-spin motion-reduce:animate-none')} />
          </Button>
          <Button variant="outline" className="hidden sm:inline-flex" onClick={() => void share()}>
            <Link2 className="h-4 w-4" />
            {t('reports.viewer.share', { defaultValue: 'Share' })}
          </Button>
          <Button variant="outline" className="hidden sm:inline-flex" disabled={!hasExportable} onClick={() => setExportDialog({})}>
            <Download className="h-4 w-4" />
            {t('reports.viewer.export', { defaultValue: 'Export' })}
          </Button>
          {report.canEdit && (
            <Button onClick={onEdit}>
              <PencilLine className="h-4 w-4" />
              {t('reports.editReport', { defaultValue: 'Edit' })}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label={t('reports.viewerMoreActions', { defaultValue: 'More actions' })}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {explorer && (
                <DropdownMenuItem className="sm:hidden" onSelect={() => switchView('map')}>
                  <MapIcon className="me-2 h-4 w-4" />
                  {t('reports.mapView.mapView', { defaultValue: 'Map view' })}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className="sm:hidden" onSelect={refresh} disabled={anyRunning}>
                <RefreshCw className="me-2 h-4 w-4" />
                {t('reports.viewerRefresh', { defaultValue: 'Refresh' })}
              </DropdownMenuItem>
              <DropdownMenuItem className="sm:hidden" onSelect={() => void share()}>
                <Link2 className="me-2 h-4 w-4" />
                {t('reports.viewer.share', { defaultValue: 'Share' })}
              </DropdownMenuItem>
              {hasExportable && (
                <DropdownMenuItem className="sm:hidden" onSelect={() => setExportDialog({})}>
                  <Download className="me-2 h-4 w-4" />
                  {t('reports.export.menuItem', { defaultValue: 'Export…' })}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className="sm:hidden" />
              <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                <History className="me-2 h-4 w-4" />
                {t('reports.viewer.runHistory', { defaultValue: 'Run history' })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {hasParams && (
        <div {...rise(2)}>
          <ParamsBar store={store} />
        </div>
      )}

      <div {...rise(3, 'pb-8')}>
        {(spec.queries?.length ?? 0) === 0 ? (
          <EmptyState
            icon={FileSearch}
            title={t('reports.viewerNotConfiguredTitle', { defaultValue: 'This report has no source yet' })}
            description={t('reports.viewerNotConfiguredBody', {
              defaultValue: 'Open the builder to point this report at a table or data source.',
            })}
            action={
              report.canEdit ? (
                <Button size="sm" onClick={onEdit}>
                  <PencilLine className="h-4 w-4" />
                  {t('reports.editReport', { defaultValue: 'Edit' })}
                </Button>
              ) : undefined
            }
          />
        ) : (
          // Single-series charts wear the report's own colour.
          <ReportAccentContext.Provider value={report.color || undefined}>
            <ReportExportContext.Provider value={exportActions}>
            <ReportQueryContext.Provider value={queryContext}>
            <CanvasBody
              spec={spec}
              queryResults={queryResults}
              queryPhase={queryPhase}
              queryErrors={queryErrors}
              locale={i18n.language}
              onRetry={retryQuery}
            />
            </ReportQueryContext.Provider>
            </ReportExportContext.Provider>
          </ReportAccentContext.Provider>
        )}
      </div>

      {overlays}
    </PageContainer>
  )
}

/**
 * When the report's queries last finished. Seeded from the store (the
 * first run may already be done by the time the body mounts), updated
 * from a store subscription, and re-rendered every 30 s so "2 minutes
 * ago" keeps moving.
 */
function useLastUpdated(store: ReportRuntimeStore): number | null {
  const busy = (phases: Record<string, string>) => Object.values(phases).some((p) => p !== 'idle')
  const [at, setAt] = useState<number | null>(() => (busy(store.getState().queryPhase) ? null : Date.now()))
  useEffect(
    () =>
      store.subscribe((s, prev) => {
        if (busy(prev.queryPhase) && !busy(s.queryPhase)) setAt(Date.now())
      }),
    [store],
  )
  const [, setTick] = useState(0)
  useEffect(() => {
    const h = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(h)
  }, [])
  return at
}

/** Renders the widgets. Receives resolved query results as props — no
 *  `useStore` calls inside so hook order is trivial. */
function CanvasBody({
  spec,
  queryResults,
  queryPhase,
  queryErrors,
  locale,
  onRetry,
}: {
  spec: ReportSpecV2
  queryResults: Record<string, QueryRunResult | undefined>
  queryPhase: Record<string, string>
  queryErrors: Record<string, string | undefined>
  locale: string
  onRetry: (queryName: string) => void
}) {
  const renderCell = (widget: ReportWidgetV2) => (
    <WidgetCell
      widget={widget}
      queryResults={queryResults}
      phase={widget.queryRef ? queryPhase[widget.queryRef] : 'idle'}
      error={widget.queryRef ? queryErrors[widget.queryRef] : undefined}
      locale={locale}
      onRetry={onRetry}
    />
  )

  // A full-map report shown as a page reads as a document.
  if (spec.layout?.kind !== 'grid') {
    return <DocumentFlow spec={spec} renderWidget={renderCell} />
  }

  const items: CanvasItem[] = withAutoPositions(spec.widgets ?? []).map((w) => ({ id: w.id, position: w.position }))
  const widgetsById = new Map((spec.widgets ?? []).map((w) => [w.id, w]))
  return (
    <ReportCanvas
      items={items}
      layout={spec.layout}
      editable={false}
      renderItem={(item) => {
        const widget = widgetsById.get(item.id)
        return widget ? renderCell(widget) : null
      }}
    />
  )
}

function WidgetCell({
  widget,
  queryResults,
  phase,
  error,
  locale,
  onRetry,
}: {
  widget: ReportWidgetV2
  queryResults: Record<string, QueryRunResult | undefined>
  phase: string | undefined
  error: string | undefined
  locale: string
  onRetry: (queryName: string) => void
}) {
  const { t } = useTranslation()
  const needsData = widget.queryRef !== undefined
  const qr = needsData ? queryResults[widget.queryRef!] : undefined

  if (error) {
    return (
      <div role="alert" className="flex h-full min-h-[6.5rem] flex-col gap-2 rounded-xl border bg-card p-4">
        {widget.title && <p className="truncate text-sm font-medium">{widget.title}</p>}
        <div className="flex flex-1 flex-col items-start justify-center gap-2">
          <p className="flex items-start gap-1.5 text-sm text-danger">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span className="line-clamp-3 break-words">
              {t('reports.viewer.widgetError', { defaultValue: 'Couldn’t load this widget.' })}
            </span>
          </p>
          <p className="line-clamp-2 break-words text-xs text-muted-foreground" title={error}>{error}</p>
          <Button variant="outline" size="sm" onClick={() => onRetry(widget.queryRef!)}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('common.retry', { defaultValue: 'Retry' })}
          </Button>
        </div>
      </div>
    )
  }
  if (needsData && !qr && phase && phase !== 'idle') {
    return <WidgetSkeleton kind={widget.kind} title={widget.title} />
  }

  const legacyResult = qr
    ? { runId: 0, columns: qr.columns, rows: qr.rows, rowCount: qr.rowCount, msElapsed: qr.msElapsed, spec: {} as ReportSpec }
    : { runId: 0, columns: [], rows: [], rowCount: 0, msElapsed: 0, spec: {} as ReportSpec }

  return (
    // Stretch the widget's own card to the cell; dim it while it re-runs.
    // The ⋯ export menu floats over the card's top corner on hover / focus.
    <div data-export-widget={widget.id} className={cn('group/widget relative h-full transition-opacity [&>*:first-child]:h-full', phase === 'refreshing' && 'opacity-60')}>
      <Widget widget={widget as unknown as ReportWidget} result={legacyResult} locale={locale} />
      <WidgetExportMenu
        widget={widget}
        className="absolute end-2 top-2 z-10 opacity-0 group-hover/widget:opacity-100 group-focus-within/widget:opacity-100 [@media(hover:none)]:opacity-100"
      />
    </div>
  )
}

/** A loading placeholder shaped like the widget that's coming. */
function WidgetSkeleton({ kind, title }: { kind: string; title?: string }) {
  const titleRow = title ? <p className="truncate text-sm font-medium text-muted-foreground/70">{title}</p> : <Skeleton className="h-3.5 w-32" />
  if (kind === 'kpi' || kind === 'bigValue') {
    return (
      <div className="flex h-full min-h-[6.5rem] flex-col justify-center gap-2.5 rounded-xl border bg-card px-5 py-4" aria-busy>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-32" />
      </div>
    )
  }
  if (kind === 'table' || kind === 'dataTable' || kind === 'editableTable' || kind === 'facilityExplorer') {
    return (
      <div className="flex h-full min-h-[14rem] flex-col gap-3 overflow-hidden rounded-xl border bg-card p-4" aria-busy>
        {titleRow}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-3" style={{ width: `${92 - ((i * 13) % 30)}%` }} />
        ))}
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-[14rem] flex-col gap-3 overflow-hidden rounded-xl border bg-card p-4" aria-busy>
      {titleRow}
      <div className="flex flex-1 items-end gap-3 px-2 pb-1">
        {[0.55, 0.8, 0.65, 0.95, 0.5, 0.7, 0.4].map((h, i) => (
          <Skeleton key={i} className="flex-1 rounded-b-none" style={{ height: `${h * 100}%` }} />
        ))}
      </div>
    </div>
  )
}

/** Mirrors the loaded header + a KPI row + two charts. */
function ViewerSkeleton() {
  return (
    <div className="space-y-6" aria-busy>
      <div className="flex items-start gap-4">
        <Skeleton className="h-12 w-12 rounded-xl" />
        <div className="flex-1 space-y-2.5">
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <WidgetSkeleton key={i} kind="kpi" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <WidgetSkeleton kind="bar" />
        <WidgetSkeleton kind="bar" />
      </div>
    </div>
  )
}

function RunHistoryPanel({
  open,
  onOpenChange,
  reportId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  reportId: number
}) {
  const { t, i18n } = useTranslation()
  const [reloadToken, setReloadToken] = useState(0)
  const [result, setResult] = useState<{ key: string; runs: ReportRun[]; error: unknown } | null>(null)
  const queryKey = `${reportId}:${reloadToken}`

  useEffect(() => {
    let cancelled = false
    listReportRuns(reportId, 50)
      .then((runs) => {
        if (!cancelled) setResult({ key: queryKey, runs, error: null })
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ key: queryKey, runs: [], error })
      })
    return () => {
      cancelled = true
    }
  }, [reportId, queryKey])

  const loading = result?.key !== queryKey
  const nf = new Intl.NumberFormat(i18n.language)

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="end"
        className="w-[min(420px,100vw)] rounded-none sm:rounded-s-xl"
        aria-describedby={undefined}
        // Non-modal: focus moving back to the page (e.g. the ⋯ menu that
        // opened this returning focus to its trigger) must not close it.
        onFocusOutside={(e) => e.preventDefault()}
      >
        <div className="border-b px-5 py-4 pe-12">
          <SheetTitle className="text-base">{t('reports.viewer.runHistory', { defaultValue: 'Run history' })}</SheetTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('reports.viewer.runHistoryHint', { defaultValue: 'Each time this report ran — the latest 50.' })}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {loading ? (
            <div className="space-y-4 p-5" aria-busy>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-2 w-2 rounded-full" />
                  <Skeleton className="h-3.5 flex-1" />
                  <Skeleton className="h-3.5 w-16" />
                </div>
              ))}
            </div>
          ) : result?.error ? (
            <QueryError
              compact
              error={result.error}
              onRetry={() => setReloadToken((n) => n + 1)}
              what={t('reports.viewer.historyWhat', { defaultValue: 'the run history' })}
            />
          ) : result!.runs.length === 0 ? (
            <EmptyState
              compact
              icon={History}
              title={t('reports.historyEmpty', { defaultValue: 'No runs yet' })}
              description={t('reports.viewer.historyEmptyBody', { defaultValue: 'Runs appear here each time the report is opened or refreshed.' })}
            />
          ) : (
            <ul className="divide-y">
              {result!.runs.map((run) => {
                const ok = run.status === 'ok'
                return (
                  <li key={run.id} className="flex items-start gap-3 px-5 py-3">
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', ok ? 'bg-success' : 'bg-danger')} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium first-letter:uppercase" title={fullTime(run.ranAt, i18n.language)}>
                          {relativeTime(run.ranAt, i18n.language)}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {t('reports.viewer.runStats', {
                            defaultValue: '{{rows}} rows · {{ms}} ms',
                            rows: nf.format(run.rowCount),
                            ms: nf.format(run.msElapsed),
                          })}
                        </span>
                      </div>
                      {!ok && (
                        <p className="mt-1 line-clamp-3 break-words text-xs text-danger">
                          {run.error || t('reports.viewer.runFailed', { defaultValue: 'Failed' })}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
