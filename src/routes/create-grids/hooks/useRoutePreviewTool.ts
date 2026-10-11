import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Map as MapboxMapInstance } from 'mapbox-gl'

import type { DoorShape } from '@/lib/door/types'
import type { Grid } from '@/lib/db'
import {
  buildRoutingScene,
  computeRoute,
  type RouteResult,
} from '@/lib/routing'
import type { LineShape, PolygonShape } from '@/lib/shapes'
import type { Tool } from '@/lib/keyboard-shortcuts'

/**
 * State + click plumbing for the route-preview tool.
 *
 * Session state machine — one enum, three states, deterministic
 * transitions on every click. Prior attempt threaded transitions
 * through nested `setState` callbacks and got tangled; this version
 * is one `useReducer`-shaped switch statement that's trivial to
 * eyeball and prove correct.
 *
 *   idle   ── click ─▶ startPlaced   (A dropped, no B yet)
 *   startPlaced ── click ─▶ routed  (B dropped, compute path)
 *   routed ── click ─▶ startPlaced  (this click becomes the new A)
 *   any    ── Escape / tool off ─▶ idle
 *
 * Performance: `computeRoute` runs synchronously on the main thread.
 * At the default 25 cm cell size and a ~100 × 60 m warehouse the whole
 * pipeline (compile + A* + postprocess) finishes in well under a
 * frame, so a WebWorker isn't warranted for this pass. When we add
 * drag-to-preview we'll move it off-thread.
 */

type SessionState =
  | { phase: 'idle' }
  | { phase: 'startPlaced'; start: [number, number] }
  | {
      phase: 'routed'
      start: [number, number]
      end: [number, number]
      result: RouteResult
    }

export interface UseRoutePreviewToolInput {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  walls?: ReadonlyArray<LineShape>
  doors?: ReadonlyArray<DoorShape>
  polygons?: ReadonlyArray<PolygonShape>
  /**
   * Rack / grid shapes — treated as impassable obstacles by the
   * router. Without these the pathfinder would happily walk through
   * a rack block since the block is visually only a 3D extrusion,
   * not a wall.
   */
  grids?: ReadonlyArray<Grid>
}

/** One walkable polygon with a non-zero top surface height above ground. */
export interface ElevatedPolygon {
  vertices: [number, number][]
  /** Metres above sea level to render the route while over this polygon. */
  topZ: number
}

export interface UseRoutePreviewToolResult {
  start: [number, number] | null
  end: [number, number] | null
  path: [number, number][] | null
  status: RouteResult['status'] | null
  distanceMeters: number | null
  cellsExpanded: number | null
  /**
   * Every WALKABLE polygon in the scene whose top surface is above
   * ground (elevation + height > 0). Used by the overlay to lift the
   * route line above the extrusion so it stays visible while crossing.
   */
  elevatedPolygons: ElevatedPolygon[]
  /** Programmatic reset — hooked to the toolbar's "Clear" button. */
  reset: () => void
}

