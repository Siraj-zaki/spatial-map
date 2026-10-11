#!/usr/bin/env node
/**
 * seed-hospital-assets — creates a table-backed "Assets" data source
 * on the Hospital zone, applies a full asset-management schema, and
 * pushes one asset per curated room across the ground floor (G*)
 * AND the first floor (F*).
 *
 * Reads room polygons from `/tmp/hosp/polygons.json` — the same
 * fixture the reconciliation step produces. Each polygon's centroid
 * is used as the asset's map position; the asset stamps the room
 * name + floor plan id so the data-link's floor gate + tooltip both
 * work.
 *
 * The image_url values are REAL medical-equipment photos hosted on
 * Wikimedia Commons — every URL was fetched from the source article
 * and confirmed to resolve before being pinned here. No placeholder
 * links.
 *
 * Usage:
 *
 *   node scripts/seed-hospital-assets.mjs \
 *     --email you@example.com --password '…' \
 *     --tenant 21 \
 *     [--polygons /tmp/hosp/polygons.json]     # default
 *     [--ground-floor 19] [--first-floor 11]   # polygon.floorPlanId
 *     [--table-name Assets]                    # default
 *     [--keep-token]                           # don't revoke seed token at end
 *     [--force-recreate]                       # drop table if it already exists
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
const polygonsPath = String(args.polygons ?? '/tmp/hosp/polygons.json')
const groundFp = Number(args['ground-floor'] ?? 19)
const firstFp = Number(args['first-floor'] ?? 11)
const tableName = String(args['table-name'] ?? 'Assets')
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
if (!fs.existsSync(polygonsPath)) {
  console.error(`polygons fixture not found at ${polygonsPath}`)
  process.exit(1)
}
const polygonsPayload = JSON.parse(fs.readFileSync(polygonsPath, 'utf8'))
const polygons = Array.isArray(polygonsPayload)
  ? polygonsPayload
  : polygonsPayload?.data ?? []
if (polygons.length === 0) {
  console.error(`${polygonsPath} contained no polygons`)
  process.exit(1)
}

// ---------- schema -----------------------------------------------------

const FIELDS = [
  { fieldKey: 'external_code',    fieldLabel: 'Asset tag',       dataType: 'text',   isRequired: true,  isUnique: true,  sortOrder: 1 },
  { fieldKey: 'name',             fieldLabel: 'Name',            dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 2 },
  { fieldKey: 'asset_type',       fieldLabel: 'Type',            dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 3 },
  { fieldKey: 'category',         fieldLabel: 'Category',        dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 4 },
  { fieldKey: 'status',           fieldLabel: 'Status',          dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 5 },
  { fieldKey: 'condition',        fieldLabel: 'Condition',       dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 6 },
  { fieldKey: 'manufacturer',     fieldLabel: 'Manufacturer',    dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 7 },
  { fieldKey: 'model',            fieldLabel: 'Model',           dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 8 },
  { fieldKey: 'serial_number',    fieldLabel: 'Serial no.',      dataType: 'text',   isRequired: false, isUnique: true,  sortOrder: 9 },
  { fieldKey: 'purchase_date',    fieldLabel: 'Purchased',       dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 10 },
  { fieldKey: 'warranty_expires', fieldLabel: 'Warranty ends',   dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 11 },
  { fieldKey: 'last_service_at',  fieldLabel: 'Last service',    dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 12 },
  { fieldKey: 'next_service_at',  fieldLabel: 'Next service',    dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 13 },
  { fieldKey: 'purchase_cost',    fieldLabel: 'Purchase cost',   dataType: 'number', isRequired: false, isUnique: false, sortOrder: 14 },
  { fieldKey: 'currency',         fieldLabel: 'Currency',        dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 15 },
  { fieldKey: 'image_url',        fieldLabel: 'Image',           dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 16 },
  { fieldKey: 'area_name',        fieldLabel: 'Area',            dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 17 },
  { fieldKey: 'floor_name',       fieldLabel: 'Floor',           dataType: 'text',   isRequired: true,  isUnique: false, sortOrder: 18 },
  { fieldKey: 'floorPlanId',      fieldLabel: 'Floor plan id',   dataType: 'number', isRequired: true,  isUnique: false, sortOrder: 19 },
  { fieldKey: 'assigned_to',      fieldLabel: 'Owner / dept',    dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 20 },
  { fieldKey: 'installed_at',     fieldLabel: 'Installed',       dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 21 },
  { fieldKey: 'lng',              fieldLabel: 'Lng',             dataType: 'number', isRequired: true,  isUnique: false, sortOrder: 22 },
  { fieldKey: 'lat',              fieldLabel: 'Lat',             dataType: 'number', isRequired: true,  isUnique: false, sortOrder: 23 },
  { fieldKey: 'notes',            fieldLabel: 'Notes',           dataType: 'text',   isRequired: false, isUnique: false, sortOrder: 24 },
]

// ---------- image palette (verified Wikimedia Commons URLs) -----------
//
// Each URL was fetched from the referenced Wikipedia article via
// WebFetch during script authoring. Thumb sizes are what the article
// itself embeds — Wikimedia's thumb server generates them on demand.

const IMG = {
  mri:            'https://upload.wikimedia.org/wikipedia/commons/b/bd/Modern_3T_MRI.JPG',
  ct:             'https://upload.wikimedia.org/wikipedia/commons/2/27/UPMCEast_CTscan.jpg',
  xray:           'https://upload.wikimedia.org/wikipedia/commons/thumb/7/77/X-ray_table.JPG/500px-X-ray_table.JPG',
  fluoroscopy:    'https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/Fluoroscope.jpg/500px-Fluoroscope.jpg',
  mammography:    'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Mammogram.jpg/500px-Mammogram.jpg',
  ultrasound:     'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Sonographer_doing_pediatric_echocardiography.JPG/500px-Sonographer_doing_pediatric_echocardiography.JPG',
  ventilator:     'https://upload.wikimedia.org/wikipedia/commons/thumb/3/31/Servo_I_Ventilator.jpg/500px-Servo_I_Ventilator.jpg',
  defibrillator:  'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/AED_machine_medisource.jpg/500px-AED_machine_medisource.jpg',
  patient_monitor:'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Monitor_%28medical%29.jpg/500px-Monitor_%28medical%29.jpg',
  hospital_bed:   'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/A_Modern_Hospital_Bed_in_Pok_Oi_Hospital.jpg/500px-A_Modern_Hospital_Bed_in_Pok_Oi_Hospital.jpg',
  wheelchair:     'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/Man_in_wheelchair_with_AFO_braces_and_crutches_b.jpg/500px-Man_in_wheelchair_with_AFO_braces_and_crutches_b.jpg',
  anesthesia:     'https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/Maquet_Flow-I_anesthesia_machine.jpg/500px-Maquet_Flow-I_anesthesia_machine.jpg',
  infusion_pump:  'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Infusionspumpe.JPG/500px-Infusionspumpe.JPG',
  autoclave:      'https://upload.wikimedia.org/wikipedia/commons/e/eb/Rectangular-medical-autoclave-cutaway.jpg',
  microscope:     'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/Scientists_are_working_in_the_lab.9.jpg/500px-Scientists_are_working_in_the_lab.9.jpg',
  centrifuge:     'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Tabletop_centrifuge.jpg/500px-Tabletop_centrifuge.jpg',
  blood_bank:     'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/Blood_Bank%2C_Hospital_Foch%2C_Suresnes_-_DPLA_-_c05c7e2d480962916a35f58b60e61c41.jpg/500px-Blood_Bank%2C_Hospital_Foch%2C_Suresnes_-_DPLA_-_c05c7e2d480962916a35f58b60e61c41.jpg',
  dialysis:       'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fc/Hemodialysismachine.jpg/500px-Hemodialysismachine.jpg',
  crash_cart:     'https://upload.wikimedia.org/wikipedia/commons/6/6a/Crash_Cart.jpg',
  nurse_station:  'https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Pyxis_Pharmacy_Robot_by_Nurse_Station.JPG/500px-Pyxis_Pharmacy_Robot_by_Nurse_Station.JPG',
}

// ---------- asset archetype catalogue ---------------------------------
//
// Each archetype maps to one physical device / piece of furniture with
// a plausible manufacturer, model, expected purchase cost, and image.
// Placement rules (below) associate archetypes with room-name patterns
// so a "BLOOD DRAW" room gets phlebotomy equipment, an OR gets
// anesthesia + operating table, etc.

const ARCH = {
  MRI_SCANNER:      { type: 'imaging',        category: 'MRI',                  mfr: 'Siemens Healthineers', model: 'MAGNETOM Vida 3T',     cost: 2_400_000, img: IMG.mri,             tag: 'MRI' },
  CT_SCANNER:       { type: 'imaging',        category: 'CT',                   mfr: 'GE Healthcare',        model: 'Revolution Apex',      cost: 1_800_000, img: IMG.ct,              tag: 'CT'  },
  XRAY_UNIT:        { type: 'imaging',        category: 'Radiography',          mfr: 'Philips',              model: 'DigitalDiagnost C90',  cost: 320_000,   img: IMG.xray,            tag: 'XR'  },
  FLUOROSCOPY:      { type: 'imaging',        category: 'Fluoroscopy',          mfr: 'Ziehm',                model: 'Vision RFD C-arm',     cost: 240_000,   img: IMG.fluoroscopy,     tag: 'FL'  },
  MAMMOGRAPHY:      { type: 'imaging',        category: 'Mammography',          mfr: 'Hologic',              model: 'Selenia Dimensions',   cost: 250_000,   img: IMG.mammography,     tag: 'MMG' },
  ULTRASOUND:       { type: 'imaging',        category: 'Ultrasound',           mfr: 'GE Healthcare',        model: 'LOGIQ E10',            cost: 95_000,    img: IMG.ultrasound,      tag: 'US'  },
  VENTILATOR:       { type: 'life_support',   category: 'Ventilator',           mfr: 'Getinge',              model: 'SERVO-U',              cost: 42_000,    img: IMG.ventilator,      tag: 'VNT' },
  DEFIBRILLATOR:    { type: 'life_support',   category: 'Defibrillator',        mfr: 'Physio-Control',       model: 'LIFEPAK 20e',          cost: 12_500,    img: IMG.defibrillator,   tag: 'DEF' },
  PATIENT_MONITOR:  { type: 'monitoring',     category: 'Patient monitor',      mfr: 'Philips',              model: 'IntelliVue MX750',     cost: 18_000,    img: IMG.patient_monitor, tag: 'MON' },
  HOSPITAL_BED:     { type: 'furniture',      category: 'Patient bed',          mfr: 'Hill-Rom',             model: 'Progressa P1900',      cost: 26_000,    img: IMG.hospital_bed,    tag: 'BED' },
  WHEELCHAIR:       { type: 'mobility',       category: 'Wheelchair',           mfr: 'Sunrise Medical',      model: 'Breezy Style X',       cost: 850,       img: IMG.wheelchair,      tag: 'WCH' },
  ANESTHESIA:       { type: 'life_support',   category: 'Anesthesia machine',   mfr: 'Getinge',              model: 'Flow-i',               cost: 68_000,    img: IMG.anesthesia,      tag: 'ANS' },
  INFUSION_PUMP:    { type: 'therapy',        category: 'Infusion pump',        mfr: 'B. Braun',             model: 'Perfusor Space',       cost: 4_200,     img: IMG.infusion_pump,   tag: 'IVP' },
  AUTOCLAVE:        { type: 'sterilisation',  category: 'Autoclave',            mfr: 'STERIS',               model: 'Amsco 3080',           cost: 78_000,    img: IMG.autoclave,       tag: 'AUT' },
  MICROSCOPE:       { type: 'laboratory',     category: 'Microscope',           mfr: 'Zeiss',                model: 'Axio Lab.A1',          cost: 9_500,     img: IMG.microscope,      tag: 'MIC' },
  CENTRIFUGE:       { type: 'laboratory',     category: 'Centrifuge',           mfr: 'Eppendorf',            model: 'Centrifuge 5910 Ri',   cost: 11_800,    img: IMG.centrifuge,      tag: 'CFG' },
  BLOOD_BANK_FRIDGE:{ type: 'cold_storage',   category: 'Blood bank refrigerator', mfr: 'Helmer',            model: 'iBR256',               cost: 14_500,    img: IMG.blood_bank,      tag: 'BBR' },
  DIALYSIS:         { type: 'therapy',        category: 'Dialysis machine',     mfr: 'Fresenius',            model: '4008S',                cost: 22_000,    img: IMG.dialysis,        tag: 'DIA' },
  CRASH_CART:       { type: 'emergency',      category: 'Crash cart',           mfr: 'Waterloo Healthcare',  model: 'Small 5-Drawer',       cost: 3_800,     img: IMG.crash_cart,      tag: 'CRS' },
  NURSE_STATION:    { type: 'workstation',    category: 'Nurse station',        mfr: 'Herman Miller',        model: 'Compass System',       cost: 5_500,     img: IMG.nurse_station,   tag: 'NST' },
}

// Room-name → asset archetypes. First matching pattern wins. Each
// pattern lists 1-4 archetypes; every archetype in the list is placed
// in the room. Regexes are UPPERCASED against the polygon name.
const PLACEMENT_RULES = [
  { match: /BLOOD DRAW/,              archetypes: ['CENTRIFUGE', 'BLOOD_BANK_FRIDGE', 'PATIENT_MONITOR'] },
  { match: /FREEZER FARM|MATERIALS?\s*STORAGE|SURGICAL EQUIPMENT STORES|MATERIAL SUPPLY/, archetypes: ['BLOOD_BANK_FRIDGE'] },
  { match: /AUTOCLAVE|CENTERAL STERILE|STERILE SUPPLY/,     archetypes: ['AUTOCLAVE', 'AUTOCLAVE'] },
  { match: /MICROSCOPY|GENOMICS|TISSUE LAB|DRY LAB|SAMPLE PROCESSING/, archetypes: ['MICROSCOPE', 'CENTRIFUGE'] },
  { match: /CT SCAN/,                 archetypes: ['CT_SCANNER', 'PATIENT_MONITOR'] },
  { match: /OPERATING ROOM|PRE-?OP/,  archetypes: ['ANESTHESIA', 'PATIENT_MONITOR', 'VENTILATOR', 'CRASH_CART'] },
  { match: /SCRUB SINKS/,             archetypes: ['CRASH_CART'] },
  { match: /INPATIENT WARD|INPATIENT WARP/, archetypes: ['HOSPITAL_BED', 'PATIENT_MONITOR', 'INFUSION_PUMP'] },
  { match: /NURSING OBSERVATION|NURSE STATION/, archetypes: ['NURSE_STATION', 'DEFIBRILLATOR'] },
  { match: /EXAMINATION|EXAM ROOM/,   archetypes: ['ULTRASOUND', 'PATIENT_MONITOR'] },
  { match: /RECEPTION|WAITING|LOBBY|TRIAGE|TRAILS RECEPTION/, archetypes: ['WHEELCHAIR', 'DEFIBRILLATOR'] },
  { match: /AUDITORIUM|CONFERENCE|SURGICAL TEAM CONF/, archetypes: ['NURSE_STATION'] },
  { match: /IT SERVER/,               archetypes: [] }, // no medical assets in server room
]

const STATUSES = [
  'operational', 'operational', 'operational', 'operational',
  'operational', 'operational', 'operational',
  'maintenance', 'out_of_service', 'reserved',
]
const CONDITIONS = ['excellent', 'good', 'good', 'good', 'fair', 'poor']
const CURRENCIES = ['USD']

// ---------- helpers ---------------------------------------------------

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const rand = (a, b) => Math.random() * (b - a) + a

function centroid(vertices) {
  let cx = 0
  let cy = 0
  let n = 0
  for (const v of vertices) {
    if (!Array.isArray(v) || v.length < 2) continue
    cx += v[0]
    cy += v[1]
    n++
  }
  if (n === 0) return null
  return [cx / n, cy / n]
}

// Slight jitter around the centroid so multiple assets in the same
// room don't stack pixel-perfectly on top of each other.
function jitterAround([lng, lat], amountM = 1.5) {
  const dLng = (rand(-amountM, amountM) / 111_320) / Math.cos((lat * Math.PI) / 180)
  const dLat = rand(-amountM, amountM) / 111_320
  return [lng + dLng, lat + dLat]
}

function daysAgo(days) {
  return new Date(Date.now() - days * 86_400_000)
}
function daysFromNow(days) {
  return new Date(Date.now() + days * 86_400_000)
}
function fmt(d) {
  return d.toISOString().slice(0, 10)
}
function fmtDateTime(d) {
  return d.toISOString()
}

function serialFor(archKey, seq) {
  const arch = ARCH[archKey]
  const year = new Date().getFullYear() - Math.floor(rand(0, 6))
  return `${arch.tag}-${year}-${String(seq).padStart(5, '0')}`
}

// Assigned owner departments — matched from room name when possible,
// else falls back by asset type.
function assignedTo(roomName, archKey) {
  const r = roomName.toUpperCase()
  if (/OPERATING|PRE-?OP|SURGICAL|SCRUB/.test(r)) return 'Surgical Services'
  if (/INPATIENT|WARD|NURSING/.test(r)) return 'Nursing / Inpatient'
  if (/BLOOD DRAW|PHLEBOT/.test(r)) return 'Pathology / Phlebotomy'
  if (/LAB|GENOMICS|MICROSCOPY|TISSUE|SAMPLE/.test(r)) return 'Clinical Laboratory'
  if (/CT SCAN|RADIOLOGY|IMAGING|MRI|XRAY/.test(r)) return 'Radiology'
  if (/RECEPTION|WAITING|TRIAGE|LOBBY/.test(r)) return 'Patient Access'
  if (/AUTOCLAVE|STERILE/.test(r)) return 'Central Sterile Supply'
  if (/AUDITORIUM|CONFERENCE|OFFICE/.test(r)) return 'Administration'
  if (['CT_SCANNER','MRI_SCANNER','XRAY_UNIT','MAMMOGRAPHY','FLUOROSCOPY','ULTRASOUND'].includes(archKey)) return 'Radiology'
  if (['ANESTHESIA','VENTILATOR'].includes(archKey)) return 'Anesthesia / Surgical'
  return 'Biomedical Engineering'
}

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
    entityKind: 'asset',
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
  const r = await req('POST', `/api/v1/tables/${tableId}/tokens`, authH(jwt), { label: 'asset-seed' })
  if (!r?.token) throw new Error('token: missing plaintext')
  return { id: r.id, plaintext: r.token }
}

async function revokeToken(jwt, tableId, tokenId) {
  await req('DELETE', `/api/v1/tables/${tableId}/tokens/${tokenId}`, authH(jwt))
}

const publicReq = (method, path, plaintext, body) =>
  req(method, path, { authorization: `Bearer ${plaintext}` }, body)

// ---------- room selection --------------------------------------------

function pickArchetypes(roomName) {
  const upper = roomName.toUpperCase()
  for (const rule of PLACEMENT_RULES) {
    if (rule.match.test(upper)) return rule.archetypes
  }
  // Default: unnamed / generic areas get a bed + monitor pair, which
  // is the reasonable fallback for any inpatient-ish zone.
  return ['HOSPITAL_BED', 'PATIENT_MONITOR']
}

function buildRows(polygons) {
  const rows = []
  let seq = 0
  const groundFloorLabel = 'Ground Floor'
  const firstFloorLabel = 'First Floor'
  const now = new Date()

  for (const p of polygons) {
    if (p.floorPlanId !== groundFp && p.floorPlanId !== firstFp) continue
    // Skip generic "Area" polygons — placement logic keys off room
    // names. Naming a room "Area" is a fixture default, not a real
    // room label; putting an ICU bed on every unlabeled polygon
    // would clutter the map.
    const name = String(p.name ?? '').trim()
    if (!name || name === 'Area') continue

    const c = centroid(p.vertices ?? [])
    if (!c) continue

    const archetypes = pickArchetypes(name)
    if (archetypes.length === 0) continue

    const floorName = p.floorPlanId === groundFp ? groundFloorLabel : firstFloorLabel

    for (const archKey of archetypes) {
      const arch = ARCH[archKey]
      seq++
      const position = jitterAround(c, 1.4)
      const status = pick(STATUSES)
      const condition = status === 'out_of_service' ? 'poor'
        : status === 'maintenance' ? pick(['fair', 'poor'])
        : pick(CONDITIONS)

      const purchase = daysAgo(Math.floor(rand(30, 6 * 365)))
      const warranty = daysFromNow(Math.floor(rand(-365, 1095)))
      const lastService = daysAgo(Math.floor(rand(3, 210)))
      const nextService = daysFromNow(
        status === 'maintenance' ? Math.floor(rand(-14, 7))
          : Math.floor(rand(14, 240)),
      )
      const installedAt = daysAgo(Math.floor(rand(30, 6 * 365)))
      // Prices drift +/- 15% from list so a fleet reads plausibly.
      const cost = Math.round(arch.cost * rand(0.85, 1.15))

      const entityKey = `${arch.tag}-${String(seq).padStart(4, '0')}`
      rows.push({
        entityKey,
        payload: {
          external_code: entityKey,
          name: `${arch.mfr} ${arch.model}`,
          asset_type: arch.type,
          category: arch.category,
          status,
          condition,
          manufacturer: arch.mfr,
          model: arch.model,
          serial_number: serialFor(archKey, seq),
          purchase_date: fmt(purchase),
          warranty_expires: fmt(warranty),
          last_service_at: fmtDateTime(lastService),
          next_service_at: fmt(nextService),
          purchase_cost: cost,
          currency: pick(CURRENCIES),
          image_url: arch.img,
          area_name: name,
          floor_name: floorName,
          floorPlanId: p.floorPlanId,
          assigned_to: assignedTo(name, archKey),
          installed_at: fmt(installedAt),
          lng: position[0],
          lat: position[1],
          notes: status === 'out_of_service'
            ? 'Awaiting parts — see biomed ticket queue'
            : status === 'maintenance'
            ? 'PM in progress'
            : status === 'reserved'
            ? 'Reserved for scheduled procedure'
            : '',
        },
        position,
      })
    }
  }
  return rows
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

    const rows = buildRows(polygons)
    const byFloor = rows.reduce((acc, r) => {
      const f = r.payload.floor_name
      acc[f] = (acc[f] ?? 0) + 1
      return acc
    }, {})
    console.log(`[5/5] seeding ${rows.length} assets across floors:`)
    for (const [f, n] of Object.entries(byFloor)) console.log(`      ${f}: ${n}`)

    if (rows.length === 0) {
      console.warn('no rows to seed — check polygons fixture + floor-plan ids')
      return
    }

    // Bulk endpoint has a payload ceiling; chunk generously so a fleet
    // of a few hundred rows sails through.
    const CHUNK = 100
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK)
      await publicReq('POST', '/api/v1/public/tables/rows/bulk', token.plaintext, { rows: slice })
      console.log(`      pushed ${Math.min(i + CHUNK, rows.length)}/${rows.length}`)
    }

    console.log(`done ✓ table id = ${tableId}`)
    console.log('')
    console.log('Next:')
    console.log('  1) node scripts/seed-asset-style-rules.mjs --email ... --tenant 21 --table', tableId, '--zone <zoneId>')
    console.log('  2) open the /view editor for the Hospital zone, add a data-link layer')
    console.log('     backed by table id', tableId, 'and pick the newly-created rules under "Style rules".')
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
