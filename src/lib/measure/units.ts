/**
 * Measurement display units for the drafting tools (live dimensions,
 * ruler, guides, typed lengths, image calibration).
 *
 * Kept separate from `LengthUnit` (lib/units.ts) on purpose: that type is
 * stamped onto every saved shape and drives the property inputs, so adding
 * cm / mm / in / feet-and-inches there would ripple through every picker.
 * Measurement units are display-only — geometry is always stored in metres.
 */

import type { LengthUnit } from '@/lib/units'

export type MeasureUnit = 'm' | 'cm' | 'mm' | 'ft' | 'in' | 'ft-in' | 'yd'

export const MEASURE_UNITS: MeasureUnit[] = ['m', 'cm', 'mm', 'ft', 'in', 'ft-in', 'yd']

export type AreaUnit = 'm2' | 'ft2' | 'yd2'

export const AREA_UNITS: AreaUnit[] = ['m2', 'ft2', 'yd2']

const METERS_PER: Record<Exclude<MeasureUnit, 'ft-in'>, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  ft: 0.3048,
  in: 0.0254,
  yd: 0.9144,
}

const SQ_METERS_PER: Record<AreaUnit, number> = {
  m2: 1,
  ft2: 0.09290304,
  yd2: 0.83612736,
}

export const AREA_SUFFIX: Record<AreaUnit, string> = {
  m2: 'm²',
  ft2: 'ft²',
  yd2: 'yd²',
}

/** Area unit that pairs with a length unit (rooms read in m² or ft²). */
export function areaUnitFor(unit: MeasureUnit): AreaUnit {
  if (unit === 'ft' || unit === 'in' || unit === 'ft-in') return 'ft2'
  if (unit === 'yd') return 'yd2'
  return 'm2'
}

/** Closest measurement unit to the editor's shape unit. */
export function measureUnitFromLength(unit: LengthUnit): MeasureUnit {
  if (unit === 'ft' || unit === 'mi') return 'ft'
  if (unit === 'yd') return 'yd'
  return 'm'
}

function trimZeros(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

/** "12' 6½"" style — rounded to the nearest 1/8 inch. */
function formatFeetInches(meters: number): string {
  const sign = meters < 0 ? '-' : ''
  const totalEighths = Math.round(Math.abs(meters) / 0.0254 * 8)
  const feet = Math.floor(totalEighths / 96)
  const restEighths = totalEighths - feet * 96
  const inches = Math.floor(restEighths / 8)
  const eighths = restEighths % 8
  const FRACTIONS = ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞']
  return `${sign}${feet}′ ${inches}${FRACTIONS[eighths]}″`
}

export function formatMeasureLength(meters: number, unit: MeasureUnit): string {
  if (!Number.isFinite(meters)) return '—'
  if (unit === 'ft-in') return formatFeetInches(meters)
  const value = meters / METERS_PER[unit]
  const decimals = unit === 'mm' ? 0 : unit === 'cm' || unit === 'in' ? 1 : 2
  return `${trimZeros(value.toFixed(decimals))} ${unit}`
}

export function formatMeasureArea(sqMeters: number, unit: AreaUnit): string {
  if (!Number.isFinite(sqMeters)) return '—'
  const value = sqMeters / SQ_METERS_PER[unit]
  const decimals = value < 100 ? 2 : 1
  return `${trimZeros(value.toFixed(decimals))} ${AREA_SUFFIX[unit]}`
}

export function toSquareMeters(value: number, unit: AreaUnit): number {
  return value * SQ_METERS_PER[unit]
}

export function toMetersFrom(value: number, unit: MeasureUnit): number {
  return value * METERS_PER[unit === 'ft-in' ? 'ft' : unit]
}

/** Parse a decimal that may use a comma separator ("3,5" in de/fr/…). */
function parseDecimal(raw: string): number | null {
  const s = raw.trim().replace(',', '.')
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const SUFFIX_UNITS: Array<[RegExp, Exclude<MeasureUnit, 'ft-in'>]> = [
  [/^(mm)$/, 'mm'],
  [/^(cm)$/, 'cm'],
  [/^(m)$/, 'm'],
  [/^(ft|feet|foot|')$/, 'ft'],
  [/^(in|inch|inches|")$/, 'in'],
  [/^(yd|yds)$/, 'yd'],
]

/**
 * Parse a typed length into metres. Accepts a bare number (read in
 * `fallback`), a number with a unit ("350cm", "3.5 m", "12ft"), and
 * feet + inches ("12'6", "12' 6\"", "12ft 6in"). Returns null when the
 * text isn't a positive length.
 */
export function parseLengthInput(text: string, fallback: MeasureUnit): number | null {
  const s = text.trim().toLowerCase()
  if (!s) return null
  // Feet + inches: 12'6, 12' 6", 12ft 6in, 12ft6
  const fi = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:'|ft|feet|foot)\s*(\d+(?:[.,]\d+)?)\s*(?:"|in|inch|inches)?$/)
  if (fi) {
    const ft = parseDecimal(fi[1])
    const inch = parseDecimal(fi[2])
    if (ft === null || inch === null) return null
    const m = ft * METERS_PER.ft + inch * METERS_PER.in
    return m > 0 ? m : null
  }
  const single = s.match(/^(\d*[.,]?\d+|\d+[.,])\s*([a-z'"]*)$/)
  if (!single) return null
  const value = parseDecimal(single[1])
  if (value === null) return null
  let unit: Exclude<MeasureUnit, 'ft-in'> = fallback === 'ft-in' ? 'ft' : fallback
  if (single[2]) {
    const hit = SUFFIX_UNITS.find(([re]) => re.test(single[2]))
    if (!hit) return null
    unit = hit[1]
  }
  const m = value * METERS_PER[unit]
  return m > 0 ? m : null
}

/** Characters a typed length can contain (digits, separators, unit letters). */
export function isLengthInputChar(key: string, started: boolean): boolean {
  if (key.length !== 1) return false
  if (/[0-9.,]/.test(key)) return true
  // Unit letters and quote marks only once a number has been started, so
  // the tool-switch letters (m, c, f, …) still work with an empty buffer.
  return started && /[mcftinyd'" ]/i.test(key)
}
