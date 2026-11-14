/**
 * Built-in facility sources (backend: internal/reports/facility.go).
 *
 * A facility source reads a shape table live — areas, markers, racks,
 * floors, walls, doors, stairs/lifts/escalators, text labels, 3D models.
 * Each report row's `entity_key` is "<api-kind>:<id>" (e.g. "markers:57"),
 * so an edit or delete made in a report goes through the same shape API
 * the map editor uses (apiDb → notifySync + the server's SSE broadcast),
 * and any open map updates at once.
 *
 * The reports page has no map and no loaded spatial store, so this is the
 * one place outside the editor that writes shapes through apiDb directly
 * rather than the store's optimistic path (see docs/pitfalls-frontend.md).
 */

import { apiDb } from '@/lib/api-db'
import { formatFocusParam, parseFocusParam } from '@/lib/focus/focus-target'
import i18n from '@/i18n'

export const FACILITY_ENTITIES = [
  'floors', 'areas', 'racks', 'markers', 'walls', 'doors',
  'stairs', 'lifts', 'escalators', 'text-labels', 'models',
] as const
export type FacilityEntity = (typeof FACILITY_ENTITIES)[number]

/** Shape API kinds a facility row can point at. */
type FacilityApiKind = 'polygons' | 'markers' | 'grids' | 'images' | 'lines' | 'doors' | 'stairs' | 'text-labels' | 'models'

interface ShapeTable {
  get: (id: number) => Promise<{ config?: Record<string, unknown> } | undefined>
  update: (id: number, patch: Record<string, unknown>) => Promise<unknown>
  delete: (id: number) => Promise<void>
}

function tableFor(kind: FacilityApiKind): ShapeTable {
  const tables: Record<FacilityApiKind, unknown> = {
    polygons: apiDb.polygons,
    markers: apiDb.markers,
    grids: apiDb.grids,
    images: apiDb.images,
    lines: apiDb.lines,
    doors: apiDb.doors,
    stairs: apiDb.stairs,
    'text-labels': apiDb.textLabels,
    models: apiDb.models,
  }
  return tables[kind] as ShapeTable
}

/** "markers:57" → { kind: 'markers', id: 57 }; null for anything else. */
export function parseFacilityKey(key: string): { kind: FacilityApiKind; id: number } | null {
  const m = /^(polygons|markers|grids|images|lines|doors|stairs|text-labels|models):(\d+)$/.exec(key)
  return m ? { kind: m[1] as FacilityApiKind, id: Number(m[2]) } : null
}

/** Translated label for a facility column ("area_m2" → "Area (m²)"). */
export function facilityFieldLabel(key: string, fallback?: string): string {
  return i18n.t(`reports.facility.fields.${key}`, { defaultValue: fallback ?? key })
}

/** Translated name for a facility source ("text-labels" → "Text labels"). */
export function facilityEntityName(entity: string, fallback?: string): string {
  return i18n.t(`reports.facility.entities.${entity}`, { defaultValue: fallback ?? entity })
}

/**
 * Report column → where it lives on the shape. `field` columns are
 * top-level shape fields; `config` columns live in shape.config (merged,
 * never replaced). Only columns listed here can be written back.
 */
const WRITABLE: Record<string, { field: string } | { config: string }> = {
  name: { field: 'name' },
  visible: { field: 'visible' },
  color: { config: 'color' },
  icon: { config: 'icon' },
  label: { config: 'label' },
  text: { config: 'text' },
  height_m: { config: 'height' },
  thickness_m: { config: 'wallThickness' },
  elevation_m: { config: 'elevation' },
}
/** `type` is an area's role; for every other kind it's derived. */
const AREA_TYPE = { field: 'role' }

function targetFor(kind: FacilityApiKind, column: string) {
  if (column === 'type') return kind === 'polygons' ? AREA_TYPE : undefined
  return WRITABLE[column]
}

/** Whether a column can be written back for a shape kind. */
export function isFacilityColumnWritable(kind: FacilityApiKind, column: string): boolean {
  return targetFor(kind, column) !== undefined
}

