import MapboxDraw from '@mapbox/mapbox-gl-draw'
import type {
  DrawCustomMode,
  DrawCustomModeThis,
} from '@mapbox/mapbox-gl-draw'
import type { Feature, LineString, Point } from 'geojson'
import type { GeoJSONSource, Map as MapboxMapInstance } from 'mapbox-gl'
import { type GridConfig } from './grid-generators'
import { isPathLayout } from './grid-path'
import { unprojectOnScene } from './unproject-at-altitude'

const { cursors, events, modes } = MapboxDraw.constants

const ANCHOR_SOURCE = 'draw-anchor-source'
const ANCHOR_LAYER = 'draw-anchor-layer'

/**
 * State for the `draw_grid` mode.
 *
 * The mode is a two-click rectangle tool with **no live preview**:
 *   1. First click  → set the start corner (the "anchor"). A small dot is
 *      rendered at that point so the user can see where they clicked.
 *   2. Mouse move   → nothing is drawn on the map (the user can pan/zoom
 *      and inspect the basemap freely while choosing the second corner).
 *   3. Second click → commit. A synthetic LineString (start → end) is
 *      fired via the `draw.create` event. The committed grid is rendered
 *      by `MapGridOverlay` from the persisted grid list, not by this mode.
 *
 * The drawing line itself is NOT added to the mapbox-gl-draw store, so
 * nothing in the canvas shows a partial rectangle or a leftover line —
 * just the static anchor dot between the two clicks.
 *
 * Path layout (`config.layout === 'path'`, see grid-path.ts): every click
 * adds a vertex (shown as a dot, fired as `draw.pathvertices`); a
 * double-click or Enter finishes and fires `draw.create` with the whole
 * LineString; Backspace drops the last vertex (via `onTrash`); Esc cancels. Double-click
 * zoom is off while the mode runs. `options.vertices` seeds the path, so
 * Re-draw on a path grid continues from its last point instead of starting
 * over (and a config change mid-draw keeps the points clicked so far).
 */
export interface DrawGridState {
  /** Start point, set on the first click. */
  startLngLat: [number, number] | null
  /** Path layout: every clicked vertex so far. */
  vertices: [number, number][]
  /** Path layout: last click (time + screen point) for double-click detection. */
  lastClick: { t: number; x: number; y: number } | null
  /** True when the mode turned double-click zoom off (and must turn it back on). */
  dblZoomOff: boolean
  /** Configuration snapshot for the in-progress grid. */
  config: GridConfig
}

/** Options passed via `draw.changeMode('draw_grid', { config, start? })`. */
export interface DrawGridOptions {
  config: GridConfig
  /**
   * If set, the mode is pre-anchored at this point. The first click is
   * treated as the second corner (commits the grid). Used by the re-draw
   * flow to seed the live preview with an existing grid's bbox.
   */
  start?: [number, number]
  /** Grid ID being re-drawn (so the route can update the right row on commit). */
  redrawingGridId?: number
  /**
   * Path layout: vertices already placed. The draw continues from the last
   * one — the next click adds a point after it, Backspace removes from it.
   */
  vertices?: [number, number][]
}

type GridContext = DrawCustomModeThis & DrawCustomMode<DrawGridState, DrawGridOptions>
type FireFn = (eventName: string, data: unknown) => void

/**
 * Add a small circle layer that marks the user's first click (the anchor).
 * The layer is removed in `onStop` so it never lingers after the user
 * finishes drawing.
 */
function ensureAnchorLayer(map: MapboxMapInstance) {
  if (!map.getSource(ANCHOR_SOURCE)) {
    map.addSource(ANCHOR_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
  }
  if (!map.getLayer(ANCHOR_LAYER)) {
    map.addLayer({
      id: ANCHOR_LAYER,
      type: 'circle',
      source: ANCHOR_SOURCE,
      paint: {
        'circle-radius': 6,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#1f2937',
        'circle-stroke-width': 2,
      },
    })
  }
}

function setAnchor(map: MapboxMapInstance, lngLat: [number, number] | [number, number][] | null) {
  const src = map.getSource(ANCHOR_SOURCE) as GeoJSONSource | undefined
  if (!src) return
  if (!lngLat) {
    src.setData({ type: 'FeatureCollection', features: [] })
    return
  }
  const points = (Array.isArray(lngLat[0]) ? lngLat : [lngLat]) as [number, number][]
  const features: Feature<Point>[] = points.map((p) => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: p },
  }))
  src.setData({ type: 'FeatureCollection', features })
}

