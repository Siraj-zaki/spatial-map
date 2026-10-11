import {
  ArrowLeft,
  ArrowUpRight,
  Boxes,
  ChevronDown,
  ChevronUp,
  Layers,
  MapPin,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { statusBreakdown } from '@/lib/analytics/metrics'
import type { Bin, Grid } from '@/lib/db'
import type { MarkerShape, ModelShape, ShapeBase } from '@/lib/shapes'

type DrillSection = 'racks' | 'markers' | 'models' | null

interface ViewSummaryCardProps {
  grids: Grid[]
  bins: Bin[]
  markers: MarkerShape[]
  models: ModelShape[]
  /** Click a row inside a drill-in list — host should fly the map. */
  onFlyToGrid?: (grid: Grid) => void
  onFlyToMarker?: (marker: MarkerShape) => void
  onFlyToModel?: (model: ModelShape) => void
}

function shapeCount<T extends ShapeBase>(rows: ReadonlyArray<T>): number {
  return rows.length
}

export function ViewSummaryCard({
  grids,
  bins,
  markers,
  models,
  onFlyToGrid,
  onFlyToMarker,
  onFlyToModel,
}: ViewSummaryCardProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [drill, setDrill] = useState<DrillSection>(null)

  const breakdown = useMemo(() => statusBreakdown(bins), [bins])
  const occupancyPct = breakdown.total > 0
    ? Math.round((breakdown.occupied / breakdown.total) * 100)
    : 0

  const modelCount = shapeCount(models as unknown as ShapeBase[])
  const markerCount = shapeCount(markers as unknown as ShapeBase[])

  // Per-grid occupancy used in the racks drill list. Cheap pre-compute so
  // every row renders without re-walking the bins array.
  const gridOccupancy = useMemo(() => {
    const map = new Map<number, { occupied: number; total: number }>()
    for (const b of bins) {
      if (b.targetKind !== 'grid-cell' || b.gridId === undefined) continue
      const entry = map.get(b.gridId) ?? { occupied: 0, total: 0 }
      entry.total += 1
      if (b.status === 'occupied') entry.occupied += 1
      map.set(b.gridId, entry)
    }
    return map
  }, [bins])

  const closeDrill = () => setDrill(null)

  return (
    <div className="fixed bottom-3 end-3 z-20 bg-card/95 backdrop-blur border rounded-md shadow-sm w-72 max-w-[calc(100vw-1.5rem)]">
      <button
        type="button"
        onClick={() => {
          setExpanded((v) => !v)
          if (expanded) setDrill(null)
        }}
        className="flex items-center justify-between w-full px-3 py-2 gap-2"
        aria-expanded={expanded}
      >
        <span className="text-xs font-semibold">
          {drill
            ? t(`view.summary.${drill}`, { defaultValue: drill[0].toUpperCase() + drill.slice(1) })
            : t('view.summary.title', { defaultValue: 'Summary' })}
        </span>
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground" />
        ) : (
          <ChevronUp className="w-3 h-3 text-muted-foreground" />
        )}
      </button>

      {!expanded && (
        <div className="px-3 pb-2 text-[11px] text-muted-foreground">
          {grids.length} {t('view.summary.racks', { defaultValue: 'Racks' })} ·{' '}
          {bins.length} {t('view.summary.bins', { defaultValue: 'Bins' })} ·{' '}
          {occupancyPct}% {t('view.summary.occupancy', { defaultValue: 'Occupancy' })}
        </div>
      )}

      {expanded && drill === null && (
        <div className="px-3 pb-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <StatButton
            label={t('view.summary.racks', { defaultValue: 'Racks' })}
            value={grids.length}
            onClick={grids.length > 0 ? () => setDrill('racks') : undefined}
            icon={<Layers className="w-3 h-3" />}
          />
          <Stat label={t('view.summary.bins', { defaultValue: 'Bins' })} value={bins.length} />
          <Stat label={t('view.summary.occupied', { defaultValue: 'Occupied' })} value={breakdown.occupied} />
          <Stat label={t('view.summary.available', { defaultValue: 'Available' })} value={breakdown.empty + breakdown.reserved} />
          <Stat label={t('view.summary.empty', { defaultValue: 'Empty' })} value={breakdown.empty} />
          <Stat label={t('view.summary.occupancy', { defaultValue: 'Occupancy' })} value={`${occupancyPct}%`} />
          <StatButton
            label={t('view.summary.markers', { defaultValue: 'Markers' })}
            value={markerCount}
            onClick={markerCount > 0 ? () => setDrill('markers') : undefined}
            icon={<MapPin className="w-3 h-3" />}
          />
          <StatButton
            label={t('view.summary.models', { defaultValue: '3D models' })}
            value={modelCount}
            onClick={modelCount > 0 ? () => setDrill('models') : undefined}
            icon={<Boxes className="w-3 h-3" />}
          />
        </div>
      )}

      {expanded && drill === 'racks' && (
        <DrillList onBack={closeDrill}>
          {grids.map((g, i) => {
            const occ = g.id !== undefined ? gridOccupancy.get(g.id) : undefined
            return (
              <DrillRow
                key={g.id ?? i}
                name={g.name || t('view.summary.unnamedRack', { defaultValue: `Rack #${g.id ?? i + 1}` })}
                detail={occ ? `${occ.occupied}/${occ.total}` : undefined}
                onClick={onFlyToGrid ? () => onFlyToGrid(g) : undefined}
              />
            )
          })}
        </DrillList>
      )}

      {expanded && drill === 'markers' && (
        <DrillList onBack={closeDrill}>
          {markers.map((m, i) => (
            <DrillRow
              key={m.id ?? i}
              name={m.name || t('view.summary.unnamedMarker', { defaultValue: `Marker #${m.id ?? i + 1}` })}
              onClick={onFlyToMarker ? () => onFlyToMarker(m) : undefined}
            />
          ))}
        </DrillList>
      )}

      {expanded && drill === 'models' && (
        <DrillList onBack={closeDrill}>
          {models.map((m, i) => (
            <DrillRow
              key={m.id ?? i}
              name={m.name || t('view.summary.unnamedModel', { defaultValue: `Model #${m.id ?? i + 1}` })}
              onClick={onFlyToModel ? () => onFlyToModel(m) : undefined}
            />
          ))}
        </DrillList>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-muted-foreground leading-tight">{label}</span>
      <span className="text-sm font-semibold leading-tight">{value}</span>
    </div>
  )
}

function StatButton({
  label,
  value,
  onClick,
  icon,
}: {
  label: string
  value: number | string
  onClick?: () => void
  icon?: React.ReactNode
}) {
  if (!onClick) return <Stat label={label} value={value} />
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col text-left rounded px-1.5 py-0.5 -mx-1.5 hover:bg-muted/60 transition-colors group"
    >
      <span className="text-[10px] text-muted-foreground leading-tight flex items-center gap-1">
        {icon}
        {label}
        <ArrowUpRight className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
      </span>
      <span className="text-sm font-semibold leading-tight">{value}</span>
    </button>
  )
}

function DrillList({
  children,
  onBack,
}: {
  children: React.ReactNode
  onBack: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="px-1.5 pb-1.5">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-0.5"
      >
        <ArrowLeft className="w-3 h-3" />
        {t('view.summary.back', { defaultValue: 'Back' })}
      </button>
      <div className="mt-1 max-h-[40dvh] overflow-y-auto flex flex-col gap-0.5">
        {children}
      </div>
    </div>
  )
}

function DrillRow({
  name,
  detail,
  onClick,
}: {
  name: string
  detail?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="flex items-center justify-between gap-2 text-xs rounded px-1.5 py-1 hover:bg-muted/60 transition-colors disabled:opacity-50 disabled:cursor-default text-left"
    >
      <span className="truncate">{name}</span>
      <span className="flex items-center gap-1.5 text-muted-foreground flex-shrink-0">
        {detail && <span className="tabular-nums text-[10px]">{detail}</span>}
        {onClick && <ArrowUpRight className="w-3 h-3" />}
      </span>
    </button>
  )
}
