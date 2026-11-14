import {
  transformRotate,
  distance as turfDistance,
  point as turfPoint,
  polygon as turfPolygon,
} from '@turf/turf'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import type { LengthUnit } from './units'
import {
  arcStops,
  cellRingFromStops,
  isPathGrid,
  makeArc,
  pathGridDepth,
  pathGridDimensions,
  pathGridFrame,
  pathGridVertices,
  pathPolylineMetres,
  type ArcStop,
  type GridPathFields,
} from './grid-path'

export type GridType = 'square' | 'triangle' | 'hexagon'
export type HexOrientation = 'pointy' | 'flat'
export type LabelDirection = 'x' | 'y'

export interface GridConfig extends GridPathFields {
  type: GridType
  /** Cell width in meters. */
  xSize: number
  /** Cell height in meters. Ignored for hexagons (derived from xSize). */
  ySize: number
  /**
   * Horizontal gap between adjacent cells in meters. Cells stay at their
   * full `xSize` × `ySize` and the lattice pitch widens by `cellGap`, so
   * a positive value produces air between cells without shrinking them.
   * `0` preserves the legacy 3% inset seam. Applies to square, triangle
   * (inherits from square), and hex (widens the hex lattice step).
   * Default 0.
   */
  cellGap: number
  /**
   * Display unit stamped at draw time. Geometry is always stored in meters;
   * this only controls how the UI shows xSize/ySize/elevation/height/etc.
   * Defaults to the global unit preference (see `db.settings`) on new grids.
   */
  unit: LengthUnit
  /** Rotation in degrees (-180..+180). Applied around the start point. Negatives rotate counter-clockwise. */
  rotation: number
  /** Fill color (hex). */
  color: string
  /** Border color (hex). */
  borderColor: string
  /** Border width in pixels. */
  borderWidth: number
  /** Fill opacity (0-100). */
  opacity: number
  /**
   * Base elevation of the grid in meters (lifts the grid to a specific altitude
   * above sea level when rendered in 3D). Default 0 = sea level / on the ground.
   * When `height === 0` and `elevation === 0` the grid is rendered as a flat
   * 2D `fill` layer. When `elevation > 0` OR `height > 0` the grid is rendered
   * as a 3D `fill-extrusion` layer with `fill-extrusion-base = elevation` and
   * `fill-extrusion-height = elevation + height`.
   */
  elevation: number
  /**
   * 3D extrusion height in meters (top of the grid above its `elevation`
   * base). Default 0 = flat (use 2D `fill`). When `> 0` the grid is rendered
   * as a 3D `fill-extrusion` layer.
   */
  height: number
  /** Pointy-top or flat-top hex layout (only used when type === 'hexagon'). */
  hexOrientation: HexOrientation
  /** Show cell index labels. */
  showLabels: boolean
  /** Master visibility toggle. */
  visible: boolean
  // ---- Label customization ------------------------------------------------
  /** Starting number for the first cell's label. Default 1. */
  labelStart: number
  /** Which axis the numbering advances along. 'x' = row-major, 'y' = column-major. Default 'x'. */
  labelDirection: LabelDirection
  /** Optional prefix prepended with a hyphen (e.g. 'Site' -> 'Site-1', 'Site-2'). Default ''. */
  labelPrefix: string
  /** Label text size in pixels. Default 11. */
  labelSize: number
  /** Label text color (hex). Default '#000000'. */
  labelColor: string
  /** Label altitude in meters (lifts the label above the cell in 3D). Default 0. */
  labelAltitude: number
  // ---- Vertical racking ---------------------------------------------------
  /**
   * Number of vertical levels stacked at each cell footprint. 1 = legacy
   * single-level grid (the historic behaviour and the default for new
   * grids). Values > 1 turn the grid into a pallet-rack-style 3D stack:
   * each cell footprint is rendered N times, each at altitude
   * `elevation + level * levelHeight` with extrusion height
   * `levelHeight`. Bins are addressed as (row, col, level).
   *
   * Only honoured for square grids — hex / triangle grids stay flat
   * because vertical rack geometry doesn't map cleanly onto those
   * tilings.
   */
  levels: number
  /**
   * Vertical spacing between levels in meters. Each level extrudes from
   * `level * levelHeight` to `(level+1) * levelHeight` above the grid's
   * `elevation`. Ignored when `levels === 1`.
   */
  levelHeight: number
  /**
   * Vertical air between shelves in meters. The per-level pitch becomes
   * `levelHeight + levelGap` (each shelf sits `levelGap` above the top of
   * the one below), while the shelf extrusion thickness stays `levelHeight`.
   * Default 0 = shelves touch. Ignored when `levels === 1`.
   */
  levelGap: number
}

export interface GridCellProps {
  /** Stable string id for the cell within its grid (e.g. `${row}-${col}-l0`). */
  id: string
  /** The parent grid's ID (Dexie primary key). Undefined for live preview. */
  gridId?: number
  row: number
  col: number
  /**
   * Vertical level (0-based) for the stacked-rack rendering. Always
   * `0` for legacy / single-level grids. Higher values mean higher
   * shelves; the cell's altitude is `elevation` (computed from
   * `gridElevation + level * levelHeight`).
   */
  level: number
  /**
   * Total level count of the parent grid. Always `1` for legacy /
   * single-level grids; `> 1` for stacked pallet-rack grids. The
   * label-placement code uses this to decide whether to apply the
   * per-grid `labelAltitude` lift (single-level: yes, multi-level:
   * no, because each cell already lifts its label to its own shelf).
   */
  totalLevels: number
  index: number
  /** Per-cell base elevation (m). Used as `fill-extrusion-base`. */
  elevation: number
  /** Per-cell 3D extrusion height (m). Used with `elevation` to compute `fill-extrusion-height`. */
  height: number
  /** Pre-formatted label string. */
  label?: string
  /** Per-cell label size override (px). */
  labelSize?: number
  /** Per-cell label color override (hex). */
  labelColor?: string
  /** Per-cell label altitude (m) for 3D lift. */
  labelAltitude?: number
  /** Marks the "next" cell at the leading edge of an in-progress draw. */
  future?: boolean
  /**
   * Marks every cell of an in-progress (uncommitted) draw preview. Used by
   * the overlay's layer filters: committed cells are kept by `has gridId`,
   * preview cells (which have no gridId yet) are kept by `has preview`.
   */
  preview?: boolean
  /**
   * Per-grid style fields stamped at build time so the overlay's paint
   * expressions can read them via `['get', ...]` instead of using a single
   * layer-wide config. This lets multiple grids on the same map carry
   * independent colors, opacities, border styles, and label visibility.
   */
  color?: string
  opacity?: number
  /**
   * `opacity` rounded to the nearest multiple of 10 (0, 10, …, 100). The
   * overlay pre-creates one constant-opacity fill-extrusion layer per
   * bucket and routes each cell into the matching bucket via filter,
   * because `fill-extrusion-opacity` rejects all data expressions in
   * Mapbox GL JS 3.x.
   */
  opacityBucket?: number
  /**
   * Legacy: `color` pre-multiplied with `opacity / 100`. Kept on the
   * object for any callers that still read it, but the rendering path
   * no longer uses it (fill-extrusion-color strips alpha).
   */
  colorRgba?: string
  borderColor?: string
  borderWidth?: number
  showLabels?: boolean
}

export type GridCell = Feature<Polygon, GridCellProps>

const METERS_PER_DEG_LAT = 111_320

function metersToLngDelta(meters: number, lat: number): number {
  return meters / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))
}

function metersToLatDelta(meters: number): number {
  return meters / METERS_PER_DEG_LAT
}

