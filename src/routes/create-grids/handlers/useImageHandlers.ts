import { useCallback, type Dispatch, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import type { CadPickResult } from '@/components/cad-import-dialog'
import type { PdfPickResult } from '@/components/pdf-page-picker'
import { rewriteFilesUrlSameOrigin, uploadImage } from '@/lib/binary-store'
import { invalidateUploadLibrary, measureImage, type LibraryImage } from '@/lib/upload-library'
import { toast } from '@/lib/toast-store'
import i18n from '@/i18n'
import { isCadFile } from '@/lib/cad-import'
import { readImageFile } from '@/lib/image-generators'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { isPdfFile } from '@/lib/pdf-import'
import { type ImageShape, type ImageShapeConfig } from '@/lib/shapes'
import { patchSpatialEntity, useSpatialStore, saveSpatialEntity } from '@/lib/spatial-store'

import type {
  ImageDraft,
  ImageTransform,
  ImageTransformDraft,
} from '../state/useImageEditorState'
import { fitBoundsIfOffscreen } from './fitToShapeOnSelect'
import { copyName } from '@/lib/copy-name'

type SelectedBin =
  | { gridId: number; row: number; col: number; level: number }
  | null

/**
 * All image (floor plan raster) CRUD + selection + transform +
 * upload handlers. Images support move / rotate / scale — the
 * rotate handle spins the raster around its centre, scale drags
 * one corner while pinning the opposite.
 *
 * `handleToggleImageVisible` intentionally SKIPS the spatial-store
 * optimistic patch — the sidebar's floor-plan cascade
 * (`hiddenFloorPlanIds`) reads from the raw store list, so a direct
 * `apiDb.images.update` + `queryCache.invalidate('images')` keeps the
 * SSE + local reload in charge of the render.
 */
export function useImageHandlers({
  mapInstance,
  savedImages,
  selectedImage,
  imageTransform,
  imageTransformDraft,
  setSelectedImageIds,
  setImageTransform,
  setImageTransformDraft,
  setImageConfig,
  setImageDraft,
  setPendingPdfFile,
  setPendingCadFile,
  setSelectedBin,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedModelIds,
  setSelectedStairIds,
  setActiveTool,
  activeWarehouseId,
}: {
  activeWarehouseId: number | null
  mapInstance: MapboxMapInstance | null
  savedImages: ImageShape[]
  selectedImage: ImageShape | null
  imageTransform: ImageTransform
  imageTransformDraft: ImageTransformDraft
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setImageTransform: Dispatch<SetStateAction<ImageTransform>>
  setImageTransformDraft: Dispatch<SetStateAction<ImageTransformDraft>>
  setImageConfig: Dispatch<SetStateAction<ImageShapeConfig>>
  setImageDraft: Dispatch<SetStateAction<ImageDraft>>
  setPendingPdfFile: Dispatch<SetStateAction<File | null>>
  setPendingCadFile: Dispatch<SetStateAction<File | null>>
  setSelectedBin: Dispatch<SetStateAction<SelectedBin>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  const handlePickImageFile = useCallback(
    async (file: File) => {
      // A PDF is a drawing set, not a picture: which sheet and at what
      // plot scale are questions only the user can answer, so it detours
      // through the picker before it can become a draft.
      if (isPdfFile(file)) {
        setPendingPdfFile(file)
        return
      }
      // A CAD drawing detours for the same reason, but the open
      // questions are different: which units the coordinates are in, and
      // which of the thirty layers are actually the plan.
      if (isCadFile(file)) {
        setPendingCadFile(file)
        return
      }
      let result: Awaited<ReturnType<typeof readImageFile>>
      try {
        result = await readImageFile(file)
      } catch (err) {
        console.warn('[CreateGrids] image read failed', err)
        toast.error(i18n.t('library.readFailed', { defaultValue: 'That file could not be read as an image.' }))
        return
      }
      // Upload in the background so the user can start dragging at once;
      // placement awaits `pendingUpload` before it creates the row.
      const pendingUpload = uploadImage(file, activeWarehouseId).then(
        (upload) => {
          setImageDraft((prev) => (prev && prev.dataUrl === result.dataUrl ? { ...prev, imageUrl: upload.url, pendingUpload: undefined } : prev))
          invalidateUploadLibrary()
          return upload.url
        },
        (err) => {
          console.warn('[CreateGrids] image upload failed', err)
          toast.error(i18n.t('library.uploadFailed', { defaultValue: 'Upload failed. Check your connection and try again.' }))
          setImageDraft((prev) => (prev && prev.dataUrl === result.dataUrl ? null : prev))
          return undefined
        },
      )
      setImageDraft({
        fileName: file.name,
        dataUrl: result.dataUrl,
        mimeType: result.mimeType,
        naturalWidth: result.naturalWidth,
        naturalHeight: result.naturalHeight,
        pendingUpload,
      })
    },
    [setImageDraft, setPendingPdfFile, setPendingCadFile, activeWarehouseId],
  )

  /** Reuse a file from the workspace's upload library — nothing to upload. */
  const handlePickLibraryImage = useCallback(
    async (item: LibraryImage) => {
      let { naturalWidth, naturalHeight } = item
      if (!naturalWidth || !naturalHeight) {
        try {
          const size = await measureImage(item.url)
          naturalWidth = size.width
          naturalHeight = size.height
        } catch {
          toast.error(i18n.t('library.loadFailed', { defaultValue: 'That image could not be loaded.' }))
          return
        }
      }
      setImageDraft({
        fileName: item.name,
        dataUrl: rewriteFilesUrlSameOrigin(item.url),
        imageUrl: item.url,
        mimeType: item.mimeType || 'image/png',
        naturalWidth,
        naturalHeight,
      })
    },
    [setImageDraft],
  )

  /** Swap a placed floor plan's picture, keeping its position and size. */
  const handleReplaceImageFile = useCallback(
    async (imageId: number, item: LibraryImage) => {
      let { naturalWidth, naturalHeight } = item
      if (!naturalWidth || !naturalHeight) {
        try {
          const size = await measureImage(item.url)
          naturalWidth = size.width
          naturalHeight = size.height
        } catch {
          toast.error(i18n.t('library.loadFailed', { defaultValue: 'That image could not be loaded.' }))
          return
        }
      }
      await saveSpatialEntity('images', imageId, {
        imageUrl: item.url,
        imageData: null,
        mimeType: item.mimeType || 'image/png',
        naturalWidth,
        naturalHeight,
        updatedAt: new Date(),
      } as unknown as Partial<ImageShape>)
      invalidateUploadLibrary()
    },
    [],
  )

  /**
   * The picker has already rasterized the chosen sheet server-side and
   * stored the PNG, so there is nothing left to upload — the render URL
   * goes straight onto the draft.
   */
  const handleConfirmPdfPage = useCallback(
    (picked: PdfPickResult) => {
      const { render } = picked
      const url = rewriteFilesUrlSameOrigin(render.url)
      setPendingPdfFile(null)
      setImageDraft({
        fileName: `${render.page.sheet ?? 'Sheet'} · p${render.page.index + 1}`,
        dataUrl: url,
        imageUrl: render.url,
        mimeType: render.mimeType,
        naturalWidth: render.naturalWidth,
        naturalHeight: render.naturalHeight,
        sourceKind: 'pdf',
        scaleDenominator: picked.scaleDenominator || undefined,
        realWidthMeters: picked.realWidthMeters || undefined,
        realHeightMeters: picked.realHeightMeters || undefined,
      })
    },
    [setImageDraft, setPendingPdfFile],
  )

  const handleCancelPdfPage = useCallback(() => {
    setPendingPdfFile(null)
  }, [setPendingPdfFile])

  /**
   * Same shape as the PDF path, and deliberately so: the dialog has
   * already rendered the chosen layers server-side and stored the PNG,
   * so a CAD floor plan reaches the map as an ordinary image with no
   * second placement path and no shape kind of its own.
   *
   * The one thing a drawing gives that a sheet cannot is its own size.
   * CAD model space is 1:1, so the real-world extent is read rather than
   * inferred, and the placement drag only has to pick position.
   */
  const handleConfirmCadDrawing = useCallback(
    (picked: CadPickResult) => {
      const { render } = picked
      setPendingCadFile(null)
      setImageDraft({
        fileName: picked.fileName.replace(/\.[^./\\]+$/, '').trim() || picked.fileName,
        dataUrl: rewriteFilesUrlSameOrigin(render.url),
        imageUrl: render.url,
        mimeType: render.mimeType,
        naturalWidth: render.naturalWidth,
        naturalHeight: render.naturalHeight,
        sourceKind: 'dwg',
        realWidthMeters: render.widthMeters,
        realHeightMeters: render.heightMeters,
      })
    },
    [setImageDraft, setPendingCadFile],
  )

  const handleCancelCadDrawing = useCallback(() => {
    setPendingCadFile(null)
  }, [setPendingCadFile])

  const handleClearImageDraft = useCallback(() => {
    setImageDraft(null)
  }, [setImageDraft])

  const handleSelectImage = useCallback(
    (id: number, additive: boolean) => {
      setSelectedGridIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedMarkerIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedCircleIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedPolygonIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedLineIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedModelIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedStairIds((prev) => (prev.size > 0 ? new Set() : prev))
      setSelectedBin(null)
      setSelectedImageIds((prev) => {
        if (additive) {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }
        return new Set([id])
      })
      const img = savedImages.find((x) => x.id === id)
      if (img && img.start && img.current) {
        fitBoundsIfOffscreen(
          mapInstance,
          [
            Math.min(img.start[0], img.current[0]),
            Math.min(img.start[1], img.current[1]),
            Math.max(img.start[0], img.current[0]),
            Math.max(img.start[1], img.current[1]),
          ],
          { additive },
        )
      }
    },
    [
      setSelectedGridIds,
      setSelectedMarkerIds,
      setSelectedCircleIds,
      setSelectedPolygonIds,
      setSelectedLineIds,
      setSelectedModelIds,
      setSelectedStairIds,
      setSelectedBin,
      setSelectedImageIds,
      mapInstance,
      savedImages,
    ],
  )

  const handleImageClick = useCallback(
    (id: number, e: MouseEvent) => {
      handleSelectImage(id, e.shiftKey || e.metaKey || e.ctrlKey)
    },
    [handleSelectImage],
  )

  const handleFitToImageById = useCallback(
    (id: number) => {
      const img = savedImages.find((x) => x.id === id)
      if (!img || !mapInstance) return
      const center: [number, number] = [
        (img.start[0] + img.current[0]) / 2,
        (img.start[1] + img.current[1]) / 2,
      ]
      mapInstance.flyTo({
        center,
        zoom: Math.max(mapInstance.getZoom(), 16),
        essential: true,
      })
    },
    [mapInstance, savedImages],
  )

  const handleDeleteImageById = useCallback(
    (id: number) => {
      setSelectedImageIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      useSpatialStore.getState().deleteLocal('images', id)
    },
    [setSelectedImageIds],
  )

  const handleDuplicateImage = useCallback(
    (id: number) => {
      const original = savedImages.find((img) => img.id === id)
      if (!original) return
      const now = new Date()
      const offset: [number, number] = [0.00005, 0.00005]
      void (async () => {
        const { id: _, ...rest } = original
        const copy = await useSpatialStore.getState().createLocal('images', {
          ...rest,
          name: copyName('images', original.name),
          start: [
            original.start[0] + offset[0],
            original.start[1] + offset[1],
          ],
          current: [
            original.current[0] + offset[0],
            original.current[1] + offset[1],
          ],
          createdAt: now,
          updatedAt: now,
        } as Omit<ImageShape, 'id'>)
        setSelectedImageIds(new Set([copy.id!]))
      })()
    },
    [savedImages, setSelectedImageIds],
  )

  const handleExitImagePlacement = useCallback(() => {
    setActiveTool('pan')
  }, [setActiveTool])

  const handleRenameImage = useCallback(
    async (id: number, name: string) => {
      await saveSpatialEntity('images', id, { name, updatedAt: new Date() } as never)
    },
    [],
  )

  /**
   * Toggle one image's visibility. Used by the per-image eye button
   * in the side-panel "Floor plans" list. The route already wires
   * the cascade — `hiddenFloorPlanIds` picks up the change and
   * `scopeToWarehouse` filters out every shape with
   * `floorPlanId === id` on the next render, so dimming the ground
   * floor immediately dims everything stamped to it.
   */
  const handleToggleImageVisible = useCallback(
    async (id: number, visible: boolean) => {
      await saveSpatialEntity('images', id, { visible, updatedAt: new Date() } as never)
    },
    [],
  )

  const handleAssignImageToZone = useCallback(
    async (imageId: number, zoneId: number | null) => {
      await saveSpatialEntity('images', imageId, { zoneId } as never)
    },
    [],
  )

  const handleImageConfigChange = useCallback(
    (cfg: ImageShapeConfig) => {
      if (selectedImage && selectedImage.id !== undefined) {
        const id = selectedImage.id
        void patchSpatialEntity('images', id, {
          config: { ...cfg },
          updatedAt: new Date(),
        })
      } else {
        setImageConfig(cfg)
      }
    },
    [selectedImage, setImageConfig],
  )

  const handleImagePatch = useCallback(
    (patch: Partial<ImageShape>) => {
      if (!selectedImage || selectedImage.id === undefined) return
      void patchSpatialEntity('images', selectedImage.id, {
        ...patch,
        updatedAt: new Date(),
      })
    },
    [selectedImage],
  )

  const handleStartMoveImage = useCallback(
    (id: number) => {
      setImageTransform({ imageId: id, kind: 'move' })
      setImageTransformDraft(null)
    },
    [setImageTransform, setImageTransformDraft],
  )

  const handleStartRotateImage = useCallback(
    (id: number) => {
      setImageTransform({ imageId: id, kind: 'rotate' })
      setImageTransformDraft(null)
    },
    [setImageTransform, setImageTransformDraft],
  )

  const handleStartScaleImage = useCallback(
    (id: number) => {
      setImageTransform({ imageId: id, kind: 'scale' })
      setImageTransformDraft(null)
    },
    [setImageTransform, setImageTransformDraft],
  )

  const handleCancelImageTransform = useCallback(() => {
    setImageTransform(null)
    setImageTransformDraft(null)
  }, [setImageTransform, setImageTransformDraft])

  const handleImageTransformChange = useCallback(
    (
      patch: {
        start?: [number, number]
        current?: [number, number]
        rotation?: number
      },
      commit: boolean,
    ) => {
      setImageTransformDraft((prev) => ({ ...(prev ?? {}), ...patch }))
      if (!commit) return
      const tx = imageTransform
      if (!tx) return
      const merged = { ...(imageTransformDraft ?? {}), ...patch }
      const update: Partial<ImageShape> = { updatedAt: new Date() }
      if (merged.start) update.start = merged.start
      if (merged.current) update.current = merged.current
      if (typeof merged.rotation === 'number') update.rotation = merged.rotation
      void patchSpatialEntity('images', tx.imageId, update)
      setImageTransform(null)
      setImageTransformDraft(null)
    },
    [
      imageTransform,
      imageTransformDraft,
      setImageTransform,
      setImageTransformDraft,
    ],
  )

  return {
    handlePickImageFile,
    handlePickLibraryImage,
    handleReplaceImageFile,
    handleConfirmPdfPage,
    handleCancelPdfPage,
    handleConfirmCadDrawing,
    handleCancelCadDrawing,
    handleClearImageDraft,
    handleSelectImage,
    handleImageClick,
    handleFitToImageById,
    handleDeleteImageById,
    handleDuplicateImage,
    handleExitImagePlacement,
    handleRenameImage,
    handleToggleImageVisible,
    handleAssignImageToZone,
    handleImageConfigChange,
    handleImagePatch,
    handleStartMoveImage,
    handleStartRotateImage,
    handleStartScaleImage,
    handleCancelImageTransform,
    handleImageTransformChange,
  }
}
