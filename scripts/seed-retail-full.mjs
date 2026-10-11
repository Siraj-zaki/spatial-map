#!/usr/bin/env node
/**
 * seed-retail-full — end-to-end retail-mall seed.
 *
 * Given login credentials + a tenant + an Assets-table id, this script:
 *   1. logs in, gets a JWT + auto-picks the tenant
 *   2. PATCHes the table schema to a retail-appropriate field set
 *      (preserves existing keys; adds missing ones)
 *   3. mints a scoped table API token, revoked on exit
 *   4. bulk-upserts N realistic retail assets clustered around the
 *      facility centre
 *   5. runs M movement passes — each patches a handful of rows with
 *      new lat/lng (category-aware nudge) + occasional status flips
 *
 * Everything runs against `--url` (localhost:8080 by default). All the
 * long-lived state (JWT, token id) is discarded on exit so nothing
 * lingers past the run.
 *
 * Usage:
 *
 *   node scripts/seed-retail-full.mjs \
 *     --email you@example.com \
 *     --password '…' \
 *     --tenant 21 --table 36 \
 *     --center -121.759625,38.542374 \
 *     [--radius 60]         # metres from centre for initial placement (default 60)
 *     [--assets 30]         # rows to seed (default 30)
 *     [--passes 20]         # movement passes (default 20)
 *     [--pass-interval 2]   # seconds between passes (default 2)
 *     [--movers 8]          # rows repositioned per pass (default 8)
 *     [--seed-only]         # skip movement
 *     [--move-only]         # skip seed
 *     [--keep-token]        # don't revoke the seed token at the end
 */

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (!arg.startsWith('--')) return acc
  const key = arg.slice(2)
  const next = arr[i + 1]
  acc[key] = next && !next.startsWith('--') ? next : true
  return acc
}, {})

const url = String(args.url ?? 'http://localhost:8080').replace(/\/+$/, '')
const email = String(args.email ?? '')
const password = String(args.password ?? '')
const tenantId = Number(args.tenant ?? 0)
const tableId = Number(args.table ?? 0)
const [centerLngStr, centerLatStr] = String(args.center ?? '0,0').split(',')
const centerLng = Number(centerLngStr)
const centerLat = Number(centerLatStr)
const radiusM = Number(args.radius ?? 60)
const assetCount = Number(args.assets ?? 30)
const passes = Number(args.passes ?? 20)
const passIntervalMs = Number(args['pass-interval'] ?? 2) * 1000
const moversPerPass = Number(args.movers ?? 8)
const seedOnly = args['seed-only'] === true
const moveOnly = args['move-only'] === true
const keepToken = args['keep-token'] === true

for (const [name, val] of [
  ['--email', email],
  ['--password', password],
  ['--tenant', tenantId],
  ['--table', tableId],
]) {
  if (!val) {
    console.error(`missing ${name}`)
    process.exit(1)
  }
}
if (!Number.isFinite(centerLng) || !Number.isFinite(centerLat)) {
  console.error('--center must be "lng,lat"')
  process.exit(1)
}

// ---------- retail archetypes ------------------------------------------

const ARCHETYPES = [
  { category: 'shelving', prefix: 'SHELF', brand: 'Metro',      valueRange: [400, 1200] },
  { category: 'shelving', prefix: 'SHELF', brand: 'Uline',      valueRange: [400, 1200] },
  { category: 'pos',      prefix: 'POS',   brand: 'NCR',        valueRange: [1800, 3500] },
  { category: 'pos',      prefix: 'POS',   brand: 'Toshiba',    valueRange: [1800, 3500] },
  { category: 'freezer',  prefix: 'FRZ',   brand: 'True',       valueRange: [3000, 8000] },
  { category: 'freezer',  prefix: 'FRZ',   brand: 'Turbo Air',  valueRange: [3000, 8000] },
  { category: 'cart',     prefix: 'CART',  brand: 'Rubbermaid', valueRange: [180, 320] },
  { category: 'forklift', prefix: 'FLIFT', brand: 'Toyota',     valueRange: [15000, 32000] },
  { category: 'forklift', prefix: 'FLIFT', brand: 'Crown',      valueRange: [15000, 32000] },
  { category: 'display',  prefix: 'DISP',  brand: 'Lozier',     valueRange: [700, 1900] },
]
const STATUSES = ['available', 'in-transit', 'maintenance', 'reserved']
const FLOORS = ['G', 'F1', 'F2']
const AISLES = ['A1', 'A2', 'A3', 'B1', 'B2', 'C1', 'C2', 'D1']
const STAFF = ['j.doe', 'a.patel', 'm.garcia', 's.kim', 'l.osei']

