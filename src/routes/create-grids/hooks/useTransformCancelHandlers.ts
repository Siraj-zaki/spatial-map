import { useEffect, type Dispatch, type SetStateAction } from 'react'

import type { CircleTransform, CircleTransformDraft } from '../state/useCircleEditorState'
import type { DoorTransform } from '../state/useDoorEditorState'
import type { ImageTransform, ImageTransformDraft } from '../state/useImageEditorState'
import type { LineTransform, LineTransformDraft } from '../state/useLineEditorState'
import type { MarkerTransform } from '../state/useMarkerEditorState'
import type {
  PolygonTransform,
  PolygonTransformDraft,
} from '../state/usePolygonEditorState'

/**
 * Consolidates the six near-identical "Esc cancels an in-flight
 * transform" + "drop the transform if selection changes" effect pairs
 * that used to be scattered inline in the route file. Each pair is
 * tiny (5–10 lines) but there are six of them (circle, marker,
 * polygon, image, line, door) so extracting them together removes ~90
 * lines of noise from `create-grids.tsx` without introducing any
 * cross-cutting abstraction.
 *
 * Door's Esc handler uses `{ capture: true }` so it fires ahead of
 * the global deselect handler that other Esc listeners bubble
 * through. The other five use the default bubble phase.
 */
export function useTransformCancelHandlers({
  circleTransform,
  setCircleTransform,
  setCircleTransformDraft,
  selectedCircleIds,
  markerTransform,
  setMarkerTransform,
  selectedMarkerIds,
  polygonTransform,
  setPolygonTransform,
  setPolygonTransformDraft,
  selectedPolygonIds,
  imageTransform,
  setImageTransform,
  setImageTransformDraft,
  selectedImageIds,
  lineTransform,
  setLineTransform,
  setLineTransformDraft,
  selectedLineIds,
  doorTransform,
  setDoorTransform,
  selectedDoorIds,
}: {
  circleTransform: CircleTransform
  setCircleTransform: Dispatch<SetStateAction<CircleTransform>>
  setCircleTransformDraft: Dispatch<SetStateAction<CircleTransformDraft>>
  selectedCircleIds: Set<number>
  markerTransform: MarkerTransform
  setMarkerTransform: Dispatch<SetStateAction<MarkerTransform>>
  selectedMarkerIds: Set<number>
  polygonTransform: PolygonTransform
  setPolygonTransform: Dispatch<SetStateAction<PolygonTransform>>
  setPolygonTransformDraft: Dispatch<SetStateAction<PolygonTransformDraft>>
  selectedPolygonIds: Set<number>
  imageTransform: ImageTransform
  setImageTransform: Dispatch<SetStateAction<ImageTransform>>
  setImageTransformDraft: Dispatch<SetStateAction<ImageTransformDraft>>
  selectedImageIds: Set<number>
  lineTransform: LineTransform
  setLineTransform: Dispatch<SetStateAction<LineTransform>>
  setLineTransformDraft: Dispatch<SetStateAction<LineTransformDraft>>
  selectedLineIds: Set<number>
  doorTransform: DoorTransform
  setDoorTransform: Dispatch<SetStateAction<DoorTransform>>
  selectedDoorIds: Set<number>
}) {
  // ---- Circle ----
  // Capture-phase + stopImmediatePropagation so the main useKeyboardShortcuts
  // Escape handler can't fall through to `deselect` on the same keypress —
  // matches the door listener's pattern.
  useEffect(() => {
    if (!circleTransform) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCircleTransform(null)
        setCircleTransformDraft(null)
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [circleTransform, setCircleTransform, setCircleTransformDraft])

  useEffect(() => {
    if (!circleTransform) return
    if (!selectedCircleIds.has(circleTransform.circleId)) {
      setCircleTransform(null)
      setCircleTransformDraft(null)
    }
  }, [
    circleTransform,
    selectedCircleIds,
    setCircleTransform,
    setCircleTransformDraft,
  ])

  // ---- Marker ----
  useEffect(() => {
    if (!markerTransform) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMarkerTransform(null)
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [markerTransform, setMarkerTransform])

  useEffect(() => {
    if (!markerTransform) return
    if (!selectedMarkerIds.has(markerTransform.markerId)) {
      setMarkerTransform(null)
    }
  }, [markerTransform, selectedMarkerIds, setMarkerTransform])

  // ---- Polygon ----
  useEffect(() => {
    if (!polygonTransform) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPolygonTransform(null)
        setPolygonTransformDraft(null)
        // The main useKeyboardShortcuts Escape handler also listens on
        // window and its `hasTransformActive` ref is only refreshed after
        // React re-renders. Without stopping propagation here the fallback
        // "hasSelection → deselect" branch fires in the same tick because
        // the ref still reads false in some render orderings, dropping
        // the user's selection right after they cancelled a transform.
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [polygonTransform, setPolygonTransform, setPolygonTransformDraft])

  useEffect(() => {
    if (!polygonTransform) return
    if (!selectedPolygonIds.has(polygonTransform.polygonId)) {
      setPolygonTransform(null)
      setPolygonTransformDraft(null)
    }
  }, [
    polygonTransform,
    selectedPolygonIds,
    setPolygonTransform,
    setPolygonTransformDraft,
  ])

  // ---- Image ----
  useEffect(() => {
    if (!imageTransform) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setImageTransform(null)
        setImageTransformDraft(null)
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [imageTransform, setImageTransform, setImageTransformDraft])

  useEffect(() => {
    if (!imageTransform) return
    if (!selectedImageIds.has(imageTransform.imageId)) {
      setImageTransform(null)
      setImageTransformDraft(null)
    }
  }, [
    imageTransform,
    selectedImageIds,
    setImageTransform,
    setImageTransformDraft,
  ])

  // ---- Line ----
  useEffect(() => {
    if (!lineTransform) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLineTransform(null)
        setLineTransformDraft(null)
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [lineTransform, setLineTransform, setLineTransformDraft])

  useEffect(() => {
    if (!lineTransform) return
    if (!selectedLineIds.has(lineTransform.lineId)) {
      setLineTransform(null)
      setLineTransformDraft(null)
    }
  }, [
    lineTransform,
    selectedLineIds,
    setLineTransform,
    setLineTransformDraft,
  ])

  // ---- Door ----
  // Uses `capture: true` so it fires ahead of the global deselect
  // handler that other Esc listeners bubble through — matches the
  // original behaviour in the route file.
  useEffect(() => {
    if (!doorTransform) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setDoorTransform(null)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [doorTransform, setDoorTransform])

  useEffect(() => {
    if (!doorTransform) return
    if (!selectedDoorIds.has(doorTransform.doorId)) setDoorTransform(null)
  }, [doorTransform, selectedDoorIds, setDoorTransform])
}
