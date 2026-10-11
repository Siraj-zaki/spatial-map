#!/usr/bin/env node
/**
 * seed-supermarket-full — end-to-end seed for the Acme Supermarket demo.
 *
 * Creates 9 data_sources with field definitions, realistic seed rows,
 * and data_link_configs that wire them into the map. Idempotent per
 * table_name: existing sources for this tenant/zone with matching
 * names are dropped + recreated (safer than trying to diff).
 *
 * Tables:
 *   1. products            — SKU master
 *   2. shelf_placements    — planogram (SKU → aisle/shelf)
 *   3. employees           — staff on floor (marker link)
 *   4. pos_transactions    — sales events
 *   5. stock_levels        — on-hand per SKU per aisle
 *   6. customer_traffic    — foot-traffic per department (polygon tint)
 *   7. safety_assets       — fire extinguisher registry (marker link)
 *   8. deliveries          — receiving-dock inbound
 *   9. promotions          — active offers
 *
 * Usage:
 *   node scripts/seed-supermarket-full.mjs \
 *     [--dsn 'postgres://spatial:spatial@localhost:5432/spatial'] \
 *     [--tenant 27] [--zone 66]
 *
 * The script generates a single .sql file into /tmp and pipes it to
 * psql in one transaction so a mid-run failure rolls everything back.
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// ---------- args -----------------------------------------------------------

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (!arg.startsWith('--')) return acc
  const key = arg.slice(2)
  const next = arr[i + 1]
  acc[key] = next && !next.startsWith('--') ? next : true
  return acc
}, {})

const DSN = String(args.dsn ?? 'postgres://spatial:spatial@localhost:5432/spatial')
const TENANT_ID = Number(args.tenant ?? 0)
const ZONE_ID = Number(args.zone ?? 0)
if (!TENANT_ID || !ZONE_ID) {
  console.error('--tenant and --zone are required (your workspace id and facility id)')
  process.exit(1)
}
const SQL_OUT = '/tmp/seed-supermarket.sql'

// ---------- deterministic RNG so re-runs produce identical data ----------
// Mulberry32 — small, fast, plenty of quality for seed data.
// Mulberry32 seed — deterministic across runs so re-seeding the same
// zone yields the same SKU list / employee positions / etc.
let rngState = 0xACE55EED
function rand() {
  rngState |= 0
  rngState = (rngState + 0x6d2b79f5) | 0
  let t = rngState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const uniform = (a, b) => a + rand() * (b - a)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const intPick = (a, b) => Math.floor(uniform(a, b + 1))

// SQL-safe escaping. All strings are wrapped '…', single quotes doubled.
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`
const jsonLit = (obj) => sq(JSON.stringify(obj))

// ---------- shape constants (queried once, embedded) ---------------------
// Aisle grids in the Acme Supermarket zone. Aisles named "AISLE_1..12"
// with the ordering the user placed them in; we don't rely on the DB
// ordering here since names carry the semantics we care about.
const AISLES = ['AISLE_1','AISLE_2','AISLE_3','AISLE_4','AISLE_5','AISLE_6',
                'AISLE_7','AISLE_8','AISLE_9','AISLE_10','AISLE_11','AISLE_12']

// Departments (named polygons). SHOP_DEPTS are customer-facing; back-of-
// house is stripped out of anything customer-oriented (traffic, promos).
const SHOP_DEPTS = ['FROZEN FOODS','DAIRY','MEAT & SEAFOOD','BAKERY','DELI',
                    'PRODUCE','WINE AREA','PHARMACY']
const BOH_DEPTS  = ['RECEIVING DOCK','DRY STORAGE','WALK-IN COOLER','WALK-IN FREEZER',
                    'MANAGER OFFICE','BREAK ROOM','RESTROOM','ELECTRICAL','JANITOR']
const ALL_DEPTS  = [...SHOP_DEPTS, ...BOH_DEPTS]

// Fire extinguisher markers already placed on the map. Coordinates
// duplicated here so safety_assets rows can carry their point positions
// even without joining back to the markers table at seed time.
const FIRE_EXTINGUISHERS = [
  { name: 'FE-01', lng: -1.8183818579753677, lat: 50.746411971128026 },
  { name: 'FE-02', lng: -1.8182769757956123, lat: 50.746345244383775 },
  { name: 'FE-03', lng: -1.8181044362282819, lat: 50.74650475603491 },
  { name: 'FE-04', lng: -1.8182295402576472, lat: 50.74655155191991 },
  { name: 'FE-05', lng: -1.8172906029731735, lat: 50.74616758168611 },
  { name: 'FE-06', lng: -1.8174786663328462, lat: 50.745991991818585 },
  { name: 'FE-07', lng: -1.8182224846750046, lat: 50.74617514362211 },
  { name: 'FE-08', lng: -1.8178029636637234, lat: 50.74599551149254 },
  { name: 'FE-09', lng: -1.81782487957787, lat: 50.74586569237556 },
]

// Rough facility centre (used to place employees + first-aid stations).
const CENTER = { lng: -1.8178, lat: 50.7463 }

// ---------- realistic content pools --------------------------------------
// SKU catalogue: department → array of (name, brand, unit_price, package_size).
// Prices in USD, package sizes in native retail units. Each department
// contributes 8-12 SKUs so the total lands around ~80.
const CATALOG = {
  PRODUCE: [
    ['Bananas', 'Chiquita', 0.59, '1 lb'],
    ['Apples Gala', 'Local Farm', 1.99, '3 lb bag'],
    ['Baby Spinach', 'Earthbound', 3.49, '5 oz'],
    ['Broccoli Crowns', 'Fresh Express', 2.99, '1 lb'],
    ['Roma Tomatoes', 'Local Farm', 1.79, '1 lb'],
    ['Baby Carrots', 'Bolthouse', 2.29, '1 lb bag'],
    ['Avocados', 'Del Monte', 1.49, 'each'],
    ['Strawberries', 'Driscoll\'s', 4.99, '1 lb'],
    ['Bell Peppers', 'Local Farm', 1.79, 'each'],
    ['Iceberg Lettuce', 'Fresh Express', 1.99, 'head'],
  ],
  DAIRY: [
    ['Whole Milk', 'Horizon', 4.99, '1 gal'],
    ['2% Milk', 'Organic Valley', 5.49, '1 gal'],
    ['Butter Salted', 'Kerrygold', 6.99, '8 oz'],
    ['Greek Yogurt', 'Chobani', 5.99, '32 oz'],
    ['Cheddar Block', 'Tillamook', 5.99, '8 oz'],
    ['Cream Cheese', 'Philadelphia', 3.49, '8 oz'],
    ['Eggs Large', 'Vital Farms', 6.49, '12 ct'],
    ['Sour Cream', 'Daisy', 2.99, '16 oz'],
    ['Mozzarella Shred', 'Sargento', 4.49, '8 oz'],
  ],
  'MEAT & SEAFOOD': [
    ['Chicken Breast', 'Perdue', 8.99, '1 lb'],
    ['Ground Beef 80/20', 'Local Butcher', 6.99, '1 lb'],
    ['Salmon Fillet', 'Wild Alaskan', 14.99, '1 lb'],
    ['Bacon', 'Applegate', 7.49, '8 oz'],
    ['Pork Chops', 'Smithfield', 5.99, '1 lb'],
    ['Shrimp Peeled', 'Sea Best', 12.99, '1 lb'],
    ['Turkey Breast', 'Butterball', 9.99, '2 lb'],
    ['Ribeye Steak', 'Prime Cuts', 19.99, '12 oz'],
  ],
  BAKERY: [
    ['Sourdough Loaf', 'In-House', 4.99, 'loaf'],
    ['Baguette', 'In-House', 2.99, 'each'],
    ['Croissants', 'In-House', 6.99, '4 pk'],
    ['Chocolate Chip Cookies', 'In-House', 5.99, '12 ct'],
    ['Blueberry Muffins', 'In-House', 5.49, '4 pk'],
    ['Whole Wheat Bread', 'Dave\'s Killer', 5.99, 'loaf'],
    ['Bagels Everything', 'In-House', 4.99, '6 ct'],
    ['Cinnamon Rolls', 'In-House', 6.99, '6 ct'],
  ],
  DELI: [
    ['Turkey Sliced', 'Boar\'s Head', 12.99, '1 lb'],
    ['Ham Sliced', 'Boar\'s Head', 11.99, '1 lb'],
    ['Salami', 'Columbus', 13.99, '1 lb'],
    ['Provolone Sliced', 'Boar\'s Head', 10.99, '1 lb'],
    ['Prepared Salad', 'In-House', 8.99, '1 lb'],
    ['Rotisserie Chicken', 'In-House', 8.99, 'each'],
    ['Coleslaw', 'In-House', 5.99, '1 lb'],
    ['Potato Salad', 'In-House', 5.99, '1 lb'],
  ],
  'FROZEN FOODS': [
    ['Frozen Pizza', 'DiGiorno', 7.99, '30 oz'],
    ['Ice Cream Vanilla', 'Ben & Jerry\'s', 5.99, '1 pt'],
    ['Frozen Vegetables', 'Green Giant', 3.49, '12 oz'],
    ['Frozen Berries', 'Cascadian Farm', 5.99, '10 oz'],
    ['TV Dinner', 'Stouffer\'s', 4.99, '12 oz'],
    ['Frozen Waffles', 'Eggo', 4.49, '10 ct'],
    ['Frozen Fish Sticks', 'Gorton\'s', 6.99, '18 ct'],
    ['Popsicles', 'Outshine', 5.99, '12 ct'],
  ],
  'WINE AREA': [
    ['Cabernet Sauvignon', 'Kendall-Jackson', 15.99, '750ml'],
    ['Chardonnay', 'La Crema', 17.99, '750ml'],
    ['Pinot Noir', 'Meiomi', 19.99, '750ml'],
    ['Rosé', 'Whispering Angel', 22.99, '750ml'],
    ['Prosecco', 'La Marca', 13.99, '750ml'],
    ['Malbec', 'Catena', 16.99, '750ml'],
    ['IPA 6-pack', 'Sierra Nevada', 11.99, '6 pk'],
    ['Craft Beer 6-pack', 'Lagunitas', 12.99, '6 pk'],
  ],
  PHARMACY: [
    ['Acetaminophen 500mg', 'Tylenol', 8.99, '100 ct'],
    ['Ibuprofen 200mg', 'Advil', 9.99, '100 ct'],
    ['Multivitamin', 'Centrum', 14.99, '100 ct'],
    ['Vitamin D3', 'Nature Made', 11.99, '90 ct'],
    ['Toothpaste', 'Crest', 4.99, '4.1 oz'],
    ['Shampoo', 'Head & Shoulders', 7.99, '13.5 oz'],
    ['Sunscreen SPF 30', 'Neutrogena', 12.99, '3 oz'],
    ['Band-Aids', 'Johnson & Johnson', 5.99, '30 ct'],
  ],
}

// Random UPC-12 barcode. Not a valid checksum digit — sufficient for
// demo data; a real system would compute the check digit.
function upc12(rngIndex) {
  let s = '0'
  for (let i = 0; i < 11; i++) s += intPick(0, 9)
  return s
}

// Aisle → department mapping (each aisle stocks 1-2 department SKUs).
// Aisles 1-8 are grocery, 9-10 pharmacy/wine, 11-12 frozen/dairy.
const AISLE_TO_DEPT = {
  AISLE_1: ['PRODUCE'],
  AISLE_2: ['PRODUCE', 'BAKERY'],
  AISLE_3: ['BAKERY', 'DELI'],
  AISLE_4: ['MEAT & SEAFOOD'],
  AISLE_5: ['DELI', 'DAIRY'],
  AISLE_6: ['DAIRY'],
  AISLE_7: ['FROZEN FOODS'],
  AISLE_8: ['FROZEN FOODS', 'DAIRY'],
  AISLE_9: ['WINE AREA'],
  AISLE_10: ['WINE AREA'],
  AISLE_11: ['PHARMACY'],
  AISLE_12: ['PHARMACY'],
}

const EMPLOYEE_NAMES = [
  ['Emma Wilson', 'cashier'],
  ['Liam Chen', 'cashier'],
  ['Sophia Patel', 'cashier'],
  ['Noah Rodriguez', 'stocker'],
  ['Olivia Kim', 'stocker'],
  ['Ethan Nguyen', 'stocker'],
  ['Ava Thompson', 'deli'],
  ['Mason Silva', 'deli'],
  ['Isabella Ross', 'bakery'],
  ['Lucas Anderson', 'bakery'],
  ['Mia Hernandez', 'produce'],
  ['Aiden Kumar', 'butcher'],
  ['Charlotte Wong', 'pharmacist'],
  ['James Osei', 'manager'],
  ['Amelia Fischer', 'floor-supervisor'],
]
const SHIFTS = ['morning', 'afternoon', 'evening']
const ROLE_TO_DEPT = {
  cashier: 'CHECKOUT',
  stocker: null,          // roams
  deli: 'DELI',
  bakery: 'BAKERY',
  produce: 'PRODUCE',
  butcher: 'MEAT & SEAFOOD',
  pharmacist: 'PHARMACY',
  manager: 'MANAGER OFFICE',
  'floor-supervisor': null,
}

const SUPPLIERS = [
  'Sysco Foods', 'US Foods', 'Sysco Fresh', 'Coca-Cola Bottling',
  'Pepsi Distribution', 'Nestle Direct', 'Kraft Heinz',
  'General Mills', 'Kellogg Sales', 'Anheuser-Busch',
  'Local Dairy Co-op', 'Fresh Produce Direct',
]

const PROMO_TYPES = ['bogo', 'discount-pct', 'clearance', 'weekly-special', 'loyalty']
const PAYMENT_METHODS = ['credit', 'debit', 'cash', 'ebt', 'mobile']

// ---------- SKU generation (products table drives everything else) -------

// Build the full product list. Deterministic ordering by department →
// preserves reproducible SKU codes across runs.
const PRODUCTS = []
let skuSeq = 1000
for (const [dept, entries] of Object.entries(CATALOG)) {
  const deptCode = dept.replace(/[^A-Z]/g, '').slice(0, 3).padEnd(3, 'X')
  for (const [name, brand, price, size] of entries) {
    PRODUCTS.push({
      sku: `SKU-${deptCode}-${skuSeq++}`,
      product_name: name,
      department: dept,
      brand,
      unit_price: price,
      package_size: size,
      barcode: upc12(),
      unit_of_measure: /lb|oz|ml|kg|g\b/.test(size) ? 'weight' : 'unit',
    })
  }
}
console.log(`generated ${PRODUCTS.length} products`)

// ---------- rows ---------------------------------------------------------

// Shelf placements: for each aisle, pick 8-12 SKUs whose department
// matches AISLE_TO_DEPT. Every placement gets a section (A/B/C) and a
// shelf number (1-5, bottom to top).
function makeShelfPlacements() {
  const rows = []
  let seq = 1
  for (const aisle of AISLES) {
    const depts = AISLE_TO_DEPT[aisle] ?? SHOP_DEPTS
    const candidates = PRODUCTS.filter((p) => depts.includes(p.department))
    const perAisle = Math.min(candidates.length, intPick(9, 13))
    const shuffled = candidates.slice().sort(() => rand() - 0.5).slice(0, perAisle)
    for (const p of shuffled) {
      const section = pick(['A', 'B', 'C'])
      const shelf = intPick(1, 5)
      rows.push({
        placement_id: `PL-${String(seq++).padStart(4, '0')}`,
        aisle,
        section,
        shelf,
        position_slot: intPick(1, 12),
        facings: intPick(2, 6),
        sku: p.sku,
        product_name: p.product_name,
        department: p.department,
        unit_price: p.unit_price,
        last_planogram_update: iso(daysAgo(intPick(1, 60))),
      })
    }
  }
  return rows
}

function iso(d) { return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') }
function isoZ(d) { return d.toISOString() }
function daysAgo(n) { return new Date(Date.now() - n * 86400_000) }
function hoursAgo(n) { return new Date(Date.now() - n * 3600_000) }
function minutesAgo(n) { return new Date(Date.now() - n * 60_000) }

// Employees clustered near their home department (cashiers near
// checkout front, pharmacist near PHARMACY zone, etc.). Roamers get a
// random position within the facility.
function makeEmployees() {
  const rows = []
  let seq = 1
  const now = new Date()
  for (const [name, role] of EMPLOYEE_NAMES) {
    // Jitter around facility centre — we don't have per-department
    // centroids handy without another PG query, and demo employees
    // don't need pixel-perfect placement.
    const pt = jitter(CENTER.lng, CENTER.lat, uniform(4, 25))
    rows.push({
      employee_id: `EMP-${String(seq).padStart(3, '0')}`,
      name,
      role,
      shift: pick(SHIFTS),
      home_department: ROLE_TO_DEPT[role] ?? 'FLOOR',
      current_zone: role === 'stocker' || role === 'floor-supervisor'
        ? pick(SHOP_DEPTS)
        : (ROLE_TO_DEPT[role] ?? 'FLOOR'),
      on_shift: rand() > 0.15,
      picks_today: role === 'stocker' ? intPick(30, 120) : 0,
      transactions_today: role === 'cashier' ? intPick(40, 220) : 0,
      last_active: isoZ(minutesAgo(intPick(0, 30))),
      avatar_color: pick(['#f97316','#10b981','#3b82f6','#a855f7','#ef4444','#eab308']),
      lat: pt.lat,
      lng: pt.lng,
    })
    seq++
  }
  return rows
}

function jitter(lng, lat, meters) {
  const dLat = uniform(-meters, meters) / 111_320
  const dLng = uniform(-meters, meters) / (111_320 * Math.cos((lat * Math.PI) / 180))
  return { lng: lng + dLng, lat: lat + dLat }
}

// POS transactions: 150 events across the last 12 hours, with peaks
// around noon and 6 PM. Each carries a compact items_summary (top
// SKUs + count) rather than full line-items to keep the payload small.
function makePosTransactions() {
  const rows = []
  const now = Date.now()
  const cashiers = EMPLOYEE_NAMES.filter(([, r]) => r === 'cashier')
  for (let i = 0; i < 150; i++) {
    // Weighted-random hour: peak factor emphasises 11-14 and 17-20.
    const hour = pick([9,10,11,11,12,12,13,13,14,14,15,16,17,18,18,19,19,20])
    const minute = intPick(0, 59)
    const ts = new Date(now)
    ts.setHours(hour, minute, intPick(0, 59), 0)
    const itemCount = intPick(1, 30)
    const itemsSample = []
    let total = 0
    for (let j = 0; j < Math.min(itemCount, 5); j++) {
      const p = pick(PRODUCTS)
      const qty = intPick(1, 3)
      itemsSample.push(`${p.product_name} × ${qty}`)
      total += p.unit_price * qty
    }
    // Extrapolate for un-sampled items (~ average $4/item).
    if (itemCount > 5) total += (itemCount - 5) * uniform(2.5, 6)
    const cashierIdx = intPick(0, cashiers.length - 1)
    rows.push({
      tx_id: `TX-${ts.getTime()}-${String(i).padStart(4, '0')}`,
      ts: isoZ(ts),
      checkout_lane: `LANE-${String(intPick(1, 10)).padStart(2, '0')}`,
      cashier_id: `EMP-${String(cashierIdx + 1).padStart(3, '0')}`,
      cashier_name: cashiers[cashierIdx][0],
      item_count: itemCount,
      subtotal: +total.toFixed(2),
      tax: +(total * 0.06).toFixed(2),
      total: +(total * 1.06).toFixed(2),
      payment_method: pick(PAYMENT_METHODS),
      items_summary: itemsSample.join(', '),
    })
  }
  // Sort chronological — nicer default browse order.
  rows.sort((a, b) => a.ts.localeCompare(b.ts))
  return rows
}

// Stock levels: one row per shelf placement, with realistic
// on-hand / min / max, needs_restock flag when on_hand < min.
function makeStockLevels(placements) {
  return placements.map((p, i) => {
    const min = intPick(3, 12)
    const max = intPick(30, 80)
    const onHand = intPick(0, max + 5)
    const needsRestock = onHand < min
    const salesPerDay = uniform(2, 20)
    return {
      stock_id: `ST-${String(i + 1).padStart(4, '0')}`,
      sku: p.sku,
      product_name: p.product_name,
      aisle: p.aisle,
      section: p.section,
      shelf: p.shelf,
      on_hand: onHand,
      min_level: min,
      max_level: max,
      needs_restock: needsRestock,
      days_of_supply: +(onHand / salesPerDay).toFixed(1),
      last_restock: isoZ(hoursAgo(intPick(1, 96))),
      last_counted: isoZ(hoursAgo(intPick(0, 24))),
    }
  })
}

// Customer traffic: per shop-facing department, 6 five-minute buckets
// spanning the last 30 minutes. Adds a slight peak toward the current
// bucket so dashboards look alive.
function makeCustomerTraffic() {
  const rows = []
  const now = Date.now()
  let seq = 1
  for (const dept of SHOP_DEPTS) {
    const deptBase = { PRODUCE: 45, DAIRY: 40, BAKERY: 35, DELI: 30,
                       'MEAT & SEAFOOD': 25, 'FROZEN FOODS': 30,
                       'WINE AREA': 20, PHARMACY: 15 }[dept] ?? 20
    for (let b = 0; b < 6; b++) {
      const bucketStart = new Date(now - (6 - b) * 5 * 60_000)
      // Round to the 5-minute boundary so buckets align across depts.
      bucketStart.setSeconds(0, 0)
      bucketStart.setMinutes(Math.floor(bucketStart.getMinutes() / 5) * 5)
      const entries = Math.max(0, intPick(deptBase - 10, deptBase + 15))
      const exits = Math.max(0, entries - intPick(-4, 4))
      rows.push({
        bucket_id: `CT-${String(seq++).padStart(4, '0')}`,
        zone_name: dept,
        ts_bucket: isoZ(bucketStart),
        bucket_minutes: 5,
        entries,
        exits,
        dwell_median_s: intPick(30, 240),
        unique_visitors: Math.floor(entries * uniform(0.85, 1.0)),
      })
    }
  }
  return rows
}

// Safety assets: one per fire extinguisher marker + 3 first-aid stations
// placed at fixed points around the store.
function makeSafetyAssets() {
  const rows = []
  let seq = 1
  for (const fe of FIRE_EXTINGUISHERS) {
    const lastInsp = daysAgo(intPick(15, 180))
    const nextDue = new Date(lastInsp.getTime() + 365 * 86400_000)
    rows.push({
      asset_id: `SA-${String(seq++).padStart(3, '0')}`,
      asset_name: fe.name,
      asset_type: 'fire-extinguisher',
      location_zone: pick(ALL_DEPTS),
      last_inspection: iso(lastInsp).slice(0, 10),
      next_due: iso(nextDue).slice(0, 10),
      status: rand() > 0.15 ? 'compliant' : 'due-soon',
      inspector: pick(['Fire Safety Inc.', 'ABC Compliance', 'SafeCheck Ltd.']),
      pressure_psi: intPick(100, 175),
      lat: fe.lat,
      lng: fe.lng,
    })
  }
  // 3 first-aid stations at fixed offsets from centre.
  const kits = [
    { off: [ 15,  10], loc: 'MANAGER OFFICE' },
    { off: [-20,   5], loc: 'BREAK ROOM' },
    { off: [ -5, -20], loc: 'CHECKOUT' },
  ]
  for (const k of kits) {
    const p = jitter(CENTER.lng, CENTER.lat, 5)
    // Deterministic offset — use k.off in meters explicitly.
    const dLat = k.off[1] / 111_320
    const dLng = k.off[0] / (111_320 * Math.cos((CENTER.lat * Math.PI) / 180))
    rows.push({
      asset_id: `SA-${String(seq++).padStart(3, '0')}`,
      asset_name: `First Aid Kit ${seq - FIRE_EXTINGUISHERS.length - 1}`,
      asset_type: 'first-aid-kit',
      location_zone: k.loc,
      last_inspection: iso(daysAgo(intPick(30, 120))).slice(0, 10),
      next_due: iso(daysAgo(-1 * intPick(90, 240))).slice(0, 10),
      status: 'compliant',
      inspector: 'In-House',
      pressure_psi: 0,
      lat: CENTER.lat + dLat,
      lng: CENTER.lng + dLng,
    })
  }
  return rows
}

// Deliveries: 30 receiving events over the last 14 days.
function makeDeliveries() {
  const rows = []
  for (let i = 0; i < 30; i++) {
    const ts = hoursAgo(intPick(0, 14 * 24))
    const pallets = intPick(2, 24)
    rows.push({
      delivery_id: `DEL-${String(i + 1).padStart(4, '0')}`,
      supplier: pick(SUPPLIERS),
      ts: isoZ(ts),
      dock_bay: `BAY-${intPick(1, 4)}`,
      pallets,
      sku_count: intPick(3, 30),
      weight_kg: intPick(200, 4000),
      status: pick(['completed', 'completed', 'completed', 'in-transit', 'delayed']),
      received_by: pick(EMPLOYEE_NAMES.filter(([,r]) => r === 'stocker' || r === 'manager')
                        .map(([n]) => n)),
      po_number: `PO-${intPick(50000, 99999)}`,
    })
  }
  rows.sort((a, b) => b.ts.localeCompare(a.ts))
  return rows
}

// Promotions: 25 active offers on random SKUs.
function makePromotions() {
  const rows = []
  const shuffled = PRODUCTS.slice().sort(() => rand() - 0.5).slice(0, 25)
  for (let i = 0; i < shuffled.length; i++) {
    const p = shuffled[i]
    const type = pick(PROMO_TYPES)
    const discount = type === 'clearance' ? intPick(30, 60)
                    : type === 'bogo' ? 50
                    : intPick(10, 30)
    const start = daysAgo(intPick(0, 5))
    const end = new Date(start.getTime() + intPick(3, 14) * 86400_000)
    rows.push({
      promo_id: `PROMO-${String(i + 1).padStart(3, '0')}`,
      sku: p.sku,
      product_name: p.product_name,
      department: p.department,
      promo_type: type,
      discount_pct: discount,
      original_price: p.unit_price,
      sale_price: +(p.unit_price * (1 - discount / 100)).toFixed(2),
      start_date: iso(start).slice(0, 10),
      end_date: iso(end).slice(0, 10),
      active: end.getTime() > Date.now(),
    })
  }
  return rows
}

// ---------- table specs (schema + entity_kind + link config) -------------

const TABLES = [
  {
    name: 'Products',
    kind: 'table',
    entity_kind: 'asset',
    description: 'SKU master catalogue — every product carried across all departments.',
    fields: [
      ['sku',              'SKU',            'text',     true,  true,  1],
      ['product_name',     'Product',        'text',     true,  false, 2],
      ['department',       'Department',     'text',     true,  false, 3],
      ['brand',            'Brand',          'text',     false, false, 4],
      ['unit_price',       'Price (USD)',    'number',   true,  false, 5],
      ['package_size',     'Package size',   'text',     false, false, 6],
      ['barcode',          'Barcode',        'text',     false, false, 7],
      ['unit_of_measure',  'UoM',            'text',     false, false, 8],
    ],
    rows: PRODUCTS,
    key: 'sku',
    link: null,
  },
  {
    name: 'Shelf Placements',
    kind: 'table',
    entity_kind: 'rack-cell',
    description: 'Planogram — which SKU sits on which aisle, section, and shelf.',
    fields: [
      ['placement_id',           'Placement ID', 'text',     true,  true,  1],
      ['aisle',                  'Aisle',        'text',     true,  false, 2],
      ['section',                'Section',      'text',     true,  false, 3],
      ['shelf',                  'Shelf',        'integer',  true,  false, 4],
      ['position_slot',          'Slot',         'integer',  false, false, 5],
      ['facings',                'Facings',      'integer',  false, false, 6],
      ['sku',                    'SKU',          'text',     true,  false, 7],
      ['product_name',           'Product',      'text',     false, false, 8],
      ['department',             'Department',   'text',     false, false, 9],
      ['unit_price',             'Price',        'number',   false, false, 10],
      ['last_planogram_update',  'Updated',      'datetime', false, false, 11],
    ],
    rowsFn: (ctx) => (ctx.placements = makeShelfPlacements()),
    key: 'placement_id',
    link: null,
  },
  {
    name: 'Employees',
    kind: 'table',
    entity_kind: 'marker',
    description: 'On-floor staff — cashiers, stockers, department leads.',
    fields: [
      ['employee_id',        'Employee ID',   'text',     true,  true,  1],
      ['name',               'Name',          'text',     true,  false, 2],
      ['role',               'Role',          'text',     true,  false, 3],
      ['shift',              'Shift',         'text',     true,  false, 4],
      ['home_department',    'Home dept',     'text',     false, false, 5],
      ['current_zone',       'Current zone',  'text',     false, false, 6],
      ['on_shift',           'On shift',      'boolean',  false, false, 7],
      ['picks_today',        'Picks today',   'integer',  false, false, 8],
      ['transactions_today', 'Txns today',    'integer',  false, false, 9],
      ['last_active',        'Last active',   'datetime', false, false, 10],
      ['avatar_color',       'Color',         'text',     false, false, 11],
      ['lat',                'Lat',           'number',   true,  false, 12],
      ['lng',                'Lng',           'number',   true,  false, 13],
    ],
    rows: makeEmployees(),
    key: 'employee_id',
    link: {
      name: 'Employees',
      target_kind: 'marker',
      render_mode: 'point-at-coord',
      field_mapping: {
        match: { mode: 'coord' },
        elevation: { kind: 'static', value: 1.7 },
        floorScope: { mode: 'all' },
        labelField: 'name',
        colorField: 'avatar_color',
        coordFields: { lat: 'lat', lng: 'lng' },
        tooltipFields: ['employee_id','name','role','shift','current_zone',
                        'on_shift','picks_today','transactions_today','last_active'],
      },
    },
  },
  {
    name: 'POS Transactions',
    kind: 'table',
    entity_kind: 'asset',
    description: 'Checkout events — one row per transaction with lane, cashier, and totals.',
    fields: [
      ['tx_id',           'Transaction ID', 'text',     true,  true,  1],
      ['ts',              'Time',           'datetime', true,  false, 2],
      ['checkout_lane',   'Lane',           'text',     true,  false, 3],
      ['cashier_id',      'Cashier ID',     'text',     true,  false, 4],
      ['cashier_name',    'Cashier',        'text',     false, false, 5],
      ['item_count',      'Items',          'integer',  false, false, 6],
      ['subtotal',        'Subtotal',       'number',   false, false, 7],
      ['tax',             'Tax',            'number',   false, false, 8],
      ['total',           'Total',          'number',   true,  false, 9],
      ['payment_method',  'Payment',        'text',     false, false, 10],
      ['items_summary',   'Items summary',  'longtext', false, false, 11],
    ],
    rows: makePosTransactions(),
    key: 'tx_id',
    link: null,
  },
  {
    name: 'Stock Levels',
    kind: 'table',
    entity_kind: 'rack-cell',
    description: 'Real-time on-hand per SKU per aisle, with restock flags.',
    fields: [
      ['stock_id',        'Stock ID',      'text',     true,  true,  1],
      ['sku',             'SKU',           'text',     true,  false, 2],
      ['product_name',    'Product',       'text',     false, false, 3],
      ['aisle',           'Aisle',         'text',     true,  false, 4],
      ['section',         'Section',       'text',     false, false, 5],
      ['shelf',           'Shelf',         'integer',  false, false, 6],
      ['on_hand',         'On-hand',       'integer',  true,  false, 7],
      ['min_level',       'Min',           'integer',  false, false, 8],
      ['max_level',       'Max',           'integer',  false, false, 9],
      ['needs_restock',   'Needs restock', 'boolean',  false, false, 10],
      ['days_of_supply',  'Days supply',   'number',   false, false, 11],
      ['last_restock',    'Last restock',  'datetime', false, false, 12],
      ['last_counted',    'Last counted',  'datetime', false, false, 13],
    ],
    rowsFn: (ctx) => makeStockLevels(ctx.placements),
    key: 'stock_id',
    link: null,
  },
  {
    name: 'Customer Traffic',
    kind: 'table',
    entity_kind: 'polygon',
    description: 'Anonymized customer entries per department per 5-minute bucket.',
    fields: [
      ['bucket_id',        'Bucket ID',     'text',     true,  true,  1],
      ['zone_name',        'Department',    'text',     true,  false, 2],
      ['ts_bucket',        'Bucket start',  'datetime', true,  false, 3],
      ['bucket_minutes',   'Minutes',       'integer',  false, false, 4],
      ['entries',          'Entries',       'integer',  true,  false, 5],
      ['exits',            'Exits',         'integer',  false, false, 6],
      ['dwell_median_s',   'Dwell median',  'integer',  false, false, 7],
      ['unique_visitors',  'Unique',        'integer',  false, false, 8],
    ],
    rows: makeCustomerTraffic(),
    key: 'bucket_id',
    link: {
      name: 'Customer Traffic (heat)',
      target_kind: 'polygon',
      render_mode: 'shape-tint',
      field_mapping: {
        // Polygon match: `external-code` is hard-coded to bin.externalCode
        // in match-resolver.ts and doesn't work here. `attribute-join`
        // with `shapeFieldSource: 'name'` looks polygons up by their
        // .name field (matches payload.zone_name → polygon.name).
        match: {
          mode: 'attribute-join',
          join: { payloadField: 'zone_name', shapeFieldSource: 'name' },
        },
        floorScope: { mode: 'all' },
        labelField: 'entries',
        tooltipFields: ['zone_name','ts_bucket','entries','exits',
                        'dwell_median_s','unique_visitors'],
      },
    },
  },
  {
    name: 'Safety Assets',
    kind: 'table',
    entity_kind: 'marker',
    description: 'Fire-extinguisher and first-aid registry with inspection dates.',
    fields: [
      ['asset_id',        'Asset ID',      'text',     true,  true,  1],
      ['asset_name',      'Name',          'text',     true,  false, 2],
      ['asset_type',      'Type',          'text',     true,  false, 3],
      ['location_zone',   'Location',      'text',     false, false, 4],
      ['last_inspection', 'Last insp.',    'date',     false, false, 5],
      ['next_due',        'Next due',      'date',     false, false, 6],
      ['status',          'Status',        'text',     true,  false, 7],
      ['inspector',       'Inspector',     'text',     false, false, 8],
      ['pressure_psi',    'Pressure PSI',  'integer',  false, false, 9],
      ['lat',             'Lat',           'number',   true,  false, 10],
      ['lng',             'Lng',           'number',   true,  false, 11],
    ],
    rows: makeSafetyAssets(),
    key: 'asset_id',
    link: {
      name: 'Safety Assets',
      target_kind: 'marker',
      render_mode: 'point-at-coord',
      field_mapping: {
        match: { mode: 'coord' },
        elevation: { kind: 'static', value: 1.2 },
        floorScope: { mode: 'all' },
        labelField: 'asset_name',
        coordFields: { lat: 'lat', lng: 'lng' },
        tooltipFields: ['asset_id','asset_name','asset_type','location_zone',
                        'last_inspection','next_due','status','inspector','pressure_psi'],
      },
    },
  },
  {
    name: 'Deliveries',
    kind: 'table',
    entity_kind: 'asset',
    description: 'Inbound deliveries at the receiving dock.',
    fields: [
      ['delivery_id',  'Delivery ID', 'text',     true,  true,  1],
      ['supplier',     'Supplier',    'text',     true,  false, 2],
      ['ts',           'Received',    'datetime', true,  false, 3],
      ['dock_bay',     'Dock bay',    'text',     false, false, 4],
      ['pallets',      'Pallets',     'integer',  false, false, 5],
      ['sku_count',    'SKUs',        'integer',  false, false, 6],
      ['weight_kg',    'Weight (kg)', 'number',   false, false, 7],
      ['status',       'Status',      'text',     true,  false, 8],
      ['received_by',  'Received by', 'text',     false, false, 9],
      ['po_number',    'PO #',        'text',     false, false, 10],
    ],
    rows: makeDeliveries(),
    key: 'delivery_id',
    link: null,
  },
  {
    name: 'Promotions',
    kind: 'table',
    entity_kind: 'asset',
    description: 'Active in-store offers and clearance items.',
    fields: [
      ['promo_id',       'Promo ID',       'text',    true,  true,  1],
      ['sku',            'SKU',            'text',    true,  false, 2],
      ['product_name',   'Product',        'text',    false, false, 3],
      ['department',     'Department',     'text',    false, false, 4],
      ['promo_type',     'Type',           'text',    true,  false, 5],
      ['discount_pct',   'Discount %',     'integer', true,  false, 6],
      ['original_price', 'Original price', 'number',  false, false, 7],
      ['sale_price',     'Sale price',     'number',  false, false, 8],
      ['start_date',     'Start',          'date',    false, false, 9],
      ['end_date',       'End',            'date',    false, false, 10],
      ['active',         'Active',         'boolean', false, false, 11],
    ],
    rows: makePromotions(),
    key: 'promo_id',
    link: null,
  },
]

// ---------- SQL builder --------------------------------------------------

const stmts = []

// Wrap everything in one transaction so a mid-run failure rolls back.
stmts.push('BEGIN;')

// Drop any prior seed run's data_sources for this tenant/zone whose
// name matches one of ours (idempotent re-run).
const nameList = TABLES.map((t) => sq(t.name)).join(', ')
stmts.push(`-- Idempotency: drop matching prior seeds for tenant/zone before recreating`)
stmts.push(`DELETE FROM data_sources WHERE tenant_id = ${TENANT_ID} AND zone_id = ${ZONE_ID} AND name IN (${nameList});`)

// Context for rowsFn (some tables consume the output of prior ones).
const ctx = {}

for (const t of TABLES) {
  const dsIdVar = `_ds_${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`

  // Materialise rows now (rowsFn may depend on ctx from earlier tables).
  const rows = t.rowsFn ? t.rowsFn(ctx) : t.rows
  if (t.name === 'Shelf Placements') ctx.placements = rows

  stmts.push('')
  stmts.push(`-- ============================================================`)
  stmts.push(`-- ${t.name} — ${rows.length} rows`)
  stmts.push(`-- ============================================================`)

  // Insert data_source; capture the new id into a temp table.
  stmts.push(`WITH new_ds AS (
    INSERT INTO data_sources (tenant_id, name, kind, entity_kind, zone_id, config, mapping)
    VALUES (${TENANT_ID}, ${sq(t.name)}, ${sq(t.kind)}::data_source_kind, ${sq(t.entity_kind)}::data_source_entity_kind, ${ZONE_ID}, ${jsonLit({ description: t.description })}, '{}'::jsonb)
    RETURNING id
  ) SELECT id AS ds_id INTO TEMP TABLE ${dsIdVar} FROM new_ds;`)

  // Field definitions.
  for (const [key, label, type, req, uniq, sort] of t.fields) {
    stmts.push(`INSERT INTO table_field_definitions (tenant_id, source_id, field_key, field_label, data_type, is_required, is_unique, sort_order)
      SELECT ${TENANT_ID}, ds_id, ${sq(key)}, ${sq(label)}, ${sq(type)}, ${req}, ${uniq}, ${sort} FROM ${dsIdVar};`)
  }

  // Data rows — one INSERT per row (readable; ~800 total is fine).
  // Uses ON CONFLICT (source_id, entity_key) DO UPDATE for re-runs.
  for (const row of rows) {
    const entityKey = String(row[t.key])
    // Point geometry when lat/lng present; NULL otherwise.
    const posSql = (typeof row.lat === 'number' && typeof row.lng === 'number')
      ? `ST_SetSRID(ST_MakePoint(${row.lng}, ${row.lat}), 4326)`
      : 'NULL'
    stmts.push(`INSERT INTO data_source_rows (tenant_id, source_id, entity_key, payload, position, linked_shape_name)
      SELECT ${TENANT_ID}, ds_id, ${sq(entityKey)}, ${jsonLit(row)}::jsonb, ${posSql}, NULL FROM ${dsIdVar}
      ON CONFLICT (source_id, entity_key) DO UPDATE SET payload = EXCLUDED.payload, position = EXCLUDED.position, updated_at = now();`)
  }

  // Data link config (renders this table onto shapes).
  if (t.link) {
    const linkName = t.link.name
    // Match render_mode to the target_kind enum expected by the app.
    stmts.push(`INSERT INTO data_link_configs (tenant_id, zone_id, name, target_kind, render_mode, field_mapping, style, tooltip, style_rule_ids, enabled, source_id)
      SELECT ${TENANT_ID}, ${ZONE_ID}, ${sq(linkName)}, ${sq(t.link.target_kind)}, ${sq(t.link.render_mode)}, ${jsonLit(t.link.field_mapping)}::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::bigint[], TRUE, ds_id FROM ${dsIdVar};`)
  }

  stmts.push(`DROP TABLE ${dsIdVar};`)
}

stmts.push('')
stmts.push('COMMIT;')

// ---------- write + run --------------------------------------------------

const sql = stmts.join('\n') + '\n'
writeFileSync(SQL_OUT, sql, 'utf8')
console.log(`generated ${SQL_OUT} — ${sql.length.toLocaleString()} bytes`)

const psql = spawnSync('psql', [DSN, '-v', 'ON_ERROR_STOP=1', '-f', SQL_OUT], {
  stdio: 'inherit',
  encoding: 'utf8',
})
if (psql.status !== 0) {
  console.error(`psql exited with status ${psql.status}`)
  process.exit(psql.status ?? 1)
}
console.log('seed complete ✓')
