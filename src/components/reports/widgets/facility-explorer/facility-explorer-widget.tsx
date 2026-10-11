/**
 * Facility explorer — the facility report set's main widget: a list of
 * items (areas, racks, markers, …) with thumbnails beside a live map of
 * the floor. Picking a row highlights the shape on the map and opens a
 * detail panel (big preview, every property, edit, delete, open in the
 * editor, previous / next); clicking a shape on the map picks its row.
 *
 * Bindings: { zoneId, tabs: [{ entity, queryRef, sourceId, title, label,
 * subtitle[], editable[] }] } (src/lib/reports/explorer-spec.ts) — one tab per facility source, each reading
 * its own query from the report (ReportQueryContext), so the page's
 * viewer filters narrow the list like every other widget.
 *
 * Writes go through src/lib/reports/facility-sources.ts (the shape API),
 * so the map — and any other open map — updates at once.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownWideNarrow,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  EyeOff,
  Loader2,
  MapPinned,
  PencilLine,
  SearchX,
  Table2,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ColorPicker } from '@/components/ui/color-picker'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { FilterTabs } from '@/components/filter-tabs'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { useReportQueries } from '@/components/reports/report-query-context'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast-store'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { MarkerIconGlyph } from '@/lib/marker-icons'
import {
  deleteFacilityRow,
  facilityEditorHref,
  facilityEntityName,
  facilityFieldLabel,
  isFacilityRowDeletable,
  writeFacilityRow,
} from '@/lib/reports/facility-sources'
import type { ReportFieldType, ReportWidget, RunReportResult, QueryRunResult } from '@/lib/reports-client'
import { parseEntityKey, shapeBounds, type ExplorerKind, type ExplorerShape } from './explorer-geometry'
import { FacilityMap, useFacilityShapes } from './facility-map'
import { DataPointThumb, ShapeThumb } from './shape-thumb'
import { dataPlacement, facilityPlacement, linkShapeKind, type Placement } from './explorer-placement'
import { ExplorerMapLayout, type ExplorerMapChrome } from './explorer-map-layout'
import { FloorPicker } from './floor-picker'
import type { MapInsets } from './facility-map'
import { useSpatialStore } from '@/lib/spatial-store'
import { evaluateEntityRules } from '@/lib/data-link/style-rule-evaluator'
import { useSourceSchema } from '@/components/reports/builder/wizard/use-source-schema'

interface ExplorerTab {
  /** `facility` (default): rows are shapes of a built-in facility source.
   *  `dataLink`: rows are records of a linked table, placed on the map by
   *  data link `dataLinkId` (read-only here; edits happen in the table). */
  kind?: 'facility' | 'dataLink'
  dataLinkId?: number
  /** Data tabs: the field shown as each row's title. */
  titleField?: string
  entity: string
  queryRef: string
  sourceId: number
  /** The author's tab name (report builder). */
  title?: string
  label?: string
  subtitle?: string[]
  editable?: string[]
}

interface ExplorerBindings {
  zoneId: number
  tabs: ExplorerTab[]
}

type Row = Record<string, unknown> & { entity_key: string }

/** Columns the detail panel never lists (ids, keys, coordinates). */
const HIDDEN_FACTS = new Set(['entity_key', 'id', 'name', 'facility_id', 'floor_id', 'lng', 'lat'])
const DETAIL_WIDTH = 380

function toRows(qr: QueryRunResult | undefined): Row[] {
  if (!qr) return []
  return qr.rows
    .map((r) => {
      const o: Record<string, unknown> = {}
      qr.columns.forEach((c, i) => (o[c.name] = r[i]))
      return o as Row
    })
    .filter((r) => typeof r.entity_key === 'string')
}

