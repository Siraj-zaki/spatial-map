/**
 * Pure v1 → v2 converter. Mirrors the backend counterpart at
 * `backend/internal/reports/specmigrate/migrate.go` so the two ends
 * always agree on what a migrated spec looks like — the same v1 blob
 * produces the same v2 tree on both sides.
 *
 * v2 is the ONLY on-disk spec after `cmd/migrate-reports-to-v2` runs;
 * this helper stays useful for the frontend as an idempotent
 * safety net (any stray v1 blob a stale cache surfaces still renders
 * correctly) and for tests.
 */
import type {
  FilterCond,
  FilterNode,
  ReportSpec,
  ReportWidget,
} from '@/lib/reports-client'
import {
  DEFAULT_LAYOUT,
  isPresentationOnly,
  REPORT_SPEC_VERSION,
  type ReportQueryV2,
  type ReportSpecV2,
  type ReportWidgetV2,
  type WidgetKindV2,
} from './v2-types'

/** The name every migrated v1 spec's single synthesized query takes. */
export const MAIN_QUERY_NAME = 'main'

/** Cols wide the migrated widgets stack across — matches DEFAULT_LAYOUT. */
const DEFAULT_COLS = DEFAULT_LAYOUT.cols

/**
 * Migrate a v1 or v2 spec to v2. Idempotent — a v2 input returns
 * unchanged (well, with the layout defaults filled in when absent).
 */
export function migrateToV2(spec: ReportSpec | ReportSpecV2 | null | undefined): ReportSpecV2 {
  if (!spec) {
    return {
      v: REPORT_SPEC_VERSION,
      layout: { ...DEFAULT_LAYOUT },
      queries: [],
      params: [],
      widgets: [],
      sources: [],
    }
  }
  if (isV2(spec)) {
    return {
      ...spec,
      v: REPORT_SPEC_VERSION,
      layout: { ...DEFAULT_LAYOUT, ...(spec.layout ?? {}) },
      params: spec.params ?? [],
      queries: spec.queries ?? [],
      widgets: spec.widgets ?? [],
      sources: spec.sources ?? [],
    }
  }
  return convertV1(spec as ReportSpec)
}

function isV2(spec: unknown): spec is ReportSpecV2 {
  return (
    typeof spec === 'object' &&
    spec !== null &&
    'v' in spec &&
    (spec as { v: unknown }).v === REPORT_SPEC_VERSION
  )
}

function convertV1(v1: ReportSpec): ReportSpecV2 {
  const spec: ReportSpecV2 = {
    v: REPORT_SPEC_VERSION,
    sources: v1.sources ?? [],
    params: [],
    queries: [],
    layout: { ...DEFAULT_LAYOUT },
    widgets: [],
    presentation: v1.presentation,
  }

  const needsQuery =
    (v1.sources && v1.sources.length > 0) ||
    v1.filters !== undefined ||
    (v1.groupBy && v1.groupBy.length > 0) ||
    (v1.metrics && v1.metrics.length > 0)

  if (needsQuery) {
    const query: ReportQueryV2 = {
      name: MAIN_QUERY_NAME,
      sourceRef: (v1.sources && v1.sources[0]) ?? { kind: 'dataSource', id: 0 },
      filters: v1.filters,
      groupBy: v1.groupBy,
      metrics: v1.metrics,
      sort: v1.sort,
      limit: v1.limit,
    }
    spec.queries!.push(query)
    // Promote prompt-filter placeholders into typed textInput params.
    if (query.filters) {
      const seen = new Set<string>()
      promotePromptFilters(query.filters, spec, seen)
    }
  }

  if (v1.widgets && v1.widgets.length > 0) {
    let nextY = 0
    spec.widgets = v1.widgets.map((w, i) => {
      const height = defaultWidgetHeight(w.kind)
      const widget: ReportWidgetV2 = {
        id: w.id || `w_${i + 1}`,
        kind: w.kind as WidgetKindV2,
        title: w.title,
        bindings: (w.bindings as Record<string, unknown>) ?? undefined,
        icon: w.icon,
        color: w.color,
        position: { x: 0, y: nextY, w: DEFAULT_COLS, h: height },
      }
      if (needsQuery && !isPresentationOnly(widget.kind)) {
        widget.queryRef = MAIN_QUERY_NAME
      }
      nextY += height
      return widget
    })
  }

  return spec
}

/** Default row-span the migrator gives a v1 widget so imported dashboards read at a glance. */
function defaultWidgetHeight(kind: ReportWidget['kind']): number {
  switch (kind) {
    case 'kpi':
    case 'divider':
      return 2
    case 'markdown':
      return 3
    case 'history':
      return 8
    default:
      return 6
  }
}

/**
 * Walk the filter tree; every leaf whose op requires a value but whose
 * value is empty (a "prompt filter") becomes a `textInput` param and
 * its value slot is rewritten to `"{{param.<id>}}"` so the executor
 * resolves at run time.
 */
function promotePromptFilters(
  node: FilterNode,
  spec: ReportSpecV2,
  seen: Set<string>,
): void {
  if (!node) return
  if (node.and) {
    for (const child of node.and) promotePromptFilters(child, spec, seen)
  }
  if (node.or) {
    for (const child of node.or) promotePromptFilters(child, spec, seen)
  }
  if (!node.cond) return
  const cond = node.cond
  if (!isPromptCond(cond)) return
  const id = paramIdFromField(cond.field)
  if (!seen.has(id)) {
    seen.add(id)
    spec.params!.push({
      id,
      label: cond.field,
      input: { kind: 'textInput' },
    })
  }
  // Rewrite the value slot to reference the promoted param.
  cond.value = `{{param.${id}}}`
}

/** Mirrors the backend `queryx.CondIsInactive` check on the client. */
function isPromptCond(cond: FilterCond): boolean {
  // Value-free ops never need a runtime value.
  if (cond.op === 'isnull' || cond.op === 'notnull') return false
  const v = cond.value
  if (v === undefined || v === null || v === '') return true
  if (Array.isArray(v) && v.length === 0) return true
  if (typeof v === 'string' && v.trim() === '') return true
  return false
}

/** Turn a payload field key into a valid param id (dots become underscores). */
function paramIdFromField(field: string): string {
  const cleaned = field.replace(/[^a-zA-Z0-9_]/g, '_')
  return cleaned.length > 0 ? cleaned : 'prompt'
}
