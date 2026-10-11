import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ChevronDown,
  Combine,
  FunctionSquare as FunctionIcon,
  GitCompareArrows,
  Loader2,
  Plus,
  Regex,
  Sigma,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  getReportSourceSchema,
  type ReportFieldType,
  type ReportSourceSchema,
} from '@/lib/reports-client'
import {
  describe,
  type ComputedColumn,
  type ExpressionNode,
} from '@/lib/reports/computed-columns'
import { useWizard } from '../wizard-state'

/** One authoring template — a chart of pre-shaped expression trees
 *  the user can start from, so the builder doesn't force them to
 *  reason about AST kinds. */
type TemplateId = 'concat' | 'if' | 'arithmetic' | 'match' | 'fn'

interface TemplateDef {
  id: TemplateId
  label: string
  hint: string
  icon: typeof Combine
  build: (schema: ReportSourceSchema) => { expression: ExpressionNode; type: ReportFieldType }
}

const TEMPLATES: TemplateDef[] = [
  {
    id: 'concat',
    label: 'Combine text',
    hint: 'Join two or more columns into a single string',
    icon: Combine,
    build: (s) => ({
      expression: {
        kind: 'concat',
        separator: ' ',
        parts: [
          { kind: 'column', name: firstText(s) },
          { kind: 'column', name: secondText(s) },
        ],
      },
      type: 'text',
    }),
  },
  {
    id: 'if',
    label: 'If / then / else',
    hint: 'Return one value when a condition is true, another when false',
    icon: GitCompareArrows,
    build: (s) => ({
      expression: {
        kind: 'if',
        cond: {
          kind: 'binary',
          op: '>',
          left: { kind: 'column', name: firstNumber(s) },
          right: { kind: 'literal', value: 0 },
        },
        then: { kind: 'literal', value: 'yes' },
        else: { kind: 'literal', value: 'no' },
      },
      type: 'text',
    }),
  },
  {
    id: 'arithmetic',
    label: 'Arithmetic',
    hint: 'Add, subtract, multiply, or divide two columns',
    icon: Sigma,
    build: (s) => ({
      expression: {
        kind: 'binary',
        op: '+',
        left: { kind: 'column', name: firstNumber(s) },
        right: { kind: 'literal', value: 0 },
      },
      type: 'number',
    }),
  },
  {
    id: 'match',
    label: 'Match pattern',
    hint: 'True when a column matches a regex or substring',
    icon: Regex,
    build: (s) => ({
      expression: {
        kind: 'match',
        column: firstText(s),
        pattern: '',
        caseInsensitive: true,
      },
      type: 'boolean',
    }),
  },
  {
    id: 'fn',
    label: 'Function',
    hint: 'Uppercase, lowercase, trim, length, round, absolute value',
    icon: FunctionIcon,
    build: (s) => ({
      expression: {
        kind: 'fn',
        name: 'UPPER',
        args: [{ kind: 'column', name: firstText(s) }],
      },
      type: 'text',
    }),
  },
]

function firstText(s: ReportSourceSchema): string {
  return (s.fields.find((f) => f.type === 'text') ?? s.fields[0])?.key ?? ''
}
function secondText(s: ReportSourceSchema): string {
  const t = s.fields.filter((f) => f.type === 'text')
  return (t[1] ?? t[0] ?? s.fields[0])?.key ?? ''
}
function firstNumber(s: ReportSourceSchema): string {
  return (s.fields.find((f) => f.type === 'number') ?? s.fields[0])?.key ?? ''
}

