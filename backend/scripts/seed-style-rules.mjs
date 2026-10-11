// One-shot: insert the default warehouse / logistics / inventory style
// rule catalog into the existing `style_rules` table via the existing
// POST /api/v1/style-rules endpoint. Run once per tenant.
//
// Rules are grid-cell scoped (rack cells / bins). The evaluator reads
// `custom.<key>` from `bin.customProperties` (mapped to the
// attribute_definitions seeded by seed-attribute-definitions.mjs) plus
// the built-in bin attrs (status, sku, capacity, ...).
//
// Priority is ascending — the first matching rule wins per target, so
// the most important signals (expired, blocked, hazmat) come first.
// Less critical rules (empty, ABC class) come later as visual fallbacks
// for cells where no high-signal attribute is set.
//
// Usage:
//   SGV_API_URL=http://localhost:8080 SGV_API_KEY=dev-api-key-change-in-production SGV_TENANT_ID=1 SGV_ZONE_ID=1 \
//     node backend/scripts/seed-style-rules.mjs

const BASE = process.env.SGV_API_URL ?? 'http://localhost:8080'
const API_KEY = process.env.SGV_API_KEY ?? 'dev-api-key-change-in-production'
const TENANT_ID = process.env.SGV_TENANT_ID ?? '1'
// Warehouse (zone) the rules are scoped to. Style rules already had a
// nullable zone_id column; we set it so the rule only fires inside this
// warehouse. NULL would mean tenant-wide.
const ZONE_ID = process.env.SGV_ZONE_ID ?? '1'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

