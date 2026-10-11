import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Calendar,
  CalendarRange,
  Check,
  ChevronDown,
  Filter,
  Grid2x2,
  ListChecks,
  Plus,
  Sliders,
  SquareCheckBig,
  ToggleLeft,
  Trash2,
  Type as TypeIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { ParamInputKind, ReportParam } from '@/lib/reports/v2-types'
import { useWizard } from '../wizard-state'
import { availableQueries as computeQueries, columnsForQuery } from '../available-columns'

/** Kinds the wizard exposes. dimensionGrid is intentionally excluded
 *  — it needs sourceRef + pivot column config that doesn't fit a
 *  first-pass form. Advanced users can hand-edit the spec later. */
const KINDS: Array<{
  kind: ParamInputKind
  label: string
  icon: typeof Filter
  hint: string
}> = [
  { kind: 'textInput', label: 'Text', icon: TypeIcon, hint: 'Free-form text — good for search boxes and adhoc filters.' },
  { kind: 'dropdown', label: 'Dropdown', icon: ChevronDown, hint: 'A single-select (or multi-select) menu built from a static option list.' },
  { kind: 'buttonGroup', label: 'Button group', icon: ListChecks, hint: 'Segmented control from a static option list — great for 2–5 mutually exclusive choices.' },
  { kind: 'dateInput', label: 'Date', icon: Calendar, hint: 'Single-date picker. Bind to a date filter.' },
  { kind: 'dateRange', label: 'Date range', icon: CalendarRange, hint: 'Two-date picker with optional "last 7 / 30 / 90 days" presets.' },
  { kind: 'slider', label: 'Slider', icon: Sliders, hint: 'Numeric range selector. Set min, max, and step.' },
  { kind: 'checkbox', label: 'Checkbox', icon: SquareCheckBig, hint: 'Boolean toggle — on/off, true/false.' },
  { kind: 'dimensionGrid', label: 'Dimension grid', icon: Grid2x2, hint: 'Cross-filter panel — one tile per pivot column, click values to include. Options come from a query.' },
]

const kindMeta = (k: ParamInputKind) => KINDS.find((x) => x.kind === k)

/** Params step — declare runtime parameters that surface in the
 *  viewer's params bar. The runtime store already handles URL
 *  persistence, defaults, and dependent-query re-runs; this step is
 *  the config surface that produces the `params` array on the spec. */
export function ParamsStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()

  const addParam = (kind: ParamInputKind) => {
    const id = uniqueId(draft.params.map((p) => p.id))
    const meta = kindMeta(kind)
    const p: ReportParam = {
      id,
      label: meta ? meta.label : id,
      input: defaultInputFor(kind),
      defaultValue: defaultValueFor(kind),
      urlPersist: true,
    }
    update({ params: [...draft.params, p] })
  }

  const patchParam = (idx: number, patch: Partial<ReportParam>) => {
    const next = [...draft.params]
    next[idx] = { ...next[idx], ...patch }
    update({ params: next })
  }

  const removeParam = (idx: number) => {
    update({ params: draft.params.filter((_, i) => i !== idx) })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground flex items-start gap-2">
        <Filter className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
        <div>
          <div className="font-medium">
            {t('reports.wizard.params.intro', {
              defaultValue: 'Parameters become prompts in the viewer',
            })}
          </div>
          <div className="text-muted-foreground">
            {t('reports.wizard.params.introHint', {
              defaultValue: 'Reference them from filters as {{"{{param.<id>}}"}}. Values persist in the URL so dashboards are shareable.',
            })}
          </div>
        </div>
      </div>

      {draft.params.length === 0 && (
        <div className="italic text-muted-foreground text-sm py-6 text-center border-2 border-dashed border-border rounded-md">
          {t('reports.wizard.params.empty', {
            defaultValue: 'No parameters yet. Add one below to let viewers change the report at runtime.',
          })}
        </div>
      )}

      <ul className="space-y-2">
        {draft.params.map((p, idx) => (
          <ParamCard
            key={p.id + idx}
            index={idx}
            param={p}
            onChange={(patch) => patchParam(idx, patch)}
            onRemove={() => removeParam(idx)}
          />
        ))}
      </ul>

      <div className="border-t border-border pt-4">
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" className="h-8">
              <Plus className="w-3.5 h-3.5 me-1.5" />
              {t('reports.wizard.params.add', { defaultValue: 'Add parameter' })}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-1" align="start">
            {KINDS.map((k) => {
              const Icon = k.icon
              return (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => addParam(k.kind)}
                  className="w-full flex items-start gap-2 px-2 py-2 rounded-md text-left text-xs hover:bg-accent"
                >
                  <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">
                      {t(`reports.wizard.params.kind.${k.kind}`, { defaultValue: k.label })}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {t(`reports.wizard.params.kindHint.${k.kind}`, { defaultValue: k.hint })}
                    </div>
                  </div>
                </button>
              )
            })}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

