import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Database,
  Layers,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  getReportSourceSchema,
  type FilterCond,
  type FilterOp,
  type Metric,
  type MetricFn,
  type ReportSourceSchema,
  type SortKey,
} from '@/lib/reports-client'
import type { ReportQueryV2 } from '@/lib/reports/v2-types'
import { useWizard } from '../wizard-state'
import { PRIMARY_QUERY_NAME, TOTALS_QUERY_NAME } from '../wizard-serialisation'

const FNS: MetricFn[] = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max']

const OPS: Array<{ op: FilterOp; label: string; arity: 'none' | 'one' | 'list' }> = [
  { op: 'eq', label: '= equals', arity: 'one' },
  { op: 'neq', label: '≠ not equals', arity: 'one' },
  { op: 'gt', label: '> greater than', arity: 'one' },
  { op: 'gte', label: '≥ at least', arity: 'one' },
  { op: 'lt', label: '< less than', arity: 'one' },
  { op: 'lte', label: '≤ at most', arity: 'one' },
  { op: 'contains', label: 'contains', arity: 'one' },
  { op: 'in', label: 'is one of', arity: 'list' },
  { op: 'isnull', label: 'is empty', arity: 'none' },
  { op: 'notnull', label: 'has value', arity: 'none' },
]

const opArity = (op: FilterOp): 'none' | 'one' | 'list' =>
  OPS.find((x) => x.op === op)?.arity ?? 'one'

/** Queries step — declare additional named queries beyond the
 *  auto-emitted `primary` / `totals`. Extras share the report's
 *  source but have their own filters + sort + limit so widgets can
 *  slice the same data multiple ways in one dashboard.
 *
 *  What's intentionally out of scope for the first pass:
 *   - Per-query sources (extras always share the report source)
 *   - Full AND/OR filter trees (extras get a flat AND list, matching
 *     the primary Filters step)
 *   - GroupBy + metrics on extras (Summary aggregates stay on primary)
 *  Advanced users can hand-edit the spec for those cases. */
export function QueriesStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()
  const sourceId = draft.sourceRef?.id
  const [loaded, setLoaded] = useState<{ key: number; schema: ReportSourceSchema | null } | null>(null)

  useEffect(() => {
    if (sourceId === undefined) return
    let cancelled = false
    getReportSourceSchema(sourceId)
      .then((s) => {
        if (!cancelled) setLoaded({ key: sourceId, schema: s })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: sourceId, schema: null })
      })
    return () => {
      cancelled = true
    }
  }, [sourceId])

  // Keyed by source id — "loading" means no result for this source yet.
  const current = sourceId !== undefined && loaded?.key === sourceId ? loaded : null
  const loading = sourceId !== undefined && !current
  const schema = current?.schema ?? null

  const addQuery = () => {
    const name = uniqueQueryName(draft.extraQueries.map((q) => q.name))
    const q: ReportQueryV2 = {
      name,
      sourceRef: draft.sourceRef ?? { kind: 'dataSource', id: 0 },
      filters: undefined,
      sort: [],
      limit: 500,
    }
    update({ extraQueries: [...draft.extraQueries, q] })
  }

  const patchQuery = (idx: number, patch: Partial<ReportQueryV2>) => {
    const next = [...draft.extraQueries]
    next[idx] = { ...next[idx], ...patch }
    update({ extraQueries: next })
  }

  const removeQuery = (idx: number) => {
    update({ extraQueries: draft.extraQueries.filter((_, i) => i !== idx) })
  }

  if (!draft.sourceRef) {
    return (
      <div className="text-sm text-muted-foreground italic py-6 text-center border-2 border-dashed border-border rounded-md">
        {t('reports.wizard.queries.needSource', { defaultValue: 'Pick a data source first.' })}
      </div>
    )
  }
  if (loading) {
    return (
      <div className="text-sm text-muted-foreground italic py-6 text-center">
        {t('reports.wizard.queries.loading', { defaultValue: 'Loading schema…' })}
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground flex items-start gap-2">
        <Layers className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
        <div>
          <div className="font-medium">
            {t('reports.wizard.queries.intro', {
              defaultValue: 'Extra queries let widgets slice the same source differently',
            })}
          </div>
          <div className="text-muted-foreground">
            {t('reports.wizard.queries.introHint', {
              defaultValue: 'Give each extra a name and its own filters — bind a widget to it via the query picker in the Widgets step.',
            })}
          </div>
        </div>
      </div>

      {/* Auto-emitted queries — shown for context, not editable. A report
          authored outside the wizard has none. */}
      {draft.generatePrimary && (
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t('reports.wizard.queries.autoTitle', { defaultValue: 'Automatic queries' })}
        </div>
        <ul className="space-y-1">
          <AutoRow name={PRIMARY_QUERY_NAME} hint={t('reports.wizard.queries.primaryHint', {
            defaultValue: 'Reads what the Filters + Sort steps declare — the main dataset for your report.',
          })} />
          {draft.reportType === 'summary' && (
            <AutoRow name={TOTALS_QUERY_NAME} hint={t('reports.wizard.queries.totalsHint', {
              defaultValue: 'Ungrouped grand totals of every metric — powers the KPI strip.',
            })} />
          )}
        </ul>
      </div>
      )}

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t('reports.wizard.queries.extrasTitle', {
            count: draft.extraQueries.length,
            defaultValue: 'Extra queries ({{count}})',
          })}
        </div>
        {draft.extraQueries.length === 0 && (
          <div className="italic text-muted-foreground text-sm py-4 text-center border-2 border-dashed border-border rounded-md">
            {t('reports.wizard.queries.empty', {
              defaultValue: 'No extra queries yet — widgets can still bind to the automatic queries above.',
            })}
          </div>
        )}
        <ul className="space-y-2">
          {draft.extraQueries.map((q, idx) => (
            <QueryCard
              key={idx}
              index={idx}
              query={q}
              schema={schema}
              params={draft.params}
              onChange={(patch) => patchQuery(idx, patch)}
              onRemove={() => removeQuery(idx)}
            />
          ))}
        </ul>
      </div>

      <Button size="sm" onClick={addQuery} disabled={!schema}>
        <Plus className="w-3.5 h-3.5 me-1.5" />
        {t('reports.wizard.queries.add', { defaultValue: 'Add query' })}
      </Button>
    </div>
  )
}

