import type { Map as MapboxMapInstance } from 'mapbox-gl'
import { buildCircleFeatures } from './circle-generators'
import { type Grid } from './db'
import { apiDb } from './api-db'
import { saveSpatialEntity, useSpatialStore } from './spatial-store'
import { queryCache } from './useApiQuery'
import { buildGrid, type GridConfig } from './grid-generators'
import { buildImageFeature } from './image-generators'
import { buildLineFeature, lineLengthMeters } from './line-generators'
import { buildPolygonFeature } from './polygon-generators'
import type {
  CircleShape,
  ImageShape,
  LineShape,
  MarkerShape,
  PolygonShape,
} from './shapes'
import { copyName } from '@/lib/copy-name'

/**
 * Build the bbox from a grid's start/current points. The bbox is the
 * `[minLng, minLat, maxLng, maxLat]` regardless of which corner is start.
 */
export function gridBbox(grid: Grid): [number, number, number, number] {
  return [
    Math.min(grid.start[0], grid.current[0]),
    Math.min(grid.start[1], grid.current[1]),
    Math.max(grid.start[0], grid.current[0]),
    Math.max(grid.start[1], grid.current[1]),
  ]
}

/**
 * Build a FeatureCollection representing the cells of a grid. Used for
 * both on-screen rendering and GeoJSON export.
 */
export function gridToFeatureCollection(
  grid: Grid
): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  return buildGrid(gridBbox(grid), grid.config, grid.start, grid.id) as GeoJSON.FeatureCollection<GeoJSON.Polygon>
}

/**
 * Trigger a browser download of a Blob with the given filename.
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke after a short delay so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function safeFilename(name: string, ext: string): string {
  const base = (name || 'grid').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '')
  return `${base || 'grid'}.${ext}`
}

/**
 * Export one or more grids as a single GeoJSON FeatureCollection file.
 */
export function exportGridsAsGeoJSON(grids: Grid[]): void {
  if (grids.length === 0) return
  const features: GeoJSON.Feature[] = []
  for (const grid of grids) {
    const fc = gridToFeatureCollection(grid)
    for (const f of fc.features) {
      features.push({
        ...f,
        properties: {
          ...(f.properties ?? {}),
          gridName: grid.name,
          gridId: grid.id,
        },
      })
    }
  }
  const out: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/geo+json' })
  const filename =
    grids.length === 1
      ? safeFilename(grids[0].name, 'geojson')
      : `grids-${grids.length}-${Date.now()}.geojson`
  downloadBlob(blob, filename)
}

// ---- Multi-kind export ----------------------------------------------------

/**
 * Build features for a marker as a single Point feature carrying the
 * marker's name, bearing, and full config under `properties`.
 */
function markerToFeature(m: MarkerShape): GeoJSON.Feature<GeoJSON.Point> {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: m.position },
    properties: {
      kind: 'marker',
      shapeId: m.id,
      name: m.name,
      unit: m.unit,
      zoneId: m.zoneId,
      bearing: m.bearing,
      visible: m.visible,
      config: m.config,
    },
  }
}

/**
 * Build features for a circle. Single-mode produces one Polygon; grid
 * mode produces N polygons (one per cell). Each feature carries the
 * parent circle's name + config + mode under `properties`.
 */
function circleToFeatures(c: CircleShape): GeoJSON.Feature<GeoJSON.Polygon>[] {
  const features = buildCircleFeatures(c)
  return features.map((f) => ({
    ...f,
    properties: {
      ...(f.properties ?? {}),
      kind: 'circle',
      circleMode: c.mode,
      name: c.name,
      unit: c.unit,
      zoneId: c.zoneId,
      rotation: c.rotation,
      config: c.config,
      // single-mode geometry
      center: c.center,
      radius: c.radius,
      // grid-mode geometry
      gridStart: c.start,
      gridCurrent: c.current,
      cellSize: c.cellSize,
      cellRadius: c.cellRadius,
    },
  }))
}

function polygonToFeature(
  p: PolygonShape
): GeoJSON.Feature<GeoJSON.Polygon> | null {
  const f = buildPolygonFeature(p)
  if (!f) return null
  return {
    ...f,
    properties: {
      ...(f.properties ?? {}),
      kind: 'polygon',
      name: p.name,
      unit: p.unit,
      zoneId: p.zoneId,
      rotation: p.rotation,
      vertices: p.vertices,
      config: p.config,
    },
  }
}

function imageToFeature(
  img: ImageShape
): GeoJSON.Feature<GeoJSON.Polygon> | null {
  const f = buildImageFeature(img)
  if (!f) return null
  return {
    type: 'Feature',
    geometry: f.geometry,
    properties: {
      ...(f.properties ?? {}),
      kind: 'image',
      name: img.name,
      unit: img.unit,
      zoneId: img.zoneId,
      visible: img.visible,
      start: img.start,
      current: img.current,
      rotation: img.rotation,
      mimeType: img.mimeType,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      config: img.config,
    },
  }
}

