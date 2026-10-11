/**
 * Facility map & list ("facility explorer") widgets authored in the
 * report builder.
 *
 * The widget's bindings carry everything needed to rebuild it:
 *   { zoneId, tabs: [{ kind, entity, sourceId, dataLinkId?, title?,
 *     titleField?, subtitle[], editable[], queryRef? }] }
 * Each tab reads its own query. The builder never shows those queries:
 * `compileExplorer` writes them on save (named `w_<widget-id>_<n>`, which
 * loadDraft already drops) and points each tab at its own, so viewer
 * filters reach them like every other query on the same source.
 *
 * The generated report set (backend internal/reports/facility_report.go,
 * datalink_report.go) emits the same bindings with its own named queries
 * (`rows_areas`, `rows`); a tab keeps such a query until the author edits
 * the widget (see `explorerQueryRefs` / `releaseExplorerQueries`).
 */

import type { DataLinkConfig } from '@/lib/db'
import type { FilterNode, ReportSourceField } from '@/lib/reports-client'
import type { ReportParam, ReportQueryV2, ReportWidgetV2 } from '@/lib/reports/v2-types'
import { FACILITY_ENTITIES, type FacilityEntity } from '@/lib/reports/facility-sources'

export interface ExplorerTabConfig {
  /** `facility` (default): shapes of a built-in facility source.
   *  `dataLink`: rows of a linked table, placed by data link `dataLinkId`. */
  kind?: 'facility' | 'dataLink'
  /** Facility entity key ("racks"); `data` for linked-data tabs. */
  entity: string
  sourceId: number
  dataLinkId?: number
  /** The author's tab name; empty = the entity's / link's own name. */
  title?: string
  /** Generated reports' tab name (English) — kept for old specs. */
  label?: string
  /** Data tabs: the field shown as each row's title. */
  titleField?: string
  subtitle?: string[]
  editable?: string[]
  queryRef?: string
}

export interface ExplorerBindings {
  zoneId?: number
  tabs: ExplorerTabConfig[]
}

export const EXPLORER_ROW_LIMIT = 5000

/** Fields each facility list shows under the name, and the ones its
 *  detail panel may edit — same as the generated set's `explorerFacts`. */
export const EXPLORER_FACTS: Record<FacilityEntity, { subtitle: string[]; editable: string[] }> = {
  floors: { subtitle: ['elevation_m', 'area_count', 'rack_count', 'marker_count'], editable: ['name', 'elevation_m', 'visible'] },
  areas: { subtitle: ['type', 'floor', 'area_m2'], editable: ['name', 'type', 'color', 'visible'] },
  racks: { subtitle: ['area', 'floor', 'bays'], editable: ['name', 'color', 'visible'] },
  markers: { subtitle: ['icon', 'area', 'floor'], editable: ['name', 'icon', 'label', 'visible'] },
  walls: { subtitle: ['type', 'floor', 'length_m'], editable: ['name', 'thickness_m', 'height_m', 'color', 'visible'] },
  doors: { subtitle: ['type', 'floor', 'width_m'], editable: ['name', 'visible'] },
  stairs: { subtitle: ['type', 'floor', 'to_floor'], editable: ['name', 'visible'] },
  lifts: { subtitle: ['served_floors'], editable: ['name', 'visible'] },
  escalators: { subtitle: ['floor', 'direction', 'to_floor'], editable: ['name', 'visible'] },
  'text-labels': { subtitle: ['text', 'area', 'floor'], editable: ['name', 'text', 'visible'] },
  models: { subtitle: ['model', 'area', 'floor'], editable: ['name', 'visible'] },
}

export function isFacilityEntity(e: string): e is FacilityEntity {
  return (FACILITY_ENTITIES as readonly string[]).includes(e)
}

export function readExplorerBindings(w: Pick<ReportWidgetV2, 'bindings'>): ExplorerBindings {
  const b = (w.bindings ?? {}) as Partial<ExplorerBindings>
  const zone = Number(b.zoneId)
  return { zoneId: Number.isFinite(zone) && zone > 0 ? zone : undefined, tabs: Array.isArray(b.tabs) ? b.tabs : [] }
}

export function facilityTab(entity: FacilityEntity, sourceId: number): ExplorerTabConfig {
  const f = EXPLORER_FACTS[entity]
  return { kind: 'facility', entity, sourceId, subtitle: [...f.subtitle], editable: [...f.editable] }
}

// Same heuristics as the generated linked-data report (pickDataFields).
const IGNORE = /^(id|entity_key|lng|lat|longitude|latitude|position)$|_id$|^elevation|color$|colour$/i
const FLOOR = /^(floor|floor_name|level_name|storey|story)$|^floor/i
const STATUS = /^(status|state|condition|health)$|status/i
const NAME = /(^|_)(name|label|title)$|^name/i