export function CustomColumnsStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()
  const sourceId = draft.sourceRef?.id
  const [loaded, setLoaded] = useState<{
    key: number
    schema: ReportSourceSchema | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    if (sourceId === undefined) return
    let cancelled = false
    getReportSourceSchema(sourceId)
      .then((s) => {
        if (!cancelled) setLoaded({ key: sourceId, schema: s, error: null })
      })
      .catch((err) => {
        if (!cancelled) setLoaded({ key: sourceId, schema: null, error: (err as Error).message })
      })
    return () => {
      cancelled = true
    }
  }, [sourceId])

  // Keyed by source id — "loading" means no result for this source yet.
  const current = sourceId !== undefined && loaded?.key === sourceId ? loaded : null
  const loading = sourceId !== undefined && !current
  const schema = current?.schema ?? null
  const error = current?.error ?? null

  if (!draft.sourceRef) {
    return (
      <div className="text-sm text-muted-foreground italic py-6 text-center border-2 border-dashed border-border rounded-md">
        {t('reports.wizard.customColumns.needSource', { defaultValue: 'Pick a data source first.' })}
      </div>
    )
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('reports.wizard.customColumns.loading', { defaultValue: 'Loading schema…' })}
      </div>
    )
  }
  if (error || !schema) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>{error ?? t('reports.wizard.customColumns.noSchema', { defaultValue: 'Could not load fields.' })}</span>
      </div>
    )
  }

  const patchColumn = (idx: number, patch: Partial<ComputedColumn>) => {
    const next = [...draft.computedColumns]
    next[idx] = { ...next[idx], ...patch }
    update({ computedColumns: next })
  }

  const removeColumn = (idx: number) => {
    update({ computedColumns: draft.computedColumns.filter((_, i) => i !== idx) })
  }

  const addFromTemplate = (tpl: TemplateDef) => {
    const built = tpl.build(schema)
    const nextIdx = draft.computedColumns.length + 1
    update({
      computedColumns: [
        ...draft.computedColumns,
        {
          name: `custom_${nextIdx}`,
          type: built.type,
          expression: built.expression,
        },
      ],
    })
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <p className="text-xs text-muted-foreground">
        {t('reports.wizard.customColumns.hint', {
          defaultValue: 'Computed columns are calculated in the browser after the report runs — they appear in tables and charts alongside real columns, but cannot be filtered or sorted server-side.',
        })}
      </p>

      {/* Existing custom columns */}
      {draft.computedColumns.length > 0 && (
        <ul className="space-y-2">
          {draft.computedColumns.map((c, idx) => (
            <CustomColumnCard
              key={idx}
              column={c}
              schema={schema}
              onChange={(patch) => patchColumn(idx, patch)}
              onRemove={() => removeColumn(idx)}
            />
          ))}
        </ul>
      )}

      {/* Add from template */}
      <div className="border-t border-border pt-4 space-y-2">
        <Label>{t('reports.wizard.customColumns.add', { defaultValue: 'Add a custom column' })}</Label>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TEMPLATES.map((tpl) => {
            const Icon = tpl.icon
            return (
              <button
                key={tpl.id}
                type="button"
                onClick={() => addFromTemplate(tpl)}
                className="group flex items-start gap-3 rounded-lg border border-border p-3 text-left hover:border-primary/50 hover:bg-accent/50 transition-colors"
              >
                <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-muted text-muted-foreground group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                  <Icon className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {t(`reports.wizard.customColumns.template.${tpl.id}`, { defaultValue: tpl.label })}
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-snug mt-0.5">
                    {t(`reports.wizard.customColumns.template.${tpl.id}Hint`, { defaultValue: tpl.hint })}
                  </div>
                </div>
                <Plus className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-1" />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** One custom column row — inline expression editor keyed off the
 *  node kind of `column.expression`. Node-specific inputs render
 *  the operands (column pickers, literal inputs, operator selects)
 *  so the user never sees the raw AST. */
function CustomColumnCard({
  column,
  schema,
  onChange,
  onRemove,
}: {
  column: ComputedColumn
  schema: ReportSourceSchema
  onChange: (patch: Partial<ComputedColumn>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)

  const patchExpr = (expression: ExpressionNode) => onChange({ expression })

  return (
    <li className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !expanded && '-rotate-90')} />
        </button>
        <Input
          value={column.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="h-7 text-sm font-medium max-w-[16rem]"
          placeholder="column_name"
        />
        <select
          value={column.type}
          onChange={(e) => onChange({ type: e.target.value as ReportFieldType })}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
        </select>
        <div className="flex-1 min-w-0 text-[10px] text-muted-foreground truncate font-mono">
          = {describe(column.expression)}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onRemove}
          aria-label={t('reports.wizard.customColumns.remove', { defaultValue: 'Remove' })}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border">
          <ExpressionEditor node={column.expression} schema={schema} onChange={patchExpr} />
        </div>
      )}
    </li>
  )
}

// ---------------------------------------------------------- editors

/** Per-node editor — switches on the AST kind of the current node.
 *  For nodes with sub-expressions (binary, if, concat), the editor
 *  recursively renders itself for each child so the whole tree is
 *  editable inline. */
function ExpressionEditor({
  node,
  schema,
  onChange,
}: {
  node: ExpressionNode
  schema: ReportSourceSchema
  onChange: (n: ExpressionNode) => void
}) {
  switch (node.kind) {
    case 'concat':
      return <ConcatEditor node={node} schema={schema} onChange={onChange} />
    case 'binary':
      return <BinaryEditor node={node} schema={schema} onChange={onChange} />
    case 'if':
      return <IfEditor node={node} schema={schema} onChange={onChange} />
    case 'match':
      return <MatchEditor node={node} schema={schema} onChange={onChange} />
    case 'fn':
      return <FnEditor node={node} schema={schema} onChange={onChange} />
    default:
      return <LeafEditor node={node} schema={schema} onChange={onChange} />
  }
}

/** Leaf editor — literal or column reference. Picker on the left,
 *  input on the right, wrapper handles the switch. */
function LeafEditor({
  node,
  schema,
  onChange,
}: {
  node: ExpressionNode
  schema: ReportSourceSchema
  onChange: (n: ExpressionNode) => void
}) {
  const isColumn = node.kind === 'column'
  const isLiteral = node.kind === 'literal'
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={isColumn ? 'column' : isLiteral ? 'literal' : ''}
        onChange={(e) => {
          if (e.target.value === 'column') {
            onChange({ kind: 'column', name: schema.fields[0]?.key ?? '' })
          } else {
            onChange({ kind: 'literal', value: '' })
          }
        }}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs"
      >
        <option value="column">column</option>
        <option value="literal">literal</option>
      </select>
      {isColumn && (
        <select
          value={(node as { name: string }).name}
          onChange={(e) => onChange({ kind: 'column', name: e.target.value })}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs flex-1"
        >
          {schema.fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label || f.key}
            </option>
          ))}
        </select>
      )}
      {isLiteral && (
        <Input
          value={String((node as { value: unknown }).value ?? '')}
          onChange={(e) => onChange({ kind: 'literal', value: e.target.value })}
          className="h-7 text-xs flex-1"
          placeholder="value"
        />
      )}
    </div>
  )
}

