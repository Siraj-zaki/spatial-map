/**
 * Style-rule types.
 *
 * A StyleRule describes a condition over a bin's attributes and a set of
 * visual overrides to apply when that condition matches. Rules turn the
 * data the user has imported (status, sku, capacity, custom WMS fields,
 * sync metadata) into colour/opacity/elevation signal on the map without
 * a code change per layout.
 *
 * Phase 3 generalises the engine so a rule can:
 *   - target one shape, one cell, every shape of a kind, or every shape
 *     of a kind in a warehouse
 *   - source data from itself (default), one shape/cell, every cell of
 *     a rack, or every shape of a kind
 *   - use quantified conditions (every / some / none) and aggregate
 *     conditions (count / sum / avg / min / max) over the source bin set
 *
 * Backward compat: rules saved before this refactor (single source,
 * single conditions, scope-only target) keep evaluating unchanged.
 * The new selector / quantifier / aggregate fields are all optional.
 */

import type { BindingKind } from '@/lib/db'
import type { ShapeLink } from '@/lib/shape-link'

/**
 * Which shape kind(s) a rule applies to. `any` means every kind.
 * `text-label` and `stair` are accepted as scopes even though they
 * aren't `BindingKind` themselves — rules targeting them only fire
 * when the rule supplies a `source` (cross-shape linking).
 */
export type StyleRuleScope = BindingKind | 'any' | 'text-label' | 'stair'

/** Boolean operators a single-bin condition supports. */
export type RuleOp =
  | 'equals'
  | 'notEquals'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'notIn'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'isSet'
  | 'olderThan'
  | 'newerThan'

/**
 * Quantifier for a standard attribute condition when the rule's source
 * resolves to more than one bin.
 *
 *   - `single`  — implicit default; the condition reads a single bin
 *                 (used for `self` and `single` sources).
 *   - `every`   — every source bin must satisfy the condition.
 *   - `some`    — at least one source bin must satisfy.
 *   - `none`    — no source bin may satisfy.
 *
 * For `self` / `single` sources only `single` makes sense; the UI
 * hides the quantifier picker in that case.
 */
export type RuleQuantifier = 'single' | 'every' | 'some' | 'none'

/**
 * Operators for numeric aggregates (count, sum, avg, min, max). A
 * narrow comparator set is enough because the aggregated value is
 * always a number.
 */
export type AggregateOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'

/**
 * Aggregate function applied to the source bin set. `count` doesn't
 * need an attribute (it just counts bins); the others reduce a
 * numeric attribute across bins. `countWhere` is a convenience for
 * "how many bins satisfy `where`" without introducing a separate
 * predicate language — we reuse the standard attr/op/value shape.
 */
export type AggregateFn = 'count' | 'countWhere' | 'sum' | 'avg' | 'min' | 'max'

/**
 * One condition. Three variants:
 *   - `attr`       — read one bin's attribute (with optional quantifier
 *                    when the source resolves to many bins).
 *   - `aggregate`  — reduce the source bin set with an aggregate fn,
 *                    then compare the scalar result to `value`.
 *   - legacy shape — `{ attribute, op, value }` with no `type` field;
 *                    the evaluator treats it as `{ type: 'attr', … }`.
 *
 * Built-in attribute paths: `status`, `sku`, `capacity`, `notes`,
 * `externalCode`, `syncSource`, `lastSyncedAt`. Custom paths:
 * `custom.<key>` indirects into `bin.customProperties`.
 */
export type RuleCondition = AttrCondition | AggregateCondition | LegacyAttrCondition

export interface AttrCondition {
  type: 'attr'
  attribute: string
  op: RuleOp
  value?: string | number | boolean | Array<string | number> | null
  quantifier?: RuleQuantifier
}

export interface AggregateCondition {
  type: 'aggregate'
  fn: AggregateFn
  /** Attribute reduced over (required for sum/avg/min/max; optional for count/countWhere). */
  attribute?: string
  /** For `countWhere`: only count bins where `whereAttribute whereOp whereValue`. */
  whereAttribute?: string
  whereOp?: RuleOp
  whereValue?: AttrCondition['value']
  /** Comparator vs the aggregated scalar. */
  op: AggregateOp
  value: number
}

