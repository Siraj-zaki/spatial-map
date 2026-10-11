import { beginLoading } from '@/lib/loading-bar'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import {
  Warehouse,
  Boxes,
  PackageCheck,
  Forklift,
  Plus,
  Trash2,
  AlertCircle,
  Loader2,
  MapPin,
  Check,
  ExternalLink,
  Share2,
  Link2,
  Pencil,
  Settings as SettingsIcon,
  Copy as CopyIcon,
  Search,
  ChevronUp,
  ChevronDown,
  X,
  ArrowUpDown,
  LayoutGrid,
  List,
  MoreHorizontal,
} from 'lucide-react'
import { apiDb } from '@/lib/api-db'
import { apiPost } from '@/lib/api-client'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { queryCache, useApiQuery } from '@/lib/useApiQuery'
import {
  listWarehouseSummaries,
  type WarehouseFilteredStats,
  type WarehouseShareLinkSummary,
  type WarehouseSummariesResponse,
  type WarehouseSummaryRow as ServerWarehouseRow,
} from '@/lib/warehouses-client'
import { shareLinkUrl } from '@/lib/share-link-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageContainer, PageHero, rise } from '@/components/page-shell'
import { SolutionDialog } from '@/components/solutions/solution-dialog'
import { addSolutionItems, useActiveSolution } from '@/lib/solutions-client'
import { RoleGate } from '@/components/feedback/role-gate'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { QueryError } from '@/components/feedback/query-error'
import { useUrlState } from '@/hooks/useUrlState'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { toast } from '@/lib/toast-store'
import { EmptyState } from '@/components/empty-state'
import { FacilityCard, FacilityCardSkeleton, facilityEditorHref } from '@/components/facility-card'
import { StatCard } from '@/components/stat-card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsDialog } from '@/components/settings-dialog'
import { ShareLinkDialog, type ShareLinkDialogTab } from '@/components/share-link-dialog'
import { apiGet } from '@/lib/api-client'
import type { Zone, DataLinkConfig } from '@/lib/db'
import type { ImageShape } from '@/lib/shapes'

/** Curated swatches the dialog offers as one-tap presets. */
const COLOR_PRESETS = [
  '#6366f1', // indigo
  '#3b82f6', // blue
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#84cc16', // lime
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
] as const

const DEFAULT_COLOR = COLOR_PRESETS[0]

type SortKey = 'name' | 'binCount' | 'occupiedPct' | 'assetCount' | 'rackCount' | 'floorCount'
type SortDir = 'asc' | 'desc'

const DEFAULT_PAGE_SIZE = 25
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const
const SEARCH_DEBOUNCE_MS = 300

/** Refresh every view of the facility list (this page, the dashboard). */
function invalidateFacilityQueries() {
  queryCache.invalidate('zones')
  queryCache.invalidate('warehouse-summaries')
  queryCache.invalidate('dashboard-facilities')
  queryCache.invalidate('dashboard-overview')
}

/** Lightweight handle the bulk-delete dialog needs — just enough to show the count and target the right ids. */
interface DeleteTarget {
  id: number
  name: string
}

