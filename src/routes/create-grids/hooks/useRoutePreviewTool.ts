import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { booleanPointInPolygon } from '@turf/turf'
import type { Map as MapboxMapInstance } from 'mapbox-gl'

import { imageCorners } from '@/lib/image-generators'
import { raisedSurfaces, type ElevatedPolygon } from '@/lib/routing/surface'
import type { Tool } from '@/lib/keyboard-shortcuts'
import {
  floorsOf,
  planRoutes,
  type FacilityRoutingInput,
  type Floor,
  type PlanResult,
  type RouteOption,
} from '@/lib/routing/floors'
import { unprojectAtAltitude, unprojectOnScene } from '@/lib/unproject-at-altitude'

/**
 * State + click plumbing for the route tool (editor "Route preview" and
 * the viewer's "Navigate").
 *
 *   idle   ── click ─▶ startPlaced   (A dropped, no B yet)
 *   startPlaced ── click ─▶ routed  (B dropped, routes planned)
 *   routed ── click ─▶ startPlaced  (this click becomes the new A)
 *   any    ── Escape / tool off ─▶ idle
 *
 * Every click lands on a FLOOR: the highest shown floor whose plan the
 * cursor ray meets inside its outline (hide an upper floor to click the
 * one below), at the surface under the cursor on that floor
 * (`unprojectOnScene`). A facility without floor plans is one floor.
 *
 * Planning is `planRoutes` (routing/floors.ts): each floor walked on its
 * own walls / doors / racks, floors joined through stairs, escalators and
 * lifts; options fastest / step-free / alternative. Runs synchronously —
 * a few floors plan in well under a frame.
 */

/** A placed route end: its floor, position and height (for drawing). */
export interface RoutePin {
  floorId: number | null
  coord: [number, number]
  z: number
}

export type RoutePlanStatus = PlanResult['status']

type SessionState =
  | { phase: 'idle' }
  | { phase: 'startPlaced'; start: RoutePin }
  | { phase: 'routed'; start: RoutePin; end: RoutePin; result: PlanResult }

export interface UseRoutePreviewToolInput {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  /** Every floor's shapes in the facility — hidden floors included, so a
   *  route can pass through a floor that isn't on screen. */
  facility: FacilityRoutingInput
  /** Floors a click may land on (the ones shown). Null: every visible plan. */
  pickableFloorIds?: ReadonlySet<number> | null
}

export type { ElevatedPolygon } from '@/lib/routing/surface'

export interface UseRoutePreviewToolResult {
  start: RoutePin | null
  end: RoutePin | null
  status: RoutePlanStatus | null
  options: RouteOption[]
  selected: number
  setSelected: (i: number) => void
  floors: Floor[]
  /** Raised walkable polygons per floor — the overlay lifts the line onto them. */
  elevatedPolygons: ElevatedPolygon[]
  reset: () => void
}

export function useRoutePreviewTool({
  mapInstance,
  activeTool,
  facility,
  pickableFloorIds = null,
}: UseRoutePreviewToolInput): UseRoutePreviewToolResult {
  const [session, setSession] = useState<SessionState>({ phase: 'idle' })
  const [selected, setSelected] = useState(0)
  // Read by the click handler without re-binding it on every change.
  const sessionRef = useRef<SessionState>(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])
  const facilityRef = useRef(facility)
  useEffect(() => {
    facilityRef.current = facility
  }, [facility])
  const pickableRef = useRef(pickableFloorIds)
  useEffect(() => {
    pickableRef.current = pickableFloorIds
  }, [pickableFloorIds])

  const floors = useMemo(() => floorsOf(facility), [facility])
  const floorsRef = useRef(floors)
  useEffect(() => {
    floorsRef.current = floors
  }, [floors])

  const reset = useCallback(() => setSession({ phase: 'idle' }), [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (activeTool !== 'route-preview') setSession({ phase: 'idle' })
  }, [activeTool])

  useEffect(() => {
    if (!mapInstance || activeTool !== 'route-preview') return
    const map = mapInstance
    const canvas = map.getCanvas()
    canvas.style.cursor = 'crosshair'

    /** The floor and point under the cursor. */
    const pick = (pt: { x: number; y: number }): RoutePin => {
      const fl = floorsRef.current
      const images = facilityRef.current.images
      const pickable = pickableRef.current
      for (const f of [...fl].reverse()) {
        if (pickable && !pickable.has(f.id)) continue
        const img = images.find((i) => i.id === f.id)
        if (!img || img.visible === false) continue
        const quad = imageCorners(img)
        if (!quad) continue
        const hit = unprojectAtAltitude(map, pt, f.elevation)
        if (!booleanPointInPolygon([hit.lng, hit.lat], { type: 'Polygon', coordinates: [[...quad, quad[0]]] })) continue
        const p = unprojectOnScene(map, pt, f.elevation)
        return { floorId: f.id, coord: [p.lng, p.lat], z: f.elevation }
      }
      // Off every shown plan: the lowest shown floor (or ground).
      const lowest = fl.find((f) => !pickable || pickable.has(f.id)) ?? null
      const z = lowest?.elevation ?? 0
      const p = unprojectOnScene(map, pt, z)
      return { floorId: lowest?.id ?? null, coord: [p.lng, p.lat], z }
    }

    // Bound on the CANVAS in the capture phase so it wins over every
    // overlay's `map.on('click', …)` (which would open a detail drawer
    // instead of placing the point); `stopPropagation` keeps Mapbox's own
    // click from firing for the same gesture.
    const onCanvasClick = (ev: MouseEvent) => {
      if (ev.button !== 0) return
      const rect = canvas.getBoundingClientRect()
      const pt = { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
      if (pt.x < 0 || pt.y < 0 || pt.x > rect.width || pt.y > rect.height) return
      ev.preventDefault()
      ev.stopPropagation()
      const click = pick(pt)
      const cur = sessionRef.current
      if (cur.phase !== 'startPlaced') {
        setSession({ phase: 'startPlaced', start: click })
        return
      }
      let result: PlanResult
      try {
        result = planRoutes(
          facilityRef.current,
          { floorId: cur.start.floorId, coord: cur.start.coord },
          { floorId: click.floorId, coord: click.coord },
        )
      } catch (err) {
        console.error('[route-preview] planRoutes threw', err)
        result = { status: 'unreachable' }
      }
      setSelected(0)
      setSession({ phase: 'routed', start: cur.start, end: click, result })
    }

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setSession({ phase: 'idle' })
    }

    canvas.addEventListener('click', onCanvasClick, { capture: true })
    window.addEventListener('keydown', onKey)
    return () => {
      canvas.removeEventListener('click', onCanvasClick, { capture: true })
      window.removeEventListener('keydown', onKey)
      canvas.style.cursor = ''
    }
  }, [mapInstance, activeTool])

  // Raised walkable polygons: the overlay lifts each leg onto the tops of
  // the ones on its floor (by height) so the line isn't buried inside the
  // extrusion (rooms drawn 1 m tall, a floor-area slab).
  const elevatedPolygons = useMemo(() => raisedSurfaces(facility.polygons), [facility.polygons])

  const base = { floors, elevatedPolygons, reset, selected, setSelected }
  if (session.phase === 'idle') return { ...base, start: null, end: null, status: null, options: [] }
  if (session.phase === 'startPlaced') return { ...base, start: session.start, end: null, status: null, options: [] }
  const r = session.result
  return {
    ...base,
    start: session.start,
    end: session.end,
    status: r.status,
    options: r.status === 'ok' ? r.options : [],
    selected: r.status === 'ok' ? Math.min(selected, r.options.length - 1) : 0,
  }
}
