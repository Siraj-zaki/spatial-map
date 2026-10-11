import { useState } from 'react'

export type ImagePlaneTransform =
  | { imagePlaneId: number; kind: 'move' }
  | null

export type ImagePlaneTransformDraft = { position: [number, number] } | null

/**
 * Local editor state for the image-plane tool. Image planes are 3D
 * textured planes (elevation + 3-axis rotation) rendered via Mapbox's
 * model layer; distinct from `image` shapes which are flat rasters
 * anchored to the ground plane. Placement is driven by the
 * self-contained `<ImagePlaneTool>` component so this hook only owns
 * selection + a move transform + its live draft.
 */
export function useImagePlaneEditorState() {
  const [selectedImagePlaneIds, setSelectedImagePlaneIds] = useState<
    Set<number>
  >(() => new Set())
  const [imagePlaneTransform, setImagePlaneTransform] =
    useState<ImagePlaneTransform>(null)
  const [imagePlaneTransformDraft, setImagePlaneTransformDraft] =
    useState<ImagePlaneTransformDraft>(null)

  return {
    selectedImagePlaneIds,
    setSelectedImagePlaneIds,
    imagePlaneTransform,
    setImagePlaneTransform,
    imagePlaneTransformDraft,
    setImagePlaneTransformDraft,
  }
}
