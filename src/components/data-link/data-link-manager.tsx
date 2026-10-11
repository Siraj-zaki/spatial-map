/**
 * DataLinkManagerDialog — zone-wide inventory of every DataLinkConfig
 * for the active warehouse. Opens from the editor toolbar's Data
 * flyout (Manage data links) and is the primary entry point for
 * linking data to shapes in the v2 UX. See DESIGN-data-link-v2.md §1.
 *
 * Each row shows: target kind + shape name, stream, render mode,
 * enabled toggle, and edit/delete actions. Clicking + New or Edit
 * hands off to `DataLinkEditorDialog` with the appropriate prefill.
 * All mutations flow through the optimistic `useSpatialStore` path
 * (createLocal / updateLocal / deleteLocal + immediate commit).
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Pencil, Trash2, Search, X, Link2Off } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useSpatialStore } from '@/lib/spatial-store'
import { useApiQuery } from '@/lib/useApiQuery'
import { apiDb } from '@/lib/api-db'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import type { DataSource } from '@/lib/db'
import {
  useSpatialCircles,
  useSpatialLines,
  useSpatialMarkers,
  useSpatialModels,
  useSpatialPolygons,
} from '@/hooks/useSpatialShapes'
import { iconComponentForId } from '@/components/data-link/lucide-icon-picker'
import { DataLinkEditorV3Dialog as DataLinkEditorDialog } from '@/components/data-link/data-link-editor-v3'
import type { DataLinkConfig } from '@/lib/db'
import type { Stream } from '@/lib/data-link/contracts'

const RENDER_MODE_LABEL: Record<DataLinkConfig['renderMode'], string> = {
  'point-at-coord': 'Point (coord)',
  'point-on-shape': 'Point (shape)',
  'gauge-on-shape': 'Gauge',
  'shape-tint': 'Tint',
  heatmap: 'Heatmap',
  track: 'Track',
  'fov-cone': 'FOV cone',
  'roi-pulse': 'ROI pulse',
  'history-movement': 'History player',
}

const KIND_LABEL: Record<DataLinkConfig['targetKind'], string> = {
  polygon: 'Polygon',
  circle: 'Circle',
  marker: 'Marker',
  line: 'Line',
  image: 'Image',
  model: '3D Model',
  'grid-cell': 'Grid cell',
  'text-label': 'Text label',
  stair: 'Stair',
  door: 'Door',
}

export interface DataLinkManagerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Warehouse the manager scopes to. Only that zone's configs appear. */
  zoneId: number
}

