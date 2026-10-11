import { useState } from 'react'

import { usePersistedState } from '@/lib/persisted-state'
import {
  DEFAULT_FILL_CONFIG,
  type FillShapeConfig,
} from '@/lib/shapes'

export type CircleTransform =
  | { circleId: number; kind: 'move' | 'rotate' }
  | null

export type CircleTransformDraft =
  | {
      center?: [number, number]
      start?: [number, number]
      current?: [number, number]
      rotation?: number
    }
  | null

/**
 * Local editor state for the circle tool. Circles have two sub-modes:
 *   - `single` — click-drag: mousedown center → drag radius → mouseup
 *     commits.
 *   - `grid` — two clicks bracket a bbox; the geometry helper fills the
 *     bbox with regularly-spaced circles of `cellRadius` metres inside
 *     `cellSize`-metre cells.
 *
 * Both share the same paint config + selection + transform state.
 * The `circleDragStartLatest` and `circleGridStartLatest` refs (used
 * by the draw effect to sidestep stale closures) currently live next
 * to the draw effect and stay there until Phase 4 moves them along
 * with it.
 */
export function useCircleEditorState() {
  const [selectedCircleIds, setSelectedCircleIds] = useState<Set<number>>(
    new Set(),
  )
  const [circleConfig, setCircleConfig] = usePersistedState<FillShapeConfig>(
    'sgv-draw-config:circle',
    () => ({ ...DEFAULT_FILL_CONFIG, showLabels: false }),
  )
  const [circleSubMode, setCircleSubMode] = useState<'single' | 'grid'>(
    'single',
  )
  const [circleCellSize, setCircleCellSize] = useState<number>(20)
  const [circleCellRadius, setCircleCellRadius] = useState<number>(8)
  const [circleDragStart, setCircleDragStart] = useState<
    [number, number] | null
  >(null)
  const [circleDragCursor, setCircleDragCursor] = useState<
    [number, number] | null
  >(null)
  const [circleGridStart, setCircleGridStart] = useState<
    [number, number] | null
  >(null)
  const [circleGridCursor, setCircleGridCursor] = useState<
    [number, number] | null
  >(null)
  const [circleTransform, setCircleTransform] = useState<CircleTransform>(null)
  const [circleTransformDraft, setCircleTransformDraft] =
    useState<CircleTransformDraft>(null)

  return {
    selectedCircleIds,
    setSelectedCircleIds,
    circleConfig,
    setCircleConfig,
    circleSubMode,
    setCircleSubMode,
    circleCellSize,
    setCircleCellSize,
    circleCellRadius,
    setCircleCellRadius,
    circleDragStart,
    setCircleDragStart,
    circleDragCursor,
    setCircleDragCursor,
    circleGridStart,
    setCircleGridStart,
    circleGridCursor,
    setCircleGridCursor,
    circleTransform,
    setCircleTransform,
    circleTransformDraft,
    setCircleTransformDraft,
  }
}