export function distanceMeters(a: [number, number], b: [number, number]): number {
  return turfDistance(turfPoint(a), turfPoint(b), { units: 'meters' })
}

/**
 * Format the label for a cell based on its (row, col) position, the grid's
 * total dimensions, and the label config.
 *
 * - `labelDirection: 'x'` → row-major: numbers go across, then down
 *     e.g. for a 3x3 grid:
 *       1 2 3
 *       4 5 6
 *       7 8 9
 * - `labelDirection: 'y'` → column-major: numbers go down, then across
 *     e.g. for a 3x3 grid:
 *       1 4 7
 *       2 5 8
 *       3 6 9
 * - `labelStart` shifts the starting number (default 1)
 * - `labelPrefix` is prepended with a hyphen. Set to '' for numbers only.
 */
export function formatLabel(
  row: number,
  col: number,
  totalRows: number,
  totalCols: number,
  config: Pick<GridConfig, 'labelStart' | 'labelDirection' | 'labelPrefix'>,
  level: number = 0,
  totalLevels: number = 1,
): string {
  const index =
    config.labelDirection === 'y'
      ? col * totalRows + row
      : row * totalCols + col
  const num = config.labelStart + index
  // A prefix that already ends in punctuation shouldn't get another
  // separator glued on ("AISLE-" + "-" + "3" = "AISLE--3"). Skip the
  // hyphen when the user's prefix already terminates cleanly.
  const trailing = config.labelPrefix ? config.labelPrefix.slice(-1) : ''
  const sep = trailing && /[-_./ ]/.test(trailing) ? '' : '-'
  const base = config.labelPrefix ? `${config.labelPrefix}${sep}${num}` : String(num)
  // For multi-level racks, suffix with the 1-based level number padded
  // to two digits so labels stay column-aligned in the side panel and
  // the on-map text. Single-level grids return the legacy label
  // unchanged.
  if (totalLevels <= 1) return base
  const lvl = String(level + 1).padStart(2, '0')
  return `${base}-L${lvl}`
}

/**
 * The opposite of `formatLabel`. Given a label that came out of the
 * label renderer (`"A-1-L01"`, `"3"`, `"Aisle-3-7-L02"`, …) plus the
 * grid's label config and dimensions, return the `(row, col, level)`
 * the label refers to. Returns `null` when:
 *   - the label doesn't parse,
 *   - the prefix doesn't match `config.labelPrefix`,
 *   - the resolved index falls outside the grid's cell range,
 *   - the level is outside the grid's level range.
 *
 * Inverse of:
 *   formatLabel(row, col, totalRows, totalCols, config, level, totalLevels)
 */
export interface ParsedBinLabel {
  prefix: string
  number: number
  /** 0-based level (formatLabel emits 1-based zero-padded). */
  level: number
}

export function parseLabelString(label: string): ParsedBinLabel | null {
  const trimmed = label.trim()
  if (trimmed === '') return null
  // 1. Peel an optional `-L<digits>` suffix. Lazy `(.+?)` is fine
  //    because `-L<digits>` is anchored at the end.
  const lvlMatch = trimmed.match(/^(.+?)-L(\d+)$/)
  let body: string
  let level: number
  if (lvlMatch) {
    body = lvlMatch[1]
    level = Number(lvlMatch[2]) - 1
    if (!Number.isFinite(level) || level < 0) return null
  } else {
    body = trimmed
    level = 0
  }
  // 2. Body is either `<prefix>-<number>` or just `<number>`.
  //    Greedy `(.+)-` so a prefix containing hyphens survives.
  const bodyMatch = body.match(/^(?:(.+)-)?(\d+)$/)
  if (!bodyMatch) return null
  const prefix = bodyMatch[1] ?? ''
  const number = Number(bodyMatch[2])
  if (!Number.isFinite(number) || number < 0) return null
  return { prefix, number, level }
}

/**
 * Resolve a parsed bin label to a cell address inside a specific
 * grid. Knows the grid's `labelStart` / `labelDirection` so the
 * inverse cell-index math matches `formatLabel` exactly.
 */
/**
 * Reason a candidate grid couldn't accept a parsed label. The resolver
 * surfaces this in the import preview so the user can see e.g.
 * "Rack #3 only has 1 level — re-create it with Levels = 3 to map L02".
 */
export type LabelMismatchReason =
  | 'prefix-mismatch'
  | 'number-below-start'
  | 'level-out-of-range'
  | 'index-out-of-range'

export interface LabelMismatch {
  reason: LabelMismatchReason
  /** Filled in when relevant — useful for "X / Y" diagnostics. */
  detail?: { value: number; max: number }
}

export function cellAddressFromLabel(
  parsed: ParsedBinLabel,
  config: Pick<GridConfig, 'labelStart' | 'labelDirection' | 'labelPrefix' | 'levels'>,
  totalRows: number,
  totalCols: number,
): { row: number; col: number; level: number } | LabelMismatch {
  // Prefix MUST match exactly (after trim). An empty prefix in the
  // config means labels were numbers-only — accept an empty parsed
  // prefix too.
  if ((config.labelPrefix ?? '') !== parsed.prefix) {
    return { reason: 'prefix-mismatch' }
  }
  const labelStart = config.labelStart ?? 1
  const index = parsed.number - labelStart
  if (index < 0) {
    return { reason: 'number-below-start', detail: { value: parsed.number, max: labelStart } }
  }
  const totalLevels = Math.max(1, Math.floor(config.levels ?? 1))
  if (parsed.level >= totalLevels) {
    return {
      reason: 'level-out-of-range',
      detail: { value: parsed.level + 1, max: totalLevels },
    }
  }
  let row: number
  let col: number
  if (config.labelDirection === 'y') {
    // Column-major: index = col * totalRows + row
    col = Math.floor(index / totalRows)
    row = index % totalRows
  } else {
    // Row-major (default): index = row * totalCols + col
    row = Math.floor(index / totalCols)
    col = index % totalCols
  }
  if (row < 0 || row >= totalRows || col < 0 || col >= totalCols) {
    return {
      reason: 'index-out-of-range',
      detail: { value: index, max: totalRows * totalCols - 1 },
    }
  }
  return { row, col, level: parsed.level }
}

/** Narrow the union returned by `cellAddressFromLabel`. */
export function isCellAddress(
  v: { row: number; col: number; level: number } | LabelMismatch,
): v is { row: number; col: number; level: number } {
  return (v as LabelMismatch).reason === undefined
}

/**
 * Cheap cell-count estimate from a grid's bbox + cell size, without
 * running the full `buildGrid` tessellation. Mirrors the floor() math
 * the renderer uses so the counts agree.
 */
export function estimateGridDimensions(
  start: [number, number],
  current: [number, number],
  config: Pick<GridConfig, 'xSize' | 'ySize' | 'type'> & Partial<Pick<GridConfig, 'cellGap' | 'levels'>> & GridPathFields,
): { rows: number; cols: number } | null {
  if (config.type !== 'square') return null
  if (isPathGrid(config)) {
    if (config.xSize <= 0 || config.ySize <= 0) return null
    const { rows, cols } = pathGridDimensions(start, current, config)
    return { rows, cols }
  }
  const widthM = distanceMeters([start[0], start[1]], [current[0], start[1]])
  const heightM = distanceMeters([start[0], start[1]], [start[0], current[1]])
  if (config.xSize <= 0 || config.ySize <= 0) return null
  return {
    cols: Math.max(0, Math.floor(widthM / config.xSize)),
    rows: Math.max(0, Math.floor(heightM / config.ySize)),
  }
}

/**
 * Convert a hex color (`#rgb` or `#rrggbb`) plus an alpha in [0, 1] to a CSS
 * `rgba(...)` string that Mapbox style functions accept anywhere a color is
 * allowed. Returns the input unchanged if it isn't a recognizable hex.
 */
