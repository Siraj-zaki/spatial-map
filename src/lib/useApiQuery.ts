import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseApiQueryOptions {
  /**
   * Polling interval in milliseconds. Defaults to 30000 (30s) for catalog
   * data. Set to 0 to disable polling entirely.
   */
  intervalMs?: number
  /** Disable fetching when false. */
  enabled?: boolean
  /**
   * If true, the poll interval is extended while the result set is empty.
   * Useful for tables that start empty and only get rows later.
   */
  slowWhenEmpty?: boolean
}

export interface UseApiQueryResult<T> {
  data: T | undefined
  error: Error | null
  isLoading: boolean
  /** Trigger a manual refresh. */
  mutate: () => void
}

interface CacheEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  ts: number
}

const cache = new Map<string, CacheEntry>()
const listeners = new Set<(prefix: string) => void>()

function buildKey(deps: unknown[]): string {
  return JSON.stringify(deps)
}

// Batches synchronous invalidate broadcasts into a single microtask.
// Without this, N callers invalidating the same prefix in one tick
// woke every subscriber N times — 4 useModelAssets() subscribers × 3
// migration writes gave the classic "user-models fetched 11 times"
// pageload symptom. Cache entries are still dropped synchronously
// (a `get()` right after `invalidate()` still returns undefined) —
// only the listener notifications coalesce.
const pendingBroadcasts = new Set<string>()
let broadcastScheduled = false
function scheduleBroadcast() {
  if (broadcastScheduled) return
  broadcastScheduled = true
  queueMicrotask(() => {
    broadcastScheduled = false
    const prefixes = Array.from(pendingBroadcasts)
    pendingBroadcasts.clear()
    for (const prefix of prefixes) {
      listeners.forEach((cb) => cb(prefix))
    }
  })
}

