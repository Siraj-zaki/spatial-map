import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Calendar,
  ChevronDown,
  Filter as FilterIcon,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  SquareCheckBig,
  Type as TypeIcon,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  getReportSourceSchema,
  type FilterCond,
  type FilterOp,
  type ReportSourceSchema,
} from '@/lib/reports-client'
import type { ParamInputKind, ReportParam } from '@/lib/reports/v2-types'
import { useWizard, type WizardDraft } from '../wizard-state'
import { PRIMARY_QUERY_NAME } from '../wizard-serialisation'

const OPS: Array<{ op: FilterOp; label: string; arity: 'none' | 'one' | 'list' }> = [
  { op: 'eq', label: '= equals', arity: 'one' },
  { op: 'neq', label: '≠ not equals', arity: 'one' },
  { op: 'gt', label: '> greater than', arity: 'one' },
  { op: 'gte', label: '≥ at least', arity: 'one' },
  { op: 'lt', label: '< less than', arity: 'one' },
  { op: 'lte', label: '≤ at most', arity: 'one' },
  { op: 'contains', label: 'contains', arity: 'one' },
  { op: 'starts', label: 'starts with', arity: 'one' },
  { op: 'ends', label: 'ends with', arity: 'one' },
  { op: 'in', label: 'is one of', arity: 'list' },
  { op: 'isnull', label: 'is empty', arity: 'none' },
  { op: 'notnull', label: 'has value', arity: 'none' },
]

const opArity = (op: FilterOp): 'none' | 'one' | 'list' =>
  OPS.find((x) => x.op === op)?.arity ?? 'one'

/** The prompt widget kinds we expose per-filter. Multi-select
 *  dropdown and button-group live under the dropdown/buttonGroup
 *  ParamInputKind — we just expose them here as separate presets. */
const PROMPT_KINDS: Array<{
  key: string
  label: string
  icon: typeof FilterIcon
  input: ParamInputKind
  configure?: (p: ReportParam, fieldKey: string) => ReportParam
}> = [
  { key: 'text', label: 'Text input', icon: TypeIcon, input: 'textInput' },
  {
    key: 'dropdown',
    label: 'Dropdown (from source)',
    icon: ChevronDown,
    input: 'dropdown',
    configure: (p, field) => ({
      ...p,
      input: {
        ...p.input,
        kind: 'dropdown',
        options: { fromQuery: PRIMARY_QUERY_NAME, valueColumn: field },
      },
    }),
  },
  {
    key: 'search',
    label: 'Search dropdown',
    icon: Search,
    input: 'dropdown',
    configure: (p, field) => ({
      ...p,
      input: {
        ...p.input,
        kind: 'dropdown',
        multi: false,
        options: { fromQuery: PRIMARY_QUERY_NAME, valueColumn: field },
      },
    }),
  },
  {
    key: 'multi',
    label: 'Multi-select dropdown',
    icon: ChevronDown,
    input: 'dropdown',
    configure: (p, field) => ({
      ...p,
      input: {
        ...p.input,
        kind: 'dropdown',
        multi: true,
        options: { fromQuery: PRIMARY_QUERY_NAME, valueColumn: field },
      },
    }),
  },
  { key: 'date', label: 'Date picker', icon: Calendar, input: 'dateInput' },
  // Date ranges live in the Viewer filters step: a single `= {{param}}`
  // condition can't compare a range (it needs a start and an end).
  { key: 'checkbox', label: 'Checkbox (yes/no)', icon: SquareCheckBig, input: 'checkbox' },
]

/** Detect which preset matches an existing param — we walk the same
 *  configure functions to spot a stable match. Falls back to a
 *  best-effort kind match. */
function detectPresetKey(param: ReportParam | null | undefined): string {
  if (!param) return 'text'
  const kind = param.input.kind
  if (kind === 'textInput') return 'text'
  if (kind === 'dateInput') return 'date'
  if (kind === 'dateRange') return 'dateRange'
  if (kind === 'checkbox') return 'checkbox'
  if (kind === 'dropdown') {
    if (param.input.multi) return 'multi'
    if (param.input.options?.fromQuery) return 'dropdown'
    return 'search'
  }
  return 'text'
}

