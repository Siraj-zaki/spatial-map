import { useEffect, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'
import { useGraphicsSettings } from '@/lib/graphics-settings'
import {
  focusTier,
  focusedIdOf,
  NO_BLOCKERS,
  useFocusScene,
  type FocusTier,
} from '@/lib/focus/focus-scene'
import {
  buildOccluders,
  createOcclusionState,
  markerOcclusionTargets,
  updateOcclusion,
  type OccluderInput,
} from '@/lib/marker-occlusion'
import type { MarkerShape } from '@/lib/shapes'
import { MarkerIconGlyph } from '@/lib/marker-icons'
import { cn } from '@/lib/utils'
import { LIMIT_MARKER_SIZE_PX } from '@/lib/input-limits'

interface MapMarkerOverlayProps {
  map: MapboxMapInstance | null
  /** Committed markers. */
  markers?: ReadonlyArray<MarkerShape>
  /**
   * Cursor coord — when set, renders a semi-transparent ghost marker
   * at the cursor (used during placement to preview where it'll land).
   */
  liveCursor?: [number, number] | null
  /** Maki id used for the ghost preview's icon. */
  liveIcon?: string | null
  liveColor?: string
  liveSize?: number
  /** Live elevation used for the ghost preview (METERS). */
  liveElevation?: number
  /** Live "pole" length used for the ghost preview (METERS). */
  liveHeight?: number
  selectedMarkerIds?: ReadonlySet<number>
  onMarkerClick?: (id: number, originalEvent: MouseEvent) => void
  /** Master visibility toggle. */
  committedVisible?: boolean
  /**
   * When false, clicks on markers pass through to the map (no
   * `preventDefault`, no selection callback). Set to false while a
   * create-* tool is active so the user can drop a new shape directly
   * on top of an existing marker without first deselecting it.
   */
  selectionEnabled?: boolean
  /**
   * When set, the given marker becomes draggable on the map. Drag
   * events fire `onTransformChange` with the new position; `commit` is
   * true on dragend so the caller can persist.
   */
  transformState?: { markerId: number; kind: 'move' } | null
  onTransformChange?: (
    patch: { position?: [number, number] },
    commit: boolean
  ) => void
  /**
   * Per-marker style overrides from the style-rules engine. Each entry
   * supersedes the matching field on `marker.config` at render time, so
   * the DOM marker re-paints whenever the resolver yields a new map.
   */
  shapeStyleOverrides?: ReadonlyMap<number, MarkerStyleOverride> | null
  /**
   * Geometry that markers can hide behind — floor plans, extruded
   * polygons / circles, walls, staircases. Pass the SAME arrays handed to
   * each shape overlay, gated on that layer's visibility: the warehouse
   * filter and the hidden-floor cascade are already applied there, and
   * geometry the user hid must stop occluding. Omitted = no occlusion.
   */
  occluders?: OccluderInput | null
}

/** What the rules engine can override on a marker. */
export interface MarkerStyleOverride {
  iconColor?: string
  fillOpacity?: number
  elevation?: number
  height?: number
  labelColor?: string
  labelText?: string
}

interface MarkerEntry {
  marker: mapboxgl.Marker
  root: Root
  el: HTMLElement
  /**
   * What `root` last rendered, so the sync effect re-renders only the
   * markers whose visual inputs changed (a selection click or a style-rule
   * tick touches one or two of ~200 roots, not all of them).
   */
  rendered?: { marker: MarkerShape; selected: boolean }
  /** `data-occluded` as last written by the occlusion pass. */
  occluded?: boolean
  /** `data-focus-tier` ('focus' | 'near') as last written by the focus pass (undefined / 'normal' = no attribute). */
  focusTier?: FocusTier
}

/**
 * Would `MarkerVisual` draw `a` and `b` the same? Shallow over the shape's
 * own fields and over its config (every config field is a scalar). The
 * style-rule resolver hands back a fresh override object — and so a fresh
 * effective config — on every tick, hence content rather than identity.
 */
function sameMarkerVisual(a: MarkerShape, b: MarkerShape): boolean {
  if (a === b) return true
  return shallowEqual(a, b, 'config') && shallowEqual(a.config, b.config)
}

function shallowEqual(a: object, b: object, skip?: string): boolean {
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const keys = Object.keys(ra)
  if (keys.length !== Object.keys(rb).length) return false
  for (const k of keys) {
    if (k === skip) continue
    if (!(k in rb) || ra[k] !== rb[k]) return false
  }
  return true
}

/**
 * Treat a hex colour as "neutral" when its R/G/B channels are within
 * 16 of each other — i.e. black, white, or any unsaturated grey. The
 * marker label uses this to decide whether to honour the user's
 * stored color (`isNeutralGrayscale = false` → respect it) or fall
 * back to the theme-aware `text-foreground` token (`true` → flip
 * with dark mode so the default `#000000` doesn't disappear against
 * the dark pill background).
 *
 * 16 channels of slop covers everything from `#000000` through
 * `#202020` and similar "default-ish" near-blacks/whites without
 * accidentally matching anything a user would describe as a colour.
 */
function isNeutralGrayscale(hex: string): boolean {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return false
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max - min <= 16
}

/**
 * Renders markers as HTML overlays via mapboxgl.Marker. We render the
 * lucide icon resolved by `MarkerIconGlyph` inside each marker's
 * element, so the picker UI and the rendered marker are visually
 * identical. This also sidesteps the Mapbox Standard sprite (which does
 * NOT ship the Maki icons the legacy config.icon names referred to —
 * the symbol-layer approach failed silently because the icon images
 * weren't loaded).
 *
 * Selection / hover / dragging states are CSS classes on the element:
 *   .shape-marker
 *   .shape-marker[data-selected="true"]
 *   .shape-marker[data-occluded="true"]
 *   .shape-marker:hover
 *
 * Being DOM nodes also means markers sit outside the GL depth buffer, so
 * a ground-floor marker would otherwise keep drawing over every slab,
 * wall and staircase stacked above it. `occluders` + `occlusionEnabled`
 * feed the analytic depth test in `src/lib/marker-occlusion.ts`, which
 * flips `data-occluded` per camera frame. The user can turn the pass off
 * from the side panel's Graphics section.
 *
 * Focus mode (`src/lib/focus/`, read from the host's FocusSceneContext):
 *   .shape-marker[data-focus-tier="focus" | "near"]
 *   map container [data-sgv-occlusion="ghost"]   (Graphics → faint ghosts)
 * The focused marker is left out of the occlusion pass, so it shows even
 * behind a slab. Only markers in the focused item's NEAR column fade;
 * every other marker carries no tier and looks exactly as without focus.
 * With no focus and ghosts off neither attribute is written and the
 * occlusion targets are the same array as before.
 */
export function MapMarkerOverlay({
  map,
  markers,
  liveCursor,
  liveIcon,
  liveColor = '#6366f1',
  liveSize = 28,
  liveElevation = 0,
  liveHeight = 0,
  selectedMarkerIds,
  onMarkerClick,
  committedVisible = true,
  selectionEnabled = true,
  transformState = null,
  onTransformChange,
  shapeStyleOverrides = null,
  occluders,
}: MapMarkerOverlayProps) {
  // Read the user's occlusion preference here rather than threading it
  // through every host — same pattern `mapbox-map.tsx` uses for the
  // shadow / AO flags.
  const occlusionEnabled = useGraphicsSettings((s) => s.markerOcclusion)
  const occlusionGhosts = useGraphicsSettings((s) => s.occlusionGhosts)
  // Focus mode. FOCUS_OFF outside a provider, so a host that never
  // focuses gets a null id and 'normal' tiers — today's behaviour.
  const focusScene = useFocusScene()
  const focusedMarkerId = focusedIdOf(focusScene, 'markers')
  // Map<markerId, MarkerEntry> kept in a ref so we can diff against
  // incoming props without losing the underlying DOM nodes on re-renders.
  const entriesRef = useRef<Map<number, MarkerEntry>>(new Map())
  const ghostRef = useRef<MarkerEntry | null>(null)

  // Keep the click callback in a ref so we don't reattach DOM listeners
  // every time the parent passes a new function identity.
  const onMarkerClickRef = useRef(onMarkerClick)
  useEffect(() => {
    onMarkerClickRef.current = onMarkerClick
  }, [onMarkerClick])
  // Same trick for `selectionEnabled` — the click listener captures this
  // ref so toggling the prop doesn't tear down + rebuild every marker.
  const selectionEnabledRef = useRef(selectionEnabled)
  useEffect(() => {
    selectionEnabledRef.current = selectionEnabled
    // Sync cursor on every existing marker so create-* mode shows the
    // crosshair cursor over markers (not the selection pointer).
    const entries = entriesRef.current
    for (const entry of entries.values()) {
      entry.el.style.cursor = selectionEnabled ? 'pointer' : 'default'
    }
  }, [selectionEnabled])

  const onTransformChangeRef = useRef(onTransformChange)
  useEffect(() => {
    onTransformChangeRef.current = onTransformChange
  }, [onTransformChange])

  // Sync committed markers.
  useEffect(() => {
    if (!map) return
    const entries = entriesRef.current
    const wanted = new Map<number, MarkerShape>()
    for (const m of markers ?? []) {
      if (m.id === undefined) continue
      if (m.visible === false) continue
      wanted.set(m.id, m)
    }

    // Remove anything that's no longer present.
    for (const [id, entry] of entries) {
      if (!wanted.has(id)) {
        entry.marker.remove()
        // Defer unmount past the current render commit — calling unmount()
        // synchronously inside an effect triggers a React warning.
        queueMicrotask(() => entry.root.unmount())
        entries.delete(id)
      }
    }

    // Add or update remaining markers.
    for (const [id, m] of wanted) {
      // Altitude is in METERS above the map surface (Mapbox handles
      // occlusion with 3D buildings/terrain when the camera angle is
      // below the marker). The `altitude` option and `setAltitude()`
      // method exist on Marker at runtime (Mapbox GL JS 3.x) but the
      // `@types/mapbox-gl` package is behind — hence the small cast.
      const altitude = Math.max(0, m.config.elevation ?? 0)
      let entry = entries.get(id)
      if (!entry) {
        const el = document.createElement('div')
        el.className = 'shape-marker'
        el.dataset.markerId = String(id)
        el.style.cursor = 'pointer'
        el.style.willChange = 'transform'
        el.addEventListener('click', (e) => {
          // When selection is disabled (a create-* tool is active), let
          // the click reach the map canvas so the create handler can
          // place a new shape directly on top of an existing marker.
          if (!selectionEnabledRef.current) return
          e.stopPropagation()
          onMarkerClickRef.current?.(id, e)
        })
        const marker = new mapboxgl.Marker({
          element: el,
          anchor: 'center',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...({ altitude } as any),
        })
          .setLngLat(m.position)
          .setRotation(m.bearing)
          .addTo(map)
        const root = createRoot(el)
        entry = { marker, root, el }
        entries.set(id, entry)
      } else {
        // Every setter runs a full `Marker._update` (project + rAF + DOM
        // task), and this effect re-runs for all ~200 markers on any
        // selection / override / list change — so call one only when it
        // would change something. Compared against the marker's OWN state
        // (exactly what each setter stores), not a cached prop: a native
        // drag moves `_lngLat` too, and must still be snapped back to
        // `m.position` here just as before.
        const ll = entry.marker.getLngLat()
        if (!ll || ll.lng !== m.position[0] || ll.lat !== m.position[1]) {
          entry.marker.setLngLat(m.position)
        }
        // `setRotation` stores `bearing || 0`.
        if (entry.marker.getRotation() !== (m.bearing || 0)) {
          entry.marker.setRotation(m.bearing)
        }
      }
      // `setAltitude` already returns early for an unchanged value.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const setAlt = (entry.marker as any).setAltitude
      if (typeof setAlt === 'function') setAlt.call(entry.marker, altitude)
      const isSelected = selectedMarkerIds?.has(id) ?? false
      // DOM writes only on change: an attribute or style write invalidates
      // style even when the value is the same.
      const selectedAttr = String(isSelected)
      if (entry.el.dataset.selected !== selectedAttr) entry.el.dataset.selected = selectedAttr
      const display = committedVisible ? '' : 'none'
      if (entry.el.style.display !== display) entry.el.style.display = display
      const override = shapeStyleOverrides?.get(id)
      const effectiveMarker = override ? applyMarkerOverride(m, override) : m
      const rendered = entry.rendered
      if (
        !rendered ||
        rendered.selected !== isSelected ||
        !sameMarkerVisual(rendered.marker, effectiveMarker)
      ) {
        entry.root.render(
          <MarkerVisual
            marker={effectiveMarker}
            selected={isSelected}
          />
        )
        entry.rendered = { marker: effectiveMarker, selected: isSelected }
      }
    }
  }, [map, markers, selectedMarkerIds, committedVisible, shapeStyleOverrides])

  // Focus tier → `data-focus-tier` (index.css: 'focus' glows and sits on
  // top; 'near' 35 % unless the marker is occluded; no attribute = drawn as
  // without focus). The focused marker gets 'focus'; a marker whose anchor
  // lies in the focused item's NEAR column (`scene.near`: within
  // FOCUS_NEAR_RADIUS_M horizontally, no more than FOCUS_NEAR_BELOW_M below
  // the item) gets 'near'; every other marker stays 'normal'. Markers never
  // block a line of sight, so the blocker set is irrelevant here (and there
  // is no ghost tier). `entry.focusTier` mirrors the attribute, so only
  // changed tiers are written. Declared after the sync effect, which
  // creates elements on `map` / `markers` changes — both are deps here, so
  // a marker created while focused is stamped in the same commit. Runs on
  // focus enter / exit / change (or a change of the NEAR column), never per
  // camera frame. With focus off and no tier ever written it returns at
  // once, so no attribute is touched.
  const tiersWrittenRef = useRef(false)
  useEffect(() => {
    if (!map) return
    if (!focusScene.active && !tiersWrittenRef.current) return
    const entries = entriesRef.current
    let anyTier = false
    for (const m of markers ?? []) {
      if (m.id === undefined) continue
      const entry = entries.get(m.id)
      if (!entry) continue
      const tier = focusTier(focusScene, NO_BLOCKERS, 'markers', m.id)
      if (tier !== 'normal') anyTier = true
      if ((entry.focusTier ?? 'normal') === tier) continue
      entry.focusTier = tier
      if (tier === 'normal') delete entry.el.dataset.focusTier
      else entry.el.dataset.focusTier = tier
    }
    tiersWrittenRef.current = anyTier
  }, [map, markers, focusScene])

  // Graphics → "Show hidden items as faint ghosts": one attribute on the
  // map container turns every occluded marker into a 25 % clickable ghost
  // (index.css); a click reaches the element listener above, and the host
  // focuses the marker. Off (the default) writes nothing.
  useEffect(() => {
    if (!map || !occlusionGhosts) return
    const container = map.getContainer()
    container.dataset.sgvOcclusion = 'ghost'
    return () => {
      delete container.dataset.sgvOcclusion
    }
  }, [map, occlusionGhosts])

  // Destructured so the memo below keys on the individual arrays. Hosts
  // build the `occluders` bag inline, so its object identity changes
  // every render while the arrays inside it stay referentially stable.
  const occludeImages = occluders?.images
  const occludePolygons = occluders?.polygons
  const occludeCircles = occluders?.circles
  const occludeLines = occluders?.lines
  const occludeStairs = occluders?.stairs
  const occludeGrids = occluders?.grids

  // The solids the occlusion pass tests against. Derived from props so a
  // moved / re-elevated / hidden shape re-prisms with no extra bookkeeping.
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
    ]
  )

  // Depth occlusion. Markers are DOM nodes above the canvas, so nothing
  // in the GL depth buffer can hide them — we solve camera→marker
  // against each extruded solid ourselves and flip `data-occluded`, which
  // `index.css` turns into `opacity: 0 !important; pointer-events: none`
  // (the `!important` beats the inline opacity `mapboxgl.Marker` writes
  // for its own fog / terrain fade).
  //
  // Recomputed on every `move` because occlusion is a function of the
  // camera, not of the data: the same marker is hidden looking straight
  // down and visible at a grazing pitch. `move` already fires at most
  // once per frame, and the pass walks a spatial index (see
  // `occluder-index.ts`), so it stays cheap at stadium scale.
  //
  // Targets are the drawn (visible) markers — the only ones with an
  // element — built once per `markers` change, not on every move.
  //
  // The focused marker is never a target: a focused item is always shown.
  // Changing focus rebuilds the list, so the effect below re-subscribes and
  // its full pass clears a stale `data-occluded` on the newly focused
  // marker (and re-tests the one that lost focus) — writes are flips only.
  // While no marker is focused the id stays null, so the array changes only
  // with `markers` — the same list (and occlusion state) as before focus
  // mode.
  const occlusionTargets = useMemo(
    () =>
      markerOcclusionTargets(
        (markers ?? []).filter(
          (m) => m.visible !== false && (focusedMarkerId === null || m.id !== focusedMarkerId),
        ),
      ),
    [markers, focusedMarkerId],
  )
  useEffect(() => {
    // Hidden markers are `display: none`, so their flag can wait: this
    // re-runs when they show again and re-checks every element in the
    // same commit that un-hides it.
    if (!map || !committedVisible) return
    const entries = entriesRef.current
    const state = createOcclusionState()
    // `entry.occluded` mirrors the attribute, so a frame where nothing
    // flipped writes nothing. Re-writing an unchanged attribute still
    // invalidates style on that element (~200 per frame before this).
    const write = (entry: MarkerEntry, occluded: boolean) => {
      if ((entry.occluded ?? false) === occluded) return
      entry.occluded = occluded
      if (occluded) entry.el.dataset.occluded = 'true'
      else delete entry.el.dataset.occluded
    }
    // Full pass over every element on (re)subscribe: markers created or
    // re-created since the last pass start without the attribute. Entries
    // only change when `markers` does, which re-runs this effect.
    const { occluded } = updateOcclusion(map, occlusionTargets, prisms, state)
    for (const [id, entry] of entries) write(entry, occluded.has(id))
    // Nothing to hide (occlusion off, no occluders, no markers): the
    // result can't depend on the camera, so don't listen to it.
    if (occlusionTargets.length === 0 || prisms.length === 0) return
    // Per move, only the ids whose state flipped.
    const apply = () => {
      const { entered, left } = updateOcclusion(map, occlusionTargets, prisms, state)
      for (const id of left) {
        const entry = entries.get(id)
        if (entry) write(entry, false)
      }
      for (const id of entered) {
        const entry = entries.get(id)
        if (entry) write(entry, true)
      }
    }
    map.on('move', apply)
    return () => {
      map.off('move', apply)
    }
  }, [map, occlusionTargets, prisms, committedVisible])

  // Sync the ghost marker (placement preview).
  useEffect(() => {
    if (!map) return
    if (!liveCursor) {
      if (ghostRef.current) {
        ghostRef.current.marker.remove()
        const g = ghostRef.current
        queueMicrotask(() => g.root.unmount())
        ghostRef.current = null
      }
      return
    }
    const ghostAlt = Math.max(0, liveElevation)
    if (!ghostRef.current) {
      const el = document.createElement('div')
      el.className = 'shape-marker shape-marker--ghost'
      // Ghost is purely visual — it must NOT swallow clicks so the
      // placement code's `map.on('click')` can still drop a real marker.
      el.style.pointerEvents = 'none'
      el.style.opacity = '0.55'
      const marker = new mapboxgl.Marker({
        element: el,
        anchor: 'center',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ altitude: ghostAlt } as any),
      })
        .setLngLat(liveCursor)
        .addTo(map)
      const root = createRoot(el)
      ghostRef.current = { marker, root, el }
    } else {
      ghostRef.current.marker.setLngLat(liveCursor)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ghostSetAlt = (ghostRef.current.marker as any).setAltitude
    if (typeof ghostSetAlt === 'function')
      ghostSetAlt.call(ghostRef.current.marker, ghostAlt)
    ghostRef.current.root.render(
      <IconVisual
        iconId={liveIcon ?? 'marker'}
        color={liveColor}
        size={liveSize}
        elevation={liveElevation}
        height={liveHeight}
      />
    )
  }, [map, liveCursor, liveIcon, liveColor, liveSize, liveElevation, liveHeight])

  // Move-mode wiring. Toggles `setDraggable` on each marker so only
  // the transform target can be dragged. Listens to mapboxgl.Marker's
  // built-in 'drag' / 'dragend' events and forwards new positions up
  // via `onTransformChange`. Matches the grid/circle Move pattern but
  // uses Mapbox's native draggable HTML markers (no separate handle
  // needed, since the marker IS the click target).
  useEffect(() => {
    const entries = entriesRef.current
    const targetId = transformState?.kind === 'move' ? transformState.markerId : null

    const cleanups: Array<() => void> = []
    for (const [id, entry] of entries) {
      const isTarget = id === targetId
      // Re-runs on every `markers` change (a drag frame included), so
      // only flip the markers whose draggability actually changes —
      // `setDraggable` re-binds map listeners each call.
      try {
        if (entry.marker.isDraggable() !== isTarget) entry.marker.setDraggable(isTarget)
      } catch {
        /* ignore */
      }
      // We mutate `entry.el.style.cursor` on the DOM nodes the
      // overlay owns. The rule flags this as "modifying a ref" because
      // the el is reachable through `entriesRef`, but the DOM node
      // itself is the actual mutation target. Same pattern as the
      // selectionEnabled sync effect above.
      const el = entry.el
      if (!isTarget) {
        const cursor = selectionEnabledRef.current ? 'pointer' : 'default'
        // eslint-disable-next-line react-hooks/immutability
        if (el.style.cursor !== cursor) el.style.cursor = cursor
        continue
      }
      if (el.style.cursor !== 'grab') el.style.cursor = 'grab'
      const onDragStart = () => {
        el.style.cursor = 'grabbing'
      }
      const onDrag = () => {
        const ll = entry.marker.getLngLat()
        onTransformChangeRef.current?.(
          { position: [ll.lng, ll.lat] },
          false
        )
      }
      const onDragEnd = () => {
        el.style.cursor = 'grab'
        const ll = entry.marker.getLngLat()
        onTransformChangeRef.current?.(
          { position: [ll.lng, ll.lat] },
          true
        )
      }
      entry.marker.on('dragstart', onDragStart)
      entry.marker.on('drag', onDrag)
      entry.marker.on('dragend', onDragEnd)
      cleanups.push(() => {
        try {
          entry.marker.off('dragstart', onDragStart)
          entry.marker.off('drag', onDrag)
          entry.marker.off('dragend', onDragEnd)
        } catch {
          /* ignore */
        }
      })
    }
    return () => {
      for (const fn of cleanups) fn()
    }
  }, [transformState, markers])

  // Final teardown: remove every marker the overlay owns. We snapshot
  // the refs here so the cleanup closes over the exact Map / entry the
  // effect saw at mount time (React's lint rule prevents reading
  // `entriesRef.current` lazily inside cleanup).
  useEffect(() => {
    const entries = entriesRef.current
    const ghostSlot = ghostRef
    return () => {
      for (const entry of entries.values()) {
        entry.marker.remove()
        const e = entry
        queueMicrotask(() => e.root.unmount())
      }
      entries.clear()
      const ghost = ghostSlot.current
      if (ghost) {
        ghost.marker.remove()
        queueMicrotask(() => ghost.root.unmount())
        ghostSlot.current = null
      }
    }
  }, [])

  return null
}

