/**
 * Viewer filters — the filters a report's viewers change from its filter
 * bar, authored in one click in the builder's Viewer filters step.
 *
 * A viewer filter is stored as metadata (`spec.viewerFilters`) and
 * compiled at save time into what the runtime already understands:
 *   - a param (`id`, prefix `vf_`) with the right input;
 *   - an options query `opt_<id>` (distinct values, never filtered by
 *     the params, so the dropdown doesn't shrink to the current pick);
 *   - the condition(s) it adds to EVERY query reading one of its
 *     `sourceIds` — the main table, extra queries and widgets alike.
 * Unset filters drop out on the server (the condition is inactive), so
 * "All" is simply "no value".
 *
 * `stripViewerFilters` undoes the injection when a report is loaded back
 * into the builder, so the conditions never pile up across saves. The
 * facility report set (backend internal/reports/facility_report.go)
 * emits the same shape.
 */

import type { FilterCond, FilterNode, ReportFieldType, ReportSourceField } from '@/lib/reports-client'
import type { ReportParam, ReportQueryV2, ViewerFilter, ViewerFilterKind } from '@/lib/reports/v2-types'

export const VIEWER_FILTER_PREFIX = 'vf_'

const ref = (id: string, sub?: string) => `{{param.${id}${sub ? `.${sub}` : ''}}}`
const REF_RE = /^\{\{\s*param\.(vf_[A-Za-z0-9_]+)(?:\.[a-z]+)?\s*\}\}$/

export function optionQueryName(vf: Pick<ViewerFilter, 'id'>): string {
  return `opt_${vf.id}`
}

/** The input kinds that fit a field type, best first. */
export function kindsForType(type: ReportFieldType): ViewerFilterKind[] {
  switch (type) {
    case 'boolean':
      return ['yesNo']
    case 'date':
    case 'datetime':
      return ['dateRange']
    case 'number':
      return ['dropdown', 'multi', 'buttons']
    default:
      return ['dropdown', 'multi', 'buttons', 'search']
  }
}

/** The param the runtime renders for a viewer filter. */
export function viewerFilterParam(vf: ViewerFilter): ReportParam {
  const fromQuery = { fromQuery: optionQueryName(vf), valueColumn: vf.options?.valueColumn ?? vf.field }
  switch (vf.kind) {
    case 'dropdown':
      return { id: vf.id, label: vf.label, input: { kind: 'dropdown', options: fromQuery } }
    case 'multi':
      return { id: vf.id, label: vf.label, input: { kind: 'dropdown', multi: true, options: fromQuery } }
    case 'buttons':
      return { id: vf.id, label: vf.label, input: { kind: 'buttonGroup', options: fromQuery } }
    case 'search':
      return { id: vf.id, label: vf.label, input: { kind: 'textInput', placeholder: vf.options?.placeholder ?? vf.label } }
    case 'dateRange':
      return { id: vf.id, label: vf.label, input: { kind: 'dateRange', presets: ['last7', 'last30', 'last90'] } }
    case 'yesNo':
      return {
        id: vf.id,
        label: vf.label,
        input: {
          kind: 'buttonGroup',
          options: {
            static: [
              { value: 'true', label: vf.options?.trueLabel ?? 'Yes' },
              { value: 'false', label: vf.options?.falseLabel ?? 'No' },
            ],
          },
        },
      }
  }
}

/** The condition(s) a viewer filter adds to each query on its sources. */
export function viewerFilterConds(vf: ViewerFilter): FilterCond[] {
  switch (vf.kind) {
    case 'multi':
      return [{ field: vf.field, op: 'in', value: ref(vf.id) }]
    case 'search':
      return [{ field: vf.field, op: 'contains', value: ref(vf.id) }]
    case 'dateRange':
      return [
        { field: vf.field, op: 'onOrAfter', value: ref(vf.id, 'start') },
        { field: vf.field, op: 'onOrBefore', value: ref(vf.id, 'end') },
      ]
    default:
      return [{ field: vf.field, op: 'eq', value: ref(vf.id) }]
  }
}

/**
 * Options query for dropdown / multi / buttons, else null. `base` is the
 * report's fixed conditions on that source (e.g. facility_id = 71), so
 * the options cover the same rows the report does — never filtered by
 * the viewer's own picks.
 */
export function viewerFilterOptionQuery(vf: ViewerFilter, base?: FilterNode): ReportQueryV2 | null {
  if (vf.kind !== 'dropdown' && vf.kind !== 'multi' && vf.kind !== 'buttons') return null
  const sourceId = vf.options?.sourceId ?? vf.sourceIds[0]
  if (!sourceId) return null
  const field = vf.options?.valueColumn ?? vf.field
  const notBlank: FilterNode = { cond: { field, op: 'notnull' } }
  const filters: FilterNode = { and: [...(base ? (base.and ?? [base]) : []), notBlank] }
  if (vf.options?.sortField) {
    return {
      name: optionQueryName(vf),
      sourceRef: { kind: 'dataSource', id: sourceId },
      filters,
      sort: [{ field: vf.options.sortField, dir: 'asc' }],
      limit: 500,
    }
  }
  return {
    name: optionQueryName(vf),
    sourceRef: { kind: 'dataSource', id: sourceId },
    filters,
    groupBy: [field],
    sort: [{ field, dir: 'asc' }],
    limit: 500,
  }
}

