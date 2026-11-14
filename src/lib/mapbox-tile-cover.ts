/**
 * Per-frame tile bookkeeping cuts for Mapbox GL JS 3.25 that leave every
 * drawn pixel unchanged.
 *
 * Every frame, `Style.updateSources()` runs `SourceCache.update()` for every
 * used source cache. Each GeoJSON source gets its own `coveringTiles()`
 * quadtree walk and then keeps, re-sorts and re-projects one tile per covered
 * tile id. At the pitched orbit cameras (pitch 58°, zoom 17–18.5) the cover
 * reaches about 2 km out, so most of those tiles lie far outside the facility
 * and are empty. Measured on the Standard style, that work is 13–27 % of the
 * orbit CPU: `update` and `_updateLoadedParentTileCache`, then
 * `getVisibleCoordinates` / `getShadowCasterCoordinates` /
 * `sortCoordinatesByDistance` in `Painter.render`, then the worker round trips
 * that load the empty tiles. There are three cuts:
 *
 * 1. **GeoJSON `hasTile`.** `SourceCache.update` already drops covering tiles
 *    a source says it has no data for (`source.hasTile`, which vector sources
 *    use for `bounds`). GeoJSON sources don't define it. Here each one gets a
 *    `hasTile` built from a running Web-Mercator bounding box of every feature
 *    ever sent to its worker. The worker builds a tile from exactly the
 *    features that intersect the tile padded by its own clip buffer
 *    (geojson-vt: `buffer/extent`, supercluster: `radius/extent`, the dynamic
 *    index: 1/64). So a tile whose padded bounds miss the box is one the
 *    worker would return empty, and an empty tile draws nothing. The box
 *    only ever grows, so a tile still showing older data is never dropped
 *    early.
 *
 *    `SourceCache.update` then adds *extra* tiles worked out from the ideal
 *    cover, and a smaller cover must not change which non-empty extras it
 *    adds:
 *    - near-plane extension (sources with an elevated layer): it depends on
 *      the cover only through "non-empty?", its highest `overscaledZ` and a
 *      dedupe set. The nearest tile of every pass and one overscaled tile
 *      (they all share the covering zoom as overscaledZ) are always kept, so
 *      the first two match, and the dedupe can only re-add tiles that were
 *      trimmed, which are empty.
 *    - shadow-caster extension (`castsShadows`): it adds the light-side
 *      neighbours of every cover tile at z ≥ 16, minus candidates that equal,
 *      contain or sit inside a cover tile. For such a source a z ≥ 16 tile is
 *      kept while it is within one tile (plus pad) of the box, so its
 *      neighbours are empty. A z > 16 tile is also kept while its z16
 *      ancestor (padded) touches the box, so any candidate that only a
 *      trimmed tile would have suppressed is itself empty.
 *    - tunnel extension: needs features with the road-elevation property
 *      `3d_elevation_id`. Data carrying it is never trimmed.
 *    Data that can't be bounded (URL data, malformed or non-finite
 *    coordinates) is never trimmed, and nor is a non-mercator projection.
 *
 * 2. **`coveringTiles` memo.** Within one `Style.updateSources()` call the
 *    transform doesn't change, so every source cache with the same cover
 *    options gets the same result. The first call computes it and later calls
 *    get fresh copies: a new array of new `OverscaledTileID`s with the same
 *    fields, because callers push onto the array and stamp matrices on the
 *    ids. Skipped while terrain is on, because the cover then reads DEM
 *    min/max values that the same loop updates.
 *
 * 3. **Empty source caches.** `Painter.render` calls `getVisibleCoordinates`
 *    (twice), `getShadowCasterCoordinates` and `sortCoordinatesByDistance` for
 *    *every* source cache every frame, including the ~250 caches with no
 *    tiles (unused, or gated empty). With no tiles those return `[]`, so they
 *    return a fresh `[]` straight away instead of allocating their way there
 *    (`sortCoordinatesByDistance` also skips a camera `forward()`).
 *
 * All of this reads GL JS internals, so it only installs on 3.25.x, and each
 * patch checks the private method or field it needs and leaves the engine
 * alone if it isn't there. It is installed once, from `tuneMapboxRuntime()`.
 * The private prototypes only become reachable from a live map, so the hook
 * is `Map.prototype.addSource`.
 */

