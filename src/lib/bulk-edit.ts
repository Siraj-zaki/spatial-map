/**
 * Helpers for bulk-editing multiple shapes of the same kind.
 *
 * The sidebar's bulk-edit panels are deliberately partial-patch: when a
 * user edits one field (say "border color"), only that field is fanned
 * out to every selected shape — other config fields stay as each shape's
 * own value. This avoids the classic "I changed color and lost everyone's
 * individual opacity" bug.
 *
 * `sharedValue` computes whether all selected shapes agree on a given
 * field. The bulk-edit UI uses this to show the unanimous value, or an
 * "indeterminate" placeholder when shapes differ.
 */

/**
 * Read a single field across many items. Returns the shared value if
 * every item produces the same value (under `===`), or `undefined`
 * paired with `isMixed: true` otherwise.
 *
 * The first item's value is returned even when mixed — useful for
 * seeding a color picker or slider so the user has a sensible starting
 * point when they begin editing.
 */
export function sharedValue<T, V>(
  items: ReadonlyArray<T>,
  pick: (item: T) => V,
): { value: V | undefined; isMixed: boolean } {
  if (items.length === 0) return { value: undefined, isMixed: false }
  const first = pick(items[0])
  for (let i = 1; i < items.length; i++) {
    if (pick(items[i]) !== first) {
      return { value: first, isMixed: true }
    }
  }
  return { value: first, isMixed: false }
}
