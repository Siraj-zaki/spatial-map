import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ParamInputProps } from './types'

interface DateRangeValue {
  start?: string
  end?: string
}

/** Compute the ISO date `n` days before today. */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

const PRESETS: Record<string, () => DateRangeValue> = {
  last7: () => ({ start: daysAgo(7), end: daysAgo(0) }),
  last30: () => ({ start: daysAgo(30), end: daysAgo(0) }),
  last90: () => ({ start: daysAgo(90), end: daysAgo(0) }),
  ytd: () => ({ start: `${new Date().getFullYear()}-01-01`, end: daysAgo(0) }),
}

/**
 * Date-range param. Uses two native date inputs so no external picker
 * is needed. Presets are a shortcuts row above the inputs.
 */
export function ParamDateRange({
  param,
  value,
  userSet,
  onChange,
  onReset,
  compact,
}: ParamInputProps<DateRangeValue>) {
  const { t } = useTranslation()
  const start = value?.start ?? ''
  const end = value?.end ?? ''
  const presets = param.input.presets ?? ['last7', 'last30', 'last90']

  return (
    <div className={cn('flex flex-col gap-2', compact ? 'min-w-0' : 'w-full')}>
      <div className="flex items-center gap-2">
        <Input
          type="date"
          value={start}
          onChange={(e) => onChange({ ...(value ?? {}), start: e.target.value })}
          aria-label={t('reports.params.dateRange.start', { defaultValue: 'Start date' })}
          className={cn('h-8 text-sm', compact && 'w-36')}
        />
        <span className="text-xs text-muted-foreground">
          {t('reports.params.dateRange.to', { defaultValue: 'to' })}
        </span>
        <Input
          type="date"
          value={end}
          onChange={(e) => onChange({ ...(value ?? {}), end: e.target.value })}
          aria-label={t('reports.params.dateRange.end', { defaultValue: 'End date' })}
          className={cn('h-8 text-sm', compact && 'w-36')}
        />
        {userSet && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onReset}
            aria-label={t('reports.params.reset', { defaultValue: 'Reset' })}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {!compact && presets.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {presets.map((preset) => {
            const build = PRESETS[preset]
            if (!build) return null
            return (
              <button
                key={preset}
                type="button"
                onClick={() => onChange(build())}
                className="text-xs px-2 py-0.5 rounded border border-border hover:bg-accent transition-colors"
              >
                {t(`reports.params.dateRange.preset.${preset}`, { defaultValue: preset })}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
