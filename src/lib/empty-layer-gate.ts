/**
 * Empty-source layer visibility gate.
 *
 * Mapbox GL 3.25 `Style.update()` skips `layer.recalculate()` for a layer
 * only when its visibility is `'none'`:
 *
 *     if (layer.visibility !== "none" || layer.hasTransition())
 *       layer.recalculate(parameters, this._availableImages)
 *
 * Every other layer is re-evaluated on every frame — including the ones
 * whose source holds zero features and which therefore draw nothing. On a
 * real facility (retail mall, ground floor) that is 81 of 205 overlay
 * layers in the viewer and 102 of 203 in the editor, measured at 19.6% and
 * 34.8% of median frame time respectively.
 *
 * This gate hides exactly those layers, and shows them again the instant
 * their source gains a feature. A layer whose source has zero features
 * rasterises zero pixels, so `'none'` is pixel-identical: the gate is a
 * pure performance change, not a behaviour change.
 *
 * Two invariants keep it that way:
 *
 *   1. **App intent wins.** `map.setLayoutProperty(id, 'visibility', …)` is
 *      wrapped, so a user-driven hide (per-kind toggles, the grid toggle)
 *      is recorded as intent. The gate never un-hides a layer the app asked
 *      to hide, no matter what its source does later.
 *   2. **Unknown means visible.** If a feature count can't be determined —
 *      URL-backed GeoJSON, a non-GeoJSON source, a layer added outside our
 *      hooks — the gate leaves visibility alone. Every failure mode costs
 *      performance, never UX.
 *
 * Restoration is not deferred or debounced: GeoJSON `setData` is already an
 * async worker round-trip before anything is renderable, and the gate
 * re-shows the layer synchronously inside that same `setData` call. So the
 * live-draw, selection, transform and in-flight layers — which are empty
 * until the moment the user acts — become visible no later than they do
 * today.
 *
 * Install once per Map instance, immediately after construction.
 */

import type { Map as MapboxMapInstance } from 'mapbox-gl'

type Visibility = 'visible' | 'none'

const INSTALLED = Symbol.for('sgv.empty-layer-gate.installed')
const SOURCE_WRAPPED = Symbol.for('sgv.empty-layer-gate.source-wrapped')
const COUNT_HINTS = Symbol.for('sgv.empty-layer-gate.count-hints')
const LAYER_API = Symbol.for('sgv.empty-layer-gate.layer-api')

/** Per-feature test that mirrors a layer's own `filter` (see registerLayerFeaturePredicate). */
export type LayerFeaturePredicate = (feature: { properties?: Record<string, unknown> | null; id?: unknown }) => boolean

interface LayerApi {
  setPredicate(layerId: string, predicate: LayerFeaturePredicate | null): void
  setEmptyHint(layerId: string, empty: boolean | null): void
}
function layerApi(map: MapboxMapInstance): LayerApi | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (map as any)[LAYER_API] as LayerApi | undefined
}

/**
 * Register a JS predicate that matches exactly the features a layer's own
 * `filter` lets through (e.g. one opacity bucket of a shared source). On
 * every `setData` of the layer's source the gate counts the matching
 * features and hides the layer while that count is 0 — a layer whose filter
 * passes nothing draws nothing, yet Mapbox still re-evaluates it every frame
 * (on the stadium, ~30 empty opacity-bucket layers cost ~4 fps on Standard).
 *
 * The predicate MUST stay in lock-step with the layer's filter: if it ever
 * returns false for a feature the filter would draw, that feature vanishes.
 * When in doubt return true. Pass `null` to unregister. The registration is
 * dropped when the layer is removed (style swap / unmount), so overlays
 * register right after each `addLayer`. While the source's data is unknown
 * (URL data, a diff-only `updateData` without a count hint) the predicate is
 * ignored and the layer stays visible. No-op when the gate isn't installed.
 */
export function registerLayerFeaturePredicate(
  map: MapboxMapInstance,
  layerId: string,
  predicate: LayerFeaturePredicate | null,
): void {
  layerApi(map)?.setPredicate(layerId, predicate)
}

/**
 * Tell the gate a layer currently has nothing to draw for a reason the
 * source data doesn't show — typically a selection/hover layer whose
 * `filter` matches no id right now (`['==', id, -1]`). `true` hides it,
 * `false` / `null` clears the hint (= today's behaviour). App intent still
 * wins: a layer the app hid stays hidden. Dropped when the layer is removed.
 */
export function hintLayerEmpty(map: MapboxMapInstance, layerId: string, empty: boolean | null): void {
  layerApi(map)?.setEmptyHint(layerId, empty)
}

/**
 * Tell the gate how many features a source will hold after the NEXT
 * `updateData` call on it. `updateData` carries only a diff, so the gate
 * can't count it; without a hint the source's count becomes unknown
 * (= visible). The GeoJSON diff writer knows the full size and passes it
 * here right before it calls `updateData`. No-op when the gate isn't
 * installed on this map.
 */
