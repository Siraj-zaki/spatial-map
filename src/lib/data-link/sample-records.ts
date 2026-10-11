/**
 * Sample record catalogue used by the "Download sample" menu on the
 * Integrations page + Import dialog.
 *
 * For every `DataSourceEntityKind` we ship:
 *   - `fields`     : column list with type / required / description
 *   - `records`    : 5-6 realistic rows demonstrating create + upsert +
 *                    custom-property mapping
 *   - `geometry`   : per-kind GeoJSON geometry hint (Point / Polygon /
 *                    null when the kind is non-spatial)
 *   - `formats`    : which formats make sense for the kind (streaming
 *                    excludes GeoJSON, polygon includes it, etc.)
 *
 * Upsert semantics: rows 1 + 2 share the same `external_code` so users
 * can see how re-importing overwrites the previous state. Rows 3-5 are
 * unique creates. The last row uses a `custom.<key>` column so users
 * see how the `prop.*` mapping works.
 *
 * Coordinates cluster around Amsterdam Schiphol (52.31°N, 4.76°E) — a
 * real logistics hub — so previews render in a recognisable spot on
 * the map when a user imports the sample and drops it on a shared demo.
 */

import type { DataSourceEntityKind } from '@/lib/db'

export type SampleFieldType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'latitude'
  | 'longitude'
  | 'enum'

export interface SampleFieldDef {
  /** Column name as it appears in the header row. Matches
   *  `validateColumnsForKind()` in entity-kind-picker.tsx. */
  name: string
  type: SampleFieldType
  required?: boolean
  recommended?: boolean
  /** One-line explanation shown in the JSON `$schema` block + XLSX
   *  second sheet + inline HTML tooltip on the picker. */
  description: string
  /** Comma-separated allowed values when `type === 'enum'`. */
  enumValues?: readonly string[]
}

/** A raw sample row. Values are strings/numbers/nulls only — no
 *  arrays/objects. Custom-property columns follow the `custom.<key>`
 *  naming convention so `suggestFieldTarget()` maps them to `prop.<key>`. */
export type SampleRecord = Record<string, string | number | null>

export type SampleFormat = 'csv' | 'xlsx' | 'json' | 'geojson'

export interface SampleSpec {
  kind: DataSourceEntityKind
  /** Human-friendly one-liner shown as the download-menu heading. */
  headline: string
  fields: readonly SampleFieldDef[]
  records: readonly SampleRecord[]
  /** GeoJSON geometry type for each record (or null when the kind
   *  can't be represented as a GeoJSON feature). */
  geometry: 'Point' | 'Polygon' | null
  /** Format list to expose in the download menu. */
  formats: readonly SampleFormat[]
  /**
   * Optional filename stem override — used by the augmentation layer
   * to tag files with the target warehouse slug so the download name
   * reads `sgv-sample-hospital-marker.csv` instead of the generic form.
   */
  filenameStem?: string
}

// ------------------------------------------------------------ constants

// Warehouse baseline (Schiphol logistics park). All sample points sit
// within ~200 m of here so a batch import lands as a legible cluster.
const BASE_LNG = 4.7602
const BASE_LAT = 52.3086

/** Nudge a coord by `metres` — rough conversion, sufficient for demo data. */
function offsetLng(metres: number): number {
  // 1 metre ≈ 1.463e-5° lng at lat 52
  return +(BASE_LNG + metres * 1.463e-5).toFixed(6)
}
function offsetLat(metres: number): number {
  // 1 metre ≈ 8.983e-6° lat
  return +(BASE_LAT + metres * 8.983e-6).toFixed(6)
}

// Timestamps: freeze at 2026-07-20T14:00Z, step by minute so events read
// left-to-right in ascending order — matches `mergeMode: 'append'` UX.
const T = (offsetMin: number): string =>
  new Date(Date.UTC(2026, 6, 20, 14, offsetMin, 0)).toISOString()

// ------------------------------------------------------------- catalogue

