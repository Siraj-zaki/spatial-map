/**
 * Structural sharing for a layer's rows across refetches.
 *
 * Every refetch of `layer-rows` produces brand-new row objects — and after
 * a `data-sources` SSE invalidation the query cache hands them over even
 * when nothing changed (the invalidation dropped the entry the equality
 * check compares against). Every downstream memo, the per-row feature
 * cache and the source diff then saw "every row changed".
 *
 * `shareRows(prev, next)` returns `prev` itself when `next` holds the same
 * rows in the same order, and otherwise a list that reuses `prev`'s object
 * for every row that is deep-equal to its counterpart. Deep-equal is strict
 * — key order, every field, Dates by time — so a reused object is
 * indistinguishable from the fresh one to anything that reads it.
 */

import { useState } from 'react'
import type { EntityState } from '@/lib/db'

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a === 'number') return Number.isNaN(a) && Number.isNaN(b as number)
  if (a === null || b === null || typeof a !== 'object') return false
  const aDate = a instanceof Date
  const bDate = b instanceof Date
  if (aDate || bDate) {
    return aDate && bDate && Object.is((a as Date).getTime(), (b as Date).getTime())
  }
  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) {
    const x = a as unknown[]
    const y = b as unknown[]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (!sameValue(x[i], y[i])) return false
    return true
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (let i = 0; i < ka.length; i++) {
    // Same keys in the same order: payload key order shows in tooltips and
    // in the stringified payload stamped on each feature.
    if (ka[i] !== kb[i]) return false
    if (!sameValue((a as Record<string, unknown>)[ka[i]!], (b as Record<string, unknown>)[kb[i]!])) {
      return false
    }
  }
  return true
}

/**
 * `next` with every unchanged row replaced by its `prev` object; `prev`
 * itself when nothing changed. Rows pair up by entity key and occurrence
 * (history lists repeat a key once per event).
 */
export function shareRows<T extends EntityState>(
  prev: readonly T[] | undefined,
  next: readonly T[] | undefined,
): readonly T[] | undefined {
  if (!prev || !next || prev === next) return next
  const byKey = new Map<string, T[]>()
  for (const row of prev) {
    const list = byKey.get(row.entityKey)
    if (list) list.push(row)
    else byKey.set(row.entityKey, [row])
  }
  const seen = new Map<string, number>()
  let reused = 0
  let samePositions = prev.length === next.length
  const out: T[] = new Array(next.length)
  for (let i = 0; i < next.length; i++) {
    const row = next[i]!
    const n = seen.get(row.entityKey) ?? 0
    seen.set(row.entityKey, n + 1)
    const candidate = byKey.get(row.entityKey)?.[n]
    if (candidate !== undefined && sameValue(candidate, row)) {
      out[i] = candidate
      reused++
    } else {
      out[i] = row
    }
    if (samePositions && out[i] !== prev[i]) samePositions = false
  }
  if (samePositions) return prev
  return reused === 0 ? next : out
}

/**
 * Hook form: the rows a component should render, sharing objects with what
 * it rendered last time. Derived-state pattern (setState during render on
 * input change), so no effect and no extra commit.
 */
export function useSharedRows<T extends EntityState>(
  rows: readonly T[] | undefined,
): readonly T[] | undefined {
  const [held, setHeld] = useState<{ input: readonly T[] | undefined; output: readonly T[] | undefined }>(
    () => ({ input: rows, output: rows }),
  )
  if (held.input !== rows) {
    const output = shareRows(held.output, rows)
    setHeld({ input: rows, output })
    return output
  }
  return held.output
}
