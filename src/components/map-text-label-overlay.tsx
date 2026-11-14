/**
 * Text-label overlay. Renders saved + live-preview text annotations as
 * a native Mapbox `symbol` layer so we get every modern Mapbox text
 * effect for free:
 *
 *   - halo color / width / blur
 *   - emissive strength (the v3 lighting model "glow" path)
 *   - depth-occlusion (`text-occlusion-opacity`, v3.5+) so text disappears
 *     behind 3D buildings / models / racks like the world expects
 *   - billboard vs map-locked alignment (`text-pitch-alignment` +
 *     `text-rotation-alignment`)
 *   - per-feature altitude (`symbol-z-offset` + `symbol-elevation-reference`)
 *   - per-feature anchor / letter spacing / casing
 *
 * Architecture mirrors the line/polygon overlays: one source + one
 * symbol layer, with data-driven paint expressions reading per-feature
 * properties stamped by `text-label-generators.ts`.
 */

import {
  buildTextLabelFeatureCollection,
  buildTextLabelPreviewFeature,
  TEXT_FONT_STACKS,
  type TextLabelProps,
  type TextLabelStyleOverride,
} from '@/lib/text-label-generators'
import type {
  CircleShape,
  ImageShape,
  LineShape,
  PolygonShape,
  StairShape,
  TextLabelConfig,
  TextLabelShape,
} from '@/lib/shapes'
import {
  buildOccluders,
  createOcclusionState,
  updateOcclusion,
  type GridOccluderInput,
  type OccludableTarget,
  type OcclusionState,
} from '@/lib/marker-occlusion'
import {
  TRANSFORM_ICON,
  readThemePrimaryForegroundHex,
  readThemePrimaryHex,
  registerTransformHandleIcons,
  subscribeThemeChanges,
} from '@/lib/map-transform-handles'
import type { LayerFeaturePredicate } from '@/lib/empty-layer-gate'
import { GatedLayerHold, type GatedLayerSpec } from '@/components/map-line-overlay'
import {
  GHOST_OCCLUDED_OPACITY,
  NO_BLOCKERS,
  focusFactor,
  focusedIdOf,
  useFocusScene,
  type FocusScene,
} from '@/lib/focus/focus-scene'
import { useGraphicsSettings } from '@/lib/graphics-settings'
import type {
  GeoJSONSource,
  Map as MapboxMapInstance,
  MapMouseEvent,
} from 'mapbox-gl'
import { useEffect, useMemo, useRef, useState } from 'react'

interface MapTextLabelOverlayProps {
  map: MapboxMapInstance | null
  labels?: ReadonlyArray<TextLabelShape>
  /** Cursor lng/lat used to render the placement-preview "ghost" label. */
  liveCursor?: [number, number] | null
  /** Config for the placement preview. */
  liveConfig?: TextLabelConfig
  selectedLabelIds?: ReadonlySet<number>
  onLabelClick?: (id: number, originalEvent: MouseEvent) => void
  onMapClickEmpty?: () => void
  committedVisible?: boolean
  selectionEnabled?: boolean
  /**
   * Active interactive transform.
   *  - `move`   → drag the label itself.
   *  - `rotate` → drag an orange handle around the label centre; the
   *    label's `rotation` follows the drag angle.
   *  - `scale`  → drag the same handle radially; the label's `size`
   *    grows / shrinks with the distance from the centre.
   *
   * The first two follow the same UX as the image / polygon transforms.
   */
  transformState?: {
    textLabelId: number
    kind: 'move' | 'rotate' | 'scale'
  } | null
  onTransformChange?: (
    patch: {
      position?: [number, number]
      rotation?: number
      config?: TextLabelConfig
    },
    commit: boolean,
  ) => void
  /** Per-shape style overrides from the style-rules engine. */
  shapeStyleOverrides?: ReadonlyMap<number, TextLabelStyleOverride> | null
  /**
   * v5.4 — geometry the text-labels can hide behind. Same shape the
   * marker overlay accepts. When omitted, floor-plan occlusion is off
   * and labels always render regardless of camera angle — that's the
   * pre-v5.4 behaviour, and is what the editor's Create-Grids canvas
   * still wants (author-mode: always see every label).
   */
  occluders?: {
    images?: ReadonlyArray<ImageShape>
    polygons?: ReadonlyArray<PolygonShape>
    circles?: ReadonlyArray<CircleShape>
    lines?: ReadonlyArray<LineShape>
    stairs?: ReadonlyArray<StairShape>
    grids?: ReadonlyArray<GridOccluderInput>
  }
  /**
   * Master switch for the occlusion pass. Kept as a separate flag from
   * `occluders !== undefined` so a viewer setting can toggle it without
   * the host having to conditionally pass the props.
   */
  occlusionEnabled?: boolean
}

const TEXT_SOURCE = 'text-label-source'
const TRANSFORM_SOURCE = 'text-label-transform-source'
const TRANSFORM_LAYER = 'text-label-transform-layer'
const TRANSFORM_LAYER_HALO = 'text-label-transform-layer-halo'
// Drag handle radius in METERS — the orange dot sits this far from the
// label centre. Anchored in meters (not pixels) so it tracks the label
// at every zoom level.
const HANDLE_RADIUS_METERS = 8
/**
 * Mapbox rejects data expressions on `text-rotation-alignment` and
 * `text-pitch-alignment` (they're layout properties evaluated once per
 * layer). To still support per-feature billboard vs map-locked
 * orientation, we pre-create one symbol layer per alignment mode and
 * filter each feature into the matching layer by its `pitchAlignment`
 * property. Same trick the grid overlay uses for opacity buckets.
 */
const ALIGNMENTS = ['viewport', 'map'] as const
type AlignmentMode = (typeof ALIGNMENTS)[number]
const TEXT_LAYER_BASE = 'text-label-layer'
const SELECTION_LAYER_BASE = 'text-label-selection-layer'
/**
 * Focus mode's twin of the text layers: draws ONLY the focused label, with
 * collision off, so a focused label is never dropped by placement. The id
 * deliberately starts with `text-label-layer-`, which makes it a real
 * 'text' hit layer (overlay-hit-priority.ts) for the click handler, the
 * empty-click exit and the other overlays' priority checks.
 */
const FOCUS_LAYER_BASE = 'text-label-layer-focus'
const textLayerId = (m: AlignmentMode) => `${TEXT_LAYER_BASE}-${m}`
const selectionLayerId = (m: AlignmentMode) => `${SELECTION_LAYER_BASE}-${m}`
const focusLayerId = (m: AlignmentMode) => `${FOCUS_LAYER_BASE}-${m}`
/** Every layer that draws label text: the per-alignment layers and their focus twins. */
const TEXT_LAYER_IDS = [...ALIGNMENTS.map(textLayerId), ...ALIGNMENTS.map(focusLayerId)]
const SELECTION_LAYER_IDS = ALIGNMENTS.map(selectionLayerId)

// ---- Empty-layer gate predicates (lib/empty-layer-gate.ts) ----------------
// JS transcriptions of the per-alignment filters below, so the gate can hide
// a layer whose filter passes nothing — `text-label-layer-map` whenever every
// label is viewport-aligned (most facilities), and vice versa. Mapbox
// re-evaluates every visible layer each frame even when it draws nothing. Registered right after every `addLayer` /
// `setFilter` of the layer. Mapbox `get` reads a missing property as null,
// `coalesce` skips null, and `==` / `in` are strict, so `?.` + `??` + `===`
// match it value for value.

