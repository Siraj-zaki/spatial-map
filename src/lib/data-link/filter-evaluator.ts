/**
 * Runtime evaluator for the per-config filter expressions users author
 * from the /view Layers panel. Kept intentionally tiny — one field, one
 * operator, one value. Style-rules already cover the rich "condition
 * combinatorics" story; this filter is the on-map slicer, so users can
 * ask "only running forklifts" without ever leaving the view.
 *
 * Payload path reads reuse `readPayloadPath` from `match-resolver.ts` so
 * the syntax (dotted paths + array indices + `custom.foo` shortcut) is
 * identical to what the field-mapping picker offers in the editor.
 */

import type {
  DataLinkFieldMapping,
  DataLinkFilter,
  DataLinkFilterCondition,
  DataLinkFilterGroup,
  DataLinkFilterOp,
} from '@/lib/db'
import { readPayloadPath } from './match-resolver'
import { normaliseFilter } from './query-client'

/**
 * True when the entity's payload satisfies the filter. Missing / disabled
 * filters (no `field`, no `op`) always pass — so callers can pass in a
 * `null` filter and skip the check by intent.
 *
 * Numeric operators (`gt`/`gte`/`lt`/`lte`) coerce both sides to `Number`.
 * Non-numeric coercion yields NaN → the comparison is false, which reads
 * as "entity dropped." String comparisons are case-sensitive except for
 * `contains` which is a case-insensitive substring test.
 */
export function evaluateDataLinkFilter(
  payload: Record<string, unknown>,
  filter: DataLinkFilter | null | undefined,
): boolean {
  const node = normaliseFilter(filter)
  if (!node) return true
  return evaluateNode(payload, node)
}

function evaluateNode(
  payload: Record<string, unknown>,
  node: DataLinkFilterCondition | DataLinkFilterGroup,
): boolean {
  if (node.kind === 'group') {
    if (node.conditions.length === 0) return true
    if (node.combine === 'or') {
      return node.conditions.some((c) => evaluateNode(payload, c))
    }
    return node.conditions.every((c) => evaluateNode(payload, c))
  }
  const raw = readPayloadPath(payload, node.field)
  return applyOp(raw, node.op, node.value)
}

const IN_SETS = new WeakMap<readonly unknown[], Set<string>>()
function inSetOf(values: readonly unknown[]): Set<string> {
  let set = IN_SETS.get(values)
  if (!set) {
    set = new Set(values.map((v) => String(v)))
    IN_SETS.set(values, set)
  }
  return set
}

function applyOp(
  lhs: unknown,
  op: DataLinkFilterOp,
  rhs: DataLinkFilterCondition['value'],
): boolean {
  switch (op) {
    case 'exists':
      return lhs !== undefined && lhs !== null && lhs !== ''
    case 'missing':
      return lhs === undefined || lhs === null || lhs === ''
    case 'eq':
      return coerceEq(lhs, rhs)
    case 'neq':
      return !coerceEq(lhs, rhs)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(lhs)
      const b = Number(rhs)
      if (Number.isNaN(a) || Number.isNaN(b)) return false
      switch (op) {
        case 'gt':
          return a > b
        case 'gte':
          return a >= b
        case 'lt':
          return a < b
        case 'lte':
          return a <= b
      }
      return false
    }
    case 'between': {
      if (!Array.isArray(rhs) || rhs.length !== 2) return false
      const [lo, hi] = rhs
      const a = Number(lhs)
      const l = Number(lo)
      const h = Number(hi)
      if (!Number.isNaN(a) && !Number.isNaN(l) && !Number.isNaN(h)) {
        return a >= l && a <= h
      }
      // String bounds — lexical compare.
      const s = String(lhs ?? '')
      return s >= String(lo) && s <= String(hi)
    }
    case 'contains':
      if (lhs === undefined || lhs === null) return false
      return String(lhs).toLowerCase().includes(String(rhs ?? '').toLowerCase())
    case 'startsWith':
      if (lhs === undefined || lhs === null) return false
      return String(lhs).toLowerCase().startsWith(String(rhs ?? '').toLowerCase())
    case 'endsWith':
      if (lhs === undefined || lhs === null) return false
      return String(lhs).toLowerCase().endsWith(String(rhs ?? '').toLowerCase())
    case 'regex':
      if (lhs === undefined || lhs === null) return false
      try {
        return new RegExp(String(rhs ?? '')).test(String(lhs))
      } catch {
        return false
      }
    case 'in':
    case 'notIn': {
      if (!Array.isArray(rhs)) return op === 'notIn'
      const s = String(lhs ?? '')
      // A report narrows a layer to its filtered rows with one `in` over
      // thousands of keys, evaluated per entity per rebuild — a Set per
      // value array (cached by identity) keeps that linear.
      const hit = rhs.length > 16 ? inSetOf(rhs).has(s) : rhs.some((v) => String(v) === s)
      return op === 'in' ? hit : !hit
    }
    case 'before':
    case 'after': {
      const l = new Date(String(lhs)).getTime()
      const r = new Date(String(rhs)).getTime()
      if (Number.isNaN(l) || Number.isNaN(r)) return false
      return op === 'before' ? l < r : l > r
    }
    case 'lastNDays':
    case 'nextNDays': {
      const days = Number(rhs)
      if (Number.isNaN(days) || days < 0) return false
      const t = new Date(String(lhs)).getTime()
      if (Number.isNaN(t)) return false
      const now = Date.now()
      const window = days * 86400_000
      return op === 'lastNDays'
        ? t >= now - window && t <= now
        : t <= now + window && t >= now
    }
    default:
      return true
  }
}

