import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type * as mapboxgl from 'mapbox-gl'
import { MapboxMap } from '@/components/mapbox-map'
import { cn } from '@/lib/utils'
import type { ReportWidget } from '@/lib/reports-client'

/** Bindings the map widget accepts. `warehouseId` is used to pull the
 *  centre + zoom from the app's warehouse metadata (which the caller
 *  passes via props — the widget doesn't fetch on its own to keep the
 *  boundary clean between reports and the spatial store). */
export interface MapWidgetBindings {
  warehouseId?: number | string
  dataLinkConfigId?: number
  featureIdColumn?: string
  initialCenter?: [number, number]
  initialZoom?: number
}

/** Global map-instance count for the safety cap. Guarantees no more
 *  than [MAP_HARD_CAP] Mapbox contexts live at once — each context is
 *  ~15MB of WebGL memory, so a dashboard with 10 maps would freeze the
 *  browser. */
const MAP_HARD_CAP = 4
let activeMaps = 0

/**
 * Map widget for the report canvas. Composes only [MapboxMap] — the
 * full [MapDataLinkedOverlay] pipeline needs shape data from the
 * spatial store which isn't available in a headless dashboard
 * context. When the host supplies overlay data via props, that pipe
 * plugs in via the `renderOverlay` render-prop.
 *
 * Enforces the multi-map safety cap (4 per dashboard) — additional
 * map widgets past the cap render a placeholder card instead.
 */
export function MapWidget({
  widget,
  renderOverlay,
}: {
  widget: ReportWidget
  /** Optional overlay renderer — the host wires in
   *  MapDataLinkedOverlay + spatial-store data. */
  renderOverlay?: (map: mapboxgl.Map) => React.ReactNode
}) {
  const { t } = useTranslation()
  const b = (widget.bindings ?? {}) as MapWidgetBindings
  const [map, setMap] = useState<mapboxgl.Map | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [overCap, setOverCap] = useState(false)

  // Bump the global counter on mount / decrement on unmount. Refuse
  // to render when we're already at the cap; the placeholder is
  // rendered instead. The cap is claimed in mount (effect) order against
  // a module-level counter, so it can't be derived during render —
  // `react-hooks/set-state-in-effect` is disabled per the convention in
  // `model-preview.tsx`: syncing from external state is what the effect
  // is for.
  useEffect(() => {
    if (activeMaps >= MAP_HARD_CAP) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOverCap(true)
      return
    }
    activeMaps++
    return () => {
      if (!overCap) activeMaps = Math.max(0, activeMaps - 1)
    }
    // deliberately empty deps — cap check happens once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // React to cell resize — Mapbox needs an explicit `resize()` when
  // its container's box changes.
  useEffect(() => {
    if (!map || !containerRef.current) return
    const ro = new ResizeObserver(() => {
      // debounce inside the map's requestAnimationFrame — cheap enough to skip a queue
      try {
        map.resize()
      } catch {
        /* map may have been torn down */
      }
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [map])

  const initialView = useMemo(
    () => ({
      center: (b.initialCenter ?? [-79.4, 43.7]) as [number, number],
      zoom: b.initialZoom ?? 14,
    }),
    [b.initialCenter, b.initialZoom],
  )

  if (overCap) {
    return (
      <div
        className={cn(
          'h-full rounded-xl border-2 border-dashed border-warning/50 bg-warning/5',
          'p-4 flex flex-col items-center justify-center text-center',
        )}
      >
        <p className="text-sm font-medium text-warning">
          {t('reports.widgets.map.maxLimitReached', { defaultValue: 'Maximum of 4 map widgets per report' })}
        </p>
      </div>
    )
  }

  if (b.warehouseId === undefined && b.initialCenter === undefined) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-dashed p-4 text-center">
        <p className="text-xs italic text-muted-foreground">
          {t('reports.widgets.map.missingConfig', { defaultValue: 'Map requires warehouse and data-link config' })}
        </p>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-full rounded-lg overflow-hidden bg-card border border-border relative">
      <MapboxMap
        onMapLoad={(m) => setMap(m)}
        onMapDestroy={() => setMap(null)}
        initialView={initialView}
      />
      {map && renderOverlay?.(map)}
      {widget.title && (
        <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-background/80 backdrop-blur text-xs font-medium">
          {widget.title}
        </div>
      )}
    </div>
  )
}