/** Spread style-rule fields into a marker shape's config copy. */
function applyMarkerOverride(
  marker: MarkerShape,
  override: MarkerStyleOverride,
): MarkerShape {
  const cfg = { ...marker.config }
  if (override.iconColor !== undefined) cfg.iconColor = override.iconColor
  if (override.fillOpacity !== undefined) cfg.opacity = override.fillOpacity
  if (override.elevation !== undefined) cfg.elevation = override.elevation
  if (override.height !== undefined) cfg.height = override.height
  if (override.labelColor !== undefined) cfg.labelColor = override.labelColor
  if (override.labelText !== undefined) {
    cfg.label = override.labelText
    cfg.showLabels = true
  }
  return { ...marker, config: cfg }
}

// ---- DOM-rendered visuals -------------------------------------------------

function MarkerVisual({
  marker,
  selected,
}: {
  marker: MarkerShape
  selected: boolean
}) {
  const cfg = marker.config
  return (
    <div
      className={cn(
        'group/marker relative',
        // The container is rotated by mapboxgl.Marker.setRotation; the
        // label sits in a fixed counter-rotated wrapper underneath so it
        // stays upright even if the user spins the icon.
      )}
    >
      <IconVisual
        iconId={cfg.icon}
        color={cfg.iconColor}
        size={cfg.iconSize}
        selected={selected}
        opacity={cfg.opacity / 100}
        elevation={cfg.elevation}
        height={cfg.height}
      />
      {cfg.showLabels && cfg.label.trim() !== '' && (() => {
        // Marker labels render as an HTML pill inside the Mapbox
        // marker element. The pill's background follows the theme
        // (`bg-background/85` flips dark in dark mode), but the
        // user's saved `labelColor` is an absolute hex — so the
        // default `#000000` becomes invisible against the dark
        // pill. When the saved color is near-grayscale (= the user
        // never picked a non-neutral color), fall back to the
        // theme-aware `text-foreground` token so dark mode reads
        // correctly. A vivid hex (e.g. a red warning label) stays
        // honored verbatim — that color was an explicit choice.
        const themeAware = isNeutralGrayscale(cfg.labelColor)
        return (
          <span
            className={cn(
              'pointer-events-none absolute whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-medium',
              'bg-background/85 backdrop-blur-sm shadow-sm border',
              themeAware && 'text-foreground',
            )}
            style={{
              color: themeAware ? undefined : cfg.labelColor,
              fontSize: `${cfg.labelSize}px`,
              ...labelOffsetFor(cfg.labelPosition, cfg.iconSize),
            }}
          >
            {cfg.label}
          </span>
        )
      })()}
    </div>
  )
}

