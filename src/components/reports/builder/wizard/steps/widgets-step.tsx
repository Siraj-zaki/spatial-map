import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  BarChart3,
  ChevronDown,
  ArrowDown,
  ArrowUp,
  CircleDot,
  Database,
  Divide,
  Gauge,
  Grid3x3,
  LayoutGrid,
  LineChart,
  Loader2,
  MapPinned,
  Minus,
  Palette,
  PieChart,
  Plus,
  ScatterChart,
  StickyNote,
  Table2,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  type Metric,
  type MetricFn,
  type ReportSourceHint,
  type ReportSourceRef,
  type ReportSourceSchema,
} from '@/lib/reports-client'
import type {
  ReportQueryV2,
  ReportWidgetV2,
  WidgetDataConfig,
  WidgetKindV2,
} from '@/lib/reports/v2-types'
import { useWizard } from '../wizard-state'
import { PRIMARY_QUERY_NAME, TOTALS_QUERY_NAME } from '../wizard-serialisation'
import { useSourceSchema } from '../use-source-schema'
import { newWidgetId, useExplorerActions, useExplorerData, useExplorerSuggestion } from '../use-explorer-setup'
import { useWidgetKindLabel } from '../widget-kinds'
import { ExplorerSetup } from './explorer-setup'
import { ExplorerClusterSetup } from './explorer-cluster-setup'
import { readClusterBinding, toBindingValue } from '@/lib/reports/cluster-config'
import type { DataLinkConfig, Zone } from '@/lib/db'
import {
  readExplorerBindings,
  releaseExplorerQueries,
  withoutQueryRefs,
  type ExplorerBindings,
} from '@/lib/reports/explorer-spec'

// ─────────────────────────────────────────────── palette

const PALETTE: Array<{ kind: WidgetKindV2; label: string; icon: typeof BarChart3 }> = [
  { kind: 'facilityExplorer', label: 'Facility map & list', icon: MapPinned },
  { kind: 'kpi', label: 'KPI', icon: Gauge },
  { kind: 'bigValue', label: 'Big value + delta', icon: TrendingUp },
  { kind: 'line', label: 'Line chart', icon: LineChart },
  { kind: 'bar', label: 'Bar chart', icon: BarChart3 },
  { kind: 'area', label: 'Area chart', icon: TrendingUp },
  { kind: 'pie', label: 'Pie chart', icon: PieChart },
  { kind: 'donut', label: 'Donut chart', icon: CircleDot },
  { kind: 'scatter', label: 'Scatter plot', icon: ScatterChart },
  { kind: 'heatmap', label: 'Heatmap', icon: Grid3x3 },
  { kind: 'dataTable', label: 'Data table', icon: Table2 },
  { kind: 'note', label: 'Note', icon: StickyNote },
  { kind: 'alert', label: 'Alert banner', icon: AlertCircle },
  { kind: 'divider', label: 'Divider', icon: Minus },
]
const paletteEntry = (k: WidgetKindV2) => PALETTE.find((p) => p.kind === k)

/** Widget kinds that read from data. */
const DATA_KINDS = new Set<WidgetKindV2>([
  'kpi',
  'bigValue',
  'line',
  'bar',
  'area',
  'pie',
  'donut',
  'scatter',
  'heatmap',
  'dataTable',
])

/** Widget kinds that expose an aggregation editor by default
 *  (KPI/BigValue/charts/pie/donut). scatter/heatmap/dataTable use
 *  raw-mode + explicit column pickers because their axes are
 *  point-level, not roll-up columns. */
const AGG_DEFAULT_KINDS = new Set<WidgetKindV2>([
  'kpi',
  'bigValue',
  'line',
  'bar',
  'area',
  'pie',
  'donut',
])

const FNS: Array<{ fn: MetricFn; label: string }> = [
  { fn: 'count', label: 'Count of rows' },
  { fn: 'sum', label: 'Sum of' },
  { fn: 'avg', label: 'Average of' },
  { fn: 'min', label: 'Min of' },
  { fn: 'max', label: 'Max of' },
  { fn: 'countDistinct', label: 'Distinct count of' },
]
const FN_LABEL = (fn: MetricFn) => FNS.find((f) => f.fn === fn)?.label ?? fn

/** Produce a stable, human-readable alias for a metric.
 *  count → `count`, `sum(units)` → `sum_units`, etc. */
function metricAlias(m: Metric): string {
  if (m.as?.trim()) return m.as.trim()
  if (m.fn === 'count') return 'count'
  if (m.fn === 'countDistinct') return `distinct_${m.field ?? 'rows'}`
  return `${m.fn}_${m.field ?? 'rows'}`
}


// ─────────────────────────────────────────────── top-level step