function AutoRow({ name, hint }: { name: string; hint: string }) {
  return (
    <li className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs">
      <Database className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <code className="font-mono text-[11px] px-1 py-0.5 rounded bg-background border border-border">
          {name}
        </code>
        <span className="text-muted-foreground ms-2">{hint}</span>
      </div>
    </li>
  )
}

function QueryCard({
  index,
  query,
  schema,
  params,
  onChange,
  onRemove,
}: {
  index: number
  query: ReportQueryV2
  schema: ReportSourceSchema | null
  params: import('@/lib/reports/v2-types').ReportParam[]
  onChange: (patch: Partial<ReportQueryV2>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)

  const conditions: FilterCond[] = (query.filters?.and ?? [])
    .map((n) => n.cond)
    .filter((c): c is FilterCond => !!c)

  const setConditions = (next: FilterCond[]) =>
    onChange({ filters: next.length ? { and: next.map((c) => ({ cond: c })) } : undefined })

  const addCond = () => {
    if (!schema || schema.fields.length === 0) return
    setConditions([...conditions, { field: schema.fields[0].key, op: 'eq', value: '' }])
  }

  const patchCond = (i: number, cond: FilterCond) => {
    const next = [...conditions]
    next[i] = cond
    setConditions(next)
  }
  const removeCond = (i: number) => setConditions(conditions.filter((_, ii) => ii !== i))

  return (
    <li className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 p-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-8 shrink-0 text-center">
          #{index + 1}
        </span>
        <Input
          value={query.name}
          onChange={(e) => onChange({ name: sanitiseQueryName(e.target.value) })}
          placeholder={t('reports.wizard.queries.namePlaceholder', { defaultValue: 'query_name' })}
          className="h-7 text-xs w-40 font-mono"
        />
        <span className="text-[11px] text-muted-foreground flex-1 truncate">
          {conditions.length === 0
            ? t('reports.wizard.queries.noFilters', { defaultValue: 'No filters' })
            : t('reports.wizard.queries.filterCount', {
                count: conditions.length,
                defaultValue: '{{count}} filters',
              })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onRemove}
          aria-label={t('reports.wizard.queries.remove', { defaultValue: 'Remove' })}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      {open && (
        <div className="border-t border-border p-3 space-y-3 text-xs">
          {/* Filters */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {t('reports.wizard.queries.filtersLabel', { defaultValue: 'Filters' })}
            </Label>
            {schema && (
              <div className="space-y-2">
                {conditions.map((c, i) => {
                  const arity = opArity(c.op)
                  return (
                    <div key={i} className="flex items-center gap-1.5">
                      <select
                        value={c.field}
                        onChange={(e) => patchCond(i, { ...c, field: e.target.value })}
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs w-32 min-w-0"
                      >
                        {schema.fields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label || f.key}
                          </option>
                        ))}
                      </select>
                      <select
                        value={c.op}
                        onChange={(e) => patchCond(i, { ...c, op: e.target.value as FilterOp })}
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs w-32"
                      >
                        {OPS.map((o) => (
                          <option key={o.op} value={o.op}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {arity === 'one' && (
                        <ExtraFilterValue
                          cond={c}
                          params={params}
                          onChange={(v) => patchCond(i, { ...c, value: v })}
                        />
                      )}
                      {arity === 'list' && (
                        <Input
                          value={Array.isArray(c.value) ? (c.value as unknown[]).join(', ') : ''}
                          onChange={(e) =>
                            patchCond(i, {
                              ...c,
                              value: e.target.value
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean),
                            })
                          }
                          className="h-7 text-xs flex-1"
                        />
                      )}
                      {arity === 'none' && <div className="flex-1" />}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => removeCond(i)}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  )
                })}
                <Button variant="outline" size="sm" className="h-7" onClick={addCond}>
                  <Plus className="w-3 h-3 me-1" />
                  {t('reports.wizard.queries.addFilter', { defaultValue: 'Add filter' })}
                </Button>
              </div>
            )}
            {!schema && (
              <div className="text-[11px] text-warning flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                {t('reports.wizard.queries.schemaUnavailable', {
                  defaultValue: 'Source schema unavailable — filters disabled.',
                })}
              </div>
            )}
          </div>

          {/* Aggregation — optional. groupBy + metrics turn the query
              from raw rows into a rollup; widgets bound to it see
              groupBy + metric-alias columns via availableColumns. */}
          {schema && (
            <QueryAggregationEditor
              query={query}
              schema={schema}
              onChange={onChange}
            />
          )}

          {/* Sort */}
          {schema && (
            <QuerySortEditor
              query={query}
              schema={schema}
              onChange={onChange}
            />
          )}

          {/* Row cap */}
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground shrink-0">
              {t('reports.wizard.queries.limit', { defaultValue: 'Row limit' })}
            </Label>
            <Input
              type="number"
              min={1}
              max={5000}
              value={query.limit ?? 500}
              onChange={(e) => onChange({ limit: Math.max(1, Math.min(5000, Number(e.target.value) || 500)) })}
              className="h-7 text-xs w-24"
            />
            <span className="text-[11px] text-muted-foreground">
              {t('reports.wizard.queries.limitHint', {
                defaultValue: 'Caps rows returned — keep it as small as the widgets need.',
              })}
            </span>
          </div>
        </div>
      )}
    </li>
  )
}

