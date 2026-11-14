/**
 * The viewer-chosen heatmap of one data-link point config (point-at-coord /
 * history-movement): a small source `dl-<id>-rh-src` drawn by one `symbol`
 * layer `dl-<id>-rh-heat`. Mounted by `PointAtCoordSubRenderer` only while
 * the host passes a `pointHeatmap` spec that covers the config — with the
 * heatmap off nothing here touches the map. (The author-time `heatmap`
 * render mode is a separate renderer; this one is a runtime view of a point
 * layer, like runtime clustering.)
 *
 * Why symbols, not a Mapbox `heatmap` or `fill` layer: both of those are
 * depth-tested against the facility's 3D areas — a heatmap paints on the
 * ground plane and a lifted fill sits under room volumes' roofs, so inside
 * the building neither shows. The markers have the same problem and solve it
 * as symbols with `symbol-z-offset`; the heat does the same: a kernel-density
 * grid (1 m cells, σ = 2 m) where every cell is a soft round blob lying flat
 * on the map (`icon-pitch-alignment: map`), sized in metres, at its items'
 * height (+0.25 m, clear of solid area blocks the items stand in), drawn
 * through occluders. Neighbouring blobs overlap, so the result is smooth.
 * With the host's `barriers` the heat stops at walls, racks and solid
 * objects and passes through doors (`data-link/heat-spread.ts`); the blobs
 * trimmed at a face use a firmer gradient, so the heat ends crisply there.
 *
 * Drawing through occluders keeps the heat inside room volumes, but at a
 * tilt it would also show through the walls in front of it. The markers'
 * analytic test (`marker-occlusion.ts`) settles that per cell on every
 * camera move: a cell with a wall, rack or floor plate between it and the
 * camera gets feature-state `occluded` and opacity 0, while the volume a
 * cell stands in never hides it. The host passes the same occluder prisms
 * the markers use.
 *
 * - It reads the point renderer's drawn features (already filtered, floor-
 *   scoped and occlusion-dropped), so it follows every filter the points do;
 *   ghost copies of occluded rows are left out.
 * - Weight: 1 per row, or a numeric payload field normalised to 0.15–1
 *   across the rows drawn (rows without a number count as the minimum).
 *   Density is normalised to the busiest cell, so the hottest spot is always
 *   the top of the ramp.
 * - Colours: four blob images from the theme's status tokens (info → success
 *   → warning → danger), re-drawn on a theme change; opacity rises with
 *   density. No hardcoded colours. With several layers heated each one is
 *   a single theme chart colour (`spec.tints`, one blob image) instead.
 * - Ids follow `dl-<configId>-…` and no sub-renderer claims them, so the dl
 *   layer stack keeps the heat at the bottom of the dl block, under every
 *   point. Not clickable (no hit routing reads `-rh-`).
 * - Writes during a focus flight are held until `moveend`, like the bubbles.
 */

import { useEffect, useMemo } from 'react'
import type { Map as MapboxMapInstance } from 'mapbox-gl'
import { whenStyleLoaded } from '@/lib/mapbox-style-ready'
import { readThemeTokenHex, subscribeThemeChanges } from '@/lib/map-transform-handles'
import { isFocusFlying } from '@/lib/focus/focus-camera'
import { hasMapLayer, raiseDataLinkLayers } from '@/lib/data-link/dl-layer-stack'
import { readPayloadPath } from '@/lib/data-link/match-resolver'
import { plainHeat, spreadHeat, type HeatBarriers, type HeatKernel } from '@/lib/data-link/heat-spread'
import {
  createOcclusionState,
  resetOcclusionState,
  updateOcclusion,
  type OccludableTarget,
  type OccluderPrism,
} from '@/lib/marker-occlusion'

/** What the host asks for. `configIds` null = every point layer. */
export interface PointHeatmapSpec {
  /** 'on' = heat under the points; 'only' = heat, points hidden. */
  mode: 'on' | 'only'
  /** Numeric payload field to weight by; unset = count. */
  weightField?: string | null
  configIds?: ReadonlySet<number> | null
  /** The facility's shapes (memoised): heat stops at walls and solid
   *  objects. Unset = heat spreads freely. */
  barriers?: HeatBarriers | null
  /** Several layers heated at once: config id → theme token (`chart-3`)
   *  its heat is drawn in, one colour fading with density. Unset = the
   *  blue → red ramp. */
  tints?: ReadonlyMap<number, string> | null
}

export function heatmapCovers(spec: PointHeatmapSpec | null | undefined, configId: number | undefined): boolean {
  if (!spec || configId === undefined) return false
  return !spec.configIds || spec.configIds.has(configId)
}

