/**
 * In-memory scheduler for auto-refresh of pull-based data sources.
 *
 * The route mounts this once via `useDataSourceScheduler()` and lets it
 * drive itself off the live `db.dataSources` query. Two trigger kinds
 * matter for v1:
 *
 *   - `'on-load'`   → run once when the source first appears (or when
 *                     the tab opens with one already configured)
 *   - `'interval'`  → run every `intervalSeconds` while the tab is open
 *
 * `'manual'` does nothing — those are user-triggered from the sidebar.
 * File-backed sources (csv/xlsx/json/geojson) auto-skip because their
 * data isn't stashed; the rerun call surfaces a clear error for those.
 *
 * Persistence note: the scheduler is per-tab. When the tab closes the
 * pollers stop. That's fine for a local-only app; once we move to a
 * Cloudflare Worker (or another always-on backend), the same shape
 * lifts out of the browser largely untouched.
 */

import { useEffect, useMemo, useRef } from 'react'
import { apiDb } from '@/lib/api-db'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { type DataSource, type WebhookSourceConfig } from '@/lib/db'
import { useApiQuery } from '@/lib/useApiQuery'
import { rerunDataSource } from './rerun'
import { stampSourceRun } from './source-service'

interface PollerState {
  sourceId: number
  intervalSec: number
  timerId: number
  /** Used to detect config changes — bumped on every effect re-run. */
  signature: string
  /**
   * Exponential backoff state. After a failed run we skip the next
   * `skipTicks` fires; on success it resets to 0. The next-error step
   * doubles `failures` up to MAX_BACKOFF_TICKS so a wedged endpoint
   * doesn't hammer the network — typical pattern is 1 → 2 → 4 → 8 → 16.
   */
  failures: number
  skipTicks: number
}

/**
 * Max consecutive failures the backoff can grow to. Caps the skip
 * count at 2^N ticks (= 16 ticks at N=4) so a long outage doesn't pause
 * polling forever — once the endpoint recovers we want to find out
 * within a minute or two on a 30s interval.
 */
const MAX_BACKOFF_STEPS = 4

function nextSkipTicks(failures: number): number {
  const step = Math.min(failures, MAX_BACKOFF_STEPS)
  return Math.pow(2, step - 1) // failures=1 → 1 tick skipped, =2 → 2, =3 → 4, =4 → 8
}

/**
 * React hook the route mounts to keep all pollers in sync with the
 * Dexie row state. Returns nothing; side-effects only.
 */
