/**
 * HistoryRangePicker — the history player's time range. Quick spans (15 min
 * … 30 days), "last N minutes / hours / days", or a custom from–to. A range
 * covers at most 31 days (the events endpoint's cap). Lives in the player's
 * top row; the popover opens upward, over the map.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarClock, ChevronDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export type PlayerRange = { kind: 'last'; sec: number } | { kind: 'between'; from: number; to: number }

/** A range covers at most this much (the events endpoint's cap). */
export const MAX_RANGE_MS = 31 * 86_400_000

const QUICK_SPANS = [900, 3600, 7200, 21_600, 43_200, 86_400, 259_200, 604_800, 2_592_000]
const UNIT_SEC = { minute: 60, hour: 3600, day: 86_400 } as const
type Unit = keyof typeof UNIT_SEC

/** The playback window a range stands for, now. */
export function rangeBounds(range: PlayerRange, now = Date.now()): { startMs: number; endMs: number } {
  return range.kind === 'last' ? { startMs: now - range.sec * 1000, endMs: now } : { startMs: range.from, endMs: range.to }
}

/** "2 hr", "15 min", "24 hr", "7 days" — whole days from two days up. */
function spanLabel(sec: number, locale: string, display: 'short' | 'narrow' = 'short'): string {
  const unit: Unit = sec >= 2 * 86_400 && sec % 86_400 === 0 ? 'day' : sec % 3600 === 0 ? 'hour' : 'minute'
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: display }).format(sec / UNIT_SEC[unit])
}

/** `<input type="datetime-local">` value for an instant, in local time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function HistoryRangePicker({ value, onChange }: { value: PlayerRange; onChange: (range: PlayerRange) => void }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState('2')
  const [unit, setUnit] = useState<Unit>('hour')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [now, setNow] = useState('')
  const [error, setError] = useState<string | null>(null)

  const onOpenChange = (next: boolean) => {
    if (next) {
      // Seed the custom fields from the range in use.
      const { startMs, endMs } = rangeBounds(value)
      setFrom(toLocalInput(startMs))
      setTo(toLocalInput(endMs))
      setNow(toLocalInput(Date.now()))
      setError(null)
    }
    setOpen(next)
  }
  const pick = (range: PlayerRange) => {
    onChange(range)
    setOpen(false)
  }

  const applyLast = () => {
    const n = Number(count)
    const sec = Math.round(n * UNIT_SEC[unit])
    if (!Number.isFinite(n) || n <= 0 || sec * 1000 > MAX_RANGE_MS) {
      setError(t('view.playerRange.errNumber', { defaultValue: 'Enter an amount from 1 minute up to 31 days.' }))
      return
    }
    pick({ kind: 'last', sec: Math.max(60, sec) })
  }
  const applyBetween = () => {
    const a = new Date(from).getTime()
    const b = new Date(to).getTime()
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
      setError(t('view.playerRange.errOrder', { defaultValue: 'The end must be after the start.' }))
      return
    }
    if (b - a > MAX_RANGE_MS) {
      setError(t('view.playerRange.errSpan', { defaultValue: 'A range can cover at most 31 days.' }))
      return
    }
    if (a > Date.now()) {
      setError(t('view.playerRange.errFuture', { defaultValue: 'The start is in the future.' }))
      return
    }
    pick({ kind: 'between', from: a, to: b })
  }

  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  const label =
    value.kind === 'last'
      ? t('view.playerRange.last', { span: spanLabel(value.sec, locale), defaultValue: 'Last {{span}}' })
      : `${fmt.format(value.from)} – ${fmt.format(value.to)}`
  const title = t('view.playerRange.title', { defaultValue: 'Time range' })

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 max-w-[16rem] shrink-0 gap-1 bg-background/70 px-2 text-[11px] font-normal"
          title={title}
          aria-label={`${title}: ${label}`}
        >
          <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 max-w-[calc(100vw-1.5rem)] space-y-3 p-3">
        <p className="text-sm font-medium">{title}</p>

        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label={t('view.playerRange.quick', { defaultValue: 'Quick ranges' })}>
          {QUICK_SPANS.map((sec) => {
            const on = value.kind === 'last' && value.sec === sec
            return (
              <Button
                key={sec}
                type="button"
                size="sm"
                variant={on ? 'secondary' : 'ghost'}
                aria-pressed={on}
                className={cn('h-7 text-xs', on && 'font-semibold')}
                onClick={() => pick({ kind: 'last', sec })}
              >
                {spanLabel(sec, locale)}
              </Button>
            )
          })}
        </div>

        <div className="space-y-1.5 border-t pt-3">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="history-range-count">
            {t('view.playerRange.lastN', { defaultValue: 'Last…' })}
          </label>
          <div className="flex items-center gap-1.5">
            <Input
              id="history-range-count"
              type="number"
              min={1}
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyLast()}
              className="h-8 w-20 text-sm"
            />
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as Unit)}
              aria-label={t('view.playerRange.unit', { defaultValue: 'Unit' })}
              className="h-8 flex-1 rounded-md border bg-background px-2 text-sm"
            >
              <option value="minute">{t('view.playerRange.minutes', { defaultValue: 'minutes' })}</option>
              <option value="hour">{t('view.playerRange.hours', { defaultValue: 'hours' })}</option>
              <option value="day">{t('view.playerRange.days', { defaultValue: 'days' })}</option>
            </select>
            <Button type="button" size="sm" variant="outline" className="h-8" onClick={applyLast}>
              {t('view.playerRange.apply', { defaultValue: 'Apply' })}
            </Button>
          </div>
        </div>

        <div className="space-y-1.5 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">{t('view.playerRange.custom', { defaultValue: 'Custom range' })}</p>
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
            <label htmlFor="history-range-from" className="text-xs">
              {t('view.playerRange.from', { defaultValue: 'From' })}
            </label>
            <Input id="history-range-from" type="datetime-local" value={from} max={now} onChange={(e) => setFrom(e.target.value)} className="h-8 text-sm" />
            <label htmlFor="history-range-to" className="text-xs">
              {t('view.playerRange.to', { defaultValue: 'To' })}
            </label>
            <Input id="history-range-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-sm" />
          </div>
          <Button type="button" size="sm" className="h-8 w-full" onClick={applyBetween}>
            {t('view.playerRange.play', { defaultValue: 'Play this range' })}
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
