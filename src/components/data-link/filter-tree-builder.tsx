/**
 * FilterTreeBuilder — the AND/OR condition tree editor.
 *
 * Extracted from the old viewer-side `view-filter-widget.tsx` in v5.
 * Authoring now happens once, in the data-link editor, and the result is
 * saved as a named preset; the viewer only picks between presets. So this
 * component is a controlled sub-form (`value` / `onChange`) rather than a
 * dialog that applies filters on its own.
 *
 *   • Type-aware operators — separate op catalog per field type
 *     (string / number / date / boolean) so users only see what works.
 *   • Schema-driven — GET `/api/v1/data-sources/:id/schema` supplies
 *     detected fields with inferred types, distinct values and numeric
 *     bounds, so the field picker is a dropdown rather than free text.
 *   • Server-side execution — the saved tree POSTs to
 *     `/api/v1/data-sources/:id/query`, which translates it to safe
 *     parameterised JSONB WHERE clauses.
 */

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { normaliseFilter } from '@/lib/data-link/query-client'
import type {
  DataSourceFieldSchema,
  DataSourceSchema,
} from '@/lib/data-link/query-client'
import type {
  DataLinkFieldType,
  DataLinkFilter,
  DataLinkFilterCondition,
  DataLinkFilterGroup,
  DataLinkFilterOp,
} from '@/lib/db'

/** Translation function type passed to child components. */
type TFunc = (key: string, opts?: Record<string, unknown>) => string

// ------------------------------------------ op catalog per field type

/** Ops available for each field type. Picking a field pares the
 *  dropdown down to the ops its type actually supports. */
export const OPS_BY_TYPE: Record<DataLinkFieldType, DataLinkFilterOp[]> = {
  string: ['eq', 'neq', 'contains', 'startsWith', 'endsWith', 'regex', 'in', 'notIn', 'exists', 'missing'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'notIn', 'exists', 'missing'],
  date: ['before', 'after', 'lastNDays', 'nextNDays', 'between', 'exists', 'missing'],
  boolean: ['eq', 'neq', 'exists', 'missing'],
  unknown: ['eq', 'neq', 'contains', 'exists', 'missing'],
}

export const OP_LABEL: Record<DataLinkFilterOp, string> = {
  eq: '= equals',
  neq: '≠ not equals',
  gt: '> greater than',
  gte: '≥ at least',
  lt: '< less than',
  lte: '≤ at most',
  between: '↔ between',
  contains: '≈ contains',
  startsWith: '⤳ starts with',
  endsWith: '⤴ ends with',
  regex: '.* matches regex',
  in: '∈ any of',
  notIn: '∉ none of',
  exists: '★ has value',
  missing: '∅ empty',
  before: '⟵ before',
  after: '⟶ after',
  lastNDays: '⏱ last N days',
  nextNDays: '⏱ next N days',
}

/** Compact, prose form used by `describeFilter` for read-only summaries. */
const OP_PHRASE: Record<DataLinkFilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  regex: 'matches',
  in: 'is any of',
  notIn: 'is none of',
  exists: 'has a value',
  missing: 'is empty',
  before: 'before',
  after: 'after',
  lastNDays: 'in the last',
  nextNDays: 'in the next',
}

export const OP_HINT: Record<DataLinkFilterOp, string> = {
  eq: 'Exact match — case-sensitive for text.',
  neq: 'Everything except this value.',
  gt: 'Numeric greater than.',
  gte: 'Numeric ≥.',
  lt: 'Numeric less than.',
  lte: 'Numeric ≤.',
  between: 'Range test (inclusive). Provide low and high.',
  contains: 'Substring, case-insensitive.',
  startsWith: 'Prefix match, case-insensitive.',
  endsWith: 'Suffix match, case-insensitive.',
  regex: 'PostgreSQL POSIX regular expression.',
  in: 'Value must be one of the listed items.',
  notIn: 'Value must not be in the listed items.',
  exists: 'Field is present and non-empty.',
  missing: 'Field is absent or empty string.',
  before: 'Timestamp is strictly before the given date.',
  after: 'Timestamp is strictly after the given date.',
  lastNDays: 'Timestamp within the last N days.',
  nextNDays: 'Timestamp within the next N days.',
}

