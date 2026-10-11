/**
 * URL <-> param-store sync. Modeled directly on Evidence's
 * `Filter.svelte.ts` behaviour:
 *
 *   * The URL reflects USER intent only. Programmatic defaults (URL
 *     absent, data-driven, hard-coded) never write to the URL.
 *   * User interactions write via `history.replaceState` (NOT
 *     `pushState`) — pushing on every slider tick would blow up the
 *     back button. Replace keeps the current entry in place so
 *     reload / share still carries the state.
 *   * A single 150ms debounce coalesces bursts of writes (dragging a
 *     slider fires 30+ set calls a second).
 *
 * The store owns the source of truth; this file just persists.
 */
import type { ReportParam } from './v2-types'

/** Read the URL and pull out any values that match declared params. */
export function readParamsFromURL(
  params: ReportParam[],
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!search || params.length === 0) return out
  const url = new URLSearchParams(search)
  for (const p of params) {
    if (p.urlPersist === false) continue
    const raw = url.getAll(p.id)
    if (raw.length === 0) continue
    out[p.id] = decodeUrlValue(p, raw)
  }
  return out
}

/** Interpret one raw URL value (or values) per the param's input kind. */
function decodeUrlValue(param: ReportParam, raw: string[]): unknown {
  const single = raw[0]
  switch (param.input.kind) {
    case 'dropdown':
      if (param.input.multi) return raw.filter(Boolean)
      return single
    case 'buttonGroup':
    case 'textInput':
      return single
    case 'checkbox':
      return single === 'true' || single === '1'
    case 'slider': {
      const n = Number(single)
      if (Number.isFinite(n)) return n
      // Range shape: "low..high"
      const [lo, hi] = single.split('..').map(Number)
      if (Number.isFinite(lo) && Number.isFinite(hi)) return { low: lo, high: hi }
      return single
    }
    case 'dateInput':
      return single
    case 'dateRange': {
      // Format: "YYYY-MM-DD..YYYY-MM-DD"
      const [start, end] = single.split('..')
      return { start: start || undefined, end: end || undefined }
    }
    case 'dimensionGrid': {
      // The DimensionGrid predicate is complex; the URL slot carries
      // a compact JSON encoding. Robustness: fall back to no-op on
      // parse failure so a stale URL doesn't break the page.
      try {
        return JSON.parse(single)
      } catch {
        return undefined
      }
    }
    default:
      return single
  }
}

/** Serialise a value back to URL-ready form. */
export function encodeUrlValue(param: ReportParam, value: unknown): string | string[] | null {
  if (value === undefined || value === null || value === '') return null
  switch (param.input.kind) {
    case 'dropdown':
      if (param.input.multi) {
        if (!Array.isArray(value) || value.length === 0) return null
        return value.map(String)
      }
      return String(value)
    case 'buttonGroup':
    case 'textInput':
    case 'dateInput':
      return String(value)
    case 'checkbox':
      return value ? 'true' : 'false'
    case 'slider':
      if (typeof value === 'number') return String(value)
      if (typeof value === 'object' && value !== null && 'low' in value && 'high' in value) {
        const { low, high } = value as { low: number; high: number }
        return `${low}..${high}`
      }
      return null
    case 'dateRange':
      if (typeof value === 'object' && value !== null) {
        const range = value as { start?: string; end?: string }
        return `${range.start ?? ''}..${range.end ?? ''}`
      }
      return null
    case 'dimensionGrid':
      try {
        return JSON.stringify(value)
      } catch {
        return null
      }
    default:
      return String(value)
  }
}

/**
 * Write a batch of param values to the URL. Only entries with
 * `userSet: true` are persisted (matches Evidence's non-clobber
 * rule); programmatic defaults never touch the URL.
 *
 * Uses `window.history.replaceState` so the back button isn't
 * polluted. No-op on the server or in JSDOM without a location.
 */
export function writeParamsToURL(
  params: ReportParam[],
  values: Record<string, { value: unknown; userSet: boolean }>,
): void {
  if (typeof window === 'undefined' || !window.history || !window.location) return
  const url = new URL(window.location.href)
  const search = url.searchParams

  const declared = new Set(params.map((p) => p.id))

  // Wipe every declared param slot first — we rewrite them below,
  // and this stops a previously-set-then-cleared param from lingering.
  for (const id of declared) search.delete(id)

  for (const p of params) {
    if (p.urlPersist === false) continue
    const state = values[p.id]
    if (!state || !state.userSet) continue
    const encoded = encodeUrlValue(p, state.value)
    if (encoded === null) continue
    if (Array.isArray(encoded)) {
      for (const v of encoded) search.append(p.id, v)
    } else {
      search.set(p.id, encoded)
    }
  }

  // Replace-in-place. Reads window.history.state so back-forward
  // cache doesn't clobber whatever the router put there.
  const target = url.pathname + (search.toString() ? '?' + search.toString() : '') + url.hash
  window.history.replaceState(window.history.state, '', target)
}

/**
 * Debounced writer. Store code calls `writeSoon(params, values)` on
 * every setParam; the debounce coalesces bursts (slider drag) into a
 * single replaceState call after 150ms of quiet.
 */
export function createDebouncedWriter(delayMs = 150) {
  let handle: ReturnType<typeof setTimeout> | undefined
  return (params: ReportParam[], values: Record<string, { value: unknown; userSet: boolean }>) => {
    if (handle) clearTimeout(handle)
    handle = setTimeout(() => {
      writeParamsToURL(params, values)
      handle = undefined
    }, delayMs)
  }
}