function ParamCard({
  index,
  param,
  onChange,
  onRemove,
}: {
  index: number
  param: ReportParam
  onChange: (patch: Partial<ReportParam>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const meta = kindMeta(param.input.kind)
  const Icon = meta?.icon ?? Filter

  return (
    <li className="rounded-lg border border-border bg-card p-3 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-8 shrink-0">
          #{index + 1}
        </span>
        <div className="w-6 h-6 rounded flex items-center justify-center bg-primary/10 text-primary shrink-0">
          <Icon className="w-3.5 h-3.5" />
        </div>
        <Input
          value={param.id}
          onChange={(e) => onChange({ id: sanitiseId(e.target.value) })}
          placeholder={t('reports.wizard.params.idPlaceholder', { defaultValue: 'id (used in {{param.id}})' })}
          className="h-7 text-xs w-40 font-mono"
        />
        <Input
          value={param.label ?? ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder={t('reports.wizard.params.labelPlaceholder', { defaultValue: 'Display label' })}
          className="h-7 text-xs flex-1"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onRemove}
          aria-label={t('reports.wizard.params.remove', { defaultValue: 'Remove parameter' })}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div className="ms-10 grid gap-3">
        <KindEditor param={param} onChange={onChange} />

        {/* Default value + URL persistence — shared across kinds. */}
        <div className="grid grid-cols-[auto,1fr,auto] items-center gap-x-3 gap-y-1.5 text-xs">
          <Label className="text-xs text-muted-foreground">
            {t('reports.wizard.params.defaultValue', { defaultValue: 'Default value' })}
          </Label>
          <DefaultValueInput param={param} onChange={(v) => onChange({ defaultValue: v })} />

          <Label className="text-xs text-muted-foreground">
            {t('reports.wizard.params.urlPersist', { defaultValue: 'Sync to URL' })}
          </Label>
          <span />
          <Switch
            checked={param.urlPersist !== false}
            onCheckedChange={(v) => onChange({ urlPersist: Boolean(v) })}
          />
        </div>

        <DataDefaultEditor param={param} onChange={onChange} />
      </div>
    </li>
  )
}

/** Optional data-driven default — Evidence's `select_first`-style
 *  binding. When set, the runtime store waits for the target query to
 *  land, extracts the reduced value, and pushes it via
 *  `setDataDefault` (which loses if the user has already picked a
 *  value manually or through the URL). */
function DataDefaultEditor({
  param,
  onChange,
}: {
  param: ReportParam
  onChange: (patch: Partial<ReportParam>) => void
}) {
  const { t } = useTranslation()
  const { draft } = useWizard()
  const availableQueries = computeQueries(draft)
  const active = Boolean(param.defaultFromQuery)
  const dfq = param.defaultFromQuery
  const activeQuery = dfq?.query ?? availableQueries[0]
  const availableColumns = columnsForQuery(draft, activeQuery)

  return (
    <div className="border-t border-border pt-3 space-y-2">
      <label className="flex items-center gap-2 text-xs">
        <Switch
          checked={active}
          onCheckedChange={(v) => {
            if (v) {
              onChange({
                defaultFromQuery: {
                  query: availableQueries[0],
                  column: availableColumns[0] ?? '',
                  reduce: 'first',
                },
              })
            } else {
              onChange({ defaultFromQuery: undefined })
            }
          }}
        />
        <span className="font-medium">
          {t('reports.wizard.params.dataDefault', { defaultValue: 'Use data-driven default' })}
        </span>
        <span className="text-muted-foreground">
          {t('reports.wizard.params.dataDefaultHint', {
            defaultValue: '— seed from a query result on load',
          })}
        </span>
      </label>
      {active && dfq && (
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('reports.wizard.params.dataDefaultQuery', { defaultValue: 'Query' })}
            </Label>
            <select
              value={dfq.query}
              onChange={(e) =>
                onChange({ defaultFromQuery: { ...dfq, query: e.target.value } })
              }
              className="h-7 rounded-md border border-input bg-background px-2 text-xs w-full"
            >
              {availableQueries.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('reports.wizard.params.dataDefaultColumn', { defaultValue: 'Column' })}
            </Label>
            <select
              value={dfq.column}
              onChange={(e) =>
                onChange({ defaultFromQuery: { ...dfq, column: e.target.value } })
              }
              className="h-7 rounded-md border border-input bg-background px-2 text-xs w-full"
            >
              {!availableColumns.includes(dfq.column) && <option value="">—</option>}
              {availableColumns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('reports.wizard.params.dataDefaultReduce', { defaultValue: 'Pick' })}
            </Label>
            <select
              value={dfq.reduce ?? 'first'}
              onChange={(e) =>
                onChange({
                  defaultFromQuery: {
                    ...dfq,
                    reduce: e.target.value as 'first' | 'min' | 'max',
                  },
                })
              }
              className="h-7 rounded-md border border-input bg-background px-2 text-xs w-full"
            >
              <option value="first">
                {t('reports.wizard.params.reduceFirst', { defaultValue: 'First row' })}
              </option>
              <option value="min">
                {t('reports.wizard.params.reduceMin', { defaultValue: 'Min value' })}
              </option>
              <option value="max">
                {t('reports.wizard.params.reduceMax', { defaultValue: 'Max value' })}
              </option>
            </select>
          </div>
        </div>
      )}
    </div>
  )
}

/** Per-kind editor body — options for dropdown/buttonGroup, min/max
 *  for slider, presets for dateRange, granularity for dateInput. */
function KindEditor({
  param,
  onChange,
}: {
  param: ReportParam
  onChange: (patch: Partial<ReportParam>) => void
}) {
  const { t } = useTranslation()
  const { draft } = useWizard()
  const input = param.input

  if (input.kind === 'dropdown' || input.kind === 'buttonGroup') {
    // Dropdowns can source options two ways: a static list, or a
    // named query result (Evidence's `select_first`-style dynamic
    // options). Detect current mode from what's set on the input.
    const availableQueries = computeQueries(draft)
    const activeQuery = input.options?.fromQuery ?? availableQueries[0]
    const availableColumns = columnsForQuery(draft, activeQuery)
    const mode: 'static' | 'query' = input.options?.fromQuery ? 'query' : 'static'
    const setMode = (m: 'static' | 'query') => {
      if (m === 'query') {
        onChange({
          input: {
            ...input,
            options: {
              fromQuery: input.options?.fromQuery ?? availableQueries[0],
              valueColumn: input.options?.valueColumn ?? availableColumns[0] ?? '',
              labelColumn: input.options?.labelColumn,
            },
          },
        })
      } else {
        onChange({
          input: {
            ...input,
            options: { static: input.options?.static ?? [] },
          },
        })
      }
    }
    const opts = input.options?.static ?? []
    const setOpts = (next: Array<{ value: unknown; label: string }>) =>
      onChange({
        input: {
          ...input,
          options: { ...(input.options ?? {}), static: next },
        },
      })
    const setQueryOpts = (patch: {
      fromQuery?: string
      valueColumn?: string
      labelColumn?: string
    }) => {
      onChange({
        input: {
          ...input,
          options: {
            ...(input.options ?? {}),
            ...patch,
          },
        },
      })
    }
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">
            {t('reports.wizard.params.options', { defaultValue: 'Options' })}
          </Label>
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {(['static', 'query'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  'px-2.5 py-0.5 text-[11px] transition-colors border-e border-border last:border-e-0',
                  mode === m
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:bg-accent',
                )}
              >
                {t(`reports.wizard.params.optionsMode.${m}`, {
                  defaultValue: m === 'static' ? 'Static list' : 'From query',
                })}
              </button>
            ))}
          </div>
        </div>

        {mode === 'static' && <OptionListEditor options={opts} onChange={setOpts} />}
        {mode === 'query' && (
          <div className="grid grid-cols-3 gap-2 pt-1">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                {t('reports.wizard.params.fromQuery', { defaultValue: 'Query' })}
              </Label>
              <select
                value={input.options?.fromQuery ?? ''}
                onChange={(e) => setQueryOpts({ fromQuery: e.target.value })}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs w-full"
              >
                {availableQueries.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                {t('reports.wizard.params.valueColumn', { defaultValue: 'Value column' })}
              </Label>
              <select
                value={input.options?.valueColumn ?? ''}
                onChange={(e) => setQueryOpts({ valueColumn: e.target.value })}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs w-full"
              >
                {!availableColumns.includes(input.options?.valueColumn ?? '') && (
                  <option value="">—</option>
                )}
                {availableColumns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">
                {t('reports.wizard.params.labelColumn', {
                  defaultValue: 'Label column (optional)',
                })}
              </Label>
              <select
                value={input.options?.labelColumn ?? ''}
                onChange={(e) =>
                  setQueryOpts({ labelColumn: e.target.value || undefined })
                }
                className="h-7 rounded-md border border-input bg-background px-2 text-xs w-full"
              >
                <option value="">—</option>
                {availableColumns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {input.kind === 'dropdown' && (
          <label className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={input.multi === true}
              onChange={(e) => onChange({ input: { ...input, multi: e.target.checked } })}
              className="w-3.5 h-3.5"
            />
            {t('reports.wizard.params.multi', { defaultValue: 'Allow multiple selections' })}
          </label>
        )}
      </div>
    )
  }

  if (input.kind === 'slider') {
    return (
      <div className="grid grid-cols-3 gap-2">
        <NumberField
          label={t('reports.wizard.params.min', { defaultValue: 'Min' })}
          value={input.min ?? 0}
          onChange={(v) => onChange({ input: { ...input, min: v } })}
        />
        <NumberField
          label={t('reports.wizard.params.max', { defaultValue: 'Max' })}
          value={input.max ?? 100}
          onChange={(v) => onChange({ input: { ...input, max: v } })}
        />
        <NumberField
          label={t('reports.wizard.params.step', { defaultValue: 'Step' })}
          value={input.step ?? 1}
          onChange={(v) => onChange({ input: { ...input, step: v } })}
        />
      </div>
    )
  }

  if (input.kind === 'dateInput') {
    return (
      <div className="flex items-center gap-2 text-xs">
        <Label className="text-xs text-muted-foreground">
          {t('reports.wizard.params.granularity', { defaultValue: 'Granularity' })}
        </Label>
        <select
          value={input.granularity ?? 'day'}
          onChange={(e) =>
            onChange({
              input: {
                ...input,
                granularity: e.target.value as 'day' | 'month' | 'year',
              },
            })
          }
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="day">{t('reports.wizard.params.granularityDay', { defaultValue: 'Day' })}</option>
          <option value="month">{t('reports.wizard.params.granularityMonth', { defaultValue: 'Month' })}</option>
          <option value="year">{t('reports.wizard.params.granularityYear', { defaultValue: 'Year' })}</option>
        </select>
      </div>
    )
  }

  if (input.kind === 'dateRange') {
    const presets = input.presets ?? []
    const togglePreset = (key: string) => {
      const next = presets.includes(key) ? presets.filter((k) => k !== key) : [...presets, key]
      onChange({ input: { ...input, presets: next } })
    }
    const PRESETS = ['last7', 'last30', 'last90', 'thisMonth', 'thisYear']
    return (
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('reports.wizard.params.presets', { defaultValue: 'Quick presets' })}
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => {
            const active = presets.includes(p)
            return (
              <button
                key={p}
                type="button"
                onClick={() => togglePreset(p)}
                className={cn(
                  'px-2 py-0.5 rounded-md text-[11px] border transition-colors',
                  active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                {active && <Check className="w-2.5 h-2.5 me-1 inline-block" strokeWidth={3} />}
                {t(`reports.wizard.params.preset.${p}`, { defaultValue: p })}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  if (input.kind === 'textInput') {
    return (
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t('reports.wizard.params.placeholder', { defaultValue: 'Placeholder' })}
        </Label>
        <Input
          value={input.placeholder ?? ''}
          onChange={(e) => onChange({ input: { ...input, placeholder: e.target.value } })}
          className="h-7 text-xs"
        />
      </div>
    )
  }

  if (input.kind === 'dimensionGrid') {
    const availableQueries = computeQueries(draft)
    const activeQuery = input.options?.fromQuery ?? availableQueries[0]
    const availableColumns = columnsForQuery(draft, activeQuery)
    const pickedColumns = input.columns ?? []
    const setColumns = (next: string[]) => onChange({ input: { ...input, columns: next } })
    const toggleColumn = (c: string) => {
      if (pickedColumns.includes(c)) setColumns(pickedColumns.filter((x) => x !== c))
      else setColumns([...pickedColumns, c])
    }
    const setFromQuery = (q: string) =>
      onChange({
        input: {
          ...input,
          options: { ...(input.options ?? {}), fromQuery: q },
        },
      })
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {t('reports.wizard.params.fromQuery', { defaultValue: 'Query' })}
            </Label>
            <select
              value={activeQuery}
              onChange={(e) => setFromQuery(e.target.value)}
              className="h-7 rounded-md border border-input bg-background px-2 text-xs w-full"
            >
              {availableQueries.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {t('reports.wizard.params.pivotColumns', { defaultValue: 'Pivot columns' })}
          </Label>
          <div className="flex flex-wrap gap-1">
            {availableColumns.length === 0 && (
              <span className="text-[11px] text-muted-foreground italic">
                {t('reports.wizard.params.noColumnsForQuery', {
                  defaultValue: 'No columns available from this query.',
                })}
              </span>
            )}
            {availableColumns.map((c) => {
              const on = pickedColumns.includes(c)
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleColumn(c)}
                  className={cn(
                    'text-[11px] px-2 py-0.5 rounded-md border transition-colors',
                    on
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground border-border hover:bg-accent',
                  )}
                >
                  {c}
                </button>
              )
            })}
          </div>
          <p className="text-[10px] text-muted-foreground pt-0.5">
            {t('reports.wizard.params.pivotColumnsHint', {
              defaultValue: 'Each picked column becomes a tile of clickable values in the viewer.',
            })}
          </p>
        </div>
      </div>
    )
  }

  // checkbox has no extra config.
  return null
}

function OptionListEditor({
  options,
  onChange,
}: {
  options: Array<{ value: unknown; label: string }>
  onChange: (next: Array<{ value: unknown; label: string }>) => void
}) {
  const { t } = useTranslation()
  const [rawValue, setRawValue] = useState('')
  const [rawLabel, setRawLabel] = useState('')

  const addOption = () => {
    if (!rawValue.trim()) return
    onChange([...options, { value: rawValue, label: rawLabel || rawValue }])
    setRawValue('')
    setRawLabel('')
  }
  const removeOption = (i: number) => onChange(options.filter((_, idx) => idx !== i))

  return (
    <div className="space-y-1">
      {options.length === 0 && (
        <div className="text-[11px] text-muted-foreground italic">
          {t('reports.wizard.params.noOptions', {
            defaultValue: 'No options yet — add value / label pairs below.',
          })}
        </div>
      )}
      <ul className="space-y-1">
        {options.map((o, i) => (
          <li key={i} className="flex items-center gap-1.5 text-xs">
            <code className="px-1.5 py-0.5 rounded bg-muted text-[11px]">{String(o.value)}</code>
            <span className="text-muted-foreground">→</span>
            <span className="flex-1 truncate">{o.label}</span>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => removeOption(i)}>
              <Trash2 className="w-3 h-3" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-1.5 pt-1">
        <Input
          value={rawValue}
          onChange={(e) => setRawValue(e.target.value)}
          placeholder={t('reports.wizard.params.valuePlaceholder', { defaultValue: 'value' })}
          className="h-7 text-xs w-28 font-mono"
        />
        <Input
          value={rawLabel}
          onChange={(e) => setRawLabel(e.target.value)}
          placeholder={t('reports.wizard.params.optionLabelPlaceholder', { defaultValue: 'label (defaults to value)' })}
          className="h-7 text-xs flex-1"
        />
        <Button size="sm" variant="outline" className="h-7" onClick={addOption} disabled={!rawValue.trim()}>
          <Plus className="w-3 h-3" />
        </Button>
      </div>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="number"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(n)
        }}
        className="h-7 text-xs"
      />
    </div>
  )
}

/** Renders the right editor for `defaultValue` given the param's
 *  input kind. Kept intentionally simple — a text field for
 *  most, a switch for checkbox, and a date input for date kinds. */
function DefaultValueInput({
  param,
  onChange,
}: {
  param: ReportParam
  onChange: (v: unknown) => void
}) {
  const kind = param.input.kind
  const value = param.defaultValue

  if (kind === 'checkbox') {
    return (
      <div className="flex items-center gap-2 text-xs">
        <Switch
          checked={value === true || value === 'true'}
          onCheckedChange={(v) => onChange(Boolean(v))}
        />
        <span className="text-muted-foreground">
          {value === true || value === 'true' ? 'true' : 'false'}
        </span>
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-muted-foreground">
          <ToggleLeft className="w-3 h-3" />
        </span>
      </div>
    )
  }

  if (kind === 'slider') {
    return (
      <Input
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => {
          const n = Number(e.target.value)
          onChange(Number.isFinite(n) ? n : undefined)
        }}
        className="h-7 text-xs"
      />
    )
  }

  if (kind === 'dateInput') {
    return (
      <Input
        type="date"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="h-7 text-xs"
      />
    )
  }

  if (kind === 'dateRange') {
    const range = (value ?? {}) as { start?: string; end?: string }
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type="date"
          value={range.start ?? ''}
          onChange={(e) => onChange({ ...range, start: e.target.value || undefined })}
          className="h-7 text-xs"
        />
        <span className="text-muted-foreground text-xs">→</span>
        <Input
          type="date"
          value={range.end ?? ''}
          onChange={(e) => onChange({ ...range, end: e.target.value || undefined })}
          className="h-7 text-xs"
        />
      </div>
    )
  }

  // textInput, dropdown (single value), buttonGroup — plain text.
  return (
    <Input
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="h-7 text-xs"
    />
  )
}

/** Default input config for a fresh param — sensible starter values
 *  so the row renders correctly the moment it's added. */
function defaultInputFor(kind: ParamInputKind): ReportParam['input'] {
  switch (kind) {
    case 'dropdown':
      return { kind, options: { static: [] } }
    case 'buttonGroup':
      return { kind, options: { static: [] } }
    case 'slider':
      return { kind, min: 0, max: 100, step: 1 }
    case 'dateRange':
      return { kind, presets: ['last7', 'last30'] }
    case 'dateInput':
      return { kind, granularity: 'day' }
    case 'textInput':
      return { kind, placeholder: '' }
    case 'checkbox':
      return { kind }
    case 'dimensionGrid':
      return { kind, columns: [], options: {} }
  }
}

/** Sensible default value for a freshly-added param — mostly
 *  undefined so the runtime falls through to "no value" until the
 *  user picks something. */
function defaultValueFor(kind: ParamInputKind): unknown {
  if (kind === 'checkbox') return false
  return undefined
}

/** Restrict param ids to identifier-shaped strings so URL keys and
 *  `{{param.id}}` references stay unambiguous. */
function sanitiseId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)
}

/** Guarantee a unique id when adding a new param. `param`, `param_2`, … */
function uniqueId(existing: string[]): string {
  const base = 'param'
  if (!existing.includes(base)) return base
  let i = 2
  while (existing.includes(`${base}_${i}`)) i += 1
  return `${base}_${i}`
}
