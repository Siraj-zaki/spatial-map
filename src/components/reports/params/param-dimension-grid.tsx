import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ParamInputProps } from './types'
import type { Predicate, PredicateColumn } from '@/lib/reports/predicate-types'

/**
 * Rich filter panel — one tile per column, each tile lists the
 * distinct values as toggle chips. Emits a typed Predicate the
 * backend renders via `queryx.RenderColumnPredicate` (no SQL text
 * crosses the wire — this is the ONLY predicate-emit slot in the
 * whole system).
 *
 * The `optionsResolved` prop is grouped: entries with a `column`
 * prefix in the label are bucketed accordingly. Callers wire a
 * multi-source fetcher upstream to populate.
 */
export function ParamDimensionGrid({
  param,
  value,
  userSet,
  onChange,
  onReset,
  optionsResolved,
  optionsLoading,
  optionsError,
  compact,
}: ParamInputProps<Predicate>) {
  const { t } = useTranslation()
  const columns = param.input.columns ?? []

  if (optionsLoading) {
    return <span className="text-xs text-muted-foreground italic">
      {t('reports.params.loading', { defaultValue: 'Loading…' })}
    </span>
  }
  if (optionsError) {
    return <span className="text-xs text-destructive">{optionsError}</span>
  }
  if (columns.length === 0) {
    return <span className="text-xs text-muted-foreground italic">
      {t('reports.params.dimensionGrid.noColumns', { defaultValue: 'No columns configured' })}
    </span>
  }

  // Bucket the resolved options per column. Options prefixed with
  // "<column>::" belong to that column; anything unprefixed goes to
  // the first column as a safety fallback.
  const byColumn: Record<string, Array<{ value: unknown; label: string }>> = {}
  for (const col of columns) byColumn[col] = []
  for (const opt of optionsResolved ?? []) {
    const colonIdx = String(opt.label).indexOf('::')
    if (colonIdx > 0) {
      const col = String(opt.label).slice(0, colonIdx)
      const rest = String(opt.label).slice(colonIdx + 2)
      if (byColumn[col]) byColumn[col].push({ value: opt.value, label: rest })
      continue
    }
    if (columns[0] && byColumn[columns[0]]) byColumn[columns[0]].push(opt)
  }

  // Existing selection per column, if any.
  const currentByCol: Record<string, Set<string>> = {}
  for (const col of columns) currentByCol[col] = new Set()
  for (const col of value?.columns ?? []) {
    if (!currentByCol[col.field]) currentByCol[col.field] = new Set()
    for (const v of col.values ?? []) {
      // Values arrive as raw wire-format items — stringify for the
      // set-membership check (values are compared by string identity).
      currentByCol[col.field].add(String(v))
    }
  }

  const toggleValue = (colName: string, rawValue: unknown) => {
    const strVal = String(rawValue)
    const nextSet = new Set(currentByCol[colName])
    if (nextSet.has(strVal)) nextSet.delete(strVal)
    else nextSet.add(strVal)
    // Rebuild the whole predicate — cheap since typical N is tiny.
    // Each value ships as its raw form; JSON serialisation of the
    // outer object handles encoding once, so the backend's
    // `[]json.RawMessage` gets a single-encoded scalar per entry.
    const nextCols: PredicateColumn[] = []
    for (const col of columns) {
      const set = col === colName ? nextSet : currentByCol[col]
      if (set.size === 0) continue
      nextCols.push({
        field: col,
        values: [...set] as unknown as string[],
      })
    }
    onChange({ combine: 'AND', columns: nextCols })
  }

  return (
    <div className={cn('flex flex-col gap-3', compact && 'w-72')}>
      {columns.map((col) => (
        <div key={col} className="rounded border border-border p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
            {col}
          </div>
          <div className="flex flex-wrap gap-1">
            {(byColumn[col] ?? []).length === 0 && (
              <span className="text-xs text-muted-foreground italic">
                {t('reports.params.dimensionGrid.emptyColumn', { defaultValue: 'No values' })}
              </span>
            )}
            {(byColumn[col] ?? []).map((opt, i) => {
              const active = currentByCol[col].has(String(opt.value))
              return (
                <button
                  key={`${opt.value}-${i}`}
                  type="button"
                  onClick={() => toggleValue(col, opt.value)}
                  className={cn(
                    'text-xs px-2 py-0.5 rounded transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-accent',
                  )}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {userSet && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 self-end"
          onClick={onReset}
        >
          <X className="h-3.5 w-3.5 me-1" />
          {t('reports.params.reset', { defaultValue: 'Reset' })}
        </Button>
      )}
    </div>
  )
}
