/**
 * Keeps translucent 3D layers drawn AFTER every opaque 3D layer.
 *
 * Mapbox draws a fill-extrusion with opacity < 1 in two passes: a
 * depth-only pre-pass that WRITES depth, then the colour pass
 * (`drawFillExtrusion` in 3.25: `DepthMode(LEQUAL, ReadWrite)` +
 * `ColorMode.disabled`, then the blended pass). Anything drawn later
 * that sits behind it fails the depth test. So with the style order
 * we produce naturally — opacity buckets `-op0 … -op100` added in
 * ascending order, overlay kinds in the user's layer order — a 40%
 * polygon in front of a 100% polygon hid it completely: you looked
 * through the translucent shape straight at the floor plan below.
 *
 * Fix: the classic rule for mixing the two — every opaque 3D layer
 * first, then the translucent ones, most opaque first (a heuristic for
 * back-to-front; per-feature sorting across layers isn't possible), and
 * translucent custom layers (lift glass, no depth write) very last.
 * Opaque 3D layers resolve against each other by depth, not by order,
 * so moving the translucent ones later doesn't change what the user's
 * layer order means for 3D content.
 *
 * Installed once per map (mapbox-map.tsx). It watches addLayer /
 * moveLayer / `fill-extrusion-opacity` changes and re-checks the order
 * in a microtask, so a whole overlay's batch of adds costs one pass and
 * an already-correct order costs no moves.
 */

import type { Map as MapboxMapInstance } from 'mapbox-gl'

const INSTALLED = Symbol.for('sgv.translucent-layer-order.installed')
/** Bump when the ordering rules change (custom layers, dl- skip, ordering pins, …). */
const ORDER_VERSION = 7

interface RootLayer {
  id: string
  type: string
  slot?: string
  /** Custom layers: drawn translucent (e.g. lift glass, LiftMeshLayer). */
  translucent?: boolean
  /** Custom layers: renderingMode '3d'. */
  threeD?: boolean
}

/**
 * Sort weight for translucent custom layers: below every real opacity, so
 * they draw after ALL other 3D layers. Lift glass writes no depth; a
 * translucent extrusion drawn after it (say a 20% area behind the
 * escalator) would lay its depth pre-pass and colour over the glass and
 * the panes in front of it vanished. Drawn last, the glass blends over
 * everything behind it and is still hidden by whatever is in front.
 */
const CUSTOM_TRANSLUCENT_OPACITY = -1

/**
 * Root layers in ROOT order (the order `moveLayer` edits), custom layers
 * included, read live via `getLayer` (`getStyle()` leaves custom layers
 * out).
 *
 * Not `style.order`: that is the merged DRAW order, and Mapbox's
 * `mergeLayers` re-sorts it — symbol layers with occlusion-opacity
 * properties (rack labels, lift icons) that sit below the last 3D layer
 * are pushed after it. Picking the `moveLayer` anchor from the draw order
 * then named a label that, in root order, sits *before* the opaque
 * layers: the lift glass landed in front of the walls, the escalator
 * treads and the solid lift mesh, and every pane in front of them
 * vanished. 3D layers keep their relative order in both, so deciding in
 * root order is exact.
 */
function rootLayersInOrder(map: MapboxMapInstance): RootLayer[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const style = (map as any).style
  const order: unknown = style?._order ?? style?.order
  if (!Array.isArray(order)) return (map.getStyle()?.layers ?? []) as RootLayer[]
  const out: RootLayer[] = []
  for (const id of order as string[]) {
    // Imported (basemap) layers appear as `id\u001fscope`; getLayer
    // rejects those ids with a logged error, and they're never ours.
    if (id.includes('\u001f')) continue
    let impl: { type?: string; slot?: string; translucent?: boolean; renderingMode?: string } | undefined
    try {
      impl = map.getLayer(id) as typeof impl
    } catch {
      impl = undefined
    }
    if (!impl?.type) continue
    if (impl.type === 'custom') {
      out.push({ id, type: 'custom', slot: impl.slot, translucent: impl.translucent === true, threeD: impl.renderingMode === '3d' })
    } else {
      out.push({ id, type: impl.type, slot: impl.slot || undefined })
    }
  }
  return out
}

