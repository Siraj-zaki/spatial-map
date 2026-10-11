/**
 * The four Data-screen tables (records, rooms & bins, files, runs), their
 * phone layouts, and the pager.
 *
 * ONE scroll: the page. TableShell has no height cap and no sideways
 * scroll — a table that scrolled inside a page that also scrolled meant
 * two scrollbars and a pager you had to hunt for. The header sticks to the
 * page instead (the card around it uses `overflow-clip`, which unlike
 * `overflow-hidden` doesn't create a scroll container, so `sticky` still
 * works), and columns fit by truncating; lower-priority columns (source on records/bins/files,
 * notes, duration) hide below `xl`. Below `md` each table becomes a card list.
 *
 * Motion: rows rise in when they first mount (new page / filter), staggered
 * a few ms apart; polling refreshes keep the same row elements, so nothing
 * re-animates on a refresh. A record that arrives live gets a fading
 * highlight (useFreshIds). All of it is off under reduced motion
 * (`.sgv-row-in` / `.sgv-row-new` in index.css).
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Eye, FileText, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { DataBin, DataFile, DataRow, DataRun } from '@/lib/data-screen-client'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { formatBytes, formatDuration, payloadEntries, previewValue, runCounts, runResult, runResultLabel, runResultVariant } from './data-helpers'
import { SourceKindIcon } from './source-picker'

export type SortDir = 'asc' | 'desc'
export interface SortState<K extends string> {
  key: K
  dir: SortDir
}

// ---- motion helpers --------------------------------------------------

/**
 * Ids that appeared since the last render of the SAME query (a live
 * arrival), as opposed to a new page or filter (a fresh set — no flash).
 * Seen ids catch up after the highlight has played.
 */
function useFreshIds(ids: number[], queryKey: string): Set<number> {
  const [seen, setSeen] = useState<{ key: string; ids: Set<number> }>(() => ({ key: queryKey, ids: new Set(ids) }))
  if (seen.key !== queryKey) setSeen({ key: queryKey, ids: new Set(ids) })
  const fresh = seen.key === queryKey ? new Set(ids.filter((id) => !seen.ids.has(id))) : new Set<number>()
  const freshKey = [...fresh].join(',')
  useEffect(() => {
    if (!freshKey) return
    const id = window.setTimeout(() => setSeen((s) => ({ key: s.key, ids: new Set([...s.ids, ...freshKey.split(',').map(Number)]) })), 1700)
    return () => window.clearTimeout(id)
  }, [freshKey])
  return fresh
}

const rowMotion = (i: number, fresh: boolean) => ({
  className: cn('sgv-row-in', fresh && 'sgv-row-new'),
  style: { '--sgv-i': i } as React.CSSProperties,
})

// ---- shell -------------------------------------------------------------

function TableShell({ header, children, busy }: { header: React.ReactNode; children: React.ReactNode; busy: boolean }) {
  return (
    <table aria-busy={busy} className="hidden w-full table-fixed border-separate border-spacing-0 text-sm md:table">
      <thead className="sticky top-0 z-10 [&_th]:border-b [&_th]:border-border [&_th]:bg-card/95 [&_th]:backdrop-blur">{header}</thead>
      <tbody className="[&>tr:last-child>td]:border-b-0 [&>tr>td]:border-b [&>tr>td]:border-border/60">{children}</tbody>
    </table>
  )
}

const TH = 'h-10 whitespace-nowrap px-3 text-start text-xs font-medium text-muted-foreground'