// ================================================================
// Public component
// ================================================================

export interface FilterTreeBuilderProps {
  value: DataLinkFilterGroup
  schema: DataSourceSchema | null
  onChange: (next: DataLinkFilterGroup) => void
}

export function FilterTreeBuilder({
  value,
  schema,
  onChange,
}: FilterTreeBuilderProps) {
  const { t } = useTranslation()
  const addConditionAt = useCallback(
    (path: number[]) => {
      onChange(
        mutateGroup(value, path, (g) => {
          g.conditions.push(defaultCondition(schema))
        }),
      )
    },
    [value, schema, onChange],
  )

  const addGroupAt = useCallback(
    (path: number[]) => {
      onChange(
        mutateGroup(value, path, (g) => {
          g.conditions.push(emptyGroup())
        }),
      )
    },
    [value, onChange],
  )

  const removeAt = useCallback(
    (path: number[]) => {
      if (path.length === 0) {
        onChange(emptyGroup())
        return
      }
      const parent = path.slice(0, -1)
      const idx = path[path.length - 1]
      onChange(
        mutateGroup(value, parent, (g) => {
          g.conditions.splice(idx, 1)
        }),
      )
    },
    [value, onChange],
  )

  const updateAt = useCallback(
    (path: number[], patch: Partial<DataLinkFilterCondition>) => {
      if (path.length === 0) return
      const parent = path.slice(0, -1)
      const idx = path[path.length - 1]
      onChange(
        mutateGroup(value, parent, (g) => {
          const target = g.conditions[idx]
          if (target && target.kind === 'condition') {
            g.conditions[idx] = { ...target, ...patch } as DataLinkFilterCondition
          }
        }),
      )
    },
    [value, onChange],
  )

  const setCombine = useCallback(
    (path: number[], combine: 'and' | 'or') => {
      onChange(
        mutateGroup(value, path, (g) => {
          g.combine = combine
        }),
      )
    },
    [value, onChange],
  )

  return (
    <GroupEditor
      group={value}
      path={[]}
      schema={schema}
      depth={0}
      t={t}
      onSetCombine={setCombine}
      onUpdate={updateAt}
      onRemove={removeAt}
      onAddCondition={addConditionAt}
      onAddGroup={addGroupAt}
    />
  )
}

// ================================================================
// Group editor (recursive)
// ================================================================

