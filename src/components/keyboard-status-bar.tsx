import type { SidePanelMode } from '@/components/side-panel'
import type { Tool } from '@/lib/keyboard-shortcuts'
import { Keyboard } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface KeyboardHintProps {
  activeTool: Tool
  panelMode: SidePanelMode
  /** True if a move/rotate/scale transform is in progress on the map. */
  transformActive: boolean
  /** Number of shapes currently selected (any kind). */
  selectedCount: number
  shiftHeld: boolean
  altHeld: boolean
  /** Click handler for the ? button — opens the cheatsheet. */
  onOpenCheatsheet: () => void
}

/**
 * The *current* contextual keyboard hint, rendered inline in the middle of
 * the editor's bottom status bar (it used to float in its own pill and
 * overlapped the bar). Strings flow through i18n via `kbHint.<mode>` keys.
 */
export function KeyboardHint({
  activeTool,
  panelMode,
  transformActive,
  selectedCount,
  shiftHeld,
  altHeld,
  onOpenCheatsheet,
}: KeyboardHintProps) {
  const { t } = useTranslation()

  const hint = resolveHintKey({ activeTool, panelMode, transformActive, selectedCount })
  const text = t(`kbHint.${hint}`, { defaultValue: DEFAULT_HINTS[hint] })

  const modifier = shiftHeld
    ? t('kbHint.modShift', { defaultValue: 'Shift held' })
    : altHeld
      ? t('kbHint.modAlt', { defaultValue: 'Alt held' })
      : null

  return (
    <div className="flex min-w-0 items-center justify-center gap-2">
      <span className="min-w-0 truncate" title={text}>{text}</span>
      {modifier && (
        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          {modifier}
        </span>
      )}
      <button
        type="button"
        onClick={onOpenCheatsheet}
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('kb.cheatsheet', { defaultValue: 'Show / hide this cheatsheet' })}
        title={t('kb.cheatsheet', { defaultValue: 'Show / hide this cheatsheet' })}
      >
        <Keyboard className="h-3 w-3" aria-hidden />
        <kbd className="font-mono">?</kbd>
      </button>
    </div>
  )
}

// ---- Contextual hint resolver --------------------------------------------

type HintKey = keyof typeof DEFAULT_HINTS

const DEFAULT_HINTS = {
  idle: 'Drag to pan · V to select · ? for shortcuts',
  pan: 'Drag to pan · V to select · ? for shortcuts',
  select: 'Click to select · Shift-click to add · Esc to deselect',
  drawingGrid: 'Click first corner · ⇧ square · ⌥ from center · Esc cancel',
  drawingMarker: 'Click to place marker · Esc cancel',
  drawingCircle: 'Drag to draw · ⇧ perfect circle · ⌥ from center · Esc cancel',
  drawingPolygon: 'Click to add vertex · Enter to finish · ⌫ undo vertex · ⇧ constrain',
  drawingLine: 'Click to add vertex · Enter to finish · ⌫ undo vertex · ⇧ constrain',
  drawingImage: 'Drag to size · ⇧ square aspect · ⌥ from center · Esc cancel',
  drawingImagePlane: 'Click the map to place the image plane · Esc cancel',
  drawingModel: 'Click to place model · Esc cancel',
  drawingText: 'Click to place label · Esc cancel',
  drawingStair: 'Click anchors · Enter to finish · Esc cancel',
  zones: 'Click a facility to focus it',
  transformActive: 'Arrows move · [ ] rotate · - + scale · PgUp/PgDn elevation · Enter commit · Esc cancel',
  selected: 'Arrows nudge · [ ] rotate · - + scale · Delete · ⌘D duplicate · ? help',
  // Polygon / line / stair have no scale handler in useKeyboardDispatch —
  // scaling vertices around a centroid isn't wired up. Drop the "- + scale"
  // hint for those kinds so we don't advertise a shortcut that no-ops.
  selectedNoScale: 'Arrows nudge · [ ] rotate · Delete · ⌘D duplicate · ? help',
  // Same shapes also have no PgUp/PgDn elevation handler in
  // handleElevationSelected, so transform-mode hint drops both.
  transformActiveNoScaleNoElevation:
    'Arrows move · [ ] rotate · Enter commit · Esc cancel',
} as const

function resolveHintKey(state: {
  activeTool: Tool
  panelMode: SidePanelMode
  transformActive: boolean
  selectedCount: number
}): HintKey {
  if (state.transformActive) {
    switch (state.panelMode) {
      case 'polygon-selected':
      case 'line-selected':
      case 'stair-selected':
        return 'transformActiveNoScaleNoElevation'
      default:
        return 'transformActive'
    }
  }
  // A live selection is the user's current context, so it wins over the
  // active tool. This matters after a placement tool commits and selects
  // the new shape — activeTool is still e.g. 'create-image' for a beat, but
  // the "Drag to size" placement hint is stale; the user is now editing.
  // Starting a new draw clears the selection (see the effect on activeTool
  // change in create-grids/index.tsx), so this branch only fires for
  // post-commit and true selection modes, never for mid-draw.
  if (state.selectedCount > 0) {
    switch (state.panelMode) {
      case 'polygon-selected':
      case 'line-selected':
      case 'stair-selected':
        return 'selectedNoScale'
      default:
        return 'selected'
    }
  }

  switch (state.activeTool) {
    case 'pan':
      return 'pan'
    case 'select':
      return 'select'
    case 'create-grid':
      return 'drawingGrid'
    case 'create-marker':
      return 'drawingMarker'
    case 'create-circle':
      return 'drawingCircle'
    case 'create-polygon':
      return 'drawingPolygon'
    case 'create-line':
      return 'drawingLine'
    case 'create-image':
      return 'drawingImage'
    case 'create-image-plane':
      return 'drawingImagePlane'
    case 'create-model':
      return 'drawingModel'
    case 'create-text':
      return 'drawingText'
    case 'create-stair':
      return 'drawingStair'
    case 'zones':
      return 'zones'
    default:
      return 'idle'
  }
}