/** Text layer: `['==', ['coalesce', ['get', 'pitchAlignment'], 'viewport'], mode]`. */
export function textAlignmentPredicate(mode: AlignmentMode): LayerFeaturePredicate {
  return (f) => (f.properties?.pitchAlignment ?? 'viewport') === mode
}

/** Selection layer: the alignment test AND `['in', ['get', 'textLabelId'], ['literal', ids]]`. */
export function textSelectionPredicate(mode: AlignmentMode, ids: ReadonlyArray<number>): LayerFeaturePredicate {
  const selected = new Set<unknown>(ids)
  return (f) => {
    const p = f.properties
    return (p?.pitchAlignment ?? 'viewport') === mode && selected.has(p?.textLabelId)
  }
}

/**
 * Focus twin filter: the alignment test AND the one focused label.
 * `-1` (no focus) matches nothing — saved labels have positive ids and the
 * placement preview has none.
 */
export function textFocusFilter(mode: AlignmentMode, focusedId: number | null): unknown[] {
  return [
    'all',
    ['==', ['coalesce', ['get', 'pitchAlignment'], 'viewport'], mode],
    ['==', ['get', 'textLabelId'], focusedId ?? -1],
  ]
}

/** Focus twin predicate: JS mirror of `textFocusFilter(mode, focusedId)`. */
export function textFocusPredicate(mode: AlignmentMode, focusedId: number | null): LayerFeaturePredicate {
  const want = focusedId ?? -1
  return (f) => {
    const p = f.properties
    return (p?.pitchAlignment ?? 'viewport') === mode && p?.textLabelId === want
  }
}

// ---- Opacity expressions (occlusion / focus mode / ghosts) ----------------
// Built fresh per call: Mapbox deep-compares a new paint value against the
// current one, so rebuilding an unchanged expression is a no-op there.

/** Focus-mode multiplier: feature-state `focusScale` (FOCUS_FACTOR.near for a label in the NEAR column); unset → 1. */
function focusScaleExpr(): unknown[] {
  return ['coalesce', ['feature-state', 'focusScale'], 1]
}

/** The label's authored opacity, 0–1. */
function authoredTextOpacityExpr(): unknown[] {
  return ['/', ['coalesce', ['to-number', ['get', 'opacity']], 100], 100]
}

/**
 * `text-opacity` of the per-alignment text layers:
 *
 *   focusScale × case(focused → 0, occluded → 0 | ghost, authored)
 *
 * - `focused` (feature-state): the focused label is drawn by its twin
 *   (`text-label-layer-focus-*`), so the base copy hides — never drawn twice.
 *   The base copy still places, so every other label keeps its spot.
 * - `occluded` (feature-state, the analytic pass): 0, or with Graphics →
 *   "faint ghosts" on, GHOST_OCCLUDED_OPACITY of the authored opacity.
 * - `focusScale`: focus mode's near tier (a label right next to the focused
 *   item fades so it doesn't crowd it).
 *
 * With no feature-state written and ghosts off this evaluates to exactly the
 * pre-focus expression (`1 × x === x`).
 */
export function textLabelOpacityExpr(ghosts: boolean): unknown[] {
  return [
    '*',
    focusScaleExpr(),
    [
      'case',
      ['boolean', ['feature-state', 'focused'], false],
      0,
      ['boolean', ['feature-state', 'occluded'], false],
      ghosts ? ['*', GHOST_OCCLUDED_OPACITY, authoredTextOpacityExpr()] : 0,
      authoredTextOpacityExpr(),
    ],
  ]
}

/** `text-opacity` of the selection halo layers: same occlusion / focus folding, base 1. */
export function textSelectionOpacityExpr(ghosts: boolean): unknown[] {
  return [
    '*',
    focusScaleExpr(),
    ['case', ['boolean', ['feature-state', 'occluded'], false], ghosts ? GHOST_OCCLUDED_OPACITY : 0, 1],
  ]
}

/**
 * `text-opacity` of the focus twins (`text-label-layer-focus-*`):
 *
 *   case(focused → authored, 0)
 *
 * The exact complement of the base layers' `focused → 0` branch: the twin
 * shows the label exactly while its base copy is hidden, so the label is
 * never drawn twice and never missing (`focused` is written only once
 * TEXT_SOURCE re-tiled the twin's filter, and cleared on exit, which hides
 * the twin and shows the base copy in the same frame).
 *
 * It MUST read feature-state. TEXT_SOURCE carries feature-state (occluded /
 * focused / focusScale), and Mapbox GL 3.25's `Tile.updateBuckets` then hands
 * each bucket only its `stateDependentLayers`. A symbol layer with no
 * state-dependent paint gets an EMPTY list, and on a paint update / symbol
 * UBO update (an image registered, a transition, a palette or theme swap)
 * `SymbolBucket.update` reads `layers[0].paint` → "Cannot read properties of
 * undefined (reading 'paint')". Every symbol layer on a source this overlay
 * writes feature-state to needs at least one state-dependent paint property.
 */
export function textFocusTwinOpacityExpr(): unknown[] {
  return ['case', ['boolean', ['feature-state', 'focused'], false], authoredTextOpacityExpr(), 0]
}

/**
 * Per-label focus factors that aren't 1, as a value key (`id:factor,…`, ''
 * when none). Memos keyed on the key keep their identity while the faded
 * set is unchanged — a focus change that fades the same labels writes
 * nothing. Labels never occlude anything, so blockers don't apply: only the
 * labels in the focused item's NEAR column (`scene.near.textLabels`) fade,
 * to FOCUS_FACTOR.near; every other label keeps factor 1.
 */
function labelFocusFactorKey(scene: FocusScene, labels: ReadonlyArray<TextLabelShape> | undefined): string {
  if (!scene.active || !labels) return ''
  const parts: string[] = []
  for (const l of labels) {
    if (l.id === undefined) continue
    const f = focusFactor(scene, NO_BLOCKERS, 'text-labels', l.id)
    if (f !== 1) parts.push(`${l.id}:${f}`)
  }
  return parts.join(',')
}

const NO_FACTORS: ReadonlyMap<number, number> = new Map()

/** Inverse of `labelFocusFactorKey` (number → string → number round-trips exactly). */
function parseFactorKey(key: string): ReadonlyMap<number, number> {
  if (key === '') return NO_FACTORS
  const out = new Map<number, number>()
  for (const part of key.split(',')) {
    const i = part.indexOf(':')
    out.set(Number(part.slice(0, i)), Number(part.slice(i + 1)))
  }
  return out
}