const POLYGON: SampleSpec = {
  kind: 'polygon',
  headline: 'Rooms / zones — one row per named area',
  geometry: 'Polygon',
  formats: ['csv', 'xlsx', 'json', 'geojson'],
  fields: [
    { name: 'external_code', type: 'string', required: true, description: 'Unique stable id for this room/zone. Re-importing with the same code overwrites the previous row.' },
    { name: 'linked_shape_name', type: 'string', recommended: true, description: 'Name of the polygon shape on the map to attach to (case-insensitive).' },
    { name: 'availability', type: 'enum', recommended: true, description: 'Room availability status.', enumValues: ['available', 'occupied', 'reserved', 'maintenance'] },
    { name: 'department', type: 'string', recommended: true, description: 'Owning department. Renders in tooltips.' },
    { name: 'notes', type: 'string', recommended: true, description: 'Free-text notes.' },
    { name: 'custom.temperature_c', type: 'number', description: 'Custom property example — anything under `custom.*` maps to `prop.*` at import.' },
  ],
  records: [
    { external_code: 'RM-101', linked_shape_name: 'Room 101', availability: 'available', department: 'Emergency', notes: 'Ground floor triage bay', 'custom.temperature_c': 21.4 },
    { external_code: 'RM-101', linked_shape_name: 'Room 101', availability: 'occupied', department: 'Emergency', notes: 'Patient in bay 2', 'custom.temperature_c': 21.6 },
    { external_code: 'RM-102', linked_shape_name: 'Room 102', availability: 'reserved', department: 'Radiology', notes: 'MRI scheduled 15:00', 'custom.temperature_c': 20.1 },
    { external_code: 'RM-201', linked_shape_name: 'Room 201', availability: 'available', department: 'Surgery', notes: null, 'custom.temperature_c': 19.8 },
    { external_code: 'RM-202', linked_shape_name: 'Room 202', availability: 'maintenance', department: 'Surgery', notes: 'HVAC service until 16:00', 'custom.temperature_c': null },
  ],
}

const CIRCLE: SampleSpec = {
  kind: 'circle',
  headline: 'Circular regions — wash-down zones, exclusion areas',
  geometry: 'Point', // circles export as Point + a `radius_m` prop; standard GeoJSON has no Circle
  formats: ['csv', 'xlsx', 'json', 'geojson'],
  fields: [
    { name: 'external_code', type: 'string', required: true, description: 'Unique stable id. Upsert key on re-import.' },
    { name: 'linked_shape_name', type: 'string', recommended: true, description: 'Name of the circle shape on the map to attach to.' },
    { name: 'lng', type: 'longitude', recommended: true, description: 'Optional centre longitude — only used when the linked shape name misses.' },
    { name: 'lat', type: 'latitude', recommended: true, description: 'Optional centre latitude.' },
    { name: 'radius_m', type: 'number', recommended: true, description: 'Radius in metres. GeoJSON output stamps this as a feature property.' },
    { name: 'notes', type: 'string', recommended: true, description: 'Free-text notes.' },
    { name: 'custom.hazard_level', type: 'string', description: 'Custom property — e.g. low/medium/high.' },
  ],
  records: [
    { external_code: 'WASH-A', linked_shape_name: 'Wash Bay A', lng: offsetLng(0), lat: offsetLat(0), radius_m: 4.0, notes: 'Chemical wash-down', 'custom.hazard_level': 'medium' },
    { external_code: 'WASH-A', linked_shape_name: 'Wash Bay A', lng: offsetLng(0), lat: offsetLat(0), radius_m: 4.0, notes: 'Chemical wash-down — inspected', 'custom.hazard_level': 'medium' },
    { external_code: 'WASH-B', linked_shape_name: 'Wash Bay B', lng: offsetLng(20), lat: offsetLat(0), radius_m: 3.5, notes: null, 'custom.hazard_level': 'low' },
    { external_code: 'EVAC-1', linked_shape_name: 'Evac Point 1', lng: offsetLng(-30), lat: offsetLat(40), radius_m: 6.0, notes: 'Muster area', 'custom.hazard_level': null },
    { external_code: 'DNZ-01', linked_shape_name: 'Drone No-Fly', lng: offsetLng(60), lat: offsetLat(60), radius_m: 12.0, notes: 'Restricted airspace', 'custom.hazard_level': 'high' },
  ],
}

