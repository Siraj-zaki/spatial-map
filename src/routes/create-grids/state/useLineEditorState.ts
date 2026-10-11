import { useEffect, useRef, useState } from 'react'

import type { LineSnap } from '@/lib/line-snap'
import { usePersistedState } from '@/lib/persisted-state'
import {
  DEFAULT_LINE_CONFIG,
  type LineShapeConfig,
} from '@/lib/shapes'
import type { LengthUnit } from '@/lib/units'

export type LineTransform =
  | { lineId: number; kind: 'move' | 'rotate' }
  | null

export type LineTransformDraft =
  | { vertices?: [number, number][]; rotation?: number }
  | null

/**
 * Local editor state for the line/wall tool: current selection, the
 * default paint config, in-flight vertex chain + cursor while drawing,
 * the snap decision (endpoint/axis) the draw effect computes on every
 * mousemove, the drawing-HUD length unit, and any active transform.
 *
 * `drawingUnit` is line-adjacent (it drives the length HUD rendered
 * inside the line-draw preview) but is initialised from the persisted
 * global `getDisplayUnit()` in the route's onMount effect. The setter
 * is exposed so that effect (and the panel's default-unit picker) can
 * keep it in sync.
 */
export function useLineEditorState() {
  const [selectedLineIds, setSelectedLineIds] = useState<Set<number>>(
    new Set(),
  )
  const [lineConfig, setLineConfig] = usePersistedState<LineShapeConfig>(
    'sgv-draw-config:line',
    () => ({ ...DEFAULT_LINE_CONFIG }),
  )
  const [lineDraftVertices, setLineDraftVertices] = useState<
    [number, number][]
  >([])
  const [lineDraftCursor, setLineDraftCursor] = useState<
    [number, number] | null
  >(null)
  const [lineDraftSnap, setLineDraftSnap] = useState<LineSnap | null>(null)
  const [drawingUnit, setDrawingUnit] = useState<LengthUnit>('m')
  const [lineTransform, setLineTransform] = useState<LineTransform>(null)
  const [lineTransformDraft, setLineTransformDraft] =
    useState<LineTransformDraft>(null)

  // Mirror line draft into a ref for the dblclick/keydown handlers,
  // which capture stale closures otherwise.
  const lineVerticesRef = useRef<[number, number][]>([])
  useEffect(() => {
    lineVerticesRef.current = lineDraftVertices
  }, [lineDraftVertices])

  return {
    selectedLineIds,
    setSelectedLineIds,
    lineConfig,
    setLineConfig,
    lineDraftVertices,
    setLineDraftVertices,
    lineDraftCursor,
    setLineDraftCursor,
    lineDraftSnap,
    setLineDraftSnap,
    drawingUnit,
    setDrawingUnit,
    lineTransform,
    setLineTransform,
    lineTransformDraft,
    setLineTransformDraft,
    lineVerticesRef,
  }
}
