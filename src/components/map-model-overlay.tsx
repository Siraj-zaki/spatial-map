/**
 * 3D glTF/GLB model overlay — source-driven per-instance variant.
 *
 * Why this changed:
 *   The previous implementation used a single GeoJSON Point source and
 *   one `model` layer per distinct `modelAssetId`, with all per-instance
 *   transforms driven by data expressions over feature properties. That
 *   pattern scales well for "many instances of the same asset" but
 *   *cannot* drive Mapbox's `materialOverrides` / `nodeOverrides` — the
 *   only knobs that expose per-material colour / emissive / metallic /
 *   roughness and per-node rotation / visibility tied to names that
 *   come from the GLB itself. Those overrides only live on
 *   `type: 'model'` source entries, not on layer paint expressions.
 *
 *   So we switched to: ONE `type: 'model'` source PER placed shape,
 *   plus ONE `model` layer per placed shape. The source entry carries
 *   uri / position / materialOverrides / nodeOverrides; the layer's
 *   paint properties carry the per-instance rotation / scale /
 *   translation / global tint. Layer ids keep the
 *   `model-shapes-layer-<shapeId>` prefix so the consumers that filter
 *   by that prefix (`map-image-overlay`, `map-shape-tooltip`,
 *   `map-grid-overlay`) need no changes.
 *
 * Picking and selection:
 *   `queryRenderedFeatures` against a model layer is unreliable at the
 *   pixel level (the mesh is rendered, not the bbox), so we keep the
 *   same 6 px hit buffer the original code used. The hit's layer id
 *   already encodes the shapeId (`model-shapes-layer-<id>`), so we
 *   parse it back without needing a separate hit-test layer.
 */

import {
  buildModelEntry,
  buildModelLayerPaint,
  type ModelEntry,
} from '@/lib/model-generators'
import type { ModelShape } from '@/lib/shapes'
import mapboxgl, {
  type Map as MapboxMapInstance,
  type MapMouseEvent,
} from 'mapbox-gl'
import { useEffect, useMemo, useRef, useState } from 'react'

interface MapModelOverlayProps {
  map: MapboxMapInstance | null
  /** Committed model placements. */
  models?: ReadonlyArray<ModelShape>
  /**
   * `modelAssetId → URL` lookup. Bundled assets resolve to
   * `/models/<slug>/scene.glb`; uploaded ones to a session blob URL
   * (see `model-catalog.ts`). The overlay reads URLs from this map
   * when it builds each shape's `model` source entry.
   */
  urlMap: Record<string, string>
  /**
   * `modelAssetId → bounding-box centre` in local meters. Used to
   * compensate Mapbox's origin-anchored `model-scale` so the visual
   * centre stays put as the user dials scale. Missing entries fall
   * back to the pre-fix behaviour (no compensation).
   */
  boundingCenterMap?: ReadonlyMap<string, [number, number, number]>
  /**
   * `modelAssetId → { min, max }` — the model's full AABB in glTF
   * local coords. When present, the render code anchors the model's
   * BOTTOM at the placement point (bounds.min[1] in glTF Y-up →
   * world Z after Mapbox's Y→Z remap). Without it, we fall back to
   * centre-anchor behaviour — see `buildModelLayerPaint`.
   */
  boundsMap?: ReadonlyMap<
    string,
    { min: [number, number, number]; max: [number, number, number] }
  >
  /**
   * Optional per-shape override bag, keyed by shape id, merged into
   * each shape's render config at build time. This is how the
   * data-link layer pushes Bin.customProperties (status, tintColor,
   * opacity, …) into the per-shape paint without an extra round-trip
   * through React state.
   */
  shapeExtras?: ReadonlyMap<number, Record<string, unknown>>
  /** Cursor coord — when set, renders a ghost model at the cursor. */
  liveCursor?: [number, number] | null
  /** Asset id used by the ghost preview. */
  liveModelId?: string | null
  selectedModelIds?: ReadonlySet<number>
  onModelClick?: (id: number, originalEvent: MouseEvent) => void
  /** Master visibility toggle. */
  committedVisible?: boolean
  /**
   * When false, clicks on models pass through to the map (so a create-*
   * tool can drop a new shape on top of an existing model). Matches the
   * gating used by the marker and polygon overlays.
   */
  selectionEnabled?: boolean
  /**
   * When set, the given model becomes movable on the map. We render a
   * transparent draggable `mapboxgl.Marker` at the model's position and
   * forward drag events through `onTransformChange`. Mapbox's `model`
   * layer isn't draggable on its own — the marker is the actual pointer
   * target. Mirrors the marker overlay's move pattern.
   */
  transformState?: { modelId: number; kind: 'move' } | null
  onTransformChange?: (
    patch: { position?: [number, number] },
    commit: boolean
  ) => void
  /**
   * v5.5 — viewer chip mode for models marked as `facilityShell`.
   *   - `auto`          → shell fades by zoom (its own paint expression)
   *   - `shell-only`    → shell pinned opaque; interior geometry is
   *                       hidden at the host level (this overlay only
   *                       needs to force the shell's paint here)
   *   - `interior-only` → shell pinned transparent
   * Non-shell models ignore this. Defaults to `auto`.
   */
  facilityShellMode?: 'auto' | 'shell-only' | 'interior-only'
}

