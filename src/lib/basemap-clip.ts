import { useEffect, useState } from 'react'
import type { Map as MapboxMapInstance } from 'mapbox-gl'

/**
 * Basemap clipping — does the current style have anything to clip?
 *
 * The overlays add `type: 'clip'` layers scoped to the `basemap` import
 * (`clip-layer-scope: ['basemap']`) so Standard's 3D buildings, landmarks,
 * trees and POI labels don't poke through a facility. On a classic style
 * (Light / Dark / Streets — no `basemap` import) those layers clip nothing,
 * yet the mere presence of a clip layer switches on Mapbox's per-frame
 * conflation path (`ReplacementSource._setSources` → `_computeReplacement`
 * over every footprint, plus a region scan in `updateBucketOpacities`), which
 * cost ~13 ms of a 60 ms frame at stadium scale. So: add clip layers only when
 * the style has something they can hide, and remove them when it doesn't.
 *
 * Read the stylesheet's own fields (no `getStyle()` serialisation — that is far
 * too heavy to call on a hot path); fall back to `getStyle()` only when the
 * internal field is missing, which happens at most once per style load.
 */
export function styleHasBasemapImport(map: MapboxMapInstance | null | undefined): boolean {
  if (!map) return false
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const style = (map as any).style
    // `stylesheet` is the style JSON as loaded. A style with no imports has
    // no `imports` key at all, which is a definite "no", not an unknown.
    if (style?.stylesheet) return hasBasemapId(style.stylesheet.imports)
    return hasBasemapId(map.getStyle()?.imports)
  } catch {
    return false
  }
}

function hasBasemapId(imports: unknown): boolean {
  return Array.isArray(imports) && imports.some((i) => (i as { id?: string } | null)?.id === 'basemap')
}

/**
 * Exact answer to "can an app clip layer change a single pixel on this style?"
 * — the decision `useBasemapClipNeeded` reports.
 *
 * What a region from our clip layers (types `['symbol', 'model']`, scope
 * `['basemap']`) can hide, per mapbox-gl 3.25:
 *
 *   - symbol and model layers inside the `basemap` import scope
 *     (`skipClipping` checks the scope) — needs a `basemap` import;
 *   - `fill-extrusion` layers on the `building` / `procedural_buildings`
 *     source-layers, `building` layers, and batched-model (3D landmark)
 *     sources, in ANY scope: `FillExtrusionBucket` / `BuildingBucket`
 *     `updateReplacement` and the landmark `hiddenByOverlap` pass ignore
 *     the clip scope and type mask.
 *
 * So a style without a `basemap` import still needs the clip layers if it,
 * or any style it imports, carries one of the second group. Today's classic
 * styles (Light / Dark / Streets) carry none; this keeps the gate exact if a
 * style is ever edited to add 3D buildings. Unknown (style not parsed, an
 * import not loaded yet) answers `true` — today's behaviour.
 */
export function styleNeedsBasemapClip(map: MapboxMapInstance | null | undefined): boolean {
  if (!map) return false
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const style = (map as any).style
    if (!style?.stylesheet) return true
    if (hasBasemapId(style.stylesheet.imports)) return true
    return styleTreeHasConflatedContent(style, 0) !== false
  } catch {
    return true
  }
}

/** The style JSON fields read by `styleTreeHasConflatedContent`. */
interface StyleTreeNode {
  stylesheet?: {
    imports?: unknown[]
    layers?: Array<{ type?: string; source?: unknown; 'source-layer'?: string }>
    sources?: Record<string, { type?: string } | undefined>
  }
  fragments?: Array<{ style?: StyleTreeNode }>
}

/** Source-layers whose `fill-extrusion` layers Mapbox treats as basemap buildings. */
const CONFLATED_SOURCE_LAYERS = new Set(['building', 'procedural_buildings'])
/** Mapbox caps import nesting at 5; stop well before a malformed cycle could. */
const MAX_IMPORT_DEPTH = 8

/**
 * `true` when this style or one it imports has a layer/source that clip
 * regions hide regardless of scope; `false` when it definitely has none;
 * `null` when it can't tell yet.
 */
