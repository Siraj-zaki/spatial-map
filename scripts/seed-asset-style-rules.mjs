#!/usr/bin/env node
/**
 * seed-asset-style-rules — creates a colour-coded status + condition
 * ruleset on the Assets zone. Idempotent: upserts rules by name so
 * re-running the script is safe.
 *
 * The rules evaluate against each asset row's payload via the shared
 * `evaluateEntityRules` path (see
 * `src/lib/data-link/style-rule-evaluator.ts`). No `styleRuleIds` are
 * pushed onto any DataLinkConfig — the operator picks which rules to
 * apply in the editor.
 *
 * Rules created (priority = firing order; lower wins):
 *    5 · Asset · Out of service        status=out_of_service          → red
 *   10 · Asset · Maintenance           status=maintenance             → amber
 *   15 · Asset · Reserved              status=reserved                → blue
 *   20 · Asset · Poor condition        condition=poor                 → orange
 *   30 · Asset · High-value imaging    category in {MRI,CT,Fluoroscopy,Mammography}
 *                                                                     → violet
 *   40 · Asset · Warranty expiring     warranty_expires within 60 d   → yellow
 *   50 · Asset · Operational           status=operational             → green
 *
 * Usage:
 *   node scripts/seed-asset-style-rules.mjs \
 *     --email you@example.com --password '…' \
 *     --tenant 21 --zone <zoneId>
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
const zoneId = Number(args.zone ?? 0)

for (const [name, val] of [
  ['--email', email], ['--password', password],
  ['--tenant', tenantId], ['--zone', zoneId],
]) {
  if (!val) {
    console.error(`missing ${name}`)
    process.exit(1)
  }
}

// The rules-list UI reads only `fillColor` + `fillOpacity` + `labelText`
// off the override (`iconColor` is silently overridden by the disc
// color path — see the note in seed-sensor-style-rules.mjs). Keep the
// style bag minimal here for the same reason.
const RULES = [
  {
    name: 'Asset · Out of service',
    priority: 5,
    combine: 'and',
    conditions: [{ type: 'attr', attribute: 'status', op: 'equals', value: 'out_of_service' }],
    style: { fillColor: '#dc2626', fillOpacity: 100 },  // red-600
  },
  {
    name: 'Asset · Maintenance',
    priority: 10,
    combine: 'and',
    conditions: [{ type: 'attr', attribute: 'status', op: 'equals', value: 'maintenance' }],
    style: { fillColor: '#f59e0b', fillOpacity: 100 },  // amber-500
  },
  {
    name: 'Asset · Reserved',
    priority: 15,
    combine: 'and',
    conditions: [{ type: 'attr', attribute: 'status', op: 'equals', value: 'reserved' }],
    style: { fillColor: '#3b82f6', fillOpacity: 100 },  // blue-500
  },
  {
    name: 'Asset · Poor condition',
    priority: 20,
    combine: 'and',
    conditions: [{ type: 'attr', attribute: 'condition', op: 'equals', value: 'poor' }],
    style: { fillColor: '#f97316', fillOpacity: 100 },  // orange-500
  },
  {
    name: 'Asset · High-value imaging',
    priority: 30,
    combine: 'or',
    conditions: [
      { type: 'attr', attribute: 'category', op: 'equals', value: 'MRI' },
      { type: 'attr', attribute: 'category', op: 'equals', value: 'CT' },
      { type: 'attr', attribute: 'category', op: 'equals', value: 'Fluoroscopy' },
      { type: 'attr', attribute: 'category', op: 'equals', value: 'Mammography' },
    ],
    style: { fillColor: '#8b5cf6', fillOpacity: 100 },  // violet-500
  },
  {
    name: 'Asset · Warranty expiring soon',
    priority: 40,
    combine: 'and',
    conditions: [
      // `lastNDays` fires while the timestamp sits inside the last
      // window — for future-facing warranty dates, use `nextNDays`.
      { type: 'attr', attribute: 'warranty_expires', op: 'nextNDays', value: 60 },
    ],
    style: { fillColor: '#eab308', fillOpacity: 100 },  // yellow-500
  },
  {
    name: 'Asset · Operational',
    priority: 50,
    combine: 'and',
    conditions: [{ type: 'attr', attribute: 'status', op: 'equals', value: 'operational' }],
    style: { fillColor: '#22c55e', fillOpacity: 100 },  // green-500
  },
]

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

;(async () => {
  try {
    console.log(`[1/2] logging in as ${email}`)
    const jwt = await login()

    console.log(`[2/2] upserting ${RULES.length} style rules on zone ${zoneId}`)
    const existing = await listRules(jwt)
    const byName = new Map(existing.map((r) => [r.name, r]))
    const ids = []
    for (const spec of RULES) {
      const found = byName.get(spec.name)
      if (found) {
        const upd = await updateRule(jwt, found.id, spec)
        console.log(`  updated rule #${upd?.id ?? found.id} · ${spec.name}`)
        ids.push(upd?.id ?? found.id)
      } else {
        const created = await createRule(jwt, spec)
        console.log(`  created rule #${created?.id} · ${spec.name}`)
        ids.push(created?.id)
      }
    }
    console.log(`      rule ids: [${ids.join(', ')}]`)
    console.log('done ✓')
    console.log('')
    console.log('Next: open the data-link editor, edit the Assets layer,')
    console.log('and tick these rules in the "Style rules" section:')
    for (const r of RULES) console.log(`  • ${r.name}`)
  } catch (err) {
    console.error('failed:', err.message)
    process.exitCode = 1
  }
})()
