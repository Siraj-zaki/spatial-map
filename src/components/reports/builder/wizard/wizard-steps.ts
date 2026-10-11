/**
 * Static wizard metadata shared by the shell (step rail + header), the
 * Basics step (type cards) and the Review step (summary, "go to step"
 * links). Kept out of the component files so importing it creates no
 * cycle and doesn't break fast refresh.
 */

import { Database, Edit3, History as HistoryIcon, LayoutList, PieChart } from 'lucide-react'
import type { ReportType } from '@/lib/reports/v2-types'
import type { WizardStepId } from './wizard-state'

/** Label + short description for each step — shown in the left rail
 *  and (for the current step) as a header at the top of the pane. */
export const STEP_LABELS: Record<WizardStepId, { key: string; fallback: string; hint: string }> = {
  basics: { key: 'reports.wizard.step.basics', fallback: 'Basics', hint: 'Name, description, report type' },
  source: { key: 'reports.wizard.step.source', fallback: 'Data source', hint: 'Choose the table or feed this report reads from' },
  columns: { key: 'reports.wizard.step.columns', fallback: 'Columns', hint: 'Pick which fields to show and how' },
  filters: { key: 'reports.wizard.step.filters', fallback: 'Filters', hint: 'Narrow which rows appear' },
  viewerFilters: { key: 'reports.wizard.step.viewerFilters', fallback: 'Viewer filters', hint: 'Filters your viewers can change — Floor, Area, Type, search, dates' },
  sort: { key: 'reports.wizard.step.sort', fallback: 'Sort & limit', hint: 'Default ordering + row cap' },
  conditions: { key: 'reports.wizard.step.conditions', fallback: 'Conditional formatting', hint: 'Colour cells based on their value' },
  customColumns: { key: 'reports.wizard.step.customColumns', fallback: 'Custom columns', hint: 'Combine or compute columns from raw data' },
  aggregations: { key: 'reports.wizard.step.aggregations', fallback: 'Group & aggregate', hint: 'Roll up rows into totals, averages, counts' },
  editForm: { key: 'reports.wizard.step.editForm', fallback: 'Edit form', hint: 'Which columns viewers can edit, single or bulk' },
  historyConfig: { key: 'reports.wizard.step.historyConfig', fallback: 'Time window', hint: 'Which time field to track and how far back' },
  params: { key: 'reports.wizard.step.params', fallback: 'Parameters', hint: 'Runtime prompts viewers can change to reslice the report' },
  queries: { key: 'reports.wizard.step.queries', fallback: 'Extra queries', hint: 'Extra named queries widgets can bind to — same source, different slice' },
  widgets: { key: 'reports.wizard.step.widgets', fallback: 'Widgets', hint: 'Add KPI cards, charts, notes on top of the primary view' },
  layout: { key: 'reports.wizard.step.layout', fallback: 'Layout', hint: 'Arrange widgets, toggle the filters bar, and pick document, grid or full-map mode' },
  review: { key: 'reports.wizard.step.review', fallback: 'Review & save', hint: 'Check the report and who can see it before saving' },
}

/** The four report types offered on the Basics step. */
export const REPORT_TYPES: Array<{ id: ReportType; icon: typeof Database; labelKey: string; fallback: string; hintKey: string; hintFallback: string }> = [
  {
    id: 'detail',
    icon: LayoutList,
    labelKey: 'reports.wizard.type.detail',
    fallback: 'Detail',
    hintKey: 'reports.wizard.type.detailHint',
    hintFallback: 'Rich table of records with filters, sort, and per-column formatting.',
  },
  {
    id: 'summary',
    icon: PieChart,
    labelKey: 'reports.wizard.type.summary',
    fallback: 'Summary',
    hintKey: 'reports.wizard.type.summaryHint',
    hintFallback: 'Group rows and aggregate (sum / avg / count) for charts and KPIs.',
  },
  {
    id: 'editable',
    icon: Edit3,
    labelKey: 'reports.wizard.type.editable',
    fallback: 'Editable',
    hintKey: 'reports.wizard.type.editableHint',
    hintFallback: 'Records viewers can edit inline — single row or bulk. Table-kind sources only.',
  },
  {
    id: 'history',
    icon: HistoryIcon,
    labelKey: 'reports.wizard.type.history',
    fallback: 'History',
    hintKey: 'reports.wizard.type.historyHint',
    hintFallback: 'Time-based view — pick a timestamp field and a rolling window.',
  },
]
