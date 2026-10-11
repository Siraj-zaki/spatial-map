/**
 * Popover-based colour picker.
 *
 * Trigger: a rounded swatch button showing the current colour + a paired
 * hex text input. Clicking the swatch opens a Radix popover with the
 * react-colorful HexColorPicker (SV + Hue) plus a hex input inside the
 * popover for pasting brand codes.
 *
 * Why not the native `<input type="color">`? It fires `change` on every
 * drag frame (60 times per second) and each fire re-renders the parent
 * component — and, for shapes on the map, repaints the Mapbox layer.
 * That produces visible lag on drag. We now hold the picker's dragging
 * value in local state and only push the committed value to `onChange`
 * either (a) on a 120 ms trailing debounce or (b) when the popover
 * closes / hex input commits.
 *
 * The text input follows the same "draft while typing, commit on
 * blur/Enter" pattern as the previous ColorPicker, so backspacing
 * through "#abcd" no longer snaps back to the previous colour on every
 * keystroke.
 */

import * as React from 'react'
import { HexColorPicker } from 'react-colorful'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const DEBOUNCE_MS = 120

function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(trimmed)) {
    const [r, g, b] = trimmed
    return `#${r}${r}${g}${g}${b}${b}`
  }
  if (/^[0-9a-f]{6}$/.test(trimmed)) {
    return `#${trimmed}`
  }
  return null
}

interface ColorPickerProps {
  value: string
  /**
   * Called with the committed hex (`#rrggbb`, lowercase). Fires:
   *   - ~120 ms after the last drag frame in the visual picker
   *   - immediately when the popover closes
   *   - on Enter/blur in the hex text input
   */
  onChange: (value: string) => void
  ariaLabel?: string
  /** Optional row of preset swatches shown above the hex input. */
  presets?: ReadonlyArray<string>
  /** Disables the trigger button. */
  disabled?: boolean
  className?: string
}

const DEFAULT_PRESETS: ReadonlyArray<string> = [
  '#000000', '#ffffff', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899',
]

export function ColorPicker({
  value,
  onChange,
  ariaLabel,
  presets = DEFAULT_PRESETS,
  disabled,
  className,
}: ColorPickerProps) {
  const [open, setOpen] = React.useState(false)
  // Local draft while the user is dragging the picker or typing in the
  // hex input. Kept in sync with `value` while the popover is closed.
  const [draft, setDraft] = React.useState(value)
  // Text-input draft (kept separate so typing invalid chars doesn't
  // move the picker cursor around mid-key).
  const [hexDraft, setHexDraft] = React.useState<string | null>(null)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync from parent when the popover is closed AND the text input is
  // not being edited — otherwise we'd stomp on the user's in-flight
  // draft the moment the parent's autosave round-trips.
  React.useEffect(() => {
    if (open) return
    if (hexDraft !== null) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(value)
  }, [value, open, hexDraft])

  const commit = React.useCallback(
    (hex: string) => {
      const normalized = normalizeHex(hex) ?? value
      if (normalized === value) return
      onChange(normalized)
    },
    [onChange, value],
  )

  const flushDebounce = React.useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [])

  // React to the picker's drag events: update the local draft
  // immediately (so the swatch and picker cursor track the pointer),
  // then debounce the parent commit so we don't repaint the map at
  // 60 fps.
  const handlePickerChange = React.useCallback(
    (next: string) => {
      setDraft(next)
      flushDebounce()
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        commit(next)
      }, DEBOUNCE_MS)
    },
    [commit, flushDebounce],
  )

  // Popover open state: on close, flush any pending debounce so we
  // don't lose the last drag frame.
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (!nextOpen) {
        flushDebounce()
        commit(draft)
      }
    },
    [flushDebounce, commit, draft],
  )

  // Text input commit (Enter / blur).
  const commitHex = React.useCallback(() => {
    if (hexDraft === null) return
    const normalized = normalizeHex(hexDraft)
    setHexDraft(null)
    if (normalized) {
      setDraft(normalized)
      flushDebounce()
      commit(normalized)
    }
  }, [hexDraft, flushDebounce, commit])

  const hexDisplayed = hexDraft ?? draft

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={ariaLabel}
            className={cn(
              'w-7 h-7 flex-shrink-0 rounded border border-input',
              'shadow-sm ring-offset-background transition-shadow',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
            style={{ backgroundColor: draft }}
          />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          className="p-3 w-[220px] space-y-3"
        >
          <div className="sgv-color-picker">
            <HexColorPicker color={draft} onChange={handlePickerChange} />
          </div>
          {presets.length > 0 && (
            <div className="grid grid-cols-10 gap-1">
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setDraft(p)
                    flushDebounce()
                    commit(p)
                  }}
                  aria-label={p}
                  className="w-4 h-4 rounded-sm border border-border/60 hover:scale-110 transition-transform"
                  style={{ backgroundColor: p }}
                />
              ))}
            </div>
          )}
          <input
            type="text"
            value={hexDisplayed}
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={commitHex}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitHex()
                ;(e.currentTarget as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setHexDraft(null)
                ;(e.currentTarget as HTMLInputElement).blur()
              }
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            maxLength={7}
            className={cn(
              'w-full h-8 px-2 rounded border bg-transparent text-xs font-mono uppercase',
              'text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
            aria-label={ariaLabel ? `${ariaLabel} (hex)` : 'Hex colour'}
          />
        </PopoverContent>
      </Popover>
      <input
        type="text"
        value={hexDisplayed}
        onChange={(e) => setHexDraft(e.target.value)}
        onBlur={commitHex}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitHex()
            ;(e.currentTarget as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setHexDraft(null)
            ;(e.currentTarget as HTMLInputElement).blur()
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        maxLength={7}
        disabled={disabled}
        className={cn(
          'w-20 h-7 rounded border bg-transparent px-1.5 text-[11px] font-mono uppercase',
          'text-muted-foreground focus:text-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        aria-label={ariaLabel ? `${ariaLabel} (hex)` : 'Hex colour'}
      />
    </div>
  )
}
