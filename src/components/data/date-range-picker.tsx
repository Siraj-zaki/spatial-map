/**
 * Date-range filter: one button that answers the common questions in one
 * click (last hour / 24 h / 7 d / 30 d) and keeps an exact range one step
 * away. Replaces two always-visible datetime inputs that rendered as
 * "dd/mm/yyyy, --:--" placeholders and collapsed to slivers on phones.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarRange, Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { RANGE_PRESETS, formatStamp, localToISO, rangeLabel, type RangePreset } from './data-helpers'

export interface DateRangeValue {
  preset: RangePreset
  /** datetime-local strings, only for `custom`. */
  from?: string
  to?: string
}

export function DateRangePicker({ value, onChange, disabled }: { value: DateRangeValue; onChange: (v: DateRangeValue) => void; disabled?: boolean }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: value.from ?? '', to: value.to ?? '' })
  const active = value.preset !== 'any'
  const invalid = !!draft.from && !!draft.to && Date.parse(draft.from) > Date.parse(draft.to)

  const label =
    value.preset === 'custom'
      ? [value.from ? formatStamp(localToISO(value.from), i18n.language) : '…', value.to ? formatStamp(localToISO(value.to), i18n.language) : t('data.range.now', { defaultValue: 'now' })].join(' → ')
      : rangeLabel(value.preset, t)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setDraft({ from: value.from ?? '', to: value.to ?? '' })
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" disabled={disabled} className={cn('max-w-[18rem]', active && 'border-primary/40 bg-primary/5')}>
          <CalendarRange className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <div role="listbox" aria-label={t('data.range.label', { defaultValue: 'Time range' })}>
          {RANGE_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              role="option"
              aria-selected={value.preset === p}
              onClick={() => {
                onChange({ preset: p })
                setOpen(false)
              }}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none', value.preset === p && 'font-medium')}
            >
              <span className="flex-1">{rangeLabel(p, t)}</span>
              {value.preset === p && <Check className="h-4 w-4 text-primary" aria-hidden />}
            </button>
          ))}
        </div>
        <form
          className="mt-1 space-y-2 border-t p-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (invalid || (!draft.from && !draft.to)) return
            onChange({ preset: 'custom', from: draft.from || undefined, to: draft.to || undefined })
            setOpen(false)
          }}
        >
          <p className="text-xs font-medium text-muted-foreground">{t('data.range.custom', { defaultValue: 'Custom range' })}</p>
          <div className="space-y-1">
            <Label htmlFor="dr-from" className="text-xs">{t('data.filter.dateFrom', { defaultValue: 'From' })}</Label>
            <Input id="dr-from" type="datetime-local" value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dr-to" className="text-xs">{t('data.filter.dateTo', { defaultValue: 'To' })}</Label>
            <Input id="dr-to" type="datetime-local" value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} className="h-8 text-xs" aria-invalid={invalid} />
          </div>
          {invalid && <p className="text-xs text-danger">{t('data.range.invalid', { defaultValue: '“From” must be before “To”.' })}</p>}
          <Button type="submit" size="sm" className="w-full" disabled={invalid || (!draft.from && !draft.to)}>
            {t('data.range.apply', { defaultValue: 'Apply range' })}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}