import type mapboxgl from 'mapbox-gl'

type MapboxModule = typeof mapboxgl

const PATCHED = Symbol.for('sgv.tile-cover.patched')
const TRACKED = Symbol.for('sgv.tile-cover.tracked')

/** The only GL JS line whose `SourceCache.update` extensions were audited. */
const AUDITED_VERSION_PREFIX = '3.25.'

// ─── Bounding box of GeoJSON data, in the worker's Web-Mercator space ───────

/** Running bounding box in [0,1] Web-Mercator units (x east, y south). */
export interface MercatorBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function emptyBox(): MercatorBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
}

export function boxIsEmpty(box: MercatorBox): boolean {
  return !(box.minX <= box.maxX && box.minY <= box.maxY)
}

const DEG = Math.PI / 180

/** geojson-vt / supercluster / dynamic-index `projectX`. */
export function mercatorX(lng: number): number {
  return lng / 360 + 0.5
}

/** geojson-vt / supercluster / dynamic-index `projectY`, clamped like theirs. */
export function mercatorY(lat: number): number {
  const sin = Math.sin(lat * DEG)
  const y = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI
  return y < 0 ? 0 : y > 1 ? 1 : y
}

/**
 * Features carrying this property feed GL JS's road-elevation parser, which
 * can mark a tile as holding tunnel geometry and widen the tile cover. Data
 * with it is never trimmed.
 */
const ELEVATION_ID_PROPERTY = '3d_elevation_id'

/** Nesting depth of `coordinates` per geometry type (0 = one position). */
const COORDINATE_DEPTH: Record<string, number> = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
}

function addPosition(box: MercatorBox, position: unknown): boolean {
  if (!Array.isArray(position) || position.length < 2) return false
  const lng: unknown = position[0]
  const lat: unknown = position[1]
  if (typeof lng !== 'number' || typeof lat !== 'number') return false
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false
  const x = mercatorX(lng)
  const y = mercatorY(lat)
  if (x < box.minX) box.minX = x
  if (x > box.maxX) box.maxX = x
  if (y < box.minY) box.minY = y
  if (y > box.maxY) box.maxY = y
  return true
}

function addCoordinates(box: MercatorBox, coordinates: unknown, depth: number): boolean {
  if (depth === 0) return addPosition(box, coordinates)
  if (!Array.isArray(coordinates)) return false
  for (const child of coordinates) if (!addCoordinates(box, child, depth - 1)) return false
  return true
}

function addGeometry(box: MercatorBox, geometry: unknown, nesting = 0): boolean {
  // geojson-vt, supercluster and the dynamic index all skip a feature with
  // no geometry (the diff writer sends removals that way).
  if (geometry === null || geometry === undefined) return true
  if (typeof geometry !== 'object') return false
  const g = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown }
  if (g.type === 'GeometryCollection') {
    if (nesting > 8 || !Array.isArray(g.geometries)) return false
    for (const child of g.geometries) if (!addGeometry(box, child, nesting + 1)) return false
    return true
  }
  const depth = typeof g.type === 'string' ? COORDINATE_DEPTH[g.type] : undefined
  if (depth === undefined) return false
  return addCoordinates(box, g.coordinates, depth)
}

function addFeature(box: MercatorBox, feature: unknown): boolean {
  if (!feature || typeof feature !== 'object') return false
  const f = feature as { properties?: unknown; geometry?: unknown }
  const props = f.properties
  if (props && typeof props === 'object' && Object.prototype.hasOwnProperty.call(props, ELEVATION_ID_PROPERTY)) {
    return false
  }
  return addGeometry(box, f.geometry)
}