function hexToRgba(hex: string, alpha: number): string {
  // Every cell of a grid asks for the same colour; answer repeats from a
  // one-entry memo instead of re-running the regex per cell.
  const memo = lastRgba
  if (memo && memo.hex === hex && Object.is(memo.alpha, alpha)) return memo.out
  const out = hexToRgbaUncached(hex, alpha)
  lastRgba = { hex, alpha, out }
  return out
}
let lastRgba: { hex: string; alpha: number; out: string } | null = null

function hexToRgbaUncached(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const a = Math.max(0, Math.min(1, alpha))
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/**
 * Build the per-cell properties object, including the formatted label.
 * Always tagged with the parent `gridId` when known (committed grids), and
 * with the per-grid label overrides so the symbol layer can read them via
 * expressions (no feature-state needed for label styling).
 */
function makeCellProps(
  id: string,
  gridId: number | undefined,
  row: number,
  col: number,
  index: number,
  elevation: number,
  height: number,
  totalRows: number,
  totalCols: number,
  config: GridConfig,
  level: number = 0,
  totalLevels: number = 1,
): GridCellProps {
  const props: GridCellProps = { id, gridId, row, col, level, totalLevels, index, elevation, height }
  props.label = formatLabel(row, col, totalRows, totalCols, config, level, totalLevels)
  props.labelSize = config.labelSize
  props.labelColor = config.labelColor
  props.labelAltitude = config.labelAltitude
  // Stamp per-grid style fields so paint expressions can read them via
  // `['get', ...]`. Without this, the overlay falls back to layer-wide
  // paint properties driven by the active panel config, which makes
  // every grid on the map share a single color/border/opacity.
  props.color = config.color
  props.opacity = config.opacity
  props.opacityBucket = Math.max(
    0,
    Math.min(100, Math.round((config.opacity ?? 100) / 10) * 10),
  )
  // Legacy field kept for back-compat; the overlay no longer reads it.
  props.colorRgba = hexToRgba(config.color, (config.opacity ?? 100) / 100)
  props.borderColor = config.borderColor
  props.borderWidth = config.borderWidth
  props.showLabels = config.showLabels
  return props
}

function cellCentroid(cell: GridCell): [number, number] {
  const ring = cell.geometry.coordinates[0]
  let sx = 0
  let sy = 0
  for (let i = 0; i < ring.length - 1; i++) {
    sx += ring[i][0]
    sy += ring[i][1]
  }
  return [sx / (ring.length - 1), sy / (ring.length - 1)]
}

// ---- Square grid ------------------------------------------------------------

// Cap the total number of cells so a large bbox with very small cell sizes
// can't blow up the browser (or tile size). If the user-requested cell size
// would produce more cells than this, we automatically grow the cell size to
// keep the count within the cap. The user's preferred size is preserved when
// the bbox is small.
const MAX_CELLS = 20_000

/**
 * Per-cell inset as a fraction of the cell's lng/lat extent. Each cell
 * polygon is shrunk by this amount on every side, leaving a visible
 * gap between adjacent cells so 3D rack geometry reads as distinct
 * boxes from every angle — not just from above.
 *
 * The motivation: Mapbox's `fill-extrusion` renders adjacent
 * coplanar walls as a single merged wall (cell A's right face and
 * cell B's left face overlap exactly when the cells share an edge),
 * which makes the SIDES of a rack look like one solid colored block
 * even though the TOPS show every cell border via our line layer.
 * Mapbox provides no "draw stroke on extrusion edge" paint property
 * and `line-z-offset` is 2D-only, so a separator can't be drawn on
 * the vertical face directly — but pulling each cell inward by ~1.5%
 * leaves a small basemap-visible gap that reads as a seam at every
 * camera angle.
 *
 * 3% gives a ~6% combined gap between adjacent cells (`2 × inset`).
 * For a 1 m cell that's 6 cm; for a 0.2 m narrow-bin rack ~1.2 cm.
 * At deep close zooms (warehouse-floor view, zoom ≥ 20) the smaller
 * insets we tried (1.5%) became sub-pixel and the side walls read
 * as a single solid block again — 3% keeps the seam readable at
 * those zooms without being obviously gappy from a top-down view.
 */
const CELL_INSET_FRACTION = 0.03

/**
 * Pick which corner of the bbox matches the user's start point and the
 * direction in which cells should extend. `start` is one of the two clicks
 * used to define the bbox, so it always sits at one of the four corners.
 */
function getAnchor(
  start: [number, number],
  bbox: [number, number, number, number]
): { cornerLng: number; cornerLat: number; dLng: 1 | -1; dLat: 1 | -1 } {
  const [west, south, east, north] = bbox
  const cx = (west + east) / 2
  const cy = (south + north) / 2
  // start is at a corner; decide which axis direction points away from it.
  const dLng: 1 | -1 = start[0] >= cx ? -1 : 1
  const dLat: 1 | -1 = start[1] >= cy ? -1 : 1
  return {
    cornerLng: dLng === 1 ? west : east,
    cornerLat: dLat === 1 ? south : north,
    dLng,
    dLat,
  }
}

/**
 * Drop any cell with at least one vertex outside the bbox. Combined with
 * `Math.floor` cell counts, this keeps the grid inside the guide box with
 * only full, complete cells visible (no clipped/partial cells).
 */
function dropCellsOutsideBbox(
  cells: GridCell[],
  bbox: [number, number, number, number]
): GridCell[] {
  const [w, s, e, n] = bbox
  const eps = 1e-9
  return cells.filter((cell) => {
    const ring = cell.geometry.coordinates[0]
    for (const [lng, lat] of ring) {
      if (lng < w - eps || lng > e + eps || lat < s - eps || lat > n + eps) {
        return false
      }
    }
    return true
  })
}

function fitCellSize(
  cellSizeMeters: number,
  bbox: [number, number, number, number],
  otherAxisSizeMeters: number | null,
  isLng: boolean
): { lngSize: number; latSize: number } {
  // Returns the cell size (in degrees for both axes) that produces at most
  // MAX_CELLS cells in the bbox, while keeping the aspect ratio of the
  // user's xSize/ySize. We compute the bbox size, then derive the cell size
  // that yields MAX_CELLS cells.
  const [west, south, east, north] = bbox
  const midLat = (south + north) / 2
  const widthMeters = (east - west) * METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
  const heightMeters = (north - south) * METERS_PER_DEG_LAT
  if (widthMeters <= 0 || heightMeters <= 0) {
    return { lngSize: 1, latSize: 1 }
  }
  // Initial cells using the user-requested size.
  const ratio = (otherAxisSizeMeters ?? cellSizeMeters) / cellSizeMeters
  const lngCells0 = Math.max(1, Math.ceil(widthMeters / cellSizeMeters))
  const latCells0 = Math.max(1, Math.ceil(heightMeters / cellSizeMeters / Math.max(ratio, 0.0001)))
  const cells0 = lngCells0 * latCells0
  if (cells0 <= MAX_CELLS) {
    return {
      lngSize: metersToLngDelta(cellSizeMeters, midLat),
      latSize: metersToLatDelta(otherAxisSizeMeters ?? cellSizeMeters),
    }
  }
  // Scale up cell size so cells == MAX_CELLS, preserving aspect ratio.
  const scale = Math.sqrt(cells0 / MAX_CELLS)
  const newCellSizeMeters = cellSizeMeters * scale
  const newOtherSizeMeters = (otherAxisSizeMeters ?? cellSizeMeters) * scale
  void isLng
  return {
    lngSize: metersToLngDelta(newCellSizeMeters, midLat),
    latSize: metersToLatDelta(newOtherSizeMeters),
  }
}

function buildSquareGrid(
  bbox: [number, number, number, number],
  cellWidthMeters: number,
  cellHeightMeters: number,
  elevation: number,
  height: number,
  start: [number, number],
  config: GridConfig,
  gridId?: number
): GridCell[] {
  const [west, south, east, north] = bbox
  const { lngSize: cellW, latSize: cellH } = fitCellSize(
    cellWidthMeters,
    bbox,
    cellHeightMeters,
    true
  )
  // Anchor cell (0, 0) at the bbox corner matching `start`; cells extend in
  // the direction of the opposite corner.
  const { cornerLng, cornerLat, dLng, dLat } = getAnchor(start, bbox)

  // Horizontal gap between cells: cells stay at their full `xSize` ×
  // `ySize` and are spaced out by `cellGap` of air. The per-axis pitch
  // (center-to-center distance) is `cellW + gapLng` / `cellH + gapLat`,
  // so a positive `cellGap` widens the lattice without shrinking the
  // cells. When `cellGap === 0` the legacy 3% inset seam is preserved
  // (see below).
  const cellGapMeters = Math.max(0, config.cellGap ?? 0)
  const midLatSq = (south + north) / 2
  const gapLng = metersToLngDelta(cellGapMeters, midLatSq)
  const gapLat = metersToLatDelta(cellGapMeters)
  const pitchW = cellW + gapLng
  const pitchH = cellH + gapLat

  // Cell count is derived from the no-gap cell size so adding a `cellGap`
  // doesn't change the count — the rack grows past the drawn bbox to
  // accommodate the gaps rather than dropping edge cells. The gapped
  // `pitchW` / `pitchH` are only used for positioning (see the loop).
  const cols = Math.max(1, Math.floor((east - west) / cellW))
  const rows = Math.max(1, Math.floor((north - south) / cellH))

  // Vertical-racking expansion: for `levels > 1` we emit N stacked
  // copies of each (row, col) footprint. Single-level grids (the
  // default, and everything pre-racking) get exactly one feature per
  // cell, matching the legacy behaviour. The level loop is innermost
  // so the `index` walks "all levels at (0,0), then all levels at
  // (0,1), …" — Mapbox renders in the order features appear in the
  // source, which keeps higher levels on top of lower ones at the
  // same footprint.
  const totalLevels = Math.max(1, Math.floor(config.levels ?? 1))
  const levelHeight = Math.max(0, config.levelHeight ?? 0)
  const levelGap = Math.max(0, config.levelGap ?? 0)
  // Per-level extrusion height: single-level grids preserve the
  // original `height` value (so existing 2D / 3D grids render the
  // same); multi-level grids ignore the grid's overall `height` and
  // instead use `levelHeight` for each band. `levelGap` is NOT
  // subtracted here — the shelf thickness stays `levelHeight`; the
  // gap widens the per-level pitch (see `cellElevation` below).
  const perLevelHeight = totalLevels > 1 ? levelHeight : height

  const cells: GridCell[] = []
  let index = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Position each cell by the gapped pitch, but keep the cell
      //itself at the full `cellW` × `cellH` size — `cellGap` is air
      // between cells, not a shrink.
      const x0Raw = cornerLng + c * pitchW * dLng
      const y0Raw = cornerLat + r * pitchH * dLat
      const x1Raw = x0Raw + cellW * dLng
      const y1Raw = y0Raw + cellH * dLat
      // GeoJSON polygons must wind counter-clockwise with x0 < x1, y0 < y1.
      const x0 = Math.min(x0Raw, x1Raw)
      const x1 = Math.max(x0Raw, x1Raw)
      const y0 = Math.min(y0Raw, y1Raw)
      const y1 = Math.max(y0Raw, y1Raw)
      // When `cellGap === 0` apply the legacy 3% inset so adjacent
      // cells look like distinct boxes in 3D (the historic default).
      // When `cellGap > 0` the gap itself provides the visual
      // separation, so no inset — cells render at exactly `xSize` ×
      // `ySize`. Triangle grids inherit this because their builder
      // reads its corners off the square's ring.
      const insetX = cellGapMeters > 0 ? 0 : (x1 - x0) * CELL_INSET_FRACTION
      const insetY = cellGapMeters > 0 ? 0 : (y1 - y0) * CELL_INSET_FRACTION
      const xL = x0 + insetX
      const xR = x1 - insetX
      const yB = y0 + insetY
      const yT = y1 - insetY
      const ring: [number, number][][] = [
        [
          [xL, yB],
          [xR, yB],
          [xR, yT],
          [xL, yT],
          [xL, yB],
        ],
      ]
      for (let lvl = 0; lvl < totalLevels; lvl++) {
        const cellElevation =
          totalLevels > 1 ? elevation + lvl * (levelHeight + levelGap) : elevation
        const cell = turfPolygon(
          ring,
          makeCellProps(
            // Embed the level in the cell id so each band is a
            // separate feature from Mapbox's perspective (otherwise
            // `feature-state` and click hit-testing would collide).
            totalLevels > 1 ? `${r}-${c}-l${lvl}` : `${r}-${c}`,
            gridId,
            r,
            c,
            index,
            cellElevation,
            perLevelHeight,
            rows,
            cols,
            config,
            lvl,
            totalLevels,
          ),
        ) as GridCell
        cells.push(cell)
        index++
      }
    }
  }
  // When `cellGap > 0` the rack intentionally extends past the drawn bbox
  // by `(cols-1) × gapLng` / `(rows-1) × gapLat` — the user's draw rectangle
  // defines the cell AREA (cells × xSize × ySize), and the gaps are added
  // on top, growing the overall rack. Skip the bbox drop so those cells
  // are kept. When `cellGap === 0` the drop is a safety net for any
  // floating-point edge case (it's a no-op in practice because `floor`
  // already fits cells exactly inside the bbox).
  if (cellGapMeters > 0) return cells
  return dropCellsOutsideBbox(cells, bbox)
}

