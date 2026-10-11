import type { ReportParam } from '@/lib/reports/v2-types'
import { ParamButtonGroup } from './param-button-group'
import { ParamCheckbox } from './param-checkbox'
import { ParamDateInput } from './param-date-input'
import { ParamDateRange } from './param-date-range'
import { ParamDimensionGrid } from './param-dimension-grid'
import { ParamDropdown } from './param-dropdown'
import { ParamSlider } from './param-slider'
import { ParamTextInput } from './param-text-input'
import type { ParamInputProps, ResolvedOption } from './types'

/**
 * Kind-dispatcher — picks the right specialised input component and
 * forwards the shared props. Any component receives the same
 * generically-typed `ParamInputProps`; the wrappers below cast per
 * kind's expected value shape.
 */
export interface ParamInputRootProps {
  param: ReportParam
  value: unknown
  userSet: boolean
  onChange: (v: unknown) => void
  onReset: () => void
  optionsResolved?: ResolvedOption[]
  optionsLoading?: boolean
  optionsError?: string
  isRtl?: boolean
  compact?: boolean
}

export function ParamInput(props: ParamInputRootProps) {
  // Cast through `unknown` so each specialised component receives its
  // own value-shape signature. The dispatcher is intentionally
  // permissive — the individual widgets validate the shape at use.
  const forwarded = props as unknown as ParamInputProps<unknown>
  switch (props.param.input.kind) {
    case 'dropdown':
      return <ParamDropdown {...(forwarded as unknown as ParamInputProps<string | string[]>)} />
    case 'buttonGroup':
      return <ParamButtonGroup {...(forwarded as unknown as ParamInputProps<string>)} />
    case 'dateInput':
      return <ParamDateInput {...(forwarded as unknown as ParamInputProps<string>)} />
    case 'dateRange':
      return <ParamDateRange {...(forwarded as unknown as ParamInputProps<{ start?: string; end?: string }>)} />
    case 'slider':
      return <ParamSlider {...(forwarded as unknown as ParamInputProps<number>)} />
    case 'textInput':
      return <ParamTextInput {...(forwarded as unknown as ParamInputProps<string>)} />
    case 'checkbox':
      return <ParamCheckbox {...(forwarded as unknown as ParamInputProps<boolean>)} />
    case 'dimensionGrid':
      return <ParamDimensionGrid {...(forwarded as unknown as ParamInputProps<import('@/lib/reports/predicate-types').Predicate>)} />
    default:
      return null
  }
}
