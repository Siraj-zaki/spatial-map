/**
 * Per-table records grid + per-row history.
 *
 * `TableRecordsDialog` renders the grid in a Dialog (the "Records" button
 * on an Integrations `TableCard`) or, with `inline`, straight into the
 * Records tab of `/tables/:id`. It hits the SPA's authed row surface
 * (`/api/v1/tables/:id/rows/...`) — NOT the public bearer surface —
 * because the SPA never holds a plaintext table token after mint. See
 * `table-rows-authed-client.ts` and the backend's `table_rows_authed.go`.
 *
 * The grid:
 *   - One column per field definition (sortOrder), labelled by the
 *     field's human label; the row key column and the actions column are
 *     sticky so wide tables scroll between them.
 *   - Server pagination + sort (entity_key / ts / updated_at — the
 *     backend allow-list) by clicking the column headers. Inline mode
 *     keeps page + sort in the URL (?page=&sort=&dir=).
 *   - Inline edit per cell (click / Enter / F2; Enter saves, Esc cancels;
 *     an unchanged value makes no request). A saved cell flashes.
 *   - Delete is immediate with an Undo toast (the row is re-upserted with
 *     its old payload) — no confirm dialog for a one-click-reversible act.
 *   - Viewers see everything read-only; edit controls are disabled with
 *     a tooltip, not hidden.
 *
 * `TableRowHistoryDialog` is a non-modal side panel (the grid stays
 * usable) showing the row's append-only event trail newest-first, with a
 * field-level diff against the previous snapshot at each step.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  Rows3,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { EmptyState } from '@/components/empty-state'
import { QueryError } from '@/components/feedback/query-error'
import { RoleGate } from '@/components/feedback/role-gate'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { toast } from '@/lib/toast-store'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import {
  coerceFieldValue,
  fieldTypeMeta,
  fieldValueToInput,
  formatFieldValue,
  isMonospaceType,
} from '@/lib/table-field-types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  type FieldDefinitionResponse,
  type TableEventWire,
  type TableResponse,
  listTableRowEvents,
} from '@/lib/tables-client'
import {
  type AuthedRowResponse,
  type AuthedRowSortBy,
  type SortDir,
  deleteAuthedRow,
  listAuthedRows,
  patchAuthedRow,
  upsertAuthedRow,
} from '@/lib/table-rows-authed-client'
import { coordFields, identityField } from '@/lib/table-starter-fields'

const PAGE_SIZES = [25, 50, 100] as const
const SORT_BY_OPTIONS: AuthedRowSortBy[] = ['entity_key', 'ts', 'updated_at']
const SEARCH_DEBOUNCE_MS = 300
const SKELETON_ROWS = 8

/** Sticky cells need an opaque background that still tracks row hover. */
const STICKY_BG =
  'bg-card group-hover:bg-[color-mix(in_srgb,hsl(var(--muted))_60%,hsl(var(--card)))]'
const TH = 'h-10 whitespace-nowrap px-3 text-start align-middle text-xs font-medium text-muted-foreground'

function isNumericType(dataType: string): boolean {
  return dataType === 'number' || dataType === 'integer'
}

// ============================================================ grid state

interface GridState {
  page: number
  pageSize: number
  sortBy: AuthedRowSortBy
  sortDir: SortDir
  /** Server-side search over the row key and every value. */
  q: string
}

const DEFAULT_GRID: GridState = { page: 1, pageSize: 25, sortBy: 'ts', sortDir: 'desc', q: '' }

function parseGrid(p: URLSearchParams): GridState {
  const sort = p.get('sort') as AuthedRowSortBy | null
  const size = Number.parseInt(p.get('size') ?? '', 10)
  return {
    page: Math.max(1, Number.parseInt(p.get('page') ?? '', 10) || 1),
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_GRID.pageSize,
    // `field:<key>` sorts by a declared column (validated server-side).
    sortBy: sort && (SORT_BY_OPTIONS.includes(sort) || sort.startsWith('field:')) ? sort : DEFAULT_GRID.sortBy,
    sortDir: p.get('dir') === 'asc' ? 'asc' : 'desc',
    q: p.get('q') ?? '',
  }
}

/**
 * Page + sort, in the URL when the grid owns the page (refresh- and
 * share-safe), in memory inside a dialog (so opening it doesn't rewrite
 * the host page's URL). One setter so page and sort change atomically.
 */
function useGridState(inUrl: boolean): [GridState, (patch: Partial<GridState>) => void] {
  const [params, setParams] = useSearchParams()
  const [local, setLocal] = useState<GridState>(DEFAULT_GRID)
  const update = useCallback(
    (patch: Partial<GridState>) => {
      if (!inUrl) {
        setLocal((s) => ({ ...s, ...patch }))
        return
      }
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          const merged = { ...parseGrid(prev), ...patch }
          if (merged.page === 1) next.delete('page')
          else next.set('page', String(merged.page))
          if (merged.sortBy === DEFAULT_GRID.sortBy) next.delete('sort')
          else next.set('sort', merged.sortBy)
          if (merged.sortDir === DEFAULT_GRID.sortDir) next.delete('dir')
          else next.set('dir', merged.sortDir)
          if (merged.pageSize === DEFAULT_GRID.pageSize) next.delete('size')
          else next.set('size', String(merged.pageSize))
          if (!merged.q) next.delete('q')
          else next.set('q', merged.q)
          return next
        },
        { replace: true },
      )
    },
    [inUrl, setParams],
  )
  return [inUrl ? parseGrid(params) : local, update]
}