// ---- Triangle grid (each square split into 2 triangles) ---------------------

function buildTriangleGrid(
  bbox: [number, number, number, number],
  cellWidthMeters: number,
  cellHeightMeters: number,
  elevation: number,
  height: number,
  start: [number, number],
  config: GridConfig,
  gridId?: number
): GridCell[] {
  const squares = buildSquareGrid(
    bbox,
    cellWidthMeters,
    cellHeightMeters,
    elevation,
    height,
    start,
    config,
    gridId
  )
  const cells: GridCell[] = []
  let index = 0
  for (const sq of squares) {
    const ring = sq.geometry.coordinates[0]
    const [sw, se, ne, nw] = ring
    const baseProps = sq.properties
    cells.push(
      turfPolygon(
        [
          [
            [sw[0], sw[1]],
            [se[0], se[1]],
            [ne[0], ne[1]],
            [sw[0], sw[1]],
          ],
        ],
        {
          ...baseProps,
          id: `${baseProps.row}-${baseProps.col}-A`,
          index,
        }
      ) as GridCell
    )
    index++
    cells.push(
      turfPolygon(
        [
          [
            [sw[0], sw[1]],
            [ne[0], ne[1]],
            [nw[0], nw[1]],
            [sw[0], sw[1]],
          ],
        ],
        {
          ...baseProps,
          id: `${baseProps.row}-${baseProps.col}-B`,
          index,
        }
      ) as GridCell
    )
    index++
  }
  return cells
}

// ---- Hexagon grid -----------------------------------------------------------

