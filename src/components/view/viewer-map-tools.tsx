/**
 * The facility viewer's map tools — the same controls the report map view
 * has, in one glass pill under the style switcher:
 *
 * - **Live**: how often the data layers re-poll (10 s / 30 s / 1 min / 5 min
 *   or paused), with the report's countdown ring and "Refresh now". Sets the
 *   shared layer poll interval (src/lib/data-link/layer-refresh.ts) while the
 *   viewer is open; remembered per browser.
 * - **Cluster**: runtime clustering of every point layer (`?cluster=`), as on
 *   a report map (by location / by room; "by field" needs report rows).
 * - **Heatmap**: one or more point layers as heatmaps
 *   (`?heatmap=…&heatmapLayer=1,2`), several in their own colours; one
 *   layer can be weighted by a number field from its table schema.
 *   Paused while several floors are stacked. Excludes clustering.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { DataLinkConfig } from '@/lib/db'
import { LivePill, useLiveRefresh } from '@/components/reports/layout/report-map-view'
import { ClusterControl, useClusterSetting } from '@/components/reports/widgets/facility-explorer/cluster-control'
import { HeatmapControl, useHeatmapSetting, useHeatNumberFields } from '@/components/reports/widgets/facility-explorer/heatmap-control'
import type { PointHeatmapSpec } from '@/components/map-dl-heatmap-overlay'
import type { PointClusterSpec } from '@/lib/data-link/point-clusters'
import { CLUSTER_OFF, toPointClusterSpec, type ReportClusterConfig } from '@/lib/reports/cluster-config'
import { HEATMAP_OFF, heatmapSpecFor, resolveHeatLayers, type HeatmapSetting } from '@/lib/reports/heatmap-config'
import { DEFAULT_LAYER_POLL_MS, markLayersRefreshed, setLayerPollMs, useLayerRefresh } from '@/lib/data-link/layer-refresh'
import { queryCache } from '@/lib/useApiQuery'

const LIVE_KEY = 'sgv-viewer-live'
const POINT_MODES = new Set(['point-at-coord', 'history-movement'])

function readLive(): number {
  try {
    const n = Number(localStorage.getItem(LIVE_KEY))
    return [0, 10, 30, 60, 300].includes(n) && localStorage.getItem(LIVE_KEY) !== null ? n : DEFAULT_LAYER_POLL_MS / 1000
  } catch {
    return DEFAULT_LAYER_POLL_MS / 1000
  }
}

export function useViewerMapTools({
  configs,
  floorsStacked,
}: {
  /** The data links this view draws (visible ones). */
  configs: readonly DataLinkConfig[]
  /** More than one floor on screen — a heatmap would blur floors together. */
  floorsStacked: boolean
}): { pointCluster: PointClusterSpec | null; pointHeatmap: PointHeatmapSpec | null; node: ReactNode } {
  const { t } = useTranslation()

  // ---- Live
  const [every, setEvery] = useState(readLive)
  useEffect(() => {
    setLayerPollMs(every * 1000)
    try {
      localStorage.setItem(LIVE_KEY, String(every))
    } catch {
      /* a remembered choice is a convenience */
    }
  }, [every])
  useEffect(() => () => setLayerPollMs(DEFAULT_LAYER_POLL_MS), [])
  const refreshedAt = useLayerRefresh((s) => s.refreshedAt)
  // The countdown restarts each period (the polls run on the same cadence).
  const live = useLiveRefresh(every, false, refreshedAt, markLayersRefreshed)
  const refreshNow = () => {
    queryCache.invalidate('layer-rows')
    markLayersRefreshed()
  }

  // ---- Cluster + heatmap (exclusive)
  const pointLayers = useMemo(() => configs.filter((c) => c.id !== undefined && POINT_MODES.has(c.renderMode)), [configs])
  const [cluster, setClusterRaw] = useClusterSetting(CLUSTER_OFF)
  const [heat, setHeatRaw] = useHeatmapSetting()
  const setCluster = (next: ReportClusterConfig) => {
    setClusterRaw(next)
    if (next.mode !== 'off' && heat.mode !== 'off') setHeatRaw(HEATMAP_OFF)
  }
  const setHeat = (next: HeatmapSetting) => {
    setHeatRaw(next)
    if (next.mode !== 'off' && cluster.mode !== 'off') setClusterRaw({ ...cluster, mode: 'off' })
  }
  const { mode: clusterMode, radius: clusterRadius } = cluster
  const pointCluster = useMemo(
    () => (pointLayers.length > 0 ? toPointClusterSpec({ mode: clusterMode, radius: clusterRadius }) : null),
    [pointLayers.length, clusterMode, clusterRadius],
  )
  const pointIds = useMemo(() => pointLayers.map((c) => c.id as number), [pointLayers])
  const heatIds = useMemo(() => resolveHeatLayers(heat, pointIds, undefined), [heat, pointIds])
  const pointHeatmap = useMemo(() => heatmapSpecFor(heat, heatIds, pointIds, floorsStacked), [heat, heatIds, pointIds, floorsStacked])
  const heatSourceId = heat.mode !== 'off' && heatIds.length === 1 ? pointLayers.find((c) => c.id === heatIds[0])?.sourceId ?? null : null
  const numericFields = useHeatNumberFields(heatSourceId)

  const node = (
    <div className="flex items-center gap-0.5 rounded-full border border-border/60 bg-background/70 p-0.5 shadow-lg shadow-black/5 backdrop-blur-xl">
      <LivePill every={every} remaining={live.remaining} pulseKey={refreshedAt} onChange={setEvery} onRefresh={refreshNow} running={false} />
      {pointLayers.length > 0 && (
        <>
          <ClusterControl value={cluster} defaultValue={CLUSTER_OFF} onChange={setCluster} fields={[]} fieldLabel={(k) => k} className="rounded-full" />
          <HeatmapControl
            value={heat}
            onChange={setHeat}
            numericFields={numericFields}
            fieldLabel={(k) => k}
            layers={pointLayers.map((c) => ({ id: c.id as number, name: c.name }))}
            blockedReason={floorsStacked ? t('heatmap.pickOneFloor', { defaultValue: 'Pick one floor to see the heatmap — several stacked floors would blur together.' }) : null}
            className="rounded-full"
          />
        </>
      )}
    </div>
  )
  return { pointCluster, pointHeatmap, node }
}
