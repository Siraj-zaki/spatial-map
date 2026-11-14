/**
 * Payload-scoped style-rule evaluator for the data-link overlay.
 *
 * The main `style-rules/evaluator.ts` is Bin-centric — it reads
 * attributes off `bin.status`, `bin.customProperties[k]`, etc., and
 * runs the full source-selector / quantifier / aggregate pipeline that
 * spatial rules need. Data-linked entities live in a different world:
 * each `EntityState.payload` is arbitrary JSON, there's no
 * quantifier / aggregate story yet, and rules only ever score
 * `single`-bin equivalent conditions against the entity currently
 * being rendered.
 *
 * So we ship a tiny sibling: iterate the styleRuleIds attached to a
 * DataLinkConfig, evaluate each rule's `AttrCondition` / legacy
 * conditions against the entity's payload, and return the first match's
 * `RuleStyle`. Same `RuleOp` semantics via the shared `compare`
 * helper — a rule authored for bins keeps its meaning when reused
 * against an entity payload.
 *
 * The one important behavioural note: aggregate + quantified conditions
 * silently no-op here. If a user writes an aggregate rule and wires it
 * to a data-link config, we skip that condition (treat as non-match)
 * rather than misinterpret it. A Slice-5 pass can add proper aggregate
 * support once we have a story for what "count of entities in this
 * stream" means (window? per-config? per-target-shape?).
 */

import { compare } from '@/lib/style-rules/evaluator'
import type {
  AttrCondition,
  LegacyAttrCondition,
  RuleStyle,
  StyleRule,
} from '@/lib/style-rules/types'

/**
 * Read a value off an entity payload by attribute path.
 *
 * Mirrors `readBinAttribute`'s `custom.<key>` special case for
 * cross-compat — a rule that says `custom.temp` on a bin can also
 * read `custom.temp` on an entity payload structured with a
 * `customProperties` key. Plain dot notation is NOT supported (we
 * don't want to invent a mini query language mid-refactor); the
 * attribute is treated as a flat key otherwise.
 */
function readPayloadAttribute(
  payload: Record<string, unknown>,
  attribute: string,
): unknown {
  if (attribute.startsWith('custom.')) {
    const key = attribute.slice('custom.'.length)
    const custom = payload.customProperties
    if (custom && typeof custom === 'object') {
      return (custom as Record<string, unknown>)[key]
    }
    return undefined
  }
  return payload[attribute]
}

/**
 * Compile one condition (attr or legacy shape) into a payload predicate.
 * Aggregate conditions never get here — see file header.
 *
 * Same answer as `compare(op, readPayloadAttribute(payload, attribute),
 * value ?? null)`. The one thing done ahead of time is the `in` / `notIn`
 * set, which `compare` would otherwise rebuild for every payload.
 */
function compileCondition(
  cond: AttrCondition | LegacyAttrCondition,
): (payload: Record<string, unknown>) => boolean {
  const attrCond = 'type' in cond ? cond : { type: 'attr' as const, ...cond }
  const { attribute, op } = attrCond
  const rhs = attrCond.value ?? null
  if (op === 'in' || op === 'notIn') {
    const isIn = op === 'in'
    if (!Array.isArray(rhs)) {
      // `compare` answers without reading the value; the read is kept so a
      // malformed rule (no attribute) fails the same way it always did.
      return (payload) => {
        readPayloadAttribute(payload, attribute)
        return !isIn
      }
    }
    const set = new Set(rhs.map((x) => String(x)))
    return (payload) => {
      const has = set.has(String(readPayloadAttribute(payload, attribute) ?? ''))
      return isIn ? has : !has
    }
  }
  return (payload) => compare(op, readPayloadAttribute(payload, attribute), rhs)
}

/**
 * A config's rule list, filtered, sorted and compiled once. `evaluate`
 * returns exactly what `evaluateEntityRules` would for the same payload.
 */
