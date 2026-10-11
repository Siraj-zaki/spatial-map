/**
 * Popup overlay for non-grid shapes (polygon / circle / line / image /
 * model / marker). Each kind is resolved independently — no kind ever
 * leaks data into another. Mirrors the grid-cell popup wired in
 * `map-bin-overlay.tsx` but keyed on `(targetKind, shapeId)` instead of
 * `(gridId, row, col, level)`.
 *
 * # Hover vs click — per-shape activation
 *
 * Each shape's `config.tooltipTrigger` (default `'hover'`) decides
 * whether the popup opens on mousemove or on click:
 *   - `hover`  → behaves like the original implementation: opens on
 *     mousemove, closes when the cursor leaves.
 *   - `click`  → opens on click and stays open until the user clicks
 *     the same shape again (toggle off), clicks another click-trigger
 *     shape (replace), or clicks an empty area of the map (dismiss).
 *
 * Hover-trigger and click-trigger shapes coexist on the same map. The
 * pointer cursor still flips on hover for *both* kinds so the user
 * sees that a shape is interactive regardless of its trigger.
 *
 * # Hit resolution
 *
 * On every mousemove (and click) we:
 *   1. Collect the live set of target layers (filtered to those that
 *      currently exist on the map — overlays add their layers
 *      asynchronously after `style.load`, so binding by name at mount
 *      time silently misses anything that loads later).
 *   2. Call `queryRenderedFeatures` against the union of those layers.
 *   3. Group the hits by **kind**, then pick a winner via explicit
 *      priority — markers > 3D models > line / polygon / circle > image —
 *      regardless of Mapbox's render order. Large background-style
 *      kinds (the floor-plan image-hit-layer is a fill that covers the
 *      whole image bbox) must never out-rank a small specific shape
 *      under the cursor.
 *
 * # Markers stay sticky
 *
 * Markers are HTML overlays (`mapboxgl.Marker`), not Mapbox layers, so
 * the same mousemove that drives the layer pipeline NEVER finds them.
 * Without special handling the layer pipeline would clear the popup
 * the moment the cursor entered a marker. The fix: when a marker DOM
 * `mouseover` (or `click`) fires we tag the popup as one of the marker
 * owners. The layer-side mousemove leaves marker-owned popups alone;
 * only `markerLeave` (hover) or a follow-up dismissive click (click)
 * releases the marker's claim.
 */