export function hintNextUpdateCount(map: MapboxMapInstance, sourceId: string, count: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hints = (map as any)[COUNT_HINTS] as Map<string, number> | undefined
  hints?.set(sourceId, count)
}

/**
 * Feature count of a GeoJSON source's `data`, or `null` when it can't be
 * known from the value alone (a URL string is resolved on the worker).
 */
function countFeatures(data: unknown): number | null {
  if (typeof data === 'string') return null
  if (!data || typeof data !== 'object') return null
  const obj = data as { type?: string; features?: unknown }
  if (Array.isArray(obj.features)) return obj.features.length
  if (obj.type === 'Feature') return 1
  return null
}

export function installEmptyLayerGate(map: MapboxMapInstance): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyMap = map as any
  if (anyMap[INSTALLED]) return () => {}
  anyMap[INSTALLED] = true

  /** layer id → source id, for every layer added through `map.addLayer`. */
  const layerSource = new Map<string, string>()
  /** source id → layer ids drawing from it. */
  const sourceLayers = new Map<string, Set<string>>()
  /** source id → feature count, or `null` when unknown. */
  const featureCount = new Map<string, number | null>()
  /** layer id → visibility the app asked for (absent means `'visible'`). */
  const desired = new Map<string, Visibility>()
  /** layer id → visibility the gate last pushed, to skip redundant writes. */
  const applied = new Map<string, Visibility>()
  /** source id → feature count after its next `updateData` (see hintNextUpdateCount). */
  const countHints = new Map<string, number>()
  anyMap[COUNT_HINTS] = countHints
  /** source id → the last full data object pushed (null when unknown), for predicates. */
  const lastData = new Map<string, unknown>()
  /** layer id → predicate mirroring its filter (registerLayerFeaturePredicate). */
  const predicates = new Map<string, LayerFeaturePredicate>()
  /** layer id → number of source features its predicate passes, or null when unknown. */
  const predicateCount = new Map<string, number | null>()
  /** layer id → app hint that the layer has nothing to draw (hintLayerEmpty). */
  const emptyHints = new Map<string, boolean>()

  function countPredicate(data: unknown, predicate: LayerFeaturePredicate): number | null {
    if (!data || typeof data !== 'object') return null
    const feats = (data as { features?: unknown }).features
    if (!Array.isArray(feats)) return null
    let n = 0
    for (const f of feats) {
      try {
        if (predicate(f as never)) n++
      } catch {
        return null
      }
      if (n > 0) return n // only zero vs non-zero matters
    }
    return n
  }
  function refreshPredicates(sourceId: string): void {
    const ids = sourceLayers.get(sourceId)
    if (!ids) return
    const data = lastData.get(sourceId)
    for (const layerId of ids) {
      const p = predicates.get(layerId)
      if (!p) continue
      predicateCount.set(layerId, data === undefined || data === null ? null : countPredicate(data, p))
    }
  }
  anyMap[LAYER_API] = {
    setPredicate(layerId: string, predicate: LayerFeaturePredicate | null) {
      if (!predicate) {
        predicates.delete(layerId)
        predicateCount.delete(layerId)
      } else {
        predicates.set(layerId, predicate)
        const sourceId = layerSource.get(layerId)
        const data = sourceId === undefined ? undefined : lastData.get(sourceId)
        predicateCount.set(layerId, data === undefined || data === null ? null : countPredicate(data, predicate))
      }
      applyLayer(layerId)
    },
    setEmptyHint(layerId: string, empty: boolean | null) {
      if (empty) emptyHints.set(layerId, true)
      else emptyHints.delete(layerId)
      applyLayer(layerId)
    },
  } satisfies LayerApi

  const origAddSource = map.addSource.bind(map)
  const origRemoveSource = map.removeSource.bind(map)
  const origAddLayer = map.addLayer.bind(map)
  const origRemoveLayer = map.removeLayer.bind(map)
  const origSetLayoutProperty = map.setLayoutProperty.bind(map)

  function effectiveVisibility(layerId: string): Visibility {
    if ((desired.get(layerId) ?? 'visible') === 'none') return 'none'
    if (emptyHints.get(layerId)) return 'none'
    if (predicateCount.get(layerId) === 0) return 'none'
    const sourceId = layerSource.get(layerId)
    if (sourceId === undefined) return 'visible'
    const count = featureCount.get(sourceId)
    if (count === undefined || count === null) return 'visible'
    return count === 0 ? 'none' : 'visible'
  }

  function applyLayer(layerId: string): void {
    const next = effectiveVisibility(layerId)
    if (applied.get(layerId) === next) return
    // A layer can be gone (style swap, overlay unmount) between the write
    // that scheduled this and now.
    if (!map.getLayer(layerId)) return
    applied.set(layerId, next)
    try {
      origSetLayoutProperty(layerId, 'visibility', next)
    } catch {
      // Layer removed mid-flight, or style not ready. Drop the cached value
      // so the next evaluation retries rather than believing a write landed.
      applied.delete(layerId)
    }
  }

  function applySource(sourceId: string): void {
    const ids = sourceLayers.get(sourceId)
    if (!ids) return
    for (const layerId of ids) applyLayer(layerId)
  }

  /**
   * Wrap a source's `setData` so the gate learns the new feature count
   * synchronously, in the same call the overlay makes. Sources without
   * `setData` (raster, image, video, vector, model) stay untracked, which
   * leaves their layers ungated.
   *
   * `updateData` (dynamic GeoJSON sources) is wrapped too: it sends a diff,
   * so the count comes from a `hintNextUpdateCount` the caller left just
   * before, or becomes unknown (= visible) when there is none.
   */
  function trackSource(sourceId: string, initialData: unknown): void {
    const src = map.getSource(sourceId)
    if (!src) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anySrc = src as any
    if (typeof anySrc.setData !== 'function') {
      featureCount.delete(sourceId)
      return
    }
    featureCount.set(sourceId, countFeatures(initialData))
    lastData.set(sourceId, countFeatures(initialData) === null ? null : initialData)
    refreshPredicates(sourceId)
    if (anySrc[SOURCE_WRAPPED]) return
    anySrc[SOURCE_WRAPPED] = true
    const origSetData = anySrc.setData.bind(anySrc)
    anySrc.setData = (data: unknown) => {
      const result = origSetData(data)
      countHints.delete(sourceId)
      featureCount.set(sourceId, countFeatures(data))
      lastData.set(sourceId, countFeatures(data) === null ? null : data)
      refreshPredicates(sourceId)
      applySource(sourceId)
      return result
    }
    if (typeof anySrc.updateData === 'function') {
      const origUpdateData = anySrc.updateData.bind(anySrc)
      anySrc.updateData = (data: unknown) => {
        const result = origUpdateData(data)
        const hint = countHints.get(sourceId)
        countHints.delete(sourceId)
        featureCount.set(sourceId, hint ?? null)
        // A diff can't be run through predicates; their layers fall back to visible.
        lastData.set(sourceId, null)
        refreshPredicates(sourceId)
        applySource(sourceId)
        return result
      }
    }
  }

  anyMap.addSource = ((id: string, spec: unknown) => {
    const result = origAddSource(id, spec as never)
    const data = spec && typeof spec === 'object' ? (spec as { data?: unknown }).data : undefined
    trackSource(id, data)
    applySource(id)
    return result
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  anyMap.removeSource = ((id: string) => {
    featureCount.delete(id)
    countHints.delete(id)
    lastData.delete(id)
    return origRemoveSource(id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anyMap.addLayer = ((layerSpec: any, beforeId?: string) => {
    const result = origAddLayer(layerSpec, beforeId)
    const layerId: unknown = layerSpec?.id
    const sourceId: unknown = layerSpec?.source
    if (typeof layerId === 'string') {
      // A freshly added layer carries the visibility from its own spec, so
      // any cached "already applied" value from a previous incarnation of
      // this id (style swap, remount) is stale.
      applied.delete(layerId)
      const specVisibility: unknown = layerSpec?.layout?.visibility
      if (specVisibility === 'none' || specVisibility === 'visible') {
        desired.set(layerId, specVisibility)
      }
      if (typeof sourceId === 'string') {
        layerSource.set(layerId, sourceId)
        let ids = sourceLayers.get(sourceId)
        if (!ids) {
          ids = new Set<string>()
          sourceLayers.set(sourceId, ids)
        }
        ids.add(layerId)
      }
      applyLayer(layerId)
    }
    return result
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  anyMap.removeLayer = ((id: string) => {
    const sourceId = layerSource.get(id)
    if (sourceId !== undefined) sourceLayers.get(sourceId)?.delete(id)
    layerSource.delete(id)
    applied.delete(id)
    predicates.delete(id)
    predicateCount.delete(id)
    emptyHints.delete(id)
    return origRemoveLayer(id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  anyMap.setLayoutProperty = ((
    layerId: string,
    name: string,
    value: unknown,
    options?: unknown,
  ) => {
    if (name !== 'visibility') {
      return origSetLayoutProperty(layerId, name as never, value as never, options as never)
    }
    desired.set(layerId, value === 'none' ? 'none' : 'visible')
    const next = effectiveVisibility(layerId)
    applied.set(layerId, next)
    return origSetLayoutProperty(layerId, 'visibility', next, options as never)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  if (import.meta.env.DEV) {
    anyMap.__emptyLayerGate = { layerSource, sourceLayers, featureCount, desired, applied, predicates, predicateCount, emptyHints }
  }

  return () => {
    anyMap.addSource = origAddSource
    anyMap.removeSource = origRemoveSource
    anyMap.addLayer = origAddLayer
    anyMap.removeLayer = origRemoveLayer
    anyMap.setLayoutProperty = origSetLayoutProperty
    anyMap[INSTALLED] = false
    if (anyMap[COUNT_HINTS] === countHints) anyMap[COUNT_HINTS] = undefined
    anyMap[LAYER_API] = undefined
  }
}