/**
 * Grow `box` to cover every feature in `data` (a FeatureCollection, a Feature
 * or a bare geometry — what a GeoJSON source accepts). Returns false when the
 * data can't be bounded (a URL, malformed or non-finite coordinates, an
 * unknown type, road-elevation features), in which case the caller must stop
 * trimming that source.
 */
export function extendBoxWithData(box: MercatorBox, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as { type?: unknown; features?: unknown }
  if (d.type === 'FeatureCollection') {
    if (!Array.isArray(d.features)) return false
    for (const feature of d.features) if (!addFeature(box, feature)) return false
    return true
  }
  if (d.type === 'Feature') return addFeature(box, data)
  return addGeometry(box, data)
}

/**
 * Slack on every comparison, in world units (a z18 tile is ≈ 3.8e-6 wide).
 * supercluster keeps point and cluster positions as float32 (`fround`, ulp
 * ≈ 6e-8 in [0.5, 1)), so its tile query can disagree with a float64 box by
 * about that much. 2.5e-7 covers it with room to spare and stays under 7 % of
 * a z18 tile.
 */
const EPSILON = 2.5e-7

/**
 * Whether tile (z, x, y), padded by `pad` tile widths on every side, touches
 * `box` — or `box` shifted one world left/right, which covers geojson-vt's
 * and supercluster's antimeridian copies.
 */
export function tileTouchesBox(box: MercatorBox, z: number, x: number, y: number, pad: number): boolean {
  if (boxIsEmpty(box)) return false
  const n = Math.pow(2, z)
  const loY = (y - pad) / n - EPSILON
  const hiY = (y + 1 + pad) / n + EPSILON
  if (box.maxY < loY || box.minY > hiY) return false
  const loX = (x - pad) / n - EPSILON
  const hiX = (x + 1 + pad) / n + EPSILON
  for (let shift = -1; shift <= 1; shift++) {
    if (box.maxX + shift >= loX && box.minX + shift <= hiX) return true
  }
  return false
}

/** The dynamic (`updateData`) index pads every tile by 64/4096 of its width. */
const DYNAMIC_INDEX_PAD = 64 / 4096

interface GeoJsonWorkerOptions {
  cluster?: unknown
  geojsonVtOptions?: { buffer?: unknown; extent?: unknown }
  superclusterOptions?: { radius?: unknown; extent?: unknown }
}

/**
 * Tile padding, in tile widths, that the worker uses to decide which features
 * go into a tile — the largest of the three indexes a GeoJSON source can use.
 * Falls back to a full tile when the options aren't where 3.25 keeps them.
 */
export function workerTilePad(workerOptions: GeoJsonWorkerOptions | undefined): number {
  const vt = workerOptions?.geojsonVtOptions
  const buffer = vt?.buffer
  const extent = vt?.extent
  if (typeof buffer !== 'number' || typeof extent !== 'number' || !(extent > 0) || !(buffer >= 0)) return 1
  let pad = Math.max(buffer / extent, DYNAMIC_INDEX_PAD)
  if (workerOptions?.cluster) {
    const radius = workerOptions.superclusterOptions?.radius
    const clusterExtent = workerOptions.superclusterOptions?.extent
    if (typeof radius !== 'number' || typeof clusterExtent !== 'number' || !(clusterExtent > 0) || !(radius >= 0)) {
      return 1
    }
    pad = Math.max(pad, radius / clusterExtent)
  }
  return pad + 1e-6
}

/**
 * `SourceCache.update` passes this as the lowest zoom whose tiles get
 * shadow-caster neighbours (`extendTileCover(cover, zoom, lightDir, 16)`).
 */
export const SHADOW_EXTENSION_MIN_Z = 16

/**
 * Whether a cover tile at canonical (z, x, y) can be dropped from a GeoJSON
 * source's ideal cover without changing anything drawn. `pad` is the worker
 * clip padding; `castsShadows` says whether any of the source's caches is a
 * shadow caster. The two rules that keep the cover non-empty and its top
 * `overscaledZ` (nearest tile of the pass, one overscaled tile) are applied
 * by the caller.
 */
