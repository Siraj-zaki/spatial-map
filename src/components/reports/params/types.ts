import type { ReportParam } from '@/lib/reports/v2-types'

/** One option surfaced by dropdown / buttonGroup / dimensionGrid. */
export interface ResolvedOption {
  value: unknown
  label: string
}

/** Props every ParamInput* component takes. Values are typed generically —
 *  each input casts as needed. */
export interface ParamInputProps<T = unknown> {
  param: ReportParam
  value: T | undefined
  userSet: boolean
  onChange: (v: T) => void
  onReset: () => void
  /** Options resolved either from the static list on the param or from a
   *  fetched query. Undefined = still loading. */
  optionsResolved?: ResolvedOption[]
  optionsLoading?: boolean
  optionsError?: string
  /** Right-to-left rendering. Passed explicitly so components don't have
   *  to read `document.dir`. */
  isRtl?: boolean
  /** Compact form for the collapsible chip strip. */
  compact?: boolean
}