function ConcatEditor({
  node,
  schema,
  onChange,
}: {
  node: Extract<ExpressionNode, { kind: 'concat' }>
  schema: ReportSourceSchema
  onChange: (n: ExpressionNode) => void
}) {
  const { t } = useTranslation()
  const patchPart = (i: number, next: ExpressionNode) => {
    const parts = [...node.parts]
    parts[i] = next
    onChange({ ...node, parts })
  }
  const removePart = (i: number) => onChange({ ...node, parts: node.parts.filter((_, x) => x !== i) })
  const addPart = () =>
    onChange({ ...node, parts: [...node.parts, { kind: 'column', name: schema.fields[0]?.key ?? '' }] })

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
          {t('reports.wizard.customColumns.separator', { defaultValue: 'Separator' })}
        </Label>
        <Input
          value={node.separator}
          onChange={(e) => onChange({ ...node, separator: e.target.value })}
          className="h-7 text-xs w-24"
          placeholder="' '"
        />
      </div>
      <div className="space-y-1">
        {node.parts.map((p, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <LeafEditor node={p} schema={schema} onChange={(n) => patchPart(i, n)} />
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => removePart(i)}>
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        ))}
      </div>
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addPart}>
        <Plus className="w-3 h-3 me-1" />
        {t('reports.wizard.customColumns.addPart', { defaultValue: 'Add part' })}
      </Button>
    </div>
  )
}

const BINARY_OPS = ['+', '-', '*', '/', '=', '!=', '>', '<', '>=', '<='] as const