function coerceEq(lhs: unknown, rhs: DataLinkFilterCondition['value']): boolean {
  if (lhs === rhs) return true
  // Compare across string / number boundaries (payload sometimes carries
  // `"1"` where the user typed `1`, or vice versa). Booleans coerce too.
  if (lhs === undefined || lhs === null || rhs === undefined || rhs === null) {
    return false
  }
  const ls = String(lhs)
  const rs = String(rhs)
  if (ls === rs) return true
  const ln = Number(lhs)
  const rn = Number(rhs)
  if (!Number.isNaN(ln) && !Number.isNaN(rn) && ln === rn) return true
  return false
}

/**
 * Resolve the floor a data-link entity belongs to. Non-null return means
 * the entity has a known floor and should be tested against the active
 * floor. Null return means "unknown" — treat like unassigned shapes and
 * show on every floor (matches the `onFloor` helper in view.tsx).
 *
 * Priority when `overrides` is set (v5.5 — "From record" mapping):
 *   payload[overrides.field] matched against `overrides.valueMap`
 *   (case-insensitive string equality, with numeric coercion as a
 *   tie-breaker) → floorPlanId. This wins over the classic chain so a
 *   payload can carry BOTH a `floor_name: "F1"` and a stale numeric
 *   `floor: 99` without the stale value clobbering the mapping.
 *
 * Priority when no overrides (classic path):
 *   explicit `floorPlanId` > `floorId` > `floor` > matched shape's
 *   `floorPlanId`. The matched-shape source is passed separately so
 *   callers can also account for shape-anchored modes.
 */
export function resolveEntityFloor(
  payload: Record<string, unknown>,
  matchedShapeFloorPlanId?: number | null,
  overrides?: {
    field?: string
    valueMap?: ReadonlyArray<{ value: string; floorPlanId: number }>
  },
): number | null {
  // v5.5 — user-configured mapping wins when both parts are set. Empty
  // maps (user picked a field but didn't add rows) fall through so the
  // layer isn't silently blanked out during authoring.
  if (
    overrides?.field &&
    overrides.valueMap !== undefined &&
    overrides.valueMap.length > 0
  ) {
    const raw = readPayloadPath(payload, overrides.field)
    if (raw !== undefined && raw !== null && raw !== '') {
      const rs = String(raw).trim().toLowerCase()
      const rn = Number(raw)
      for (const entry of overrides.valueMap) {
        if (!entry || entry.floorPlanId === undefined) continue
        const es = String(entry.value ?? '').trim().toLowerCase()
        if (es === rs) return entry.floorPlanId
        if (!Number.isNaN(rn)) {
          const en = Number(entry.value)
          if (!Number.isNaN(en) && en === rn) return entry.floorPlanId
        }
      }
    }
    // No mapping row matched — fall through to the classic chain so a
    // partially-configured payload (one row references an unmapped
    // "F3", say) still tries `floorPlanId` etc. before giving up.
  }
  const candidates = ['floorPlanId', 'floorId', 'floor']
  for (const key of candidates) {
    const v = readPayloadPath(payload, key)
    if (v === undefined || v === null || v === '') continue
    const n = Number(v)
    if (!Number.isNaN(n)) return n
  }
  if (matchedShapeFloorPlanId !== undefined && matchedShapeFloorPlanId !== null) {
    return matchedShapeFloorPlanId
  }
  return null
}

/**
 * True when the entity should render on the active floor.
 *
 * - `active === null` (all-floors mode) → always true.
 * - Entity floor unknown → true (matches shape behaviour for
 *   `floorPlanId === undefined` — unassigned shapes show everywhere).
 * - Otherwise, exact match.
 */
export function onActiveFloor(
  entityFloor: number | null,
  active: number | null,
): boolean {
  if (active === null) return true
  if (entityFloor === null) return true
  return entityFloor === active
}

/**
 * Whether a shape matched by name / code belongs to the entity's floor.
 * An attribute join matches every shape with that name, and floors often
 * repeat names ("Bakery" on Ground and Level 1). When the payload itself
 * names a floor (`auto` mode only), shapes on other floors are skipped so
 * a Ground row doesn't also paint the Level 1 room.
 */
