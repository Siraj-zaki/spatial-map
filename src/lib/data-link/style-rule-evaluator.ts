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
 * True when a condition (attr or legacy shape) matches the payload.
 * Aggregate conditions return false — see file header.
 */
function conditionMatches(
  cond: AttrCondition | LegacyAttrCondition,
  payload: Record<string, unknown>,
): boolean {
  const attrCond = 'type' in cond ? cond : { type: 'attr' as const, ...cond }
  const lhs = readPayloadAttribute(payload, attrCond.attribute)
  return compare(attrCond.op, lhs, attrCond.value ?? null)
}

/**
 * Evaluate rules against an entity payload; return the first (in
 * priority order) matching rule's style overrides. `null` when no
 * rule matched.
 *
 * `styleRuleIds` filters the input catalog to only the rules the
 * DataLinkConfig references — we sort by `priority` then `id` for a
 * stable order matching the main rule engine's convention.
 */
export function evaluateEntityRules(
  allRules: ReadonlyArray<StyleRule>,
  styleRuleIds: ReadonlyArray<number>,
  payload: Record<string, unknown>,
): RuleStyle | null {
  if (styleRuleIds.length === 0 || allRules.length === 0) return null
  const idSet = new Set(styleRuleIds)
  const scoped = allRules
    .filter((r) => r.enabled && r.id !== undefined && idSet.has(r.id))
    .sort((a, b) => a.priority - b.priority || (a.id ?? 0) - (b.id ?? 0))
  for (const rule of scoped) {
    if (rule.conditions.length === 0) continue
    // Filter out aggregate conditions we can't evaluate here.
    const evaluable = rule.conditions.filter(
      (c): c is AttrCondition | LegacyAttrCondition =>
        !('type' in c) || c.type !== 'aggregate',
    )
    if (evaluable.length === 0) continue
    const hits = evaluable.map((c) => conditionMatches(c, payload))
    const all = hits.every(Boolean)
    const some = hits.some(Boolean)
    const passed = rule.combine === 'or' ? some : all
    if (passed) return rule.style
  }
  return null
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
