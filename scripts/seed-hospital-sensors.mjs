#!/usr/bin/env node
/**
 * seed-hospital-sensors — creates a table-backed "Sensors" data source
 * on the Hospital zone's ground floor, applies a realistic sensor
 * schema, and pushes one sensor per ground-floor door at the door's
 * midpoint. Each sensor stamps the door's containing room + floor so
 * a data-link's tooltip/panel shows where it's attached.
 *
 * Reads door → room mapping from `/tmp/hosp/door_rooms.json`
 * (produced upstream by the reconciliation step). Falls back to
 * `--doors <path>` if the fixture is somewhere else.
 *
 * Usage:
 *
 *   node scripts/seed-hospital-sensors.mjs \
 *     --email you@example.com --password '…' \
 *     --tenant 21 \
 *     [--doors /tmp/hosp/door_rooms.json]     # default
 *     [--table-name Sensors]                  # default
 *     [--updates 20]                          # value drift updates (default 20)
 *     [--pass-interval 3]                     # seconds between updates
 *     [--seed-only]                           # skip drift updates
 *     [--keep-token]                          # don't revoke the seed token at end
 *     [--force-recreate]                      # drop any existing table with the same name first
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
const doorsPath = String(args.doors ?? '/tmp/hosp/door_rooms.json')
const tableName = String(args['table-name'] ?? 'Sensors')
const updateCount = Number(args.updates ?? 20)
const passIntervalMs = Number(args['pass-interval'] ?? 3) * 1000
const seedOnly = args['seed-only'] === true
const keepToken = args['keep-token'] === true
const forceRecreate = args['force-recreate'] === true

for (const [name, val] of [
  ['--email', email], ['--password', password], ['--tenant', tenantId],
]) {
  if (!val) {
    console.error(`missing ${name}`)
    process.exit(1)
  }
}

const fs = await import('node:fs')
if (!fs.existsSync(doorsPath)) {
  console.error(`doors fixture not found at ${doorsPath}`)
  process.exit(1)
}
const doors = JSON.parse(fs.readFileSync(doorsPath, 'utf8'))
if (!Array.isArray(doors) || doors.length === 0) {
  console.error(`${doorsPath} must contain a non-empty array`)
  process.exit(1)
}

// ---------- schema -----------------------------------------------------

const FIELDS = [
  { fieldKey: 'external_code',    fieldLabel: 'Sensor ID',      dataType: 'text',   isRequired: true,  isUnique: true,  sortOrder: 1 },
  { fieldKey: 'name',             fieldLabel: 'Name',           dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 2 },
  { fieldKey: 'sensor_type',      fieldLabel: 'Type',           dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 3 },
  { fieldKey: 'status',           fieldLabel: 'Status',         dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 4 },
  { fieldKey: 'value',            fieldLabel: 'Value',          dataType: 'number', isRequired: false, isUnique: false, sortOrder: 5 },
  { fieldKey: 'unit',             fieldLabel: 'Unit',           dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 6 },
  { fieldKey: 'battery_pct',      fieldLabel: 'Battery %',      dataType: 'number', isRequired: false, isUnique: false, sortOrder: 7 },
  { fieldKey: 'last_reading_at',  fieldLabel: 'Last reading',   dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 8 },
  { fieldKey: 'floor',            fieldLabel: 'Floor',          dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 9 },
  { fieldKey: 'room',             fieldLabel: 'Room',           dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 10 },
  { fieldKey: 'door_id',          fieldLabel: 'Door ID',        dataType: 'number', isRequired: false, isUnique: false, sortOrder: 11 },
  { fieldKey: 'door_name',        fieldLabel: 'Attached door',  dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 12 },
  { fieldKey: 'manufacturer',     fieldLabel: 'Manufacturer',   dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 13 },
  { fieldKey: 'model',            fieldLabel: 'Model',          dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 14 },
  { fieldKey: 'installed_at',     fieldLabel: 'Installed',      dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 15 },
  { fieldKey: 'lng',              fieldLabel: 'Lng',            dataType: 'number', isRequired: true,  isUnique: false, sortOrder: 16 },
  { fieldKey: 'lat',              fieldLabel: 'Lat',            dataType: 'number', isRequired: true,  isUnique: false, sortOrder: 17 },
  { fieldKey: 'notes',            fieldLabel: 'Notes',          dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 18 },
]

// ---------- realistic sensor archetypes -------------------------------

const TYPES = [
  { key: 'temperature',    prefix: 'TEMP', unit: '°C',  vRange: [18, 24],    drift: 0.4,   brand: 'Honeywell', model: 'T7460' },
  { key: 'humidity',       prefix: 'HUM',  unit: '%RH', vRange: [30, 60],    drift: 3,     brand: 'Sensirion', model: 'SHT35' },
  { key: 'co2',            prefix: 'CO2',  unit: 'ppm', vRange: [400, 1200], drift: 60,    brand: 'Vaisala',   model: 'GMP252' },
  { key: 'air_quality',    prefix: 'AQ',   unit: 'ppb', vRange: [100, 500],  drift: 40,    brand: 'Bosch',     model: 'BME688' },
  { key: 'occupancy',      prefix: 'OCC',  unit: 'ppl', vRange: [0, 8],      drift: 1,     brand: 'Milesight', model: 'VS121' },
  { key: 'motion',          prefix: 'MOT',  unit: 'flag', vRange: [0, 1],    drift: 1,     brand: 'Aqara',     model: 'RTCGQ11LM' },
  { key: 'contact',        prefix: 'DOOR', unit: 'flag', vRange: [0, 1],    drift: 1,     brand: 'Aqara',     model: 'MCCGQ11LM' },
  { key: 'smoke',          prefix: 'SMK',  unit: 'flag', vRange: [0, 0],    drift: 0,     brand: 'Kidde',     model: 'i9040' },
  { key: 'water_leak',     prefix: 'LEAK', unit: 'flag', vRange: [0, 0],    drift: 0,     brand: 'Aqara',     model: 'SJCGQ11LM' },
  { key: 'illuminance',    prefix: 'LUX',  unit: 'lux', vRange: [50, 700],   drift: 80,    brand: 'Elsys',     model: 'ERS Lite' },
]
const STATUSES = ['active', 'active', 'active', 'active', 'offline', 'maintenance', 'alarm']
const FLOOR = 'G'

// ---------- helpers ---------------------------------------------------

const rand = (a, b) => Math.random() * (b - a) + a
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d

async function req(method, path, headers, body) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`)
  if (!text) return null
  try {
    const p = JSON.parse(text)
    return p && typeof p === 'object' && 'data' in p ? p.data : p
  } catch { return text }
}

// ---------- steps -----------------------------------------------------

async function login() {
  const r = await req('POST', '/api/v1/auth/login', {}, { email, password })
  if (!r?.token) throw new Error('login: missing token')
  return r.token
}

const authH = (jwt) => ({ authorization: `Bearer ${jwt}`, 'x-tenant-id': String(tenantId) })

async function findOrCreateTable(jwt) {
  const list = await req('GET', '/api/v1/tables', authH(jwt))
  const existing = (Array.isArray(list) ? list : []).find(
    (t) => t.dataSource?.name === tableName,
  )
  if (existing && !forceRecreate) {
    console.log(`  reusing existing table id=${existing.dataSource.id}`)
    return existing.dataSource.id
  }
  if (existing && forceRecreate) {
    console.log(`  --force-recreate: deleting existing table id=${existing.dataSource.id}`)
    await req('DELETE', `/api/v1/tables/${existing.dataSource.id}`, authH(jwt))
  }
  const created = await req('POST', '/api/v1/tables', authH(jwt), {
    name: tableName,
    entityKind: 'sensor',
    fields: FIELDS,
  })
  const id = created?.dataSource?.id ?? created?.id
  console.log(`  created table id=${id}`)
  return id
}

async function applySchema(jwt, tableId) {
  await req('PATCH', `/api/v1/tables/${tableId}`, authH(jwt), { fields: FIELDS })
}

async function mintToken(jwt, tableId) {
  const r = await req('POST', `/api/v1/tables/${tableId}/tokens`, authH(jwt), { label: 'sensor-seed' })
  if (!r?.token) throw new Error('token: missing plaintext')
  return { id: r.id, plaintext: r.token }
}

async function revokeToken(jwt, tableId, tokenId) {
  await req('DELETE', `/api/v1/tables/${tableId}/tokens/${tokenId}`, authH(jwt))
}

const publicReq = (method, path, plaintext, body) =>
  req(method, path, { authorization: `Bearer ${plaintext}` }, body)

/**
 * Produce a fresh reading value based on the sensor's type + prior
 * value. Bounded to the type's normal range so drift doesn't wander
 * into implausible readings.
 */
