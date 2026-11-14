import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface UseApiQueryOptions<T = unknown> {
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
  /**
   * Combine the previous result with a fresh one, returning `prev` itself
   * when nothing changed. Replaces the default structural sharing
   * (`shareStructure`) for this query — e.g. a keyed row merge.
   */
  merge?: (prev: T, next: T) => T
}

export interface UseApiQueryResult<T> {
  data: T | undefined
  error: Error | null
  isLoading: boolean
  /** A refetch is running while earlier data is shown (poll tick, invalidation, manual refresh). */
  isRefreshing: boolean
  /** Trigger a manual refresh. */
  mutate: () => void
}

/** Picks which keys of a namespace an invalidation hits, from the key's deps. */
export type QueryKeyMatch = (deps: unknown[]) => boolean

interface CacheEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  ts: number
}

const cache = new Map<string, CacheEntry>()
/**
 * The last data of keys an invalidation dropped. Not served (a `get()`
 * after `invalidate()` is still undefined) — only the base the refetch's
 * result is structurally shared against, so an unchanged answer keeps its
 * references instead of handing every consumer a brand-new copy.
 */
const staleData = new Map<string, unknown>()
/** Keys whose stale data is kept; the oldest go first (keys of unmounted screens). */
const MAX_STALE_KEYS = 64
const listeners = new Set<(prefix: string, match?: QueryKeyMatch) => void>()

function buildKey(deps: unknown[]): string {
  return JSON.stringify(deps)
}

/** Parsed deps per key, so invalidations don't JSON.parse every key every time. */
const parsedKeys = new Map<string, unknown[] | null>()
function depsOf(key: string): unknown[] | null {
  let deps = parsedKeys.get(key)
  if (deps === undefined) {
    try {
      const parsed = JSON.parse(key) as unknown
      deps = Array.isArray(parsed) ? parsed : null
    } catch {
      deps = null // Ignore keys that are not JSON arrays.
    }
    parsedKeys.set(key, deps)
  }
  return deps
}

// Batches synchronous invalidate broadcasts into a single microtask.
// Without this, N callers invalidating the same prefix in one tick
// woke every subscriber N times — 4 useModelAssets() subscribers × 3
// migration writes gave the classic "user-models fetched 11 times"
// pageload symptom. Cache entries are still dropped synchronously
// (a `get()` right after `invalidate()` still returns undefined) —
// only the listener notifications coalesce.
//
// Per prefix: null = every key of the namespace, else the matchers of
// targeted invalidations (`invalidateWhere`) — a key refetches once if
// any of them picks it.
const pendingBroadcasts = new Map<string, QueryKeyMatch[] | null>()
let broadcastScheduled = false
function scheduleBroadcast() {
  if (broadcastScheduled) return
  broadcastScheduled = true
  queueMicrotask(() => {
    broadcastScheduled = false
    const batch = Array.from(pendingBroadcasts)
    pendingBroadcasts.clear()
    for (const [prefix, matchers] of batch) {
      const match: QueryKeyMatch | undefined = matchers
        ? (deps) => matchers.some((m) => m(deps))
        : undefined
      listeners.forEach((cb) => cb(prefix, match))
    }
  })
}

/** Drop matching cache entries; mark matching requests on the wire as answering too early. */
function dropKeys(prefix: string, match?: QueryKeyMatch): void {
  const hits = (key: string) => {
    const deps = depsOf(key)
    return deps !== null && deps[0] === prefix && (!match || match(deps))
  }
  for (const [key, entry] of cache) {
    if (!hits(key)) continue
    staleData.delete(key) // re-insert as the newest
    staleData.set(key, entry.data)
    cache.delete(key)
  }
  while (staleData.size > MAX_STALE_KEYS) staleData.delete(staleData.keys().next().value!)
  for (const key of inflight.keys()) if (hits(key)) dirty.add(key)
}

