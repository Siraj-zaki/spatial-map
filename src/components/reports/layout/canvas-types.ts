import type { WidgetPosition } from '@/lib/reports/v2-types'

/** One placed item on the grid canvas. Consumers pass the widget id
 *  as the discriminant; the layout system doesn't care what the id
 *  actually addresses. */
export interface CanvasItem {
  id: string
  position: WidgetPosition
  /** Minimum sizes — the resize handles clamp to these. Defaults to 1/1. */
  minW?: number
  minH?: number
}

/** Grid canvas metrics — mirrors the shape in v2-types.LayoutConfig
 *  but with defaults filled in so consumers don't repeat them. */
export interface CanvasMetrics {
  cols: number
  rowHeightPx: number
  gapPx: number
  mobileBreakpointPx: number
}

/** In-flight drag state kept in a ref (not React state) to avoid
 *  re-rendering the canvas 60 times per second during a drag. */
export interface DragState {
  itemId: string
  startX: number
  startY: number
  startPos: WidgetPosition
  ghostPos: WidgetPosition
  mode: 'move' | 'resize'
  /** For resize: which corner/edge is being pulled. */
  handle?: ResizeHandle
}

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Optional callback fired every commit — used by the runtime store's
 *  undo buffer. */
export type LayoutChange = (items: CanvasItem[]) => void