// Field definitions we want on the table. The updateTableHandler diffs
// against the existing list and applies add/remove — we merge with any
// existing fields to avoid dropping data.
const DESIRED_FIELDS = [
  { fieldKey: 'external_code', fieldLabel: 'Asset ID',     dataType: 'text',   isRequired: true,  isUnique: true,  sortOrder: 1 },
  { fieldKey: 'asset_name',    fieldLabel: 'Name',         dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 2 },
  { fieldKey: 'category',      fieldLabel: 'Category',     dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 3 },
  { fieldKey: 'status',        fieldLabel: 'Status',       dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 4 },
  { fieldKey: 'floor_name',    fieldLabel: 'Floor',        dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 5 },
  { fieldKey: 'aisle',         fieldLabel: 'Aisle',        dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 6 },
  { fieldKey: 'brand',         fieldLabel: 'Brand',        dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 7 },
  { fieldKey: 'value_usd',     fieldLabel: 'Value (USD)',  dataType: 'number', isRequired: false, isUnique: false, sortOrder: 8 },
  { fieldKey: 'last_seen_by',  fieldLabel: 'Last seen by', dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 9 },
  { fieldKey: 'lng',           fieldLabel: 'Lng',          dataType: 'number', isRequired: true,  isUnique: false, sortOrder: 10 },
  { fieldKey: 'lat',           fieldLabel: 'Lat',          dataType: 'number', isRequired: true,  isUnique: false, sortOrder: 11 },
  { fieldKey: 'notes',         fieldLabel: 'Notes',        dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 12 },
]

// ---------- helpers ----------------------------------------------------

const rand = (a, b) => Math.random() * (b - a) + a
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const intPick = (a, b) => Math.floor(rand(a, b + 1))

/** ±meters around (lng,lat) in a rough plane approximation. */
function jitter(lng, lat, meters) {
  const dLat = rand(-meters, meters) / 111_320
  const dLng = rand(-meters, meters) / (111_320 * Math.cos((lat * Math.PI) / 180))
  return { lng: lng + dLng, lat: lat + dLat }
}

/**
 * Backend responses use `{ data: <payload> }` for successes. Unwrap that
 * layer here so callers just get the payload.
 */
async function req(method, path, headers, body) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`)
  }
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && 'data' in parsed
      ? parsed.data
      : parsed
  } catch {
    return text
  }
}

// ---------- steps ------------------------------------------------------

async function login() {
  const resp = await req('POST', '/api/v1/auth/login', {}, { email, password })
  if (!resp?.token) throw new Error('login response missing token')
  return { jwt: resp.token, user: resp.user, tenants: resp.tenants }
}

function authHeaders(jwt) {
  return { authorization: `Bearer ${jwt}`, 'x-tenant-id': String(tenantId) }
}

async function fetchTable(jwt) {
  return req('GET', `/api/v1/tables/${tableId}`, authHeaders(jwt))
}

async function applySchema(jwt, existingFields) {
  // Merge: preserve existing fields' keys (in case the user added
  // custom ones), and layer DESIRED_FIELDS on top so the retail fields
  // become / stay present. Existing fields not in DESIRED_FIELDS are
  // kept as-is at the tail; existing fields whose key matches are
  // overwritten by the desired shape (so `required` etc. are refreshed).
  const desiredByKey = new Map(DESIRED_FIELDS.map((f) => [f.fieldKey, f]))
  const merged = []
  for (const d of DESIRED_FIELDS) merged.push(d)
  for (const f of existingFields ?? []) {
    if (!desiredByKey.has(f.fieldKey)) {
      merged.push({
        fieldKey: f.fieldKey,
        fieldLabel: f.fieldLabel,
        dataType: f.dataType,
        isRequired: f.isRequired,
        isUnique: f.isUnique,
        sortOrder: 100 + merged.length,
      })
    }
  }
  const resp = await req(
    'PATCH',
    `/api/v1/tables/${tableId}`,
    authHeaders(jwt),
    { fields: merged },
  )
  return resp?.fields ?? []
}

async function mintToken(jwt) {
  const resp = await req(
    'POST',
    `/api/v1/tables/${tableId}/tokens`,
    authHeaders(jwt),
    { label: 'retail-seed' },
  )
  if (!resp?.token) throw new Error('token response missing token')
  return { id: resp.id, plaintext: resp.token }
}

async function revokeToken(jwt, tokenId) {
  await req(
    'DELETE',
    `/api/v1/tables/${tableId}/tokens/${tokenId}`,
    authHeaders(jwt),
  )
}

/** Public API — auth via table token, no tenant header. */
async function publicReq(method, path, tokenPlaintext, body) {
  return req(method, path, { authorization: `Bearer ${tokenPlaintext}` }, body)
}

async function seed(tokenPlaintext) {
  const rows = []
  for (let i = 0; i < assetCount; i++) {
    const arch = pick(ARCHETYPES)
    // Freezers + POS anchored; shelving fixed on aisles; carts + forklifts roam.
    const spread =
      ['cart', 'forklift'].includes(arch.category) ? radiusM :
      ['shelving', 'display'].includes(arch.category) ? radiusM * 0.6 :
      radiusM * 0.35
    const pt = jitter(centerLng, centerLat, spread)
    const idNum = String(i + 1).padStart(3, '0')
    const entityKey = `${arch.prefix}-${idNum}`
    rows.push({
      entityKey,
      payload: {
        external_code: entityKey,
        asset_name: `${arch.brand} ${arch.category} #${idNum}`,
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
  await publicReq('POST', '/api/v1/public/tables/rows/bulk', tokenPlaintext, { rows })
  return rows
}

