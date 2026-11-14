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

// ---------------------------------------------------------------- compiled

/**
 * A rule prepared once for repeated evaluation. The resolver evaluates
 * every rule against every target (30k+ seats in a stadium), so the work
 * `evaluateRule` redoes per call — widening legacy conditions, picking the
 * attribute reader, building the `in` Set, parsing a numeric bound,
 * lower-casing a needle — is done here once per rule instead.
 *
 * Results are the same as `evaluateRule(rule, bins)` for every input; the
 * functions above stay the reference. Rules and bins are immutable rows,
 * so callers may cache a compiled rule per rule object.
 */
export interface CompiledRuleTest {
  /** `evaluateRule(rule, bins)`. */
  test: (bins: ReadonlyArray<Bin>) => boolean
  /** `evaluateRule(rule, [bin])`, without allocating the one-bin set. */
  testOne: (bin: Bin) => boolean
  /**
   * A condition reads the clock (`olderThan` / `newerThan`), so its
   * result can change while the bins don't — such rules must not be
   * cached per bin.
   */
  timeDependent: boolean
}

type Reader = (bin: Bin) => unknown

/** `readBinAttribute(bin, attribute)` with the path resolved up front. */
function compileReader(attribute: string): Reader {
  // Malformed rows (no attribute) keep the reference path, errors included.
  if (typeof attribute !== 'string') return (bin) => readBinAttribute(bin, attribute)
  if (attribute.startsWith('custom.')) {
    const key = attribute.slice('custom.'.length)
    return (bin) => bin.customProperties?.[key]
  }
  switch (attribute) {
    case 'status':       return (bin) => bin.status
    case 'sku':          return (bin) => bin.sku
    case 'capacity':     return (bin) => bin.capacity
    case 'notes':        return (bin) => bin.notes
    case 'externalCode': return (bin) => bin.externalCode
    case 'syncSource':   return (bin) => bin.syncSource
    case 'lastSyncedAt': return (bin) => bin.lastSyncedAt
    default:             return () => undefined
  }
}

const never = () => false

/** `(lhs) => compare(op, lhs, rhs)` with the right-hand side prepared once. */
function compileCompare(op: RuleOp, rhs: unknown): (lhs: unknown) => boolean {
  switch (op) {
    case 'equals':
      return (lhs) => lhs == rhs
    case 'notEquals':
      return (lhs) => lhs != rhs
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const b = asNumber(rhs)
      if (b === null) return never
      if (op === 'lt') return (lhs) => { const a = asNumber(lhs); return a !== null && a < b }
      if (op === 'lte') return (lhs) => { const a = asNumber(lhs); return a !== null && a <= b }
      if (op === 'gt') return (lhs) => { const a = asNumber(lhs); return a !== null && a > b }
      return (lhs) => { const a = asNumber(lhs); return a !== null && a >= b }
    }
    case 'in':
    case 'notIn': {
      if (!Array.isArray(rhs)) {
        const r = op === 'notIn'
        return () => r
      }
      const set = new Set(rhs.map((x) => String(x)))
      return op === 'in'
        ? (lhs) => set.has(String(lhs ?? ''))
        : (lhs) => !set.has(String(lhs ?? ''))
    }
    case 'contains': {
      const needle = String(rhs ?? '').toLowerCase()
      return (lhs) => typeof lhs === 'string' && lhs.toLowerCase().includes(needle)
    }
    case 'startsWith': {
      const needle = String(rhs ?? '').toLowerCase()
      return (lhs) => typeof lhs === 'string' && lhs.toLowerCase().startsWith(needle)
    }
    case 'endsWith': {
      const needle = String(rhs ?? '').toLowerCase()
      return (lhs) => typeof lhs === 'string' && lhs.toLowerCase().endsWith(needle)
    }
    case 'isEmpty':
      return isEmpty
    case 'isSet':
      return (lhs) => !isEmpty(lhs)
    case 'olderThan':
    case 'newerThan': {
      const window = asNumber(rhs)
      if (window === null) return never
      const older = op === 'olderThan'
      return (lhs) => {
        const t = asDateMs(lhs)
        if (t === null) return false
        // Read per call, as `compare` does: the clock moves between calls.
        const ageMs = Date.now() - t
        return older ? ageMs > window : ageMs < window
      }
    }
    default:
      // An unknown op compares to nothing (`compare` returns undefined).
      return never
  }
}