// ---- Source / layer ids ---------------------------------------------------

/** One source + one layer per placed shape (see file header). */
const SOURCE_PREFIX = 'model-shapes-source-'
const LAYER_PREFIX = 'model-shapes-layer-'
/** Live preview source / layer — only present while the user is placing. */
const PREVIEW_SOURCE = 'model-shapes-preview-source'
const PREVIEW_LAYER = 'model-shapes-preview-layer'

const sourceIdFor = (shapeId: number) => `${SOURCE_PREFIX}${shapeId}`
const layerIdFor = (shapeId: number) => `${LAYER_PREFIX}${shapeId}`

/**
 * Convert a URI to an absolute URL. Mapbox tries to resolve relative
 * model URIs against the *style*'s base URL — which for the Standard
 * style is `mapbox://styles/mapbox/standard`. Resolving `/models/foo.gltf`
 * against `mapbox://...` throws `Failed to construct 'URL': Invalid base
 * URL` and the model silently fails to load. Pinning to `window.location.origin`
 * sidesteps that for bundled assets; blob/http(s) URIs are already absolute.
 */
function toAbsoluteUrl(uri: string): string {
  if (
    uri.startsWith('http://') ||
    uri.startsWith('https://') ||
    uri.startsWith('blob:') ||
    uri.startsWith('data:')
  ) {
    return uri
  }
  if (typeof window === 'undefined') return uri
  try {
    return new URL(uri, window.location.origin).href
  } catch {
    return uri
  }
}

/**
 * Pull the model source from the live style and call `setModels` on
 * it with the single entry for this shape. We always pass the entry as
 * a single-key map because each shape owns one source. Some Mapbox
 * builds expose `setModels`, some don't — fall back to mutating the
 * source's `models` field and triggering a paint via `setSource`-ish
 * APIs as needed.
 */
function setSourceModel(
  map: MapboxMapInstance,
  sourceId: string,
  entry: ModelEntry,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = map.getSource(sourceId) as any
  if (!src) return
  const key = entry.key
  const spec = entry.spec
  const models = { [key]: spec }
  try {
    if (typeof src.setModels === 'function') {
      src.setModels(models)
      return
    }
  } catch {
    /* fall through to direct assignment */
  }
  try {
    src.models = models
    if (typeof src.fire === 'function') {
      // Nudge a re-render — older Mapbox builds rely on the `data`
      // event to repaint a model source.
      src.fire('data', { dataType: 'source', sourceId })
    }
  } catch {
    /* nothing else we can do — the layer will keep the prior frame */
  }
}

/**
 * Renders 3D glTF models. ONE `type: 'model'` source + ONE `model`
 * layer per placed shape. Shapes share the same `model-shapes-layer-`
 * prefix so consumers that look for "any active model layer" via
 * `style.layers.filter(l => l.id.startsWith('model-shapes-layer-'))`
 * continue to work without code changes.
 */
