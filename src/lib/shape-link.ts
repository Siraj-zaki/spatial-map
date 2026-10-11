/**
 * Cross-shape data binding.
 *
 * A `ShapeLink` lets one shape (the "viewer") borrow another shape's
 * bin row for style-rule evaluation. The classic case is a text label
 * whose text should mirror a polygon's status — the text label has no
 * data of its own, but with a link the rule engine can match against
 * the polygon's bin and paint the label accordingly.
 *
 * Two flavours of source are supported:
 *   - A non-grid shape: `{ kind, shapeId }` (polygon, circle, line,
 *     marker, image, model). The viewer reads the bin attached to that
 *     shape.
 *   - A grid cell: `{ kind: 'grid-cell', gridId, row, col, level }`.
 *     The viewer reads the bin keyed by that cell address.
 *
 * The link is *optional* — when absent the shape participates in rules
 * the old way (using its own bin, if any). Stored on `ShapeBase` so
 * every saved shape inherits the slot uniformly.
 */

import type { BindingKind } from '@/lib/db'

export type LinkableKind = BindingKind

export type ShapeLink =
  | {
      kind: Exclude<LinkableKind, 'grid-cell'>
      shapeId: number
    }
  | {
      kind: 'grid-cell'
      gridId: number
      row: number
      col: number
      /** Optional vertical level inside the rack. Defaults to 0. */
      level?: number
    }

/** Stable string id for a ShapeLink — useful as a map key or React key. */
export function linkId(link: ShapeLink): string {
  if (link.kind === 'grid-cell') {
    return `grid-cell:${link.gridId}:${link.row}:${link.col}:${link.level ?? 0}`
  }
  return `${link.kind}:${link.shapeId}`
}

/** Best-effort sanity check before persisting a link. */
export function isValidLink(link: ShapeLink | undefined): link is ShapeLink {
  if (!link) return false
  if (link.kind === 'grid-cell') {
    return (
      Number.isFinite(link.gridId) &&
      Number.isFinite(link.row) &&
      Number.isFinite(link.col)
    )
  }
  return Number.isFinite(link.shapeId)
}