function buildHexGrid(
  bbox: [number, number, number, number],
  sizeMeters: number,
  orientation: HexOrientation,
  elevation: number,
  height: number,
  start: [number, number],
  config: GridConfig,
  gridId?: number
): GridCell[] {
  const [west, south, east, north] = bbox
  const midLat = (south + north) / 2
  // Auto-scale hex size to keep cell count under MAX_CELLS.
  {
    const widthMeters = (east - west) * METERS_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180)
    const heightMeters = (north - south) * METERS_PER_DEG_LAT
    if (widthMeters > 0 && heightMeters > 0) {
      const sqrt3 = Math.sqrt(3)
      const w = orientation === 'pointy' ? sqrt3 * sizeMeters : 2 * sizeMeters
      const h = orientation === 'pointy' ? 2 * sizeMeters : sqrt3 * sizeMeters
      const approxCols = widthMeters / (orientation === 'pointy' ? w : (3 / 4) * w)
      const approxRows = heightMeters / (orientation === 'pointy' ? (3 / 4) * h : h)
      const approxCells = Math.ceil(approxCols) * Math.ceil(approxRows)
      if (approxCells > MAX_CELLS) {
        const scale = Math.sqrt(approxCells / MAX_CELLS)
        sizeMeters = sizeMeters * scale
      }
    }
  }
  const sqrt3 = Math.sqrt(3)
  const w = orientation === 'pointy' ? sqrt3 * sizeMeters : 2 * sizeMeters
  const h = orientation === 'pointy' ? 2 * sizeMeters : sqrt3 * sizeMeters
  const wDeg = metersToLngDelta(w, midLat)
  const hDeg = metersToLatDelta(h)
  // Horizontal gap between hexes: each hex stays at full `sizeMeters`
  // and the lattice step widens by `cellGap`, so a positive gap produces
  // air between hexes without shrinking them. The stagger offsets
  // (`rowOffset` / `colOffset`) are derived from the gapped step so the
  // odd-row / odd-col centering is preserved.
  const cellGapMeters = Math.max(0, config.cellGap ?? 0)
  const gapLngDeg = metersToLngDelta(cellGapMeters, midLat)
  const gapLatDeg = metersToLatDelta(cellGapMeters)
  // The no-gap step is used to compute `cols` / `rows` and to decide which
  // cells survive the bbox drop — this preserves the exact no-gap cell
  // count when a gap is added (the rack grows rather than losing cells).
  const baseColStep = orientation === 'pointy' ? wDeg : (3 / 4) * wDeg
  const baseRowStep = orientation === 'pointy' ? (3 / 4) * hDeg : hDeg
  const baseRowOffset = orientation === 'pointy' ? baseColStep / 2 : 0
  const baseColOffset = orientation === 'flat' ? baseRowStep / 2 : 0
  // The gapped step is used to position the survivors.
  const colStepDeg = baseColStep + gapLngDeg
  const rowStepDeg = baseRowStep + gapLatDeg
  const rowOffset = orientation === 'pointy' ? colStepDeg / 2 : 0
  const colOffset = orientation === 'flat' ? rowStepDeg / 2 : 0

  // Anchor the first hexagon at the bbox corner matching `start`. The first
  // hexagon's leftmost (pointy-top) or bottom (flat-top) point sits at the
  // anchor corner, so cell 0 is as close to the click as hex geometry
  // allows. Direction is mirrored if the start is at the far corner.
  const { cornerLng, cornerLat, dLng, dLat } = getAnchor(start, bbox)
  const startCenterLng = cornerLng + (wDeg / 2) * dLng
  const startCenterLat = cornerLat + (hDeg / 2) * dLat

  // Use Math.floor so the grid fits inside the bbox; any hexagons that
  // still poke past the edge (e.g. odd rows offset by half a cell) are
  // dropped at the end so the user only sees complete cells.
  const cols = Math.max(1, Math.floor((east - west) / baseColStep) + 1)
  const rows = Math.max(1, Math.floor((north - south) / baseRowStep) + 1)

  const halfW = wDeg / 2
  const halfH = hDeg / 2
  const baseCorners: [number, number][] =
    orientation === 'pointy'
      ? [
          [0, -halfH],
          [halfW, -halfH / 2],
          [halfW, halfH / 2],
          [0, halfH],
          [-halfW, halfH / 2],
          [-halfW, -halfH / 2],
        ]
      : [
          [halfW, 0],
          [halfW / 2, halfH],
          [-halfW / 2, halfH],
          [-halfW, 0],
          [-halfW / 2, -halfH],
          [halfW / 2, -halfH],
        ]
  // Mirror corner offsets when extending in the negative direction so each
  // hexagon is properly oriented relative to its center, not just translated.
  const corners: [number, number][] = baseCorners.map(
    ([dx, dy]) => [dx * dLng, dy * dLat] as [number, number]
  )

  const eps = 1e-9
  const cells: GridCell[] = []
  let index = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // First pass when `cellGap > 0`: compute the hex position at the
      // no-gap pitch and skip it if it would have been dropped by the
      // no-gap bbox filter. This keeps the cell count identical to the
      // no-gap case — the rack grows to accommodate the gaps rather than
      // losing edge hexes.
      if (cellGapMeters > 0) {
        const probeCx =
          startCenterLng +
          c * baseColStep * dLng +
          (r % 2 === 1 ? baseRowOffset * dLng : 0)
        const probeCy =
          startCenterLat +
          r * baseRowStep * dLat +
          (c % 2 === 1 ? baseColOffset * dLat : 0)
        const probeRing = corners.map(([dx, dy]) => [probeCx + dx, probeCy + dy] as [number, number])
        let inside = true
        for (const [lng, lat] of probeRing) {
          if (lng < west - eps || lng > east + eps || lat < south - eps || lat > north + eps) {
            inside = false
            break
          }
        }
        if (!inside) continue
      }
      // Position with the gapped pitch (when `cellGap > 0`) so the hex
      // stays full-size with `cellGap` of air between neighbors. The rack
      // extends past the drawn bbox by the total gap space, which is the
      // user's desired "grow the rack" behavior.
      const cx =
        startCenterLng +
        c * colStepDeg * dLng +
        (r % 2 === 1 ? rowOffset * dLng : 0)
      const cy =
        startCenterLat +
        r * rowStepDeg * dLat +
        (c % 2 === 1 ? colOffset * dLat : 0)
      const ring: [number, number][] = corners.map(([dx, dy]) => [cx + dx, cy + dy])
      ring.push([ring[0][0], ring[0][1]])
      const cell = turfPolygon(
        [ring],
        makeCellProps(`${r}-${c}`, gridId, r, c, index, elevation, height, rows, cols, config)
      ) as GridCell
      cells.push(cell)
      index++
    }
  }
  // When `cellGap > 0` the survivor filter above already kept only the
  // no-gap cells, so no further drop is needed (and dropping would remove
  // the hexes that intentionally poke past the bbox by the gap amount).
  if (cellGapMeters > 0) return cells
  return dropCellsOutsideBbox(cells, bbox)
}

// ---- Build grid from a bbox (for the saved "permanent" grid) ---------------

function rotateCells(
  cells: GridCell[],
  pivot: [number, number],
  degrees: number
): GridCell[] {
  if (!degrees || Math.abs(degrees) < 1e-6) return cells
  return cells.map((cell) => {
    const rotated = transformRotate(cell, degrees, { pivot, mutate: false }) as GridCell
    rotated.properties = { ...cell.properties }
    return rotated
  })
}