function IconVisual({
  iconId,
  color,
  size,
  selected = false,
  opacity = 1,
  elevation = 0,
  height = 0,
}: {
  iconId: string
  color: string
  size: number
  selected?: boolean
  opacity?: number
  /** Meters above the surface — used to render the optional 3D pole. */
  elevation?: number
  /** Meters of pole length (0 = no pole). */
  height?: number
}) {
  // Round size to whole pixels; clamp so the icon never disappears or
  // overflows tiles. The badge background scales with icon size.
  const px = Math.max(12, Math.min(LIMIT_MARKER_SIZE_PX, Math.round(size)))
  const padding = Math.round(px * 0.22)
  const showPole = elevation > 0 && height > 0
  // Cheap pole length: ~1px per meter, clamped so it never gets absurd.
  // This is screen-space (independent of zoom) — true world-space length
  // would need camera-projection math we don't need yet for a depth cue.
  const polePx = showPole ? Math.max(8, Math.min(160, Math.round(height))) : 0
  const badge = px + padding * 2
  return (
    <div
      className="relative flex flex-col items-center"
      style={{ opacity }}
    >
      {showPole && (
        <div
          aria-hidden="true"
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            top: `${badge}px`,
            width: 2,
            height: polePx,
            background: `linear-gradient(to bottom, ${color}, ${color}00)`,
            boxShadow: '0 0 0 0.5px rgba(0,0,0,0.25)',
          }}
        />
      )}
      <div
        className={cn(
          'flex items-center justify-center rounded-full transition-all',
          'shadow-[0_2px_6px_rgba(0,0,0,0.35)] border-2 border-white/85',
          selected && 'ring-4 ring-amber-300/85 scale-110'
        )}
        style={{
          width: badge,
          height: badge,
          backgroundColor: color,
        }}
      >
        <MarkerIconGlyph
          icon={iconId}
          style={{
            width: px,
            height: px,
            color: '#ffffff',
          }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}

/**
 * Pixel offset from the marker center for the label position. The
 * marker's badge has a radius of roughly `iconSize * 0.72`, so the
 * label sits just outside the badge edge with a small gap.
 */
function labelOffsetFor(
  position: 'top' | 'bottom' | 'left' | 'right',
  iconSize: number
): React.CSSProperties {
  const gap = Math.max(6, Math.round(iconSize * 0.4))
  switch (position) {
    case 'top':
      return { left: '50%', bottom: `calc(100% + ${gap}px)`, transform: 'translateX(-50%)' }
    case 'bottom':
      return { left: '50%', top: `calc(100% + ${gap}px)`, transform: 'translateX(-50%)' }
    case 'left':
      return { right: `calc(100% + ${gap}px)`, top: '50%', transform: 'translateY(-50%)' }
    case 'right':
      return { left: `calc(100% + ${gap}px)`, top: '50%', transform: 'translateY(-50%)' }
  }
}
