/**
 * Locale-aware "3 days ago" / full timestamp pair for tables and lists.
 * `Intl` rather than translation keys so all six locales (and RTL Arabic)
 * read correctly for free. Show `relativeTime` in the cell and
 * `fullTime` in its `title` so the exact value is one hover away.
 */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

export function relativeTime(iso: string | undefined, locale: string): string {
  const then = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(then)) return '—'
  const seconds = Math.round((then - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit)
  }
  return rtf.format(0, 'minute')
}

export function fullTime(iso: string | undefined, locale: string): string {
  const then = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(then)) return ''
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(then)
}
