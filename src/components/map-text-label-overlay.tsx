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
  computeOccludedIds,
  type GridOccluderInput,
  type OccludableTarget,
} from '@/lib/marker-occlusion'
import {
  TRANSFORM_ICON,
  readThemePrimaryForegroundHex,
  readThemePrimaryHex,
  registerTransformHandleIcons,
  subscribeThemeChanges,
} from '@/lib/map-transform-handles'
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
const textLayerId = (m: AlignmentMode) => `${TEXT_LAYER_BASE}-${m}`
const selectionLayerId = (m: AlignmentMode) => `${SELECTION_LAYER_BASE}-${m}`
const TEXT_LAYER_IDS = ALIGNMENTS.map(textLayerId)
const SELECTION_LAYER_IDS = ALIGNMENTS.map(selectionLayerId)

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

  // ---- Layer setup -------------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
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
      }

      // One symbol layer per alignment mode. Features route by their
      // stamped `pitchAlignment` property. Within each layer, every
      // other text effect (color, halo, emissive, occlusion, size,
      // anchor, letter-spacing, rotation) IS data-driven so multiple
      // labels of the same alignment mode coexist on the same layer.
      for (const mode of ALIGNMENTS) {
        const layerId = textLayerId(mode)
        if (map.getLayer(layerId)) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const layout: any = {
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
          'text-allow-overlap': false,
          'text-ignore-placement': false,
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const paint: any = {
          'text-color': ['coalesce', ['get', 'color'], '#111827'],
          // v5.4 — fold analytic floor-plan occlusion into text-opacity.
          // `feature-state.occluded === true` → 0; otherwise the
          // authored per-feature opacity applies. This mirrors the
          // marker overlay's `data-occluded` DOM flag, but for symbol
          // layers where DOM CSS isn't available.
          'text-opacity': [
            'case',
            ['boolean', ['feature-state', 'occluded'], false],
            0,
            ['/', ['coalesce', ['to-number', ['get', 'opacity']], 100], 100],
          ],
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
        map.addLayer({
          id: layerId,
          type: 'symbol',
          source: TEXT_SOURCE,
          filter: ['==', ['coalesce', ['get', 'pitchAlignment'], 'viewport'], mode],
          layout,
          paint,
        })
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
          // reveal an orphan halo hovering over nothing.
          'text-opacity': [
            'case',
            ['boolean', ['feature-state', 'occluded'], false],
            0,
            1,
          ],
          'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
          'text-emissive-strength': 1,
          'text-occlusion-opacity': [
            'coalesce',
            ['to-number', ['get', 'occlusionOpacity']],
            0,
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
    if (src) src.setData(fc as GeoJSON.FeatureCollection)
  }, [map, styleLoaded, styleGen, fc])

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
  // camera, not of the data.
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
  const occludedIdsRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (!map || !styleLoaded) return
    const targets: OccludableTarget[] = []
    for (const l of labels ?? []) {
      if (l.id === undefined) continue
      targets.push({
        id: l.id,
        position: l.position,
        elevationM: l.config.elevation ?? 0,
        floorPlanId: l.floorPlanId,
      })
    }
    const apply = () => {
      const nextOccluded = computeOccludedIds(map, targets, prisms)
      const prev = occludedIdsRef.current
      // Clear the state of anything that just left the occluded set,
      // set state for anything that just joined. `setFeatureState`
      // needs the source name + feature id — the source's
      // `promoteId: 'textLabelId'` maps `properties.textLabelId` to
      // the id key.
      for (const id of prev) {
        if (nextOccluded.has(id)) continue
        try {
          map.setFeatureState({ source: TEXT_SOURCE, id }, { occluded: false })
        } catch { /* source went away */ }
      }
      for (const id of nextOccluded) {
        try {
          map.setFeatureState({ source: TEXT_SOURCE, id }, { occluded: true })
        } catch { /* source went away */ }
      }
      occludedIdsRef.current = nextOccluded
    }
    apply()
    map.on('move', apply)
    return () => {
      map.off('move', apply)
    }
  }, [map, styleLoaded, labels, prisms])

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
  // late-added overlays can't shove above.
  useEffect(() => {
    if (!map || !styleLoaded) return
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
