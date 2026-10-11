import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  CREATION_TOOLS,
  type Tool,
  isTextInput,
  isMacPlatform,
  matchToolKey,
} from '@/lib/keyboard-shortcuts'

/**
 * Callback bag the host implements. Each callback routes to the
 * already-existing handler in `create-grids.tsx` — the hook owns no
 * business logic, only key dispatch and modifier tracking.
 *
 * The getter-style fields (`hasTransformActive`, `hasSelection`,
 * `hasInProgressDraw`) are functions so the hook can read live state
 * from a stable ref without re-binding the listener on every keystroke.
 */
export interface KeyboardShortcutHandlers {
  setActiveTool: (tool: Tool) => void
  /** Current tool — lets holding Space switch to Select and release go back. */
  getActiveTool?: () => Tool
  /** True when in preview mode — creation tool shortcuts are then disabled. */
  preview: boolean

  // Drawing-time
  /** Enter while drawing polygon/line/stair — finish the shape. */
  commitInProgressDraw: () => void
  /** Backspace while drawing polygon/line/stair — remove last vertex. */
  undoLastVertex: () => void
  /** Esc while a draw is in progress — cancel just the draw. */
  cancelInProgressDraw: () => void

  // Transform nudges (work on the single selected shape, or the
  // in-progress transform draft if one is active). The host resolves
  // which shape kind is selected and converts step counts to map units.
  nudge: (direction: 'left' | 'right' | 'up' | 'down', big: boolean) => void
  rotate: (deltaDeg: number) => void
  scale: (delta: number) => void
  elevation: (delta: number) => void
  commitTransform: () => void
  cancelTransform: () => void

  // Selection
  deleteSelected: () => void
  duplicateSelected: () => void
  redrawSelected: () => void
  fitToSelection: () => void
  deselect: () => void

  // App
  undo: () => void
  redo: () => void
  exportGeoJSON: () => void

  // Live state getters (called from inside the listener)
  hasTransformActive: () => boolean
  hasSelection: () => boolean
  hasInProgressDraw: () => boolean
}

export interface KeyboardShortcutState {
  /** True while Shift is held — drawing constrain modifier. */
  shiftHeld: boolean
  /** True while Alt is held — from-center drawing modifier. */
  altHeld: boolean
  /** Ref version of the above for use inside non-React event handlers. */
  modifierRef: { readonly shift: boolean; readonly alt: boolean }
  cheatsheetOpen: boolean
  setCheatsheetOpen: (open: boolean) => void
}

/**
 * One global keydown/keyup listener for the editor. Returns modifier
 * state (re-renderable) + a ref (for use inside existing mousemove
 * handlers) and the cheatsheet open state.
 *
 * The host passes a stable `handlers` bag. To avoid stale closures
 * without re-binding on every render, the bag is stored in a ref and
 * swapped every render — the listener reads `handlersRef.current` at
 * fire time.
 */