export function FiltersStep() {
  const { t } = useTranslation()
  const { draft, update, goTo } = useWizard()
  const sourceId = draft.sourceRef?.id
  const [loaded, setLoaded] = useState<{ key: number; schema: ReportSourceSchema | null } | null>(null)

  useEffect(() => {
    if (sourceId === undefined) return
    let cancelled = false
    getReportSourceSchema(sourceId)
      .then((s) => {
        if (!cancelled) setLoaded({ key: sourceId, schema: s })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: sourceId, schema: null })
      })
    return () => {
      cancelled = true
    }
  }, [sourceId])

  // Keyed by source id — "loading" means no result for this source yet.
  const current = sourceId !== undefined && loaded?.key === sourceId ? loaded : null
  const loading = sourceId !== undefined && !current
  const schema = current?.schema ?? null

  const conditions: FilterCond[] = (draft.filters?.and ?? [])
    .map((n) => n.cond)
    .filter((c): c is FilterCond => !!c)

  const setConditions = (next: FilterCond[]) => {
    update({ filters: next.length ? { and: next.map((c) => ({ cond: c })) } : undefined })
  }

  const addCondition = () => {
    if (!schema || schema.fields.length === 0) return
    // New filters default to "prompt at runtime with a text input" —
    // this covers 90% of the common case (make the viewer ask) and
    // the user can override the value or the prompt kind inline.
    const field = schema.fields[0].key
    const paramId = uniqueFilterParamId(draft.params.map((p) => p.id), field)
    const param: ReportParam = {
      id: paramId,
      label: schema.fields[0].label || field,
      input: { kind: 'textInput' },
    }
    const nextCond: FilterCond = {
      field,
      op: 'eq',
      value: `{{param.${paramId}}}`,
    }
    update({
      filters: {
        and: [
          ...(draft.filters?.and ?? []),
          { cond: nextCond },
        ],
      },
      params: [...draft.params, param],
    })
  }

  const patch = (idx: number, cond: FilterCond) => {
    const next = [...conditions]
    next[idx] = cond
    setConditions(next)
  }

  const remove = (idx: number) => {
    const cond = conditions[idx]
    // Also drop the auto-declared param if it was created by this row.
    const paramId = extractParamId(cond?.value)
    let nextParams = draft.params
    if (paramId && paramId.startsWith('f_')) {
      nextParams = draft.params.filter((p) => p.id !== paramId)
    }
    const remaining = conditions.filter((_, i) => i !== idx)
    update({
      filters: remaining.length ? { and: remaining.map((c) => ({ cond: c })) } : undefined,
      params: nextParams,
    })
  }

  if (!draft.sourceRef) {
    return (
      <div className="text-sm text-muted-foreground italic py-6 text-center border-2 border-dashed border-border rounded-md">
        {t('reports.wizard.filters.needSource', { defaultValue: 'Pick a data source first.' })}
      </div>
    )
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('reports.wizard.filters.loading', { defaultValue: 'Loading schema…' })}
      </div>
    )
  }
  if (!schema) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>{t('reports.wizard.filters.noSchema', { defaultValue: 'Could not load fields.' })}</span>
      </div>
    )
  }

  return (
    <div className="space-y-3 max-w-3xl">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
        <span className="flex-1">
          {t('reports.wizard.filters.viewerHint', {
            defaultValue: 'Want viewers to choose — a floor, a type, a date range? Add it in Viewer filters; it then narrows every chart and table too.',
          })}
        </span>
        <Button variant="outline" size="sm" className="h-7" onClick={() => goTo('viewerFilters')}>
          {t('reports.wizard.filters.viewerHintAction', { defaultValue: 'Open Viewer filters' })}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('reports.wizard.filters.hint', {
          defaultValue:
            'All conditions must match (AND). Type a value to pin it, or leave the value empty and pick how viewers should be prompted for it.',
        })}
      </p>
      {conditions.length === 0 && (
        <div className="italic text-muted-foreground text-sm py-4 text-center border-2 border-dashed border-border rounded-md">
          {t('reports.wizard.filters.empty', { defaultValue: 'No filters — every row will show.' })}
        </div>
      )}
      <ul className="space-y-2">
        {conditions.map((c, idx) => (
          <FilterRow
            key={idx}
            cond={c}
            schema={schema}
            onChange={(next) => patch(idx, next)}
            onRemove={() => remove(idx)}
          />
        ))}
      </ul>
      <Button variant="outline" size="sm" onClick={addCondition}>
        <Plus className="w-3.5 h-3.5 me-1.5" />
        {t('reports.wizard.filters.add', { defaultValue: 'Add filter' })}
      </Button>
    </div>
  )
}