export const queryCache = {
  set<T>(key: string, data: T): void {
    cache.set(key, { data, ts: Date.now() })
    staleData.delete(key)
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
    dropKeys(prefix)
    pendingBroadcasts.set(prefix, null)
    scheduleBroadcast()
  },
  /**
   * `invalidate`, limited to the namespace's keys whose deps `match`
   * picks — e.g. only the layers reading the one table an SSE event
   * names: `invalidateWhere('layer-rows', (deps) => deps[2] === sourceId)`.
   */
  invalidateWhere(prefix: string, match: QueryKeyMatch): void {
    dropKeys(prefix, match)
    const pending = pendingBroadcasts.get(prefix)
    if (pending === null) return // the whole namespace is already going
    if (pending) pending.push(match)
    else pendingBroadcasts.set(prefix, [match])
    scheduleBroadcast()
  },
  invalidateAll(): void {
    cache.clear()
    // A workspace switch: nothing from before may be shared into what comes next.
    staleData.clear()
    for (const key of inflight.keys()) dirty.add(key)
    pendingBroadcasts.set('', null)
    scheduleBroadcast()
  },
  subscribe(cb: (prefix: string, match?: QueryKeyMatch) => void): () => void {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  /**
   * The cached keys of a namespace with their deps and data — for callers
   * that patch results in place (`patch`). Only keys with data.
   */
  entries(prefix: string): Array<{ key: string; deps: unknown[]; data: unknown }> {
    const out: Array<{ key: string; deps: unknown[]; data: unknown }> = []
    for (const [key, entry] of cache) {
      const deps = depsOf(key)
      if (deps !== null && deps[0] === prefix) out.push({ key, deps, data: entry.data })
    }
    return out
  },
  /**
   * Replace one key's data and hand it to every mounted hook showing that
   * key — WITHOUT a refetch (live pushes: device positions). A key that
   * isn't cached is left alone. Notifications are batched per frame-ish
   * microtask like invalidations.
   */
  patch(key: string, data: unknown): void {
    if (!cache.has(key)) return
    cache.set(key, { data, ts: Date.now() })
    pendingPatches.add(key)
    if (patchScheduled) return
    patchScheduled = true
    queueMicrotask(() => {
      patchScheduled = false
      const keys = Array.from(pendingPatches)
      pendingPatches.clear()
      for (const k of keys) patchListeners.get(k)?.forEach((cb) => cb())
    })
  },
}

/** Per key: the mounted hooks to hand a `queryCache.patch` to. */
const patchListeners = new Map<string, Set<() => void>>()
const pendingPatches = new Set<string>()
let patchScheduled = false
function onPatch(key: string, cb: () => void): () => void {
  let set = patchListeners.get(key)
  if (!set) patchListeners.set(key, (set = new Set()))
  set.add(cb)
  return () => {
    set!.delete(cb)
    if (set!.size === 0) patchListeners.delete(key)
  }
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
 * Structural sharing for fetch results. Every 30 s poll — and every
 * refetch after an invalidation — would otherwise hand the same data over
 * as a NEW reference: downstream effects that depend on `query.data` (map
 * overlays, GeoJSON pushes, feature stamps) would re-run for no visual
 * change. Now an equal answer keeps the previous reference, and a changed
 * one keeps the previous object for every part that didn't change (one
 * changed row of 50k: 49,999 rows keep their identity, so per-row caches
 * downstream still hit). This replaced a JSON.stringify compare of both
 * results, which handed over a whole new copy whenever anything differed
 * and was skipped after an invalidation (the entry it compared against
 * was gone) — so every SSE-driven refetch re-ran everything downstream.
 * The walk costs about as much as that compare did (~40 ms at 50k rows).
 *
 * The shared base survives invalidation (`staleData`). With no base (a
 * key never fetched) the result is cached as-is.
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
  merge: ((prev: T, next: T) => T) | undefined,
): void {
  const hasBase = cache.has(key) || staleData.has(key)
  const base = (cache.has(key) ? cache.get(key)!.data : staleData.get(key)) as T
  const next = !hasBase ? result : merge ? merge(base, result) : (shareStructure(base, result) as T)
  if (!cache.has(key) || next !== base) queryCache.set(key, next)
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
/**
 * Keys invalidated while their request was on the wire. That response may
 * have been produced before the change, so callers after the invalidation
 * get exactly one follow-up request (shared) once it lands — instead of the
 * stale in-flight answer, which used to lose the write until the next poll.
 */
const dirty = new Set<string>()
const followUps = new Map<string, Promise<unknown>>()
const noop = () => {}
function dedupedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined
  if (existing && dirty.has(key)) {
    let follow = followUps.get(key) as Promise<T> | undefined
    if (!follow) {
      follow = existing.then(noop, noop).then(() => {
        followUps.delete(key)
        return dedupedFetch(key, fetcher)
      })
      followUps.set(key, follow)
    }
    return follow
  }
  if (existing) return existing
  dirty.delete(key)
  const promise = fetcher().finally(() => {
    // Only clear if this is still the current in-flight. A caller may
    // have invalidated during the fetch and started a fresh one.
    if (inflight.get(key) === promise) inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

/**
 * `next`, with every part deep-equal to its counterpart in `prev` replaced
 * by `prev`'s object; `prev` itself when the two are deep-equal.
 *
 * Strict equality, so a reused part is indistinguishable from the fresh
 * one: same keys in the same order (key order shows wherever a payload's
 * fields are listed), every value, Dates by time. Arrays pair up by index.
 * Other objects (Maps, class instances — rare in API responses) keep the
 * old JSON comparison.
 */
export function shareStructure(prev: unknown, next: unknown): unknown {
  if (prev === next) return prev
  if (typeof prev !== 'object' || typeof next !== 'object' || prev === null || next === null) {
    return typeof prev === 'number' && typeof next === 'number' && Number.isNaN(prev) && Number.isNaN(next)
      ? prev
      : next
  }
  const proto = Object.getPrototypeOf(prev)
  if (proto !== Object.getPrototypeOf(next)) return next
  if (proto === Object.prototype || proto === null) {
    return shareObject(prev as Record<string, unknown>, next as Record<string, unknown>)
  }
  if (proto === Array.prototype) return shareArray(prev as unknown[], next as unknown[])
  if (prev instanceof Date) {
    return Object.is(prev.getTime(), (next as Date).getTime()) ? prev : next
  }
  try {
    return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
  } catch {
    return next
  }
}

function shareArray(p: unknown[], n: unknown[]): unknown {
  let same = p.length === n.length
  let out: unknown[] | null = null
  for (let i = 0; i < n.length; i++) {
    const nv = n[i]
    const pv = p[i]
    const v = pv === nv || i >= p.length ? nv : shareStructure(pv, nv)
    if (v !== nv && !out) out = n.slice(0, i)
    if (out) out.push(v)
    if (same && v !== p[i]) same = false
  }
  return same ? p : (out ?? n)
}

function shareObject(p: Record<string, unknown>, n: Record<string, unknown>): unknown {
  const nk = Object.keys(n)
  // Same keys in the same order? Walk `p` without allocating its key list.
  let same = true
  let i = 0
  for (const k in p) {
    if (i >= nk.length || nk[i] !== k) {
      same = false
      break
    }
    i++
  }
  if (i !== nk.length) same = false
  let values: unknown[] | null = null
  for (let j = 0; j < nk.length; j++) {
    const k = nk[j]
    // An own `__proto__` key can't be copied by assignment; don't share into it.
    if (k === '__proto__') return n
    const nv = n[k]
    const pv = p[k]
    // A key `p` lacks reads as undefined (or an inherited function): `nv` stays.
    const v = pv === nv ? nv : shareStructure(pv, nv)
    if (v !== nv && !values) values = nk.slice(0, j).map((key) => n[key])
    if (values) values.push(v)
    if (same && v !== p[k]) same = false
  }
  if (same) return p
  if (!values) return n
  const out: Record<string, unknown> = {}
  for (let j = 0; j < nk.length; j++) out[nk[j]] = values[j]
  return out
}

/* eslint-disable react-hooks/set-state-in-effect */
export function useApiQuery<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  options: UseApiQueryOptions<T> = {},
): UseApiQueryResult<T> {
  const key = buildKey(deps)
  const parsedKey = useMemo(() => depsOf(key) ?? [], [key])
  const baseIntervalMs = options.intervalMs ?? 30000
  const enabled = options.enabled ?? true
  const slowWhenEmpty = options.slowWhenEmpty ?? true

  const [data, setData] = useState<T | undefined>(() => queryCache.get<T>(key))
  const [error, setError] = useState<Error | null>(null)
  const [isLoading, setIsLoading] = useState(!queryCache.has(key))

  const fetcherRef = useRef(fetcher)
  const mergeRef = useRef(options.merge)
  useEffect(() => {
    fetcherRef.current = fetcher
    mergeRef.current = options.merge
  }, [fetcher, options.merge])

  const isEmptyResult = useCallback((result: T): boolean => {
    if (result === undefined || result === null) return true
    if (Array.isArray(result)) return result.length === 0
    return false
  }, [])

  const run = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await dedupedFetch(key, () => fetcherRef.current())
      if (signal?.aborted) return
      applyResult(key, result, setData, mergeRef.current)
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
        applyResult(key, result, setData, mergeRef.current)
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

  // Re-fetch when another caller invalidates our namespace (or, for a
  // targeted invalidation, picks our key).
  useEffect(() => {
    return queryCache.subscribe((prefix, match) => {
      if (prefix && parsedKey[0] !== prefix) return
      if (match && !match(parsedKey)) return
      setIsLoading(true)
      run()
    })
  }, [parsedKey, run])

  // A live in-place patch of our key (queryCache.patch): show it, no refetch.
  useEffect(() => onPatch(key, () => setData(queryCache.get<T>(key))), [key])

  // Expose a stable mutate that invalidates by namespace prefix.
  const mutate = useCallback(() => {
    const prefix = deps[0]
    if (typeof prefix === 'string') {
      queryCache.invalidate(prefix)
    } else {
      queryCache.invalidateAll()
    }
  }, [deps])

  return { data, error, isLoading, isRefreshing: isLoading && data !== undefined, mutate }
}
