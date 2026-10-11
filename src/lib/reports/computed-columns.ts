/**
 * Client-side computed columns — user-authored expressions that
 * derive a new column from the query's already-fetched rows. Pure
 * JavaScript evaluation; the backend executor never sees these
 * (which is why they are trivially safe — no SQL, no injection
 * vector, and no filter/sort/aggregate participation, by design in
 * phase 1).
 *
 * Trade-off: a computed column cannot be filtered on, sorted on, or
 * used inside an aggregation. Phase 2 can promote hot expressions
 * into server-side SQL emitters registered in `queryx` — the
 * expression tree here is deliberately shaped so that migration is
 * a straightforward per-node translator, not a rewrite.
 */
import type { ReportFieldType, RunColumn } from '@/lib/reports-client'

/** All node kinds the expression tree supports. Small, closed set —
 *  the UI only builds trees the evaluator understands. */
export type ExpressionNode =
  | LiteralNode
  | ColumnNode
  | ConcatNode
  | BinaryNode
  | LogicalNode
  | IfNode
  | MatchNode
  | FnNode

export interface LiteralNode {
  kind: 'literal'
  value: string | number | boolean | null
}
export interface ColumnNode {
  kind: 'column'
  name: string
}
export interface ConcatNode {
  kind: 'concat'
  /** Separator inserted between parts. Empty string = no separator. */
  separator: string
  parts: ExpressionNode[]
}
export interface BinaryNode {
  kind: 'binary'
  op: '+' | '-' | '*' | '/' | '=' | '!=' | '>' | '<' | '>=' | '<='
  left: ExpressionNode
  right: ExpressionNode
}
export interface LogicalNode {
  kind: 'logical'
  op: 'AND' | 'OR' | 'NOT'
  args: ExpressionNode[]
}
export interface IfNode {
  kind: 'if'
  cond: ExpressionNode
  then: ExpressionNode
  else: ExpressionNode
}
export interface MatchNode {
  kind: 'match'
  column: string
  pattern: string
  caseInsensitive?: boolean
}
/** Named single-arg function calls — kept as a closed enum so the
 *  builder UI can render one form per name. */
export interface FnNode {
  kind: 'fn'
  name: 'LOWER' | 'UPPER' | 'TRIM' | 'LEN' | 'ROUND' | 'ABS'
  args: ExpressionNode[]
}

/** One user-declared computed column. */
export interface ComputedColumn {
  name: string
  type: ReportFieldType
  expression: ExpressionNode
}

/** Runtime result the evaluator returns — same shape as the wire
 *  RunReportResult (columns + rows) so widget renderers see no
 *  difference between real and computed columns. */
export interface EvaluatedResult {
  columns: RunColumn[]
  rows: unknown[][]
}

// ---------------------------------------------------------- evaluate

/** Fold every computed column into a query's raw result. Rows are
 *  extended with one extra value per column, appended in the same
 *  order the user declared them. Columns metadata is appended
 *  identically so downstream widgets can address them by name. */
export function evaluateComputedColumns(
  result: EvaluatedResult,
  computed: ComputedColumn[] | undefined,
): EvaluatedResult {
  if (!computed || computed.length === 0) return result
  const columnIndex = new Map<string, number>()
  result.columns.forEach((c, i) => columnIndex.set(c.name, i))

  const nextColumns: RunColumn[] = [...result.columns, ...computed.map((c) => ({ name: c.name, type: c.type }))]
  const nextRows = result.rows.map((row) => {
    const extended = [...row]
    // Each computed column can reference *previously-computed*
    // columns in its expression — evaluate in declaration order so
    // later columns see earlier ones on the same row.
    const rowIndex = new Map(columnIndex)
    for (let i = 0; i < computed.length; i++) {
      const col = computed[i]
      const value = coerceToDeclaredType(evaluate(col.expression, extended, rowIndex), col.type)
      extended.push(value)
      rowIndex.set(col.name, extended.length - 1)
    }
    return extended
  })
  return { columns: nextColumns, rows: nextRows }
}

/** Evaluate one node against a row. Values fall through the JS
 *  operator semantics (no coercion beyond what the operator itself
 *  does) — the wrapper `coerceToDeclaredType` normalises the final
 *  output to match the column's declared type. */