function lineToFeature(
  ln: LineShape
): GeoJSON.Feature<GeoJSON.LineString> | null {
  const f = buildLineFeature(ln)
  if (!f) return null
  return {
    ...f,
    properties: {
      ...(f.properties ?? {}),
      kind: 'line',
      name: ln.name,
      unit: ln.unit,
      zoneId: ln.zoneId,
      rotation: ln.rotation,
      vertices: ln.vertices,
      lengthMeters: lineLengthMeters(ln.vertices),
      config: ln.config,
    },
  }
}

/**
 * Export every shape kind (grids + markers + circles + polygons + lines)
 * to a single GeoJSON FeatureCollection. Each feature carries a `kind`
 * discriminator under `properties` so a downstream importer can route
 * back to the correct shape table.
 *
 * The arguments are independent — passing empty arrays for kinds you
 * don't want included is fine.
 */
export function exportAllShapesAsGeoJSON(args: {
  grids?: ReadonlyArray<Grid>
  markers?: ReadonlyArray<MarkerShape>
  circles?: ReadonlyArray<CircleShape>
  polygons?: ReadonlyArray<PolygonShape>
  lines?: ReadonlyArray<LineShape>
  images?: ReadonlyArray<ImageShape>
  filename?: string
}): void {
  const features: GeoJSON.Feature[] = []
  for (const g of args.grids ?? []) {
    const fc = gridToFeatureCollection(g)
    for (const f of fc.features) {
      features.push({
        ...f,
        properties: {
          ...(f.properties ?? {}),
          kind: 'grid',
          gridName: g.name,
          gridId: g.id,
          unit: g.config.unit,
          zoneId: g.zoneId,
          start: g.start,
          current: g.current,
          // The grid's `config` already lives on the cell properties via
          // `buildGrid`, but stamp it again so an importer that wants
          // the *whole* config in one place can find it.
          gridConfig: g.config,
        },
      })
    }
  }
  for (const m of args.markers ?? []) features.push(markerToFeature(m))
  for (const c of args.circles ?? []) features.push(...circleToFeatures(c))
  for (const p of args.polygons ?? []) {
    const f = polygonToFeature(p)
    if (f) features.push(f)
  }
  for (const ln of args.lines ?? []) {
    const f = lineToFeature(ln)
    if (f) features.push(f)
  }
  for (const img of args.images ?? []) {
    const f = imageToFeature(img)
    if (f) features.push(f)
  }
  if (features.length === 0) return
  const out: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/geo+json' })
  const filename = args.filename ?? `shapes-${features.length}-${Date.now()}.geojson`
  downloadBlob(blob, filename)
}

/**
 * Export the current map viewport as a PNG file. Includes any basemap
 * imagery and overlay layers.
 */
export function exportMapAsPNG(map: MapboxMapInstance, name?: string): void {
  const canvas = map.getCanvas()
  const dataUrl = canvas.toDataURL('image/png')
  // Convert data URL to Blob for a more reliable download
  fetch(dataUrl)
    .then((res) => res.blob())
    .then((blob) => downloadBlob(blob, safeFilename(name ?? `map-${Date.now()}`, 'png')))
    .catch((err) => {
      console.warn('[export] PNG download failed', err)
    })
}

/**
 * Fit the map to the combined bounds of the given grids. Animates by default.
 */
export function fitMapToGrids(map: MapboxMapInstance, grids: Grid[]): void {
  if (grids.length === 0) return
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const g of grids) {
    const [w, s, e, n] = gridBbox(g)
    if (w < minLng) minLng = w
    if (s < minLat) minLat = s
    if (e > maxLng) maxLng = e
    if (n > maxLat) maxLat = n
  }
  if (!isFinite(minLng) || !isFinite(minLat)) return
  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding: 60, duration: 600, maxZoom: 18 }
  )
}

/**
 * Update a grid's config in the backend and reflect the saved row in the
 * local spatial store immediately. Without the store sync the UI would
 * keep showing the old config until the SSE invalidation arrives, which
 * the user sees as a brief "revert" right after Save.
 */
// Grid writes go through the spatial store: the map updates at once, the
// draft holds until the server confirms (no snap-back), and writes to the
// same rack never overlap. Each resolves once the save is confirmed.
export function updateGridConfig(id: number, config: GridConfig): Promise<void> {
  return saveSpatialEntity<Grid>('grids', id, { config })
}

export function updateGridGeometry(
  id: number,
  start: [number, number],
  current: [number, number]
): Promise<void> {
  return saveSpatialEntity<Grid>('grids', id, { start, current })
}

export function renameGrid(id: number, name: string): Promise<void> {
  return saveSpatialEntity<Grid>('grids', id, { name })
}

/**
 * Duplicate a grid (deep copy of all fields except id and timestamps).
 *
 * Two non-obvious details we have to get right:
 *
 * 1. `zoneId` is COPIED. The active-warehouse filter in the editor
 *    drops grids whose zone doesn't match the current scope — without
 *    this, the duplicate would land in IndexedDB but disappear from
 *    the saved-grids list, which reads as "Duplicate doesn't work".
 *
 * 2. The bbox is OFFSET one grid-width east. Otherwise the copy
 *    renders at the exact lng/lat of the source and is visually
 *    indistinguishable from it. One grid-width is the natural default
 *    for warehouse layouts where rows of racks sit side-by-side; the
 *    user can drag the copy elsewhere afterwards.
 *
 * Returns the new grid's id.
 */
