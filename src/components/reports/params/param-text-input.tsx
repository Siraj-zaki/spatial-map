import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ParamInputProps } from './types'

/**
 * Free-form text param. Emits the string as-is. Empty string is
 * treated as unset by the runtime store (mirrors Evidence's
 * empty-value = no-filter semantics).
 */
export function ParamTextInput({
  param,
  value,
  userSet,
  onChange,
  onReset,
  compact,
}: ParamInputProps<string>) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex items-center gap-2', compact ? 'min-w-0' : 'w-full')}>
      <Input
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          param.input.placeholder ??
          t('reports.params.textInput.placeholder', { defaultValue: 'Type to filter…' })
        }
        aria-label={param.label ?? param.id}
        className={cn('h-8 text-sm', compact && 'w-40')}
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
