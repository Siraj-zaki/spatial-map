import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpRight,
  Boxes,
  ChevronDown,
  ChevronUp,
  Circle,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Layers,
  MapPin,
  Minus,
  Pentagon,
  Square,
  Tag,
  TrendingUp,
} from 'lucide-react'

import { statusColor } from '@/lib/analytics/metrics'
import type { LayerKind, LayerVisibility } from '@/components/view/view-controls'

interface ViewLegendProps {
  layers: LayerVisibility
  onLayerToggle: (k: LayerKind) => void
  /** Per-kind counts for the floor currently being viewed. Drives the
   * data-driven section: rows with `0` are dimmed and unclickable, so the
   * legend doubles as a "what's on this floor" inventory. */
  counts: Record<LayerKind, number>
  /** When true, bins layer is on and at least one bin exists — show the
   * status swatches (Occupied / Reserved / Empty). */
  showBinStatuses: boolean
}

interface Row {
  kind: LayerKind
  labelKey: string
  fallback: string
  Icon: React.ComponentType<{ className?: string }>
  swatch: string
}

const ROWS: Row[] = [
  { kind: 'racks',    labelKey: 'view.controls.layerRacks',    fallback: 'Racks',       Icon: Layers,    swatch: '#0ea5e9' },
  { kind: 'bins',     labelKey: 'view.controls.layerBins',     fallback: 'Bins',        Icon: Boxes,     swatch: '#3b82f6' },
  { kind: 'markers',  labelKey: 'view.controls.layerMarkers',  fallback: 'Markers',     Icon: MapPin,    swatch: '#ef4444' },
  { kind: 'models',   labelKey: 'view.controls.layerModels',   fallback: '3D models',   Icon: Boxes,     swatch: '#6366f1' },
  { kind: 'polygons', labelKey: 'view.controls.layerPolygons', fallback: 'Polygons',    Icon: Pentagon,  swatch: '#22c55e' },
  { kind: 'circles',  labelKey: 'view.controls.layerCircles',  fallback: 'Circles',     Icon: Circle,    swatch: '#a855f7' },
  { kind: 'lines',    labelKey: 'view.controls.layerLines',    fallback: 'Lines',       Icon: Minus,     swatch: '#eab308' },
  { kind: 'stairs',   labelKey: 'view.controls.layerStairs',   fallback: 'Stairs',      Icon: TrendingUp, swatch: '#f97316' },
  { kind: 'doors',    labelKey: 'view.controls.layerDoors',    fallback: 'Doors',       Icon: ArrowUpRight, swatch: '#2563eb' },
  { kind: 'images',   labelKey: 'view.controls.layerImages',   fallback: 'Floor plans', Icon: ImageIcon, swatch: '#64748b' },
  { kind: 'imagePlanes', labelKey: 'view.controls.layerImagePlanes', fallback: 'Image planes', Icon: ImageIcon, swatch: '#94a3b8' },
  { kind: 'text',     labelKey: 'view.controls.layerText',     fallback: 'Text labels', Icon: Tag,       swatch: '#0f172a' },
]

const STATUSES: { key: string; fallback: string; status: 'occupied' | 'reserved' | 'empty' }[] = [
  { status: 'occupied', key: 'view.legend.occupied',  fallback: 'Occupied' },
  { status: 'reserved', key: 'view.legend.available', fallback: 'Available' },
  { status: 'empty',    key: 'view.legend.empty',     fallback: 'Empty' },
]

export function ViewLegend({ layers, onLayerToggle, counts, showBinStatuses }: ViewLegendProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)

  const visibleRows = ROWS.filter((r) => counts[r.kind] > 0)
  // Total layers with data — drives the collapsed header summary.
  const totalLayers = visibleRows.length

  if (totalLayers === 0 && !showBinStatuses) return null

  return (
    <div className="fixed bottom-3 start-3 z-20 bg-card/95 backdrop-blur border rounded-md shadow-sm max-w-[230px]">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex items-center justify-between w-full px-2.5 py-1.5 gap-2"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-semibold">
          <Square className="w-3 h-3 text-muted-foreground" />
          {t('view.legend.title', { defaultValue: 'Legend' })}
          <span className="text-muted-foreground font-normal">· {totalLayers}</span>
        </span>
        {collapsed ? (
          <ChevronUp className="w-3 h-3 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        )}
      </button>

      {!collapsed && (
        <div className="px-2.5 pb-2 pt-0.5 flex flex-col gap-0.5">
          {visibleRows.map(({ kind, labelKey, fallback, Icon, swatch }) => {
            const on = layers[kind]
            const count = counts[kind]
            return (
              <button
                key={kind}
                type="button"
                onClick={() => onLayerToggle(kind)}
                aria-pressed={on}
                title={
                  on
                    ? t('view.legend.hide', { defaultValue: 'Hide layer' })
                    : t('view.legend.show', { defaultValue: 'Show layer' })
                }
                className={`flex items-center justify-between gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-muted/60 transition-colors ${
                  on ? '' : 'opacity-45'
                }`}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm border border-black/10 flex-shrink-0"
                    style={{ backgroundColor: swatch }}
                  />
                  <Icon className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                  <span className="truncate">{t(labelKey, { defaultValue: fallback })}</span>
                </span>
                <span className="flex items-center gap-1 text-muted-foreground flex-shrink-0">
                  <span className="tabular-nums">{count}</span>
                  {on ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                </span>
              </button>
            )
          })}

          {showBinStatuses && (
            <div className="mt-1 pt-1.5 border-t flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground px-1.5">
                {t('view.legend.binStatus', { defaultValue: 'Bin status' })}
              </span>
              {STATUSES.map(({ status, key, fallback }) => (
                <div
                  key={status}
                  className="flex items-center gap-1.5 px-1.5 py-0.5 text-[11px]"
                >
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm border border-black/10 flex-shrink-0"
                    style={{ backgroundColor: statusColor(status) }}
                  />
                  <span>{t(key, { defaultValue: fallback })}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
