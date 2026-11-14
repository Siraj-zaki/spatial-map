import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'

import { isTextInput } from '@/lib/keyboard-shortcuts'
import { isLengthInputChar, parseLengthInput, type MeasureUnit } from '@/lib/measure/units'

/**
 * Typed lengths for the vertex tools (wall, polygon, measure). With at
 * least one vertex placed, typing a number — optionally with a unit,
 * "3.5", "350cm", "12'6" — fills a buffer the cursor HUD shows; Enter
 * places the next vertex that far toward the cursor (`onSubmit`),
 * Backspace edits the buffer, Esc clears it.
 *
 * The listener runs in the CAPTURE phase on window and stops the event
 * there, so neither the number-row tool shortcuts (1–0 switch tools) nor
 * the tools' own Enter = finish / Backspace = undo vertex handlers see a
 * keystroke that belongs to the buffer. With an empty buffer it only
 * claims digits and the decimal separator; everything else passes
 * through untouched.
 */
export function useLengthEntry({
  enabled,
  canStart,
  unit,
  buffer,
  setBuffer,
  onSubmit,
}: {
  enabled: boolean
  /** True when a vertex exists to measure from. */
  canStart: () => boolean
  unit: MeasureUnit
  buffer: string
  setBuffer: Dispatch<SetStateAction<string>>
  /** Place the next vertex `meters` from the last one (`shiftKey` flips the angle lock). */
  onSubmit: (meters: number, shiftKey: boolean) => void
}) {
  const bufferRef = useRef(buffer)
  const canStartRef = useRef(canStart)
  const onSubmitRef = useRef(onSubmit)
  const unitRef = useRef(unit)
  useEffect(() => {
    bufferRef.current = buffer
    canStartRef.current = canStart
    onSubmitRef.current = onSubmit
    unitRef.current = unit
  })

  useEffect(() => {
    if (!enabled) {
      setBuffer('')
      return
    }
    const claim = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTextInput(e.target)) return
      const current = bufferRef.current
      const started = current.length > 0
      if (!started && !canStartRef.current()) return
      if (isLengthInputChar(e.key, started)) {
        claim(e)
        const next = current + e.key
        bufferRef.current = next
        setBuffer(next)
        return
      }
      if (!started) return
      if (e.key === 'Backspace') {
        claim(e)
        const next = current.slice(0, -1)
        bufferRef.current = next
        setBuffer(next)
      } else if (e.key === 'Escape') {
        claim(e)
        bufferRef.current = ''
        setBuffer('')
      } else if (e.key === 'Enter') {
        claim(e)
        const meters = parseLengthInput(current, unitRef.current)
        // An unparseable buffer stays put so the user can fix it.
        if (meters === null) return
        bufferRef.current = ''
        setBuffer('')
        onSubmitRef.current(meters, e.shiftKey)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [enabled, setBuffer])
}