/** Structural equality for the small paint / filter values compared before a write. */
function sameValue(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/** True once TEXT_SOURCE's tiles reflect its latest data and filters (or it is gone). */
function textSourceSettled(map: MapboxMapInstance): boolean {
  try {
    return !map.getSource(TEXT_SOURCE) || map.isSourceLoaded(TEXT_SOURCE)
  } catch {
    return true
  }
}

/**
 * The layers gated through GatedLayerHold (map-line-overlay.tsx): when a
 * label switches alignment, the layer it leaves is held visible until
 * TEXT_SOURCE re-tiles, so the label never drops out between the two.
 * Symbol layers cast no shadow. The focus twins are gated the same way:
 * empty (hidden) without a focused label, shown the moment one is set and
 * held until the source re-tiled when it clears.
 */
const TEXT_GATED_LAYERS: ReadonlyMap<string, GatedLayerSpec> = new Map<string, GatedLayerSpec>(
  [...TEXT_LAYER_IDS, ...SELECTION_LAYER_IDS].map((id) => [id, { sourceId: TEXT_SOURCE, castsShadows: false }] as const),
)

/**
 * v5.4 — zoom-dependent multiplier applied to the authored `size`.
 *
 *   • zoom ≥ 18 → 1.0×   (author's size lands as-authored on close view)
 *   • zoom = 16 → 0.65×
 *   • zoom = 14 → 0.4×
 *   • zoom ≤ 12 → 0.28×  (facility overview: labels shrink so they don't
 *                         dominate the map — but big enough to stay
 *                         readable, and small enough that collision
 *                         detection doesn't drop everything)
 *
 * The stop values MULTIPLY the per-feature `size` inside each stop
 * because Mapbox insists `zoom` be the top-level input to
 * `step`/`interpolate` — nesting the interpolate inside a `*` fails
 * validation with "zoom expression may only be used as input to a
 * top-level step or interpolate". Per-feature `size` still wins the
 * relative-scale contest between two labels at any given zoom — a 24px
 * label stays 1.5× bigger than a 16px label at every stop.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SIZE_INPUT: any = ['coalesce', ['to-number', ['get', 'size']], 14]
// Mapbox forbids `['zoom']` anywhere except as the top-level input to
// `interpolate` / `step`. So we branch INSIDE each stop with a `case`
// on `sizeMode`. Three branches:
//   'fixed'  → constant SIZE_INPUT (never scales with zoom).
//   'shape'  → 2× per zoom step around reference zoom 20, so the label
//              tracks its underlying shape (a room label doesn't
//              overflow when you zoom out).
//   default  → 'screen' — original curve, shrinks a bit at low zoom
//              so dense facilities don't become walls of text.
// Linear interpolation between exponential-computed stops is a decent
// approximation of true exponential — smooth enough at the zoom
// granularity users actually pan through.
const SHAPE_MULT = {
  10: 0.0009765625, // 2^-10
  12: 0.00390625,   // 2^-8
  14: 0.015625,     // 2^-6
  16: 0.0625,       // 2^-4
  18: 0.25,         // 2^-2
  20: 1.0,          // reference — authored px here
  22: 4.0,          // 2^+2
} as const
const stop = (zoom: keyof typeof SHAPE_MULT, screenMult: number) => [
  zoom,
  [
    'case',
    ['==', ['get', 'sizeMode'], 'fixed'], SIZE_INPUT,
    ['==', ['get', 'sizeMode'], 'shape'], ['*', SIZE_INPUT, SHAPE_MULT[zoom]],
    ['*', SIZE_INPUT, screenMult],
  ],
]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TEXT_SIZE_ZOOM_EXPR: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...stop(10, 0.20),
  ...stop(12, 0.28),
  ...stop(14, 0.4),
  ...stop(16, 0.65),
  ...stop(18, 1.0),
  ...stop(20, 1.0),
  ...stop(22, 1.0),
]

// Shared font expression. `text-font` accepts a data expression, but the
// output of each branch MUST be a `['literal', [...]]` — Mapbox can't
// validate raw `['get']` arrays as font stacks. Branches map the
// `fontWeight` property to a pre-defined Mapbox font stack.
const FONT_EXPR = [
  'match',
  ['get', 'fontWeight'],
  'bold', ['literal', [...TEXT_FONT_STACKS.bold]],
  'italic', ['literal', [...TEXT_FONT_STACKS.italic]],
  ['literal', [...TEXT_FONT_STACKS.regular]],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any

/**
 * Layout of a label text layer. `alwaysPlaced` false = the per-alignment
 * layers (collision on); true = the focus twin, which must draw the focused
 * label whatever it overlaps.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textLayerLayout(mode: AlignmentMode, alwaysPlaced: boolean): any {
  return {
    'text-field': ['coalesce', ['get', 'text'], ''],
    // v5.4 — zoom-stable size. Mapbox's `text-size` is pixels;
    // held constant it makes labels look larger and larger as the
    // user zooms out because the map content shrinks under them.
    // Scale the user's size DOWN below zoom 18 so labels stay
    // proportional to what's on the ground, and hold ~full size
    // at close zooms so authored-size still reads as authored.
    'text-size': TEXT_SIZE_ZOOM_EXPR,
    'text-font': FONT_EXPR,
    'text-anchor': ['coalesce', ['get', 'anchor'], 'center'],
    'text-letter-spacing': ['coalesce', ['get', 'letterSpacing'], 0],
    // v5.4 — let Mapbox de-conflict at zoom-out so a dense
    // facility isn't a wall of overlapping labels. Both flags
    // must be false: `text-allow-overlap: false` hides THIS
    // label when it would overlap an already-placed symbol;
    // `text-ignore-placement: false` makes THIS label reserve
    // pixels so later symbols de-conflict against it. `text-
    // padding: 4` widens the collision box so labels don't
    // just barely miss each other. The earlier revert to
    // `true/true` was because I'd wired the occluder bag with
    // multi-floor geometry — every label was disappearing for
    // an unrelated reason, and I mistakenly blamed collision.
    // With the occluder fix in place, collision is safe again.
    // The focus twin flips both: it draws one label, always, and
    // reserves nothing (the hidden base copy keeps its placement,
    // so the other labels stay exactly where they were).
    'text-allow-overlap': alwaysPlaced,
    'text-ignore-placement': alwaysPlaced,
    'text-padding': 4,
    // Bigger authored labels win the collision race. Mapbox
    // places lower-sort-key symbols first, so we NEGATE the
    // size so a 24pt label sorts BEFORE a 12pt label and
    // therefore claims its pixels first.
    'symbol-sort-key': ['*', -1, SIZE_INPUT],
    // Constants — Mapbox rejects data expressions on these two.
    'text-rotation-alignment': mode,
    'text-pitch-alignment': mode,
    'text-rotate': ['coalesce', ['get', 'rotation'], 0],
    'symbol-elevation-reference': 'sea',
    // Don't auto-snap to extrusion roofs — the user's explicit
    // `elevation` already places the label in 3D.
    'symbol-z-elevate': false,
  }
}

/** Paint of a label text layer; only `text-opacity` differs between the base layers and the focus twin. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textLayerPaint(textOpacity: unknown): any {
  return {
    'text-color': ['coalesce', ['get', 'color'], '#111827'],
    // v5.4 — fold analytic floor-plan occlusion into text-opacity.
    // `feature-state.occluded === true` → 0; otherwise the
    // authored per-feature opacity applies. This mirrors the
    // marker overlay's `data-occluded` DOM flag, but for symbol
    // layers where DOM CSS isn't available. Focus mode folds in
    // its own feature-state (see textLabelOpacityExpr).
    'text-opacity': textOpacity,
    'text-halo-color': ['coalesce', ['get', 'haloColor'], '#ffffff'],
    'text-halo-width': ['coalesce', ['to-number', ['get', 'haloWidth']], 0],
    'text-halo-blur': ['coalesce', ['to-number', ['get', 'haloBlur']], 0],
    // Per-feature altitude. `symbol-z-offset` is a PAINT property
    // (matches how the grid label layer does it).
    'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
    // Emissive strength keeps the text readable under the v3
    // lighting model. Driven per-feature so the "glow" preset can
    // crank it without affecting "subtle" labels.
    'text-emissive-strength': [
      'coalesce',
      ['to-number', ['get', 'emissive']],
      1,
    ],
    // v5.4 — force x-ray (1). The GL depth buffer was hiding
    // ground-floor labels (elevation: 0) behind 0.152m-tall
    // polygon slabs and 0.1m floor rasters in the viewer's
    // top-down view — a label at z=0 sits BELOW a slab at
    // z=0.152, so `text-occlusion-opacity: 0` treated them as
    // "behind 3D content" and painted them at opacity 0. On
    // tilt some labels then appeared because the depth test
    // was no longer against a slab.
    //
    // Our analytic occlusion pass (`feature-state.occluded → text-
    // opacity: 0` above) already covers the "walls block labels
    // on tilt" case correctly. Making this layer property a
    // constant 1 hands the responsibility entirely to the
    // analytic pass and stops the depth buffer from second-
    // guessing it. Per-feature `config.occlusionOpacity` is now
    // dead metadata — safe to remove in a later cleanup.
    'text-occlusion-opacity': 1,
  }
}

export function MapTextLabelOverlay({
  map,
  labels,
  liveCursor,
  liveConfig,
  selectedLabelIds,
  onLabelClick,
  onMapClickEmpty,
  committedVisible = true,
  selectionEnabled = true,
  transformState = null,
  onTransformChange,
  shapeStyleOverrides = null,
  occluders,
  occlusionEnabled = true,
}: MapTextLabelOverlayProps) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  // `styleGen` bumps on every style.load. Including it in every
  // effect's deps that consumes `styleLoaded` forces a clean re-mount
  // when the basemap swaps — Mapbox wipes user-added layers/sources on
  // swap and `styleLoaded` stays true across it, so the effects would
  // otherwise never re-run.
  const [styleGen, setStyleGen] = useState(0)

  // ---- Focus mode (view state from the host's FocusSceneContext) --------
  // Outside a provider the scene is FOCUS_OFF: no label is focused, every
  // factor is 1, and nothing below writes anything.
  const scene = useFocusScene()
  const focusedLabelId = focusedIdOf(scene, 'text-labels')
  const occlusionGhosts = useGraphicsSettings((s) => s.occlusionGhosts)

  // ---- Style readiness ---------------------------------------------------
  useEffect(() => {
    if (!map) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStyleLoaded(false)
      return
    }
    const setReady = () => {
      setStyleLoaded(true)
      setStyleGen((g) => g + 1)
    }
    if (map.isStyleLoaded()) {
      setReady()
      return
    }
    const interval = setInterval(() => {
      if (map.isStyleLoaded()) {
        setReady()
        clearInterval(interval)
      }
    }, 100)
    map.on('style.load', setReady)
    map.on('load', setReady)
    return () => {
      clearInterval(interval)
      map.off('style.load', setReady)
      map.off('load', setReady)
    }
  }, [map])

  // (Removed) Old URL-polling style-swap detector. The `style.load`
  // listener above now bumps `styleGen`; see notes in
  // `map-polygon-overlay.tsx`.

  // ---- Theme-tinted handle icons -----------------------------------------
  // Same pattern as image / polygon / line / grid overlays. See
  // `@/lib/map-transform-handles`. Text labels use a SINGLE handle
  // per action: rotate reads the angle, scale reads the distance,
  // move has no handle at all (dragging the text body itself).
  const [primaryHex, setPrimaryHex] = useState<string>(() =>
    readThemePrimaryHex(),
  )
  const [primaryFgHex, setPrimaryFgHex] = useState<string>(() =>
    readThemePrimaryForegroundHex(),
  )
  useEffect(() => {
    const refresh = () => {
      setPrimaryHex(readThemePrimaryHex())
      setPrimaryFgHex(readThemePrimaryForegroundHex())
    }
    refresh()
    return subscribeThemeChanges(refresh)
  }, [])
  useEffect(() => {
    if (!map || !styleLoaded) return
    registerTransformHandleIcons(map, primaryHex, primaryFgHex)
  }, [map, styleLoaded, styleGen, primaryHex, primaryFgHex])

  // ---- Data --------------------------------------------------------------
  const fc = useMemo(() => {
    const base = buildTextLabelFeatureCollection(labels ?? [], shapeStyleOverrides)
    if (liveCursor && liveConfig) {
      base.features.push(buildTextLabelPreviewFeature(liveCursor, liveConfig))
    }
    return base
  }, [labels, shapeStyleOverrides, liveCursor, liveConfig])

  // ---- Empty-layer gate --------------------------------------------------
  // Every gate predicate goes through this hold (GatedLayerHold).
  const gateHoldRef = useRef(new GatedLayerHold(TEXT_GATED_LAYERS))
  useEffect(() => {
    if (!map) return
    return gateHoldRef.current.attach(map)
  }, [map])

  // ---- Layer setup -------------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const gateHold = gateHoldRef.current
    // Installed with the current "faint ghosts" setting so the toggle
    // effect below has nothing to rewrite on mount.
    const ghosts = useGraphicsSettings.getState().occlusionGhosts
    try {
      if (!map.getSource(TEXT_SOURCE)) {
        map.addSource(TEXT_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          // v5.4 — expose `textLabelId` as the feature-state key so the
          // occlusion pass can `setFeatureState({id, occluded: true})`
          // without regenerating the whole FC on every camera move.
          promoteId: 'textLabelId',
        })
        gateHold.resetSource(TEXT_SOURCE)
      }

      // One symbol layer per alignment mode. Features route by their
      // stamped `pitchAlignment` property. Within each layer, every
      // other text effect (color, halo, emissive, occlusion, size,
      // anchor, letter-spacing, rotation) IS data-driven so multiple
      // labels of the same alignment mode coexist on the same layer.
      for (const mode of ALIGNMENTS) {
        const layerId = textLayerId(mode)
        if (map.getLayer(layerId)) continue
        map.addLayer({
          id: layerId,
          type: 'symbol',
          source: TEXT_SOURCE,
          filter: ['==', ['coalesce', ['get', 'pitchAlignment'], 'viewport'], mode],
          layout: textLayerLayout(mode, false),
          paint: textLayerPaint(textLabelOpacityExpr(ghosts)),
        })
        gateHold.register(map, layerId, textAlignmentPredicate(mode))
      }

      // Selection halo — one mirror per alignment mode. Wider halo,
      // transparent fill, filtered to the selected ids only.
      for (const mode of ALIGNMENTS) {
        const layerId = selectionLayerId(mode)
        if (map.getLayer(layerId)) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const layout: any = {
          'text-field': ['coalesce', ['get', 'text'], ''],
          'text-size': TEXT_SIZE_ZOOM_EXPR,
          'text-font': FONT_EXPR,
          'text-anchor': ['coalesce', ['get', 'anchor'], 'center'],
          'text-letter-spacing': ['coalesce', ['get', 'letterSpacing'], 0],
          // Selection halo must always draw for the selected label
          // even if the main layer got de-conflicted — otherwise you
          // can't see which label is selected at zoom-out.
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-rotation-alignment': mode,
          'text-pitch-alignment': mode,
          'text-rotate': ['coalesce', ['get', 'rotation'], 0],
          'symbol-elevation-reference': 'sea',
          'symbol-z-elevate': false,
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const paint: any = {
          // Transparent fill — the selection effect is just the
          // amber halo sitting behind the regular text-layer's
          // halo. Kept narrow (2 px) and soft so it reads as a
          // "selected" cue without dominating the label.
          'text-color': 'rgba(0,0,0,0)',
          'text-halo-color': '#fbbf24',
          'text-halo-width': 2,
          'text-halo-blur': 0.5,
          // Fade the selection halo along with the main label when
          // the label is occluded — otherwise a floor above would
          // reveal an orphan halo hovering over nothing. Focus mode
          // fades it with a near label (textSelectionOpacityExpr).
          'text-opacity': textSelectionOpacityExpr(ghosts),
          'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
          'text-emissive-strength': 1,
          // The focused label (feature-state `focused`, drawn x-ray by
          // its twin) keeps its halo in front of walls and slabs too;
          // everything else keeps the per-feature depth occlusion.
          'text-occlusion-opacity': [
            'case',
            ['boolean', ['feature-state', 'focused'], false],
            1,
            ['coalesce', ['to-number', ['get', 'occlusionOpacity']], 0],
          ],
        }
        map.addLayer({
          id: layerId,
          type: 'symbol',
          source: TEXT_SOURCE,
          filter: [
            'all',
            ['==', ['coalesce', ['get', 'pitchAlignment'], 'viewport'], mode],
            ['in', ['get', 'textLabelId'], ['literal', [-1]]],
          ],
          layout,
          paint,
        })
        gateHold.register(map, layerId, textSelectionPredicate(mode, [-1]))
      }

      // Focus twin — one per alignment mode (the alignments are layout
      // constants). Same layout / paint builders as the text layers, but
      // collision off and no occlusion / near folding: it draws only the
      // focused label (filter set by the focus effect below), on top of
      // everything in this overlay, whatever it overlaps or sits behind,
      // and only while that label's base copy is hidden (feature-state
      // `focused`, textFocusTwinOpacityExpr — which also keeps the layer
      // state-dependent, see there). Empty without a focus, so the gate
      // keeps it hidden.
      for (const mode of ALIGNMENTS) {
        const layerId = focusLayerId(mode)
        if (map.getLayer(layerId)) continue
        map.addLayer({
          id: layerId,
          type: 'symbol',
          source: TEXT_SOURCE,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filter: textFocusFilter(mode, null) as any,
          layout: textLayerLayout(mode, true),
          paint: textLayerPaint(textFocusTwinOpacityExpr()),
        })
        gateHold.register(map, layerId, textFocusPredicate(mode, null))
      }
    } catch (err) {
      console.warn('[MapTextLabelOverlay] setup failed', err)
    }

    return () => {
      for (const id of [...SELECTION_LAYER_IDS, ...TEXT_LAYER_IDS]) {
        try {
          if (map.getLayer(id)) map.removeLayer(id)
        } catch {
          /* ignore */
        }
      }
      try {
        if (map.getSource(TEXT_SOURCE)) map.removeSource(TEXT_SOURCE)
      } catch {
        /* ignore */
      }
    }
  }, [map, styleLoaded, styleGen])

  // ---- Push data ---------------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(TEXT_SOURCE) as GeoJSONSource | undefined
    if (src) {
      // Before setData, where the gate re-counts (GatedLayerHold).
      gateHoldRef.current.push(map, TEXT_SOURCE, fc)
      src.setData(fc as GeoJSON.FeatureCollection)
    }
  }, [map, styleLoaded, styleGen, fc])

  // ---- Graphics → "faint ghosts" -----------------------------------------
  // The occluded branch of the text / halo opacity: 0 (off, the default) or
  // GHOST_OCCLUDED_OPACITY. A data-driven paint swap re-lays out the source,
  // so it is written only when the live value differs — once per toggle;
  // never on mount (setup installs the current setting) or per camera move.
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const mode of ALIGNMENTS) {
      for (const [layerId, value] of [
        [textLayerId(mode), textLabelOpacityExpr(occlusionGhosts)],
        [selectionLayerId(mode), textSelectionOpacityExpr(occlusionGhosts)],
      ] as const) {
        try {
          if (!map.getLayer(layerId)) continue
          if (sameValue(map.getPaintProperty(layerId, 'text-opacity'), value)) continue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map.setPaintProperty(layerId, 'text-opacity', value as any)
        } catch { /* style torn down */ }
      }
    }
  }, [map, styleLoaded, styleGen, occlusionGhosts])

  // ---- Occlusion ---------------------------------------------------------
  //
  // Same solver as the marker overlay: for each label, clip the
  // camera → label segment to every occluder prism's altitude slab and
  // ask whether the surviving span crosses the footprint. Occluders
  // include everything the editor's text-draw layer uses — images
  // (floor plates above), plus polygons / lines / stairs / circles
  // (walls and 3D geometry the label would sit behind at a tilt).
  //
  // The "embedded in solid" skip in `computeOccludedIds`
  // (`marker-occlusion.ts`) uses `>=` on `baseM` so a label at
  // `elevation: 0` sitting on the floor of a room whose polygon
  // extrudes from 0m is correctly recognised as INSIDE that room
  // (not occluded by its own room). Adjacent rooms + walls the
  // camera segment crosses on the way in still occlude, matching
  // the 3D behaviour a viewer expects on tilt.
  //
  // Runs on every `move` because occlusion is a function of the
  // camera, not of the data. Only the ids whose state flipped are
  // written: every `setFeatureState` makes Mapbox refresh the source's
  // tiles and re-upload their paint arrays, even for an unchanged value.
  const occludeImages = occluders?.images
  const occludePolygons = occluders?.polygons
  const occludeCircles = occluders?.circles
  const occludeLines = occluders?.lines
  const occludeStairs = occluders?.stairs
  const occludeGrids = occluders?.grids
  const prisms = useMemo(
    () =>
      occlusionEnabled
        ? buildOccluders({
            images: occludeImages,
            polygons: occludePolygons,
            circles: occludeCircles,
            lines: occludeLines,
            stairs: occludeStairs,
            grids: occludeGrids,
          })
        : [],
    [
      occlusionEnabled,
      occludeImages,
      occludePolygons,
      occludeCircles,
      occludeLines,
      occludeStairs,
      occludeGrids,
    ],
  )
  // One target per label, built once per `labels` change (and projected
  // once inside `updateOcclusion`) rather than on every camera move.
  // The focused label is left out: focus mode never hides it. Dropping it
  // from the targets makes the next pass report it in `left`, so the
  // effect below clears its `occluded` flag with the usual flip write.
  const occlusionTargets = useMemo(() => {
    const targets: OccludableTarget[] = []
    for (const l of labels ?? []) {
      if (l.id === undefined) continue
      if (l.id === focusedLabelId) continue
      targets.push({
        id: l.id,
        position: l.position,
        elevationM: l.config.elevation ?? 0,
        floorPlanId: l.floorPlanId,
      })
    }
    return targets
  }, [labels, focusedLabelId])
  // What TEXT_SOURCE's feature-state says, tied to the source instance it
  // was written to. Kept across re-subscriptions (a label edit, a floor
  // toggle) so they write only what flipped. A NEW source starts with no
  // feature-state — basemap swap, StrictMode remount, HMR — and is
  // detected by identity, so the next pass writes every occluded id again
  // instead of trusting writes that went to the old one.
  const occlusionRef = useRef<{ source: unknown; state: OcclusionState } | null>(null)
  useEffect(() => {
    if (!map || !styleLoaded) return
    // Hidden layers draw nothing (the selection halo is gated on
    // `committedVisible` too), so the pass can wait: it re-runs when they
    // show again and diffs against what the source still holds.
    if (!committedVisible) return
    const sync = () => {
      const source = map.getSource(TEXT_SOURCE)
      // Mid style swap: nothing to write to. The re-created source is
      // picked up below on the next pass.
      if (!source) return
      let o = occlusionRef.current
      if (!o || o.source !== source) {
        o = { source, state: createOcclusionState() }
        occlusionRef.current = o
      }
      const { entered, left } = updateOcclusion(map, occlusionTargets, prisms, o.state)
      // `setFeatureState` needs the source name + feature id — the
      // source's `promoteId: 'textLabelId'` maps
      // `properties.textLabelId` to the id key. Feature-state survives
      // `setData` on the same source, so a label edit keeps it.
      for (const id of left) {
        try {
          map.setFeatureState({ source: TEXT_SOURCE, id }, { occluded: false })
        } catch { /* source went away */ }
      }
      for (const id of entered) {
        try {
          map.setFeatureState({ source: TEXT_SOURCE, id }, { occluded: true })
        } catch { /* source went away */ }
      }
    }
    sync()
    // Nothing to hide (no occluders — the editor's author mode — or no
    // labels): the result can't depend on the camera.
    if (occlusionTargets.length === 0 || prisms.length === 0) return
    map.on('move', sync)
    return () => {
      map.off('move', sync)
    }
  }, [map, styleLoaded, styleGen, occlusionTargets, prisms, committedVisible])

  // ---- Focus mode: the twin layers --------------------------------------
  // Point the twins at the focused label (or at nothing). Runs once per
  // focus change; `setFilter` re-tiles TEXT_SOURCE, so it is skipped when
  // the live filter already matches (mount, style swap with no focus). The
  // predicate is re-registered in the same pass (GatedLayerHold: show now,
  // hide only once the source re-tiled).
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const mode of ALIGNMENTS) {
      const layerId = focusLayerId(mode)
      try {
        if (!map.getLayer(layerId)) continue
        const filter = textFocusFilter(mode, focusedLabelId)
        if (sameValue(map.getFilter(layerId), filter)) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setFilter(layerId, filter as any)
        gateHoldRef.current.register(map, layerId, textFocusPredicate(mode, focusedLabelId))
      } catch { /* style torn down */ }
    }
  }, [map, styleLoaded, styleGen, focusedLabelId])

  // ---- Focus mode: near tier + handing the label to the twin -----------
  // `focusScale` (FOCUS_FACTOR.near) on every label in the focused item's
  // NEAR column; written from the scene, never from the camera, and only
  // for ids whose value changed. Tracked per TEXT_SOURCE instance like the
  // occlusion state: a re-created source starts clean and gets every value
  // written again.
  //
  // `focused` hides the base copy of the label and shows it on the twin
  // (textFocusTwinOpacityExpr is its complement). It is written only once
  // TEXT_SOURCE has re-tiled the twin's new filter — hiding the base copy
  // sooner would blank the label for the worker round trip. On exit /
  // change the old label is un-focused at once: the base copy shows and the
  // twin's (old-filter) copy hides in the same frame.
  const labelFactorKey = useMemo(() => labelFocusFactorKey(scene, labels), [scene, labels])
  const labelFactors = useMemo(() => parseFactorKey(labelFactorKey), [labelFactorKey])
  const focusWriteRef = useRef<{
    source: unknown
    scales: ReadonlyMap<number, number>
    hidden: number | null
  } | null>(null)
  useEffect(() => {
    if (!map || !styleLoaded) return
    const source = map.getSource(TEXT_SOURCE)
    if (!source) return
    let w = focusWriteRef.current
    if (!w || w.source !== source) {
      w = { source, scales: NO_FACTORS, hidden: null }
      focusWriteRef.current = w
    }
    const written = w
    const write = (id: number, state: Record<string, unknown>) => {
      try {
        map.setFeatureState({ source: TEXT_SOURCE, id }, state)
      } catch { /* source went away */ }
    }
    if (written.scales !== labelFactors) {
      for (const id of written.scales.keys()) {
        if (!labelFactors.has(id)) write(id, { focusScale: 1 })
      }
      for (const [id, factor] of labelFactors) {
        if (written.scales.get(id) !== factor) write(id, { focusScale: factor })
      }
      written.scales = labelFactors
    }
    if (written.hidden !== null && written.hidden !== focusedLabelId) {
      write(written.hidden, { focused: false })
      written.hidden = null
    }
    if (focusedLabelId === null || written.hidden === focusedLabelId) return
    const id = focusedLabelId
    const onRender = () => {
      if (!textSourceSettled(map)) return
      map.off('render', onRender)
      write(id, { focused: true })
      written.hidden = id
    }
    map.on('render', onRender)
    // A frame is due anyway after a filter / data change; this covers a
    // re-run with neither (the scales changed while waiting).
    map.triggerRepaint()
    return () => {
      map.off('render', onRender)
    }
  }, [map, styleLoaded, styleGen, labelFactors, focusedLabelId])

  // ---- Selection filter --------------------------------------------------
  // We belt-and-suspenders this: when nothing is selected, set both
  // the filter to a no-match sentinel AND flip the layer to
  // `visibility: 'none'`. The visibility toggle is the reliable
  // signal — depending on the Mapbox version, a freshly-changed
  // `setFilter` can still draw one frame of stale features before
  // the next paint cycle, which the user perceives as "the selection
  // halo lingered after I clicked away".
  useEffect(() => {
    if (!map || !styleLoaded) return
    const hasSelection = !!(selectedLabelIds && selectedLabelIds.size > 0)
    const ids = hasSelection ? [...(selectedLabelIds as ReadonlySet<number>)] : [-1]
    for (const mode of ALIGNMENTS) {
      const layerId = selectionLayerId(mode)
      if (!map.getLayer(layerId)) continue
      try {
        map.setFilter(layerId, [
          'all',
          ['==', ['coalesce', ['get', 'pitchAlignment'], 'viewport'], mode],
          ['in', ['get', 'textLabelId'], ['literal', ids]],
        ])
        gateHoldRef.current.register(map, layerId, textSelectionPredicate(mode, ids))
        // Selection layers are gated on BOTH the selection state and
        // the master `committedVisible` toggle, so we re-compute the
        // composite here rather than letting the visibility effect
        // below override us.
        map.setLayoutProperty(
          layerId,
          'visibility',
          hasSelection && committedVisible ? 'visible' : 'none',
        )
      } catch {
        /* ignore — style may have torn down */
      }
    }
  }, [map, styleLoaded, styleGen, selectedLabelIds, committedVisible])

  // ---- Visibility toggle -------------------------------------------------
  // The text layers track `committedVisible` directly; selection
  // layers are handled by the effect above (it also reads
  // `committedVisible`) so we don't fight it here.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const vis = committedVisible ? 'visible' : 'none'
    for (const id of TEXT_LAYER_IDS) {
      try {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis)
      } catch {
        /* ignore */
      }
    }
  }, [map, styleLoaded, styleGen, committedVisible])

  // Push the theme primary hex into the selection halo colour on
  // every selection layer (one per alignment mode). The selection
  // effect for text labels is a coloured halo behind the glyph
  // rather than a fill/outline, so `text-halo-color` is the right
  // paint prop. Retints live on palette / mode swaps.
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const mode of ALIGNMENTS) {
      const layerId = selectionLayerId(mode)
      try {
        if (map.getLayer(layerId)) {
          map.setPaintProperty(layerId, 'text-halo-color', primaryHex)
        }
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, styleGen, primaryHex])

  // Keep the transform handle at the top of the layer stack so
  // late-added overlays can't shove above. Only while a transform is
  // active: with none, the handle source is empty and its place in the
  // stack can't show, while `moveLayer` (even onto the top it already
  // holds) flags a layer re-order — on every label edit and selection
  // click otherwise. It runs again when a transform starts.
  useEffect(() => {
    if (!map || !styleLoaded || !transformState) return
    try {
      if (map.getLayer(TRANSFORM_LAYER)) map.moveLayer(TRANSFORM_LAYER)
    } catch { /* ignore */ }
  }, [map, styleLoaded, styleGen, labels, selectedLabelIds, transformState])

  // ---- Click handling ----------------------------------------------------
  // Text labels are tiny glyph footprints, so Mapbox's per-layer click
  // (which uses the actual rendered glyph bounds as the hit-test
  // surface) leaves the user chasing pixels. Replace it with a manual
  // global click + a HIT_BUFFER bbox query so anywhere within ~8 px
  // of the label still registers as a selection — same pattern the
  // stair / polygon / door overlays use.
  const HIT_BUFFER = 8
  useEffect(() => {
    if (!map || !styleLoaded || !selectionEnabled) return
    const presentLayers = () =>
      TEXT_LAYER_IDS.filter((id) => map.getLayer(id))

    const onClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      if (e.originalEvent?.defaultPrevented) return
      const layers = presentLayers()
      if (layers.length === 0) return
      const bbox: [[number, number], [number, number]] = [
        [e.point.x - HIT_BUFFER, e.point.y - HIT_BUFFER],
        [e.point.x + HIT_BUFFER, e.point.y + HIT_BUFFER],
      ]
      let hits: GeoJSON.Feature[]
      try {
        hits = map.queryRenderedFeatures(bbox, { layers })
      } catch {
        return
      }
      if (hits.length === 0) {
        onMapClickEmpty?.()
        return
      }
      const id = (hits[0].properties as Partial<TextLabelProps> | undefined)
        ?.textLabelId
      if (typeof id !== 'number') return
      e.preventDefault()
      e.originalEvent?.preventDefault?.()
      onLabelClick?.(id, e.originalEvent as MouseEvent)
    }

    const onMove = (e: MapMouseEvent) => {
      // Mid drag-pan / drag-orbit (button held while the camera moves)
      // the pointer is busy dragging the map, not hovering a label, so
      // skip the hit-test that would otherwise run on every drag frame.
      // The cursor keeps its pre-drag value until the next plain
      // mousemove after the drag refreshes it.
      if ((e.originalEvent as MouseEvent | undefined)?.buttons && map.isMoving()) return
      const layers = presentLayers()
      if (layers.length === 0) return
      const bbox: [[number, number], [number, number]] = [
        [e.point.x - HIT_BUFFER, e.point.y - HIT_BUFFER],
        [e.point.x + HIT_BUFFER, e.point.y + HIT_BUFFER],
      ]
      let hits: GeoJSON.Feature[] = []
      try {
        hits = map.queryRenderedFeatures(bbox, { layers })
      } catch {
        /* ignore */
      }
      // Don't override crosshair cursor (draw modes).
      if (map.getCanvas().style.cursor === 'crosshair') return
      map.getCanvas().style.cursor = hits.length > 0 ? 'pointer' : ''
    }

    map.on('click', onClick)
    map.on('mousemove', onMove)
    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
    }
  }, [map, styleLoaded, styleGen, selectionEnabled, onLabelClick, onMapClickEmpty])

  // ---- Transform handle (move / rotate / scale) -------------------------
  // Move    → drag the text body itself; no handle rendered.
  // Rotate  → orange dot sits HANDLE_RADIUS_METERS east of the label;
  //           drag it around the label to spin it. The shape's
  //           `rotation` field is the source of truth — Mapbox's
  //           `text-rotate` reads it per-feature.
  // Scale   → same orange dot; dragging away/toward the centre grows
  //           or shrinks the text by the same factor (size = baseline
  //           × distance ratio). Matches the image overlay's UX.
  const transformChangeRef = useRef(onTransformChange)
  useEffect(() => {
    transformChangeRef.current = onTransformChange
  }, [onTransformChange])

  // Mount the handle source + layer once (reused across move/rotate/scale).
  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!map.getSource(TRANSFORM_SOURCE)) {
      try {
        map.addSource(TRANSFORM_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      } catch (err) {
        console.warn('[text-label-overlay] transform source failed', err)
        return
      }
    }
    // HMR safety: force-remove the old circle-typed halo + main
    // layers if they survived from a previous build. Without this,
    // the guarded `if (!getLayer)` below skips re-add and users keep
    // seeing the pre-refresh amber circles.
    const existingHalo = map.getStyle()?.layers?.find(
      (l) => l.id === TRANSFORM_LAYER_HALO,
    ) as { type?: string } | undefined
    if (existingHalo) {
      try { map.removeLayer(TRANSFORM_LAYER_HALO) } catch { /* ignore */ }
    }
    const existingMain = map.getStyle()?.layers?.find(
      (l) => l.id === TRANSFORM_LAYER,
    ) as { type?: string } | undefined
    if (existingMain && existingMain.type !== 'symbol') {
      try { map.removeLayer(TRANSFORM_LAYER) } catch { /* ignore */ }
    }
    // Single symbol layer — theme-tinted canvas icon (rotate curl or
    // scale double-arrow, picked per feature via `iconId`). z-elevate
    // false + z-offset from the label's elevation lifts the handle to
    // the same altitude as the label glyph. Text labels have no
    // extrusion height so `symbol-z-offset = elevation` (no `+ height`).
    if (!map.getLayer(TRANSFORM_LAYER)) {
      try {
        const transformLayerDef = {
          id: TRANSFORM_LAYER,
          type: 'symbol',
          source: TRANSFORM_SOURCE,
          layout: {
            'icon-image': [
              'coalesce',
              ['get', 'iconId'],
              TRANSFORM_ICON.rotate,
            ],
            'icon-size': 1,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            // Rotate icon curl follows the label's own rotation so
            // the curl always faces outward from the label centre.
            // Scale icon stays screen-space (its diagonal arrows
            // convey "grow me" regardless of label orientation).
            'icon-rotate': [
              'match',
              ['get', 'kind'],
              'rotate',
              ['coalesce', ['to-number', ['get', 'imageRotation']], 0],
              0,
            ],
            'symbol-z-elevate': false,
            'symbol-elevation-reference': 'sea',
          },
          paint: {
            'icon-emissive-strength': 1,
            'symbol-z-offset': [
              'coalesce',
              ['to-number', ['get', 'elevation']],
              0,
            ],
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any
        map.addLayer(transformLayerDef)
      } catch (err) {
        console.warn('[text-label-overlay] handle layer failed', err)
      }
    }
    return () => {
      // Cleanup runs only when the overlay unmounts — not on every
      // transformState change — so the layer stays mounted while the
      // user toggles between Move / Rotate / Scale.
    }
  }, [map, styleLoaded, styleGen])

  // Resolve the currently-targeted label + its centre + the handle
  // position. Handle sits HANDLE_RADIUS_METERS east of the label by
  // default; rotate/scale drags read its CURRENT position out of the
  // shape's rotation so the handle tracks the label after a drag.
  const METERS_PER_DEG_LAT = 111_320
  const transformContext = useMemo(() => {
    if (!transformState) return null
    const lbl = labels?.find((l) => l.id === transformState.textLabelId)
    if (!lbl) return null
    const centre = lbl.position
    if (transformState.kind === 'move') {
      return { label: lbl, centre, anchor: centre }
    }
    const rotRad = ((lbl.rotation ?? 0) * Math.PI) / 180
    const midLat = centre[1]
    const dxM = HANDLE_RADIUS_METERS * Math.sin(rotRad)
    const dyM = HANDLE_RADIUS_METERS * Math.cos(rotRad)
    const dLng = dxM / (METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180))
    const dLat = dyM / METERS_PER_DEG_LAT
    const anchor: [number, number] = [centre[0] + dLng, centre[1] + dLat]
    return { label: lbl, centre, anchor }
  }, [transformState, labels])

  // Push handle position into the transform source. For move, the
  // handle sits at the label's centre (anchor point); for rotate /
  // scale it sits at the offset anchor computed in transformContext.
  useEffect(() => {
    if (!map || !styleLoaded) return
    const src = map.getSource(TRANSFORM_SOURCE) as GeoJSONSource | undefined
    if (!src) return
    if (!transformContext || !transformState) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    // Stamp iconId (picks the move cross / rotate curl / scale double-
    // arrow), the label's own rotation (so the rotate curl faces
    // outward), and elevation (so the symbol lifts to the label's
    // altitude).
    const lbl = transformContext.label
    const kind = transformState.kind
    // Move handle sits at the label's centre — it's the geometric
    // representation of "here's the label, drag me". Rotate + scale
    // handles sit at the offset anchor (~8 m east, tracks rotation).
    const coordinates =
      kind === 'move' ? transformContext.centre : transformContext.anchor
    src.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates },
          properties: {
            kind,
            iconId: TRANSFORM_ICON[kind],
            imageRotation: lbl.rotation ?? 0,
            elevation: lbl.config.elevation ?? 0,
          },
        },
      ],
    })
  }, [map, styleLoaded, styleGen, transformContext, transformState])

  const dragRef = useRef<{
    dragging: boolean
    originalRotation: number
    originalSize: number
    originalAnchorAngle: number
    originalAnchorDist: number
    originalCentre: [number, number] | null
  }>({
    dragging: false,
    originalRotation: 0,
    originalSize: 14,
    originalAnchorAngle: 0,
    originalAnchorDist: 0,
    originalCentre: null,
  })

  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!transformState) return

    const canvas = map.getCanvas()
    canvas.style.cursor =
      transformState.kind === 'rotate'
        ? 'crosshair'
        : transformState.kind === 'scale'
          ? 'nwse-resize'
          : 'grab'

    const drag = dragRef.current

    const onDown = (e: MapMouseEvent) => {
      if (transformState.kind === 'move') {
        // Grab either the move handle (the visible 4-way cross at
        // the label's anchor) OR the label glyphs themselves — both
        // start the same drag. Handle takes priority since it's a
        // clearer affordance.
        if (map.getLayer(TRANSFORM_LAYER)) {
          const handleHits = map.queryRenderedFeatures(e.point, {
            layers: [TRANSFORM_LAYER],
          })
          if (handleHits.length > 0) {
            drag.dragging = true
            canvas.style.cursor = 'grabbing'
            map.dragPan.disable()
            e.preventDefault?.()
            return
          }
        }
        // Hit-test the label glyphs (use the same HIT_BUFFER bbox so
        // the user can grab from a few pixels off the text).
        const layers = TEXT_LAYER_IDS.filter((id) => map.getLayer(id))
        if (layers.length === 0) return
        const bbox: [[number, number], [number, number]] = [
          [e.point.x - HIT_BUFFER, e.point.y - HIT_BUFFER],
          [e.point.x + HIT_BUFFER, e.point.y + HIT_BUFFER],
        ]
        let hits: GeoJSON.Feature[]
        try {
          hits = map.queryRenderedFeatures(bbox, { layers })
        } catch {
          return
        }
        const hit = hits.find(
          (f) =>
            (f.properties as Partial<TextLabelProps> | undefined)
              ?.textLabelId === transformState.textLabelId,
        )
        if (!hit) return
        drag.dragging = true
        canvas.style.cursor = 'grabbing'
        map.dragPan.disable()
        e.preventDefault?.()
        return
      }

      // Rotate / Scale: hit-test the orange handle.
      if (!map.getLayer(TRANSFORM_LAYER)) return
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [TRANSFORM_LAYER],
      })
      if (hits.length === 0) return
      const ctx = transformContext
      if (!ctx) return
      drag.dragging = true
      drag.originalCentre = ctx.centre
      drag.originalRotation = ctx.label.rotation ?? 0
      drag.originalSize = ctx.label.config.size ?? 14
      // Cache the start angle + distance so the drag is idempotent
      // (matches the image overlay's pattern).
      const midLat = ctx.centre[1]
      const cosLat = Math.cos((midLat * Math.PI) / 180)
      const dxM = (ctx.anchor[0] - ctx.centre[0]) * METERS_PER_DEG_LAT * cosLat
      const dyM = (ctx.anchor[1] - ctx.centre[1]) * METERS_PER_DEG_LAT
      drag.originalAnchorAngle = Math.atan2(dxM, dyM)
      drag.originalAnchorDist = Math.hypot(dxM, dyM)
      map.dragPan.disable()
      e.preventDefault?.()
    }

    const onMove = (e: MapMouseEvent) => {
      if (!drag.dragging) return
      if (transformState.kind === 'move') {
        transformChangeRef.current?.(
          { position: [e.lngLat.lng, e.lngLat.lat] },
          false,
        )
        return
      }
      const centre = drag.originalCentre
      if (!centre) return
      const midLat = centre[1]
      const cosLat = Math.cos((midLat * Math.PI) / 180)
      const dxM = (e.lngLat.lng - centre[0]) * METERS_PER_DEG_LAT * cosLat
      const dyM = (e.lngLat.lat - centre[1]) * METERS_PER_DEG_LAT
      if (transformState.kind === 'rotate') {
        const newAngle = Math.atan2(dxM, dyM)
        const deltaDeg =
          ((newAngle - drag.originalAnchorAngle) * 180) / Math.PI
        let next = drag.originalRotation + deltaDeg
        while (next > 180) next -= 360
        while (next < -180) next += 360
        transformChangeRef.current?.({ rotation: next }, false)
        return
      }
      // scale
      const newDist = Math.hypot(dxM, dyM)
      if (drag.originalAnchorDist < 1e-6) return
      const factor = newDist / drag.originalAnchorDist
      const nextSize = Math.max(
        6,
        Math.min(200, drag.originalSize * factor),
      )
      transformChangeRef.current?.(
        { config: { ...transformContext!.label.config, size: nextSize } },
        false,
      )
    }

    const onUp = (e: MapMouseEvent) => {
      if (!drag.dragging) return
      drag.dragging = false
      map.dragPan.enable()
      canvas.style.cursor =
        transformState.kind === 'rotate'
          ? 'crosshair'
          : transformState.kind === 'scale'
            ? 'nwse-resize'
            : 'grab'
      if (transformState.kind === 'move') {
        transformChangeRef.current?.(
          { position: [e.lngLat.lng, e.lngLat.lat] },
          true,
        )
      } else {
        // Commit by sending the last live patch with commit=true so
        // the host's debounce knows to flush.
        transformChangeRef.current?.({}, true)
      }
    }

    const onEnter = () => {
      if (!drag.dragging) {
        canvas.style.cursor =
          transformState.kind === 'rotate'
            ? 'crosshair'
            : transformState.kind === 'scale'
              ? 'nwse-resize'
              : 'grab'
      }
    }
    const onLeave = () => {
      if (!drag.dragging) canvas.style.cursor = ''
    }

    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    map.on('mouseup', onUp)
    if (transformState.kind !== 'move') {
      map.on('mouseenter', TRANSFORM_LAYER, onEnter)
      map.on('mouseleave', TRANSFORM_LAYER, onLeave)
    }
    return () => {
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      map.off('mouseup', onUp)
      if (transformState.kind !== 'move') {
        map.off('mouseenter', TRANSFORM_LAYER, onEnter)
        map.off('mouseleave', TRANSFORM_LAYER, onLeave)
      }
      map.dragPan.enable()
      canvas.style.cursor = ''
    }
  }, [map, styleLoaded, styleGen, transformState, transformContext])

  return null
}
