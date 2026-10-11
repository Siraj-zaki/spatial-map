import * as React from 'react'
import { Minus, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  type LengthUnit,
  fromMeters,
  toMeters,
  stepFor,
  decimalsFor,
  UNIT_SUFFIX,
} from '@/lib/units'

interface BaseProps {
  /** Min/max in the *storage* representation (meters when `unit` set, raw otherwise). */
  min?: number
  max?: number
  /** Override step in the displayed unit (default = `stepFor(unit)` or 1). */
  step?: number
  /** Override decimal places in the displayed unit (default = `decimalsFor(unit)` or 2). */
  decimals?: number
  disabled?: boolean
  className?: string
  inputClassName?: string
  /** Optional label rendered above the field. */
  label?: React.ReactNode
  /** Optional aria-label when no visible `label` is provided. */
  ariaLabel?: string
  /** Hide the +/- spinner buttons. */
  hideSpinner?: boolean
  /** Tooltip on the field. */
  title?: string
}

interface LengthProps extends BaseProps {
  /** Value stored in METERS. */
  value: number
  /** Active display unit. The value is converted before display. */
  unit: LengthUnit
  /** Fires with the new METERS value. */
  onChange: (meters: number) => void
  /** Raw mode is off when `unit` is provided. */
  suffix?: never
}

interface RawProps extends BaseProps {
  /** Value used as-is; no conversion. */
  value: number
  /** Optional suffix shown to the right (e.g. '°', 'px'). */
  suffix?: string
  /** Fires with the new raw value. */
  onChange: (value: number) => void
  unit?: undefined
}

type NumberInputProps = LengthProps | RawProps

/**
 * Decimal-friendly numeric input with ± spinner and unit suffix.
 *
 * - When `unit` is set, `value` is interpreted as METERS and converted to
 *   the active unit for display. `onChange` fires with the meters value.
 * - When `unit` is omitted, the input behaves as a plain number field;
 *   `suffix` is shown to the right of the value (e.g. '°').
 *
 * Editing flow: while the user is typing, we hold the partial string in
 * local state so they can freely type '12.', '1.2e' etc. without us
 * stomping on the keystroke. On blur (or Enter), we parse, clamp, and
 * fire `onChange` with the committed value.
 */
export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput(props, ref) {
    const { t } = useTranslation()
    const {
      value,
      min,
      max,
      decimals,
      disabled,
      className,
      inputClassName,
      label,
      ariaLabel,
      hideSpinner,
      title,
    } = props
    const unit = 'unit' in props ? props.unit : undefined
    const suffix = unit ? UNIT_SUFFIX[unit] : (props as RawProps).suffix
    const effectiveDecimals = decimals ?? (unit ? decimalsFor(unit) : 2)
    const effectiveStep = props.step ?? (unit ? stepFor(unit) : 1)

    /** Convert storage value → string shown in the input. */
    const formatDisplay = React.useCallback(
      (storage: number): string => {
        const shown = unit ? fromMeters(storage, unit) : storage
        const fixed = shown.toFixed(effectiveDecimals)
        return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
      },
      [unit, effectiveDecimals]
    )

    const [draft, setDraft] = React.useState(() => formatDisplay(value))
    const [editing, setEditing] = React.useState(false)

    // Sync external value into the draft when not actively editing.
    React.useEffect(() => {
      if (!editing) setDraft(formatDisplay(value))
    }, [value, editing, formatDisplay])

    const clampStorage = React.useCallback(
      (storage: number): number => {
        let v = storage
        if (typeof min === 'number') v = Math.max(min, v)
        if (typeof max === 'number') v = Math.min(max, v)
        return v
      },
      [min, max]
    )

    /** Parse the draft string → storage value, clamped. Returns null if unparseable. */
    const parse = React.useCallback(
      (s: string): number | null => {
        const trimmed = s.trim()
        if (trimmed === '' || trimmed === '-' || trimmed === '.') return null
        const n = Number(trimmed)
        if (!Number.isFinite(n)) return null
        const storage = unit ? toMeters(n, unit) : n
        return clampStorage(storage)
      },
      [unit, clampStorage]
    )

    const commit = React.useCallback(() => {
      const parsed = parse(draft)
      if (parsed === null) {
        // Revert to last known good value.
        setDraft(formatDisplay(value))
      } else if (parsed !== value) {
        // Use a type assertion to bridge the union: both branches accept number.
        ;(props.onChange as (n: number) => void)(parsed)
        setDraft(formatDisplay(parsed))
      } else {
        setDraft(formatDisplay(parsed))
      }
      setEditing(false)
    }, [parse, draft, value, formatDisplay, props.onChange])

    const bump = React.useCallback(
      (direction: 1 | -1) => {
        const displayed = unit ? fromMeters(value, unit) : value
        const nextDisplayed = displayed + direction * effectiveStep
        const storage = clampStorage(unit ? toMeters(nextDisplayed, unit) : nextDisplayed)
        ;(props.onChange as (n: number) => void)(storage)
        setDraft(formatDisplay(storage))
      },
      [unit, value, effectiveStep, clampStorage, formatDisplay, props.onChange]
    )

    return (
      <div className={cn('space-y-1.5', className)}>
        {label && (
          <div className="text-xs flex items-center justify-between">
            {label}
          </div>
        )}
        <div
          title={title}
          className={cn(
            'flex items-stretch h-8 rounded-md border border-input bg-transparent overflow-hidden focus-within:ring-1 focus-within:ring-ring transition-shadow',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
        >
          {!hideSpinner && (
            <button
              type="button"
              onClick={() => bump(-1)}
              disabled={disabled}
              tabIndex={-1}
              className="px-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:cursor-not-allowed"
              aria-label={t('numberInput.decrease', { defaultValue: 'Decrease' })}
            >
              <Minus className="w-3 h-3" />
            </button>
          )}
          <input
            ref={ref}
            type="text"
            inputMode="decimal"
            value={draft}
            disabled={disabled}
            aria-label={ariaLabel}
            onFocus={() => setEditing(true)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                setDraft(formatDisplay(value))
                setEditing(false)
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                bump(1)
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                bump(-1)
              }
            }}
            className={cn(
              'flex-1 min-w-0 bg-transparent px-2 text-sm font-mono tabular-nums text-foreground focus:outline-none',
              inputClassName
            )}
          />
          {suffix && (
            <span className="flex items-center px-2 text-[11px] text-muted-foreground select-none border-s border-input/60 bg-muted/30">
              {suffix}
            </span>
          )}
          {!hideSpinner && (
            <button
              type="button"
              onClick={() => bump(1)}
              disabled={disabled}
              tabIndex={-1}
              className="px-2 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:cursor-not-allowed"
              aria-label={t('numberInput.increase', { defaultValue: 'Increase' })}
            >
              <Plus className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    )
  }
)
