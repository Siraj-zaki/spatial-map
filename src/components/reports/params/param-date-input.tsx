import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ParamInputProps } from './types'

/**
 * Single-date param. Emits an ISO YYYY-MM-DD string. Uses the browser
 * native date picker for the widest input support without adding a
 * dependency.
 */
export function ParamDateInput({
  param,
  value,
  userSet,
  onChange,
  onReset,
  compact,
}: ParamInputProps<string>) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex items-center gap-2', compact && 'min-w-0')}>
      <Input
        type="date"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        aria-label={param.label ?? param.id}
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
  )
}