const rules = [
  // --- Safety / compliance (highest priority) ---------------------------
  {
    name: 'Expired stock',
    scope: 'grid-cell',
    priority: 5,
    enabled: true,
    combine: 'and',
    conditions: [
      { type: 'attr', attribute: 'custom.expiration_date', op: 'olderThan', value: 0 },
    ],
    style: {
      fillColor: '#dc2626',
      fillOpacity: 95,
      borderColor: '#7f1d1d',
      borderWidth: 2,
      labelText: 'EXPIRED',
    },
  },
  {
    name: 'Expiring within 7 days',
    scope: 'grid-cell',
    priority: 15,
    enabled: true,
    combine: 'and',
    conditions: [
      // expiration_date is in the future (age < 0) ...
      { type: 'attr', attribute: 'custom.expiration_date', op: 'newerThan', value: 0 },
      // ... and not more than 7 days away (age > -7d). Combined with the
      // first condition this gives: 0 > age > -7d, i.e. date is within
      // the next 7 days.
      { type: 'attr', attribute: 'custom.expiration_date', op: 'olderThan', value: -SEVEN_DAYS_MS },
    ],
    style: {
      fillColor: '#f97316',
      fillOpacity: 85,
      borderColor: '#9a3412',
      borderWidth: 1,
      labelText: 'EXPIRES SOON',
    },
  },
  {
    name: 'Blocked or damaged cell',
    scope: 'grid-cell',
    priority: 25,
    enabled: true,
    combine: 'or',
    conditions: [
      { type: 'attr', attribute: 'custom.status', op: 'in', value: ['blocked', 'damaged'] },
    ],
    style: {
      fillColor: '#7f1d1d',
      fillOpacity: 90,
      borderColor: '#450a0a',
      borderWidth: 2,
      labelText: '{custom.status}',
    },
  },
  {
    name: 'Hazmat cell',
    scope: 'grid-cell',
    priority: 35,
    enabled: true,
    combine: 'and',
    conditions: [
      { type: 'attr', attribute: 'custom.temperature_zone', op: 'equals', value: 'hazmat' },
    ],
    style: {
      fillColor: '#facc15',
      fillOpacity: 65,
      borderColor: '#a16207',
      borderWidth: 2,
      labelText: 'HAZMAT',
    },
  },

  // --- Temperature zones ------------------------------------------------
  {
    name: 'Frozen zone',
    scope: 'grid-cell',
    priority: 45,
    enabled: true,
    combine: 'and',
    conditions: [
      { type: 'attr', attribute: 'custom.temperature_zone', op: 'equals', value: 'frozen' },
    ],
    style: {
      fillColor: '#3b82f6',
      fillOpacity: 55,
      borderColor: '#1e3a8a',
      borderWidth: 1,
    },
  },
  {
    name: 'Refrigerated zone',
    scope: 'grid-cell',
    priority: 55,
    enabled: true,
    combine: 'and',
    conditions: [
      { type: 'attr', attribute: 'custom.temperature_zone', op: 'equals', value: 'refrigerated' },
    ],
    style: {
      fillColor: '#06b6d4',
      fillOpacity: 45,
      borderColor: '#155e75',
      borderWidth: 1,
    },
  },
  {
    name: 'Clean room',
    scope: 'grid-cell',
    priority: 65,
    enabled: true,
    combine: 'and',
    conditions: [
      { type: 'attr', attribute: 'custom.temperature_zone', op: 'equals', value: 'clean_room' },
    ],
    style: {
      fillColor: '#5eead4',
      fillOpacity: 40,
      borderColor: '#0f766e',
      borderWidth: 1,
    },
  },

  // --- Occupancy (built-in bin.status) ---------------------------------
  {
    name: 'Occupied cell',
    scope: 'grid-cell',
    priority: 75,
    enabled: true,
    combine: 'and',
    conditions: [
      { type: 'attr', attribute: 'status', op: 'equals', value: 'occupied' },
    ],
    style: {
      fillColor: '#16a34a',
      fillOpacity: 75,
      borderColor: '#14532d',
      borderWidth: 1,
      labelText: '{custom.rack_id}',
    },
  },
  {
    name: 'Reserved cell',
    scope: 'grid-cell',
    priority: 85,
    enabled: true,
    combine: 'and',
    conditions: [
      { type: 'attr', attribute: 'status', op: 'equals', value: 'reserved' },
    ],
    style: {
      fillColor: '#f59e0b',
      fillOpacity: 55,
      borderColor: '#78350f',
      borderWidth: 1,
    },
  },
  {
    name: 'Empty cell',
    scope: 'grid-cell',
    priority: 95,
    enabled: true,
    combine: 'and',
    conditions: [
      { type: 'attr', attribute: 'status', op: 'equals', value: 'empty' },
    ],
    style: {
      fillColor: '#e5e7eb',
      fillOpacity: 30,
      borderColor: '#9ca3af',
      borderWidth: 1,
    },
  },

  // --- ABC class fallbacks (lower priority so they don't override the
  //     safety/occupancy/temperature rules above) -----------------------
  {
    name: 'ABC class A — high value',
    scope: 'grid-cell',
    priority: 105,
    enabled: true,
    combine: 'and',
    conditions: [
      { type: 'attr', attribute: 'custom.abc_class', op: 'equals', value: 'A' },
    ],
    style: {
      borderColor: '#fbbf24',
      borderWidth: 3,
      fillOpacity: 35,
    },
  },
  {
    name: 'ABC class C — low value',
    scope: 'grid-cell',
    priority: 115,
    enabled: true,
    combine: 'and',
    conditions: [
      { type: 'attr', attribute: 'custom.abc_class', op: 'equals', value: 'C' },
    ],
    style: {
      fillColor: '#9ca3af',
      fillOpacity: 25,
    },
  },
]

async function create(rule) {
  const res = await fetch(`${BASE}/api/v1/style-rules`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': TENANT_ID,
      'X-Api-Key': API_KEY,
    },
    body: JSON.stringify({ ...rule, zoneId: Number(ZONE_ID) }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status} for "${rule.name}": ${text}`)
  }
  return res.json()
}

const created = []
const failed = []
for (const rule of rules) {
  try {
    const row = await create(rule)
    created.push(`${rule.priority} ${rule.name} #${row.id}`)
  } catch (err) {
    failed.push({ rule, err: err.message })
  }
}

console.log(`Inserted ${created.length}/${rules.length} style rules for tenant ${TENANT_ID}`)
for (const c of created) console.log(`  ✓ ${c}`)
if (failed.length > 0) {
  console.log('Failures:')
  for (const f of failed) console.log(`  ✗ ${f.rule.name}: ${f.err}`)
  process.exit(1)
}