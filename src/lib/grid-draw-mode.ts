import MapboxDraw from '@mapbox/mapbox-gl-draw'
import type {
  DrawCustomMode,
  DrawCustomModeThis,
} from '@mapbox/mapbox-gl-draw'
import type { Feature, LineString, Point } from 'geojson'
import type { GeoJSONSource, Map as MapboxMapInstance } from 'mapbox-gl'
import { type GridConfig } from './grid-generators'

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
 */
export interface DrawGridState {
  /** Start point, set on the first click. */
  startLngLat: [number, number] | null
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

function setAnchor(map: MapboxMapInstance, lngLat: [number, number] | null) {
  const src = map.getSource(ANCHOR_SOURCE) as GeoJSONSource | undefined
  if (!src) return
  if (!lngLat) {
    src.setData({ type: 'FeatureCollection', features: [] })
    return
  }
  const feature: Feature<Point> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: lngLat },
  }
  src.setData({ type: 'FeatureCollection', features: [feature] })
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
    const state: DrawGridState = {
      startLngLat: options.start ?? null,
      config: options.config,
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
    const lng = e.lngLat.lng
    const lat = e.lngLat.lat
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
    if (e.key === 'Escape') {
      setAnchor(this.map, null)
      state.startLngLat = null
      ;(this as unknown as { fire: FireFn }).fire('draw.anchorclear', null)
      this.changeMode(modes.SIMPLE_SELECT)
    }
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
    ;(this as unknown as { fire: FireFn }).fire('draw.anchorclear', null)
  },
}

export default DrawGridMode

export const DRAW_GRID_MODE_NAME = 'draw_grid'
