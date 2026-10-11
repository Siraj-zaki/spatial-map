/**
 * Viewer filters step — one-click filters for the report's filter bar.
 * Pick a suggested field (Floor, Area, Type, a name search, a date
 * range…) and it's done: the right input for the field's type, options
 * from their own query, and the filter narrows every query that reads a
 * source with that field. Compiled on save by
 * src/lib/reports/viewer-filters.ts.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown,
  ArrowUp,
  CalendarRange,
  ChevronDown,
  ListChecks,
  Loader2,
  Plus,
  Rows3,
  Search,
  SlidersHorizontal,
  ToggleRight,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { ReportFieldType, ReportSourceSchema } from '@/lib/reports-client'
import type { ViewerFilter, ViewerFilterKind } from '@/lib/reports/v2-types'
import { kindsForType, suggestViewerFilters, viewerFilterId } from '@/lib/reports/viewer-filters'
import { useWizard } from '../wizard-state'
import { useSourceSchemas } from '../use-source-schema'
import { readExplorerBindings } from '@/lib/reports/explorer-spec'

const KIND_ICON: Record<ViewerFilterKind, LucideIcon> = {
  dropdown: ChevronDown,
  multi: ListChecks,
  buttons: Rows3,
  search: Search,
  dateRange: CalendarRange,
  yesNo: ToggleRight,
}

const KIND_LABEL: Record<ViewerFilterKind, string> = {
  dropdown: 'Dropdown',
  multi: 'Pick several',
  buttons: 'Buttons',
  search: 'Search box',
  dateRange: 'Date range',
  yesNo: 'Yes / No',
}

const MAX_SUGGESTIONS = 8

export function ViewerFiltersStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()
  const filters = draft.viewerFilters

  // Every source the report reads: its own, extra queries', widgets'.
  const sourceIds = useMemo(() => {
    const ids = new Set<number>()
    if (draft.sourceRef?.id) ids.add(draft.sourceRef.id)
    for (const q of draft.extraQueries) if (q.sourceRef?.id) ids.add(q.sourceRef.id)
    for (const w of draft.extraWidgets) {
      if (w.data?.sourceRef?.id) ids.add(w.data.sourceRef.id)
      if (w.kind === 'facilityExplorer') for (const tab of readExplorerBindings(w).tabs) if (tab.sourceId) ids.add(tab.sourceId)
    }
    return [...ids]
  }, [draft.sourceRef, draft.extraQueries, draft.extraWidgets])
  const schemas = useSourceSchemas(sourceIds)
  const mainId = draft.sourceRef?.id ?? sourceIds[0]
  const main = mainId ? schemas[mainId] : undefined
  const loading = sourceIds.some((id) => !schemas[id]) && Object.keys(schemas).length < sourceIds.length

  const fieldType = (field: string): ReportFieldType =>
    sourceIds.map((id) => schemas[id]?.fields.find((f) => f.key === field)?.type).find(Boolean) ?? 'text'
  const sourcesWith = (field: string) => sourceIds.filter((id) => schemas[id]?.fields.some((f) => f.key === field))

  const taken = filters.map((f) => f.field)
  const suggestions = useMemo(() => (main ? suggestViewerFilters(main.fields, taken) : []), [main, taken])
  const otherFields = useMemo(() => {
    const seen = new Map<string, { key: string; label: string }>()
    for (const id of sourceIds) {
      for (const f of schemas[id]?.fields ?? []) {
        if (!taken.includes(f.key) && !seen.has(f.key)) seen.set(f.key, { key: f.key, label: f.label || f.key })
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [schemas, sourceIds, taken])

  const fieldLabel = (key: string) =>
    sourceIds.map((id) => schemas[id]?.fields.find((f) => f.key === key)?.label).find(Boolean) ?? key

  const add = (field: string, kind?: ViewerFilterKind) => {
    const k = kind ?? kindsForType(fieldType(field))[0]
    const id = viewerFilterId(field, [...filters.map((f) => f.id), ...draft.params.map((p) => p.id)])
    update({
      viewerFilters: [...filters, { id, field, label: fieldLabel(field), kind: k, sourceIds: sourcesWith(field) }],
    })
  }
  const patch = (id: string, p: Partial<ViewerFilter>) =>
    update({ viewerFilters: filters.map((f) => (f.id === id ? { ...f, ...p } : f)) })
  const remove = (id: string) => update({ viewerFilters: filters.filter((f) => f.id !== id) })
  const move = (i: number, d: -1 | 1) => {
    const next = [...filters]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    update({ viewerFilters: next })
  }

  if (!draft.sourceRef) {
    return (
      <div className="rounded-md border-2 border-dashed py-6 text-center text-sm italic text-muted-foreground">
        {t('reports.wizard.filters.needSource', { defaultValue: 'Pick a data source first.' })}
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-muted-foreground">
        {t('reports.wizard.viewerFilters.intro', {
          defaultValue: 'Filters your viewers change from the bar above the report. Each one narrows every table, chart and KPI that reads a source with that field. Left empty, a filter shows everything.',
        })}
      </p>

      {/* What viewers will see. */}
      <div className="rounded-xl border bg-muted/30 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          {t('reports.wizard.viewerFilters.previewTitle', { defaultValue: 'Filter bar preview' })}
        </p>
        {filters.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">
            {t('reports.wizard.viewerFilters.previewEmpty', { defaultValue: 'No filters — viewers see every row.' })}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {filters.map((f) => {
              const Icon = KIND_ICON[f.kind]
              return (
                <span key={f.id} className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs">
                  <span className="text-muted-foreground">{f.label || f.field}</span>
                  <span className="text-foreground/70">{t('reports.wizard.viewerFilters.all', { defaultValue: 'All' })}</span>
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                </span>
              )
            })}
          </div>
        )}
      </div>

      {/* One-click suggestions. */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t('reports.wizard.viewerFilters.suggested', { defaultValue: 'Add a filter' })}</h3>
        {loading && !main ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t('reports.wizard.filters.loading', { defaultValue: 'Loading schema…' })}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {suggestions.slice(0, MAX_SUGGESTIONS).map((s) => {
              const Icon = KIND_ICON[s.kind]
              return (
                <Button key={s.field.key} variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => add(s.field.key, s.kind)}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  {s.field.label || s.field.key}
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                </Button>
              )
            })}
            {otherFields.length > 0 && (
              <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="sr-only">{t('reports.wizard.viewerFilters.otherField', { defaultValue: 'Another field' })}</span>
                <select
                  value=""
                  onChange={(e) => e.target.value && add(e.target.value)}
                  className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
                >
                  <option value="">{t('reports.wizard.viewerFilters.otherField', { defaultValue: 'Another field…' })}</option>
                  {otherFields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {suggestions.length === 0 && otherFields.length === 0 && (
              <span className="text-xs italic text-muted-foreground">
                {t('reports.wizard.viewerFilters.noFields', { defaultValue: 'Every field already has a filter.' })}
              </span>
            )}
          </div>
        )}
      </section>

      {/* The report's filters. */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium">
          {t('reports.wizard.viewerFilters.current', { count: filters.length, defaultValue: 'Filters on this report ({{count}})' })}
        </h3>
        {filters.length === 0 && (
          <div className="rounded-md border-2 border-dashed py-5 text-center text-sm italic text-muted-foreground">
            {t('reports.wizard.viewerFilters.empty', { defaultValue: 'None yet — pick a field above.' })}
          </div>
        )}
        <ul className="space-y-2">
          {filters.map((f, i) => (
            <FilterCard
              key={f.id}
              filter={f}
              index={i}
              count={filters.length}
              type={fieldType(f.field)}
              fieldLabel={fieldLabel(f.field)}
              candidates={sourcesWith(f.field)}
              schemas={schemas}
              onPatch={(p) => patch(f.id, p)}
              onRemove={() => remove(f.id)}
              onMove={(d) => move(i, d)}
            />
          ))}
        </ul>
      </section>
    </div>
  )
}

