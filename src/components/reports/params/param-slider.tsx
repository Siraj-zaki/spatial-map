import { useTranslation } from 'react-i18next'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ParamInputProps } from './types'

/**
 * Numeric slider. Emits a plain number (the runtime store handles
 * range shapes when the spec explicitly declares one via {low, high}).
 */
export function ParamSlider({
  param,
  value,
  userSet,
  onChange,
  onReset,
  compact,
}: ParamInputProps<number>) {
  const { t } = useTranslation()
  const min = param.input.min ?? 0
  const max = param.input.max ?? 100
  const step = param.input.step ?? 1
  const current = typeof value === 'number' ? value : min
  return (
    <div className={cn('flex items-center gap-3', compact ? 'w-48' : 'w-full')}>
      <span className="text-xs tabular-nums text-muted-foreground w-10 text-right">{min}</span>
      <Slider
        value={[current]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v: number[]) => onChange(v[0])}
        aria-label={param.label ?? param.id}
        className="flex-1"
      />
      <span className="text-xs tabular-nums font-medium w-14 text-left">{current}</span>
      {userSet && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 shrink-0"
          onClick={onReset}
          aria-label={t('reports.params.reset', { defaultValue: 'Reset' })}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}
