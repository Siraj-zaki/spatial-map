import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChartArea, ChartLine, ChartPie, ChartColumn, CircleDot, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { getReportSourceSchema, type MetricFn, type ReportSourceSchema } from '@/lib/reports-client'
import { useWizard, type SummaryChartKind } from '../wizard-state'

const FNS: MetricFn[] = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max']

const CHART_KINDS: Array<{ kind: SummaryChartKind; label: string; icon: typeof ChartColumn; hint: string }> = [
  { kind: 'bar', label: 'Bar', icon: ChartColumn, hint: 'One bar per group — the everyday default.' },
  { kind: 'line', label: 'Line', icon: ChartLine, hint: 'Trend across an ordered group (dates, weeks).' },
  { kind: 'area', label: 'Area', icon: ChartArea, hint: 'Line with filled area — good for cumulative totals.' },
  { kind: 'pie', label: 'Pie', icon: ChartPie, hint: 'Share of a single metric — few groups only.' },
  { kind: 'donut', label: 'Donut', icon: CircleDot, hint: 'Pie with a hole; matches a bigValue in the middle.' },
]

export function AggregationsStep() {
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

  // Only trust a schema fetched for the current source.
  const schema = sourceId !== undefined && loaded?.key === sourceId ? loaded.schema : null

  if (!schema) {
    return (
      <div className="text-sm text-muted-foreground italic py-6 text-center border-2 border-dashed border-border rounded-md">
        {t('reports.wizard.aggregations.needSource', { defaultValue: 'Pick a data source first.' })}
      </div>
    )
  }

  const toggleGroupBy = (key: string) => {
    if (draft.groupBy.includes(key)) update({ groupBy: draft.groupBy.filter((g) => g !== key) })
    else update({ groupBy: [...draft.groupBy, key] })
  }

  const addMetric = () => {
    const nextIndex = draft.metrics.length + 1
    update({
      metrics: [...draft.metrics, { fn: 'count', as: `metric_${nextIndex}` }],
    })
  }

  const patchMetric = (idx: number, patch: Partial<{ fn: MetricFn; field: string; as: string }>) => {
    const next = [...draft.metrics]
    next[idx] = { ...next[idx], ...patch }
    update({ metrics: next })
  }

  const removeMetric = (idx: number) => {
    update({ metrics: draft.metrics.filter((_, i) => i !== idx) })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="space-y-2">
        <Label>{t('reports.wizard.aggregations.groupBy', { defaultValue: 'Group by' })}</Label>
        <p className="text-xs text-muted-foreground">
          {t('reports.wizard.aggregations.groupByHint', {
            defaultValue: 'Rows sharing the same values for these fields are collapsed together.',
          })}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {schema.fields.map((f) => {
            const active = draft.groupBy.includes(f.key)
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => toggleGroupBy(f.key)}
                className={cn(
                  'text-xs px-2.5 py-1 rounded-md border transition-colors',
                  active
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

      <div className="space-y-2 border-t border-border pt-4">
        <Label>{t('reports.wizard.aggregations.metrics', { defaultValue: 'Aggregations' })}</Label>
        <p className="text-xs text-muted-foreground">
          {t('reports.wizard.aggregations.metricsHint', {
            defaultValue: 'Numeric rollups computed per group. Count works without a field; others need one.',
          })}
        </p>
        {draft.metrics.length === 0 && (
          <div className="italic text-muted-foreground text-sm py-2">
            {t('reports.wizard.aggregations.empty', {
              defaultValue: 'No aggregations yet.',
            })}
          </div>
        )}
        <div className="space-y-2">
          {draft.metrics.map((m, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <select
                value={m.fn}
                onChange={(e) => patchMetric(idx, { fn: e.target.value as MetricFn })}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs w-36"
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
                className="h-8 rounded-md border border-input bg-background px-2 text-xs flex-1 min-w-0"
                disabled={m.fn === 'count'}
              >
                <option value="">
                  {m.fn === 'count'
                    ? t('reports.wizard.aggregations.allRows', { defaultValue: 'all rows' })
                    : t('reports.wizard.aggregations.pickField', { defaultValue: 'pick a field…' })}
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
                placeholder={t('reports.wizard.aggregations.aliasPlaceholder', { defaultValue: 'output name' })}
                className="h-8 text-xs w-32"
                maxLength={64}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => removeMetric(idx)}
                aria-label={t('reports.wizard.aggregations.remove', { defaultValue: 'Remove' })}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={addMetric}>
          <Plus className="w-3.5 h-3.5 me-1.5" />
          {t('reports.wizard.aggregations.add', { defaultValue: 'Add aggregation' })}
        </Button>
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <Label>{t('reports.wizard.aggregations.chartKind', { defaultValue: 'Primary chart' })}</Label>
        <p className="text-xs text-muted-foreground">
          {t('reports.wizard.aggregations.chartKindHint', {
            defaultValue: 'The wizard auto-generates a KPI strip plus this chart as the report’s primary widget.',
          })}
        </p>
        <div className="grid gap-2 sm:grid-cols-5 pt-1">
          {CHART_KINDS.map((c) => {
            const active = draft.primaryChartKind === c.kind
            const Icon = c.icon
            return (
              <button
                key={c.kind}
                type="button"
                onClick={() => update({ primaryChartKind: c.kind })}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-all',
                  active
                    ? 'border-primary bg-primary/10 ring-2 ring-primary/40'
                    : 'border-border hover:border-primary/40 hover:bg-accent/50',
                )}
                aria-pressed={active}
                title={c.hint}
              >
                <Icon
                  className={cn(
                    'w-5 h-5',
                    active ? 'text-primary' : 'text-muted-foreground',
                  )}
                />
                <span className={cn('text-xs font-medium', active && 'text-primary')}>
                  {t(`reports.wizard.aggregations.chart.${c.kind}`, { defaultValue: c.label })}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
