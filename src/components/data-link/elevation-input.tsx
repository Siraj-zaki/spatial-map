/**
 * ElevationInput — richer editor for `DataLinkFieldMapping.elevation`.
 *
 * The pre-v5.3 control was a single "pick a numeric field" combobox —
 * fine when the source emits its own z, useless for the common REST /
 * table case where records only carry a floor *name* (`F2`, `Ground`)
 * or where the whole layer sits on one floor. This control widens it to
 * three modes:
 *
 *   • **Field**  — same as before: pick or type a payload path.
 *   • **Static** — one metres-above-ground for every record (fastest
 *     to reason about; no per-row lookup).
 *   • **Rules**  — first-match wins. Each rule tests a payload field
 *     against a string (equals / contains / starts / ends with) and
 *     produces a metres value; a final fallback catches everything
 *     else. Made for "if floor_name == F2 then z = 12" style setups.
 *
 * Kept a controlled component (`value` / `onChange`) so the editor
 * doesn't have to know about the internal state — the shape is exactly
 * `ElevationSpec` from `@/lib/db`, minus `undefined` (which the editor
 * treats as "no elevation configured").
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type {
  ElevationRule,
  ElevationSpec,
} from '@/lib/db'

// Local, minimal shape for the field-picker options — same fields we use
// in `data-link-editor-v3.tsx`'s `SampleField` but declared here so this
// component doesn't cross-import the editor.
export interface ElevationFieldOption {
  path: string
  type: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object'
}

export interface ElevationInputProps {
  value: ElevationSpec | undefined
  onChange: (next: ElevationSpec | undefined) => void
  fields: ReadonlyArray<ElevationFieldOption>
  /**
   * Legacy `elevationField` string. When present and `value` is empty,
   * the control seeds itself in Field mode with this path so the user
   * sees their prior config; on any edit we hand `onChange` the new
   * `ElevationSpec` and the editor drops the legacy field on save.
   */
  legacyField?: string
}

type Mode = 'none' | 'field' | 'static' | 'rules'

const MODES: Array<{ id: Mode; labelKey: string; fallback: string }> = [
  { id: 'none', labelKey: 'dataLink.elevationModeNone', fallback: 'None' },
  { id: 'field', labelKey: 'dataLink.elevationModeField', fallback: 'From field' },
  { id: 'static', labelKey: 'dataLink.elevationModeStatic', fallback: 'Static value' },
  { id: 'rules', labelKey: 'dataLink.elevationModeRules', fallback: 'Conditional' },
]

const OP_LABELS: Record<ElevationRule['op'], string> = {
  equals: 'equals',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
}

export function ElevationInput({
  value,
  onChange,
  fields,
  legacyField,
}: ElevationInputProps) {
  const { t } = useTranslation()

  // Effective spec — the legacy field pretends to be a `field` mode
  // spec until the user touches something, at which point we
  // promote it to a real one via onChange.
  const effective: ElevationSpec | undefined = useMemo(() => {
    if (value) return value
    if (legacyField) return { kind: 'field', field: legacyField }
    return undefined
  }, [value, legacyField])

  const mode: Mode = effective?.kind ?? 'none'

  const setMode = useCallback(
    (next: Mode) => {
      if (next === mode) return
      switch (next) {
        case 'none':
          onChange(undefined)
          return
        case 'field':
          onChange({
            kind: 'field',
            field: effective?.kind === 'field' ? effective.field : legacyField ?? '',
          })
          return
        case 'static':
          onChange({
            kind: 'static',
            value:
              effective?.kind === 'static' && Number.isFinite(effective.value)
                ? effective.value
                : 0,
          })
          return
        case 'rules':
          onChange({
            kind: 'rules',
            rules:
              effective?.kind === 'rules' && effective.rules.length > 0
                ? effective.rules
                : [{ field: '', op: 'equals', match: '', value: 0 }],
            fallback:
              effective?.kind === 'rules' ? effective.fallback : undefined,
          })
          return
      }
    },
    [mode, onChange, effective, legacyField],
  )

  return (
    <div className="grid gap-2">
      <div className="flex rounded-md border border-input bg-background p-0.5 gap-0.5 text-xs">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            aria-pressed={mode === m.id}
            className={
              'flex-1 py-1 px-2 rounded transition-colors ' +
              (mode === m.id
                ? 'bg-primary text-primary-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent')
            }
          >
            {t(m.labelKey, { defaultValue: m.fallback })}
          </button>
        ))}
      </div>

      {mode === 'field' && effective?.kind === 'field' && (
        <FieldModeInput
          value={effective.field}
          onChange={(v) => onChange({ kind: 'field', field: v })}
          fields={fields}
        />
      )}

      {mode === 'static' && effective?.kind === 'static' && (
        <StaticModeInput
          value={effective.value}
          onChange={(v) => onChange({ kind: 'static', value: v })}
        />
      )}

      {mode === 'rules' && effective?.kind === 'rules' && (
        <RulesModeInput
          value={effective}
          onChange={onChange}
          fields={fields}
        />
      )}
    </div>
  )
}