import { useEffect, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'
import {
  useSpatialBins,
  useSpatialCircles,
  useSpatialImages,
  useSpatialLines,
  useSpatialMarkers,
  useSpatialModels,
  useSpatialPolygons,
} from '@/hooks/useSpatialShapes'
import { type Bin, type BindingKind } from '@/lib/db'
import type { TooltipTrigger } from '@/lib/shapes'
import { BinPopupContent } from './bin-popup-content'
import { hasAnyContent } from '@/lib/rich-data'

const OPACITY_BUCKETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
const POLYGON_EXTRUDE_LAYERS = OPACITY_BUCKETS.map((b) => `polygon-extrude-layer-op${b}`)
const CIRCLE_EXTRUDE_LAYERS = OPACITY_BUCKETS.map((b) => `circle-extrude-layer-op${b}`)
const MODEL_LAYER_PREFIX = 'model-shapes-layer-'

/**
 * The set of Mapbox layers each kind owns. Probe-filtered on every
 * mousemove so a missing overlay just yields zero hits instead of
 * throwing.
 */
const KIND_LAYERS: Array<{
  kind: Exclude<BindingKind, 'grid-cell' | 'marker' | 'model'>
  layers: string[]
}> = [
  { kind: 'polygon', layers: POLYGON_EXTRUDE_LAYERS },
  { kind: 'circle', layers: ['circle-fill-layer', ...CIRCLE_EXTRUDE_LAYERS] },
  { kind: 'line', layers: ['line-stroke-layer', 'line-wall-layer'] },
  { kind: 'image', layers: ['image-hit-layer'] },
]

/**
 * Priority order when multiple kinds report a hit at the same pixel.
 * Lower number wins. Markers and 3D models are user-placed point
 * objects so they're the highest-signal hits; images are large flat
 * backgrounds (floor-plan rasters) and must come last so a model
 * sitting visually inside the floor-plan doesn't get out-ranked by
 * the floor-plan's full-bbox hit layer.
 */
const KIND_PRIORITY: Record<Exclude<BindingKind, 'grid-cell'>, number> = {
  marker: 1,
  model: 2,
  line: 3,
  circle: 4,
  polygon: 5,
  image: 6,
}

/**
 * Per-kind property the overlay stamps on its features. The top-level
 * GeoJSON `feature.id` is also set in most cases, but the property is
 * the more reliable source — paint expressions and source rebuilds
 * sometimes drop the top-level id.
 */
const ID_PROP_BY_KIND: Record<Exclude<BindingKind, 'grid-cell'>, string> = {
  polygon: 'polygonId',
  circle: 'circleId',
  line: 'lineId',
  marker: 'markerId',
  image: 'imageId',
  model: 'modelId',
}

interface Props {
  map: MapboxMapInstance | null
  /**
   * Master switch — tooltips only render when this is true. The host
   * (`routes/create-grids.tsx`) wires this to `activeTool === 'pan'`
   * so the read-only Pan tool is the one mode that shows hover and
   * click popups. In Select mode clicks select shapes (and a popup
   * would compete for the same gesture); in Create-* modes clicks
   * place new shapes (so a popup over an existing one would lie
   * about what the next click will do). Flipping false also
   * dismisses any popup already on screen so it doesn't strand.
   */
  enabled?: boolean
  /**
   * Forwarded to `<BinPopupContent>`. Set to false to suppress the
   * "Linked" references section — /view uses this in shape-only mode
   * so hovering doesn't fire a `/references` fetch every time. The
   * editor keeps the default `true`.
   */
  withReferences?: boolean
  /**
   * Called for every `click`-trigger shape click BEFORE the tooltip
   * would open its popup. Return `true` to fully take over the click:
   * the tooltip suppresses its own popup and leaves the click to the
   * host. Return `false`/undefined for default behaviour.
   *
   * `/view` uses this to route polygon click-trigger interactions
   * into a side drawer instead of the compact popup.
   */
  onClickShapeOverride?: (
    kind: Exclude<BindingKind, 'grid-cell'>,
    id: number,
  ) => boolean | void
  /**
   * Optional shape-array overrides. When provided, they supersede the
   * `useSpatial*` store hooks. Share-link / public-view code paths
   * render without `useSpatialStore` populated — the shapes arrive
   * from the share endpoint — so callers pass them in here to keep
   * hover popups and click-to-drawer working. In authenticated mode
   * these are undefined and the store hooks provide the data.
   */
  bins?: readonly Bin[]
  polygons?: readonly import('@/lib/shapes').PolygonShape[]
  circles?: readonly import('@/lib/shapes').CircleShape[]
  lines?: readonly import('@/lib/shapes').LineShape[]
  markers?: readonly import('@/lib/shapes').MarkerShape[]
  images?: readonly import('@/lib/shapes').ImageShape[]
  models?: readonly import('@/lib/shapes').ModelShape[]
}

type ShapeKey = string // formatted as `${BindingKind}:${shapeId}`

const shapeKey = (
  kind: Exclude<BindingKind, 'grid-cell'>,
  id: number,
): ShapeKey => `${kind}:${id}`

export function MapShapeTooltip({
  map,
  enabled = true,
  withReferences = true,
  onClickShapeOverride,
  bins: binsOverride,
  polygons: polygonsOverride,
  circles: circlesOverride,
  lines: linesOverride,
  markers: markersOverride,
  images: imagesOverride,
  models: modelsOverride,
}: Props) {
  const overrideRef = useRef(onClickShapeOverride)
  useEffect(() => {
    overrideRef.current = onClickShapeOverride
  }, [onClickShapeOverride])
  // Read shape snapshots from the local spatial store instead of polling
  // each catalog table every 10 seconds. SSE reconciles changes in the
  // background while the tooltip is idle. Overrides win when the host
  // provides them (share-link path — store is empty there).
  const { data: storeBins = [] } = useSpatialBins()
  const { data: storePolygons = [] } = useSpatialPolygons()
  const { data: storeCircles = [] } = useSpatialCircles()
  const { data: storeLines = [] } = useSpatialLines()
  const { data: storeMarkers = [] } = useSpatialMarkers()
  const { data: storeImages = [] } = useSpatialImages()
  const { data: storeModels = [] } = useSpatialModels()
  const bins = binsOverride ?? storeBins
  const polygons = polygonsOverride ?? storePolygons
  const circles = circlesOverride ?? storeCircles
  const lines = linesOverride ?? storeLines
  const markers = markersOverride ?? storeMarkers
  const images = imagesOverride ?? storeImages
  const models = modelsOverride ?? storeModels

  const binIndex = useMemo(() => {
    const idx = new Map<string, Bin>()
    for (const b of bins) {
      if (b.targetKind === 'grid-cell') continue
      if (typeof b.shapeId === 'number') {
        idx.set(`${b.targetKind}:${b.shapeId}`, b)
      }
    }
    return idx
  }, [bins])
  const binIndexRef = useRef(binIndex)
  useEffect(() => {
    binIndexRef.current = binIndex
  }, [binIndex])

  /**
   * `${kind}:${id}` → activation. Missing entries (legacy rows that
   * predate `config.tooltipTrigger`) default to `'hover'` so behaviour
   * matches the pre-feature build.
   */
  const triggerIndex = useMemo(() => {
    const idx = new Map<ShapeKey, TooltipTrigger>()
    const add = (
      kind: Exclude<BindingKind, 'grid-cell'>,
      id: number | undefined,
      trigger: TooltipTrigger | undefined,
    ) => {
      if (id === undefined) return
      idx.set(shapeKey(kind, id), trigger ?? 'hover')
    }
    for (const s of polygons) add('polygon', s.id, s.config.tooltipTrigger)
    for (const s of circles) add('circle', s.id, s.config.tooltipTrigger)
    for (const s of lines) add('line', s.id, s.config.tooltipTrigger)
    for (const s of markers) add('marker', s.id, s.config.tooltipTrigger)
    for (const s of images) add('image', s.id, s.config.tooltipTrigger)
    for (const s of models) add('model', s.id, s.config.tooltipTrigger)
    return idx
  }, [polygons, circles, lines, markers, images, models])
  const triggerIndexRef = useRef(triggerIndex)
  useEffect(() => {
    triggerIndexRef.current = triggerIndex
  }, [triggerIndex])

  useEffect(() => {
    if (!map) return
    if (!enabled) return
    const popup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      className: 'bin-hover-popup',
      maxWidth: '340px',
    })
    let popupNode: HTMLElement | null = null
    let popupRoot: Root | null = null
    // True while the cursor is over the popup DOM itself. Kept in a
    // closure ref so the map's `mousemove` handler can consult it
    // synchronously — Mapbox stops firing map-canvas mousemoves once the
    // cursor enters the popup element (its default pointer-events:auto),
    // so without this flag the last "no candidate" mousemove that fired
    // in the gap between shape and popup would tear the popup down
    // before the user could reach it. See the delayed-dismiss dance in
    // `scheduleDismiss` + the DOM listeners at the bottom of this
    // effect.
    let popupHovered = false
    let pendingDismiss: ReturnType<typeof setTimeout> | null = null
    const cancelPendingDismiss = () => {
      if (pendingDismiss !== null) {
        clearTimeout(pendingDismiss)
        pendingDismiss = null
      }
    }
    const ensureMount = (): Root => {
      if (popupRoot) return popupRoot
      popupNode = document.createElement('div')
      popupRoot = createRoot(popupNode)
      // Popup preservation: mouse entering the popup cancels the
      // pending dismiss so users can move their cursor from the shape
      // onto the popup without it vanishing mid-transit. Mouseleave
      // schedules a new dismiss with the same delay so leaving the
      // popup toward empty map still tears it down eventually.
      popupNode.addEventListener('mouseenter', () => {
        popupHovered = true
        cancelPendingDismiss()
      })
      popupNode.addEventListener('mouseleave', () => {
        popupHovered = false
        scheduleDismiss()
      })
      popup.setDOMContent(popupNode)
      return popupRoot
    }

    /**
     * Which subsystem currently "owns" the popup. Each click-popup
     * owner is sticky — its dismissal happens through a follow-up
     * click rather than a mousemove. The hover variants behave like
     * the pre-feature build.
     */
    type PopupOwner =
      | 'hover-layer'
      | 'click-layer'
      | 'hover-marker'
      | 'click-marker'
      | null
    let popupOwner: PopupOwner = null
    /**
     * When a click popup is up, this is the shape it belongs to.
     * Used to detect "click the same shape again to toggle off" and to
     * avoid replacing a click popup with a hover popup of the same
     * shape (which would just flicker).
     */
    let clickPopupKey: ShapeKey | null = null
    let cursorOwned = false
    /**
     * The shape currently rendered inside the popup. Re-rendering React
     * with the same prop tree is cheap, but `mapboxgl.Popup.addTo()`
     * *removes-then-re-adds* the popup DOM (so its `closeOnMove` /
     * `closeOnClick` listeners reset and the CSS entry animation
     * replays). On a hover popup that follows the cursor across the
     * same shape that means a flicker on every `mousemove`. Tracking
     * the rendered key lets us skip the React render AND skip the
     * `addTo` call when neither has changed.
     */
    let renderedKey: ShapeKey | null = null

    /**
     * Move the popup to `lngLat` and attach it lazily. Mapbox's
     * `addTo` is destructive (`this._map && this.remove()`), so calling
     * it on every mousemove restarts the entry animation. Only call
     * `addTo` when the popup isn't already showing.
     */
    const placeAndShow = (lngLat: mapboxgl.LngLatLike) => {
      cancelPendingDismiss()
      popup.setLngLat(lngLat)
      if (!popup.isOpen()) popup.addTo(map)
    }
    /**
     * Track the shape currently rendered PLUS whether we rendered the
     * compact preview or the full body. Click flips a hover-mode
     * shape's popup from compact → full, so we need the render key to
     * capture both dimensions or the flip would silently no-op.
     */
    let renderedMode: 'compact' | 'full' | null = null
    /**
     * Render the bin. Hover popups get the compact preview (image + 5
     * fields + "View more"); click popups get the full body. "View
     * more" simulates a click on the shape by invoking the same
     * override the click handler uses — for /view that opens the
     * shape drawer. Falls back to promoting the popup itself to full
     * body when the host doesn't own the shape (no override
     * registered).
     */
    const renderIfChanged = (
      key: ShapeKey,
      bin: Bin,
      mode: 'compact' | 'full',
      kind?: Exclude<BindingKind, 'grid-cell'>,
      shapeId?: number,
    ) => {
      if (renderedKey === key && renderedMode === mode) return
      // Only wire "View more" when the host has a drawer target.
      // Without it (editor context), the button would just dismiss the
      // popup and leave the user staring at the map — worse UX than
      // hiding the button entirely. `BinPopupContent` renders the
      // button only when both `compact` and `onViewMore` are truthy.
      const hasDrawerTarget = overrideRef.current !== undefined
      const onViewMore =
        mode === 'compact' &&
        kind !== undefined &&
        shapeId !== undefined &&
        hasDrawerTarget
          ? () => {
              // Delegate to the host (view.tsx opens its sidebar
              // drawer via `overrideRef`). Then ALWAYS dismiss the
              // popup — the drawer replaces it as the detail surface,
              // and leaving the popup pinned would trap it open
              // (sticky click owner ignores hover-leave, and
              // subsequent hovers on other shapes would be blocked).
              overrideRef.current?.(kind, shapeId)
              dismissPopup()
            }
          : undefined
      ensureMount().render(
        <BinPopupContent
          bin={bin}
          withReferences={withReferences && mode === 'full'}
          compact={mode === 'compact'}
          onViewMore={onViewMore}
        />,
      )
      renderedKey = key
      renderedMode = mode
    }

    const setCursor = (style: '' | 'pointer') => {
      if (style === 'pointer') {
        map.getCanvas().style.cursor = 'pointer'
        cursorOwned = true
      } else if (cursorOwned) {
        map.getCanvas().style.cursor = ''
        cursorOwned = false
      }
    }
    const dismissPopup = () => {
      cancelPendingDismiss()
      popup.remove()
      popupOwner = null
      clickPopupKey = null
      renderedKey = null
      renderedMode = null
      popupHovered = false
      setCursor('')
    }
    /**
     * Schedule a hover-popup dismiss with a 180 ms grace period. The
     * delay lets the cursor cross the 12 px offset gap between the
     * shape and the popup without the popup vanishing mid-transit — a
     * new mousemove landing on the shape OR the popup's own
     * mouseenter cancels the pending timer. Click popups ignore
     * this — they're sticky and only close via a follow-up click.
     */
    const HOVER_DISMISS_DELAY_MS = 180
    const scheduleDismiss = () => {
      if (popupOwner !== 'hover-layer' && popupOwner !== 'hover-marker') return
      if (popupHovered) return
      cancelPendingDismiss()
      pendingDismiss = setTimeout(() => {
        pendingDismiss = null
        if (popupHovered) return
        if (popupOwner === 'hover-layer' || popupOwner === 'hover-marker') {
          popup.remove()
          popupOwner = null
          renderedKey = null
          renderedMode = null
          setCursor('')
        }
      }, HOVER_DISMISS_DELAY_MS)
    }
    /**
     * Hover-side clear: only acts when the popup is currently a hover
     * popup. Click popups survive mousemove — they can only be
     * dismissed by a follow-up click. Uses the delayed dismiss so
     * users can move their cursor from the shape onto the popup.
     */
    const clearHoverPopup = () => {
      if (popupOwner === 'hover-layer' || popupOwner === 'hover-marker') {
        scheduleDismiss()
      }
    }

    /**
     * Resolve a Mapbox feature → numeric shape id, walking the per-kind
     * property first, then the top-level id, then a trailing-number
     * heuristic on `properties.id`.
     */
    const featureToShapeId = (
      kind: Exclude<BindingKind, 'grid-cell'>,
      feature: mapboxgl.MapboxGeoJSONFeature,
    ): number => {
      const props = feature.properties as Record<string, unknown> | undefined
      const idProp = ID_PROP_BY_KIND[kind]
      if (props && typeof props[idProp] === 'number') return props[idProp] as number
      if (props && typeof props[idProp] === 'string') {
        const n = Number(props[idProp])
        if (Number.isFinite(n)) return n
      }
      if (typeof feature.id === 'number') return feature.id
      if (typeof feature.id === 'string') {
        const n = Number(feature.id)
        if (Number.isFinite(n)) return n
      }
      if (props && typeof props.id === 'string') {
        const tail = props.id.match(/(\d+)$/)
        if (tail) return Number(tail[1])
      }
      // Model hits from the source-driven overlay don't carry GeoJSON
      // properties — there's one model source + one model layer per
      // placed shape, and the layer id encodes the shape id. So when
      // every other path fails for a model hit, parse the trailing
      // number off the layer id (e.g. "model-shapes-layer-42" → 42).
      if (kind === 'model') {
        const layerId = feature.layer?.id ?? ''
        if (layerId.startsWith(MODEL_LAYER_PREFIX)) {
          const tail = layerId.slice(MODEL_LAYER_PREFIX.length)
          const n = Number(tail)
          if (Number.isFinite(n)) return n
        }
      }
      return NaN
    }

    /**
     * Build the active layer set: filter `KIND_LAYERS` down to layers
     * that currently exist, then discover dynamic model layers from
     * the live style.
     */
    const collectActiveLayers = (): Array<{
      kind: Exclude<BindingKind, 'grid-cell' | 'marker'>
      layers: string[]
    }> => {
      const out: Array<{
        kind: Exclude<BindingKind, 'grid-cell' | 'marker'>
        layers: string[]
      }> = []
      for (const cfg of KIND_LAYERS) {
        const live = cfg.layers.filter((id) => map.getLayer(id) !== undefined)
        if (live.length > 0) out.push({ kind: cfg.kind, layers: live })
      }
      // `map.getStyle()` throws "Style is not done loading" if the user
      // is in the middle of switching basemaps and a mousemove event
      // happens to fire between `setStyle()` and the new `style.load`.
      // Swallow it — the next mousemove after the swap completes will
      // re-collect the active model layers cleanly.
      let styleLayers: { id: string }[]
      try {
        styleLayers = map.getStyle()?.layers ?? []
      } catch {
        return out
      }
      const modelLayers = styleLayers
        .map((l) => l.id)
        .filter((id) => id.startsWith(MODEL_LAYER_PREFIX))
      if (modelLayers.length > 0) out.push({ kind: 'model', layers: modelLayers })
      return out
    }

    /**
     * Group hits by kind. Within a kind we keep the topmost hit (the
     * one Mapbox rendered last) — that's the right tie-break inside a
     * single kind. Between kinds, `KIND_PRIORITY` decides.
     */
    const groupHitsByKind = (
      hits: mapboxgl.MapboxGeoJSONFeature[],
      groups: Array<{
        kind: Exclude<BindingKind, 'grid-cell' | 'marker'>
        layers: string[]
      }>,
    ): Map<
      Exclude<BindingKind, 'grid-cell' | 'marker'>,
      mapboxgl.MapboxGeoJSONFeature
    > => {
      const out = new Map<
        Exclude<BindingKind, 'grid-cell' | 'marker'>,
        mapboxgl.MapboxGeoJSONFeature
      >()
      for (const f of hits) {
        const layerId = f.layer?.id ?? ''
        const g = groups.find((grp) => grp.layers.includes(layerId))
        if (!g) continue
        if (!out.has(g.kind)) out.set(g.kind, f) // first wins (topmost)
      }
      return out
    }

    /**
     * Resolve a screen-point query into a kind-ordered list of
     * `(kind, shapeId, bin)` candidates that have renderable data.
     * Shared by the mousemove (hover) and click paths.
     */
    const resolveHitsAt = (
      e: mapboxgl.MapMouseEvent,
    ): Array<{
      kind: Exclude<BindingKind, 'grid-cell' | 'marker'>
      shapeId: number
      bin: Bin
    }> => {
      const groups = collectActiveLayers()
      if (groups.length === 0) return []
      const allLayerIds = groups.flatMap((g) => g.layers)
      let hits: mapboxgl.MapboxGeoJSONFeature[]
      try {
        hits = map.queryRenderedFeatures(e.point, { layers: allLayerIds })
      } catch {
        return []
      }
      if (hits.length === 0) return []
      const byKind = groupHitsByKind(hits, groups)
      if (byKind.size === 0) return []
      const orderedKinds = [...byKind.keys()].sort(
        (a, b) => KIND_PRIORITY[a] - KIND_PRIORITY[b],
      )
      const out: Array<{
        kind: Exclude<BindingKind, 'grid-cell' | 'marker'>
        shapeId: number
        bin: Bin
      }> = []
      for (const kind of orderedKinds) {
        const feature = byKind.get(kind)!
        const shapeId = featureToShapeId(kind, feature)
        if (!Number.isFinite(shapeId)) continue
        const bin = binIndexRef.current.get(`${kind}:${shapeId}`)
        if (!bin || !hasAnyContent(bin)) continue
        out.push({ kind, shapeId, bin })
      }
      return out
    }

    const onMouseMove = (e: mapboxgl.MapMouseEvent) => {
      // Marker-owned popups manage themselves through DOM events.
      if (popupOwner === 'hover-marker' || popupOwner === 'click-marker') {
        return
      }
      // If the cursor is over a marker DOM element (the layer under it
      // still fires mousemove because DOM markers don't stop
      // propagation on move), defer to the marker's own tooltip path
      // and clear any stale hover popup so the polygon tooltip
      // doesn't ghost behind the marker one.
      const oe = e.originalEvent as MouseEvent | undefined
      if (oe && typeof oe.clientX === 'number') {
        const el = document.elementFromPoint(oe.clientX, oe.clientY)
        if (el && (el as Element).closest?.('.shape-marker')) {
          clearHoverPopup()
          return
        }
      }
      // Data-link widgets (sensor / camera / asset) render as Mapbox
      // `dl-*` layers on top of the polygon layers. If any of them is
      // under the cursor, we don't want the polygon tooltip to ghost
      // through — the widget itself owns the hover interaction.
      try {
        const allHits = map.queryRenderedFeatures(e.point)
        for (const hit of allHits) {
          const layerId = (hit.layer as { id?: string })?.id
          if (typeof layerId === 'string' && layerId.startsWith('dl-')) {
            clearHoverPopup()
            return
          }
        }
      } catch { /* style not ready */ }
      const candidates = resolveHitsAt(e)
      // Pointer cursor: any candidate (hover or click) means the user
      // is over something interactive. Set the cursor for whichever
      // wins priority — even click-trigger shapes should signal that
      // they're interactive.
      const anyInteractive = candidates.length > 0
      // Find the first hover-trigger candidate. Click-trigger
      // candidates are NOT shown on hover — they wait for click.
      const hoverHit = candidates.find(
        ({ kind, shapeId }) =>
          (triggerIndexRef.current.get(shapeKey(kind, shapeId)) ?? 'hover') ===
          'hover',
      )
      if (hoverHit) {
        // A click popup pinned to the same shape is preserved — the
        // user explicitly opened it. Show pointer only.
        if (clickPopupKey === shapeKey(hoverHit.kind, hoverHit.shapeId)) {
          setCursor('pointer')
          return
        }
        setCursor('pointer')
        popupOwner = 'hover-layer'
        const key = shapeKey(hoverHit.kind, hoverHit.shapeId)
        renderIfChanged(key, hoverHit.bin, 'compact', hoverHit.kind, hoverHit.shapeId)
        placeAndShow(e.lngLat)
        return
      }
      // No hover candidates — but maybe a click-trigger one is under
      // the cursor. Keep the pointer to signal interactivity, then
      // clear any stale hover popup.
      if (anyInteractive) setCursor('pointer')
      else setCursor('')
      clearHoverPopup()
    }
    map.on('mousemove', onMouseMove)
    map.on('mouseout', clearHoverPopup)

    /**
     * Click pipeline. Two responsibilities:
     *   1. Open / replace / toggle a click popup when the user clicks
     *      a `click`-trigger shape with bin data.
     *   2. Dismiss any open click popup when the user clicks an empty
     *      area or a `hover`-trigger shape (which doesn't claim
     *      ownership of the click — the hover pipeline handles that).
     */
    const onClick = (e: mapboxgl.MapMouseEvent) => {
      // The marker DOM click handler runs in capture phase before
      // the map's click event, so by the time we land here a marker
      // click has already been processed. We still get the map click
      // bubbled up though — guard against re-handling.
      if (popupOwner === 'click-marker') return
      const candidates = resolveHitsAt(e)
      const clickHit = candidates.find(
        ({ kind, shapeId }) =>
          triggerIndexRef.current.get(shapeKey(kind, shapeId)) === 'click',
      )
      if (!clickHit) {
        // Empty area or hover-only shape → dismiss any open click popup.
        // The click-marker branch already returned at the top of this
        // handler, so the only sticky owner that can reach here is
        // 'click-layer'.
        if (popupOwner === 'click-layer') dismissPopup()
        return
      }
      const key = shapeKey(clickHit.kind, clickHit.shapeId)
      // Host-side override: caller wants to take this click entirely
      // (e.g. /view opens a drawer for click-mode polygons). Dismiss
      // any stale popup + skip our own.
      if (overrideRef.current?.(clickHit.kind, clickHit.shapeId) === true) {
        if (popupOwner === 'click-layer') dismissPopup()
        return
      }
      // Toggle off when the user clicks the same shape that's already
      // showing — matches the "click again to dismiss" affordance the
      // rest of the UI uses for selection / tools.
      if (clickPopupKey === key && popupOwner === 'click-layer') {
        dismissPopup()
        return
      }
      // Replace any existing popup (hover or click) with the new
      // click-anchored one.
      popupOwner = 'click-layer'
      clickPopupKey = key
      setCursor('pointer')
      renderIfChanged(key, clickHit.bin, 'full', clickHit.kind, clickHit.shapeId)
      placeAndShow(e.lngLat)
    }
    map.on('click', onClick)

    // ------ marker — DOM overlays, event-delegated -------------------
    const container = map.getContainer()
    const markerIdFromEvent = (ev: Event): number | null => {
      const el = (ev.target as HTMLElement | null)?.closest?.('.shape-marker')
      if (!(el instanceof HTMLElement)) return null
      const raw = el.dataset.markerId
      if (!raw) return null
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    }
    /**
     * Anchor a popup at the centre of a marker DOM element. Shared by
     * the hover and click paths so the popup lands at the same spot.
     */
    const popupLngLatForElement = (el: HTMLElement): mapboxgl.LngLat => {
      const rect = el.getBoundingClientRect()
      const canvasRect = container.getBoundingClientRect()
      return map.unproject([
        rect.left + rect.width / 2 - canvasRect.left,
        rect.top + rect.height / 2 - canvasRect.top,
      ])
    }
    const markerEnter = (ev: Event) => {
      const id = markerIdFromEvent(ev)
      if (id === null) return
      const trigger =
        triggerIndexRef.current.get(shapeKey('marker', id)) ?? 'hover'
      // Click-trigger markers don't open on hover; we still flip the
      // cursor so the user sees the marker is interactive.
      if (trigger !== 'hover') {
        setCursor('pointer')
        return
      }
      const bin = binIndexRef.current.get(`marker:${id}`)
      if (!bin || !hasAnyContent(bin)) return
      const el = (ev.target as HTMLElement).closest('.shape-marker') as HTMLElement | null
      if (!el) return
      // A click popup pinned to the same marker is preserved — the
      // user already opened it deliberately.
      if (clickPopupKey === shapeKey('marker', id)) {
        setCursor('pointer')
        return
      }
      setCursor('pointer')
      popupOwner = 'hover-marker'
      const mkKey = shapeKey('marker', id)
      renderIfChanged(mkKey, bin, 'compact', 'marker', id)
      placeAndShow(popupLngLatForElement(el))
    }
    const markerLeave = (ev: Event) => {
      const related = (ev as MouseEvent).relatedTarget as Node | null
      const el = (ev.target as HTMLElement | null)?.closest?.('.shape-marker')
      // Ignore transitions between a marker's nested children.
      if (el && related && el.contains(related)) return
      // Only hover popups release on leave; click popups stay pinned.
      // Uses the same delayed dismiss as the layer path so the cursor
      // can travel from marker → popup without the popup vanishing.
      if (popupOwner === 'hover-marker') {
        scheduleDismiss()
      } else if (popupOwner !== 'click-marker' && popupOwner !== 'click-layer') {
        setCursor('')
      }
    }
    /**
     * Click on a marker element. Mirrors `onClick` for layer hits:
     * toggle / replace / open. Uses the capture phase so the map's
     * own click handler can detect that a marker handled the event
     * (we tag `popupOwner = 'click-marker'` before the map click
     * bubbles, so the layer onClick skips the dismissal branch).
     */
    const markerClick = (ev: Event) => {
      const id = markerIdFromEvent(ev)
      if (id === null) return
      const trigger =
        triggerIndexRef.current.get(shapeKey('marker', id)) ?? 'hover'
      if (trigger !== 'click') return
      const bin = binIndexRef.current.get(`marker:${id}`)
      if (!bin || !hasAnyContent(bin)) return
      const el = (ev.target as HTMLElement).closest('.shape-marker') as HTMLElement | null
      if (!el) return
      ev.stopPropagation()
      const key = shapeKey('marker', id)
      if (overrideRef.current?.('marker', id) === true) {
        if (popupOwner === 'click-marker') dismissPopup()
        return
      }
      if (clickPopupKey === key && popupOwner === 'click-marker') {
        dismissPopup()
        return
      }
      popupOwner = 'click-marker'
      clickPopupKey = key
      setCursor('pointer')
      renderIfChanged(key, bin, 'full', 'marker', id)
      placeAndShow(popupLngLatForElement(el))
    }
    container.addEventListener('mouseover', markerEnter, true)
    container.addEventListener('mouseout', markerLeave, true)
    container.addEventListener('click', markerClick, true)

    return () => {
      map.off('mousemove', onMouseMove)
      map.off('mouseout', clearHoverPopup)
      map.off('click', onClick)
      container.removeEventListener('mouseover', markerEnter, true)
      container.removeEventListener('mouseout', markerLeave, true)
      container.removeEventListener('click', markerClick, true)
      cancelPendingDismiss()
      popup.remove()
      popupOwner = null
      clickPopupKey = null
      popupHovered = false
      setCursor('')
      if (popupRoot) {
        const root = popupRoot
        popupRoot = null
        popupNode = null
        queueMicrotask(() => root.unmount())
      }
    }
    // `enabled` is in deps so flipping it tears down the listeners AND
    // any popup currently displayed (the cleanup above calls
    // `popup.remove()`). Without that, leaving Pan mode with a popup
    // open would strand the popup on screen until the next hover.
  }, [map, enabled, withReferences])

  return null
}
