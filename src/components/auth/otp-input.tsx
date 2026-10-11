/**
 * 6-digit code entry that LOOKS segmented but is ONE real <input>.
 *
 * Why one input: autocomplete="one-time-code" (Safari fills codes from
 * Mail/Messages), password managers and paste all target a single field,
 * and screen readers announce one labelled control instead of six unlabeled
 * boxes (WCAG 3.3.8: pasting must work). The visible slots are aria-hidden
 * decoration drawn from `value`; the transparent input lies on top of them
 * and receives every click, keystroke and paste.
 *
 * Paste/autofill tolerate "123 456" / "123-456": non-digits are stripped
 * BEFORE truncating, which is why there is no maxLength (it would cut
 * "123-456" to "123-45" before we ever see it).
 */

import { forwardRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface OtpInputProps {
  id: string
  value: string
  onChange: (value: string) => void
  /** Fired once when the value becomes complete — the screens auto-submit here. */
  onComplete?: (value: string) => void
  length?: number
  invalid?: boolean
  disabled?: boolean
  autoFocus?: boolean
  'aria-describedby'?: string
}

export const OtpInput = forwardRef<HTMLInputElement, OtpInputProps>(
  ({ id, value, onChange, onComplete, length = 6, invalid, disabled, autoFocus, ...aria }, ref) => {
    const [focused, setFocused] = useState(false)
    const half = Math.ceil(length / 2)
    const activeIndex = Math.min(value.length, length - 1)

    return (
      <div className="relative" dir="ltr">
        <div aria-hidden className="flex items-center gap-2">
          {Array.from({ length }, (_, i) => {
            const char = value[i]
            const active = focused && !disabled && i === activeIndex
            return (
              <div key={i} className="contents">
                {i === half && <span className="h-px w-2.5 shrink-0 bg-border" />}
                <div
                  className={cn(
                    'flex h-12 min-w-0 flex-1 items-center justify-center rounded-lg border bg-background text-xl font-semibold tabular-nums text-foreground shadow-sm transition-[border-color,box-shadow] duration-150',
                    active && 'border-ring ring-2 ring-ring/25',
                    invalid && 'border-destructive',
                    invalid && active && 'ring-destructive/25',
                    disabled && 'opacity-60',
                  )}
                >
                  {char ??
                    (active && value.length < length ? (
                      <span className="sgv-auth-caret h-5 w-px bg-foreground" />
                    ) : null)}
                </div>
              </div>
            )
          })}
        </div>
        <input
          ref={ref}
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          pattern={`[0-9]{${length}}`}
          autoFocus={autoFocus}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          {...aria}
          value={value}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          // Keep the caret at the end so typing always fills the next slot
          // (the slots have no notion of an insertion point in the middle).
          onSelect={(e) => {
            const el = e.currentTarget
            if (el.selectionStart !== el.value.length || el.selectionEnd !== el.value.length) {
              el.setSelectionRange(el.value.length, el.value.length)
            }
          }}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, '').slice(0, length)
            onChange(next)
            if (next.length === length && next !== value) onComplete?.(next)
          }}
          className="absolute inset-0 h-full w-full cursor-text rounded-lg border-0 bg-transparent text-base text-transparent caret-transparent outline-none selection:bg-transparent disabled:cursor-not-allowed"
        />
      </div>
    )
  },
)
OtpInput.displayName = 'OtpInput'