export const queryCache = {
  set<T>(key: string, data: T): void {
    cache.set(key, { data, ts: Date.now() })
  },
  get<T>(key: string): T | undefined {
    return cache.get(key)?.data as T | undefined
  },
  has(key: string): boolean {
    return cache.has(key)
  },
  /**
   * Drop every cache entry whose key starts with the namespace prefix.
   * Callers should put the table/namespace as the first dep, e.g.
   * `['tenants', tenantId]`, and invalidate with `queryCache.invalidate('tenants')`.
   *
   * Cache deletion is synchronous; subscriber notifications are batched
   * into a microtask so N sync invalidations for the same prefix fire
   * the subscribers exactly once.
   */
  invalidate(prefix: string): void {
    for (const key of cache.keys()) {
      try {
        const parsed = JSON.parse(key) as unknown[]
        if (parsed[0] === prefix) {
          cache.delete(key)
        }
      } catch {
        // Ignore keys that are not JSON arrays.
      }
    }
    pendingBroadcasts.add(prefix)
    scheduleBroadcast()
  },
  invalidateAll(): void {
    cache.clear()
    pendingBroadcasts.add('')
    scheduleBroadcast()
  },
  subscribe(cb: (prefix: string) => void): () => void {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
}

/**
 * SWR-style hook that polls a backend fetcher and caches the result.
 * The cache key is derived from `deps`, so changing the tenant id or query
 * params automatically re-fetches. Mutations can invalidate a namespace via
 * `queryCache.invalidate('namespace')` to force dependent hooks to refresh.
 *
 * Note: this hook intentionally calls setState inside effects to keep the
 * cache and loading state in sync with the external backend. Disabling the
 * related lint rule is standard for low-level data-fetching hooks.
 */

/**
 * Deep-equality gate for fetch results. Every 30 s poll would otherwise
 * hand the same data over as a NEW reference — downstream effects that
 * depend on `query.data` (map overlays, GeoJSON pushes, feature stamps)
 * would then re-run for no visual change. One JSON.stringify compare
 * costs microseconds; the map re-layouts it saves cost tens of ms per
 * layer per tick.
 *
 * The cache is still updated on the first fetch (queryCache.has(key)
 * false path) so downstream consumers get the initial data reference.
 * On subsequent identical fetches we keep the existing cache entry
 * (preserves reference identity for downstream memoization) but we
 * STILL call setData with that cached value.
 *
 * Why setData unconditionally: two components using the same query
 * key each spin up their own useState. If component A's fetch resolves
 * first, it sets the cache + its own state. Component B's fetch then
 * resolves — cache is already populated with equal data, so the old
 * behaviour was to `return` early. That skipped B's setData entirely,
 * leaving B's local `data` at `undefined` forever even though the
 * cache had the payload. Symptom: whichever hook lost the race
 * silently rendered as if data never arrived, only recovering after
 * a component unmount + remount (which re-reads from the cache on
 * useState init).
 *
 * React deduplicates same-reference state updates automatically, so
 * calling setData with the cached (stable) value is a no-op for
 * hooks that already have it and a corrective update for the ones
 * that don't.
 */
function applyResult<T>(
  key: string,
  result: T,
  setData: (v: T | undefined) => void,
): void {
  const prev = queryCache.get<T>(key)
  const isNewValue = !queryCache.has(key) || !stableEqual(prev, result)
  if (isNewValue) {
    queryCache.set(key, result)
  }
  // Read the (now possibly-updated) cache entry so every consumer
  // converges on the SAME reference for equal payloads — downstream
  // useMemos keyed on this value can then skip their recomputes.
  setData(queryCache.get<T>(key))
}

// In-flight fetch dedup — N subscribers to the same query key share a
// single HTTP call instead of racing N parallel requests. Fixes the
// "useModelAssets fetched 11 times" pageload symptom: 4 subscribers ×
// 3 invalidation events = 12 fetches becomes 3.
const inflight = new Map<string, Promise<unknown>>()
function dedupedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined
  if (existing) return existing
  const promise = fetcher().finally(() => {
    // Only clear if this is still the current in-flight. A caller may
    // have invalidated during the fetch and started a fresh one.
    if (inflight.get(key) === promise) inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

/**
 * Cheap-then-thorough equality. Fast path handles the common cases
 * (undefined, null, primitives, same reference). Falls through to
 * JSON.stringify for structural compare on plain objects / arrays.
 * Not suitable for values with Dates / Maps / Sets — those still
 * cascade, which is fine because they're rare in API responses.
 */
function stableEqual<T>(a: T | undefined, b: T | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a === null || b === null) return a === b
  const ta = typeof a
  const tb = typeof b
  if (ta !== tb) return false
  if (ta !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/* eslint-disable react-hooks/set-state-in-effect */
export function useApiQuery<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  options: UseApiQueryOptions = {},
): UseApiQueryResult<T> {
  const key = buildKey(deps)
  const baseIntervalMs = options.intervalMs ?? 30000
  const enabled = options.enabled ?? true
  const slowWhenEmpty = options.slowWhenEmpty ?? true

  const [data, setData] = useState<T | undefined>(() => queryCache.get<T>(key))
  const [error, setError] = useState<Error | null>(null)
  const [isLoading, setIsLoading] = useState(!queryCache.has(key))

  const fetcherRef = useRef(fetcher)
  useEffect(() => {
    fetcherRef.current = fetcher
  }, [fetcher])

  const isEmptyResult = useCallback((result: T): boolean => {
    if (result === undefined || result === null) return true
    if (Array.isArray(result)) return result.length === 0
    return false
  }, [])

  const run = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await dedupedFetch(key, () => fetcherRef.current())
      if (signal?.aborted) return
      applyResult(key, result, setData)
      setError(null)
    } catch (err) {
      if (signal?.aborted) return
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (!signal?.aborted) setIsLoading(false)
    }
  }, [key])

  // Initial fetch + polling.
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let intervalId: ReturnType<typeof setInterval> | null = null
    let cancelled = false

    const execute = async () => {
      if (document.hidden) return
      try {
        const result = await dedupedFetch(key, () => fetcherRef.current())
        if (cancelled || controller.signal.aborted) return
        applyResult(key, result, setData)
        setError(null)
      } catch (err) {
        if (cancelled || controller.signal.aborted) return
        setError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        if (!cancelled && !controller.signal.aborted) setIsLoading(false)
      }
    }

    setIsLoading(!queryCache.has(key))
    execute()

    if (baseIntervalMs > 0) {
      const schedule = () => {
        // Slow down polling for empty result sets.
        const result = queryCache.get<T>(key)
        const interval = slowWhenEmpty && result !== undefined && isEmptyResult(result)
          ? Math.max(baseIntervalMs, 60000)
          : baseIntervalMs
        if (intervalId) clearInterval(intervalId)
        intervalId = setInterval(execute, interval)
      }

      schedule()

      const handleVisibility = () => {
        if (document.hidden) {
          if (intervalId) clearInterval(intervalId)
          intervalId = null
        } else {
          execute()
          schedule()
        }
      }
      document.addEventListener('visibilitychange', handleVisibility)

      return () => {
        cancelled = true
        controller.abort()
        if (intervalId) clearInterval(intervalId)
        document.removeEventListener('visibilitychange', handleVisibility)
      }
    }

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [key, enabled, baseIntervalMs, slowWhenEmpty, isEmptyResult])

  // Re-fetch when another caller invalidates our namespace.
  useEffect(() => {
    return queryCache.subscribe((prefix) => {
      const parsedKey = (() => {
        try {
          return JSON.parse(key) as unknown[]
        } catch {
          return []
        }
      })()
      if (prefix && parsedKey[0] !== prefix) return
      setIsLoading(true)
      run()
    })
  }, [key, run])

  // Expose a stable mutate that invalidates by namespace prefix.
  const mutate = useCallback(() => {
    const prefix = deps[0]
    if (typeof prefix === 'string') {
      queryCache.invalidate(prefix)
    } else {
      queryCache.invalidateAll()
    }
  }, [deps])

  return { data, error, isLoading, mutate }
}