/** Filter value editor for extras — mirrors the operand-source
 *  dropdown from filters-step.tsx (literal / prompt / bind-to-param)
 *  so extras get the same power as the main filter list. */
function ExtraFilterValue({
  cond,
  params,
  onChange,
}: {
  cond: FilterCond
  params: import('@/lib/reports/v2-types').ReportParam[]
  onChange: (v: unknown) => void
}) {
  const { t } = useTranslation()
  const raw = typeof cond.value === 'string' ? cond.value : ''
  const paramMatch = raw.match(/^\{\{param\.([a-zA-Z0-9_]+)\}\}$/)
  const boundParamId = paramMatch ? paramMatch[1] : null
  const mode: 'literal' | 'prompt' | 'param' =
    boundParamId ? 'param' : raw === '' ? 'prompt' : 'literal'

  const setMode = (m: 'literal' | 'prompt' | 'param') => {
    if (m === 'param') onChange(`{{param.${params[0]?.id ?? ''}}}`)
    else onChange('')
  }

  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as 'literal' | 'prompt' | 'param')}
        className={cn('h-7 rounded-md border border-input bg-background px-1.5 text-[11px] shrink-0')}
      >
        <option value="literal">{t('reports.wizard.filters.mode.literal', { defaultValue: 'Fixed' })}</option>
        <option value="prompt">{t('reports.wizard.filters.mode.prompt', { defaultValue: 'Prompt' })}</option>
        <option value="param" disabled={params.length === 0}>
          {t('reports.wizard.filters.mode.param', { defaultValue: 'Param' })}
        </option>
      </select>
      {mode === 'literal' && (
        <Input
          value={raw}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 text-xs flex-1 min-w-0"
        />
      )}
      {mode === 'prompt' && <span className="text-[11px] text-muted-foreground italic flex-1">runtime</span>}
      {mode === 'param' && (
        <select
          value={boundParamId ?? ''}
          onChange={(e) => onChange(`{{param.${e.target.value}}}`)}
          className="h-7 rounded-md border border-input bg-background px-1.5 text-xs flex-1 min-w-0"
        >
          {params.length === 0 && <option value="">—</option>}
          {params.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label ?? p.id}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/** Compact aggregation editor for one extra query. Enabled via a
 *  switch — off means the query returns raw rows; on means groupBy +
 *  metrics form a rollup, matching the shape the AggregationsStep
 *  emits for `primary` on Summary reports. */
function QueryAggregationEditor({
  query,
  schema,
  onChange,
}: {
  query: ReportQueryV2
  schema: ReportSourceSchema
  onChange: (patch: Partial<ReportQueryV2>) => void
}) {
  const { t } = useTranslation()
  const groupBy = query.groupBy ?? []
  const metrics = query.metrics ?? []
  const active = groupBy.length > 0 || metrics.length > 0

  const toggleActive = (on: boolean) => {
    if (on) {
      // Seed with a single count() metric so the query is valid the
      // moment aggregation turns on — count() needs no field.
      onChange({ groupBy: [], metrics: [{ fn: 'count', as: 'row_count' }] })
    } else {
      onChange({ groupBy: undefined, metrics: undefined })
    }
  }

  const toggleGroupBy = (key: string) => {
    const next = groupBy.includes(key) ? groupBy.filter((g) => g !== key) : [...groupBy, key]
    onChange({ groupBy: next })
  }

  const addMetric = () => {
    const nextIndex = metrics.length + 1
    onChange({ metrics: [...metrics, { fn: 'count', as: `metric_${nextIndex}` }] })
  }
  const patchMetric = (idx: number, patch: Partial<Metric>) => {
    const next = [...metrics]
    next[idx] = { ...next[idx], ...patch }
    onChange({ metrics: next })
  }
  const removeMetric = (idx: number) => {
    onChange({ metrics: metrics.filter((_, i) => i !== idx) })
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => toggleActive(e.target.checked)}
          className="w-3.5 h-3.5"
        />
        <span className="font-medium">
          {t('reports.wizard.queries.aggregate', { defaultValue: 'Aggregate this query' })}
        </span>
        <span className="text-muted-foreground">
          {t('reports.wizard.queries.aggregateHint', {
            defaultValue: '— roll up rows into groups + metric totals',
          })}
        </span>
      </label>

      {active && (
        <div className="space-y-3 ms-6">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('reports.wizard.queries.groupBy', { defaultValue: 'Group by' })}
            </Label>
            <div className="flex flex-wrap gap-1">
              {schema.fields.map((f) => {
                const on = groupBy.includes(f.key)
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => toggleGroupBy(f.key)}
                    className={cn(
                      'text-[11px] px-2 py-0.5 rounded-md border transition-colors',
                      on
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-muted-foreground border-border hover:bg-accent',
                    )}
                  >
                    {f.label || f.key}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('reports.wizard.queries.metrics', { defaultValue: 'Metrics' })}
            </Label>
            {metrics.length === 0 && (
              <div className="text-[11px] text-muted-foreground italic">
                {t('reports.wizard.queries.noMetrics', { defaultValue: 'No metrics — add at least one.' })}
              </div>
            )}
            <div className="space-y-1.5">
              {metrics.map((m, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <select
                    value={m.fn}
                    onChange={(e) => patchMetric(idx, { fn: e.target.value as MetricFn })}
                    className="h-7 rounded-md border border-input bg-background px-1.5 text-xs w-28"
                  >
                    {FNS.map((fn) => (
                      <option key={fn} value={fn}>
                        {fn}
                      </option>
                    ))}
                  </select>
                  <select
                    value={m.field ?? ''}
                    onChange={(e) => patchMetric(idx, { field: e.target.value || undefined })}
                    className="h-7 rounded-md border border-input bg-background px-1.5 text-xs flex-1 min-w-0"
                    disabled={m.fn === 'count'}
                  >
                    <option value="">
                      {m.fn === 'count'
                        ? t('reports.wizard.queries.allRows', { defaultValue: 'all rows' })
                        : t('reports.wizard.queries.pickField', { defaultValue: 'pick a field…' })}
                    </option>
                    {schema.fields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label || f.key}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={m.as}
                    onChange={(e) => patchMetric(idx, { as: e.target.value })}
                    placeholder="output name"
                    className="h-7 text-xs w-32"
                    maxLength={64}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => removeMetric(idx)}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
            <Button variant="outline" size="sm" className="h-7 mt-1" onClick={addMetric}>
              <Plus className="w-3 h-3 me-1" />
              {t('reports.wizard.queries.addMetric', { defaultValue: 'Add metric' })}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Compact sort editor — one row per SortKey with a field dropdown,
 *  direction toggle, and remove button. Add pulls from schema fields
 *  plus any metric aliases the query declares so aggregated queries
 *  can sort on their own outputs. */
function QuerySortEditor({
  query,
  schema,
  onChange,
}: {
  query: ReportQueryV2
  schema: ReportSourceSchema
  onChange: (patch: Partial<ReportQueryV2>) => void
}) {
  const { t } = useTranslation()
  const sort = query.sort ?? []
  const metrics = query.metrics ?? []
  const fieldOptions: Array<{ value: string; label: string }> = [
    ...schema.fields.map((f) => ({ value: f.key, label: f.label || f.key })),
    ...metrics.map((m) => ({ value: m.as, label: `${m.as} (metric)` })),
  ]

  const setSort = (next: SortKey[]) => onChange({ sort: next })
  const addSort = () => {
    if (fieldOptions.length === 0) return
    setSort([...sort, { field: fieldOptions[0].value, dir: 'asc' }])
  }
  const patchSort = (idx: number, patch: Partial<SortKey>) => {
    const next = [...sort]
    next[idx] = { ...next[idx], ...patch }
    setSort(next)
  }
  const removeSort = (idx: number) => setSort(sort.filter((_, i) => i !== idx))

  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <Label className="text-xs text-muted-foreground">
        {t('reports.wizard.queries.sort', { defaultValue: 'Sort' })}
      </Label>
      {sort.length === 0 && (
        <div className="text-[11px] text-muted-foreground italic">
          {t('reports.wizard.queries.sortEmpty', {
            defaultValue: 'Unordered — widgets render rows in scan order.',
          })}
        </div>
      )}
      <div className="space-y-1.5">
        {sort.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <select
              value={s.field}
              onChange={(e) => patchSort(i, { field: e.target.value })}
              className="h-7 rounded-md border border-input bg-background px-1.5 text-xs flex-1 min-w-0"
            >
              {fieldOptions.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              {(['asc', 'desc'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => patchSort(i, { dir: d })}
                  className={cn(
                    'px-2 py-0.5 text-[11px] transition-colors border-e border-border last:border-e-0',
                    s.dir === d
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-muted-foreground hover:bg-accent',
                  )}
                >
                  {d === 'asc'
                    ? t('reports.wizard.queries.sortAsc', { defaultValue: 'Asc' })
                    : t('reports.wizard.queries.sortDesc', { defaultValue: 'Desc' })}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => removeSort(i)}
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        ))}
      </div>
      <Button variant="outline" size="sm" className="h-7" onClick={addSort}>
        <Plus className="w-3 h-3 me-1" />
        {t('reports.wizard.queries.addSort', { defaultValue: 'Add sort key' })}
      </Button>
    </div>
  )
}

function sanitiseQueryName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)
}

function uniqueQueryName(existing: string[]): string {
  const reserved = new Set([...existing, PRIMARY_QUERY_NAME, TOTALS_QUERY_NAME])
  const base = 'q'
  if (!reserved.has(base)) return base
  let i = 2
  while (reserved.has(`${base}_${i}`)) i += 1
  return `${base}_${i}`
}
