import { useState } from 'react'


export type GridTransform =
  | { gridId: number; kind: 'move' | 'rotate' | 'scale' }
  | null

export type GridTransformDraft =
  | {
      gridId: number
      start: [number, number]
      current: [number, number]
      rotation: number
    }
  | null

/**
 * Local editor state for grid (rack) shapes. Distinct from the panel
 * default `config` state which is a truly cross-cutting default
 * (`config.unit` cascades into every other kind's placement flow, so
 * it stays in the route file).
 *
 * Sidebar edits to a selected rack don't live here: they go through the
 * spatial store (`updateLocal`), which previews and saves them.
 *
 * `transform` + `transformDraft` implement the on-map move / rotate /
 * scale handles: state holds which grid + which kind, the working copy
 * of `start` / `current` / `rotation` updates on every mousemove, and
 * the commit persists to Dexie on mouseup.
 *
 * `redrawingGridId` seeds the grid draw mode with an existing row's
 * geometry so the user can retrace it in place.
 *
 * Grid-draw transient state (`hasAnchor`, `liveStart`, `liveCurrent`,
 * `drawMode`) stays in the route file for now — Phase 4 folds it into
 * a dedicated grid-draw hook alongside the MapboxDraw event handlers.
 */
export function useGridEditorState() {
  const [selectedGridIds, setSelectedGridIds] = useState<Set<number>>(
    new Set(),
  )
  const [redrawingGridId, setRedrawingGridId] = useState<number | null>(null)
  const [transform, setTransform] = useState<GridTransform>(null)
  const [transformDraft, setTransformDraft] = useState<GridTransformDraft>(null)

  return {
    selectedGridIds,
    setSelectedGridIds,
    redrawingGridId,
    setRedrawingGridId,
    transform,
    setTransform,
    transformDraft,
    setTransformDraft,
  }
}
