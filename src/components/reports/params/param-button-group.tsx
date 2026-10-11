import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ParamInputProps } from './types'

/**
 * Segmented control — one visible pill per option. Ideal when the
 * option count is small (< 6). Single-select only; multi-select is
 * the dropdown's job.
 */
export function ParamButtonGroup({
  param,
  value,
  userSet,
  onChange,
  onReset,
  optionsResolved,
  optionsLoading,
  optionsError,
  compact,
}: ParamInputProps<string>) {
  const { t } = useTranslation()
  const options = optionsResolved ?? []

  if (optionsLoading) {
    return <span className="text-xs text-muted-foreground italic">
      {t('reports.params.loading', { defaultValue: 'Loading…' })}
    </span>
  }
  if (optionsError) {
    return <span className="text-xs text-destructive">{optionsError}</span>
  }
  if (options.length === 0) {
    return <span className="text-xs text-muted-foreground italic">
      {t('reports.params.noOptions', { defaultValue: 'No options' })}
    </span>
  }

  return (
    <div className={cn('inline-flex items-center gap-1', compact && 'shrink-0')}>
      <div role="group" aria-label={param.label ?? param.id} className="inline-flex rounded-md border border-border overflow-hidden">
        {/* No value = no filter on the server: "All" clears the pick. */}
        <button
          type="button"
          onClick={onReset}
          aria-pressed={value === undefined || value === null || value === ''}
          className={cn(
            'px-3 py-1 text-xs transition-colors border-r border-border',
            value === undefined || value === null || value === ''
              ? 'bg-primary text-primary-foreground'
              : 'bg-background hover:bg-accent',
          )}
        >
          {t('reports.params.all', { defaultValue: 'All' })}
        </button>
        {options.map((opt, i) => {
          const isSelected = String(opt.value) === String(value ?? '')
          return (
            <button
              key={`${opt.value}-${i}`}
              type="button"
              onClick={() => onChange(String(opt.value))}
              aria-pressed={isSelected}
              className={cn(
                'px-3 py-1 text-xs transition-colors',
                'border-r border-border last:border-r-0',
                isSelected
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background hover:bg-accent',
              )}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
      {userSet && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onReset}
          aria-label={t('reports.params.reset', { defaultValue: 'Reset' })}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}