/**
 * Ordering pins: per map, the opacity a layer is JUDGED by, whatever its
 * live `fill-extrusion-opacity` says. Kept on the map object under a
 * global symbol (like INSTALLED), so the map takes its pins with it and a
 * hot-reloaded copy of this module reads the same table.
 */
const PINS = Symbol.for('sgv.translucent-layer-order.pins')

function pinsOf(map: MapboxMapInstance): Map<string, number> | undefined {
  return (map as unknown as { [PINS]?: Map<string, number> })[PINS]
}

/**
 * Pin the opacity the translucent-order pass judges `layerId` by (null =
 * unpin). A pinned value >= 1 counts as opaque, below 1 as that opacity.
 *
 * For a TEMPORARY dim of a layer (focus mode fading grid bucket / grid
 * line layers to 40 %) that must not move it in the root order: a 100 %
 * layer dimmed to 0.4 would otherwise be pulled after every opaque 3D
 * layer, and restoring it would leave it there — exit would no longer be
 * pixel-identical. Protocol:
 *
 *   1. `setOrderingOpacity(map, id, base)`         — pin the ORIGINAL constant
 *   2. `map.setPaintProperty(id, 'fill-extrusion-opacity', dimmed)`
 *   …
 *   3. `map.setPaintProperty(id, 'fill-extrusion-opacity', base)` — restore exactly
 *   4. `setOrderingOpacity(map, id, null)`         — unpin
 *
 * Pin BEFORE the dimming write and unpin AFTER the restoring write: the
 * write is what schedules a pass (the wrapped `setPaintProperty`), and
 * that pass must already see the pin. Pinning / unpinning schedules
 * nothing by itself — with base == restored constant, the pinned and
 * unpinned verdicts agree, so there is nothing to re-check.
 */
export function setOrderingOpacity(
  map: MapboxMapInstance,
  layerId: string,
  opacity: number | null,
): void {
  let pins = pinsOf(map)
  if (opacity === null || !Number.isFinite(opacity)) {
    pins?.delete(layerId)
    return
  }
  if (!pins) {
    pins = new Map()
    ;(map as unknown as { [PINS]?: Map<string, number> })[PINS] = pins
  }
  pins.set(layerId, opacity)
}

/** Constant opacity below 1, or null when opaque / not a fill-extrusion. */
function translucentOpacity(map: MapboxMapInstance, layer: RootLayer): number | null {
  if (layer.type === 'custom') return layer.translucent ? CUSTOM_TRANSLUCENT_OPACITY : null
  if (layer.type !== 'fill-extrusion') return null
  const pinned = pinsOf(map)?.get(layer.id)
  if (pinned !== undefined) return pinned < 1 ? pinned : null
  let value: unknown
  try {
    value = map.getPaintProperty(layer.id, 'fill-extrusion-opacity')
  } catch {
    return null
  }
  // Undefined = the default (1). Expressions (zoom-driven) can't be
  // judged statically; treat them as opaque, i.e. leave them alone.
  return typeof value === 'number' && value < 1 ? value : null
}

/**
 * Moves translucent fill-extrusions after the last opaque 3D layer,
 * ordered by descending opacity. Returns the number of moves made.
 * Exported for tests.
 */