const MARKER: SampleSpec = {
  kind: 'marker',
  headline: 'Points of interest — one row per marker',
  geometry: 'Point',
  formats: ['csv', 'xlsx', 'json', 'geojson'],
  fields: [
    { name: 'external_code', type: 'string', required: true, description: 'Unique stable id. Upsert key on re-import.' },
    { name: 'lng', type: 'longitude', recommended: true, description: 'Longitude (WGS84). GeoJSON puts this first in the coord pair.' },
    { name: 'lat', type: 'latitude', recommended: true, description: 'Latitude (WGS84).' },
    { name: 'linked_shape_name', type: 'string', recommended: true, description: 'Optional — name of an existing marker to bind to instead of spawning.' },
    { name: 'role', type: 'string', recommended: true, description: 'Marker role (e.g. pick_station, forklift_bay).' },
    { name: 'marker_state', type: 'enum', recommended: true, description: 'Current state.', enumValues: ['ok', 'warning', 'error', 'offline'] },
    { name: 'label', type: 'string', description: 'Text label shown on the marker.' },
    { name: 'custom.floor', type: 'string', description: 'Custom property — floor id / name.' },
  ],
  records: [
    { external_code: 'MK-001', lng: offsetLng(10), lat: offsetLat(10), linked_shape_name: null, role: 'pick_station', marker_state: 'ok', label: 'Pick 1', 'custom.floor': 'G' },
    { external_code: 'MK-001', lng: offsetLng(10), lat: offsetLat(10), linked_shape_name: null, role: 'pick_station', marker_state: 'warning', label: 'Pick 1 (SLA breach)', 'custom.floor': 'G' },
    { external_code: 'MK-002', lng: offsetLng(25), lat: offsetLat(15), linked_shape_name: null, role: 'forklift_bay', marker_state: 'ok', label: 'Bay 2', 'custom.floor': 'G' },
    { external_code: 'MK-003', lng: offsetLng(-15), lat: offsetLat(30), linked_shape_name: null, role: 'reception', marker_state: 'ok', label: 'Reception', 'custom.floor': 'G' },
    { external_code: 'MK-004', lng: offsetLng(40), lat: offsetLat(-20), linked_shape_name: null, role: 'emergency_exit', marker_state: 'ok', label: 'Exit E', 'custom.floor': '1' },
  ],
}

const ASSET: SampleSpec = {
  kind: 'asset',
  headline: 'Mobile equipment — position + operational status',
  geometry: 'Point',
  formats: ['csv', 'xlsx', 'json', 'geojson'],
  fields: [
    { name: 'external_code', type: 'string', required: true, description: 'Unique asset id. Upsert key.' },
    { name: 'lng', type: 'longitude', recommended: true, description: 'Last-known longitude.' },
    { name: 'lat', type: 'latitude', recommended: true, description: 'Last-known latitude.' },
    { name: 'op_status', type: 'enum', recommended: true, description: 'Operational status.', enumValues: ['active', 'idle', 'charging', 'maintenance', 'offline'] },
    { name: 'sku', type: 'string', recommended: true, description: 'Equipment type / SKU.' },
    { name: 'notes', type: 'string', recommended: true, description: 'Free-text notes.' },
    { name: 'ts', type: 'timestamp', description: 'When this state was reported (RFC 3339).' },
    { name: 'custom.battery_pct', type: 'number', description: 'Custom property — battery percentage.' },
  ],
  records: [
    { external_code: 'FLT-01', lng: offsetLng(5), lat: offsetLat(5), op_status: 'active', sku: 'Toyota-8FBE20', notes: 'Aisle A', ts: T(0), 'custom.battery_pct': 82 },
    { external_code: 'FLT-01', lng: offsetLng(12), lat: offsetLat(8), op_status: 'active', sku: 'Toyota-8FBE20', notes: 'Aisle A', ts: T(1), 'custom.battery_pct': 81 },
    { external_code: 'FLT-02', lng: offsetLng(-10), lat: offsetLat(20), op_status: 'charging', sku: 'Crown-RC5500', notes: 'Charging bay 3', ts: T(0), 'custom.battery_pct': 34 },
    { external_code: 'AGV-11', lng: offsetLng(35), lat: offsetLat(-5), op_status: 'idle', sku: 'MiR-250', notes: null, ts: T(0), 'custom.battery_pct': 91 },
    { external_code: 'AGV-12', lng: offsetLng(55), lat: offsetLat(-25), op_status: 'maintenance', sku: 'MiR-250', notes: 'Scheduled service', ts: T(0), 'custom.battery_pct': null },
  ],
}