export function WidgetsStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()
  const { sourceHints, zones, dataLinks } = useExplorerData()
  const { defaultZone, joinViewerFilters, addExplorer: addExplorerWidget } = useExplorerActions(zones)
  // The card just added opens with its settings showing.
  const [justAdded, setJustAdded] = useState<string | null>(null)

  const availableQueries: string[] = [PRIMARY_QUERY_NAME]
  if (draft.reportType === 'summary') availableQueries.push(TOTALS_QUERY_NAME)
  for (const q of draft.extraQueries) {
    if (q.name && q.name !== PRIMARY_QUERY_NAME && q.name !== TOTALS_QUERY_NAME) {
      availableQueries.push(q.name)
    }
  }

  const addExplorer = (bindings: ExplorerBindings, title?: string) => setJustAdded(addExplorerWidget(bindings, title))

  const addWidget = (kind: WidgetKindV2) => {
    if (kind === 'facilityExplorer') return addExplorer({ zoneId: defaultZone, tabs: [] })
    const nextOrder = 20 + draft.extraWidgets.length
    const wantData = DATA_KINDS.has(kind)
    const w: ReportWidgetV2 = {
      id: newWidgetId(),
      kind,
      queryRef: undefined,
      data: wantData
        ? {
            sourceRef: draft.sourceRef ?? undefined,
            agg: AGG_DEFAULT_KINDS.has(kind) ? 'aggregate' : 'raw',
            groupBy: [],
            metrics: AGG_DEFAULT_KINDS.has(kind)
              ? [{ fn: 'count', as: 'count' }]
              : [],
            limit: kind === 'dataTable' ? 200 : 500,
          }
        : undefined,
      position: { x: 0, y: nextOrder, w: 12, h: kind === 'kpi' || kind === 'bigValue' ? 2 : 6 },
      order: nextOrder,
      columnSpan: kind === 'kpi' || kind === 'bigValue' ? 2 : undefined,
      bindings: defaultBindingsFor(kind),
    }
    update({ extraWidgets: [...draft.extraWidgets, w] })
  }

  const patchWidget = (idx: number, patch: Partial<ReportWidgetV2>) => {
    const next = [...draft.extraWidgets]
    next[idx] = { ...next[idx], ...patch }
    update({ extraWidgets: next })
  }
  // Editing a map & list moves its tabs onto queries written at save
  // time; queries only it read (a generated report's) go with them.
  const patchExplorer = (idx: number, bindings: ExplorerBindings) => {
    const before = draft.extraWidgets[idx]
    const next = [...draft.extraWidgets]
    next[idx] = { ...before, bindings: { ...(before.bindings ?? {}), zoneId: bindings.zoneId, tabs: withoutQueryRefs(bindings.tabs) } }
    joinViewerFilters(readExplorerBindings(before).tabs, bindings.tabs)
    // Sources only the removed tabs read leave the viewer filters too.
    const stillRead = new Set<number>()
    if (draft.sourceRef?.id) stillRead.add(draft.sourceRef.id)
    for (const q of draft.extraQueries) if (q.sourceRef?.id) stillRead.add(q.sourceRef.id)
    for (const w of next) {
      if (w.data?.sourceRef?.id) stillRead.add(w.data.sourceRef.id)
      if (w.kind === 'facilityExplorer') for (const tab of readExplorerBindings(w).tabs) stillRead.add(tab.sourceId)
    }
    const dropped = new Set(readExplorerBindings(before).tabs.map((tab) => tab.sourceId).filter((id) => !stillRead.has(id)))
    update({
      ...(draft.zoneId == null && bindings.zoneId ? { zoneId: bindings.zoneId } : {}),
      ...(dropped.size
        ? { viewerFilters: draft.viewerFilters.map((vf) => ({ ...vf, sourceIds: vf.sourceIds.filter((id) => !dropped.has(id)) })) }
        : {}),
      extraWidgets: next,
      extraQueries: releaseExplorerQueries(before, next, draft.extraQueries, draft.params),
    })
  }
  const removeWidget = (idx: number) => {
    update({ extraWidgets: draft.extraWidgets.filter((_, i) => i !== idx) })
  }
  const moveWidget = (idx: number, dir: -1 | 1) => {
    const target = idx + dir
    if (target < 0 || target >= draft.extraWidgets.length) return
    const next = [...draft.extraWidgets]
    const [item] = next.splice(idx, 1)
    next.splice(target, 0, item)
    next.forEach((w, i) => {
      w.order = 20 + i
    })
    update({ extraWidgets: next })
  }

  const suggestion = useExplorerSuggestion({
    sourceId: draft.sourceRef?.id,
    hasExplorer: draft.extraWidgets.some((w) => w.kind === 'facilityExplorer'),
    sourceHints,
    dataLinks,
    defaultZone,
  })

  return (
    <div className="space-y-6 max-w-3xl">
      {suggestion && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <MapPinned className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 text-xs">
            <div className="font-medium text-foreground">
              {t('reports.wizard.explorer.suggestTitle', { name: suggestion.name, defaultValue: 'Show {{name}} on the facility map' })}
            </div>
            <div className="text-muted-foreground">
              {t('reports.wizard.explorer.suggestBody', {
                defaultValue: 'Adds a list of every row beside a live map — pick a row to find it on the map, or click the map to find its row.',
              })}
            </div>
          </div>
          <Button size="sm" className="h-8" onClick={() => addExplorer(suggestion.bindings, suggestion.name)}>
            <Plus className="me-1.5 h-3.5 w-3.5" aria-hidden />
            {t('reports.wizard.explorer.suggestAdd', { defaultValue: 'Add map & list' })}
          </Button>
        </div>
      )}

      {draft.generatePrimary && (
      <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground flex items-start gap-2">
        <LayoutGrid className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
        <div>
          <div className="font-medium">
            {t('reports.wizard.widgets.primaryTitle', {
              defaultValue: 'A primary widget is generated automatically',
            })}
          </div>
          <div className="text-muted-foreground">
            {t('reports.wizard.widgets.primaryHint', {
              defaultValue:
                'Add extras below — each widget defines its own source, aggregation, and filters.',
            })}
          </div>
        </div>
      </div>
      )}

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t('reports.wizard.widgets.extras', {
            count: draft.extraWidgets.length,
            defaultValue: 'Extra widgets ({{count}})',
          })}
        </div>
        {draft.extraWidgets.length === 0 && (
          <div className="italic text-muted-foreground text-sm py-6 text-center border-2 border-dashed border-border rounded-md">
            {t('reports.wizard.widgets.empty', {
              defaultValue: 'No extras yet — the report will show just the primary widget.',
            })}
          </div>
        )}
        <ul className="space-y-2">
          {draft.extraWidgets.map((w, idx) => (
            <WidgetCard
              key={w.id}
              index={idx}
              widget={w}
              total={draft.extraWidgets.length}
              reportSource={draft.sourceRef ?? null}
              sourceHints={sourceHints}
              zones={zones}
              dataLinks={dataLinks}
              defaultOpen={w.id === justAdded}
              availableQueries={availableQueries}
              onChange={(patch) => patchWidget(idx, patch)}
              onExplorerChange={(b) => patchExplorer(idx, b)}
              onRemove={() => removeWidget(idx)}
              onMove={(dir) => moveWidget(idx, dir)}
            />
          ))}
        </ul>
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t('reports.wizard.widgets.palette', { defaultValue: 'Add a widget' })}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" className="h-8">
              <Plus className="w-3.5 h-3.5 me-1.5" />
              {t('reports.wizard.widgets.addOne', { defaultValue: 'Add widget' })}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-1" align="start">
            <div className="grid grid-cols-2 gap-1">
              {PALETTE.map((p) => {
                const Icon = p.icon
                if (p.kind === 'facilityExplorer') {
                  return (
                    <button
                      key={p.kind}
                      type="button"
                      onClick={() => addWidget(p.kind)}
                      className="col-span-2 mb-1 flex items-center gap-2.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-2 text-start text-xs hover:bg-primary/10"
                    >
                      <Icon className="h-4 w-4 shrink-0 text-primary" />
                      <span className="min-w-0">
                        <span className="block font-medium text-foreground">
                          {t('reports.wizard.widgets.kind.facilityExplorer', { defaultValue: p.label })}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {t('reports.wizard.explorer.paletteHint', { defaultValue: 'Items and linked data on a live map' })}
                        </span>
                      </span>
                    </button>
                  )
                }
                return (
                  <button
                    key={p.kind}
                    type="button"
                    onClick={() => addWidget(p.kind)}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent"
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0 text-primary" />
                    <span className="truncate">
                      {t(`reports.wizard.widgets.kind.${p.kind}`, { defaultValue: p.label })}
                    </span>
                  </button>
                )
              })}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────── widget card

