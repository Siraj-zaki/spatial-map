/**
 * /files — every image and 3D model this workspace has stored, and the
 * one question the screen answers: what's in use, and what can go.
 *
 * Strictly workspace-scoped: the API lists files this workspace uploaded
 * (tenant_files) or uses — never another workspace's, and never the
 * owner-less uploads from before ownership was recorded.
 *
 * Server-side paging: filters, search, sort and counts run in the API;
 * the page holds the first 24 rows and "Load more" (also fired when the
 * end of the list scrolls into view) appends the next 24 by offset — see
 * useFilesPages. Changing a filter keeps the current cards (dimmed) until
 * the new first page lands; search waits until typing pauses.
 *
 * Header KPIs and the "X can be freed → Review" / missing-files notices
 * come from the response's whole-workspace `stats`; tab and menu counts
 * from `statusCounts` / `typeCounts` (each under the other filters).
 *
 * URL: ?status=all|inUse|cleanup|missing  ?type=floorplan|plane|model|
 * image|other  ?facility=<zoneId>  ?q=  ?sort=newest|oldest|largest|name
 * ?view=grid|list  ?file=<key> (detail panel, file-detail-sheet.tsx).
 *
 * Only Leftover / Unused files can be deleted (the API refuses the rest),
 * so only they carry a selection checkbox. "Delete" on an in-use file
 * opens its detail panel instead, which says where it's used.
 *
 * Owners/admins only — the API answers 403 to everyone else, so the page
 * shows a read-only explanation instead of fetching.
 */

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownWideNarrow,
  Building2,
  Check,
  ChevronDown,
  FolderOpen,
  HardDrive,
  LayoutGrid,
  List,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Shapes,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PageContainer, PageHero, rise } from '@/components/page-shell'
import { StatCard } from '@/components/stat-card'
import { EmptyState } from '@/components/empty-state'
import { FilterTabs, type FilterTabItem } from '@/components/filter-tabs'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { QueryError } from '@/components/feedback/query-error'
import { FileGridCard, FileListHeader, FileListRow } from '@/components/files/file-card'
import { FileDetailSheet } from '@/components/files/file-detail-sheet'
import { FILE_TYPES, canDelete, displayFileName, fileTypeLabel, formatBytes, type FileType } from '@/components/files/file-helpers'
import { FILES_PAGE_SIZE, useFilesPages } from '@/hooks/useFilesPages'
import { useUrlState } from '@/hooks/useUrlState'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { ApiError } from '@/lib/api-client'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { deleteFile, listFiles, type FileCard, type FileSort, type FileStatusFilter } from '@/lib/files-client'
import { subscribeExternalSSE } from '@/lib/useSSE'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'

type View = 'grid' | 'list'

const STATUSES: FileStatusFilter[] = ['all', 'inUse', 'cleanup', 'missing']
const SORTS: FileSort[] = ['newest', 'oldest', 'largest', 'name']
const SEARCH_DEBOUNCE_MS = 300

const sum = (files: FileCard[]) => files.reduce((n, f) => n + (f.size || 0), 0)

function GridSkeleton({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="overflow-hidden rounded-xl border bg-card" aria-hidden>
          <Skeleton className="aspect-[4/3] rounded-none" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </li>
      ))}
    </>
  )
}