export function tileIsTrimmable(box: MercatorBox, z: number, x: number, y: number, pad: number, castsShadows: boolean): boolean {
  if (tileTouchesBox(box, z, x, y, pad)) return false
  if (!castsShadows) return true
  // Its light-side neighbours must be empty: within one more tile of the box → keep.
  if (z >= SHADOW_EXTENSION_MIN_Z && tileTouchesBox(box, z, x, y, pad + 1)) return false
  // A shadow candidate at z16 is dropped when any cover tile sits inside it.
  // Keep this tile while its z16 ancestor may hold data, so such a candidate
  // only appears here when it is empty.
  if (z > SHADOW_EXTENSION_MIN_Z) {
    const shift = z - SHADOW_EXTENSION_MIN_Z
    if (tileTouchesBox(box, SHADOW_EXTENSION_MIN_Z, x >> shift, y >> shift, pad)) return false
  }
  return true
}

// ─── Minimal shapes of the GL JS 3.25 internals we touch ────────────────────

interface CanonicalTileIdLike {
  z: number
  x: number
  y: number
}
interface OverscaledTileIdLike {
  overscaledZ: number
  wrap: number
  canonical: CanonicalTileIdLike
  visibleQuadrants?: number
}
type OverscaledTileIdCtor = new (overscaledZ: number, wrap: number, z: number, x: number, y: number) => OverscaledTileIdLike

interface SourceCacheLike {
  castsShadows?: unknown
  _tiles?: Record<string, unknown>
  _source?: unknown
}
interface StyleLike {
  _otherSourceCaches?: Record<string, SourceCacheLike | undefined>
  _symbolSourceCaches?: Record<string, SourceCacheLike | undefined>
  _fillExtrusionSourceCaches?: Record<string, SourceCacheLike | undefined>
  updateSources?: (transform: unknown) => unknown
}
interface TransformLike {
  _elevation?: unknown
  projection?: { name?: unknown }
  coveringTiles?: (options: unknown) => OverscaledTileIdLike[]
}
interface MapInternals {
  style?: StyleLike
  transform?: TransformLike
  getSource(id: string): unknown
}
interface GeoJsonSourceLike {
  id?: unknown
  type?: unknown
  map?: MapInternals
  _data?: unknown
  workerOptions?: GeoJsonWorkerOptions
  setData?: (data: unknown) => unknown
  updateData?: (data: unknown) => unknown
  hasTile?: (tileID: OverscaledTileIdLike) => boolean
  [TRACKED]?: TrimState
}

// ─── 1. GeoJSON hasTile ─────────────────────────────────────────────────────

interface TrimState {
  /** Set once any data we can't bound reached the worker. Never cleared. */
  unbounded: boolean
  /** Union of every feature ever sent to the worker (it never shrinks). */
  box: MercatorBox
  /** Worker clip padding in tile widths. */
  pad: number
  /** Set by `SourceCache.update` before its cover filter: keep the next tile. */
  firstOfPass: boolean
  /** Set with `firstOfPass`: keep the next overscaled tile. */
  overscaledPending: boolean
  /** Tiles this source has skipped (dev diagnostics only). */
  skipped: number
}

/**
 * True once `SourceCache.prototype.update` marks the start of every cover
 * pass. Without it the "keep the nearest tile" rule can't run, so nothing is
 * trimmed.
 */
let passMarkerInstalled = false

/**
 * Whether any cache of `sourceId` casts shadows, or null when the style
 * internals aren't where 3.25 keeps them (then nothing is trimmed).
 */
function sourceCastsShadows(style: StyleLike, sourceId: string): boolean | null {
  const other = style._otherSourceCaches
  const symbol = style._symbolSourceCaches
  if (!other || typeof other !== 'object' || !symbol || typeof symbol !== 'object') return null
  const a = cacheCastsShadows(other[sourceId])
  const b = cacheCastsShadows(symbol[sourceId])
  const c = cacheCastsShadows(style._fillExtrusionSourceCaches?.[sourceId])
  if (a === null || b === null || c === null) return null
  return a || b || c
}

