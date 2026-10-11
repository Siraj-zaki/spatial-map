import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronLeft, ChevronRight, Loader2, MapPinned, Pencil, Save, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { humanizeColumn } from '@/lib/reports/humanize-column'
import {
  bulkPatchAuthedRows,
  patchAuthedRow,
} from '@/lib/table-rows-authed-client'
import {
  type ReportFieldType,
  type ReportWidget,
  type RunReportResult,
} from '@/lib/reports-client'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { useSourceSchema } from '@/components/reports/builder/wizard/use-source-schema'
import {
  deleteFacilityRow,
  facilityEditorHref,
  facilityFieldLabel,
  isFacilityRowDeletable,
  writeFacilityRow,
} from '@/lib/reports/facility-sources'
import { CellRenderer, type CellColumnConfig } from './cell-renderer'

/** Editable-table widget bindings — mirrors DataTable's shape plus a
 *  sourceId + which columns are editable. sourceId is the
 *  `data_sources.id` of a table-kind source, since row edits only
 *  make sense against a table (not a REST feed or a file). */
interface EditableTableBindings {
  sourceId: number
  columns?: string[]
  columnConfig?: Record<string, CellColumnConfig>
  editableColumns?: string[]
  bulkEditable?: boolean
  /** Optional column that carries the row identity. Defaults to
   *  `entity_key` — which is what the reports executor emits for
   *  table-source queries. */
  keyColumn?: string
  pageSize?: number
}

/** Editable field's runtime form value. Keyed by column name.
 *  Everything held as string; coerced on save based on the underlying
 *  column type. */
type FormValues = Record<string, string | number | boolean | null>

/**
 * Editable table widget — data grid where a subset of columns can be
 * inline-edited via a slide-in form. Single-row edits use PATCH
 * /tables/{id}/rows/{key}; bulk edits use PATCH /tables/{id}/rows/bulk
 * with a per-row patch payload.
 *
 * Row identity comes from the `keyColumn` binding (defaults to
 * `entity_key`, which the reports executor emits for table sources).
 * If the key column is missing from the result, the widget renders
 * read-only and shows a hint — a sanity check that also prevents a
 * PATCH-with-blank-key round-trip.
 */
