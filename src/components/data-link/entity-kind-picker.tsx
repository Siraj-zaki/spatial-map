/**
 * EntityKindPicker — used on every /integrations Add-source dialog to
 * tag the connection with what kind of data it produces. See
 * DESIGN-integrations-v3.md §3.1 + §6.
 *
 * Advisory only — the backend accepts any of the 10 values without
 * validation. The picker's job is to make the choice explicit up-front
 * so the layer editor can:
 *   - Filter/prioritise sources by kind
 *   - Pre-fill the default match strategy
 *   - Pre-fill the default render mode
 *
 * Also exports `validateColumnsForKind()` — a warning-generator the
 * validate step surfaces per row.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import type { DataSourceEntityKind } from '@/lib/db'
import { SampleDownloadMenu } from '@/components/data-link/sample-download-menu'

interface KindDef {
  kind: DataSourceEntityKind
  label: string
  hint: string
  /** Columns the wizard should surface as required warnings if absent. */
  required?: string[]
  /** Columns the wizard should surface as recommended (soft warning). */
  recommended?: string[]
}

/**
 * Full manifest. Column names use the un-slugged (user-facing) form — the
 * validator normalises for comparison so `room_name` and `roomname` match.
 */
export const ENTITY_KIND_DEFS: readonly KindDef[] = [
  {
    kind: 'polygon',
    label: 'Polygon / area',
    hint: 'Rows describe named rooms or zones (e.g. HVAC alarms, occupancy). Matched to polygon shapes by name.',
    required: ['external_code'],
    recommended: ['linked_shape_name', 'availability', 'department', 'notes'],
  },
  {
    kind: 'circle',
    label: 'Circle',
    hint: 'Rows describe circular regions (e.g. wash-down zones). Matched to circles by name.',
    required: ['external_code'],
    recommended: ['linked_shape_name', 'notes'],
  },
  {
    kind: 'marker',
    label: 'Marker / POI',
    hint: 'Rows are points of interest. Coordinates spawn markers if not already present.',
    required: ['external_code'],
    recommended: ['lng', 'lat', 'linked_shape_name', 'role', 'marker_state'],
  },
  {
    kind: 'asset',
    label: 'Asset (mobile)',
    hint: 'Rows are mobile equipment with positions + operational status.',
    required: ['external_code'],
    recommended: ['lng', 'lat', 'op_status', 'sku', 'notes'],
  },
  {
    kind: 'camera',
    label: 'Camera',
    hint: 'Fixed cameras with pose + field-of-view. Requires yaw / fov / distance for FOV cone.',
    required: ['external_code', 'yaw', 'fov_deg', 'view_distance_m'],
    recommended: ['link_status', 'linked_shape_name', 'stream_url'],
  },
  {
    kind: 'sensor',
    label: 'Sensor (fixed monitor)',
    hint: 'Sensors with value + unit + optional threshold band.',
    required: ['external_code', 'kind', 'unit'],
    recommended: ['value', 'threshold_min', 'threshold_max', 'health_status', 'linked_shape_name'],
  },
  {
    kind: 'shipment',
    label: 'Shipment',
    hint: 'State-machine rows for inbound/outbound freight.',
    required: ['external_code', 'state'],
    recommended: ['carrier', 'eta_at', 'linked_shape_name'],
  },
  {
    kind: 'rfid-tag',
    label: 'RFID tag',
    hint: 'Position + tag_state per read. Heatmap and track are the common render modes.',
    required: ['external_code'],
    recommended: ['lng', 'lat', 'tag_state', 'antenna_id', 'rssi'],
  },
  {
    kind: 'rack-cell',
    label: 'Rack cell (bin)',
    hint: 'WMS rack rows — write to the bins table. The only kind that keeps the legacy bin path.',
    required: ['external_code'],
    recommended: ['sku', 'capacity', 'status', 'notes'],
  },
  {
    kind: 'streaming',
    label: 'Streaming / batch replay',
    hint: 'Event log rows for correlation testing (each row is a discrete event).',
    required: ['external_code'],
    recommended: ['lng', 'lat', 'ts'],
  },
]