function BinaryEditor({
  node,
  schema,
  onChange,
}: {
  node: Extract<ExpressionNode, { kind: 'binary' }>
  schema: ReportSourceSchema
  onChange: (n: ExpressionNode) => void
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <div className="flex-1 min-w-[10rem]">
        <LeafEditor node={node.left} schema={schema} onChange={(n) => onChange({ ...node, left: n })} />
      </div>
      <select
        value={node.op}
        onChange={(e) => onChange({ ...node, op: e.target.value as typeof BINARY_OPS[number] })}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs w-16"
      >
        {BINARY_OPS.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>
      <div className="flex-1 min-w-[10rem]">
        <LeafEditor node={node.right} schema={schema} onChange={(n) => onChange({ ...node, right: n })} />
      </div>
    </div>
  )
}

function IfEditor({
  node,
  schema,
  onChange,
}: {
  node: Extract<ExpressionNode, { kind: 'if' }>
  schema: ReportSourceSchema
  onChange: (n: ExpressionNode) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2 text-xs">
      <Row label={t('reports.wizard.customColumns.if', { defaultValue: 'IF' })}>
        <BinaryEditor
          node={ensureBinary(node.cond)}
          schema={schema}
          onChange={(n) => onChange({ ...node, cond: n })}
        />
      </Row>
      <Row label={t('reports.wizard.customColumns.then', { defaultValue: 'THEN' })}>
        <LeafEditor
          node={node.then}
          schema={schema}
          onChange={(n) => onChange({ ...node, then: n })}
        />
      </Row>
      <Row label={t('reports.wizard.customColumns.else', { defaultValue: 'ELSE' })}>
        <LeafEditor
          node={node.else}
          schema={schema}
          onChange={(n) => onChange({ ...node, else: n })}
        />
      </Row>
    </div>
  )
}

function ensureBinary(n: ExpressionNode): Extract<ExpressionNode, { kind: 'binary' }> {
  if (n.kind === 'binary') return n
  return { kind: 'binary', op: '=', left: n, right: { kind: 'literal', value: '' } }
}

function MatchEditor({
  node,
  schema,
  onChange,
}: {
  node: Extract<ExpressionNode, { kind: 'match' }>
  schema: ReportSourceSchema
  onChange: (n: ExpressionNode) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <select
        value={node.column}
        onChange={(e) => onChange({ ...node, column: e.target.value })}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs flex-1 min-w-[10rem]"
      >
        {schema.fields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label || f.key}
          </option>
        ))}
      </select>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">MATCH</span>
      <Input
        value={node.pattern}
        onChange={(e) => onChange({ ...node, pattern: e.target.value })}
        placeholder="regex or substring"
        className="h-7 text-xs flex-1 min-w-[10rem] font-mono"
      />
      <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <input
          type="checkbox"
          checked={node.caseInsensitive ?? false}
          onChange={(e) => onChange({ ...node, caseInsensitive: e.target.checked })}
          className="w-3.5 h-3.5"
        />
        {t('reports.wizard.customColumns.caseInsensitive', { defaultValue: 'case-insensitive' })}
      </label>
    </div>
  )
}

const FN_NAMES = ['LOWER', 'UPPER', 'TRIM', 'LEN', 'ROUND', 'ABS'] as const

function FnEditor({
  node,
  schema,
  onChange,
}: {
  node: Extract<ExpressionNode, { kind: 'fn' }>
  schema: ReportSourceSchema
  onChange: (n: ExpressionNode) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={node.name}
        onChange={(e) => onChange({ ...node, name: e.target.value as typeof FN_NAMES[number] })}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs w-24"
      >
        {FN_NAMES.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <span className="text-[10px] text-muted-foreground">(</span>
      <div className="flex-1">
        <LeafEditor
          node={node.args[0] ?? { kind: 'column', name: schema.fields[0]?.key ?? '' }}
          schema={schema}
          onChange={(n) => onChange({ ...node, args: [n] })}
        />
      </div>
      <span className="text-[10px] text-muted-foreground">)</span>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <div className="w-14 pt-1.5 text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
        {label}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