interface LoadResult {
  key: string
  rows: AuthedRowResponse[]
  total: number
  error: unknown
}

// ============================================================ records grid

export function TableRecordsDialog({
  table,
  open,
  onOpenChange,
  inline = false,
  onShowApi,
  onTotalChange,
}: {
  table: TableResponse
  open: boolean
  onOpenChange: (open: boolean) => void
  inline?: boolean
  /** Empty-state shortcut to the table's API docs (inline page only). */
  onShowApi?: () => void
  /** Reports the server's row count; must be a stable callback (e.g. a setState). */
  onTotalChange?: (total: number) => void
}) {
  const { t, i18n } = useTranslation()
  const tableId = table.dataSource.id
  const { canEdit } = useWorkspaceRole()

  const [{ page, pageSize, sortBy, sortDir, q }, setGrid] = useGridState(inline)
  // The box updates instantly; the query (and URL) once typing pauses. An
  // outside change to ?q= (back button, Clear) flows back into the box.
  const [searchDraft, setSearchDraft] = useState(q)
  const [syncedQ, setSyncedQ] = useState(q)
  if (q !== syncedQ) {
    setSyncedQ(q)
    setSearchDraft(q)
  }
  useEffect(() => {
    if (searchDraft.trim() === q) return
    const id = window.setTimeout(() => setGrid({ q: searchDraft.trim(), page: 1 }), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [searchDraft, q, setGrid])
  const [reloadToken, setReloadToken] = useState(0)
  const [result, setResult] = useState<LoadResult | null>(null)

  const [editing, setEditing] = useState<{ key: string; field: string; value: string } | null>(null)
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [historyKey, setHistoryKey] = useState<string | null>(null)

  const fields = useMemo(
    () => [...table.fields].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    [table.fields],
  )

  // Loading is derived: the result on screen belongs to an older query.
  const queryKey = `${tableId}:${page}:${pageSize}:${sortBy}:${sortDir}:${q}:${reloadToken}`
  useEffect(() => {
    if (!open || tableId === undefined) return
    let cancelled = false
    listAuthedRows(tableId, { page, pageSize, sortBy, sortDir, q })
      .then((res) => {
        if (cancelled) return
        setResult({ key: queryKey, rows: res.rows, total: res.totalCount ?? 0, error: null })
        // The header shows the table's size, not a search's match count.
        if (!q) onTotalChange?.(res.totalCount ?? 0)
      })
      .catch((err: unknown) => {
        if (!cancelled) setResult({ key: queryKey, rows: [], total: 0, error: err })
      })
    return () => {
      cancelled = true
    }
  }, [open, tableId, page, pageSize, sortBy, sortDir, q, queryKey, onTotalChange])

  const loading = result?.key !== queryKey
  const rows = useMemo(() => result?.rows ?? [], [result])
  const total = result?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const firstLoad = loading && result === null
  const loadError = !loading ? result?.error : null

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  const flashCell = (id: string) => {
    setFlash(id)
    window.setTimeout(() => setFlash((cur) => (cur === id ? null : cur)), 1400)
  }

  const startEdit = (row: AuthedRowResponse, field: FieldDefinitionResponse) => {
    if (!canEdit) return
    setActionError(null)
    setEditing({
      key: row.entityKey,
      field: field.fieldKey,
      value: fieldValueToInput(field.dataType, row.payload[field.fieldKey]),
    })
  }

  const commitEdit = async (row: AuthedRowResponse, field: FieldDefinitionResponse) => {
    if (tableId === undefined || !editing || savingRef.current) return
    // Nothing changed → no request, no history event.
    if (editing.value === fieldValueToInput(field.dataType, row.payload[field.fieldKey])) {
      setEditing(null)
      return
    }
    const coerced = coerceFieldValue(field.dataType, editing.value)
    if (!coerced.ok) {
      setActionError(`${field.fieldLabel}: ${t(coerced.messageKey, { defaultValue: coerced.messageFallback })}`)
      return
    }
    savingRef.current = true
    setSaving(true)
    setActionError(null)
    try {
      const updated = await patchAuthedRow(tableId, row.entityKey, { [field.fieldKey]: coerced.value })
      setResult((r) => r && { ...r, rows: r.rows.map((x) => (x.entityKey === row.entityKey ? updated : x)) })
      setEditing(null)
      flashCell(`${row.entityKey}\u0000${field.fieldKey}`)
    } catch (err: unknown) {
      setActionError(`${field.fieldLabel}: ${(err as Error).message}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const restoreRow = async (row: AuthedRowResponse) => {
    if (tableId === undefined) return
    try {
      await upsertAuthedRow(tableId, { entityKey: row.entityKey, payload: row.payload, position: row.position })
      toast.success(t('tables.records.restored', { defaultValue: 'Row {{key}} restored', key: row.entityKey }))
      reload()
    } catch (err: unknown) {
      toast.error(t('tables.records.restoreFailed', { defaultValue: 'Couldn’t restore {{key}}', key: row.entityKey }), {
        description: (err as Error).message,
      })
    }
  }

  const handleDelete = async (row: AuthedRowResponse) => {
    if (tableId === undefined) return
    if (historyKey === row.entityKey) setHistoryKey(null)
    // Optimistic: the row leaves at once; a failure puts the page back.
    setResult((r) => r && { ...r, rows: r.rows.filter((x) => x.entityKey !== row.entityKey), total: Math.max(0, r.total - 1) })
    try {
      await deleteAuthedRow(tableId, row.entityKey)
      if (!q) onTotalChange?.(Math.max(0, total - 1))
      toast.success(t('tables.records.deleted', { defaultValue: 'Row {{key}} deleted', key: row.entityKey }), {
        action: { label: t('common.undo', { defaultValue: 'Undo' }), onClick: () => void restoreRow(row) },
      })
    } catch (err: unknown) {
      reload()
      toast.error(t('tables.records.deleteFailed', { defaultValue: 'Couldn’t delete {{key}}', key: row.entityKey }), {
        description: (err as Error).message,
      })
    }
  }

  const handleCreated = (entityKey: string) => {
    toast.success(t('tables.records.added', { defaultValue: 'Row {{key}} added', key: entityKey }))
    // Newest-first page 1 is where the new row lands.
    setGrid({ page: 1, sortBy: 'ts', sortDir: 'desc', q: '' })
    reload()
    flashCell(`${entityKey}\u0000*`)
  }

  const cycleSort = (col: AuthedRowSortBy) => {
    if (sortBy === col) setGrid({ sortDir: sortDir === 'asc' ? 'desc' : 'asc', page: 1 })
    // Keys and field values start A→Z / low→high; timestamps newest first.
    else setGrid({ sortBy: col, sortDir: col === 'ts' || col === 'updated_at' ? 'desc' : 'asc', page: 1 })
  }

  // The key column stands in for the identity field. Beyond the named
  // identity columns, a unique field that equals the row key on every
  // loaded row (e.g. `sku`) is the same value twice — show it once.
  const identity = useMemo(() => {
    const named = identityField(fields)
    if (named || rows.length === 0) return named
    return fields.find((f) => f.isUnique && rows.every((r) => String(r.payload[f.fieldKey] ?? '') === r.entityKey)) ?? null
  }, [fields, rows])
  const keyLabel = identity?.fieldLabel ?? t('tables.records.colKey', { defaultValue: 'Key' })
  const colCount = fields.length + 4
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  const pastEnd = !loading && !loadError && rows.length === 0 && total > 0

  const addButton = (
    <RoleGate allowed={canEdit}>
      <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!canEdit || fields.length === 0}>
        <Plus className="h-4 w-4" />
        {t('integrations.records.addRow', { defaultValue: 'Add row' })}
      </Button>
    </RoleGate>
  )

  const body = (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          {firstLoad ? (
            <Skeleton className="h-4 w-20" />
          ) : (
            <p className="text-sm font-medium tabular-nums">
              {q
                ? t('tables.records.matchCount', { defaultValue: '{{count}} matching records', count: total })
                : t('tables.records.countRecords', { defaultValue: '{{count}} records', count: total })}
            </p>
          )}
          <p className="mt-0.5 hidden text-xs text-muted-foreground sm:block">
            {canEdit
              ? t('tables.records.editHint', { defaultValue: 'Click a cell to edit — Enter saves, Esc cancels.' })
              : t('common.readOnlyHint', { defaultValue: 'You have view-only access in this workspace.' })}
          </p>
        </div>
        <div className="relative order-last w-full sm:order-none sm:w-64">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            role="searchbox"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && searchDraft && setSearchDraft('')}
            placeholder={t('tables.records.searchPlaceholder', { defaultValue: 'Search records' })}
            aria-label={t('tables.records.searchPlaceholder', { defaultValue: 'Search records' })}
            className="h-8 ps-8 pe-8"
          />
          {searchDraft.trim() !== q || (loading && q) ? (
            <Loader2 className="absolute end-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
          ) : (
            searchDraft && (
              <button
                type="button"
                onClick={() => setSearchDraft('')}
                className="absolute end-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('tables.clearSearch', { defaultValue: 'Clear search' })}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={reload}
          disabled={loading}
          aria-label={t('common.refresh', { defaultValue: 'Refresh' })}
          title={t('common.refresh', { defaultValue: 'Refresh' })}
        >
          <RefreshCw className={cn('h-4 w-4', loading && !firstLoad && 'animate-spin motion-reduce:animate-none')} />
        </Button>
        {addButton}
      </div>

      {actionError && (
        <div role="alert" className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 whitespace-pre-line break-words">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="-m-1 rounded p-1 hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('common.dismiss', { defaultValue: 'Dismiss' })}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {loadError ? (
        <QueryError
          compact
          error={loadError}
          onRetry={reload}
          what={t('tables.records.what', { defaultValue: 'these rows' })}
        />
      ) : !loading && total === 0 && q ? (
        <EmptyState
          compact
          icon={SearchX}
          className="py-14"
          title={t('tables.records.noMatchTitle', { defaultValue: 'No records match “{{q}}”', q })}
          description={t('tables.records.noMatchBody', { defaultValue: 'Search looks at the record key and every field value.' })}
          action={
            <Button size="sm" variant="outline" onClick={() => setSearchDraft('')}>
              {t('tables.clearSearch', { defaultValue: 'Clear search' })}
            </Button>
          }
        />
      ) : !loading && total === 0 ? (
        <EmptyState
          compact
          icon={Rows3}
          className="py-14"
          title={t('tables.records.emptyTitle', { defaultValue: 'No rows yet' })}
          description={t('tables.records.emptyBody', {
            defaultValue: 'Add a row by hand, or send rows from your own systems through this table’s API.',
          })}
          action={
            <>
              {canEdit && fields.length > 0 && addButton}
              {onShowApi && (
                <Button size="sm" variant="outline" onClick={onShowApi}>
                  {t('tables.records.viewApi', { defaultValue: 'View API' })}
                </Button>
              )}
            </>
          }
        />
      ) : pastEnd ? (
        <EmptyState
          compact
          icon={Rows3}
          className="py-14"
          title={t('tables.records.pastEndTitle', { defaultValue: 'This page is empty' })}
          description={t('tables.records.pastEndBody', { defaultValue: 'The table has fewer rows than this page needs.' })}
          action={
            <Button size="sm" variant="outline" onClick={() => setGrid({ page: 1 })}>
              {t('tables.records.firstPage', { defaultValue: 'Go to first page' })}
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto overscroll-x-contain" aria-busy={loading}>
          <table className={cn('w-full border-collapse text-sm transition-opacity', loading && !firstLoad && 'opacity-60')}>
            <thead className="border-b bg-muted/40">
              <tr>
                <SortHeader
                  label={keyLabel}
                  col="entity_key"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSort={cycleSort}
                  className="sticky start-0 z-[1] border-e bg-[color-mix(in_srgb,hsl(var(--muted))_40%,hsl(var(--card)))]"
                />
                {fields.map((f) => {
                  if (f.id === identity?.id) return null
                  const TypeIcon = fieldTypeMeta(f.dataType).icon
                  return (
                    <SortHeader
                      key={f.id}
                      col={`field:${f.fieldKey}`}
                      sortBy={sortBy}
                      sortDir={sortDir}
                      onSort={cycleSort}
                      title={f.fieldKey}
                      className={cn(isNumericType(f.dataType) && 'text-end')}
                      label={
                        <>
                          <TypeIcon className="h-3 w-3 opacity-60" aria-hidden />
                          {f.fieldLabel}
                          {f.isRequired && <span className="text-danger" aria-hidden>*</span>}
                        </>
                      }
                    />
                  )
                })}
                <SortHeader label={t('tables.records.colAdded', { defaultValue: 'Added' })} col="ts" sortBy={sortBy} sortDir={sortDir} onSort={cycleSort} />
                <SortHeader label={t('tables.records.colUpdated', { defaultValue: 'Updated' })} col="updated_at" sortBy={sortBy} sortDir={sortDir} onSort={cycleSort} />
                <th scope="col" className={cn(TH, 'sticky end-0 z-[1] w-px border-s bg-[color-mix(in_srgb,hsl(var(--muted))_40%,hsl(var(--card)))]')}>
                  <span className="sr-only">{t('integrations.records.actions', { defaultValue: 'Actions' })}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {firstLoad
                ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
                    <tr key={i} className="border-b last:border-0">
                      {Array.from({ length: colCount - (identity ? 1 : 0) }, (_, j) => (
                        <td key={j} className="h-10 px-3">
                          <Skeleton className="h-3" style={{ width: `${40 + ((i * 7 + j * 13) % 45)}%` }} />
                        </td>
                      ))}
                    </tr>
                  ))
                : rows.map((row) => {
                    const rowFlash = flash === `${row.entityKey}\u0000*`
                    return (
                      <tr
                        key={row.entityKey}
                        className={cn(
                          'group border-b transition-colors duration-700 last:border-0 hover:bg-muted/60',
                          rowFlash && 'bg-success/10',
                        )}
                      >
                        <th
                          scope="row"
                          className={cn('sticky start-0 z-[1] h-10 max-w-[220px] border-e px-3 text-start align-middle font-normal', STICKY_BG, rowFlash && 'bg-success/10')}
                        >
                          <span className="block truncate font-mono text-xs" dir="ltr" title={row.entityKey}>
                            {row.entityKey}
                          </span>
                        </th>
                        {fields.map((f) => {
                          if (f.id === identity?.id) return null
                          const isEditing = editing?.key === row.entityKey && editing.field === f.fieldKey
                          const flashed = flash === `${row.entityKey}\u0000${f.fieldKey}`
                          const raw = row.payload[f.fieldKey]
                          return (
                            <td
                              key={f.id}
                              tabIndex={canEdit && !isEditing ? 0 : undefined}
                              onClick={() => !isEditing && startEdit(row, f)}
                              onKeyDown={(e) => {
                                if (!isEditing && (e.key === 'Enter' || e.key === 'F2')) {
                                  e.preventDefault()
                                  startEdit(row, f)
                                }
                              }}
                              aria-label={canEdit && !isEditing ? t('tables.records.editCell', { defaultValue: 'Edit {{field}}', field: f.fieldLabel }) : undefined}
                              className={cn(
                                'h-10 max-w-[260px] px-3 align-middle transition-colors duration-700',
                                isNumericType(f.dataType) && 'text-end tabular-nums',
                                canEdit && !isEditing && 'cursor-text hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                                isEditing && 'min-w-[200px] px-1.5 py-1',
                                flashed && 'bg-success/15',
                              )}
                            >
                              {isEditing ? (
                                <FieldValueInput
                                  autoFocus
                                  compact
                                  dataType={f.dataType}
                                  value={editing.value}
                                  disabled={saving}
                                  onChange={(value) => setEditing((cur) => cur && { ...cur, value })}
                                  onCommit={() => void commitEdit(row, f)}
                                  onCancel={() => {
                                    setEditing(null)
                                    setActionError(null)
                                  }}
                                />
                              ) : (
                                <CellValue raw={raw} dataType={f.dataType} locale={i18n.language} />
                              )}
                            </td>
                          )
                        })}
                        <td className="h-10 whitespace-nowrap px-3 align-middle text-xs text-muted-foreground" title={fullTime(row.ts, i18n.language)}>
                          {relativeTime(row.ts, i18n.language)}
                        </td>
                        <td className="h-10 whitespace-nowrap px-3 align-middle text-xs text-muted-foreground" title={fullTime(row.updatedAt, i18n.language)}>
                          {relativeTime(row.updatedAt, i18n.language)}
                        </td>
                        <td className={cn('sticky end-0 z-[1] h-10 whitespace-nowrap border-s px-1.5 align-middle', STICKY_BG, rowFlash && 'bg-success/10')}>
                          <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title={t('integrations.records.history', { defaultValue: 'History' })}
                              aria-label={t('tables.records.historyFor', { defaultValue: 'History of {{key}}', key: row.entityKey })}
                              onClick={() => setHistoryKey(row.entityKey)}
                            >
                              <History className="h-3.5 w-3.5" />
                            </Button>
                            {canEdit && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                                title={t('common.delete', { defaultValue: 'Delete' })}
                                aria-label={t('tables.records.deleteRow', { defaultValue: 'Delete {{key}}', key: row.entityKey })}
                                onClick={() => void handleDelete(row)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer: range + pager */}
      {!loadError && total > 0 && (
        <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="tabular-nums">
              {t('tables.records.range', { defaultValue: '{{from}}–{{to}} of {{total}}', from, to, total })}
            </span>
            <label className="hidden items-center gap-1.5 sm:flex">
              <span>{t('tables.records.perPage', { defaultValue: 'Rows per page' })}</span>
              <select
                value={pageSize}
                onChange={(e) => setGrid({ pageSize: Number(e.target.value), page: 1 })}
                className="h-7 rounded-md border border-input bg-background px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <span className="me-2 tabular-nums">
                {t('tables.records.pageOf', { defaultValue: 'Page {{page}} of {{pages}}', page, pages: totalPages })}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={page <= 1 || loading}
                onClick={() => setGrid({ page: Math.max(1, page - 1) })}
                aria-label={t('common.prev', { defaultValue: 'Previous' })}
              >
                <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={page >= totalPages || loading}
                onClick={() => setGrid({ page: Math.min(totalPages, page + 1) })}
                aria-label={t('common.next', { defaultValue: 'Next' })}
              >
                <ChevronRight className="h-4 w-4 rtl:rotate-180" />
              </Button>
            </div>
          )}
        </div>
      )}

      {createOpen && tableId !== undefined && (
        <CreateRowDialog
          table={table}
          fields={fields}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={handleCreated}
          tableId={tableId}
        />
      )}

      {historyKey !== null && tableId !== undefined && (
        <TableRowHistoryDialog
          table={table}
          entityKey={historyKey}
          open={historyKey !== null}
          onOpenChange={(v) => !v && setHistoryKey(null)}
        />
      )}
    </div>
  )

  if (inline) return body

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {t('integrations.records.title', { defaultValue: '{{name}} · records', name: table.dataSource.name })}
          </DialogTitle>
          <DialogDescription>
            {t('tables.records.dialogDescription', { defaultValue: 'Every row this table holds, newest first.' })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">{body}</div>
      </DialogContent>
    </Dialog>
  )
}

function SortHeader({
  label,
  col,
  sortBy,
  sortDir,
  onSort,
  className,
  title,
}: {
  label: React.ReactNode
  col: AuthedRowSortBy
  sortBy: AuthedRowSortBy
  sortDir: SortDir
  onSort: (col: AuthedRowSortBy) => void
  className?: string
  title?: string
}) {
  const active = sortBy === col
  const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th scope="col" title={title} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className={cn(TH, className)}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          '-mx-1.5 inline-flex items-center gap-1.5 rounded px-1.5 py-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active && 'text-foreground',
        )}
      >
        {label}
        <Icon className={cn('h-3 w-3', !active && 'opacity-40')} aria-hidden />
      </button>
    </th>
  )
}

// ============================================================ cell render

function CellValue({ raw, dataType, locale }: { raw: unknown; dataType: string; locale: string }) {
  if (raw === undefined || raw === null || raw === '') {
    return <span className="text-muted-foreground/60">—</span>
  }
  const text = formatFieldValue(dataType, raw, locale)
  if (dataType === 'url' || dataType === 'email') {
    return (
      <a
        href={dataType === 'email' ? `mailto:${text}` : text}
        target={dataType === 'url' ? '_blank' : undefined}
        rel="noreferrer noopener"
        className="block truncate text-primary hover:underline"
        title={text}
        dir="ltr"
        onClick={(e) => e.stopPropagation()}
      >
        {text}
      </a>
    )
  }
  const mono = isMonospaceType(dataType) && !isNumericType(dataType)
  return (
    <span className={cn('block truncate', mono && 'font-mono text-xs')} dir={mono ? 'ltr' : undefined} title={text}>
      {text}
    </span>
  )
}

/**
 * One value editor, shaped by the field's declared type — shared by the
 * create-row form and the grid's inline cell edit. Everything is held as
 * a string and coerced on save by `coerceFieldValue`, so the input type
 * here is an affordance (native pickers, mobile keyboards) rather than
 * the validation itself.
 *
 * Enter commits, except in a textarea where it has to insert a newline —
 * there the shortcut moves to Cmd/Ctrl+Enter.
 */
function FieldValueInput({
  id,
  dataType,
  value,
  disabled,
  compact,
  autoFocus,
  onChange,
  onCommit,
  onCancel,
}: {
  id?: string
  dataType: string
  value: string
  disabled?: boolean
  compact?: boolean
  autoFocus?: boolean
  onChange: (value: string) => void
  onCommit?: () => void
  onCancel?: () => void
}) {
  const meta = fieldTypeMeta(dataType)
  const multiline = meta.inputType === 'textarea'

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel?.()
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onCommit?.()
    }
  }

  if (meta.inputType === 'select') {
    return (
      <select
        id={id}
        autoFocus={autoFocus}
        className={cn('w-full rounded-md border border-input bg-background px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', compact ? 'h-8 text-sm' : 'h-9 text-sm')}
        value={value === '' ? 'false' : value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCommit}
      >
        <option value="false">false</option>
        <option value="true">true</option>
      </select>
    )
  }

  if (multiline) {
    return (
      <textarea
        id={id}
        autoFocus={autoFocus}
        className={`w-full border border-input rounded-md px-2 py-1.5 bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          compact ? 'min-h-[52px] text-sm' : 'min-h-[72px] text-sm'
        } ${dataType === 'json' ? 'font-mono' : ''}`}
        dir={dataType === 'json' ? 'ltr' : undefined}
        value={value}
        disabled={disabled}
        placeholder={meta.hint}
        spellCheck={dataType !== 'json'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCommit}
      />
    )
  }

  return (
    <Input
      id={id}
      autoFocus={autoFocus}
      type={meta.inputType}
      value={value}
      disabled={disabled}
      placeholder={meta.hint}
      step={dataType === 'integer' ? 1 : dataType === 'number' ? 'any' : undefined}
      className={compact ? 'h-8' : undefined}
      // Grid edit behaves like a spreadsheet: typing replaces the value.
      onFocus={compact ? (e) => e.currentTarget.select() : undefined}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={onCommit}
    />
  )
}

// ============================================================ create dialog

function CreateRowDialog({
  table,
  fields,
  open,
  onOpenChange,
  onCreated,
  tableId,
}: {
  table: TableResponse
  fields: FieldDefinitionResponse[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (entityKey: string) => void
  tableId: number
}) {
  const { t } = useTranslation()
  // Mounted only while open, so every open starts from a blank form.
  const [entityKey, setEntityKey] = useState('')
  const [payload, setPayload] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // When the schema declares an identity column (external_code / id /
  // name), that field IS the row key — asking for it twice is the same
  // value entered twice. Mirrors how a file/REST import derives
  // `entity_key` from the row rather than carrying a separate one.
  const identity = useMemo(() => identityField(fields), [fields])
  const coords = useMemo(() => coordFields(fields), [fields])

  const save = async () => {
    const key = identity ? (payload[identity.fieldKey] ?? '').trim() : entityKey.trim()
    if (key.length === 0) {
      setError(
        identity
          ? `${identity.fieldLabel}: ${t('tables.fieldTypes.requiredField', { defaultValue: 'is required' })}`
          : t('tables.records.keyRequired', { defaultValue: 'Row key is required.' }),
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      const builtPayload: Record<string, unknown> = {}
      for (const f of fields) {
        const raw = payload[f.fieldKey] ?? ''
        if (raw.trim() === '') continue
        const coerced = coerceFieldValue(f.dataType, raw)
        if (!coerced.ok) {
          throw new Error(`${f.fieldLabel}: ${t(coerced.messageKey, { defaultValue: coerced.messageFallback })}`)
        }
        builtPayload[f.fieldKey] = coerced.value
      }
      for (const f of fields) {
        if (f.isRequired && !(f.fieldKey in builtPayload)) {
          throw new Error(`${f.fieldLabel}: ${t('tables.fieldTypes.requiredField', { defaultValue: 'is required' })}`)
        }
      }
      // Mirror the row's lng/lat into the indexed `position` column so
      // coord-mode matching doesn't have to scan JSON.
      let position: [number, number] | undefined
      if (coords) {
        const lng = Number(builtPayload[coords.lng.fieldKey])
        const lat = Number(builtPayload[coords.lat.fieldKey])
        if (Number.isFinite(lng) && Number.isFinite(lat)) position = [lng, lat]
      }
      await upsertAuthedRow(tableId, { entityKey: key, payload: builtPayload, position })
      onOpenChange(false)
      onCreated(key)
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="flex max-h-[90dvh] flex-col p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-6 pb-4 pt-6">
          <DialogTitle>{t('tables.records.createTitle', { defaultValue: 'Add a row' })}</DialogTitle>
          <DialogDescription>
            {t('tables.records.createBody', {
              defaultValue: 'Adds one row to {{name}}. Fields marked * are required.',
              name: table.dataSource.name,
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          id="create-row-form"
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          {!identity && (
            <div className="space-y-1.5">
              <Label htmlFor="create-row-key">
                {t('tables.records.colKey', { defaultValue: 'Key' })}
                <span className="ms-0.5 text-danger" aria-hidden>*</span>
              </Label>
              <Input
                id="create-row-key"
                autoFocus
                value={entityKey}
                onChange={(e) => setEntityKey(e.target.value)}
                disabled={busy}
                dir="ltr"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {t('tables.records.keyHint', { defaultValue: 'A unique ID for this row — writing the same key again updates it.' })}
              </p>
            </div>
          )}
          {fields.map((f, i) => {
            const TypeIcon = fieldTypeMeta(f.dataType).icon
            const inputId = `create-row-${f.id}`
            return (
              <div key={f.id} className="space-y-1.5">
                <Label htmlFor={inputId} className="flex items-center gap-1.5">
                  <TypeIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  {f.fieldLabel}
                  {(f.isRequired || f.id === identity?.id) && <span className="text-danger" aria-hidden>*</span>}
                  <span className="ms-auto font-mono text-[11px] font-normal text-muted-foreground" dir="ltr">
                    {f.fieldKey}
                  </span>
                </Label>
                <FieldValueInput
                  id={inputId}
                  autoFocus={!!identity && i === 0}
                  dataType={f.dataType}
                  value={payload[f.fieldKey] ?? ''}
                  disabled={busy}
                  onChange={(v) => setPayload((p) => ({ ...p, [f.fieldKey]: v }))}
                />
                {f.id === identity?.id && (
                  <p className="text-xs text-muted-foreground">
                    {t('tables.records.identityHint', { defaultValue: 'Also the row key — writing the same value again updates the row.' })}
                  </p>
                )}
              </div>
            )
          })}
        </form>
        <div className="space-y-3 border-t px-6 py-4">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 whitespace-pre-line break-words">{error}</span>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" form="create-row-form" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
              {t('tables.records.createSubmit', { defaultValue: 'Add row' })}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================ history panel

const OP_STYLE: Record<string, { dot: string; key: string; fallback: string }> = {
  insert: { dot: 'bg-success', key: 'tables.history.opInsert', fallback: 'Created' },
  update: { dot: 'bg-info', key: 'tables.history.opUpdate', fallback: 'Updated' },
  delete: { dot: 'bg-danger', key: 'tables.history.opDelete', fallback: 'Deleted' },
}

export function TableRowHistoryDialog({
  table,
  entityKey,
  open,
  onOpenChange,
}: {
  table: TableResponse
  entityKey: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const tableId = table.dataSource.id
  const [reloadToken, setReloadToken] = useState(0)
  const [result, setResult] = useState<{ key: string; events: TableEventWire[]; error: unknown } | null>(null)

  const queryKey = `${tableId}:${entityKey}:${reloadToken}`
  useEffect(() => {
    if (!open || tableId === undefined) return
    let cancelled = false
    listTableRowEvents(tableId, entityKey)
      .then((events) => {
        if (!cancelled) setResult({ key: queryKey, events, error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled) setResult({ key: queryKey, events: [], error: err })
      })
    return () => {
      cancelled = true
    }
  }, [open, tableId, entityKey, queryKey])

  const loading = result?.key !== queryKey
  const labels = useMemo(() => new Map(table.fields.map((f) => [f.fieldKey, f.fieldLabel])), [table.fields])

  // Diff each snapshot against the one before it (events arrive oldest
  // first), then show newest first — the question is usually "what just
  // changed?".
  const steps = useMemo(() => {
    const events = result?.events ?? []
    return events
      .map((evt, idx) => ({ evt, diffs: computeDiff(idx > 0 ? events[idx - 1].payload : undefined, evt.payload) }))
      .reverse()
  }, [result])

  return (
    // modal={false}: the grid stays usable, so the next row's history can
    // be opened without closing this first.
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="end"
        className="w-[min(460px,100vw)] rounded-none sm:rounded-s-xl"
        aria-describedby={undefined}
        onFocusOutside={(e) => e.preventDefault()}
      >
        <div className="border-b px-5 py-4 pe-12">
          <SheetTitle className="text-base">{t('tables.history.title', { defaultValue: 'Row history' })}</SheetTitle>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" dir="ltr" title={entityKey}>
            {entityKey}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
          {loading ? (
            <div className="space-y-6" aria-busy>
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="mt-1 h-2.5 w-2.5 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-4/5" />
                    <Skeleton className="h-3 w-3/5" />
                  </div>
                </div>
              ))}
            </div>
          ) : result?.error ? (
            <QueryError
              compact
              error={result.error}
              onRetry={() => setReloadToken((n) => n + 1)}
              what={t('tables.history.what', { defaultValue: 'this row’s history' })}
            />
          ) : steps.length === 0 ? (
            <EmptyState
              compact
              icon={History}
              title={t('tables.history.emptyTitle', { defaultValue: 'No history yet' })}
              description={t('tables.history.emptyBody', {
                defaultValue: 'Changes to this row are recorded from now on — each edit, import or API write adds a step.',
              })}
            />
          ) : (
            <ol className="relative space-y-6 before:absolute before:bottom-2 before:start-[4.5px] before:top-2 before:w-px before:bg-border">
              {steps.map(({ evt, diffs }) => {
                const op = OP_STYLE[evt.operation] ?? { dot: 'bg-muted-foreground', key: '', fallback: evt.operation }
                return (
                  <li key={evt.id} className="relative flex gap-3">
                    <span className={cn('relative mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-background', op.dot)} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-medium">{op.key ? t(op.key, { defaultValue: op.fallback }) : op.fallback}</span>
                        <time className="text-xs text-muted-foreground" dateTime={evt.ts} title={fullTime(evt.ts, i18n.language)}>
                          {relativeTime(evt.ts, i18n.language)}
                        </time>
                        {evt.sourceIp && (
                          <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">
                            {evt.sourceIp}
                          </span>
                        )}
                      </div>
                      {evt.operation === 'delete' ? null : diffs.length === 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t('tables.history.noChanges', { defaultValue: 'Written again with the same values.' })}
                        </p>
                      ) : (
                        <dl className="mt-2 divide-y overflow-hidden rounded-lg border bg-muted/30 text-xs">
                          {diffs.map((d) => (
                            <div key={d.field} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 px-3 py-2">
                              <dt className="truncate text-muted-foreground" title={d.field}>
                                {labels.get(d.field) ?? d.field}
                              </dt>
                              <dd className="min-w-0 break-words">
                                {d.op !== 'added' && (
                                  <span className="text-danger line-through decoration-danger/50">{formatVal(d.old)}</span>
                                )}
                                {d.op === 'changed' && <span className="mx-1 text-muted-foreground rtl:rotate-180">→</span>}
                                {d.op !== 'removed' && <span className="font-medium text-success">{formatVal(d.new)}</span>}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

interface FieldDiff {
  field: string
  op: 'added' | 'removed' | 'changed'
  old?: unknown
  new?: unknown
}

function computeDiff(
  prev: Record<string, unknown> | undefined,
  curr: Record<string, unknown> | undefined,
): FieldDiff[] {
  const a = prev ?? {}
  const b = curr ?? {}
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)])
  const out: FieldDiff[] = []
  for (const k of keys) {
    const inA = k in a
    const inB = k in b
    if (inA && !inB) out.push({ field: k, op: 'removed', old: a[k] })
    else if (!inA && inB) out.push({ field: k, op: 'added', new: b[k] })
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      out.push({ field: k, op: 'changed', old: a[k], new: b[k] })
    }
  }
  out.sort((x, y) => x.field.localeCompare(y.field))
  return out
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
