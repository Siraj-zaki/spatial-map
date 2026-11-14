/**
 * A report map's clustering setting (see src/lib/data-link/point-clusters.ts).
 *
 * - Author default: `widget.bindings.cluster` on the facility explorer —
 *   `{ mode, radius, field? }`; absent = off (every existing report).
 * - Viewer choice: `?cluster=off|location|room|field:<key>` plus
 *   `&clusterRadius=<20..120>` (written whenever mode ≠ off). Precedence:
 *   URL, then the author default, then off. A choice equal to the default
 *   removes both params. Only these two params are ever touched.
 */

import {
  CLUSTER_RADIUS_DEFAULT,
  CLUSTER_RADIUS_MAX,
  CLUSTER_RADIUS_MIN,
  type PointClusterMode,
  type PointClusterSpec,
} from '@/lib/data-link/point-clusters'

export type ReportClusterMode = 'off' | PointClusterMode

export interface ReportClusterConfig {
  mode: ReportClusterMode
  radius: number
  field?: string
}

export const CLUSTER_OFF: ReportClusterConfig = { mode: 'off', radius: CLUSTER_RADIUS_DEFAULT }

export const CLUSTER_URL_PARAM = 'cluster'
export const CLUSTER_RADIUS_URL_PARAM = 'clusterRadius'

function clampRadius(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(CLUSTER_RADIUS_MAX, Math.max(CLUSTER_RADIUS_MIN, Math.round(n)))
}

function normalise(mode: unknown, radius: number, field: unknown): ReportClusterConfig {
  if (mode === 'location' || mode === 'room') return { mode, radius }
  if (mode === 'field') {
    const f = typeof field === 'string' ? field.trim() : ''
    return f ? { mode: 'field', radius, field: f } : { mode: 'location', radius }
  }
  return { mode: 'off', radius }
}

/** The author default from `widget.bindings.cluster`; garbage reads as off. */
export function readClusterBinding(raw: unknown): ReportClusterConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return CLUSTER_OFF
  const o = raw as Record<string, unknown>
  const mode = o.mode
  if (mode !== 'location' && mode !== 'room' && mode !== 'field') return CLUSTER_OFF
  return normalise(mode, clampRadius(o.radius, CLUSTER_RADIUS_DEFAULT), o.field)
}

/** What to store in `bindings.cluster` (off = remove the key). */
export function toBindingValue(
  c: ReportClusterConfig,
): { mode: PointClusterMode; radius: number; field?: string } | undefined {
  if (c.mode === 'off') return undefined
  if (c.mode === 'field' && c.field) return { mode: 'field', field: c.field, radius: c.radius }
  return { mode: c.mode === 'field' ? 'location' : c.mode, radius: c.radius }
}

/** Same effective setting (off ignores the radius; only field mode has a field). */
export function sameCluster(a: ReportClusterConfig, b: ReportClusterConfig): boolean {
  if (a.mode !== b.mode) return false
  if (a.mode === 'off') return true
  if (a.radius !== b.radius) return false
  return a.mode !== 'field' || (a.field ?? '') === (b.field ?? '')
}

/** The viewer's setting from the URL, else `fallback`. */
export function readClusterFromURL(search: string, fallback: ReportClusterConfig): ReportClusterConfig {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search)
  } catch {
    return fallback
  }
  const raw = params.get(CLUSTER_URL_PARAM)
  const rawRadius = params.get(CLUSTER_RADIUS_URL_PARAM)
  if (raw === null && rawRadius === null) return fallback
  const radius = clampRadius(rawRadius, fallback.radius)
  if (raw === null) return fallback.mode === 'off' ? fallback : { ...fallback, radius }
  const value = raw.trim()
  if (value.startsWith('field:')) return normalise('field', radius, value.slice('field:'.length))
  if (value === 'off' || value === 'location' || value === 'room') return normalise(value, radius, undefined)
  // `field` with no key, or garbage: field → location, else the fallback.
  if (value === 'field') return normalise('location', radius, undefined)
  return fallback
}

/**
 * Put the viewer's setting in the URL (replaceState, no history entry),
 * or remove it when it equals the report default. Never touches any
 * other param.
 */
export function writeClusterToURL(c: ReportClusterConfig, fallback: ReportClusterConfig): void {
  if (typeof window === 'undefined') return
  let url: URL
  try {
    url = new URL(window.location.href)
  } catch {
    return
  }
  const before = url.search
  if (sameCluster(c, fallback)) {
    url.searchParams.delete(CLUSTER_URL_PARAM)
    url.searchParams.delete(CLUSTER_RADIUS_URL_PARAM)
  } else {
    url.searchParams.set(CLUSTER_URL_PARAM, c.mode === 'field' && c.field ? `field:${c.field}` : c.mode)
    if (c.mode === 'off') url.searchParams.delete(CLUSTER_RADIUS_URL_PARAM)
    else url.searchParams.set(CLUSTER_RADIUS_URL_PARAM, String(c.radius))
  }
  if (url.search === before) return
  window.history.replaceState(window.history.state, '', url)
}

/** The overlay's spec for a setting (null = off, today's map). */
export function toPointClusterSpec(c: ReportClusterConfig): PointClusterSpec | null {
  if (c.mode === 'off') return null
  if (c.mode === 'field') return c.field ? { mode: 'field', radius: c.radius, field: c.field } : { mode: 'location', radius: c.radius }
  return { mode: c.mode, radius: c.radius }
}