export function useKeyboardShortcuts(
  handlers: KeyboardShortcutHandlers
): KeyboardShortcutState {
  const handlersRef = useRef(handlers)
  useLayoutEffect(() => {
    handlersRef.current = handlers
  })

  const [shiftHeld, setShiftHeld] = useState(false)
  const [altHeld, setAltHeld] = useState(false)
  const shiftRef = useRef(false)
  const altRef = useRef(false)
  // Tool to return to when a held Space is released.
  const spaceReturnToRef = useRef<Tool | null>(null)

  const [cheatsheetOpen, setCheatsheetOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Track modifiers regardless of focus so the preview effects can
      // read them even when the user is mid-drag.
      if (e.key === 'Shift' && !shiftRef.current) {
        shiftRef.current = true
        setShiftHeld(true)
      }
      if (e.key === 'Alt' && !altRef.current) {
        altRef.current = true
        setAltHeld(true)
      }

      const h = handlersRef.current
      const mod = isMacPlatform() ? e.metaKey : e.ctrlKey

      // Undo / Redo works even from inputs (browser-native), but our
      // handler should still fire when not in an input.
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
        if (isTextInput(e.target)) return
        e.preventDefault()
        h.undo()
        return
      }
      if (
        (mod && e.shiftKey && e.key.toLowerCase() === 'z') ||
        (mod && e.key.toLowerCase() === 'y')
      ) {
        if (isTextInput(e.target)) return
        e.preventDefault()
        h.redo()
        return
      }

      // Cheatsheet toggle — works from anywhere except text inputs.
      if (e.key === '?' && !mod) {
        if (isTextInput(e.target)) return
        e.preventDefault()
        setCheatsheetOpen((v) => !v)
        return
      }

      // Ignore the rest when typing in a form field.
      if (isTextInput(e.target)) return

      // Space toggles select tool momentary-style. preventDefault stops
      // page scroll.
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        if (e.repeat) return
        // Hold to select; releasing returns to the previous tool (keyup).
        spaceReturnToRef.current = h.getActiveTool?.() ?? null
        h.setActiveTool('select')
        return
      }

      // Escape: order matters — cancel transform first, then in-progress
      // draw, then deselect.
      if (e.key === 'Escape') {
        if (h.hasTransformActive()) {
          e.preventDefault()
          h.cancelTransform()
          return
        }
        if (h.hasInProgressDraw()) {
          e.preventDefault()
          h.cancelInProgressDraw()
          return
        }
        if (h.hasSelection()) {
          e.preventDefault()
          h.deselect()
          return
        }
        return
      }

      // Enter: commit transform, else commit in-progress draw.
      if (e.key === 'Enter') {
        if (h.hasTransformActive()) {
          e.preventDefault()
          h.commitTransform()
          return
        }
        if (h.hasInProgressDraw()) {
          e.preventDefault()
          h.commitInProgressDraw()
          return
        }
        return
      }

      // Backspace: undo last vertex while drawing; otherwise delete
      // selected (mirrors the existing grid-only Delete/Backspace
      // shortcut at create-grids.tsx:3457, generalized to all kinds).
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (h.hasInProgressDraw()) {
          e.preventDefault()
          h.undoLastVertex()
          return
        }
        if (h.hasSelection()) {
          e.preventDefault()
          h.deleteSelected()
          return
        }
        return
      }

      // Arrow nudge — works on selection or transform.
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        h.nudge('left', e.shiftKey)
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        h.nudge('right', e.shiftKey)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        h.nudge('up', e.shiftKey)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        h.nudge('down', e.shiftKey)
        return
      }

      // Rotate via [ ]
      if (e.key === '[') {
        e.preventDefault()
        h.rotate(e.shiftKey ? -15 : -1)
        return
      }
      if (e.key === ']') {
        e.preventDefault()
        h.rotate(e.shiftKey ? 15 : 1)
        return
      }

      // Scale via - / + (and =, since + is shift-on-=-on US layouts) —
      // only with something selected, so with nothing selected `-` / `=`
      // still pick the stair / door tools from the number row.
      if ((e.key === '-' || e.key === '_') && (h.hasSelection() || h.hasTransformActive())) {
        e.preventDefault()
        h.scale(-1)
        return
      }
      if ((e.key === '+' || e.key === '=') && (h.hasSelection() || h.hasTransformActive())) {
        e.preventDefault()
        h.scale(1)
        return
      }

      // Elevation via PgUp / PgDn
      if (e.key === 'PageUp') {
        e.preventDefault()
        h.elevation(1)
        return
      }
      if (e.key === 'PageDown') {
        e.preventDefault()
        h.elevation(-1)
        return
      }

      // F = fit map to selection
      if (e.key === 'f' || e.key === 'F') {
        if (h.hasSelection()) {
          e.preventDefault()
          h.fitToSelection()
          return
        }
      }

      // Cmd/Ctrl+D = duplicate
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        h.duplicateSelected()
        return
      }

      // Cmd/Ctrl+E = export
      if (mod && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        h.exportGeoJSON()
        return
      }

      // R = redraw (only when a single grid is selected — host decides)
      if (!mod && (e.key === 'r' || e.key === 'R')) {
        if (h.hasSelection()) {
          e.preventDefault()
          h.redrawSelected()
          return
        }
      }

      // Tool selection by letter / number. Skipped when any modifier
      // other than Shift is held (so Cmd+G stays browser-owned).
      const tool = matchToolKey(e)
      // AI Map is "coming soon" in the toolbar; its key mustn't open it.
      if (tool === 'ai-map') return
      if (tool) {
        if (h.preview && CREATION_TOOLS.includes(tool)) return
        e.preventDefault()
        h.setActiveTool(tool)
        return
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if ((e.key === ' ' || e.code === 'Space') && spaceReturnToRef.current) {
        const back = spaceReturnToRef.current
        spaceReturnToRef.current = null
        if (back !== 'select') handlersRef.current.setActiveTool(back)
      }
      if (e.key === 'Shift') {
        shiftRef.current = false
        setShiftHeld(false)
      }
      if (e.key === 'Alt') {
        altRef.current = false
        setAltHeld(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  return {
    shiftHeld,
    altHeld,
    modifierRef: {
      get shift() {
        return shiftRef.current
      },
      get alt() {
        return altRef.current
      },
    },
    cheatsheetOpen,
    setCheatsheetOpen,
  }
}