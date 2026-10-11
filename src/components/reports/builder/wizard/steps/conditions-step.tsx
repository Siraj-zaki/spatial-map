import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { WidgetCondition } from '@/lib/reports-client'
import { useWizard } from '../wizard-state'
import type { ComputedColumn } from '@/lib/reports/computed-columns'
import { CONDITION_STYLES, conditionStyleFor } from '@/lib/reports/condition-styles'

/** Operators the runtime supports — the widget already ships an
 *  `evalCondition` that handles these; we mirror the list here so the
 *  wizard shows the same vocabulary. */
const OPS: Array<{ op: WidgetCondition['op']; label: string }> = [
  { op: 'eq', label: '=' },
  { op: 'neq', label: '≠' },
  { op: 'gt', label: '>' },
  { op: 'gte', label: '≥' },
  { op: 'lt', label: '<' },
  { op: 'lte', label: '≤' },
  { op: 'contains', label: 'contains' },
]

/** Looks a rule can apply — shared with the viewer, on theme tokens
 *  (`@/lib/reports/condition-styles`). Each renders as a live chip. */
const STYLE_PRESETS = CONDITION_STYLES
const presetByClass = conditionStyleFor

export function ConditionsStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()

  // Columns available to target — the picked source columns plus any
  // computed columns declared in the previous step, since those also
  // render as cells.
  const availableColumns = useMemo(() => {
    const base = draft.columns.slice()
    for (const c of draft.computedColumns as ComputedColumn[]) {
      if (!base.includes(c.name)) base.push(c.name)
    }
    return base
  }, [draft.columns, draft.computedColumns])

  // The picked column, falling back to the first one whenever the pick
  // isn't in the list (none yet, or removed upstream) — derived, not synced.
  const [pickedCol, setSelectedCol] = useState<string | null>(null)
  const selectedCol = pickedCol && availableColumns.includes(pickedCol) ? pickedCol : (availableColumns[0] ?? null)

  if (availableColumns.length === 0) {
    return (
      <div className="text-sm text-muted-foreground italic py-6 text-center border-2 border-dashed border-border rounded-md">
        {t('reports.wizard.conditions.needColumns', {
          defaultValue: 'Pick at least one column in the Columns step first — rules apply to specific columns.',
        })}
      </div>
    )
  }

  const currentRules = selectedCol ? draft.conditions[selectedCol] ?? [] : []

  const patchColumn = (col: string, rules: WidgetCondition[]) => {
    const next = { ...draft.conditions }
    if (rules.length === 0) delete next[col]
    else next[col] = rules
    update({ conditions: next })
  }

  const addRule = () => {
    if (!selectedCol) return
    const rule: WidgetCondition = {
      column: selectedCol,
      op: 'gt',
      value: 0,
      className: STYLE_PRESETS[0].className,
    }
    patchColumn(selectedCol, [...currentRules, rule])
  }

  const patchRule = (idx: number, patch: Partial<WidgetCondition>) => {
    if (!selectedCol) return
    const next = [...currentRules]
    next[idx] = { ...next[idx], ...patch }
    patchColumn(selectedCol, next)
  }

  const removeRule = (idx: number) => {
    if (!selectedCol) return
    patchColumn(selectedCol, currentRules.filter((_, i) => i !== idx))
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[220px,1fr] max-w-4xl">
      {/* Column list — badge shows rule count per column */}
      <aside className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-1 mb-1">
          {t('reports.wizard.conditions.columnsList', { defaultValue: 'Columns' })}
        </div>
        {availableColumns.map((col) => {
          const count = draft.conditions[col]?.length ?? 0
          const active = selectedCol === col
          const label = draft.columnConfig[col]?.label ?? col
          return (
            <button
              key={col}
              type="button"
              onClick={() => setSelectedCol(col)}
              className={cn(
                'w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-left text-xs transition-colors',
                active
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <span className="truncate flex-1">{label}</span>
              {count > 0 && (
                <span
                  className={cn(
                    'text-[10px] rounded-full px-1.5 shrink-0 tabular-nums',
                    active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </aside>

      {/* Rules editor for the selected column */}
      <section className="min-w-0">
        {selectedCol && (
          <>
            <div className="flex items-center gap-2 mb-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
                  {t('reports.wizard.conditions.rulesFor', {
                    column: draft.columnConfig[selectedCol]?.label ?? selectedCol,
                    defaultValue: 'Rules for “{{column}}”',
                  })}
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('reports.wizard.conditions.hint', {
                    defaultValue: 'Rules are checked top-down; the first match wins.',
                  })}
                </p>
              </div>
              <div className="flex-1" />
              <Button size="sm" onClick={addRule} className="h-8">
                <Plus className="w-3.5 h-3.5 me-1.5" />
                {t('reports.wizard.conditions.add', { defaultValue: 'Add rule' })}
              </Button>
            </div>

            {currentRules.length === 0 && (
              <div className="italic text-muted-foreground text-sm py-6 text-center border-2 border-dashed border-border rounded-md">
                {t('reports.wizard.conditions.empty', {
                  defaultValue: 'No rules yet. Cells in this column render with their default style.',
                })}
              </div>
            )}

            <ul className="space-y-2">
              {currentRules.map((rule, idx) => (
                <RuleCard
                  key={idx}
                  index={idx}
                  rule={rule}
                  onChange={(patch) => patchRule(idx, patch)}
                  onRemove={() => removeRule(idx)}
                />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}

function RuleCard({
  index,
  rule,
  onChange,
  onRemove,
}: {
  index: number
  rule: WidgetCondition
  onChange: (patch: Partial<WidgetCondition>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const preset = presetByClass(rule.className)

  return (
    <li className="rounded-lg border border-border bg-card p-3 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-8 shrink-0">
          #{index + 1}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('reports.wizard.conditions.when', { defaultValue: 'When value' })}
        </span>
        <select
          value={rule.op}
          onChange={(e) => onChange({ op: e.target.value as WidgetCondition['op'] })}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs w-24"
        >
          {OPS.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
        <Input
          value={String(rule.value ?? '')}
          onChange={(e) => {
            const raw = e.target.value
            // Try numeric parse for numeric ops; fall back to string.
            const numeric = ['gt', 'gte', 'lt', 'lte'].includes(rule.op)
            if (numeric) {
              const n = Number(raw)
              onChange({ value: Number.isFinite(n) ? n : raw })
            } else {
              onChange({ value: raw })
            }
          }}
          placeholder={t('reports.wizard.conditions.valuePlaceholder', { defaultValue: 'value' })}
          className="h-7 text-xs flex-1"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onRemove}
          aria-label={t('reports.wizard.conditions.remove', { defaultValue: 'Remove rule' })}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div className="ms-10 space-y-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t('reports.wizard.conditions.style', { defaultValue: 'Apply style' })}
        </span>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {STYLE_PRESETS.map((p) => {
            const active = preset?.id === p.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onChange({ className: p.className })}
                className={cn(
                  'group relative flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors',
                  active
                    ? 'border-primary ring-2 ring-primary/40 bg-primary/5'
                    : 'border-border hover:border-primary/50 hover:bg-accent/50',
                )}
              >
                <span className={cn('flex-1 truncate text-start', p.className)}>
                  {t(`reports.wizard.conditions.preset.${p.id}`, { defaultValue: p.fallback })}
                </span>
                {active && (
                  <Check className="w-3 h-3 text-primary shrink-0" strokeWidth={3} />
                )}
              </button>
            )
          })}
        </div>
      </div>
    </li>
  )
}
