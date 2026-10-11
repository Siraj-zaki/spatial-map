#!/usr/bin/env node
/**
 * seed-sensor-style-rules — creates a colour-coded status rule set
 * on the sensor data-link and rebalances the seeded rows so every
 * rule fires against real data. Idempotent: reuses rules by name if
 * they already exist.
 *
 * The rules are stored in `style_rules` and evaluate against the
 * sensor row payload via `evaluateEntityRules`
 * (`src/lib/data-link/style-rule-evaluator.ts`). No `styleRuleIds`
 * are pushed onto the DataLinkConfig — the user picks the rules to
 * apply in the editor, same as any other data-link layer.
 *
 * Rules created (priority = firing order, lower wins):
 *   10 · Sensor · Alarm         status=alarm            → red
 *   20 · Sensor · Offline       status=offline          → grey
 *   30 · Sensor · Maintenance   status=maintenance      → amber
 *   40 · Sensor · CO2 high      sensor_type=co2 AND value>=900 → orange
 *   50 · Sensor · Active        status=active           → green
 *
 * Usage:
 *   node scripts/seed-sensor-style-rules.mjs \
 *     --email you@example.com --password '…' \
 *     --tenant 21 --table 37 --zone 58 \
 *     [--rebalance]     # nudge sensor statuses so each rule matches ≥1 row
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
const zoneId = Number(args.zone ?? 0)
const rebalance = args.rebalance === true

for (const [name, val] of [
  ['--email', email], ['--password', password],
  ['--tenant', tenantId], ['--table', tableId], ['--zone', zoneId],
]) {
  if (!val) {
    console.error(`missing ${name}`)
    process.exit(1)
  }
}

// ---------- rule definitions ------------------------------------------

// `scope: 'marker'` matches what point-at-coord renders — the data-link
// evaluator (`evaluateEntityRules`) ignores scope anyway (it just runs
// conditions against the payload), so this is more of a "what does this
// rule paint on" hint for the rules-list UI than a functional gate.
// For data-link entities the overlay's `evaluateEntityRules` path
// reads ONLY `fillColor`, `fillOpacity`, and `labelText` off the
// override. Setting `iconColor`, `labelColor`, `borderColor`,
// `borderWidth` here would be silently ignored — except for
// `iconColor`, which the overlay currently overwrites the disc's
// `color` variable with (see line ~1262 of map-data-linked-overlay).
// That bug means an `iconColor: '#ffffff'` on a red-fill rule paints
// the whole disc white. So keep the style bag minimal.
const RULES = [
  {
    name: 'Sensor · Alarm',
    priority: 10,
    combine: 'and',
    conditions: [{ type: 'attr', attribute: 'status', op: 'equals', value: 'alarm' }],
    style: { fillColor: '#dc2626', fillOpacity: 100 },   // red-600
  },
  {
    name: 'Sensor · Offline',
    priority: 20,
    combine: 'and',
    conditions: [{ type: 'attr', attribute: 'status', op: 'equals', value: 'offline' }],
    style: { fillColor: '#9ca3af', fillOpacity: 45 },    // grey-400 @ 45%
  },
  {
    name: 'Sensor · Maintenance',
    priority: 30,
    combine: 'and',
    conditions: [{ type: 'attr', attribute: 'status', op: 'equals', value: 'maintenance' }],
    style: { fillColor: '#f59e0b', fillOpacity: 100 },   // amber-500
  },
  {
    name: 'Sensor · CO₂ high',
    priority: 40,
    combine: 'and',
    conditions: [
      { type: 'attr', attribute: 'sensor_type', op: 'equals', value: 'co2' },
      { type: 'attr', attribute: 'value', op: 'gte', value: 900 },
    ],
    style: { fillColor: '#f97316', fillOpacity: 100 },   // orange-500
  },
  {
    name: 'Sensor · Active',
    priority: 50,
    combine: 'and',
    conditions: [{ type: 'attr', attribute: 'status', op: 'equals', value: 'active' }],
    style: { fillColor: '#22c55e', fillOpacity: 100 },   // green-500
  },
]

// ---------- API helpers -----------------------------------------------

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

const authH = (jwt) => ({ authorization: `Bearer ${jwt}`, 'x-tenant-id': String(tenantId) })

// ---------- steps ------------------------------------------------------

async function login() {
  const r = await req('POST', '/api/v1/auth/login', {}, { email, password })
  if (!r?.token) throw new Error('login: missing token')
  return r.token
}

async function listRules(jwt) {
  const r = await req('GET', '/api/v1/style-rules', authH(jwt))
  return Array.isArray(r) ? r : []
}

async function createRule(jwt, spec) {
  return req('POST', '/api/v1/style-rules', authH(jwt), {
    name: spec.name,
    scope: 'marker',
    zoneId,
    enabled: true,
    priority: spec.priority,
    combine: spec.combine,
    conditions: spec.conditions,
    style: spec.style,
  })
}

async function updateRule(jwt, id, spec) {
  return req('PATCH', `/api/v1/style-rules/${id}`, authH(jwt), {
    name: spec.name,
    scope: 'marker',
    zoneId,
    enabled: true,
    priority: spec.priority,
    combine: spec.combine,
    conditions: spec.conditions,
    style: spec.style,
  })
}

async function upsertRules(jwt) {
  const existing = await listRules(jwt)
  const byName = new Map(existing.map((r) => [r.name, r]))
  const out = []
  for (const spec of RULES) {
    const found = byName.get(spec.name)
    if (found) {
      const upd = await updateRule(jwt, found.id, spec)
      console.log(`  updated rule #${upd?.id ?? found.id} · ${spec.name}`)
      out.push(upd?.id ?? found.id)
    } else {
      const created = await createRule(jwt, spec)
      console.log(`  created rule #${created?.id} · ${spec.name}`)
      out.push(created?.id)
    }
  }
  return out
}

// ---------- rebalance --------------------------------------------------

async function listSensorRows(jwt) {
  const r = await req('GET', `/api/v1/tables/${tableId}/rows?limit=200`, authH(jwt))
  return r?.rows ?? (Array.isArray(r) ? r : [])
}

async function mintToken(jwt) {
  const r = await req('POST', `/api/v1/tables/${tableId}/tokens`, authH(jwt), { label: 'rule-rebalance' })
  return { id: r.id, plaintext: r.token }
}

async function revokeToken(jwt, tokenId) {
  await req('DELETE', `/api/v1/tables/${tableId}/tokens/${tokenId}`, authH(jwt))
}

const publicPatch = (path, plaintext, body) =>
  req('PATCH', path, { authorization: `Bearer ${plaintext}` }, body)

/**
 * Guarantee at least one sensor exists in each status bucket + one CO₂
 * sensor above 900 ppm — otherwise the rules exist but paint nothing
 * visible in the demo.
 */
