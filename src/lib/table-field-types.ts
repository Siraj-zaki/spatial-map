/**
 * The field-type catalogue for user-defined tables — one source of truth
 * for the schema builder's picker, the record grid's cell renderer, and
 * the row create/edit forms.
 *
 * The backend stores `data_type` as unconstrained TEXT and validates it
 * with an `oneof` tag (`handlers/tables.go`), so this list and that tag
 * must be extended together. Nothing here reaches the database as a
 * column type — payloads stay JSONB, and the type decides how a value is
 * entered, coerced on the way in, and displayed on the way out.
 *
 * Coercion is a client-side convenience, not a trust boundary: rows
 * written through the public token API bypass it entirely.
 */

import {
  AlignLeft,
  AtSign,
  Braces,
  Calendar,
  CalendarClock,
  Clock,
  Fingerprint,
  Hash,
  Link,
  Phone,
  Sigma,
  ToggleLeft,
  Type,
} from 'lucide-react'
import type { FieldDataType } from '@/lib/tables-client'

export type FieldTypeGroup = 'text' | 'numeric' | 'boolean' | 'temporal' | 'structured'

export interface FieldTypeMeta {
  value: FieldDataType
  group: FieldTypeGroup
  icon: typeof Type
  labelKey: string
  labelFallback: string
  /** `<input type>` for the row editors. `textarea` and `select` are handled specially. */
  inputType: 'text' | 'number' | 'email' | 'url' | 'tel' | 'date' | 'datetime-local' | 'time' | 'textarea' | 'select'
  /** Shown as the input placeholder — a shape hint, not a translated string. */
  hint: string
}

export const FIELD_TYPE_GROUPS: Array<{ group: FieldTypeGroup; labelKey: string; labelFallback: string }> = [
  { group: 'text', labelKey: 'tables.fieldTypes.groupText', labelFallback: 'Text' },
  { group: 'numeric', labelKey: 'tables.fieldTypes.groupNumeric', labelFallback: 'Numeric' },
  { group: 'boolean', labelKey: 'tables.fieldTypes.groupBoolean', labelFallback: 'Boolean' },
  { group: 'temporal', labelKey: 'tables.fieldTypes.groupTemporal', labelFallback: 'Date & time' },
  { group: 'structured', labelKey: 'tables.fieldTypes.groupStructured', labelFallback: 'Structured' },
]

export const FIELD_DATA_TYPES: FieldTypeMeta[] = [
  { value: 'text', group: 'text', icon: Type, labelKey: 'tables.fieldTypes.text', labelFallback: 'Text', inputType: 'text', hint: 'Aisle A' },
  { value: 'longtext', group: 'text', icon: AlignLeft, labelKey: 'tables.fieldTypes.longtext', labelFallback: 'Long text', inputType: 'textarea', hint: 'Notes…' },
  { value: 'email', group: 'text', icon: AtSign, labelKey: 'tables.fieldTypes.email', labelFallback: 'Email', inputType: 'email', hint: 'name@example.com' },
  { value: 'url', group: 'text', icon: Link, labelKey: 'tables.fieldTypes.url', labelFallback: 'URL', inputType: 'url', hint: 'https://example.com' },
  { value: 'phone', group: 'text', icon: Phone, labelKey: 'tables.fieldTypes.phone', labelFallback: 'Phone', inputType: 'tel', hint: '+1 555 0100' },
  { value: 'uuid', group: 'text', icon: Fingerprint, labelKey: 'tables.fieldTypes.uuid', labelFallback: 'UUID', inputType: 'text', hint: '00000000-0000-4000-8000-000000000000' },
  { value: 'number', group: 'numeric', icon: Hash, labelKey: 'tables.fieldTypes.number', labelFallback: 'Number', inputType: 'number', hint: '12.5' },
  { value: 'integer', group: 'numeric', icon: Sigma, labelKey: 'tables.fieldTypes.integer', labelFallback: 'Integer', inputType: 'number', hint: '42' },
  { value: 'boolean', group: 'boolean', icon: ToggleLeft, labelKey: 'tables.fieldTypes.boolean', labelFallback: 'Boolean', inputType: 'select', hint: 'true' },
  { value: 'date', group: 'temporal', icon: Calendar, labelKey: 'tables.fieldTypes.date', labelFallback: 'Date', inputType: 'date', hint: '2026-08-12' },
  { value: 'datetime', group: 'temporal', icon: CalendarClock, labelKey: 'tables.fieldTypes.datetime', labelFallback: 'Date & time', inputType: 'datetime-local', hint: '2026-08-12T14:30' },
  { value: 'time', group: 'temporal', icon: Clock, labelKey: 'tables.fieldTypes.time', labelFallback: 'Time', inputType: 'time', hint: '14:30' },
  { value: 'json', group: 'structured', icon: Braces, labelKey: 'tables.fieldTypes.json', labelFallback: 'JSON', inputType: 'textarea', hint: '{ "key": "value" }' },
]

