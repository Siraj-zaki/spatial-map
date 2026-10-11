/**
 * Layers pill for the viewer — a dropdown selector that lists every
 * DataLinkConfig for the active warehouse, grouped by render kind
 * (asset / sensor / camera / other). Each row has an independent
 * eye toggle for visibility AND an expandable body that lists the
 * real items (entities) flowing through that config — each with its
 * own "zoom to item" button that flies the map to the entity's anchor.
 */

import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  Camera,
  ChevronDown,
  ChevronUp,
  Circle,
  Crosshair,
  Eye,
  EyeOff,
  Filter as FilterIcon,
  Layers as LayersIcon,
  MapPin,
  Power,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { DataLinkConfig, DataLinkFilter, EntityState } from '@/lib/db'
import { fetchLayerRows } from '@/lib/data-link/layer-rows'

export type LayerKind = 'asset' | 'sensor' | 'camera' | 'other'

export function inferLayerKind(cfg: DataLinkConfig): LayerKind {
  const n = (cfg.name ?? '').toLowerCase()
  if (n.includes('sensor')) return 'sensor'
  if (n.includes('camera')) return 'camera'
  if (n.includes('asset') || n.includes('forklift') || n.includes('vehicle')) return 'asset'
  return 'other'
}

interface ViewLayersPanelProps {
  configs: ReadonlyArray<DataLinkConfig>
  /** Set of config ids that should be HIDDEN from the map. */
  hiddenConfigIds: ReadonlySet<number>
  onToggle: (configId: number) => void
  onSetAll: (kind: LayerKind, hidden: boolean) => void
  /**
   * Called when the user clicks the "zoom to item" affordance on a
   * particular entity. The parent (view.tsx) resolves the entity's
   * anchor (payload coord or matched shape centroid) and flies the map.
   */
  onZoomToItem?: (cfg: DataLinkConfig, entity: EntityState) => void
  /**
   * Called when the user clicks the power button to flip a config's
   * `enabled` flag in the DB. The overlay only renders configs with
   * `enabled === true`, so a disabled config won't appear on the map
   * even though it still shows in this panel. Surfacing the toggle
   * here lets the user re-enable a layer without bouncing through the
   * data-link-manager.
   */
  onToggleEnabled?: (configId: number, enabled: boolean) => void
  /**
   * v4 — per-layer filter state. The row only highlights the filter
   * icon when this map has an entry for the config; opening / editing
   * the filter is handled by a separate top-level widget via
   * `onFilterOpen`. Keeping this component free of the filter form's
   * state makes the dropdown feel light and lets the widget render
   * outside the dropdown's clipping context.
   */
  configFilters?: Readonly<Record<number, DataLinkFilter | null>>
  /**
   * Called when the user clicks the filter icon on a layer row.
   * The host (`view.tsx`) mounts the `<ViewFilterWidget>` and
   * responds to this by setting its own open state.
   */
  onFilterOpen?: (configId: number) => void
}

const KIND_META: Record<LayerKind, { label: string; Icon: typeof LayersIcon; tint: string }> = {
  asset:  { label: 'Assets',  Icon: MapPin,   tint: 'text-emerald-500' },
  sensor: { label: 'Sensors', Icon: Activity, tint: 'text-sky-500'     },
  camera: { label: 'Cameras', Icon: Camera,   tint: 'text-fuchsia-500' },
  other:  { label: 'Other',   Icon: Circle,   tint: 'text-slate-500'   },
}

