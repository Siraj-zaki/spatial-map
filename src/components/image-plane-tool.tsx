/**
 * Self-contained image-plane creation tool. Mounts in `create-grids.tsx`
 * alongside the other overlays. When `activeTool === 'create-image-plane'`,
 * it:
 *
 *   1. Opens the upload library (`ImageLibraryDialog`): reuse an image this
 *      workspace already uploaded — this facility first — or upload one.
 *   2. Listens for the next map click and creates an `ImagePlaneShape` at
 *      the clicked location with default 3D-transform config.
 *   3. Calls `onCreated(id)` so the host can select it, switch tools,
 *      and surface the side-panel editor.
 *
 * Kept separate from `create-grids.tsx` so the existing create-image /
 * create-model flows remain untouched.
 */

import { useTranslation } from 'react-i18next'
import { ImageLibraryDialog } from '@/components/upload-library'
import { DEFAULT_IMAGE_PLANE_CONFIG, type ImagePlaneShape } from '@/lib/shapes'
import { useSpatialStore } from '@/lib/spatial-store'
import { invalidateUploadLibrary, measureImage, type LibraryImage } from '@/lib/upload-library'
import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'
import { useEffect, useRef, useState } from 'react'

interface ImagePlaneToolProps {
  map: MapboxMapInstance | null
  active: boolean
  zoneId?: number
  /** Optional default floor plan the new plane should be pinned to. */
  floorPlanId?: number
  /**
   * Default base altitude (meters) — matches the default floor plan's
   * elevation so an image plane drawn on an elevated plan lands at the
   * same altitude without a manual sidebar tweak.
   */
  elevation?: number
  unit: string
  onCreated?: (id: number) => void
  /** Called once the placement flow finishes so the host can return to select / pan. */
  onDone?: () => void
}

interface ImagePlaneDraft {
  imageUrl: string
  mimeType: string
  naturalWidth: number
  naturalHeight: number
  fileName: string
}

export function ImagePlaneTool({
  map,
  active,
  zoneId,
  floorPlanId,
  elevation,
  unit,
  onCreated,
  onDone,
}: ImagePlaneToolProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<ImagePlaneDraft | null>(null)
  // The dialog closes itself right after a pick, before `draft` re-renders.
  const pickedRef = useRef(false)
  // Switching away from the tool drops an unplaced pick (adjusted during
  // render, not in an effect).
  const [wasActive, setWasActive] = useState(active)
  if (wasActive !== active) {
    setWasActive(active)
    if (!active) setDraft(null)
  }

  const pick = async (item: LibraryImage) => {
    let { naturalWidth, naturalHeight } = item
    if (!naturalWidth || !naturalHeight) {
      const size = await measureImage(item.url)
      naturalWidth = size.width
      naturalHeight = size.height
    }
    pickedRef.current = true
    setDraft({ imageUrl: item.url, mimeType: item.mimeType || 'image/png', naturalWidth, naturalHeight, fileName: item.name })
  }

  // ---- Cursor: crosshair while placing, default otherwise.
  // Matches every other create-* tool's behaviour (see create-grids.tsx
  // patterns at the create-marker / create-model handlers).
  useEffect(() => {
    if (!map) return
    const canvas = map.getCanvas()
    if (active && draft) {
      canvas.style.cursor = 'crosshair'
    }
    return () => {
      if (canvas.style.cursor === 'crosshair') canvas.style.cursor = ''
    }
  }, [map, active, draft])

  // ---- Map click → create the shape at the click location.
  useEffect(() => {
    if (!map || !active || !draft) return
    const handleClick = async (e: MapMouseEvent) => {
      const lng = e.lngLat.lng
      const lat = e.lngLat.lat
      // Seed size = "1 pixel ≈ 1 cm" so the plane reflects the source
      // image's actual pixel dimensions and aspect ratio out of the box.
      // A 1920×1080 photo becomes 19.2 m × 10.8 m — a sensible footprint
      // at typical warehouse zoom (15-19). Cap the longer side at 100 m
      // so huge source images don't dominate the scene; the cap scales
      // the shorter side proportionally to preserve aspect ratio.
      const CAP = 100
      const PX_TO_M = 0.01
      let width = CAP
      let height = CAP
      if (draft.naturalWidth > 0 && draft.naturalHeight > 0) {
        width = draft.naturalWidth * PX_TO_M
        height = draft.naturalHeight * PX_TO_M
        const longest = Math.max(width, height)
        if (longest > CAP) {
          const scale = CAP / longest
          width *= scale
          height *= scale
        }
        // Floor at 0.5 m so a tiny icon doesn't disappear.
        width = Math.max(width, 0.5)
        height = Math.max(height, 0.5)
      }
      const shape: Omit<ImagePlaneShape, 'id'> = {
        name: draft.fileName.replace(/\.[^.]+$/, '') || 'Image plane',
        position: [lng, lat],
        imageUrl: draft.imageUrl,
        mimeType: draft.mimeType,
        naturalWidth: draft.naturalWidth,
        naturalHeight: draft.naturalHeight,
        config: {
          ...DEFAULT_IMAGE_PLANE_CONFIG,
          width,
          height,
          elevation: elevation ?? DEFAULT_IMAGE_PLANE_CONFIG.elevation,
        },
        zoneId: zoneId ?? undefined,
        floorPlanId: floorPlanId ?? undefined,
        unit,
        visible: true,
      } as Omit<ImagePlaneShape, 'id'>
      try {
        const created = await useSpatialStore
          .getState()
          .createLocal('image-planes', shape)
        if (created.id !== undefined) onCreated?.(created.id)
        invalidateUploadLibrary()
      } catch (err) {
        console.warn('[image-plane-tool] create failed', err)
      } finally {
        setDraft(null)
        onDone?.()
      }
    }
    map.on('click', handleClick)
    return () => {
      map.off('click', handleClick)
    }
  }, [map, active, draft, zoneId, floorPlanId, elevation, unit, onCreated, onDone])

  if (!active || draft) return null
  return (
    <ImageLibraryDialog
      open
      onOpenChange={(open) => {
        if (open) return
        if (pickedRef.current) pickedRef.current = false
        else onDone?.()
      }}
      title={t('library.planeTitle', { defaultValue: 'Add image plane' })}
      description={t('library.planeBody', { defaultValue: 'Pick an image this workspace already uploaded, or upload a new one. Then click the map to place it.' })}
      confirmLabel={t('library.planeConfirm', { defaultValue: 'Place on map' })}
      zoneId={zoneId ?? null}
      onPick={pick}
    />
  )
}
