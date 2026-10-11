/**
 * Length-unit conversions for the editor.
 *
 * All geometry under the hood is stored in METERS. These helpers convert
 * between meters (storage) and the user's chosen display unit. There is one
 * global default unit (persisted via `db.settings`), and each saved shape
 * also stamps its own unit at draw time so revisiting a "50 × 100 ft" plot
 * never re-formats itself just because the global preference changed.
 */

export type LengthUnit = 'm' | 'ft' | 'yd' | 'km' | 'mi'

export const LENGTH_UNITS: LengthUnit[] = ['m', 'ft', 'yd', 'km', 'mi']

/** Meters per 1 unit. Multiply unit → meters; divide meters → unit. */
const METERS_PER_UNIT: Record<LengthUnit, number> = {
  m: 1,
  ft: 0.3048,
  yd: 0.9144,
  km: 1000,
  mi: 1609.344,
}

/** Suggested input step (in the unit) so increments feel natural. */
const STEP_PER_UNIT: Record<LengthUnit, number> = {
  m: 0.1,
  ft: 0.5,
  yd: 0.25,
  km: 0.01,
  mi: 0.01,
}

/** Default decimal places when formatting for display. */
const DECIMALS_PER_UNIT: Record<LengthUnit, number> = {
  m: 2,
  ft: 2,
  yd: 2,
  km: 3,
  mi: 3,
}

/** Short suffix shown in the UI. */
export const UNIT_SUFFIX: Record<LengthUnit, string> = {
  m: 'm',
  ft: 'ft',
  yd: 'yd',
  km: 'km',
  mi: 'mi',
}

export function toMeters(value: number, unit: LengthUnit): number {
  return value * METERS_PER_UNIT[unit]
}

export function fromMeters(meters: number, unit: LengthUnit): number {
  return meters / METERS_PER_UNIT[unit]
}

/** Convert between two units, going through meters as the canonical form. */
export function convert(value: number, from: LengthUnit, to: LengthUnit): number {
  if (from === to) return value
  return fromMeters(toMeters(value, from), to)
}

export function stepFor(unit: LengthUnit): number {
  return STEP_PER_UNIT[unit]
}

export function decimalsFor(unit: LengthUnit): number {
  return DECIMALS_PER_UNIT[unit]
}

/**
 * Format a meters value in the given unit. Trailing zeros are stripped so
 * "10.00 m" renders as "10 m" but "10.25 m" stays "10.25 m".
 */
export function formatLength(
  meters: number,
  unit: LengthUnit,
  opts?: { decimals?: number; withSuffix?: boolean }
): string {
  const decimals = opts?.decimals ?? decimalsFor(unit)
  const withSuffix = opts?.withSuffix ?? true
  const value = fromMeters(meters, unit)
  const fixed = value.toFixed(decimals)
  // Strip trailing zeros after the decimal point (and the dot if empty).
  const trimmed = fixed.includes('.')
    ? fixed.replace(/\.?0+$/, '')
    : fixed
  return withSuffix ? `${trimmed} ${UNIT_SUFFIX[unit]}` : trimmed
}

/**
 * Pick a sensible default unit from a BCP-47 language tag.
 * US/Liberia/Myanmar use imperial — everyone else metric.
 */
export function defaultUnitForLocale(locale: string | undefined): LengthUnit {
  if (!locale) return 'm'
  const lower = locale.toLowerCase()
  if (lower === 'en-us' || lower.startsWith('en-us-') || lower === 'en') {
    // Plain "en" defaults to feet under the assumption that the global
    // English locale is most often used in US-flavored real-estate; users
    // outside the US can flip the picker once and we'll persist it.
    return 'ft'
  }
  return 'm'
}