async function rebalanceSensors(jwt) {
  const rows = await listSensorRows(jwt)
  const byStatus = { alarm: [], offline: [], maintenance: [], active: [] }
  for (const r of rows) {
    const s = r.payload?.status
    if (byStatus[s]) byStatus[s].push(r.entityKey)
  }
  console.log(`  before: alarm=${byStatus.alarm.length} offline=${byStatus.offline.length} maintenance=${byStatus.maintenance.length} active=${byStatus.active.length}`)

  // Need at least 1 in each bucket. Steal from `active` when short.
  const need = {
    alarm: Math.max(0, 1 - byStatus.alarm.length),
    offline: Math.max(0, 1 - byStatus.offline.length),
    maintenance: Math.max(0, 1 - byStatus.maintenance.length),
  }
  const totalMoves = need.alarm + need.offline + need.maintenance
  // Find one CO2 sensor and give it a high value so the CO2-high rule fires.
  const co2 = rows.find((r) => r.payload?.sensor_type === 'co2')

  if (totalMoves === 0 && !co2) {
    console.log('  balance already covers every rule — no rebalance needed')
    return
  }

  const token = await mintToken(jwt)
  try {
    // Move actives → maintenance/offline/alarm as needed.
    const spare = [...byStatus.active]
    const moves = []
    for (const target of ['maintenance', 'offline', 'alarm']) {
      while (need[target] > 0 && spare.length > 0) {
        moves.push({ key: spare.shift(), status: target })
        need[target]--
      }
    }
    for (const m of moves) {
      await publicPatch(
        `/api/v1/public/tables/rows/${encodeURIComponent(m.key)}`,
        token.plaintext,
        { status: m.status },
      )
      console.log(`  ${m.key} → status=${m.status}`)
      await new Promise((r) => setTimeout(r, 1200))
    }
    if (co2) {
      const key = co2.entityKey
      await publicPatch(
        `/api/v1/public/tables/rows/${encodeURIComponent(key)}`,
        token.plaintext,
        { value: 1150, status: 'active' },
      )
      console.log(`  ${key} → value=1150 (CO₂-high rule)`)
    }
  } finally {
    await revokeToken(jwt, token.id)
  }
}

// ---------- main -------------------------------------------------------

;(async () => {
  try {
    console.log(`[1/3] logging in as ${email}`)
    const jwt = await login()

    console.log(`[2/3] upserting ${RULES.length} style rules on zone ${zoneId}`)
    const ids = await upsertRules(jwt)
    console.log(`      rule ids: [${ids.join(', ')}]`)

    if (rebalance) {
      console.log(`[3/3] rebalancing sensor rows so every rule has a match`)
      await rebalanceSensors(jwt)
    } else {
      console.log(`[3/3] --rebalance not set; skipping row nudging`)
    }

    console.log('done ✓')
    console.log('\nNext: open the data-link editor, edit the sensors layer,')
    console.log('and tick these rules in the "Style rules" section:')
    for (const r of RULES) console.log(`  • ${r.name}`)
  } catch (err) {
    console.error('failed:', err.message)
    process.exitCode = 1
  }
})()