// ================================================================
// Field mode
// ================================================================

function FieldModeInput({
  value,
  onChange,
  fields,
}: {
  value: string
  onChange: (next: string) => void
  fields: ReadonlyArray<ElevationFieldOption>
}) {
  const { t } = useTranslation()
  const numeric = fields.filter((f) => f.type === 'number')
  return (
    <div className="flex gap-1.5 items-center">
      <select
        value={numeric.some((f) => f.path === value) ? value : '__custom__'}
        onChange={(e) => {
          if (e.target.value === '__custom__') return
          onChange(e.target.value)
        }}
        className="h-8 flex-1 min-w-0 rounded-md border bg-background px-2 text-xs"
      >
        <option value="">
          {t('dataLink.elevationFieldNone', { defaultValue: '(none)' })}
        </option>
        {numeric.map((f) => (
          <option key={f.path} value={f.path}>
            {f.path}
          </option>
        ))}
        <option value="__custom__">
          {t('dataLink.elevationFieldCustom', {
            defaultValue: 'Custom path…',
          })}
        </option>
      </select>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. floor.z"
        className="h-8 text-xs font-mono w-40"
      />
    </div>
  )
}

// ================================================================
// Static mode
// ================================================================

function StaticModeInput({
  value,
  onChange,
}: {
  value: number
  onChange: (next: number) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(Number(e.target.value))}
        placeholder="0"
        className="h-8 text-xs w-40"
        step="any"
      />
      <span className="text-[11px] text-muted-foreground">
        {t('dataLink.elevationMeters', { defaultValue: 'metres above ground' })}
      </span>
    </div>
  )
}

// ================================================================
// Rules mode
// ================================================================

function RulesModeInput({
  value,
  onChange,
  fields,
}: {
  value: Extract<ElevationSpec, { kind: 'rules' }>
  onChange: (next: ElevationSpec) => void
  fields: ReadonlyArray<ElevationFieldOption>
}) {
  const { t } = useTranslation()

  const patch = useCallback(
    (patchFn: (r: Extract<ElevationSpec, { kind: 'rules' }>) => Extract<ElevationSpec, { kind: 'rules' }>) => {
      onChange(patchFn(value))
    },
    [onChange, value],
  )

  const addRule = () =>
    patch((v) => ({
      ...v,
      rules: [...v.rules, { field: '', op: 'equals', match: '', value: 0 }],
    }))

  const updateRule = (i: number, next: Partial<ElevationRule>) =>
    patch((v) => ({
      ...v,
      rules: v.rules.map((r, idx) => (idx === i ? { ...r, ...next } : r)),
    }))

  const removeRule = (i: number) =>
    patch((v) => ({ ...v, rules: v.rules.filter((_, idx) => idx !== i) }))

  const setFallback = (raw: string) =>
    patch((v) => {
      const n = Number(raw)
      return {
        ...v,
        fallback: raw === '' || !Number.isFinite(n) ? undefined : n,
      }
    })

  return (
    <div className="grid gap-2">
      <div className="grid gap-1.5">
        {value.rules.map((rule, i) => (
          <RuleRow
            key={i}
            rule={rule}
            fields={fields}
            onChange={(next) => updateRule(i, next)}
            onRemove={value.rules.length > 1 ? () => removeRule(i) : undefined}
          />
        ))}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" onClick={addRule}>
          <Plus size={12} className="me-1" />
          {t('dataLink.elevationRuleAdd', { defaultValue: 'Add rule' })}
        </Button>

        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">
            {t('dataLink.elevationRuleFallback', {
              defaultValue: 'Otherwise:',
            })}
          </span>
          <Input
            type="number"
            value={value.fallback ?? ''}
            onChange={(e) => setFallback(e.target.value)}
            placeholder="skip"
            className="h-7 text-xs w-20"
            step="any"
          />
          <span className="text-[11px] text-muted-foreground">m</span>
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground">
        {t('dataLink.elevationRuleHint', {
          defaultValue:
            'First matching rule wins. Leave “Otherwise” empty to fall through to the shape’s own floor.',
        })}
      </p>
    </div>
  )
}