const CAMERA: SampleSpec = {
  kind: 'camera',
  headline: 'Fixed cameras — pose + field-of-view for FOV cones',
  geometry: 'Point',
  formats: ['csv', 'xlsx', 'json', 'geojson'],
  fields: [
    { name: 'external_code', type: 'string', required: true, description: 'Unique camera id. Upsert key.' },
    { name: 'lng', type: 'longitude', recommended: true, description: 'Mount longitude.' },
    { name: 'lat', type: 'latitude', recommended: true, description: 'Mount latitude.' },
    { name: 'yaw', type: 'number', required: true, description: 'Compass bearing in degrees, 0 = north, 90 = east.' },
    { name: 'fov_deg', type: 'number', required: true, description: 'Horizontal field of view in degrees (0–360).' },
    { name: 'view_distance_m', type: 'number', required: true, description: 'Effective view distance in metres — drives the FOV cone length.' },
    { name: 'link_status', type: 'enum', recommended: true, description: 'Camera health.', enumValues: ['online', 'offline', 'error'] },
    { name: 'linked_shape_name', type: 'string', recommended: true, description: 'Optional — name of a marker/shape to bind to instead of using lng/lat.' },
    { name: 'stream_url', type: 'string', recommended: true, description: 'RTSP or HLS URL for the live feed.' },
    { name: 'custom.model', type: 'string', description: 'Custom property — hardware model.' },
  ],
  records: [
    { external_code: 'CAM-01', lng: offsetLng(0), lat: offsetLat(0), yaw: 45, fov_deg: 90, view_distance_m: 25, link_status: 'online', linked_shape_name: null, stream_url: 'rtsp://cam-01.local/stream', 'custom.model': 'Axis P1448-LE' },
    { external_code: 'CAM-01', lng: offsetLng(0), lat: offsetLat(0), yaw: 45, fov_deg: 90, view_distance_m: 25, link_status: 'offline', linked_shape_name: null, stream_url: 'rtsp://cam-01.local/stream', 'custom.model': 'Axis P1448-LE' },
    { external_code: 'CAM-02', lng: offsetLng(30), lat: offsetLat(0), yaw: 180, fov_deg: 60, view_distance_m: 40, link_status: 'online', linked_shape_name: null, stream_url: 'rtsp://cam-02.local/stream', 'custom.model': 'Axis P1448-LE' },
    { external_code: 'CAM-03', lng: offsetLng(-30), lat: offsetLat(30), yaw: 270, fov_deg: 110, view_distance_m: 20, link_status: 'online', linked_shape_name: null, stream_url: 'rtsp://cam-03.local/stream', 'custom.model': 'Hikvision DS-2CD' },
    { external_code: 'CAM-04', lng: offsetLng(60), lat: offsetLat(60), yaw: 315, fov_deg: 75, view_distance_m: 30, link_status: 'error', linked_shape_name: null, stream_url: 'rtsp://cam-04.local/stream', 'custom.model': 'Hikvision DS-2CD' },
  ],
}

