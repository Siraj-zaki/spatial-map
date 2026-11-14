/**
 * Master report — one live, configurable report per facility: the full map
 * with the chosen data layers (a facility-explorer tab each, so each draws,
 * narrows with the filters and plays back its history), a count per layer,
 * status charts, and viewer filters.
 *
 * Set up in MasterReportDialog. The setup is stored in `spec.origin =
 * { kind: 'master', key: 'master:<zoneId>', zoneId, config }`, so updating
 * reopens it with the same choices (a report built before the setup existed
 * is read back from its widgets — `setupFromSpec`). An update rebuilds only
 * what the setup generates — `explorer`, `kpi_<link>`, `chart_<link>`,
 * `rows_<link>` and the `vf_*` filters — and keeps everything an author
 * added in the builder. Generated widgets keep their edits (title, tone, tab
 * names and fields) while the setup still asks for them; filter ids stay
 * stable per field, so links that carry filter values keep working.
 *
 * Written in its compiled form (the shape the builder saves — explorer tabs
 * with their own queries, viewer filters already injected), so it opens and
 * edits like any other report.
 */

import { apiDb } from '@/lib/api-db'
import { createReport, getReport, getReportSourceSchema, listReports, updateReport, type Report, type ReportSourceField, type ReportSpec } from '@/lib/reports-client'
import { dataLinkTab, EXPLORER_ROW_LIMIT } from '@/lib/reports/explorer-spec'
import { applyViewerFilters, isViewerFilterQuery, kindsForType, stripViewerFilters, suggestViewerFilters, VIEWER_FILTER_PREFIX, viewerFilterId } from '@/lib/reports/viewer-filters'
import type { ReportQueryV2, ReportSpecV2, ReportWidgetV2, ViewerFilter, ViewerFilterKind } from '@/lib/reports/v2-types'
import type { DataLinkConfig } from '@/lib/db'

export const MASTER_ORIGIN_KIND = 'master'
/** Defaults for a first setup; the dialog can turn on more. */
const DEFAULT_KPIS = 10
const DEFAULT_CHARTS = 6
/** Layer order: layers that play back history, then tinted areas, then points, then the rest. */
const MODE_RANK: Record<string, number> = { 'history-movement': 0, 'shape-tint': 1, 'point-at-coord': 2 }
const TONES = ['blue', 'purple', 'emerald', 'amber'] as const
const STATUS = /(^|_)(status|state)$/i
const EXPLORER_ID = 'explorer'
const GENERATED_WIDGET = /^(kpi|chart)_\d+$/
const GENERATED_QUERY = /^(kpi|chart|rows)_\d+$/

export interface MasterLayerSetup {
  linkId: number
  /** A count card for the layer. */
  kpi: boolean
  /** The text field its status chart groups by; null = no chart. */
  chart: string | null
}

export interface MasterFilterSetup {
  field: string
  kind: ViewerFilterKind
  label: string
}

export interface MasterReportSetup {
  name: string
  /** The layers in the report, in tab order. */
  layers: MasterLayerSetup[]
  filters: MasterFilterSetup[]
  /** How it opens. */
  view: 'map' | 'page'
}

/** What's stored in `spec.origin.config`: the setup plus every link the
 *  facility had then, so a later setup can tell which ones are new. */
interface StoredSetup extends MasterReportSetup {
  known: number[]
}

export interface MasterReportText {
  name: string
  description: string
  mapTitle: string
  rowsLabel: string
  /** "<layer> by <field>" */
  byStatus: (layer: string, field: string) => string
}

/** Everything the dialog and the builder need about one facility. */
export interface MasterInputs {
  zoneId: number
  /** The facility's data links, in default order. */
  links: DataLinkConfig[]
  fieldsBySource: ReadonlyMap<number, ReadonlyArray<ReportSourceField>>
  /** The facility's master report, if it has one. */
  existing: Report | null
}

export function isMasterReport(r: Pick<Report, 'spec'>): boolean {
  return (r.spec as { origin?: { kind?: string } } | undefined)?.origin?.kind === MASTER_ORIGIN_KIND
}

const byMode = (a: DataLinkConfig, b: DataLinkConfig) =>
  (MODE_RANK[a.renderMode] ?? 3) - (MODE_RANK[b.renderMode] ?? 3) || (a.name ?? '').localeCompare(b.name ?? '')