/**
 * Legacy condition shape — no `type` discriminator. Persisted rules
 * predating Phase 3 use this; the evaluator widens them to
 * `AttrCondition` at read time.
 */
export interface LegacyAttrCondition {
  attribute: string
  op: RuleOp
  value?: string | number | boolean | Array<string | number> | null
}

/**
 * What the rule paints. Every field is optional — only set the ones the
 * rule should override. Fields use the same units as the underlying
 * shape config (opacity 0-100, lengths in meters, colours as hex).
 *
 * `labelText` supports `{attribute}` placeholders which are substituted
 * with the source bin's value at evaluation time (e.g. `"{sku}"`,
 * `"{custom.qty} units"`).
 */
export interface RuleStyle {
  fillColor?: string
  fillOpacity?: number
  borderColor?: string
  borderWidth?: number
  elevation?: number
  height?: number
  iconColor?: string
  labelColor?: string
  labelText?: string
}

// ---------------------------------------------------------- selectors

/**
 * Where the rule's data comes from. Resolved to a set of bins; the
 * conditions then evaluate over that set with their quantifier /
 * aggregate.
 */
export type SourceSelector =
  | { type: 'self' }
  | { type: 'single'; shape: ShapeLink }
  | { type: 'allCellsOf'; gridId: number }
  | {
      type: 'allOfKind'
      kind: BindingKind
      /** Optional warehouse scope — only bins inside this zone count. */
      zoneId?: number
    }

/**
 * Where the rule's override lands. Resolved to a set of target keys
 * (shape ids or grid-cell addresses) the resolver writes into.
 */
export type TargetSelector =
  | { type: 'all' }
  | { type: 'shape'; kind: BindingKind | 'text-label' | 'stair'; id: number }
  | { type: 'cell'; gridId: number; row: number; col: number; level?: number }
  | {
      type: 'inWarehouse'
      kind: BindingKind | 'text-label' | 'stair'
      zoneId: number
    }

/** One persisted rule row. Stored in `db.styleRules`. */
export interface StyleRule {
  id?: number
  /** Human-readable label shown in the rules list. */
  name: string
  /** Which shape kind the rule targets. */
  scope: StyleRuleScope
  /** Optional warehouse scope — only run against bins in this zone. */
  zoneId?: number
  /** When false the rule is ignored (still listed, can be flipped back on). */
  enabled: boolean
  /**
   * Lower priority wins. Rules are evaluated in ascending order; the
   * first match's `style` is applied and later rules are skipped for
   * that target. Stable across reloads (we sort by priority then id).
   */
  priority: number
  /** AND-or-OR combiner for the conditions list. */
  combine: 'and' | 'or'
  conditions: RuleCondition[]
  style: RuleStyle

  // ---- Phase 3: full selectors -----------------------------------------
  /** Where the rule sources its data. Defaults to `{ type: 'self' }`. */
  source?: SourceSelector
  /** Where the rule applies. Defaults to `{ type: 'all' }`. */
  target?: TargetSelector

  // ---- Phase 2 (legacy) shortcuts kept for back-compat -----------------
  /** Same as `target = { type: 'shape', kind: scope, id: targetShapeId }`. */
  targetShapeId?: number
  /** Same as `target = { type: 'cell', ... }`. */
  targetGridCell?: {
    gridId: number
    row: number
    col: number
    level?: number
  }
  /** Same as `source = { type: 'single', shape: sourceShape }`. */
  sourceShape?: ShapeLink

  createdAt: Date
  updatedAt: Date
}

/**
 * A resolved override the overlay should apply to one target. Empty
 * when no rule matched; otherwise carries the style from the
 * first-priority-wins rule.
 */
export interface ResolvedStyle {
  /** The matching rule's id — handy for tooltips / dev tooling. */
  ruleId: number
  /** The matching rule's name — shown in the side panel for diagnostics. */
  ruleName: string
  /** The style payload to merge with the base shape config. */
  style: RuleStyle
}
