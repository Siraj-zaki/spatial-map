/**
 * Warehouse-aware sample augmentation.
 *
 * Takes a generic `SampleSpec` from `sample-records.ts` and returns a
 * tailored copy that reflects a specific warehouse's schema. The
 * augmented sample stays byte-identical in structure (same field
 * naming conventions, same record count) so downstream generators
 * (CSV / XLSX / JSON / GeoJSON) work unchanged — the difference is
 * only in the field list + values.
 *
 * Three augmentations run in order:
 *
 *   1. Attribute definitions → `custom.<key>` columns
 *      Every `AttributeDefinition` whose scope matches the entity
 *      kind (or `any`) becomes an extra field with plausible sample
 *      values seeded per-record based on the attribute's type.
 *
 *   2. Shape names → `linked_shape_name` values
 *      Records whose `linked_shape_name` is already null stay null
 *      (that's the "no anchor" case). Records that had a placeholder
 *      name get cycled through the warehouse's real shape names so
 *      users can copy the sample and re-import against real shapes.
 *
 *   3. Role vocabulary → `role` values (polygon / circle only)
 *      Adds a `role` field to every record and cycles through the
 *      warehouse's real role keys.
 *
 * Filename is tagged with the warehouse slug so downloads read
 * `sgv-sample-hospital-marker.csv` instead of the generic form.
 */

import type {
  AttributeDefinition,
  BindingKind,
  DataSourceEntityKind,
  Zone,
} from '@/lib/db'
import { vocabularyFor } from '@/lib/role-vocabulary'
import type { SampleFieldDef, SampleRecord, SampleSpec } from './sample-records'

// ------------------------------------------------------- context

export interface WarehouseSampleContext {
  warehouseId: number
  warehouseName: string
  /** Slug for the download filename. */
  warehouseSlug: string
  /** Attribute definitions this augmentation should surface as columns. */
  attributes: readonly AttributeDefinition[]
  /** Roles this warehouse has defined for polygon/circle. Empty otherwise. */
  roleKeys: readonly string[]
  /** Real shape names to seed `linked_shape_name` cycles. */
  shapeNames: readonly string[]
}

/**
 * Build a per-kind context by narrowing tenant-wide inputs to the
 * given warehouse. Callers pull the raw data from the spatial store
 * hooks; this function stays pure so it's easy to test / memoize.
 */
export function buildWarehouseSampleContext({
  warehouse,
  kind,
  allAttributes,
  allShapeNames,
}: {
  warehouse: Pick<Zone, 'id' | 'name' | 'roleVocabulary'>
  kind: DataSourceEntityKind
  /** Tenant-wide attribute definitions. Filtered internally. */
  allAttributes: readonly AttributeDefinition[]
  /** Shape names for THIS warehouse only, from any kind (deduped). */
  allShapeNames: readonly string[]
}): WarehouseSampleContext {
  const warehouseId = warehouse.id ?? 0
  const bindingKind = bindingKindFor(kind)

  const attributes = allAttributes.filter((def) => {
    // Warehouse scope: 'undefined' = tenant-shared (visible to every
    // warehouse) OR matching zoneId.
    const zoneMatches = def.zoneId === undefined || def.zoneId === warehouseId
    if (!zoneMatches) return false
    if (def.scope === 'any') return true
    return bindingKind !== null && def.scope === bindingKind
  })

  const roleKeys =
    kind === 'polygon' || kind === 'circle'
      ? vocabularyFor(warehouse, kind).map((v) => v.key)
      : []

  // Cap to a reasonable pool — the augmentation cycles through these
  // for a handful of records, and larger pools waste memory.
  const cappedShapeNames = allShapeNames.slice(0, 25)

  return {
    warehouseId,
    warehouseName: warehouse.name,
    warehouseSlug: slugifyWarehouseName(warehouse.name),
    attributes,
    roleKeys,
    shapeNames: cappedShapeNames,
  }
}

// ------------------------------------------------------- augmentation

/**
 * Return a new `SampleSpec` whose fields + records reflect the target
 * warehouse's schema. The original `spec` is not mutated.
 */