export function useRoutePreviewTool({
  mapInstance,
  activeTool,
  walls,
  doors,
  polygons,
  grids,
}: UseRoutePreviewToolInput): UseRoutePreviewToolResult {
  const [session, setSession] = useState<SessionState>({ phase: 'idle' })
  // Ref kept in step with `session` so the click handler can read the
  // latest phase without re-subscribing to the map's click event on
  // every state change. `sessionRef.current` is our synchronous view.
  const sessionRef = useRef<SessionState>(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const reset = useCallback(() => setSession({ phase: 'idle' }), [])

  // Wipe session state whenever the tool is toggled off.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (activeTool !== 'route-preview') setSession({ phase: 'idle' })
  }, [activeTool])

  // Latest-value refs so the click handler doesn't need to
  // re-subscribe every time the store changes. This keeps the
  // Mapbox event listener registration cheap and stable.
  const wallsRef = useRef(walls)
  const doorsRef = useRef(doors)
  const polygonsRef = useRef(polygons)
  const gridsRef = useRef(grids)
  useEffect(() => {
    wallsRef.current = walls
  }, [walls])
  useEffect(() => {
    doorsRef.current = doors
  }, [doors])
  useEffect(() => {
    polygonsRef.current = polygons
  }, [polygons])
  useEffect(() => {
    gridsRef.current = grids
  }, [grids])

  useEffect(() => {
    if (!mapInstance || activeTool !== 'route-preview') return
    const map = mapInstance
    const canvas = map.getCanvas()
    canvas.style.cursor = 'crosshair'

    // Bind the click at the CANVAS DOM level in the capture phase.
    // This wins over every Mapbox layer-specific `map.on('click', …)`
    // handler registered by other overlays (polygon / line / marker
    // detail drawers) which would otherwise `preventDefault()` the
    // event and starve the routing tool. `stopPropagation` also stops
    // Mapbox itself from firing its own `click` event, so no other
    // overlay's `map.on('click', …)` runs for the same gesture — that
    // matters most in the presenter viewer where clicking any
    // polygon (rooms, aisles, production area) would otherwise open a
    // detail drawer instead of placing the route point.
    const onCanvasClick = (ev: MouseEvent) => {
      if (ev.button !== 0) return
      const rect = canvas.getBoundingClientRect()
      const pt = { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
      if (pt.x < 0 || pt.y < 0 || pt.x > rect.width || pt.y > rect.height) return
      const lngLat = map.unproject([pt.x, pt.y])
      const click: [number, number] = [lngLat.lng, lngLat.lat]
      ev.preventDefault()
      ev.stopPropagation()
      // Read the current phase synchronously via the state ref (kept
      // in sync by a companion effect below). Doing the work OUTSIDE
      // setState means: (a) React 18 Strict Mode won't double-invoke
      // `computeRoute`, (b) errors surface where you can see them, and
      // (c) diagnostic logging happens exactly once per click.
      const cur = sessionRef.current
      if (cur.phase === 'idle') {
        setSession({ phase: 'startPlaced', start: click })
        return
      }
      if (cur.phase === 'startPlaced') {
        const scene = buildRoutingScene({
          walls: wallsRef.current,
          doors: doorsRef.current,
          polygons: polygonsRef.current,
          grids: gridsRef.current,
        })
        let result: RouteResult
        try {
          const t0 = performance.now()
          result = computeRoute(scene, { start: cur.start, end: click })
          const ms = performance.now() - t0
          // Diagnostic — surface enough to triage "why is nothing
          // drawn" without opening the router internals. Users can
          // share the console output; we can spot empty scenes,
          // blocked endpoints, unreachable pairs, or fine-scene
          // routes with a huge cell count instantly.
          console.info('[route-preview] computed', {
            status: result.status,
            waypoints: result.waypoints.length,
            distanceMeters: Math.round(result.distanceMeters * 100) / 100,
            cellsExpanded: result.cellsExpanded,
            walls: scene.walls?.length ?? 0,
            doors: scene.doors?.length ?? 0,
            obstacles: scene.obstacles?.length ?? 0,
            bounds: !!scene.bounds,
            ms: Math.round(ms),
          })
        } catch (err) {
          console.error('[route-preview] computeRoute threw', err)
          // Fall back to a straight-line "empty scene" so the user
          // still sees SOMETHING (an amber line signalling the
          // failure) instead of a silent void.
          result = {
            status: 'empty-scene',
            waypoints: [cur.start, click],
            distanceMeters: 0,
          }
        }
        setSession({ phase: 'routed', start: cur.start, end: click, result })
        return
      }
      // routed → startPlaced (this click seeds the next session)
      setSession({ phase: 'startPlaced', start: click })
    }

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setSession({ phase: 'idle' })
    }

    // `capture: true` runs the listener before any bubble-phase
    // handlers (Mapbox's canvas click handler is bubble-phase). That's
    // what lets stopPropagation() suppress Mapbox's `click` fire.
    canvas.addEventListener('click', onCanvasClick, { capture: true })
    window.addEventListener('keydown', onKey)
    return () => {
      canvas.removeEventListener('click', onCanvasClick, { capture: true })
      window.removeEventListener('keydown', onKey)
      canvas.style.cursor = ''
    }
  }, [mapInstance, activeTool])

  // Precompute the list of walkable polygons whose TOP SURFACE is
  // raised above ground. The route overlay uses this to lift its line
  // above the polygon extrusion so the path stays visible while
  // crossing (otherwise a polygon at `height: 0.6` would occlude a
  // ground-level line in a pitched 3D view).
  //
  // Only *walkable* polygons matter — the router treats non-role-tagged
  // polygons as walkable, which mirrors what we do here. If we ever
  // add polygon-role-as-obstacle configuration this list needs to
  // filter those out too.
  const elevatedPolygons = useMemo<ElevatedPolygon[]>(() => {
    if (!polygons) return []
    const out: ElevatedPolygon[] = []
    for (const p of polygons) {
      if (!p.visible) continue
      if (p.vertices.length < 3) continue
      const elev = p.config?.elevation ?? 0
      const height = p.config?.height ?? 0
      const topZ = elev + height
      // A small epsilon avoids z-fighting when topZ is exactly 0 — we
      // never emit a polygon that's genuinely at ground level (it'd
      // add no value; the line renders correctly there already).
      if (topZ <= 0.001) continue
      out.push({ vertices: p.vertices, topZ })
    }
    return out
  }, [polygons])

  if (session.phase === 'idle') {
    return {
      start: null,
      end: null,
      path: null,
      status: null,
      distanceMeters: null,
      cellsExpanded: null,
      elevatedPolygons,
      reset,
    }
  }
  if (session.phase === 'startPlaced') {
    return {
      start: session.start,
      end: null,
      path: null,
      status: null,
      distanceMeters: null,
      cellsExpanded: null,
      elevatedPolygons,
      reset,
    }
  }
  return {
    start: session.start,
    end: session.end,
    path: session.result.waypoints,
    status: session.result.status,
    distanceMeters: session.result.distanceMeters,
    cellsExpanded: session.result.cellsExpanded ?? null,
    elevatedPolygons,
    reset,
  }
}
