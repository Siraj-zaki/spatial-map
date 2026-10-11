/**
 * Shared vocabulary for the Data screen: date-range presets, formatters,
 * and plain-language run results. Pure functions so the page, the tables,
 * the mobile lists and the record panel never disagree.
 */

import type { TFunction } from 'i18next'

export type DataTab = 'rows' | 'bins' | 'files' | 'runs'
export const DATA_TABS: DataTab[] = ['rows', 'bins', 'files', 'runs']

// ---- date range --------------------------------------------------------

/** Presets cover the common questions; `custom` opens two inputs. */
export type RangePreset = 'any' | '1h' | '24h' | '7d' | '30d' | 'custom'
export const RANGE_PRESETS: Exclude<RangePreset, 'custom'>[] = ['any', '1h', '24h', '7d', '30d']
const PRESET_MS: Record<'1h' | '24h' | '7d' | '30d', number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
}

/**
 * Resolve a preset to the ISO `from` the API takes. Rounded down to the
 * minute so the value (and the query cache key built from it) is stable
 * across re-renders within a minute.
 */
export function presetFrom(preset: RangePreset, now = Date.now()): string | undefined {
  if (preset === 'any' || preset === 'custom') return undefined
  const t = Math.floor((now - PRESET_MS[preset]) / 60_000) * 60_000
  return new Date(t).toISOString()
}

export function rangeLabel(preset: RangePreset, t: TFunction): string {
  switch (preset) {
    case 'any':
      return t('data.range.any', { defaultValue: 'Any time' })
    case '1h':
      return t('data.range.1h', { defaultValue: 'Last hour' })
    case '24h':
      return t('data.range.24h', { defaultValue: 'Last 24 hours' })
    case '7d':
      return t('data.range.7d', { defaultValue: 'Last 7 days' })
    case '30d':
      return t('data.range.30d', { defaultValue: 'Last 30 days' })
    case 'custom':
      return t('data.range.custom', { defaultValue: 'Custom range' })
  }
}

/** `YYYY-MM-DDTHH:mm` (what datetime-local inputs hold) → ISO, or undefined. */
export function localToISO(local: string | undefined): string | undefined {
  if (!local) return undefined
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

// ---- formatting ------------------------------------------------------

export function formatBytes(bytes: number | undefined, locale: string): string {
  if (!bytes) return '—'
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: units[i], unitDisplay: i === 0 ? 'narrow' : 'short', maximumFractionDigits: i >= 2 ? 1 : 0 }).format(v)
}

/** Compact absolute time for dense tables: omits the year when it's this year. */
export function formatStamp(iso: string | undefined, locale: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat(locale, sameYear ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { dateStyle: 'medium', timeStyle: 'short' }).format(d)
}

export function formatDuration(startIso: string | undefined, endIso: string | undefined, locale: string): string {
  if (!startIso || !endIso) return '—'
  const ms = Date.parse(endIso) - Date.parse(startIso)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const nf = (n: number, unit: 'second' | 'minute' | 'hour') => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow', maximumFractionDigits: unit === 'second' && n < 10 ? 1 : 0 }).format(n)
  if (ms < 60_000) return nf(ms / 1000, 'second')
  if (ms < 3_600_000) return nf(ms / 60_000, 'minute')
  return nf(ms / 3_600_000, 'hour')
}

/** A primitive rendered compactly for the payload preview. */
export function previewValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'object') return Array.isArray(v) ? `[${v.length}]` : '{…}'
  return String(v)
}

export function payloadEntries(payload: unknown): [string, unknown][] | null {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.entries(payload as Record<string, unknown>) : null
}

// ---- runs --------------------------------------------------------------

export type RunResult = 'succeeded' | 'partial' | 'failed' | 'running' | 'other'

export function runResult(status: string): RunResult {
  switch (status) {
    case 'ok':
    case 'success':
    case 'completed':
      return 'succeeded'
    case 'partial':
      return 'partial'
    case 'error':
    case 'failed':
      return 'failed'
    case 'running':
      return 'running'
    default:
      return 'other'
  }
}

export function runResultLabel(r: RunResult, raw: string, t: TFunction): string {
  switch (r) {
    case 'succeeded':
      return t('data.run.succeeded', { defaultValue: 'Succeeded' })
    case 'partial':
      return t('data.run.partial', { defaultValue: 'Partly failed' })
    case 'failed':
      return t('data.run.failed', { defaultValue: 'Failed' })
    case 'running':
      return t('data.run.running', { defaultValue: 'Running' })
    default:
      return raw || '—'
  }
}

export function runResultVariant(r: RunResult): 'success' | 'warning' | 'danger' | 'info' | 'muted' {
  return r === 'succeeded' ? 'success' : r === 'partial' ? 'warning' : r === 'failed' ? 'danger' : r === 'running' ? 'info' : 'muted'
}

/** The counts an import job records (`import_jobs.stats`). */
export interface RunCounts {
  read?: number
  imported?: number
  skipped?: number
  errored?: number
  matched?: number
}

export function runCounts(stats: unknown): RunCounts {
  const s = (stats && typeof stats === 'object' ? stats : {}) as Record<string, unknown>
  const n = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : undefined)
  return { read: n('rowsRead'), imported: n('rowsImported'), skipped: n('rowsSkipped'), errored: n('rowsErrored'), matched: n('rowsMatched') }
}