function RuleRow({
  rule,
  fields,
  onChange,
  onRemove,
}: {
  rule: ElevationRule
  fields: ReadonlyArray<ElevationFieldOption>
  onChange: (next: Partial<ElevationRule>) => void
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  // Rules test field values as strings, so string/number/boolean fields
  // are all candidates — restricting to string would exclude the
  // useful `floorId = 2` case.
  const candidates = fields.filter(
    (f) => f.type === 'string' || f.type === 'number' || f.type === 'boolean',
  )
  const listed = candidates.some((f) => f.path === rule.field)

  return (
    <div className="grid gap-1 border border-border rounded-md p-2">
      <div className="grid grid-cols-[1fr_auto_1fr] gap-1.5 items-center">
        <select
          value={listed ? rule.field : '__custom__'}
          onChange={(e) => {
            if (e.target.value === '__custom__') return
            onChange({ field: e.target.value })
          }}
          className="h-7 rounded-md border bg-background px-2 text-xs min-w-0"
        >
          <option value="">
            {t('dataLink.elevationRuleFieldPlaceholder', {
              defaultValue: '(pick field)',
            })}
          </option>
          {candidates.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path}
            </option>
          ))}
          <option value="__custom__">
            {t('dataLink.elevationFieldCustom', {
              defaultValue: 'Custom path…',
            })}
          </option>
        </select>

        <select
          value={rule.op}
          onChange={(e) => onChange({ op: e.target.value as ElevationRule['op'] })}
          className="h-7 rounded-md border bg-background px-2 text-xs"
        >
          {(Object.keys(OP_LABELS) as ElevationRule['op'][]).map((op) => (
            <option key={op} value={op}>
              {t(`dataLink.elevationOp.${op}`, { defaultValue: OP_LABELS[op] })}
            </option>
          ))}
        </select>

        <Input
          value={rule.match}
          onChange={(e) => onChange({ match: e.target.value })}
          placeholder={t('dataLink.elevationRuleMatchPlaceholder', {
            defaultValue: 'value',
          }) as string}
          className="h-7 text-xs px-2 min-w-0"
        />
      </div>

      {!listed && rule.field && (
        <Input
          value={rule.field}
          onChange={(e) => onChange({ field: e.target.value })}
          placeholder="custom path (e.g. floor.name)"
          className="h-7 text-xs font-mono"
        />
      )}

      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground shrink-0">
          {t('dataLink.elevationRuleThen', { defaultValue: 'then z =' })}
        </span>
        <Input
          type="number"
          value={Number.isFinite(rule.value) ? rule.value : ''}
          onChange={(e) => onChange({ value: Number(e.target.value) })}
          placeholder="0"
          className="h-7 text-xs w-24"
          step="any"
        />
        <span className="text-[11px] text-muted-foreground">m</span>
        <div className="flex-1" />
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title={
              t('dataLink.elevationRuleRemove', {
                defaultValue: 'Remove rule',
              }) as string
            }
            className="text-muted-foreground hover:text-destructive p-1 rounded hover:bg-accent"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
