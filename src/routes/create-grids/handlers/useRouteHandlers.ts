import { useCallback, type Dispatch, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { type Tool } from '@/lib/keyboard-shortcuts'
import { type RouteShape } from '@/lib/shapes'
import { useSpatialStore } from '@/lib/spatial-store'

/**
 * Route (wayfinding path) CRUD handlers. Routes persist via the
 * spatial store's optimistic update/commit pattern rather than
 * `apiDb.routes.*` — matches the newer entity-kind pattern the store
 * was extended to support for pathfinding.
 *
 * The set is intentionally small: routes don't have their own
 * transform / rotate / scale, per-vertex edit (yet), or config
 * dialog. The route's `RouteType` (walking / driving / etc.) is the
 * only meaningful config field and it's edited via the sidebar's
 * dropdown, which calls `setRouteConfig` directly.
 */
export function useRouteHandlers({
  mapInstance,
  savedRoutes,
  setSelectedRouteIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  savedRoutes: RouteShape[]
  setSelectedRouteIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  const handleFitToRouteById = useCallback(
    (id: number) => {
      const route = savedRoutes.find((r) => r.id === id)
      if (!route || route.vertices.length < 2 || !mapInstance) return
      const lngs = route.vertices.map((v) => v[0])
      const lats = route.vertices.map((v) => v[1])
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ]
      mapInstance.fitBounds(bounds, {
        padding: 80,
        maxZoom: 20,
        duration: 500,
      })
    },
    [mapInstance, savedRoutes],
  )

  const handleDeleteRouteById = useCallback(
    (id: number) => {
      const store = useSpatialStore.getState()
      store.deleteLocal('routes', id)
      void store.commit('routes', id)
      setSelectedRouteIds(new Set())
    },
    [setSelectedRouteIds],
  )

  const handleRenameRoute = useCallback((id: number, name: string) => {
    const store = useSpatialStore.getState()
    store.updateLocal('routes', id, { name })
  }, [])

  const handleExitRoutePlacement = useCallback(
    () => setActiveTool('pan'),
    [setActiveTool],
  )

  return {
    handleFitToRouteById,
    handleDeleteRouteById,
    handleRenameRoute,
    handleExitRoutePlacement,
  }
}
