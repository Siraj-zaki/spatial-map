import { useEffect, useRef } from 'react'
import type { Map as MapboxMapInstance } from 'mapbox-gl'
import { LiftMeshLayer, type LiftMeshData } from '@/lib/lift-mesh-layer'

/**
 * Two `LiftMeshLayer`s for an overlay's sloped shapes (sloped-mesh.ts):
 * `<base>-mesh-layer` for opaque meshes (writes depth) and
 * `<base>-mesh-translucent-layer` for see-through ones (solid shading, no
 * depth write — kept after every opaque 3D layer by
 * translucent-layer-order.ts). Meshes are routed by their colour alpha.
 *
 * Mirrors the stair overlay's mesh-layer lifecycle: added once the style is
 * ready (and again after a basemap swap), removed with the overlay.
 */
export function useShapeMeshLayers(
  map: MapboxMapInstance | null,
  styleLoaded: boolean,
  styleGen: number,
  base: string,
  meshes: ReadonlyArray<LiftMeshData>,
  visible: boolean,
): void {
  const solidId = `${base}-mesh-layer`
  const translucentId = `${base}-mesh-translucent-layer`
  const layersRef = useRef<{ solid: LiftMeshLayer; translucent: LiftMeshLayer } | null>(null)
  if (layersRef.current === null) {
    layersRef.current = {
      solid: new LiftMeshLayer(solidId),
      translucent: new LiftMeshLayer(translucentId, true, false),
    }
  }

  useEffect(() => {
    if (!map || !styleLoaded) return
    const layers = layersRef.current
    if (!layers) return
    try {
      if (!map.getLayer(solidId)) map.addLayer(layers.solid)
      if (!map.getLayer(translucentId)) map.addLayer(layers.translucent)
    } catch (err) {
      console.warn(`[${base}] mesh layers failed`, err)
    }
  }, [map, styleLoaded, styleGen, base, solidId, translucentId])

  useEffect(() => {
    const layers = layersRef.current
    if (!layers) return
    const solid: LiftMeshData[] = []
    const translucent: LiftMeshData[] = []
    for (const m of meshes) {
      const alpha = m.colors.length >= 4 ? m.colors[3] : 1
      if (alpha <= 0.001) continue
      ;(alpha < 0.999 ? translucent : solid).push(m)
    }
    layers.solid.setMeshes(solid)
    layers.translucent.setMeshes(translucent)
  }, [meshes])

  useEffect(() => {
    layersRef.current?.solid.setVisible(visible)
    layersRef.current?.translucent.setVisible(visible)
  }, [visible])

  useEffect(() => {
    return () => {
      if (!map) return
      for (const id of [solidId, translucentId]) {
        try {
          if (map.getLayer(id)) map.removeLayer(id)
        } catch { /* map gone */ }
      }
    }
  }, [map, solidId, translucentId])
}
