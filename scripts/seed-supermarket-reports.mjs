#!/usr/bin/env node
/**
 * seed-supermarket-reports — 11 professional reports for Acme Supermarket.
 *
 * Auto-resolves the 9 supermarket data_source IDs by name (tenant 27,
 * zone 66) so it stays correct across re-seeds of the data. Reports
 * are idempotent per name: any existing report with a matching name +
 * zone is deleted before recreating.
 *
 * Widget shapes match `src/lib/reports-client.ts`:
 *   bigValue   = { value, format, tone }
 *   bar/line   = { xAxis, series: [] }
 *   donut/pie  = { xAxis, series: [oneValueColumn] }
 *   dataTable  = { columns: [], columnConfig?, pageSize? }
 *   markdown   = { content }
 *
 * Positions use the 12-column grid: x + w ≤ 12; h is row units.
 *
 * Usage:
 *   node scripts/seed-supermarket-reports.mjs \
 *     [--dsn 'postgres://spatial:spatial@localhost:5432/spatial'] \
 *     [--tenant 27] [--zone 66]
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// ---------- args + constants --------------------------------------------
const args = process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (!a.startsWith('--')) return acc
  const k = a.slice(2)
  const n = arr[i + 1]
  acc[k] = n && !n.startsWith('--') ? n : true
  return acc
}, {})
const DSN = String(args.dsn ?? 'postgres://spatial:spatial@localhost:5432/spatial')
const TENANT_ID = Number(args.tenant ?? 0)
const ZONE_ID = Number(args.zone ?? 0)
if (!TENANT_ID || !ZONE_ID) {
  console.error('--tenant and --zone are required (your workspace id and facility id)')
  process.exit(1)
}
const SQL_OUT = '/tmp/seed-supermarket-reports.sql'

// ---------- resolve source ids ------------------------------------------
function q(sql) {
  const r = spawnSync('psql', [DSN, '-A', '-t', '-F', '|', '-c', sql], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(r.stderr)
    process.exit(1)
  }
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('|'))
}

const SOURCES = Object.fromEntries(
  q(`SELECT name, id FROM data_sources WHERE tenant_id = ${TENANT_ID} AND zone_id = ${ZONE_ID} AND deleted_at IS NULL`)
    .map(([name, id]) => [name, Number(id)]),
)
const NEEDED = [
  'Products', 'Shelf Placements', 'Employees', 'POS Transactions',
  'Stock Levels', 'Customer Traffic', 'Safety Assets', 'Deliveries', 'Promotions',
]
for (const n of NEEDED) {
  if (!SOURCES[n]) {
    console.error(`missing data_source "${n}" — run seed-supermarket-full.mjs first`)
    process.exit(1)
  }
}
const PRODUCTS = SOURCES['Products']
const SHELF = SOURCES['Shelf Placements']
const EMPLOYEES = SOURCES['Employees']
const POS = SOURCES['POS Transactions']
const STOCK = SOURCES['Stock Levels']
const TRAFFIC = SOURCES['Customer Traffic']
const SAFETY = SOURCES['Safety Assets']
const DELIVERIES = SOURCES['Deliveries']
const PROMOTIONS = SOURCES['Promotions']
console.log('resolved source ids:', SOURCES)

// ---------- widget factories --------------------------------------------
const src = (id) => ({ kind: 'dataSource', id })

const kpi = (id, title, queryRef, value, tone, x, y, format = 'number') => ({
  id, kind: 'bigValue', queryRef, title,
  position: { x, y, w: 3, h: 2 },
  bindings: { value, tone, format },
})

const chart = (id, kind, title, queryRef, xAxis, series, x, y, w = 6, h = 6, extra = {}) => ({
  id, kind, queryRef, title,
  position: { x, y, w, h },
  bindings: { xAxis, series, ...extra },
})

const table = (id, title, queryRef, columns, x, y, w = 12, h = 6, columnConfig = {}, pageSize = 25) => ({
  id, kind: 'dataTable', queryRef, title,
  position: { x, y, w, h },
  bindings: { columns, columnConfig, pageSize },
})

const md = (id, content, x, y, w = 12, h = 2) => ({
  id, kind: 'markdown',
  position: { x, y, w, h },
  bindings: { content },
})

// ---------- report specs ------------------------------------------------

const REPORTS = [
  // ==========================================================================
  // 1. Store Overview — cross-cutting KPIs
  // ==========================================================================
  {
    name: 'Store Overview',
    description: 'Executive snapshot — SKUs, staff on shift, live sales, and traffic hot spots across the whole store.',
    icon: 'store',
    color: '#0ea5e9',
    spec: {
      v: 2, reportType: 'summary',
      sources: [src(PRODUCTS), src(EMPLOYEES), src(POS), src(TRAFFIC)],
      queries: [
        { name: 'skus', sourceRef: src(PRODUCTS), metrics: [{ fn: 'count', as: 'skus' }], limit: 1 },
        { name: 'on_shift', sourceRef: src(EMPLOYEES),
          filters: { cond: { field: 'on_shift', op: 'eq', value: true } },
          metrics: [{ fn: 'count', as: 'staff' }], limit: 1 },
        { name: 'sales_today', sourceRef: src(POS),
          metrics: [
            { fn: 'count', as: 'txns' },
            { fn: 'sum', field: 'total', as: 'revenue' },
            { fn: 'avg', field: 'total', as: 'avg_basket' },
          ], limit: 1 },
        { name: 'traffic_total', sourceRef: src(TRAFFIC),
          metrics: [{ fn: 'sum', field: 'entries', as: 'entries' }], limit: 1 },
        { name: 'dept_traffic', sourceRef: src(TRAFFIC),
          groupBy: ['zone_name'],
          metrics: [{ fn: 'sum', field: 'entries', as: 'entries' }],
          sort: [{ field: 'entries', dir: 'desc' }] },
        { name: 'sales_by_lane', sourceRef: src(POS),
          groupBy: ['checkout_lane'],
          metrics: [{ fn: 'sum', field: 'total', as: 'revenue' }],
          sort: [{ field: 'revenue', dir: 'desc' }] },
      ],
      layout: { kind: 'grid' },
      widgets: [
        md('intro', '## Acme Supermarket — Live Overview\nCross-cutting KPIs for the last operating window. Drill into individual reports for detail.', 0, 0, 12, 2),
        kpi('k_skus', 'SKUs carried', 'skus', 'skus', 'blue', 0, 2),
        kpi('k_staff', 'Staff on shift', 'on_shift', 'staff', 'emerald', 3, 2),
        kpi('k_txns', 'Transactions', 'sales_today', 'txns', 'purple', 6, 2),
        kpi('k_rev', 'Revenue', 'sales_today', 'revenue', 'amber', 9, 2, 'currency'),
        chart('c_dept_traffic', 'bar', 'Foot traffic by department', 'dept_traffic', 'zone_name', ['entries'], 0, 4, 6, 6),
        chart('c_sales_lane', 'bar', 'Revenue by checkout lane', 'sales_by_lane', 'checkout_lane', ['revenue'], 6, 4, 6, 6),
        kpi('k_traffic', 'Total entries', 'traffic_total', 'entries', 'blue', 0, 10),
        kpi('k_avg', 'Avg basket', 'sales_today', 'avg_basket', 'emerald', 3, 10, 'currency'),
      ],
    },
  },

  // ==========================================================================
  // 2. Sales Performance — deep dive on POS
  // ==========================================================================
  {
    name: 'Sales Performance',
    description: 'Deep-dive on POS transactions — revenue, basket size, payment mix, lane throughput.',
    icon: 'trending-up',
    color: '#22c55e',
    spec: {
      v: 2, reportType: 'summary',
      sources: [src(POS)],
      queries: [
        { name: 'totals', sourceRef: src(POS),
          metrics: [
            { fn: 'count', as: 'txns' },
            { fn: 'sum', field: 'total', as: 'revenue' },
            { fn: 'avg', field: 'total', as: 'avg_basket' },
            { fn: 'max', field: 'total', as: 'largest' },
          ], limit: 1 },
        { name: 'by_lane', sourceRef: src(POS),
          groupBy: ['checkout_lane'],
          metrics: [
            { fn: 'count', as: 'txns' },
            { fn: 'sum', field: 'total', as: 'revenue' },
          ],
          sort: [{ field: 'revenue', dir: 'desc' }] },
        { name: 'by_payment', sourceRef: src(POS),
          groupBy: ['payment_method'],
          metrics: [
            { fn: 'count', as: 'txns' },
            { fn: 'sum', field: 'total', as: 'revenue' },
          ],
          sort: [{ field: 'revenue', dir: 'desc' }] },
        { name: 'listing', sourceRef: src(POS),
          sort: [{ field: 'ts', dir: 'desc' }], limit: 500 },
      ],
      layout: { kind: 'grid' },
      widgets: [
        kpi('k_txns', 'Transactions', 'totals', 'txns', 'blue', 0, 0),
        kpi('k_rev', 'Total revenue', 'totals', 'revenue', 'emerald', 3, 0, 'currency'),
        kpi('k_avg', 'Avg basket', 'totals', 'avg_basket', 'purple', 6, 0, 'currency'),
        kpi('k_max', 'Largest sale', 'totals', 'largest', 'amber', 9, 0, 'currency'),
        chart('c_lane_rev', 'bar', 'Revenue by lane', 'by_lane', 'checkout_lane', ['revenue'], 0, 2, 6, 6),
        chart('c_lane_txns', 'bar', 'Transactions by lane', 'by_lane', 'checkout_lane', ['txns'], 6, 2, 6, 6),
        chart('c_pay_donut', 'donut', 'Revenue by payment method', 'by_payment', 'payment_method', ['revenue'], 0, 8, 6, 6),
        chart('c_pay_bar', 'bar', 'Transactions by payment method', 'by_payment', 'payment_method', ['txns'], 6, 8, 6, 6),
        table('tbl_tx', 'Transaction log', 'listing',
          ['tx_id', 'ts', 'checkout_lane', 'cashier_name', 'item_count', 'subtotal', 'tax', 'total', 'payment_method'],
          0, 14, 12, 8,
          {
            ts: { format: 'date' },
            checkout_lane: { chip: true, align: 'center' },
            payment_method: { chip: true },
            item_count: { align: 'right' },
            subtotal: { align: 'right', format: 'currency' },
            tax: { align: 'right', format: 'currency' },
            total: { align: 'right', format: 'currency', footer: 'sum' },
          },
        ),
      ],
    },
  },

  // ==========================================================================
  // 3. Cashier Performance — Employees × POS
  // ==========================================================================
  {
    name: 'Cashier Performance',
    description: 'Per-cashier throughput — transactions, revenue, and average basket.',
    icon: 'user-check',
    color: '#a855f7',
    spec: {
      v: 2, reportType: 'summary',
      sources: [src(POS), src(EMPLOYEES)],
      queries: [
        { name: 'by_cashier', sourceRef: src(POS),
          groupBy: ['cashier_name'],
          metrics: [
            { fn: 'count', as: 'txns' },
            { fn: 'sum', field: 'total', as: 'revenue' },
            { fn: 'avg', field: 'total', as: 'avg_basket' },
            { fn: 'sum', field: 'item_count', as: 'items' },
          ],
          sort: [{ field: 'revenue', dir: 'desc' }] },
        { name: 'cashiers', sourceRef: src(EMPLOYEES),
          filters: { cond: { field: 'role', op: 'eq', value: 'cashier' } },
          sort: [{ field: 'transactions_today', dir: 'desc' }] },
        { name: 'totals', sourceRef: src(EMPLOYEES),
          filters: { cond: { field: 'role', op: 'eq', value: 'cashier' } },
          metrics: [
            { fn: 'count', as: 'cashiers' },
            { fn: 'sum', field: 'transactions_today', as: 'txns_today' },
          ], limit: 1 },
      ],
      layout: { kind: 'grid' },
      widgets: [
        kpi('k_num', 'Cashiers', 'totals', 'cashiers', 'blue', 0, 0),
        kpi('k_txns', 'Transactions today', 'totals', 'txns_today', 'emerald', 3, 0),
        chart('c_rev', 'bar', 'Revenue by cashier', 'by_cashier', 'cashier_name', ['revenue'], 0, 2, 12, 6),
        chart('c_txns', 'bar', 'Transactions by cashier', 'by_cashier', 'cashier_name', ['txns'], 0, 8, 6, 6),
        chart('c_avg', 'bar', 'Avg basket by cashier', 'by_cashier', 'cashier_name', ['avg_basket'], 6, 8, 6, 6),
        table('tbl_c', 'Cashier leaderboard', 'by_cashier',
          ['cashier_name', 'txns', 'items', 'revenue', 'avg_basket'],
          0, 14, 12, 8,
          {
            txns: { align: 'right', footer: 'sum' },
            items: { align: 'right', footer: 'sum' },
            revenue: { align: 'right', format: 'currency', footer: 'sum' },
            avg_basket: { align: 'right', format: 'currency' },
          },
        ),
        table('tbl_roster', 'Cashier roster', 'cashiers',
          ['employee_id', 'name', 'shift', 'on_shift', 'transactions_today', 'last_active'],
          0, 22, 12, 6,
          {
            shift: { chip: true },
            on_shift: { chip: true, align: 'center' },
            transactions_today: { align: 'right' },
            last_active: { format: 'date' },
          },
        ),
      ],
    },
  },

  // ==========================================================================
  // 4. Product Catalogue — Products
  // ==========================================================================
  {
    name: 'Product Catalogue',
    description: 'SKU master — full catalogue with department breakdown, pricing, and brand mix.',
    icon: 'package',
    color: '#3b82f6',
    spec: {
      v: 2, reportType: 'summary',
      sources: [src(PRODUCTS)],
      queries: [
        { name: 'totals', sourceRef: src(PRODUCTS),
          metrics: [
            { fn: 'count', as: 'skus' },
            { fn: 'countDistinct', field: 'brand', as: 'brands' },
            { fn: 'countDistinct', field: 'department', as: 'departments' },
            { fn: 'avg', field: 'unit_price', as: 'avg_price' },
          ], limit: 1 },
        { name: 'by_dept', sourceRef: src(PRODUCTS),
          groupBy: ['department'],
          metrics: [
            { fn: 'count', as: 'skus' },
            { fn: 'avg', field: 'unit_price', as: 'avg_price' },
          ],
          sort: [{ field: 'skus', dir: 'desc' }] },
        { name: 'by_brand', sourceRef: src(PRODUCTS),
          groupBy: ['brand'],
          metrics: [{ fn: 'count', as: 'skus' }],
          sort: [{ field: 'skus', dir: 'desc' }], limit: 15 },
        { name: 'listing', sourceRef: src(PRODUCTS),
          sort: [{ field: 'department', dir: 'asc' }, { field: 'product_name', dir: 'asc' }],
          limit: 500 },
      ],
      layout: { kind: 'grid' },
      widgets: [
        kpi('k_skus', 'SKUs', 'totals', 'skus', 'blue', 0, 0),
        kpi('k_brands', 'Brands', 'totals', 'brands', 'purple', 3, 0),
        kpi('k_depts', 'Departments', 'totals', 'departments', 'emerald', 6, 0),
        kpi('k_price', 'Avg price', 'totals', 'avg_price', 'amber', 9, 0, 'currency'),
        chart('c_donut', 'donut', 'SKUs by department', 'by_dept', 'department', ['skus'], 0, 2, 6, 6),
        chart('c_price', 'bar', 'Avg price by department', 'by_dept', 'department', ['avg_price'], 6, 2, 6, 6),
        chart('c_brand', 'bar', 'Top brands by SKU count', 'by_brand', 'brand', ['skus'], 0, 8, 12, 6),
        table('tbl_p', 'Full catalogue', 'listing',
          ['sku', 'product_name', 'department', 'brand', 'unit_price', 'package_size', 'barcode', 'unit_of_measure'],
          0, 14, 12, 8,
          {
            department: { chip: true },
            brand: { chip: true },
            unit_price: { align: 'right', format: 'currency' },
            unit_of_measure: { chip: true, align: 'center' },
          },
        ),
      ],
    },
  },

  // ==========================================================================
  // 5. Shelf Placement Audit — Shelf Placements
  // ==========================================================================
  {
    name: 'Shelf Placement Audit',
    description: 'Planogram distribution — placements per aisle and department, facings audit.',
    icon: 'layers',
    color: '#14b8a6',
    spec: {
      v: 2, reportType: 'summary',
      sources: [src(SHELF)],
      queries: [
        { name: 'totals', sourceRef: src(SHELF),
          metrics: [
            { fn: 'count', as: 'placements' },
            { fn: 'countDistinct', field: 'aisle', as: 'aisles' },
            { fn: 'countDistinct', field: 'sku', as: 'skus' },
            { fn: 'avg', field: 'facings', as: 'avg_facings' },
          ], limit: 1 },
        { name: 'by_aisle', sourceRef: src(SHELF),
          groupBy: ['aisle'],
          metrics: [
            { fn: 'count', as: 'placements' },
            { fn: 'sum', field: 'facings', as: 'facings' },
          ],
          sort: [{ field: 'aisle', dir: 'asc' }] },
        { name: 'by_dept', sourceRef: src(SHELF),
          groupBy: ['department'],
          metrics: [{ fn: 'count', as: 'placements' }],
          sort: [{ field: 'placements', dir: 'desc' }] },
        { name: 'listing', sourceRef: src(SHELF),
          sort: [{ field: 'aisle', dir: 'asc' }, { field: 'shelf', dir: 'asc' }],
          limit: 500 },
      ],
      layout: { kind: 'grid' },
      widgets: [
        kpi('k_p', 'Placements', 'totals', 'placements', 'blue', 0, 0),
        kpi('k_a', 'Aisles covered', 'totals', 'aisles', 'emerald', 3, 0),
        kpi('k_s', 'Distinct SKUs', 'totals', 'skus', 'purple', 6, 0),
        kpi('k_f', 'Avg facings', 'totals', 'avg_facings', 'amber', 9, 0),
        chart('c_aisle', 'bar', 'Placements per aisle', 'by_aisle', 'aisle', ['placements'], 0, 2, 6, 6),
        chart('c_facings', 'bar', 'Total facings per aisle', 'by_aisle', 'aisle', ['facings'], 6, 2, 6, 6),
        chart('c_dept', 'donut', 'Placements by department', 'by_dept', 'department', ['placements'], 0, 8, 6, 6),
        table('tbl_p', 'Planogram', 'listing',
          ['placement_id', 'aisle', 'section', 'shelf', 'position_slot', 'facings', 'sku', 'product_name', 'department', 'unit_price', 'last_planogram_update'],
          0, 14, 12, 8,
          {
            aisle: { chip: true },
            section: { chip: true, align: 'center' },
            shelf: { align: 'right' },
            facings: { align: 'right', footer: 'sum' },
            department: { chip: true },
            unit_price: { align: 'right', format: 'currency' },
            last_planogram_update: { format: 'date' },
          },
        ),
      ],
    },
  },

  // ==========================================================================
  // 6. Stock Health — Stock Levels
  // ==========================================================================
  {
    name: 'Stock Health',
    description: 'On-hand inventory with restock alerts — needs-restock flags, aisle rollup, low-stock table.',
    icon: 'alert-triangle',
    color: '#f59e0b',
    spec: {
      v: 2, reportType: 'summary',
      sources: [src(STOCK)],
      queries: [
        { name: 'totals', sourceRef: src(STOCK),
          metrics: [
            { fn: 'count', as: 'items' },
            { fn: 'sum', field: 'on_hand', as: 'units' },
            { fn: 'avg', field: 'days_of_supply', as: 'avg_dos' },
          ], limit: 1 },
        { name: 'restock', sourceRef: src(STOCK),
          filters: { cond: { field: 'needs_restock', op: 'eq', value: true } },
          metrics: [{ fn: 'count', as: 'to_restock' }], limit: 1 },
        { name: 'by_aisle', sourceRef: src(STOCK),
          groupBy: ['aisle'],
          metrics: [
            { fn: 'sum', field: 'on_hand', as: 'units' },
            { fn: 'count', as: 'items' },
          ],
          sort: [{ field: 'aisle', dir: 'asc' }] },
        { name: 'restock_by_aisle', sourceRef: src(STOCK),
          filters: { cond: { field: 'needs_restock', op: 'eq', value: true } },
          groupBy: ['aisle'],
          metrics: [{ fn: 'count', as: 'to_restock' }],
          sort: [{ field: 'to_restock', dir: 'desc' }] },
        { name: 'low_stock', sourceRef: src(STOCK),
          filters: { cond: { field: 'needs_restock', op: 'eq', value: true } },
          sort: [{ field: 'days_of_supply', dir: 'asc' }],
          limit: 200 },
      ],
      layout: { kind: 'grid' },
      widgets: [
        md('intro', '## Stock Health\nWatch the **Needs restock** count in amber — anything > 15 warrants a stocker sweep this shift.', 0, 0, 12, 2),
        kpi('k_items', 'Placements', 'totals', 'items', 'blue', 0, 2),
        kpi('k_units', 'Units on hand', 'totals', 'units', 'emerald', 3, 2),
        kpi('k_restock', 'Needs restock', 'restock', 'to_restock', 'amber', 6, 2),
        kpi('k_dos', 'Avg days supply', 'totals', 'avg_dos', 'purple', 9, 2),
        chart('c_units', 'bar', 'Units on hand by aisle', 'by_aisle', 'aisle', ['units'], 0, 4, 6, 6),
        chart('c_restock', 'bar', 'Restock alerts by aisle', 'restock_by_aisle', 'aisle', ['to_restock'], 6, 4, 6, 6),
        table('tbl_low', 'Low-stock items', 'low_stock',
          ['stock_id', 'sku', 'product_name', 'aisle', 'shelf', 'on_hand', 'min_level', 'max_level', 'days_of_supply', 'last_restock'],
          0, 10, 12, 10,
          {
            aisle: { chip: true },
            shelf: { align: 'center' },
            on_hand: { align: 'right', footer: 'sum' },
            min_level: { align: 'right' },
            max_level: { align: 'right' },
            days_of_supply: { align: 'right', format: 'number' },
            last_restock: { format: 'date' },
          },
        ),
      ],
    },
  },

  // ==========================================================================
  // 7. Customer Traffic Heatmap — Customer Traffic
  // ==========================================================================
  {
    name: 'Customer Traffic',
    description: 'Anonymized foot traffic per department per 5-minute bucket — entries, dwell time, unique visitors.',
    icon: 'users',
    color: '#ec4899',
    spec: {
      v: 2, reportType: 'summary',
      sources: [src(TRAFFIC)],
      queries: [
        { name: 'totals', sourceRef: src(TRAFFIC),
          metrics: [
            { fn: 'sum', field: 'entries', as: 'entries' },
            { fn: 'sum', field: 'unique_visitors', as: 'unique' },
            { fn: 'avg', field: 'dwell_median_s', as: 'avg_dwell' },
          ], limit: 1 },
        { name: 'by_dept', sourceRef: src(TRAFFIC),
          groupBy: ['zone_name'],
          metrics: [
            { fn: 'sum', field: 'entries', as: 'entries' },
            { fn: 'sum', field: 'unique_visitors', as: 'unique' },
            { fn: 'avg', field: 'dwell_median_s', as: 'avg_dwell' },
          ],
          sort: [{ field: 'entries', dir: 'desc' }] },
        { name: 'by_bucket', sourceRef: src(TRAFFIC),
          groupBy: ['ts_bucket'],
          metrics: [{ fn: 'sum', field: 'entries', as: 'entries' }],
          sort: [{ field: 'ts_bucket', dir: 'asc' }] },
        { name: 'listing', sourceRef: src(TRAFFIC),
          sort: [{ field: 'ts_bucket', dir: 'desc' }, { field: 'zone_name', dir: 'asc' }],
          limit: 500 },
      ],
      layout: { kind: 'grid' },
      widgets: [
        kpi('k_e', 'Total entries', 'totals', 'entries', 'blue', 0, 0),
        kpi('k_u', 'Unique visitors', 'totals', 'unique', 'purple', 3, 0),
        kpi('k_d', 'Avg dwell (s)', 'totals', 'avg_dwell', 'emerald', 6, 0),
        chart('c_dept', 'bar', 'Entries by department', 'by_dept', 'zone_name', ['entries'], 0, 2, 6, 6),
        chart('c_dwell', 'bar', 'Avg dwell by department (s)', 'by_dept', 'zone_name', ['avg_dwell'], 6, 2, 6, 6),
        chart('c_time', 'line', 'Entries over time (5-min buckets)', 'by_bucket', 'ts_bucket', ['entries'], 0, 8, 12, 6),
        table('tbl', 'Traffic log', 'listing',
          ['bucket_id', 'zone_name', 'ts_bucket', 'entries', 'exits', 'unique_visitors', 'dwell_median_s'],
          0, 14, 12, 8,
          {
            zone_name: { chip: true },
            ts_bucket: { format: 'date' },
            entries: { align: 'right', footer: 'sum' },
            exits: { align: 'right', footer: 'sum' },
            unique_visitors: { align: 'right', footer: 'sum' },
            dwell_median_s: { align: 'right' },
          },
        ),
      ],
    },
  },

  // ==========================================================================
  // 8. Safety Compliance — Safety Assets
  // ==========================================================================
  {
    name: 'Safety Compliance',
    description: 'Fire-extinguisher and first-aid registry — inspection status, pressure readings, due dates.',
    icon: 'shield-check',
    color: '#ef4444',
    spec: {
      v: 2, reportType: 'summary',
      sources: [src(SAFETY)],
      queries: [
        { name: 'totals', sourceRef: src(SAFETY),
          metrics: [{ fn: 'count', as: 'assets' }], limit: 1 },
        { name: 'compliant', sourceRef: src(SAFETY),
          filters: { cond: { field: 'status', op: 'eq', value: 'compliant' } },
          metrics: [{ fn: 'count', as: 'compliant' }], limit: 1 },
        { name: 'due_soon', sourceRef: src(SAFETY),
          filters: { cond: { field: 'status', op: 'eq', value: 'due-soon' } },
          metrics: [{ fn: 'count', as: 'due_soon' }], limit: 1 },
        { name: 'by_type', sourceRef: src(SAFETY),
          groupBy: ['asset_type'],
          metrics: [{ fn: 'count', as: 'assets' }],
          sort: [{ field: 'assets', dir: 'desc' }] },
        { name: 'by_status', sourceRef: src(SAFETY),
          groupBy: ['status'],
          metrics: [{ fn: 'count', as: 'assets' }],
          sort: [{ field: 'assets', dir: 'desc' }] },
        { name: 'listing', sourceRef: src(SAFETY),
          sort: [{ field: 'next_due', dir: 'asc' }] },
      ],
      layout: { kind: 'grid' },
      widgets: [
        kpi('k_a', 'Assets', 'totals', 'assets', 'blue', 0, 0),
        kpi('k_c', 'Compliant', 'compliant', 'compliant', 'emerald', 3, 0),
        kpi('k_d', 'Due soon', 'due_soon', 'due_soon', 'amber', 6, 0),
        chart('c_status', 'donut', 'Status mix', 'by_status', 'status', ['assets'], 0, 2, 6, 6),
        chart('c_type', 'bar', 'Assets by type', 'by_type', 'asset_type', ['assets'], 6, 2, 6, 6),
        table('tbl', 'Registry', 'listing',
          ['asset_id', 'asset_name', 'asset_type', 'location_zone', 'status', 'last_inspection', 'next_due', 'inspector', 'pressure_psi'],
          0, 8, 12, 10,
          {
            asset_type: { chip: true },
            location_zone: { chip: true },
            status: { chip: true, align: 'center' },
            last_inspection: { format: 'date' },
            next_due: { format: 'date' },
            pressure_psi: { align: 'right' },
          },
        ),
      ],
    },
  },

  // ==========================================================================
  // 9. Receiving Activity — Deliveries
  // ==========================================================================
  {
    name: 'Receiving Activity',
    description: 'Inbound deliveries at the receiving dock — supplier mix, pallet throughput, dock utilization.',
    icon: 'truck',
    color: '#6366f1',
    spec: {
      v: 2, reportType: 'summary',
      sources: [src(DELIVERIES)],
      queries: [
        { name: 'totals', sourceRef: src(DELIVERIES),
          metrics: [
            { fn: 'count', as: 'deliveries' },
            { fn: 'sum', field: 'pallets', as: 'pallets' },
            { fn: 'sum', field: 'weight_kg', as: 'weight' },
            { fn: 'avg', field: 'weight_kg', as: 'avg_wt' },
          ], limit: 1 },
        { name: 'by_supplier', sourceRef: src(DELIVERIES),
          groupBy: ['supplier'],
          metrics: [
            { fn: 'count', as: 'deliveries' },
            { fn: 'sum', field: 'pallets', as: 'pallets' },
          ],
          sort: [{ field: 'deliveries', dir: 'desc' }] },
        { name: 'by_dock', sourceRef: src(DELIVERIES),
          groupBy: ['dock_bay'],
          metrics: [
            { fn: 'count', as: 'deliveries' },
            { fn: 'sum', field: 'pallets', as: 'pallets' },
          ],
          sort: [{ field: 'dock_bay', dir: 'asc' }] },
        { name: 'by_status', sourceRef: src(DELIVERIES),
          groupBy: ['status'],
          metrics: [{ fn: 'count', as: 'deliveries' }],
          sort: [{ field: 'deliveries', dir: 'desc' }] },
        { name: 'listing', sourceRef: src(DELIVERIES),
          sort: [{ field: 'ts', dir: 'desc' }] },
      ],
      layout: { kind: 'grid' },
      widgets: [
        kpi('k_d', 'Deliveries', 'totals', 'deliveries', 'blue', 0, 0),
        kpi('k_p', 'Pallets', 'totals', 'pallets', 'emerald', 3, 0),
        kpi('k_w', 'Weight (kg)', 'totals', 'weight', 'purple', 6, 0),
        kpi('k_avg', 'Avg (kg)', 'totals', 'avg_wt', 'amber', 9, 0),
        chart('c_sup', 'bar', 'Deliveries by supplier', 'by_supplier', 'supplier', ['deliveries'], 0, 2, 6, 6),
        chart('c_dock', 'bar', 'Pallets by dock bay', 'by_dock', 'dock_bay', ['pallets'], 6, 2, 6, 6),
        chart('c_status', 'donut', 'Status mix', 'by_status', 'status', ['deliveries'], 0, 8, 6, 6),
        table('tbl', 'Recent deliveries', 'listing',
          ['delivery_id', 'supplier', 'ts', 'dock_bay', 'pallets', 'sku_count', 'weight_kg', 'status', 'received_by', 'po_number'],
          0, 14, 12, 8,
          {
            supplier: { chip: true },
            ts: { format: 'date' },
            dock_bay: { chip: true, align: 'center' },
            pallets: { align: 'right', footer: 'sum' },
            sku_count: { align: 'right' },
            weight_kg: { align: 'right', format: 'number', footer: 'sum' },
            status: { chip: true },
          },
        ),
      ],
    },
  },

  // ==========================================================================
  // 10. Active Promotions — Promotions
  // ==========================================================================
  {
    name: 'Active Promotions',
    description: 'In-store offers — discount depth, department mix, expiring promos.',
    icon: 'tag',
    color: '#f97316',
    spec: {
      v: 2, reportType: 'summary',
      sources: [src(PROMOTIONS)],
      queries: [
        { name: 'totals', sourceRef: src(PROMOTIONS),
          metrics: [
            { fn: 'count', as: 'promos' },
            { fn: 'avg', field: 'discount_pct', as: 'avg_discount' },
            { fn: 'max', field: 'discount_pct', as: 'max_discount' },
          ], limit: 1 },
        { name: 'active', sourceRef: src(PROMOTIONS),
          filters: { cond: { field: 'active', op: 'eq', value: true } },
          metrics: [{ fn: 'count', as: 'active' }], limit: 1 },
        { name: 'by_type', sourceRef: src(PROMOTIONS),
          groupBy: ['promo_type'],
          metrics: [
            { fn: 'count', as: 'promos' },
            { fn: 'avg', field: 'discount_pct', as: 'avg_discount' },
          ],
          sort: [{ field: 'promos', dir: 'desc' }] },
        { name: 'by_dept', sourceRef: src(PROMOTIONS),
          groupBy: ['department'],
          metrics: [
            { fn: 'count', as: 'promos' },
            { fn: 'avg', field: 'discount_pct', as: 'avg_discount' },
          ],
          sort: [{ field: 'promos', dir: 'desc' }] },
        { name: 'listing', sourceRef: src(PROMOTIONS),
          sort: [{ field: 'end_date', dir: 'asc' }] },
      ],
      layout: { kind: 'grid' },
      widgets: [
        kpi('k_p', 'Total promos', 'totals', 'promos', 'blue', 0, 0),
        kpi('k_a', 'Active', 'active', 'active', 'emerald', 3, 0),
        kpi('k_d', 'Avg discount %', 'totals', 'avg_discount', 'amber', 6, 0),
        kpi('k_m', 'Max discount %', 'totals', 'max_discount', 'purple', 9, 0),
        chart('c_type', 'donut', 'Promos by type', 'by_type', 'promo_type', ['promos'], 0, 2, 6, 6),
        chart('c_dept', 'bar', 'Avg discount by department', 'by_dept', 'department', ['avg_discount'], 6, 2, 6, 6),
        chart('c_deptc', 'bar', 'Promos by department', 'by_dept', 'department', ['promos'], 0, 8, 12, 6),
        table('tbl', 'Promo details', 'listing',
          ['promo_id', 'sku', 'product_name', 'department', 'promo_type', 'discount_pct', 'original_price', 'sale_price', 'start_date', 'end_date', 'active'],
          0, 14, 12, 8,
          {
            department: { chip: true },
            promo_type: { chip: true },
            discount_pct: { align: 'right', format: 'number' },
            original_price: { align: 'right', format: 'currency' },
            sale_price: { align: 'right', format: 'currency' },
            start_date: { format: 'date' },
            end_date: { format: 'date' },
            active: { chip: true, align: 'center' },
          },
        ),
      ],
    },
  },

  // ==========================================================================
  // 11. Workforce Roster — Employees
  // ==========================================================================
  {
    name: 'Workforce Roster',
    description: 'Full staff roster — role mix, shift coverage, and current-zone assignment.',
    icon: 'users',
    color: '#8b5cf6',
    spec: {
      v: 2, reportType: 'summary',
      sources: [src(EMPLOYEES)],
      queries: [
        { name: 'totals', sourceRef: src(EMPLOYEES),
          metrics: [
            { fn: 'count', as: 'employees' },
            { fn: 'countDistinct', field: 'role', as: 'roles' },
          ], limit: 1 },
        { name: 'on_shift', sourceRef: src(EMPLOYEES),
          filters: { cond: { field: 'on_shift', op: 'eq', value: true } },
          metrics: [{ fn: 'count', as: 'active' }], limit: 1 },
        { name: 'by_role', sourceRef: src(EMPLOYEES),
          groupBy: ['role'],
          metrics: [{ fn: 'count', as: 'staff' }],
          sort: [{ field: 'staff', dir: 'desc' }] },
        { name: 'by_shift', sourceRef: src(EMPLOYEES),
          groupBy: ['shift'],
          metrics: [{ fn: 'count', as: 'staff' }],
          sort: [{ field: 'staff', dir: 'desc' }] },
        { name: 'by_zone', sourceRef: src(EMPLOYEES),
          groupBy: ['current_zone'],
          metrics: [{ fn: 'count', as: 'staff' }],
          sort: [{ field: 'staff', dir: 'desc' }] },
        { name: 'listing', sourceRef: src(EMPLOYEES),
          sort: [{ field: 'role', dir: 'asc' }, { field: 'name', dir: 'asc' }] },
      ],
      layout: { kind: 'grid' },
      widgets: [
        kpi('k_t', 'Employees', 'totals', 'employees', 'blue', 0, 0),
        kpi('k_a', 'On shift', 'on_shift', 'active', 'emerald', 3, 0),
        kpi('k_r', 'Distinct roles', 'totals', 'roles', 'purple', 6, 0),
        chart('c_role', 'bar', 'Staff by role', 'by_role', 'role', ['staff'], 0, 2, 6, 6),
        chart('c_shift', 'donut', 'Staff by shift', 'by_shift', 'shift', ['staff'], 6, 2, 6, 6),
        chart('c_zone', 'bar', 'Staff by current zone', 'by_zone', 'current_zone', ['staff'], 0, 8, 12, 6),
        table('tbl', 'Roster', 'listing',
          ['employee_id', 'name', 'role', 'shift', 'home_department', 'current_zone', 'on_shift', 'picks_today', 'transactions_today', 'last_active'],
          0, 14, 12, 8,
          {
            role: { chip: true },
            shift: { chip: true },
            home_department: { chip: true },
            current_zone: { chip: true },
            on_shift: { chip: true, align: 'center' },
            picks_today: { align: 'right' },
            transactions_today: { align: 'right' },
            last_active: { format: 'date' },
          },
        ),
      ],
    },
  },
]

// ---------- SQL builder --------------------------------------------------

const sqStr = (s) => `'${String(s).replace(/'/g, "''")}'`
const jsonLit = (o) => sqStr(JSON.stringify(o))

const stmts = ['BEGIN;']
const names = REPORTS.map((r) => sqStr(r.name)).join(', ')
stmts.push(`DELETE FROM reports WHERE tenant_id = ${TENANT_ID} AND zone_id = ${ZONE_ID} AND name IN (${names});`)

for (const r of REPORTS) {
  stmts.push('')
  stmts.push(`-- ${r.name}`)
  stmts.push(`INSERT INTO reports (tenant_id, zone_id, name, description, icon, color, spec, spec_version, is_archived)
    VALUES (${TENANT_ID}, ${ZONE_ID}, ${sqStr(r.name)}, ${sqStr(r.description)}, ${sqStr(r.icon)}, ${sqStr(r.color)}, ${jsonLit(r.spec)}::jsonb, 2, FALSE);`)
}
stmts.push('COMMIT;')

const sql = stmts.join('\n') + '\n'
writeFileSync(SQL_OUT, sql, 'utf8')
console.log(`generated ${SQL_OUT} — ${sql.length.toLocaleString()} bytes`)

const psql = spawnSync('psql', [DSN, '-v', 'ON_ERROR_STOP=1', '-f', SQL_OUT], {
  stdio: 'inherit', encoding: 'utf8',
})
if (psql.status !== 0) {
  console.error(`psql exited ${psql.status}`)
  process.exit(psql.status ?? 1)
}
console.log(`seed complete ✓ — ${REPORTS.length} reports`)