async function movePass(passIdx, keys, tokenPlaintext) {
  const targets = []
  const seen = new Set()
  while (targets.length < moversPerPass && targets.length < keys.length) {
    const k = pick(keys)
    if (seen.has(k.entityKey)) continue
    seen.add(k.entityKey)
    targets.push(k)
  }
  let moved = 0
  for (const row of targets) {
    const category = row.payload?.category ?? 'cart'
    const step =
      category === 'freezer' ? 0.5 :
      category === 'shelving' || category === 'display' ? 1.5 :
      category === 'pos' ? 0.8 :
      5
    const nudged = jitter(
      Number(row.payload?.lng ?? centerLng),
      Number(row.payload?.lat ?? centerLat),
      step,
    )
    const patchPayload = {
      lng: nudged.lng,
      lat: nudged.lat,
      last_seen_by: pick(STAFF),
    }
    if (Math.random() < 0.33) patchPayload.status = pick(STATUSES)
    try {
      // Public PATCH takes the body as a flat patch map — every key
      // becomes a payload merge target. Sending `{payload:{...}}` would
      // nest under `row.payload.payload`. Position isn't a payload
      // field on the wire, so we omit it here — lng/lat inside the
      // payload are what the map renders from.
      await publicReq(
        'PATCH',
        `/api/v1/public/tables/rows/${encodeURIComponent(row.entityKey)}`,
        tokenPlaintext,
        patchPayload,
      )
      Object.assign(row.payload, patchPayload)
      moved++
    } catch (err) {
      console.warn(`  pass ${passIdx + 1}: patch ${row.entityKey} failed: ${err.message}`)
    }
    // Space patches ~1.2s apart within a pass so we sit under the
    // per-token 1 req/s steady-state limit (burst 30). Without this
    // the burst empties in ~4s and the next 15+ passes all 429.
    await new Promise((r) => setTimeout(r, 1200))
  }
  console.log(`  pass ${passIdx + 1}/${passes}: moved ${moved} assets`)
}

async function loadKeys(tokenPlaintext) {
  const out = await publicReq(
    'GET',
    '/api/v1/public/tables/rows?limit=5000',
    tokenPlaintext,
  )
  const list = Array.isArray(out) ? out : out?.rows ?? []
  return list.map((r) => ({ entityKey: r.entityKey, payload: r.payload }))
}

// ---------- main -------------------------------------------------------

;(async () => {
  let jwt = ''
  let tokenId = 0
  try {
    console.log(`[1/5] logging in as ${email}`)
    const auth = await login()
    jwt = auth.jwt
    console.log(`      user #${auth.user?.id} — ${auth.user?.email}`)

    console.log(`[2/5] fetching table ${tableId} in tenant ${tenantId}`)
    const table = await fetchTable(jwt)
    console.log(
      `      "${table?.dataSource?.name}" — ${table?.fields?.length ?? 0} existing fields`,
    )

    console.log('[3/5] applying retail schema (merged with existing)')
    const fields = await applySchema(jwt, table?.fields ?? [])
    console.log(
      `      -> ${fields.length} fields now: ${fields.map((f) => f.fieldKey).join(', ')}`,
    )

    console.log('[4/5] minting temporary table API token')
    const token = await mintToken(jwt)
    tokenId = token.id
    console.log(`      token id=${token.id}`)

    let seededKeys = null
    if (!moveOnly) {
      console.log(`[5/5] seeding ${assetCount} retail assets near ${centerLng.toFixed(6)},${centerLat.toFixed(6)}`)
      seededKeys = await seed(token.plaintext)
      console.log(`      seeded ${seededKeys.length} rows`)
    } else {
      console.log('[5/5] skipping seed (--move-only)')
    }

    if (!seedOnly) {
      const keys = seededKeys ?? (await loadKeys(token.plaintext))
      if (keys.length === 0) {
        console.warn('no rows to move — did the seed run?')
      } else {
        console.log(`      running ${passes} movement passes @ every ${passIntervalMs / 1000}s`)
        for (let p = 0; p < passes; p++) {
          await movePass(p, keys, token.plaintext)
          if (p < passes - 1) await new Promise((r) => setTimeout(r, passIntervalMs))
        }
      }
    } else {
      console.log('      skipping movement (--seed-only)')
    }

    console.log('done ✓')
  } catch (err) {
    console.error('failed:', err.message)
    process.exitCode = 1
  } finally {
    if (tokenId && !keepToken && jwt) {
      try {
        await revokeToken(jwt, tokenId)
        console.log(`token #${tokenId} revoked`)
      } catch (err) {
        console.warn(`token revoke failed: ${err.message}`)
      }
    }
  }
})()
