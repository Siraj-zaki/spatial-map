import { useEffect, useMemo } from 'react'
import type { GeoJSONSource, Map as MapboxMapInstance } from 'mapbox-gl'

import type { Grid } from '@/lib/db'
import { gridBbox } from '@/lib/export'

interface ViewGhostFloorOverlayProps {
  map: MapboxMapInstance | null
  /** All grids in the warehouse, regardless of floor. */
  allGrids: Grid[]
  /** The floor currently in focus; null = "All Floors" → overlay paints nothing. */
  selectedFloorPlanId: number | null
}

const SRC = 'viewer-ghost-floor-source'
const FILL = 'viewer-ghost-floor-fill'
const LINE = 'viewer-ghost-floor-line'

/**
 * Paint a faint translucent outline over the bboxes of grids that
 * belong to floors other than the active one. Without this the user
 * loses every cue that other floors exist when they pick a single
 * floor — pro viewers (Mapbox indoor plugin, MapsIndoors) leave the
 * non-active extents visible as a "dimmed" plane.
 *
 * Implemented purely viewer-side so the editor's grid overlay stays
 * untouched. The fill is intentionally low-opacity so it doesn't fight
 * with the active floor's racks for attention.
 */
export function ViewGhostFloorOverlay({
  map,
  allGrids,
  selectedFloorPlanId,
}: ViewGhostFloorOverlayProps) {
  // Bboxes of grids on every non-active floor. When "All floors" is on
  // we hand the layer an empty FeatureCollection so it renders nothing.
  const data = useMemo(() => {
    if (selectedFloorPlanId === null) {
      return { type: 'FeatureCollection' as const, features: [] }
    }
    const features: GeoJSON.Feature<GeoJSON.Polygon>[] = []
    for (const g of allGrids) {
      if (g.floorPlanId === undefined) continue
      if (g.floorPlanId === selectedFloorPlanId) continue
      const [w, s, e, n] = gridBbox(g)
      features.push({
        type: 'Feature',
        properties: { gridId: g.id, floorPlanId: g.floorPlanId },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [w, s], [e, s], [e, n], [w, n], [w, s],
          ]],
        },
      })
    }
    return { type: 'FeatureCollection' as const, features }
  }, [allGrids, selectedFloorPlanId])

  useEffect(() => {
    if (!map) return
    const install = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(map as any).style) return
      if (!map.getSource(SRC)) {
        map.addSource(SRC, { type: 'geojson', data })
      }
      if (!map.getLayer(FILL)) {
        map.addLayer({
          id: FILL,
          type: 'fill',
          source: SRC,
          paint: {
            'fill-color': '#64748b',  // slate-500
            'fill-opacity': 0.08,
          },
        })
      }
      if (!map.getLayer(LINE)) {
        map.addLayer({
          id: LINE,
          type: 'line',
          source: SRC,
          paint: {
            'line-color': '#64748b',
            'line-width': 1,
            'line-opacity': 0.35,
            'line-dasharray': [3, 3],
          },
        })
      }
    }
    if (map.isStyleLoaded()) install()
    else map.once('style.load', install)
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(map as any).style) return
      try {
        if (map.getLayer(LINE)) map.removeLayer(LINE)
        if (map.getLayer(FILL)) map.removeLayer(FILL)
        if (map.getSource(SRC)) map.removeSource(SRC)
      } catch { /* style mid-tear-down */ }
    }
  }, [map])

  // Push the latest features into the source whenever the active floor
  // changes (the install effect runs once per map identity, so this
  // separate effect handles per-render updates).
  useEffect(() => {
    if (!map) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(map as any).style) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    if (src) src.setData(data)
  }, [map, data])

  return null
}