const SENSOR: SampleSpec = {
  kind: 'sensor',
  headline: 'Fixed sensors — value + unit + optional threshold band',
  geometry: 'Point',
  formats: ['csv', 'xlsx', 'json', 'geojson'],
  fields: [
    { name: 'external_code', type: 'string', required: true, description: 'Unique sensor id.' },
    { name: 'kind', type: 'enum', required: true, description: 'Sensor kind.', enumValues: ['temperature', 'humidity', 'pressure', 'co2', 'motion', 'door', 'noise', 'vibration', 'power'] },
    { name: 'unit', type: 'string', required: true, description: 'SI or common unit (°C, %RH, ppm, dBA, Pa, kWh…).' },
    { name: 'value', type: 'number', recommended: true, description: 'Most recent reading.' },
    { name: 'threshold_min', type: 'number', recommended: true, description: 'Alert if value < min.' },
    { name: 'threshold_max', type: 'number', recommended: true, description: 'Alert if value > max.' },
    { name: 'health_status', type: 'enum', recommended: true, description: 'Sensor self-report.', enumValues: ['ok', 'warning', 'error', 'offline'] },
    { name: 'linked_shape_name', type: 'string', recommended: true, description: 'Optional — name of a shape to bind the sensor to.' },
    { name: 'lng', type: 'longitude', description: 'Longitude when the sensor has a fixed geo pose.' },
    { name: 'lat', type: 'latitude', description: 'Latitude.' },
    { name: 'ts', type: 'timestamp', description: 'Reading timestamp (RFC 3339).' },
    { name: 'custom.zone', type: 'string', description: 'Custom property — physical zone tag.' },
  ],
  records: [
    { external_code: 'TEMP-COLD-01', kind: 'temperature', unit: '°C', value: -18.3, threshold_min: -22, threshold_max: -16, health_status: 'ok', linked_shape_name: 'Cold Room 1', lng: offsetLng(10), lat: offsetLat(-10), ts: T(0), 'custom.zone': 'cold-storage' },
    { external_code: 'TEMP-COLD-01', kind: 'temperature', unit: '°C', value: -15.9, threshold_min: -22, threshold_max: -16, health_status: 'warning', linked_shape_name: 'Cold Room 1', lng: offsetLng(10), lat: offsetLat(-10), ts: T(5), 'custom.zone': 'cold-storage' },
    { external_code: 'HUM-DOCK-02', kind: 'humidity', unit: '%RH', value: 62, threshold_min: 30, threshold_max: 80, health_status: 'ok', linked_shape_name: 'Dock 2', lng: offsetLng(40), lat: offsetLat(-20), ts: T(0), 'custom.zone': 'inbound' },
    { external_code: 'CO2-OFFICE', kind: 'co2', unit: 'ppm', value: 780, threshold_min: 0, threshold_max: 1000, health_status: 'ok', linked_shape_name: 'Office A', lng: offsetLng(-40), lat: offsetLat(40), ts: T(0), 'custom.zone': 'admin' },
    { external_code: 'VIB-CONV-05', kind: 'vibration', unit: 'mm/s', value: 3.1, threshold_min: 0, threshold_max: 4.5, health_status: 'ok', linked_shape_name: 'Conveyor 5', lng: offsetLng(20), lat: offsetLat(20), ts: T(0), 'custom.zone': 'sortation' },
  ],
}

const SHIPMENT: SampleSpec = {
  kind: 'shipment',
  headline: 'Inbound/outbound freight — state-machine rows',
  geometry: 'Point',
  formats: ['csv', 'xlsx', 'json', 'geojson'],
  fields: [
    { name: 'external_code', type: 'string', required: true, description: 'Shipment tracking id / ASN #.' },
    { name: 'state', type: 'enum', required: true, description: 'Current state.', enumValues: ['booked', 'in_transit', 'arrived', 'unloading', 'received', 'shipped', 'delivered', 'cancelled', 'exception'] },
    { name: 'carrier', type: 'string', recommended: true, description: 'Carrier / 3PL.' },
    { name: 'eta_at', type: 'timestamp', recommended: true, description: 'ETA (RFC 3339).' },
    { name: 'linked_shape_name', type: 'string', recommended: true, description: 'Optional — dock door / bay to bind to.' },
    { name: 'lng', type: 'longitude', description: 'Optional — current position for in_transit.' },
    { name: 'lat', type: 'latitude', description: 'Optional — current position.' },
    { name: 'custom.pallets', type: 'integer', description: 'Custom property — pallet count.' },
  ],
  records: [
    { external_code: 'SHIP-2026-0710', state: 'in_transit', carrier: 'DHL', eta_at: T(120), linked_shape_name: 'Dock 3', lng: offsetLng(80), lat: offsetLat(-80), 'custom.pallets': 22 },
    { external_code: 'SHIP-2026-0710', state: 'arrived', carrier: 'DHL', eta_at: T(120), linked_shape_name: 'Dock 3', lng: offsetLng(30), lat: offsetLat(-20), 'custom.pallets': 22 },
    { external_code: 'SHIP-2026-0710', state: 'received', carrier: 'DHL', eta_at: T(120), linked_shape_name: 'Dock 3', lng: null, lat: null, 'custom.pallets': 22 },
    { external_code: 'SHIP-2026-0711', state: 'booked', carrier: 'Fedex', eta_at: T(240), linked_shape_name: 'Dock 4', lng: null, lat: null, 'custom.pallets': 8 },
    { external_code: 'SHIP-2026-0712', state: 'exception', carrier: 'UPS', eta_at: T(90), linked_shape_name: 'Dock 5', lng: offsetLng(120), lat: offsetLat(-120), 'custom.pallets': 14 },
  ],
}

