#!/usr/bin/env node
/**
 * seed-retail-assets — pushes a realistic retail-facility asset set into
 * a table-backed data source, then runs N update passes moving a handful
 * of assets each pass so the History player has a scrubbable trail.
 *
 * Uses the same public-token surface publishers use:
 *
 *   POST   /api/v1/public/tables/rows          — upsert
 *   PATCH  /api/v1/public/tables/rows/{key}    — partial update
 *   POST   /api/v1/public/tables/rows/bulk     — batch upsert
 *
 * `Authorization: Bearer <table_api_token>` — same token you'd hand a
 * physical scanner or a warehouse ERP. Get one from the SPA:
 *   /tables/{id} → Tokens → Create — copy the plaintext ONCE.
 *
 * The schema block below is what the table should have — apply it via
 * the table editor before running (the public token has row-CRUD scope
 * only, not schema-edit scope, and that's by design).
 *
 * Usage:
 *
 *   node scripts/seed-retail-assets.mjs \
 *     --url http://localhost:8080 \
 *     --token <TABLE_API_TOKEN> \
 *     [--center 4.769,52.317]        # facility centre lng,lat (Schiphol default)
 *     [--assets 30]                  # how many rows to seed (default 30)
 *     [--passes 20]                  # movement update passes (default 20)
 *     [--pass-interval 2]            # seconds between passes (default 2)
 *     [--movers 8]                   # rows to reposition per pass (default 8)
 *     [--seed]                       # just seed, skip movement
 *     [--move-only]                  # skip seed, only run movement (assumes rows exist)
 *
 * Movement model: each pass picks `movers` random rows and nudges their
 * lat/lng by up to ±5m, plus flips a few status fields to `in-transit` /
 * `available` / `maintenance` so the drawer's History diff has more than
 * just coordinate changes to show.
 */

// ---------- SCHEMA (apply in the SPA's table editor before running) ----
//
// Table: Assets
// Entity kind: asset
//
// Fields (key : type : required):
//   asset_id       : string  : required (unique)
//   name           : string  : required
//   category       : string  : required   ('shelving' | 'pos' | 'freezer' | 'cart' | 'forklift' | 'display')
//   status         : string  : required   ('available' | 'in-transit' | 'maintenance' | 'reserved')
//   floor_name     : string  :             ('G' | 'F1' | 'F2')
//   aisle          : string
//   brand          : string
//   value_usd      : number
//   last_seen_by   : string
//   lng            : number  : required
//   lat            : number  : required
//   notes          : string
//
// Point `lng` / `lat` as the layer's coord fields, and add whichever
// display fields you want in the tooltip/panel.

// ---------- config ------------------------------------------------------

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (!arg.startsWith('--')) return acc
  const key = arg.slice(2)
  const next = arr[i + 1]
  acc[key] = next && !next.startsWith('--') ? next : true
  return acc
}, {})

const url = String(args.url ?? process.env.API_URL ?? 'http://localhost:8080').replace(/\/+$/, '')
const token = String(args.token ?? process.env.TABLE_TOKEN ?? '')
if (!token) {
  console.error('missing --token or TABLE_TOKEN env var')
  process.exit(1)
}

const [centerLngStr, centerLatStr] = String(args.center ?? '4.769,52.317').split(',')
const centerLng = Number(centerLngStr)
const centerLat = Number(centerLatStr)
if (!Number.isFinite(centerLng) || !Number.isFinite(centerLat)) {
  console.error('--center must be "lng,lat"')
  process.exit(1)
}

const assetCount = Number(args.assets ?? 30)
const passes = Number(args.passes ?? 20)
const passIntervalMs = Number(args['pass-interval'] ?? 2) * 1000
const moversPerPass = Number(args.movers ?? 8)
const seedOnly = args.seed === true
const moveOnly = args['move-only'] === true

// ---------- retail archetypes ------------------------------------------

const ARCHETYPES = [
  { category: 'shelving', prefix: 'SHELF',   brand: 'Metro',      valueRange: [400, 1200] },
  { category: 'shelving', prefix: 'SHELF',   brand: 'Uline',      valueRange: [400, 1200] },
  { category: 'pos',      prefix: 'POS',     brand: 'NCR',        valueRange: [1800, 3500] },
  { category: 'pos',      prefix: 'POS',     brand: 'Toshiba',    valueRange: [1800, 3500] },
  { category: 'freezer',  prefix: 'FRZ',     brand: 'True',       valueRange: [3000, 8000] },
  { category: 'freezer',  prefix: 'FRZ',     brand: 'Turbo Air',  valueRange: [3000, 8000] },
  { category: 'cart',     prefix: 'CART',    brand: 'Rubbermaid', valueRange: [180, 320] },
  { category: 'forklift', prefix: 'FLIFT',   brand: 'Toyota',     valueRange: [15000, 32000] },
  { category: 'forklift', prefix: 'FLIFT',   brand: 'Crown',      valueRange: [15000, 32000] },
  { category: 'display',  prefix: 'DISP',    brand: 'Lozier',     valueRange: [700, 1900] },
]

