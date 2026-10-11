import { useState } from 'react'

import { usePersistedState } from '@/lib/persisted-state'
import {
  DEFAULT_STAIR_CONFIG,
  type StairShapeConfig,
} from '@/lib/shapes'

export type StairDraftPatch =
  | {
      stairId: number
      name?: string
      visible?: boolean
      config?: Partial<StairShapeConfig>
    }
  | null

export type StairTransform =
  | { stairId: number; kind: 'move' | 'rotate' }
  | null

export type StairTransformDraft =
  | {
      vertices?: [number, number][]
      rotation?: number
    }
  | null

/**
 * Local editor state for the stair tool. Click flow depends on
 * `stairConfig.stairType`:
 *   - `straight` / `u`: 2 clicks (bottom, top). U-shape auto-mirrors
 *     flight 2 so still just 2 anchors.
 *   - `l`: 3 clicks (bottom, corner, top).
 *
 * Sidebar edits to a selected stair go through the spatial store
 * (`updateLocal`), not route state.
 */
export function useStairEditorState() {
  const [selectedStairIds, setSelectedStairIds] = useState<Set<number>>(
    new Set(),
  )
  const [stairConfig, setStairConfig] = usePersistedState<StairShapeConfig>(
    'sgv-draw-config:stair',
    () => ({ ...DEFAULT_STAIR_CONFIG }),
  )
  const [stairDraftAnchors, setStairDraftAnchors] = useState<
    [number, number][]
  >([])
  const [stairDraftCursor, setStairDraftCursor] = useState<
    [number, number] | null
  >(null)
  const [stairTransform, setStairTransform] = useState<StairTransform>(null)
  const [stairTransformDraft, setStairTransformDraft] =
    useState<StairTransformDraft>(null)

  return {
    selectedStairIds,
    setSelectedStairIds,
    stairConfig,
    setStairConfig,
    stairDraftAnchors,
    setStairDraftAnchors,
    stairDraftCursor,
    setStairDraftCursor,
    stairTransform,
    setStairTransform,
    stairTransformDraft,
    setStairTransformDraft,
  }
}