/** false for a missing cache, null when the flag isn't the boolean 3.25 keeps. */
function cacheCastsShadows(cache: SourceCacheLike | undefined): boolean | null {
  if (!cache) return false
  return typeof cache.castsShadows === 'boolean' ? cache.castsShadows : null
}

function trackGeoJsonSource(map: MapInternals, id: string): void {
  const src = map.getSource(id) as GeoJsonSourceLike | undefined
  if (!src || typeof src !== 'object' || src.type !== 'geojson' || src[TRACKED]) return
  if (typeof src.setData !== 'function' || 'hasTile' in src) return

  const state: TrimState = {
    unbounded: false,
    box: emptyBox(),
    pad: workerTilePad(src.workerOptions),
    firstOfPass: false,
    overscaledPending: false,
    skipped: 0,
  }
  // `onAdd` already ran `setData(this._data)` with the spec's data.
  if (!extendBoxWithData(state.box, src._data)) state.unbounded = true
  src[TRACKED] = state
  if (import.meta.env?.DEV) {
    // Dev diagnostics for the browser verifier: map.__tileCover[sourceId].
    const diag = map as unknown as { __tileCover?: Record<string, TrimState> }
    ;(diag.__tileCover ??= {})[id] = state
  }

  const origSetData = src.setData.bind(src)
  src.setData = (data: unknown) => {
    // Grow the box before the worker gets the data, so no update in between
    // can trim a tile the new data lands in.
    if (!state.unbounded && !extendBoxWithData(state.box, data)) state.unbounded = true
    return origSetData(data)
  }
  if (typeof src.updateData === 'function') {
    const origUpdateData = src.updateData.bind(src)
    src.updateData = (data: unknown) => {
      // A diff: added / changed features carry their geometry, removals carry
      // `geometry: null`. The box never shrinks, so the union stays a superset.
      if (!state.unbounded && !extendBoxWithData(state.box, data)) state.unbounded = true
      return origUpdateData(data)
    }
  }

  src.hasTile = (tileID: OverscaledTileIdLike) => {
    const canonical = tileID?.canonical
    const overscaled = !!canonical && tileID.overscaledZ !== canonical.z
    // The nearest tile of every pass stays, so a non-empty cover stays
    // non-empty and the near-plane / shadow extensions still run.
    if (state.firstOfPass) {
      state.firstOfPass = false
      if (overscaled) state.overscaledPending = false
      return true
    }
    // One overscaled tile stays. `coveringTiles` gives every overscaled tile
    // the same overscaledZ (the covering zoom), the cover's highest, and the
    // near-plane extension stamps that value on the tiles it adds.
    if (overscaled && state.overscaledPending) {
      state.overscaledPending = false
      return true
    }
    if (state.unbounded || !passMarkerInstalled) return true
    if (!canonical || typeof canonical.z !== 'number' || typeof canonical.x !== 'number' || typeof canonical.y !== 'number') {
      return true
    }
    if (tileTouchesBox(state.box, canonical.z, canonical.x, canonical.y, state.pad)) return true
    const owner = src.map
    const style = owner?.style
    if (!style || typeof src.id !== 'string') return true
    if (owner.transform?.projection?.name !== 'mercator') return true
    const shadows = sourceCastsShadows(style, src.id)
    if (shadows === null) return true
    if (!tileIsTrimmable(state.box, canonical.z, canonical.x, canonical.y, state.pad, shadows)) return true
    state.skipped++
    return false
  }
}

// ─── 2. coveringTiles memo  +  3. empty source caches ───────────────────────

interface CoverSnapshot {
  ctor: OverscaledTileIdCtor | null
  ids: Array<[overscaledZ: number, wrap: number, z: number, x: number, y: number, visibleQuadrants: number | undefined]>
}

