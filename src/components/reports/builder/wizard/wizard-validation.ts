/**
 * Draft validation for the report builder — one list the whole builder
 * reads: the step rail flags steps that need attention, the Review step
 * lists every issue, and Save refuses only on `blocking` ones.
 *
 * Blocking = the report can't run at all (no name, no source, no
 * columns). Everything else is a warning: the report saves and opens,
 * but a widget / parameter / query will render empty or error until
 * fixed — that's the author's call, not a hard stop.
 */

import type { TFunction } from 'i18next'
import type { WizardDraft, WizardStepId } from './wizard-state'
import { readExplorerBindings } from '@/lib/reports/explorer-spec'

export interface DraftIssue {
  step: WizardStepId
  message: string
  blocking: boolean
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

export function validateDraft(draft: WizardDraft, t: TFunction): DraftIssue[] {
  const out: DraftIssue[] = []
  const add = (step: WizardStepId, key: string, fallback: string, vars: Record<string, unknown> = {}, blocking = false) =>
    out.push({ step, blocking, message: t(`reports.wizard.issue.${key}`, { defaultValue: fallback, ...vars }) })

  if (!draft.name.trim()) add('basics', 'name', 'Give the report a name.', {}, true)
  if (!draft.sourceRef) add('source', 'source', 'Pick a data source.', {}, true)
  // Only table-shaped reports need an explicit column list. For Summary /
  // History an empty list means "all fields" (that's how loadDraft
  // leaves it when the spec has no table widget) — requiring it made a
  // saved Summary report unsaveable until the Columns step was visited.
  // (None of the primary-bundle checks apply to a report authored
  // outside the wizard — it has no bundle; see `generatePrimary`.)
  if (draft.generatePrimary && (draft.reportType === 'detail' || draft.reportType === 'editable') && draft.sourceRef && draft.columns.length === 0) {
    add('columns', 'columns', 'Select at least one column.', {}, true)
  }

  if (draft.generatePrimary && draft.reportType === 'summary') {
    if (draft.metrics.length === 0) add('aggregations', 'metrics', 'Summary reports need at least one aggregation.')
    if (draft.groupBy.length === 0) add('aggregations', 'groupBy', 'Add a group-by field so the summary chart has categories.')
  }
  if (draft.reportType === 'editable' && draft.sourceRef && draft.sourceRef.kind !== 'dataSource') {
    add('source', 'editableSource', 'Editable reports need a table as their source.', {}, true)
  }
  for (const vf of draft.viewerFilters) {
    if (vf.sourceIds.length === 0) {
      add('viewerFilters', 'viewerFilterNoSource', 'Viewer filter “{{label}}” doesn’t narrow anything — tick a source.', { label: vf.label || vf.field })
    }
    if (!vf.label.trim()) add('viewerFilters', 'viewerFilterNoLabel', 'Give every viewer filter a label.')
  }
  if (draft.generatePrimary && draft.reportType === 'history' && !draft.timeField) {
    add('historyConfig', 'timeField', 'Pick the time field to track.')
  }

  // Extra widgets — own-data widgets need a source (+ a metric / group-by
  // when aggregating); shared-query widgets need a query; content widgets
  // need content.
  draft.extraWidgets.forEach((w, i) => {
    const label = w.title || `#${i + 1}`
    if (w.kind === 'note' || w.kind === 'alert') {
      if (!nonEmpty((w.bindings ?? {}).content)) add('widgets', 'widgetContent', 'Widget “{{label}}” has no content yet.', { label })
      return
    }
    if (w.kind === 'divider' || w.kind === 'markdown') return
    if (w.kind === 'facilityExplorer') {
      const { zoneId, tabs } = readExplorerBindings(w)
      if (!zoneId) add('widgets', 'explorerFacility', 'Map & list “{{label}}” needs a facility.', { label })
      else if (tabs.length === 0) add('widgets', 'explorerTabs', 'Map & list “{{label}}” needs at least one thing to show.', { label })
      return
    }
    if (w.data) {
      if (!w.data.sourceRef || !w.data.sourceRef.id) add('widgets', 'widgetSource', 'Widget “{{label}}” needs a data source.', { label })
      if (w.data.agg === 'aggregate') {
        if (!(w.data.metrics ?? []).length) add('widgets', 'widgetMetric', 'Widget “{{label}}” needs at least one metric.', { label })
        if (w.kind !== 'kpi' && w.kind !== 'bigValue' && !(w.data.groupBy ?? []).length) {
          add('widgets', 'widgetGroupBy', 'Widget “{{label}}” needs a group-by field.', { label })
        }
      } else if (w.kind === 'dataTable') {
        if (((w.bindings?.columns as unknown[] | undefined) ?? []).length === 0) {
          add('widgets', 'widgetColumns', 'Widget “{{label}}” needs at least one column.', { label })
        }
      }
      if (w.kind === 'scatter') {
        const b = (w.bindings ?? {}) as Record<string, unknown>
        if (!nonEmpty(b.xAxis) || !nonEmpty(b.yAxis)) add('widgets', 'widgetScatter', 'Scatter widget “{{label}}” needs an x-axis and a y-axis column.', { label })
      }
    } else if (!w.queryRef) {
      add('widgets', 'widgetQuery', 'Widget “{{label}}” needs a query or its own data.', { label })
    }
  })

  // The page holds one facility at a time (one spatial store), so every
  // map & list must show the same one.
  const explorerZones = new Set(
    draft.extraWidgets
      .filter((w) => w.kind === 'facilityExplorer' && !draft.hiddenWidgetIds.includes(w.id))
      .map((w) => readExplorerBindings(w).zoneId)
      .filter((z): z is number => !!z),
  )
  if (explorerZones.size > 1) {
    add('widgets', 'explorerOneFacility', 'Every map & list in a report must show the same facility — a report page shows one facility at a time.', {}, true)
  }

  if (draft.layout?.kind === 'map') {
    const ready = draft.extraWidgets.some((w) => {
      if (w.kind !== 'facilityExplorer' || draft.hiddenWidgetIds.includes(w.id)) return false
      const b = readExplorerBindings(w)
      return Boolean(b.zoneId) && b.tabs.length > 0
    })
    if (!ready) {
      add('layout', 'mapNeedsExplorer', 'The full map needs a facility map & list — until then the report opens as a page.')
    }
  }

  // Extra queries — named, unique, not reserved; grouping needs a metric.
  const names = new Set<string>()
  draft.extraQueries.forEach((q, i) => {
    if (!q.name.trim()) {
      add('queries', 'queryName', 'Extra query #{{n}} needs a name.', { n: i + 1 })
      return
    }
    if (draft.generatePrimary && (q.name === 'primary' || q.name === 'totals')) add('queries', 'queryReserved', 'Query name “{{name}}” is reserved — pick another.', { name: q.name })
    if (names.has(q.name)) add('queries', 'queryDuplicate', 'Two queries are named “{{name}}”.', { name: q.name })
    names.add(q.name)
    if ((q.groupBy ?? []).length > 0 && (q.metrics ?? []).length === 0) {
      add('queries', 'queryMetrics', 'Query “{{name}}” groups rows but has no metric.', { name: q.name })
    }
  })

  // Parameters — pickers need options, dimension grids need a query + columns.
  draft.params.forEach((p) => {
    if (p.input.kind === 'dropdown' || p.input.kind === 'buttonGroup') {
      const opts = p.input.options
      const hasStatic = Array.isArray(opts?.static) && (opts?.static?.length ?? 0) > 0
      const hasQuery = Boolean(opts?.fromQuery && opts?.valueColumn)
      if (!hasStatic && !hasQuery) add('params', 'paramOptions', 'Parameter “{{id}}” needs a list of options or a query to take them from.', { id: p.id })
    }
    if (p.input.kind === 'dimensionGrid') {
      if (!p.input.options?.fromQuery) add('params', 'gridQuery', 'Parameter “{{id}}” needs a source query.', { id: p.id })
      if ((p.input.columns ?? []).length === 0) add('params', 'gridColumns', 'Parameter “{{id}}” needs at least one pivot column.', { id: p.id })
    }
  })

  return out
}
