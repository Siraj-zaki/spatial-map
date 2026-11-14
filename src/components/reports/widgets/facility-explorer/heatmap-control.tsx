/**
 * The viewer's "Heatmap" control for a facility map (report map view, the
 * explorer card's floor bar, and the facility viewer): off · heatmap with
 * points · heatmap only; which point layers (a checklist — several layers
 * each glow in their own theme chart colour, shown as a swatch); and, with
 * one layer, weighted by count or a number field of its table. The choice
 * lives in the URL (src/lib/reports/heatmap-config.ts). A heatmap is flat,
 * so with several floors on screen it is paused with a hint to pick one
 * floor.
 */

import { useCallback, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Flame } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { heatTintOf, readHeatmapFromURL, resolveHeatLayers, writeHeatmapToURL, type HeatmapMode, type HeatmapSetting } from '@/lib/reports/heatmap-config'
import { fetchDataSourceSchema } from '@/lib/data-link/query-client'
import { useApiQuery } from '@/lib/useApiQuery'

const MODES: readonly HeatmapMode[] = ['off', 'on', 'only']

/** The viewer's heatmap setting, mirrored to the URL. */
export function useHeatmapSetting(): [HeatmapSetting, (next: HeatmapSetting) => void] {
  const [value, setValue] = useState<HeatmapSetting>(() => readHeatmapFromURL())
  const set = useCallback((next: HeatmapSetting) => {
    setValue(next)
    writeHeatmapToURL(next)
  }, [])
  return [value, set]
}

/** The number fields of a layer's table (weighting); none while unknown. */
export function useHeatNumberFields(sourceId: number | null | undefined): string[] {
  const id = sourceId ?? null
  const schema = useApiQuery(
    () => (id !== null ? fetchDataSourceSchema(id) : Promise.resolve(null)),
    ['dl-schema', id ?? 0],
    { enabled: id !== null },
  )
  return useMemo(
    () =>
      (schema.data?.fields ?? [])
        .filter((f) => f.type === 'number' && !/^(lat|lng|lon|latitude|longitude|elevation(_m)?)$/i.test(f.field))
        .map((f) => f.field),
    [schema.data],
  )
}

export function HeatmapControl({
  value,
  onChange,
  numericFields,
  fieldLabel,
  layers,
  defaultLayerId,
  blockedReason,
  className,
}: {
  value: HeatmapSetting
  onChange: (next: HeatmapSetting) => void
  /** Number fields of the heated layer (one layer), for weighting. */
  numericFields: readonly string[]
  fieldLabel: (key: string) => string
  /** The point layers on the map, in list order (colours follow it). */
  layers: readonly { id: number; name: string }[]
  /** Heated when none is chosen (a report's open tab). */
  defaultLayerId?: number
  /** Set when the heatmap can't draw right now (several floors on screen). */
  blockedReason?: string | null
  className?: string
}) {
  const { t } = useTranslation()
  const id = useId()
  const label = t('heatmap.button', { defaultValue: 'Heatmap' })
  const on = value.mode !== 'off'
  const ids = layers.map((l) => l.id)
  const chosen = resolveHeatLayers(value, ids, defaultLayerId)
  const several = chosen.length > 1

  const pick = (mode: HeatmapMode) => {
    if (mode === value.mode) return
    onChange(mode === 'off' ? { mode } : { ...value, mode })
  }
  // At least one layer stays ticked; a weight only applies to one layer.
  const toggle = (layerId: number) => {
    const next = chosen.includes(layerId) ? chosen.filter((x) => x !== layerId) : ids.filter((x) => x === layerId || chosen.includes(x))
    if (next.length === 0) return
    onChange({ ...value, layerIds: next, weightField: next.length === 1 ? value.weightField : undefined })
  }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant={on ? 'secondary' : 'ghost'} size="sm" className={cn('relative h-8 w-8 shrink-0 p-0', className)} aria-label={label}>
              <Flame className={cn('h-4 w-4', on && !blockedReason && 'text-warning')} />
              {on && blockedReason && <span className="absolute end-1 top-1 h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-1.5rem)] p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">{label}</div>
        <div className="space-y-3 p-3">
          {on && blockedReason && <p className="rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning">{blockedReason}</p>}
          <div role="radiogroup" aria-label={label} className="space-y-0.5">
            {MODES.map((mode) => {
              const checked = value.mode === mode
              return (
                <label
                  key={mode}
                  className={cn('flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors', checked ? 'bg-accent' : 'hover:bg-accent/60')}
                >
                  <input type="radio" name={`${id}-mode`} value={mode} checked={checked} onChange={() => pick(mode)} className="mt-0.5 shrink-0 accent-primary" />
                  <span className="min-w-0">
                    <span className="block text-sm leading-5">{t(`heatmap.mode.${mode}`, { defaultValue: MODE_FALLBACK[mode] })}</span>
                    <span className="block text-xs text-muted-foreground">{t(`heatmap.hint.${mode}`, { defaultValue: HINT_FALLBACK[mode] })}</span>
                  </span>
                </label>
              )
            })}
          </div>

          {on && layers.length > 1 && (
            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs text-muted-foreground">{t('heatmap.layers', { defaultValue: 'Layers' })}</legend>
              <div className="max-h-40 space-y-0.5 overflow-y-auto">
                {layers.map((l) => {
                  const checked = chosen.includes(l.id)
                  return (
                    <label
                      key={l.id}
                      className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors', checked ? 'bg-accent' : 'hover:bg-accent/60')}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggle(l.id)} className="shrink-0 accent-primary" />
                      <span className="min-w-0 flex-1 truncate">{l.name}</span>
                      {several && checked && (
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: `hsl(var(--${heatTintOf(ids, l.id)}))` }} aria-hidden />
                      )}
                    </label>
                  )
                })}
              </div>
              {several && <p className="px-2 text-xs text-muted-foreground">{t('heatmap.layersHint', { defaultValue: 'Each ticked layer glows in its own colour.' })}</p>}
            </fieldset>
          )}

          {on && several && <p className="text-xs text-muted-foreground">{t('heatmap.weightOneLayer', { defaultValue: 'Weighting by a number works with one layer.' })}</p>}

          {on && !several && (
            <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t('heatmap.weight', { defaultValue: 'Weight' })}</span>
              <select
                value={value.weightField ?? ''}
                onChange={(e) => onChange({ ...value, weightField: e.target.value || undefined })}
                className="h-7 min-w-0 max-w-[11rem] rounded-md border bg-background px-1.5 text-xs text-foreground"
              >
                <option value="">{t('heatmap.weightCount', { defaultValue: 'Number of items' })}</option>
                {numericFields.map((f) => (
                  <option key={f} value={f}>
                    {fieldLabel(f)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

const MODE_FALLBACK: Record<HeatmapMode, string> = { off: 'Off', on: 'Heatmap and items', only: 'Heatmap only' }
const HINT_FALLBACK: Record<HeatmapMode, string> = {
  off: 'Items are drawn as markers.',
  on: 'Where items gather glows, markers stay on top.',
  only: 'Just the density — markers are hidden.',
}
