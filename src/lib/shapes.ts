/**
 * Non-grid shape types: polygons, circles, lines, and markers.
 *
 * Grids stay in their own table (`db.grids`) with the existing `GridConfig`
 * so the established grid pipeline keeps working untouched. The new shapes
 * follow a parallel pattern: one table per kind, each row carries its own
 * `config` snapshot, and all geometry is stored in meters / lng-lat just
 * like grids.
 */

import type { LengthUnit } from './units'

export type ShapeKind = 'grid' | 'polygon' | 'circle' | 'line' | 'route' | 'marker' | 'image' | 'model' | 'text' | 'stair' | 'imagePlane'

/**
 * Per-shape tooltip activation. The hover-popup overlay
 * (`map-shape-tooltip.tsx`) used to fire on `mousemove` for every kind;
 * now each shape's config carries this knob so a single shape can opt
 * into "only show when I click" — useful for noisy maps where hovering
 * triggers too many popups, or for click-driven workflows like data
 * inspection. `undefined` is treated as `'hover'` for backward
 * compatibility with shapes saved before this field existed.
 */
export type TooltipTrigger = 'hover' | 'click'

/** Fields common to every saved shape (and to grids). */
export interface ShapeBase {
  id?: number
  /** Human-readable label shown in the saved-shapes list. */
  name: string
  /** Optional foreign key to a Zone row. */
  zoneId?: number
  /**
   * v13+. Optional FK to an `images` row used as a floor plan. When
   * the referenced image is hidden, this shape is hidden too. Set via
   * the bulk-assign dialog; never auto-stamped at creation time.
   */
  floorPlanId?: number
  /** Display unit stamped at draw time (same semantics as `GridConfig.unit`). */
  unit: LengthUnit
  /** Master visibility toggle. */
  visible: boolean
  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Polygon
// ---------------------------------------------------------------------------

export interface PolygonShape extends ShapeBase {
  /**
   * Closed ring of [lng, lat] vertices. We do NOT duplicate the first
   * vertex at the end — the renderer handles closing. Minimum 3 vertices.
   */
  vertices: [number, number][]
  /** Rotation in degrees (-180..+180) around the polygon's centroid. */
  rotation: number
  /**
   * Per-warehouse role this polygon plays — Office, Storage, Loading
   * bay, etc. The string is the `key` of an entry in the host
   * warehouse's `roleVocabulary.polygon`. Optional; old rows have no
   * role and render as generic "Polygon #N".
   */
  role?: string
  config: FillShapeConfig
}

// ---------------------------------------------------------------------------
// Circle
// ---------------------------------------------------------------------------

/**
 * Two sub-modes:
 *  - `single`: one circle defined by center + radius (in meters).
 *  - `grid`:   a bbox (start / current corners) plus a `cellRadius`. The
 *              renderer materializes one circle inscribed in each cell of
 *              the underlying square grid.
 *
 * The fields are intentionally optional and gated by `mode` so a single
 * row can carry either variant without separate tables.
 */
export interface CircleShape extends ShapeBase {
  mode: 'single' | 'grid'
  /** Used when `mode === 'single'`. */
  center?: [number, number]
  /** Radius in METERS. `mode === 'single'`. */
  radius?: number
  /** Used when `mode === 'grid'`. Two opposite corners of the cell bbox. */
  start?: [number, number]
  current?: [number, number]
  /** Cell radius in METERS for the circle-grid sub-mode. */
  cellRadius?: number
  /** Cell size in METERS for the circle-grid sub-mode (square cells). */
  cellSize?: number
  /** Rotation in degrees (-180..+180). Around centroid for single, around bbox center for grid. */
  rotation: number
  /**
   * Per-warehouse role this circle plays — see `PolygonShape.role`.
   * References a `key` in the host warehouse's `roleVocabulary.circle`.
   */
  role?: string
  config: FillShapeConfig
}

// ---------------------------------------------------------------------------
// Line / polyline
// ---------------------------------------------------------------------------

export interface LineShape extends ShapeBase {
  /** Ordered [lng, lat] vertices. Minimum 2. */
  vertices: [number, number][]
  /** Rotation in degrees (-180..+180) around the centroid of the vertex list. */
  rotation: number
  config: LineShapeConfig
}

// ---------------------------------------------------------------------------
// Route / wayfinding path
// ---------------------------------------------------------------------------

/**
 * A user-drawn navigation path (walking, driving, emergency, etc.).
 * Geometry mirrors LineShape — an ordered vertex list rendered as a
 * polyline — but semantics differ: each vertex is a *waypoint* on a
 * wayfinding path, not a wall corner. The path is decorated with
 * directional arrows and a type-specific colour so users can visually
 * distinguish the intent from walls / aisles at a glance.
 *
 * Each vertex is designed to be a node in a future pathfinding graph;
 * when turn-by-turn navigation ships, an A* / Dijkstra solver reads
 * `vertices` as nodes and consecutive pairs as edges. The `type`
 * field lets the solver filter to relevant path networks (e.g. only
 * walkable paths when routing pedestrians).
 */
export interface RouteShape extends ShapeBase {
  /** Ordered [lng, lat] waypoints. Minimum 2. */
  vertices: [number, number][]
  /** Rotation in degrees (-180..+180). Kept for symmetry with LineShape;
   *  routes are typically drawn without rotation and this stays 0. */
  rotation: number
  config: RouteShapeConfig
}

// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------

export interface MarkerShape extends ShapeBase {
  position: [number, number]
  /** Icon rotation in degrees (-180..+180). Treated as map bearing. */
  bearing: number
  config: MarkerShapeConfig
}

// ---------------------------------------------------------------------------
// Image overlay
// ---------------------------------------------------------------------------

/**
 * A raster image (PNG / JPEG / GIF) anchored to a lng/lat bounding box on
 * the map and rendered as a Mapbox `image` source + `raster` layer. The
 * geometry mirrors the circle-grid pattern: `start` and `current` are
 * the two opposite corners the user drag-defined, and `rotation` spins
 * the rendered quad around the bbox center. The four raster corner
 * coordinates Mapbox needs are computed from those fields at render
 * time (see `imageCorners` in `image-generators.ts`).
 *
 * The image bytes are stored inline as a data URL on `imageData` so the
 * shape round-trips through IndexedDB without any external storage. We
 * keep `mimeType` separate so the export step can label the payload, and
 * `naturalWidth` / `naturalHeight` so future drawing flows (e.g.
 * Shift-drag for aspect-lock) can preserve the source aspect ratio.
 */
export interface ImageShape extends ShapeBase {
  /** First corner the user clicked when drawing the bbox. */
  start: [number, number]
  /** Opposite corner — where the user released the mouse. */
  current: [number, number]
  /** Rotation in degrees (-180..+180) around the bbox center. */
  rotation: number
  /** Data URL (`data:image/png;base64,…`) of the uploaded image bytes. Legacy — prefer `imageUrl`. */
  imageData?: string
  /** Object-store URL for the uploaded image. Preferred over inline `imageData`. */
  imageUrl?: string
  /** MIME type of the original file (e.g. `image/png`). */
  mimeType: string
  /** Intrinsic pixel width of the source image. */
  naturalWidth: number
  /** Intrinsic pixel height of the source image. */
  naturalHeight: number
  config: ImageShapeConfig
}

/**
 * Non-destructive rectangular crop applied at render time. Percentages
 * are of the FULL image size, taken inward from each edge. All four
 * values in [0, 100); their sums along each axis must stay strictly
 * below 100 or the crop is treated as absent.
 *
 * Stored as a config field (not baked into the image bytes) so the
 * user can adjust or clear the crop at any time — the original file
 * in the object store is preserved. The full-image world bbox
 * (`start` / `current`) is unchanged too, so an existing map
 * alignment doesn't drift when you edit the crop. Only the raster's
 * rendered content + source-coordinate sub-rectangle change.
 */
export interface ImageCrop {
  top: number
  right: number
  bottom: number
  left: number
}

export interface ImageShapeConfig {
  /** 0..100 percent. */
  opacity: number
  /**
   * 3D base altitude in METERS above the basemap surface. 0 = on the
   * ground. Used to stack floor-plan images vertically — e.g. a
   * "Second floor" floor-plan image at elevation 4m sits visually
   * above the ground-floor plan in 3D. The floor-plan layer
   * (src/lib/floor-plan-layer.ts) draws the image at this altitude.
   *
   * Optional + backfilled to 0 so existing images don't suddenly
   * float when the editor loads them after this field was introduced.
   */
  elevation?: number
  /**
   * Optional per-edge crop as percentages of the full image. Undefined
   * (or an all-zero rect) means no crop. See `ImageCrop` for details.
   */
  crop?: ImageCrop
  /**
   * Hide the part of the image outside the floor's outermost walls
   * (sheet margin, title block, grid bubbles). Non-destructive: a render
   * mask from the walls with this `floorPlanId`, recomputed when they
   * change. No walls → whole image shown.
   */
  clipToWalls?: boolean
  /** Extra image kept around the outer walls, metres (default 0.5). */
  clipMargin?: number
  showLabels: boolean
  label: string
  labelSize: number
  labelColor: string
  /** Where the label anchors relative to the image. */
  labelPosition: MarkerLabelPosition
  /** Per-shape tooltip activation. Defaults to 'hover' when undefined. */
  tooltipTrigger?: TooltipTrigger
}

// ---------------------------------------------------------------------------
// Style configs
// ---------------------------------------------------------------------------

/** Fill-based shapes (polygon, circle). Shares much of GridConfig's vocabulary. */
export interface FillShapeConfig {
  color: string
  borderColor: string
  borderWidth: number
  /** 0..100 percent. */
  opacity: number
  /** 3D base in meters. 0 = flat. */
  elevation: number
  /** 3D extrusion height in meters (above `elevation`). 0 = flat. */
  height: number
  /**
   * When true (default), the shape's top face renders with lower
   * emissive-strength so shadows from other 3D shapes darken it
   * visibly. Set false to fully self-illuminate the top face — it
   * won't darken at low zoom, but no shadows will land on it either.
   */
  receiveShadows?: boolean
  showLabels: boolean
  /** Single label text — unlike grids, polygons/circles carry one label. */
  label: string
  labelSize: number
  labelColor: string
  /** Lift in meters above the cell face. */
  labelAltitude: number
  /**
   * When true, the label lies FLAT on the shape's top face (pitches and
   * rotates with the map). When false/undefined, the label stands
   * upright as a screen-space billboard facing the camera (default,
   * matches how symbols behave everywhere else in Mapbox).
   */
  labelFlat?: boolean
  /**
   * Label position offset in METERS from the shape's centroid, in the
   * shape's LOCAL (unrotated) frame. `labelOffsetX` = east/right,
   * `labelOffsetY` = north/up. The offset rotates with the shape so
   * the label stays anchored to the same spot relative to the shape's
   * geometry. Default 0.
   */
  labelOffsetX?: number
  labelOffsetY?: number
  /** Per-shape tooltip activation. Defaults to 'hover' when undefined. */
  tooltipTrigger?: TooltipTrigger
}

export type LineDash = 'solid' | 'dashed' | 'dotted'

/**
 * Route intent — drives the default colour + dash + tooltip semantics.
 * The overlay reads `config.type` to pick paint; the pathfinding graph
 * later reads it to scope A* / Dijkstra to relevant edges (e.g. don't
 * route a wheelchair down a `driving` path).
 *
 * The union is open in spirit — new types can be added by extending
 * this string without a backend migration since it lives inside the
 * `config` JSONB blob. Update `ROUTE_TYPE_COLORS` alongside so the
 * overlay picks up a distinct paint.
 */
export type RouteType =
  | 'walking'
  | 'driving'
  | 'emergency'
  | 'forklift'
  | 'accessible'
  | 'service'

export interface RouteShapeConfig {
  /** Which kind of path this represents. Drives the default paint. */
  type: RouteType
  /** Line colour. When absent, the overlay falls back to the
   *  `ROUTE_TYPE_COLORS[type]` swatch — so users don't have to set a
   *  colour just because they set a type. */
  color?: string
  /** Stroke width in pixels. */
  width: number
  dash: LineDash
  /** 0..100 percent. */
  opacity: number
  /** Base elevation in metres. Lifts the route onto the right floor
   *  plan just like the other shape overlays. */
  elevation: number
  /** Render directional arrows along the path. Default true — routes
   *  are directional in intent so users expect to see a flow. */
  showArrows: boolean
  /** Arrow glyph size in px. */
  arrowSize: number
  /** Distance between arrows in metres. Larger = fewer arrows. */
  arrowSpacing: number
  showLabels: boolean
  label: string
  labelSize: number
  labelColor: string
  /** Where the single label anchors along the path. */
  labelPosition: 'start' | 'middle' | 'end'
  /** Per-shape tooltip activation. Defaults to 'hover' when undefined. */
  tooltipTrigger?: TooltipTrigger
}

/** Default paint per route type. Referenced by the overlay when
 *  `config.color` is undefined and by the side panel's type picker to
 *  show a swatch next to each option. */
export const ROUTE_TYPE_COLORS: Record<RouteType, string> = {
  walking: '#3b82f6',      // blue-500
  driving: '#f97316',      // orange-500
  emergency: '#ef4444',    // red-500
  forklift: '#eab308',     // yellow-500
  accessible: '#22c55e',   // green-500
  service: '#8b5cf6',      // violet-500
}


export interface LineShapeConfig {
  color: string
  /** Stroke width in pixels. */
  width: number
  /**
   * Border (casing) color for the 2D stroke and the 3D wall's base
   * outline. Matches the borderColor field on FillShapeConfig so the
   * side-panel controls and style-rules engine treat lines uniformly.
   * Undefined on legacy rows → renders as if borderWidth = 0.
   */
  borderColor?: string
  /**
   * Border width in pixels, drawn *additively* on both sides of the
   * main stroke (total visible = width + 2 × borderWidth), same
   * convention as polygons/circles. 0 or undefined = no border.
   */
  borderWidth?: number
  dash: LineDash
  /** 0..100 percent. */
  opacity: number
  /** Optional 3D wall extrusion: 0 = flat polyline, > 0 = wall. */
  elevation: number
  height: number
  /**
   * Wall thickness in METERS perpendicular to the run. Drives the buffer
   * that turns the LineString into a polygon for the fill-extrusion
   * layer — a real architectural wall has visible depth (top face area
   * + side faces), not a paper-thin sheet. Defaults to 0.3 m
   * (~typical interior wall) when undefined so existing rows keep a
   * sensible look without a migration.
   */
  wallThickness?: number
  showLabels: boolean
  label: string
  labelSize: number
  labelColor: string
  /** Where the label anchors along the line. */
  labelPosition: 'start' | 'middle' | 'end'
  /** Per-shape tooltip activation. Defaults to 'hover' when undefined. */
  tooltipTrigger?: TooltipTrigger
}

// ---------------------------------------------------------------------------
// Stairs
// ---------------------------------------------------------------------------

/**
 * A parametric 3D staircase placed between two geographic anchors:
 * `vertices[0]` is the bottom of the first step, `vertices[1]` is the
 * top of the last step. The vector between them defines the run
 * direction and (in `treadMode: 'auto'`) the total run length; the
 * step count and per-step dimensions live in `config`.
 *
 * Modelled on `LineShape` so it can ride the same backend table layout
 * (`stairs.vertices` JSONB) and reuse the existing line-style drawing
 * UX: click the bottom, click the top, done.
 */
export interface StairShape extends ShapeBase {
  /**
   * Variable-length vertex list, layout depends on `config.stairType`:
   *   - `'straight'` / `'u'`: exactly 2 elements [bottomAnchor, topOfFirstFlight].
   *     For U-shape the second flight is auto-mirrored back next to the first.
   *   - `'l'`: exactly 3 elements [bottomAnchor, cornerAnchor, topOfSecondFlight].
   *     The cornerAnchor is the top of flight 1 / start of the landing.
   */
  vertices: [number, number][]
  /** Rotation in degrees around the midpoint of the run (-180..+180). */
  rotation: number
  config: StairShapeConfig
}

/**
 * Tread-depth determination strategy:
 *   - `'auto'`: tread depth = (drag length) / stepCount. Step count and
 *     riser height are user-controlled; tread depth follows the geometry.
 *     This matches the SketchUp / Revit "drag the run" flow.
 *   - `'manual'`: tread depth is a fixed config value; the top anchor on
 *     the map is recomputed from `stepCount * treadDepth` along the run
 *     direction whenever the user changes those parameters.
 */
export type StairTreadMode = 'auto' | 'manual'

/**
 * Stair shape variants. The geometry generator dispatches on this:
 *   - `'straight'` — single flight, 2 vertices.
 *   - `'l'`       — two perpendicular(ish) flights joined by a square
 *                   landing at the corner. 3 vertices.
 *   - `'u'`       — two parallel flights going opposite directions,
 *                   joined by a landing at the top of flight 1. 2
 *                   vertices; flight 2 is auto-mirrored.
 *   - `'escalator'` — moving stairway between two floors. 2 vertices:
 *                   bottom landing → top landing (the run direction;
 *                   length follows the rise at the incline angle unless
 *                   `inclineFit` is false). See vertical-transport-generators.
 *   - `'elevator'`  — lift shaft serving several floors. 2 vertices: the
 *                   door side, left corner then right as seen standing
 *                   in front of it; the shaft extends `depth` behind it.
 */
export type StairType = 'straight' | 'l' | 'u' | 'escalator' | 'elevator'

/** Types drawn by the stair tool that are lifts rather than flights. */
export function isLiftType(t: StairType | undefined): t is 'escalator' | 'elevator' {
  return t === 'escalator' || t === 'elevator'
}

/**
 * Every floor plan a lift connects (escalator from/to, elevator served
 * floors). Floor filters keep a lift while ANY of these is shown — an
 * elevator assigned to the ground floor must still appear on floor 3.
 * Empty for stairs.
 */
export function liftFloorPlanIds(config: Pick<StairShapeConfig, 'stairType' | 'fromFloorPlanId' | 'toFloorPlanId' | 'servedFloorPlanIds'>): number[] {
  if (config.stairType === 'elevator') return config.servedFloorPlanIds ?? []
  if (config.stairType === 'escalator') {
    return [config.fromFloorPlanId, config.toFloorPlanId].filter((id): id is number => typeof id === 'number')
  }
  return []
}

export interface StairShapeConfig {
  /** Stair variant — drives both the click flow and the geometry. */
  stairType: StairType
  /** Tread (run) width in meters — perpendicular to the run direction. */
  width: number
  /** Number of risers/treads (integer ≥ 1). */
  stepCount: number
  /** Per-step rise in meters. IBC public-stair default ≈ 0.178 m (7 in). */
  riserHeight: number
  /** Per-step tread depth in meters. IBC default ≈ 0.279 m (11 in). */
  treadDepth: number
  treadMode: StairTreadMode
  /** Base elevation of the first riser in meters (ground = 0). */
  baseElevation: number
  /**
   * Landing depth in meters, measured along the incoming run direction.
   * Defaults to `width` (square landing) but can be set larger for
   * generous turn space. Used by L-shape and U-shape; ignored for
   * straight stairs.
   */
  landingDepth?: number
  /**
   * Open-well gap between the two flights of a U-shape stair, in
   * meters. 0 = flights touch (current). > 0 = central void you can
   * see down through — the architectural "open well" pattern.
   * Ignored for straight and L-shape.
   */
  flightGap?: number
  /** Top surface color. */
  color: string
  /** Riser (vertical face) color — defaults to a darker shade of `color`. */
  riserColor?: string
  borderColor: string
  /**
   * Border line width in pixels for the outline traced around each step.
   * Undefined on legacy rows → falls back to 1.2 px in the overlay, so
   * older stairs look identical until the user opts in.
   */
  borderWidth?: number
  /** 0..100 percent. */
  opacity: number
  /** Optional per-step label visibility. */
  showLabels: boolean
  /** Single label rendered near the top of the run. */
  label: string
  labelSize: number
  labelColor: string
  /** Per-shape tooltip activation. Defaults to 'hover' when undefined. */
  tooltipTrigger?: TooltipTrigger