export interface CompiledEntityRules {
  evaluate: (payload: Record<string, unknown>) => RuleStyle | null
  /**
   * True when a condition reads the clock (`olderThan` / `newerThan`), so
   * its answer for an unchanged payload can change over time. Callers that
   * cache per-row results must not reuse them while this is set.
   */
  timeDependent: boolean
  /**
   * The first instant (epoch ms) after `now` at which one of this
   * payload's clock conditions flips, i.e. when `evaluate` may start to
   * answer differently for the unchanged payload. `null` when none ever
   * will, and always `null` when `timeDependent` is false. A condition
   * counts even if it can't change the outcome (an OR partner already
   * holds, a higher-priority rule wins). That only costs a re-check.
   */
  nextClockChange: (payload: Record<string, unknown>, now: number) => number | null
}

const NO_RULES: CompiledEntityRules = {
  evaluate: () => null,
  timeDependent: false,
  nextClockChange: () => null,
}

/**
 * `compare`'s reading of a clock condition's operands (`asDateMs` and
 * `asNumber` in `style-rules/evaluator.ts`). Keep them in step with it:
 * they only decide WHEN a layer re-checks its rules. The colour itself
 * always comes from `compare`.
 */
function clockDateMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

function clockWindowMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * The first whole ms `n` at which a clock condition on timestamp `t` has
 * flipped: `compare` tests `n - t > window` for olderThan (false, then
 * true) and `n - t < window` for newerThan (true, then false). It starts
 * from `t + window` and steps to the exact instant under the same float
 * subtraction `compare` does. `null` beyond the safe-integer range, which
 * is hundreds of millennia away.
 */
function clockFlipAt(t: number, window: number, older: boolean): number | null {
  const flipped = older
    ? (n: number) => n - t > window
    : (n: number) => !(n - t < window)
  let n = Math.ceil(t + window)
  if (!(Math.abs(n) < Number.MAX_SAFE_INTEGER)) return null
  // The estimate is off by float rounding only, so a few steps at most.
  for (let i = 0; i < 4 && flipped(n - 1); i++) n--
  for (let i = 0; i < 4 && !flipped(n); i++) n++
  return n
}

/**
 * Compiled rule lists, keyed by the tenant's rule array (the spatial store
 * replaces it on every rule edit) and then by the config's id list.
 */
const compiledRulesCache = new WeakMap<
  ReadonlyArray<StyleRule>,
  Map<string, CompiledEntityRules>
>()

/**
 * Filter, sort and compile the rules a DataLinkConfig references, once per
 * (rule array, id list). The data-link overlay evaluates them for every
 * row on every push; before this, each row re-filtered and re-sorted the
 * whole rule catalog.
 */
