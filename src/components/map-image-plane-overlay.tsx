/**
 * Image-plane overlay — renders user-placed image planes as Mapbox
 * `model` layers. A textured-plane GLB is synthesised at runtime from
 * the image bytes (see `lib/image-plane-generators.ts`) and handed to
 * Mapbox via a `type: 'model'` source — one source + one layer per
 * placed shape, mirroring the 3D model overlay pattern.
 *
 * Storage:
 *   - Each `ImagePlaneShape` stores the image URL + 3D transforms in
 *     `config` (width, height, elevation, rotation, opacity, color).
 *   - The plane GLB is *not* stored; we regenerate it client-side when
 *     the image URL changes. A plane is ~1 KB so the work is trivial.
 *
 * Selection:
 *   `queryRenderedFeatures` is unreliable on the `model` layer at the
 *   pixel level, so we use the same 6 px hit buffer the model overlay
 *   uses. The hit's layer id encodes the shape id (see `LAYER_PREFIX`).
 */

import {
  buildImagePlaneEntry,
  buildImagePlaneLayerPaint,
  createImagePlaneGlb,
  glbUint8ToBlobUrl,
} from '@/lib/image-plane-generators'
import type { ImagePlaneShape } from '@/lib/shapes'
import mapboxgl, {
  type Map as MapboxMapInstance,
  type MapMouseEvent,
  type ModelLayerSpecification,
  type PointLike,
} from 'mapbox-gl'
import { useEffect, useMemo, useRef, useState } from 'react'

interface MapImagePlaneOverlayProps {
  map: MapboxMapInstance | null
  imagePlanes?: ReadonlyArray<ImagePlaneShape>
  selectedImagePlaneIds?: ReadonlySet<number>
  onImagePlaneClick?: (id: number, originalEvent: MouseEvent) => void
  onMapClickEmpty?: () => void
  committedVisible?: boolean
  selectionEnabled?: boolean
  /**
   * When set, the given plane becomes movable on the map. A draggable
   * `mapboxgl.Marker` is attached at the plane's anchor and drag events
   * are forwarded through `onTransformChange`. Mirrors the model
   * overlay's move pattern — the marker is the pointer target since
   * Mapbox `model` layers aren't directly draggable.
   */
  transformState?: { imagePlaneId: number; kind: 'move' } | null
  onTransformChange?: (
    patch: { position?: [number, number] },
    commit: boolean,
  ) => void
}

const SOURCE_PREFIX = 'image-plane-source-'
const LAYER_PREFIX = 'image-plane-layer-'

const sourceIdFor = (shapeId: number) => `${SOURCE_PREFIX}${shapeId}`
const layerIdFor = (shapeId: number) => `${LAYER_PREFIX}${shapeId}`

const HIT_BUFFER_PX = 6

/**
 * Cache entry — the synthesised GLB plus the source image URL that
 * generated it. We re-synthesise when the URL changes; otherwise the
 * blob URL is stable for the session.
 */
interface GlbCacheEntry {
  imageUrl: string
  blobUrl: string
}