  // ---- Lifts (escalator / elevator). Ignored by stair types. ----------
  /** Escalator: floor plan (ImageShape id) at the bottom / top. When both
   *  are set and known, base and rise follow those floors' elevations. */
  fromFloorPlanId?: number
  toFloorPlanId?: number
  /** Escalator rise in metres when floors aren't linked. */
  rise?: number
  /** Escalator travel direction (bottom → top is 'up'). */
  direction?: 'up' | 'down'
  /** One unit, or a side-by-side pair running opposite ways. */
  escalatorLayout?: 'single' | 'pair'
  /** Incline in degrees (EN 115: 30° standard, 35° up to 6 m rise). */
  inclineAngle?: number
  /** True (default): length follows rise + angle; false: drawn length. */
  inclineFit?: boolean
  /** Flat landing length at each end, metres (default 1.2). */
  landingLength?: number
  /** Escalator step edge (safety demarcation) colour; default yellow. */
  stepEdgeColor?: string
  /** Step edge line width in px; 0 removes it. Default 1. */
  stepEdgeWidth?: number
  /** Animate the treads (off by default — keeps the map idle). */
  animated?: boolean
  /** Elevator: floor plans served, in any order. */
  servedFloorPlanIds?: number[]
  /** Elevator stop elevations (m) when floors aren't linked. */
  stops?: number[]
  /** Elevator fallback when neither links nor `stops` are set. */
  stopCount?: number
  floorHeight?: number
  /** Elevator: index of the stop the car is drawn at (0 = lowest). */
  carStop?: number
  /** Elevator shaft walls. Glass (default) shows the car. */
  shaftStyle?: 'glass' | 'solid'
  /** Elevator shaft depth behind the door side (m). */
  depth?: number
  /** Elevator door opening width (m). */
  doorWidth?: number
  /** Lifts: out of service greys the treads / doors and marks the icon. */
  status?: 'operational' | 'out-of-service'

