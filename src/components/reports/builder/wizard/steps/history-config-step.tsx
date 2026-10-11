import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getReportSourceSchema, type ReportSourceSchema } from '@/lib/reports-client'
import { useWizard } from '../wizard-state'

const BUCKETS = ['hour', 'day', 'week', 'month'] as const

export function HistoryConfigStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()
  const sourceId = draft.sourceRef?.id
  const [loaded, setLoaded] = useState<{ key: number; schema: ReportSourceSchema | null } | null>(null)

  useEffect(() => {
    if (sourceId === undefined) return
    let cancelled = false
    getReportSourceSchema(sourceId)
      .then((s) => {
        if (!cancelled) {
          setLoaded({ key: sourceId, schema: s })
          // Auto-pick the first datetime/date field when none is set.
          if (!draft.timeField) {
            const temporal = s.fields.find((f) => f.type === 'datetime' || f.type === 'date')
            if (temporal) update({ timeField: temporal.key })
          }
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: sourceId, schema: null })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId])

  // Only trust a schema fetched for the current source.
  const schema = sourceId !== undefined && loaded?.key === sourceId ? loaded.schema : null

  const temporalFields = useMemo(
    () => schema?.fields.filter((f) => f.type === 'datetime' || f.type === 'date') ?? [],
    [schema],
  )

  if (!draft.sourceRef) {
    return (
      <div className="text-sm text-muted-foreground italic py-6 text-center border-2 border-dashed border-border rounded-md">
        {t('reports.wizard.history.needSource', { defaultValue: 'Pick a data source first.' })}
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="space-y-2">
        <Label>{t('reports.wizard.history.timeField', { defaultValue: 'Time field' })}</Label>
        <p className="text-xs text-muted-foreground">
          {t('reports.wizard.history.timeFieldHint', {
            defaultValue: 'Which column represents when each record was recorded.',
          })}
        </p>
        {temporalFields.length === 0 ? (
          <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning flex items-start gap-2">
            <Clock className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              {t('reports.wizard.history.noTemporal', {
                defaultValue: 'This source has no date/datetime fields. History reports need at least one.',
              })}
            </span>
          </div>
        ) : (
          <select
            value={draft.timeField ?? ''}
            onChange={(e) => update({ timeField: e.target.value || null })}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm w-64"
          >
            <option value="">{t('reports.wizard.history.pickField', { defaultValue: 'Pick a field…' })}</option>
            {temporalFields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label || f.key}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <Label htmlFor="wiz-window">
          {t('reports.wizard.history.window', { defaultValue: 'Window (days)' })}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t('reports.wizard.history.windowHint', {
            defaultValue: 'How far back the report looks. 30 days is a common default.',
          })}
        </p>
        <Input
          id="wiz-window"
          type="number"
          min={1}
          max={365}
          value={draft.windowDays}
          onChange={(e) =>
            update({ windowDays: Math.max(1, Math.min(365, Number(e.target.value) || 30)) })
          }
          className="h-8 w-32 text-sm"
        />
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <Label>{t('reports.wizard.history.bucket', { defaultValue: 'Bucket by' })}</Label>
        <p className="text-xs text-muted-foreground">
          {t('reports.wizard.history.bucketHint', {
            defaultValue: 'The time interval each chart point represents.',
          })}
        </p>
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          {BUCKETS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => update({ timeBucket: b })}
              className={
                (draft.timeBucket === b
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background text-muted-foreground hover:bg-accent') +
                ' px-3 py-1 text-xs border-e border-border last:border-e-0'
              }
            >
              {t(`reports.wizard.history.bucket.${b}`, { defaultValue: b })}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