function GroupEditor({
  group,
  path,
  schema,
  depth,
  t,
  onSetCombine,
  onUpdate,
  onRemove,
  onAddCondition,
  onAddGroup,
}: {
  group: DataLinkFilterGroup
  path: number[]
  schema: DataSourceSchema | null
  depth: number
  t: TFunc
  onSetCombine: (path: number[], combine: 'and' | 'or') => void
  onUpdate: (path: number[], patch: Partial<DataLinkFilterCondition>) => void
  onRemove: (path: number[]) => void
  onAddCondition: (path: number[]) => void
  onAddGroup: (path: number[]) => void
}) {
  const isRoot = path.length === 0
  return (
    <div
      className={
        'rounded-lg ' +
        (isRoot ? '' : 'border border-border/60 bg-muted/20 p-3')
      }
    >
      <div className="flex items-center gap-2 mb-3">
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          <button
            type="button"
            onClick={() => onSetCombine(path, 'and')}
            className={
              'text-xs px-3 py-1 transition-colors ' +
              (group.combine === 'and'
                ? 'bg-primary text-primary-foreground'
                : 'bg-background hover:bg-accent/40')
            }
          >
            AND
          </button>
          <button
            type="button"
            onClick={() => onSetCombine(path, 'or')}
            className={
              'text-xs px-3 py-1 transition-colors ' +
              (group.combine === 'or'
                ? 'bg-primary text-primary-foreground'
                : 'bg-background hover:bg-accent/40')
            }
          >
            OR
          </button>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {group.combine === 'and'
            ? t('filterTree.group.matchAll')
            : t('filterTree.group.matchAny')}
        </span>
        <div className="ms-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onAddCondition(path)}
          >
            <Plus size={12} className="me-1" />
            {t('filterTree.group.condition')}
          </Button>
          {depth < 3 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onAddGroup(path)}
            >
              <Plus size={12} className="me-1" />
              {t('filterTree.group.addGroup')}
            </Button>
          )}
          {!isRoot && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
              onClick={() => onRemove(path)}
              aria-label={t('filterTree.group.deleteGroup')}
            >
              <Trash2 size={13} />
            </Button>
          )}
        </div>
      </div>
      {group.conditions.length === 0 ? (
        <p className="text-[11px] text-muted-foreground text-center py-4 border border-dashed border-border/60 rounded-md">
          {t('filterTree.group.noConditionsPrefix')}{' '}
          <span className="font-semibold">{t('filterTree.group.noConditionsButton')}</span>{' '}
          {t('filterTree.group.noConditionsSuffix')}
        </p>
      ) : (
        <div className="grid gap-2">
          {group.conditions.map((child, i) => {
            const childPath = [...path, i]
            if (child.kind === 'group') {
              return (
                <GroupEditor
                  key={i}
                  group={child}
                  path={childPath}
                  schema={schema}
                  depth={depth + 1}
                  t={t}
                  onSetCombine={onSetCombine}
                  onUpdate={onUpdate}
                  onRemove={onRemove}
                  onAddCondition={onAddCondition}
                  onAddGroup={onAddGroup}
                />
              )
            }
            return (
              <ConditionRow
                key={i}
                condition={child}
                schema={schema}
                t={t}
                onUpdate={(patch) => onUpdate(childPath, patch)}
                onRemove={() => onRemove(childPath)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ================================================================
// Condition row
// ================================================================

function ConditionRow({
  condition,
  schema,
  t,
  onUpdate,
  onRemove,
}: {
  condition: DataLinkFilterCondition
  schema: DataSourceSchema | null
  t: TFunc
  onUpdate: (patch: Partial<DataLinkFilterCondition>) => void
  onRemove: () => void
}) {
  const [customField, setCustomField] = useState(false)
  const [showHint, setShowHint] = useState(false)

  const fieldSchema = schema?.fields.find((f) => f.field === condition.field)
  const effectiveType: DataLinkFieldType =
    condition.type ?? fieldSchema?.type ?? 'unknown'
  const availableOps = OPS_BY_TYPE[effectiveType] ?? OPS_BY_TYPE.unknown

  return (
    <div className="rounded-md border border-border bg-background p-3 grid gap-2">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-start">
        {/* Field */}
        <div className="grid gap-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {t('filterTree.field.label')}
          </Label>
          {schema && schema.fields.length > 0 && !customField ? (
            <select
              value={condition.field || ''}
              onChange={(e) => {
                if (e.target.value === '__custom__') {
                  setCustomField(true)
                  return
                }
                const f = schema.fields.find((x) => x.field === e.target.value)
                onUpdate({
                  field: e.target.value,
                  type: f?.type ?? 'unknown',
                  // Reset op if the current op isn't valid for the new type.
                  op:
                    f && !OPS_BY_TYPE[f.type].includes(condition.op)
                      ? OPS_BY_TYPE[f.type][0]
                      : condition.op,
                  value: undefined,
                })
              }}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              <option value="">{t('filterTree.field.pick')}</option>
              {schema.fields.map((f) => (
                <option key={f.field} value={f.field}>
                  {f.field}
                  {f.type !== 'unknown' ? `  ·  ${f.type}` : ''}
                </option>
              ))}
              <option value="__custom__">{t('filterTree.field.customPath')}</option>
            </select>
          ) : (
            <Input
              value={condition.field}
              onChange={(e) => onUpdate({ field: e.target.value })}
              placeholder={t('filterTree.field.customPlaceholder')}
              className="h-8 text-xs font-mono"
            />
          )}
        </div>

        {/* Op */}
        <div className="grid gap-1">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {t('filterTree.operator.label')}
          </Label>
          <select
            value={condition.op}
            onChange={(e) => onUpdate({ op: e.target.value as DataLinkFilterOp, value: undefined })}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            {availableOps.map((op) => (
              <option key={op} value={op}>
                {t(`filterTree.op.${op}`)}
              </option>
            ))}
          </select>
        </div>

        {/* Value */}
        <div className="grid gap-1 min-w-0">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {t('filterTree.value.label')}
          </Label>
          <ValueEditor
            condition={condition}
            fieldSchema={fieldSchema}
            t={t}
            onChange={(value) => onUpdate({ value })}
          />
        </div>

        {/* Delete + hint */}
        <div className="flex items-start gap-1 pt-4">
          <button
            type="button"
            onClick={() => setShowHint((v) => !v)}
            className="h-7 w-7 grid place-items-center rounded hover:bg-accent/60 text-muted-foreground"
            aria-label={t('filterTree.operator.hintToggle')}
            title={t('filterTree.operator.hintShow')}
          >
            {showHint ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="h-7 w-7 grid place-items-center rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive"
            aria-label={t('filterTree.operator.remove')}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {showHint && (
        <div className="text-[11px] text-muted-foreground bg-muted/40 rounded px-2 py-1.5">
          {t(`filterTree.opHint.${condition.op}`)}
        </div>
      )}
      {fieldSchema && effectiveType === 'number' && (
        (typeof fieldSchema.numericMin === 'number' ||
          typeof fieldSchema.numericMax === 'number') && (
          <div className="text-[10px] text-muted-foreground">
            {t('filterTree.value.observedRange')}{' '}
            <span className="font-mono tabular-nums">
              {fieldSchema.numericMin?.toLocaleString() ?? '—'}
            </span>{' '}
            →{' '}
            <span className="font-mono tabular-nums">
              {fieldSchema.numericMax?.toLocaleString() ?? '—'}
            </span>
          </div>
        )
      )}
    </div>
  )
}

// ================================================================
// Value editor — dispatches per op / type
// ================================================================

function ValueEditor({
  condition,
  fieldSchema,
  t,
  onChange,
}: {
  condition: DataLinkFilterCondition
  fieldSchema: DataSourceFieldSchema | undefined
  t: TFunc
  onChange: (value: DataLinkFilterCondition['value']) => void
}) {
  const { op } = condition
  const type = condition.type ?? fieldSchema?.type ?? 'unknown'

  if (op === 'exists' || op === 'missing') {
    return (
      <div className="text-xs text-muted-foreground h-8 flex items-center">
        {t('filterTree.value.noneNeeded')}
      </div>
    )
  }

  if (op === 'between') {
    const [lo, hi] = Array.isArray(condition.value)
      ? (condition.value as [string | number, string | number])
      : ['', '']
    const inputType = type === 'date' ? 'datetime-local' : type === 'number' ? 'number' : 'text'
    return (
      <div className="grid grid-cols-2 gap-1">
        <input
          type={inputType}
          value={String(lo ?? '')}
          onChange={(e) => onChange([e.target.value, String(hi ?? '')])}
          className="h-8 rounded-md border bg-background px-2 text-xs"
          placeholder={t('filterTree.value.low')}
        />
        <input
          type={inputType}
          value={String(hi ?? '')}
          onChange={(e) => onChange([String(lo ?? ''), e.target.value])}
          className="h-8 rounded-md border bg-background px-2 text-xs"
          placeholder={t('filterTree.value.high')}
        />
      </div>
    )
  }

  if (op === 'in' || op === 'notIn') {
    const arr = Array.isArray(condition.value)
      ? (condition.value as Array<string | number>)
      : []
    return (
      <div className="grid gap-1">
        <Input
          value={arr.join(', ')}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            )
          }
          placeholder={t('filterTree.value.list')}
          className="h-8 text-xs"
        />
      </div>
    )
  }

  if (op === 'lastNDays' || op === 'nextNDays') {
    return (
      <Input
        type="number"
        min={1}
        value={typeof condition.value === 'number' ? condition.value : ''}
        onChange={(e) => onChange(Number(e.target.value))}
        placeholder={t('filterTree.value.days')}
        className="h-8 text-xs"
      />
    )
  }

  if (op === 'before' || op === 'after' || (op === 'eq' && type === 'date')) {
    return (
      <input
        type="datetime-local"
        value={typeof condition.value === 'string' ? condition.value : ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-md border bg-background px-2 text-xs w-full"
      />
    )
  }

  if (type === 'boolean' && (op === 'eq' || op === 'neq')) {
    return (
      <select
        value={
          typeof condition.value === 'boolean'
            ? String(condition.value)
            : ''
        }
        onChange={(e) => onChange(e.target.value === 'true')}
        className="h-8 rounded-md border bg-background px-2 text-xs w-full"
      >
        <option value="">{t('filterTree.value.select')}</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }

  if (type === 'number') {
    return (
      <Input
        type="number"
        value={typeof condition.value === 'number' ? condition.value : ''}
        onChange={(e) => onChange(Number(e.target.value))}
        placeholder={t('filterTree.value.placeholder')}
        className="h-8 text-xs"
      />
    )
  }

  // String / unknown — text input + distinct-value pills.
  return (
    <div className="grid gap-1">
      <Input
        value={typeof condition.value === 'string' ? condition.value : ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('filterTree.value.placeholder')}
        className="h-8 text-xs"
      />
      {fieldSchema?.sample && fieldSchema.sample.length > 0 && fieldSchema.sample.length <= 12 && (
        <div className="flex flex-wrap gap-1">
          {fieldSchema.sample.slice(0, 8).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange(s)}
              className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent/60 font-mono"
              title={t('filterTree.value.use', { value: s })}
            >
              {s.length > 16 ? s.slice(0, 14) + '…' : s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ================================================================
// Schema status pill
// ================================================================

export function SchemaStatus({
  loading,
  error,
  schema,
}: {
  loading: boolean
  error: string | null
  schema: DataSourceSchema | null
}) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
        <Loader2 size={11} className="animate-spin" /> {t('filterTree.schema.inspecting')}
      </div>
    )
  }
  if (error) {
    return (
      <div className="text-[11px] text-destructive">
        {t('filterTree.schema.fetchError', { error })}
      </div>
    )
  }
  if (!schema) return null
  return (
    <div className="text-[11px] text-muted-foreground">
      {t('filterTree.schema.discoveredPrefix')}{' '}
      <span className="font-medium text-foreground">{schema.fields.length}</span>{' '}
      {t('filterTree.schema.field', { count: schema.fields.length })}{' '}
      {t('filterTree.schema.across')}{' '}
      <span className="font-medium text-foreground">
        {schema.rowCount.toLocaleString()}
      </span>{' '}
      {t('filterTree.schema.record', { count: schema.rowCount })}.
    </div>
  )
}

// ================================================================
// Tree helpers
// ================================================================

export function emptyGroup(): DataLinkFilterGroup {
  return { kind: 'group', combine: 'and', conditions: [] }
}

export function defaultCondition(
  schema: DataSourceSchema | null,
): DataLinkFilterCondition {
  const first = schema?.fields?.[0]
  return {
    kind: 'condition',
    field: first?.field ?? '',
    type: first?.type ?? 'unknown',
    op: 'eq',
    value: undefined,
  }
}

export function normaliseTree(
  filter: DataLinkFilter | null | undefined,
): DataLinkFilterGroup {
  const n = normaliseFilter(filter)
  if (!n) return emptyGroup()
  if (n.kind === 'group') return n
  return { kind: 'group', combine: 'and', conditions: [n] }
}

/**
 * Immutably apply `mut` to the group at `path`. Path is an array of
 * child indices from the root; empty path targets the root.
 */
export function mutateGroup(
  root: DataLinkFilterGroup,
  path: number[],
  mut: (g: DataLinkFilterGroup) => void,
): DataLinkFilterGroup {
  const clone = deepCloneGroup(root)
  let cursor: DataLinkFilterGroup = clone
  for (const i of path) {
    const next = cursor.conditions[i]
    if (!next || next.kind !== 'group') return root
    cursor = next
  }
  mut(cursor)
  return clone
}

export function deepCloneGroup(g: DataLinkFilterGroup): DataLinkFilterGroup {
  return {
    kind: 'group',
    combine: g.combine,
    conditions: g.conditions.map((c) =>
      c.kind === 'group' ? deepCloneGroup(c) : { ...c },
    ),
  }
}

export function countLeaves(g: DataLinkFilterGroup): number {
  let n = 0
  for (const c of g.conditions) {
    if (c.kind === 'group') n += countLeaves(c)
    else n++
  }
  return n
}

export function allLeavesValid(g: DataLinkFilterGroup): boolean {
  for (const c of g.conditions) {
    if (c.kind === 'group') {
      if (!allLeavesValid(c)) return false
      continue
    }
    if (!c.field || !c.op) return false
    if (isConditionValueMissing(c)) return false
  }
  return true
}

/**
 * Every leaf needs a field + operator, but the value slot may be blank —
 * blanks become runtime prompts the viewer fills in when they pick the
 * chip. This is the check the editor uses to enable "Save".
 */
export function allLeavesAuthorable(g: DataLinkFilterGroup): boolean {
  for (const c of g.conditions) {
    if (c.kind === 'group') {
      if (!allLeavesAuthorable(c)) return false
      continue
    }
    if (!c.field || !c.op) return false
  }
  return true
}

/**
 * True when the operator needs a value and the value slot is empty. Ops
 * like `exists`/`missing` never need one, so they're never prompts.
 */
export function isConditionValueMissing(c: DataLinkFilterCondition): boolean {
  if (c.op === 'exists' || c.op === 'missing') return false
  if (c.op === 'between') {
    return (
      !Array.isArray(c.value) ||
      c.value.length !== 2 ||
      c.value.some((v) => v === '' || v === undefined || v === null)
    )
  }
  if (c.op === 'in' || c.op === 'notIn') {
    return !Array.isArray(c.value) || c.value.length === 0
  }
  return c.value === undefined || c.value === null || c.value === ''
}

/**
 * Prompt leaves in traversal order — the same order `resolvePromptValues`
 * consumes runtime values from, so the viewer can index them positionally.
 */
export function collectPromptLeaves(
  g: DataLinkFilterGroup,
): DataLinkFilterCondition[] {
  const out: DataLinkFilterCondition[] = []
  const walk = (grp: DataLinkFilterGroup) => {
    for (const c of grp.conditions) {
      if (c.kind === 'group') walk(c)
      else if (c.field && c.op && isConditionValueMissing(c)) out.push(c)
    }
  }
  walk(g)
  return out
}

/**
 * Return a copy of the tree with runtime values injected into prompt
 * leaves in the same order `collectPromptLeaves` returns them.
 * Missing/undefined entries in `values` leave that leaf as a prompt so
 * `allLeavesValid` on the result still rejects the incomplete filter.
 */
export function resolvePromptValues(
  g: DataLinkFilterGroup,
  values: ReadonlyArray<DataLinkFilterCondition['value']>,
): DataLinkFilterGroup {
  let i = 0
  const walk = (grp: DataLinkFilterGroup): DataLinkFilterGroup => ({
    kind: 'group',
    combine: grp.combine,
    conditions: grp.conditions.map((c) => {
      if (c.kind === 'group') return walk(c)
      if (c.field && c.op && isConditionValueMissing(c)) {
        const v = values[i++]
        return v === undefined ? c : { ...c, value: v }
      }
      return c
    }),
  })
  return walk(g)
}

/**
 * Filter to just the complete leaves, dropping prompts entirely. Used by
 * the editor's preview count so the author sees an approximate match
 * count while some values are still blank.
 */
export function stripPromptLeaves(
  g: DataLinkFilterGroup,
): DataLinkFilterGroup {
  const walk = (grp: DataLinkFilterGroup): DataLinkFilterGroup => {
    const out: Array<DataLinkFilterCondition | DataLinkFilterGroup> = []
    for (const c of grp.conditions) {
      if (c.kind === 'group') {
        const inner = walk(c)
        if (inner.conditions.length > 0) out.push(inner)
      } else if (c.field && c.op && !isConditionValueMissing(c)) {
        out.push(c)
      }
    }
    return { kind: 'group', combine: grp.combine, conditions: out }
  }
  return walk(g)
}

/**
 * Human-readable one-liner for a saved filter, e.g.
 * `status is "active" AND (temp > 30 OR humidity ≥ 80)`.
 *
 * Both sides need this: the editor shows it under each preset so the
 * author can sanity-check a rule without reopening the builder, and the
 * viewer shows it as the read-only explanation of the active chip.
 */
export function describeFilter(
  filter: DataLinkFilter | null | undefined,
  maxLeaves = 4,
): string {
  const tree = normaliseTree(filter)
  if (tree.conditions.length === 0) return ''
  let remaining = maxLeaves
  let truncated = 0

  const walk = (g: DataLinkFilterGroup, depth: number): string => {
    const parts: string[] = []
    for (const c of g.conditions) {
      if (c.kind === 'group') {
        const inner = walk(c, depth + 1)
        if (inner) parts.push(depth === 0 && g.conditions.length === 1 ? inner : `(${inner})`)
        continue
      }
      if (remaining <= 0) {
        truncated++
        continue
      }
      remaining--
      parts.push(describeCondition(c))
    }
    return parts.join(g.combine === 'and' ? ' AND ' : ' OR ')
  }

  const body = walk(tree, 0)
  return truncated > 0 ? `${body} +${truncated} more` : body
}

function describeCondition(c: DataLinkFilterCondition): string {
  const field = c.field || '?'
  const phrase = OP_PHRASE[c.op] ?? c.op
  if (c.op === 'exists' || c.op === 'missing') return `${field} ${phrase}`
  if (c.op === 'lastNDays' || c.op === 'nextNDays') {
    return `${field} ${phrase} ${c.value ?? '?'} days`
  }
  if (c.op === 'between' && Array.isArray(c.value)) {
    return `${field} ${phrase} ${formatValue(c.value[0])} and ${formatValue(c.value[1])}`
  }
  if ((c.op === 'in' || c.op === 'notIn') && Array.isArray(c.value)) {
    const shown = c.value.slice(0, 3).map(formatValue).join(', ')
    const more = c.value.length > 3 ? `, +${c.value.length - 3}` : ''
    return `${field} ${phrase} [${shown}${more}]`
  }
  return `${field} ${phrase} ${formatValue(c.value)}`
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null || v === '') return '?'
  if (typeof v === 'string') return `"${v.length > 20 ? v.slice(0, 18) + '…' : v}"`
  return String(v)
}