export function augmentSampleSpec(
  spec: SampleSpec,
  ctx: WarehouseSampleContext,
): SampleSpec {
  // Start from the base
  const fields: SampleFieldDef[] = [...spec.fields]
  let records: SampleRecord[] = spec.records.map((r) => ({ ...r }))

  // (1) attribute-defs → custom.<key> columns.
  // Skip attributes whose key already exists in the sample (e.g. the
  // sample already ships a `custom.temperature_c` field for demo);
  // the warehouse-defined one wins and replaces the placeholder values.
  const existingKeys = new Set(fields.map((f) => f.name))
  for (const def of ctx.attributes) {
    const fieldName = `custom.${def.key}`
    const attrField = attributeToSampleField(def, fieldName)
    // Replace an existing custom.<key> stub if there is one; otherwise append.
    const idx = fields.findIndex((f) => f.name === fieldName)
    if (idx >= 0) {
      fields[idx] = attrField
    } else {
      fields.push(attrField)
    }
    records = records.map((r, i) => ({
      ...r,
      [fieldName]: sampleValueForAttribute(def, i),
    }))
    existingKeys.add(fieldName)
  }

  // (2) linked_shape_name substitution.
  if (ctx.shapeNames.length > 0) {
    records = records.map((r, i) => {
      if (!Object.prototype.hasOwnProperty.call(r, 'linked_shape_name')) return r
      if (r.linked_shape_name === null) return r
      return {
        ...r,
        linked_shape_name: ctx.shapeNames[i % ctx.shapeNames.length],
      }
    })
  }

  // (3) role vocabulary — polygon / circle only.
  if (
    (spec.kind === 'polygon' || spec.kind === 'circle') &&
    ctx.roleKeys.length > 0
  ) {
    const roleFieldExists = fields.some((f) => f.name === 'role')
    if (!roleFieldExists) {
      fields.push({
        name: 'role',
        type: 'enum',
        recommended: true,
        description:
          'Warehouse role key. One of the values configured in this warehouse\'s role vocabulary.',
        enumValues: ctx.roleKeys,
      })
    } else {
      // Refresh the enum list on the existing field so it matches the
      // warehouse's actual vocabulary (in case a sample had a generic set).
      const idx = fields.findIndex((f) => f.name === 'role')
      fields[idx] = { ...fields[idx], enumValues: ctx.roleKeys }
    }
    records = records.map((r, i) => ({
      ...r,
      role: ctx.roleKeys[i % ctx.roleKeys.length],
    }))
  }

  return {
    ...spec,
    fields,
    records,
    filenameStem: `sgv-sample-${ctx.warehouseSlug}-${spec.kind}`,
  }
}

// ---------------------------------------------------- kind mapping

/** Map integrations entity-kind → shape binding-kind for attribute-def scope matching. */
function bindingKindFor(kind: DataSourceEntityKind): BindingKind | null {
  switch (kind) {
    case 'polygon':
      return 'polygon'
    case 'circle':
      return 'circle'
    case 'marker':
      return 'marker'
    case 'rack-cell':
      return 'grid-cell'
    // The rest (asset / camera / sensor / shipment / rfid-tag / streaming)
    // have no shape binding — only `scope: 'any'` attributes surface.
    default:
      return null
  }
}

// ---------------------------------------------------- value helpers

function attributeToSampleField(
  def: AttributeDefinition,
  fieldName: string,
): SampleFieldDef {
  const desc = def.description
    ? `${def.label} — ${def.description}`
    : `${def.label}${def.unit ? ` (${def.unit})` : ''}`
  return {
    name: fieldName,
    type: mapAttributeType(def.type),
    recommended: true,
    description: desc,
    enumValues: def.enumValues,
  }
}

function mapAttributeType(t: string): SampleFieldDef['type'] {
  switch (t) {
    case 'number':
    case 'integer':
    case 'currency':
    case 'weight':
    case 'length':
    case 'percent':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'enum':
      return 'enum'
    case 'date':
    case 'datetime':
    case 'timestamp':
      return 'timestamp'
    default:
      return 'string'
  }
}

/**
 * Plausible sample value for the i-th record given an attribute def.
 * Rotates through a few options so a downloaded sample shows realistic
 * variation without every row being identical.
 */
function sampleValueForAttribute(
  def: AttributeDefinition,
  index: number,
): string | number | null {
  // If the def has a default, use it once + null the rest — signals the
  // right shape without pretending we know user data.
  if (def.defaultValue !== undefined && def.defaultValue !== null) {
    if (index === 0) return String(def.defaultValue)
    if (index === 2) return null
  }
  if (def.type === 'enum' && def.enumValues && def.enumValues.length > 0) {
    return def.enumValues[index % def.enumValues.length]
  }
  if (def.type === 'boolean') {
    const cycle = [true, false, null, true, false]
    const v = cycle[index % cycle.length]
    return v === null ? null : v ? 'true' : 'false'
  }
  if (
    def.type === 'number' ||
    def.type === 'integer' ||
    def.type === 'currency' ||
    def.type === 'weight' ||
    def.type === 'length' ||
    def.type === 'percent'
  ) {
    const base = def.type === 'currency' ? 19.99 : 10
    return +(base + index * 3).toFixed(2)
  }
  if (def.type === 'date' || def.type === 'datetime' || def.type === 'timestamp') {
    const d = new Date(Date.UTC(2026, 6, 20, 14 + index, 0, 0))
    return d.toISOString()
  }
  // text / sku / free-form
  const cycle: (string | null)[] = ['Example value', 'Another example', null, 'Value 4', null]
  return cycle[index % cycle.length]
}

/** URL-safe slug from a human warehouse name. */
function slugifyWarehouseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    // Fallback for names that are all non-ascii — keeps the filename valid.
    || 'warehouse'
}
