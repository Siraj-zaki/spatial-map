/**
 * Unified layers panel for the viewer — combines shape layers
 * (polygons, circles, markers, models, stairs, doors, image planes,
 * text labels, grids, floor plans, bins) with data-link layers
 * (sensors, cameras, assets). Each kind has an eye toggle for
 * show/hide and an expandable list of individual items with
 * zoom-to-item. Lines / walls are intentionally excluded from
 * the viewer layer controls.
 */

import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  Box,
  Camera,
  ChevronDown,
  ChevronUp,
  Circle,
  Crosshair,
  DoorOpen,
  Eye,
  EyeOff,
  Footprints,
  Frame,
  Grid3x3,
  Image as ImageIcon,
  Layers as LayersIcon,
  MapPin,
  Pentagon,
  Power,
  Type,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { DataLinkConfig, EntityState } from '@/lib/db'
import { fetchLayerRows } from '@/lib/data-link/layer-rows'
import { inferLayerKind, type LayerKind as DataLinkLayerKind } from './view-layers-panel'

// Re-export the data-link layer kind for consumers
export type { DataLinkLayerKind }

// ---- Shape kind metadata --------------------------------------------------

export type ShapeLayerKind =
  | 'polygons'
  | 'circles'
  | 'markers'
  | 'models'
  | 'stairs'
  | 'doors'
  | 'imagePlanes'
  | 'textLabels'
  | 'grids'
  | 'images'
  | 'bins'

interface ShapeKindMeta {
  label: string
  Icon: typeof LayersIcon
  tint: string
}

const SHAPE_META: Record<ShapeLayerKind, ShapeKindMeta> = {
  polygons:    { label: 'Areas / Polygons',  Icon: Pentagon,    tint: 'text-violet-500' },
  circles:     { label: 'Circles',           Icon: Circle,      tint: 'text-sky-500' },
  markers:     { label: 'Markers',           Icon: MapPin,      tint: 'text-emerald-500' },
  models:      { label: '3D Models',         Icon: Box,         tint: 'text-amber-500' },
  stairs:      { label: 'Stairs',            Icon: Footprints,  tint: 'text-orange-500' },
  doors:       { label: 'Doors',             Icon: DoorOpen,    tint: 'text-rose-500' },
  imagePlanes: { label: 'Image Planes',      Icon: Frame,       tint: 'text-teal-500' },
  textLabels:  { label: 'Text Labels',       Icon: Type,        tint: 'text-slate-400' },
  grids:       { label: 'Racks / Grids',     Icon: Grid3x3,     tint: 'text-indigo-500' },
  images:      { label: 'Floor Plans',       Icon: ImageIcon,   tint: 'text-cyan-500' },
  bins:        { label: 'Bins',              Icon: Box,         tint: 'text-blue-500' },
}

// ---- Data-link kind metadata (reuses view-layers-panel logic) -------------

const DL_META: Record<DataLinkLayerKind, { label: string; Icon: typeof LayersIcon; tint: string }> = {
  asset:  { label: 'Assets',  Icon: MapPin,   tint: 'text-emerald-500' },
  sensor: { label: 'Sensors', Icon: Activity, tint: 'text-sky-500' },
  camera: { label: 'Cameras', Icon: Camera,   tint: 'text-fuchsia-500' },
  other:  { label: 'Other',   Icon: Circle,   tint: 'text-slate-500' },
}

// ---- Generic shape item type ----------------------------------------------

interface ShapeItem {
  id: number
  name: string
  /** Optional centroid for zoom-to. */
  center?: [number, number]
}

// ---- Props ----------------------------------------------------------------

interface ViewerLayersPanelProps {
  // ---- Shape data (from spatial store) ----
  shapeItems: Partial<Record<ShapeLayerKind, ShapeItem[]>>
  /** Callback to get centroid for a specific shape kind + id. */
  getShapeCenter?: (kind: ShapeLayerKind, id: number) => [number, number] | null
  /** Called when user clicks zoom-to on an item. */
  onZoomTo?: (center: [number, number]) => void

