/**
 * Keyboard shortcut registry for the warehouse editor.
 *
 * The registry is the single source of truth for which keys select which
 * tool, plus the structured cheatsheet data shown in the `?` overlay. The
 * `useKeyboardShortcuts` hook and the cheatsheet component both read from
 * here so the in-app hints never drift from the actual bindings.
 *
 * Tool keys are aliases — most tools respond to both a letter and a
 * number, so users can pick whichever hand-position is comfortable.
 */

export type Tool =
  | 'pan'
  | 'select'
  | 'marquee'
  | 'create-grid'
  | 'create-marker'
  | 'create-circle'
  | 'create-polygon'
  | 'create-line'
  | 'create-route'
  | 'create-image'
  | 'create-model'
  | 'create-image-plane'
  | 'create-text'
  | 'create-stair'
  | 'create-door'
  | 'magic-wall'
  | 'ai-map'
  | 'route-preview'
  | 'measure'
  | 'calibrate-image'
  | 'zones'

/** Keys that create geometry — hidden in preview mode. */
export const CREATION_TOOLS: ReadonlyArray<Tool> = [
  'create-grid',
  'create-marker',
  'create-circle',
  'create-polygon',
  'create-line',
  'create-route',
  'create-image',
  'create-model',
  'create-image-plane',
  'create-text',
  'create-stair',
  'create-door',
]

interface ToolBinding {
  /** Letter aliases, lowercase. Multiple letters may map to the same tool. */
  letters: string[]
  /** Optional number-row alias, e.g. `'3'`. */
  number?: string
}

export const TOOL_SHORTCUTS: Record<Tool, ToolBinding> = {
  pan: { letters: ['v', 'h'], number: '1' },
  select: { letters: ['space'], number: '2' },
  // `q` for "quick select" — drag a rectangle to select every shape
  // inside, regardless of kind. No number-row slot; number row is full.
  marquee: { letters: ['q'] },
  'create-grid': { letters: ['g', 'r'], number: '3' },
  'create-marker': { letters: ['m'], number: '4' },
  'create-circle': { letters: ['c', 'o'], number: '5' },
  'create-polygon': { letters: ['p'], number: '6' },
  'create-line': { letters: ['l'], number: '7' },
  // Route tool shares no primary number-row slot (numbers are already
  // mapped through 0); `y` letter for "way(y)finding" gets close.
  'create-route': { letters: ['y'] },
  'create-image': { letters: ['i'], number: '8' },
  'create-model': { letters: ['b'], number: '9' },
  'create-image-plane': { letters: ['f'], number: '0' },
  'create-text': { letters: ['t'] },
  'create-stair': { letters: ['s'], number: '-' },
  'create-door': { letters: ['d'], number: '=' },
  // `w` for "wall"; no number-row slot (they're full through 0/-/= already).
  'magic-wall': { letters: ['w'] },
  // AI Map — click a placed floor plan to auto-detect aisles/areas/doors/stairs.
  // `a` for AI; number-row is fully used already.
  'ai-map': { letters: ['a'] },
  // Route-preview — click A then B to visualise a wayfinding path
  // through the current scene. `n` for "navigate".
  'route-preview': { letters: ['n'] },
  // Measure — ruler that leaves guides. `u` for "rUler"; e/j/k/u/x were
  // the only free letters.
  measure: { letters: ['u'] },
  // Calibrate scale — entered from a selected image's side panel only.
  'calibrate-image': { letters: [] },
  zones: { letters: ['z'] },
}

/** Reverse lookup: key (lowercase) → tool. Precomputed at module load. */
const KEY_TO_TOOL: Map<string, Tool> = (() => {
  const map = new Map<string, Tool>()
  for (const tool of Object.keys(TOOL_SHORTCUTS) as Tool[]) {
    const binding = TOOL_SHORTCUTS[tool]
    for (const letter of binding.letters) map.set(letter, tool)
    if (binding.number) map.set(binding.number, tool)
  }
  return map
})()