export function EditableTableWidget({
  widget,
  result,
  locale,
}: {
  widget: ReportWidget
  result: RunReportResult
  locale: string
}) {
  const { t } = useTranslation()
  const b = (widget.bindings ?? {}) as EditableTableBindings
  const keyColumn = b.keyColumn ?? 'entity_key'

  const declared = b.columns && b.columns.length > 0 ? b.columns : result.columns.map((c) => c.name)
  const editableSet = useMemo(() => new Set(b.editableColumns ?? []), [b.editableColumns])
  const columnIdx = useMemo(
    () => new Map(result.columns.map((c, i) => [c.name, i])),
    [result.columns],
  )
  const columnTypes = useMemo(() => {
    const out: Record<string, ReportFieldType> = {}
    for (const c of result.columns) out[c.name] = c.type
    return out
  }, [result.columns])
  const keyIdx = columnIdx.get(keyColumn)

  // Local row buffer — starts from the fetched rows and gets patched
  // in place on successful saves so the grid reflects edits without
  // waiting for a re-run.
  const [rows, setRows] = useState<unknown[][]>(result.rows)
  // A fresh result replaces local edits (adjusted during render).
  const [syncedRows, setSyncedRows] = useState(result.rows)
  if (syncedRows !== result.rows) {
    setSyncedRows(result.rows)
    setRows(result.rows)
  }

  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<'row' | 'bulk' | null>(null)
  const [editRowKey, setEditRowKey] = useState<string | null>(null)
  const [formValues, setFormValues] = useState<FormValues>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const pageSize = Math.max(5, Math.min(200, b.pageSize ?? 20))
  const canEdit = editableSet.size > 0 && keyIdx !== undefined && b.sourceId > 0

  // Built-in facility source: rows are shapes (entity_key "markers:57"),
  // written through the shape API instead of /tables/:id/rows, with
  // delete + "Open in editor" row actions.
  const { schema } = useSourceSchema(b.sourceId)
  const facility = schema?.kind === 'facility'
  const facilityIdx = columnIdx.get('facility_id')
  const nameIdx = columnIdx.get('name')
  const showSelect = (b.bulkEditable && canEdit) || (facility && keyIdx !== undefined)
  const showActions = canEdit || (facility && keyIdx !== undefined)
  const [deleteKeys, setDeleteKeys] = useState<string[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const columnLabel = (name: string) =>
    b.columnConfig?.[name]?.label ?? (facility ? facilityFieldLabel(name, humanizeColumn(name)) : humanizeColumn(name))

  const sorted = useMemo(() => {
    if (!sortCol) return rows
    const idx = columnIdx.get(sortCol)
    if (idx === undefined) return rows
    const copy = [...rows]
    copy.sort((a, b) => {
      const av = a[idx]
      const bv = b[idx]
      if (av === bv) return 0
      if (av === null || av === undefined) return 1
      if (bv === null || bv === undefined) return -1
      const dir = sortDir === 'asc' ? 1 : -1
      return av < bv ? -dir : dir
    })
    return copy
  }, [rows, sortCol, sortDir, columnIdx])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const pageRows = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize)

  const toggleSort = (name: string) => {
    if (sortCol === name) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortCol(name)
      setSortDir('asc')
    }
  }

  const rowKey = (row: unknown[]): string | null => {
    if (keyIdx === undefined) return null
    const raw = row[keyIdx]
    return raw === null || raw === undefined ? null : String(raw)
  }

  const openRowEditor = (row: unknown[]) => {
    const key = rowKey(row)
    if (!key) return
    const initial: FormValues = {}
    for (const col of editableSet) {
      const idx = columnIdx.get(col)
      initial[col] = idx !== undefined ? coerceForForm(row[idx]) : ''
    }
    setEditRowKey(key)
    setFormValues(initial)
    setSaveError(null)
    setEditing('row')
  }

  const openBulkEditor = () => {
    if (selected.size === 0) return
    const initial: FormValues = {}
    for (const col of editableSet) initial[col] = ''
    setFormValues(initial)
    setSaveError(null)
    setEditing('bulk')
  }

  const closeEditor = () => {
    setEditing(null)
    setEditRowKey(null)
    setFormValues({})
    setSaveError(null)
  }

  const toggleSelected = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const submitSingle = async () => {
    if (!editRowKey || !b.sourceId) return
    setSaving(true)
    setSaveError(null)
    try {
      const patch = coercePatch(formValues, columnTypes)
      if (facility) await writeFacilityRow(editRowKey, patch)
      else await patchAuthedRow(b.sourceId, editRowKey, patch)
      applyPatchLocal([editRowKey], patch)
      closeEditor()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const submitBulk = async () => {
    if (selected.size === 0 || !b.sourceId) return
    setSaving(true)
    setSaveError(null)
    try {
      const patch = coercePatch(formValues, columnTypes)
      // Only send the fields the user actually set — a blank input in
      // the form means "leave this column alone" for the bulk case.
      const nonBlank: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(patch)) {
        if (v !== '' && v !== undefined) nonBlank[k] = v
      }
      if (Object.keys(nonBlank).length === 0) {
        setSaveError(t('reports.widgets.editableTable.noFields', { defaultValue: 'Fill in at least one field to bulk-edit.' }))
        setSaving(false)
        return
      }
      const keys = [...selected]
      if (facility) {
        const results = await Promise.allSettled(keys.map((k) => writeFacilityRow(k, nonBlank)))
        const done = keys.filter((_, i) => results[i].status === 'fulfilled')
        applyPatchLocal(done, nonBlank)
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
        if (failed) {
          setSelected(new Set(keys.filter((k) => !done.includes(k))))
          throw failed.reason
        }
      } else {
        await bulkPatchAuthedRows(b.sourceId, {
          rows: keys.map((entityKey) => ({ entityKey, patch: nonBlank })),
        })
        applyPatchLocal(keys, nonBlank)
      }
      setSelected(new Set())
      closeEditor()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const applyPatchLocal = (keys: string[], patch: Record<string, unknown>) => {
    const keySet = new Set(keys)
    setRows((prev) =>
      prev.map((row) => {
        const k = rowKey(row)
        if (!k || !keySet.has(k)) return row
        const next = [...row]
        for (const [col, value] of Object.entries(patch)) {
          const idx = columnIdx.get(col)
          if (idx !== undefined) next[idx] = value
        }
        return next
      }),
    )
  }

  const confirmDelete = async () => {
    if (!deleteKeys) return
    setDeleting(true)
    setDeleteError(null)
    const results = await Promise.allSettled(deleteKeys.map((k) => deleteFacilityRow(k)))
    const gone = new Set(deleteKeys.filter((_, i) => results[i].status === 'fulfilled'))
    setRows((prev) => prev.filter((row) => {
      const k = rowKey(row)
      return !k || !gone.has(k)
    }))
    setSelected((prev) => new Set([...prev].filter((k) => !gone.has(k))))
    setDeleting(false)
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) {
      setDeleteKeys(deleteKeys.filter((k) => !gone.has(k)))
      setDeleteError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason))
    } else {
      setDeleteKeys(null)
    }
  }

  const rowName = (key: string): string => {
    if (nameIdx === undefined || keyIdx === undefined) return key
    const row = rows.find((r) => rowKey(r) === key)
    const v = row?.[nameIdx]
    return v === null || v === undefined || v === '' ? key : String(v)
  }
  const deletableSelected = [...selected].filter(isFacilityRowDeletable)

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 p-2 border-b border-border">
        {widget.title && <div className="text-sm font-medium">{widget.title}</div>}
        <div className="ms-auto flex items-center gap-2">
          {facility && deletableSelected.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-danger hover:text-danger"
              onClick={() => {
                setDeleteError(null)
                setDeleteKeys(deletableSelected)
              }}
            >
              <Trash2 className="w-3 h-3 me-1.5" />
              {t('reports.facility.deleteSelected', {
                count: deletableSelected.length,
                defaultValue: 'Delete {{count}} selected',
              })}
            </Button>
          )}
          {b.bulkEditable && canEdit && selected.size > 0 && (
            <Button size="sm" className="h-7" onClick={openBulkEditor}>
              <Pencil className="w-3 h-3 me-1.5" />
              {t('reports.widgets.editableTable.editSelected', {
                count: selected.size,
                defaultValue: 'Edit {{count}} selected',
              })}
            </Button>
          )}
          {!canEdit && !facility && (
            <span className="text-[10px] text-muted-foreground italic">
              {editableSet.size === 0
                ? t('reports.widgets.editableTable.noEditableColumns', {
                    defaultValue: 'Read-only — no editable columns configured',
                  })
                : t('reports.widgets.editableTable.missingKey', {
                    defaultValue: 'Read-only — missing row key column',
                  })}
            </span>
          )}
        </div>
      </div>

      {/* Sideways scroll only — the reading canvas grows to the page of rows. */}
      <div className="flex-1 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              {showSelect && (
                <th className="w-8 px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={pageRows.length > 0 && pageRows.every((r) => {
                      const k = rowKey(r)
                      return k !== null && selected.has(k)
                    })}
                    onChange={(e) => {
                      const check = e.target.checked
                      const keys = pageRows.map(rowKey).filter((k): k is string => k !== null)
                      setSelected((prev) => {
                        const next = new Set(prev)
                        for (const k of keys) {
                          if (check) next.add(k)
                          else next.delete(k)
                        }
                        return next
                      })
                    }}
                    className="w-3.5 h-3.5"
                    aria-label={t('reports.facility.selectPage', { defaultValue: 'Select all rows on this page' })}
                  />
                </th>
              )}
              {declared.map((name) => {
                const cfg = b.columnConfig?.[name]
                return (
                  <th
                    key={name}
                    onClick={() => toggleSort(name)}
                    className={cn(
                      'cursor-pointer select-none whitespace-nowrap px-3 py-2 text-start text-xs font-medium text-muted-foreground hover:text-foreground',
                      cfg?.align === 'right' && 'text-end',
                      cfg?.align === 'center' && 'text-center',
                    )}
                  >
                    <span className="inline-flex items-center gap-1">
                      {columnLabel(name)}
                      {editableSet.has(name) && (
                        <Pencil className="w-2.5 h-2.5 opacity-50" />
                      )}
                      {sortCol === name && (
                        <ChevronDown className={cn('w-3 h-3 transition-transform', sortDir === 'asc' && 'rotate-180')} />
                      )}
                    </span>
                  </th>
                )
              })}
              {showActions && <th className={facility ? 'w-20' : 'w-8'} />}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr>
                <td
                  colSpan={declared.length + (showSelect ? 1 : 0) + (showActions ? 1 : 0)}
                  className="p-6 text-center text-muted-foreground italic"
                >
                  {t('reports.widgets.editableTable.emptyState', { defaultValue: 'No rows to edit' })}
                </td>
              </tr>
            )}
            {pageRows.map((row, ri) => {
              const k = rowKey(row)
              const isSelected = k !== null && selected.has(k)
              return (
                <tr
                  key={k ?? ri}
                  className={cn(
                    'border-t border-border/60 hover:bg-accent/30',
                    isSelected && 'bg-primary/5',
                  )}
                >
                  {showSelect && (
                    <td className="px-2 py-1">
                      {k && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelected(k)}
                          className="w-3.5 h-3.5"
                          aria-label={t('reports.facility.selectRow', { name: rowName(k), defaultValue: 'Select {{name}}' })}
                        />
                      )}
                    </td>
                  )}
                  {declared.map((name) => {
                    const idx = columnIdx.get(name)
                    const cfg = b.columnConfig?.[name]
                    const val = idx !== undefined ? row[idx] : undefined
                    const displayType = idx !== undefined ? result.columns[idx].type : 'text'
                    const maxW = cfg?.maxWidthPx ?? 240
                    return (
                      <td
                        key={name}
                        style={{ maxWidth: maxW }}
                        className={cn(
                          'px-2 py-1 tabular-nums whitespace-nowrap overflow-hidden',
                          cfg?.align === 'right' && 'text-right',
                          cfg?.align === 'center' && 'text-center',
                        )}
                      >
                        <CellRenderer
                          value={val}
                          fieldType={displayType}
                          config={cfg}
                          locale={locale}
                        />
                      </td>
                    )
                  })}
                  {showActions && (
                    <td className="px-1 py-0.5">
                      <div className="flex items-center justify-end gap-0.5">
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => openRowEditor(row)}
                            aria-label={t('reports.widgets.editableTable.editRow', { defaultValue: 'Edit row' })}
                            title={t('reports.widgets.editableTable.editRow', { defaultValue: 'Edit row' })}
                          >
                            <Pencil className="w-3 h-3" />
                          </Button>
                        )}
                        {facility && k && (() => {
                          const href = facilityEditorHref(k, facilityIdx !== undefined ? Number(row[facilityIdx]) : null)
                          return href ? (
                            <Button asChild variant="ghost" size="sm" className="h-6 w-6 p-0">
                              <a
                                href={href}
                                aria-label={t('reports.facility.openInEditor', { name: rowName(k), defaultValue: 'Open {{name}} in the editor' })}
                                title={t('reports.facility.openInEditorShort', { defaultValue: 'Open in editor' })}
                              >
                                <MapPinned className="w-3 h-3" />
                              </a>
                            </Button>
                          ) : null
                        })()}
                        {facility && k && isFacilityRowDeletable(k) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-muted-foreground hover:text-danger"
                            onClick={() => {
                              setDeleteError(null)
                              setDeleteKeys([k])
                            }}
                            aria-label={t('reports.facility.deleteRow', { name: rowName(k), defaultValue: 'Delete {{name}}' })}
                            title={t('reports.facility.deleteRowShort', { defaultValue: 'Delete' })}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 px-2 py-1.5 border-t border-border text-xs text-muted-foreground">
        <span>
          {t('reports.widgets.dataTable.rowSummary', {
            from: sorted.length === 0 ? 0 : safePage * pageSize + 1,
            to: Math.min(sorted.length, (safePage + 1) * pageSize),
            total: sorted.length,
            defaultValue: '{{from}}–{{to}} of {{total}}',
          })}
        </span>
        <div className="ms-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
          >
            <ChevronLeft className="w-3 h-3" />
          </Button>
          <span>
            {safePage + 1} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={safePage >= totalPages - 1}
          >
            <ChevronRight className="w-3 h-3" />
          </Button>
        </div>
      </div>

      <Sheet open={editing !== null} onOpenChange={(open) => !open && closeEditor()}>
        <SheetContent side="end" className="w-full sm:max-w-md flex flex-col">
          <SheetHeader>
            <SheetTitle>
              {editing === 'bulk'
                ? t('reports.widgets.editableTable.bulkTitle', {
                    count: selected.size,
                    defaultValue: 'Edit {{count}} rows',
                  })
                : facility && editRowKey
                  ? t('reports.facility.editTitle', { name: rowName(editRowKey), defaultValue: 'Edit "{{name}}"' })
                  : t('reports.widgets.editableTable.rowTitle', {
                      key: editRowKey ?? '',
                      defaultValue: 'Edit row {{key}}',
                    })}
            </SheetTitle>
            <SheetDescription>
              {editing === 'bulk'
                ? t('reports.widgets.editableTable.bulkDescription', {
                    defaultValue: 'Blank fields are left unchanged. Only filled fields are written to every selected row.',
                  })
                : t('reports.widgets.editableTable.rowDescription', {
                    defaultValue: 'Change any editable field and save. The grid updates immediately once the server confirms.',
                  })}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-auto px-4 py-4 space-y-4">
            {[...editableSet].map((col) => {
              const type = columnTypes[col] ?? 'text'
              const label = facility ? columnLabel(col) : (b.columnConfig?.[col]?.label ?? col)
              const value = formValues[col]
              return (
                <div key={col} className="space-y-1.5">
                  <Label className="text-xs">{label}</Label>
                  <FieldEditor
                    type={type}
                    value={value}
                    onChange={(v) => setFormValues((prev) => ({ ...prev, [col]: v }))}
                  />
                </div>
              )
            })}
            {saveError && (
              <div className="text-xs text-danger border border-danger/40 bg-danger/5 rounded-md px-2 py-1.5">
                {saveError}
              </div>
            )}
          </div>

          <SheetFooter className="gap-2">
            <Button variant="ghost" onClick={closeEditor} disabled={saving}>
              <X className="w-3.5 h-3.5 me-1.5" />
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button onClick={editing === 'bulk' ? submitBulk : submitSingle} disabled={saving}>
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5 me-1.5" />
              )}
              {t('reports.widgets.editableTable.save', { defaultValue: 'Save' })}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={deleteKeys !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteKeys(null)
            setDeleteError(null)
          }
        }}
        title={
          deleteKeys && deleteKeys.length === 1
            ? t('reports.facility.deleteOneTitle', { name: rowName(deleteKeys[0]), defaultValue: 'Delete "{{name}}"?' })
            : t('reports.facility.deleteManyTitle', { count: deleteKeys?.length ?? 0, defaultValue: 'Delete {{count}} items?' })
        }
        description={t('reports.facility.deleteDescription', {
          defaultValue: 'They are removed from the map for everyone, the same as deleting them in the editor. This can\'t be undone.',
        })}
        confirmLabel={t('reports.facility.deleteConfirm', { defaultValue: 'Delete' })}
        onConfirm={() => void confirmDelete()}
        busy={deleting}
        error={deleteError}
      />
    </div>
  )
}