function SortHeader<K extends string>({ label, k, sort, onSort, className, end }: { label: string; k: K; sort: SortState<K>; onSort: (s: SortState<K>) => void; className?: string; end?: boolean }) {
  const active = sort.key === k
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={cn(TH, end && 'text-end', className)}>
      <button
        type="button"
        onClick={() => onSort(active ? { key: k, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' })}
        className={cn('-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active && 'text-foreground', end && 'flex-row-reverse')}
      >
        {label}
        <Icon className={cn('h-3 w-3', !active && 'opacity-40')} aria-hidden />
      </button>
    </th>
  )
}

function Check({ checked, onChange, label, mixed }: { checked: boolean; onChange: () => void; label: string; mixed?: boolean }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!mixed && !checked
      }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      className="h-4 w-4 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
    />
  )
}

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 8 }, (_, i) => (
        <tr key={i} aria-hidden>
          {Array.from({ length: cols }, (_, j) => (
            <td key={j} className="h-11 px-3">
              <Skeleton className="h-3.5" style={{ width: j === 0 ? 16 : `${45 + ((i * 7 + j * 13) % 45)}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

function When({ iso }: { iso?: string }) {
  const { i18n } = useTranslation()
  if (!iso) return <span className="text-muted-foreground">—</span>
  return (
    <time dateTime={iso} title={fullTime(iso, i18n.language)} className="whitespace-nowrap text-xs text-muted-foreground">
      {relativeTime(iso, i18n.language)}
    </time>
  )
}

function SourceCell({ name, kind, archived, deletedId }: { name: string; kind?: string; archived?: boolean; deletedId?: number }) {
  const { t } = useTranslation()
  if (!name) {
    return (
      <span className="text-sm text-muted-foreground" title={deletedId ? `#${deletedId}` : undefined}>
        {t('data.source.deleted', { defaultValue: 'Deleted source' })}
      </span>
    )
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {kind && <SourceKindIcon kind={kind} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      <span className="truncate">{name}</span>
      {archived && (
        <Badge variant="warning" className="shrink-0 gap-1">
          <Archive className="h-3 w-3" aria-hidden />
          {t('data.archivedBadge', { defaultValue: 'Archived' })}
        </Badge>
      )}
    </span>
  )
}

/** First few payload fields as muted-key / value pairs on one line. */
function FieldsPreview({ payload, max = 4 }: { payload: unknown; max?: number }) {
  const entries = payloadEntries(payload)
  if (!entries) return <code className="block truncate font-mono text-xs text-muted-foreground">{previewValue(payload)}</code>
  return (
    <p className="truncate text-xs" dir="ltr">
      {entries.slice(0, max).map(([k, v], i) => (
        <span key={k}>
          {i > 0 && <span className="mx-1.5 text-muted-foreground/40">·</span>}
          <span className="text-muted-foreground">{k}</span> <span className="font-medium">{previewValue(v)}</span>
        </span>
      ))}
      {entries.length > max && <span className="ms-1.5 text-muted-foreground">+{entries.length - max}</span>}
    </p>
  )
}

function RowActions({ onView, onDelete, canDelete, viewLabel, deleteLabel }: { onView?: () => void; onDelete: () => void; canDelete: boolean; viewLabel: string; deleteLabel: string }) {
  return (
    <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
      {onView && (
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); onView() }} aria-label={viewLabel} title={viewLabel}>
          <Eye className="h-3.5 w-3.5" />
        </Button>
      )}
      {canDelete && (
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:bg-danger/10 hover:text-danger" onClick={(e) => { e.stopPropagation(); onDelete() }} aria-label={deleteLabel} title={deleteLabel}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

interface Common<T> {
  rows: T[]
  loading: boolean
  queryKey: string
  selected: Set<number>
  onToggle: (id: number) => void
  onToggleAll: (ids: number[]) => void
  onDelete: (row: T) => void
  canDelete: boolean
  empty: React.ReactNode
  activeId?: number
}

const clickableRow = (active: boolean) =>
  cn('group cursor-pointer transition-colors hover:bg-muted/50 focus-within:bg-muted/40', active && 'bg-primary/5 hover:bg-primary/5')

// ---- records -----------------------------------------------------------

export type RowsSortKey = 'ts' | 'updatedAt' | 'sourceName' | 'entityKey'

export function RecordsTable({ rows, loading, queryKey, selected, onToggle, onToggleAll, onDelete, canDelete, empty, activeId, sort, onSort, onOpen, showSource }: Common<DataRow> & { sort: SortState<RowsSortKey>; onSort: (s: SortState<RowsSortKey>) => void; onOpen: (index: number) => void; showSource: boolean }) {
  const { t } = useTranslation()
  const ids = rows.map((r) => r.id)
  const fresh = useFreshIds(ids, queryKey)
  const all = ids.length > 0 && ids.every((id) => selected.has(id))
  const some = ids.some((id) => selected.has(id))
  const cols = showSource ? 6 : 5
  const view = t('data.action.viewRecord', { defaultValue: 'Open record' })
  const del = t('data.action.deleteRow', { defaultValue: 'Delete' })
  return (
    <>
      <TableShell
        busy={loading}
        header={
          <tr>
            <th className={cn(TH, 'w-10')}>
              {canDelete && <Check checked={all} mixed={some} onChange={() => onToggleAll(ids)} label={t('data.bulk.selectAll', { defaultValue: 'Select all rows' })} />}
            </th>
            <SortHeader label={t('data.col.entityKey', { defaultValue: 'Key' })} k="entityKey" sort={sort} onSort={onSort} className="w-[180px]" />
            {showSource && <SortHeader label={t('data.col.source', { defaultValue: 'Source' })} k="sourceName" sort={sort} onSort={onSort} className="hidden w-[200px] xl:table-cell" />}
            <th className={TH}>{t('data.col.fields', { defaultValue: 'Fields' })}</th>
            <SortHeader label={t('data.col.updated', { defaultValue: 'Updated' })} k="updatedAt" sort={sort} onSort={onSort} className="w-[130px]" />
            <th className={cn(TH, 'w-20')} aria-label={t('data.col.actions', { defaultValue: 'Actions' })} />
          </tr>
        }
      >
        {loading && rows.length === 0 ? (
          <SkeletonRows cols={cols} />
        ) : rows.length === 0 ? (
          <tr>
            <td colSpan={cols}>{empty}</td>
          </tr>
        ) : (
          rows.map((r, i) => (
            <tr key={r.id} {...rowMotion(i, fresh.has(r.id))} onClick={() => onOpen(i)} className={cn(rowMotion(i, fresh.has(r.id)).className, clickableRow(r.id === activeId))}>
              <td className="h-11 px-3" onClick={(e) => e.stopPropagation()}>
                {canDelete && <Check checked={selected.has(r.id)} onChange={() => onToggle(r.id)} label={t('data.bulk.selectNamed', { defaultValue: 'Select {{name}}', name: r.entityKey })} />}
              </td>
              <td className="max-w-0 px-3">
                <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(i) }} className="block max-w-full truncate rounded font-mono text-xs font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" dir="ltr" title={r.entityKey}>
                  {r.entityKey}
                </button>
              </td>
              {showSource && (
                <td className="hidden max-w-0 px-3 xl:table-cell">
                  <SourceCell name={r.sourceName} kind={r.sourceKind} archived={r.sourceArchived} deletedId={r.sourceId} />
                </td>
              )}
              <td className="max-w-0 px-3">
                <FieldsPreview payload={r.payload} />
              </td>
              <td className="px-3">
                <When iso={r.updatedAt || r.ts} />
              </td>
              <td className="px-2">
                <RowActions onView={() => onOpen(i)} onDelete={() => onDelete(r)} canDelete={canDelete} viewLabel={view} deleteLabel={del} />
              </td>
            </tr>
          ))
        )}
      </TableShell>
      <MobileList
        loading={loading}
        empty={empty}
        items={rows.map((r, i) => ({
          id: r.id,
          fresh: fresh.has(r.id),
          active: r.id === activeId,
          onOpen: () => onOpen(i),
          title: <span className="font-mono text-xs font-medium" dir="ltr">{r.entityKey}</span>,
          meta: <When iso={r.updatedAt || r.ts} />,
          sub: showSource ? <SourceCell name={r.sourceName} kind={r.sourceKind} archived={r.sourceArchived} /> : null,
          body: <FieldsPreview payload={r.payload} max={3} />,
        }))}
      />
    </>
  )
}

// ---- rooms & bins ------------------------------------------------------

export type BinsSortKey = 'lastSyncedAt' | 'externalCode' | 'status' | 'sourceName'

export function BinsTable({ rows, loading, queryKey, selected, onToggle, onToggleAll, onDelete, canDelete, empty, activeId, sort, onSort, onOpen, showSource }: Common<DataBin> & { sort: SortState<BinsSortKey>; onSort: (s: SortState<BinsSortKey>) => void; onOpen: (index: number) => void; showSource: boolean }) {
  const { t } = useTranslation()
  const ids = rows.map((r) => r.id)
  const fresh = useFreshIds(ids, queryKey)
  const all = ids.length > 0 && ids.every((id) => selected.has(id))
  const some = ids.some((id) => selected.has(id))
  const cols = showSource ? 7 : 6
  const code = (b: DataBin) => b.externalCode || b.sku || `#${b.id}`
  return (
    <>
      <TableShell
        busy={loading}
        header={
          <tr>
            <th className={cn(TH, 'w-10')}>{canDelete && <Check checked={all} mixed={some} onChange={() => onToggleAll(ids)} label={t('data.bulk.selectAll', { defaultValue: 'Select all rows' })} />}</th>
            <SortHeader label={t('data.col.externalCode', { defaultValue: 'Code' })} k="externalCode" sort={sort} onSort={onSort} className="w-[160px]" />
            {showSource && <SortHeader label={t('data.col.source', { defaultValue: 'Source' })} k="sourceName" sort={sort} onSort={onSort} className="hidden w-[200px] xl:table-cell" />}
            <SortHeader label={t('data.col.status', { defaultValue: 'Status' })} k="status" sort={sort} onSort={onSort} className="w-[120px]" />
            <th className={cn(TH, 'hidden xl:table-cell')}>{t('data.col.notes', { defaultValue: 'Notes' })}</th>
            <SortHeader label={t('data.col.lastSyncedAt', { defaultValue: 'Last synced' })} k="lastSyncedAt" sort={sort} onSort={onSort} className="w-[130px]" />
            <th className={cn(TH, 'w-20')} aria-label={t('data.col.actions', { defaultValue: 'Actions' })} />
          </tr>
        }
      >
        {loading && rows.length === 0 ? (
          <SkeletonRows cols={cols} />
        ) : rows.length === 0 ? (
          <tr>
            <td colSpan={cols}>{empty}</td>
          </tr>
        ) : (
          rows.map((b, i) => (
            <tr key={b.id} {...rowMotion(i, fresh.has(b.id))} onClick={() => onOpen(i)} className={cn(rowMotion(i, fresh.has(b.id)).className, clickableRow(b.id === activeId))}>
              <td className="h-11 px-3" onClick={(e) => e.stopPropagation()}>
                {canDelete && <Check checked={selected.has(b.id)} onChange={() => onToggle(b.id)} label={t('data.bulk.selectNamed', { defaultValue: 'Select {{name}}', name: code(b) })} />}
              </td>
              <td className="max-w-0 truncate px-3 font-mono text-xs font-medium" dir="ltr">{code(b)}</td>
              {showSource && (
                <td className="hidden max-w-0 px-3 xl:table-cell">
                  <SourceCell name={b.sourceName} archived={b.sourceArchived} deletedId={b.sourceId ?? undefined} />
                </td>
              )}
              <td className="px-3">{b.status ? <Badge variant={b.status === 'occupied' ? 'success' : b.status === 'reserved' ? 'warning' : 'muted'}>{b.status}</Badge> : <span className="text-muted-foreground">—</span>}</td>
              <td className="hidden max-w-0 truncate px-3 text-xs text-muted-foreground xl:table-cell">{b.notes || '—'}</td>
              <td className="px-3"><When iso={b.lastSyncedAt} /></td>
              <td className="px-2">
                <RowActions onView={() => onOpen(i)} onDelete={() => onDelete(b)} canDelete={canDelete} viewLabel={t('data.action.viewRecord', { defaultValue: 'Open record' })} deleteLabel={t('data.action.deleteRow', { defaultValue: 'Delete' })} />
              </td>
            </tr>
          ))
        )}
      </TableShell>
      <MobileList
        loading={loading}
        empty={empty}
        items={rows.map((b, i) => ({
          id: b.id,
          fresh: fresh.has(b.id),
          active: b.id === activeId,
          onOpen: () => onOpen(i),
          title: <span className="font-mono text-xs font-medium" dir="ltr">{code(b)}</span>,
          meta: <When iso={b.lastSyncedAt} />,
          sub: showSource ? <SourceCell name={b.sourceName} archived={b.sourceArchived} /> : null,
          body: b.status ? <Badge variant="muted">{b.status}</Badge> : null,
        }))}
      />
    </>
  )
}

// ---- files -------------------------------------------------------------

export type FilesSortKey = 'createdAt' | 'updatedAt' | 'filename' | 'bytesSize' | 'sourceName'

export function FilesTable({ rows, loading, queryKey, selected, onToggle, onToggleAll, onDelete, canDelete, empty, sort, onSort, showSource }: Common<DataFile> & { sort: SortState<FilesSortKey>; onSort: (s: SortState<FilesSortKey>) => void; showSource: boolean }) {
  const { t, i18n } = useTranslation()
  const ids = rows.map((r) => r.id)
  const fresh = useFreshIds(ids, queryKey)
  const all = ids.length > 0 && ids.every((id) => selected.has(id))
  const some = ids.some((id) => selected.has(id))
  const cols = showSource ? 6 : 5
  return (
    <>
      <TableShell
        busy={loading}
        header={
          <tr>
            <th className={cn(TH, 'w-10')}>{canDelete && <Check checked={all} mixed={some} onChange={() => onToggleAll(ids)} label={t('data.bulk.selectAll', { defaultValue: 'Select all rows' })} />}</th>
            <SortHeader label={t('data.col.filename', { defaultValue: 'File name' })} k="filename" sort={sort} onSort={onSort} />
            {showSource && <SortHeader label={t('data.col.source', { defaultValue: 'Source' })} k="sourceName" sort={sort} onSort={onSort} className="hidden w-[200px] xl:table-cell" />}
            <SortHeader label={t('data.col.size', { defaultValue: 'Size' })} k="bytesSize" sort={sort} onSort={onSort} className="w-[100px]" end />
            <SortHeader label={t('data.col.uploadedAt', { defaultValue: 'Uploaded' })} k="createdAt" sort={sort} onSort={onSort} className="w-[130px]" />
            <th className={cn(TH, 'w-14')} aria-label={t('data.col.actions', { defaultValue: 'Actions' })} />
          </tr>
        }
      >
        {loading && rows.length === 0 ? (
          <SkeletonRows cols={cols} />
        ) : rows.length === 0 ? (
          <tr>
            <td colSpan={cols}>{empty}</td>
          </tr>
        ) : (
          rows.map((f, i) => (
            <tr key={f.id} {...rowMotion(i, fresh.has(f.id))} className={cn(rowMotion(i, fresh.has(f.id)).className, 'group transition-colors hover:bg-muted/50')}>
              <td className="h-11 px-3">{canDelete && <Check checked={selected.has(f.id)} onChange={() => onToggle(f.id)} label={t('data.bulk.selectNamed', { defaultValue: 'Select {{name}}', name: f.filename })} />}</td>
              <td className="max-w-0 px-3">
                <span className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate font-medium" title={f.filename}>{f.filename}</span>
                </span>
              </td>
              {showSource && (
                <td className="hidden max-w-0 px-3 xl:table-cell">
                  <SourceCell name={f.sourceName} kind={f.sourceKind} archived={f.sourceArchived} deletedId={f.sourceId} />
                </td>
              )}
              <td className="px-3 text-end text-xs tabular-nums text-muted-foreground">{formatBytes(f.bytesSize, i18n.language)}</td>
              <td className="px-3"><When iso={f.createdAt} /></td>
              <td className="px-2">
                <RowActions onDelete={() => onDelete(f)} canDelete={canDelete} viewLabel="" deleteLabel={t('data.action.deleteRow', { defaultValue: 'Delete' })} />
              </td>
            </tr>
          ))
        )}
      </TableShell>
      <MobileList
        loading={loading}
        empty={empty}
        items={rows.map((f) => ({
          id: f.id,
          fresh: fresh.has(f.id),
          title: <span className="font-medium">{f.filename}</span>,
          meta: <When iso={f.createdAt} />,
          sub: showSource ? <SourceCell name={f.sourceName} kind={f.sourceKind} archived={f.sourceArchived} /> : null,
          body: <span className="text-xs text-muted-foreground">{formatBytes(f.bytesSize, i18n.language)}</span>,
        }))}
      />
    </>
  )
}

// ---- runs --------------------------------------------------------------

export type RunsSortKey = 'createdAt' | 'startedAt' | 'finishedAt' | 'status' | 'sourceName'

/** "50 imported · 3 skipped · 1 error" — the counts a person reads. */
export function RunOutcome({ stats }: { stats: unknown }) {
  const { t, i18n } = useTranslation()
  const c = runCounts(stats)
  const nf = new Intl.NumberFormat(i18n.language)
  const parts: { text: string; tone?: string }[] = []
  if (c.imported !== undefined) parts.push({ text: t('data.run.imported', { defaultValue: '{{n}} imported', n: nf.format(c.imported) }) })
  if (c.skipped) parts.push({ text: t('data.run.skipped', { defaultValue: '{{n}} skipped', n: nf.format(c.skipped) }), tone: 'text-warning' })
  if (c.errored) parts.push({ text: t('data.run.errored', { defaultValue: '{{n}} errors', n: nf.format(c.errored) }), tone: 'text-danger' })
  if (parts.length === 0 && c.read !== undefined) parts.push({ text: t('data.run.read', { defaultValue: '{{n}} read', n: nf.format(c.read) }) })
  if (parts.length === 0) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <p className="truncate text-xs">
      {parts.map((p, i) => (
        <span key={p.text} className={p.tone}>
          {i > 0 && <span className="mx-1.5 text-muted-foreground/40">·</span>}
          {p.text}
        </span>
      ))}
    </p>
  )
}

export function RunsTable({ rows, loading, queryKey, selected, onToggle, onToggleAll, onDelete, canDelete, empty, activeId, sort, onSort, onOpen, showSource }: Common<DataRun> & { sort: SortState<RunsSortKey>; onSort: (s: SortState<RunsSortKey>) => void; onOpen: (index: number) => void; showSource: boolean }) {
  const { t, i18n } = useTranslation()
  const ids = rows.map((r) => r.id)
  const fresh = useFreshIds(ids, queryKey)
  const all = ids.length > 0 && ids.every((id) => selected.has(id))
  const some = ids.some((id) => selected.has(id))
  const cols = showSource ? 7 : 6
  return (
    <>
      <TableShell
        busy={loading}
        header={
          <tr>
            <th className={cn(TH, 'w-10')}>{canDelete && <Check checked={all} mixed={some} onChange={() => onToggleAll(ids)} label={t('data.bulk.selectAll', { defaultValue: 'Select all rows' })} />}</th>
            {showSource && <SortHeader label={t('data.col.source', { defaultValue: 'Source' })} k="sourceName" sort={sort} onSort={onSort} className="w-[150px] xl:w-[200px]" />}
            <SortHeader label={t('data.col.result', { defaultValue: 'Result' })} k="status" sort={sort} onSort={onSort} className="w-[120px]" />
            <th className={TH}>{t('data.col.outcome', { defaultValue: 'Outcome' })}</th>
            <SortHeader label={t('data.col.startedAt', { defaultValue: 'Started' })} k="startedAt" sort={sort} onSort={onSort} className="w-[130px]" />
            <th className={cn(TH, 'hidden w-[90px] text-end xl:table-cell')}>{t('data.col.duration', { defaultValue: 'Duration' })}</th>
            <th className={cn(TH, 'w-20')} aria-label={t('data.col.actions', { defaultValue: 'Actions' })} />
          </tr>
        }
      >
        {loading && rows.length === 0 ? (
          <SkeletonRows cols={cols} />
        ) : rows.length === 0 ? (
          <tr>
            <td colSpan={cols}>{empty}</td>
          </tr>
        ) : (
          rows.map((r, i) => {
            const res = runResult(r.status)
            return (
              <tr key={r.id} {...rowMotion(i, fresh.has(r.id))} onClick={() => onOpen(i)} className={cn(rowMotion(i, fresh.has(r.id)).className, clickableRow(r.id === activeId))}>
                <td className="h-11 px-3" onClick={(e) => e.stopPropagation()}>{canDelete && <Check checked={selected.has(r.id)} onChange={() => onToggle(r.id)} label={t('data.bulk.selectNamed', { defaultValue: 'Select {{name}}', name: `#${r.id}` })} />}</td>
                {showSource && (
                  <td className="max-w-0 px-3">
                    <SourceCell name={r.sourceName} archived={r.sourceArchived} deletedId={r.sourceId} />
                  </td>
                )}
                <td className="px-3">
                  <Badge variant={runResultVariant(res)}>{runResultLabel(res, r.status, t)}</Badge>
                </td>
                <td className="max-w-0 px-3"><RunOutcome stats={r.stats} /></td>
                <td className="px-3"><When iso={r.startedAt ?? r.createdAt} /></td>
                <td className="hidden px-3 text-end text-xs tabular-nums text-muted-foreground xl:table-cell">{formatDuration(r.startedAt, r.finishedAt, i18n.language)}</td>
                <td className="px-2">
                  <RowActions onView={() => onOpen(i)} onDelete={() => onDelete(r)} canDelete={canDelete} viewLabel={t('data.action.viewRun', { defaultValue: 'Open run' })} deleteLabel={t('data.action.deleteRow', { defaultValue: 'Delete' })} />
                </td>
              </tr>
            )
          })
        )}
      </TableShell>
      <MobileList
        loading={loading}
        empty={empty}
        items={rows.map((r, i) => {
          const res = runResult(r.status)
          return {
            id: r.id,
            fresh: fresh.has(r.id),
            active: r.id === activeId,
            onOpen: () => onOpen(i),
            title: <Badge variant={runResultVariant(res)}>{runResultLabel(res, r.status, t)}</Badge>,
            meta: <When iso={r.startedAt ?? r.createdAt} />,
            sub: showSource ? <SourceCell name={r.sourceName} archived={r.sourceArchived} /> : null,
            body: <RunOutcome stats={r.stats} />,
          }
        })}
      />
    </>
  )
}

// ---- phone layout ------------------------------------------------------

interface MobileItem {
  id: number
  fresh: boolean
  active?: boolean
  onOpen?: () => void
  title: React.ReactNode
  meta: React.ReactNode
  sub: React.ReactNode
  body: React.ReactNode
}

function MobileList({ items, loading, empty }: { items: MobileItem[]; loading: boolean; empty: React.ReactNode }) {
  if (loading && items.length === 0) {
    return (
      <ul className="divide-y md:hidden" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="space-y-2 px-4 py-3">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-3/4" />
          </li>
        ))}
      </ul>
    )
  }
  if (items.length === 0) return <div className="md:hidden">{empty}</div>
  return (
    <ul className="divide-y md:hidden">
      {items.map((it, i) => (
        <li key={it.id} {...rowMotion(i, it.fresh)} className={cn(rowMotion(i, it.fresh).className, it.active && 'bg-primary/5')}>
          <button type="button" onClick={it.onOpen} disabled={!it.onOpen} className="w-full space-y-1 px-4 py-3 text-start transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 truncate">{it.title}</div>
              <div className="shrink-0">{it.meta}</div>
            </div>
            {it.sub && <div className="min-w-0 text-sm">{it.sub}</div>}
            {it.body && <div className="min-w-0">{it.body}</div>}
          </button>
        </li>
      ))}
    </ul>
  )
}

