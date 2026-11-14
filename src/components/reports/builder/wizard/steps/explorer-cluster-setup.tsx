/**
 * Widgets step: the report author's default for clustering the data
 * items of a "Facility map & list" widget (`bindings.cluster`, see
 * src/lib/reports/cluster-config.ts). Viewers can still switch it from
 * the report header, and their choice is kept in the URL.
 *
 * Shown only for widgets with a linked-data tab. Off removes the key, so
 * reports that never touch this control are saved unchanged.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { CLUSTER_RADIUS_MAX, CLUSTER_RADIUS_MIN } from '@/lib/data-link/point-clusters'
import type { ReportClusterConfig, ReportClusterMode } from '@/lib/reports/cluster-config'
import { useSourceSchema } from '../use-source-schema'

const MODES: readonly ReportClusterMode[] = ['off', 'location', 'room', 'field']

// Keys, coordinates and elevations never make a useful group.
const NOT_A_GROUP = /^(id|entity_key|lng|lat|lon|longitude|latitude|position|geom|geometry)$|^elevation/i

const MODE_DEFAULTS: Record<ReportClusterMode, { label: string; hint: string }> = {
  off: { label: 'Off', hint: 'Every item is drawn on its own.' },
  location: { label: 'By location', hint: 'Items close together on screen merge into one bubble.' },
  room: { label: 'By room', hint: 'One bubble per room or area. Items outside rooms group by location.' },
  field: { label: 'By field', hint: 'Nearby items merge only with others of the same value.' },
}

export function ExplorerClusterSetup({
  value,
  sourceId,
  onChange,
}: {
  value: ReportClusterConfig
  sourceId?: number
  onChange: (next: ReportClusterConfig) => void
}) {
  const { t } = useTranslation()
  const fieldId = useId()
  const radiusId = useId()
  const { schema, loading } = useSourceSchema(sourceId)
  // "By field" with no field picked yet stays local: a stored field mode
  // without a field reads back as location, which would undo the click.
  const [pickingField, setPickingField] = useState(false)
  const mode: ReportClusterMode = pickingField && value.mode !== 'field' ? 'field' : value.mode
  const field = value.mode === 'field' ? value.field ?? '' : ''

  const fields = (schema?.fields ?? []).filter(
    (f) => !NOT_A_GROUP.test(f.key) && f.type !== 'date' && f.type !== 'datetime',
  )
  // Keep a stored field selectable while the schema loads or after it changed.
  const options = field && !fields.some((f) => f.key === field) ? [{ key: field, label: field }, ...fields] : fields

  const pickMode = (next: ReportClusterMode) => {
    if (next === 'field') {
      if (value.mode === 'field') return
      setPickingField(true)
      return
    }
    setPickingField(false)
    if (next !== value.mode) onChange({ mode: next, radius: value.radius })
  }
  const pickField = (key: string) => {
    if (!key) return
    setPickingField(false)
    onChange({ mode: 'field', field: key, radius: value.radius })
  }

  return (
    <fieldset className="space-y-2 border-t border-border pt-3">
      <legend className="sr-only">{t('reports.wizard.explorer.cluster', { defaultValue: 'Clustering on the map' })}</legend>
      <div aria-hidden className="text-xs font-medium text-foreground">
        {t('reports.wizard.explorer.cluster', { defaultValue: 'Clustering on the map' })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t('reports.wizard.explorer.clusterHint', {
          defaultValue: 'How the map groups items that sit close together. Viewers can change it from the report header.',
        })}
      </p>

      <div className="grid w-full grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:inline-grid sm:w-fit sm:grid-cols-4">
        {MODES.map((m) => {
          const active = mode === m
          return (
            <button
              key={m}
              type="button"
              aria-pressed={active}
              onClick={() => pickMode(m)}
              className={cn(
                'px-3 py-0.5 text-[11px] transition-colors motion-reduce:transition-none',
                active ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-accent',
              )}
            >
              {t(`reports.cluster.mode.${m}`, { defaultValue: MODE_DEFAULTS[m].label })}
            </button>
          )
        })}
      </div>
      <p className="text-[10px] text-muted-foreground">
        {t(`reports.cluster.hint.${mode}`, { defaultValue: MODE_DEFAULTS[mode].hint })}
      </p>

      {mode === 'field' && (
        <div className="grid gap-1.5 sm:grid-cols-[8rem,1fr] sm:items-center">
          <Label htmlFor={fieldId} className="text-xs text-muted-foreground">
            {t('reports.cluster.field', { defaultValue: 'Field' })}
          </Label>
          <select
            id={fieldId}
            value={field}
            disabled={loading && options.length === 0}
            onChange={(e) => pickField(e.target.value)}
            className={cn(
              'h-8 w-full rounded-md border bg-background px-2 text-xs disabled:opacity-50',
              field ? 'border-input' : 'border-warning',
            )}
          >
            <option value="" disabled>
              {t('reports.cluster.fieldNone', { defaultValue: 'Pick a field' })}
            </option>
            {options.map((f) => (
              <option key={f.key} value={f.key}>{f.label || f.key}</option>
            ))}
          </select>
        </div>
      )}

      {mode !== 'off' && (
        <div className="grid gap-1.5 sm:grid-cols-[8rem,1fr] sm:items-center">
          <Label id={radiusId} className="text-xs text-muted-foreground">
            {mode === 'room'
              ? t('reports.cluster.radiusOutside', { defaultValue: 'Radius outside rooms' })
              : t('reports.cluster.radius', { defaultValue: 'Radius' })}
          </Label>
          <div className="flex items-center gap-3">
            <Slider
              aria-labelledby={radiusId}
              min={CLUSTER_RADIUS_MIN}
              max={CLUSTER_RADIUS_MAX}
              step={4}
              value={[value.radius]}
              onValueChange={([r]) => {
                if (r === value.radius) return
                // While a field is still being picked the stored mode is
                // the previous one; keep it and only move the radius.
                if (value.mode !== 'off') onChange({ ...value, radius: r })
              }}
              disabled={value.mode === 'off'}
              className="min-w-0 flex-1"
            />
            <span className="w-12 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">
              {t('reports.cluster.px', { value: value.radius, defaultValue: '{{value}} px' })}
            </span>
          </div>
        </div>
      )}
    </fieldset>
  )
}