const RFID_TAG: SampleSpec = {
  kind: 'rfid-tag',
  headline: 'RFID reads — one row per position/state update',
  geometry: 'Point',
  formats: ['csv', 'xlsx', 'json', 'geojson'],
  fields: [
    { name: 'external_code', type: 'string', required: true, description: 'EPC / tag id.' },
    { name: 'lng', type: 'longitude', recommended: true, description: 'Estimated longitude at time of read.' },
    { name: 'lat', type: 'latitude', recommended: true, description: 'Estimated latitude.' },
    { name: 'tag_state', type: 'enum', recommended: true, description: 'Tag movement state.', enumValues: ['stationary', 'moving', 'lost'] },
    { name: 'antenna_id', type: 'string', recommended: true, description: 'Reader antenna that produced the read.' },
    { name: 'rssi', type: 'integer', recommended: true, description: 'Signal strength (dBm, typically -30 to -90).' },
    { name: 'ts', type: 'timestamp', description: 'Read timestamp (RFC 3339).' },
    { name: 'custom.sku', type: 'string', description: 'Custom property — SKU carried by the tag.' },
  ],
  records: [
    { external_code: 'EPC-ABCD-0001', lng: offsetLng(0), lat: offsetLat(0), tag_state: 'stationary', antenna_id: 'A-01', rssi: -52, ts: T(0), 'custom.sku': 'SKU-8891' },
    { external_code: 'EPC-ABCD-0001', lng: offsetLng(2), lat: offsetLat(2), tag_state: 'moving', antenna_id: 'A-02', rssi: -58, ts: T(1), 'custom.sku': 'SKU-8891' },
    { external_code: 'EPC-ABCD-0002', lng: offsetLng(10), lat: offsetLat(-5), tag_state: 'stationary', antenna_id: 'A-01', rssi: -49, ts: T(0), 'custom.sku': 'SKU-2201' },
    { external_code: 'EPC-ABCD-0003', lng: offsetLng(-8), lat: offsetLat(12), tag_state: 'moving', antenna_id: 'A-03', rssi: -70, ts: T(0), 'custom.sku': 'SKU-1030' },
    { external_code: 'EPC-ABCD-0004', lng: null, lat: null, tag_state: 'lost', antenna_id: 'A-04', rssi: -90, ts: T(0), 'custom.sku': 'SKU-7742' },
  ],
}

const RACK_CELL: SampleSpec = {
  kind: 'rack-cell',
  headline: 'WMS rack cells — writes to bins table (legacy path)',
  geometry: null,
  formats: ['csv', 'xlsx', 'json'],
  fields: [
    { name: 'external_code', type: 'string', required: true, description: 'Bin external code (unique per zone).' },
    { name: 'sku', type: 'string', recommended: true, description: 'SKU stored in this bin.' },
    { name: 'capacity', type: 'integer', recommended: true, description: 'Max units the bin can hold.' },
    { name: 'status', type: 'enum', recommended: true, description: 'Bin status.', enumValues: ['empty', 'partial', 'full', 'blocked', 'picking', 'reserved'] },
    { name: 'notes', type: 'string', recommended: true, description: 'Free-text notes.' },
    { name: 'grid_name', type: 'string', description: 'Alternative to external_code — name of the grid the cell belongs to.' },
    { name: 'row', type: 'integer', description: 'Row index within the grid (used with grid_name).' },
    { name: 'col', type: 'integer', description: 'Column index within the grid.' },
    { name: 'level', type: 'integer', description: 'Level index (0 = ground).' },
    { name: 'custom.lot', type: 'string', description: 'Custom property — lot number.' },
  ],
  records: [
    { external_code: 'A-01-01-L0', sku: 'SKU-8891', capacity: 12, status: 'full', notes: null, grid_name: null, row: null, col: null, level: null, 'custom.lot': 'LOT-2026-07-15' },
    { external_code: 'A-01-01-L0', sku: 'SKU-8891', capacity: 12, status: 'picking', notes: 'Reserved for order 12345', grid_name: null, row: null, col: null, level: null, 'custom.lot': 'LOT-2026-07-15' },
    { external_code: 'A-01-01-L1', sku: 'SKU-2201', capacity: 12, status: 'partial', notes: null, grid_name: null, row: null, col: null, level: null, 'custom.lot': 'LOT-2026-07-14' },
    // Alternative addressing — grid_name + row/col instead of external_code
    { external_code: null, sku: 'SKU-1030', capacity: 8, status: 'empty', notes: null, grid_name: 'Aisle A', row: 2, col: 3, level: 0, 'custom.lot': null },
    { external_code: 'B-02-05-L0', sku: null, capacity: 12, status: 'blocked', notes: 'Damaged shelf', grid_name: null, row: null, col: null, level: null, 'custom.lot': null },
  ],
}