export function MapModelOverlay({
  map,
  models,
  urlMap,
  boundingCenterMap,
  boundsMap,
  shapeExtras,
  liveCursor,
  liveModelId,
  selectedModelIds,
  onModelClick,
  committedVisible = true,
  selectionEnabled = true,
  transformState = null,
  onTransformChange,
  facilityShellMode = 'auto',
}: MapModelOverlayProps) {
  const [styleLoaded, setStyleLoaded] = useState(false)

  // ---- Style readiness (mirrors the image / line overlays) -------------
  useEffect(() => {
    if (!map) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStyleLoaded(false)
      return
    }
    const setReady = () => setStyleLoaded(true)
    if (map.isStyleLoaded()) setReady()
    const interval = setInterval(() => {
      if (map.isStyleLoaded()) {
        setReady()
        clearInterval(interval)
      }
    }, 100)
    map.on('style.load', () => setStyleLoaded(false))
    map.on('style.load', setReady)
    map.on('load', setReady)
    return () => {
      clearInterval(interval)
      map.off('style.load', setReady)
      map.off('load', setReady)
    }
  }, [map])

  // ---- Build per-shape entries ------------------------------------------
  //
  // Each shape gets one ModelEntry — the (key, spec) pair Mapbox's
  // model source consumes — plus its own layer-paint payload. We do
  // this in one pass through `models` so the layer-management effect
  // can render directly from `entries` without re-deriving anything.
  const entries = useMemo(() => {
    const out: Array<{
      shapeId: number
      entry: ModelEntry
      paint: ReturnType<typeof buildModelLayerPaint>
    }> = []
    for (const s of models ?? []) {
      if (s.id === undefined) continue
      if (s.visible === false) continue
      const assetId = s.config.modelAssetId
      if (assetId === undefined) continue
      const uri = urlMap[assetId]
      if (!uri) continue
      const absUri = toAbsoluteUrl(uri)
      const extra = shapeExtras?.get(s.id)
      const center = boundingCenterMap?.get(assetId)
      const shapeBounds = boundsMap?.get(assetId)
      const entry = buildModelEntry(s, absUri, {
        extraProps: extra,
        boundingCenter: center,
      })
      if (!entry) continue
      const paint = buildModelLayerPaint(
        s.config,
        extra,
        center,
        shapeBounds,
        facilityShellMode ?? 'auto',
      )
      out.push({ shapeId: s.id, entry, paint })
    }
    return out
  }, [models, urlMap, boundingCenterMap, boundsMap, shapeExtras, facilityShellMode])

  // Stable key of the shape ids currently rendered — drives the
  // layer-management effect without re-running on noisy upstream
  // re-creates of the `models` array.
  const activeShapeIdsKey = entries.map((e) => e.shapeId).sort((a, b) => a - b).join('|')

  // ---- Source / layer per shape ----------------------------------------
  //
  // Per-shape URI signature that has actually been handed to Mapbox.
  // When a shape's `entry.spec.uri` differs from what's mounted, we
  // MUST do a full remove + re-add of BOTH source AND layer — calling
  // `setSourceModel` (which underneath calls `setModels`) is NOT enough
  // to trigger a fresh GLB fetch. This is the same "type: 'model' URI
  // isn't immediately fetchable" pitfall in docs/pitfalls-frontend.md
  // that originally bit `map-image-plane-overlay.tsx`.
  //
  // Symptom without this: freshly-uploaded small GLBs mount an empty
  // model source; the layer paints nothing at any scale / elevation
  // because Mapbox's model source never fetched the bytes. Toggling
  // visibility off/on "accidentally" fixed it because the toggle tore
  // down + re-added the source, which is what should have happened on
  // first mount.
  const mountedUriRef = useRef<Map<number, string>>(new Map())
  // Per-shape pending retry timeout (single 1000 ms fallback). Cancelled
  // on component unmount OR when the sourcedata listener detects load.
  const pendingRetryRef = useRef<Map<number, ReturnType<typeof setTimeout>[]>>(
    new Map(),
  )
  // Per-shape `sourcedata` listener. Fires when Mapbox reports the model
  // source loaded. More reliable than polling `map.isSourceLoaded()` —
  // that returns false indefinitely for many `type: 'model'` sources
  // even after they've clearly rendered, which was making the retry
  // ladder fire uselessly.
  const pendingListenerRef = useRef<Map<number, (e: unknown) => void>>(
    new Map(),
  )
  useEffect(() => {
    return () => {
      const pending = pendingRetryRef.current
      for (const timers of pending.values()) {
        for (const t of timers) clearTimeout(t)
      }
      pending.clear()
      const listeners = pendingListenerRef.current
      if (map) {
        for (const fn of listeners.values()) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.off('sourcedata', fn as any)
          } catch { /* ignore */ }
        }
      }
      listeners.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!map || !styleLoaded) return

    const wantedSources = new Set(entries.map((e) => sourceIdFor(e.shapeId)))
    const wantedLayers = new Set(entries.map((e) => layerIdFor(e.shapeId)))

    // Remove layers / sources whose shape id is no longer present.
    const allLayers = map.getStyle()?.layers ?? []
    for (const l of allLayers) {
      if (!l.id.startsWith(LAYER_PREFIX)) continue
      if (l.id === PREVIEW_LAYER) continue
      if (!wantedLayers.has(l.id)) {
        try {
          map.removeLayer(l.id)
        } catch {
          /* ignore */
        }
      }
    }
    const style = map.getStyle()
    const sourceIds = style?.sources ? Object.keys(style.sources) : []
    for (const sid of sourceIds) {
      if (!sid.startsWith(SOURCE_PREFIX)) continue
      if (!wantedSources.has(sid)) {
        try {
          map.removeSource(sid)
        } catch {
          /* ignore */
        }
      }
    }
    // Clear stale entries from the mount-signature map for shapes
    // that no longer exist. Also cancel any pending delayed retries
    // for those shapes so the timeout doesn't fire after the shape's
    // source has been removed (would silently re-add a phantom), and
    // detach the sourcedata listener so we don't leak per-shape
    // listeners on the map.
    for (const id of Array.from(mountedUriRef.current.keys())) {
      const sid = sourceIdFor(id)
      if (!wantedSources.has(sid)) {
        mountedUriRef.current.delete(id)
        const pending = pendingRetryRef.current.get(id)
        if (pending) {
          for (const t of pending) clearTimeout(t)
          pendingRetryRef.current.delete(id)
        }
        const listener = pendingListenerRef.current.get(id)
        if (listener) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.off('sourcedata', listener as any)
          } catch { /* ignore */ }
          pendingListenerRef.current.delete(id)
        }
      }
    }

    // Add / update each wanted shape.
    for (const { shapeId, entry, paint } of entries) {
      const sourceId = sourceIdFor(shapeId)
      const layerId = layerIdFor(shapeId)
      const wantedUri = entry.spec.uri
      const mountedUri = mountedUriRef.current.get(shapeId)
      // A full source remount is required when: (a) the source isn't
      // present at all (first-time mount), OR (b) the URI differs from
      // what we last mounted. `setModels` handles paint / rotation /
      // orientation deltas cleanly but does NOT retrigger a GLB fetch
      // when the URI itself changes — Mapbox silently keeps the old
      // (or empty, for first-time) model bytes and the layer renders
      // blank.
      const needsRemount = !map.getSource(sourceId) || mountedUri !== wantedUri
      if (needsRemount) {
        // Tear down first if present. Layer must go before its source.
        try {
          if (map.getLayer(layerId)) map.removeLayer(layerId)
        } catch { /* ignore */ }
        try {
          if (map.getSource(sourceId)) map.removeSource(sourceId)
        } catch { /* ignore */ }
        try {
          map.addSource(sourceId, {
            type: 'model',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            models: { [entry.key]: entry.spec } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any)
          mountedUriRef.current.set(shapeId, wantedUri)
          if (import.meta.env.DEV) {
            console.debug(
              '[map-model-overlay] mounted model source',
              sourceId,
              'uri=', wantedUri,
            )
          }
        } catch (err) {
          console.warn('[map-model-overlay] failed to add model source', sourceId, err)
          continue
        }
      } else {
        setSourceModel(map, sourceId, entry)
      }
      if (!map.getLayer(layerId)) {
        try {
          // Intentionally no `slot:` here, see commit history on the
          // previous implementation — slot 'top' puts models above
          // image-overlay raster layers in the global layer list,
          // breaking the floor-plan-above-models order. Without a slot
          // user layers land at the end of the global list, so mount
          // order drives z-stacking (which is what we want).
          //
          // `model-id` (layout) tells Mapbox WHICH entry in the
          // source's `models` object this layer should render. Per
          // the Mapbox style spec this is the key of the entry (we
          // stamp `entry.key = "shape-${shape.id}"`). Without an
          // explicit model-id, freshly-mounted layers on page refresh
          // silently render nothing — the source has the bytes but
          // the layer can't pick a model out of the collection. On
          // interactive drop the layer sometimes worked because
          // Mapbox fell back to a default; on refresh, that fallback
          // wasn't triggered and the layer stayed blank.
          map.addLayer({
            id: layerId,
            type: 'model',
            source: sourceId,
            layout: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              'model-id': entry.key as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
            paint: paint as unknown as mapboxgl.ModelLayerSpecification['paint'],
          })
          // Force Mapbox to repaint after adding the source + layer.
          // On initial-load conditions (page refresh) the model source
          // sometimes goes silent — Mapbox added it but never issued
          // the HTTP fetch. An explicit triggerRepaint kicks the paint
          // loop, which usually forces the source resolver to run.
          try { map.triggerRepaint() } catch { /* ignore */ }

          // Single-attempt delayed remount + a `sourcedata` listener that
          // short-circuits the retry the moment Mapbox confirms load.
          //
          // Was a two-attempt ladder at 250 ms + 1000 ms with a
          // `map.isSourceLoaded()` short-circuit. Two problems that made
          // the ladder do wasteful work:
          //   1. `isSourceLoaded()` is unreliable for `type: 'model'`
          //      sources — some GLBs (especially when several shapes
          //      share the same GLB file) never report loaded even after
          //      they've clearly rendered, so both retries fired and
          //      each shape ended up with 3 addSource+addLayer cycles.
          //   2. The 250 ms retry was too eager — it aborted slow-but-
          //      legitimate GLB fetches that were still in flight.
          //
          // The new shape: register a `sourcedata` listener that flips
          // `sourceLoaded=true` when Mapbox emits `isSourceLoaded: true`
          // for this source id, and immediately cancels the pending retry.
          // The single 1000 ms retry only fires if the listener hasn't
          // heard from Mapbox by then — i.e. the genuine silent-fail case
          // the ladder was originally designed for.
          const retryShapeId = shapeId
          const retryEntry = entry
          const retrySourceId = sourceId
          const retryLayerId = layerId
          const retryPaint = paint
          const retryUri = wantedUri
          const prevTimers = pendingRetryRef.current.get(retryShapeId)
          if (prevTimers) for (const t of prevTimers) clearTimeout(t)
          const prevListener = pendingListenerRef.current.get(retryShapeId)
          if (prevListener) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              map.off('sourcedata', prevListener as any)
            } catch { /* ignore */ }
            pendingListenerRef.current.delete(retryShapeId)
          }

          let sourceLoaded = false
          const detachListener = () => {
            const fn = pendingListenerRef.current.get(retryShapeId)
            if (!fn) return
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              map.off('sourcedata', fn as any)
            } catch { /* ignore */ }
            pendingListenerRef.current.delete(retryShapeId)
          }
          const cancelRetry = () => {
            const timers = pendingRetryRef.current.get(retryShapeId)
            if (timers) {
              for (const t of timers) clearTimeout(t)
              pendingRetryRef.current.delete(retryShapeId)
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const onSourceData = (e: any) => {
            if (e?.dataType !== 'source') return
            if (e?.sourceId !== retrySourceId) return
            if (!e?.isSourceLoaded) return
            sourceLoaded = true
            cancelRetry()
            detachListener()
            if (import.meta.env.DEV) {
              console.debug(
                '[map-model-overlay] sourcedata confirmed load',
                retryShapeId,
              )
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map.on('sourcedata', onSourceData as any)
          pendingListenerRef.current.set(retryShapeId, onSourceData)

          const doRemount = (label: string) => {
            if (sourceLoaded) return
            let alreadyLoaded = false
            try {
              alreadyLoaded = map.isSourceLoaded(retrySourceId)
            } catch { /* ignore */ }
            if (alreadyLoaded) {
              sourceLoaded = true
              cancelRetry()
              detachListener()
              if (import.meta.env.DEV) {
                console.debug(
                  `[map-model-overlay] ${label} skipped (isSourceLoaded=true)`,
                  retryShapeId,
                )
              }
              return
            }
            detachListener()
            try {
              if (map.getLayer(retryLayerId)) {
                map.removeLayer(retryLayerId)
              }
              if (map.getSource(retrySourceId)) {
                map.removeSource(retrySourceId)
              }
              map.addSource(retrySourceId, {
                type: 'model',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                models: { [retryEntry.key]: retryEntry.spec } as any,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any)
              map.addLayer({
                id: retryLayerId,
                type: 'model',
                source: retrySourceId,
                layout: {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  'model-id': retryEntry.key as any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
                paint: retryPaint as unknown as mapboxgl.ModelLayerSpecification['paint'],
              })
              try { map.triggerRepaint() } catch { /* ignore */ }
              mountedUriRef.current.set(retryShapeId, retryUri)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              map.on('sourcedata', onSourceData as any)
              pendingListenerRef.current.set(retryShapeId, onSourceData)
              if (import.meta.env.DEV) {
                console.debug(
                  `[map-model-overlay] ${label} full remount`,
                  retryShapeId,
                  'uri=', retryUri,
                )
              }
            } catch (err) {
              if (import.meta.env.DEV) {
                console.debug(
                  `[map-model-overlay] ${label} remount failed`,
                  retryShapeId,
                  err,
                )
              }
            }
          }

          const t1 = setTimeout(() => doRemount('t=1000ms'), 1000)
          pendingRetryRef.current.set(retryShapeId, [t1])
        } catch (err) {
          console.warn('[map-model-overlay] failed to add model layer', layerId, err)
          continue
        }
      } else {
        // Repaint properties whenever the per-shape paint changed —
        // rotation, scale, translation, tint, etc. setPaintProperty's
        // overload is strictly typed against the union of every paint
        // property name across every layer type. Our `paint` object is
        // a ModelLayerPaint subset of that union, but TS can't narrow
        // through Object.entries — cast at the call site.
        for (const [k, v] of Object.entries(paint)) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.setPaintProperty(layerId, k as any, v as any)
          } catch {
            /* ignore — some properties only exist on newer Mapbox builds */
          }
        }
      }
      // Master visibility — flip every layer at once.
      try {
        map.setLayoutProperty(
          layerId,
          'visibility',
          committedVisible ? 'visible' : 'none',
        )
      } catch {
        /* ignore */
      }
    }
  }, [map, styleLoaded, entries, activeShapeIdsKey, committedVisible])

  // ---- Live preview (ghost at cursor) -----------------------------------
  //
  // One source + one layer max — torn down and rebuilt when the live
  // asset id changes, in-place when only the cursor moves.
  const previewEntry = useMemo(() => {
    if (!liveCursor || !liveModelId) return null
    const uri = urlMap[liveModelId]
    if (!uri) return null
    return {
      key: 'preview',
      spec: {
        uri: toAbsoluteUrl(uri),
        position: liveCursor,
        orientation: [0, 0, 0] as [number, number, number],
      },
    }
  }, [liveCursor, liveModelId, urlMap])

  // We track the previously-mounted preview asset id so a swap can tear
  // down the old layer (the layer is mounted with the asset's URI
  // baked into the source entry — only `setModels` updates without a
  // rebuild are cheap, but if the asset changed entirely we redo the
  // mount so any per-asset paint defaults reset).
  const previewMountedAssetRef = useRef<string | null>(null)

  useEffect(() => {
    if (!map || !styleLoaded) return
    // Tear down when there's no preview to show.
    if (!previewEntry) {
      if (map.getLayer(PREVIEW_LAYER)) {
        try { map.removeLayer(PREVIEW_LAYER) } catch { /* ignore */ }
      }
      if (map.getSource(PREVIEW_SOURCE)) {
        try { map.removeSource(PREVIEW_SOURCE) } catch { /* ignore */ }
      }
      previewMountedAssetRef.current = null
      return
    }
    const assetChanged = previewMountedAssetRef.current !== liveModelId
    // Re-mount when the asset switched, otherwise nudge the entry
    // in-place — cheap and avoids the GLB re-fetch.
    if (assetChanged) {
      if (map.getLayer(PREVIEW_LAYER)) {
        try { map.removeLayer(PREVIEW_LAYER) } catch { /* ignore */ }
      }
      if (map.getSource(PREVIEW_SOURCE)) {
        try { map.removeSource(PREVIEW_SOURCE) } catch { /* ignore */ }
      }
    }
    if (!map.getSource(PREVIEW_SOURCE)) {
      try {
        map.addSource(PREVIEW_SOURCE, {
          type: 'model',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          models: { [previewEntry.key]: previewEntry.spec } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
      } catch (err) {
        console.warn('[map-model-overlay] failed to add preview source', err)
        return
      }
    } else {
      setSourceModel(map, PREVIEW_SOURCE, previewEntry)
    }
    if (!map.getLayer(PREVIEW_LAYER)) {
      try {
        map.addLayer({
          id: PREVIEW_LAYER,
          type: 'model',
          source: PREVIEW_SOURCE,
          layout: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            'model-id': previewEntry.key as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          paint: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            'model-opacity': 0.45 as any,
            // Same v3 shadow stack the committed model layer enables —
            // keeps the placement preview grounded so the user sees
            // exactly how the model will look once placed.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['model-cast-shadows' as any]: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ['model-receive-shadows' as any]: true,
          },
        })
      } catch (err) {
        console.warn('[map-model-overlay] failed to add preview layer', err)
      }
    }
    previewMountedAssetRef.current = liveModelId ?? null
  }, [map, styleLoaded, previewEntry, liveModelId])

  // ---- Click selection ---------------------------------------------------
  // Keep the click callback in a ref so we don't re-bind on every render.
  const onModelClickRef = useRef(onModelClick)
  useEffect(() => {
    onModelClickRef.current = onModelClick
  }, [onModelClick])
  const selectionEnabledRef = useRef(selectionEnabled)
  useEffect(() => {
    selectionEnabledRef.current = selectionEnabled
  }, [selectionEnabled])

  useEffect(() => {
    if (!map || !styleLoaded) return
    if (entries.length === 0) return

    // Mapbox's `model` layer is a 3D mesh layer — click hit-testing
    // via `map.on('click', layerId)` is unreliable at oblique pitches
    // and mid-zoom because the rendered footprint doesn't always
    // match what `queryRenderedFeatures` returns for a model. So we
    // listen on the whole canvas and run a combined query against
    // every per-shape model layer at the click point, with a small
    // pixel buffer so the user doesn't have to land their click
    // pixel-perfect on the mesh.
    const layerIds = entries
      .map((e) => layerIdFor(e.shapeId))
      .filter((id) => map.getLayer(id))

    const HIT_BUFFER = 6 // px

    const shapeIdFromLayer = (layerId: string): number | undefined => {
      if (!layerId.startsWith(LAYER_PREFIX)) return undefined
      const tail = layerId.slice(LAYER_PREFIX.length)
      const n = Number(tail)
      return Number.isFinite(n) ? n : undefined
    }

    const onClick = (e: MapMouseEvent) => {
      if (!selectionEnabledRef.current) return
      if (e.defaultPrevented) return
      const bbox: [[number, number], [number, number]] = [
        [e.point.x - HIT_BUFFER, e.point.y - HIT_BUFFER],
        [e.point.x + HIT_BUFFER, e.point.y + HIT_BUFFER],
      ]
      let hits: GeoJSON.Feature[]
      try {
        hits = map.queryRenderedFeatures(bbox, { layers: layerIds })
      } catch {
        return
      }
      if (hits.length === 0) return
      const f = hits[0] as GeoJSON.Feature & { layer?: { id?: string } }
      const layerId = f.layer?.id ?? ''
      const shapeId = shapeIdFromLayer(layerId)
      if (typeof shapeId !== 'number') return
      // Claim the click on BOTH the Mapbox event and the underlying DOM
      // event. Other overlays (grid, image, etc.) inspect
      // `e.originalEvent?.defaultPrevented` to decide whether to fire
      // their own "empty click → deselect" path. Without the DOM-level
      // preventDefault, those overlays would still see false and call
      // `onMapClickEmpty`, wiping the selection we just made.
      e.preventDefault()
      e.originalEvent?.preventDefault?.()
      onModelClickRef.current?.(shapeId, e.originalEvent as MouseEvent)
    }

    const onMove = (e: MapMouseEvent) => {
      if (!selectionEnabledRef.current) return
      const bbox: [[number, number], [number, number]] = [
        [e.point.x - HIT_BUFFER, e.point.y - HIT_BUFFER],
        [e.point.x + HIT_BUFFER, e.point.y + HIT_BUFFER],
      ]
      let hits: GeoJSON.Feature[]
      try {
        hits = map.queryRenderedFeatures(bbox, { layers: layerIds })
      } catch {
        return
      }
      // Don't override an active create-tool's crosshair cursor.
      if (map.getCanvas().style.cursor === 'crosshair') return
      map.getCanvas().style.cursor = hits.length > 0 ? 'pointer' : ''
    }

    map.on('click', onClick)
    map.on('mousemove', onMove)
    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
    }
  }, [map, styleLoaded, activeShapeIdsKey, entries])

  // ---- Selection highlight ----------------------------------------------
  //
  // We can't put an outline directly on a `model` layer (it's a 3D
  // mesh, not a polygon). With one layer per shape we can bump that
  // layer's emissive strength to communicate selection without
  // disturbing other shapes' lighting.
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const { shapeId, paint } of entries) {
      const layerId = layerIdFor(shapeId)
      if (!map.getLayer(layerId)) continue
      const baseEmissive =
        (paint['model-emissive-strength'] as number | undefined) ?? 0
      const isSelected = selectedModelIds?.has(shapeId) ?? false
      try {
        map.setPaintProperty(
          layerId,
          'model-emissive-strength',
          isSelected ? Math.max(baseEmissive, 1.5) : baseEmissive,
        )
      } catch {
        /* ignore */
      }
    }
  }, [map, styleLoaded, entries, selectedModelIds])

  // ---- Move handle ------------------------------------------------------
  // When `transformState.kind === 'move'`, we attach a draggable
  // `mapboxgl.Marker` at the model's position. The marker is the actual
  // pointer target (the model layer itself can't be dragged) but it
  // shows up as a small grab-handle dot above the model so the user can
  // see what they're grabbing. drag → live patch via
  // `onTransformChange`; dragend → commit.
  //
  // IMPORTANT: this effect only depends on `map` and `transformState` —
  // *not* on `models`. The reason: during a drag, the parent's
  // onTransformChange callback updates a draft state which re-computes
  // the `models` array. If `models` were in the dep list, the effect
  // would tear down the marker the user is currently dragging and
  // create a fresh one on each frame, producing exactly the "drag a
  // tiny bit then stops" behaviour. We snapshot the model position
  // through a ref so the initial attachment uses the latest position,
  // but subsequent drag updates leave the marker untouched.
  const onTransformChangeRef = useRef(onTransformChange)
  useEffect(() => {
    onTransformChangeRef.current = onTransformChange
  }, [onTransformChange])

  const modelsRef = useRef(models)
  useEffect(() => {
    modelsRef.current = models
  }, [models])

  useEffect(() => {
    if (!map) return
    if (!transformState || transformState.kind !== 'move') return
    const model = (modelsRef.current ?? []).find(
      (m) => m.id === transformState.modelId
    )
    if (!model || model.id === undefined) return

    const el = document.createElement('div')
    el.className = 'model-move-handle'
    el.style.width = '18px'
    el.style.height = '18px'
    el.style.borderRadius = '9999px'
    el.style.background = 'rgba(245, 158, 11, 0.95)'
    el.style.border = '2px solid white'
    el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)'
    el.style.cursor = 'grab'

    const handle = new mapboxgl.Marker({
      element: el,
      anchor: 'center',
      draggable: true,
    })
      .setLngLat(model.position)
      .addTo(map)

    // Bypass React state during drag. Rewriting the source spec via
    // `setSourceModel` on the transforming model's Mapbox source
    // updates its `model-translation` without touching the store — so
    // the parent's `modelsForOverlay` memo stays reference-stable and
    // the shared `entries` memo + layer effect (which loop every model
    // on every change) don't fire during the drag. Only dragend fires
    // the parent commit path, which triggers ONE final rebuild.
    //
    // RAF coalescing caps the model-source updates at 60 fps even when
    // Mapbox's marker `drag` event fires at pointer rate.
    const sourceId = sourceIdFor(model.id)
    const originalModel = model
    let pendingLngLat: [number, number] | null = null
    let rafId = 0

    const flushDrag = () => {
      rafId = 0
      if (!pendingLngLat) return
      const nextPos = pendingLngLat
      pendingLngLat = null
      // Rebuild the spec at the new position; keep everything else
      // (uri, orientation, scale, config) identical so Mapbox doesn't
      // re-fetch the GLB.
      const assetId = originalModel.config.modelAssetId
      if (assetId === undefined) return
      const uri = urlMap[assetId]
      if (!uri) return
      const absUri = toAbsoluteUrl(uri)
      const extra = shapeExtras?.get(originalModel.id!)
      const boundingCenter = boundingCenterMap?.get(assetId)
      const patchedModel: ModelShape = { ...originalModel, position: nextPos }
      const entry = buildModelEntry(patchedModel, absUri, {
        extraProps: extra,
        boundingCenter,
      })
      if (!entry) return
      try {
        setSourceModel(map, sourceId, entry)
      } catch { /* ignore transient style teardown */ }
    }
    const scheduleFlush = () => {
      if (rafId !== 0) return
      rafId = requestAnimationFrame(flushDrag)
    }

    const onDragStart = () => {
      el.style.cursor = 'grabbing'
    }
    const onDrag = () => {
      const ll = handle.getLngLat()
      pendingLngLat = [ll.lng, ll.lat]
      scheduleFlush()
    }
    const onDragEnd = () => {
      el.style.cursor = 'grab'
      const ll = handle.getLngLat()
      if (rafId !== 0) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      pendingLngLat = null
      onTransformChangeRef.current?.(
        { position: [ll.lng, ll.lat] },
        true
      )
    }

    handle.on('dragstart', onDragStart)
    handle.on('drag', onDrag)
    handle.on('dragend', onDragEnd)

    return () => {
      try {
        handle.off('dragstart', onDragStart)
        handle.off('drag', onDrag)
        handle.off('dragend', onDragEnd)
      } catch {
        /* ignore */
      }
      if (rafId !== 0) cancelAnimationFrame(rafId)
      pendingLngLat = null
      handle.remove()
    }
  }, [map, transformState, urlMap, shapeExtras, boundingCenterMap])

  // ---- Teardown ----------------------------------------------------------
  useEffect(() => {
    return () => {
      if (!map) return
      try {
        const allLayers = map.getStyle()?.layers ?? []
        for (const l of allLayers) {
          if (l.id.startsWith(LAYER_PREFIX) || l.id === PREVIEW_LAYER) {
            map.removeLayer(l.id)
          }
        }
        const sourceIds = Object.keys(map.getStyle()?.sources ?? {})
        for (const sid of sourceIds) {
          if (sid.startsWith(SOURCE_PREFIX) || sid === PREVIEW_SOURCE) {
            map.removeSource(sid)
          }
        }
      } catch {
        /* ignore */
      }
    }
  }, [map])

  return null
}
