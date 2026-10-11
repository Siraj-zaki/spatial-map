/**
 * Wizard draft state — one object with every field the multi-step
 * builder reads or writes. Exposed via React Context so step
 * components consume it without prop-drilling.
 *
 * Kept as plain useState (not Zustand) because the state IS the
 * single source of truth for one open wizard; we don't need
 * cross-component subscriptions with selectors.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type {
  ReportType,
  LayoutConfig,
  ReportWidgetV2,
  ReportQueryV2,
  ReportParam,
  ReportSpecV2,
  ViewerFilter,
  WidgetKindV2,
} from '@/lib/reports/v2-types'
import type {
  FilterNode,
  Metric,
  ReportSourceRef,
  SortKey,
  TableColumnConfig,
  WidgetCondition,
} from '@/lib/reports-client'
import type { ComputedColumn } from '@/lib/reports/computed-columns'

/** Wizard step identifiers — the shell uses these to render the
 *  correct step component. */
export type WizardStepId =
  | 'basics'
  | 'source'
  | 'columns'
  | 'filters'
  | 'viewerFilters'
  | 'sort'
  | 'conditions'
  | 'customColumns'
  | 'aggregations'
  | 'editForm'
  | 'historyConfig'
  | 'params'
  | 'queries'
  | 'widgets'
  | 'layout'
  | 'review'

/** Full draft — every field the wizard collects. Loading an existing
 *  report populates this from the persisted v2 spec; saving flattens
 *  it back to a spec. */
export interface WizardDraft {
  /** null when creating a new report; set to the id once loaded. */
  reportId: number | null

  // Basics
  name: string
  description: string
  icon: string
  color: string
  reportType: ReportType

  /**
   * Whether save emits the wizard's own bundle — the `primary` (+ `totals`)
   * query and the widgets built from them. False for a report authored
   * outside the wizard (the seeded ones, imports): its widgets and
   * queries round-trip verbatim instead of gaining an overlapping
   * auto-generated chart and KPI on every save.
   */
  generatePrimary: boolean

  /**
   * Facility scope (migration 0040). `null` = cross-facility — the
   * report shows under every facility tab as "Shared". A numeric zone
   * id pins it to that warehouse; the Reports directory filter uses
   * this. The Basics step exposes a dropdown so the author can decide.
   */
  zoneId: number | null

  // Data source
  sourceRef: ReportSourceRef | null

  // Columns
  columns: string[]                              // field keys selected, in display order
  columnConfig: Record<string, TableColumnConfig>

  // Filters
  filters: FilterNode | undefined                // AND/OR tree

  // Sort + limit
  sort: SortKey[]
  limit: number

  // Conditional formatting per column
  conditions: Record<string, WidgetCondition[]>

  // Summary path
  groupBy: string[]
  metrics: Metric[]
  /** Which chart type to auto-generate as the primary Summary widget.
   *  bar is a sensible default; line suits time-based groupBys; pie /
   *  donut work best for a single metric with few categories. */
  primaryChartKind: SummaryChartKind

  // Editable path
  editableColumns: string[]
  bulkEditable: boolean

  // History path
  timeField: string | null
  windowDays: number
  timeBucket: 'hour' | 'day' | 'week' | 'month'

  // Custom / computed columns (phase 3 — declared shape now, evaluator later)
  computedColumns: ComputedColumn[]

  // Extra widgets on top of the auto-generated primary
  extraWidgets: ReportWidgetV2[]

  /** Widget ids currently hidden from the layout — kept in
   *  `extraWidgets` (config preserved) but excluded from the saved
   *  spec so the viewer doesn't render them. Populated when the user
   *  drags an extra out of the layout drop area back to the palette
   *  in the Layout step. */
  hiddenWidgetIds: string[]

  /** Extra named queries beyond `primary` / `totals`. Widgets in
   *  `extraWidgets` can bind to any of these via `queryRef`. Each
   *  extra query shares the report source but has its own filters +
   *  sort + limit. */
  extraQueries: ReportQueryV2[]

  // Runtime parameters (surfaces as prompts in the viewer)
  params: ReportParam[]

  // ACL
  permissions: Array<{ userId: number; canEdit: boolean }>

  // Layout metrics
  /** Filters viewers change from the filter bar (Viewer filters step);
   *  compiled into params + conditions + option queries on save. */
  viewerFilters: ViewerFilter[]
  /** Where a generated report came from (spec.origin) — round-tripped
   *  untouched so the facility-set backfill still recognises it. */
  origin?: ReportSpecV2['origin']
  layout: LayoutConfig

  // Wizard nav
  currentStepId: WizardStepId
}

