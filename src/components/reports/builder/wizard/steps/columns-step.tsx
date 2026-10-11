import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Calculator,
  GripVertical,
  Loader2,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  getReportSourceSchema,
  type ReportSourceSchema,
} from '@/lib/reports-client'
import type { ComputedColumn } from '@/lib/reports/computed-columns'
import { useWizard } from '../wizard-state'
import { CustomColumnsStep } from './custom-columns-step'
import { useDragDropList } from '../use-drag-drop-list'

const FACILITY_HIDDEN_BY_DEFAULT = new Set(['id', 'facility_id', 'floor_id', 'created_at', 'updated_at', 'lng', 'lat'])

/**
 * Columns step — single home for both source-picked and computed
 * columns. The ordered list interleaves both types so users see one
 * timeline they can reorder freely; the custom-columns editor is
 * embedded below for authoring expressions.
 */
export function ColumnsStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()
  const sourceId = draft.sourceRef?.id
  const [loaded, setLoaded] = useState<{
    key: number
    schema: ReportSourceSchema | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    if (sourceId === undefined) return
    let cancelled = false
    getReportSourceSchema(sourceId)
      .then((s) => {
        if (!cancelled) {
          setLoaded({ key: sourceId, schema: s, error: null })
          // If the wizard hasn't chosen columns yet, pre-select every
          // field so a brand-new report shows something out of the gate.
          // Seed each column's label from the source's field label so the
          // table reads "Product" rather than "product_name" out of the box.
          if (draft.columns.length === 0 && s.fields.length > 0) {
            const columnConfig = { ...draft.columnConfig }
            for (const f of s.fields) {
              if (f.label && f.label !== f.key && !columnConfig[f.key]?.label) {
                columnConfig[f.key] = { ...columnConfig[f.key], label: f.label }
              }
            }
            // Built-in facility sources: skip the internal ids, audit
            // timestamps and coordinates — they're one click away.
            const keys = s.fields.map((f) => f.key).filter((k) => s.kind !== 'facility' || !FACILITY_HIDDEN_BY_DEFAULT.has(k))
            update({ columns: keys, columnConfig })
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setLoaded({ key: sourceId, schema: null, error: (err as Error).message })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId])

  // Results are keyed by source id, so a stale fetch never shows as
  // current and "loading" is simply "no result for this source yet".
  const current = sourceId !== undefined && loaded?.key === sourceId ? loaded : null
  const loading = sourceId !== undefined && !current
  const schema = current?.schema ?? null
  const error = current?.error ?? null

  // ─── Hook-safe derivations. All hooks BELOW must run every render
  // regardless of loading / error state — early returns come AFTER
  // the hook block so React's hook call order stays stable across
  // renders (Rules of Hooks).
  const computedByName = new Map(draft.computedColumns.map((c) => c.name).map((n) => [n, true]))
  const selected = new Set(draft.columns)
  const visibleColumns: string[] = [
    ...draft.columns,
    ...draft.computedColumns
      .map((c) => c.name)
      .filter((n) => n && !selected.has(n)),
  ]

  /** Apply a from → to reorder to the visible column list, then
   *  split it back into `columns` (source) and `computedColumns`
   *  (definitions), preserving the new mixed order. */
  const reorderVisible = (from: number, to: number) => {
    if (from === to) return
    const next = [...visibleColumns]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    const nextSource = next.filter((n) => !computedByName.has(n))
    const nextComputed: ComputedColumn[] = []
    for (const name of next) {
      const cc = draft.computedColumns.find((c) => c.name === name)
      if (cc) nextComputed.push(cc)
    }
    for (const cc of draft.computedColumns) {
      if (!nextComputed.some((x) => x.name === cc.name)) nextComputed.push(cc)
    }
    update({ columns: nextSource, computedColumns: nextComputed })
  }

  // HTML5 drag reorder — hook must run every render for Rules of
  // Hooks compliance, even in loading/error states.
  const drag = useDragDropList<string>({
    items: visibleColumns,
    getId: (n) => n,
    kind: 'widget',
    source: 'canvas',
    onReorder: reorderVisible,
  })

  // ─── Early returns — safe now that all hooks above have fired.
  if (!draft.sourceRef) {
    return (
      <div className="text-sm text-muted-foreground italic py-6 text-center border-2 border-dashed border-border rounded-md">
        {t('reports.wizard.columns.needSource', {
          defaultValue: 'Pick a data source in the previous step first.',
        })}
      </div>
    )
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('reports.wizard.columns.loading', { defaultValue: 'Loading source schema…' })}
      </div>
    )
  }
  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>{error}</span>
      </div>
    )
  }
  if (!schema || schema.fields.length === 0) {
    return (
      <div className="text-sm text-muted-foreground italic py-6 text-center border-2 border-dashed border-border rounded-md">
        {t('reports.wizard.columns.empty', {
          defaultValue: 'This source has no fields yet — push data or add field definitions first.',
        })}
      </div>
    )
  }

  // Non-hook handlers used only in the render output below.
  const toggleSource = (key: string) => {
    if (selected.has(key)) update({ columns: draft.columns.filter((c) => c !== key) })
    else update({ columns: [...draft.columns, key] })
  }

  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir
    if (target < 0 || target >= visibleColumns.length) return
    reorderVisible(idx, target)
  }

  const setLabel = (col: string, label: string) => {
    update({
      columnConfig: {
        ...draft.columnConfig,
        [col]: { ...(draft.columnConfig[col] ?? {}), label: label || undefined },
      },
    })
  }

  const removeComputed = (name: string) => {
    update({
      computedColumns: draft.computedColumns.filter((c) => c.name !== name),
      columns: draft.columns.filter((c) => c !== name),
    })
  }

  return (
    <div className="space-y-6">
      <div className="text-xs text-muted-foreground">
        {t('reports.wizard.columns.selected', {
          selected: visibleColumns.length,
          total: schema.fields.length + draft.computedColumns.length,
          defaultValue: '{{selected}} of {{total}} selected',
        })}
      </div>

      {/* Ordered list — source + computed intermixed */}
      {visibleColumns.length > 0 && (
        <div className="rounded-md border border-border overflow-hidden">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40 border-b border-border">
            {t('reports.wizard.columns.orderTitle', { defaultValue: 'Column order + labels' })}
          </div>
          <ul className="divide-y divide-border">
            {visibleColumns.map((col, idx) => {
              const isComputed = computedByName.has(col)
              const cc = isComputed ? draft.computedColumns.find((c) => c.name === col) : null
              const field = isComputed ? null : schema.fields.find((f) => f.key === col)
              if (!isComputed && !field) return null
              const label = draft.columnConfig[col]?.label ?? ''
              const isDragging = drag.dragIndex === idx
              const showTop = drag.overIndex === idx && drag.dropBefore && drag.dragIndex !== idx
              const showBottom =
                drag.overIndex === idx && !drag.dropBefore && drag.dragIndex !== idx
              return (
                <li
                  key={col}
                  {...drag.rowProps(idx)}
                  className={cn(
                    'relative flex items-center gap-2 px-2 py-1.5 transition-opacity',
                    isDragging && 'opacity-40',
                  )}
                >
                  {showTop && (
                    <span
                      aria-hidden
                      className="absolute inset-x-2 -top-px h-0.5 bg-primary rounded-full pointer-events-none"
                    />
                  )}
                  {showBottom && (
                    <span
                      aria-hidden
                      className="absolute inset-x-2 -bottom-px h-0.5 bg-primary rounded-full pointer-events-none"
                    />
                  )}
                  <GripVertical
                    className="w-3.5 h-3.5 text-muted-foreground shrink-0 cursor-grab active:cursor-grabbing"
                    aria-hidden
                  />
                  <div className="w-32 flex items-center gap-1 min-w-0">
                    {isComputed && (
                      <Calculator
                        className="w-3 h-3 text-primary shrink-0"
                        aria-label="computed"
                      />
                    )}
                    <span
                      className="text-xs text-muted-foreground truncate"
                      title={col}
                    >
                      {col}
                    </span>
                  </div>
                  <Input
                    value={label}
                    onChange={(e) => setLabel(col, e.target.value)}
                    placeholder={
                      isComputed
                        ? cc?.name ?? col
                        : field?.label || field?.key || col
                    }
                    className="h-7 text-xs flex-1"
                  />
                  <span className="text-[10px] text-muted-foreground uppercase w-16 tabular-nums text-end">
                    {isComputed ? cc?.type ?? 'computed' : field?.type}
                  </span>
                  <div className="flex gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      disabled={idx === 0}
                      onClick={() => move(idx, -1)}
                      aria-label={t('reports.wizard.columns.moveUp', { defaultValue: 'Move up' })}
                    >
                      <ArrowUp className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      disabled={idx === visibleColumns.length - 1}
                      onClick={() => move(idx, 1)}
                      aria-label={t('reports.wizard.columns.moveDown', { defaultValue: 'Move down' })}
                    >
                      <ArrowDown className="w-3 h-3" />
                    </Button>
                    {isComputed && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        onClick={() => removeComputed(col)}
                        aria-label={t('reports.wizard.columns.removeComputed', {
                          defaultValue: 'Remove computed column',
                        })}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Source field picker */}
      <div className="rounded-md border border-border">
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40 border-b border-border">
          {t('reports.wizard.columns.allFields', { defaultValue: 'Available source fields' })}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1 p-2">
          {schema.fields.map((f) => {
            const isSelected = selected.has(f.key)
            return (
              <label
                key={f.key}
                className={cn(
                  'flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer transition-colors',
                  isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-accent',
                )}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSource(f.key)}
                  className="w-3.5 h-3.5"
                />
                <span className="truncate flex-1">{f.label || f.key}</span>
                <span className="text-[10px] text-muted-foreground uppercase">{f.type}</span>
              </label>
            )
          })}
        </div>
      </div>

      {/* Computed / custom columns — the full authoring UI embedded
          here so users don't have to jump between steps. */}
      <div className="rounded-md border border-primary/30 bg-primary/[0.02]">
        <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground bg-primary/5 border-b border-primary/20 flex items-center gap-1.5">
          <Calculator className="w-3 h-3 text-primary" />
          {t('reports.wizard.columns.computedTitle', { defaultValue: 'Computed columns' })}
        </div>
        <div className="p-3">
          <CustomColumnsStep />
        </div>
      </div>
    </div>
  )
}