export function buildGrid(
  bbox: [number, number, number, number],
  config: GridConfig,
  start?: [number, number],
  gridId?: number
): FeatureCollection<Polygon, GridCellProps> {
  // Default the anchor to the bbox's lower-left corner when no explicit
  // start is given (e.g. for fixed-bbox rendering where we don't have a
  // click point to anchor to).
  const anchor: [number, number] = start ?? [bbox[0], bbox[1]]
  // Pivot for rotation:
  //   - When `start` is provided (live draw + committed grids that pass
  //     their click point), pivot on `start` so the user's first click
  //     stays glued to that point under any rotation. This matches the
  //     visual expectation of "the start circle is the corner; rotate
  //     the box around it" and keeps the dashed bbox guide aligned with
  //     the start marker.
  //   - When `start` is missing (the `bbox`-only render path), fall
  //     back to the bbox center.
  const pivot: [number, number] = start ?? [
    (bbox[0] + bbox[2]) / 2,
    (bbox[1] + bbox[3]) / 2,
  ]
  let cells: GridCell[]
  if (config.type === 'square') {
    cells = buildSquareGrid(bbox, config.xSize, config.ySize, config.elevation, config.height, anchor, config, gridId)
  } else if (config.type === 'triangle') {
    cells = buildTriangleGrid(bbox, config.xSize, config.ySize, config.elevation, config.height, anchor, config, gridId)
  } else {
    cells = buildHexGrid(bbox, config.xSize, config.hexOrientation, config.elevation, config.height, anchor, config, gridId)
  }
  cells = rotateCells(cells, pivot, config.rotation)
  // No post-rotation drop step: the cells were built to fit inside the
  // axis-aligned bbox, and rotation around the bbox center preserves
  // containment (the rotated bbox and the rotated cells share the same
  // extent), so the rotated cells still fit inside the rotated bbox.
  // Each builder already called dropCellsOutsideBbox to remove any
  // partial cells that wouldn't have closed cleanly.
  //
  // Stamp `feature.id` on every emitted cell so the overlay's
  // `setFeatureState` sync can drive `fill-extrusion-opacity` per grid
  // (Mapbox 3.x rejects data expressions on that paint property). All
  // cells of a saved grid share the same id — opacity is grid-wide, and
  // multiple features can share a feature-state id. Live preview cells
  // get a sentinel id so the preview opacity also reacts in real time.
  for (const cell of cells) {
    cell.id = gridId ?? GRID_PREVIEW_FEATURE_ID
  }
  return { type: 'FeatureCollection', features: cells }
}

/**
 * Sentinel `feature.id` for the live-preview grid (no DB id yet). Dexie
 * auto-increment starts at 1, so 0 is permanently free.
 */
export const GRID_PREVIEW_FEATURE_ID = 0

// ---- Build grid from a start point in the direction of the mouse ----------
// (used for the live drawing preview)

/**
 * Rotate a single point (x, y) around a pivot by `degrees`, matching the
 * direction used by `@turf/turf.transformRotate` (which is implemented
 * internally via `rhumbBearing` + `rhumbDestination`). For a positive
 * `degrees` the point moves clockwise in compass terms — e.g.
 * `(1, 0)` rotated `+58°` around `(0, 0)` lands at
 * `(sin 148°, cos 148°) ≈ (0.530, -0.848)`. This is the OPPOSITE
 * direction of the standard math counter-clockwise rotation; using
 * the standard CCW matrix would put the bbox outline and the cells
 * at different rotations. Keeping the two helpers aligned is what
 * guarantees the dashed bbox guide box matches the cell layout.
 */
export function rotatePointAroundPivot(
  x: number,
  y: number,
  pivotX: number,
  pivotY: number,
  degrees: number
): [number, number] {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = x - pivotX
  const dy = y - pivotY
  return [
    pivotX + dx * cos + dy * sin,
    pivotY - dx * sin + dy * cos,
  ]
}

/**
 * Compute the 4 corners of a rotated bbox, suitable for drawing as a
 * closed LineString outline that matches the rotated cell polygons.
 * When `degrees === 0` returns the axis-aligned corners in
 * `[w,s], [e,s], [e,n], [w,n]` order. Otherwise the corners are rotated
 * around `pivot` (defaults to the bbox center) using the same direction
 * as `turf.transformRotate`. Pass the user's first-click point as
 * `pivot` so the outline is anchored at the start of the draw.
 */
export function rotatedBboxCorners(
  bbox: [number, number, number, number],
  degrees: number,
  pivot?: [number, number]
): [number, number][] {
  const [w, s, e, n] = bbox
  const px = pivot?.[0] ?? (w + e) / 2
  const py = pivot?.[1] ?? (s + n) / 2
  const corners: [number, number][] = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ]
  const rot = ((degrees % 360) + 360) % 360
  if (Math.abs(rot) < 1e-6) return corners
  return corners.map(([x, y]) => rotatePointAroundPivot(x, y, px, py, rot))
}

/**
 * Compute the position of the rotation handle for a (possibly rotated)
 * grid. The handle sits at the midpoint of the FIRST edge of the
 * rotated bbox, offset OUTWARD from the bbox center by
 * `radiusScale × distance(center, edge_midpoint)`. This is the same
 * algorithm used by `mapbox-gl-draw-scale-rotate-mode` (a port of
 * `SRMode._createRotationPoint`):
 *
 *   1. Get the 4 corners of the bbox rotated by `rotation` around the
 *      bbox center.
 *   2. Take the first edge (corners[0] → corners[1]) and find its
 *      midpoint.
 *   3. Compute the bearing from the bbox center to that midpoint.
 *   4. Place the handle at `radiusScale × distance` from the center
 *      along that bearing, so the handle sits clearly outside the grid
 *      body and is easy to grab without occluding cells.
 *
 * The handle therefore "rotates with" the grid: as the user changes
 * the grid's rotation, the handle moves around the perimeter, always
 * at the same offset from the first edge's midpoint.
 */
export function rotatedHandlePosition(
  bbox: [number, number, number, number],
  rotation: number,
  radiusScale: number,
  pivot?: [number, number]
): [number, number] {
  const [w, s, e, n] = bbox
  const cx = (w + e) / 2
  const cy = (s + n) / 2
  // Use the supplied pivot for both the corner rotation and the
  // outward-offset reference, so the handle follows the bbox under any
  // pivot (bbox center for legacy callers, `start` for the start-anchored
  // rotation path).
  const px = pivot?.[0] ?? cx
  const py = pivot?.[1] ?? cy
  const corners = rotatedBboxCorners(bbox, rotation, [px, py])
  // First edge: corners[0] (SW) → corners[1] (SE). Midpoint:
  const mx = (corners[0][0] + corners[1][0]) / 2
  const my = (corners[0][1] + corners[1][1]) / 2
  // Direction from pivot to midpoint (unit vector in lng/lat space).
  const dx = mx - px
  const dy = my - py
  const d = Math.hypot(dx, dy)
  if (d < 1e-12) return [px, py]
  const ux = dx / d
  const uy = dy / d
  // Offset the handle outward by `radiusScale × d`. With radiusScale =
  // 1.0 the handle sits ON the edge midpoint; 1.2 places it 20% past
  // the edge (matches the package's default).
  return [px + ux * d * radiusScale, py + uy * d * radiusScale]
}

export interface LineGridResult {
  cells: GridCell[]
  /** The cell id marked as the "future" / leading cell. */
  futureId: string | null
  /** Total bounds of all cell corners in lng/lat. */
  bbox: [number, number, number, number] | null
}

function markFuture(cells: GridCell[], current: [number, number], committed = false): LineGridResult {
  if (!committed) {
    let minDist = Infinity
    let futureId: string | null = null
    for (const c of cells) {
      const cc = cellCentroid(c)
      const d = distanceMeters(cc, current)
      if (d < minDist) {
        minDist = d
        futureId = c.properties.id
      }
    }
    if (futureId !== null) {
      const fc = cells.find((c) => c.properties.id === futureId)
      if (fc) fc.properties.future = true
    }
  }
  // The bbox walks every vertex of every cell, and most callers (the map
  // overlays, occlusion, export) never read it — so it is computed on first
  // read and remembered. Same value, same enumerable key.
  let bbox: [number, number, number, number] | null | undefined
  return {
    cells,
    futureId: null,
    get bbox() {
      if (bbox === undefined) bbox = cellsBbox(cells)
      return bbox
    },
  }
}