export function DataLinkManagerDialog({
  open,
  onOpenChange,
  zoneId,
}: DataLinkManagerDialogProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  // Bumped every time the editor is opened so the dialog remounts and
  // its useState initializers re-hydrate from the `existing` config.
  // Without this, editing a saved layer shows empty inputs because the
  // form state was captured on first mount only. See §6 of DESIGN-data-link-v2.md.
  const [editorOpenTick, setEditorOpenTick] = useState(0)

  const allConfigs = useSpatialStore((s) => s.dataLinkConfigs)
  const streams = useSpatialStore((s) => s.streams)
  const { data: polygons } = useSpatialPolygons()
  const { data: circles } = useSpatialCircles()
  const { data: markers } = useSpatialMarkers()
  const { data: lines } = useSpatialLines()
  const { data: models } = useSpatialModels()

  const streamsById = useMemo(() => {
    const m = new Map<number, Stream>()
    for (const s of streams) if (s.id !== undefined) m.set(s.id, s as unknown as Stream)
    return m
  }, [streams])

  // v3 — layers can point at a DataSource directly (config.sourceId).
  // Look up the source name so the manager column shows the actual
  // origin instead of just the stream name.
  const tenantId = useCurrentTenantId()
  const sourcesQuery = useApiQuery(
    () => apiDb.dataSources.toArray(),
    ['data-sources', tenantId, 'data-link-manager'],
    { intervalMs: 0 },
  )
  const sourcesById = useMemo(() => {
    const m = new Map<number, DataSource>()
    for (const s of sourcesQuery.data ?? []) {
      if (s.id !== undefined) m.set(s.id, s)
    }
    return m
  }, [sourcesQuery.data])

  // Helper used by both the search filter and the row rendering.
  const sourceLabelFor = (c: DataLinkConfig): string => {
    if (c.sourceId !== undefined && c.sourceId !== null) {
      const src = sourcesById.get(c.sourceId)
      if (src) return `${src.name} (${src.entityKind ?? 'marker'})`
      return `source #${c.sourceId}`
    }
    if (c.streamId) {
      const stream = streamsById.get(c.streamId)
      if (stream) return `${stream.name} (stream)`
      return `stream #${c.streamId}`
    }
    return '—'
  }

  const configs = useMemo(() => {
    const zoneConfigs = allConfigs.filter((c) => c.zoneId === zoneId)
    const q = query.trim().toLowerCase()
    if (!q) return zoneConfigs
    return zoneConfigs.filter((c) => {
      const hay = [
        c.name,
        c.targetKind,
        c.renderMode,
        sourceLabelFor(c),
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [allConfigs, zoneId, query, sourcesById, streamsById])

  const editingConfig = useMemo(
    () => (editingId ? allConfigs.find((c) => c.id === editingId) ?? null : null),
    [allConfigs, editingId],
  )

  function shapeNameFor(config: DataLinkConfig): string {
    if (config.targetShapeId === undefined) return '—'
    const id = config.targetShapeId
    switch (config.targetKind) {
      case 'polygon': return polygons.find((s) => s.id === id)?.name ?? `#${id}`
      case 'circle':  return circles.find((s) => s.id === id)?.name ?? `#${id}`
      case 'marker':  return markers.find((s) => s.id === id)?.name ?? `#${id}`
      case 'line':    return lines.find((s) => s.id === id)?.name ?? `#${id}`
      case 'model':   return models.find((s) => s.id === id)?.name ?? `#${id}`
      default:        return `#${id}`
    }
  }

  function toggleEnabled(config: DataLinkConfig, next: boolean) {
    if (config.id === undefined) return
    const store = useSpatialStore.getState()
    store.updateLocal('data-link-configs', config.id, { enabled: next })
    void store.commit('data-link-configs')
  }

  function handleDelete(config: DataLinkConfig) {
    if (config.id === undefined) return
    if (typeof window !== 'undefined' && !window.confirm(
      t('dataLink.confirmDelete', {
        defaultValue: `Delete data link "${config.name}"?`,
        name: config.name,
      }),
    )) {
      return
    }
    const store = useSpatialStore.getState()
    store.deleteLocal('data-link-configs', config.id)
    void store.commit('data-link-configs')
  }

  function openNew() {
    setEditingId(null)
    setEditorOpenTick((t) => t + 1)
    setEditorOpen(true)
  }

  function openEdit(config: DataLinkConfig) {
    if (config.id === undefined) return
    setEditingId(config.id)
    setEditorOpenTick((t) => t + 1)
    setEditorOpen(true)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl" aria-describedby={undefined}>
          <DialogTitle>
            {t('dataLink.managerTitle', { defaultValue: 'Data links' })}
          </DialogTitle>

          <div className="flex items-center gap-2 mt-2">
            <div className="relative flex-1">
              <Search className="absolute start-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('dataLink.managerSearch', {
                  defaultValue: 'Search by name, kind, source…',
                })}
                className="ps-8 pe-8 h-8 text-xs"
                aria-label={t('dataLink.managerSearchAria', {
                  defaultValue: 'Search data links',
                })}
              />
              {query && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setQuery('')}
                  className="absolute end-1 top-1/2 -translate-y-1/2 h-6 w-6"
                  aria-label={t('dataLink.clearSearch', {
                    defaultValue: 'Clear search',
                  })}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
            <Button size="sm" onClick={openNew} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              {t('dataLink.newLink', { defaultValue: 'New link' })}
            </Button>
          </div>

          {configs.length === 0 ? (
            <EmptyState onNew={openNew} zoneHasAny={allConfigs.some((c) => c.zoneId === zoneId)} query={query} t={t} />
          ) : (
            <div className="max-h-[440px] overflow-y-auto -mx-6 px-6">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase text-muted-foreground border-b">
                  <tr>
                    <th className="text-start py-2 w-6" />
                    <th className="text-start py-2">
                      {t('dataLink.colName', { defaultValue: 'Name' })}
                    </th>
                    <th className="text-start py-2">
                      {t('dataLink.colTarget', { defaultValue: 'Target' })}
                    </th>
                    <th className="text-start py-2">
                      {t('dataLink.colSource', { defaultValue: 'Source' })}
                    </th>
                    <th className="text-start py-2">
                      {t('dataLink.colMode', { defaultValue: 'Mode' })}
                    </th>
                    <th className="text-start py-2 w-14">
                      {t('dataLink.colEnabled', { defaultValue: 'On' })}
                    </th>
                    <th className="w-20" />
                  </tr>
                </thead>
                <tbody>
                  {configs.map((c, i) => {
                    const Icon = iconComponentForId(c.style.defaultIcon)
                    return (
                      <tr
                        key={c.id ?? `unsaved-${i}`}
                        className="border-b border-border/50 hover:bg-accent/30"
                      >
                        <td className="py-1.5">
                          <div
                            className="w-6 h-6 rounded-full flex items-center justify-center"
                            style={{ background: c.style.defaultColor ?? '#0ea5e9' }}
                          >
                            {Icon && (
                              <Icon
                                size={12}
                                color={c.style.iconColor ?? '#ffffff'}
                                strokeWidth={2.25}
                              />
                            )}
                          </div>
                        </td>
                        <td className="py-1.5 font-medium">{c.name}</td>
                        <td className="py-1.5 text-muted-foreground">
                          {KIND_LABEL[c.targetKind]}
                          {c.targetShapeId !== undefined && (
                            <span className="ms-1 opacity-70">
                              · {shapeNameFor(c)}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 text-muted-foreground">
                          {sourceLabelFor(c)}
                        </td>
                        <td className="py-1.5 text-muted-foreground">
                          {RENDER_MODE_LABEL[c.renderMode] ?? c.renderMode}
                        </td>
                        <td className="py-1.5">
                          <Switch
                            checked={c.enabled}
                            onCheckedChange={(v) => toggleEnabled(c, v)}
                            aria-label={
                              c.enabled
                                ? t('dataLink.disable', { defaultValue: 'Disable link' })
                                : t('dataLink.enable', { defaultValue: 'Enable link' })
                            }
                          />
                        </td>
                        <td className="py-1.5 text-end">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEdit(c)}
                            className="h-7 w-7"
                            aria-label={t('common.edit', { defaultValue: 'Edit' })}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(c)}
                            className="h-7 w-7 text-destructive"
                            aria-label={t('common.delete', { defaultValue: 'Delete' })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <DataLinkEditorDialog
        key={`dl-editor-${editorOpenTick}`}
        open={editorOpen}
        onOpenChange={(o) => {
          setEditorOpen(o)
          if (!o) setEditingId(null)
        }}
        zoneId={zoneId}
        existing={editingConfig}
      />
    </>
  )
}

// ---------------------------------------------------------------- empty

function EmptyState({
  onNew,
  zoneHasAny,
  query,
  t,
}: {
  onNew: () => void
  zoneHasAny: boolean
  query: string
  t: ReturnType<typeof useTranslation>['t']
}) {
  if (zoneHasAny && query) {
    return (
      <div className="text-center py-10 text-xs text-muted-foreground border rounded-md mt-3 bg-muted/20">
        {t('dataLink.noMatches', {
          defaultValue: 'No data links match your search.',
        })}
      </div>
    )
  }
  return (
    <div className="text-center py-10 border rounded-md mt-3 bg-muted/20">
      <Link2Off className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
      <p className="text-xs text-muted-foreground mb-3">
        {t('dataLink.emptyManager', {
          defaultValue:
            'No data links yet. Pick a data source from /integrations first, then link it to shapes here.',
        })}
      </p>
      <Button size="sm" onClick={onNew} className="gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        {t('dataLink.newLink', { defaultValue: 'New link' })}
      </Button>
    </div>
  )
}