  // ---- Shape visibility (lifted to parent for overlay filtering) ----
  hiddenShapeKinds: ReadonlySet<string>
  onToggleShapeKind: (kind: string) => void

  // ---- Data-link data ----
  dataLinkConfigs?: ReadonlyArray<DataLinkConfig>
  hiddenConfigIds?: ReadonlySet<number>
  onToggleDataLinkConfig?: (configId: number) => void
  onSetAllDataLinkConfigs?: (kind: DataLinkLayerKind, hidden: boolean) => void
  onToggleDataLinkEnabled?: (configId: number, enabled: boolean) => void
  /**
   * Label of the saved filter each layer is currently showing, keyed by
   * config id. Read-only here — picking a filter happens in
   * `ViewerFilterBar`, so this panel stays about visibility.
   */
  activeFilterLabels?: Readonly<Record<number, string>>
  onZoomToDataLinkItem?: (cfg: DataLinkConfig, entity: EntityState) => void
}

// ---- Component ------------------------------------------------------------

export function ViewerLayersPanel({
  shapeItems,
  getShapeCenter,
  onZoomTo,
  hiddenShapeKinds,
  onToggleShapeKind,
  dataLinkConfigs,
  hiddenConfigIds,
  onToggleDataLinkConfig,
  onSetAllDataLinkConfigs,
  onToggleDataLinkEnabled,
  activeFilterLabels,
  onZoomToDataLinkItem,
}: ViewerLayersPanelProps) {
  const [expandedKinds, setExpandedKinds] = useState<Set<string>>(new Set())
  const [hiddenShapeItems, setHiddenShapeItems] = useState<Record<string, Set<number>>>({})

  const toggleKindExpanded = (kind: string) => {
    setExpandedKinds((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  const toggleItemVisibility = (kind: string, id: number) => {
    setHiddenShapeItems((prev) => {
      const current = prev[kind] ?? new Set()
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { ...prev, [kind]: next }
    })
  }

  // Count visible shapes per kind
  const shapeKindEntries = (Object.keys(SHAPE_META) as ShapeLayerKind[]).filter(
    (kind) => (shapeItems[kind]?.length ?? 0) > 0,
  )

  const totalShapeKinds = shapeKindEntries.length
  const visibleShapeKinds = shapeKindEntries.filter((k) => !hiddenShapeKinds.has(k)).length

  const totalDlConfigs = dataLinkConfigs?.length ?? 0
  const visibleDlConfigs = dataLinkConfigs?.filter(
    (c) => c.id !== undefined && !hiddenConfigIds?.has(c.id),
  ).length ?? 0

  const totalKinds = totalShapeKinds + totalDlConfigs
  const visibleKinds = visibleShapeKinds + visibleDlConfigs

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-2 rounded-full border-border/60 bg-background/70 pl-3 pr-2.5 shadow-lg shadow-black/5 backdrop-blur-xl hover:bg-background/90"
        >
          <LayersIcon className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-medium">
            Layers
            <span className="ms-1 text-muted-foreground">
              ({visibleKinds}/{totalKinds})
            </span>
          </span>
          <ChevronDown className="h-3.5 h-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-72 max-h-[70dvh] overflow-y-auto shadow-xl rounded-xl border-border/60 bg-popover/95 backdrop-blur-xl"
      >
        {totalKinds === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No layers available.
          </div>
        )}

        {/* ---- Shape layers ---- */}
        {shapeKindEntries.length > 0 && (
          <>
            {shapeKindEntries.map((kind) => {
              const meta = SHAPE_META[kind]
              const items = shapeItems[kind] ?? []
              const isKindHidden = hiddenShapeKinds.has(kind)
              const isExpanded = expandedKinds.has(kind)
              const hiddenItems = hiddenShapeItems[kind]
              const visibleItemCount = hiddenItems
                ? items.filter((i) => !hiddenItems.has(i.id)).length
                : items.length
              return (
                <div key={kind}>
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => toggleKindExpanded(kind)}
                      className="flex flex-1 items-center gap-2 min-w-0 rounded-md px-1 py-0.5 text-left hover:bg-accent/60"
                    >
                      <meta.Icon className={`h-3.5 w-3.5 flex-shrink-0 ${meta.tint}`} />
                      <span className="flex-1 truncate text-xs font-medium">{meta.label}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {visibleItemCount}/{items.length}
                      </span>
                      {isExpanded ? (
                        <ChevronUp className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleShapeKind(kind)}
                      className={
                        'flex-shrink-0 h-7 w-7 grid place-items-center rounded-md hover:bg-accent/60 ' +
                        (isKindHidden ? 'text-muted-foreground' : 'text-emerald-500')
                      }
                      aria-label={isKindHidden ? `Show ${meta.label}` : `Hide ${meta.label}`}
                      title={isKindHidden ? `Show ${meta.label}` : `Hide ${meta.label}`}
                    >
                      {isKindHidden ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="ms-6 me-2 mb-2 rounded-md border border-border/40 bg-background/60 px-1.5 py-1 text-[11px]">
                      <ShapeItemsList
                        kind={kind}
                        items={items}
                        hiddenItems={hiddenShapeItems[kind]}
                        onToggleItem={toggleItemVisibility}
                        getCenter={getShapeCenter}
                        onZoomTo={onZoomTo}
                      />
                    </div>
                  )}
                </div>
              )
            })}
            {dataLinkConfigs && dataLinkConfigs.length > 0 && <DropdownMenuSeparator />}
          </>
        )}

        {/* ---- Data-link layers ---- */}
        {dataLinkConfigs && dataLinkConfigs.length > 0 && (
          <DataLinkLayersSection
            configs={dataLinkConfigs}
            hiddenConfigIds={hiddenConfigIds ?? new Set()}
            onToggle={onToggleDataLinkConfig ?? (() => {})}
            onSetAll={onSetAllDataLinkConfigs ?? (() => {})}
            onToggleEnabled={onToggleDataLinkEnabled}
            activeFilterLabels={activeFilterLabels}
            onZoomToItem={onZoomToDataLinkItem}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---- Shape items list (expandable) ----------------------------------------

function ShapeItemsList({
  kind,
  items,
  hiddenItems,
  onToggleItem,
  getCenter,
  onZoomTo,
}: {
  kind: ShapeLayerKind
  items: ShapeItem[]
  hiddenItems?: Set<number>
  onToggleItem: (kind: string, id: number) => void
  getCenter?: (kind: ShapeLayerKind, id: number) => [number, number] | null
  onZoomTo?: (center: [number, number]) => void
}) {
  if (items.length === 0) {
    return (
      <div className="px-1 py-1.5 text-muted-foreground">No items.</div>
    )
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => {
        const isHidden = hiddenItems?.has(item.id) ?? false
        return (
          <li
            key={item.id}
            className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/40"
          >
            <button
              type="button"
              onClick={() => onToggleItem(kind, item.id)}
              className={
                'flex-shrink-0 h-5 w-5 grid place-items-center rounded hover:bg-accent/60 ' +
                (isHidden ? 'text-muted-foreground' : 'text-emerald-500')
              }
              aria-label={isHidden ? 'Show item' : 'Hide item'}
              title={isHidden ? 'Show on map' : 'Hide from map'}
            >
              {isHidden ? (
                <EyeOff className="h-3 w-3" />
              ) : (
                <Eye className="h-3 w-3" />
              )}
            </button>
            <span
              className="flex-shrink-0 h-2.5 w-2.5 rounded-full ring-1 ring-black/10"
              style={{ backgroundColor: 'hsl(var(--primary))' }}
              aria-hidden
            />
            <span className="flex-1 truncate text-foreground/90" title={item.name || `#${item.id}`}>
              {item.name || `#${item.id}`}
            </span>
            {onZoomTo && (
              <button
                type="button"
                onClick={() => {
                  const center = getCenter?.(kind, item.id)
                  if (center) onZoomTo(center)
                }}
                className="flex-shrink-0 h-6 w-6 grid place-items-center rounded-md text-primary hover:bg-accent/80"
                aria-label="Zoom to item"
                title="Zoom to item"
              >
                <Crosshair className="h-3 w-3" />
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ---- Data-link layers section (mirrors ViewLayersPanel internal) ----------

function DataLinkLayersSection({
  configs,
  hiddenConfigIds,
  onToggle,
  onSetAll,
  onToggleEnabled,
  activeFilterLabels,
  onZoomToItem,
}: {
  configs: ReadonlyArray<DataLinkConfig>
  hiddenConfigIds: ReadonlySet<number>
  onToggle: (configId: number) => void
  onSetAll: (kind: DataLinkLayerKind, hidden: boolean) => void
  onToggleEnabled?: (configId: number, enabled: boolean) => void
  activeFilterLabels?: Readonly<Record<number, string>>
  onZoomToItem?: (cfg: DataLinkConfig, entity: EntityState) => void
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [itemsByConfig, setItemsByConfig] = useState<Record<number, EntityState[] | undefined>>({})
  const [itemsStatus, setItemsStatus] = useState<Record<number, 'idle' | 'loading' | 'loaded' | 'error'>>({})
  const fetchedRef = useRef<Set<number>>(new Set())

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useEffect(() => {
    if (expanded.size === 0) return
    let cancelled = false
    for (const cfg of configs) {
      if (cfg.id === undefined) continue
      if (!expanded.has(cfg.id)) continue
      const id = cfg.id
      if (fetchedRef.current.has(id)) continue
      fetchedRef.current.add(id)
      queueMicrotask(() => {
        if (cancelled) return
        setItemsStatus((prev) => (prev[id] ? prev : { ...prev, [id]: 'loading' }))
      })
      fetchLayerRows(cfg)
        .then((rows) => {
          if (cancelled) return
          setItemsByConfig((prev) => ({ ...prev, [id]: rows }))
          setItemsStatus((prev) => ({ ...prev, [id]: 'loaded' }))
        })
        .catch(() => {
          if (cancelled) return
          fetchedRef.current.delete(id)
          setItemsByConfig((prev) => ({ ...prev, [id]: [] }))
          setItemsStatus((prev) => ({ ...prev, [id]: 'error' }))
        })
    }
    return () => { cancelled = true }
  }, [expanded, configs])

  const grouped: Record<DataLinkLayerKind, DataLinkConfig[]> = {
    asset: [], sensor: [], camera: [], other: [],
  }
  for (const cfg of configs) grouped[inferLayerKind(cfg)].push(cfg)

  return (
    <>
      {(Object.keys(grouped) as DataLinkLayerKind[]).map((kind) => {
        const list = grouped[kind]
        if (list.length === 0) return null
        const meta = DL_META[kind]
        const groupHiddenCount = list.filter(
          (c) => c.id !== undefined && hiddenConfigIds.has(c.id),
        ).length
        const allHidden = groupHiddenCount === list.length
        return (
          <div key={kind}>
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="flex items-center gap-2">
                <meta.Icon className={`h-3.5 w-3.5 ${meta.tint}`} />
                <span className="text-[11px] uppercase tracking-wider font-semibold">
                  {meta.label}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {list.length - groupHiddenCount}/{list.length}
                </span>
              </span>
              <button
                type="button"
                onClick={() => onSetAll(kind, !allHidden)}
                className="text-[10px] text-primary hover:underline"
              >
                {allHidden ? 'Show all' : 'Hide all'}
              </button>
            </div>
            {list.map((cfg) => {
              if (cfg.id === undefined) return null
              const isHidden = hiddenConfigIds.has(cfg.id)
              const isExpanded = expanded.has(cfg.id)
              const isDisabled = cfg.enabled === false
              return (
                <div key={cfg.id} className="border-b border-border/30 last:border-b-0">
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(cfg.id!)}
                      className={
                        'flex flex-1 items-center gap-2 min-w-0 rounded-md px-1 py-0.5 text-left hover:bg-accent/60 ' +
                        (isDisabled ? 'opacity-50' : '')
                      }
                    >
                      {cfg.style?.defaultColor ? (
                        <span
                          className="flex-shrink-0 h-3 w-3 rounded-full ring-1 ring-black/10"
                          style={{ backgroundColor: cfg.style.defaultColor }}
                          aria-hidden
                        />
                      ) : (
                        <span className="flex-shrink-0 h-3 w-3 rounded-full bg-muted-foreground/30" aria-hidden />
                      )}
                      <span className="flex-1 truncate text-xs">
                        {cfg.name || `Widget #${cfg.id}`}
                      </span>
                      {isDisabled && (
                        <span className="flex-shrink-0 rounded-sm bg-amber-500/15 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                          off
                        </span>
                      )}
                      {activeFilterLabels?.[cfg.id] && (
                        <span
                          className="flex-shrink-0 flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-medium text-primary max-w-[7rem] truncate"
                          title={activeFilterLabels[cfg.id]}
                        >
                          <FilterIcon className="h-2.5 w-2.5" />
                          {activeFilterLabels[cfg.id]}
                        </span>
                      )}
                      {isExpanded ? (
                        <ChevronUp className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggle(cfg.id!)}
                      className={
                        'flex-shrink-0 h-7 w-7 grid place-items-center rounded-md hover:bg-accent/60 ' +
                        (isHidden ? 'text-muted-foreground' : 'text-emerald-500')
                      }
                      aria-label={isHidden ? 'Show layer' : 'Hide layer'}
                    >
                      {isHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                    {onToggleEnabled && (
                      <button
                        type="button"
                        onClick={() => onToggleEnabled(cfg.id!, cfg.enabled !== false)}
                        className={
                          'flex-shrink-0 h-7 w-7 grid place-items-center rounded-md hover:bg-accent/60 ' +
                          (isDisabled ? 'text-amber-500' : 'text-muted-foreground')
                        }
                        title={isDisabled ? 'Enable layer' : 'Disable layer'}
                      >
                        <Power className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="ms-6 me-2 mb-2 rounded-md border border-border/40 bg-background/60 px-1.5 py-1 text-[11px]">
                      <DataLinkItemsList
                        cfg={cfg}
                        status={itemsStatus[cfg.id] ?? 'idle'}
                        items={itemsByConfig[cfg.id]}
                        onZoomToItem={onZoomToItem}
                      />
                    </div>
                  )}
                </div>
              )
            })}
            <DropdownMenuSeparator />
          </div>
        )
      })}
    </>
  )
}

// ---- Data-link items list (reuses view-layers-panel pattern) ---------------

import { Filter as FilterIcon } from 'lucide-react'

function DataLinkItemsList({
  cfg,
  status,
  items,
  onZoomToItem,
}: {
  cfg: DataLinkConfig
  status: 'idle' | 'loading' | 'loaded' | 'error'
  items: EntityState[] | undefined
  onZoomToItem?: (cfg: DataLinkConfig, entity: EntityState) => void
}) {
  const labelKey = cfg.fieldMapping?.labelField ?? 'label'

  if (status === 'idle' || status === 'loading') {
    return <div className="px-1 py-1.5 text-muted-foreground">Loading items...</div>
  }
  if (status === 'error') {
    return <div className="px-1 py-1.5 text-destructive-foreground/80">Failed to load items.</div>
  }
  if (!items || items.length === 0) {
    return <div className="px-1 py-1.5 text-muted-foreground">No items yet.</div>
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((entity) => {
        const rawLabel = entity.payload[labelKey]
        const label = typeof rawLabel === 'string' || typeof rawLabel === 'number'
          ? String(rawLabel)
          : entity.entityKey
        return (
          <li
            key={entity.entityKey + ':' + (entity.id ?? '')}
            className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/40"
          >
            <span
              className="flex-shrink-0 h-2.5 w-2.5 rounded-full ring-1 ring-black/10"
              style={{ backgroundColor: cfg.style?.defaultColor ?? 'currentColor' }}
              aria-hidden
            />
            <span className="flex-1 truncate text-foreground/90" title={label}>
              {label}
            </span>
            {onZoomToItem && (
              <button
                type="button"
                onClick={() => onZoomToItem(cfg, entity)}
                className="flex-shrink-0 h-6 w-6 grid place-items-center rounded-md text-primary hover:bg-accent/80"
                aria-label="Zoom to item"
              >
                <Crosshair className="h-3 w-3" />
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