/** transform → memo of `coveringTiles` results for the running `updateSources`. */
const activeCoverMemos = new WeakMap<object, { depth: number; results: Map<string, CoverSnapshot> }>()

/** Memo key for a `coveringTiles` options object, or null if it isn't all primitives. */
export function coverOptionsKey(options: unknown): string | null {
  if (!options || typeof options !== 'object') return null
  const record = options as Record<string, unknown>
  const keys = Object.keys(record).sort()
  let key = ''
  for (const k of keys) {
    const v = record[k]
    const t = typeof v
    if (v !== undefined && v !== null && t !== 'number' && t !== 'boolean' && t !== 'string') return null
    key += `${k}=${t}:${String(v)};`
  }
  return key
}

const TILE_ID_OWN_KEYS = new Set(['overscaledZ', 'wrap', 'canonical', 'key', 'visibleQuadrants'])

function snapshotCover(result: OverscaledTileIdLike[]): CoverSnapshot | null {
  const ids: CoverSnapshot['ids'] = []
  let ctor: OverscaledTileIdCtor | null = null
  for (const id of result) {
    const c = id?.canonical
    if (!c || typeof id.overscaledZ !== 'number' || typeof id.wrap !== 'number') return null
    // 3.25's OverscaledTileID straight out of coveringTiles carries only these.
    for (const k of Object.keys(id)) if (!TILE_ID_OWN_KEYS.has(k)) return null
    const thisCtor = (id as { constructor?: unknown }).constructor
    if (typeof thisCtor !== 'function') return null
    if (ctor === null) ctor = thisCtor as OverscaledTileIdCtor
    else if (ctor !== thisCtor) return null
    ids.push([id.overscaledZ, id.wrap, c.z, c.x, c.y, id.visibleQuadrants])
  }
  return { ctor, ids }
}

function replayCover(snapshot: CoverSnapshot): OverscaledTileIdLike[] {
  const out: OverscaledTileIdLike[] = []
  const Ctor = snapshot.ctor
  if (!Ctor) return out
  for (const [overscaledZ, wrap, z, x, y, visibleQuadrants] of snapshot.ids) {
    const id = new Ctor(overscaledZ, wrap, z, x, y)
    if (visibleQuadrants !== undefined) id.visibleQuadrants = visibleQuadrants
    out.push(id)
  }
  return out
}

function patchStyleAndTransform(map: MapInternals): void {
  const style = map.style
  const transform = map.transform
  if (!style || !transform) return
  const styleProto = Object.getPrototypeOf(style) as StyleLike & { [PATCHED]?: boolean }
  const transformProto = Object.getPrototypeOf(transform) as TransformLike & { [PATCHED]?: boolean }
  if (styleProto[PATCHED] || transformProto[PATCHED]) return
  const origUpdateSources = styleProto.updateSources
  const origCoveringTiles = transformProto.coveringTiles
  if (typeof origUpdateSources !== 'function' || typeof origCoveringTiles !== 'function') return
  styleProto[PATCHED] = true
  transformProto[PATCHED] = true

  styleProto.updateSources = function (this: StyleLike, t: unknown) {
    if (!t || typeof t !== 'object' || (t as TransformLike)._elevation) return origUpdateSources.call(this, t)
    let memo = activeCoverMemos.get(t)
    if (memo) memo.depth++
    else {
      memo = { depth: 1, results: new Map() }
      activeCoverMemos.set(t, memo)
    }
    try {
      return origUpdateSources.call(this, t)
    } finally {
      if (--memo.depth === 0) activeCoverMemos.delete(t)
    }
  }

  transformProto.coveringTiles = function (this: TransformLike, options: unknown) {
    const memo = activeCoverMemos.get(this)
    // Terrain makes the cover read DEM min/max that the same loop updates.
    if (!memo || this._elevation) return origCoveringTiles.call(this, options)
    const key = coverOptionsKey(options)
    if (key === null) return origCoveringTiles.call(this, options)
    const hit = memo.results.get(key)
    if (hit) return replayCover(hit)
    const result = origCoveringTiles.call(this, options)
    if (Array.isArray(result)) {
      const snapshot = snapshotCover(result)
      if (snapshot) memo.results.set(key, snapshot)
    }
    return result
  }
}

