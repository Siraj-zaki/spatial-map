/**
 * Apply `defaultValue`s from `AttributeDefinition`s to a fresh bin.
 *
 * Called by the bin / shape data editors when seeding a new bin row
 * for a target that has no existing data. Existing values in
 * `customProperties` are preserved — defaults only fill blanks.
 */

import type { AttributeDefinition, Bin, BindingKind } from '@/lib/db'
import { defsForKind } from '@/lib/data-link/attribute-defs'

export function applyDefaultsForBin(
  kind: BindingKind,
  allDefs: AttributeDefinition[],
  bin: Pick<Bin, 'customProperties'>,
): Record<string, unknown> {
  const defs = defsForKind(kind, allDefs)
  const merged: Record<string, unknown> = { ...(bin.customProperties ?? {}) }
  for (const def of defs) {
    if (def.defaultValue === undefined || def.defaultValue === null || def.defaultValue === '') continue
    if (merged[def.key] !== undefined) continue
    merged[def.key] = def.defaultValue
  }
  return merged
}
