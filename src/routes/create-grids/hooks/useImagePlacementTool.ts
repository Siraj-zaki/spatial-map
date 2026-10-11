import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { invalidateUploadLibrary } from '@/lib/upload-library'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import type { TFunction } from 'i18next'

import {
  resizeImageBboxHeightMeters,
  resizeImageBboxWidthMeters,
} from '@/lib/image-generators'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type ImageShape, type ImageShapeConfig } from '@/lib/shapes'
import { useSpatialStore } from '@/lib/spatial-store'
import { type LengthUnit } from '@/lib/units'

import type { ImageDraft } from '../state/useImageEditorState'

/**
 * Image (raster floor plan) placement tool. While
 * `activeTool === 'create-image'` and the user has uploaded a file
 * via the side panel, a mousedown → drag → mouseup gesture commits a
 * new image shape with the bbox the user dragged. `dragPan` is
 * disabled during the drag so the basemap doesn't pan along with the
 * bbox preview.
 *
 * Esc handler: cancels an in-flight drag if one is live, otherwise
 * discards the pending upload draft and exits the tool.
 */
export function useImagePlacementTool({
  mapInstance,
  activeTool,
  imageConfig,
  imageDraft,
  imageDragStart,
  configUnit,
  t,
  activeWarehouseIdRef,
  pinWarehouseCenterIfNeeded,
  setImageDragStart,
  setImageDragCursor,
  setImageDraft,
  setSelectedImageIds,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  imageConfig: ImageShapeConfig
  imageDraft: ImageDraft
  imageDragStart: [number, number] | null
  configUnit: LengthUnit
  t: TFunction
  activeWarehouseIdRef: MutableRefObject<number | null>
  pinWarehouseCenterIfNeeded: (
    zoneId: number | null,
    center: [number, number],
  ) => Promise<void>
  setImageDragStart: Dispatch<SetStateAction<[number, number] | null>>
  setImageDragCursor: Dispatch<SetStateAction<[number, number] | null>>
  setImageDraft: Dispatch<SetStateAction<ImageDraft>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  // Mirror the pending upload + drag anchor into refs so the mousedown/
  // mouseup handlers don't capture stale state.
  const imageDraftRef = useRef<ImageDraft>(imageDraft)
  useEffect(() => {
    imageDraftRef.current = imageDraft
  }, [imageDraft])
  const imageDragStartLatest = useRef<[number, number] | null>(null)
  useEffect(() => {
    imageDragStartLatest.current = imageDragStart
  }, [imageDragStart])

  useEffect(() => {
    if (!mapInstance) return
    if (activeTool !== 'create-image') {
      setImageDragStart(null)
      setImageDragCursor(null)
      return
    }
    const map = mapInstance
    map.getCanvas().style.cursor = 'crosshair'

    let dragging = false
    // RAF-coalesce the placement drag mousemove — Mapbox fires
    // mousemove at pointer rate (120–500 Hz on modern hardware) but
    // the preview raster only needs one setCoordinates per paint frame.
    // Without this, every event triggers `setImageDragCursor` → parent
    // re-renders → overlay's `livePreview` useMemo → preview raster's
    // `setCoordinates`. Coalescing caps the cascade at 60 fps.
    let pendingCursor: [number, number] | null = null
    let moveRafId = 0
    const flushMove = () => {
      moveRafId = 0
      const c = pendingCursor
      pendingCursor = null
      if (!c) return
      setImageDragCursor(c)
    }
    const onMouseDown = (e: MapMouseEvent) => {
      if ((e.originalEvent as MouseEvent).button !== 0) return
      if (!imageDraftRef.current) return // no upload yet — wait for the user to pick a file
      dragging = true
      e.preventDefault()
      map.dragPan.disable()
      setImageDragStart([e.lngLat.lng, e.lngLat.lat])
      setImageDragCursor([e.lngLat.lng, e.lngLat.lat])
    }
    const onMouseMove = (e: MapMouseEvent) => {
      if (!dragging) return
      pendingCursor = [e.lngLat.lng, e.lngLat.lat]
      if (moveRafId === 0) moveRafId = requestAnimationFrame(flushMove)
    }
    const onMouseUp = (e: MapMouseEvent) => {
      if (!dragging) return
      dragging = false
      map.dragPan.enable()
      const start = imageDragStartLatest.current
      const draft = imageDraftRef.current
      setImageDragStart(null)
      setImageDragCursor(null)
      if (!start || !draft) return
      const end: [number, number] = [e.lngLat.lng, e.lngLat.lat]
      // Discard accidental zero-area drags (mousedown then up at the
      // same point) — those would create an invisible image.
      if (
        Math.abs(start[0] - end[0]) < 1e-9 &&
        Math.abs(start[1] - end[1]) < 1e-9
      ) {
        return
      }
      // A PDF sheet whose plot scale is known has an exact ground size,
      // so the drag only picks position — the bbox is snapped to the
      // true dimensions rather than to wherever the mouse came up.
      let placedStart = start
      let placedCurrent = end
      if (draft.realWidthMeters && draft.realHeightMeters) {
        // Height first: it moves the latitudes, and metres-per-degree of
        // longitude depends on the latitude the width is measured at. The
        // width pass only touches longitudes, so this order lands both
        // dimensions exactly; the reverse leaves width off by cos(Δlat).
        const tall = resizeImageBboxHeightMeters(
          { start, current: end },
          draft.realHeightMeters,
        )
        const sized = tall
          ? resizeImageBboxWidthMeters(tall, draft.realWidthMeters)
          : null
        if (sized) {
          placedStart = sized.start
          placedCurrent = sized.current
        }
      }
      const now = new Date()
      void (async () => {
        const wid = activeWarehouseIdRef.current
        // A drawing set yields one image per sheet, so a generic default
        // name would leave the workspace tree as a column of "Image".
        // The draft's name is the sheet descriptor for a PDF and the
        // uploaded filename otherwise.
        const draftName = draft.fileName.replace(/\.[^./\\]+$/, '').trim()
        // A fresh upload may still be in flight — wait for its URL rather
        // than storing the picture inline as base64 on the row.
        const imageUrl = draft.imageUrl ?? (draft.pendingUpload ? await draft.pendingUpload : undefined)
        if (!imageUrl) return
        const image = await useSpatialStore.getState().createLocal('images', {
          name: draftName || t('image.defaultName', { defaultValue: 'Image' }),
          unit: configUnit,
          visible: true,
          zoneId: wid ?? undefined,
          start: placedStart,
          current: placedCurrent,
          rotation: 0,
          imageUrl,
          mimeType: draft.mimeType,
          naturalWidth: draft.naturalWidth,
          naturalHeight: draft.naturalHeight,
          config: { ...imageConfig },
          createdAt: now,
          updatedAt: now,
        } as Omit<ImageShape, 'id'>)
        invalidateUploadLibrary()
        await pinWarehouseCenterIfNeeded(wid, placedStart)
        setSelectedImageIds(new Set([image.id!]))
        setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
        setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      })()
    }

    map.on('mousedown', onMouseDown)
    map.on('mousemove', onMouseMove)
    map.on('mouseup', onMouseUp)
    return () => {
      map.off('mousedown', onMouseDown)
      map.off('mousemove', onMouseMove)
      map.off('mouseup', onMouseUp)
      if (moveRafId !== 0) cancelAnimationFrame(moveRafId)
      pendingCursor = null
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''
    }
  }, [
    mapInstance,
    activeTool,
    imageConfig,
    configUnit,
    t,
    pinWarehouseCenterIfNeeded,
    activeWarehouseIdRef,
    setImageDragStart,
    setImageDragCursor,
    setSelectedImageIds,
    setSelectedGridIds,
    setSelectedMarkerIds,
    setSelectedCircleIds,
    setSelectedPolygonIds,
    setSelectedLineIds,
  ])

  // Esc cancels an in-flight image drag (or exits the tool entirely).
  useEffect(() => {
    if (activeTool !== 'create-image') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (imageDragStart) {
        setImageDragStart(null)
        setImageDragCursor(null)
      } else {
        setImageDraft(null)
        setActiveTool('pan')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    activeTool,
    imageDragStart,
    setImageDragStart,
    setImageDragCursor,
    setImageDraft,
    setActiveTool,
  ])
}
