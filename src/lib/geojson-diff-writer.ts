/**
 * Diff-only writes to a `dynamic: true` GeoJSON source.
 *
 * `source.setData(fc)` serialises the WHOLE collection on the main thread
 * (`JSON.stringify` inside GL JS) and makes the worker re-index it and
 * reload every tile, even when one feature changed — or none did. GL JS 3.x
 * has `updateData(diff)` for sources created with `dynamic: true`: the
 * worker upserts features by top-level `id`, deletes the ones sent with
 * `geometry: null`, and reloads only the tiles those features touch.
 *
 * The writer keeps a mirror of what the source holds and sends only the
 * difference. It never changes what is drawn:
 *
 *   - **Order.** The worker keeps features in insertion order (a Map):
 *     an upsert keeps its slot, a new id goes to the end. Feature order
 *     decides symbol draw order and label collision priority, so when the
 *     new list isn't "old order, minus removals, plus additions at the
 *     end" the writer falls back to one full `setData` (which re-inserts in
 *     list order).
 *   - **One load in flight.** GL JS coalesces a write made during a load
 *     into a follow-up that reuses the FINISHED request's `append` flag —
 *     mixing `setData` and `updateData` while busy either wipes the index
 *     or leaves stale features. The writer only writes when
 *     `source.loaded()`; anything that arrives meanwhile waits and goes out
 *     as one write on the source's next `sourcedata`.
 *   - **Ids.** GeoJSONRT skips features without a top-level `id`. The
 *     writer stamps `id` (from the caller's key, made unique) on a shallow
 *     copy, cached per feature object, so the caller's features stay as
 *     they were built. The id carries no style: layers read properties
 *     (and `promoteId` still names the feature-state id).
 *
 * An unchanged list (every feature object identical, same order) writes
 * nothing at all. A new source object (style swap, re-install) resets the
 * mirror and gets one full write. On a source that isn't dynamic the
 * writer just calls `setData` with the caller's features, untouched.
 */

import type { Map as MapboxMapInstance } from 'mapbox-gl'
import { hintNextUpdateCount } from '@/lib/empty-layer-gate'

type Feature = GeoJSON.Feature
type IdFeature = Feature & { id: string }

interface GeoJSONSourceLike {
  setData: (data: GeoJSON.FeatureCollection) => unknown
  updateData?: (data: GeoJSON.FeatureCollection) => unknown
  loaded?: () => boolean
  _options?: { dynamic?: boolean }
  workerOptions?: { dynamic?: boolean }
}

export interface GeoJSONDiffWriter {
  /**
   * Make the source hold exactly `features`, in this order. `keyOf` gives
   * each feature a stable identity across writes (an entity key, say);
   * duplicates are disambiguated in list order.
   */
  write: (features: readonly Feature[], keyOf: (f: Feature, index: number) => string) => void
  /**
   * Drop any queued write and stop listening. Not terminal: a later
   * `write` works again (React StrictMode re-runs effects on one writer).
   */
  dispose: () => void
}

/** How often to re-check a busy source if no `sourcedata` arrives. */
const RETRY_MS = 100

function isDynamic(src: GeoJSONSourceLike): boolean {
  return src._options?.dynamic === true || src.workerOptions?.dynamic === true
}