export async function duplicateGrid(id: number): Promise<number | null> {
  const orig = await apiDb.grids.get(id)
  if (!orig) return null
  const widthLng = orig.current[0] - orig.start[0]
  // Tiny breathing-room gap (≈2% of the grid width) so the duplicate
  // doesn't share an edge with the source — easier to grab.
  const gap = widthLng * 0.02
  const shift = widthLng + gap
  const start: [number, number] = [orig.start[0] + shift, orig.start[1]]
  const current: [number, number] = [orig.current[0] + shift, orig.current[1]]
  const now = new Date()
  const newId = await apiDb.grids.add({
    name: copyName('grids', orig.name),
    start,
    current,
    config: { ...orig.config },
    zoneId: orig.zoneId,
    createdAt: now,
    updatedAt: now,
  })
  queryCache.invalidate('grids')
  return newId as number
}

/**
 * Apply a config change to many grids at once. Used by bulk-select.
 */
export async function applyConfigToGrids(
  ids: number[],
  config: GridConfig
): Promise<void> {
  const store = useSpatialStore.getState()
  store.updateManyLocal<Grid>('grids', ids.map((id) => [id, { config: { ...config } }] as const))
  await Promise.all(ids.map((id) => store.commit('grids', id)))
}

/**
 * Read a GeoJSON file and create one Grid row per Polygon / MultiPolygon
 * feature. Each imported grid uses the bounding box of the polygon as
 * its start/current points, with the default GridConfig (so it draws
 * square cells inside the polygon's footprint). Returns the IDs of the
 * newly-created grids. Throws on invalid input.
 */
export async function importGridsFromGeoJSONFile(
  file: File,
  fallbackName: string
): Promise<number[]> {
  const text = await file.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (cause) {
    throw new Error('File is not valid JSON', { cause })
  }
  return importGridsFromGeoJSON(json, fallbackName)
}

/**
 * Lower-level: import from a parsed GeoJSON object. Accepts a single
 * Feature, a FeatureCollection, or a bare Geometry. Filters to Polygon
 * / MultiPolygon features only.
 */
export async function importGridsFromGeoJSON(
  data: unknown,
  fallbackName: string
): Promise<number[]> {
  const features: GeoJSON.Feature[] = []
  if (!data || typeof data !== 'object') {
    throw new Error('GeoJSON root must be a Feature, FeatureCollection, or Geometry')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyData = data as any
  if (anyData.type === 'FeatureCollection' && Array.isArray(anyData.features)) {
    features.push(...anyData.features)
  } else if (anyData.type === 'Feature' && anyData.geometry) {
    features.push(anyData)
  } else if (
    anyData.type === 'Polygon' ||
    anyData.type === 'MultiPolygon'
  ) {
    features.push({ type: 'Feature', geometry: anyData, properties: {} })
  } else {
    throw new Error('Unsupported GeoJSON type')
  }
  const ids: number[] = []
  const now = new Date()
  let n = 0
  for (const f of features) {
    if (!f.geometry) continue
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue
    const bbox = geometryBbox(f.geometry)
    if (!bbox) continue
    const name =
      (f.properties && (f.properties.name || f.properties.title)) ||
      `${fallbackName} #${++n}`
    const newId = await apiDb.grids.add({
      name: String(name),
      start: [bbox[0], bbox[1]],
      current: [bbox[2], bbox[3]],
      config: defaultConfigForImport(),
      createdAt: now,
      updatedAt: now,
    })
    ids.push(newId as number)
  }
  queryCache.invalidate('grids')
  return ids
}

/** A small, sensible default config for freshly imported grids. */
function defaultConfigForImport(): GridConfig {
  return {
    type: 'square',
    xSize: 10,
    ySize: 10,
    cellGap: 0,
    unit: 'm',
    rotation: 0,
    color: '#6366f1',
    borderColor: '#4338ca',
    borderWidth: 1,
    opacity: 50,
    elevation: 0,
    height: 0,
    hexOrientation: 'pointy',
    showLabels: true,
    visible: true,
    labelStart: 1,
    labelDirection: 'x',
    labelPrefix: '',
    labelSize: 11,
    labelColor: '#000000',
    labelAltitude: 0,
    levels: 1,
    levelHeight: 1.5,
    levelGap: 0,
  }
}

/** Compute `[minLng, minLat, maxLng, maxLat]` for a Polygon or MultiPolygon. */
function geometryBbox(
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon
): [number, number, number, number] | null {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  const visit = (coord: GeoJSON.Position) => {
    const [lng, lat] = coord
    if (lng < minLng) minLng = lng
    if (lat < minLat) minLat = lat
    if (lng > maxLng) maxLng = lng
    if (lat > maxLat) maxLat = lat
  }
  const rings =
    geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat()
  for (const ring of rings) {
    for (const coord of ring) visit(coord)
  }
  if (!isFinite(minLng) || !isFinite(minLat)) return null
  return [minLng, minLat, maxLng, maxLat]
}
