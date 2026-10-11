/**
 * A slider whose `max` is a comfortable drag range, not a cap.
 *
 * Sliders in the side panel pair a drag range (fine control for the
 * common case — a door 0.2–6 m wide) with a typed input. A real door can
 * be 12 m wide, so the typed value may go past the slider's end, up to
 * `limitMax`. A plain slider would then pin its thumb at the end and,
 * on the next drag, snap the value back down to `max`.
 *
 * Here the range stretches instead:
 *   - a value above the range (typed, or from another selected shape)
 *     grows the range to the next round number above it;
 *   - releasing a drag at the very end grows it again (6 → 10 → 20 → …),
 *     so dragging alone can reach any value up to `limitMax`;
 *   - releasing at or below the original `max` shrinks it back, for fine
 *     control again.
 *
 * Without `limitMax` (or with limitMax <= max) it behaves exactly like
 * `Slider`.
 */

import * as React from 'react'

import { Slider } from '@/components/ui/slider'

/** Smallest 1/2/5 × 10^n that is >= v. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1
  const exp = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 5, 10]) {
    if (m * exp >= v - 1e-9) return m * exp
  }
  return 10 * exp
}

/** Range end that shows `v` with room above it, never past the limit. */
function rangeFor(v: number, max: number, limitMax: number): number {
  return Math.min(limitMax, Math.max(max, niceCeil(v * 1.25)))
}

interface StretchSliderProps
  extends Omit<React.ComponentPropsWithoutRef<typeof Slider>, 'value' | 'onValueChange' | 'onValueCommit' | 'min' | 'max'> {
  value: number
  onValueChange: (value: number) => void
  onValueCommit?: (value: number) => void
  min: number
  /** End of the default drag range. */
  max: number
  /** Highest value the range may stretch to. Infinity = no limit. */
  limitMax?: number
}

export function StretchSlider({ value, onValueChange, onValueCommit, min, max, limitMax, step = 1, ...rest }: StretchSliderProps) {
  const limit = limitMax !== undefined && limitMax > max ? limitMax : max
  const [rangeMax, setRangeMax] = React.useState(() => (value > max ? rangeFor(value, max, limit) : max))

  // A value from outside (typed, or a different selection) past the
  // current range: widen now, during render, so the thumb never pins.
  if (value > rangeMax && rangeMax < limit) {
    setRangeMax(rangeFor(value, max, limit))
  }
  // The base range itself changed (e.g. a dependent max) — never show a
  // range smaller than it.
  const shownMax = Math.max(rangeMax, max)

  const commit = (v: number) => {
    if (limit > max) {
      if (v >= shownMax - step / 2 && shownMax < limit) {
        setRangeMax(Math.min(limit, niceCeil(shownMax * 1.5)))
      } else if (v <= max && rangeMax !== max) {
        setRangeMax(max)
      }
    }
    onValueCommit?.(v)
  }

  return (
    <Slider
      {...rest}
      value={[Math.min(value, shownMax)]}
      onValueChange={(v) => onValueChange(v[0])}
      onValueCommit={(v) => commit(v[0])}
      min={min}
      max={shownMax}
      step={step}
    />
  )
}
