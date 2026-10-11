/**
 * Native HTML5 drag-drop for row reorder + cross-container transfer.
 *
 * Two-part API:
 *   - `useDragDropList` returns props factories for a homogenous list
 *     — each row is both draggable and a drop target for other rows
 *     in the same list. Tracks the hovered row + whether the drop
 *     will land before or after it (based on the pointer's Y position
 *     relative to the row's mid-line).
 *   - `usePaletteDrag` is a thin helper for palette items that only
 *     participate as drag sources (they never accept drops in-place).
 *
 * Payload wire format:
 *   dataTransfer sets `application/x-report-drag` with a JSON blob
 *   `{ source: 'canvas' | 'palette', kind: 'widget' | 'params', id }`.
 *   The drop area code inspects the payload and dispatches:
 *     - source=palette → add / unhide
 *     - source=canvas  → reorder / hide
 *
 * Kept intentionally small — the whole hook is <120 lines, one
 * useState for hover state, no refs, no side effects. Works with
 * shadcn primitives because HTML5 drag doesn't fight React.
 */
import { useCallback, useState } from 'react'

export const DRAG_MIME = 'application/x-report-drag'

/** Wire shape carried on every drag transfer. */
export interface DragPayload {
  source: 'canvas' | 'palette'
  /** `widget` = an extra widget id; `params` = the params bar chip. */
  kind: 'widget' | 'params'
  id: string
}

/** Encode a payload into `dataTransfer`. Setting BOTH our custom MIME
 *  and `text/plain` keeps drag working in dev tools that sometimes
 *  block custom MIMEs. */
export function setDragPayload(dt: DataTransfer, payload: DragPayload) {
  const json = JSON.stringify(payload)
  try {
    dt.setData(DRAG_MIME, json)
  } catch {
    // Some browsers throw for custom MIMEs during dragover — fall through.
  }
  dt.setData('text/plain', json)
  dt.effectAllowed = 'move'
}

/** Decode. Returns null if either MIME is missing or the JSON is
 *  malformed. */
export function readDragPayload(dt: DataTransfer): DragPayload | null {
  const raw = dt.getData(DRAG_MIME) || dt.getData('text/plain')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DragPayload
    if (typeof parsed?.id !== 'string') return null
    if (parsed.source !== 'canvas' && parsed.source !== 'palette') return null
    if (parsed.kind !== 'widget' && parsed.kind !== 'params') return null
    return parsed
  } catch {
    return null
  }
}

/** Result of the last drop the hook computed. `null` while dragging. */
export interface DropTargetInfo {
  /** Zero-based index in the source list that was picked up. */
  fromIndex: number
  /** Insertion index in the destination list. Splice at this position
   *  AFTER removing the source; if the destination is a different
   *  list, no removal is needed. */
  toIndex: number
}

/**
 * Reorder-list drag helper. Each row supplies its index; the hook
 * emits handler bags for the row's outer element. `onReorderInternal`
 * fires for same-list drops with the pre-adjusted target index (so
 * `next.splice(target, 0, item)` after `next.splice(from, 1)` lands
 * where the drop indicator was drawn).
 */
export function useDragDropList<T>(opts: {
  items: T[]
  getId: (item: T) => string
  onReorder: (from: number, to: number) => void
  /** Called when a drop from a different container lands. Optional —
   *  omit if the list should only accept its own drags. */
  onExternalDrop?: (payload: DragPayload, insertAt: number) => void
  /** The "kind" this list emits for its own drags. Palette lists use
   *  'widget' or 'params'; canvas lists use 'widget'. */
  kind: 'widget' | 'params'
  /** Set to 'canvas' for the drop area, 'palette' for sidebars. */
  source: 'canvas' | 'palette'
}) {
  const { items, getId, onReorder, onExternalDrop, kind, source } = opts
  const [dragIndex, setDragIndex] = useState<number>(-1)
  const [overIndex, setOverIndex] = useState<number>(-1)
  const [dropBefore, setDropBefore] = useState<boolean>(true)

  // Declared before the handler factories below, which call it.
  const resetState = () => {
    setDragIndex(-1)
    setOverIndex(-1)
  }

  const rowProps = useCallback(
    (index: number) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        setDragPayload(e.dataTransfer, {
          source,
          kind,
          id: getId(items[index]),
        })
        setDragIndex(index)
      },
      onDragOver: (e: React.DragEvent) => {
        // Must preventDefault to allow a drop.
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const rect = e.currentTarget.getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        setOverIndex(index)
        setDropBefore(e.clientY < midY)
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const payload = readDragPayload(e.dataTransfer)
        if (!payload) {
          resetState()
          return
        }
        // Same list, same drag source, same kind → reorder.
        if (payload.source === source && payload.kind === kind) {
          const from = items.findIndex((it) => getId(it) === payload.id)
          if (from < 0) {
            resetState()
            return
          }
          let target = index + (dropBefore ? 0 : 1)
          // Removing `from` shifts subsequent indices; adjust.
          if (target > from) target -= 1
          if (target !== from) onReorder(from, target)
          resetState()
          return
        }
        // Foreign origin — hand off if the caller wants it.
        if (onExternalDrop) {
          const insertAt = index + (dropBefore ? 0 : 1)
          onExternalDrop(payload, insertAt)
        }
        resetState()
      },
      onDragEnd: () => resetState(),
    }),
    [items, getId, dropBefore, kind, source, onReorder, onExternalDrop],
  )

  /** Props for an empty "drop at end" zone rendered after the last
   *  row. Needed so lists can accept drops into an empty container
   *  or past the last item. */
  const emptyZoneProps = useCallback(
    () => ({
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOverIndex(items.length)
        setDropBefore(true)
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const payload = readDragPayload(e.dataTransfer)
        if (!payload) {
          resetState()
          return
        }
        if (payload.source === source && payload.kind === kind) {
          const from = items.findIndex((it) => getId(it) === payload.id)
          if (from < 0 || from === items.length - 1) {
            resetState()
            return
          }
          onReorder(from, items.length - 1)
          resetState()
          return
        }
        if (onExternalDrop) onExternalDrop(payload, items.length)
        resetState()
      },
    }),
    [items, getId, kind, source, onReorder, onExternalDrop],
  )

  return {
    rowProps,
    emptyZoneProps,
    dragIndex,
    overIndex,
    dropBefore,
  }
}

/** Palette items are drag sources only — they never accept drops in
 *  place. Returns the minimum bag needed to start a drag. */
export function usePaletteDrag(opts: {
  kind: 'widget' | 'params'
  id: string
  onDragStart?: () => void
  onDragEnd?: () => void
}) {
  const { kind, id, onDragStart, onDragEnd } = opts
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setDragPayload(e.dataTransfer, { source: 'palette', kind, id })
      onDragStart?.()
    },
    onDragEnd: () => {
      onDragEnd?.()
    },
  }
}