function WidgetCard({
  index,
  widget,
  total,
  reportSource,
  sourceHints,
  zones,
  dataLinks,
  defaultOpen,
  availableQueries,
  onChange,
  onExplorerChange,
  onRemove,
  onMove,
}: {
  index: number
  widget: ReportWidgetV2
  total: number
  reportSource: ReportSourceRef | null
  sourceHints: ReportSourceHint[]
  zones: Zone[]
  dataLinks: DataLinkConfig[]
  defaultOpen: boolean
  availableQueries: string[]
  onChange: (patch: Partial<ReportWidgetV2>) => void
  onExplorerChange: (bindings: ExplorerBindings) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const kindLabel = useWidgetKindLabel()
  const { t } = useTranslation()
  const meta = paletteEntry(widget.kind)
  const Icon = meta?.icon ?? Palette
  const [open, setOpen] = useState(defaultOpen)
  const isExplorer = widget.kind === 'facilityExplorer'
  // The map & list's first linked-data tab: its points can cluster.
  const clusterTab = isExplorer ? readExplorerBindings(widget).tabs.find((tab) => tab.kind === 'dataLink') : undefined

  const patchBindings = (patch: Record<string, unknown>) =>
    onChange({ bindings: { ...(widget.bindings ?? {}), ...patch } })
  const patchData = (patch: Partial<WidgetDataConfig>) =>
    onChange({ data: { ...(widget.data ?? { agg: 'raw' }), ...patch } })

  return (
    <li className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 p-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-8 shrink-0 text-center">
          #{index + 1}
        </span>
        <div className="w-6 h-6 rounded flex items-center justify-center bg-primary/10 text-primary shrink-0">
          <Icon className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <Input
            value={widget.title ?? ''}
            onChange={(e) => onChange({ title: e.target.value || undefined })}
            placeholder={t('reports.wizard.widgets.titlePlaceholder', {
              defaultValue: 'Widget title (optional)',
            })}
            className="h-7 text-xs"
          />
        </div>
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0">
          {kindLabel(widget.kind)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label={t('reports.builderWidgetMoveUp', { defaultValue: 'Move up' })}
          title={t('reports.builderWidgetMoveUp', { defaultValue: 'Move up' })}
        >
          <ArrowUp className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          aria-label={t('reports.builderWidgetMoveDown', { defaultValue: 'Move down' })}
          title={t('reports.builderWidgetMoveDown', { defaultValue: 'Move down' })}
        >
          <ArrowDown className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={t('reports.wizard.widgets.toggleSettings', { defaultValue: 'Widget settings' })}
          title={t('reports.wizard.widgets.toggleSettings', { defaultValue: 'Widget settings' })}
        >
          <ChevronDown className={cn('w-3.5 h-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={t('reports.builderWidgetRemove', { defaultValue: 'Remove widget' })}
          title={t('reports.builderWidgetRemove', { defaultValue: 'Remove widget' })}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      {open && (
        <div className="border-t border-border p-3 space-y-4 text-xs">
          {isExplorer && (
            <ExplorerSetup
              bindings={readExplorerBindings(widget)}
              sourceHints={sourceHints}
              zones={zones}
              dataLinks={dataLinks}
              onChange={onExplorerChange}
            />
          )}
          {/* The author's clustering default. Written through this card's
              patchBindings ONLY — patchExplorer would strip the tabs'
              queryRefs (a generated report's `rows` query). */}
          {isExplorer && clusterTab && (
            <ExplorerClusterSetup
              value={readClusterBinding((widget.bindings as Record<string, unknown> | undefined)?.cluster)}
              sourceId={clusterTab.sourceId}
              onChange={(c) => patchBindings({ cluster: toBindingValue(c) })}
            />
          )}
          {/* Column span — presentation; a map & list is always full width */}
          {!isExplorer && (
          <div className="grid grid-cols-[auto,1fr] items-center gap-x-3 gap-y-2">
            <Label className="text-xs text-muted-foreground">
              {t('reports.wizard.widgets.columnSpan', { defaultValue: 'Column span' })}
            </Label>
            <div className="inline-flex rounded-md border border-border overflow-hidden w-fit">
              {[1, 2].map((n) => {
                const active = (widget.columnSpan ?? 1) === n
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => onChange({ columnSpan: n as 1 | 2 })}
                    className={cn(
                      'px-3 py-0.5 text-[11px] transition-colors border-e border-border last:border-e-0',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {n === 1
                      ? t('reports.wizard.widgets.span.half', { defaultValue: 'Half width' })
                      : t('reports.wizard.widgets.span.full', { defaultValue: 'Full width' })}
                  </button>
                )
              })}
            </div>
          </div>
          )}

          {/* Data section — for data-consuming widgets */}
          {DATA_KINDS.has(widget.kind) && (
            <WidgetDataEditor
              widget={widget}
              reportSource={reportSource}
              sourceHints={sourceHints}
              availableQueries={availableQueries}
              onDataChange={patchData}
              onQueryRefChange={(q) => onChange({ queryRef: q, data: undefined })}
              onWidgetChange={onChange}
            />
          )}

          {/* Presentation section — kind-specific cosmetic bindings */}
          <PresentationEditor
            widget={widget}
            onChange={patchBindings}
          />
        </div>
      )}
    </li>
  )
}

// ─────────────────────────────────────────────── data editor

function WidgetDataEditor({
  widget,
  reportSource,
  sourceHints,
  availableQueries,
  onDataChange,
  onQueryRefChange,
  onWidgetChange,
}: {
  widget: ReportWidgetV2
  reportSource: ReportSourceRef | null
  sourceHints: ReportSourceHint[]
  availableQueries: string[]
  onDataChange: (patch: Partial<WidgetDataConfig>) => void
  onQueryRefChange: (queryRef: string | undefined) => void
  onWidgetChange: (patch: Partial<ReportWidgetV2>) => void
}) {
  const { t } = useTranslation()
  const usingOwnData = Boolean(widget.data)
  const activeSource = widget.data?.sourceRef ?? reportSource
  const { schema, loading: schemaLoading, error: schemaError } = useSourceSchema(activeSource?.id)

  // When the source changes we may need to clear stale field
  // references — but that's typically what the user wants, so keep it
  // simple: leave the metrics alone; validation will catch missing
  // fields.

  return (
    <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Database className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
          {t('reports.wizard.widgets.dataSection', { defaultValue: 'Data' })}
        </span>
        <div className="flex-1" />
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          <button
            type="button"
            onClick={() => {
              if (!usingOwnData) {
                onWidgetChange({
                  queryRef: undefined,
                  data: {
                    sourceRef: reportSource ?? undefined,
                    agg: AGG_DEFAULT_KINDS.has(widget.kind) ? 'aggregate' : 'raw',
                    groupBy: [],
                    metrics: AGG_DEFAULT_KINDS.has(widget.kind)
                      ? [{ fn: 'count', as: 'count' }]
                      : [],
                    limit: widget.kind === 'dataTable' ? 200 : 500,
                  },
                })
              }
            }}
            className={cn(
              'px-2 py-0.5 text-[10px] transition-colors border-e border-border last:border-e-0',
              usingOwnData
                ? 'bg-primary text-primary-foreground'
                : 'bg-background text-muted-foreground hover:bg-accent',
            )}
          >
            {t('reports.wizard.widgets.dataMode.own', { defaultValue: 'Own data' })}
          </button>
          <button
            type="button"
            onClick={() => {
              onWidgetChange({ data: undefined, queryRef: PRIMARY_QUERY_NAME })
            }}
            className={cn(
              'px-2 py-0.5 text-[10px] transition-colors',
              !usingOwnData
                ? 'bg-primary text-primary-foreground'
                : 'bg-background text-muted-foreground hover:bg-accent',
            )}
          >
            {t('reports.wizard.widgets.dataMode.shared', { defaultValue: 'Share a query' })}
          </button>
        </div>
      </div>

      {!usingOwnData && (
        <div className="grid grid-cols-[auto,1fr] items-center gap-x-3 gap-y-2">
          <Label className="text-xs text-muted-foreground">
            {t('reports.wizard.widgets.queryRef', { defaultValue: 'Reads from query' })}
          </Label>
          <select
            value={widget.queryRef ?? ''}
            onChange={(e) => onQueryRefChange(e.target.value || undefined)}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs w-full"
          >
            {availableQueries.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </div>
      )}

      {usingOwnData && (
        <>
          {/* Source override */}
          <div className="grid grid-cols-[auto,1fr] items-center gap-x-3 gap-y-2">
            <Label className="text-xs text-muted-foreground">
              {t('reports.wizard.widgets.data.source', { defaultValue: 'Source' })}
            </Label>
            <select
              value={activeSource?.id ?? 0}
              onChange={(e) => {
                const id = Number(e.target.value)
                const hint = sourceHints.find((h) => h.id === id)
                if (!hint) return
                onDataChange({
                  sourceRef: { kind: 'dataSource', id: hint.id },
                })
              }}
              className="h-7 rounded-md border border-input bg-background px-2 text-xs w-full"
            >
              {sourceHints.length === 0 && (
                <option value={activeSource?.id ?? 0}>
                  {activeSource ? `#${activeSource.id}` : '—'}
                </option>
              )}
              {sourceHints.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} · {h.kind}
                </option>
              ))}
            </select>
          </div>

          {schemaLoading && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              {t('reports.wizard.widgets.data.loading', { defaultValue: 'Loading fields…' })}
            </div>
          )}
          {schemaError && (
            <div className="flex items-center gap-1.5 text-[11px] text-destructive">
              <AlertCircle className="w-3 h-3" />
              {schemaError}
            </div>
          )}

          {schema && (
            <DataShapeEditor
              widget={widget}
              schema={schema}
              onDataChange={onDataChange}
              onBindingsChange={(patch) =>
                onWidgetChange({ bindings: { ...(widget.bindings ?? {}), ...patch } })
              }
            />
          )}
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────── kind-specific data shape

function DataShapeEditor({
  widget,
  schema,
  onDataChange,
  onBindingsChange,
}: {
  widget: ReportWidgetV2
  schema: ReportSourceSchema
  onDataChange: (patch: Partial<WidgetDataConfig>) => void
  onBindingsChange: (patch: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  const data = widget.data ?? { agg: 'raw' as const }

  // Reflect changes to metrics/groupBy back into bindings so the
  // widget renderer sees the right column names without callers
  // touching two places.
  const syncBindingsForKind = (
    kind: WidgetKindV2,
    groupBy: string[],
    metrics: Metric[],
  ) => {
    if (kind === 'kpi' || kind === 'bigValue') {
      const first = metrics[0]
      if (first) onBindingsChange({ value: metricAlias(first) })
      if (kind === 'bigValue' && metrics[1]) {
        onBindingsChange({ delta: metricAlias(metrics[1]) })
      }
    } else if (kind === 'bar' || kind === 'line' || kind === 'area') {
      onBindingsChange({
        xAxis: groupBy[0],
        series: metrics.map((m) => metricAlias(m)),
      })
    } else if (kind === 'pie' || kind === 'donut') {
      onBindingsChange({
        xAxis: groupBy[0],
        series: metrics.slice(0, 1).map((m) => metricAlias(m)),
      })
    } else if (kind === 'heatmap') {
      // heatmap fields are bindings.value / xAxis / yAxis. Data agg
      // shape mirrors that via metrics[0] = value.
      const first = metrics[0]
      if (first) onBindingsChange({ value: metricAlias(first) })
    }
  }

  const setMetric = (idx: number, patch: Partial<Metric>) => {
    const nextMetrics = [...(data.metrics ?? [])]
    nextMetrics[idx] = { ...nextMetrics[idx], ...patch, as: aliasFor({ ...nextMetrics[idx], ...patch }) }
    onDataChange({ metrics: nextMetrics })
    syncBindingsForKind(widget.kind, data.groupBy ?? [], nextMetrics)
  }
  const addMetric = () => {
    const nextMetrics = [...(data.metrics ?? []), { fn: 'count' as MetricFn, as: 'count' }]
    onDataChange({ metrics: nextMetrics })
    syncBindingsForKind(widget.kind, data.groupBy ?? [], nextMetrics)
  }
  const removeMetric = (idx: number) => {
    const nextMetrics = (data.metrics ?? []).filter((_, i) => i !== idx)
    onDataChange({ metrics: nextMetrics })
    syncBindingsForKind(widget.kind, data.groupBy ?? [], nextMetrics)
  }
  const setGroupBy = (next: string[]) => {
    onDataChange({ groupBy: next })
    syncBindingsForKind(widget.kind, next, data.metrics ?? [])
  }

  const isChart = widget.kind === 'bar' || widget.kind === 'line' || widget.kind === 'area'
  const isPie = widget.kind === 'pie' || widget.kind === 'donut'
  const isKpi = widget.kind === 'kpi' || widget.kind === 'bigValue'

  if (isKpi) {
    const metrics = data.metrics ?? []
    const value = metrics[0]
    const delta = metrics[1]
    return (
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {t('reports.wizard.widgets.data.value', { defaultValue: 'Value to show' })}
          </Label>
          <MetricPicker
            value={value ?? { fn: 'count', as: 'count' }}
            schema={schema}
            onChange={(m) => setMetric(0, m)}
          />
        </div>
        {widget.kind === 'bigValue' && (
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('reports.wizard.widgets.data.delta', { defaultValue: 'Delta (optional)' })}
            </Label>
            {delta ? (
              <div className="flex items-center gap-1.5">
                <div className="flex-1">
                  <MetricPicker
                    value={delta}
                    schema={schema}
                    onChange={(m) => setMetric(1, m)}
                  />
                </div>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => removeMetric(1)}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" className="h-7" onClick={addMetric}>
                <Plus className="w-3 h-3 me-1" />
                {t('reports.wizard.widgets.data.addDelta', { defaultValue: 'Add delta' })}
              </Button>
            )}
          </div>
        )}
      </div>
    )
  }

  if (isChart) {
    return (
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {t('reports.wizard.widgets.data.xAxis', { defaultValue: 'X-axis (group by)' })}
          </Label>
          <FieldPicker
            schema={schema}
            value={data.groupBy?.[0] ?? ''}
            onChange={(v) => setGroupBy(v ? [v] : [])}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {t('reports.wizard.widgets.data.series', { defaultValue: 'Series (one bar/line per metric)' })}
          </Label>
          <div className="space-y-1.5">
            {(data.metrics ?? []).map((m, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className="flex-1">
                  <MetricPicker
                    value={m}
                    schema={schema}
                    onChange={(patched) => setMetric(i, patched)}
                  />
                </div>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => removeMetric(i)}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            ))}
          </div>
          <Button variant="outline" size="sm" className="h-7 mt-1" onClick={addMetric}>
            <Plus className="w-3 h-3 me-1" />
            {t('reports.wizard.widgets.data.addSeries', { defaultValue: 'Add series' })}
          </Button>
        </div>
      </div>
    )
  }

  if (isPie) {
    const metrics = data.metrics ?? []
    const value = metrics[0]
    return (
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {t('reports.wizard.widgets.data.sliceLabel', { defaultValue: 'Slice by' })}
          </Label>
          <FieldPicker
            schema={schema}
            value={data.groupBy?.[0] ?? ''}
            onChange={(v) => setGroupBy(v ? [v] : [])}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {t('reports.wizard.widgets.data.sliceValue', { defaultValue: 'Slice value' })}
          </Label>
          <MetricPicker
            value={value ?? { fn: 'count', as: 'count' }}
            schema={schema}
            onChange={(m) => setMetric(0, m)}
          />
        </div>
      </div>
    )
  }

  if (widget.kind === 'scatter') {
    return (
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {t('reports.wizard.widgets.data.xAxis', { defaultValue: 'X-axis (numeric)' })}
          </Label>
          <FieldPicker
            schema={schema}
            value={typeof widget.bindings?.xAxis === 'string' ? widget.bindings.xAxis : ''}
            onChange={(v) => onBindingsChange({ xAxis: v })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {t('reports.wizard.widgets.data.yAxis', { defaultValue: 'Y-axis (numeric)' })}
          </Label>
          <FieldPicker
            schema={schema}
            value={typeof widget.bindings?.yAxis === 'string' ? widget.bindings.yAxis : ''}
            onChange={(v) => onBindingsChange({ yAxis: v })}
          />
        </div>
      </div>
    )
  }

  if (widget.kind === 'heatmap') {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('reports.wizard.widgets.data.xAxis', { defaultValue: 'X-axis' })}
            </Label>
            <FieldPicker
              schema={schema}
              value={data.groupBy?.[0] ?? ''}
              onChange={(v) => {
                const y = data.groupBy?.[1] ?? ''
                setGroupBy(v && y ? [v, y] : v ? [v] : [])
              }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('reports.wizard.widgets.data.yAxis', { defaultValue: 'Y-axis' })}
            </Label>
            <FieldPicker
              schema={schema}
              value={data.groupBy?.[1] ?? ''}
              onChange={(v) => {
                const x = data.groupBy?.[0] ?? ''
                setGroupBy(x && v ? [x, v] : x ? [x] : [])
              }}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {t('reports.wizard.widgets.data.intensity', { defaultValue: 'Intensity' })}
          </Label>
          <MetricPicker
            value={(data.metrics ?? [])[0] ?? { fn: 'count', as: 'count' }}
            schema={schema}
            onChange={(m) => setMetric(0, m)}
          />
        </div>
      </div>
    )
  }

  if (widget.kind === 'dataTable') {
    const cols = Array.isArray(widget.bindings?.columns)
      ? (widget.bindings?.columns as string[])
      : []
    return (
      <div className="space-y-2">
        <Label className="text-[11px] text-muted-foreground">
          {t('reports.wizard.widgets.data.columns', { defaultValue: 'Columns to show' })}
        </Label>
        <div className="flex flex-wrap gap-1">
          {schema.fields.map((f) => {
            const on = cols.includes(f.key)
            return (
              <button
                key={f.key}
                type="button"
                onClick={() =>
                  onBindingsChange({
                    columns: on ? cols.filter((c) => c !== f.key) : [...cols, f.key],
                  })
                }
                className={cn(
                  'text-[11px] px-2 py-0.5 rounded-md border transition-colors',
                  on
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:bg-accent',
                )}
              >
                {f.label || f.key}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Label className="text-[11px] text-muted-foreground shrink-0">
            {t('reports.wizard.widgets.data.limit', { defaultValue: 'Row limit' })}
          </Label>
          <Input
            type="number"
            value={data.limit ?? 200}
            onChange={(e) => onDataChange({ limit: Math.max(1, Number(e.target.value) || 200) })}
            className="h-7 text-xs w-24"
          />
        </div>
      </div>
    )
  }

  return null
}

// ─────────────────────────────────────────────── presentation editor

function PresentationEditor({
  widget,
  onChange,
}: {
  widget: ReportWidgetV2
  onChange: (patch: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  const b = (widget.bindings ?? {}) as Record<string, unknown>

  if (widget.kind === 'kpi' || widget.kind === 'bigValue') {
    return (
      <div className="grid grid-cols-3 gap-3">
        <TextField
          label={t('reports.wizard.widgets.bindings.label', { defaultValue: 'Label override' })}
          value={typeof b.label === 'string' ? b.label : ''}
          onChange={(v) => onChange({ label: v || undefined })}
        />
        <ToneRadio
          value={typeof b.tone === 'string' ? (b.tone as ToneValue) : 'blue'}
          onChange={(v) => onChange({ tone: v })}
        />
        <FormatSelect
          value={typeof b.format === 'string' ? (b.format as string) : ''}
          onChange={(v) => onChange({ format: v || undefined })}
        />
        {widget.kind === 'bigValue' && (
          <div className="flex items-center gap-2 pt-4 col-span-3">
            <Switch
              checked={b.reversed === true}
              onCheckedChange={(v) => onChange({ reversed: Boolean(v) })}
            />
            <Label className="text-xs">
              {t('reports.wizard.widgets.bindings.reversed', { defaultValue: 'Down is good' })}
            </Label>
          </div>
        )}
      </div>
    )
  }

  if (widget.kind === 'bar' || widget.kind === 'line' || widget.kind === 'area') {
    return (
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={b.stacked === true}
            onCheckedChange={(v) => onChange({ stacked: Boolean(v) })}
          />
          {t('reports.wizard.widgets.bindings.stacked', { defaultValue: 'Stacked' })}
        </label>
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={b.hideLegend === true}
            onCheckedChange={(v) => onChange({ hideLegend: Boolean(v) })}
          />
          {t('reports.wizard.widgets.bindings.hideLegend', { defaultValue: 'Hide legend' })}
        </label>
      </div>
    )
  }

  if (widget.kind === 'note') {
    return (
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            {t('reports.wizard.widgets.bindings.content', { defaultValue: 'Content' })}
          </Label>
          <textarea
            value={typeof b.content === 'string' ? b.content : ''}
            onChange={(e) => onChange({ content: e.target.value })}
            rows={3}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs resize-y"
          />
        </div>
        <NoteToneRadio
          value={typeof b.tone === 'string' ? (b.tone as NoteTone) : 'plain'}
          onChange={(v) => onChange({ tone: v })}
        />
      </div>
    )
  }

  if (widget.kind === 'alert') {
    return (
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            {t('reports.wizard.widgets.bindings.content', { defaultValue: 'Message' })}
          </Label>
          <textarea
            value={typeof b.content === 'string' ? b.content : ''}
            onChange={(e) => onChange({ content: e.target.value })}
            rows={2}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs resize-y"
          />
        </div>
        <AlertToneRadio
          value={typeof b.tone === 'string' ? (b.tone as AlertTone) : 'info'}
          onChange={(v) => onChange({ tone: v })}
        />
      </div>
    )
  }

  if (widget.kind === 'divider') {
    return (
      <p className="text-[11px] text-muted-foreground italic flex items-center gap-1.5">
        <Divide className="w-3 h-3" />
        {t('reports.wizard.widgets.bindings.dividerNote', {
          defaultValue: 'No configuration — renders as a horizontal separator.',
        })}
      </p>
    )
  }

  return null
}

// ─────────────────────────────────────────────── sub-inputs

function MetricPicker({
  value,
  schema,
  onChange,
}: {
  value: Metric
  schema: ReportSourceSchema
  onChange: (v: Metric) => void
}) {
  const { t } = useTranslation()
  const noField = value.fn === 'count'
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={value.fn}
        onChange={(e) => {
          const nextFn = e.target.value as MetricFn
          const nextField = nextFn === 'count' ? undefined : (value.field ?? schema.fields[0]?.key)
          onChange({ ...value, fn: nextFn, field: nextField, as: aliasFor({ ...value, fn: nextFn, field: nextField }) })
        }}
        className="h-7 rounded-md border border-input bg-background px-1.5 text-xs w-40"
      >
        {FNS.map((f) => (
          <option key={f.fn} value={f.fn}>
            {t(`reports.wizard.widgets.data.fn.${f.fn}`, { defaultValue: FN_LABEL(f.fn) })}
          </option>
        ))}
      </select>
      <select
        value={value.field ?? ''}
        onChange={(e) => {
          const nextField = e.target.value || undefined
          onChange({ ...value, field: nextField, as: aliasFor({ ...value, field: nextField }) })
        }}
        disabled={noField}
        className="h-7 rounded-md border border-input bg-background px-1.5 text-xs flex-1 min-w-0"
      >
        <option value="">
          {noField
            ? t('reports.wizard.widgets.data.allRows', { defaultValue: 'all rows' })
            : t('reports.wizard.widgets.data.pickField', { defaultValue: 'pick a field…' })}
        </option>
        {schema.fields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label || f.key}
          </option>
        ))}
      </select>
    </div>
  )
}

function aliasFor(m: Metric): string {
  if (m.fn === 'count') return 'count'
  if (m.fn === 'countDistinct') return `distinct_${m.field ?? 'rows'}`
  return `${m.fn}_${m.field ?? 'rows'}`
}

function FieldPicker({
  schema,
  value,
  onChange,
}: {
  schema: ReportSourceSchema
  value: string
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 rounded-md border border-input bg-background px-1.5 text-xs w-full"
    >
      {!schema.fields.some((f) => f.key === value) && <option value="">—</option>}
      {schema.fields.map((f) => (
        <option key={f.key} value={f.key}>
          {f.label || f.key}
        </option>
      ))}
    </select>
  )
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="h-7 text-xs" />
    </div>
  )
}

type ToneValue = 'blue' | 'purple' | 'emerald' | 'amber'
const TONE_CLASSES: Record<ToneValue, string> = {
  // Same chart tokens the KPI's tone dot uses in the viewer.
  blue: 'bg-chart-1/10 text-chart-1 border-chart-1/40',
  purple: 'bg-chart-3/10 text-chart-3 border-chart-3/40',
  emerald: 'bg-chart-2/10 text-chart-2 border-chart-2/40',
  amber: 'bg-chart-4/10 text-chart-4 border-chart-4/40',
}
function ToneRadio({ value, onChange }: { value: ToneValue; onChange: (v: ToneValue) => void }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">
        {t('reports.wizard.widgets.bindings.tone', { defaultValue: 'Tone' })}
      </Label>
      <div className="flex gap-1">
        {(Object.keys(TONE_CLASSES) as ToneValue[]).map((tone) => (
          <button
            key={tone}
            type="button"
            onClick={() => onChange(tone)}
            className={cn(
              'w-6 h-6 rounded border-2 transition-all',
              TONE_CLASSES[tone],
              value === tone ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : 'opacity-70 hover:opacity-100',
            )}
            aria-label={tone}
          />
        ))}
      </div>
    </div>
  )
}
function FormatSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">
        {t('reports.wizard.widgets.bindings.format', { defaultValue: 'Format' })}
      </Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs w-full"
      >
        <option value="">Auto</option>
        <option value="number">Number</option>
        <option value="percent">Percent</option>
        <option value="currency">Currency</option>
        <option value="date">Date</option>
        <option value="text">Text</option>
      </select>
    </div>
  )
}

type NoteTone = 'plain' | 'info' | 'tip' | 'warn'
const NOTE_TONES: Array<{ value: NoteTone; className: string; label: string }> = [
  { value: 'plain', className: 'border-border bg-card', label: 'Plain' },
  { value: 'info', className: 'border-info/40 bg-info/5 text-info', label: 'Info' },
  { value: 'tip', className: 'border-success/40 bg-success/5 text-success', label: 'Tip' },
  { value: 'warn', className: 'border-warning/40 bg-warning/5 text-warning', label: 'Warn' },
]
function NoteToneRadio({ value, onChange }: { value: NoteTone; onChange: (v: NoteTone) => void }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">
        {t('reports.wizard.widgets.bindings.tone', { defaultValue: 'Tone' })}
      </Label>
      <div className="grid grid-cols-4 gap-1.5">
        {NOTE_TONES.map((tone) => (
          <button
            key={tone.value}
            type="button"
            onClick={() => onChange(tone.value)}
            className={cn(
              'rounded-md border-2 px-2 py-1 text-[11px] transition-all',
              tone.className,
              value === tone.value ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : 'opacity-70 hover:opacity-100',
            )}
          >
            {tone.label}
          </button>
        ))}
      </div>
    </div>
  )
}

