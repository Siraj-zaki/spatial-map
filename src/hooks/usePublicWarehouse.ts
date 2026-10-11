import { useCallback, useEffect, useRef, useState } from 'react'

import { publicFetch, type ApiError } from '@/lib/api-client'
import type { Bin, Grid, Zone, DataLinkConfig, StyleRuleRow } from '@/lib/db'
import type {
  PolygonShape,
  CircleShape,
  LineShape,
  MarkerShape,
  ImageShape,
  ImagePlaneShape,
  ModelShape,
  StairShape,
  TextLabelShape,
} from '@/lib/shapes'
import type { DoorShape } from '@/lib/door/types'

/**
 * Full, read-only envelope returned by `GET /api/v1/public/warehouses/:id`.
 * Mirrors the backend `WarehouseView` struct; date strings are parsed into
 * `Date` objects below so the overlay components can treat them uniformly
 * with shapes loaded via the authed `apiDb` adapter.
 */
export interface WarehouseView {
  zone: Zone & { id: number; createdAt: Date; updatedAt: Date }
  grids: Grid[]
  polygons: PolygonShape[]
  circles: CircleShape[]
  lines: LineShape[]
  markers: MarkerShape[]
  images: ImageShape[]
  models: ModelShape[]
  textLabels: TextLabelShape[]
  stairs: StairShape[]
  doors: DoorShape[]
  imagePlanes: ImagePlaneShape[]
  bins: Bin[]
  /** Zone-scoped data-link configs. Included in the envelope so the
   *  shareable presentation viewer can render the same live-data
   *  overlays the authed viewer would. Optional so older backends
   *  (before slice 24) still deserialise cleanly. */
  dataLinkConfigs?: DataLinkConfig[]
  /** Tenant + zone-scoped style rules, ordered by priority DESC. */
  styleRules?: StyleRuleRow[]
  // Slice 6c2 dropped the per-entity live-data envelope rosters
  // (assets / sensors / cameras / shipments). Public visitors no
  // longer see live records — authenticated viewers fetch them via
  // the tenant-wide `/entity-states` endpoint.
}

interface UsePublicWarehouseResult {
  data: WarehouseView | null
  error: ApiError | null
  loading: boolean
  refresh: () => void
}

const DATE_FIELDS = ['createdAt', 'updatedAt', 'lastSyncedAt']

function parseDates<T>(row: T): T {
  if (!row || typeof row !== 'object') return row
  const out = { ...(row as Record<string, unknown>) }
  for (const f of DATE_FIELDS) {
    const v = out[f]
    if (typeof v === 'string') out[f] = new Date(v)
  }
  return out as T
}

function parseAll(view: WarehouseView): WarehouseView {
  // Slice 6c2 dropped the per-entity live-data rosters from the public
  // envelope; nothing here needs to translate `lastSeenAt`/`etaAt`/etc.
  // anymore.
  return {
    zone: parseDates(view.zone),
    grids: view.grids.map(parseDates),
    polygons: view.polygons.map(parseDates),
    circles: view.circles.map(parseDates),
    lines: view.lines.map(parseDates),
    markers: view.markers.map(parseDates),
    images: view.images.map(parseDates),
    models: view.models.map(parseDates),
    textLabels: view.textLabels.map(parseDates),
    stairs: view.stairs.map(parseDates),
    doors: (view.doors ?? []).map(parseDates),
    imagePlanes: (view.imagePlanes ?? []).map(parseDates),
    bins: view.bins.map(parseDates),
    dataLinkConfigs: (view.dataLinkConfigs ?? []).map(parseDates),
    styleRules: (view.styleRules ?? []).map(parseDates),
  }
}

/**
 * Fetches the public warehouse envelope once per `id` or `token` and caches
 * the result so re-renders (e.g. toggling layer visibility) don't refetch.
 * Presentations are snapshots — no SSE subscription. `refresh()` forces a
 * refetch.
 *
 * Either `id` (numeric warehouse ID, hits `/warehouses/:id`) or `token`
 * (unguessable share token, hits `/warehouses/by-token/:token`) may be
 * supplied. When both are present `token` wins — share links should resolve
 * via the token so a regenerated token invalidates the old cache.
 */
export function usePublicWarehouse(
  idOrToken: string | undefined,
  options?: { token?: boolean },
): UsePublicWarehouseResult {
  const token = options?.token
  const [data, setData] = useState<WarehouseView | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState<boolean>(idOrToken !== undefined)
  const cache = useRef<Map<string, WarehouseView>>(new Map())
  const generation = useRef(0)

  const refresh = useCallback(() => {
    if (idOrToken === undefined) return
    const cacheKey = token ? `token:${idOrToken}` : `id:${idOrToken}`
    const endpoint = token
      ? `/warehouses/by-token/${idOrToken}`
      : `/warehouses/${idOrToken}`
    const gen = ++generation.current
    setLoading(true)
    setError(null)
    publicFetch<WarehouseView>(endpoint)
      .then((raw) => {
        if (gen !== generation.current) return
        const parsed = parseAll(raw)
        cache.current.set(cacheKey, parsed)
        setData(parsed)
      })
      .catch((err: ApiError) => {
        if (gen !== generation.current) return
        setError(err)
      })
      .finally(() => {
        if (gen !== generation.current) return
        setLoading(false)
      })
  }, [idOrToken, token])

  useEffect(() => {
    if (idOrToken === undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const cacheKey = token ? `token:${idOrToken}` : `id:${idOrToken}`
    const cached = cache.current.get(cacheKey)
    if (cached) {
      setData(cached)
      setLoading(false)
      return
    }
    refresh()
  }, [idOrToken, token, refresh])

  return { data, error, loading, refresh }
}