function nextValue(type, prev) {
  const [lo, hi] = type.vRange
  if (type.unit === 'flag') {
    return Math.random() < 0.15 ? 1 - (prev ?? 0) : (prev ?? 0)
  }
  const base = prev ?? rand(lo, hi)
  const stepped = base + rand(-type.drift, type.drift)
  return Math.max(lo, Math.min(hi, stepped))
}

// ---------- main ------------------------------------------------------

;(async () => {
  let jwt = ''
  let tokenId = 0
  let tableId = 0
  try {
    console.log(`[1/5] logging in as ${email}`)
    jwt = await login()

    console.log(`[2/5] finding or creating "${tableName}" table on tenant ${tenantId}`)
    tableId = await findOrCreateTable(jwt)
    console.log(`[3/5] applying schema (${FIELDS.length} fields)`)
    await applySchema(jwt, tableId)

    console.log('[4/5] minting temporary table API token')
    const token = await mintToken(jwt, tableId)
    tokenId = token.id

    console.log(`[5/5] seeding ${doors.length} sensors — one per ground-floor door`)
    // One sensor per door, chosen from the type catalogue so the mix
    // reflects a real facility: doors get contact sensors, corridors
    // get temp/humidity, labs get CO2 / air quality, etc.
    const now = new Date()
    const rows = doors.map((d, i) => {
      // Type assignment heuristic — bias by room name to feel real.
      const room = (d.room || '').toUpperCase()
      let type
      if (/LAB|GENOMICS|MICROSCOPY|CT/.test(room)) type = pick([TYPES[0], TYPES[2], TYPES[3]])
      else if (/RECEPTION|LOBBY|WAIT/.test(room)) type = pick([TYPES[4], TYPES[5], TYPES[9]])
      else if (/RESTROOM|BREAK|JANITOR/.test(room)) type = pick([TYPES[1], TYPES[8]])
      else if (/STORAGE|SERVER|FREEZER/.test(room)) type = pick([TYPES[0], TYPES[7], TYPES[5]])
      else type = pick([TYPES[6], TYPES[5], TYPES[0]])
      const idNum = String(i + 1).padStart(3, '0')
      const entityKey = `${type.prefix}-${idNum}`
      const status = pick(STATUSES)
      const val = round(rand(type.vRange[0], type.vRange[1]), type.unit === 'flag' ? 0 : 1)
      const installed = new Date(now.getTime() - Math.floor(rand(30, 365)) * 86_400_000)
      return {
        entityKey,
        payload: {
          external_code: entityKey,
          name: `${type.brand} ${type.key} · ${d.door_name}`,
          sensor_type: type.key,
          status,
          value: status === 'offline' ? null : val,
          unit: type.unit,
          battery_pct: status === 'offline' ? 0 : Math.floor(rand(20, 100)),
          last_reading_at: now.toISOString(),
          floor: FLOOR,
          room: d.room || 'Unassigned',
          door_id: d.door_id,
          door_name: d.door_name,
          manufacturer: type.brand,
          model: type.model,
          installed_at: installed.toISOString().slice(0, 10),
          lng: d.lng,
          lat: d.lat,
          notes: '',
        },
        position: [d.lng, d.lat],
      }
    })
    await publicReq('POST', '/api/v1/public/tables/rows/bulk', token.plaintext, { rows })
    console.log(`      seeded ${rows.length} sensors`)

    if (!seedOnly && updateCount > 0) {
      console.log(`      running ${updateCount} update passes @ every ${passIntervalMs / 1000}s`)
      // Reload the seeded state so subsequent patches build on server-
      // authoritative values (the local `rows` might drift if the
      // server did any coercion on write).
      const state = rows.map((r) => ({
        entityKey: r.entityKey,
        type: TYPES.find((t) => t.prefix === r.entityKey.split('-')[0]),
        value: r.payload.value,
        battery: r.payload.battery_pct,
      }))
      for (let p = 0; p < updateCount; p++) {
        // Pick a small subset each pass so the rate limiter is happy
        // (~1/s steady, burst 30). Sleeping 1.2s between each PATCH.
        const targets = []
        while (targets.length < 3) targets.push(pick(state))
        for (const s of targets) {
          if (!s.type) continue
          const next = nextValue(s.type, s.value)
          s.value = next
          s.battery = Math.max(1, s.battery - Math.random() * 0.4)
          const patch = {
            value: s.type.unit === 'flag' ? next : round(next, 1),
            battery_pct: Math.round(s.battery),
            last_reading_at: new Date().toISOString(),
          }
          if (Math.random() < 0.08) patch.status = pick(STATUSES)
          try {
            await publicReq(
              'PATCH',
              `/api/v1/public/tables/rows/${encodeURIComponent(s.entityKey)}`,
              token.plaintext,
              patch,
            )
          } catch (err) {
            console.warn(`  pass ${p + 1}: patch ${s.entityKey} failed: ${err.message}`)
          }
          await new Promise((r) => setTimeout(r, 1200))
        }
        console.log(`  pass ${p + 1}/${updateCount} done`)
        if (p < updateCount - 1) await new Promise((r) => setTimeout(r, passIntervalMs))
      }
    }

    console.log(`done ✓ table id = ${tableId}`)
  } catch (err) {
    console.error('failed:', err.message)
    process.exitCode = 1
  } finally {
    if (tokenId && !keepToken && jwt && tableId) {
      try {
        await revokeToken(jwt, tableId, tokenId)
        console.log(`token #${tokenId} revoked`)
      } catch (err) {
        console.warn(`token revoke failed: ${err.message}`)
      }
    }
  }
})()