export function ViewLayersPanel({
  configs,
  hiddenConfigIds,
  onToggle,
  onSetAll,
  onZoomToItem,
  onToggleEnabled,
  configFilters,
  onFilterOpen,
}: ViewLayersPanelProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [itemsByConfig, setItemsByConfig] = useState<Record<number, EntityState[] | undefined>>({})
  const [itemsStatus, setItemsStatus] = useState<Record<number, 'idle' | 'loading' | 'loaded' | 'error'>>({})
  // Ref of config ids we've already kicked off a fetch for. Tracking
  // this in a ref (not state) means the fetch trigger effect doesn't
  // re-run when status flips idle → loading → loaded, which would
  // cancel the in-flight promise via the cleanup function and leave
  // status stuck on 'loading'.
  const fetchedRef = useRef<Set<number>>(new Set())
  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Lazy-load the real items for a config the first time it's expanded.
  // We cache by config id so re-collapsing/re-expanding doesn't refetch.
  useEffect(() => {
    if (expanded.size === 0) return
    let cancelled = false
    for (const cfg of configs) {
      if (cfg.id === undefined) continue
      if (!expanded.has(cfg.id)) continue
      const id = cfg.id
      if (fetchedRef.current.has(id)) continue
      fetchedRef.current.add(id)
      // Defer the "loading" flag to a microtask so we don't synchronously
      // setState inside the effect body (react-hooks/set-state-in-effect).
      queueMicrotask(() => {
        if (cancelled) return
        setItemsStatus((prev) => (prev[id] ? prev : { ...prev, [id]: 'loading' }))
      })
      fetchLayerRows(cfg)
        .then((rows) => {
          if (cancelled) return
          // Debug aid: log the raw rows coming back from the backend so
          // the operator can see what payload keys + values each entity
          // actually carries. This is the data the match resolver + sub
          // renderers consume; when a layer doesn't render, comparing
          // these payload keys against the config's `match.join.payloadField`
          // usually pinpoints the mismatch in one glance.
          console.info('[view-layers] items arrived', {
            configId: id,
            configName: cfg.name,
            renderMode: cfg.renderMode,
            targetKind: cfg.targetKind,
            match: cfg.fieldMapping?.match,
            count: rows.length,
            rows: rows.slice(0, 5).map((r) => ({
              entityKey: r.entityKey,
              position: r.position,
              payload: r.payload,
            })),
          })
          setItemsByConfig((prev) => ({ ...prev, [id]: rows }))
          setItemsStatus((prev) => ({ ...prev, [id]: 'loaded' }))
        })
        .catch((err) => {
          if (cancelled) return
          console.error('[view-layers] items fetch failed', {
            configId: id,
            configName: cfg.name,
            error: err,
          })
          // Allow retry on the next expand — clear the ref entry so a
          // re-expand kicks off a fresh fetch.
          fetchedRef.current.delete(id)
          setItemsByConfig((prev) => ({ ...prev, [id]: [] }))
          setItemsStatus((prev) => ({ ...prev, [id]: 'error' }))
        })
    }
    return () => {
      cancelled = true
    }
  }, [expanded, configs])

  const grouped: Record<LayerKind, DataLinkConfig[]> = {
    asset: [], sensor: [], camera: [], other: [],
  }
  for (const cfg of configs) grouped[inferLayerKind(cfg)].push(cfg)
  const totalConfigs = configs.length
  const visibleCount = configs.filter(
    (c) => c.id !== undefined && !hiddenConfigIds.has(c.id),
  ).length

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
              ({visibleCount}/{totalConfigs})
            </span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-72 max-h-[70dvh] overflow-y-auto shadow-xl rounded-xl border-border/60 bg-popover/95 backdrop-blur-xl"
      >
        {totalConfigs === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No data-link widgets configured for this warehouse.
          </div>
        )}
        {(Object.keys(grouped) as LayerKind[]).map((kind) => {
          const list = grouped[kind]
          if (list.length === 0) return null
          const meta = KIND_META[kind]
          const groupHiddenCount = list.filter(
            (c) => c.id !== undefined && hiddenConfigIds.has(c.id),
          ).length
          const allHidden = groupHiddenCount === list.length
          return (
            <div key={kind}>
              <DropdownMenuLabel className="flex items-center justify-between px-2 py-1.5">
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
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onSetAll(kind, !allHidden)
                  }}
                  className="text-[10px] text-primary hover:underline"
                >
                  {allHidden ? 'Show all' : 'Hide all'}
                </button>
              </DropdownMenuLabel>
              {list.map((cfg) => {
                if (cfg.id === undefined) return null
                const isHidden = hiddenConfigIds.has(cfg.id)
                const isExpanded = expanded.has(cfg.id)
                const isDisabled = cfg.enabled === false
                return (
                  <div key={cfg.id} className="border-b border-border/30 last:border-b-0">
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      {/* Row body — clicking expands the detail area. */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          toggleExpanded(cfg.id!)
                        }}
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
                          <span
                            className="flex-shrink-0 rounded-sm bg-amber-500/15 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400"
                            title="This layer is disabled in the data-link manager — toggle the power button to re-enable."
                          >
                            off
                          </span>
                        )}
                        {isExpanded ? (
                          <ChevronUp className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                        ) : (
                          <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                        )}
                      </button>

                      {/* Visibility eye — independent of the row body. */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          onToggle(cfg.id!)
                        }}
                        className={
                          'flex-shrink-0 h-7 w-7 grid place-items-center rounded-md hover:bg-accent/60 ' +
                          (isHidden ? 'text-muted-foreground' : 'text-emerald-500')
                        }
                        aria-label={isHidden ? 'Show layer' : 'Hide layer'}
                        title={isHidden ? 'Show on map' : 'Hide from map'}
                      >
                        {isHidden ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>

                      {/* v4 — filter widget trigger. The actual form
                          is a separate `<ViewFilterWidget>` mounted at
                          the top of view.tsx; clicking here just tells
                          the host to open it for this config. Icon
                          lights up primary when the layer has an
                          active filter. */}
                      {onFilterOpen && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            onFilterOpen(cfg.id!)
                          }}
                          className={
                            'flex-shrink-0 h-7 w-7 grid place-items-center rounded-md hover:bg-accent/60 ' +
                            (configFilters?.[cfg.id!]
                              ? 'text-primary bg-primary/10'
                              : 'text-muted-foreground')
                          }
                          aria-label="Filter layer"
                          title={
                            configFilters?.[cfg.id!]
                              ? 'Layer is filtered — click to edit'
                              : 'Filter this layer by a payload field'
                          }
                        >
                          <FilterIcon className="h-3.5 w-3.5" />
                        </button>
                      )}

                      {/* Power — flips the DB `enabled` flag. Disabled
                          configs don't render on the map even when the
                          eye is open, so this is the only way to bring
                          them back without bouncing through the
                          data-link-manager. Hidden when the host didn't
                          wire the callback (e.g. read-only public view). */}
                      {onToggleEnabled && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            onToggleEnabled(cfg.id!, cfg.enabled !== false)
                          }}
                          className={
                            'flex-shrink-0 h-7 w-7 grid place-items-center rounded-md hover:bg-accent/60 ' +
                            (isDisabled
                              ? 'text-amber-500'
                              : 'text-muted-foreground')
                          }
                          aria-label={isDisabled ? 'Enable layer' : 'Disable layer'}
                          title={
                            isDisabled
                              ? 'Layer is disabled — click to enable'
                              : 'Disable layer (hide from map + stop fetching)'
                          }
                        >
                          <Power className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>

                    {isExpanded && (
                      <div className="ms-6 me-2 mb-2 rounded-md border border-border/40 bg-background/60 px-1.5 py-1 text-[11px]">
                        <ItemsList
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ItemsList({
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
  const lngKey = cfg.fieldMapping?.coordFields?.lng ?? 'lng'
  const latKey = cfg.fieldMapping?.coordFields?.lat ?? 'lat'

  // 'idle' (just expanded, fetch not yet kicked off) and 'loading' both
  // show the same "Loading…" placeholder — the microtask that flips
  // 'idle' → 'loading' runs in the next tick so there's a brief window
  // where status is still 'idle' but items is undefined. Treat both
  // as "loading" to avoid falling through to `items.map()`.
  if (status === 'idle' || status === 'loading') {
    return (
      <div className="px-1 py-1.5 text-muted-foreground">Loading items…</div>
    )
  }
  if (status === 'error') {
    return (
      <div className="px-1 py-1.5 text-destructive-foreground/80">
        Failed to load items.
      </div>
    )
  }
  if (!items || items.length === 0) {
    return (
      <div className="px-1 py-1.5 text-muted-foreground">No items yet.</div>
    )
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {items!.map((entity) => {
        const rawLabel = entity.payload[labelKey]
        const label =
          typeof rawLabel === 'string' || typeof rawLabel === 'number'
            ? String(rawLabel)
            : entity.entityKey
        // Inline position resolver — only handles coord-mode (payload
        // coordFields or backend-extracted `position`). Shape-anchored
        // modes resolve position via the parent's onZoomToItem callback.
        const rawLng = entity.payload[lngKey]
        const rawLat = entity.payload[latKey]
        const hasCoord =
          (typeof rawLng === 'number' && typeof rawLat === 'number') ||
          (!!entity.position && entity.position.length === 2)
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
            <button
              type="button"
              disabled={!onZoomToItem}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onZoomToItem?.(cfg, entity)
              }}
              className={
                'flex-shrink-0 h-6 w-6 grid place-items-center rounded-md hover:bg-accent/80 ' +
                (onZoomToItem
                  ? 'text-primary'
                  : 'text-muted-foreground/60')
              }
              aria-label="Zoom to item"
              title={hasCoord ? 'Zoom to item' : 'Zoom to matched shape'}
            >
              <Crosshair className="h-3 w-3" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
