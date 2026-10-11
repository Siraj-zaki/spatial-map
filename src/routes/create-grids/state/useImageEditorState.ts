import { useState } from 'react'

import { usePersistedState } from '@/lib/persisted-state'
import {
  DEFAULT_IMAGE_CONFIG,
  type ImageShapeConfig,
} from '@/lib/shapes'

export type ImageDraft = {
  fileName: string
  dataUrl: string
  imageUrl?: string
  /** Set while a fresh upload is in flight; placement awaits it so a row
   *  is never created with the image inlined as base64. */
  pendingUpload?: Promise<string | undefined>
  mimeType: string
  naturalWidth: number
  naturalHeight: number
  /**
   * Which import produced this draft. Both `pdf` and `dwg` arrive as a
   * PNG the server rendered and stored; the distinction only decides
   * what the panel calls the plan and where its ground size came from.
   */
  sourceKind?: 'pdf' | 'dwg'
  /** Chosen plot scale denominator (N in 1:N), absent when uncalibrated. */
  scaleDenominator?: number
  /**
   * True ground size. Known for a PDF sheet whose plot scale the user
   * confirmed, and always known for a CAD drawing — model space is 1:1,
   * so the coordinates already are the building. When set, the placement
   * drag picks position only and the committed bbox is snapped to this
   * size.
   */
  realWidthMeters?: number
  realHeightMeters?: number
} | null

export type ImageTransform =
  | { imageId: number; kind: 'move' | 'rotate' | 'scale' }
  | null

export type ImageTransformDraft = {
  start?: [number, number]
  current?: [number, number]
  rotation?: number
} | null

/**
 * Local editor state for the image (raster floor plan) tool. Draw
 * flow: user picks a file → we read it as a data URL + upload → next
 * mousedown → drag → mouseup commits a new image shape with the bbox
 * the user dragged. Mirrors the circle single-mode drag pattern.
 */
export function useImageEditorState() {
  const [selectedImageIds, setSelectedImageIds] = useState<Set<number>>(
    new Set(),
  )
  const [imageConfig, setImageConfig] = usePersistedState<ImageShapeConfig>(
    'sgv-draw-config:image',
    () => ({ ...DEFAULT_IMAGE_CONFIG }),
  )
  const [imageDraft, setImageDraft] = useState<ImageDraft>(null)
  // Set while the page/scale picker is open. A PDF can't become a draft
  // until the user says which sheet it is and what scale it was drawn at.
  const [pendingPdfFile, setPendingPdfFile] = useState<File | null>(null)
  // Same idea for a CAD drawing, but the open questions are units and
  // layers rather than sheet and scale.
  const [pendingCadFile, setPendingCadFile] = useState<File | null>(null)
  const [imageDragStart, setImageDragStart] = useState<
    [number, number] | null
  >(null)
  const [imageDragCursor, setImageDragCursor] = useState<
    [number, number] | null
  >(null)
  const [imageTransform, setImageTransform] = useState<ImageTransform>(null)
  const [imageTransformDraft, setImageTransformDraft] =
    useState<ImageTransformDraft>(null)

  return {
    selectedImageIds,
    setSelectedImageIds,
    imageConfig,
    setImageConfig,
    imageDraft,
    setImageDraft,
    pendingPdfFile,
    setPendingPdfFile,
    pendingCadFile,
    setPendingCadFile,
    imageDragStart,
    setImageDragStart,
    imageDragCursor,
    setImageDragCursor,
    imageTransform,
    setImageTransform,
    imageTransformDraft,
    setImageTransformDraft,
  }
}
