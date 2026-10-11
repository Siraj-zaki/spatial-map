/**
 * /tables/:id — one thing-type table.
 *
 * Header: name, status (lib/table-status.ts — Needs fields / No records
 * yet / Receiving data / No recent writes), kind, records, last write,
 * fields, and a ⋯ menu (edit schema, keys, copy ID, delete). A callout
 * appears while there are no fields or no records, with the next step.
 * (A missing API key is not a setup problem: the grid and REST pulls
 * write without one.)
 *
 * Tabs (URL-synced, `?tab=records|api|schema`):
 *   1. Records      — `DataGrid` (server-paginated grid, inline edit,
 *                     delete + Undo, per-row history panel).
 *   2. API & access — `ApiDocsViewer` (keys, endpoints, REST polling).
 *   3. Schema       — `SchemaBuilder` in edit mode for owners/admins; a
 *                     read-only field list for everyone else.
 *
 * States: skeleton that mirrors the loaded layout, not-found (bad id or
 * 404), load error with retry/offline handling. Modular pieces live in
 * `src/components/data-link/`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ChevronLeft,
  Columns3,
  Copy,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Rows3,
  SearchX,
  Shapes,
  Table2,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { PageContainer, rise } from '@/components/page-shell'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { QueryError } from '@/components/feedback/query-error'
import { useUrlState } from '@/hooks/useUrlState'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { ApiError } from '@/lib/api-client'
import { toast } from '@/lib/toast-store'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { fieldTypeMeta } from '@/lib/table-field-types'
import { activeKeyCount, entityKindLabel, tableStatus, tableStatusLabel, tableStatusVariant } from '@/lib/table-status'
import {
  deleteTable,
  formatIntegrationLinkedMessage,
  getTable,
  isIntegrationLinkedError,
  type TableResponse,
} from '@/lib/tables-client'
import { SchemaBuilder } from '@/components/data-link/schema-builder'
import { DataGrid } from '@/components/data-link/data-grid'
import { ApiDocsViewer } from '@/components/data-link/api-docs-viewer'

type TabKey = 'records' | 'api' | 'schema'
const TABS: TabKey[] = ['records', 'api', 'schema']

export default function TableDetailPage() {
  const { id } = useParams<{ id: string }>()
  const tableId = id ? Number(id) : NaN
  const validId = Number.isInteger(tableId) && tableId > 0
  const navigate = useNavigate()
  const { t, i18n } = useTranslation()
  const { canManage } = useWorkspaceRole()

  const [tabParam, setTabParam] = useUrlState<string>('tab', 'records')
  const tab: TabKey = TABS.includes(tabParam as TabKey) ? (tabParam as TabKey) : 'records'
  const setTab = (next: TabKey) => setTabParam(next)

  const [reloadToken, setReloadToken] = useState(0)
  const [result, setResult] = useState<{ key: string; table: TableResponse | null; error: unknown } | null>(null)
  const [rowCount, setRowCount] = useState<number | null>(null)

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const queryKey = `${tableId}:${reloadToken}`
  useEffect(() => {
    if (!validId) return
    let cancelled = false
    getTable(tableId)
      .then((table) => {
        if (!cancelled) setResult({ key: queryKey, table, error: null })
      })
      .catch((error: unknown) => {
        // Keep the last good table on a background refresh failure.
        if (!cancelled) setResult((prev) => ({ key: queryKey, table: prev?.table?.dataSource.id === tableId ? prev.table : null, error }))
      })
    return () => {
      cancelled = true
    }
  }, [tableId, validId, queryKey])

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  // The grid reports its live total. When it disagrees with the snapshot
  // (a record was just added or deleted) refetch the table so the header's
  // last write and status follow. Reads the snapshot through a ref so the
  // callback stays stable, as DataGrid requires.
  const snapshotRows = useRef<number | null>(null)
  useEffect(() => {
    snapshotRows.current = result?.table?.stats?.rows ?? null
  })
  const handleTotal = useCallback(
    (n: number) => {
      setRowCount(n)
      if (snapshotRows.current !== null && snapshotRows.current !== n) {
        snapshotRows.current = n
        reload()
      }
    },
    [reload],
  )

  const table = result?.table?.dataSource.id === tableId ? result.table : null
  const pending = validId && result?.key !== queryKey
  const notFound =
    !validId || (!table && !pending && result?.error instanceof ApiError && result.error.status === 404)

  const doDelete = async () => {
    if (!table || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteTable(tableId)
      toast.success(t('tables.deleted', { defaultValue: '{{name}} deleted', name: table.dataSource.name }))
      navigate('/tables', { replace: true })
    } catch (err) {
      setDeleteError(isIntegrationLinkedError(err) ? formatIntegrationLinkedMessage(err, t) : (err as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const backLink = (
    <Link
      to="/tables"
      className="inline-flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
      {t('tables.detail.back', { defaultValue: 'All tables' })}
    </Link>
  )

  if (notFound) {
    return (
      <PageContainer className="gap-6">
        {backLink}
        <EmptyState
          icon={SearchX}
          title={t('tables.detail.notFoundTitle', { defaultValue: 'Table not found' })}
          description={t('tables.detail.notFoundBody', {
            defaultValue: 'It may have been deleted, or it belongs to another workspace.',
          })}
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/tables">{t('tables.detail.back', { defaultValue: 'All tables' })}</Link>
            </Button>
          }
        />
      </PageContainer>
    )
  }

  if (!table) {
    return (
      <PageContainer className="gap-6">
        {backLink}
        {pending ? (
          <DetailSkeleton />
        ) : (
          <QueryError error={result?.error} onRetry={reload} what={t('tables.detail.what', { defaultValue: 'this table' })} />
        )}
      </PageContainer>
    )
  }

  const ds = table.dataSource
  const keys = activeKeyCount(table)
  // The grid's live total wins over the snapshot from GET /tables/:id.
  const records = rowCount ?? table.stats?.rows ?? 0
  const status = tableStatus({ ...table, stats: { ...(table.stats ?? { activeKeys: keys, polling: false }), rows: records } })
  const lastWriteAt = table.stats?.lastWriteAt
  const nf = new Intl.NumberFormat(i18n.language)

  return (
    <PageContainer className="gap-6">
      <div {...rise(0)}>{backLink}</div>

      <header {...rise(1, 'flex items-start justify-between gap-4')}>
        <div className="flex min-w-0 items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/15">
            <Table2 className="h-6 w-6" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1.5">
            <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-[28px] sm:leading-9">{ds.name}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
              <Badge variant={tableStatusVariant(status)}>{tableStatusLabel(status, t)}</Badge>
              <span className="inline-flex items-center gap-1.5">
                <Shapes className="h-3.5 w-3.5" aria-hidden />
                {entityKindLabel(ds.entityKind, t)}
              </span>
              <span className="tabular-nums">{t('tables.recordsCount', { defaultValue: '{{count}} records', count: records })}</span>
              <span title={lastWriteAt ? fullTime(lastWriteAt, i18n.language) : undefined}>
                {lastWriteAt
                  ? t('tables.lastWriteAgo', { defaultValue: 'Last write {{when}}', when: relativeTime(lastWriteAt, i18n.language) })
                  : t('tables.neverWritten', { defaultValue: 'Never written' })}
              </span>
            </div>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="shrink-0" aria-label={t('tables.detail.more', { defaultValue: 'More actions' })}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => setTab('schema')}>
              <Pencil className="me-2 h-4 w-4" />
              {t('tables.detail.editSchema', { defaultValue: 'Edit schema' })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTab('api')}>
              <KeyRound className="me-2 h-4 w-4" />
              {t('tables.detail.manageKeys', { defaultValue: 'Manage API keys' })}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={async () => {
                try {
                  await navigator.clipboard.writeText(String(ds.id))
                  toast.success(t('tables.detail.idCopied', { defaultValue: 'Table ID {{id}} copied', id: ds.id }))
                } catch {
                  /* clipboard blocked */
                }
              }}
            >
              <Copy className="me-2 h-4 w-4" />
              {t('tables.detail.copyId', { defaultValue: 'Copy table ID' })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!canManage}
              onSelect={() => {
                setDeleteError(null)
                setConfirmDelete(true)
              }}
              className="text-danger focus:bg-danger/10 focus:text-danger"
            >
              <Trash2 className="me-2 h-4 w-4" />
              {t('tables.deleteConfirm', { defaultValue: 'Delete table' })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {(status === 'needsFields' || status === 'empty') && (
        <div {...rise(2, 'flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 sm:flex-row sm:items-center')}>
          <TriangleAlert className="hidden h-5 w-5 shrink-0 text-warning sm:block" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {status === 'needsFields'
                ? t('tables.detail.setupFieldsTitle', { defaultValue: 'Add fields before this table can store rows' })
                : t('tables.detail.emptyTitle', { defaultValue: 'No records yet' })}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {status === 'needsFields'
                ? t('tables.detail.setupFieldsBody', { defaultValue: 'Fields are the columns — what each row records.' })
                : t('tables.detail.emptyBody', { defaultValue: 'Add one by hand in Records, or connect a system with an API key or a REST pull.' })}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {status === 'needsFields' ? (
              <Button size="sm" variant="outline" onClick={() => setTab('schema')}>
                {t('tables.detail.setupFieldsCta', { defaultValue: 'Add fields' })}
              </Button>
            ) : (
              <>
                {tab !== 'records' && (
                  <Button size="sm" variant="outline" onClick={() => setTab('records')}>
                    {t('tables.detail.addRecordCta', { defaultValue: 'Add a record' })}
                  </Button>
                )}
                {tab !== 'api' && (
                  <Button size="sm" variant="outline" onClick={() => setTab('api')}>
                    {t('tables.detail.connectCta', { defaultValue: 'Connect a system' })}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} {...rise(3)}>
        <TabsList>
          <TabsTrigger value="records">
            <Rows3 className="hidden sm:block" />
            {t('tables.detail.tabRecords', { defaultValue: 'Records' })}
            <span className="tabular-nums text-muted-foreground">{nf.format(records)}</span>
          </TabsTrigger>
          <TabsTrigger value="api">
            <KeyRound className="hidden sm:block" />
            {t('tables.detail.tabApi', { defaultValue: 'API & access' })}
            <span className="tabular-nums text-muted-foreground">{nf.format(keys)}</span>
          </TabsTrigger>
          <TabsTrigger value="schema">
            <Columns3 className="hidden sm:block" />
            {t('tables.detail.tabSchema', { defaultValue: 'Schema' })}
            <span className="tabular-nums text-muted-foreground">{nf.format(table.fields.length)}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="records" className="mt-5">
          <DataGrid table={table} onShowApi={() => setTab('api')} onTotalChange={handleTotal} />
        </TabsContent>
        <TabsContent value="api" className="mt-5">
          <ApiDocsViewer table={table} onChanged={reload} />
        </TabsContent>
        <TabsContent value="schema" className="mt-5">
          {canManage ? (
            <SchemaBuilder
              existing={table}
              onDone={() => {
                toast.success(t('tables.detail.schemaSaved', { defaultValue: 'Schema saved' }))
                reload()
              }}
            />
          ) : (
            <ReadOnlySchema table={table} />
          )}
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(o) => {
          if (!o) {
            setConfirmDelete(false)
            setDeleteError(null)
          }
        }}
        title={t('tables.deleteTitle', { defaultValue: 'Delete this table?' })}
        description={t('tables.deleteBody', {
          defaultValue: 'Deletes "{{name}}" along with every row and event it has ingested. This cannot be undone.',
          name: ds.name,
        })}
        confirmLabel={t('tables.deleteConfirm', { defaultValue: 'Delete table' })}
        onConfirm={() => void doDelete()}
        busy={deleting}
        error={deleteError}
      />
    </PageContainer>
  )
}

/** Viewers/editors: the columns, without controls that would fail. */
function ReadOnlySchema({ table }: { table: TableResponse }) {
  const { t } = useTranslation()
  const fields = [...table.fields].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  if (fields.length === 0) {
    return (
      <EmptyState
        icon={Columns3}
        title={t('tables.detail.noFieldsTitle', { defaultValue: 'No fields yet' })}
        description={t('tables.detail.noFieldsViewer', { defaultValue: 'A workspace owner or admin can add them.' })}
      />
    )
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <p className="border-b px-5 py-3 text-sm text-muted-foreground">
        {t('tables.detail.schemaReadOnly', { defaultValue: 'Only workspace owners and admins can change the schema.' })}
      </p>
      <ul className="divide-y">
        {fields.map((f) => {
          const meta = fieldTypeMeta(f.dataType)
          const Icon = meta.icon
          return (
            <li key={f.id} className="flex items-center gap-3 px-5 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{f.fieldLabel}</p>
                <p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{f.fieldKey}</p>
              </div>
              <span className="text-xs text-muted-foreground">{t(meta.labelKey, { defaultValue: meta.labelFallback })}</span>
              {f.isRequired && <Badge variant="muted">{t('tables.detail.required', { defaultValue: 'Required' })}</Badge>}
              {f.isUnique && <Badge variant="muted">{t('tables.detail.unique', { defaultValue: 'Unique' })}</Badge>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Mirrors the loaded header + tabs + grid so nothing jumps on arrival. */
function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy>
      <div className="flex items-start gap-4">
        <Skeleton className="h-12 w-12 rounded-xl" />
        <div className="space-y-2.5">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-80 max-w-[60vw]" />
        </div>
      </div>
      <Skeleton className="h-9 w-80 max-w-full rounded-lg" />
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <Skeleton className="h-4 w-24" />
        </div>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex gap-6 border-b px-4 py-3 last:border-0">
            {Array.from({ length: 6 }, (_, j) => (
              <Skeleton key={j} className="h-3 flex-1" style={{ maxWidth: `${60 + ((i * 11 + j * 17) % 90)}px` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
