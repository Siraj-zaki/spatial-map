/**
 * Public surface for the style-rules engine.
 *
 * The runtime is split in three:
 *   types      — shape of a rule, condition, style payload
 *   evaluator  — pure rule-vs-bin comparisons
 *   resolver   — given (rules, bins), produce per-target overrides
 *
 * The overlay layer reads via the resolver; the sidebar reads/writes
 * via Dexie (`db.styleRules`) directly.
 */

export type {
  StyleRule,
  StyleRuleScope,
  RuleCondition,
  RuleOp,
  RuleStyle,
  ResolvedStyle,
} from './types'

export {
  evaluateCondition,
  evaluateRule,
  readBinAttribute,
  renderLabelTemplate,
  resolveStyle,
  sortRulesForEval,
} from './evaluator'

export {
  gridCellKey,
  resolveStyleMaps,
} from './resolver'
export type { ResolvedStyleMaps, ViewerIndex } from './resolver'