/** The first preferred key for a tool — used for tooltip hints. */
export function preferredKeyForTool(tool: Tool): string | null {
  const binding = TOOL_SHORTCUTS[tool]
  if (binding.letters.length > 0 && binding.letters[0] !== 'space') {
    return binding.letters[0].toUpperCase()
  }
  if (binding.letters[0] === 'space') return 'Space'
  return binding.number ?? null
}

/**
 * Resolve a `keydown` event to a tool, or `null` if the key isn't bound.
 *
 * Returns `null` when any modifier (Ctrl/Cmd/Alt) is held so browser
 * shortcuts like Cmd+G (DevTools focus) stay untouched. Shift is allowed
 * — it's our drawing constrain modifier, and tool selection with Shift
 * still switches the tool cleanly.
 *
 * The Space key is handled specially because it also scrolls the page
 * and is a hold-to-activate pan gesture in many editors. Callers should
 * treat `select` from Space as a momentary toggle.
 */
export function matchToolKey(e: KeyboardEvent): Tool | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  const key = e.key.toLowerCase()
  const tool = KEY_TO_TOOL.get(key)
  return tool ?? null
}

/**
 * Guard: should this keydown be ignored because the user is typing in an
 * input, textarea, contentEditable, an element marked
 * `data-shortcut-ignore`, or a widget that uses those keys itself
 * (slider, menu, list, tabs, dialog)? Mirrors the inline check that lived in
 * `create-grids.tsx` so all shortcuts can share one guard.
 */
export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.hasAttribute('data-shortcut-ignore')) return true
  // Widgets that use the arrow / letter keys themselves: arrows on a
  // focused slider must move the slider, not also nudge the selected
  // shape on the map; menus and lists navigate with them too.
  if (target.closest('[role="slider"],[role="spinbutton"],[role="combobox"],[role="listbox"],[role="menu"],[role="menuitem"],[role="radiogroup"],[role="tablist"],[role="dialog"]')) return true
  return false
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}

/** Display label for the platform's primary modifier key. */
export function modKeyLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl'
}

// ---- Cheatsheet data ------------------------------------------------------

export interface ShortcutRow {
  /** Visible key cap(s), e.g. `G`, `⇧+↑`, `⌘ Z`. */
  keys: string
  /** i18n key under `kb.*`. */
  labelKey: string
  /** English fallback shown when the locale lacks the key. */
  fallback: string
}

export interface ShortcutGroup {
  id: string
  /** i18n key under `kb.group.*`. */
  titleKey: string
  titleFallback: string
  rows: ShortcutRow[]
}