export function MapImagePlaneOverlay({
  map,
  imagePlanes,
  selectedImagePlaneIds,
  onImagePlaneClick,
  onMapClickEmpty,
  committedVisible = true,
  selectionEnabled = true,
  transformState = null,
  onTransformChange,
}: MapImagePlaneOverlayProps) {
  const [styleLoaded, setStyleLoaded] = useState(false)
  // Re-render tick — bumped after a GLB finishes synthesising so the
  // entries-building useMemo sees the newly populated cache.
  const [glbTick, setGlbTick] = useState(0)

  // shapeId → { imageUrl, blobUrl } cache. Holds GLBs synthesised from
  // each image. Outlives the entries memo so re-renders reuse, not
  // re-fetch.
  const glbCacheRef = useRef<Map<number, GlbCacheEntry>>(new Map())
  // shapeIds currently mid-fetch — avoids dispatching duplicate
  // `createImagePlaneGlb` calls when the entries memo re-runs while a
  // prior fetch is still pending.
  const pendingRef = useRef<Set<number>>(new Set())
  // Only true after the component fully unmounts. Used by in-flight
  // GLB fetches so their resolution never writes to a cache that's
  // about to be torn down (or leaks a fresh blob URL past the unmount
  // cleanup). Not toggled between effect re-runs — see the GLB synth
  // effect for why using per-effect-run cancellation here would orphan
  // shapes.
  const unmountedRef = useRef(false)

  // ---- Style readiness (mirrors stair / polygon overlays) --------------
  useEffect(() => {
    if (!map) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStyleLoaded(false)
      return
    }
    const setReady = () => setStyleLoaded(true)
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

  // ---- Kick off / refresh GLB synthesis ---------------------------------
  //
  // Walk the planes, and for any whose image URL we haven't synthesised
  // yet (or whose URL changed), fire off `createImagePlaneGlb`. When a
  // fetch resolves we update the cache and bump `glbTick` so the entries
  // memo re-runs.
  //
  // Deliberately NO per-effect-run cancellation: `imagePlanes` reference
  // routinely changes on parent re-renders that DON'T change the shape's
  // image URL (e.g. `hiddenFloorPlanIds` recomputes when a floor plan
  // toggles). A cancel-on-cleanup would fire between "fetch kicked off"
  // and "fetch resolved", the new effect run would see `pendingRef` still
  // holding the shape id and skip re-firing, then the in-flight fetch
  // would resolve, see `cancelled=true`, bail without writing the cache,
  // and clear `pendingRef` in its `.finally`. Net effect: no cache, no
  // `glbTick` bump, no in-flight fetch — the shape stays unrendered until
  // some future render happens to change `imagePlanes` reference AGAIN
  // when no fetch is in flight. Matches the "plane doesn't appear until I
  // hide/unhide another layer" symptom.
  //
  // Instead, let every fetch run to completion + populate the cache. The
  // `imageUrl === cached.imageUrl` skip at the top of the loop handles
  // re-runs; `pendingRef` handles duplicates. Only skip the cache write
  // if the component itself has unmounted.
  useEffect(() => {
    for (const plane of imagePlanes ?? []) {
      if (plane.id === undefined) continue
      if (!plane.imageUrl) continue
      const cached = glbCacheRef.current.get(plane.id)
      if (cached && cached.imageUrl === plane.imageUrl) continue
      if (pendingRef.current.has(plane.id)) continue
      pendingRef.current.add(plane.id)
      // Snapshot fields off `plane` — the loop variable is captured by
      // the async callback and the shape's config can mutate before the
      // fetch resolves.
      const targetId = plane.id
      const targetUrl = plane.imageUrl
      if (import.meta.env.DEV) {
        console.debug(
          '[map-image-plane-overlay] GLB synth start',
          'shape=', targetId,
          'imageUrl=', targetUrl,
        )
      }
      createImagePlaneGlb(plane.imageUrl, plane.mimeType)
        .then((bytes) => {
          if (unmountedRef.current) return
          const prev = glbCacheRef.current.get(targetId)
          // If a newer fetch (different imageUrl) already populated the
          // cache while we were in flight, don't clobber it with our
          // stale bytes.
          if (prev && prev.imageUrl !== targetUrl) return
          if (prev) {
            try { URL.revokeObjectURL(prev.blobUrl) } catch { /* ignore */ }
          }
          const blobUrl = glbUint8ToBlobUrl(bytes)
          glbCacheRef.current.set(targetId, {
            imageUrl: targetUrl,
            blobUrl,
          })
          if (import.meta.env.DEV) {
            console.debug(
              '[map-image-plane-overlay] GLB synth done',
              'shape=', targetId,
              'blobUrl=', blobUrl,
            )
          }
          setGlbTick((t) => t + 1)
        })
        .catch((err) => {
          console.warn('[map-image-plane-overlay] GLB synthesis failed', err)
        })
        .finally(() => {
          pendingRef.current.delete(targetId)
        })
    }
  }, [imagePlanes])

  // Mark unmounted + revoke any blob URLs on unmount.
  //
  // Reset `unmountedRef.current = false` on EVERY mount pass — including
  // React Strict Mode's synthetic re-mount. Strict Mode runs
  //   mount → cleanup → mount
  // in dev; if we only set the ref to true in cleanup, the second
  // "real" mount inherits `true` from the fake cleanup and every
  // in-flight GLB fetch resolves into the early-return branch, so the
  // cache never populates and the layer effect never sees any entries.
  // The symptom is identical to the original per-effect-run
  // cancellation bug: fetches start (`GLB synth start` logs fire), no
  // fetch reports done, planes stay invisible.
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      for (const entry of glbCacheRef.current.values()) {
        try { URL.revokeObjectURL(entry.blobUrl) } catch { /* ignore */ }
      }
      glbCacheRef.current.clear()
    }
  }, [])

  // ---- Build per-shape entries ------------------------------------------
  const entries = useMemo(() => {
    // Reference glbTick so the memo re-runs after a fetch finishes.
    void glbTick
    const out: Array<{
      shapeId: number
      entry: ReturnType<typeof buildImagePlaneEntry>
      paint: ReturnType<typeof buildImagePlaneLayerPaint>
    }> = []
    for (const s of imagePlanes ?? []) {
      if (s.id === undefined) continue
      if (s.visible === false) continue
      // eslint-disable-next-line react-hooks/refs -- latest-value ref, read/written outside effects intentionally
      const cached = glbCacheRef.current.get(s.id)
      if (!cached || cached.imageUrl !== s.imageUrl) continue
      const entry = buildImagePlaneEntry(s, cached.blobUrl)
      if (!entry) continue
      const paint = buildImagePlaneLayerPaint(s.config)
      out.push({ shapeId: s.id, entry, paint })
    }
    return out
  }, [imagePlanes, glbTick])

  const activeShapeIdsKey = entries.map((e) => e.shapeId).sort((a, b) => a - b).join('|')

  // Tracks the GLB URL each shape's source is currently mounted with.
  // When the synthesised URL for a shape changes (e.g. the GLB just
  // finished synthesising on page load), we force-remount that shape's
  // source + layer instead of trying to update the existing one in place
  // — Mapbox's model source has a known race where an `addSource` whose
  // model URI isn't immediately fetchable silently leaves the layer blank
  // until the source is explicitly re-mounted. Without this, the plane
  // stays invisible after refresh and only appears once the user toggles
  // visibility off/on (which incidentally tears down + recreates the
  // source).
  const mountedUriRef = useRef<Map<number, string>>(new Map())
  // Single-attempt delayed remount fallback — recovers from the
  // documented Mapbox race where a `type: 'model'` source silently drops
  // its URI fetch when the map is already idle at mount time.
  //
  // We schedule ONE timer at 1000 ms (was 250 ms + 1000 ms). The 250 ms
  // was too eager — it aborted slow-but-legitimate fetches. And the
  // `sourcedata` event listener below cancels the 1000 ms timer as soon
  // as Mapbox reports the source loaded, so the happy path is a single
  // add-source + add-layer per shape.
  const pendingRetryRef = useRef<Map<number, ReturnType<typeof setTimeout>[]>>(
    new Map(),
  )
  // Per-shape `sourcedata` listener. Fires with `isSourceLoaded: true`
  // when Mapbox finishes fetching the GLB. More reliable than polling
  // `map.isSourceLoaded()` — that polling call returns false indefinitely
  // for many `type: 'model'` sources even after they've clearly rendered,
  // which was making the retry ladder fire uselessly.
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
    // We intentionally close over `map` at mount time — the outer
    // <MapImagePlaneOverlay> stays mounted for the map's lifetime, and
    // `map` is stable across renders once styleLoaded flips true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Manage Mapbox sources + layers ----------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) {
      if (import.meta.env.DEV) {
        console.debug(
          '[map-image-plane-overlay] layer effect skipped',
          'map=', !!map,
          'styleLoaded=', styleLoaded,
        )
      }
      return
    }
    if (import.meta.env.DEV) {
      console.debug(
        '[map-image-plane-overlay] layer effect running',
        'entries=', entries.length,
        'imagePlanes=', imagePlanes?.length ?? 0,
        'glbCache=', glbCacheRef.current.size,
      )
    }

    const wantedSources = new Set(entries.map((e) => sourceIdFor(e.shapeId)))
    const wantedLayers = new Set(entries.map((e) => layerIdFor(e.shapeId)))

    const allLayers = map.getStyle()?.layers ?? []
    for (const l of allLayers) {
      if (!l.id.startsWith(LAYER_PREFIX)) continue
      if (!wantedLayers.has(l.id)) {
        try { map.removeLayer(l.id) } catch { /* ignore */ }
      }
    }
    const style = map.getStyle()
    const sourceIds = style?.sources ? Object.keys(style.sources) : []
    for (const sid of sourceIds) {
      if (!sid.startsWith(SOURCE_PREFIX)) continue
      if (!wantedSources.has(sid)) {
        try { map.removeSource(sid) } catch { /* ignore */ }
      }
    }
    // Drop bookkeeping for shapes that are no longer present. Also
    // cancel any pending retries so a timeout doesn't fire after the
    // shape's source has been torn down, and detach the sourcedata
    // listener so we don't leak per-shape listeners on the map.
    for (const id of [...mountedUriRef.current.keys()]) {
      if (!wantedSources.has(sourceIdFor(id))) {
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

    for (const { shapeId, entry, paint } of entries) {
      if (!entry) continue
      const sourceId = sourceIdFor(shapeId)
      const layerId = layerIdFor(shapeId)
      const newUri = String(entry.spec.uri)
      const mountedUri = mountedUriRef.current.get(shapeId)
      const uriChanged = mountedUri !== newUri

      // If the model URI changed (or this is the first mount), force a
      // clean remove + re-add so Mapbox actually re-fetches the GLB.
      if (uriChanged) {
        try { if (map.getLayer(layerId)) map.removeLayer(layerId) } catch { /* ignore */ }
        try { if (map.getSource(sourceId)) map.removeSource(sourceId) } catch { /* ignore */ }
      }

      if (!map.getSource(sourceId)) {
        try {
          map.addSource(sourceId, {
            type: 'model',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            models: { [entry.key]: entry.spec } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any)
          mountedUriRef.current.set(shapeId, newUri)
          if (import.meta.env.DEV) {
            console.debug(
              '[map-image-plane-overlay] mounted model source',
              sourceId,
              'uri=', newUri,
            )
          }
        } catch (err) {
          console.warn('[map-image-plane-overlay] failed to add source', sourceId, err)
          continue
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const src = map.getSource(sourceId) as any
        try {
          if (typeof src?.setModels === 'function') {
            src.setModels({ [entry.key]: entry.spec })
          } else if (src) {
            src.models = { [entry.key]: entry.spec }
          }
        } catch { /* ignore */ }
      }
      if (!map.getLayer(layerId)) {
        try {
          // `model-id` (layout, required per the Mapbox spec) tells
          // the layer WHICH entry in the source's `models` object to
          // render. We stamp `entry.key` on both the source dict and
          // the layer. Without this, freshly-mounted layers on page
          // refresh silently render nothing — the source has the
          // bytes but the layer can't pick a model out of it.
          map.addLayer({
            id: layerId,
            type: 'model',
            source: sourceId,
            layout: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              'model-id': entry.key as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
            paint: paint as unknown as ModelLayerSpecification['paint'],
          })
          // Nudge Mapbox to repaint so the source resolver runs even
          // if the map was idle when we called addSource above.
          try { map.triggerRepaint() } catch { /* ignore */ }

          // Single-attempt delayed remount + a `sourcedata` listener that
          // short-circuits the retry the moment Mapbox confirms load.
          //
          // Was a two-attempt ladder at 250 ms + 1000 ms with a
          // `map.isSourceLoaded()` short-circuit. Two problems that made
          // the ladder do wasteful work:
          //   1. `isSourceLoaded()` is unreliable for `type: 'model'`
          //      sources — some GLBs never report loaded even after
          //      they've clearly rendered, so both retries fired and each
          //      shape ended up with 3 addSource+addLayer cycles.
          //   2. The 250 ms retry was too eager — it aborted slow-but-
          //      legitimate GLB fetches that were still in flight.
          //
          // The new shape: register a `sourcedata` listener that flips
          // `sourceLoaded=true` when Mapbox emits `isSourceLoaded: true`
          // for this source id, and immediately cancels the pending retry.
          // The single 1000 ms retry only fires if the listener hasn't
          // heard from Mapbox by then — i.e. genuine silent-fail case.
          const retryShapeId = shapeId
          const retryEntry = entry
          const retrySourceId = sourceId
          const retryLayerId = layerId
          const retryPaint = paint
          const retryUri = newUri
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
                '[map-image-plane-overlay] sourcedata confirmed load',
                retryShapeId,
              )
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map.on('sourcedata', onSourceData as any)
          pendingListenerRef.current.set(retryShapeId, onSourceData)

          const doRemount = (label: string) => {
            if (sourceLoaded) return
            // Belt-and-suspenders: sometimes the `sourcedata` event is
            // missed (e.g. fired before our listener attached). Fall back
            // to the polled check.
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
                  `[map-image-plane-overlay] ${label} skipped (isSourceLoaded=true)`,
                  retryShapeId,
                )
              }
              return
            }
            // Genuine silent-fail case — do the full remount and re-arm
            // both the listener (for the new attempt's load event) and
            // let the caller know via logs.
            detachListener()
            try {
              if (map.getLayer(retryLayerId)) map.removeLayer(retryLayerId)
              if (map.getSource(retrySourceId)) map.removeSource(retrySourceId)
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
                paint: retryPaint as unknown as ModelLayerSpecification['paint'],
              })
              try { map.triggerRepaint() } catch { /* ignore */ }
              mountedUriRef.current.set(retryShapeId, retryUri)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              map.on('sourcedata', onSourceData as any)
              pendingListenerRef.current.set(retryShapeId, onSourceData)
              if (import.meta.env.DEV) {
                console.debug(
                  `[map-image-plane-overlay] ${label} full remount`,
                  retryShapeId,
                  'uri=', retryUri,
                )
              }
            } catch (err) {
              if (import.meta.env.DEV) {
                console.debug(
                  `[map-image-plane-overlay] ${label} remount failed`,
                  retryShapeId,
                  err,
                )
              }
            }
          }
          const t1 = setTimeout(() => doRemount('t=1000ms'), 1000)
          pendingRetryRef.current.set(retryShapeId, [t1])
        } catch (err) {
          console.warn('[map-image-plane-overlay] failed to add layer', layerId, err)
          continue
        }
      } else {
        for (const [k, v] of Object.entries(paint)) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.setPaintProperty(layerId, k as any, v as any)
          } catch { /* ignore */ }
        }
      }
      try {
        map.setLayoutProperty(
          layerId,
          'visibility',
          committedVisible ? 'visible' : 'none',
        )
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, entries, activeShapeIdsKey, committedVisible])

  // ---- Selection outline ------------------------------------------------
  //
  // Mapbox model layers don't expose a selection outline natively. We
  // dial the emissive on selected planes (mirrors the model overlay's
  // selection style) so they pop subtly without changing the texture.
  useEffect(() => {
    if (!map || !styleLoaded) return
    for (const { shapeId } of entries) {
      const isSelected = selectedImagePlaneIds?.has(shapeId) ?? false
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.setPaintProperty(layerIdFor(shapeId), 'model-emissive-strength' as any, isSelected ? 1.5 : 0)
      } catch { /* ignore */ }
    }
  }, [map, styleLoaded, entries, selectedImagePlaneIds])

  // ---- Move handle ------------------------------------------------------
  //
  // Mapbox `model` layers can't be dragged directly. We attach a small
  // draggable `mapboxgl.Marker` at the plane's anchor when the host
  // enters 'move' mode; drag → live `onTransformChange({position}, false)`;
  // dragend → `onTransformChange({position}, true)` (commit). Mirrors the
  // model overlay's pattern.
  //
  // Effect deps intentionally exclude `imagePlanes`: during the drag, the
  // host's draft updates `imagePlanes` on every move, and including it
  // here would tear down + recreate the marker mid-drag. We snapshot the
  // plane via a ref so the *initial* mount uses the latest position.
  const onTransformChangeRef = useRef(onTransformChange)
  useEffect(() => {
    onTransformChangeRef.current = onTransformChange
  }, [onTransformChange])

  const imagePlanesRef = useRef(imagePlanes)
  useEffect(() => {
    imagePlanesRef.current = imagePlanes
  }, [imagePlanes])

  useEffect(() => {
    if (!map) return
    if (!transformState || transformState.kind !== 'move') return
    const plane = (imagePlanesRef.current ?? []).find(
      (p) => p.id === transformState.imagePlaneId,
    )
    if (!plane || plane.id === undefined) return

    const el = document.createElement('div')
    el.className = 'image-plane-move-handle'
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
      .setLngLat(plane.position)
      .addTo(map)

    // Bypass React state during drag. Rewriting the spec via a direct
    // `setModels` call on the transforming plane's Mapbox source updates
    // its `model-translation` without touching the store — so the parent's
    // `imagePlanesForOverlay` memo stays reference-stable and the shared
    // `entries` memo + layer effect (which loop every plane on every
    // change) don't fire during the drag. Only mouseup fires the parent
    // commit path, which triggers ONE final rebuild.
    //
    // RAF coalescing caps the model-source updates at 60 fps even when
    // Mapbox's marker `drag` event fires at pointer rate.
    const sourceId = sourceIdFor(plane.id)
    const originalPlane = plane
    let pendingLngLat: [number, number] | null = null
    let rafId = 0

    const flushDrag = () => {
      rafId = 0
      if (!pendingLngLat) return
      const nextPos = pendingLngLat
      pendingLngLat = null
      const cached = glbCacheRef.current.get(originalPlane.id!)
      if (!cached) return
      // Rebuild the spec at the new position; keep everything else
      // (uri, orientation) identical so Mapbox doesn't re-fetch the GLB.
      const patchedPlane: ImagePlaneShape = { ...originalPlane, position: nextPos }
      const entry = buildImagePlaneEntry(patchedPlane, cached.blobUrl)
      if (!entry) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const src = map.getSource(sourceId) as any
      if (!src) return
      try {
        if (typeof src.setModels === 'function') {
          src.setModels({ [entry.key]: entry.spec })
        } else {
          src.models = { [entry.key]: entry.spec }
        }
      } catch { /* ignore transient style teardown */ }
    }
    const scheduleFlush = () => {
      if (rafId !== 0) return
      rafId = requestAnimationFrame(flushDrag)
    }

    const onDragStart = () => { el.style.cursor = 'grabbing' }
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
      onTransformChangeRef.current?.({ position: [ll.lng, ll.lat] }, true)
    }
    handle.on('dragstart', onDragStart)
    handle.on('drag', onDrag)
    handle.on('dragend', onDragEnd)
    return () => {
      try {
        handle.off('dragstart', onDragStart)
        handle.off('drag', onDrag)
        handle.off('dragend', onDragEnd)
      } catch { /* ignore */ }
      if (rafId !== 0) cancelAnimationFrame(rafId)
      pendingLngLat = null
      handle.remove()
    }
  }, [map, transformState])

  // ---- Click + hover ----------------------------------------------------
  useEffect(() => {
    if (!map || !styleLoaded) return
    if (!selectionEnabled) return

    const handleClick = (e: MapMouseEvent) => {
      const bbox: [PointLike, PointLike] = [
        [e.point.x - HIT_BUFFER_PX, e.point.y - HIT_BUFFER_PX],
        [e.point.x + HIT_BUFFER_PX, e.point.y + HIT_BUFFER_PX],
      ]
      const layers = map
        .getStyle()
        ?.layers
        ?.filter((l) => l.id.startsWith(LAYER_PREFIX))
        ?.map((l) => l.id) ?? []
      if (layers.length === 0) {
        onMapClickEmpty?.()
        return
      }
      const hits = map.queryRenderedFeatures(bbox, { layers })
      if (hits.length === 0) {
        onMapClickEmpty?.()
        return
      }
      // The layer id encodes the shape id: `image-plane-layer-<id>`
      const layerId = hits[0].layer?.id
      if (!layerId) return
      const idStr = layerId.slice(LAYER_PREFIX.length)
      const id = Number(idStr)
      if (!Number.isFinite(id)) return
      onImagePlaneClick?.(id, e.originalEvent as MouseEvent)
    }

    map.on('click', handleClick)
    return () => {
      map.off('click', handleClick)
    }
  }, [map, styleLoaded, selectionEnabled, onImagePlaneClick, onMapClickEmpty])

  return null
}