/** Columns a facility source can write back, for the wizard's edit step. */
export function facilityWritableColumns(apiKind: string): string[] {
  const kind = apiKind as FacilityApiKind
  return [...Object.keys(WRITABLE), 'type'].filter((c) => isFacilityColumnWritable(kind, c))
}

/**
 * Write report-column values back to one shape. Config columns are
 * merged into the shape's current config so nothing else in it is lost.
 * Throws on a column that can't be written (the caller shows it).
 */
export async function writeFacilityRow(key: string, values: Record<string, unknown>): Promise<void> {
  const ref = parseFacilityKey(key)
  if (!ref) throw new Error(i18n.t('reports.facility.badKey', { defaultValue: 'This row has no shape to update.' }))
  const table = tableFor(ref.kind)
  const patch: Record<string, unknown> = {}
  const config: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(values)) {
    const target = targetFor(ref.kind, column)
    if (!target) {
      throw new Error(i18n.t('reports.facility.notWritable', {
        column: facilityFieldLabel(column),
        defaultValue: '"{{column}}" can\'t be changed from a report.',
      }))
    }
    if ('field' in target) patch[target.field] = target.field === 'role' && value === '' ? null : value
    else config[target.config] = value === '' ? undefined : value
  }
  // Racks also keep `visible` in config (the overlay reads both).
  if (ref.kind === 'grids' && 'visible' in patch) config.visible = patch.visible
  if (Object.keys(config).length > 0) {
    const current = await table.get(ref.id)
    if (!current) throw new Error(i18n.t('reports.facility.gone', { defaultValue: 'This item no longer exists — refresh the report.' }))
    const merged: Record<string, unknown> = { ...(current.config ?? {}) }
    for (const [k, v] of Object.entries(config)) {
      if (v === undefined) delete merged[k]
      else merged[k] = v
    }
    patch.config = merged
  }
  await table.update(ref.id, patch)
}

/** Floors can't be deleted from a report: deleting one removes its image
 *  and strands everything drawn on it, so that stays an editor action. */
export function isFacilityRowDeletable(key: string): boolean {
  const ref = parseFacilityKey(key)
  return ref !== null && ref.kind !== 'images'
}

export async function deleteFacilityRow(key: string): Promise<void> {
  const ref = parseFacilityKey(key)
  if (!ref || ref.kind === 'images') throw new Error(i18n.t('reports.facility.badKey', { defaultValue: 'This row has no shape to update.' }))
  await tableFor(ref.kind).delete(ref.id)
}

/** Map-editor deep link that opens the facility and selects the shape. */
export function facilityEditorHref(key: string, facilityId: number | null | undefined): string | null {
  const ref = parseFacilityKey(key)
  if (!ref || !facilityId) return null
  return `/create-grids?warehouseId=${facilityId}&select=${ref.kind}:${ref.id}`
}

/**
 * Read-only viewer deep link that opens the facility focused on the shape
 * (`?focus=`, src/lib/focus/focus-target.ts — the item is shown even when
 * something stands in front of it). Any shape key the focus grammar reads
 * ("markers:57", "images:3", "grids:5:2:3:0", …); null for anything else.
 */
export function facilityViewerHref(key: string, facilityId: number | null | undefined): string | null {
  if (!facilityId || !(facilityId > 0)) return null
  const target = parseFocusParam(key)
  if (!target || target.kind === 'dl') return null
  return `/view/${facilityId}?focus=${encodeURIComponent(formatFocusParam(target))}`
}

/** Viewer deep link focused on one linked-data record (its live symbol). */
export function facilityViewerDataHref(
  dataLinkId: number | null | undefined,
  entityKey: string | null | undefined,
  facilityId: number | null | undefined,
): string | null {
  if (!facilityId || !(facilityId > 0) || !dataLinkId || !(dataLinkId > 0) || !entityKey) return null
  const param = formatFocusParam({ kind: 'dl', configId: dataLinkId, entityKey })
  return `/view/${facilityId}?focus=${encodeURIComponent(param)}`
}
