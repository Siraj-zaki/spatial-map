import { useState } from 'react'

import type { DoorWallSnap } from '@/lib/door/wall-snap'

export type DoorTransform =
  | { doorId: number; kind: 'move' | 'rotate' | 'scale' }
  | null

export type DoorCursorPreview =
  | {
      vertices: [[number, number], [number, number]]
      attachedToLineId?: number
    }
  | null

/**
 * Local editor state for the door tool. Doors persist via
 * `useDoorStore` (backend tenant + zone scoped, with a localStorage
 * cache for instant cold-start); this hook only owns the transient
 * placement state that mirrors the stair-tool pattern:
 * `selectedDoorIds` drives the side-panel mode, `doorDraftAnchors`
 * drives the overlay preview, and the door store handles
 * add/update/delete.
 *
 * `doorWallSnap` is the snap decision computed on every mousemove
 * while `create-door` is active; when non-null the next click is a
 * single-click commit that snaps the door onto the wall, orients to
 * its axis, and stamps `config.attachedToLineId` so the wall
 * generator cuts a hole.
 *
 * `doorCursorPreview` is the pre-first-click ghost: wall-snapped when
 * hovering a wall, otherwise a default-width door centred on the
 * cursor.
 */
export function useDoorEditorState() {
  const [selectedDoorIds, setSelectedDoorIds] = useState<Set<number>>(
    new Set(),
  )
  const [doorDraftAnchors, setDoorDraftAnchors] = useState<[number, number][]>(
    [],
  )
  const [doorDraftCursor, setDoorDraftCursor] = useState<
    [number, number] | null
  >(null)
  const [doorWallSnap, setDoorWallSnap] = useState<DoorWallSnap | null>(null)
  const [doorCursorPreview, setDoorCursorPreview] =
    useState<DoorCursorPreview>(null)
  const [doorTransform, setDoorTransform] = useState<DoorTransform>(null)

  return {
    selectedDoorIds,
    setSelectedDoorIds,
    doorDraftAnchors,
    setDoorDraftAnchors,
    doorDraftCursor,
    setDoorDraftCursor,
    doorWallSnap,
    setDoorWallSnap,
    doorCursorPreview,
    setDoorCursorPreview,
    doorTransform,
    setDoorTransform,
  }
}