/** Chart kinds valid for the Summary path's auto-generated primary
 *  widget. Full catalog is broader, but these are the ones that
 *  render meaningfully against a groupBy + metrics result. */
export type SummaryChartKind = Extract<WidgetKindV2, 'bar' | 'line' | 'area' | 'pie' | 'donut'>

/** Default draft for a brand-new report. Everything empty; wizard
 *  starts at Basics. */
export function emptyDraft(): WizardDraft {
  return {
    reportId: null,
    name: '',
    description: '',
    icon: '',
    color: '',
    reportType: 'detail',
    generatePrimary: true,
    zoneId: null,
    sourceRef: null,
    columns: [],
    columnConfig: {},
    filters: undefined,
    sort: [],
    limit: 500,
    conditions: {},
    groupBy: [],
    metrics: [],
    primaryChartKind: 'bar',
    editableColumns: [],
    bulkEditable: false,
    timeField: null,
    windowDays: 30,
    timeBucket: 'day',
    computedColumns: [],
    extraWidgets: [],
    hiddenWidgetIds: [],
    extraQueries: [],
    params: [],
    permissions: [],
    viewerFilters: [],
    layout: { kind: 'document' },
    currentStepId: 'basics',
  }
}

// ---------------------------------------------------------- context

/** Update helper — accepts a partial patch and merges into the draft. */
/** A patch, or a function of the latest draft (for async callers). */
export type UpdateDraft = (patch: Partial<WizardDraft> | ((prev: WizardDraft) => Partial<WizardDraft>)) => void

interface WizardContextValue {
  draft: WizardDraft
  update: UpdateDraft
  goTo: (step: WizardStepId) => void
  next: () => void
  back: () => void
  /** Ordered list of steps for the current report type — used by the
   *  step nav and the next/back buttons. */
  stepOrder: WizardStepId[]
}

const WizardContext = createContext<WizardContextValue | null>(null)

/** Provider — wraps the wizard shell so every step can call
 *  `useWizard()` to read + mutate the draft without prop drilling. */
export function WizardProvider({
  initialDraft,
  children,
}: {
  initialDraft: WizardDraft
  children: ReactNode
}) {
  const [draft, setDraft] = useState<WizardDraft>(initialDraft)

  const update: UpdateDraft = (patch) =>
    setDraft((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }))

  const stepOrder = useMemo(() => stepsForType(draft.reportType), [draft.reportType])

  const goTo = (step: WizardStepId) => setDraft((prev) => ({ ...prev, currentStepId: step }))

  const next = () => {
    const idx = stepOrder.indexOf(draft.currentStepId)
    if (idx < 0 || idx >= stepOrder.length - 1) return
    goTo(stepOrder[idx + 1])
  }
  const back = () => {
    const idx = stepOrder.indexOf(draft.currentStepId)
    if (idx <= 0) return
    goTo(stepOrder[idx - 1])
  }

  // Snapshot the context object so downstream memoised selectors don't
  // over-render on unrelated state changes. `draft` identity changes
  // per patch — that's expected and cheap because steps re-render only
  // when a field they read moves.
  const value = useMemo<WizardContextValue>(
    () => ({ draft, update, goTo, next, back, stepOrder }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, stepOrder],
  )

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>
}

/** Hook every step uses to read + mutate the wizard state. Throws
 *  when called outside a WizardProvider — that's an integration bug,
 *  not a runtime condition, so the error should be loud. */
export function useWizard(): WizardContextValue {
  const ctx = useContext(WizardContext)
  if (!ctx) throw new Error('useWizard must be used inside a WizardProvider')
  return ctx
}

// ---------------------------------------------------------- step visibility

/** Which steps show for each report type, in wizard order. Shared by
 *  the left rail (step nav) and the next/back buttons. */
export function stepsForType(type: ReportType): WizardStepId[] {
  // `columns` now hosts the computed-column editor inline, so
  // `customColumns` is no longer part of the step order. The step id
  // remains in the union for any spec that references it in loadDraft.
  const common: WizardStepId[] = ['basics', 'source', 'columns', 'filters', 'viewerFilters', 'sort']
  const shared: WizardStepId[] = ['conditions']
  const tail: WizardStepId[] = ['params', 'queries', 'widgets', 'layout', 'review']
  switch (type) {
    case 'summary':
      return [...common, ...shared, 'aggregations', ...tail]
    case 'editable':
      return [...common, ...shared, 'editForm', ...tail]
    case 'history':
      return [...common, 'historyConfig', ...shared, ...tail]
    case 'detail':
    default:
      return [...common, ...shared, ...tail]
  }
}
