import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { DEFAULT_LAYOUT, type LayoutConfig } from '@/lib/reports/v2-types'
import { clampPosition } from './canvas-collision'
import { useCanvasDrag } from './use-canvas-drag'
import type { CanvasItem, CanvasMetrics, ResizeHandle } from './canvas-types'

/**
 * Custom CSS-grid canvas — 12-col by default, 48px rows. Widgets are
 * positioned by `gridColumn: <x+1> / span <w>` and `gridRow: <y+1> /
 * span <h>`. Drag / resize handles switch on in editable mode.
 *
 * Deliberately built without react-grid-layout: (a) we only need a
 * subset of its features; (b) it uses `!important` inline styles that
 * conflict with our theme tokens; (c) integrating with the runtime
 * store's undo buffer is trivial when we own the pointer pipeline.
 */
export interface ReportCanvasProps {
  items: CanvasItem[]
  /** Render one widget's content. The layout system handles position/size. */
  renderItem: (item: CanvasItem) => React.ReactNode
  /** Layout metrics. Missing fields fall back to DEFAULT_LAYOUT. */
  layout?: LayoutConfig
  /** Interactive mode enables drag / resize / keyboard editing. */
  editable?: boolean
  /** Fires on every successful commit (drop / resize end / keyboard nudge). */
  onLayoutChange?: (items: CanvasItem[]) => void
  /** Widget-focus intent — the builder opens a Sheet editor. */
  onOpenItem?: (id: string) => void
  className?: string
}