export function shapeOnEntityFloor(
  payload: Record<string, unknown>,
  scope: DataLinkFieldMapping['floorScope'] | null | undefined,
  shapeFloorPlanId: number | null | undefined,
): boolean {
  if ((scope?.mode ?? 'auto') !== 'auto') return true
  if (shapeFloorPlanId === undefined || shapeFloorPlanId === null) return true
  const entityFloor = resolveEntityFloor(payload, null, { field: scope?.field, valueMap: scope?.valueMap })
  return entityFloor === null || entityFloor === shapeFloorPlanId
}

/**
 * Config-level floor gate that layers the user-picked `floorScope` on
 * top of the payload / matched-shape resolution.
 *
 * Semantics per mode:
 *   - `'all'`   — always renders. No floor read at all. Visible on
 *     every floor AND in the all-floors view.
 *   - `'specific'` — strictly gated. Renders only when the viewer's
 *     active floor is one of the picked floors. HIDDEN in the all-
 *     floors view (activeFloorPlanId === null) because the user
 *     explicitly said "I only want this data associated with the
 *     picked floors" — showing it on the all-floors view would
 *     contradict that intent.
 *   - `'auto'` (default) — resolves the entity's floor the classic way
 *     but treats *orphan* references (an id no longer present in
 *     `liveFloorPlanIds`) as unknown so the entity keeps rendering
 *     instead of disappearing after a floor was deleted + re-added
 *     with a new id.
 *
 * `liveFloorPlanIds` may be `undefined` (older callers that haven't
 * been plumbed with the set yet) — in that case orphan detection is
 * skipped and the behaviour is identical to the pre-fix
 * `onActiveFloor(resolveEntityFloor(...), active)` path.
 */
/** The floors a map shows: one, several (the report's full map) or all (null). */
export type ActiveFloors = number | ReadonlySet<number> | null

/** A stable cache-key part for `ActiveFloors`. */
export function activeFloorKey(active: ActiveFloors | undefined): string {
  if (active === null || active === undefined) return 'all'
  if (typeof active === 'number') return String(active)
  return [...active].sort((a, b) => a - b).join(',') || 'all'
}

/** The one floor of `active`, else null (several floors, or all). */
export function singleActiveFloor(active: ActiveFloors | undefined): number | null {
  if (active === null || active === undefined) return null
  if (typeof active === 'number') return active
  return active.size === 1 ? [...active][0] : null
}

/** Several floors: an entity passes when it'd pass on any of them. */
export function passesFloorScope(
  payload: Record<string, unknown>,
  scope: DataLinkFieldMapping['floorScope'] | null | undefined,
  activeFloorPlanId: ActiveFloors,
  liveFloorPlanIds?: ReadonlySet<number>,
  matchedShapeFloorPlanId?: number | null,
): boolean {
  if (activeFloorPlanId !== null && typeof activeFloorPlanId === 'object') {
    if (activeFloorPlanId.size === 0) return passesOneFloor(payload, scope, null, liveFloorPlanIds, matchedShapeFloorPlanId)
    for (const f of activeFloorPlanId) {
      if (passesOneFloor(payload, scope, f, liveFloorPlanIds, matchedShapeFloorPlanId)) return true
    }
    return false
  }
  return passesOneFloor(payload, scope, activeFloorPlanId, liveFloorPlanIds, matchedShapeFloorPlanId)
}

function passesOneFloor(
  payload: Record<string, unknown>,
  scope: DataLinkFieldMapping['floorScope'] | null | undefined,
  activeFloorPlanId: number | null,
  liveFloorPlanIds?: ReadonlySet<number>,
  matchedShapeFloorPlanId?: number | null,
): boolean {
  const mode = scope?.mode ?? 'auto'
  if (mode === 'all') return true
  if (mode === 'specific') {
    // v5.4 — the "All floors" view is a SUPERSET of every single-floor
    // view, so `specific`-mode entities that would show on their own
    // floor also show here. The prior strict-hide behaviour surprised
    // users who expected "All floors" to literally mean "show
    // everything" — the natural reading — and hid ground-floor
    // sensors when the viewer selected All Floors.
    if (activeFloorPlanId === null) return true
    const ids = scope?.floorPlanIds ?? []
    return ids.includes(activeFloorPlanId)
  }
  // 'auto' — classic resolution, orphan-safe. If the operator wired
  // up a text-field → floor mapping ("floor_name" → { "F1": 19, "F2":
  // 11 } etc.), it takes precedence over the classic
  // floorPlanId/floorId/floor chain — see `resolveEntityFloor`.
  let entityFloor = resolveEntityFloor(payload, matchedShapeFloorPlanId, {
    field: scope?.field,
    valueMap: scope?.valueMap,
  })
  if (
    entityFloor !== null &&
    liveFloorPlanIds !== undefined &&
    liveFloorPlanIds.size > 0 &&
    !liveFloorPlanIds.has(entityFloor)
  ) {
    entityFloor = null
  }
  return onActiveFloor(entityFloor, activeFloorPlanId)
}