function FilterRow({
  cond,
  schema,
  onChange,
  onRemove,
}: {
  cond: FilterCond
  schema: ReportSourceSchema
  onChange: (next: FilterCond) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const arity = opArity(cond.op)

  return (
    <li className="rounded-lg border border-border bg-card p-3 space-y-2">
      {/* Field + Op + Remove header */}
      <div className="flex items-center gap-2">
        <select
          value={cond.field}
          onChange={(e) => onChange({ ...cond, field: e.target.value })}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs flex-1 min-w-0"
        >
          {schema.fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label || f.key}
            </option>
          ))}
        </select>
        <select
          value={cond.op}
          onChange={(e) => onChange({ ...cond, op: e.target.value as FilterOp })}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs w-40"
        >
          {OPS.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={onRemove}
          aria-label={t('reports.wizard.filters.remove', { defaultValue: 'Remove' })}
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Value + prompt config — the value input gets its own row so
          the prompt-kind block below it has room to breathe. */}
      {arity === 'one' && (
        <FilterValueEditor
          cond={cond}
          schema={schema}
          onChange={onChange}
        />
      )}
      {arity === 'list' && (
        <Input
          value={Array.isArray(cond.value) ? (cond.value as unknown[]).join(', ') : ''}
          onChange={(e) =>
            onChange({
              ...cond,
              value: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
            })
          }
          placeholder={t('reports.wizard.filters.valuesPlaceholder', {
            defaultValue: 'comma-separated values',
          })}
          className="h-8 text-xs"
        />
      )}
      {arity === 'none' && (
        <div className="text-[11px] text-muted-foreground italic px-1">
          {t('reports.wizard.filters.noValueNeeded', {
            defaultValue: 'This operator needs no value.',
          })}
        </div>
      )}
    </li>
  )
}

/** Single-arity value editor.
 *  - Type a value → literal (any auto-declared param for this filter
 *    is removed on the fly).
 *  - Leave empty → prompt mode; a boxed panel below the input picks
 *    what the viewer renders (text / dropdown / date / etc.). We
 *    auto-declare a param `f_<field>` on demand so the runtime's
 *    param bar just works — the user never touches the Params step. */
