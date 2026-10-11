/**
 * TextField — a controlled text input that holds a local draft while the
 * user is typing and only commits to the parent on Enter / blur / short
 * idle debounce (default 300 ms).
 *
 * Why: the raw shadcn `<Input>` is a straight controlled input. When
 * the parent's `onChange` synchronously round-trips through the
 * spatial-store's optimistic flush, memo chain, and re-render, the
 * `value` prop can arrive back after the user's next keystroke — with
 * the older string. React sees value ≠ DOM contents and resets the DOM,
 * which reads as "character bounced back" or "cursor jumped to end,
 * had to select-all + retype." Holding a local draft while focused
 * eliminates that race: the DOM is the source of truth for the current
 * word, and the parent only sees whole units of user intent (blur /
 * Enter / typing-paused).
 *
 * Fires `onCommit` for actual writes. `onDraft` is optional if callers
 * want to reflect the partial value (e.g. show a live preview).
 */

import * as React from 'react'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface TextFieldProps
  extends Omit<React.ComponentProps<'input'>, 'value' | 'onChange' | 'onBlur' | 'defaultValue'> {
  value: string
  onCommit: (value: string) => void
  onDraft?: (value: string) => void
  /** ms of no typing after which the draft is committed. Defaults to 300. Pass 0 to disable idle-commit. */
  debounceMs?: number
  /** Passed straight through — the input's className. */
  className?: string
}

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(
    { value, onCommit, onDraft, debounceMs = 300, className, ...rest },
    ref,
  ) {
    const [draft, setDraft] = React.useState<string | null>(null)
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

    // Clear the pending debounce on unmount so we don't fire onCommit
    // against a torn-down parent.
    React.useEffect(() => {
      return () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current)
      }
    }, [])

    // Sync from external value when not editing (draft === null). Once
    // the user starts typing, ignore parent value updates until they
    // commit — otherwise a slow round-trip stomps their in-progress
    // characters and we get the "erase doesn't work" bug.
    const displayed = draft ?? value

    const commit = React.useCallback(
      (next: string) => {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        setDraft(null)
        if (next !== value) onCommit(next)
      },
      [onCommit, value],
    )

    const scheduleCommit = React.useCallback(
      (next: string) => {
        if (debounceMs <= 0) return
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          setDraft((d) => {
            // Only commit if the debounce target is still the current draft.
            if (d !== next) return d
            if (next !== value) onCommit(next)
            return null
          })
        }, debounceMs)
      },
      [debounceMs, onCommit, value],
    )

    return (
      <Input
        ref={ref}
        value={displayed}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          onDraft?.(next)
          scheduleCommit(next)
        }}
        onBlur={() => {
          if (draft !== null) commit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (draft !== null) commit(draft)
            ;(e.currentTarget as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            if (timerRef.current !== null) {
              clearTimeout(timerRef.current)
              timerRef.current = null
            }
            setDraft(null)
            ;(e.currentTarget as HTMLInputElement).blur()
          }
          rest.onKeyDown?.(e)
        }}
        className={cn(className)}
        {...rest}
      />
    )
  },
)