export const SHORTCUT_GROUPS: ReadonlyArray<ShortcutGroup> = [
  {
    id: 'tools',
    titleKey: 'kb.group.tools',
    titleFallback: 'Tools',
    rows: [
      { keys: 'V / H', labelKey: 'kb.toolPan', fallback: 'Pan' },
      { keys: 'Space', labelKey: 'kb.toolSelectHold', fallback: 'Hold for Select, release to go back' },
      { keys: 'Q', labelKey: 'kb.toolMarquee', fallback: 'Marquee select (drag rectangle)' },
      { keys: 'G', labelKey: 'kb.toolGrid', fallback: 'Racks / grid' },
      { keys: 'M', labelKey: 'kb.toolMarker', fallback: 'Marker' },
      { keys: 'C', labelKey: 'kb.toolCircle', fallback: 'Circle' },
      { keys: 'P', labelKey: 'kb.toolPolygon', fallback: 'Polygon' },
      { keys: 'L', labelKey: 'kb.toolLine', fallback: 'Line / aisle' },
      { keys: 'Y', labelKey: 'kb.toolRoute', fallback: 'Route / wayfinding path' },
      { keys: 'N', labelKey: 'kb.toolRoutePreview', fallback: 'Preview a route between two points' },
      { keys: 'U', labelKey: 'kb.toolMeasure', fallback: 'Measure distances and areas (keeps guides)' },
      { keys: 'I', labelKey: 'kb.toolImage', fallback: 'Image / floor plan' },
      { keys: 'B', labelKey: 'kb.toolModel', fallback: '3D model' },
      { keys: 'F', labelKey: 'kb.toolImagePlane', fallback: 'Image plane (when nothing is selected)' },
      { keys: 'T', labelKey: 'kb.toolText', fallback: 'Text label' },
      { keys: 'S', labelKey: 'kb.toolStair', fallback: 'Stair' },
      { keys: 'D', labelKey: 'kb.toolDoor', fallback: 'Door' },
      { keys: 'W', labelKey: 'kb.toolMagicWall', fallback: 'Magic walls (from areas)' },
      { keys: 'Z', labelKey: 'kb.toolZones', fallback: 'Facilities' },
      { keys: '1–0', labelKey: 'kb.toolNumberAlias', fallback: 'Number row mirrors tools' },
    ],
  },
  {
    id: 'drawing',
    titleKey: 'kb.group.drawing',
    titleFallback: 'Drawing',
    rows: [
      { keys: '⇧', labelKey: 'kb.drawConstrain', fallback: 'Constrain to square / 45° / perfect circle' },
      { keys: '⇧', labelKey: 'kb.drawAngleLock', fallback: 'Walls, polygons, measure: flip the angle lock while held' },
      { keys: '0–9 Enter', labelKey: 'kb.drawTypedLength', fallback: 'Type a length (3.5, 350cm, 12\'6) then Enter to place the next point' },
      { keys: '⌥', labelKey: 'kb.drawFromCenter', fallback: 'Draw outward from click point' },
      { keys: 'Enter', labelKey: 'kb.drawCommit', fallback: 'Finish polygon / line / stair' },
      { keys: 'Backspace', labelKey: 'kb.drawUndoVertex', fallback: 'Remove last vertex' },
      { keys: 'Esc', labelKey: 'kb.drawCancel', fallback: 'Cancel current draw' },
    ],
  },
  {
    id: 'transform',
    titleKey: 'kb.group.transform',
    titleFallback: 'Transform selected shape',
    rows: [
      { keys: '← → ↑ ↓', labelKey: 'kb.tMove', fallback: 'Move 1 step' },
      { keys: '⇧ + arrow', labelKey: 'kb.tMoveBig', fallback: 'Move 10 steps' },
      { keys: '[  ]', labelKey: 'kb.tRotate', fallback: 'Rotate ±1°' },
      { keys: '⇧ + [  ]', labelKey: 'kb.tRotateBig', fallback: 'Rotate ±15°' },
      { keys: '-  +', labelKey: 'kb.tScaleSelected', fallback: 'Scale down / up (with a selection)' },
      { keys: 'PgUp  PgDn', labelKey: 'kb.tElevation', fallback: 'Elevation up / down' },
      { keys: 'Enter', labelKey: 'kb.tCommit', fallback: 'Commit transform' },
      { keys: 'Esc', labelKey: 'kb.tCancel', fallback: 'Cancel transform' },
    ],
  },
  {
    id: 'selection',
    titleKey: 'kb.group.selection',
    titleFallback: 'Selection',
    rows: [
      { keys: 'Delete', labelKey: 'kb.delete', fallback: 'Delete selected' },
      { keys: '⌘ D', labelKey: 'kb.duplicate', fallback: 'Duplicate selected' },
      { keys: 'R', labelKey: 'kb.redraw', fallback: 'Redraw selected grid' },
      { keys: 'F', labelKey: 'kb.fit', fallback: 'Fit map to selection' },
      { keys: 'Esc', labelKey: 'kb.deselect', fallback: 'Deselect / cancel' },
    ],
  },
  {
    id: 'app',
    titleKey: 'kb.group.app',
    titleFallback: 'App',
    rows: [
      { keys: '⌘ Z', labelKey: 'kb.undo', fallback: 'Undo' },
      { keys: '⌘ ⇧ Z / ⌘ Y', labelKey: 'kb.redoBoth', fallback: 'Redo' },
      { keys: '⌘ E', labelKey: 'kb.export', fallback: 'Export GeoJSON' },
      { keys: '?', labelKey: 'kb.cheatsheet', fallback: 'Show / hide this cheatsheet' },
    ],
  },
]