// ---- pager -------------------------------------------------------------

export const PAGE_SIZES = [25, 50, 100, 200] as const

export function Pager({ page, pageSize, total, onPage, onPageSize, busy }: { page: number; pageSize: number; total: number; onPage: (n: number) => void; onPageSize: (n: number) => void; busy?: boolean }) {
  const { t, i18n } = useTranslation()
  const nf = new Intl.NumberFormat(i18n.language)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  const btn = (label: string, Icon: typeof ChevronLeft, target: number, disabled: boolean) => (
    <Button variant="outline" size="icon" className="h-8 w-8" disabled={disabled || busy} onClick={() => onPage(target)} aria-label={label} title={label}>
      <Icon className="h-4 w-4 rtl:rotate-180" />
    </Button>
  )
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5 text-xs text-muted-foreground">
      <span className="tabular-nums" aria-live="polite">
        {t('data.pager.range', { defaultValue: '{{from}}–{{to}} of {{total}}', from: nf.format(from), to: nf.format(to), total: nf.format(total) })}
      </span>
      <div className="flex items-center gap-2">
        <label className="hidden items-center gap-1.5 sm:flex">
          {t('data.pager.perPage', { defaultValue: 'Rows per page' })}
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className="h-8 rounded-md border border-input bg-background px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {pages > 1 && (
          <div className="flex items-center gap-1">
            {btn(t('data.pagination.first', { defaultValue: 'First' }), ChevronsLeft, 1, page <= 1)}
            {btn(t('data.pagination.prev', { defaultValue: 'Prev' }), ChevronLeft, page - 1, page <= 1)}
            <span className="px-1.5 tabular-nums">{t('data.pager.pageOf', { defaultValue: '{{page}} of {{pages}}', page: nf.format(page), pages: nf.format(pages) })}</span>
            {btn(t('data.pagination.next', { defaultValue: 'Next' }), ChevronRight, page + 1, page >= pages)}
            {btn(t('data.pagination.last', { defaultValue: 'Last' }), ChevronsRight, pages, page >= pages)}
          </div>
        )}
      </div>
    </div>
  )
}
