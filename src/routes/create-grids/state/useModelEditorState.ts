import { useRef, useState } from 'react'

import { usePersistedState } from '@/lib/persisted-state'
import {
  DEFAULT_MODEL_CONFIG,
  type ModelShapeConfig,
} from '@/lib/shapes'

export type ModelTransform = { modelId: number; kind: 'move' } | null

export type ModelTransformDraft = { position?: [number, number] } | null

export type ModelDraftPatch =
  | {
      modelId: number
      name?: string
      visible?: boolean
      config?: Partial<ModelShapeConfig>
    }
  | null

/**
 * Local editor state for the model (glTF/GLB) tool. Tool flow: click
 * the toolbar icon → auto-open the model library → user picks an asset
 * → cursor enters "drop" mode → next map click drops a `ModelShape`.
 *
 * `modelLibraryPickedRef` is flipped to `true` by `onSelect` right
 * before the dialog closes so the close-handler can tell a pick apart
 * from a real dismiss. Reading `modelConfig.modelAssetId` inside
 * `onOpenChange` would race the queued state update.
 *
 * Sidebar edits to a selected model go through the spatial store
 * (`updateLocal`), not route state.
 */
export function useModelEditorState() {
  const [selectedModelIds, setSelectedModelIds] = useState<Set<number>>(
    new Set(),
  )
  const [modelConfig, setModelConfig] = usePersistedState<ModelShapeConfig>(
    'sgv-draw-config:model',
    () => ({ ...DEFAULT_MODEL_CONFIG }),
  )
  const [modelCursor, setModelCursor] = useState<[number, number] | null>(null)
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false)
  const [modelLibraryMode, setModelLibraryMode] = useState<'place' | 'swap'>(
    'place',
  )
  const modelLibraryPickedRef = useRef(false)
  const [modelTransform, setModelTransform] = useState<ModelTransform>(null)
  const [modelTransformDraft, setModelTransformDraft] =
    useState<ModelTransformDraft>(null)

  return {
    selectedModelIds,
    setSelectedModelIds,
    modelConfig,
    setModelConfig,
    modelCursor,
    setModelCursor,
    modelLibraryOpen,
    setModelLibraryOpen,
    modelLibraryMode,
    setModelLibraryMode,
    modelLibraryPickedRef,
    modelTransform,
    setModelTransform,
    modelTransformDraft,
    setModelTransformDraft,
  }
}