function cellsBbox(cells: GridCell[]): [number, number, number, number] | null {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const c of cells) {
    for (const [lng, lat] of c.geometry.coordinates[0]) {
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
  }
  return minLng === Infinity ? null : [minLng, minLat, maxLng, maxLat]
}

/**
 * Build a 2D grid that fills the rectangle defined by `start` and `current`
 * as opposite corners. Works for all grid types (square, triangle, hexagon).
 *
 * The bbox is `[minLng, minLat, maxLng, maxLat]` of the two points, then
 * `buildGrid` fills it with cells rotated by `config.rotation` around the
 * bbox center.
 *
 * The "future" cell is the one whose center is closest to `current` — the
 * leading corner of the rectangle. Pass `options.committed: true` to skip
 * the "future" flag (used for already-saved grids, which have no leading
 * edge).
 *
 * When start === current (or the two points are within 0.01 m), returns
 * an empty result.
 */
export function buildGridFromLine(
  start: [number, number],
  current: [number, number],
  config: GridConfig,
  options: { committed?: boolean; gridId?: number } = {}
): LineGridResult {
  if (distanceMeters(start, current) < 0.01) {
    return { cells: [], futureId: null, bbox: null }
  }
  if (config.type === 'square' && isPathGrid(config)) {
    const cells = buildPathGrid(start, current, config, options.gridId)
    for (const cell of cells) cell.id = options.gridId ?? GRID_PREVIEW_FEATURE_ID
    const tail = cells[cells.length - 1]
    return markFuture(cells, tail ? cellCentroid(tail) : current, options.committed)
  }

  const minLng = Math.min(start[0], current[0])
  const maxLng = Math.max(start[0], current[0])
  const minLat = Math.min(start[1], current[1])
  const maxLat = Math.max(start[1], current[1])
  const bbox: [number, number, number, number] = [minLng, minLat, maxLng, maxLat]
  const fc = buildGrid(bbox, config, start, options.gridId)
  return markFuture(fc.features as GridCell[], current, options.committed)
}

/**
 * Square cells laid along `config.path` (see grid-path.ts): columns along the
 * path, `pathRows` rows across it, same ids / props / level stacking as
 * `buildSquareGrid`, rotated around `start` by `config.rotation`. Each row sits
 * `pathRowRise` m above the one before it (raked seating).
 */
function buildPathGrid(
  start: [number, number],
  current: [number, number],
  config: GridConfig,
  gridId?: number,
): GridCell[] {
  const frame = pathGridFrame(start, current)
  const arc = makeArc(pathPolylineMetres(start, current, config.path ?? [], !!config.pathSmooth))
  if (!arc.valid) return []
  const { rows, cols } = pathGridDimensions(start, current, config)
  const gap = Math.max(0, config.cellGap ?? 0)
  const pitchX = config.xSize + gap
  const pitchY = config.ySize + gap
  const depth = pathGridDepth(config)
  // Row bands across the path (left-hand offsets positive). Row 0 is the
  // band nearest the path on a one-sided grid, the right-most when centred.
  const align = config.pathAlign ?? 'center'
  const band = (r: number): [number, number] => {
    if (align === 'left') return [r * pitchY, r * pitchY + config.ySize]
    if (align === 'right') return [-(r * pitchY + config.ySize), -r * pitchY]
    const a = -depth / 2 + r * pitchY
    return [a, a + config.ySize]
  }
  const insetX = gap > 0 ? 0 : config.xSize * CELL_INSET_FRACTION
  const insetY = gap > 0 ? 0 : config.ySize * CELL_INSET_FRACTION
  const totalLevels = Math.max(1, Math.floor(config.levels ?? 1))
  const levelHeight = Math.max(0, config.levelHeight ?? 0)
  const levelGap = Math.max(0, config.levelGap ?? 0)
  const perLevelHeight = totalLevels > 1 ? levelHeight : config.height
  const rowRise = Math.max(0, config.pathRowRise ?? 0)
  // A column's stops along the arc don't depend on the row (rows only
  // change the offsets across it), so look each column's up once instead
  // of once per row.
  // (Pushed, not pre-sized: a corrupt size makes `cols` NaN, which must
  // yield no cells rather than throw.)
  const colStops: ArcStop[][] = []
  for (let c = 0; c < cols; c++) {
    const s0 = c * pitchX
    colStops.push(arcStops(arc, s0 + insetX, s0 + config.xSize - insetX))
  }
  const cells: GridCell[] = []
  let index = 0
  for (let r = 0; r < rows; r++) {
    const [a, b] = band(r)
    const rowBase = config.elevation + r * rowRise
    for (let c = 0; c < cols; c++) {
      const ring = cellRingFromStops(colStops[c], a + insetY, b - insetY).map(frame.toLngLat)
      for (let lvl = 0; lvl < totalLevels; lvl++) {
        const cellElevation = totalLevels > 1 ? rowBase + lvl * (levelHeight + levelGap) : rowBase
        cells.push(
          turfPolygon(
            [ring],
            makeCellProps(
              totalLevels > 1 ? `${r}-${c}-l${lvl}` : `${r}-${c}`,
              gridId,
              r,
              c,
              index,
              cellElevation,
              perLevelHeight,
              rows,
              cols,
              config,
              lvl,
              totalLevels,
            ),
          ) as GridCell,
        )
        index++
      }
    }
  }
  return rotateCells(cells, start, config.rotation)
}

/**
 * A path grid's vertices as they sit on the map ([lng, lat], with the grid's
 * rotation applied) — what Re-draw seeds the draw mode with so the user
 * continues the existing path.
 */
export function pathGridDrawnVertices(
  start: [number, number],
  current: [number, number],
  config: GridConfig,
): [number, number][] {
  if (!isPathGrid(config)) return []
  const verts = pathGridVertices(start, current, config.path ?? [])
  if (!config.rotation) return verts
  return verts.map(([x, y]) => rotatePointAroundPivot(x, y, start[0], start[1], config.rotation))
}

/**
 * Outline of a path-layout grid's whole strip (all rows, full length) as one
 * [lng, lat] ring, rotated like the cells. Used where a single footprint is
 * enough (report thumbnails, extents); empty for non-path grids.
 */
export function pathGridOutline(
  start: [number, number],
  current: [number, number],
  config: GridConfig,
): [number, number][] {
  const strip = pathGridStrip(start, current, config)
  if (!strip) return []
  const ring = cellRingFromStops(strip.stops, strip.a, strip.b).map(strip.frame.toLngLat)
  if (!config.rotation) return ring
  return ring.map(([x, y]) => rotatePointAroundPivot(x, y, start[0], start[1], config.rotation))
}

/**
 * A path grid's whole strip in local metres, unrotated: the stops along the
 * arc from 0 to the end of the last column, and the offsets of its two long
 * edges. Null for non-path grids or an unusable path.
 */
function pathGridStrip(start: [number, number], current: [number, number], config: GridConfig) {
  if (config.type !== 'square' || !isPathGrid(config)) return null
  const frame = pathGridFrame(start, current)
  const arc = makeArc(pathPolylineMetres(start, current, config.path ?? [], !!config.pathSmooth))
  if (!arc.valid) return null
  const { cols } = pathGridDimensions(start, current, config)
  const gap = Math.max(0, config.cellGap ?? 0)
  const depth = pathGridDepth(config)
  const align = config.pathAlign ?? 'center'
  const [a, b] = align === 'left' ? [0, depth] : align === 'right' ? [-depth, 0] : [-depth / 2, depth / 2]
  return { frame, stops: arcStops(arc, 0, cols * (config.xSize + gap) - gap), a, b }
}