export function ReportCanvas({
  items,
  renderItem,
  layout,
  editable = false,
  onLayoutChange,
  onOpenItem,
  className,
}: ReportCanvasProps) {
  const { t } = useTranslation()
  const metrics = useMetrics(layout)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [isMobile, setIsMobile] = useState(false)

  // Auto-stack on mobile — the actual widget positions stay untouched;
  // we override to full-width single-column at render time.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const check = () => setIsMobile(window.innerWidth < metrics.mobileBreakpointPx)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [metrics.mobileBreakpointPx])

  const commit = useCallback(
    (next: CanvasItem[]) => {
      onLayoutChange?.(next)
    },
    [onLayoutChange],
  )

  const { ghost, beginDrag, updateGhost, endDrag } = useCanvasDrag({
    items,
    metrics,
    containerRef,
    onCommit: commit,
    disabled: !editable || isMobile,
  })

  const renderedItems = useMemo(() => {
    if (!isMobile) return items
    // Mobile stack: sort by (y, x), then re-lay full-width top-to-bottom.
    const sorted = [...items].sort((a, b) =>
      a.position.y === b.position.y ? a.position.x - b.position.x : a.position.y - b.position.y,
    )
    // One content-sized row per widget: at phone width text wraps onto
    // more lines than the desktop row height allows, so a fixed height
    // clipped it. Cards bring their own minimum heights. Narrow widgets
    // (KPI tiles, ≤ a third of the row) pair up two-across instead of
    // each taking a full-width row.
    return sorted.map((it, y) => ({
      ...it,
      position: { x: 0, y, w: it.position.w <= metrics.cols / 3 ? metrics.cols / 2 : metrics.cols, h: 1 },
    }))
  }, [items, isMobile, metrics.cols])

  const handleKeyNudge = useCallback(
    (item: CanvasItem, e: React.KeyboardEvent) => {
      if (!editable || isMobile) return
      const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
      if (dx === 0 && dy === 0 && e.key !== 'Enter') return
      if (e.key === 'Enter') {
        onOpenItem?.(item.id)
        return
      }
      e.preventDefault()
      const resizing = e.shiftKey
      const next = resizing
        ? { ...item.position, w: Math.max(1, item.position.w + dx), h: Math.max(1, item.position.h + dy) }
        : { ...item.position, x: item.position.x + dx, y: item.position.y + dy }
      const clamped = clampPosition(next, metrics.cols, item.minW ?? 1, item.minH ?? 1)
      const nextItems = items.map((i) => (i.id === item.id ? { ...i, position: clamped } : i))
      commit(nextItems)
    },
    [commit, editable, isMobile, items, metrics.cols, onOpenItem],
  )

  return (
    <div
      ref={containerRef}
      role="grid"
      aria-label={t('reports.canvas.label', { defaultValue: 'Widget canvas' })}
      className={cn('relative w-full', className)}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${metrics.cols}, 1fr)`,
        // Reading (not editing), rows grow to fit their content: a table
        // shows its whole page instead of scrolling inside a scrolling
        // page. Editing keeps the exact grid so drag/resize line up.
        gridAutoRows: isMobile ? 'auto' : editable ? `${metrics.rowHeightPx}px` : `minmax(${metrics.rowHeightPx}px, auto)`,
        gridAutoFlow: isMobile ? 'row dense' : undefined,
        gap: `${metrics.gapPx}px`,
      }}
    >
      {renderedItems.map((item, index) => {
        const isFocused = focusedId === item.id
        const isGhosting = ghost?.itemId === item.id
        return (
          <div
            key={item.id}
            role="gridcell"
            tabIndex={editable ? 0 : -1}
            data-widget-id={item.id}
            onFocus={() => setFocusedId(item.id)}
            onBlur={() => setFocusedId((cur) => (cur === item.id ? null : cur))}
            onKeyDown={(e) => handleKeyNudge(item, e)}
            className={cn(
              // No chrome here: every widget draws its own card (it has to,
              // for document flow), so a border on the cell doubled it.
              'relative min-h-0 min-w-0 rounded-xl transition-shadow',
              editable && isFocused && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
              editable && !isMobile && 'select-none',
              isGhosting && 'opacity-40',
              !editable && 'sgv-rise',
            )}
            style={
              isMobile
                ? // Auto-placed in reading order, so paired tiles flow.
                  ({ gridColumn: `span ${item.position.w}`, '--sgv-i': index } as React.CSSProperties)
                : ({
                    gridColumn: `${item.position.x + 1} / span ${Math.min(item.position.w, metrics.cols)}`,
                    gridRow: `${item.position.y + 1} / span ${item.position.h}`,
                    '--sgv-i': index,
                  } as React.CSSProperties)
            }
          >
            {editable && !isMobile && (
              <div
                className="absolute inset-x-0 top-0 h-5 cursor-move opacity-0 hover:opacity-100 transition-opacity"
                onPointerDown={(e) => beginDrag(item, e)}
                onPointerMove={updateGhost}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                aria-label={t('reports.canvas.dragHandle', { defaultValue: 'Drag to move' })}
              >
                <div className="w-8 h-1 mx-auto mt-1.5 rounded-full bg-muted-foreground/40" />
              </div>
            )}
            <div className="h-full overflow-hidden rounded-xl [&>*]:h-full">{renderItem(item)}</div>
            {editable && !isMobile && <ResizeHandles item={item} onBeginDrag={beginDrag} onMove={updateGhost} onEnd={endDrag} />}
          </div>
        )
      })}
      {ghost && (
        <div
          aria-hidden
          className="pointer-events-none rounded-lg border-2 border-dashed border-primary/60 bg-primary/5"
          style={{
            gridColumn: `${ghost.ghostPos.x + 1} / span ${Math.min(ghost.ghostPos.w, metrics.cols)}`,
            gridRow: `${ghost.ghostPos.y + 1} / span ${ghost.ghostPos.h}`,
          }}
        />
      )}
    </div>
  )
}

/** Resize handle overlay — 8 grabbable dots per widget. Sized so
 *  they're targetable without being visually noisy in read mode. */
function ResizeHandles({
  item,
  onBeginDrag,
  onMove,
  onEnd,
}: {
  item: CanvasItem
  onBeginDrag: (item: CanvasItem, e: React.PointerEvent, handle: ResizeHandle) => void
  onMove: (e: React.PointerEvent) => void
  onEnd: (e: React.PointerEvent) => void
}) {
  const positions: Array<{ handle: ResizeHandle; cls: string }> = [
    { handle: 'n', cls: 'top-0 left-1/2 -translate-x-1/2 h-1 w-8 cursor-ns-resize' },
    { handle: 's', cls: 'bottom-0 left-1/2 -translate-x-1/2 h-1 w-8 cursor-ns-resize' },
    { handle: 'e', cls: 'right-0 top-1/2 -translate-y-1/2 w-1 h-8 cursor-ew-resize' },
    { handle: 'w', cls: 'left-0 top-1/2 -translate-y-1/2 w-1 h-8 cursor-ew-resize' },
    { handle: 'nw', cls: 'top-0 left-0 w-2 h-2 cursor-nwse-resize' },
    { handle: 'ne', cls: 'top-0 right-0 w-2 h-2 cursor-nesw-resize' },
    { handle: 'sw', cls: 'bottom-0 left-0 w-2 h-2 cursor-nesw-resize' },
    { handle: 'se', cls: 'bottom-0 right-0 w-2 h-2 cursor-nwse-resize' },
  ]
  return (
    <>
      {positions.map((p) => (
        <div
          key={p.handle}
          className={cn(
            'absolute opacity-0 hover:opacity-100 bg-primary/60 transition-opacity',
            p.cls,
          )}
          onPointerDown={(e) => onBeginDrag(item, e, p.handle)}
          onPointerMove={onMove}
          onPointerUp={onEnd}
          onPointerCancel={onEnd}
          aria-hidden
        />
      ))}
    </>
  )
}

/** Resolve layout metrics, filling missing fields from DEFAULT_LAYOUT. */
function useMetrics(layout: LayoutConfig | undefined): CanvasMetrics {
  return useMemo(
    () => ({
      cols: layout?.cols ?? DEFAULT_LAYOUT.cols,
      rowHeightPx: layout?.rowHeightPx ?? DEFAULT_LAYOUT.rowHeightPx,
      gapPx: layout?.gapPx ?? DEFAULT_LAYOUT.gapPx,
      mobileBreakpointPx: layout?.mobileBreakpointPx ?? DEFAULT_LAYOUT.mobileBreakpointPx,
    }),
    [layout],
  )
}
