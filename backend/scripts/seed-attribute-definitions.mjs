// One-shot: insert the warehouse / logistics / inventory attribute
// catalog into the existing `attribute_definitions` table via the
// existing POST /api/v1/attribute-definitions REST endpoint. Run once
// per tenant. Idempotent-ish: re-running will 409/500 on duplicates due
// to the (tenant_id, scope, key) unique constraint — just delete the
// tenant's rows first if you want to re-run.
//
// Usage:
//   SGV_API_URL=http://localhost:8080 SGV_API_KEY=dev-api-key-change-in-production SGV_TENANT_ID=1 SGV_ZONE_ID=1 \
//     node backend/scripts/seed-attribute-definitions.mjs

const BASE = process.env.SGV_API_URL ?? 'http://localhost:8080'
const API_KEY = process.env.SGV_API_KEY ?? 'dev-api-key-change-in-production'
const TENANT_ID = process.env.SGV_TENANT_ID ?? '1'
// Warehouse (zone) the definitions are scoped to. NULL would mean
// tenant-shared; we scope per warehouse so two warehouses under the same
// tenant can have different catalogs.
const ZONE_ID = process.env.SGV_ZONE_ID ?? '1'

const defs = [
  // grid-cell: rack cells / bins / storage locations
  { scope: 'grid-cell', key: 'rack_id', label: 'Rack ID', type: 'text', description: 'Unique rack identifier (e.g. A-01-03)' },
  { scope: 'grid-cell', key: 'rack_type', label: 'Rack type', type: 'enum', enumValues: ['pallet_rack', 'drive_in', 'cantilever', 'flow_rack', 'mezzanine', 'shelving'] },
  { scope: 'grid-cell', key: 'sku', label: 'SKU', type: 'sku', description: 'Stock keeping unit' },
  { scope: 'grid-cell', key: 'barcode', label: 'Barcode', type: 'barcode' },
  { scope: 'grid-cell', key: 'quantity', label: 'Quantity on hand', type: 'quantity', description: 'Current units in the cell' },
  { scope: 'grid-cell', key: 'capacity', label: 'Capacity', type: 'integer', description: 'Max units the cell holds' },
  { scope: 'grid-cell', key: 'max_load_kg', label: 'Max load (kg)', type: 'measure', unit: 'kg' },
  { scope: 'grid-cell', key: 'status', label: 'Cell status', type: 'status', enumValues: ['empty', 'partial', 'full', 'blocked', 'damaged'] },
  { scope: 'grid-cell', key: 'abc_class', label: 'ABC class', type: 'enum', enumValues: ['A', 'B', 'C'], description: 'Pareto classification' },
  { scope: 'grid-cell', key: 'lot', label: 'Lot number', type: 'text' },
  { scope: 'grid-cell', key: 'batch', label: 'Batch number', type: 'text' },
  { scope: 'grid-cell', key: 'expiration_date', label: 'Expiration date', type: 'date' },
  { scope: 'grid-cell', key: 'reorder_point', label: 'Reorder point', type: 'integer' },
  { scope: 'grid-cell', key: 'temperature_zone', label: 'Temperature zone', type: 'enum', enumValues: ['ambient', 'refrigerated', 'frozen', 'hazmat', 'clean_room'] },
  { scope: 'grid-cell', key: 'hazmat_class', label: 'Hazmat class', type: 'text', description: 'UN class code' },
  { scope: 'grid-cell', key: 'last_counted_at', label: 'Last cycle count date', type: 'date' },

  // polygon: storage zones, dock areas, restricted areas
  { scope: 'polygon', key: 'zone_code', label: 'Zone code', type: 'text' },
  { scope: 'polygon', key: 'area_type', label: 'Area type', type: 'enum', enumValues: ['storage', 'dock', 'staging', 'picking', 'receiving', 'shipping', 'restricted', 'hazmat'] },
  { scope: 'polygon', key: 'capacity_sqm', label: 'Capacity (m²)', type: 'measure', unit: 'm²' },
  { scope: 'polygon', key: 'max_pallets', label: 'Max pallets', type: 'integer' },
  { scope: 'polygon', key: 'temperature_min', label: 'Min temperature', type: 'measure', unit: '°C' },
  { scope: 'polygon', key: 'temperature_max', label: 'Max temperature', type: 'measure', unit: '°C' },
  { scope: 'polygon', key: 'access_level', label: 'Access level', type: 'enum', enumValues: ['public', 'staff', 'restricted', 'authorized_only'] },
  { scope: 'polygon', key: 'fire_class', label: 'Fire class', type: 'enum', enumValues: ['A', 'B', 'C', 'D', 'E', 'F'] },
  { scope: 'polygon', key: 'dock_doors', label: 'Dock door count', type: 'integer' },

  // circle: sensor/camera coverage, hazard zones
  { scope: 'circle', key: 'device_type', label: 'Device type', type: 'enum', enumValues: ['sensor', 'camera', 'beacon', 'gateway', 'access_point'] },
  { scope: 'circle', key: 'sensor_kind', label: 'Sensor kind', type: 'enum', enumValues: ['temperature', 'humidity', 'motion', 'smoke', 'gas', 'contact', 'weight', 'proximity'] },
  { scope: 'circle', key: 'reading_type', label: 'Reading type', type: 'text' },
  { scope: 'circle', key: 'threshold_min', label: 'Threshold min', type: 'measure' },
  { scope: 'circle', key: 'threshold_max', label: 'Threshold max', type: 'measure' },
  { scope: 'circle', key: 'battery_pct', label: 'Battery %', type: 'integer' },
  { scope: 'circle', key: 'last_calibration', label: 'Last calibration date', type: 'date' },
  { scope: 'circle', key: 'status', label: 'Status', type: 'status' },

  // line: conveyors, aisles, paths, pick routes
  { scope: 'line', key: 'line_type', label: 'Line type', type: 'enum', enumValues: ['aisle', 'conveyor', 'path', 'pick_route', 'docking_line', 'fence'] },
  { scope: 'line', key: 'direction', label: 'Direction', type: 'enum', enumValues: ['one_way', 'two_way', 'reversible'] },
  { scope: 'line', key: 'max_speed_mps', label: 'Max speed', type: 'measure', unit: 'm/s' },
  { scope: 'line', key: 'capacity_per_min', label: 'Capacity / min', type: 'integer' },
  { scope: 'line', key: 'status', label: 'Status', type: 'status' },

  // marker: POIs, equipment anchors, workstation labels
  { scope: 'marker', key: 'marker_type', label: 'Marker type', type: 'enum', enumValues: ['workstation', 'dock_door', 'charging_station', 'first_aid', 'fire_extinguisher', 'office', 'restroom', 'entrance', 'exit'] },
  { scope: 'marker', key: 'location_code', label: 'Location code', type: 'text' },
  { scope: 'marker', key: 'equipment_id', label: 'Equipment ID', type: 'text' },
  { scope: 'marker', key: 'assigned_to', label: 'Assigned to', type: 'text', description: 'Operator id' },
  { scope: 'marker', key: 'status', label: 'Status', type: 'status' },

  // image: floor plans
  { scope: 'image', key: 'floor_number', label: 'Floor number', type: 'integer' },
  { scope: 'image', key: 'level_label', label: 'Level label', type: 'text' },
  { scope: 'image', key: 'area_sqm', label: 'Floor area (m²)', type: 'measure', unit: 'm²' },
  { scope: 'image', key: 'is_default_layer', label: 'Default layer', type: 'boolean' },
  { scope: 'image', key: 'cad_source', label: 'CAD source file', type: 'text' },

  // model: 3D equipment / fixtures
  { scope: 'model', key: 'model_type', label: 'Model type', type: 'enum', enumValues: ['forklift', 'conveyor', 'robot', 'shelf_unit', 'pallet', 'dock_door', 'HVAC', 'machine', 'vehicle'] },
  { scope: 'model', key: 'asset_class', label: 'Asset class', type: 'text' },
  { scope: 'model', key: 'manufacturer', label: 'Manufacturer', type: 'text' },
  { scope: 'model', key: 'model_number', label: 'Model number', type: 'text' },
  { scope: 'model', key: 'serial', label: 'Serial number', type: 'text' },
  { scope: 'model', key: 'equipment_id', label: 'Equipment ID', type: 'text', description: 'Links to maintenance system' },
  { scope: 'model', key: 'install_date', label: 'Install date', type: 'date' },
  { scope: 'model', key: 'power_kw', label: 'Power (kW)', type: 'measure', unit: 'kW' },
  { scope: 'model', key: 'voltage', label: 'Voltage', type: 'measure', unit: 'V' },
  { scope: 'model', key: 'fuel_type', label: 'Fuel type', type: 'enum', enumValues: ['electric', 'diesel', 'LPG', 'gas', 'hybrid', 'none'] },
  { scope: 'model', key: 'inspection_date', label: 'Last inspection date', type: 'date' },
  { scope: 'model', key: 'next_inspection_date', label: 'Next inspection date', type: 'date' },
  { scope: 'model', key: 'maintenance_status', label: 'Maintenance status', type: 'enum', enumValues: ['ok', 'needs_service', 'in_repair', 'decommissioned'] },
  { scope: 'model', key: 'capacity_kg', label: 'Load capacity (kg)', type: 'measure', unit: 'kg' },

  // text-label
  { scope: 'text-label', key: 'label_kind', label: 'Label kind', type: 'enum', enumValues: ['section', 'warning', 'info', 'directional', 'brand'] },
  { scope: 'text-label', key: 'font_size', label: 'Font size (pt)', type: 'integer' },
  { scope: 'text-label', key: 'language', label: 'Language code', type: 'text' },

  // stair
  { scope: 'stair', key: 'stair_type', label: 'Stair type', type: 'enum', enumValues: ['straight', 'L_shaped', 'U_shaped', 'spiral', 'escalator', 'emergency'] },
  { scope: 'stair', key: 'direction', label: 'Direction', type: 'enum', enumValues: ['up', 'down', 'both'] },
  { scope: 'stair', key: 'floor_from', label: 'From floor', type: 'integer' },
  { scope: 'stair', key: 'floor_to', label: 'To floor', type: 'integer' },
  { scope: 'stair', key: 'fire_exit', label: 'Fire exit', type: 'boolean' },

  // any: shared across all shapes, used by cross-scope style rules
  { scope: 'any', key: 'external_id', label: 'External ID', type: 'text', description: 'ERP / WMS reference' },
  { scope: 'any', key: 'owner', label: 'Owner', type: 'text' },
  { scope: 'any', key: 'project', label: 'Project code', type: 'text' },
  { scope: 'any', key: 'notes', label: 'Notes', type: 'longText' },
  { scope: 'any', key: 'tags', label: 'Tags', type: 'tags' },
]

async function create(def) {
  const res = await fetch(`${BASE}/api/v1/attribute-definitions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': TENANT_ID,
      'X-Api-Key': API_KEY,
    },
    body: JSON.stringify({ ...def, zoneId: Number(ZONE_ID) }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status} for ${def.scope}/${def.key}: ${text}`)
  }
  return res.json()
}

const created = []
const failed = []
for (const def of defs) {
  try {
    const row = await create(def)
    created.push(`${def.scope}/${def.key}#${row.id}`)
  } catch (err) {
    failed.push({ def, err: err.message })
  }
}

console.log(`Inserted ${created.length}/${defs.length} rows for tenant ${TENANT_ID}, zone ${ZONE_ID}`)
if (failed.length > 0) {
  console.log('Failures:')
  for (const f of failed) console.log(`  ${f.def.scope}/${f.def.key}: ${f.err}`)
  process.exit(1)
}