export default function Warehouses() {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const enabled = tenantId !== null

  // ---- Filter + sort + pagination state (drives the backend query)
  // Search / filter / sort / view live in the URL (?q=&empty=1&sort=&dir=&view=)
  // so refresh, back/forward and shared links keep what you were looking at.
  const [search, setSearch] = useUrlState<string>('q', '')
  const [debouncedSearch, setDebouncedSearch] = useState(() => search.trim())
  const [emptyParam, setEmptyParam] = useUrlState<string>('empty', '')
  const showEmptyOnly = emptyParam === '1'
  const setShowEmptyOnly = (next: boolean | ((prev: boolean) => boolean)) =>
    setEmptyParam((typeof next === 'function' ? next(showEmptyOnly) : next) ? '1' : '')
  const [sortParam, setSortParam] = useUrlState<string>('sort', 'name')
  const sortKey: SortKey = (['name', 'binCount', 'occupiedPct', 'assetCount', 'rackCount', 'floorCount'] as const).includes(sortParam as SortKey)
    ? (sortParam as SortKey)
    : 'name'
  const setSortKey = (k: SortKey) => setSortParam(k)
  const [dirParam, setDirParam] = useUrlState<string>('dir', 'asc')
  const sortDir: SortDir = dirParam === 'desc' ? 'desc' : 'asc'
  const setSortDir = (next: SortDir | ((prev: SortDir) => SortDir)) =>
    setDirParam(typeof next === 'function' ? next(sortDir) : next)
  const { canEdit, canManage } = useWorkspaceRole()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)

  // Debounce search keystrokes so we don't hit the backend on every letter.
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1) // Filter changed → jump back to page 1.
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [search])

  // Any filter/sort change resets to page 1 (done in the handlers below) so
  // the user isn't stranded on page 7 of a freshly-narrowed result.

  // Inside a solution (`?solution=`) the list, counts and KPIs cover just
  // its facilities.
  const { id: solutionId, solution } = useActiveSolution()

  // Single server query. The backend does ONE SQL trip with CTE aggregates
  // (rack/bin/occupancy/asset/floor counts per zone) + a COUNT(*) OVER()
  // window for the filtered total. Tenant-wide stats for the KPI cards
  // come in the same response.
  const summariesQuery = useApiQuery<WarehouseSummariesResponse>(
    () =>
      listWarehouseSummaries({
        solution: solutionId,
        search: debouncedSearch || undefined,
        emptyOnly: showEmptyOnly || undefined,
        sort: sortKey,
        dir: sortDir,
        page,
        pageSize,
      }),
    [
      'warehouse-summaries',
      tenantId,
      solutionId,
      solution?.updatedAt,
      debouncedSearch,
      showEmptyOnly,
      sortKey,
      sortDir,
      page,
      pageSize,
    ],
    { intervalMs: 10000, enabled },
  )

  const serverResponse = summariesQuery.data
  const serverRows = useMemo<ServerWarehouseRow[]>(
    () => serverResponse?.rows ?? [],
    [serverResponse],
  )
  // Tenant-wide warehouse count drives the "no warehouses at all" empty
  // state and the count badge. The KPI strip below uses `filteredStats`
  // instead so it reacts to the active filter.
  const warehouseCount = serverResponse?.stats.totalWarehouses ?? 0
  const tenantHasWarehouses = warehouseCount > 0
  const filteredStats: WarehouseFilteredStats = useMemo(
    () =>
      serverResponse?.filteredStats ?? {
        warehouses: 0,
        bins: 0,
        occupied: 0,
        assets: 0,
        avgOccupiedPct: 0,
      },
    [serverResponse],
  )
  const totalFiltered = serverResponse?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize))
  const initialLoading = enabled && summariesQuery.isLoading && !serverResponse
  const filteredOccupancyPct = Math.round(filteredStats.avgOccupiedPct * 100)

  // ---- Add-warehouse dialog
  const [adding, setAdding] = useState(false)
  const [managingSolution, setManagingSolution] = useState(false)

  // ---- Duplicate-warehouse dialog (source warehouse + new name/color)
  const [duplicating, setDuplicating] = useState<Zone | null>(null)
  // A row action that fetches before its dialog opens (share, duplicate,
  // settings): its ⋯ button spins and the top bar runs meanwhile.
  const [openingRow, setOpeningRow] = useState<number | null>(null)
  const whileOpening = async (id: number, work: () => Promise<void>) => {
    setOpeningRow(id)
    const end = beginLoading()
    try {
      await work()
    } finally {
      end()
      setOpeningRow((cur) => (cur === id ? null : cur))
    }
  }

  // ---- Settings dialog (warehouse or global tab)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsWarehouse, setSettingsWarehouse] = useState<Zone | null>(null)
  const [settingsTab, setSettingsTab] = useState<'warehouse' | 'global'>('global')

  // ---- Share-link chip copy indicator. Keyed by share_links.id (NOT
  // warehouse id) — a facility can have several links and only the one
  // that was clicked should flip to a checkmark.
  const [copiedLinkId, setCopiedLinkId] = useState<number | null>(null)

  // ---- Rich share-link dialog (per-row multi-link management).
  // When the user clicks the Share row action we open the full-featured
  // ShareLinkDialog against that warehouse. `shareFloorPlans` / `shareConfigs`
  // are lazy-loaded from the tenant-scoped endpoints so the picker + data-link
  // tabs render with real data. `shareTab` / `shareEditLinkId` let a click on
  // a specific chip land directly on that link's editor instead of a blank
  // create form.
  const [shareOpen, setShareOpen] = useState<Zone | null>(null)
  const [shareFloorPlans, setShareFloorPlans] = useState<Array<ImageShape & { id: number }>>([])
  const [shareConfigs, setShareConfigs] = useState<DataLinkConfig[]>([])
  const [shareTab, setShareTab] = useState<ShareLinkDialogTab>('general')
  const [shareEditLinkId, setShareEditLinkId] = useState<number | null>(null)

  // ---- Delete confirmation (single or bulk)
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null)
  const [pendingBulkDelete, setPendingBulkDelete] = useState<DeleteTarget[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteTyped, setDeleteTyped] = useState('')

  // ---- Multi-select for bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const selectedRows = useMemo(
    () => serverRows.filter((r) => selectedIds.has(r.id)),
    [serverRows, selectedIds],
  )

  const onSortClick = (key: SortKey) => {
    setPage(1)
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  // Share + open-settings/duplicate buttons need the full Zone (the row only
  // carries identity + aggregates), so we lazy-load the row from `/zones/{id}`
  // when the user actually clicks. Cheap — single primary-key fetch — and
  // keeps the listing endpoint lean.
  const handleShareRow = async (
    row: ServerWarehouseRow,
    focus?: { tab?: ShareLinkDialogTab; editLinkId?: number },
  ) => {
    // Fetch the full zone + its images + data-link configs in parallel so
    // the dialog's Layout / Data Links tabs render with real data on first
    // paint. Failures are non-fatal — the dialog opens with empty lists
    // and the user can still create labels-only links.
    await whileOpening(row.id, async () => {
    try {
      const [zone, images, configs] = await Promise.all([
        apiDb.zones.get(row.id),
        apiDb.images.toArray().catch(() => []),
        apiGet<DataLinkConfig[]>(`/data-links`).catch(() => []),
      ])
      if (!zone) return
      const zoneImages = (images as ImageShape[])
        .filter((img) => img.id !== undefined && img.zoneId === row.id)
        .sort((a, b) => (a.id ?? 0) - (b.id ?? 0)) as Array<ImageShape & { id: number }>
      const zoneConfigs = (Array.isArray(configs) ? configs : []).filter(
        (c) => c.zoneId === row.id || c.zoneId == null,
      )
      setShareFloorPlans(zoneImages)
      setShareConfigs(zoneConfigs)
      // Editing a specific link needs the editor tabs; otherwise land on
      // Manage when links already exist and on the create form when none do.
      const defaultTab: ShareLinkDialogTab =
        focus?.editLinkId != null || row.shareLinkCount === 0 ? 'general' : 'manage'
      setShareTab(focus?.tab ?? defaultTab)
      setShareEditLinkId(focus?.editLinkId ?? null)
      setShareOpen(zone)
    } catch (err) {
      console.warn('[warehouses] share dialog open failed', err)
    }
    })
  }

  // Copy a chip's public URL. Falls back silently when the clipboard is
  // blocked (insecure origin / denied permission) — the dialog's Manage tab
  // still offers a selectable input.
  const copyShareLink = async (link: WarehouseShareLinkSummary) => {
    try {
      await navigator.clipboard.writeText(shareLinkUrl(link.token))
      setCopiedLinkId(link.id)
      setTimeout(() => setCopiedLinkId((prev) => (prev === link.id ? null : prev)), 1800)
      toast.success(t('dashboard.shareCopied'), { description: link.label || undefined })
    } catch {
      /* clipboard denied — user can copy from the share dialog instead */
    }
  }
  const openDuplicate = (id: number) =>
    whileOpening(id, async () => {
      const zone = await apiDb.zones.get(id)
      if (zone) setDuplicating(zone)
    })
  const openSettings = (id: number) =>
    whileOpening(id, async () => {
      const zone = await apiDb.zones.get(id)
      if (!zone) return
      setSettingsWarehouse(zone)
      setSettingsTab('warehouse')
      setSettingsOpen(true)
    })

  const allVisibleSelected =
    serverRows.length > 0 && serverRows.every((r) => selectedIds.has(r.id))

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(serverRows.map((r) => r.id)))
    }
  }
  const toggleSelectOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const confirmBulkDelete = async () => {
    if (!pendingBulkDelete || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await Promise.all(pendingBulkDelete.map((row) => apiDb.zones.delete(row.id)))
      invalidateFacilityQueries()
      toast.success(t('warehouses.bulkDeleted', { defaultValue: '{{count}} facilities deleted', count: pendingBulkDelete.length }))
      setPendingBulkDelete(null)
      setSelectedIds(new Set())
    } catch (err) {
      console.error('[warehouses] bulk delete failed', err)
      setDeleteError(t('dashboard.deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await apiDb.zones.delete(pendingDelete.id)
      invalidateFacilityQueries()
      toast.success(t('warehouses.deleted', { defaultValue: '{{name}} deleted', name: pendingDelete.name }))
      setPendingDelete(null)
      setDeleteTyped('')
    } catch (err) {
      console.error('[warehouses] failed to delete warehouse', err)
      setDeleteError(t('dashboard.deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  const isFiltered = debouncedSearch !== '' || showEmptyOnly
  const anyAddress = serverRows.some((r) => Boolean(r.address))
  const [viewParam, setView] = useUrlState<'grid' | 'table'>('view', 'grid')
  const view: 'grid' | 'table' = viewParam === 'table' ? 'table' : 'grid'
  const sortLabels: Record<SortKey, string> = {
    name: t('warehouses.sortName', { defaultValue: 'Name' }),
    occupiedPct: t('warehouses.sortOccupancy', { defaultValue: 'Occupancy' }),
    binCount: t('warehouses.sortBins', { defaultValue: 'Most bins' }),
    assetCount: t('warehouses.sortAssets', { defaultValue: 'Most assets' }),
    rackCount: t('warehouses.sortRacks', { defaultValue: 'Most racks' }),
    floorCount: t('warehouses.sortFloors', { defaultValue: 'Most floors' }),
  }

  /** The row / card overflow menu. One set of actions in both views. */
  const rowMenu = (row: ServerWarehouseRow) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          aria-label={t('warehouses.rowActions', { defaultValue: 'Actions for {{name}}', name: row.name })}
          aria-busy={openingRow === row.id}
        >
          {openingRow === row.id ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <MoreHorizontal className="h-4 w-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem asChild className="cursor-pointer">
          <Link to={facilityEditorHref(row.id)}>
            <Pencil className="me-2 h-4 w-4" />
            {t('warehouses.editLayout', { defaultValue: 'Edit layout' })}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="cursor-pointer"
          onSelect={() => window.open(`/view/${row.id}`, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink className="me-2 h-4 w-4" />
          {t('dashboard.preview')}
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" disabled={!canEdit} onSelect={() => void handleShareRow(row)}>
          <Share2 className="me-2 h-4 w-4" />
          {t('dashboard.share')}
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" disabled={!canEdit} onSelect={() => void openDuplicate(row.id)}>
          <CopyIcon className="me-2 h-4 w-4" />
          {t('dashboard.duplicate', { defaultValue: 'Duplicate' })}
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer" disabled={!canEdit} onSelect={() => void openSettings(row.id)}>
          <SettingsIcon className="me-2 h-4 w-4" />
          {t('dashboard.settings')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer text-destructive focus:text-destructive"
          disabled={!canManage}
          onSelect={() => {
            setDeleteError(null)
            setPendingDelete({ id: row.id, name: row.name })
          }}
        >
          <Trash2 className="me-2 h-4 w-4" />
          {t('sidePanel.deleteZone')}
        </DropdownMenuItem>
        {!canEdit && (
          <p className="px-2 pb-1.5 pt-1 text-xs text-muted-foreground">
            {t('common.readOnlyHint', { defaultValue: 'You have view-only access in this workspace.' })}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <PageContainer>
      <PageHero
        title={t('warehouses.heroTitle', { defaultValue: 'Facilities' })}
        description={
          solution
            ? t('solutions.facilitiesDescription', { name: solution.name, defaultValue: 'The facilities in {{name}}. Open one to edit its layout, share it, or change its settings.' })
            : t('warehouses.heroDescription', {
                defaultValue: 'Every facility in this workspace. Open one to edit its layout, share it, or change its settings.',
              })
        }
        actions={
          <>
            <Button
              variant="outline"
              disabled={!canEdit}
              onClick={() => {
                setSettingsWarehouse(null)
                setSettingsTab('global')
                setSettingsOpen(true)
              }}
            >
              <SettingsIcon className="h-4 w-4" />
              <span className="hidden sm:inline">{t('dashboard.settings')}</span>
            </Button>
            <RoleGate allowed={canEdit}>
              <Button onClick={() => setAdding(true)} disabled={!canEdit}>
                <Plus className="h-4 w-4" />
                {t('dashboard.addWarehouse')}
              </Button>
            </RoleGate>
          </>
        }
      />

      {/* KPIs — follow the search / empty-only filter below. */}
      {(initialLoading || tenantHasWarehouses) && !summariesQuery.error && (
        <section
          {...rise(1, 'grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4')}
          aria-label={t('warehouses.kpiLabel', { defaultValue: 'Filtered totals' })}
        >
          <StatCard
            icon={Warehouse}
            label={t('warehouses.kpiFacilities', { defaultValue: 'Facilities' })}
            value={filteredStats.warehouses}
            hint={
              isFiltered
                ? t('warehouses.kpiShowingOf', {
                    defaultValue: 'Showing {{shown}} of {{total}}',
                    shown: filteredStats.warehouses,
                    total: warehouseCount,
                  })
                : undefined
            }
            loading={initialLoading}
          />
          <StatCard
            icon={Boxes}
            label={t('warehouses.kpiBins', { defaultValue: 'Bins' })}
            value={filteredStats.bins}
            loading={initialLoading}
          />
          <StatCard
            icon={PackageCheck}
            label={t('warehouses.kpiAvgOccupancy', { defaultValue: 'Occupancy' })}
            value={filteredStats.bins > 0 ? `${filteredOccupancyPct}%` : '—'}
            progress={filteredStats.bins > 0 ? filteredStats.avgOccupiedPct : undefined}
            progressTone="capacity"
            hint={
              filteredStats.bins > 0
                ? t('dashboard.occupancyHint', {
                    defaultValue: '{{occupied}} of {{total}} bins filled',
                    occupied: filteredStats.occupied.toLocaleString(),
                    total: filteredStats.bins.toLocaleString(),
                  })
                : t('dashboard.occupancyEmpty', { defaultValue: 'No bins yet' })
            }
            loading={initialLoading}
          />
          <StatCard
            icon={Forklift}
            label={t('warehouses.kpiAssets', { defaultValue: 'Assets' })}
            value={filteredStats.assets}
            loading={initialLoading}
          />
        </section>
      )}

      <section {...rise(2, 'flex flex-col gap-4')} aria-label={t('warehouses.tableTitle', { defaultValue: 'Facilities' })}>
        {/* Toolbar */}
        {tenantHasWarehouses && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1 sm:max-w-sm">
              <Search className="absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('warehouses.searchPlaceholder', { defaultValue: 'Search by name or address' })}
                className="ps-8"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted"
                  aria-label={t('common.clear', { defaultValue: 'Clear' })}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={showEmptyOnly ? 'secondary' : 'outline'}
                size="sm"
                className="h-9"
                aria-pressed={showEmptyOnly}
                onClick={() => {
                  setShowEmptyOnly((v) => !v)
                  setPage(1)
                }}
              >
                {showEmptyOnly && <Check className="h-3.5 w-3.5" />}
                {t('warehouses.showEmptyOnly', { defaultValue: 'Only empty' })}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9">
                    <ArrowUpDown className="h-3.5 w-3.5" />
                    {sortLabels[sortKey]}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {(Object.keys(sortLabels) as SortKey[]).map((key) => (
                    <DropdownMenuItem
                      key={key}
                      onSelect={() => {
                        setSortKey(key)
                        setSortDir(key === 'name' ? 'asc' : 'desc')
                        setPage(1)
                      }}
                      className="cursor-pointer"
                    >
                      <span className="flex-1">{sortLabels[key]}</span>
                      {sortKey === key && <Check className="h-3.5 w-3.5 text-primary" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="flex h-9 items-center rounded-md border p-0.5" role="group" aria-label={t('warehouses.viewMode', { defaultValue: 'View' })}>
                {(['grid', 'table'] as const).map((mode) => {
                  const Icon = mode === 'grid' ? LayoutGrid : List
                  const label =
                    mode === 'grid'
                      ? t('warehouses.viewGrid', { defaultValue: 'Grid' })
                      : t('warehouses.viewTable', { defaultValue: 'Table' })
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setView(mode)}
                      aria-pressed={view === mode}
                      aria-label={label}
                      title={label}
                      className={`flex h-full w-8 items-center justify-center rounded transition-colors ${
                        view === mode ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  )
                })}
              </div>
              <span className="text-sm text-muted-foreground tabular-nums sm:ms-2">
                {t('warehouses.matchCount', { defaultValue: '{{count}} match', count: totalFiltered })}
              </span>
            </div>
          </div>
        )}

        {/* Bulk action bar — shows when 1+ row is selected */}
        {selectedRows.length > 0 && (
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-primary/5 px-3 py-2">
            <span className="text-sm font-medium">
              {t('warehouses.bulkSelected', { defaultValue: '{{count}} selected', count: selectedRows.length })}
            </span>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                {t('warehouses.bulkClear', { defaultValue: 'Clear' })}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setDeleteError(null)
                  setPendingBulkDelete(selectedRows.map((r) => ({ id: r.id, name: r.name })))
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('warehouses.bulkDelete', { defaultValue: 'Delete' })}
              </Button>
            </div>
          </div>
        )}

        {summariesQuery.error && !serverResponse ? (
          <QueryError
            error={summariesQuery.error}
            onRetry={summariesQuery.mutate}
            what={t('dashboard.whatFacilities', { defaultValue: 'your facilities' })}
          />
        ) : initialLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FacilityCardSkeleton />
            <FacilityCardSkeleton />
            <FacilityCardSkeleton />
          </div>
        ) : !tenantHasWarehouses && solution ? (
          <EmptyState
            icon={Warehouse}
            title={t('solutions.noFacilitiesTitle', { name: solution.name, defaultValue: 'No facilities in {{name}} yet' })}
            description={t('solutions.noFacilitiesBody', { defaultValue: 'Add facilities from this workspace, or create a new one here — it joins the solution.' })}
            action={
              canEdit ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" onClick={() => setManagingSolution(true)}>
                    {t('solutions.addExisting', { defaultValue: 'Add existing' })}
                  </Button>
                  <Button onClick={() => setAdding(true)}>
                    <Plus className="h-4 w-4" />
                    {t('dashboard.addWarehouse')}
                  </Button>
                </div>
              ) : undefined
            }
          />
        ) : !tenantHasWarehouses ? (
          <EmptyState
            icon={Warehouse}
            title={t('dashboard.warehousesEmptyTitle', { defaultValue: 'No facilities yet' })}
            description={t('dashboard.warehousesEmptyBody', {
              defaultValue: 'Create a facility, drop in a floor plan, and start mapping racks, zones and assets.',
            })}
            action={
              canEdit ? (
                <Button onClick={() => setAdding(true)}>
                  <Plus className="h-4 w-4" />
                  {t('dashboard.addWarehouse')}
                </Button>
              ) : undefined
            }
          />
        ) : serverRows.length === 0 ? (
          <EmptyState
            icon={Search}
            title={t('warehouses.noResultsTitle', { defaultValue: 'No matching facilities' })}
            description={t('warehouses.noResults', { defaultValue: 'Try a different search or clear the filters.' })}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setSearch('')
                  setShowEmptyOnly(false)
                  setPage(1)
                }}
              >
                {t('warehouses.clearFilters', { defaultValue: 'Clear filters' })}
              </Button>
            }
          />
        ) : view === 'grid' ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {serverRows.map((row) => (
              <FacilityCard
                key={row.id}
                row={row}
                menu={rowMenu(row)}
                selected={selectedIds.has(row.id)}
                onToggleSelect={canManage ? () => toggleSelectOne(row.id) : undefined}
              />
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>
                    <input
                      type="checkbox"
                      role="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAll}
                      aria-label={t('warehouses.selectAll', { defaultValue: 'Select all' })}
                      className="rounded border-input"
                    />
                  </TableHead>
                  <SortableHeader
                    label={t('warehouses.colName', { defaultValue: 'Name' })}
                    active={sortKey === 'name'}
                    dir={sortDir}
                    onClick={() => onSortClick('name')}
                  />
                  {anyAddress && <TableHead>{t('warehouses.colAddress', { defaultValue: 'Address' })}</TableHead>}
                  <TableHead>{t('warehouses.colShareLinks', { defaultValue: 'Share links' })}</TableHead>
                  <SortableHeader label={t('warehouses.colRacks', { defaultValue: 'Racks' })} active={sortKey === 'rackCount'} dir={sortDir} onClick={() => onSortClick('rackCount')} align="end" />
                  <SortableHeader label={t('warehouses.colBins', { defaultValue: 'Bins' })} active={sortKey === 'binCount'} dir={sortDir} onClick={() => onSortClick('binCount')} align="end" />
                  <SortableHeader label={t('warehouses.colOccupancy', { defaultValue: 'Occupancy' })} active={sortKey === 'occupiedPct'} dir={sortDir} onClick={() => onSortClick('occupiedPct')} align="end" />
                  <SortableHeader label={t('warehouses.colAssets', { defaultValue: 'Assets' })} active={sortKey === 'assetCount'} dir={sortDir} onClick={() => onSortClick('assetCount')} align="end" />
                  <SortableHeader label={t('warehouses.colFloors', { defaultValue: 'Floors' })} active={sortKey === 'floorCount'} dir={sortDir} onClick={() => onSortClick('floorCount')} align="end" />
                  <TableHead className="w-12">
                    <span className="sr-only">{t('warehouses.colActions', { defaultValue: 'Actions' })}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {serverRows.map((row) => {
                  const checked = selectedIds.has(row.id)
                  return (
                    <TableRow key={row.id} data-testid="warehouse-row" data-state={checked ? 'selected' : undefined}>
                      <TableCell>
                        <input
                          type="checkbox"
                          role="checkbox"
                          checked={checked}
                          onChange={() => toggleSelectOne(row.id)}
                          aria-label={t('warehouses.selectRow', { defaultValue: 'Select {{name}}', name: row.name })}
                          className="rounded border-input"
                        />
                      </TableCell>
                      <TableCell className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.color }} aria-hidden />
                          <Link to={facilityEditorHref(row.id)} className="truncate font-medium hover:underline">
                            {row.name}
                          </Link>
                        </div>
                      </TableCell>
                      {anyAddress && (
                        <TableCell className="max-w-[18rem] text-muted-foreground">
                          {row.address ? (
                            <span className="flex items-center gap-1 truncate">
                              <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                              <span className="truncate">{row.address}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground/60">—</span>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="max-w-[20rem]">
                        <ShareLinksCell
                          links={row.shareLinks ?? []}
                          total={row.shareLinkCount}
                          copiedLinkId={copiedLinkId}
                          onCopy={copyShareLink}
                          onEdit={(link) => void handleShareRow(row, { editLinkId: link.id })}
                          onManage={() => void handleShareRow(row, { tab: 'manage' })}
                          onCreate={() => void handleShareRow(row, { tab: 'general' })}
                        />
                      </TableCell>
                      <TableCell className="text-end">{row.rackCount.toLocaleString()}</TableCell>
                      <TableCell className="text-end">{row.binCount.toLocaleString()}</TableCell>
                      <TableCell className="text-end">
                        {row.binCount > 0 ? `${Math.round(row.occupiedPct * 100)}%` : <span className="text-muted-foreground/60">—</span>}
                      </TableCell>
                      <TableCell className="text-end">{row.assetCount.toLocaleString()}</TableCell>
                      <TableCell className="text-end">{row.floorCount.toLocaleString()}</TableCell>
                      <TableCell className="text-end">{rowMenu(row)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination footer — only when there's enough to page through */}
        {totalFiltered > pageSize && (
          <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="text-muted-foreground tabular-nums">
              {t('warehouses.pageRange', {
                defaultValue: 'Showing {{from}}–{{to}} of {{total}}',
                from: (page - 1) * pageSize + 1,
                to: Math.min(page * pageSize, totalFiltered),
                total: totalFiltered,
              })}
            </div>
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span>{t('warehouses.pageSize', { defaultValue: 'Rows' })}</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value))
                    setPage(1)
                  }}
                  className="h-8 rounded-md border border-input bg-transparent px-1.5 text-sm"
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                {t('warehouses.prev', { defaultValue: 'Prev' })}
              </Button>
              <span className="px-1 tabular-nums">
                {t('warehouses.pageOf', { defaultValue: '{{page}} / {{total}}', page, total: totalPages })}
              </span>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
                {t('warehouses.next', { defaultValue: 'Next' })}
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Add-warehouse dialog */}
      <AddWarehouseDialog open={adding} onOpenChange={setAdding} />
      {managingSolution && solution && (
        <SolutionDialog open={managingSolution} onOpenChange={setManagingSolution} mode="items" solution={solution} />
      )}

      {/* Duplicate-warehouse dialog */}
      <DuplicateWarehouseDialog
        source={duplicating}
        onOpenChange={(open) => {
          if (!open) setDuplicating(null)
        }}
      />

      {/* Settings dialog — header opens the global tab, card opens the warehouse tab */}
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialTab={settingsTab}
        warehouse={settingsWarehouse ?? undefined}
      />

      {/* Rich share-link dialog — replaces the copy-only shortcut. Handles
          multi-link management, expiry, view caps, appearance + chrome
          overrides. See src/components/share-link-dialog.tsx. */}
      {shareOpen && shareOpen.id !== undefined && (
        <ShareLinkDialog
          open={shareOpen !== null}
          onOpenChange={(open) => {
            if (!open) setShareOpen(null)
          }}
          zone={{ id: shareOpen.id, name: shareOpen.name }}
          floorPlans={shareFloorPlans}
          dataLinkConfigs={shareConfigs}
          initialTab={shareTab}
          initialEditLinkId={shareEditLinkId}
          onLinksChanged={invalidateFacilityQueries}
        />
      )}

      {/* Bulk-delete confirmation */}
      <ConfirmDialog
        open={pendingBulkDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingBulkDelete(null)
            setDeleteError(null)
          }
        }}
        title={t('warehouses.bulkDeleteTitle', { count: pendingBulkDelete?.length ?? 0 })}
        description={t('warehouses.bulkDeleteBody')}
        confirmLabel={t('warehouses.bulkDeleteConfirm', { defaultValue: 'Delete {{count}} facilities', count: pendingBulkDelete?.length ?? 0 })}
        onConfirm={confirmBulkDelete}
        busy={deleting}
        error={deleteError}
      >
        <ul className="max-h-32 space-y-1 overflow-y-auto rounded-lg border bg-muted/30 p-2 text-sm">
          {(pendingBulkDelete ?? []).map((r) => (
            <li key={r.id} className="truncate">{r.name}</li>
          ))}
        </ul>
      </ConfirmDialog>

      {/* Single delete — wipes every shape, bin and rule in the facility, so
          the name must be typed to confirm (NN/g: reserve friction for
          serious, irreversible actions). */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null)
            setDeleteError(null)
            setDeleteTyped('')
          }
        }}
        title={t('dashboard.deleteWarehouseTitle')}
        description={t('dashboard.deleteWarehouseBody', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('warehouses.deleteConfirm', { defaultValue: 'Delete facility' })}
        onConfirm={() => {
          if (deleteTyped.trim() === pendingDelete?.name.trim()) void confirmDelete()
        }}
        busy={deleting}
        confirmDisabled={deleteTyped.trim() !== pendingDelete?.name.trim()}
        error={deleteError}
      >
        <div className="space-y-1.5">
          <label htmlFor="confirm-facility-name" className="text-sm">
            {t('warehouses.typeToConfirm', { defaultValue: 'Type {{name}} to confirm', name: pendingDelete?.name ?? '' })}
          </label>
          <Input
            id="confirm-facility-name"
            value={deleteTyped}
            onChange={(e) => setDeleteTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
      </ConfirmDialog>
    </PageContainer>
  )
}

// =============================================================================
// Add-warehouse dialog
// =============================================================================

function AddWarehouseDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Only mount the form while the dialog is open. Gives a fresh, empty form
  // on every open without needing a reset effect, and — crucially — avoids the
  // remount-then-close flash you'd see with `key={String(open)}`: on submit,
  // `onOpenChange(false)` would flip the key from "true" to "false" and remount
  // the form with cleared fields before the dialog close animation played.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-6">
        {open && <AddWarehouseForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function AddWarehouseForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  // Created inside a solution → it joins that solution.
  const { id: solutionId, solution } = useActiveSolution()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [color, setColor] = useState<string>(DEFAULT_COLOR)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Ref guard against double-fire. The button is `disabled={!canSubmit}`
  // and `setSaving(true)` flips canSubmit to false, but React batches the
  // state update — a second click (or Enter + click) arriving inside the
  // same frame still sees the stale `canSubmit=true` closure and fires
  // submit() again, creating a duplicate zone. The ref is synchronous so
  // it blocks the second call immediately.
  const submittingRef = useRef(false)

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0 && !saving

  const submit = async () => {
    if (!canSubmit || submittingRef.current) return
    submittingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const newId = await apiDb.zones.add({
        name: trimmedName,
        color,
        description: '',
        address: address.trim() || undefined,
      })
      if (solutionId != null && typeof newId === 'number') {
        await addSolutionItems(solutionId, { zoneIds: [newId] }).catch(() => undefined)
      }
      invalidateFacilityQueries()
      toast.success(
        solution
          ? t('solutions.createdIn', { name: trimmedName, solution: solution.name, defaultValue: '{{name}} created in {{solution}}' })
          : t('warehouses.created', { defaultValue: '{{name}} created', name: trimmedName }),
      )
      onDone()
    } catch (err) {
      console.error('[dashboard] failed to save warehouse', err)
      setError(t('dashboard.saveFailed'))
    } finally {
      submittingRef.current = false
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2.5">
          <span
            className="w-3 h-3 rounded-full ring-2 ring-background shadow transition-colors"
            style={{ backgroundColor: color }}
            aria-hidden
          />
          <span>{t('dashboard.newWarehouse')}</span>
        </DialogTitle>
        <DialogDescription>{t('dashboard.newWarehouseSubtitle')}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-5">
        <Field label={t('dashboard.warehouseName')} htmlFor="wh-name" required>
          <Input
            id="wh-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('dashboard.warehouseNamePlaceholder')}
            autoFocus
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </Field>

        <Field
          label={t('dashboard.warehouseAddress')}
          htmlFor="wh-address"
          hint={t('dashboard.optional')}
        >
          <Input
            id="wh-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t('dashboard.warehouseAddressPlaceholder')}
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </Field>

        <Field label={t('dashboard.colorPresets')}>
          <div
            role="radiogroup"
            aria-label={t('dashboard.colorPresets')}
            className="flex flex-wrap items-center gap-2.5"
          >
            {COLOR_PRESETS.map((c) => {
              const selected = c.toLowerCase() === color.toLowerCase()
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setColor(c)}
                  disabled={saving}
                  className={`relative w-9 h-9 rounded-full ring-offset-2 ring-offset-background transition-all hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:hover:scale-100 ${
                    selected ? 'ring-2 ring-foreground/80 scale-105' : ''
                  }`}
                  style={{ backgroundColor: c }}
                  aria-label={c}
                >
                  {selected && (
                    <Check
                      className="w-4 h-4 text-white absolute inset-0 m-auto drop-shadow-md"
                      aria-hidden
                    />
                  )}
                </button>
              )
            })}
          </div>
        </Field>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2"
        >
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <DialogFooter className="gap-2 sm:gap-2">
        <Button variant="outline" onClick={onDone} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving ? t('common.saving') : t('dashboard.createWarehouse')}
        </Button>
      </DialogFooter>
    </>
  )
}

// =============================================================================
// Duplicate-warehouse dialog
// =============================================================================

function DuplicateWarehouseDialog({
  source,
  onOpenChange,
}: {
  source: Zone | null
  onOpenChange: (open: boolean) => void
}) {
  // Keying the form by source.id remounts it whenever a different
  // warehouse becomes the duplication source — gives a fresh form
  // pre-filled with the source's name/color without needing a reset
  // effect.
  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-6">
        {source && (
          <DuplicateWarehouseForm
            key={String(source.id)}
            source={source}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DuplicateWarehouseForm({
  source,
  onDone,
}: {
  source: Zone
  onDone: () => void
}) {
  const { t } = useTranslation()
  // Pre-fill the name with a " (copy)" suffix so the user can just hit
  // Enter if they want the default. Color is prefilled from the source
  // so the duplicate is visually distinguishable only if the user
  // chooses to change it.
  const [name, setName] = useState(
    `${source.name} ${t('dashboard.duplicateSuffix', { defaultValue: '(copy)' })}`,
  )
  const [color, setColor] = useState<string>(source.color ?? DEFAULT_COLOR)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Ref guard against double-fire — same rationale as AddWarehouseForm.
  const submittingRef = useRef(false)

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0 && !saving

  const submit = async () => {
    if (!canSubmit || submittingRef.current) return
    if (source.id === undefined) return
    submittingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await apiPost(`/zones/${source.id}/duplicate`, { name: trimmedName, color })
      invalidateFacilityQueries()
      toast.success(t('warehouses.duplicated', { defaultValue: '{{name}} created', name: trimmedName }))
      onDone()
    } catch (err) {
      console.error('[dashboard] failed to duplicate warehouse', err)
      setError(t('dashboard.duplicateFailed', { defaultValue: 'Failed to duplicate warehouse.' }))
    } finally {
      submittingRef.current = false
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2.5">
          <span
            className="w-3 h-3 rounded-full ring-2 ring-background shadow transition-colors"
            style={{ backgroundColor: color }}
            aria-hidden
          />
          <span>{t('dashboard.duplicateWarehouse', { defaultValue: 'Duplicate facility' })}</span>
        </DialogTitle>
        <DialogDescription>
          {t('dashboard.duplicateWarehouseBody', {
            defaultValue: 'Creates a new warehouse with the same grids, shapes, bins, style rules, and data sources as "{{name}}".',
            name: source.name,
          })}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-5">
        <Field label={t('dashboard.warehouseName')} htmlFor="wh-dup-name" required>
          <Input
            id="wh-dup-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('dashboard.warehouseNamePlaceholder')}
            autoFocus
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSubmit) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </Field>

        <Field label={t('dashboard.colorPresets')}>
          <div
            role="radiogroup"
            aria-label={t('dashboard.colorPresets')}
            className="flex flex-wrap items-center gap-2.5"
          >
            {COLOR_PRESETS.map((c) => {
              const selected = c.toLowerCase() === color.toLowerCase()
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setColor(c)}
                  disabled={saving}
                  className={`relative w-9 h-9 rounded-full ring-offset-2 ring-offset-background transition-all hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:hover:scale-100 ${
                    selected ? 'ring-2 ring-foreground/80 scale-105' : ''
                  }`}
                  style={{ backgroundColor: c }}
                  aria-label={c}
                >
                  {selected && (
                    <Check
                      className="w-4 h-4 text-white absolute inset-0 m-auto drop-shadow-md"
                      aria-hidden
                    />
                  )}
                </button>
              )
            })}
          </div>
        </Field>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2"
        >
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <DialogFooter className="gap-2 sm:gap-2">
        <Button variant="outline" onClick={onDone} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving
            ? t('common.saving')
            : t('dashboard.duplicateWarehouse', { defaultValue: 'Duplicate warehouse' })}
        </Button>
      </DialogFooter>
    </>
  )
}

function Field({
  label,
  htmlFor,
  required,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-foreground flex items-baseline gap-1.5"
      >
        <span>{label}</span>
        {required && (
          <span className="text-destructive" aria-hidden>
            *
          </span>
        )}
        {hint && (
          <span className="text-xs font-normal text-muted-foreground">
            ({hint.toLowerCase()})
          </span>
        )}
      </label>
      {children}
    </div>
  )
}

/** Table column header that sorts the rows when clicked. Chevrons indicate the current sort key + direction. */
function SortableHeader({
  label,
  active,
  dir,
  onClick,
  align = 'start',
}: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
  align?: 'start' | 'end'
}) {
  const ariaSort = active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'
  const Icon = active ? (dir === 'asc' ? ChevronUp : ChevronDown) : ChevronDown
  return (
    <TableHead aria-sort={ariaSort} className={align === 'end' ? 'text-end' : undefined}>
      <button
        type="button"
        onClick={onClick}
        className={`group inline-flex items-center gap-1 transition-colors hover:text-foreground ${
          active ? 'text-foreground' : ''
        } ${align === 'end' ? 'flex-row-reverse' : ''}`}
      >
        <span>{label}</span>
        <Icon className={`h-3 w-3 ${active ? '' : 'opacity-0 group-hover:opacity-40'}`} aria-hidden />
      </button>
    </TableHead>
  )
}

/** How many chips fit in the cell before the rest collapse behind "+N". */
const VISIBLE_SHARE_CHIPS = 2

/** Status → chip tone. Mirrors the badge tones in share-link-dialog.tsx's Manage tab. */
const SHARE_STATUS_TONE: Record<WarehouseShareLinkSummary['status'], string> = {
  active: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  revoked: 'border-destructive/30 bg-destructive/10 text-destructive',
  expired: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  capped: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
}

/**
 * The share-links cell: every link issued for a facility, by name, without
 * leaving the table. Clicking an active chip copies its public URL; a dead
 * one (expired / capped / revoked) opens the manage list instead, because
 * handing out a URL that 404s is worse than one extra click. The pencil
 * opens that link's editor so an operator can re-configure or extend it.
 */
function ShareLinksCell({
  links,
  total,
  copiedLinkId,
  onCopy,
  onEdit,
  onManage,
  onCreate,
}: {
  links: ReadonlyArray<WarehouseShareLinkSummary>
  total: number
  copiedLinkId: number | null
  onCopy: (link: WarehouseShareLinkSummary) => void
  onEdit: (link: WarehouseShareLinkSummary) => void
  onManage: () => void
  onCreate: () => void
}) {
  const { t } = useTranslation()

  if (links.length === 0) {
    return (
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-primary transition-colors"
      >
        <Link2 className="w-3 h-3" aria-hidden />
        {t('warehouses.shareCreate', { defaultValue: 'Create link' })}
      </button>
    )
  }

  const visible = links.slice(0, VISIBLE_SHARE_CHIPS)
  const hidden = total - visible.length

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visible.map((link) => {
        const copied = copiedLinkId === link.id
        const label = link.label || t('shareLink.manage.untitled', { defaultValue: 'Untitled link' })
        return (
          <span
            key={link.id}
            className={`inline-flex items-center rounded-md border text-xs max-w-[10rem] ${SHARE_STATUS_TONE[link.status]}`}
          >
            <button
              type="button"
              onClick={() => (link.status === 'active' ? onCopy(link) : onManage())}
              title={
                link.status === 'active'
                  ? t('warehouses.shareCopyTitle', { defaultValue: 'Copy link URL — {{label}}', label })
                  : t('warehouses.shareInactiveTitle', {
                      defaultValue: '{{label}} — {{status}}. Open to review.',
                      label,
                      status: t(`warehouses.shareStatus.${link.status}`, {
                        defaultValue: link.status,
                      }),
                    })
              }
              className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 min-w-0 hover:opacity-80 transition-opacity"
            >
              {copied ? (
                <Check className="w-3 h-3 flex-shrink-0" aria-hidden />
              ) : (
                <Link2 className="w-3 h-3 flex-shrink-0" aria-hidden />
              )}
              <span className="truncate">{label}</span>
            </button>
            <button
              type="button"
              onClick={() => onEdit(link)}
              title={t('warehouses.shareEditTitle', { defaultValue: 'Configure {{label}}', label })}
              aria-label={t('warehouses.shareEditTitle', { defaultValue: 'Configure {{label}}', label })}
              className="pr-1.5 pl-0.5 py-0.5 opacity-60 hover:opacity-100 transition-opacity"
            >
              <Pencil className="w-3 h-3" aria-hidden />
            </button>
          </span>
        )
      })}
      {hidden > 0 && (
        <button
          type="button"
          onClick={onManage}
          title={t('warehouses.shareManage', { defaultValue: 'Manage share links' })}
          className="inline-flex items-center rounded-md border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
        >
          {/* `n`, not `count` — `count` would send i18next looking for
              plural-suffixed keys this string doesn't have. */}
          {t('warehouses.shareMore', { defaultValue: '+{{n}}', n: hidden })}
        </button>
      )}
    </div>
  )
}