// ---- Basemap clip footprint -------------------------------------------------

/**
 * The footprint(s) a grid hands the map overlay's basemap `clip` layer —
 * an area that contains every cell, so whatever a per-cell footprint would
 * erase from the basemap (3D buildings, landmarks, POI symbols) is still
 * erased. Mapbox pays for clip footprints on EVERY frame (each one is a
 * replacement region it re-sorts and re-tests), so one ring per grid
 * instead of one per cell is the difference between ~50 regions and ~30k
 * on a stadium.
 *
 *   - Path grids: the strip outline (all rows, full length, including the
 *     gaps between cells and rows), rotated exactly like the cells
 *     (`transformRotate` around `start`). Used only when the strip map is
 *     provably one-to-one — each strip segment keeps its orientation at
 *     all four corners and the outline doesn't cross itself — which makes
 *     every cell (the image of a sub-rectangle of the strip) lie inside it.
 *     A switch-back or an over-tight bend falls back to per-cell rings.
 *   - Every other grid: the convex hull of all cell vertices (for a square
 *     or triangle grid that is its rotated rectangle).
 *
 * `cells` is the grid's own `buildGridFromLine` output for the same inputs.
 */
export function gridClipRings(
  start: [number, number],
  current: [number, number],
  config: GridConfig,
  cells: ReadonlyArray<GridCell>,
): [number, number][][] {
  if (cells.length === 0) return []
  const perCell = () =>
    cells.map((c) => c.geometry.coordinates[0] as [number, number][]).filter((r) => r.length >= 4)
  if (config.type === 'square' && isPathGrid(config)) {
    const strip = pathGridStrip(start, current, config)
    if (!strip || !stripIsOneToOne(strip.stops, strip.a, strip.b)) return perCell()
    const ring = cellRingFromStops(strip.stops, strip.a, strip.b).map(strip.frame.toLngLat)
    if (ring.length < 4 || ringSelfIntersects(ring)) return perCell()
    const degrees = config.rotation
    if (!degrees || Math.abs(degrees) < 1e-6) return [ring]
    const rotated = transformRotate(turfPolygon([ring]), degrees, { pivot: start, mutate: false })
    return [rotated.geometry.coordinates[0] as [number, number][]]
  }
  const hull = convexHull(cells)
  return hull ? [hull] : perCell()
}

/**
 * True when the strip map (s, o) → p(s) + n(s)·o has a positive Jacobian
 * on every segment between consecutive stops, for o across [a, b]. On a
 * segment the map is bilinear in (t, o), so its Jacobian is bilinear too
 * and positive everywhere iff it is positive at the four corners.
 */
function stripIsOneToOne(stops: ReadonlyArray<ArcStop>, a: number, b: number): boolean {
  for (let i = 1; i < stops.length; i++) {
    const p0 = stops[i - 1].p
    const p1 = stops[i].p
    const n0 = stops[i - 1].n
    const n1 = stops[i].n
    for (const o of [a, b]) {
      // ∂F/∂t at offset o (constant along the segment).
      const cx = p1[0] - p0[0] + o * (n1[0] - n0[0])
      const cy = p1[1] - p0[1] + o * (n1[1] - n0[1])
      // ∂F/∂o at t = 0 and t = 1.
      if (!(cx * n0[1] - cy * n0[0] > 0)) return false
      if (!(cx * n1[1] - cy * n1[0] > 0)) return false
    }
  }
  return true
}

/** Above this many edges the O(n²) self-intersection test isn't worth it. */
const MAX_OUTLINE_EDGES = 4000

/**
 * True when two non-adjacent edges of the closed ring touch or cross.
 * Collinear overlaps count as crossings (when in doubt, report one).
 */
function ringSelfIntersects(ring: ReadonlyArray<[number, number]>): boolean {
  const m = ring.length - 1 // edges; ring[m] repeats ring[0]
  if (m > MAX_OUTLINE_EDGES) return true
  const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
  const onSeg = (ax: number, ay: number, bx: number, by: number, px: number, py: number) =>
    Math.min(ax, bx) <= px && px <= Math.max(ax, bx) && Math.min(ay, by) <= py && py <= Math.max(ay, by)
  for (let i = 0; i < m; i++) {
    const [ax, ay] = ring[i]
    const [bx, by] = ring[i + 1]
    const minX = Math.min(ax, bx)
    const maxX = Math.max(ax, bx)
    const minY = Math.min(ay, by)
    const maxY = Math.max(ay, by)
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue // share ring[0]
      const [cx, cy] = ring[j]
      const [dx, dy] = ring[j + 1]
      if (Math.max(cx, dx) < minX || Math.min(cx, dx) > maxX || Math.max(cy, dy) < minY || Math.min(cy, dy) > maxY) continue
      const o1 = orient(ax, ay, bx, by, cx, cy)
      const o2 = orient(ax, ay, bx, by, dx, dy)
      const o3 = orient(cx, cy, dx, dy, ax, ay)
      const o4 = orient(cx, cy, dx, dy, bx, by)
      if (o1 !== o2 && o3 !== o4) return true
      if (o1 === 0 && onSeg(ax, ay, bx, by, cx, cy)) return true
      if (o2 === 0 && onSeg(ax, ay, bx, by, dx, dy)) return true
      if (o3 === 0 && onSeg(cx, cy, dx, dy, ax, ay)) return true
      if (o4 === 0 && onSeg(cx, cy, dx, dy, bx, by)) return true
    }
  }
  return false
}

/**
 * Convex hull (closed, counter-clockwise) of every vertex of every cell —
 * Andrew's monotone chain. Null when the cells span no area.
 */
function convexHull(cells: ReadonlyArray<GridCell>): [number, number][] | null {
  const pts: [number, number][] = []
  for (const cell of cells) {
    const ring = cell.geometry.coordinates[0]
    for (let i = 0; i < ring.length - 1; i++) pts.push([ring[i][0], ring[i][1]])
  }
  if (pts.length < 3) return null
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1])
  const cross = (o: [number, number], p: [number, number], q: [number, number]) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const lower: [number, number][] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: [number, number][] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1))
  if (hull.length < 3) return null
  hull.push(hull[0])
  return hull
}

export function buildGridFromCenter(
  center: [number, number],
  radiusMeters: number,
  config: GridConfig,
  gridId?: number
): LineGridResult {
  // Build a bbox twice the radius around the center, then use bbox approach.
  const minLng = center[0] - metersToLngDelta(radiusMeters, center[1])
  const maxLng = center[0] + metersToLngDelta(radiusMeters, center[1])
  const minLat = center[1] - metersToLatDelta(radiusMeters)
  const maxLat = center[1] + metersToLatDelta(radiusMeters)
  const bbox: [number, number, number, number] = [minLng, minLat, maxLng, maxLat]
  const fc = buildGrid(bbox, config, center, gridId)
  return markFuture(fc.features as GridCell[], center)
}

export function bboxFromCenter(
  center: [number, number],
  widthMeters: number,
  heightMeters: number
): [number, number, number, number] {
  const minLng = center[0] - metersToLngDelta(widthMeters / 2, center[1])
  const maxLng = center[0] + metersToLngDelta(widthMeters / 2, center[1])
  const minLat = center[1] - metersToLatDelta(heightMeters / 2)
  const maxLat = center[1] + metersToLatDelta(heightMeters / 2)
  return [minLng, minLat, maxLng, maxLat]
}