export function dlHeatmapIds(configId: number) {
  return { source: `dl-${configId}-rh-src`, layer: `dl-${configId}-rh-heat` }
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

function mapAlive(map: MapboxMapInstance): boolean {
  const m = map as unknown as { style?: unknown; _removed?: boolean }
  return Boolean(m.style) && !m._removed
}

function rgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

const BLOB_TOKENS = ['info', 'success', 'warning', 'danger'] as const
const BLOB_FALLBACK = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444']
const BLOB_PREFIX = 'sgv-heat-blob-'
const TINT_PREFIX = 'sgv-heat-tint-'
const TINT_FALLBACK = '#6366f1'
/** Suffix of the firm-edged variant drawn for blobs trimmed at a face. */
const EDGE_SUFFIX = '-edge'
const BLOB_PX = 64
const PIXEL_RATIO = 2

/** A soft round blob in one theme colour: opaque centre, transparent rim.
 *  `firm` holds the colour further out, so a blob that ends at a wall
 *  face reads as an edge there instead of fading short of it. */
function drawBlob(token: string, fallback: string, firm: boolean): ImageData | null {
  if (typeof document === 'undefined') return null
  const size = BLOB_PX * PIXEL_RATIO
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const hex = readThemeTokenHex(token, fallback)
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, rgba(hex, 1))
  g.addColorStop(firm ? 0.8 : 0.55, rgba(hex, 0.85))
  g.addColorStop(1, rgba(hex, 0))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return ctx.getImageData(0, 0, size, size)
}

/** One of our blob image ids → the theme token it is drawn in. */
function blobTokenOf(id: string): { token: string; fallback: string; firm: boolean } | null {
  const firm = id.endsWith(EDGE_SUFFIX)
  const t = plainBlobTokenOf(firm ? id.slice(0, -EDGE_SUFFIX.length) : id)
  return t ? { ...t, firm } : null
}

function plainBlobTokenOf(id: string): { token: string; fallback: string } | null {
  if (id.startsWith(TINT_PREFIX)) {
    const token = id.slice(TINT_PREFIX.length)
    return /^chart-\d$/.test(token) ? { token, fallback: TINT_FALLBACK } : null
  }
  if (!id.startsWith(BLOB_PREFIX)) return null
  const n = Number(id.slice(BLOB_PREFIX.length))
  return Number.isInteger(n) && n >= 0 && n < BLOB_TOKENS.length ? { token: BLOB_TOKENS[n]!, fallback: BLOB_FALLBACK[n]! } : null
}

function drawBlobImage(id: string): ImageData | null {
  const t = blobTokenOf(id)
  return t ? drawBlob(t.token, t.fallback, t.firm) : null
}

/** Opacity by density: the ramp starts visible; a single tint starts fainter,
 *  since its colour can't say "cool" by itself. */
function densityOpacity(opacity: number, tinted: boolean): unknown[] {
  const stops = tinted ? [0, 0.1, 0.3, 0.35, 1, 0.85] : [0, 0.2, 0.3, 0.55, 1, 0.9]
  return ['*', opacity, ['interpolate', ['linear'], ['get', 'd'], ...stops]]
}

/** `icon-opacity`: by density, 0 for a cell behind a wall from the camera. */
function visibleOpacity(opacity: number, tinted: boolean): unknown[] {
  return ['case', ['boolean', ['feature-state', 'occluded'], false], 0, densityOpacity(opacity, tinted)]
}

const CELL_M = 1
const SIGMA_M = 2
const REACH_M = SIGMA_M * 3
const MIN_DENSITY = 0.04
/** Blob diameter in cells: wide enough that neighbours blend into one surface. */
const BLOB_CELLS = 3.4
const EARTH_CIRCUMFERENCE_M = 40_075_016.686

/**
 * `icon-size` that makes a BLOB_PX image `BLOB_CELLS` cells wide on the
 * ground at any zoom (exponential base 2 = the map's own scale), at `lat`,
 * times the cell's own scale `s` (smaller blobs at walls).
 */
function blobSizeExpression(lat: number): unknown[] {
  const pxPerMeterZ0 = 512 / (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180))
  const atZ0 = (BLOB_CELLS * CELL_M * pxPerMeterZ0) / BLOB_PX
  const scale = ['coalesce', ['get', 's'], 1]
  return ['interpolate', ['exponential', 2], ['zoom'], 0, ['*', atZ0, scale], 24, ['*', atZ0 * 2 ** 24, scale]]
}

