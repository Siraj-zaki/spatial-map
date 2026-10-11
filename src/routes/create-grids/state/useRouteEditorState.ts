import { useEffect, useRef, useState } from 'react'

import { usePersistedState } from '@/lib/persisted-state'
import type { RouteSnap } from '@/lib/route-snap'
import {
  DEFAULT_ROUTE_CONFIG,
  type RouteShapeConfig,
} from '@/lib/shapes'

/**
 * Local editor state for the route (wayfinding path) tool. Mirrors the
 * line tool's click-N-times shape but has its own snap engine
 * (`resolveRouteSnap`) tuned for path junctions rather than wall
 * axis / endpoint locking.
 */
export function useRouteEditorState() {
  const [selectedRouteIds, setSelectedRouteIds] = useState<Set<number>>(
    new Set(),
  )
  const [routeConfig, setRouteConfig] = usePersistedState<RouteShapeConfig>(
    'sgv-draw-config:route',
    () => ({ ...DEFAULT_ROUTE_CONFIG }),
  )
  const [routeDraftVertices, setRouteDraftVertices] = useState<
    [number, number][]
  >([])
  const [routeDraftCursor, setRouteDraftCursor] = useState<
    [number, number] | null
  >(null)
  const [routeDraftSnap, setRouteDraftSnap] = useState<RouteSnap | null>(null)

  // Mirror the latest chain into a ref for the dblclick/keydown handlers.
  const routeVerticesRef = useRef<[number, number][]>([])
  useEffect(() => {
    routeVerticesRef.current = routeDraftVertices
  }, [routeDraftVertices])

  return {
    selectedRouteIds,
    setSelectedRouteIds,
    routeConfig,
    setRouteConfig,
    routeDraftVertices,
    setRouteDraftVertices,
    routeDraftCursor,
    setRouteDraftCursor,
    routeDraftSnap,
    setRouteDraftSnap,
    routeVerticesRef,
  }
}