function withConds(filters: FilterNode | undefined, conds: FilterCond[]): FilterNode | undefined {
  if (conds.length === 0) return filters
  const extra: FilterNode[] = conds.map((c) => ({ cond: c }))
  if (!filters) return { and: extra }
  if (filters.and) return { ...filters, and: [...filters.and, ...extra] }
  return { and: [filters, ...extra] }
}

/**
 * Compile viewer filters into a spec's queries + params: inject each
 * filter's conditions into every query on its sources (option queries
 * excluded), and append the option queries and params.
 */
export function applyViewerFilters(
  queries: ReportQueryV2[],
  params: ReportParam[],
  filters: readonly ViewerFilter[],
): { queries: ReportQueryV2[]; params: ReportParam[] } {
  if (filters.length === 0) return { queries, params }
  const optionNames = new Set(filters.map(optionQueryName))
  const out = queries
    .filter((q) => !optionNames.has(q.name))
    .map((q) => {
      const conds = filters
        .filter((vf) => vf.sourceIds.includes(q.sourceRef.id))
        .flatMap(viewerFilterConds)
      return conds.length ? { ...q, filters: withConds(q.filters, conds) } : q
    })
  // Fixed conditions of the first query on each source (the report's
  // own scope) — the options cover exactly those rows.
  const baseFor = (sourceId: number | undefined) => {
    const q = queries.find((x) => !optionNames.has(x.name) && x.sourceRef.id === sourceId)
    return stripTemplateConds(q?.filters)
  }
  for (const vf of filters) {
    const oq = viewerFilterOptionQuery(vf, vf.options?.filters ?? baseFor(vf.options?.sourceId ?? vf.sourceIds[0]))
    if (oq) out.push(oq)
  }
  const ids = new Set(filters.map((f) => f.id))
  return { queries: out, params: [...params.filter((p) => !ids.has(p.id)), ...filters.map(viewerFilterParam)] }
}

/** Keep only fixed conditions: drop every `{{param.…}}` leaf (and OR
 *  groups, which can't be narrowed safely). */
function stripTemplateConds(node: FilterNode | undefined): FilterNode | undefined {
  if (!node) return undefined
  if (node.cond) {
    const v = node.cond.value
    return typeof v === 'string' && v.includes('{{') ? undefined : node
  }
  if (node.and) {
    const and = node.and.map(stripTemplateConds).filter((n): n is FilterNode => n !== undefined)
    return and.length ? { and } : undefined
  }
  return undefined
}

/** Remove viewer-filter conditions from a filter tree (load path). */
export function stripViewerFilters(node: FilterNode | undefined): FilterNode | undefined {
  if (!node) return node
  if (node.cond) {
    const v = node.cond.value
    return typeof v === 'string' && REF_RE.test(v.trim()) ? undefined : node
  }
  const strip = (list: FilterNode[] | undefined) =>
    (list ?? []).map(stripViewerFilters).filter((n): n is FilterNode => n !== undefined)
  if (node.and) {
    const and = strip(node.and)
    return and.length ? { ...node, and } : undefined
  }
  if (node.or) {
    const or = strip(node.or)
    return or.length ? { ...node, or } : undefined
  }
  return node
}

/** Is this an options query a viewer filter generated? */
export function isViewerFilterQuery(name: string): boolean {
  return name.startsWith(`opt_${VIEWER_FILTER_PREFIX}`)
}

/** A param id for a new filter on `field`, unique among `taken`. */
export function viewerFilterId(field: string, taken: readonly string[]): string {
  const base = `${VIEWER_FILTER_PREFIX}${field.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()}`.slice(0, 40)
  let id = base
  for (let i = 2; taken.includes(id); i++) id = `${base}_${i}`
  return id
}

/** Field names that read as identifiers, never as filters. */
const SKIP = /^(id|entity_key|lng|lat|longitude|latitude)$|_id$/i
/** Names viewers usually slice by — offered first, as dropdowns. */
const CATEGORY = /floor|area|zone|type|kind|category|status|state|department|dept|icon|location|site|group|brand|supplier|vendor|team|owner|level|class|priority|stage/i
/** Names that read as a free-text search. */
const SEARCHY = /^(name|title|label|text|description|sku|code|reference|ref)$/i

export interface ViewerFilterSuggestion {
  field: ReportSourceField
  kind: ViewerFilterKind
  score: number
}

/** Ranked one-click suggestions for a source's fields. */
export function suggestViewerFilters(fields: readonly ReportSourceField[], taken: readonly string[]): ViewerFilterSuggestion[] {
  const out: ViewerFilterSuggestion[] = []
  for (const f of fields) {
    if (SKIP.test(f.key) || taken.includes(f.key)) continue
    let kind: ViewerFilterKind
    let score: number
    if (f.type === 'boolean') {
      kind = 'yesNo'
      score = 60
    } else if (f.type === 'date' || f.type === 'datetime') {
      kind = 'dateRange'
      score = 50
    } else if (f.type === 'number') {
      continue
    } else if (SEARCHY.test(f.key)) {
      kind = 'search'
      score = 70
    } else if (CATEGORY.test(f.key)) {
      kind = 'dropdown'
      score = 90
    } else {
      kind = 'dropdown'
      score = 20
    }
    out.push({ field: f, kind, score })
  }
  return out.sort((a, b) => b.score - a.score || a.field.key.localeCompare(b.field.key))
}