const KERNEL: HeatKernel = { sigmaM: SIGMA_M, reachM: REACH_M, cellM: CELL_M, blobRadiusM: (BLOB_CELLS * CELL_M) / 2 }

/**
 * The density grid from the drawn features: each real row adds a Gaussian
 * (σ = 2 m) to the 1 m cells around it; cells under 4 % of the busiest are
 * dropped. One point per cell, at the cell centre, at its contributors'
 * weighted height. With `barriers` the heat spreads along open floor only
 * and stops at walls and solid objects (`data-link/heat-spread.ts`); cells
 * near them are 0.5 m blobs scaled by `s`.
 */
export function heatCells(
  features: readonly GeoJSON.Feature[],
  weightField?: string | null,
  barriers?: HeatBarriers | null,
): GeoJSON.Feature<GeoJSON.Point>[] {
  const rows: { lng: number; lat: number; elev: number; value: number | null }[] = []
  for (const f of features) {
    const p = f.properties ?? {}
    if (f.geometry?.type !== 'Point' || p.occluded === true || p.manualCluster === true) continue
    const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
    let value: number | null = null
    if (weightField) {
      try {
        const payload = typeof p.payload === 'string' ? JSON.parse(p.payload) : p.payload
        const raw = payload ? readPayloadPath(payload, weightField) : undefined
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
        value = Number.isFinite(n) ? n : null
      } catch {
        value = null
      }
    }
    rows.push({ lng, lat, elev: Number(p.elevation) || 0, value })
  }
  if (rows.length === 0) return []
  let min = Infinity
  let max = -Infinity
  for (const r of rows) {
    if (r.value === null) continue
    if (r.value < min) min = r.value
    if (r.value > max) max = r.value
  }
  const span = max - min
  const weightOf = (v: number | null) => (!weightField ? 1 : v === null || !Number.isFinite(span) ? 0.15 : span > 0 ? 0.15 + (0.85 * (v - min)) / span : 1)
  const weighted = rows.map((r) => ({ lng: r.lng, lat: r.lat, elev: r.elev, w: weightOf(r.value) }))

  const cells = barriers ? spreadHeat(weighted, barriers, KERNEL) : plainHeat(weighted, KERNEL)
  let peak = 0
  for (const c of cells) if (c.d > peak) peak = c.d
  if (peak <= 0) return []
  const out: GeoJSON.Feature<GeoJSON.Point>[] = []
  for (const c of cells) {
    const d = c.d / peak
    if (d < MIN_DENSITY) continue
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: {
        d: Math.round(d * 1000) / 1000,
        z: Math.round((c.zk / c.d + 0.25) * 100) / 100,
        ...(c.s !== undefined ? { s: Math.round(c.s * 1000) / 1000 } : {}),
      },
    })
  }
  // Hottest last: drawn on top of the cooler blobs around it. Ids are the
  // order, for the occlusion feature-state.
  out.sort((a, b) => (a.properties!.d as number) - (b.properties!.d as number))
  for (let i = 0; i < out.length; i++) out[i]!.id = i
  return out
}

class HeatLayer {
  private installed = false
  private visible = true
  private opacity = 0.85
  private latest: GeoJSON.Feature<GeoJSON.Point>[] = []
  private lat: number | null = null
  private waitingForMoveEnd = false
  /** Theme token of a one-colour heat (several layers heated), null = ramp. */
  private tint: string | null = null
  /** What hides a cell from the camera (the markers' prisms). */
  private prisms: ReadonlyArray<OccluderPrism> = []
  /** One target per cell written, id = the feature id. */
  private targets: OccludableTarget[] = []
  private readonly occlusion = createOcclusionState()
  /** The source instance the `occluded` feature-state was written to. */
  private occludedSource: unknown = null
  readonly ids: ReturnType<typeof dlHeatmapIds>
  private readonly map: MapboxMapInstance

  constructor(map: MapboxMapInstance, configId: number) {
    this.map = map
    this.ids = dlHeatmapIds(configId)
  }

  write = (cells: GeoJSON.Feature<GeoJSON.Point>[]): void => {
    this.latest = cells
    this.flush()
  }