  // ---- Stairs (straight / L / U). Ignored by lifts. ---------------------
  /** Balustrade along open sides: metal balusters (default), glass, none. */
  railing?: StairRailing
  /** Handrail / post / baluster colour (a material, stored as data). */
  railingColor?: string
}

export type StairRailing = 'metal' | 'glass' | 'none'
/** Brushed stainless — the default railing material. */
export const DEFAULT_RAILING_COLOR = '#9ca3af'

/**
 * Starting values when the stair tool switches to a lift type. Applied
 * on top of the current config so shared appearance edits survive.
 */
export const LIFT_TYPE_DEFAULTS: Record<'escalator' | 'elevator', Partial<StairShapeConfig>> = {
  escalator: {
    width: 1.0,
    color: '#94a3b8',
    riserColor: '#334155',
    borderColor: '#475569',
    direction: 'up',
    escalatorLayout: 'single',
    inclineAngle: 30,
    inclineFit: true,
    stepEdgeColor: '#facc15',
    stepEdgeWidth: 1,
    status: 'operational',
  },
  elevator: {
    color: '#64748b',
    riserColor: '#e2e8f0',
    borderColor: '#334155',
    depth: 2.2,
    doorWidth: 1.1,
    shaftStyle: 'glass',
    carStop: 0,
    status: 'operational',
  },
}

export type MarkerLabelPosition = 'top' | 'bottom' | 'left' | 'right'

/**
 * Warehouse-asset categorization. The marker's visual stays driven by
 * the Maki `icon` id, but `assetType` lets the dashboard / filtering
 * group markers by their operational role (forklift, pick station,
 * etc.). `undefined` means "uncategorized" — older marker rows have
 * no value here and the UI treats that as a generic marker.
 */
export type AssetType =
  | 'forklift'
  | 'pick-station'
  | 'dock-door'
  | 'shipping'
  | 'receiving'
  | 'storage'
  | 'other'

export interface MarkerShapeConfig {
  /**
   * Maki icon name (e.g. 'marker', 'warehouse', 'fuel', 'parking',
   * 'industry'). The renderer verifies the icon is loaded by the
   * current basemap style and falls back to `marker` otherwise.
   */
  icon: string
  /** Optional asset categorization — see `AssetType`. */
  assetType?: AssetType
  iconColor: string
  /** Pixel size of the icon. */
  iconSize: number
  /** 0..100 percent. */
  opacity: number
  /**
   * Altitude in METERS above the basemap surface (sea level or terrain,
   * depending on the basemap). 0 = on the ground / map surface. Positive
   * values float the marker.
   *
   * Mapbox does NOT depth-test markers against 3D geometry — they are DOM
   * nodes composited above the canvas, so nothing in the GL depth buffer
   * can hide them. This altitude is what `src/lib/marker-occlusion.ts`
   * feeds into the analytic depth test that supplies the missing
   * behaviour.
   */
  elevation: number
  /**
   * Visual "pole" length in METERS extending downward from the marker to
   * its ground anchor. 0 = no pole. Only rendered when `elevation > 0`.
   * Acts as a 3D depth cue showing where the marker is anchored.
   */
  height: number
  showLabels: boolean
  label: string
  labelSize: number
  labelColor: string
  labelPosition: MarkerLabelPosition
  /** Per-shape tooltip activation. Defaults to 'hover' when undefined. */
  tooltipTrigger?: TooltipTrigger
}

// ---------------------------------------------------------------------------
// Discriminated unions for convenience
// ---------------------------------------------------------------------------

export type NonGridShape =
  | (PolygonShape & { kind: 'polygon' })
  | (CircleShape & { kind: 'circle' })
  | (LineShape & { kind: 'line' })
  | (RouteShape & { kind: 'route' })
  | (MarkerShape & { kind: 'marker' })
  | (ImageShape & { kind: 'image' })
  | (ModelShape & { kind: 'model' })
  | (TextLabelShape & { kind: 'text' })
  | (StairShape & { kind: 'stair' })
  | (ImagePlaneShape & { kind: 'imagePlane' })

/** Lightweight ref to identify a shape across kinds. */
export interface ShapeRef {
  kind: ShapeKind
  id: number
}

// ---------------------------------------------------------------------------
// Default style configs (sensible starting values for new shapes)
// ---------------------------------------------------------------------------

export const DEFAULT_FILL_CONFIG: FillShapeConfig = {
  color: '#6366f1',
  borderColor: '#4338ca',
  borderWidth: 1.5,
  opacity: 40,
  elevation: 0,
  height: 0,
  // Shadows-on by default so a freshly-drawn slab reads with real depth
  // as soon as taller shapes are placed on top of it. Users can opt out
  // per shape from the 3D section of the polygon editor.
  receiveShadows: true,
  // On by default so a freshly-drawn polygon / circle shows its
  // auto-generated name on the map without an extra step. When the
  // user clears the Label field, the renderer falls back to the
  // shape's `name` (see `polygon-generators.propsFor`).
  showLabels: true,
  label: '',
  labelSize: 12,
  labelColor: '#000000',
  labelAltitude: 0,
  tooltipTrigger: 'hover',
}

export const DEFAULT_LINE_CONFIG: LineShapeConfig = {
  color: '#6366f1',
  width: 3,
  // Default border off — legacy walls/aisles should look identical
  // until the user opts in. 0 width means the border layer emits
  // nothing regardless of borderColor.
  borderColor: '#312e81',
  borderWidth: 0,
  dash: 'solid',
  opacity: 100,
  elevation: 0,
  height: 0,
  wallThickness: 0.3,
  showLabels: false,
  label: '',
  labelSize: 12,
  labelColor: '#000000',
  labelPosition: 'middle',
  tooltipTrigger: 'hover',
}

export const DEFAULT_ROUTE_CONFIG: RouteShapeConfig = {
  type: 'walking',
  width: 3,
  dash: 'dashed',
  opacity: 100,
  elevation: 0,
  showArrows: true,
  arrowSize: 14,
  arrowSpacing: 8,
  showLabels: false,
  label: '',
  labelSize: 12,
  labelColor: '#000000',
  labelPosition: 'middle',
  tooltipTrigger: 'hover',
}

export const DEFAULT_MARKER_CONFIG: MarkerShapeConfig = {
  icon: 'map-pin',
  iconColor: '#6366f1',
  iconSize: 24,
  opacity: 100,
  elevation: 0,
  height: 0,
  showLabels: false,
  label: '',
  labelSize: 12,
  labelColor: '#000000',
  labelPosition: 'bottom',
  tooltipTrigger: 'hover',
}

export const DEFAULT_STAIR_CONFIG: StairShapeConfig = {
  stairType: 'straight',
  // 1.2 m is the common comfortable single-lane stair width; pro tools
  // default to this for residential and light-commercial designs.
  width: 1.2,
  stepCount: 10,
  // 0.178 m ≈ 7 in — the IBC public-stair maximum and the most common
  // residential riser.
  riserHeight: 0.178,
  // 0.279 m ≈ 11 in — the IBC public-stair minimum tread. 2R + T =
  // 2·0.178 + 0.279 = 0.635 m which lands in the Blondel comfort range
  // (0.60–0.63 m), one of the most ergonomic combos available.
  treadDepth: 0.279,
  treadMode: 'auto',
  baseElevation: 0,
  // 2 × width by default — a generous turn platform that reads as a
  // proper landing rather than a tight ledge. The user can tighten or
  // expand it from the sidebar's "Landing depth" control.
  landingDepth: 2.4,
  // 0.3 m open well between U-shape flights — a comfortable
  // architectural void you can see down through.
  flightGap: 0.3,
  color: '#94a3b8',
  riserColor: '#64748b',
  borderColor: '#475569',
  // 1.2 px keeps the pre-borderWidth-field behaviour as the default so
  // existing stairs render identically until the user changes it.
  borderWidth: 1.2,
  opacity: 100,
  showLabels: false,
  label: '',
  labelSize: 12,
  labelColor: '#000000',
  tooltipTrigger: 'hover',
}

export const DEFAULT_IMAGE_CONFIG: ImageShapeConfig = {
  opacity: 100,
  elevation: 0,
  showLabels: false,
  label: '',
  labelSize: 12,
  labelColor: '#000000',
  labelPosition: 'bottom',
  tooltipTrigger: 'hover',
}

// ---------------------------------------------------------------------------
// 3D Model (glTF / GLB) overlay
// ---------------------------------------------------------------------------

/**
 * A glTF / GLB model placed at a single lng/lat anchor on the map. The
 * actual geometry is referenced by `modelAssetId`, which maps either to a
 * bundled asset in `BUNDLED_MODELS` (`source: 'bundled'`) or to a row in
 * the `userModels` Dexie table (`source: 'uploaded'`). Keeping the asset
 * registry separate from the placement row means a single uploaded GLB
 * can back N instances on the map without duplicating bytes.
 *
 * Why this lives in its own table (`models`) rather than re-using markers:
 *   - markers render as HTML overlays via `mapboxgl.Marker`, models render
 *     via the native Mapbox `model` source + `model` layer (totally
 *     different pipeline);
 *   - models carry per-axis rotation/scale (3 numbers each) plus animation
 *     state — markers only carry a single bearing + uniform scale;
 *   - data-driven properties on models are richer (color tint, emissive,
 *     animation clip, variant) and need a dedicated editor.
 */
export interface ModelShape extends ShapeBase {
  /** Single anchor point on the map. */
  position: [number, number]
  config: ModelShapeConfig
}

export interface ModelShapeConfig {
  /**
   * Foreign reference to the model asset. Either:
   *   - `BUNDLED_MODELS[*].id` (bundled, served from `/models/...`), or
   *   - the `id` of a row in the user-models table (uploaded).
   * The overlay resolves this id to a URL when it builds Mapbox's
   * top-level `style.models` map. Undefined means no asset is selected yet.
   */
  modelAssetId?: string
  /** Per-axis rotation in degrees, applied in [pitch, yaw, roll] order. */
  rotation: [number, number, number]
  /**
   * Per-axis scale multiplier on the source units. `[1, 1, 1]` keeps the
   * model at its intrinsic size; the editor exposes a uniform-scale slider
   * for the common case and an "advanced" toggle for non-uniform.
   */
  scale: [number, number, number]
  /**
   * 3D base altitude in meters above the basemap surface (sea level or
   * terrain). 0 = on the ground. Equivalent to `elevation` on other shapes.
   */
  elevation: number
  /** 0..100 percent. Maps to `model-opacity` on the Mapbox model layer. */
  opacity: number
  /**
   * Tint colour blended with the source materials' baseColor. The blend
   * intensity is controlled by `colorMix` (0 = pristine model, 1 = solid
   * tint). Defaults to no tint (`colorMix: 0`).
   */
  color: string
  /** 0..1 — how strongly `color` is mixed in over the source baseColor. */
  colorMix: number
  /**
   * 0..5 (Mapbox accepts > 1 for HDR glow). Drives `model-emissive-strength`.
   * Useful for "alert flash" or "selected" states without changing color.
   */
  emissive: number
  /**
   * Active / inactive flag. Inactive instances are still rendered, but
   * with reduced opacity and no emissive, so they read as "off-shift" or
   * "decommissioned" without disappearing entirely. The overlay applies
   * this by interpolating opacity → 30% and emissive → 0 when false.
   * Set `visible: false` instead to hide the model completely.
   */
  active: boolean
  /**
   * Name of the glTF animation clip to play (if any). The overlay plays
   * the matching clip on load and loops it. `null`/empty = static pose.
   *
   * Native Mapbox `model` layers can't play arbitrary glTF animations
   * directly — only sub-mesh node rotations via `nodeOverrides`. So this
   * field is a *future-proof* hook for the Phase 3 hero-model path; in
   * Phase 1 we treat it as metadata only.
   */
  animation?: string
  /**
   * v11+. Per-material overrides keyed by the GLB's material name (or
   * `material-${index}` for unnamed ones — matches what the inspector
   * exports). Pushed verbatim into the Mapbox `type: 'model'` source's
   * `materialOverrides` map for this instance.
   *
   * Only the keys the user has actually touched land here — an empty
   * record (or undefined) means "render the GLB's pristine materials".
   * That's important because Mapbox treats *any* materialOverrides
   * entry as a full replacement of that material's PBR factors, so we
   * mustn't push entries we don't have a real value for.
   */
  materialOverrides?: Record<string, ModelMaterialOverride>
  /**
   * v11+. Per-node overrides keyed by the GLB's node name. Pushed into
   * the source's `nodeOverrides` map. Used for things like "open the
   * trunk", "hide this part", "spin the wheels".
   */
  nodeOverrides?: Record<string, ModelNodeOverride>
  /**
   * v11+. Animation clip the user picked from the inspector's dropdown.
   * Stored separately from `animation` (the legacy free-text field) so
   * we can distinguish "user pasted a clip name we can't validate" from
   * "user picked a clip the inspector knows about". Either one drives
   * the same eventual playback path.
   */
  animationClip?: string
  /** Optional asset-type categorization, mirrors `MarkerShapeConfig`. */
  assetType?: AssetType
  showLabels: boolean
  label: string
  labelSize: number
  labelColor: string
  labelPosition: MarkerLabelPosition
  /** Per-shape tooltip activation. Defaults to 'hover' when undefined. */
  tooltipTrigger?: TooltipTrigger
  /**
   * v5.5 — mark this model as the zone's "facility shell" (the outer
   * building volume the user should see at low zoom before the
   * interior floor plans appear). When `enabled`, the overlay swaps
   * the flat `model-opacity` for a zoom-interpolated expression that
   * paints the shell opaque below `fadeStartZoom` and vanishes it by
   * `fadeEndZoom`, letting the interior geometry reveal itself
   * naturally as the user zooms in.
   *
   * A viewer-side chip (`Auto | Shell only | Interior only`) can also
   * force the shell fully on / fully off — see `view.tsx`.
   *
   * Unset / disabled = classic model behaviour (static opacity).
   */
  facilityShell?: {
    enabled: boolean
    /** Fully opaque at/below this map zoom. Default 16. */
    fadeStartZoom: number
    /** Fully transparent at/above this map zoom. Default 19. */
    fadeEndZoom: number
  }
}

/**
 * Per-material override. All fields optional; only set ones land in the
 * Mapbox source's `materialOverrides` map. Matches the subset of glTF
 * PBR factors Mapbox's model source accepts.
 */
export interface ModelMaterialOverride {
  /** Hex string. Replaces the material's `baseColorFactor` rgb. */
  baseColor?: string
  /** Hex string. Replaces `emissiveFactor` rgb. */
  emissive?: string
  /** 0..1. Replaces `metallicFactor`. */
  metallic?: number
  /** 0..1. Replaces `roughnessFactor`. */
  roughness?: number
  /** 0..1. Replaces the baseColorFactor alpha. */
  opacity?: number
}

/**
 * Per-node override. All fields optional; only set ones land in the
 * Mapbox source's `nodeOverrides` map.
 */
export interface ModelNodeOverride {
  /** Degrees [pitch, yaw, roll]. */
  rotation?: [number, number, number]
  /** Meters [tx, ty, tz]. */
  translation?: [number, number, number]
  /** Uniform scale multiplier (some Mapbox builds accept a 3-tuple here too). */
  scale?: number | [number, number, number]
  /** False hides the node and its descendants. */
  visible?: boolean
}

export const DEFAULT_MODEL_CONFIG: ModelShapeConfig = {
  modelAssetId: undefined,
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  elevation: 0,
  opacity: 100,
  color: '#ffffff',
  colorMix: 0,
  emissive: 0,
  active: true,
  animation: undefined,
  materialOverrides: undefined,
  nodeOverrides: undefined,
  animationClip: undefined,
  assetType: undefined,
  showLabels: false,
  label: '',
  labelSize: 12,
  labelColor: '#000000',
  labelPosition: 'bottom',
  tooltipTrigger: 'hover',
}

// ---------------------------------------------------------------------------
// Text label
// ---------------------------------------------------------------------------

/**
 * A standalone text label anchored at a single lng/lat point on the map.
 * Renders through a native Mapbox `symbol` layer (text-field) so it
 * inherits every modern text effect the engine supports: halo, emissive
 * glow under the v3 lighting model, depth-occlusion behind 3D content,
 * symbol z-elevation over extrusions, and billboard vs map-locked
 * rotation/pitch.
 */
export type TextEffectPreset =
  | 'normal'
  | 'glow'
  | 'outlined'
  | 'subtle'
  | 'sign'

export type TextAnchor =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'

/**
 * How the text orients in 3D. `'viewport'` is a classic billboard
 * (always faces the camera, ignores pitch + map bearing); `'map'`
 * locks the text flat onto the ground so it tilts with the camera
 * and rotates with the map bearing.
 */
export type TextAlignment = 'viewport' | 'map'

export interface TextLabelShape extends ShapeBase {
  position: [number, number]
  /** Rotation in degrees (-180..+180). Honored only when `pitchAlignment === 'map'`. */
  rotation: number
  config: TextLabelConfig
}

export interface TextLabelConfig {
  text: string
  size: number
  color: string
  /** 0..100 percent. */
  opacity: number
  haloColor: string
  haloWidth: number
  haloBlur: number
  /**
   * Emissive intensity for the v3 lighting model. 0 = subject to
   * ambient light; 1 = renders at source color regardless of lighting;
   * > 1 = HDR glow. Used by the "glow" preset.
   */
  emissive: number
  /** 3D altitude in METERS above the basemap surface. 0 = ground. */
  elevation: number
  /**
   * Opacity multiplier applied to the portion of the text occluded
   * by 3D objects (Mapbox GL JS ≥ 3.5 `text-occlusion-opacity`).
   * 0 = hide behind buildings; 1 = x-ray.
   */
  occlusionOpacity: number
  /**
   * How the text orients in space. `'viewport'` always faces the
   * camera (billboard). `'map'` locks the text flat on the map.
   */
  pitchAlignment: TextAlignment
  anchor: TextAnchor
  fontWeight: 'regular' | 'bold' | 'italic'
  /** Letter spacing in ems (0 = default). */
  letterSpacing: number
  transform: 'none' | 'uppercase' | 'lowercase'
  /**
   * How the label reacts to map zoom:
   *   - 'screen' (default): the overlay's built-in zoom interpolation
   *     shrinks the label at low zoom so it stays roughly proportional
   *     to features. Full authored size at zoom ≥ 18.
   *   - 'fixed':  always the authored `size` in pixels on screen —
   *     never scales with zoom. Good for viewport-locked callouts.
   *   - 'shape':  scales with the map by 2× per zoom step, using
   *     zoom 20 as the reference where `size` = authored px. Labels
   *     stay pinned to their shape (a room label doesn't overflow the
   *     room when you zoom out).
   */
  sizeMode?: 'screen' | 'fixed' | 'shape'
  /**
   * Legacy alias for `sizeMode: 'fixed'`. Kept so labels written by an
   * earlier build keep working; new code should set `sizeMode` instead.
   * @deprecated use `sizeMode`.
   */
  fixedSize?: boolean
  /**
   * Visual preset. Drives the halo + emissive + occlusion combo
   * without making the user dial every slider by hand.
   */
  preset: TextEffectPreset
  tooltipTrigger?: TooltipTrigger
}

export const DEFAULT_TEXT_LABEL_CONFIG: TextLabelConfig = {
  text: 'Label',
  size: 16,
  color: '#111827',
  opacity: 100,
  haloColor: '#ffffff',
  haloWidth: 1.5,
  haloBlur: 0,
  emissive: 1,
  elevation: 0,
  occlusionOpacity: 0,
  pitchAlignment: 'viewport',
  anchor: 'center',
  fontWeight: 'bold',
  letterSpacing: 0.02,
  transform: 'none',
  preset: 'normal',
  // 'screen' matches the pre-sizeMode behaviour so nothing changes for
  // labels created before this option existed. Users pick 'shape' when
  // they want a room label to stay inside its room at every zoom.
  sizeMode: 'screen',
  tooltipTrigger: 'hover',
}

// ---------------------------------------------------------------------------
// Image plane (3D image / billboard)
// ---------------------------------------------------------------------------

/**
 * An image plane is a flat textured quad rendered in 3D space. Unlike the
 * floor `ImageShape` (which lies flat on the ground via Mapbox's raster
 * source), an image plane is rendered as a `model` layer with a runtime-
 * generated GLB that wraps the user's image as a textured plane mesh.
 *
 * This gives it the full set of model-layer transforms — elevation,
 * per-axis rotation (X/Y/Z), and per-axis scale — which the raster image
 * source cannot do.
 *
 * Storage:
 *   - `position`   = the world anchor (lng/lat) the plane is pinned to.
 *   - `imageUrl`   = served from the object store (`/files/<key>`).
 *   - `config`     = all 3D transforms + visual config (see
 *                    `ImagePlaneShapeConfig`).
 *   - GLBs are NOT persisted — the overlay rebuilds the plane GLB at
 *     load time from the image URL. A plane is ~1 KB so this is cheap.
 */
export interface ImagePlaneShape extends ShapeBase {
  /** Single anchor point on the map (where the plane is centered). */
  position: [number, number]
  /** Object-store URL of the source image (`/files/<key>`). */
  imageUrl: string
  /** MIME type from upload; empty if unknown. */
  mimeType?: string
  /** Pixel dimensions of the source image. Used to derive an initial aspect ratio. */
  naturalWidth?: number
  naturalHeight?: number
  config: ImagePlaneShapeConfig
}

export interface ImagePlaneShapeConfig {
  /** Plane width in meters (along the local X axis before rotation). */
  width: number
  /** Plane height in meters (along the local Y axis before rotation). */
  height: number
  /**
   * Per-axis rotation in degrees, applied in [pitch, yaw, roll] order —
   * same convention as `ModelShapeConfig.rotation`.
   *   - rotation[0] (pitch / X) — tilt the top of the plane toward / away
   *     from the viewer. 0 = lying flat on the ground; 90 = standing up
   *     vertically like a wall poster.
   *   - rotation[1] (yaw / Y)   — spin around the vertical axis. Use to
   *     orient a vertical poster to face a direction.
   *   - rotation[2] (roll / Z)  — rotate within the plane (e.g. flip the
   *     image upside down).
   */
  rotation: [number, number, number]
  /** Base altitude in meters above the basemap surface. 0 = on the ground. */
  elevation: number
  /** 0..100 percent. Maps to `model-opacity`. */
  opacity: number
  /**
   * Optional tint colour multiplied into the texture's baseColor. Defaults
   * to white (no tint). Pair with `colorMix` to dial blend intensity.
   */
  color: string
  /** 0..1 — how strongly `color` is mixed in over the source texture. */
  colorMix: number
  /** Per-shape tooltip activation. Defaults to 'hover' when undefined. */
  tooltipTrigger?: TooltipTrigger
}

export const DEFAULT_IMAGE_PLANE_CONFIG: ImagePlaneShapeConfig = {
  width: 10,
  height: 10,
  rotation: [0, 0, 0],
  elevation: 0,
  opacity: 100,
  color: '#ffffff',
  colorMix: 0,
  tooltipTrigger: 'hover',
}