export function useDataSourceScheduler(
  enabled = true,
  /**
   * Restrict which sources this scheduler runs pollers for. When set to
   * a warehouse id, only sources bound to THAT warehouse (or unscoped
   * sources with `zoneId === undefined`) get scheduled — Hospital's REST
   * feeds won't fire background polls while the user is looking at the
   * Airport map. Pass `null` (default) to schedule every source in the
   * tenant, which is the correct behaviour before the app has picked a
   * warehouse.
   */
  activeZoneId: number | null = null,
): void {
  const tenantId = useCurrentTenantId()
  const sourcesQuery = useApiQuery(
    () => apiDb.dataSources.toArray(),
    ['dataSources', tenantId],
    // Event-driven: fetch once, refresh on mutation invalidation. The
    // scheduler itself runs interval-based work; the catalog list does not
    // need its own timer.
    { intervalMs: 0, enabled },
  )
  const allSources = sourcesQuery.data ?? []
  const sources = useMemo(
    () =>
      allSources.filter((s) => {
        if (activeZoneId === null) return true
        if (s.zoneId === undefined || s.zoneId === null) return true
        return s.zoneId === activeZoneId
      }),
    [allSources, activeZoneId],
  )
  const pollersRef = useRef<Map<number, PollerState>>(new Map())
  const onLoadFiredRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    if (!enabled) return
    const pollers = pollersRef.current
    const wantedIds = new Set<number>()
    for (const source of sources) {
      if (source.id === undefined) continue
      // Auto-fetch pullable sources. File-backed rows (csv / xlsx / json /
      // geojson) now have their bytes persisted in source_files and can be
      // re-imported via POST /data-sources/:id/reimport, so the scheduler
      // treats them like any other scheduled source. Webhook sources poll
      // the backend's /api/v1/webhooks/:token/drain endpoint — same
      // machinery, different URL shape.
      if (
        source.kind !== 'rest' &&
        source.kind !== 'webhook' &&
        source.kind !== 'csv' &&
        source.kind !== 'xlsx' &&
        source.kind !== 'json' &&
        source.kind !== 'geojson'
      ) {
        continue
      }
      wantedIds.add(source.id)

      // On-load fires exactly once per session per source id.
      if (source.schedule === 'on-load' && !onLoadFiredRef.current.has(source.id)) {
        onLoadFiredRef.current.add(source.id)
        void runSilently(source)
      }

      if (source.schedule === 'interval') {
        const intervalSec = Math.max(10, Math.floor(intervalForSource(source)))
        if (intervalSec <= 0) continue
        const signature = `${source.id}|${intervalSec}|${JSON.stringify(source.config)}`
        const existing = pollers.get(source.id)
        if (existing && existing.signature === signature) continue
        // Config or interval changed (or no poller yet) — replace.
        if (existing) window.clearInterval(existing.timerId)
        // Capture sourceId once so the closure doesn't depend on the
        // (possibly stale) source row a few ticks down the line.
        const sid = source.id
        const timerId = window.setInterval(() => {
          const state = pollers.get(sid)
          if (!state) return
          if (state.skipTicks > 0) {
            state.skipTicks--
            return
          }
          void runSilentlyWithBackoff(sid, state)
        }, intervalSec * 1000)
        pollers.set(source.id, {
          sourceId: source.id,
          intervalSec,
          timerId,
          signature,
          failures: 0,
          skipTicks: 0,
        })
      } else if (pollers.has(source.id)) {
        // Schedule was flipped off (back to manual / on-load) — stop polling.
        window.clearInterval(pollers.get(source.id)!.timerId)
        pollers.delete(source.id)
      }
    }

    // Tear down pollers for sources that are no longer in the table.
    for (const [id, poller] of pollers) {
      if (!wantedIds.has(id)) {
        window.clearInterval(poller.timerId)
        pollers.delete(id)
        onLoadFiredRef.current.delete(id)
      }
    }
  }, [sources, enabled])

  // Clean up on unmount — kill every poller so they don't outlive the
  // route. Component-scoped, no extra ref tracking needed.
  useEffect(() => {
    const pollers = pollersRef.current
    return () => {
      for (const poller of pollers.values()) {
        window.clearInterval(poller.timerId)
      }
      pollers.clear()
    }
  }, [])
}

/**
 * Pick the polling interval seconds for a source. REST sources use
 * `intervalSeconds` (set in the sidebar). Webhook sources prefer
 * `config.pollIntervalSec` (set in the wizard) and fall back to 30s
 * if absent.
 */
function intervalForSource(source: DataSource): number {
  if (source.kind === 'webhook') {
    const cfg = source.config as Partial<WebhookSourceConfig> | undefined
    return cfg?.pollIntervalSec ?? source.intervalSeconds ?? 30
  }
  return source.intervalSeconds ?? 0
}

/**
 * Run a source and swallow errors into a console warning. The hook
 * shouldn't tear down the React tree because of a network blip; the
 * source row's `lastResult` field gets the bad status from the rerun
 * helper itself.
 */
async function runSilently(source: DataSource): Promise<void> {
  try {
    await rerunDataSource(source)
  } catch (err) {
    console.warn('[scheduler] re-run failed', source.name, err)
    if (source.id !== undefined) {
      await stampSourceRun(source.id, {
        lastRunAt: new Date(),
        lastResult: 'error',
      })
    }
  }
}

/**
 * Like `runSilently` but updates the poller's failure counter so the
 * next ticks honor backoff. Resolves the row from Dexie at call time
 * because `useLiveQuery` may have changed it (URL, headers, …) since
 * the timer was installed.
 */
async function runSilentlyWithBackoff(
  sourceId: number,
  state: PollerState,
): Promise<void> {
  const source = await apiDb.dataSources.get(sourceId)
  if (!source) return
  try {
    await rerunDataSource(source)
    // Recovery: clear the backoff counter so the next failure starts
    // from a single-tick pause again.
    state.failures = 0
    state.skipTicks = 0
  } catch (err) {
    state.failures += 1
    state.skipTicks = nextSkipTicks(state.failures)
    console.warn(
      `[scheduler] re-run failed (${state.failures}× in a row, skipping ${state.skipTicks} tick${state.skipTicks === 1 ? '' : 's'})`,
      source.name,
      err,
    )
    await stampSourceRun(sourceId, {
      lastRunAt: new Date(),
      lastResult: 'error',
    })
  }
}
