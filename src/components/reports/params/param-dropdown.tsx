import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ParamInputProps } from './types'

/**
 * Single- or multi-select dropdown. Built on top of the existing
 * Radix Popover primitive with a homegrown Command-list — no new
 * dependency, keyboard nav via arrow keys, filter via type-to-search.
 */
export function ParamDropdown({
  param,
  value,
  userSet,
  onChange,
  onReset,
  optionsResolved,
  optionsLoading,
  optionsError,
  compact,
}: ParamInputProps<string | string[]>) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const multi = param.input.multi
  const options = optionsResolved ?? []
  const filtered = useMemo(
    () =>
      search.trim() === ''
        ? options
        : options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase())),
    [options, search],
  )

  const selectedSet = new Set(
    multi ? ((value as string[] | undefined) ?? []).map(String) : [String(value ?? '')],
  )

  // No value = no filter on the server, so an empty dropdown reads "All".
  const allLabel = t('reports.params.all', { defaultValue: 'All' })
  const isEmpty = multi ? !(Array.isArray(value) && value.length > 0) : value === undefined || value === null || value === ''
  const buttonLabel = multi
    ? !isEmpty
      ? t('reports.params.dropdown.multiSummary', {
          count: (value as string[]).length,
          defaultValue: '{{count}} selected',
        })
      : allLabel
    : options.find((o) => String(o.value) === String(value ?? ''))?.label ?? allLabel

  const handleToggle = (rawValue: unknown) => {
    if (multi) {
      const current = Array.isArray(value) ? [...value] : []
      const key = String(rawValue)
      const idx = current.findIndex((v) => String(v) === key)
      if (idx >= 0) current.splice(idx, 1)
      else current.push(key)
      onChange(current)
    } else {
      onChange(String(rawValue))
      setOpen(false)
    }
  }

  return (
    <div className={cn('inline-flex items-center gap-1', compact && 'shrink-0')}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn('h-8 justify-between text-xs font-normal', compact ? 'w-40' : 'w-full min-w-[10rem]')}
            aria-label={param.label ?? param.id}
          >
            <span className="truncate">{buttonLabel}</span>
            <ChevronDown className="ms-2 h-3 w-3 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-64" align="start">
          {options.length > 10 && (
            <div className="p-2 border-b border-border">
              <Input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('reports.params.dropdown.searchPlaceholder', { defaultValue: 'Search…' })}
                className="h-8 text-sm"
              />
            </div>
          )}
          <div className="max-h-64 overflow-y-auto py-1">
            {optionsLoading && (
              <div className="px-3 py-2 text-xs text-muted-foreground italic">
                {t('reports.params.loading', { defaultValue: 'Loading…' })}
              </div>
            )}
            {optionsError && (
              <div className="px-3 py-2 text-xs text-destructive">{optionsError}</div>
            )}
            {!optionsLoading && !optionsError && filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground italic">
                {t('reports.params.noOptions', { defaultValue: 'No options' })}
              </div>
            )}
            {!optionsLoading && !optionsError && options.length > 0 && search.trim() === '' && (
              <button
                type="button"
                onClick={() => {
                  onReset()
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2 border-b border-border px-3 py-1.5 text-start text-xs transition-colors',
                  isEmpty ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <Check className={cn('h-3.5 w-3.5', isEmpty ? 'opacity-100' : 'opacity-0')} />
                <span className="truncate">{allLabel}</span>
              </button>
            )}
            {filtered.map((opt, i) => {
              const isSel = selectedSet.has(String(opt.value))
              return (
                <button
                  key={`${opt.value}-${i}`}
                  type="button"
                  onClick={() => handleToggle(opt.value)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors',
                    isSel ? 'bg-accent' : 'hover:bg-accent/50',
                  )}
                >
                  <Check className={cn('h-3.5 w-3.5', isSel ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{opt.label}</span>
                </button>
              )
            })}
          </div>
        </PopoverContent>
      </Popover>
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
