/**
 * "Dead stock" detector.
 *
 * A bin is dead stock when it carries inventory data but hasn't been
 * touched in a while. The default threshold is 30 days — anything that
 * the WMS hasn't reported on for that long is worth surfacing for a
 * cycle count / write-off / repick decision.
 *
 * The check looks at three signals:
 *   1. `lastSyncedAt` — when external data last refreshed this bin
 *   2. `bin.updatedAt`  — when a user last edited this bin row
 *   3. capacity / sku   — bins with no inventory are skipped (not "dead",
 *                          just empty)
 *
 * We pick the *latest* of (1) and (2) as the freshness mark.
 */

import type { Bin } from '@/lib/db'

export interface DeadStockOptions {
  /** Window in milliseconds. Bins fresher than this are excluded. Default 30d. */
  staleMs?: number
  /**
   * When true (default) a bin with no `sku` AND no positive `capacity`
   * isn't dead stock — it's an empty slot. The user can flip this off
   * for stricter audits (e.g. "show me everything that hasn't synced
   * regardless of inventory").
   */
  ignoreEmptyBins?: boolean
}

export interface DeadStockEntry {
  bin: Bin
  /** Latest of lastSyncedAt + updatedAt. */
  freshnessMs: number
  ageMs: number
}

const DEFAULT_STALE_MS = 30 * 24 * 60 * 60 * 1000 // 30d

export function findDeadStock(
  bins: ReadonlyArray<Bin>,
  opts: DeadStockOptions = {},
): DeadStockEntry[] {
  const stale = opts.staleMs ?? DEFAULT_STALE_MS
  const ignoreEmpty = opts.ignoreEmptyBins ?? true
  const now = Date.now()
  const out: DeadStockEntry[] = []
  for (const bin of bins) {
    if (ignoreEmpty && !hasInventory(bin)) continue
    const freshness = freshnessOf(bin)
    if (freshness === null) continue // never touched — not actionable
    const age = now - freshness
    if (age < stale) continue
    out.push({ bin, freshnessMs: freshness, ageMs: age })
  }
  // Newest stale entries first so the user works the freshest backlog.
  return out.sort((a, b) => b.ageMs - a.ageMs)
}

function hasInventory(bin: Bin): boolean {
  if (typeof bin.capacity === 'number' && bin.capacity > 0) return true
  if (typeof bin.sku === 'string' && bin.sku.trim() !== '') return true
  if (bin.status === 'occupied' || bin.status === 'reserved') return true
  return false
}

function freshnessOf(bin: Bin): number | null {
  const sync = bin.lastSyncedAt instanceof Date ? bin.lastSyncedAt.getTime() : NaN
  const updated = bin.updatedAt instanceof Date ? bin.updatedAt.getTime() : NaN
  const candidates = [sync, updated].filter((n) => Number.isFinite(n)) as number[]
  if (candidates.length === 0) return null
  return Math.max(...candidates)
}

/** Format a duration in ms as "5d 3h", "12h", "44m" — for the table row. */
export function formatAge(ms: number): string {
  const day = Math.floor(ms / 86_400_000)
  const hour = Math.floor((ms % 86_400_000) / 3_600_000)
  const min = Math.floor((ms % 3_600_000) / 60_000)
  if (day > 0) return hour > 0 ? `${day}d ${hour}h` : `${day}d`
  if (hour > 0) return min > 0 ? `${hour}h ${min}m` : `${hour}h`
  return `${min}m`
}