interface CompiledCondition {
  many: (bins: ReadonlyArray<Bin>) => boolean
  one: (bin: Bin) => boolean
  timeDependent: boolean
}

const isClockOp = (op: unknown) => op === 'olderThan' || op === 'newerThan'

function compileCondition(cond: RuleCondition): CompiledCondition {
  const c = normalizeCondition(cond)
  if (c.type !== 'attr') {
    // Aggregates reduce a whole set; they run on shared sources, not per
    // target, so the reference evaluator is fine here.
    return {
      many: (bins) => evalAggregate(c, bins),
      one: (bin) => evalAggregate(c, [bin]),
      timeDependent: isClockOp(c.whereOp),
    }
  }
  const read = compileReader(c.attribute)
  const cmp = compileCompare(c.op, c.value ?? null)
  const one = (bin: Bin) => cmp(read(bin))
  const timeDependent = isClockOp(c.op)
  const quantifier = c.quantifier ?? 'single'
  switch (quantifier) {
    case 'single':
      return { many: (bins) => { const bin = bins[0]; return bin ? one(bin) : false }, one, timeDependent }
    case 'every':
      return {
        many: (bins) => { for (const bin of bins) if (!one(bin)) return false; return true },
        one,
        timeDependent,
      }
    case 'some':
      return {
        many: (bins) => { for (const bin of bins) if (one(bin)) return true; return false },
        one,
        timeDependent,
      }
    case 'none':
      return {
        many: (bins) => { for (const bin of bins) if (one(bin)) return false; return true },
        one: (bin) => !one(bin),
        timeDependent,
      }
    default:
      // An unknown quantifier never matches (see `evalAttr`).
      return { many: never, one: never, timeDependent }
  }
}

/** Compile `evaluateRule(rule, …)` for one rule. */
export function compileRuleTest(rule: StyleRule): CompiledRuleTest {
  if (!rule.enabled) return { test: never, testOne: never, timeDependent: false }
  // Malformed rows (conditions not a list) keep the reference path.
  if (!Array.isArray(rule.conditions)) {
    return { test: (bins) => evaluateRule(rule, bins), testOne: (bin) => evaluateRule(rule, [bin]), timeDependent: true }
  }
  if (rule.conditions.length === 0) {
    // An unconditional rule fires when its source is non-empty.
    return { test: (bins) => bins.length > 0, testOne: () => true, timeDependent: false }
  }
  const conds = rule.conditions.map(compileCondition)
  const timeDependent = conds.some((c) => c.timeDependent)
  if (conds.length === 1) {
    const [c] = conds
    return { test: c.many, testOne: c.one, timeDependent }
  }
  if (rule.combine === 'or') {
    return {
      test: (bins) => { for (const c of conds) if (c.many(bins)) return true; return false },
      testOne: (bin) => { for (const c of conds) if (c.one(bin)) return true; return false },
      timeDependent,
    }
  }
  return {
    test: (bins) => { for (const c of conds) if (!c.many(bins)) return false; return true },
    testOne: (bin) => { for (const c of conds) if (!c.one(bin)) return false; return true },
    timeDependent,
  }
}

/**
 * Compile `renderLabelTemplate(template, bin)`: the `{attribute}` slots
 * are found once and each gets its reader.
 */
export function compileLabelTemplate(template: string): (bin: Bin) => string {
  // Malformed rows keep the reference path, errors included.
  if (typeof template !== 'string') return (bin) => renderLabelTemplate(template, bin)
  const parts: Array<string | Reader> = []
  const re = /\{([^}]+)\}/g
  let last = 0
  for (let m = re.exec(template); m !== null; m = re.exec(template)) {
    if (m.index > last) parts.push(template.slice(last, m.index))
    parts.push(compileReader(m[1].trim()))
    last = re.lastIndex
  }
  if (last < template.length) parts.push(template.slice(last))
  if (parts.length === 1 && typeof parts[0] === 'string') {
    const text = parts[0]
    return () => text
  }
  return (bin) => {
    let out = ''
    for (const p of parts) {
      if (typeof p === 'string') {
        out += p
        continue
      }
      const v = p(bin)
      if (v === undefined || v === null) continue
      out += v instanceof Date ? v.toISOString() : String(v)
    }
    return out
  }
}
