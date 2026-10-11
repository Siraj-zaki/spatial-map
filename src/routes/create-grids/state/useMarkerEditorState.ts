import { useState } from 'react'

import { usePersistedState } from '@/lib/persisted-state'
import {
  DEFAULT_MARKER_CONFIG,
  type MarkerShapeConfig,
} from '@/lib/shapes'

export type MarkerTransform = { markerId: number; kind: 'move' } | null

/**
 * Local editor state for the marker tool: current selection, default
 * placement config, cursor lng/lat for the ghost preview, and any
 * in-flight move transform.
 */
export function useMarkerEditorState() {
  const [selectedMarkerIds, setSelectedMarkerIds] = useState<Set<number>>(
    new Set(),
  )
  const [markerConfig, setMarkerConfig] =
    usePersistedState<MarkerShapeConfig>(
      'sgv-draw-config:marker',
      () => ({ ...DEFAULT_MARKER_CONFIG }),
    )
  const [markerCursor, setMarkerCursor] = useState<[number, number] | null>(
    null,
  )
  const [markerTransform, setMarkerTransform] = useState<MarkerTransform>(null)

  return {
    selectedMarkerIds,
    setSelectedMarkerIds,
    markerConfig,
    setMarkerConfig,
    markerCursor,
    setMarkerCursor,
    markerTransform,
    setMarkerTransform,
  }
}