export function orderTranslucentLayers(
  map: MapboxMapInstance,
  moveLayer: (id: string, beforeId?: string) => void = (id, beforeId) => map.moveLayer(id, beforeId),
): number {
  let layers: RootLayer[]
  try {
    layers = rootLayersInOrder(map)
  } catch {
    return 0
  }
  // Only root layers outside slots: slotted layers belong to the basemap's
  // stack (and the floor-plan custom layer, which isn't listed here).
  // Data-link layers (`dl-…`) are skipped: map-data-linked-overlay keeps
  // them on top as one block (`raiseDataLinkLayers`, re-checked on
  // `styledata`), and our moves fire `styledata` — sorting them too would
  // pull the block down only for the raise to put it back, so the two
  // policies would chase each other and the map would never go idle.
  const own = layers.filter((l) => !l.slot && !l.id.startsWith('dl-'))
  const translucent: { id: string; opacity: number; index: number }[] = []
  let lastOpaque3D = -1
  own.forEach((layer, index) => {
    const opacity = translucentOpacity(map, layer)
    if (opacity !== null) translucent.push({ id: layer.id, opacity, index })
    else if (layer.type === 'fill-extrusion' || layer.type === 'model' || (layer.type === 'custom' && layer.threeD)) lastOpaque3D = index
  })
  if (!translucent.length) return 0

  const wanted = [...translucent].sort((a, b) => b.opacity - a.opacity || a.index - b.index)
  const alreadyOrdered =
    translucent[0].index > lastOpaque3D && wanted.every((t, i) => t.id === translucent[i].id)
  if (alreadyOrdered) return 0

  // Insert just above the last opaque 3D layer: before the first layer
  // after it that isn't one of the layers being moved.
  const moving = new Set(translucent.map((t) => t.id))
  const anchor = own.slice(lastOpaque3D + 1).find((l) => !moving.has(l.id))?.id
  let moves = 0
  for (const t of wanted) {
    try {
      moveLayer(t.id, anchor)
      moves++
    } catch {
      // Layer removed mid-pass; the next scheduled pass sorts the rest.
    }
  }
  return moves
}

/** Install on a map; returns an uninstaller. Idempotent per map. */
export function installTranslucentLayerOrder(map: MapboxMapInstance): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyMap = map as any
  // A hot-reloaded module brings a new version while the map (and the
  // old wrappers) live on — replace the stale installation so new rules
  // apply without a page reload.
  const existing = anyMap[INSTALLED] as { version: number; uninstall: () => void } | undefined
  if (existing && existing.version === ORDER_VERSION) return () => {}
  existing?.uninstall?.()

  const origAddLayer = map.addLayer.bind(map)
  const origMoveLayer = map.moveLayer.bind(map)
  const origSetPaintProperty = map.setPaintProperty.bind(map)

  // Loop guard: a pass that moves layers fires `styledata`; if some other
  // code answers by moving layers again, two policies could ping-pong.
  // A correct order costs no moves, so more than a handful of moving
  // passes within a second means a conflict — stop for a moment rather
  // than spin the render loop.
  // Initial load legitimately makes many moving passes in a row (each
  // overlay adds its layers in turn), so a paused guard always schedules
  // one catch-up pass for when the window ends — otherwise layers added
  // during the pause (e.g. 3D models mounting last) would stay unsorted.
  let scheduled = false
  let windowStart = 0
  let movingPasses = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      const now = performance.now()
      if (now - windowStart > 1000) {
        windowStart = now
        movingPasses = 0
      }
      if (movingPasses >= 5) {
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null
            schedule()
          }, Math.max(0, windowStart + 1000 - now) + 16)
        }
        return
      }
      const moves = orderTranslucentLayers(map, (id, beforeId) => origMoveLayer(id, beforeId))
      if (moves > 0) {
        movingPasses++
        if (movingPasses === 5 && import.meta.env.DEV) {
          console.warn('[translucent-layer-order] layer order keeps changing; pausing for 1 s')
        }
      }
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anyMap.addLayer = ((layer: any, beforeId?: string) => {
    const result = origAddLayer(layer, beforeId)
    const type = layer?.type
    if (type === 'fill-extrusion' || type === 'model' || type === 'custom') schedule()
    return result
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  anyMap.moveLayer = ((id: string, beforeId?: string) => {
    const result = origMoveLayer(id, beforeId)
    schedule()
    return result
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  anyMap.setPaintProperty = ((layerId: string, name: string, value: unknown, options?: unknown) => {
    const result = origSetPaintProperty(layerId, name as never, value as never, options as never)
    if (name === 'fill-extrusion-opacity') schedule()
    return result
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  map.on('style.load', schedule)

  const uninstall = () => {
    anyMap.addLayer = origAddLayer
    anyMap.moveLayer = origMoveLayer
    anyMap.setPaintProperty = origSetPaintProperty
    map.off('style.load', schedule)
    if (retryTimer) clearTimeout(retryTimer)
    if (anyMap[INSTALLED]?.uninstall === uninstall) anyMap[INSTALLED] = undefined
  }
  anyMap[INSTALLED] = { version: ORDER_VERSION, uninstall }
  // Sort what is already on the map (layers added before this install).
  schedule()
  return uninstall
}