export function evaluate(
  node: ExpressionNode,
  row: unknown[],
  columnIndex: Map<string, number>,
): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value
    case 'column': {
      const idx = columnIndex.get(node.name)
      if (idx === undefined || idx >= row.length) return null
      return row[idx]
    }
    case 'concat': {
      return node.parts
        .map((p) => toStringSafe(evaluate(p, row, columnIndex)))
        .join(node.separator)
    }
    case 'binary': {
      const l = evaluate(node.left, row, columnIndex)
      const r = evaluate(node.right, row, columnIndex)
      switch (node.op) {
        case '+':
          // Numeric addition when both sides are number-like;
          // otherwise fall back to string concatenation for `+`.
          if (isNumberLike(l) && isNumberLike(r)) return Number(l) + Number(r)
          return toStringSafe(l) + toStringSafe(r)
        case '-':
          return numOr(l) - numOr(r)
        case '*':
          return numOr(l) * numOr(r)
        case '/': {
          const rr = numOr(r)
          if (rr === 0) return null
          return numOr(l) / rr
        }
        case '=':
          // Loose equality by design — dates, numbers-as-strings and
          // number values should match visually.
          // eslint-disable-next-line eqeqeq
          return l == r
        case '!=':
          // eslint-disable-next-line eqeqeq
          return l != r
        case '>':
          return compareLoose(l, r) > 0
        case '<':
          return compareLoose(l, r) < 0
        case '>=':
          return compareLoose(l, r) >= 0
        case '<=':
          return compareLoose(l, r) <= 0
      }
      return null
    }
    case 'logical': {
      switch (node.op) {
        case 'AND':
          return node.args.every((a) => Boolean(evaluate(a, row, columnIndex)))
        case 'OR':
          return node.args.some((a) => Boolean(evaluate(a, row, columnIndex)))
        case 'NOT':
          return !evaluate(node.args[0] ?? { kind: 'literal', value: false }, row, columnIndex)
      }
      return null
    }
    case 'if': {
      const cond = evaluate(node.cond, row, columnIndex)
      return cond
        ? evaluate(node.then, row, columnIndex)
        : evaluate(node.else, row, columnIndex)
    }
    case 'match': {
      const idx = columnIndex.get(node.column)
      if (idx === undefined) return false
      const src = toStringSafe(row[idx])
      const flags = node.caseInsensitive ? 'i' : ''
      try {
        return new RegExp(node.pattern, flags).test(src)
      } catch {
        // Malformed regex — treat as false rather than throwing so
        // one bad rule doesn't blank the whole table.
        return false
      }
    }
    case 'fn': {
      const [arg] = node.args
      const value = arg ? evaluate(arg, row, columnIndex) : null
      switch (node.name) {
        case 'LOWER':
          return toStringSafe(value).toLowerCase()
        case 'UPPER':
          return toStringSafe(value).toUpperCase()
        case 'TRIM':
          return toStringSafe(value).trim()
        case 'LEN':
          return toStringSafe(value).length
        case 'ROUND':
          return Math.round(numOr(value))
        case 'ABS':
          return Math.abs(numOr(value))
      }
      return null
    }
  }
}

// ---------------------------------------------------------- helpers

/** Coerce the raw evaluated value into the column's declared type so
 *  the widget renderers get predictable input (e.g. number columns
 *  don't suddenly hand back a boolean). */
function coerceToDeclaredType(value: unknown, type: ReportFieldType): unknown {
  if (value === null || value === undefined) return null
  switch (type) {
    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }
    case 'boolean':
      return Boolean(value)
    case 'date':
    case 'datetime':
      // Dates travel as ISO strings on the wire; keep whatever came out.
      return toStringSafe(value)
    default:
      return toStringSafe(value)
  }
}

function toStringSafe(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  return String(v)
}

function isNumberLike(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (trimmed === '') return false
    return Number.isFinite(Number(trimmed))
  }
  return false
}

function numOr(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Loose compare — numeric when both look like numbers, else
 *  lexicographic. Keeps ordering semantics predictable for mixed
 *  data (dates as strings still sort correctly). */
function compareLoose(a: unknown, b: unknown): number {
  if (isNumberLike(a) && isNumberLike(b)) return numOr(a) - numOr(b)
  const sa = toStringSafe(a)
  const sb = toStringSafe(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

// ---------------------------------------------------------- describe

/** Render a human-readable summary of an expression for the wizard's
 *  computed-columns list. Not perfect — but far more scannable than
 *  a raw JSON blob when the user comes back to a report a week
 *  later. */
export function describe(node: ExpressionNode): string {
  switch (node.kind) {
    case 'literal':
      return node.value === null ? 'null' : typeof node.value === 'string' ? `"${node.value}"` : String(node.value)
    case 'column':
      return node.name
    case 'concat':
      return node.parts.map(describe).join(` "${node.separator}" `)
    case 'binary':
      return `(${describe(node.left)} ${node.op} ${describe(node.right)})`
    case 'logical':
      if (node.op === 'NOT') return `NOT ${describe(node.args[0] ?? { kind: 'literal', value: false })}`
      return `(${node.args.map(describe).join(` ${node.op} `)})`
    case 'if':
      return `IF ${describe(node.cond)} THEN ${describe(node.then)} ELSE ${describe(node.else)}`
    case 'match':
      return `${node.column} MATCH /${node.pattern}/${node.caseInsensitive ? 'i' : ''}`
    case 'fn':
      return `${node.name}(${node.args.map(describe).join(', ')})`
  }
}
