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

  const origAddSource = map.addSource.bind(map)
  const origRemoveSource = map.removeSource.bind(map)
  const origAddLayer = map.addLayer.bind(map)
  const origRemoveLayer = map.removeLayer.bind(map)
  const origSetLayoutProperty = map.setLayoutProperty.bind(map)

  function effectiveVisibility(layerId: string): Visibility {
    if ((desired.get(layerId) ?? 'visible') === 'none') return 'none'
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
    if (anySrc[SOURCE_WRAPPED]) return
    anySrc[SOURCE_WRAPPED] = true
    const origSetData = anySrc.setData.bind(anySrc)
    anySrc.setData = (data: unknown) => {
      const result = origSetData(data)
      featureCount.set(sourceId, countFeatures(data))
      applySource(sourceId)
      return result
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
    anyMap.__emptyLayerGate = { layerSource, sourceLayers, featureCount, desired, applied }
  }

  return () => {
    anyMap.addSource = origAddSource
    anyMap.removeSource = origRemoveSource
    anyMap.addLayer = origAddLayer
    anyMap.removeLayer = origRemoveLayer
    anyMap.setLayoutProperty = origSetLayoutProperty
    anyMap[INSTALLED] = false
  }
}