export function createGeoJSONDiffWriter(
  map: MapboxMapInstance,
  sourceId: string,
): GeoJSONDiffWriter {
  /** What the source holds, in its worker's order (dynamic sources only). */
  let mirror = new Map<string, IdFeature>()
  /** The source object `mirror` describes. */
  let boundSource: GeoJSONSourceLike | null = null
  /** Last list written to a non-dynamic source, to skip identical writes. */
  let lastPlain: readonly Feature[] | null = null
  let pending: { features: readonly Feature[]; keyOf: (f: Feature, i: number) => string } | null = null
  let listening = false
  let retry: ReturnType<typeof setTimeout> | null = null
  const withId = new WeakMap<Feature, IdFeature>()

  const onSourceData = (e: { sourceId?: string }) => {
    if (e.sourceId === sourceId) flush()
  }
  const wait = () => {
    if (!listening) {
      map.on('sourcedata', onSourceData)
      listening = true
    }
    if (retry === null) {
      retry = setTimeout(() => {
        retry = null
        flush()
      }, RETRY_MS)
    }
  }
  const stopWaiting = () => {
    if (listening) {
      map.off('sourcedata', onSourceData)
      listening = false
    }
    if (retry !== null) {
      clearTimeout(retry)
      retry = null
    }
  }

  function flush(): void {
    if (!pending) {
      stopWaiting()
      return
    }
    let src: GeoJSONSourceLike | undefined
    try {
      src = map.getSource(sourceId) as unknown as GeoJSONSourceLike | undefined
    } catch {
      src = undefined
    }
    if (!src || typeof src.setData !== 'function') {
      // Source torn down; whoever re-creates it writes again.
      pending = null
      boundSource = null
      mirror = new Map()
      lastPlain = null
      stopWaiting()
      return
    }
    if (src !== boundSource) {
      boundSource = src
      mirror = new Map()
      lastPlain = null
    }
    if (typeof src.loaded === 'function' && !src.loaded()) {
      wait()
      return
    }
    const { features, keyOf } = pending
    pending = null
    stopWaiting()

    if (!isDynamic(src) || typeof src.updateData !== 'function') {
      if (lastPlain && sameList(lastPlain, features)) return
      lastPlain = features
      src.setData({ type: 'FeatureCollection', features: features as Feature[] })
      return
    }

    // Stamp unique ids (cached per feature object so an unchanged feature
    // keeps the identical copy and diffs as unchanged).
    const ids: string[] = new Array(features.length)
    const stamped: IdFeature[] = new Array(features.length)
    const used = new Set<string>()
    for (let i = 0; i < features.length; i++) {
      const f = features[i]!
      const base = keyOf(f, i)
      let id = base
      for (let n = 1; used.has(id); n++) id = `${base}\u0000${n}`
      used.add(id)
      let w = withId.get(f)
      if (!w || w.id !== id) {
        w = { ...f, id }
        withId.set(f, w)
      }
      ids[i] = id
      stamped[i] = w
    }

    const fullWrite = () => {
      src.setData({ type: 'FeatureCollection', features: stamped })
      mirror = new Map()
      for (let i = 0; i < ids.length; i++) mirror.set(ids[i]!, stamped[i]!)
    }

    if (mirror.size === 0) {
      // Nothing written to this source yet. A fresh source starts empty, so
      // an empty list needs no write.
      if (stamped.length > 0) fullWrite()
      return
    }

    // Order the worker would end up in after an updateData: surviving ids
    // in place, new ids appended in list order.
    const upserts: IdFeature[] = []
    const added: IdFeature[] = []
    const expected: string[] = []
    for (const id of mirror.keys()) if (used.has(id)) expected.push(id)
    for (let i = 0; i < ids.length; i++) {
      const prev = mirror.get(ids[i]!)
      if (prev === undefined) {
        added.push(stamped[i]!)
        expected.push(ids[i]!)
      } else if (prev !== stamped[i]) {
        upserts.push(stamped[i]!)
      }
    }
    let inOrder = expected.length === ids.length
    for (let i = 0; inOrder && i < ids.length; i++) inOrder = expected[i] === ids[i]
    if (!inOrder) {
      fullWrite()
      return
    }
    const removed: string[] = []
    for (const id of mirror.keys()) if (!used.has(id)) removed.push(id)
    if (upserts.length === 0 && added.length === 0 && removed.length === 0) return

    hintNextUpdateCount(map, sourceId, ids.length)
    src.updateData({
      type: 'FeatureCollection',
      features: [
        ...upserts,
        ...added,
        // Only ids the source holds: GeoJSONRT throws on removing an
        // unknown id once it has loaded tiles.
        ...removed.map(
          (id) => ({ type: 'Feature', id, geometry: null, properties: {} }) as unknown as Feature,
        ),
      ],
    })
    for (const id of removed) mirror.delete(id)
    for (const w of upserts) mirror.set(w.id, w)
    for (const w of added) mirror.set(w.id, w)
  }

  return {
    write(features, keyOf) {
      pending = { features, keyOf }
      flush()
    },
    dispose() {
      pending = null
      stopWaiting()
    },
  }
}

function sameList(a: readonly Feature[], b: readonly Feature[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