/** Double-click window for the path layout's "finish" gesture. */
const DBLCLICK_MS = 350
const DBLCLICK_PX = 6

/** Path layout: fire `draw.create` with the collected vertices, then leave the mode. */
function finishPath(ctx: GridContext, state: DrawGridState) {
  const verts = state.vertices.filter(
    (v, i, all) => i === 0 || v[0] !== all[i - 1][0] || v[1] !== all[i - 1][1],
  )
  if (verts.length < 2) return
  const lineFeature: Feature<LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: verts },
  }
  ;(ctx as unknown as { fire: FireFn }).fire(events.CREATE, { features: [lineFeature] })
  ctx.changeMode(modes.SIMPLE_SELECT)
}

const DrawGridMode: DrawCustomMode<DrawGridState, DrawGridOptions> = {
  onSetup(this: GridContext, options: DrawGridOptions): DrawGridState {
    this.updateUIClasses({ mouse: cursors.ADD })
    this.setActionableState({
      trash: true,
      combineFeatures: false,
      uncombineFeatures: false,
    })
    ensureAnchorLayer(this.map)
    const pathMode = isPathLayout(options.config)
    const state: DrawGridState = {
      startLngLat: pathMode ? null : options.start ?? null,
      vertices: [],
      lastClick: null,
      dblZoomOff: false,
      config: options.config,
    }
    if (pathMode && this.map.doubleClickZoom.isEnabled()) {
      this.map.doubleClickZoom.disable()
      state.dblZoomOff = true
    }
    if (pathMode) {
      const seed = options.vertices ?? []
      if (seed.length > 0) {
        state.vertices = seed.map((v) => [v[0], v[1]] as [number, number])
        setAnchor(this.map, state.vertices)
        const ctx = this as unknown as { fire: FireFn }
        // `start` is the last vertex so the live preview's cursor point
        // begins where the path ends (not back at its first point).
        ctx.fire('draw.firstclick', { start: state.vertices[state.vertices.length - 1] })
        ctx.fire('draw.pathvertices', { vertices: state.vertices.slice() })
      }
      return state
    }
    // If pre-anchored (re-draw), show the anchor dot and fire the
    // firstclick event so the route can start the live preview.
    if (options.start) {
      setAnchor(this.map, options.start)
      ;(this as unknown as { fire: FireFn }).fire('draw.firstclick', {
        start: options.start,
      })
    }
    return state
  },

  onClick(this: GridContext, state: DrawGridState, e) {
    // Where the cursor touches the scene at the rack's elevation, not the
    // ground under it (off by the floor's height at pitch on upper floors).
    const { lng, lat } = unprojectOnScene(this.map, e.point, state.config.elevation ?? 0)
    if (isPathLayout(state.config)) {
      // A second click on (almost) the same spot within the window is the
      // double-click that finishes the path — it doesn't add a vertex.
      const now = performance.now()
      const last = state.lastClick
      state.lastClick = { t: now, x: e.point.x, y: e.point.y }
      if (last && now - last.t < DBLCLICK_MS && Math.hypot(e.point.x - last.x, e.point.y - last.y) < DBLCLICK_PX) {
        state.lastClick = null
        finishPath(this, state)
        return
      }
      state.vertices.push([lng, lat])
      setAnchor(this.map, state.vertices)
      const ctx = this as unknown as { fire: FireFn }
      const fire: FireFn = (name, data) => ctx.fire(name, data)
      if (state.vertices.length === 1) fire('draw.firstclick', { start: state.vertices[0] })
      fire('draw.pathvertices', { vertices: state.vertices.slice() })
      return
    }
    if (!state.startLngLat) {
      // First click: drop the static anchor at the chosen corner. No
      // cells are drawn — the user is still choosing the second corner.
      state.startLngLat = [lng, lat]
      setAnchor(this.map, state.startLngLat)
      ;(this as unknown as { fire: FireFn }).fire('draw.firstclick', {
        start: state.startLngLat,
      })
      return
    }
    // Second click: commit. The bbox is `[min, min, max, max]` of the two
    // points; the resulting grid is rendered by MapGridOverlay from the
    // persisted list (we don't push cells into a live source).
    const start = state.startLngLat
    const current: [number, number] = [lng, lat]
    // Skip the commit if the user clicked the exact same point (a single
    // point has no bbox, so buildGridFromLine would return nothing).
    if (start[0] === current[0] && start[1] === current[1]) {
      setAnchor(this.map, null)
      state.startLngLat = null
      ;(this as unknown as { fire: FireFn }).fire('draw.anchorclear', null)
      this.changeMode(modes.SIMPLE_SELECT)
      return
    }
    const lineFeature: Feature<LineString> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [start, current],
      },
    }
    ;(this as unknown as { fire: FireFn }).fire(events.CREATE, {
      features: [lineFeature],
    })
    this.changeMode(modes.SIMPLE_SELECT)
  },

  // No-op: the user must explicitly place the second click. We don't
  // draw cells while the mouse moves, per the "static two-click
  // rectangle" spec — the cells only appear after both corners are set.

  onKeyUp(this: GridContext, state: DrawGridState, e: KeyboardEvent) {
    if (isPathLayout(state.config)) {
      if (e.key === 'Enter') {
        finishPath(this, state)
        return
      }
    }
    if (e.key === 'Escape') {
      setAnchor(this.map, null)
      state.startLngLat = null
      ;(this as unknown as { fire: FireFn }).fire('draw.anchorclear', null)
      this.changeMode(modes.SIMPLE_SELECT)
    }
  },

  // Path layout: drop the last vertex. MapboxDraw never passes Backspace /
  // Delete to `onKeyUp` (it reserves them for trash), so the editor's
  // Backspace shortcut calls `draw.trash()`, which lands here.
  onTrash(this: GridContext, state: DrawGridState) {
    if (!isPathLayout(state.config) || state.vertices.length === 0) return
    state.vertices.pop()
    setAnchor(this.map, state.vertices.length ? state.vertices : null)
    const ctx = this as unknown as { fire: FireFn }
    if (state.vertices.length === 0) ctx.fire('draw.anchorclear', null)
    else ctx.fire('draw.pathvertices', { vertices: state.vertices.slice() })
  },

  // No-op: the drawing line is never added to the mapbox-gl-draw store
  // (see DrawGridState docstring), so there's nothing to filter out of
  // mapbox-gl-draw's own display layers. The committed grid is rendered
  // by MapGridOverlay from the persisted grid list.
  toDisplayFeatures(
    this: GridContext,
    _state: DrawGridState,
    _geojson,
    _display
  ) {
    // intentionally empty
  },

  onStop(this: GridContext, state: DrawGridState) {
    // Always clear the anchor dot when we leave the mode (commit, cancel,
    // or mode swap). The committed cells are rendered by MapGridOverlay
    // from the persisted list — this mode owns no cell rendering.
    setAnchor(this.map, null)
    state.startLngLat = null
    state.vertices = []
    if (state.dblZoomOff) {
      // The finishing double-click's own `dblclick` event arrives after
      // this (the mode leaves on its second click), so turn double-click
      // zoom back on only once that event has passed.
      const map = this.map
      setTimeout(() => map.doubleClickZoom.enable(), DBLCLICK_MS + 100)
      state.dblZoomOff = false
    }
    ;(this as unknown as { fire: FireFn }).fire('draw.anchorclear', null)
  },
}

export default DrawGridMode

export const DRAW_GRID_MODE_NAME = 'draw_grid'
