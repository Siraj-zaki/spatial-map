/**
 * Small helpers around `attributeDefinitions`. Kept separate from the
 * data-access layer so the import pipeline (which is the only thing that
 * needs to *write* defs) is its own concern. UI consumers read from the
 * spatial store snapshot instead of calling this directly.
 */

import { type AttributeDefinition, type BindingKind } from '@/lib/db'

/**
 * Filter and sort the provided attribute definitions for a given binding
 * kind. The caller should pass the snapshot from the spatial store; this
 * keeps all editor reads event-driven instead of polling.
 */
export function defsForKind(
  kind: BindingKind,
  rows: AttributeDefinition[],
): AttributeDefinition[] {
  const specific = rows.filter((d) => d.scope === kind)
  const any = rows.filter((d) => d.scope === 'any')
  return [...specific, ...any].sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Format a custom-property value for display in the bin editor / popup.
 * Numbers get locale formatting; everything else falls through as a
 * string. We intentionally don't render booleans/dates specially yet
 * because the import pipeline persists everything as text for Phase 1.
 */
export function formatAttributeValue(value: unknown, unit?: string): string {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'number') {
    const formatted = Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 3 })
    return unit ? formatted + ' ' + unit : formatted
  }
  return unit ? String(value) + ' ' + unit : String(value)
}