const STATUSES = ['available', 'in-transit', 'maintenance', 'reserved']
const FLOORS = ['G', 'F1', 'F2']
const AISLES = ['A1', 'A2', 'A3', 'B1', 'B2', 'C1', 'C2', 'D1']
const STAFF = ['j.doe', 'a.patel', 'm.garcia', 's.kim', 'l.osei', null]

// ---------- helpers ----------------------------------------------------

const rand = (min, max) => Math.random() * (max - min) + min
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const intPick = (min, max) => Math.floor(rand(min, max + 1))

/**
 * ~1° lat ≈ 111 km. Add ±`meters` around the centre in a rough plane
 * approximation — accurate enough that facility-scale nudges land on the
 * building's floor plan.
 */
function jitter(lng, lat, meters) {
  const dLat = (rand(-meters, meters) / 111_320)
  const dLng = (rand(-meters, meters) / (111_320 * Math.cos((lat * Math.PI) / 180)))
  return { lng: lng + dLng, lat: lat + dLat }
}

async function apiPost(path, body) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

async function apiPatch(path, body) {
  const res = await fetch(`${url}${path}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PATCH ${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

async function apiGet(path) {
  const res = await fetch(`${url}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

// ---------- seed --------------------------------------------------------

async function seed() {
  const rows = []
  for (let i = 0; i < assetCount; i++) {
    const arch = pick(ARCHETYPES)
    // Freezers + POS are anchored (small jitter). Carts + forklifts
    // roam a lot. Shelving / displays sit fixed on aisles.
    const spread = ['cart', 'forklift'].includes(arch.category) ? 25 : 8
    const pt = jitter(centerLng, centerLat, spread)
    const idNum = String(i + 1).padStart(3, '0')
    const entityKey = `${arch.prefix}-${idNum}`
    rows.push({
      entityKey,
      payload: {
        asset_id: entityKey,
        name: `${arch.brand} ${arch.category} #${idNum}`,
        category: arch.category,
        status: pick(STATUSES),
        floor_name: pick(FLOORS),
        aisle: pick(AISLES),
        brand: arch.brand,
        value_usd: intPick(arch.valueRange[0], arch.valueRange[1]),
        last_seen_by: pick(STAFF),
        lng: pt.lng,
        lat: pt.lat,
        notes: '',
      },
      position: [pt.lng, pt.lat],
    })
  }
  // Bulk upsert — one round-trip.
  await apiPost('/api/v1/public/tables/rows/bulk', { rows })
  console.log(`seeded ${rows.length} assets`)
  return rows
}

// ---------- move --------------------------------------------------------

async function loadKeys() {
  // Public list returns the current rows for this token's table.
  const out = await apiGet('/api/v1/public/tables/rows?limit=5000')
  const list = Array.isArray(out) ? out : out?.rows ?? []
  return list.map((r) => ({
    entityKey: r.entityKey,
    payload: r.payload,
  }))
}

async function movePass(passIdx, keys) {
  const targets = []
  for (let i = 0; i < moversPerPass && keys.length > 0; i++) {
    targets.push(pick(keys))
  }
  for (const row of targets) {
    // Nudge the row's current position by up to ±5m. Category-aware —
    // freezers barely move; carts drift further.
    const category = row.payload?.category ?? 'cart'
    const step = category === 'freezer' ? 0.5 : category === 'shelving' ? 1.5 : 5
    const nudged = jitter(
      Number(row.payload?.lng ?? centerLng),
      Number(row.payload?.lat ?? centerLat),
      step,
    )
    // Occasionally flip status too, so History diffs aren't only
    // coordinates. Every 3rd mover on average.
    const patch = {
      payload: {
        lng: nudged.lng,
        lat: nudged.lat,
        last_seen_by: pick(STAFF),
      },
      position: [nudged.lng, nudged.lat],
    }
    if (Math.random() < 0.33) {
      patch.payload.status = pick(STATUSES)
    }
    try {
      await apiPatch(
        `/api/v1/public/tables/rows/${encodeURIComponent(row.entityKey)}`,
        patch,
      )
      // Reflect the patched fields locally so the next pass' delta is
      // relative to the just-committed row.
      Object.assign(row.payload, patch.payload)
    } catch (err) {
      console.warn(`pass ${passIdx + 1}: patch ${row.entityKey} failed: ${err.message}`)
    }
  }
  console.log(`pass ${passIdx + 1}/${passes}: moved ${targets.length} assets`)
}

async function move(rows) {
  const keys = rows ?? (await loadKeys())
  if (keys.length === 0) {
    console.error('no rows to move — seed first or run without --move-only')
    return
  }
  for (let p = 0; p < passes; p++) {
    await movePass(p, keys)
    if (p < passes - 1) await new Promise((r) => setTimeout(r, passIntervalMs))
  }
}

// ---------- main --------------------------------------------------------

;(async () => {
  try {
    let seeded = null
    if (!moveOnly) seeded = await seed()
    if (!seedOnly) await move(seeded)
    console.log('done')
  } catch (err) {
    console.error('seed script failed:', err.message)
    process.exit(1)
  }
})()