const KIND_BY_KEY = new Map(ENTITY_KIND_DEFS.map((d) => [d.kind, d]))

function normaliseColumn(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Given the file's column list, return per-kind warnings for the user
 * to review in the Validate step. Empty warnings = ready to save.
 */
export function validateColumnsForKind(
  kind: DataSourceEntityKind,
  columns: readonly string[],
): { missingRequired: string[]; missingRecommended: string[] } {
  const def = KIND_BY_KEY.get(kind)
  if (!def) return { missingRequired: [], missingRecommended: [] }
  const cols = new Set(columns.map(normaliseColumn))
  const missingRequired = (def.required ?? []).filter((c) => !cols.has(normaliseColumn(c)))
  const missingRecommended = (def.recommended ?? []).filter((c) => !cols.has(normaliseColumn(c)))
  return { missingRequired, missingRecommended }
}

// ---------------------------------------------------------------- UI

export interface EntityKindPickerProps {
  value: DataSourceEntityKind
  onChange: (kind: DataSourceEntityKind) => void
  /** Optional: the file's column list — used to preview validation. */
  columns?: readonly string[]
  /** Hide the rack-cell option when the surface is not for WMS imports. */
  hideRackCell?: boolean
  /** Custom label above the dropdown (defaults to the translated question). */
  label?: string
}

export function EntityKindPicker({
  value,
  onChange,
  columns,
  hideRackCell = false,
  label,
}: EntityKindPickerProps) {
  const { t } = useTranslation()
  const options = useMemo(
    () => ENTITY_KIND_DEFS.filter((d) => !(hideRackCell && d.kind === 'rack-cell')),
    [hideRackCell],
  )
  const current = KIND_BY_KEY.get(value) ?? options[0]
  const validation = useMemo(
    () => (columns ? validateColumnsForKind(value, columns) : null),
    [value, columns],
  )
  const kindLabel = (k: string, fallback: string) => t(`integrations.entityKind_${k.replace(/-/g, '_')}`, { defaultValue: fallback })

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium">{label ?? t('tables.create.kindLabel', { defaultValue: 'What kind of data is this?' })}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as DataSourceEntityKind)}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
      >
        {options.map((opt) => (
          <option key={opt.kind} value={opt.kind}>
            {kindLabel(opt.kind, opt.label)}
          </option>
        ))}
      </select>
      <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <Info className="h-3 w-3 mt-0.5 shrink-0" />
        <span>{t(`integrations.entityKindHint_${current.kind.replace(/-/g, '_')}`, { defaultValue: current.hint })}</span>
      </div>

      <div className="flex justify-end">
        <SampleDownloadMenu kind={value} size="sm" />
      </div>

      {validation && validation.missingRequired.length > 0 && (
        <div className="text-[11px] rounded border border-danger/40 bg-danger/5 p-2">
          <div className="font-medium text-danger mb-1">
            {t('integrations.kindMissingRequired', { defaultValue: 'Missing required columns:', count: validation.missingRequired.length })}
          </div>
          <div className="text-danger/80 font-mono" dir="ltr">{validation.missingRequired.join(', ')}</div>
        </div>
      )}

      {validation && validation.missingRequired.length === 0 && validation.missingRecommended.length > 0 && (
        <div className="text-[11px] rounded border border-warning/40 bg-warning/5 p-2">
          <div className="font-medium text-warning mb-1">
            {t('integrations.kindMissingRecommended', { defaultValue: 'Recommended columns not present (optional):' })}
          </div>
          <div className="text-warning/80 font-mono" dir="ltr">{validation.missingRecommended.join(', ')}</div>
        </div>
      )}

      {validation && validation.missingRequired.length === 0 && validation.missingRecommended.length === 0 && columns && columns.length > 0 && (
        <div className="text-[11px] rounded border border-success/40 bg-success/5 p-2 text-success">
          {t('integrations.kindAllPresent', { defaultValue: 'All expected columns are present for a {{kind}} source.', kind: kindLabel(current.kind, current.label) })}
        </div>
      )}
    </div>
  )
}
