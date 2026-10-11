/**
 * Rule evaluator.
 *
 * Two shapes of evaluation:
 *   - single-bin: a condition reads attributes off ONE bin (used for
 *     `self` / `single` sources, and for back-compat with the legacy
 *     condition shape).
 *   - multi-bin: a condition is quantified (every/some/none) or
 *     aggregate (count/sum/avg/min/max) and reduces a SET of bins to
 *     a boolean.
 *
 * Pure module — no Dexie, no React. The resolver layer wires it up to
 * the spatial store.
 */

import type { Bin } from '@/lib/db'
import type {
  AggregateCondition,
  AggregateFn,
  AggregateOp,
  AttrCondition,
  LegacyAttrCondition,
  RuleCondition,
  RuleOp,
  RuleStyle,
  StyleRule,
} from './types'

// ---------------------------------------------------------------- attribute

/**
 * Read a value off a bin by dot-path. `custom.<key>` indirects through
 * `bin.customProperties` so users can refer to their own attribute
 * definitions without changing the rule shape.
 */
export function readBinAttribute(bin: Bin, attribute: string): unknown {
  if (attribute.startsWith('custom.')) {
    const key = attribute.slice('custom.'.length)
    return bin.customProperties?.[key]
  }
  switch (attribute) {
    case 'status':
      return bin.status
    case 'sku':
      return bin.sku
    case 'capacity':
      return bin.capacity
    case 'notes':
      return bin.notes
    case 'externalCode':
      return bin.externalCode
    case 'syncSource':
      return bin.syncSource
    case 'lastSyncedAt':
      return bin.lastSyncedAt
    default:
      return undefined
  }
}

// ---------------------------------------------------------------- comparison

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asDateMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

/**
 * Comparison helper — exported so the data-link overlay can reuse the
 * same `RuleOp` semantics on entity-payload attributes. See the switch
 * body below for the full list of ops.
 */
export function compare(op: RuleOp, lhs: unknown, rhs: unknown): boolean {
  switch (op) {
    case 'equals':
      // Lax equality so "1" === 1 (rows from CSV are strings; rules from
      // the UI may type numerically).
      return lhs == rhs
    case 'notEquals':
      return lhs != rhs
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const a = asNumber(lhs)
      const b = asNumber(rhs)
      if (a === null || b === null) return false
      if (op === 'lt') return a < b
      if (op === 'lte') return a <= b
      if (op === 'gt') return a > b
      return a >= b
    }
    case 'in':
    case 'notIn': {
      if (!Array.isArray(rhs)) return op === 'notIn'
      const set = new Set(rhs.map((x) => String(x)))
      const has = set.has(String(lhs ?? ''))
      return op === 'in' ? has : !has
    }
    case 'contains': {
      if (typeof lhs !== 'string') return false
      return lhs.toLowerCase().includes(String(rhs ?? '').toLowerCase())
    }
    case 'startsWith': {
      if (typeof lhs !== 'string') return false
      return lhs.toLowerCase().startsWith(String(rhs ?? '').toLowerCase())
    }
    case 'endsWith': {
      if (typeof lhs !== 'string') return false
      return lhs.toLowerCase().endsWith(String(rhs ?? '').toLowerCase())
    }
    case 'isEmpty':
      return isEmpty(lhs)
    case 'isSet':
      return !isEmpty(lhs)
    case 'olderThan':
    case 'newerThan': {
      const t = asDateMs(lhs)
      const window = asNumber(rhs)
      if (t === null || window === null) return false
      const now = Date.now()
      const ageMs = now - t
      return op === 'olderThan' ? ageMs > window : ageMs < window
    }
  }
}

function compareNumeric(op: AggregateOp, lhs: number, rhs: number): boolean {
  switch (op) {
    case 'eq':  return lhs === rhs
    case 'ne':  return lhs !== rhs
    case 'lt':  return lhs < rhs
    case 'lte': return lhs <= rhs
    case 'gt':  return lhs > rhs
    case 'gte': return lhs >= rhs
  }
}

// ---------------------------------------------------------------- condition

/**
 * Widen a legacy condition `{ attribute, op, value }` (no `type` field)
 * into the v3 `AttrCondition` shape so the rest of the evaluator can
 * dispatch on `type` uniformly.
 */
function normalizeCondition(cond: RuleCondition): AttrCondition | AggregateCondition {
  if ('type' in cond) return cond
  const legacy = cond as LegacyAttrCondition
  return { type: 'attr', attribute: legacy.attribute, op: legacy.op, value: legacy.value }
}

/**
 * Evaluate one condition against a set of source bins. The set may be
 * empty (in which case `every` is vacuously true, `some` is false, etc.).
 */
