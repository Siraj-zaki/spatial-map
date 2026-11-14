/**
 * Keeps the data-link overlay's `dl-*` layers on top of the map, without
 * the per-frame cost that used to come with it.
 *
 * The overlay used to re-raise every `dl-*` layer on every `styledata`
 * with no needs-raise check. In GL JS 3.25 `Style.moveLayer` always dirties
 * the style, requests a FULL symbol placement and re-merges every layer, and
 * the next frame's `Style.update` fires `styledata` again — so with one
 * data-link layer on the map the raise re-triggered itself every frame and
 * the map never went idle. Each pass also serialised the whole style
 * (`getStyle()`, `getLayer()` → `serialize()`), once per config.
 *
 * Here the raise is one guarded pass for the whole `dl-*` block: it reads
 * the root layer order straight off the style (no serialisation) and moves
 * nothing when the block is already in place. No move → no `styledata` →
 * no loop.
 *
 * The block order matches what the old listeners settled on every frame:
 * any `dl-*` layer no live sub-renderer claims (mid-teardown) at the
 * bottom, then each config's layers in the order its sub-renderer
 * registered (mount order), each config in its own fixed layer order.
 */

import type { Map as MapboxMapInstance } from 'mapbox-gl'

interface StyleInternals {
  _order?: string[]
  getOwnLayer?: (id: string) => unknown
  _otherSourceCaches?: Record<string, unknown>
}

function styleOf(map: MapboxMapInstance): StyleInternals | null {
  return ((map as unknown as { style?: StyleInternals }).style ?? null)
}

/**
 * Root layer ids in root order (the order `moveLayer` edits). Imported
 * (basemap) ids — `id\u001fscope` — are never ours and are skipped.
 * Falls back to `getStyle()` only if the internal array is missing.
 */
export function rootLayerOrder(map: MapboxMapInstance): string[] {
  const order = styleOf(map)?._order
  if (Array.isArray(order)) return order
  try {
    return (map.getStyle()?.layers ?? []).map((l) => l.id)
  } catch {
    return []
  }
}

/**
 * `map.getLayer(id) !== undefined` without the cost: `Map.getLayer`
 * returns `layer.serialize()`, a full copy of the layer, on every call.
 */
export function hasMapLayer(map: MapboxMapInstance, id: string): boolean {
  const style = styleOf(map)
  if (style && typeof style.getOwnLayer === 'function') {
    try {
      return style.getOwnLayer(id) !== undefined
    } catch {
      return false
    }
  }
  try {
    return map.getLayer(id) !== undefined
  } catch {
    return false
  }
}

/** Root source ids, without serialising the style. */
export function rootSourceIds(map: MapboxMapInstance): string[] {
  const caches = styleOf(map)?._otherSourceCaches
  if (caches && typeof caches === 'object') return Object.keys(caches)
  try {
    return Object.keys(map.getStyle()?.sources ?? {})
  } catch {
    return []
  }
}

/** Every `dl-*` layer currently on the map, bottom to top. */
export function listDataLinkLayerIds(map: MapboxMapInstance): string[] {
  const out: string[] = []
  for (const id of rootLayerOrder(map)) {
    if (id.startsWith('dl-') && !id.includes('\u001f')) out.push(id)
  }
  return out
}

/**
 * Per map: each mounted sub-renderer's layer ids, in registration order.
 * Re-registering (the sub-renderer's ids or `enabled` changed) moves the
 * entry to the end, the way re-adding a `styledata` listener used to.
 */
const registries = new WeakMap<MapboxMapInstance, Map<symbol, readonly string[]>>()

/**
 * Claim a place in the `dl-*` block for one sub-renderer's layers. Returns
 * the release function (call it on unmount / when the ids change).
 */
export function registerDataLinkLayers(
  map: MapboxMapInstance,
  layerIds: readonly string[],
): () => void {
  let reg = registries.get(map)
  if (!reg) {
    reg = new Map()
    registries.set(map, reg)
  }
  const token = Symbol('dl-layers')
  reg.set(token, layerIds)
  return () => {
    registries.get(map)?.delete(token)
  }
}

/**
 * The order the `dl-*` block should end in, bottom to top: unclaimed
 * `dl-*` layers in their current relative order, then every registered
 * sub-renderer's existing layers in registration order.
 */