function FilterCard({
  filter,
  index,
  count,
  type,
  fieldLabel,
  candidates,
  schemas,
  onPatch,
  onRemove,
  onMove,
}: {
  filter: ViewerFilter
  index: number
  count: number
  type: ReportFieldType
  fieldLabel: string
  candidates: number[]
  schemas: Record<number, ReportSourceSchema>
  onPatch: (p: Partial<ViewerFilter>) => void
  onRemove: () => void
  onMove: (d: -1 | 1) => void
}) {
  const { t } = useTranslation()
  const kinds = kindsForType(type)
  const labelId = `vf-label-${filter.id}`
  return (
    <li className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <label htmlFor={labelId} className="sr-only">
          {t('reports.wizard.viewerFilters.label', { defaultValue: 'Label' })}
        </label>
        <Input
          id={labelId}
          value={filter.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          className="h-8 flex-1 text-sm font-medium"
        />
        <span className="hidden truncate text-xs text-muted-foreground sm:inline" title={filter.field}>
          {t('reports.wizard.viewerFilters.field', { field: fieldLabel, defaultValue: 'Field: {{field}}' })}
        </span>
        <div className="flex items-center">
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={index === 0} onClick={() => onMove(-1)} aria-label={t('reports.wizard.viewerFilters.moveUp', { defaultValue: 'Move up' })}>
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={t('reports.wizard.viewerFilters.moveDown', { defaultValue: 'Move down' })}>
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onRemove} aria-label={t('reports.wizard.viewerFilters.remove', { label: filter.label, defaultValue: 'Remove {{label}}' })}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {kinds.length > 1 && (
        <div role="radiogroup" aria-label={t('reports.wizard.viewerFilters.showAs', { defaultValue: 'Show as' })} className="flex flex-wrap gap-1">
          {kinds.map((k) => {
            const Icon = KIND_ICON[k]
            const active = filter.kind === k
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onPatch({ kind: k })}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors',
                  active ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {t(`reports.wizard.viewerFilters.kind.${k}`, { defaultValue: KIND_LABEL[k] })}
              </button>
            )
          })}
        </div>
      )}

      {candidates.length > 1 && (
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted-foreground">
            {t('reports.wizard.viewerFilters.appliesTo', { defaultValue: 'Narrows' })}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {candidates.map((id) => (
              <label key={id} className="inline-flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5"
                  checked={filter.sourceIds.includes(id)}
                  onChange={(e) =>
                    onPatch({ sourceIds: e.target.checked ? [...filter.sourceIds, id] : filter.sourceIds.filter((s) => s !== id) })
                  }
                />
                {schemas[id]?.name ?? `#${id}`}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {filter.sourceIds.length === 0 && (
        <p className="text-xs text-warning">
          {t('reports.wizard.viewerFilters.narrowsNothing', { defaultValue: 'This filter doesn’t narrow anything yet — tick at least one source.' })}
        </p>
      )}
    </li>
  )
}
