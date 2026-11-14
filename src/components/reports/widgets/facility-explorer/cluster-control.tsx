/**
 * The viewer's "Cluster items" control for a report's facility map: how
 * the map groups data items that sit close together (off · by location ·
 * by room · by field) and the screen radius. The report author's choice
 * (`widget.bindings.cluster`) is the default; the viewer's own choice
 * lives in the URL (`?cluster=…&clusterRadius=…`, src/lib/reports/
 * cluster-config.ts), so a shared link carries it. Never localStorage.
 *
 * Shown in the full-map top bar (after Filters) and, in page view, in
 * the explorer card's floor bar. Only for linked-data tabs drawn as
 * points (point-at-coord / history-movement).
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Group, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CLUSTER_RADIUS_MAX, CLUSTER_RADIUS_MIN } from '@/lib/data-link/point-clusters'
import {
  CLUSTER_RADIUS_URL_PARAM,
  CLUSTER_URL_PARAM,
  readClusterFromURL,
  sameCluster,
  writeClusterToURL,
  type ReportClusterConfig,
  type ReportClusterMode,
} from '@/lib/reports/cluster-config'

const URL_WRITE_MS = 150
const RADIUS_STEP = 4
const MODES: readonly ReportClusterMode[] = ['off', 'location', 'room', 'field']

/**
 * The viewer's cluster setting: the URL's choice, else the report default.
 * With nothing in the URL it follows the default (an author's edit shows
 * at once); a choice equal to the default clears the URL params again.
 * URL writes are debounced (a dragged radius is one history entry).
 */
export function useClusterSetting(
  defaultCfg: ReportClusterConfig,
): [ReportClusterConfig, (next: ReportClusterConfig) => void] {
  // null = follow the report default.
  const [override, setOverride] = useState<ReportClusterConfig | null>(() => {
    const search = window.location.search
    const params = new URLSearchParams(search)
    if (!params.has(CLUSTER_URL_PARAM) && !params.has(CLUSTER_RADIUS_URL_PARAM)) return null
    const fromUrl = readClusterFromURL(search, defaultCfg)
    return sameCluster(fromUrl, defaultCfg) ? null : fromUrl
  })
  const value = override ?? defaultCfg

  const defaultRef = useRef(defaultCfg)
  const timer = useRef<number | null>(null)
  useEffect(() => {
    defaultRef.current = defaultCfg
  }, [defaultCfg])
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const set = useCallback((next: ReportClusterConfig) => {
    const fallback = defaultRef.current
    setOverride(sameCluster(next, fallback) ? null : next)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      writeClusterToURL(next, defaultRef.current)
    }, URL_WRITE_MS)
  }, [])

  return [value, set]
}

export function ClusterControl({
  value,
  defaultValue,
  onChange,
  fields,
  fieldLabel,
  className,
}: {
  value: ReportClusterConfig
  defaultValue: ReportClusterConfig
  onChange: (next: ReportClusterConfig) => void
  /** Fields the viewer may cluster by (the report rows' categorical columns). */
  fields: readonly string[]
  fieldLabel: (key: string) => string
  /** Trigger size override (the page view's floor bar is denser). */
  className?: string
}) {
  const { t } = useTranslation()
  const id = useId()
  const label = t('reports.cluster.button', { defaultValue: 'Cluster items' })
  const on = value.mode !== 'off'
  const isDefault = sameCluster(value, defaultValue)

  const pickMode = (mode: ReportClusterMode) => {
    if (mode === value.mode) return
    if (mode === 'field') {
      const field = value.field && fields.includes(value.field) ? value.field : fields[0]
      if (!field) return
      onChange({ mode, radius: value.radius, field })
      return
    }
    onChange({ mode, radius: value.radius })
  }

  const radiusLabel =
    value.mode === 'room'
      ? t('reports.cluster.radiusOutside', { defaultValue: 'Radius outside rooms' })
      : t('reports.cluster.radius', { defaultValue: 'Radius' })

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant={on ? 'secondary' : 'ghost'}
              size="sm"
              className={cn('h-8 w-8 shrink-0 p-0', className)}
              aria-label={label}
            >
              <Group className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-1.5rem)] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-sm font-medium">{label}</span>
          {!isDefault && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onChange(defaultValue)}>
              <RotateCcw className="h-3 w-3" />
              {t('reports.cluster.reset', { defaultValue: 'Report default' })}
            </Button>
          )}
        </div>
        <div className="space-y-3 p-3">
          <div role="radiogroup" aria-label={label} className="space-y-0.5">
            {MODES.map((mode) => {
              const disabled = mode === 'field' && fields.length === 0
              const checked = value.mode === mode
              return (
                <label
                  key={mode}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors',
                    checked ? 'bg-accent' : 'hover:bg-accent/60',
                    disabled && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    value={mode}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => pickMode(mode)}
                    className="mt-0.5 shrink-0 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm leading-5">{t(`reports.cluster.mode.${mode}`, { defaultValue: MODE_FALLBACK[mode] })}</span>
                    <span className="block text-xs text-muted-foreground">{t(`reports.cluster.hint.${mode}`, { defaultValue: HINT_FALLBACK[mode] })}</span>
                  </span>
                </label>
              )
            })}
          </div>

          {value.mode === 'field' && (
            <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t('reports.cluster.field', { defaultValue: 'Field' })}</span>
              <select
                value={value.field ?? ''}
                onChange={(e) => e.target.value && onChange({ mode: 'field', radius: value.radius, field: e.target.value })}
                className="h-7 min-w-0 max-w-[11rem] rounded-md border bg-background px-1.5 text-xs text-foreground"
              >
                {!value.field && <option value="">{t('reports.cluster.fieldNone', { defaultValue: 'Pick a field' })}</option>}
                {fields.map((f) => (
                  <option key={f} value={f}>
                    {fieldLabel(f)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {on && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span id={`${id}-radius`} className="text-muted-foreground">{radiusLabel}</span>
                <span className="tabular-nums">{t('reports.cluster.px', { value: value.radius, defaultValue: '{{value}} px' })}</span>
              </div>
              <Slider
                min={CLUSTER_RADIUS_MIN}
                max={CLUSTER_RADIUS_MAX}
                step={RADIUS_STEP}
                value={[value.radius]}
                onValueChange={([r]) => {
                  if (typeof r === 'number' && r !== value.radius) onChange({ ...value, radius: r })
                }}
                aria-labelledby={`${id}-radius`}
              />
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

const MODE_FALLBACK: Record<ReportClusterMode, string> = {
  off: 'Off',
  location: 'By location',
  room: 'By room',
  field: 'By field',
}
const HINT_FALLBACK: Record<ReportClusterMode, string> = {
  off: 'Every item is drawn on its own.',
  location: 'Items close together on screen merge into one bubble.',
  room: 'One bubble per room or area. Items outside rooms group by location.',
  field: 'Nearby items merge only with others of the same value.',
}