type AlertTone = 'info' | 'success' | 'warn' | 'error'
const ALERT_TONES: Array<{ value: AlertTone; className: string; label: string }> = [
  { value: 'info', className: 'border-info/50 bg-info/10 text-info', label: 'Info' },
  { value: 'success', className: 'border-success/50 bg-success/10 text-success', label: 'Success' },
  { value: 'warn', className: 'border-warning/50 bg-warning/10 text-warning', label: 'Warn' },
  { value: 'error', className: 'border-danger/50 bg-danger/10 text-danger', label: 'Error' },
]
function AlertToneRadio({ value, onChange }: { value: AlertTone; onChange: (v: AlertTone) => void }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">
        {t('reports.wizard.widgets.bindings.tone', { defaultValue: 'Tone' })}
      </Label>
      <div className="grid grid-cols-4 gap-1.5">
        {ALERT_TONES.map((tone) => (
          <button
            key={tone.value}
            type="button"
            onClick={() => onChange(tone.value)}
            className={cn(
              'rounded-md border-2 px-2 py-1 text-[11px] transition-all',
              tone.className,
              value === tone.value ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : 'opacity-70 hover:opacity-100',
            )}
          >
            {tone.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Sparse starter bindings — the data editor fills in the rest as
 *  the user picks metrics + groupBy. */
function defaultBindingsFor(kind: WidgetKindV2): Record<string, unknown> {
  switch (kind) {
    case 'kpi':
    case 'bigValue':
      return { value: 'count', tone: 'blue' }
    case 'line':
    case 'bar':
    case 'area':
      return { series: ['count'] }
    case 'pie':
    case 'donut':
      return { series: ['count'] }
    case 'heatmap':
      return { value: 'count' }
    case 'dataTable':
      return { columns: [], pageSize: 20, searchable: true, columnToggle: true }
    case 'note':
      return { content: '', tone: 'plain' }
    case 'alert':
      return { content: '', tone: 'info' }
    default:
      return {}
  }
}

// Reserved for referential completeness — imported types.
export type { ReportQueryV2 as _ReportQueryV2 }