const BY_VALUE = new Map(FIELD_DATA_TYPES.map((t) => [t.value, t]))

/** Falls back to `text` so a type written by an older/newer client still renders. */
export function fieldTypeMeta(dataType: string): FieldTypeMeta {
  return BY_VALUE.get(dataType as FieldDataType) ?? BY_VALUE.get('text')!
}

export type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; messageKey: string; messageFallback: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/

function bad(messageKey: string, messageFallback: string): CoerceResult {
  return { ok: false, messageKey, messageFallback }
}

/**
 * Raw input string → the JSON value stored in the row payload.
 *
 * An empty string always yields `null` — "cleared", which the required
 * check downstream then rejects if the field is mandatory. Callers
 * translate `messageKey` and prefix it with the field's label.
 */
export function coerceFieldValue(dataType: string, raw: string): CoerceResult {
  const s = raw.trim()
  if (s === '') return { ok: true, value: null }

  switch (dataType) {
    case 'number': {
      const n = Number(s)
      if (!Number.isFinite(n)) return bad('tables.fieldTypes.invalidNumber', 'must be a number')
      return { ok: true, value: n }
    }
    case 'integer': {
      const n = Number(s)
      if (!Number.isFinite(n)) return bad('tables.fieldTypes.invalidNumber', 'must be a number')
      if (!Number.isInteger(n)) return bad('tables.fieldTypes.invalidInteger', 'must be a whole number')
      return { ok: true, value: n }
    }
    case 'boolean':
      return { ok: true, value: s === 'true' || s === '1' }
    case 'date':
      if (!DATE_RE.test(s)) return bad('tables.fieldTypes.invalidDate', 'must be a date (YYYY-MM-DD)')
      return { ok: true, value: s }
    case 'time':
      if (!TIME_RE.test(s)) return bad('tables.fieldTypes.invalidTime', 'must be a time (HH:MM)')
      return { ok: true, value: s }
    case 'datetime': {
      const d = new Date(s)
      if (Number.isNaN(d.getTime())) return bad('tables.fieldTypes.invalidDatetime', 'must be a valid date and time')
      return { ok: true, value: d.toISOString() }
    }
    case 'json':
      try {
        return { ok: true, value: JSON.parse(s) }
      } catch {
        return bad('tables.fieldTypes.invalidJson', 'must be valid JSON')
      }
    case 'email':
      if (!EMAIL_RE.test(s)) return bad('tables.fieldTypes.invalidEmail', 'must be an email address')
      return { ok: true, value: s }
    case 'url':
      try {
        new URL(s)
      } catch {
        return bad('tables.fieldTypes.invalidUrl', 'must be a URL (including https://)')
      }
      return { ok: true, value: s }
    case 'uuid':
      if (!UUID_RE.test(s)) return bad('tables.fieldTypes.invalidUuid', 'must be a UUID')
      return { ok: true, value: s }
    default:
      return { ok: true, value: raw }
  }
}

/**
 * Stored value → the string an `<input>` of this type will accept.
 * `datetime-local` refuses a full ISO string, hence the slice.
 */
export function fieldValueToInput(dataType: string, raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  if (dataType === 'json') {
    return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
  }
  if (dataType === 'datetime') {
    const d = new Date(String(raw))
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
  }
  return String(raw)
}

/** Stored value → the text shown in a grid cell. `locale` drives temporal formatting. */
export function formatFieldValue(dataType: string, raw: unknown, locale: string): string {
  if (raw === undefined || raw === null) return ''
  switch (dataType) {
    case 'boolean':
      return raw ? 'true' : 'false'
    case 'json':
      return typeof raw === 'string' ? raw : JSON.stringify(raw)
    case 'datetime': {
      const d = new Date(String(raw))
      if (Number.isNaN(d.getTime())) break
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d)
    }
    case 'date': {
      const d = new Date(`${String(raw)}T00:00:00`)
      if (Number.isNaN(d.getTime())) break
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(d)
    }
    default:
      break
  }
  return String(raw)
}

/** Cells whose content reads better in a monospace column. */
export function isMonospaceType(dataType: string): boolean {
  return (
    dataType === 'number' ||
    dataType === 'integer' ||
    dataType === 'boolean' ||
    dataType === 'uuid' ||
    dataType === 'json' ||
    dataType === 'time'
  )
}

/**
 * A realistic example value for a field type, typed as the API expects it
 * (numbers as numbers, booleans as booleans). Used by the create-page
 * payload preview and the generated API examples, so docs never show a
 * bare "value" for a number column.
 */
export function sampleFieldValue(dataType: string): unknown {
  const meta = fieldTypeMeta(dataType)
  switch (meta.value) {
    case 'number':
      return 12.5
    case 'integer':
      return 42
    case 'boolean':
      return true
    case 'json':
      return { key: 'value' }
    case 'datetime':
      return '2026-08-12T14:30:00Z'
    default:
      return meta.hint
  }
}