function styleTreeHasConflatedContent(style: StyleTreeNode | undefined, depth: number): boolean | null {
  const sheet = style?.stylesheet
  if (!sheet || depth > MAX_IMPORT_DEPTH) return null
  const sources = sheet.sources ?? {}
  for (const id in sources) {
    if (sources[id]?.type === 'batched-model') return true
  }
  for (const layer of sheet.layers ?? []) {
    if (layer.type === 'building') return true
    if (layer.type === 'fill-extrusion' && CONFLATED_SOURCE_LAYERS.has(layer['source-layer'] ?? '')) return true
    // Inline source objects (rare, but valid in a v3 style).
    if ((layer.source as { type?: string } | null | undefined)?.type === 'batched-model') return true
  }
  const imports = Array.isArray(sheet.imports) ? sheet.imports : []
  if (imports.length === 0) return false
  const fragments = Array.isArray(style?.fragments) ? style.fragments : []
  if (fragments.length < imports.length) return null
  let unknown = false
  for (const fragment of fragments) {
    const nested = styleTreeHasConflatedContent(fragment?.style, depth + 1)
    if (nested === true) return true
    if (nested === null) unknown = true
  }
  return unknown ? null : false
}

/**
 * React hook: `true` while an app clip layer can change what the current
 * style draws (see `styleNeedsBasemapClip`). Re-evaluated on every
 * `style.load` — the event every overlay already re-mounts on, so the value
 * and the overlay's `styleGen` bump land in the same React batch.
 */
export function useBasemapClipNeeded(map: MapboxMapInstance | null | undefined): boolean {
  const [needed, setNeeded] = useState(() => styleNeedsBasemapClip(map))
  useEffect(() => {
    if (!map) return
    const update = () => setNeeded(styleNeedsBasemapClip(map))
    update()
    map.on('style.load', update)
    return () => {
      map.off('style.load', update)
    }
  }, [map])
  return needed
}

/**
 * Add or remove one overlay's basemap clip layer so it exists exactly when
 * `needed`. Every overlay's clip layer shares this spec (types
 * `['symbol', 'model']`, scope `['basemap']`).
 *
 * `beforeId` keeps the layer at the slot it has always had in its overlay's
 * stack (it is ignored when that layer is missing). The position only
 * matters relative to basemap layers, which all sit below every app layer,
 * but keeping it means the style's layer order is unchanged too.
 *
 * `visible: false` adds it hidden, matching an overlay whose committed
 * layers are toggled off; an existing layer's visibility is left to the
 * overlay's own visibility effect.
 */
export function syncBasemapClipLayer(
  map: MapboxMapInstance,
  opts: { layerId: string; sourceId: string; needed: boolean; beforeId?: string; visible?: boolean; label: string },
): void {
  const { layerId, sourceId, needed, beforeId, visible = true, label } = opts
  try {
    const present = !!map.getLayer(layerId)
    if (!needed) {
      if (present) map.removeLayer(layerId)
      return
    }
    if (present || !map.getSource(sourceId)) return
    map.addLayer(
      {
        id: layerId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: 'clip' as any,
        source: sourceId,
        layout: {
          'clip-layer-types': ['symbol', 'model'],
          'clip-layer-scope': ['basemap'],
          ...(visible ? {} : { visibility: 'none' }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      beforeId && map.getLayer(beforeId) ? beforeId : undefined,
    )
  } catch (err) {
    if (import.meta.env.DEV) {
      console.debug(`[${label}] clip layer not supported by this style`, err)
    }
  }
}

/**
 * `true` when two clip FeatureCollections carry the same footprints: same
 * feature count and order, same ring coordinates. The overlays' clip
 * features carry no properties or ids, so this is full equality of what the
 * clip source would hold — skipping a `setData` when it holds is exactly
 * equivalent to making it, minus the worker re-tile and ClipBucket rebuild.
 * (Only use it on property-less clip collections.)
 */
export function sameClipFootprints(
  a: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null | undefined,
  b: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null | undefined,
): boolean {
  if (a === b) return true
  const fa = a?.features ?? []
  const fb = b?.features ?? []
  if (fa.length !== fb.length) return false
  for (let i = 0; i < fa.length; i++) {
    const ra = fa[i].geometry.coordinates
    const rb = fb[i].geometry.coordinates
    if (ra === rb) continue
    if (ra.length !== rb.length) return false
    for (let r = 0; r < ra.length; r++) {
      const pa = ra[r]
      const pb = rb[r]
      if (pa === pb) continue
      if (pa.length !== pb.length) return false
      for (let p = 0; p < pa.length; p++) {
        const va = pa[p]
        const vb = pb[p]
        if (va === vb) continue
        if (va.length !== vb.length) return false
        for (let k = 0; k < va.length; k++) {
          // Object.is: NaN-safe, and strict on -0 (a false "changed" only
          // costs the setData we would have made anyway).
          if (!Object.is(va[k], vb[k])) return false
        }
      }
    }
  }
  return true
}
