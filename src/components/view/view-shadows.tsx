import { useEffect } from 'react'
import type { Map as MapboxMapInstance } from 'mapbox-gl'

interface ViewShadowsProps {
  map: MapboxMapInstance | null
  /** Disable the pass entirely (e.g. on non-Standard basemaps where
   * the style doesn't ship a sun light to drive shadow projection). */
  enabled?: boolean
}

/**
 * Viewer-only enhancement: flip on `fill-extrusion-cast-shadows` and
 * `model-cast-shadows` for every 3D layer our overlays add (grid /
 * polygon / circle / line wall / stair / bin / model). The Mapbox
 * Standard style includes a sun light + ground shadow receiver out of
 * the box, so opting our extrusions into casting gives the architectural
 * render look — walls drop crisp shadows onto the floor, racks ground
 * themselves in space, and the camera-pitched 3D scene reads as a real
 * physical model instead of a flat-looking technical drawing.
 *
 * Skipped on non-Standard basemap styles because they don't carry a sun
 * light, so toggling the property is a no-op (still safe; just noise).
 *
 * Editor-side overlays render with shadow casting OFF so the user can
 * see their own colors without surrounding context shading them. That's
 * why this lives in `components/view/` and not in the shared overlays.
 */
// Per the editor styling pass, racks (`grid-*`) do NOT get the
// cast-shadow treatment — too much visual noise across hundreds of
// adjacent cells and the gradient fights the bin-status tints. The
// shadow accent goes on architectural surfaces only (walls / polygons
// / circle extrusions / stairs). Bin tints ride on top of racks, so
// they're skipped too. 3D models DO get shadows (see below).
const FILL_EXTRUSION_LAYER_PREFIXES = [
  // Polygon walls / extrusions.
  'polygon-extrude-layer-op',
  'polygon-extrude-layer',
  // Circle extrusions.
  'circle-extrude-layer-op',
  'circle-extrude-layer',
  // Line "wall" extrusions (when height > 0).
  'line-wall-layer-op',
  'line-wall-layer',
  // Stair steps (fill-extrusion per riser/tread).
  'stair-step-layer',
]

// 3D models get cast + receive shadows. The editor's
// `buildModelLayerPaint` already sets these props at layer-add time;
// this prefix exists so the viewer pass can re-stamp them on any
// model layer Mapbox creates after a style swap, keeping forklifts /
// shelving / desks grounded by the same directional light driving
// the wall shadows.
const MODEL_LAYER_PREFIXES = [
  'model-shapes-layer-',
]

function isCandidate(layerId: string, prefixes: string[]): boolean {
  for (const p of prefixes) {
    if (layerId.startsWith(p)) return true
  }
  return false
}

export function ViewShadows({ map, enabled = true }: ViewShadowsProps) {
  useEffect(() => {
    if (!map || !enabled) return

    const apply = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(map as any).style) return
      const style = map.getStyle()
      if (!style?.layers) return

      for (const layer of style.layers) {
        const id = layer.id
        if (!id) continue
        try {
          if (layer.type === 'fill-extrusion' && isCandidate(id, FILL_EXTRUSION_LAYER_PREFIXES)) {
            // `fill-extrusion-cast-shadows` is Mapbox GL JS ≥ 3.6. On
            // older runtimes Mapbox throws a spec validation error;
            // the try/catch absorbs it without breaking the rest of
            // the pass.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.setPaintProperty(id, 'fill-extrusion-cast-shadows' as any, true)
            // Receiving shadows on our own extrusions lets one rack's
            // wall shade an adjacent rack — gives the scene depth.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.setPaintProperty(id, 'fill-extrusion-receive-shadows' as any, true)
            // Slight ambient-occlusion intensity to read the wall edge
            // even where the sun doesn't cast a direct shadow.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.setPaintProperty(id, 'fill-extrusion-ambient-occlusion-intensity' as any, 0.45)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.setPaintProperty(id, 'fill-extrusion-ambient-occlusion-radius' as any, 3)
          } else if (layer.type === 'model' && isCandidate(id, MODEL_LAYER_PREFIXES)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.setPaintProperty(id, 'model-cast-shadows' as any, true)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.setPaintProperty(id, 'model-receive-shadows' as any, true)
          }
        } catch {
          // Layer missing the property (older runtime) — ignore.
        }
      }
    }

    // Initial pass + after every style swap. We also re-apply when the
    // editor overlays add new layers asynchronously (after their own
    // `style.load`), via a short follow-up tick on every `idle` event.
    if (map.isStyleLoaded()) apply()
    map.on('style.load', apply)
    // `sourcedata` fires when overlay sources finish loading their
    // first GeoJSON payload — that's typically when the overlay adds
    // its layer immediately after. Cheap re-pass.
    const onSourceData = () => apply()
    map.on('sourcedata', onSourceData)
    return () => {
      map.off('style.load', apply)
      map.off('sourcedata', onSourceData)
    }
  }, [map, enabled])

  return null
}