/** Per-type input in the edit form. Numeric fields use a number input
 *  so mobile keyboards behave; booleans use the Switch primitive; the
 *  rest fall through to a plain text Input. */
function FieldEditor({
  type,
  value,
  onChange,
}: {
  type: ReportFieldType
  value: string | number | boolean | null
  onChange: (next: string | number | boolean) => void
}) {
  if (type === 'boolean') {
    return (
      <Switch
        checked={value === true || value === 'true'}
        onCheckedChange={(v) => onChange(Boolean(v))}
      />
    )
  }
  if (type === 'number') {
    return (
      <Input
        type="number"
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-xs"
      />
    )
  }
  if (type === 'date' || type === 'datetime') {
    return (
      <Input
        type={type === 'date' ? 'date' : 'datetime-local'}
        value={value === null || value === undefined ? '' : String(value).slice(0, type === 'date' ? 10 : 16)}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-xs"
      />
    )
  }
  return (
    <Input
      type="text"
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 text-xs"
    />
  )
}

/** Turn a raw column value into something a text-based form input can
 *  display without losing the type information (which we recover on
 *  submit via [coercePatch]). */
function coerceForForm(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  return String(value)
}

/** Convert the form buffer to a JSON patch the backend can apply,
 *  coercing strings back into numbers / booleans based on the
 *  originating column type so a number column doesn't round-trip as
 *  a stringified digit. */
function coercePatch(
  form: FormValues,
  types: Record<string, ReportFieldType>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [col, raw] of Object.entries(form)) {
    const type = types[col] ?? 'text'
    if (raw === '' || raw === null || raw === undefined) {
      out[col] = raw
      continue
    }
    if (type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(raw)
      out[col] = Number.isFinite(n) ? n : raw
    } else if (type === 'boolean') {
      out[col] = raw === true || raw === 'true'
    } else {
      out[col] = raw
    }
  }
  return out
}
