import { useCallback, useRef, useState } from 'react'
import { clampPosition, compactDown } from './canvas-collision'
import type { CanvasItem, CanvasMetrics, DragState, ResizeHandle } from './canvas-types'
import type { WidgetPosition } from '@/lib/reports/v2-types'

/**
 * Drag + resize state manager for the canvas. Both operations share
 * the same lifecycle: pointerdown captures, pointermove computes a
 * ghost position in cell units, pointerup commits.
 *
 * Ghost state lives in React state (so the overlay re-renders); the
 * incoming pointer coordinates go via a ref to avoid 60Hz state
 * writes.
 */
export function useCanvasDrag(opts: {
  items: CanvasItem[]
  metrics: CanvasMetrics
  containerRef: React.RefObject<HTMLDivElement | null>
  onCommit: (items: CanvasItem[]) => void
  disabled?: boolean
}) {
  const { items, metrics, containerRef, onCommit, disabled } = opts
  const [ghost, setGhost] = useState<DragState | null>(null)
  const startRef = useRef<{ px: number; py: number; item: CanvasItem; handle?: ResizeHandle } | null>(null)

  const pixelsToCells = useCallback(
    (px: number, py: number) => {
      const width = containerRef.current?.clientWidth ?? 0
      const cellW = (width - (metrics.cols - 1) * metrics.gapPx) / metrics.cols
      const dx = cellW > 0 ? Math.round(px / (cellW + metrics.gapPx)) : 0
      const dy = Math.round(py / (metrics.rowHeightPx + metrics.gapPx))
      return { dx, dy }
    },
    [containerRef, metrics.cols, metrics.gapPx, metrics.rowHeightPx],
  )

  const beginDrag = useCallback(
    (item: CanvasItem, e: React.PointerEvent, handle?: ResizeHandle) => {
      if (disabled) return
      e.preventDefault()
      e.stopPropagation()
      const target = e.currentTarget as HTMLElement
      target.setPointerCapture(e.pointerId)
      startRef.current = { px: e.clientX, py: e.clientY, item, handle }
      setGhost({
        itemId: item.id,
        startX: e.clientX,
        startY: e.clientY,
        startPos: { ...item.position },
        ghostPos: { ...item.position },
        mode: handle ? 'resize' : 'move',
        handle,
      })
    },
    [disabled],
  )

  const updateGhost = useCallback(
    (e: React.PointerEvent) => {
      if (!startRef.current) return
      const { px, py, item, handle } = startRef.current
      const dx = e.clientX - px
      const dy = e.clientY - py
      const { dx: dcx, dy: dcy } = pixelsToCells(dx, dy)
      let next: WidgetPosition
      if (handle) {
        next = resizeApply(item.position, handle, dcx, dcy)
      } else {
        next = { ...item.position, x: item.position.x + dcx, y: item.position.y + dcy }
      }
      const clamped = clampPosition(next, metrics.cols, item.minW ?? 1, item.minH ?? 1)
      setGhost((g) => (g ? { ...g, ghostPos: clamped } : g))
    },
    [metrics.cols, pixelsToCells],
  )

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      const target = e.currentTarget as HTMLElement
      try {
        target.releasePointerCapture(e.pointerId)
      } catch {
        // pointer may have already released
      }
      if (!ghost || !startRef.current) {
        startRef.current = null
        setGhost(null)
        return
      }
      const { item } = startRef.current
      const proposed = { ...item, position: ghost.ghostPos }
      const merged = compactDown(items, proposed)
      onCommit(merged)
      startRef.current = null
      setGhost(null)
    },
    [ghost, items, onCommit],
  )

  return { ghost, beginDrag, updateGhost, endDrag }
}

/** Apply a resize handle's delta to a position, producing the new
 *  {x, y, w, h}. Handles clamp for negative deltas (dragging past the
 *  opposite corner) by keeping the position stable at its own edge. */
function resizeApply(pos: WidgetPosition, handle: ResizeHandle, dcx: number, dcy: number): WidgetPosition {
  let { x, y, w, h } = pos
  if (handle.includes('e')) w = w + dcx
  if (handle.includes('w')) {
    x = x + dcx
    w = w - dcx
  }
  if (handle.includes('s')) h = h + dcy
  if (handle.includes('n')) {
    y = y + dcy
    h = h - dcy
  }
  return { x, y, w, h }
}
