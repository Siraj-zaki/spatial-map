import { useTranslation } from 'react-i18next'
import type { WidgetKindV2 } from '@/lib/reports/v2-types'

/** What each widget kind is called wherever the builder names it (the
 *  Widgets list, the Layout canvas and its Insert palette) — never the
 *  raw kind id. Translated under `reports.wizard.widgets.kind.<kind>`. */
export const WIDGET_KIND_LABEL: Record<WidgetKindV2, string> = {
  kpi: 'KPI',
  bigValue: 'Big value + delta',
  line: 'Line chart',
  bar: 'Bar chart',
  area: 'Area chart',
  pie: 'Pie chart',
  donut: 'Donut chart',
  scatter: 'Scatter plot',
  heatmap: 'Heatmap',
  sankey: 'Sankey',
  table: 'Table',
  dataTable: 'Data table',
  editableTable: 'Editable table',
  history: 'History',
  markdown: 'Text',
  note: 'Note',
  alert: 'Alert banner',
  divider: 'Divider',
  tabs: 'Tabs',
  accordion: 'Accordion',
  dimensionGrid: 'Dimension grid',
  map: 'Map',
  facilityExplorer: 'Facility map & list',
}

export function useWidgetKindLabel(): (kind: WidgetKindV2 | string) => string {
  const { t } = useTranslation()
  return (kind) =>
    t(`reports.wizard.widgets.kind.${kind}`, { defaultValue: WIDGET_KIND_LABEL[kind as WidgetKindV2] ?? kind })
}
