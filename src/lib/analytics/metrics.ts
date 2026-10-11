/**
 * Pure analytics over the bin / grid / zone tables.
 *
 * Every function takes the raw rows the route is already querying and
 * returns plain values — no Dexie reads, no React hooks. That keeps the
 * surface easy to test and lets the dashboard memoize freely.
 */

import type { Bin, BinStatus, Grid, Zone } from '@/lib/db'

/** Aggregate status counts across the bins set. */
export interface StatusBreakdown {
  empty: number
  occupied: number
  reserved: number
  unset: number
  total: number
}

export function statusBreakdown(bins: ReadonlyArray<Bin>): StatusBreakdown {
  const out: StatusBreakdown = {
    empty: 0,
    occupied: 0,
    reserved: 0,
    unset: 0,
    total: bins.length,
  }
  for (const b of bins) {
    if (b.status === undefined) out.unset++
    else out[b.status]++
  }
  return out
}

/** Capacity sum + count by status. Useful for "how full are the occupied bins?". */
export interface CapacitySummary {
  totalCapacity: number
  withCapacityCount: number
  /** Mean capacity over bins that have a numeric capacity. */
  meanCapacity: number
}

export function capacitySummary(bins: ReadonlyArray<Bin>): CapacitySummary {
  let total = 0
  let count = 0
  for (const b of bins) {
    if (typeof b.capacity === 'number' && Number.isFinite(b.capacity)) {
      total += b.capacity
      count++
    }
  }
  return {
    totalCapacity: total,
    withCapacityCount: count,
    meanCapacity: count > 0 ? total / count : 0,
  }
}

/** One row in the per-warehouse rollup table. */
export interface WarehouseRollup {
  zone: Zone
  rackCount: number
  binCount: number
  occupiedCount: number
  reservedCount: number
  emptyCount: number
  capacityTotal: number
  occupiedPct: number
}

export function rollupByWarehouse(
  zones: ReadonlyArray<Zone>,
  grids: ReadonlyArray<Grid>,
  bins: ReadonlyArray<Bin>,
): WarehouseRollup[] {
  const gridIndex = new Map<number, Grid>()
  for (const g of grids) if (g.id !== undefined) gridIndex.set(g.id, g)

  // Build a (zoneId → list of grid ids) lookup once so we don't rescan
  // grids per warehouse.
  const gridsByZone = new Map<number | undefined, number[]>()
  for (const g of grids) {
    if (g.id === undefined) continue
    const list = gridsByZone.get(g.zoneId) ?? []
    list.push(g.id)
    gridsByZone.set(g.zoneId, list)
  }

  // Pre-bucket bins by grid id so each warehouse can fold its rows in
  // O(racks).
  const binsByGrid = new Map<number, Bin[]>()
  for (const b of bins) {
    if (b.targetKind !== 'grid-cell') continue
    if (b.gridId === undefined) continue
    const list = binsByGrid.get(b.gridId) ?? []
    list.push(b)
    binsByGrid.set(b.gridId, list)
  }

  return zones.map((zone) => {
    const rackIds = gridsByZone.get(zone.id) ?? []
    let binCount = 0
    let occupied = 0
    let reserved = 0
    let empty = 0
    let capacityTotal = 0
    for (const rid of rackIds) {
      const list = binsByGrid.get(rid) ?? []
      for (const b of list) {
        binCount++
        if (b.status === 'occupied') occupied++
        else if (b.status === 'reserved') reserved++
        else empty++
        if (typeof b.capacity === 'number' && Number.isFinite(b.capacity)) {
          capacityTotal += b.capacity
        }
      }
    }
    return {
      zone,
      rackCount: rackIds.length,
      binCount,
      occupiedCount: occupied,
      reservedCount: reserved,
      emptyCount: empty,
      capacityTotal,
      occupiedPct: binCount > 0 ? occupied / binCount : 0,
    }
  })
}

/** Map a bin status string to a stable label for charts. */
export function statusLabel(status: BinStatus | undefined): string {
  if (status === 'occupied') return 'Occupied'
  if (status === 'reserved') return 'Reserved'
  if (status === 'empty') return 'Empty'
  return 'Unset'
}

/** Tailwind-friendly colour per status, matching the rest of the app. */
export function statusColor(status: BinStatus | 'unset'): string {
  switch (status) {
    case 'occupied': return '#3b82f6' // blue-500
    case 'reserved': return '#f59e0b' // amber-500
    case 'empty':    return '#94a3b8' // slate-400
    case 'unset':    return '#d1d5db' // gray-300
  }
}