const STREAMING: SampleSpec = {
  kind: 'streaming',
  headline: 'Event log — one row per discrete event for correlation testing',
  geometry: 'Point',
  formats: ['csv', 'xlsx', 'json'],
  fields: [
    { name: 'external_code', type: 'string', required: true, description: 'Entity the event refers to (asset / tag / shipment id).' },
    { name: 'ts', type: 'timestamp', required: true, description: 'Event timestamp (RFC 3339).' },
    { name: 'event_type', type: 'string', recommended: true, description: 'Application-defined event type (motion_start, door_open, alarm_ack, …).' },
    { name: 'lng', type: 'longitude', recommended: true, description: 'Where the event happened (optional).' },
    { name: 'lat', type: 'latitude', recommended: true, description: 'Where the event happened.' },
    { name: 'severity', type: 'enum', recommended: true, description: 'Severity level.', enumValues: ['info', 'warning', 'error', 'critical'] },
    { name: 'message', type: 'string', description: 'Human-readable message.' },
    { name: 'custom.rule_id', type: 'string', description: 'Custom property — correlation rule that fired.' },
  ],
  records: [
    { external_code: 'FLT-01', ts: T(0), event_type: 'motion_start', lng: offsetLng(5), lat: offsetLat(5), severity: 'info', message: 'Forklift departed charging bay', 'custom.rule_id': null },
    { external_code: 'FLT-01', ts: T(1), event_type: 'zone_enter', lng: offsetLng(12), lat: offsetLat(8), severity: 'info', message: 'Entered Aisle A', 'custom.rule_id': null },
    { external_code: 'FLT-01', ts: T(2), event_type: 'speed_alert', lng: offsetLng(20), lat: offsetLat(8), severity: 'warning', message: 'Speed 8 km/h exceeded aisle limit 5 km/h', 'custom.rule_id': 'SPEED-AISLE' },
    { external_code: 'TEMP-COLD-01', ts: T(5), event_type: 'threshold_breach', lng: offsetLng(10), lat: offsetLat(-10), severity: 'critical', message: 'Temperature -15.9°C above max -16°C', 'custom.rule_id': 'COLD-BREACH' },
    { external_code: 'SHIP-2026-0710', ts: T(10), event_type: 'dock_arrival', lng: offsetLng(30), lat: offsetLat(-20), severity: 'info', message: 'Truck arrived at Dock 3', 'custom.rule_id': null },
  ],
}

// ---------------------------------------------------------- public API

export const SAMPLE_SPECS: Readonly<Record<DataSourceEntityKind, SampleSpec>> = {
  polygon: POLYGON,
  circle: CIRCLE,
  marker: MARKER,
  asset: ASSET,
  camera: CAMERA,
  sensor: SENSOR,
  shipment: SHIPMENT,
  'rfid-tag': RFID_TAG,
  'rack-cell': RACK_CELL,
  streaming: STREAMING,
}

/** Return the sample spec for a kind. Throws if the kind is unknown so
 *  a future new-kind is caught at development time. */
export function sampleSpecFor(kind: DataSourceEntityKind): SampleSpec {
  const spec = SAMPLE_SPECS[kind]
  if (!spec) throw new Error(`sample spec missing for kind: ${kind}`)
  return spec
}