function patchSourceCache(map: MapInternals, id: string): void {
  const cache = map.style?._otherSourceCaches?.[id]
  if (!cache || typeof cache !== 'object') return
  const proto = Object.getPrototypeOf(cache) as {
    [PATCHED]?: boolean
    update?: (this: SourceCacheLike, ...args: unknown[]) => unknown
    getRenderableIds?: (this: SourceCacheLike, symbolOrder?: unknown, includeShadowCasters?: unknown) => unknown[]
    sortCoordinatesByDistance?: (this: SourceCacheLike, coords: unknown) => unknown[]
  }
  if (proto[PATCHED]) return
  const origUpdate = proto.update
  const origGetRenderableIds = proto.getRenderableIds
  const origSortByDistance = proto.sortCoordinatesByDistance
  if (typeof origUpdate !== 'function' || typeof origGetRenderableIds !== 'function' || typeof origSortByDistance !== 'function') {
    return
  }
  proto[PATCHED] = true

  proto.update = function (this: SourceCacheLike, ...args: unknown[]) {
    const state = (this._source as GeoJsonSourceLike | null | undefined)?.[TRACKED]
    if (state) {
      state.firstOfPass = true
      state.overscaledPending = true
    }
    return origUpdate.apply(this, args)
  }
  passMarkerInstalled = true

  proto.getRenderableIds = function (this: SourceCacheLike, symbolOrder?: unknown, includeShadowCasters?: unknown) {
    const tiles = this._tiles
    if (tiles && typeof tiles === 'object') {
      let any = false
      for (const _key in tiles) {
        any = true
        break
      }
      // No tiles: the original builds and sorts an empty list.
      if (!any) return []
    }
    return origGetRenderableIds.call(this, symbolOrder, includeShadowCasters)
  }

  proto.sortCoordinatesByDistance = function (this: SourceCacheLike, coords: unknown) {
    // An empty list sorts to a fresh empty copy, as the original's `slice()`.
    if (Array.isArray(coords) && coords.length === 0) return []
    return origSortByDistance.call(this, coords)
  }
}

/**
 * Install all three cuts. Call once, before the first `new mapboxgl.Map`.
 * A no-op on any GL JS other than 3.25.x, and idempotent across HMR.
 */
export function installTileCoverTuning(mb: MapboxModule): void {
  const version = (mb as unknown as { version?: unknown }).version
  if (typeof version !== 'string' || !version.startsWith(AUDITED_VERSION_PREFIX)) return
  const mapProto = mb.Map.prototype as unknown as {
    addSource: (this: MapInternals, id: string, spec: unknown) => unknown
    [PATCHED]?: boolean
  }
  if (mapProto[PATCHED]) return
  const origAddSource = mapProto.addSource
  if (typeof origAddSource !== 'function') return
  mapProto[PATCHED] = true

  mapProto.addSource = function (this: MapInternals, id: string, spec: unknown) {
    const result = origAddSource.call(this, id, spec)
    try {
      patchStyleAndTransform(this)
      patchSourceCache(this, id)
      trackGeoJsonSource(this, id)
    } catch {
      // Perf-only. A failure here must never break adding a source.
    }
    return result
  }
}

/** Dev diagnostics for a tracked GeoJSON source, or null when untracked. */
export function tileCoverStats(source: unknown): { unbounded: boolean; skipped: number; box: MercatorBox; pad: number } | null {
  const state = (source as GeoJsonSourceLike | null)?.[TRACKED]
  if (!state) return null
  return { unbounded: state.unbounded, skipped: state.skipped, box: { ...state.box }, pad: state.pad }
}