export function evaluateConditionOverBins(
  cond: RuleCondition,
  bins: ReadonlyArray<Bin>,
): boolean {
  const c = normalizeCondition(cond)
  if (c.type === 'attr') return evalAttr(c, bins)
  return evalAggregate(c, bins)
}

function evalAttr(c: AttrCondition, bins: ReadonlyArray<Bin>): boolean {
  const quantifier = c.quantifier ?? 'single'
  if (quantifier === 'single') {
    const bin = bins[0]
    if (!bin) return false
    return compare(c.op, readBinAttribute(bin, c.attribute), c.value ?? null)
  }
  if (bins.length === 0) {
    // Standard short-circuits on empty sets.
    return quantifier === 'every' || quantifier === 'none'
  }
  let matchCount = 0
  for (const bin of bins) {
    const lhs = readBinAttribute(bin, c.attribute)
    if (compare(c.op, lhs, c.value ?? null)) matchCount++
  }
  switch (quantifier) {
    case 'every': return matchCount === bins.length
    case 'some':  return matchCount > 0
    case 'none':  return matchCount === 0
  }
}

function evalAggregate(c: AggregateCondition, bins: ReadonlyArray<Bin>): boolean {
  const aggValue = reduceAggregate(c.fn, c.attribute, c.whereAttribute, c.whereOp, c.whereValue, bins)
  if (aggValue === null) return false
  return compareNumeric(c.op, aggValue, c.value)
}

function reduceAggregate(
  fn: AggregateFn,
  attribute: string | undefined,
  whereAttribute: string | undefined,
  whereOp: RuleOp | undefined,
  whereValue: unknown,
  bins: ReadonlyArray<Bin>,
): number | null {
  if (fn === 'count') return bins.length
  if (fn === 'countWhere') {
    if (!whereAttribute || !whereOp) return 0
    let n = 0
    for (const bin of bins) {
      if (compare(whereOp, readBinAttribute(bin, whereAttribute), whereValue ?? null)) n++
    }
    return n
  }
  if (!attribute) return null
  const values: number[] = []
  for (const bin of bins) {
    const n = asNumber(readBinAttribute(bin, attribute))
    if (n !== null) values.push(n)
  }
  if (values.length === 0) return null
  switch (fn) {
    case 'sum': return values.reduce((a, b) => a + b, 0)
    case 'avg': return values.reduce((a, b) => a + b, 0) / values.length
    case 'min': return Math.min(...values)
    case 'max': return Math.max(...values)
  }
}

/**
 * Evaluate a single rule against a set of source bins. Honours the
 * rule's `combine` (and/or) over its conditions.
 */
export function evaluateRule(rule: StyleRule, bins: ReadonlyArray<Bin>): boolean {
  if (!rule.enabled) return false
  if (rule.conditions.length === 0) return bins.length > 0 // unconditional rule fires when source is non-empty
  const results = rule.conditions.map((c) => evaluateConditionOverBins(c, bins))
  return rule.combine === 'or' ? results.some(Boolean) : results.every(Boolean)
}

// ---------------------------------------------------------------- legacy

/**
 * Back-compat: evaluate a single bin against a single condition. Used
 * by code paths that still want the old per-bin semantics.
 */
export function evaluateCondition(cond: RuleCondition, bin: Bin): boolean {
  return evaluateConditionOverBins(cond, [bin])
}

/**
 * Walk the active rules in priority order and return the first match
 * along with the rule that produced it. Caller is responsible for
 * pre-filtering by `scope` and `zoneId` so this inner loop stays tight.
 * Single-bin overload kept for callers that haven't migrated to the
 * bin-set API.
 */
export function resolveStyle(
  sortedRules: ReadonlyArray<StyleRule>,
  bin: Bin,
): { ruleId: number; ruleName: string; style: RuleStyle } | null {
  for (const rule of sortedRules) {
    if (!rule.enabled) continue
    if (rule.id === undefined) continue
    if (!evaluateRule(rule, [bin])) continue
    return { ruleId: rule.id, ruleName: rule.name, style: rule.style }
  }
  return null
}

/**
 * Substitute `{attribute}` placeholders in a label template with the
 * bin's live values. Missing attributes render as empty strings. When
 * the source resolves to many bins we substitute from the first bin
 * (callers can pick a representative bin if needed).
 */
export function renderLabelTemplate(template: string, bin: Bin): string {
  return template.replace(/\{([^}]+)\}/g, (_, attr: string) => {
    const v = readBinAttribute(bin, attr.trim())
    if (v === undefined || v === null) return ''
    if (v instanceof Date) return v.toISOString()
    return String(v)
  })
}

/** Stable sort: priority ascending, then id ascending. */
export function sortRulesForEval(
  rules: ReadonlyArray<StyleRule>,
): StyleRule[] {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return (a.id ?? 0) - (b.id ?? 0)
  })
}
