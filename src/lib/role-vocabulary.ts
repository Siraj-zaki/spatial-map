/**
 * Helpers around the per-warehouse role vocabulary.
 *
 * `Zone.roleVocabulary` is optional; whenever the editor needs to
 * render a role picker or look up the friendly label for a role key it
 * goes through these helpers so missing/empty values transparently
 * fall back to the default starter set defined in `db.ts`.
 *
 * Keeping this in its own module (rather than `db.ts` next to the
 * data definitions) lets the side panel / config screens import only
 * the helpers, without dragging in the Dexie schema.
 */

import {
  DEFAULT_ROLE_VOCABULARY,
  type RoleVocabulary,
  type RoleVocabularyEntry,
  type Zone,
} from './db'

/**
 * Returns the role list for a given shape kind on the warehouse,
 * falling back to the default starter set when the warehouse has no
 * custom vocabulary (the common case for fresh / legacy warehouses).
 */
export function vocabularyFor(
  warehouse: Pick<Zone, 'roleVocabulary'> | null | undefined,
  kind: 'polygon' | 'circle',
): RoleVocabularyEntry[] {
  const custom = warehouse?.roleVocabulary?.[kind]
  if (custom && custom.length > 0) return custom
  return DEFAULT_ROLE_VOCABULARY[kind] ?? []
}

/**
 * Resolve a role key into its display label. If the warehouse has no
 * matching entry the key itself is returned so a renamed-then-deleted
 * role still reads sensibly until the user picks a new one.
 *
 * Pass `fallback` when you want a literal string (e.g. "Polygon")
 * shown for shapes that have no role at all.
 */
export function roleLabel(
  warehouse: Pick<Zone, 'roleVocabulary'> | null | undefined,
  kind: 'polygon' | 'circle',
  key: string | undefined,
  fallback?: string,
): string {
  if (!key) return fallback ?? ''
  const list = vocabularyFor(warehouse, kind)
  const hit = list.find((e) => e.key === key)
  return hit?.label ?? key
}

/**
 * Resolve a role key into its preset colour. Used so new shapes of a
 * given role pick up the role's default fill instead of the generic
 * indigo. Returns `undefined` when the role has no preset.
 */
export function roleColor(
  warehouse: Pick<Zone, 'roleVocabulary'> | null | undefined,
  kind: 'polygon' | 'circle',
  key: string | undefined,
): string | undefined {
  if (!key) return undefined
  return vocabularyFor(warehouse, kind).find((e) => e.key === key)?.color
}

/**
 * Sanity check used by the future vocabulary editor — keys must be
 * non-empty, lowercase, and use letters/digits/dashes only so they
 * survive JSON / URL round-trips cleanly.
 */
export function isValidRoleKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(key)
}

/**
 * Bulk-apply edits made in the vocabulary editor to a warehouse,
 * preserving any kind the editor didn't touch. Always returns a fresh
 * object so the caller can pass it straight to a state setter.
 */
export function mergeVocabulary(
  current: RoleVocabulary | undefined,
  patch: Partial<RoleVocabulary>,
): RoleVocabulary {
  return {
    polygon: patch.polygon ?? current?.polygon,
    circle: patch.circle ?? current?.circle,
  }
}
