/**
 * Fetch and cache field schemas for any tenant data source. The
 * wizard needs this in three places today:
 *   - Widgets step, when a widget picks a source override
 *   - Filters step, for the report's own source
 *   - Aggregations step, for group-by / metric field pickers
 *
 * Cache lives at module scope so switching between wizard steps
 * doesn't re-fetch. Cache is intentionally not invalidated on schema
 * mutations elsewhere — a full page reload picks those up. The wizard
 * doesn't mutate source schemas.
 */
import { useEffect, useState } from 'react'
import {
  getReportSourceSchema,
  type ReportSourceSchema,
} from '@/lib/reports-client'

type CacheEntry =
  | { status: 'loading'; promise: Promise<ReportSourceSchema> }
  | { status: 'ok'; schema: ReportSourceSchema }
  | { status: 'error'; error: string }

const cache = new Map<number, CacheEntry>()

/** Fetch the schema for one source id. Returns `{schema, loading, error}`.
 *  `null` id short-circuits to `{schema: null}`. */
export function useSourceSchema(sourceId: number | null | undefined): {
  schema: ReportSourceSchema | null
  loading: boolean
  error: string | null
} {
  // The module cache is the source of truth; `settled` only records the
  // outcome this instance waited on (keyed by id) so it re-renders when
  // the fetch lands. Anything not yet settled for this id reads as loading.
  const [settled, setSettled] = useState<{ key: number; entry: CacheEntry } | null>(null)

  useEffect(() => {
    if (typeof sourceId !== 'number' || sourceId <= 0) return
    const cached = cache.get(sourceId)
    if (cached?.status === 'ok' || cached?.status === 'error') return
    let cancelled = false
    let promise: Promise<ReportSourceSchema>
    if (cached?.status === 'loading') {
      // Another consumer already started this fetch and will write the
      // outcome into the cache — just wait on it.
      promise = cached.promise
    } else {
      promise = getReportSourceSchema(sourceId)
      cache.set(sourceId, { status: 'loading', promise })
      promise.then(
        (schema) => cache.set(sourceId, { status: 'ok', schema }),
        (err) => cache.set(sourceId, { status: 'error', error: (err as Error).message }),
      )
    }
    promise
      .then((schema) => {
        if (!cancelled) setSettled({ key: sourceId, entry: { status: 'ok', schema } })
      })
      .catch((err) => {
        if (!cancelled) setSettled({ key: sourceId, entry: { status: 'error', error: (err as Error).message } })
      })
    return () => {
      cancelled = true
    }
  }, [sourceId])

  if (typeof sourceId !== 'number' || sourceId <= 0) return { schema: null, loading: false, error: null }
  const entry = settled?.key === sourceId ? settled.entry : cache.get(sourceId)
  if (!entry || entry.status === 'loading') return { schema: null, loading: true, error: null }
  if (entry.status === 'error') return { schema: null, loading: false, error: entry.error }
  return { schema: entry.schema, loading: false, error: null }
}

/** Schemas for several sources at once (same module cache). Entries
 *  appear as each fetch lands; failed ones are left out. */
export function useSourceSchemas(sourceIds: readonly number[]): Record<number, ReportSourceSchema> {
  const key = [...new Set(sourceIds.filter((id) => id > 0))].sort((a, b) => a - b).join(',')
  const [, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    for (const id of key ? key.split(',').map(Number) : []) {
      const cached = cache.get(id)
      if (cached?.status === 'ok' || cached?.status === 'error') continue
      let promise: Promise<ReportSourceSchema>
      if (cached?.status === 'loading') promise = cached.promise
      else {
        promise = getReportSourceSchema(id)
        cache.set(id, { status: 'loading', promise })
        promise.then(
          (schema) => cache.set(id, { status: 'ok', schema }),
          (err) => cache.set(id, { status: 'error', error: (err as Error).message }),
        )
      }
      promise.then(
        () => !cancelled && setTick((n) => n + 1),
        () => !cancelled && setTick((n) => n + 1),
      )
    }
    return () => {
      cancelled = true
    }
  }, [key])
  const out: Record<number, ReportSourceSchema> = {}
  for (const id of key ? key.split(',').map(Number) : []) {
    const entry = cache.get(id)
    if (entry?.status === 'ok') out[id] = entry.schema
  }
  return out
}

/** One source's schema as a promise (same module cache) — for click
 *  handlers that need the fields before they can act. */
export function loadSourceSchema(sourceId: number): Promise<ReportSourceSchema> {
  const cached = cache.get(sourceId)
  if (cached?.status === 'ok') return Promise.resolve(cached.schema)
  if (cached?.status === 'loading') return cached.promise
  const promise = getReportSourceSchema(sourceId)
  cache.set(sourceId, { status: 'loading', promise })
  promise.then(
    (schema) => cache.set(sourceId, { status: 'ok', schema }),
    (err) => cache.set(sourceId, { status: 'error', error: (err as Error).message }),
  )
  return promise
}
