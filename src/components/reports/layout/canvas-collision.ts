import type { CanvasItem } from './canvas-types'
import type { WidgetPosition } from '@/lib/reports/v2-types'

/** Returns true when two rectangles overlap on the grid. Adjacent
 *  (touching-only) rectangles are NOT considered overlapping — grid
 *  cells that share an edge but no interior are fine. */
export function rectsOverlap(a: WidgetPosition, b: WidgetPosition): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  )
}

/**
 * Push any items that collide with `moved` downward until nothing
 * overlaps. Runs in-place on a copy of the input list; deterministic
 * (items are sorted by y then x before the sweep).
 *
 * This is a "downward-only compact" — matches user intent when they
 * drop a widget on top of another (the newcomer stays put; the
 * incumbent slides down). Simpler + more predictable than a full
 * physics simulation, sufficient for a 12-col dashboard.
 */
export function compactDown(items: CanvasItem[], moved: CanvasItem): CanvasItem[] {
  const list = items.map((it) => ({ ...it, position: { ...it.position } }))
  // Ensure `moved` is in the list at its new position.
  const movedIdx = list.findIndex((it) => it.id === moved.id)
  if (movedIdx >= 0) list[movedIdx] = { ...moved, position: { ...moved.position } }

  // Sweep top-to-bottom, resolving collisions by pushing the offender down.
  const sorted = [...list].sort((a, b) =>
    a.position.y === b.position.y ? a.position.x - b.position.x : a.position.y - b.position.y,
  )

  let changed = true
  let guard = 0
  while (changed && guard++ < 500) {
    changed = false
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]
      if (cur.id === moved.id) continue
      for (let j = 0; j < sorted.length; j++) {
        if (i === j) continue
        const other = sorted[j]
        if (rectsOverlap(cur.position, other.position)) {
          // Push cur down just below other. We only push the lower-y of
          // the two so newly-dropped items win.
          if (cur.position.y < other.position.y) continue
          const push = other.position.y + other.position.h - cur.position.y
          cur.position.y += Math.max(1, push)
          changed = true
        }
      }
    }
  }

  // Return in the original order, using the sweep's positions.
  const byId = new Map(sorted.map((it) => [it.id, it]))
  return list.map((it) => byId.get(it.id) ?? it)
}

/** Clamp a position to the grid bounds — width/height must fit inside
 *  the column count; x cannot exceed cols - w. */
export function clampPosition(pos: WidgetPosition, cols: number, minW = 1, minH = 1): WidgetPosition {
  const w = Math.max(minW, Math.min(cols, pos.w))
  const h = Math.max(minH, pos.h)
  const x = Math.max(0, Math.min(cols - w, pos.x))
  const y = Math.max(0, pos.y)
  return { x, y, w, h }
}
