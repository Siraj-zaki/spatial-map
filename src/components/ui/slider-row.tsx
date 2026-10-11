/**
 * Slider + NumberInput row. Pairs a Radix slider with a decimal-capable
 * numeric input so users can either drag for approximate values OR type
 * exact decimal values (34.5, 12.75, etc.). Both stay in sync via the
 * shared `value` prop.
 *
 * Use this everywhere you'd otherwise write a bare `<Slider>` inside
 * a label row — it eliminates the "sliders don't support decimals"
 * problem across the sidebar in one place. The NumberInput's draft
 * pattern also means backspace/mid-word edits don't get stomped by
 * parent state on every keystroke.
 *
 * `max` is the slider's drag range. By default it is also the highest
 * value accepted. Pass `limitMax` for fields where the slider range is
 * just the common case (sizes, distances, counts): the typed value may
 * then go up to `limitMax`, and the slider stretches to follow it (see
 * StretchSlider). Leave it off for true limits — opacity, angles, 0–1.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { Label } from '@/components/ui/label'
import { MixedBadge } from '@/components/ui/mixed-badge'
import { NumberInput } from '@/components/ui/number-input'
import { StretchSlider } from '@/components/ui/stretch-slider'
import { cn } from '@/lib/utils'

interface SliderRowProps {
  label: React.ReactNode
  value: number
  onChange: (value: number) => void
  min: number
  /** End of the slider's drag range (and the cap, unless `limitMax`). */
  max: number
  /** Highest value a user may type or stretch the slider to. Use for
   * sizes and counts whose real range is wider than the comfortable
   * drag range. Infinity = no upper limit. */
  limitMax?: number
  /** Slider step. Defaults to 0.1 so decimal drags are supported by
   * default. Pass 1 explicitly for integer-only fields (icon size in
   * pixels, count fields, etc.). */
  step?: number
  /** Number of decimals shown in the paired NumberInput. Defaults to
   * 2 for non-integer steps, 0 otherwise. */
  decimals?: number
  suffix?: string
  disabled?: boolean
  className?: string
  /** Optional badge/hint shown inside the label row (e.g. Mixed). */
  labelExtra?: React.ReactNode
}

export function SliderRow({
  label,
  value,
  onChange,
  min,
  max,
  limitMax,
  step,
  decimals,
  suffix,
  disabled,
  className,
  labelExtra,
}: SliderRowProps) {
  const { t } = useTranslation()
  const labelId = React.useId()
  const stretches = limitMax !== undefined && limitMax > max
  const effectiveStep = step ?? 0.1
  const inferredDecimals =
    decimals ?? (Number.isInteger(effectiveStep) ? 0 : 2)
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label className="flex items-center justify-between text-xs">
        <span id={labelId}>{label}</span>
        {labelExtra}
      </Label>
      <div className="flex items-center gap-2">
        <StretchSlider
          value={value}
          onValueChange={onChange}
          min={min}
          max={max}
          limitMax={limitMax}
          step={effectiveStep}
          disabled={disabled}
          className="flex-1"
          aria-labelledby={labelId}
        />
        <NumberInput
          value={value}
          onChange={onChange}
          min={min}
          max={stretches ? limitMax : max}
          title={
            stretches
              ? t('sliderRow.typeBeyond', {
                  defaultValue: 'Type any value — the slider stretches to fit',
                })
              : undefined
          }
          step={effectiveStep}
          decimals={inferredDecimals}
          suffix={suffix}
          hideSpinner
          disabled={disabled}
          className="w-[88px] flex-shrink-0"
        />
      </div>
    </div>
  )
}

/**
 * Bulk-edit variant. Same shape as SliderRow but shows a "Mixed" badge
 * when the selected shapes disagree on the value. Kept as a separate
 * export so a caller can't forget to pass `isMixed` — the bulk-edit
 * sites always need it.
 */
interface BulkSliderRowProps extends Omit<SliderRowProps, 'labelExtra'> {
  isMixed: boolean
}

export function BulkSliderRow({ isMixed, ...rest }: BulkSliderRowProps) {
  return <SliderRow {...rest} labelExtra={isMixed ? <MixedBadge /> : null} />
}