/** Load a facility's links, their tables' fields and its master report. */
export async function loadMasterInputs(zoneId: number): Promise<MasterInputs> {
  const [allLinks, reports] = await Promise.all([apiDb.dataLinkConfigs.toArray(), listReports({ zoneId })])
  const links = allLinks.filter((l) => l.zoneId === zoneId && l.id !== undefined && l.sourceId !== undefined).sort(byMode)
  const fieldsBySource = new Map<number, ReadonlyArray<ReportSourceField>>()
  await Promise.all(
    [...new Set(links.map((l) => l.sourceId as number))].map((id) =>
      getReportSourceSchema(id)
        .then((s) => fieldsBySource.set(id, s.fields))
        .catch(() => fieldsBySource.set(id, [])),
    ),
  )
  return { zoneId, links, fieldsBySource, existing: reports.find(isMasterReport) ?? null }
}

/** Text fields a layer's chart can group by — status-like ones first. */
export function chartFields(fields: ReadonlyArray<ReportSourceField>): ReportSourceField[] {
  const text = fields.filter((f) => f.type === 'text' && !/(^|_)(id|key|name|title|label|description|vin|epc|sku)$/i.test(f.key))
  return [...text.filter((f) => STATUS.test(f.key)), ...text.filter((f) => !STATUS.test(f.key))]
}

/** A report built before the setup was stored, read back from its widgets. */
function setupFromSpec(spec: ReportSpecV2, name: string): MasterReportSetup {
  const explorer = (spec.widgets ?? []).find((w) => w.id === EXPLORER_ID)
  const tabs = ((explorer?.bindings as { tabs?: Array<{ dataLinkId?: number }> } | undefined)?.tabs ?? []).filter((t) => t.dataLinkId)
  const widgets = new Map((spec.widgets ?? []).map((w) => [w.id, w]))
  return {
    name,
    layers: tabs.map((t) => ({
      linkId: t.dataLinkId as number,
      kpi: widgets.has(`kpi_${t.dataLinkId}`),
      chart: ((widgets.get(`chart_${t.dataLinkId}`)?.bindings as { xAxis?: string } | undefined)?.xAxis) ?? null,
    })),
    filters: (spec.viewerFilters ?? []).map((f) => ({ field: f.field, kind: f.kind, label: f.label })),
    view: spec.layout?.kind === 'map' ? 'map' : 'page',
  }
}

/**
 * The setup the dialog opens with: the stored one (layers whose link is
 * gone dropped, links added since then included and listed in `fresh`),
 * else defaults — every layer, a count each, a status chart each (up to
 * the caps), a Floor filter when a table has `floor`.
 */
export function initialMasterSetup(inputs: MasterInputs, name: string): { setup: MasterReportSetup; fresh: Set<number> } {
  const { links, fieldsBySource, existing } = inputs
  const fields = (l: DataLinkConfig) => fieldsBySource.get(l.sourceId as number) ?? []
  const defaultChart = (l: DataLinkConfig) => fields(l).find((f) => f.type === 'text' && STATUS.test(f.key))?.key ?? null
  const ids = new Set(links.map((l) => l.id as number))

  if (existing) {
    const spec = existing.spec as unknown as ReportSpecV2
    const stored = (spec.origin as { config?: StoredSetup } | undefined)?.config
    const saved = stored ?? setupFromSpec(spec, existing.name)
    const known = new Set(stored?.known ?? saved.layers.map((l) => l.linkId))
    const layers = saved.layers
      .filter((l) => ids.has(l.linkId))
      .map((l) => {
        const link = links.find((x) => x.id === l.linkId)!
        return { ...l, chart: l.chart && fields(link).some((f) => f.key === l.chart) ? l.chart : null }
      })
    const added = links.filter((l) => !known.has(l.id as number))
    layers.push(...added.map((l) => ({ linkId: l.id as number, kpi: true, chart: defaultChart(l) })))
    return { setup: { ...saved, name: existing.name || saved.name, layers }, fresh: new Set(added.map((l) => l.id as number)) }
  }

  let charts = 0
  const layers = links.map((l, i) => {
    const chart = charts < DEFAULT_CHARTS ? defaultChart(l) : null
    if (chart) charts++
    return { linkId: l.id as number, kpi: i < DEFAULT_KPIS, chart }
  })
  const hasFloor = links.some((l) => fields(l).some((f) => f.key === 'floor'))
  return {
    setup: { name, layers, filters: hasFloor ? [{ field: 'floor', kind: 'dropdown', label: '' }] : [], view: 'map' },
    fresh: new Set(),
  }
}

export interface MasterFilterCandidate {
  field: ReportSourceField
  kinds: ViewerFilterKind[]
  /** How many of the chosen layers' tables have the field. */
  layers: number
}