  private flush(): void {
    if (!this.installed || !mapAlive(this.map)) return
    if (isFocusFlying(this.map)) {
      if (!this.waitingForMoveEnd) {
        this.waitingForMoveEnd = true
        this.map.once('moveend', this.onMoveEnd)
      }
      return
    }
    const src = this.map.getSource(this.ids.source) as { setData?: (d: GeoJSON.FeatureCollection) => void } | undefined
    src?.setData?.({ type: 'FeatureCollection', features: this.latest })
    // The ids now name other cells: un-hide what the last write hid, then
    // test the new cells.
    this.targets = this.latest.map((f, i) => ({
      id: i,
      position: f.geometry.coordinates as [number, number],
      elevationM: Number(f.properties?.z) || 0,
    }))
    for (const id of resetOcclusionState(this.occlusion)) this.setOccluded(id, false)
    this.syncOcclusion()
    // Blob size is in metres, which depends on latitude: set it from the data.
    const first = this.latest[0]
    if (first) {
      const lat = Math.round((first.geometry.coordinates[1] as number) * 10) / 10
      if (lat !== this.lat && hasMapLayer(this.map, this.ids.layer)) {
        this.lat = lat
        this.map.setLayoutProperty(this.ids.layer, 'icon-size', blobSizeExpression(lat) as never)
      }
    }
  }

  private onMoveEnd = (): void => {
    this.waitingForMoveEnd = false
    this.flush()
  }

  /** The prisms a cell can hide behind (same list as the markers'). */
  setOccluders(prisms: ReadonlyArray<OccluderPrism>): void {
    if (prisms === this.prisms) return
    this.prisms = prisms
    this.syncOcclusion()
  }

  /** Every camera move: write `occluded` for the cells that flipped. */
  private syncOcclusion = (): void => {
    if (!this.installed || !this.visible || !mapAlive(this.map)) return
    const source = this.map.getSource(this.ids.source)
    if (!source) return
    // A re-created source (style swap) starts with no feature-state.
    if (source !== this.occludedSource) {
      this.occludedSource = source
      resetOcclusionState(this.occlusion)
    }
    const { entered, left } = updateOcclusion(this.map, this.targets, this.prisms, this.occlusion)
    for (const id of left) this.setOccluded(id, false)
    for (const id of entered) this.setOccluded(id, true)
  }

  private setOccluded(id: number, occluded: boolean): void {
    try {
      this.map.setFeatureState({ source: this.ids.source, id }, { occluded })
    } catch { /* source went away */ }
  }

  install(): void {
    const { map, ids } = this
    this.remove()
    map.addSource(ids.source, { type: 'geojson', data: EMPTY_FC })
    this.ensureImages()
    this.lat = null
    map.addLayer({
      id: ids.layer,
      type: 'symbol',
      source: ids.source,
      layout: {
        'icon-image': this.imageExpression() as never,
        'icon-size': blobSizeExpression(0) as never,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // Flat on the floor, scaling and tilting with the map.
        'icon-pitch-alignment': 'map',
        'icon-rotation-alignment': 'map',
        // Explicit z below; no auto-lift onto 3D content underneath.
        'symbol-z-elevate': false,
        visibility: this.visible ? 'visible' : 'none',
      },
      paint: {
        'icon-opacity': visibleOpacity(this.opacity, this.tint !== null) as never,
        'symbol-z-offset': ['coalesce', ['get', 'z'], 0] as never,
        // Seen through the room volume it lies in; walls in front of a
        // cell hide it through `occluded` (the analytic pass).
        'icon-occlusion-opacity': densityOpacity(this.opacity, this.tint !== null) as never,
      },
    })
    this.installed = true
    map.off('move', this.syncOcclusion)
    map.on('move', this.syncOcclusion)
    try {
      raiseDataLinkLayers(map)
    } catch { /* style not ready — the container's styledata pass catches up */ }
    this.flush()
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (this.installed && hasMapLayer(this.map, this.ids.layer)) {
      this.map.setLayoutProperty(this.ids.layer, 'visibility', visible ? 'visible' : 'none')
    }
    this.syncOcclusion()
  }

  /** Under visible points the heat is a little lighter. */
  setOpacity(opacity: number): void {
    this.opacity = opacity
    this.applyPaint()
  }

  /** One colour (several layers heated) or the ramp; applied in place, so
   *  the data written so far stays. */
  setTint(tint: string | null): void {
    if (tint === this.tint) return
    this.tint = tint
    if (!this.installed || !mapAlive(this.map) || !hasMapLayer(this.map, this.ids.layer)) return
    this.ensureImages()
    this.map.setLayoutProperty(this.ids.layer, 'icon-image', this.imageExpression() as never)
    this.applyPaint()
  }

  private applyPaint(): void {
    if (this.installed && hasMapLayer(this.map, this.ids.layer)) {
      const tinted = this.tint !== null
      this.map.setPaintProperty(this.ids.layer, 'icon-opacity', visibleOpacity(this.opacity, tinted) as never)
      this.map.setPaintProperty(this.ids.layer, 'icon-occlusion-opacity', densityOpacity(this.opacity, tinted) as never)
    }
  }