export function compileEntityRules(
  allRules: ReadonlyArray<StyleRule>,
  styleRuleIds: ReadonlyArray<number>,
): CompiledEntityRules {
  if (styleRuleIds.length === 0 || allRules.length === 0) return NO_RULES
  const key = styleRuleIds.join(',')
  let perIds = compiledRulesCache.get(allRules)
  const hit = perIds?.get(key)
  if (hit) return hit

  const idSet = new Set(styleRuleIds)
  const scoped = allRules
    .filter((r) => r.enabled && r.id !== undefined && idSet.has(r.id))
    .sort((a, b) => a.priority - b.priority || (a.id ?? 0) - (b.id ?? 0))
  const compiled: Array<{
    conds: Array<(payload: Record<string, unknown>) => boolean>
    or: boolean
    style: RuleStyle
  }> = []
  let timeDependent = false
  // Each clock condition's attribute and window. `compare` is false for a
  // window it can't read, at any time, so those never flip.
  const clock: Array<{ attribute: string; window: number; older: boolean }> = []
  for (const rule of scoped) {
    if (rule.conditions.length === 0) continue
    // Filter out aggregate conditions we can't evaluate here.
    const evaluable = rule.conditions.filter(
      (c): c is AttrCondition | LegacyAttrCondition =>
        !('type' in c) || c.type !== 'aggregate',
    )
    if (evaluable.length === 0) continue
    for (const c of evaluable) {
      if (c.op === 'olderThan' || c.op === 'newerThan') {
        timeDependent = true
        const window = clockWindowMs(c.value ?? null)
        if (window !== null) clock.push({ attribute: c.attribute, window, older: c.op === 'olderThan' })
      }
    }
    compiled.push({
      conds: evaluable.map(compileCondition),
      or: rule.combine === 'or',
      style: rule.style,
    })
  }

  // Per payload object: the instants its clock conditions flip. They are
  // absolute, so they hold for any `now`, and the shared row objects
  // (`row-sharing`) mean each date string is parsed once.
  const flipsOf = new WeakMap<object, readonly number[]>()

  const result: CompiledEntityRules = {
    timeDependent,
    nextClockChange: (payload, now) => {
      if (clock.length === 0 || payload === null || typeof payload !== 'object') return null
      let flips = flipsOf.get(payload)
      if (!flips) {
        const list: number[] = []
        for (const c of clock) {
          const t = clockDateMs(readPayloadAttribute(payload, c.attribute))
          if (t === null) continue
          const at = clockFlipAt(t, c.window, c.older)
          if (at !== null) list.push(at)
        }
        flips = list
        flipsOf.set(payload, flips)
      }
      let next: number | null = null
      for (const at of flips) if (at > now && (next === null || at < next)) next = at
      return next
    },
    evaluate: (payload) => {
      for (const rule of compiled) {
        // Every condition is evaluated (no short-circuit), as before.
        let all = true
        let some = false
        for (const cond of rule.conds) {
          if (cond(payload)) some = true
          else all = false
        }
        if (rule.or ? some : all) return rule.style
      }
      return null
    },
  }
  if (!perIds) {
    perIds = new Map()
    compiledRulesCache.set(allRules, perIds)
  }
  perIds.set(key, result)
  return result
}

/**
 * Evaluate rules against an entity payload; return the first (in
 * priority order) matching rule's style overrides. `null` when no
 * rule matched.
 *
 * `styleRuleIds` filters the input catalog to only the rules the
 * DataLinkConfig references — we sort by `priority` then `id` for a
 * stable order matching the main rule engine's convention. The filtered
 * list is compiled once per (rule array, id list); see `compileEntityRules`.
 */
export function evaluateEntityRules(
  allRules: ReadonlyArray<StyleRule>,
  styleRuleIds: ReadonlyArray<number>,
  payload: Record<string, unknown>,
): RuleStyle | null {
  return compileEntityRules(allRules, styleRuleIds).evaluate(payload)
}

/**
 * The first instant (epoch ms) after `now` at which a clock rule flips
 * for any of `rows`, or `null` when none will. See
 * `CompiledEntityRules.nextClockChange`.
 */
export function nextRuleClockChange(
  rules: CompiledEntityRules,
  rows: Iterable<{ payload: Record<string, unknown> }>,
  now: number,
): number | null {
  if (!rules.timeDependent) return null
  let next: number | null = null
  for (const row of rows) {
    const at = rules.nextClockChange(row.payload, now)
    if (at !== null && (next === null || at < next)) next = at
  }
  return next
}

/**
 * Substitute `{attribute}` placeholders in a template string with the
 * payload's value at that attribute. Used for `RuleStyle.labelText`
 * templates so rules can write things like `"{status} · {value}°C"`.
 * Missing attributes render as empty string.
 */
export function resolveLabelTemplate(
  template: string,
  payload: Record<string, unknown>,
): string {
  return template.replace(/\{([^}]+)\}/g, (_, attr: string) => {
    const v = readPayloadAttribute(payload, attr.trim())
    if (v === null || v === undefined) return ''
    return String(v)
  })
}