export function FacilityExplorerWidget({
  widget,
  result,
  locale,
  chrome,
}: {
  widget: ReportWidget
  result: RunReportResult
  locale: string
  /** Set by the full-map report layout: the explorer fills the page and
   *  the report's other pieces float around it (explorer-map-layout.tsx). */
  chrome?: ExplorerMapChrome
}) {
  const { t } = useTranslation()
  const b = (widget.bindings ?? {}) as unknown as ExplorerBindings
  const tabs = useMemo(() => (Array.isArray(b.tabs) ? b.tabs : []), [b.tabs])
  const zoneId = Number(b.zoneId)
  const ctx = useReportQueries()
  const wide = useMediaQuery('(min-width: 1024px)')

  const [tabIdx, setTabIdx] = useState(0)
  const tab = tabs[Math.min(tabIdx, Math.max(0, tabs.length - 1))]
  // Inside a report page every tab reads the shared results; the passed
  // `result` is only a fallback without one (it's an empty placeholder
  // while the first run is in flight, which must not read as "no rows").
  const qr = tab
    ? ctx
      ? ctx.results[tab.queryRef]
      : tab.queryRef === (widget as unknown as { queryRef?: string }).queryRef
        ? (result as unknown as QueryRunResult)
        : undefined
    : undefined
  const phase = tab ? ctx?.phases[tab.queryRef] : undefined
  // No result yet = still loading (also before the first run has
  // registered a phase); a finished run with no rows has a result.
  const loading = !qr && phase !== 'idle'
  const columnTypes = useMemo(() => {
    const out: Record<string, ReportFieldType> = {}
    for (const c of qr?.columns ?? []) out[c.name] = c.type
    return out
  }, [qr])

  // Edits and deletes show at once; the next report run brings the truth.
  const [overrides, setOverrides] = useState<Record<string, Record<string, unknown>>>({})
  const [deleted, setDeleted] = useState<Set<string>>(new Set())
  const [syncedQr, setSyncedQr] = useState(qr)
  if (syncedQr !== qr) {
    setSyncedQr(qr)
    setOverrides({})
    setDeleted(new Set())
  }

  const [sortBy, setSortBy] = useState<string>('name')
  // Every row of the tab; `rows` below is what the selected floors show.
  const allRows = useMemo(() => {
    const list = toRows(qr)
      .filter((r) => !deleted.has(r.entity_key))
      .map((r) => (overrides[r.entity_key] ? { ...r, ...overrides[r.entity_key] } : r))
    // "name" means the title field on a linked-data tab.
    const key = sortBy === 'name' && tab?.kind === 'dataLink' ? tab.titleField || 'entity_key' : sortBy
    const titleKey = tab?.kind === 'dataLink' ? tab.titleField || 'entity_key' : 'name'
    const dir = sortBy === 'name' || columnTypes[key] === 'text' ? 1 : -1
    return list.sort((a, c) => {
      const av = a[key]
      const cv = c[key]
      if (av === cv) return String(a[titleKey] ?? '').localeCompare(String(c[titleKey] ?? ''), locale, { numeric: true })
      if (av === null || av === undefined || av === '') return 1
      if (cv === null || cv === undefined || cv === '') return -1
      if (typeof av === 'number' && typeof cv === 'number') return (av - cv) * dir
      return String(av).localeCompare(String(cv), locale, { numeric: true }) * dir
    })
  }, [qr, deleted, overrides, sortBy, columnTypes, locale, tab])

  const { shapes, loaded } = useFacilityShapes(zoneId)

  // Linked-data tabs: the link (placement rules + live layer), its style
  // rules (row colours), and the table's field labels.
  const isData = tab?.kind === 'dataLink'
  const dataLinkConfigs = useSpatialStore((s) => s.dataLinkConfigs)
  const styleRules = useSpatialStore((s) => s.styleRules)
  const bins = useSpatialStore((s) => s.bins)
  const circles = useSpatialStore((s) => s.circles)
  const imagePlanes = useSpatialStore((s) => s.imagePlanes)
  const link = isData ? dataLinkConfigs.find((l) => l.id === tab.dataLinkId) : undefined
  const { schema: tabSchema } = useSourceSchema(isData ? tab.sourceId : null)
  const fieldLabel = (key: string): string =>
    isData ? (tabSchema?.fields.find((f) => f.key === key)?.label || key) : facilityFieldLabel(key)
  const placements = useMemo(() => {
    const out = new Map<string, Placement>()
    if (!isData) {
      for (const r of allRows) out.set(r.entity_key, facilityPlacement(shapes, r))
      return out
    }
    const snapshot = {
      bins, circles, imagePlanes,
      polygons: shapes.polygons, markers: shapes.markers, lines: shapes.lines, stairs: shapes.stairs,
      doors: shapes.doors, images: shapes.images, models: shapes.models, textLabels: shapes.textLabels,
    }
    for (const r of allRows) out.set(r.entity_key, dataPlacement(link, snapshot, r))
    return out
  }, [isData, allRows, shapes, link, bins, circles, imagePlanes])
  const titleOf = (r: Row): string => {
    const v = isData ? r[tab.titleField ?? ''] ?? r.entity_key : r.name
    return v === null || v === undefined || v === '' ? '—' : String(v)
  }
  // A data row's colour: its colour field, else the link's style rules,
  // else the link's default.
  const rowColour = (r: Row): string | undefined => {
    if (!link) return undefined
    const cf = link.fieldMapping?.colorField
    const direct = cf ? r[cf] : undefined
    if (typeof direct === 'string' && /^#[0-9a-f]{3,8}$/i.test(direct)) return direct
    const rule = evaluateEntityRules(styleRules, link.styleRuleIds ?? [], r)
    return rule?.fillColor ?? rule?.iconColor ?? link.style?.defaultColor
  }
  const floors = useMemo(
    () =>
      [...shapes.images]
        .filter((f) => f.id !== undefined)
        .sort((a, c) => (a.config.elevation ?? 0) - (c.config.elevation ?? 0)),
    [shapes.images],
  )

  // Floors shown: the viewer's pick (one, several or all — null), else the
  // one floor every row is on (a Floor filter), else the lowest. The list
  // and the map's data follow it: rows on hidden floors aren't listed, and
  // picking a row never switches floors. Rows with no known floor (a
  // record no shape or floor field places) stay listed, like unassigned
  // shapes in the viewer.
  const [floorSel, setFloorSel] = useState<ReadonlySet<number> | null | undefined>(undefined)
  const itemFloor = (r: Row | null | undefined): number | null => (r ? placements.get(r.entity_key)?.floor ?? null : null)
  const listFloor = useMemo(() => {
    const ids = new Set(allRows.map((r) => itemFloor(r)).filter((f) => f !== null))
    return ids.size === 1 ? [...ids][0] : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, placements])
  const autoFloor = listFloor ?? floors[0]?.id ?? null
  const floorsKey = (() => {
    const shown = floorSel !== undefined ? floorSel : autoFloor !== null ? new Set([autoFloor]) : null
    return shown === null ? 'all' : [...shown].sort((a, b) => a - b).join(',')
  })()
  // One Set per distinct selection, so the map's filters don't re-run every render.
  const mapFloors = useMemo<ReadonlySet<number> | null>(
    () => (floorsKey === 'all' ? null : new Set(floorsKey.split(',').filter(Boolean).map(Number))),
    [floorsKey],
  )
  const mapFloor = mapFloors !== null && mapFloors.size === 1 ? [...mapFloors][0] : null
  const rows = useMemo(() => {
    if (mapFloors === null) return allRows
    return allRows.filter((r) => {
      const f = placements.get(r.entity_key)?.floor
      return f === null || f === undefined || mapFloors.has(f)
    })
  }, [allRows, placements, mapFloors])

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // Hovering a row shows where it is (a ghost pin; the camera stays).
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const hoverPoint = useMemo<[number, number] | null>(() => {
    if (!hoverKey || hoverKey === selectedKey) return null
    const p = placements.get(hoverKey)
    if (p?.point) return p.point
    const b = p?.shape ? shapeBounds(p.shape) : null
    return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null
  }, [hoverKey, selectedKey, placements])
  const selectedIdx = selectedKey ? rows.findIndex((r) => r.entity_key === selectedKey) : -1
  const selectedRow = selectedIdx >= 0 ? rows[selectedIdx] : null
  const selectedPlacement = selectedKey ? placements.get(selectedKey) : undefined
  const selectedShape = selectedPlacement?.shape ?? null

  const [editing, setEditing] = useState(false)
  const select = useCallback((key: string | null) => {
    setSelectedKey(key)
    setEditing(false)
  }, [])
  // Hiding the picked item's floor closes the item.
  const pickFloors = (next: ReadonlySet<number> | null) => {
    setFloorSel(next)
    const f = itemFloor(selectedKey ? allRows.find((r) => r.entity_key === selectedKey) : null)
    if (next !== null && f !== null && !next.has(f)) select(null)
  }

  // Switching tab clears the selection and the sort.
  const changeTab = (i: number) => {
    setTabIdx(i)
    setSortBy('name')
    select(null)
  }

  const onMapSelect = (kind: ExplorerKind, id: number) => {
    const hit = rows.find((r) => {
      const s = placements.get(r.entity_key)?.shape
      return s?.kind === kind && s.shape.id === id
    })
    if (hit) select(hit.entity_key)
    else toast.info(t('reports.explorer.notInList', { defaultValue: 'That item isn’t in this list — clear the filters to see it.' }))
  }

  // Keep the picked row in view.
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  useEffect(() => {
    if (selectedKey) itemRefs.current.get(selectedKey)?.scrollIntoView({ block: 'nearest' })
  }, [selectedKey])

  const step = (delta: number) => {
    if (rows.length === 0) return
    const i = selectedIdx < 0 ? 0 : (selectedIdx + delta + rows.length) % rows.length
    select(rows[i].entity_key)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, [contenteditable], [role=dialog]')) return
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1) }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1) }
    else if (e.key === 'Escape' && selectedKey) { e.preventDefault(); select(null) }
  }

  const refreshSoon = useRef<number | null>(null)
  const refreshReport = () => {
    if (refreshSoon.current) window.clearTimeout(refreshSoon.current)
    refreshSoon.current = window.setTimeout(() => ctx?.refresh(), 600)
  }

  // ---- delete ----------------------------------------------------------
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const doDelete = async () => {
    if (!selectedRow) return
    const key = selectedRow.entity_key
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteFacilityRow(key)
      const next = rows[selectedIdx + 1] ?? rows[selectedIdx - 1]
      setDeleted((prev) => new Set(prev).add(key))
      select(next && next.entity_key !== key ? next.entity_key : null)
      setConfirmDelete(false)
      toast.success(t('reports.explorer.deleted', { name: String(selectedRow.name ?? ''), defaultValue: 'Deleted “{{name}}”' }))
      refreshReport()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  if (!Number.isFinite(zoneId) || tabs.length === 0) {
    return (
      <div className="flex h-full min-h-[14rem] items-center justify-center rounded-xl border bg-card p-6 text-sm text-muted-foreground">
        {t('reports.explorer.notConfigured', { defaultValue: 'This explorer isn’t linked to a facility.' })}
      </div>
    )
  }

  // The author's name (builder), else the entity's translated name.
  const tabLabel = (tb: ExplorerTab) => tb.title?.trim() || facilityEntityName(tb.entity, tb.label)
  // The row's headline number (first numeric field under the name),
  // shown right-aligned; the rest stay in the subtitle.
  const metricField = (tab?.subtitle ?? []).find((f) => columnTypes[f] === 'number')
  const subtitleFields = (tab?.subtitle ?? []).filter((f) => f !== metricField)
  const fmtNumber = (v: unknown) =>
    typeof v === 'number' ? formatFact(metricField ?? '', v, 'number', locale, t, isData) : '—'
  const sortOptions = ['name', ...(tab?.subtitle ?? []).filter((f) => f in columnTypes)]
  const detail = selectedRow ? (
    <ExplorerDetail
      key={selectedRow.entity_key}
      row={selectedRow}
      item={selectedShape}
      entity={tab.entity}
      data={
        isData
          ? {
              title: titleOf(selectedRow),
              placement: selectedPlacement,
              sourceId: tab.sourceId,
              icon: link?.style?.defaultIcon,
              colour: rowColour(selectedRow),
              hiddenFields: [link?.fieldMapping?.coordFields?.lng, link?.fieldMapping?.coordFields?.lat].filter((f): f is string => !!f),
              fieldLabel,
              linked: Boolean(link),
            }
          : undefined
      }
      editable={isData ? [] : (tab.editable ?? []).filter((c) => c in columnTypes)}
      embedded={Boolean(chrome)}
      columns={qr?.columns ?? []}
      columnTypes={columnTypes}
      index={selectedIdx}
      total={rows.length}
      locale={locale}
      zoneId={zoneId}
      editing={editing}
      onEdit={setEditing}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
      onClose={() => select(null)}
      onDelete={() => {
        setDeleteError(null)
        setConfirmDelete(true)
      }}
      onSaved={(patch) => {
        setOverrides((prev) => ({ ...prev, [selectedRow.entity_key]: { ...prev[selectedRow.entity_key], ...patch } }))
        setEditing(false)
        toast.success(t('reports.explorer.saved', { defaultValue: 'Saved — the map is up to date.' }))
        refreshReport()
      }}
    />
  ) : null

  // The list scrolls inside a fixed-height cell: every ancestor down to
  // the scroller must be bounded (h-full + min-h-0), or the list grows to
  // fit all items and the card clips it.
  const list = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {loading
            ? t('reports.explorer.loading', { defaultValue: 'Loading…' })
            : t('reports.explorer.count', { count: rows.length, defaultValue: '{{count}} items' })}
        </span>
        <label className={cn('ms-auto flex items-center gap-1.5 text-xs text-muted-foreground', loading && 'invisible')}>
          <ArrowDownWideNarrow className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">{t('reports.explorer.sortBy', { defaultValue: 'Sort by' })}</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="h-7 rounded-md border bg-background px-1.5 text-xs text-foreground"
          >
            {sortOptions.map((f) => (
              <option key={f} value={f}>
                {f === 'name' && isData ? fieldLabel(tab.titleField ?? 'entity_key') : fieldLabel(f)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="listbox" aria-label={tabLabel(tab)}>
        {loading &&
          Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5">
              <div className="h-11 w-11 animate-pulse rounded-lg bg-muted" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        {!loading && rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <SearchX className="h-8 w-8 text-muted-foreground/60" aria-hidden />
            <p className="text-sm font-medium">{t('reports.explorer.emptyTitle', { defaultValue: 'Nothing to show' })}</p>
            <p className="max-w-[16rem] text-xs text-muted-foreground">
              {t('reports.explorer.emptyBody', { defaultValue: 'Try clearing the filters above, or add items in the editor.' })}
            </p>
            <Button asChild variant="outline" size="sm" className="mt-1">
              <a href={`/create-grids?warehouseId=${zoneId}`}>
                <MapPinned className="h-3.5 w-3.5" />
                {t('reports.explorer.openEditor', { defaultValue: 'Open the editor' })}
              </a>
            </Button>
          </div>
        )}
        {!loading &&
          rows.map((r) => {
            const active = r.entity_key === selectedKey
            const hidden = !isData && r.visible === false
            return (
              <button
                key={r.entity_key}
                ref={(el) => {
                  if (el) itemRefs.current.set(r.entity_key, el)
                  else itemRefs.current.delete(r.entity_key)
                }}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => select(active ? null : r.entity_key)}
                onMouseEnter={() => setHoverKey(r.entity_key)}
                onMouseLeave={() => setHoverKey((k) => (k === r.entity_key ? null : k))}
                onFocus={() => setHoverKey(r.entity_key)}
                onBlur={() => setHoverKey((k) => (k === r.entity_key ? null : k))}
                className={cn(
                  'sgv-row flex w-full items-center gap-3 border-s-2 px-3 py-2 text-start',
                  active ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-accent/60',
                )}
              >
                <RowThumb placement={loaded ? placements.get(r.entity_key) : undefined} entity={tab.entity} loaded={loaded} icon={link?.style?.defaultIcon} colour={isData ? rowColour(r) : undefined} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{titleOf(r)}</span>
                    {hidden && (
                      <EyeOff className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t('reports.explorer.hidden', { defaultValue: 'Hidden' })} />
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {isData && rowColour(r) && (
                      <span className="h-2 w-2 shrink-0 rounded-full ring-2 ring-background" style={{ background: rowColour(r) }} aria-hidden />
                    )}
                    <span className="truncate">
                    {subtitleFields
                      .map((f) =>
                        isData && typeof r[f] === 'number'
                          ? `${fieldLabel(f)} ${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(r[f] as number)}`
                          : formatFact(f, r[f], columnTypes[f], locale, t, isData),
                      )
                      .filter((v) => v !== '—')
                      .join(' · ')}
                    </span>
                  </span>
                </span>
                {metricField && r[metricField] !== null && r[metricField] !== undefined && (
                  <span className="ms-1 shrink-0 text-end">
                    <span className="block text-sm font-semibold tabular-nums leading-tight">{fmtNumber(r[metricField])}</span>
                    <span className="block max-w-[6rem] truncate text-[10px] text-muted-foreground">{fieldLabel(metricField)}</span>
                  </span>
                )}
              </button>
            )
          })}
      </div>
    </div>
  )

  const renderMap = (opts: { rightInset?: number; insets?: MapInsets }) =>
    Number.isFinite(zoneId) ? (
      // Fades in once the facility is loaded and framed — never a flash of
      // the whole world first.
      <div className={cn('absolute inset-0 motion-safe:transition-opacity motion-safe:duration-500', loaded ? 'opacity-100' : 'opacity-0')}>
      <FacilityMap
        shapes={shapes}
        floors={mapFloors}
        selected={selectedShape}
        selectedPoint={selectedPlacement?.point ?? null}
        selectableKind={isData ? linkShapeKind(link) : ((parseEntityKey(`${entityApiKind(tab.entity)}:0`)?.kind as ExplorerKind) ?? null)}
        onSelect={onMapSelect}
        rightInset={opts.rightInset}
        insets={opts.insets}
        hoverPoint={hoverPoint}
        dataLinks={isData && link ? linkList(link) : undefined}
        styleRules={styleRules}
        styleId={chrome?.mapStyle}
      />
      </div>
    ) : null
  const floorButtons =
    floors.length > 1
      ? [
          <button
            key="all"
            type="button"
            onClick={() => pickFloors(null)}
            className={cn(
              'whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors',
              mapFloors === null ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
            aria-pressed={mapFloors === null}
          >
            {t('reports.mapView.allFloors', { defaultValue: 'All floors' })}
          </button>,
          ...floors.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => pickFloors(new Set([f.id as number]))}
              className={cn(
                'whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors',
                mapFloor === f.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
              aria-pressed={mapFloor === f.id}
              title={f.name}
            >
              <span className="block max-w-[10rem] truncate">{f.name}</span>
            </button>
          )),
        ]
      : null
  // The same pill every map shows while it loads (mapbox-map.tsx).
  const mapLoading = !loaded ? (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status" aria-live="polite">
      <div className="sgv-glass flex items-center gap-3 rounded-full px-4 py-2 text-xs font-medium text-muted-foreground">
        <span className="relative h-1 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className="sgv-indeterminate absolute inset-y-0 start-0 w-1/3 rounded-full bg-primary" />
        </span>
        {t('view.loadState.loading', { defaultValue: 'Loading facility…' })}
      </div>
    </div>
  ) : null

  const mapPane = (
    <div className="relative min-h-0 overflow-hidden bg-muted/40">
      {renderMap({ rightInset: wide && selectedRow ? DETAIL_WIDTH : 0 })}
      {floorButtons && (
        <div className="absolute start-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] gap-1 overflow-x-auto rounded-lg border bg-card/90 p-1 shadow-sm backdrop-blur">
          {floorButtons}
        </div>
      )}
      {mapLoading}
      {wide && detail && (
        <div
          className="sgv-fade absolute inset-y-0 end-0 z-20 flex flex-col border-s bg-card/95 shadow-xl backdrop-blur"
          style={{ width: DETAIL_WIDTH }}
        >
          {detail}
        </div>
      )}
    </div>
  )

  const tabsBar =
    tabs.length > 1 ? (
      <FilterTabs
        ariaLabel={t('reports.explorer.kinds', { defaultValue: 'What to show' })}
        value={String(Math.min(tabIdx, tabs.length - 1))}
        onChange={(v) => changeTab(Number(v))}
        items={tabs.map((tb, i) => ({
          value: String(i),
          label: tabLabel(tb),
          // The open tab counts what the selected floors show.
          count: i === Math.min(tabIdx, tabs.length - 1) ? rows.length : ctx?.results[tb.queryRef]?.rowCount,
        }))}
      />
    ) : null
  const confirmDialog = (
    <ConfirmDialog
      open={confirmDelete}
      onOpenChange={(o) => {
        if (!o) {
          setConfirmDelete(false)
          setDeleteError(null)
        }
      }}
      title={t('reports.facility.deleteOneTitle', { name: String(selectedRow?.name ?? ''), defaultValue: 'Delete "{{name}}"?' })}
      description={t('reports.facility.deleteDescription', {
        defaultValue: 'They are removed from the map for everyone, the same as deleting them in the editor. This can\'t be undone.',
      })}
      confirmLabel={t('reports.facility.deleteConfirm', { defaultValue: 'Delete' })}
      onConfirm={() => void doDelete()}
      busy={deleting}
      error={deleteError}
    />
  )

  if (chrome) {
    return (
      <>
        <ExplorerMapLayout
          wide={wide}
          chrome={chrome}
          title={tabs.length > 1 ? widget.title || tabLabel(tab) : tabLabel(tab)}
          count={loading ? null : rows.length}
          tabsBar={tabsBar}
          list={list}
          detail={detail}
          onCloseDetail={() => select(null)}
          floorPicker={
            <FloorPicker
              floors={floors.map((f) => ({ id: f.id as number, name: f.name, elevation: f.config.elevation ?? 0 }))}
              selected={mapFloors}
              onChange={pickFloors}
            />
          }
          loading={mapLoading}
          renderMap={(insets) => renderMap({ insets })}
          onKeyDown={onKeyDown}
        />
        {confirmDialog}
      </>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-sm" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        {widget.title && <h3 className="text-sm font-medium">{widget.title}</h3>}
        {tabsBar && <div className="ms-auto">{tabsBar}</div>}
      </div>
      {wide ? (
        <div className="grid h-[640px] min-h-0 grid-cols-[minmax(18rem,22rem)_1fr]" style={{ gridTemplateRows: 'minmax(0, 1fr)' }}>
          <div className="h-full min-h-0 overflow-hidden border-e">{list}</div>
          {mapPane}
        </div>
      ) : (
        <div className="grid min-h-0" style={{ gridTemplateRows: '22rem 20rem' }}>
          <div className="h-full min-h-0 overflow-hidden">{list}</div>
          <div className="relative border-t">{mapPane}</div>
        </div>
      )}
      {!wide && (
        <Sheet open={detail !== null} onOpenChange={(o) => !o && select(null)}>
          <SheetContent side="bottom" hideDefaultClose className="flex max-h-[85dvh] flex-col p-0">
            <SheetTitle className="sr-only">{String(selectedRow?.name ?? '')}</SheetTitle>
            {detail}
          </SheetContent>
        </Sheet>
      )}
      {confirmDialog}
    </div>
  )
}

/** Stable one-element array per link object (the overlay keys on it). */
const linkLists = new WeakMap<object, readonly import('@/lib/db').DataLinkConfig[]>()
function linkList(link: import('@/lib/db').DataLinkConfig): readonly import('@/lib/db').DataLinkConfig[] {
  let list = linkLists.get(link)
  if (!list) {
    list = [link]
    linkLists.set(link, list)
  }
  return list
}

/** List / detail preview for a row: its shape, else the link's point
 *  icon, else a neutral glyph (not on the map). */
function RowThumb({
  placement,
  entity,
  loaded,
  icon,
  colour,
  size = 'sm',
}: {
  placement: Placement | undefined
  entity: string
  loaded: boolean
  icon?: string
  colour?: string
  size?: 'sm' | 'lg'
}) {
  if (!loaded) return <ShapeThumb item={null} entity={entity} size={size} />
  if (placement?.shape) return <ShapeThumb item={placement.shape} entity={entity} size={size} />
  if (placement?.point || entity === 'data') return <DataPointThumb icon={icon} color={colour} size={size} />
  return <ShapeThumb item={null} entity={entity} size={size} />
}

/** Explorer shape kind → facility entity key (for its display name). */
function placedEntity(kind: ExplorerKind): string {
  switch (kind) {
    case 'polygons': return 'areas'
    case 'grids': return 'racks'
    case 'images': return 'floors'
    case 'lines': return 'walls'
    default: return kind
  }
}

/** Facility entity → shape API kind (mirrors backend FacilityEntity.APIKind). */
function entityApiKind(entity: string): string {
  switch (entity) {
    case 'floors': return 'images'
    case 'areas': return 'polygons'
    case 'racks': return 'grids'
    case 'walls': return 'lines'
    case 'stairs':
    case 'lifts':
    case 'escalators': return 'stairs'
    default: return entity
  }
}

type TFn = ReturnType<typeof useTranslation>['t']

/** `plain`: a linked table's value — no facility units / count wording. */
function formatFact(field: string, value: unknown, type: ReportFieldType | undefined, locale: string, t: TFn, plain = false): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? t('common.yes', { defaultValue: 'Yes' }) : t('common.no', { defaultValue: 'No' })
  if (type === 'datetime' || type === 'date') return relativeTime(String(value), locale)
  if (typeof value === 'number') {
    const n = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)
    if (plain) return n
    if (field.endsWith('_m2')) return `${n} m²`
    if (field.endsWith('_m')) return `${n} m`
    if (field.endsWith('_count')) return t(`reports.explorer.counts.${field}`, { count: value, n, defaultValue: `${n} ${facilityFieldLabel(field).toLowerCase()}` })
    return n
  }
  return String(value)
}

interface DataDetail {
  title: string
  placement: Placement | undefined
  sourceId: number
  icon?: string
  colour?: string
  hiddenFields: string[]
  fieldLabel: (key: string) => string
  /** The report's data link still exists. */
  linked: boolean
}

function ExplorerDetail({
  row,
  item,
  entity,
  data,
  editable,
  columns,
  columnTypes,
  index,
  total,
  locale,
  zoneId,
  editing,
  onEdit,
  onPrev,
  onNext,
  onClose,
  onDelete,
  onSaved,
  embedded = false,
}: {
  row: Row
  item: ExplorerShape | null
  entity: string
  /** Set for a linked-data row (read-only; edits happen in the table). */
  data?: DataDetail
  editable: string[]
  columns: { name: string; type: ReportFieldType }[]
  columnTypes: Record<string, ReportFieldType>
  index: number
  total: number
  locale: string
  zoneId: number
  editing: boolean
  onEdit: (on: boolean) => void
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  onDelete: () => void
  onSaved: (patch: Record<string, unknown>) => void
  /** Inside the full map's Details panel, which has its own close. */
  embedded?: boolean
}) {
  const { t } = useTranslation()
  const key = row.entity_key
  const shapeKey = data ? (data.placement?.shape ? `${data.placement.shape.kind}:${data.placement.shape.shape.id}` : null) : key
  const href = shapeKey ? facilityEditorHref(shapeKey, Number(row.facility_id) || zoneId) : null
  const label = data ? data.fieldLabel : (k: string) => facilityFieldLabel(k)
  // A floor's own "floor" column is always empty; a data row hides only
  // its key and the coordinates that placed it.
  const allFacts = data
    ? columns.filter((c) => c.name !== 'entity_key' && !data.hiddenFields.includes(c.name))
    : columns.filter((c) => !HIDDEN_FACTS.has(c.name) && !(entity === 'floors' && c.name === 'floor'))
  // A linked row's status reads as a badge; its first numbers as tiles.
  const statusCol = data ? allFacts.find((c) => c.type === 'text' && /status|state|condition|health/i.test(c.name) && row[c.name]) : undefined
  const tiles = allFacts.filter((c) => c.type === 'number' && typeof row[c.name] === 'number' && !c.name.endsWith('_id')).slice(0, 4)
  const tileNames = new Set(tiles.map((c) => c.name))
  const facts = allFacts.filter((c) => !tileNames.has(c.name) && c.name !== statusCol?.name)
  const onMap = data
    ? data.placement?.shape
      ? `${data.placement.shape.shape.name || '—'} · ${facilityEntityName(placedEntity(data.placement.shape.kind))}`
      : data.placement?.point
        ? t('reports.explorer.atPosition', { lat: data.placement.point[1].toFixed(6), lng: data.placement.point[0].toFixed(6), defaultValue: 'At {{lat}}, {{lng}}' })
        : data.linked
          ? t('reports.explorer.notPlaced', { defaultValue: 'Not on the map — no matching shape' })
          : t('reports.explorer.linkGone', { defaultValue: 'Not on the map — the data link was removed' })
    : null

  return (
    <section className="sgv-fade flex min-h-0 flex-1 flex-col" aria-label={String(row.name ?? '') || facilityEntityName(entity)}>
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {data ? t('reports.explorer.record', { defaultValue: 'Record' }) : facilityEntityName(entity)}
        </span>
        <span className="ms-1 text-xs text-muted-foreground">
          {t('reports.explorer.position', { index: index + 1, total, defaultValue: '{{index}} of {{total}}' })}
        </span>
        <div className="ms-auto flex items-center">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onPrev} aria-label={t('reports.explorer.previous', { defaultValue: 'Previous' })} title={t('reports.explorer.previous', { defaultValue: 'Previous' })}>
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onNext} aria-label={t('reports.explorer.next', { defaultValue: 'Next' })} title={t('reports.explorer.next', { defaultValue: 'Next' })}>
            <ChevronRight className="h-4 w-4 rtl:rotate-180" />
          </Button>
          {!embedded && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose} aria-label={t('common.close', { defaultValue: 'Close' })} title={t('common.close', { defaultValue: 'Close' })}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        {data ? (
          <RowThumb placement={data.placement} entity={entity} loaded icon={data.icon} colour={data.colour} size="lg" />
        ) : (
          <ShapeThumb item={item} entity={entity} size="lg" />
        )}
        <h4 className="mt-3 break-words text-lg font-semibold leading-tight">{data ? data.title : String(row.name ?? '') || '—'}</h4>
        {statusCol && (
          <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border bg-background/60 px-2.5 py-0.5 text-xs font-medium">
            <span className="h-2 w-2 rounded-full" style={{ background: data?.colour ?? 'hsl(var(--muted-foreground))' }} aria-hidden />
            <span className="text-muted-foreground">{label(statusCol.name)}</span>
            {String(row[statusCol.name])}
          </span>
        )}
        {!data && row.visible === false && (
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <EyeOff className="h-3 w-3" aria-hidden />
            {t('reports.explorer.hiddenHint', { defaultValue: 'Hidden in the editor — shown here so you can find it.' })}
          </p>
        )}

        {editing ? (
          <EditForm
            row={row}
            columns={editable}
            columnTypes={columnTypes}
            onCancel={() => onEdit(false)}
            onSaved={onSaved}
          />
        ) : (
          <>
            <div className="mt-3 flex flex-wrap gap-2">
              {editable.length > 0 && (
                <Button size="sm" onClick={() => onEdit(true)}>
                  <PencilLine className="h-3.5 w-3.5" />
                  {t('reports.explorer.edit', { defaultValue: 'Edit' })}
                </Button>
              )}
              {href && (
                <Button asChild size="sm" variant="outline">
                  <a href={href}>
                    <MapPinned className="h-3.5 w-3.5" />
                    {t('reports.facility.openInEditorShort', { defaultValue: 'Open in editor' })}
                  </a>
                </Button>
              )}
              {data && (
                <Button asChild size="sm" variant={href ? 'ghost' : 'outline'}>
                  <a href={`/tables/${data.sourceId}`}>
                    <Table2 className="h-3.5 w-3.5" />
                    {t('reports.explorer.openTable', { defaultValue: 'Open in table' })}
                  </a>
                </Button>
              )}
              {!data && isFacilityRowDeletable(key) && (
                <Button size="sm" variant="ghost" className="text-danger hover:bg-danger/10 hover:text-danger" onClick={onDelete}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('reports.facility.deleteRowShort', { defaultValue: 'Delete' })}
                </Button>
              )}
            </div>
            {tiles.length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-2">
                {tiles.map((c) => (
                  <div key={c.name} className="rounded-lg border bg-muted/40 px-3 py-2">
                    <div className="truncate text-[11px] text-muted-foreground">{label(c.name)}</div>
                    <div className="truncate text-base font-semibold tabular-nums">
                      <FactValue field={c.name} value={row[c.name]} type={c.type} locale={locale} plain={Boolean(data)} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            <dl className="mt-4 divide-y rounded-lg border text-sm">
              {onMap && (
                <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-3 px-3 py-2">
                  <dt className="truncate text-muted-foreground">{t('reports.explorer.onMap', { defaultValue: 'On the map' })}</dt>
                  <dd className="min-w-0 break-words">{onMap}</dd>
                </div>
              )}
              {facts.map((c) => (
                <div key={c.name} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-3 px-3 py-2">
                  <dt className="truncate text-muted-foreground">{label(c.name)}</dt>
                  <dd className="min-w-0 break-words">
                    <FactValue field={c.name} value={row[c.name]} type={c.type} locale={locale} plain={Boolean(data)} />
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </section>
  )
}

function FactValue({ field, value, type, locale, plain = false }: { field: string; value: unknown; type: ReportFieldType; locale: string; plain?: boolean }) {
  const { t } = useTranslation()
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">—</span>
  if (typeof value === 'string' && (field === 'color' || field === 'icon_color' || /^#[0-9a-f]{6}$/i.test(value))) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="h-4 w-4 rounded border" style={{ background: value }} aria-hidden />
        <span className="font-mono text-xs">{value}</span>
      </span>
    )
  }
  if (field === 'icon' && typeof value === 'string') {
    return (
      <span className="inline-flex items-center gap-2">
        <MarkerIconGlyph icon={value} className="h-4 w-4" aria-hidden />
        {value}
      </span>
    )
  }
  if (type === 'datetime' || type === 'date') {
    return <span title={fullTime(String(value), locale)}>{relativeTime(String(value), locale)}</span>
  }
  return <>{formatFact(field, value, type, locale, t, plain)}</>
}

function EditForm({
  row,
  columns,
  columnTypes,
  onCancel,
  onSaved,
}: {
  row: Row
  columns: string[]
  columnTypes: Record<string, ReportFieldType>
  onCancel: () => void
  onSaved: (patch: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(columns.map((c) => [c, row[c] ?? ''])))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (c: string, v: unknown) => setValues((prev) => ({ ...prev, [c]: v }))

  const save = async () => {
    const patch: Record<string, unknown> = {}
    for (const c of columns) {
      const v = values[c]
      if (v === row[c] || (v === '' && (row[c] === null || row[c] === undefined))) continue
      if (columnTypes[c] === 'number') {
        if (v === '') patch[c] = ''
        else {
          const n = Number(v)
          if (!Number.isFinite(n)) {
            setError(t('reports.explorer.notANumber', { field: facilityFieldLabel(c), defaultValue: '{{field}} must be a number.' }))
            return
          }
          patch[c] = n
        }
      } else if (c === 'name' && String(v).trim() === '') {
        setError(t('reports.explorer.nameRequired', { defaultValue: 'Give it a name.' }))
        return
      } else {
        patch[c] = v
      }
    }
    if (Object.keys(patch).length === 0) {
      onCancel()
      return
    }
    setSaving(true)
    setError(null)
    try {
      await writeFacilityRow(row.entity_key, patch)
      onSaved(patch)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {columns.map((c) => {
        const id = `fx-${c}`
        const type = columnTypes[c]
        return (
          <div key={c} className="space-y-1.5">
            <Label htmlFor={id} className="text-xs">{facilityFieldLabel(c)}</Label>
            {type === 'boolean' ? (
              <div>
                <Switch id={id} checked={values[c] === true} onCheckedChange={(v) => set(c, Boolean(v))} />
              </div>
            ) : c === 'color' ? (
              <ColorPicker value={String(values[c] || '#888888')} onChange={(v) => set(c, v)} ariaLabel={facilityFieldLabel(c)} />
            ) : (
              <Input
                id={id}
                type={type === 'number' ? 'number' : 'text'}
                step="any"
                value={values[c] === null || values[c] === undefined ? '' : String(values[c])}
                onChange={(e) => set(c, e.target.value)}
                className="h-9"
                autoFocus={c === columns[0]}
              />
            )}
          </div>
        )
      })}
      {error && (
        <p role="alert" className="flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-2 text-xs text-danger">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('reports.explorer.save', { defaultValue: 'Save changes' })}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          {t('common.cancel', { defaultValue: 'Cancel' })}
        </Button>
      </div>
    </form>
  )
}