  /** The blob image ids this layer draws with (each plain and firm-edged). */
  private imageIds(): string[] {
    const plain = this.tint ? [`${TINT_PREFIX}${this.tint}`] : BLOB_TOKENS.map((_, n) => `${BLOB_PREFIX}${n}`)
    return plain.flatMap((id) => [id, id + EDGE_SUFFIX])
  }

  /** Cells trimmed at a face (they carry `s`) take the firm-edged image. */
  private imageExpression(): unknown {
    const pick = (suffix: string): unknown =>
      this.tint
        ? `${TINT_PREFIX}${this.tint}${suffix}`
        : ['step', ['get', 'd'], `${BLOB_PREFIX}0${suffix}`, 0.3, `${BLOB_PREFIX}1${suffix}`, 0.55, `${BLOB_PREFIX}2${suffix}`, 0.8, `${BLOB_PREFIX}3${suffix}`]
    return ['case', ['has', 's'], pick(EDGE_SUFFIX), pick('')]
  }

  /** Add the blob images this map is missing. */
  private ensureImages(): void {
    for (const id of this.imageIds()) {
      if (this.map.hasImage(id)) continue
      const img = drawBlobImage(id)
      if (img) this.map.addImage(id, img, { pixelRatio: PIXEL_RATIO })
    }
  }

  /** A basemap swap drops the images; the style asks for them again. */
  onImageMissing = (e: { id?: string }): void => {
    if (!e.id || this.map.hasImage(e.id)) return
    const img = drawBlobImage(e.id)
    if (img) this.map.addImage(e.id, img, { pixelRatio: PIXEL_RATIO })
  }

  /** Theme change: redraw the blobs in the new tokens (re-add, see map-dl-cluster-overlay). */
  retheme = (): void => {
    if (!mapAlive(this.map)) return
    try {
      for (const id of this.imageIds()) {
        if (!this.map.hasImage(id)) continue
        const img = drawBlobImage(id)
        if (!img) continue
        this.map.removeImage(id)
        this.map.addImage(id, img, { pixelRatio: PIXEL_RATIO })
      }
    } catch { /* style mid-swap */ }
  }

  private remove(): void {
    const { map, ids } = this
    if (hasMapLayer(map, ids.layer)) map.removeLayer(ids.layer)
    if (map.getSource(ids.source)) map.removeSource(ids.source)
  }

  teardown(): void {
    this.installed = false
    this.latest = []
    this.targets = []
    this.map.off('move', this.syncOcclusion)
    resetOcclusionState(this.occlusion)
    this.occludedSource = null
    if (this.waitingForMoveEnd) {
      this.map.off('moveend', this.onMoveEnd)
      this.waitingForMoveEnd = false
    }
    if (!mapAlive(this.map)) return
    try {
      this.remove()
    } catch { /* style swapping — nothing left to remove */ }
  }
}

const NO_CONFIG = -1
const NO_PRISMS: ReadonlyArray<OccluderPrism> = []

/** One config's heat layer while `enabled`; writes before the install land once it is in. */
export function useDlHeatmapLayer(
  map: MapboxMapInstance,
  configId: number | undefined,
  opts: {
    enabled: boolean
    visible: boolean
    pointsShown: boolean
    tint?: string | null
    /** What hides a cell from the camera: the markers' occluder prisms. */
    occluders?: ReadonlyArray<OccluderPrism>
  },
): { write: (cells: GeoJSON.Feature<GeoJSON.Point>[]) => void } {
  const { enabled, visible, pointsShown, tint = null, occluders = NO_PRISMS } = opts
  const layer = useMemo(() => new HeatLayer(map, configId ?? NO_CONFIG), [map, configId])

  useEffect(() => {
    if (!enabled || configId === undefined) return
    map.on('styleimagemissing', layer.onImageMissing)
    const detach = whenStyleLoaded(map, () => layer.install(), `[map-dl-heatmap:${configId}]`)
    const offTheme = subscribeThemeChanges(layer.retheme)
    return () => {
      detach()
      offTheme()
      map.off('styleimagemissing', layer.onImageMissing)
      layer.teardown()
    }
  }, [map, layer, enabled, configId])

  useEffect(() => {
    if (!enabled) return
    layer.setVisible(visible)
    layer.setOpacity(pointsShown ? 0.75 : 1)
    layer.setTint(tint)
    layer.setOccluders(occluders)
  }, [layer, enabled, visible, pointsShown, tint, occluders])

  return layer
}