export default function FilesPage() {
  const { t, i18n } = useTranslation()
  const canManage = useWorkspaceRole().can('files.manage')
  const tenantId = useCurrentTenantId()

  // ---- URL state --------------------------------------------------------
  const [statusParam, setStatus] = useUrlState<FileStatusFilter>('status', 'all')
  const [typeParam, setType] = useUrlState<FileType | 'all'>('type', 'all')
  const [facilityParam, setFacility] = useUrlState<string>('facility', '')
  const [q, setQ] = useUrlState<string>('q', '')
  const [sortParam, setSort] = useUrlState<FileSort>('sort', 'newest')
  const [viewParam, setView] = useUrlState<View>('view', 'grid')
  const [fileParam, setFileParam] = useUrlState<string>('file', '')
  const status: FileStatusFilter = STATUSES.includes(statusParam) ? statusParam : 'all'
  const type: FileType | 'all' = typeParam === 'all' || FILE_TYPES.includes(typeParam) ? typeParam : 'all'
  const sort: FileSort = SORTS.includes(sortParam) ? sortParam : 'newest'
  const view: View = viewParam === 'list' ? 'list' : 'grid'
  const facilityId = /^\d+$/.test(facilityParam) ? Number(facilityParam) : undefined

  // Search: the box updates instantly, the URL (and the request) once
  // typing pauses. An outside change to ?q= (Clear filters, back button)
  // flows back into the box.
  const [searchDraft, setSearchDraft] = useState(q)
  const [syncedQ, setSyncedQ] = useState(q)
  if (q !== syncedQ) {
    setSyncedQ(q)
    setSearchDraft(q)
  }
  useEffect(() => {
    if (searchDraft === q) return
    const id = window.setTimeout(() => setQ(searchDraft.trim() ? searchDraft : ''), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [searchDraft, q, setQ])

  // ---- data -------------------------------------------------------------
  const pages = useFilesPages(
    { status, type: type === 'all' ? undefined : type, facility: facilityId, q: q.trim() || undefined, sort },
    tenantId,
    canManage,
  )
  const { rows, meta, reload, removeRows } = pages
  const stats = meta?.stats
  const total = meta?.total ?? 0
  const facilities = meta?.facilities ?? []
  const activeFacility = facilities.find((f) => f.id === facilityId) ?? null
  const filtersActive = type !== 'all' || facilityId !== undefined || !!q.trim()

  // Another tab deleted a file (the backend broadcasts { entity: 'files' }).
  useEffect(() => {
    if (!canManage) return
    return subscribeExternalSSE((kind) => {
      if (kind === 'files') reload()
    })
  }, [canManage, reload])

  // Load the next page when the end of the list scrolls into view. Not
  // after a failed attempt — that waits for the Retry button.
  const sentinel = useRef<HTMLDivElement>(null)
  const { hasMore, loadingMore, loadMoreFailed, loadMore } = pages
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore || loadingMore || loadMoreFailed) return
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void loadMore(), { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loadingMore, loadMoreFailed, loadMore, rows.length])

  const clearFilters = () => {
    setType('all')
    setFacility('')
    setQ('')
  }

  // ---- selection ---------------------------------------------------------
  // Only deletable, loaded rows are selectable; a filter change drops
  // anything no longer visible.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const selectable = rows.filter(canDelete)
  const selection = selectable.filter((f) => selected.has(f.key))
  const allSelected = selectable.length > 0 && selection.length === selectable.length
  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map((f) => f.key)))

  // ---- detail panel ------------------------------------------------------
  // A deep link (?file=) can name a file outside the loaded pages; look it
  // up on its own so the panel still opens.
  const loadedFile = rows.find((f) => f.key === fileParam) ?? null
  const [deepFile, setDeepFile] = useState<FileCard | null>(null)
  useEffect(() => {
    if (!canManage || !fileParam || loadedFile || deepFile?.key === fileParam) return
    let cancelled = false
    listFiles({ q: fileParam, pageSize: 20 })
      .then((page) => {
        const hit = page.rows.find((f) => f.key === fileParam)
        if (!cancelled && hit) setDeepFile(hit)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [canManage, fileParam, loadedFile, deepFile])
  const openFile = loadedFile ?? (deepFile?.key === fileParam ? deepFile : null)

  // ---- delete ------------------------------------------------------------
  const [pendingDelete, setPendingDelete] = useState<FileCard | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const requestDelete = (f: FileCard) => {
    // In-use and missing files can't be deleted here — the detail panel
    // explains why and links to where to fix it.
    if (canDelete(f)) setPendingDelete(f)
    else setFileParam(f.key)
  }

  const deleteError = (err: unknown) =>
    err instanceof ApiError && err.status === 409
      ? t('files.deleteRefused', { defaultValue: 'It’s still in use on a facility. Remove it there first.' })
      : err instanceof ApiError && err.status === 404
        ? t('files.deleteGone', { defaultValue: 'It no longer exists — the list has been refreshed.' })
        : (err as Error).message

  const doDelete = async () => {
    const target = pendingDelete
    if (!target) return
    setBusy(true)
    try {
      await deleteFile(target.key)
      removeRows([target.key])
      toast.success(t('files.deleted', { defaultValue: '{{name}} deleted', name: displayFileName(target.key) }))
      if (fileParam === target.key) setFileParam('')
      setPendingDelete(null)
    } catch (err) {
      toast.error(t('files.deleteFailed', { defaultValue: 'Couldn’t delete {{name}}', name: displayFileName(target.key) }), {
        description: deleteError(err),
      })
    } finally {
      setBusy(false)
      reload()
    }
  }

  const doBulkDelete = async () => {
    const targets = selection
    setBusy(true)
    const results = await Promise.allSettled(targets.map((f) => deleteFile(f.key)))
    const deletedKeys = targets.filter((_, i) => results[i].status === 'fulfilled').map((f) => f.key)
    const failed = targets.length - deletedKeys.length
    removeRows(deletedKeys)
    if (failed === 0) {
      toast.success(t('files.bulkDeleted', { defaultValue: '{{count}} files deleted', count: deletedKeys.length }), {
        description: t('files.bulkFreed', { defaultValue: '{{size}} freed', size: formatBytes(sum(targets), i18n.language) }),
      })
    } else {
      const firstErr = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason
      toast.error(t('files.bulkPartial', { defaultValue: '{{done}} deleted, {{failed}} couldn’t be', done: deletedKeys.length, failed }), {
        description: deleteError(firstErr),
      })
    }
    setSelected(new Set())
    setBulkOpen(false)
    setBusy(false)
    reload()
  }

  // ---- read-only --------------------------------------------------------
  if (!canManage) {
    return (
      <PageContainer className="gap-6">
        <div {...rise(0)}>
          <PageHero
            title={t('files.title', { defaultValue: 'Files' })}
            description={t('files.heroBody', {
              defaultValue: 'Floor plans, image planes and 3D models stored in this workspace — see what’s in use and free up what isn’t.',
            })}
          />
        </div>
        <EmptyState
          icon={Lock}
          title={t('files.noPermissionTitle', { defaultValue: 'Files are managed by admins' })}
          description={t('files.noPermissionBody', {
            defaultValue: 'Ask a workspace owner or admin if a file needs to be removed. You can still see every floor plan and model on its facility.',
          })}
          action={
            <Button asChild variant="outline">
              <Link to="/warehouses">{t('files.goToFacilities', { defaultValue: 'Go to facilities' })}</Link>
            </Button>
          }
        />
      </PageContainer>
    )
  }

  // ---- toolbar pieces ---------------------------------------------------
  const counts = meta?.statusCounts ?? {}
  const countFor = (s: FileStatusFilter) => (pages.initialLoading ? undefined : (counts[s] ?? 0))
  const statusItems: FilterTabItem<FileStatusFilter>[] = [
    { value: 'all', label: t('files.filter.all', { defaultValue: 'All' }), count: countFor('all') },
    { value: 'inUse', label: t('files.filter.inUse', { defaultValue: 'In use' }), count: countFor('inUse') },
    { value: 'cleanup', label: t('files.filter.cleanup', { defaultValue: 'Can be freed' }), count: countFor('cleanup') },
    ...((stats?.missing ?? 0) > 0 || status === 'missing'
      ? [{ value: 'missing' as const, label: t('files.filter.missing', { defaultValue: 'Missing' }), count: countFor('missing') }]
      : []),
  ]
  const typeCounts = meta?.typeCounts ?? {}

  const sortLabel = (s: FileSort) =>
    ({
      newest: t('files.sort.newest', { defaultValue: 'Newest first' }),
      oldest: t('files.sort.oldest', { defaultValue: 'Oldest first' }),
      largest: t('files.sort.largest', { defaultValue: 'Largest first' }),
      name: t('files.sort.name', { defaultValue: 'Name' }),
    })[s]

  const layoutToggle = (className: string) => (
    <div
      role="radiogroup"
      aria-label={t('files.layout', { defaultValue: 'Layout' })}
      className={cn('h-9 shrink-0 items-center rounded-lg bg-muted p-1', className)}
    >
      {(
        [
          ['grid', LayoutGrid, t('files.layoutGrid', { defaultValue: 'Grid' })],
          ['list', List, t('files.layoutList', { defaultValue: 'List' })],
        ] as const
      ).map(([v, Icon, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={view === v}
          aria-label={label}
          title={label}
          onClick={() => setView(v)}
          className={cn(
            'inline-flex h-7 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            view === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  )

  const statsLoading = pages.initialLoading
  const workspaceEmpty = !!stats && stats.files === 0

  // ---- render ----------------------------------------------------------
  return (
    <PageContainer className="gap-6">
      <div {...rise(0)}>
        <PageHero
          title={t('files.title', { defaultValue: 'Files' })}
          description={t('files.heroBody', {
            defaultValue: 'Floor plans, image planes and 3D models stored in this workspace — see what’s in use and free up what isn’t.',
          })}
          actions={
            <Button variant="outline" onClick={reload} disabled={pages.reloading || pages.initialLoading}>
              {pages.reloading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-4 w-4" />}
              {t('files.refresh', { defaultValue: 'Refresh' })}
            </Button>
          }
        />
      </div>

      {!(pages.error && !stats) && !workspaceEmpty && (
        <section {...rise(1, 'grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4')} aria-label={t('files.kpiLabel', { defaultValue: 'Storage totals' })}>
          <StatCard
            icon={FolderOpen}
            label={t('files.kpiFiles', { defaultValue: 'Files' })}
            value={stats?.files ?? 0}
            hint={t('files.kpiFilesHint', {
              defaultValue: '{{images}} images · {{models}} 3D models',
              images: (stats?.files ?? 0) - (stats?.models ?? 0),
              models: stats?.models ?? 0,
            })}
            loading={statsLoading}
          />
          <StatCard
            icon={HardDrive}
            label={t('files.kpiStorage', { defaultValue: 'Storage used' })}
            value={formatBytes(stats?.bytes ?? 0, i18n.language)}
            progress={stats?.bytes ? stats.inUseBytes / stats.bytes : undefined}
            hint={stats?.bytes ? t('files.kpiStorageHint', { defaultValue: '{{size}} in use', size: formatBytes(stats.inUseBytes, i18n.language) }) : undefined}
            loading={statsLoading}
          />
          <StatCard
            icon={Building2}
            label={t('files.kpiInUse', { defaultValue: 'In use' })}
            value={stats?.inUse ?? 0}
            hint={t('files.kpiInUseHint', { defaultValue: 'On {{count}} facilities', count: stats?.facilities ?? 0 })}
            to="/warehouses"
            loading={statsLoading}
          />
          <StatCard
            icon={Sparkles}
            label={t('files.kpiFreeable', { defaultValue: 'Can be freed' })}
            value={stats?.cleanupBytes ? formatBytes(stats.cleanupBytes, i18n.language) : '—'}
            hint={
              stats?.cleanup
                ? t('files.kpiFreeableHint', { defaultValue: '{{count}} files to review', count: stats.cleanup })
                : t('files.kpiNothingToFree', { defaultValue: 'Nothing to clean up' })
            }
            loading={statsLoading}
          />
        </section>
      )}

      {!!stats?.missing && status !== 'missing' && (
        <div {...rise(2, 'flex flex-col gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 sm:flex-row sm:items-center')}>
          <TriangleAlert className="hidden h-5 w-5 shrink-0 text-danger sm:block" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t('files.missingTitle', { defaultValue: '{{count}} files are missing from storage', count: stats.missing })}</p>
            <p className="text-sm text-muted-foreground">
              {t('files.missingNotice', { defaultValue: 'A facility still points to them, so they show up blank. Upload them again from the facility.' })}
            </p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setStatus('missing')}>
            {t('files.showThese', { defaultValue: 'Show these' })}
          </Button>
        </div>
      )}

      {!!stats?.cleanup && status !== 'cleanup' && (
        <div {...rise(2, 'flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 sm:flex-row sm:items-center')}>
          <Sparkles className="hidden h-5 w-5 shrink-0 text-warning sm:block" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t('files.freeTitle', { defaultValue: '{{size}} can be freed', size: formatBytes(stats.cleanupBytes, i18n.language) })}</p>
            <p className="text-sm text-muted-foreground">
              {stats.leftovers === 0
                ? t('files.freeBodyUnused', { defaultValue: '{{count}} files aren’t used anywhere.', count: stats.cleanup })
                : stats.leftovers === stats.cleanup
                  ? t('files.freeBodyLeftovers', { defaultValue: '{{count}} files are left over from deleted shapes. Nothing on a facility uses them.', count: stats.cleanup })
                  : t('files.freeBody', {
                      defaultValue: '{{unused}} unused files and {{leftovers}} left over from deleted shapes. Nothing on a facility uses them.',
                      unused: stats.cleanup - stats.leftovers,
                      leftovers: stats.leftovers,
                    })}
            </p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setStatus('cleanup')}>
            {t('files.review', { defaultValue: 'Review' })}
          </Button>
        </div>
      )}

      <section {...rise(3, cn('space-y-4', selection.length > 0 && 'pb-20'))} aria-label={t('files.title', { defaultValue: 'Files' })}>
        {/* Toolbar: status + layout, then search and narrowing filters. Hidden
            when the list failed to load or the workspace has no files. */}
        <div className={cn('space-y-3', ((pages.error && !meta) || workspaceEmpty) && 'hidden')}>
          <div className="flex items-center justify-between gap-3">
            <FilterTabs ariaLabel={t('files.filter.label', { defaultValue: 'Filter by status' })} items={statusItems} value={status} onChange={setStatus} />
            {layoutToggle('hidden sm:inline-flex')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-full sm:basis-0">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                role="searchbox"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && searchDraft && setSearchDraft('')}
                placeholder={t('files.search', { defaultValue: 'Search files, shapes or facilities' })}
                aria-label={t('files.search', { defaultValue: 'Search files, shapes or facilities' })}
                className="ps-9 pe-9"
              />
              {pages.refreshing || searchDraft !== q ? (
                <Loader2 className="absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
              ) : (
                searchDraft && (
                  <button
                    type="button"
                    onClick={() => setSearchDraft('')}
                    aria-label={t('files.clearSearch', { defaultValue: 'Clear search' })}
                    className="absolute end-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )
              )}
            </div>

            {facilities.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className={cn('max-w-[12rem]', activeFacility && 'border-primary/40 bg-primary/5')}>
                    <Building2 className="h-4 w-4 shrink-0" />
                    <span className="truncate">{activeFacility?.name ?? t('files.allFacilities', { defaultValue: 'All facilities' })}</span>
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">
                  <DropdownMenuRadioGroup value={activeFacility ? String(activeFacility.id) : ''} onValueChange={setFacility}>
                    <DropdownMenuRadioItem value="">{t('files.allFacilities', { defaultValue: 'All facilities' })}</DropdownMenuRadioItem>
                    <DropdownMenuSeparator />
                    {facilities.map((f) => (
                      <DropdownMenuRadioItem key={f.id} value={String(f.id)}>
                        <span className="flex-1 truncate">{f.name}</span>
                        <span className="ms-3 text-xs tabular-nums text-muted-foreground">{f.count}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className={cn(type !== 'all' && 'border-primary/40 bg-primary/5')}>
                  <Shapes className="h-4 w-4" />
                  {type === 'all' ? t('files.allTypes', { defaultValue: 'All types' }) : fileTypeLabel(type, t)}
                  <ChevronDown className="h-4 w-4 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuRadioGroup value={type} onValueChange={(v) => setType(v as FileType | 'all')}>
                  <DropdownMenuRadioItem value="all">{t('files.allTypes', { defaultValue: 'All types' })}</DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  {FILE_TYPES.filter((k) => (typeCounts[k] ?? 0) > 0 || k === type).map((k) => (
                    <DropdownMenuRadioItem key={k} value={k}>
                      <span className="flex-1">{fileTypeLabel(k, t)}</span>
                      <span className="ms-3 text-xs tabular-nums text-muted-foreground">{typeCounts[k] ?? 0}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label={t('files.sortBy', { defaultValue: 'Sort: {{order}}', order: sortLabel(sort) })}>
                  <ArrowDownWideNarrow className="h-4 w-4" />
                  <span className="hidden sm:inline">{sortLabel(sort)}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>{t('files.sortLabel', { defaultValue: 'Sort by' })}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as FileSort)}>
                  {SORTS.map((s) => (
                    <DropdownMenuRadioItem key={s} value={s}>
                      {sortLabel(s)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {layoutToggle('ms-auto inline-flex sm:hidden')}
          </div>
        </div>

        {/* Results line: how much is showing, what's narrowing it, and the cleanup shortcut */}
        {meta && !workspaceEmpty && !pages.error && total > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground" aria-live="polite">
            <span>{t('files.showing', { defaultValue: 'Showing {{shown}} of {{total}}', shown: rows.length, total })}</span>
            {filtersActive && (
              <Button variant="link" size="sm" className="h-auto p-0" onClick={clearFilters}>
                {t('files.clearFilters', { defaultValue: 'Clear filters' })}
              </Button>
            )}
            {status === 'cleanup' && selectable.length > 0 && !allSelected && (
              <Button variant="outline" size="sm" className="ms-auto h-8" onClick={toggleAll}>
                <Check className="h-4 w-4" />
                {pages.hasMore
                  ? t('files.selectShown', { defaultValue: 'Select the {{count}} shown', count: selectable.length })
                  : t('files.selectAllCount', { defaultValue: 'Select all {{count}}', count: selectable.length })}
              </Button>
            )}
          </div>
        )}

        {/* Body */}
        {pages.error ? (
          <QueryError error={pages.error} onRetry={reload} what={t('files.whatFiles', { defaultValue: 'your files' })} />
        ) : pages.initialLoading ? (
          <ul aria-busy aria-label={t('files.loading', { defaultValue: 'Loading files' })} className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
            <GridSkeleton count={8} />
          </ul>
        ) : workspaceEmpty ? (
          <EmptyState
            icon={FolderOpen}
            title={t('files.emptyTitle', { defaultValue: 'No files yet' })}
            description={t('files.emptyBody', {
              defaultValue: 'Floor plans, image planes and 3D models you add to a facility are stored here, so you can see what’s used and clean up what isn’t.',
            })}
            action={
              <Button asChild>
                <Link to="/warehouses">{t('files.goToFacilities', { defaultValue: 'Go to facilities' })}</Link>
              </Button>
            }
          />
        ) : rows.length === 0 && !pages.refreshing ? (
          status === 'cleanup' && !filtersActive ? (
            <EmptyState
              icon={Sparkles}
              title={t('files.cleanEmptyTitle', { defaultValue: 'Nothing to clean up' })}
              description={t('files.cleanEmptyBody', { defaultValue: 'Every stored file is used on a facility.' })}
              action={
                <Button variant="outline" onClick={() => setStatus('all')}>
                  {t('files.showAll', { defaultValue: 'Show all files' })}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Search}
              title={t('files.noMatchTitle', { defaultValue: 'No files match' })}
              description={t('files.noMatchBody', { defaultValue: 'Try a different search, type or facility.' })}
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    clearFilters()
                    setStatus('all')
                  }}
                >
                  {t('files.clearFilters', { defaultValue: 'Clear filters' })}
                </Button>
              }
            />
          )
        ) : (
          // Previous results stay (dimmed, inert) while new filters load.
          <div aria-busy={pages.refreshing} className={cn('transition-opacity duration-200', pages.refreshing && 'pointer-events-none opacity-50')}>
            {view === 'list' ? (
              <div className="overflow-hidden rounded-xl border bg-card">
                <FileListHeader allSelected={allSelected} someSelected={selection.length > 0} onToggleAll={toggleAll} selectable={selectable.length > 0} />
                <ul className="divide-y">
                  {rows.map((f) => (
                    <FileListRow
                      key={f.key}
                      file={f}
                      selected={selected.has(f.key)}
                      onToggleSelect={() => toggle(f.key)}
                      onOpen={() => setFileParam(f.key)}
                      onDelete={() => requestDelete(f)}
                    />
                  ))}
                  {pages.loadingMore &&
                    Array.from({ length: 3 }, (_, i) => (
                      <li key={`sk-${i}`} className="flex items-center gap-3 px-4 py-2" aria-hidden>
                        <Skeleton className="h-10 w-12 shrink-0" />
                        <div className="flex-1 space-y-1.5">
                          <Skeleton className="h-4 w-1/3" />
                          <Skeleton className="h-3 w-1/4" />
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
                {rows.map((f, i) => (
                  // Only the first page staggers in; appended pages appear at once.
                  <li key={f.key} {...(i < FILES_PAGE_SIZE ? rise(Math.min(i, 12)) : {})}>
                    <FileGridCard
                      file={f}
                      selectMode={status === 'cleanup' || selection.length > 0}
                      selected={selected.has(f.key)}
                      onToggleSelect={() => toggle(f.key)}
                      onOpen={() => setFileParam(f.key)}
                      onDelete={() => requestDelete(f)}
                    />
                  </li>
                ))}
                {pages.loadingMore && <GridSkeleton count={4} />}
              </ul>
            )}

            {/* Paging footer: auto-loads via the sentinel; the button is the
                keyboard / no-IntersectionObserver path and the retry. */}
            <div ref={sentinel} className="flex flex-col items-center gap-2 pt-6 text-sm text-muted-foreground">
              {pages.loadMoreFailed ? (
                <>
                  <p className="text-danger">{t('files.loadMoreFailed', { defaultValue: 'Couldn’t load more files.' })}</p>
                  <Button variant="outline" size="sm" onClick={() => void loadMore()}>
                    <RefreshCw className="h-4 w-4" />
                    {t('common.retry', { defaultValue: 'Retry' })}
                  </Button>
                </>
              ) : pages.hasMore ? (
                <Button variant="outline" onClick={() => void loadMore()} disabled={pages.loadingMore} className="min-w-40">
                  {pages.loadingMore && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
                  {pages.loadingMore
                    ? t('files.loadingMore', { defaultValue: 'Loading…' })
                    : t('files.loadMore', { defaultValue: 'Load {{count}} more', count: Math.min(FILES_PAGE_SIZE, total - rows.length) })}
                </Button>
              ) : (
                total > FILES_PAGE_SIZE && <p>{t('files.endOfList', { defaultValue: 'That’s all {{count}} files.', count: total })}</p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Floating selection bar — the delete decision stays in reach while scrolling */}
      {selection.length > 0 && (
        <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center">
          <div
            role="region"
            aria-label={t('files.selectionLabel', { defaultValue: 'Selected files' })}
            className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-xl border bg-popover px-3 py-2 shadow-lg animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
          >
            <span className="px-1 text-sm font-medium">
              {t('files.selectedCount', {
                defaultValue: '{{count}} selected · {{size}}',
                count: selection.length,
                size: formatBytes(sum(selection), i18n.language),
              })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              <X className="h-4 w-4" />
              {t('files.clearSelection', { defaultValue: 'Clear' })}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setBulkOpen(true)}>
              <Trash2 className="h-4 w-4" />
              {t('files.deleteN', { defaultValue: 'Delete {{count}}', count: selection.length })}
            </Button>
          </div>
        </div>
      )}

      <FileDetailSheet file={openFile} open={!!openFile} onOpenChange={(o) => !o && setFileParam('')} onDelete={requestDelete} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && !busy && setPendingDelete(null)}
        title={t('files.confirmTitle', { defaultValue: 'Delete {{name}}?', name: pendingDelete ? displayFileName(pendingDelete.key) : '' })}
        description={
          pendingDelete?.category === 'ghost'
            ? t('files.confirmLeftover', {
                defaultValue: 'This also removes {{count}} leftover shapes that point to it. They’re not on any facility. This can’t be undone.',
                count: pendingDelete.referencedBy.length,
              })
            : t('files.confirmUnused', {
                defaultValue: 'Nothing uses this file. It’s removed from storage for good, freeing {{size}}.',
                size: formatBytes(pendingDelete?.size ?? 0, i18n.language),
              })
        }
        confirmLabel={t('files.deleteFile', { defaultValue: 'Delete file' })}
        onConfirm={() => void doDelete()}
        busy={busy}
      />

      <ConfirmDialog
        open={bulkOpen}
        onOpenChange={(o) => !o && !busy && setBulkOpen(false)}
        title={t('files.bulkTitle', { defaultValue: 'Delete {{count}} files?', count: selection.length })}
        description={t('files.bulkBody', {
          defaultValue: 'Frees {{size}}. None of them are used on a facility; leftover shapes that point to them are removed too. This can’t be undone.',
          size: formatBytes(sum(selection), i18n.language),
        })}
        confirmLabel={t('files.deleteN', { defaultValue: 'Delete {{count}}', count: selection.length })}
        onConfirm={() => void doBulkDelete()}
        busy={busy}
      />
    </PageContainer>
  )
}