/** Fields the chosen layers can be filtered by, best first. */
export function masterFilterCandidates(inputs: MasterInputs, layerIds: readonly number[]): MasterFilterCandidate[] {
  const byKey = new Map<string, MasterFilterCandidate & { score: number }>()
  for (const l of inputs.links) {
    if (!layerIds.includes(l.id as number)) continue
    for (const s of suggestViewerFilters(inputs.fieldsBySource.get(l.sourceId as number) ?? [], [])) {
      const prev = byKey.get(s.field.key)
      if (prev) {
        prev.layers++
        prev.score = Math.max(prev.score, s.score)
      } else {
        byKey.set(s.field.key, { field: s.field, kinds: kindsForType(s.field.type), layers: 1, score: s.score })
      }
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score || b.layers - a.layers || a.field.key.localeCompare(b.field.key))
    .map(({ field, kinds, layers }) => ({ field, kinds, layers }))
}

/** The master report's spec, compiled (pure). Null when no layer is chosen. */
export function buildMasterReportSpec({
  inputs,
  setup,
  text,
}: {
  inputs: MasterInputs
  setup: MasterReportSetup
  text: MasterReportText
}): ReportSpecV2 | null {
  const { zoneId, links, fieldsBySource, existing } = inputs
  const linkById = new Map(links.map((l) => [l.id as number, l]))
  const layers = setup.layers
    .map((s) => ({ s, l: linkById.get(s.linkId) }))
    .filter((x): x is { s: MasterLayerSetup; l: DataLinkConfig } => x.l !== undefined)
  if (layers.length === 0) return null
  const prev = (existing?.spec as unknown as ReportSpecV2 | undefined) ?? null
  const prevWidget = new Map((prev?.widgets ?? []).map((w) => [w.id, w]))
  const fields = (l: DataLinkConfig) => fieldsBySource.get(l.sourceId as number) ?? []
  const src = (l: DataLinkConfig) => ({ kind: 'dataSource' as const, id: l.sourceId as number })
  const layerName = (l: DataLinkConfig) => l.name || `#${l.id}`

  // Queries: the setup's, then the author's own (viewer filters stripped —
  // they're compiled in again below).
  const queries: ReportQueryV2[] = []
  const widgets: ReportWidgetV2[] = []
  const kpis = layers.filter(({ s }) => s.kpi)
  kpis.forEach(({ l }, i) => {
    const id = `kpi_${l.id}`
    queries.push({ name: id, sourceRef: src(l), metrics: [{ fn: 'count', as: 'v' }], limit: 1 } as ReportQueryV2)
    widgets.push(
      prevWidget.get(id) ?? ({ id, kind: 'bigValue', queryRef: id, columnSpan: 2, title: layerName(l), bindings: { value: 'v', tone: TONES[i % TONES.length] } } as unknown as ReportWidgetV2),
    )
  })

  const prevExplorer = prevWidget.get(EXPLORER_ID)
  const prevTabs = ((prevExplorer?.bindings as { tabs?: Array<{ dataLinkId?: number }> } | undefined)?.tabs ?? []) as Array<Record<string, unknown> & { dataLinkId?: number }>
  const tabs = layers.map(({ l }) => {
    const name = `rows_${l.id}`
    const tab = dataLinkTab(l, fields(l))
    queries.push({
      name, sourceRef: src(l),
      ...(tab.titleField ? { sort: [{ field: tab.titleField, dir: 'asc' as const }] } : {}),
      limit: EXPLORER_ROW_LIMIT,
    } as ReportQueryV2)
    const kept = prevTabs.find((t) => t.dataLinkId === l.id)
    return kept ? { ...kept, sourceId: l.sourceId, queryRef: name } : { ...tab, label: l.name || undefined, queryRef: name }
  })
  widgets.push({
    ...(prevExplorer ?? { id: EXPLORER_ID, kind: 'facilityExplorer', title: text.mapTitle }),
    queryRef: tabs[0].queryRef,
    bindings: { ...((prevExplorer?.bindings as object | undefined) ?? {}), zoneId, tabs },
  } as ReportWidgetV2)

  for (const { s, l } of layers) {
    if (!s.chart) continue
    const id = `chart_${l.id}`
    queries.push({ name: id, sourceRef: src(l), groupBy: [s.chart], metrics: [{ fn: 'count', as: 'n' }], sort: [{ field: 'n', dir: 'desc' }], limit: 20 } as ReportQueryV2)
    const kept = prevWidget.get(id)
    const label = fields(l).find((f) => f.key === s.chart)?.label || s.chart
    widgets.push(
      kept && (kept.bindings as { xAxis?: string } | undefined)?.xAxis === s.chart
        ? kept
        : ({ id, kind: 'donut', queryRef: id, columnSpan: 2, title: text.byStatus(layerName(l), label), bindings: { xAxis: s.chart, series: ['n'], seriesLabels: { n: text.rowsLabel } } } as unknown as ReportWidgetV2),
    )
  }

  // The author's own widgets, queries and params ride along.
  widgets.push(...(prev?.widgets ?? []).filter((w) => w.id !== EXPLORER_ID && !GENERATED_WIDGET.test(w.id)))
  queries.push(
    ...(prev?.queries ?? [])
      .filter((q) => !GENERATED_QUERY.test(q.name) && !isViewerFilterQuery(q.name))
      .map((q) => ({ ...q, filters: stripViewerFilters(q.filters) })),
  )
  const ownParams = (prev?.params ?? []).filter((p) => !p.id.startsWith(VIEWER_FILTER_PREFIX))

  // Viewer filters over the chosen layers' tables that have the field; a
  // field keeps its id across updates.
  const taken: string[] = ownParams.map((p) => p.id)
  const viewerFilters: ViewerFilter[] = []
  for (const f of setup.filters) {
    const sourceIds = [...new Set(layers.filter(({ l }) => fields(l).some((x) => x.key === f.field)).map(({ l }) => l.sourceId as number))]
    if (sourceIds.length === 0) continue
    const label = f.label || layers.flatMap(({ l }) => fields(l)).find((x) => x.key === f.field)?.label || f.field
    const kept = prev?.viewerFilters?.find((v) => v.field === f.field)?.id
    const id = kept && !taken.includes(kept) ? kept : viewerFilterId(f.field, taken)
    taken.push(id)
    viewerFilters.push({ id, field: f.field, label, kind: f.kind, sourceIds })
  }
  const compiled = applyViewerFilters(queries, ownParams, viewerFilters)

  // Grid positions too, so the report also lays out if an author switches it to the grid.
  let x = 0, y = 0, rowH = 0
  const placed = widgets.map((w, i) => {
    const size = w.kind === 'facilityExplorer' ? { w: 12, h: 8 } : w.kind === 'bigValue' || w.kind === 'kpi' ? { w: 3, h: 2 } : { w: 6, h: 4 }
    if (x + size.w > 12) { x = 0; y += rowH; rowH = 0 }
    const out = { ...w, order: i + 1, position: { x, y, ...size } }
    x += size.w
    rowH = Math.max(rowH, size.h)
    return out
  })
  const ids = new Set(placed.map((w) => w.id))
  const mapSlots = Object.fromEntries(Object.entries(prev?.layout?.mapSlots ?? {}).filter(([id]) => ids.has(id)))
  const stored: StoredSetup = { ...setup, known: links.map((l) => l.id as number) }

  return {
    ...(prev ?? {}),
    v: 2,
    layout: { ...(prev?.layout ?? {}), kind: setup.view === 'map' ? 'map' : 'document', mapSlots },
    sources: [...new Map(compiled.queries.map((q) => [q.sourceRef.id, q.sourceRef])).values()],
    params: compiled.params,
    viewerFilters,
    queries: compiled.queries,
    widgets: placed,
    origin: { kind: MASTER_ORIGIN_KIND, key: `master:${zoneId}`, zoneId, config: stored },
  } as unknown as ReportSpecV2
}

/** Save the setup: update the facility's master report, or create it. */
export async function saveMasterReport(inputs: MasterInputs, setup: MasterReportSetup, text: MasterReportText): Promise<Report> {
  const spec = buildMasterReportSpec({ inputs, setup, text })
  if (!spec) throw new Error('no-layers')
  const { existing, zoneId } = inputs
  const body = {
    name: setup.name.trim() || existing?.name || text.name,
    description: existing?.description || text.description,
    icon: existing?.icon || 'map',
    color: existing?.color || '#0f766e',
    spec: spec as unknown as ReportSpec,
    specVersion: 2,
    zoneId,
  }
  if (!existing) return createReport(body)
  // An update replaces the access list — send the current one back (the
  // directory listing doesn't carry it).
  const current = await getReport(existing.id)
  return updateReport(existing.id, {
    ...body,
    permissions: (current.permissions ?? []).map((p) => ({ userId: p.userId, canEdit: p.canEdit })),
  })
}
