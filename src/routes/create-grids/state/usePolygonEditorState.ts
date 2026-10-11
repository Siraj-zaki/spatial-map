import { useEffect, useRef, useState } from 'react'

import { usePersistedState } from '@/lib/persisted-state'
import {
  DEFAULT_FILL_CONFIG,
  type FillShapeConfig,
} from '@/lib/shapes'

export type PolygonTransform =
  | { polygonId: number; kind: 'move' | 'rotate' | 'edit' }
  | null

export type PolygonTransformDraft =
  | {
      vertices?: [number, number][]
      rotation?: number
    }
  | null

/**
 * Local editor state for the polygon tool: current selection, the
 * default paint config used for the next placement, the in-flight
 * vertex chain + cursor while drawing, and any active transform +
 * draft.
 *
 * Also owns two ref mirrors that consumers currently need:
 *   - `selectedPolygonIdsRef` — the click handler can't read state via
 *     closure (a stable `useCallback([])` freezes the first-render
 *     snapshot), and it can't use a functional setter (React StrictMode
 *     dev double-invocation flips a toggle back to empty). The ref
 *     tracks the latest committed selection so the click handler
 *     computes `next` off the live snapshot.
 *   - `polygonVerticesRef` — the `dblclick` / `keydown` handlers for
 *     the polygon draw tool capture stale closures otherwise.
 *
 * Returns individual `[value, setValue]` pairs (not a reducer) so
 * every existing call site keeps working unchanged. The reducer form
 * can land in a later refactor once the draw + handlers layers move
 * out of the route file.
 */
export function usePolygonEditorState() {
  const [selectedPolygonIds, setSelectedPolygonIds] = useState<Set<number>>(
    new Set(),
  )
  const [polygonConfig, setPolygonConfig] = usePersistedState<FillShapeConfig>(
    'sgv-draw-config:polygon',
    () => ({ ...DEFAULT_FILL_CONFIG }),
  )
  /** In-progress vertex chain while the polygon tool is active. */
  const [polygonDraftVertices, setPolygonDraftVertices] = useState<
    [number, number][]
  >([])
  const [polygonDraftCursor, setPolygonDraftCursor] = useState<
    [number, number] | null
  >(null)
  const [polygonTransform, setPolygonTransform] = useState<PolygonTransform>(
    null,
  )
  const [polygonTransformDraft, setPolygonTransformDraft] =
    useState<PolygonTransformDraft>(null)

  // Ref mirror of selectedPolygonIds for the click handler. The handler
  // can't read state via closure (useCallback([]) freezes the snapshot at
  // first render) AND can't use a state-updater toggle (StrictMode dev
  // double-invocation flips the toggle back to empty). This ref always
  // reflects the latest committed state, so the click handler computes
  // `next` once, off the live snapshot, and sets state to a concrete value.
  const selectedPolygonIdsRef = useRef(selectedPolygonIds)
  useEffect(() => {
    selectedPolygonIdsRef.current = selectedPolygonIds
  }, [selectedPolygonIds])

  // Mirror the latest draft into a ref for the dblclick/keydown handlers
  // which capture stale closures otherwise. Declared here (not next to
  // the draw effect that consumes it) because the state itself lives
  // here — keeping the ref co-located with its source of truth.
  const polygonVerticesRef = useRef<[number, number][]>([])
  useEffect(() => {
    polygonVerticesRef.current = polygonDraftVertices
  }, [polygonDraftVertices])

  return {
    selectedPolygonIds,
    setSelectedPolygonIds,
    polygonConfig,
    setPolygonConfig,
    polygonDraftVertices,
    setPolygonDraftVertices,
    polygonDraftCursor,
    setPolygonDraftCursor,
    polygonTransform,
    setPolygonTransform,
    polygonTransformDraft,
    setPolygonTransformDraft,
    selectedPolygonIdsRef,
    polygonVerticesRef,
  }
}
