import { useState } from 'react'

import { usePersistedState } from '@/lib/persisted-state'
import {
  DEFAULT_TEXT_LABEL_CONFIG,
  type TextLabelConfig,
} from '@/lib/shapes'

export type TextLabelTransform =
  | { textLabelId: number; kind: 'move' | 'rotate' | 'scale' }
  | null

export type TextLabelTransformDraft =
  | {
      position?: [number, number]
      rotation?: number
      config?: TextLabelConfig
    }
  | null

/**
 * Local editor state for the text-label tool: current selection,
 * default placement config, ghost cursor lng/lat while placing, and
 * any active transform.
 */
export function useTextLabelEditorState() {
  const [selectedTextLabelIds, setSelectedTextLabelIds] = useState<
    Set<number>
  >(new Set())
  const [textLabelConfig, setTextLabelConfig] = usePersistedState<TextLabelConfig>(
    'sgv-draw-config:textLabel',
    () => ({ ...DEFAULT_TEXT_LABEL_CONFIG }),
  )
  const [textLabelCursor, setTextLabelCursor] = useState<
    [number, number] | null
  >(null)
  const [textLabelTransform, setTextLabelTransform] =
    useState<TextLabelTransform>(null)
  const [textLabelTransformDraft, setTextLabelTransformDraft] =
    useState<TextLabelTransformDraft>(null)

  return {
    selectedTextLabelIds,
    setSelectedTextLabelIds,
    textLabelConfig,
    setTextLabelConfig,
    textLabelCursor,
    setTextLabelCursor,
    textLabelTransform,
    setTextLabelTransform,
    textLabelTransformDraft,
    setTextLabelTransformDraft,
  }
}
