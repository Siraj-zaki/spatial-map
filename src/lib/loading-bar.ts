/**
 * App-wide loading state for the top progress bar (TopLoadingBar).
 *
 * What counts as "loading" — what a person is waiting on, never background
 * traffic (live refreshes, map-data polling, analytics would make the bar
 * flicker forever on a live map):
 *   - reads (GET, and query-style POSTs like `/reports/:id/run`) started
 *     within NAV_WINDOW_MS of a navigation — the screen they just opened;
 *   - writes (POST/PUT/PATCH/DELETE) at any time — a save, delete, upload;
 *   - anything a component registers itself with `useLoadingBar(active)`
 *     (e.g. a map still loading its facility).
 * `apiFetch` calls `trackRequest`; `{ silent: true }` opts a call out.
 */
import { useEffect, useSyncExternalStore } from 'react'

const NAV_WINDOW_MS = 2500

let active = 0
let navAt = typeof performance !== 'undefined' ? performance.now() : 0
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

/** A route changed: reads in the next moments belong to the new screen. */
export function markNavigation(): void {
  navAt = performance.now()
}

/** Starts one unit of loading; the returned function ends it (once). */
export function beginLoading(): () => void {
  active++
  emit()
  let done = false
  return () => {
    if (done) return
    done = true
    active = Math.max(0, active - 1)
    emit()
  }
}

/** POSTs that only read (report runs, queries, previews) — not saves. */
const READ_POST = /\/run$|\/query$|\/search$|\/preview$|\/reports\/_\/|\/auth\/login$|\/analytics/
/** Never shown: telemetry and the shared workspace setting. */
const IGNORE = /\/analytics|\/settings\/current-tenant|\/health$/

/** Called by apiFetch for every request; null = not tracked. */
export function trackRequest(method: string, path: string, silent = false): (() => void) | null {
  if (silent || IGNORE.test(path)) return null
  const m = method.toUpperCase()
  const write = m !== 'GET' && m !== 'HEAD' && !(m === 'POST' && READ_POST.test(path))
  if (!write && performance.now() - navAt > NAV_WINDOW_MS) return null
  return beginLoading()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Whether anything is loading right now. */
export function useLoadingActive(): boolean {
  return useSyncExternalStore(subscribe, () => active > 0, () => false)
}

/** Shows the top bar while `isLoading` is true (component-owned work). */
export function useLoadingBar(isLoading: boolean): void {
  useEffect(() => {
    if (!isLoading) return
    return beginLoading()
  }, [isLoading])
}