function FilterValueEditor({
  cond,
  schema,
  onChange,
}: {
  cond: FilterCond
  schema: ReportSourceSchema
  onChange: (next: FilterCond) => void
}) {
  const { t } = useTranslation()
  const { draft, update } = useWizard()

  // Numbers and booleans are literals too (a generated report's
  // `facility_id = 75`) — reading them as '' auto-declared a prompt
  // and replaced the value.
  const raw = typeof cond.value === 'string' ? cond.value : cond.value == null ? '' : String(cond.value)
  const boundParamId = extractParamId(raw)
  const boundParam = boundParamId ? draft.params.find((p) => p.id === boundParamId) : null
  const isPrompt = raw === '' || boundParamId !== null
  // Guard the auto-declare effect — StrictMode double-invokes render,
  // and useEffect would otherwise fire twice creating dupes.
  const autoDeclared = useRef(false)

  // Legacy filters loaded from disk may have `value: ''` and no
  // param — auto-declare one so the viewer's params bar renders it.
  // Also handles the case where a picker was chosen, the param
  // dropped, and the row is empty again.
  useEffect(() => {
    if (raw === '' && !boundParamId && !autoDeclared.current) {
      autoDeclared.current = true
      const paramId = uniqueFilterParamId(draft.params.map((p) => p.id), cond.field)
      const label =
        schema.fields.find((f) => f.key === cond.field)?.label || cond.field
      const param: ReportParam = {
        id: paramId,
        label,
        input: { kind: 'textInput' },
      }
      update({
        params: [...draft.params, param],
        filters: replaceCondValueInFilters(
          draft.filters,
          cond,
          `{{param.${paramId}}}`,
        ),
      })
    }
    if (boundParamId) {
      // Reset the guard so a future prompt→literal→empty cycle can
      // re-declare a fresh param.
      autoDeclared.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, boundParamId])

  const setLiteral = (v: string) => {
    if (v === '') {
      // Empty means "prompt" — drop any auto-param; the effect above
      // will re-create one on the next render.
      dropAutoParam(draft, boundParamId, (nextParams) =>
        update({ params: nextParams }),
      )
      autoDeclared.current = false
      onChange({ ...cond, value: '' })
      return
    }
    // Non-empty literal — drop the auto-param and store the raw value.
    dropAutoParam(draft, boundParamId, (nextParams) =>
      update({ params: nextParams }),
    )
    onChange({ ...cond, value: v })
  }

  const currentPresetKey = detectPresetKey(boundParam)

  const applyPresetKey = (key: string) => {
    const preset = PROMPT_KINDS.find((p) => p.key === key)
    if (!preset) return
    const paramId =
      boundParamId ?? uniqueFilterParamId(draft.params.map((p) => p.id), cond.field)
    const base: ReportParam =
      boundParam ??
      {
        id: paramId,
        label:
          schema.fields.find((f) => f.key === cond.field)?.label || cond.field,
        input: { kind: preset.input },
      }
    const configured = preset.configure
      ? preset.configure(base, cond.field)
      : { ...base, input: { ...base.input, kind: preset.input } }
    const nextParams = boundParam
      ? draft.params.map((p) => (p.id === paramId ? configured : p))
      : [...draft.params, configured]
    update({
      params: nextParams,
      filters: replaceCondValueInFilters(
        draft.filters,
        cond,
        `{{param.${paramId}}}`,
      ),
    })
  }

  const activePreset = PROMPT_KINDS.find((p) => p.key === currentPresetKey)
  const PresetIcon = activePreset?.icon ?? MessageSquare

  return (
    <div className="space-y-2">
      <Input
        value={boundParamId ? '' : raw}
        onChange={(e) => setLiteral(e.target.value)}
        placeholder={t('reports.wizard.filters.valuePlaceholder', {
          defaultValue: 'type a value, or leave empty for a runtime prompt',
        })}
        className="h-8 text-xs"
      />
      {isPrompt && (
        <div className="rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px]">
            <MessageSquare className="w-3 h-3 text-primary shrink-0" />
            <span className="text-muted-foreground">
              {t('reports.wizard.filters.promptExplain', {
                defaultValue: 'Viewers will be prompted for this value.',
              })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground shrink-0">
              {t('reports.wizard.filters.promptAs', { defaultValue: 'Prompt with:' })}
            </span>
            <div className="relative flex-1 min-w-0">
              <PresetIcon className="absolute start-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
              <select
                value={currentPresetKey}
                onChange={(e) => applyPresetKey(e.target.value)}
                className="h-7 rounded-md border border-input bg-background ps-6 pe-2 text-xs w-full"
              >
                {PROMPT_KINDS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {t(`reports.wizard.filters.promptKind.${p.key}`, {
                      defaultValue: p.label,
                    })}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────── helpers

function extractParamId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = value.match(/^\{\{param\.([a-zA-Z0-9_]+)\}\}$/)
  return m ? m[1] : null
}

function uniqueFilterParamId(existing: string[], field: string): string {
  const sane = field.replace(/[^a-zA-Z0-9_]/g, '_')
  const base = `f_${sane}`
  if (!existing.includes(base)) return base
  let i = 2
  while (existing.includes(`${base}_${i}`)) i += 1
  return `${base}_${i}`
}

function dropAutoParam(
  draft: WizardDraft,
  paramId: string | null,
  commit: (nextParams: ReportParam[]) => void,
) {
  if (!paramId || !paramId.startsWith('f_')) return
  commit(draft.params.filter((p) => p.id !== paramId))
}

/** Replace one condition's value inside the flat AND filter tree
 *  without disturbing sibling conds. Used when we need to swap a
 *  filter's value + declare a param in the same update() call. */
function replaceCondValueInFilters(
  filters: WizardDraft['filters'],
  target: FilterCond,
  nextValue: unknown,
): WizardDraft['filters'] {
  if (!filters?.and) return filters
  return {
    and: filters.and.map((n) => {
      if (n.cond === target) return { cond: { ...target, value: nextValue } }
      return n
    }),
  }
}
