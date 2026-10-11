/**
 * Starter field sets for a user-defined table, derived from the entity
 * kind the user picks in the create form.
 *
 * A table created through the SPA and a source ingested from a file or a
 * REST poll both end up in `data_source_rows`, and the layer editor can
 * not tell them apart — it reads the payload. So a hand-built "Marker /
 * POI" table has to carry the same payload keys the marker sample file
 * ships, or every downstream feature that keys off a name (the v3
 * editor's `suggestField()` coordinate auto-detect, external-code match,
 * attribute joins on `linked_shape_name`) silently finds nothing.
 *
 * `SAMPLE_SPECS` is the source of truth rather than a fourth hand-kept
 * per-kind table: it already backs the sample downloads the user is
 * comparing against, so the two can not drift.
 *
 * The ingest side keeps the whole row: `writeOneRow`
 * (backend/internal/handlers/import_pipeline.go) marshals the raw
 * columns as the payload and derives `entity_key` / `position` /
 * `linked_shape_name` *in addition*. That is why `external_code` and
 * `lng`/`lat` are seeded as ordinary fields even though a row also
 * carries a first-class entity key and position.
 *
 * Labels are English. They are pre-filled into editable inputs and
 * become `table_field_definitions.field_label` — row data, not UI
 * chrome — so translating at seed time would freeze whichever language
 * the creator happened to be using and show it to everyone else.
 */

import type { DataSourceEntityKind } from '@/lib/db'
import type { FieldDataType, FieldDefinitionResponse } from '@/lib/tables-client'
import { type SampleFieldType, sampleSpecFor } from '@/lib/data-link/sample-records'

export interface StarterField {
  fieldKey: string
  fieldLabel: string
  dataType: FieldDataType
  isRequired: boolean
  isUnique: boolean
  /** Why the field is here — shown in the "add missing" affordance. */
  description: string
}

const TYPE_MAP: Record<SampleFieldType, FieldDataType> = {
  string: 'text',
  integer: 'integer',
  number: 'number',
  boolean: 'boolean',
  timestamp: 'datetime',
  latitude: 'number',
  longitude: 'number',
  // No enum type exists; the allowed values live in the description.
  enum: 'text',
}

/** Words that read wrong in sentence case. */
const ACRONYMS = new Set(['id', 'url', 'sku', 'rssi', 'fov', 'eta', 'epc', 'api', 'gps'])

/** Keys the generic humaniser can't do justice to, plus type refinements. */
const OVERRIDES: Record<string, { label: string; dataType?: FieldDataType }> = {
  external_code: { label: 'External code' },
  lng: { label: 'Longitude' },
  lat: { label: 'Latitude' },
  ts: { label: 'Timestamp' },
  eta_at: { label: 'ETA' },
  yaw: { label: 'Yaw (degrees)' },
  fov_deg: { label: 'Field of view (degrees)' },
  view_distance_m: { label: 'View distance (m)' },
  radius_m: { label: 'Radius (m)' },
  rssi: { label: 'RSSI (dBm)' },
  col: { label: 'Column' },
  kind: { label: 'Sensor kind' },
  stream_url: { label: 'Stream URL', dataType: 'url' },
  notes: { label: 'Notes', dataType: 'longtext' },
  message: { label: 'Message', dataType: 'longtext' },
}

function humanize(key: string): string {
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w, i) =>
      ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w,
    )
    .join(' ')
}

/**
 * The starter schema for a kind, in the order the sample file's columns
 * appear. `custom.*` columns are dropped — they demonstrate the
 * `prop.*` mapping and a dot doesn't survive the form's key slug.
 */
export function starterFieldsForKind(kind: DataSourceEntityKind): StarterField[] {
  return sampleSpecFor(kind)
    .fields.filter((f) => !f.name.startsWith('custom.'))
    .map((f) => {
      const override = OVERRIDES[f.name]
      const enumHint =
        f.enumValues && f.enumValues.length > 0 ? ` One of: ${f.enumValues.join(', ')}.` : ''
      return {
        fieldKey: f.name,
        fieldLabel: override?.label ?? humanize(f.name),
        dataType: override?.dataType ?? TYPE_MAP[f.type],
        isRequired: f.required === true,
        // The upsert key: two rows sharing it are the same entity.
        isUnique: f.name === 'external_code',
        description: f.description + enumHint,
      }
    })
}

/** Starter fields the schema doesn't already declare, by key. */
export function missingStarterFields(
  kind: DataSourceEntityKind,
  presentKeys: readonly string[],
): StarterField[] {
  const present = new Set(presentKeys.map((k) => k.trim().toLowerCase()))
  return starterFieldsForKind(kind).filter((f) => !present.has(f.fieldKey))
}

// -------------------------------------------------- built-in derivation

/**
 * Payload keys that can stand in for the row's `entity_key`, in priority
 * order. Mirrors `rowEntityKey`'s fallback list in
 * backend/internal/handlers/import_pipeline.go so a row typed into the
 * SPA gets the same key an imported row would.
 */
const IDENTITY_KEYS = ['external_code', 'externalcode', 'id', 'name'] as const

/** Mirrors `rowCoord`'s column names in import_pipeline.go. */
const LNG_KEYS = ['lng', 'longitude', 'long', 'x'] as const
const LAT_KEYS = ['lat', 'latitude', 'y'] as const

function findByKeys(
  fields: readonly FieldDefinitionResponse[],
  keys: readonly string[],
): FieldDefinitionResponse | null {
  for (const want of keys) {
    const hit = fields.find((f) => f.fieldKey.trim().toLowerCase() === want)
    if (hit) return hit
  }
  return null
}

/**
 * The field whose value doubles as the row's entity key, or null when
 * the schema declares none and the key must be asked for separately.
 */
export function identityField(
  fields: readonly FieldDefinitionResponse[],
): FieldDefinitionResponse | null {
  return findByKeys(fields, IDENTITY_KEYS)
}

/** The lng/lat pair that populates the row's `position`, when both exist. */
export function coordFields(
  fields: readonly FieldDefinitionResponse[],
): { lng: FieldDefinitionResponse; lat: FieldDefinitionResponse } | null {
  const lng = findByKeys(fields, LNG_KEYS)
  const lat = findByKeys(fields, LAT_KEYS)
  return lng && lat ? { lng, lat } : null
}