function desiredDataLinkOrder(map: MapboxMapInstance, order: readonly string[]): string[] {
  const reg = registries.get(map)
  const claimed = new Set<string>()
  if (reg) for (const ids of reg.values()) for (const id of ids) claimed.add(id)
  const present = new Set<string>()
  const out: string[] = []
  for (const id of order) {
    if (!id.startsWith('dl-') || id.includes('\u001f')) continue
    present.add(id)
    if (!claimed.has(id)) out.push(id)
  }
  if (reg) {
    for (const ids of reg.values()) {
      for (const id of ids) if (present.has(id)) out.push(id)
    }
  }
  return out
}

/**
 * Move the `dl-*` block to the top of the root layer order, in
 * `desiredDataLinkOrder`. A no-op — zero `moveLayer` calls — when the
 * block already sits there in that order, which is what ends the old
 * styledata ↔ moveLayer loop. Returns the number of moves made.
 */
export function raiseDataLinkLayers(map: MapboxMapInstance): number {
  let order: string[]
  try {
    order = rootLayerOrder(map)
  } catch {
    return 0
  }
  const desired = desiredDataLinkOrder(map, order)
  if (desired.length === 0) return 0
  // Compare against the top of the stack, ignoring imported ids.
  let i = order.length - 1
  let j = desired.length - 1
  let inPlace = true
  while (j >= 0) {
    while (i >= 0 && order[i]!.includes('\u001f')) i--
    if (i < 0 || order[i] !== desired[j]) {
      inPlace = false
      break
    }
    i--
    j--
  }
  if (inPlace) return 0
  let moves = 0
  for (const id of desired) {
    try {
      map.moveLayer(id)
      moves++
    } catch {
      /* layer went away between the read and the move */
    }
  }
  return moves
}

/**
 * One forced re-merge per newly installed `dl-*` layer, after its paint has
 * been evaluated.
 *
 * `Style.mergeLayers()` orders symbol layers that use occlusion opacity
 * after the last 3D layer, using each layer's `is3D()` AT MERGE TIME. A
 * shape-tint `fill` with a data-driven `fill-z-offset` reports `is3D() =
 * false` until its paint is first recalculated (Style.update on a frame
 * where it is visible), so a merge that happens while it is still
 * unevaluated can leave the tint drawn over the markers. The old per-frame
 * re-raise re-merged on every frame and hid this; the guarded raise moves
 * nothing once the block is in place. So: remember every newly seen dl
 * layer object, wait until it has been visible for one rendered frame, then
 * move the top dl layer onto itself once — `moveLayer` always re-runs
 * `mergeLayers` — and forget it. Keyed by the style's layer OBJECT, so a
 * style swap or re-add (same id, new object) re-arms it.
 */
const remergedLayers = new WeakSet<object>()
const pendingByMap = new WeakMap<MapboxMapInstance, Map<string, { layer: object; seenVisible: boolean }>>()

function styleLayer(map: MapboxMapInstance, id: string): { visibility?: string } | undefined {
  const layers = (styleOf(map) as unknown as { _layers?: Record<string, { visibility?: string }> } | null)?._layers
  return layers?.[id]
}

/** Note `dl-*` layers that still need their one post-evaluation re-merge. Cheap; call on styledata. */
export function noteNewDataLinkLayers(map: MapboxMapInstance): void {
  let pending = pendingByMap.get(map)
  for (const id of listDataLinkLayerIds(map)) {
    const layer = styleLayer(map, id)
    if (!layer || remergedLayers.has(layer)) continue
    if (!pending) {
      pending = new Map()
      pendingByMap.set(map, pending)
    }
    const cur = pending.get(id)
    if (!cur || cur.layer !== layer) pending.set(id, { layer, seenVisible: false })
  }
}

/**
 * Call on every `render`. O(1) when nothing is pending. When a pending
 * layer has been visible for a full frame (so its paint is evaluated),
 * re-merge once by moving the top `dl-*` layer onto itself.
 */
export function settleDataLinkMerge(map: MapboxMapInstance): void {
  const pending = pendingByMap.get(map)
  if (!pending || pending.size === 0) return
  let ready = false
  for (const [id, entry] of pending) {
    const layer = styleLayer(map, id)
    if (!layer || layer !== entry.layer) {
      pending.delete(id)
      continue
    }
    if (layer.visibility === 'none') continue
    if (!entry.seenVisible) {
      entry.seenVisible = true
      continue
    }
    remergedLayers.add(layer)
    pending.delete(id)
    ready = true
  }
  if (!ready) return
  const ids = listDataLinkLayerIds(map)
  const top = ids[ids.length - 1]
  if (!top) return
  try {
    map.moveLayer(top)
  } catch {
    /* style mid-swap; the next install re-arms */
  }
}