/** A linked-data tab with its title and subtitle picked from the table. */
export function dataLinkTab(link: DataLinkConfig, fields: readonly ReportSourceField[]): ExplorerTabConfig {
  let floor = ''
  let status = ''
  const numbers: string[] = []
  for (const f of fields) {
    if (IGNORE.test(f.key)) continue
    if (f.type === 'text' && !floor && FLOOR.test(f.key)) floor = f.key
    else if (f.type === 'text' && !status && STATUS.test(f.key)) status = f.key
    else if (f.type === 'number' && numbers.length < 1) numbers.push(f.key)
  }
  const isText = (k: string | undefined) => !!k && fields.some((f) => f.key === k && f.type === 'text')
  const join = link.fieldMapping?.match?.join?.payloadField
  let title = isText(join) ? join! : ''
  if (!title) title = fields.find((f) => f.type === 'text' && NAME.test(f.key) && f.key !== floor && f.key !== status)?.key ?? ''
  if (!title && isText(link.fieldMapping?.labelField)) title = link.fieldMapping!.labelField!
  if (!title) title = fields.find((f) => f.type === 'text' && !IGNORE.test(f.key) && f.key !== floor && f.key !== status)?.key ?? ''
  return {
    kind: 'dataLink',
    entity: 'data',
    sourceId: link.sourceId ?? 0,
    dataLinkId: link.id,
    titleField: title || undefined,
    subtitle: [status, floor, ...numbers].filter(Boolean),
  }
}

/** The facility a report is scoped to by a `facility_id = N` filter. */
export function facilityFromFilters(node: FilterNode | undefined): number | null {
  if (!node) return null
  if (node.cond) {
    const v = Number(node.cond.value)
    return node.cond.field === 'facility_id' && node.cond.op === 'eq' && Number.isFinite(v) && v > 0 ? v : null
  }
  for (const n of node.and ?? []) {
    const z = facilityFromFilters(n)
    if (z) return z
  }
  return null
}

/** Query a builder-owned tab reads. */
function tabQuery(name: string, zoneId: number, tab: ExplorerTabConfig): ReportQueryV2 {
  const isData = tab.kind === 'dataLink'
  const sortField = isData ? tab.titleField : 'name'
  return {
    name,
    sourceRef: { kind: 'dataSource', id: tab.sourceId },
    // Linked tables aren't per facility — the link places their rows.
    filters: isData ? undefined : { and: [{ cond: { field: 'facility_id', op: 'eq', value: zoneId } }] },
    sort: sortField ? [{ field: sortField, dir: 'asc' }] : undefined,
    limit: EXPLORER_ROW_LIMIT,
  }
}

/**
 * Save path: give every tab a query. A tab keeps a query the spec
 * already has under another name (the generated set's); every other tab
 * gets a fresh `w_<id>_<n>`. Returns the widget (tabs + queryRef set)
 * and the queries to add.
 */
export function compileExplorer(
  w: ReportWidgetV2,
  existing: ReadonlySet<string>,
): { widget: ReportWidgetV2; queries: ReportQueryV2[] } {
  const { zoneId, tabs } = readExplorerBindings(w)
  if (!zoneId || tabs.length === 0) return { widget: { ...w, queryRef: undefined }, queries: [] }
  const queries: ReportQueryV2[] = []
  // Builder widget ids already start with `w_` (the prefix loadDraft drops).
  const base = w.id.startsWith('w_') ? w.id : `w_${w.id}`
  const out = tabs.map((tab, i) => {
    if (tab.queryRef && !tab.queryRef.startsWith('w_') && existing.has(tab.queryRef)) return tab
    const name = `${base}_${i}`
    queries.push(tabQuery(name, zoneId, tab))
    return { ...tab, queryRef: name }
  })
  return { widget: { ...w, queryRef: out[0].queryRef, bindings: { ...(w.bindings ?? {}), zoneId, tabs: out } }, queries }
}

/** Named (non-`w_`) queries an explorer's tabs read. */
export function explorerQueryRefs(w: ReportWidgetV2): string[] {
  if (w.kind !== 'facilityExplorer') return []
  return readExplorerBindings(w)
    .tabs.map((t) => t.queryRef)
    .filter((q): q is string => !!q && !q.startsWith('w_'))
}

/**
 * When the author edits an explorer, its tabs move to builder-owned
 * queries; drop the named ones it used if nothing else reads them.
 */
export function releaseExplorerQueries(
  before: ReportWidgetV2,
  widgets: readonly ReportWidgetV2[],
  queries: readonly ReportQueryV2[],
  params: readonly ReportParam[],
): ReportQueryV2[] {
  const released = new Set(explorerQueryRefs(before))
  if (released.size === 0) return [...queries]
  const used = new Set<string>()
  for (const w of widgets) {
    if (w.id === before.id) continue
    if (w.queryRef) used.add(w.queryRef)
    for (const q of explorerQueryRefs(w)) used.add(q)
  }
  for (const p of params) {
    const from = (p.input as { options?: { fromQuery?: string } }).options?.fromQuery
    if (from) used.add(from)
  }
  return queries.filter((q) => !released.has(q.name) || used.has(q.name))
}

/** Tabs without their query refs — the builder's edit path. */
export function withoutQueryRefs(tabs: readonly ExplorerTabConfig[]): ExplorerTabConfig[] {
  return tabs.map(({ queryRef: _q, ...rest }) => rest)
}
