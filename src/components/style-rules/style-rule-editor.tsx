/**
 * Inline editor for a single style rule. Mounts under the rule row in
 * `StyleRulesSection` when the user clicks the pencil icon.
 *
 * Saves go through Dexie on every field change — the rule is a small
 * row and writes are cheap. The slider/color-picker draft pattern we
 * use for grids isn't needed here because each rule already costs one
 * cell-style override evaluation per bin per render, which is O(B) and
 * doesn't grow with frequency of edits.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link2, Plus, Sigma, Target, Unlink, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  type AttributeDefinition,
  type StyleRuleRow,
  type StyleRuleCondition,
  type StyleRuleStyle,
} from '@/lib/db'
import type { BindingKind } from '@/lib/db'
import type {
  AggregateCondition,
  AggregateFn,
  AggregateOp,
  AttrCondition,
  RuleOp,
  RuleQuantifier,
  SourceSelector,
  TargetSelector,
} from '@/lib/style-rules/types'
import { useSpatialStore } from '@/lib/spatial-store'
import {
  useSpatialAttributeDefinitions,
  useSpatialCircles,
  useSpatialDataLinks,
  useSpatialGrids,
  useSpatialImages,
  useSpatialLines,
  useSpatialMarkers,
  useSpatialModels,
  useSpatialPolygons,
  useSpatialStairs,
  useSpatialTextLabels,
  useSpatialZones,
} from '@/hooks/useSpatialShapes'
import { getAttributeType, operatorsForWidget } from '@/lib/attribute-types'
import { fetchLayerRows } from '@/lib/data-link/layer-rows'
import { ShapeLinkPicker } from '@/components/shape-link-picker'
import type { ShapeLink } from '@/lib/shape-link'
import { linkId } from '@/lib/shape-link'

/** Translation function type passed to child components. */
type TFunc = (key: string, opts?: Record<string, unknown>) => string

/**
 * Rule scopes. All shape kinds plus `text-label` and `stair` (which
 * have no bins of their own but can be driven by cross-shape rules).
 * `key` is the i18n suffix under `styleRuleEditor.scope.*`.
 */
const SCOPES: { id: StyleRuleRow['scope']; key: string }[] = [
  { id: 'any', key: 'any' },
  { id: 'grid-cell', key: 'gridCell' },
  { id: 'polygon', key: 'polygon' },
  { id: 'circle', key: 'circle' },
  { id: 'line', key: 'line' },
  { id: 'marker', key: 'marker' },
  { id: 'image', key: 'image' },
  { id: 'model', key: 'model' },
  { id: 'text-label', key: 'textLabel' },
  { id: 'stair', key: 'stair' },
]

/** Map a scope id to its i18n key suffix. */
function scopeKey(id: StyleRuleRow['scope']): string {
  return SCOPES.find((s) => s.id === id)?.key ?? 'any'
}

const AGGREGATE_OPS: { id: AggregateOp; label: string }[] = [
  { id: 'eq',  label: '=' },
  { id: 'ne',  label: '≠' },
  { id: 'lt',  label: '<' },
  { id: 'lte', label: '≤' },
  { id: 'gt',  label: '>' },
  { id: 'gte', label: '≥' },
]

interface OpDef {
  id: StyleRuleCondition['op']
  needsValue: boolean
}

const OPS: OpDef[] = [
  { id: 'equals',     needsValue: true  },
  { id: 'notEquals',  needsValue: true  },
  { id: 'lt',         needsValue: true  },
  { id: 'lte',        needsValue: true  },
  { id: 'gt',         needsValue: true  },
  { id: 'gte',        needsValue: true  },
  { id: 'in',         needsValue: true  },
  { id: 'notIn',      needsValue: true  },
  { id: 'contains',   needsValue: true  },
  { id: 'startsWith', needsValue: true  },
  { id: 'endsWith',   needsValue: true  },
  { id: 'isEmpty',    needsValue: false },
  { id: 'isSet',      needsValue: false },
  { id: 'olderThan',  needsValue: true  },
  { id: 'newerThan',  needsValue: true  },
]

/** Resolve the display label for an op. Math symbols are universal; word labels go through i18n. */
function opLabel(o: OpDef, t: TFunc): string {
  switch (o.id) {
    case 'equals': return '='
    case 'notEquals': return '≠'
    case 'lt': return '<'
    case 'lte': return '≤'
    case 'gt': return '>'
    case 'gte': return '≥'
    default: return t(`styleRuleEditor.op.${o.id}`)
  }
}

/**
 * Built-in bin attributes that are always pickable, paired with the
 * `AttributeTypeDef.id` that drives the value-input widget. Status
 * doesn't have a defined enum here because the underlying `BinStatus`
 * union is fixed in code — we surface those choices as a hard-coded
 * dropdown below. `labelKey` is the i18n suffix under
 * `styleRuleEditor.builtinAttr.*`.
 */
const BUILTIN_ATTRS: ReadonlyArray<{
  key: string
  labelKey: string
  typeId: string
  enumValues?: string[]
}> = [
  { key: 'status',        labelKey: 'status',         typeId: 'enum',     enumValues: ['empty', 'occupied', 'reserved'] },
  { key: 'sku',           labelKey: 'sku',             typeId: 'sku' },
  { key: 'capacity',      labelKey: 'capacity',        typeId: 'number' },
  { key: 'notes',         labelKey: 'notes',           typeId: 'text' },
  { key: 'externalCode',  labelKey: 'externalCode',    typeId: 'text' },
  { key: 'lastSyncedAt',  labelKey: 'lastSynced',      typeId: 'datetime' },
  { key: 'syncSource',    labelKey: 'syncSource',      typeId: 'number' },
]

interface AttrOption {
  /** Path the rule stores in `condition.attribute`. */
  path: string
  label: string
  typeId: string
  enumValues?: string[]
  custom: boolean
  /** Where this option came from — drives the optgroup label in the picker. */
  origin?: 'builtin' | 'schema' | 'data-link'
}

/**
 * Sample up to 200 rows from a data-link source and build an AttrOption per
 * distinct payload key. When a key has <= 20 distinct string values it's
 * treated as an enum (drives the value dropdown); when every value parses
 * as a number, it's typed `number` (drives the numeric input). Everything
 * else falls back to `text`. Keeps the picker useful even against ad-hoc
 * REST/CSV feeds that don't have declared attribute_definitions.
 */
function extractPayloadFields(
  rows: ReadonlyArray<{ payload: Record<string, unknown> }>,
): AttrOption[] {
  const distinct = new Map<string, { values: Set<string>; numeric: boolean }>()
  for (const row of rows.slice(0, 200)) {
    if (!row.payload || typeof row.payload !== 'object') continue
    for (const [key, raw] of Object.entries(row.payload)) {
      if (raw === null || raw === undefined || raw === '') continue
      if (typeof raw === 'object') continue // skip nested containers
      const s = String(raw)
      const entry =
        distinct.get(key) ?? { values: new Set<string>(), numeric: true }
      entry.values.add(s)
      if (entry.numeric && Number.isNaN(Number(s))) entry.numeric = false
      distinct.set(key, entry)
    }
  }
  return Array.from(distinct.entries())
    .filter(([, v]) => v.values.size > 0)
    .map(([key, v]) => {
      const isEnum = v.values.size <= 20 && !v.numeric
      const typeId = v.numeric ? 'number' : isEnum ? 'enum' : 'text'
      return {
        path: key,
        label: key,
        typeId,
        enumValues: isEnum ? Array.from(v.values).sort() : undefined,
        custom: true,
        origin: 'data-link' as const,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

interface Props {
  rule: StyleRuleRow
  onClose: () => void
}

export function StyleRuleEditor({ rule, onClose }: Props) {
  const { t } = useTranslation()
  // Edits are debounced (200ms) so a long name doesn't hammer Dexie on
  // every keystroke. The editor is *uncontrolled*: we initialize from
  // the rule prop once and never auto-sync. If the parent wants fresh
  // data (rare — they pulled the row from the same live query), it can
  // pass a `key={rule.id}` to force a remount.
  const [local, setLocal] = useState<StyleRuleRow>(rule)

  // Attribute definitions come from the spatial store, which is loaded once
  // per tenant and updated via SSE. No polling inside the editor.
  const { data: defs = [] } = useSpatialAttributeDefinitions(rule.zoneId)

  // Data-link field discovery. The picker is ephemeral (not persisted on
  // the rule) — its only job is to surface real payload fields + real
  // sampled values so the user can write rules like "severity = critical"
  // against a data-link layer without hand-typing the attribute path.
  // Once the rule is saved, condition.attribute stores the raw payload
  // path and works with any config that happens to reference this rule.
  const { data: allDataLinks = [] } = useSpatialDataLinks()
  const zoneDataLinks = useMemo(
    () =>
      allDataLinks.filter(
        (c) => rule.zoneId === undefined || c.zoneId === rule.zoneId,
      ),
    [allDataLinks, rule.zoneId],
  )
  const [pickedDataLinkId, setPickedDataLinkId] = useState<number | null>(null)
  const pickedDataLink = useMemo(
    () =>
      pickedDataLinkId !== null
        ? zoneDataLinks.find((c) => c.id === pickedDataLinkId) ?? null
        : null,
    [pickedDataLinkId, zoneDataLinks],
  )
  const [dlFieldOptions, setDlFieldOptions] = useState<AttrOption[]>([])
  useEffect(() => {
    if (!pickedDataLink) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDlFieldOptions([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const rows = await fetchLayerRows(pickedDataLink, {})
        if (cancelled) return
        setDlFieldOptions(extractPayloadFields(rows))
      } catch (err) {
        if (!cancelled) {
          console.warn(
            '[style-rule-editor] failed to fetch sample rows for data-link',
            pickedDataLink.name,
            err,
          )
          setDlFieldOptions([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pickedDataLink])

  const attrOptions = useMemo<AttrOption[]>(() => {
    const customDefs = defs.filter(
      (d: AttributeDefinition) =>
        d.scope === 'any' || d.scope === (local.scope as AttributeDefinition['scope']),
    )
    const customs: AttrOption[] = customDefs.map((d) => ({
      path: `custom.${d.key}`,
      label: d.label,
      typeId: d.type,
      enumValues: d.enumValues,
      custom: true,
      origin: 'schema' as const,
    }))
    const builtins: AttrOption[] = BUILTIN_ATTRS.map((b) => ({
      path: b.key,
      label: t(`styleRuleEditor.builtinAttr.${b.labelKey}`),
      typeId: b.typeId,
      enumValues: b.enumValues,
      custom: false,
      origin: 'builtin' as const,
    }))
    // Data-link fields last — dedupe against builtin/schema paths so the
    // picker doesn't show the same key twice when a payload uses `status`
    // (already a built-in) or matches a registered attribute_definition.
    const seen = new Set([...builtins, ...customs].map((o) => o.path))
    const dl = dlFieldOptions.filter((o) => !seen.has(o.path))
    return [...builtins, ...customs, ...dl]
  }, [defs, local.scope, dlFieldOptions, t])

  /** Resolve the option behind a condition.attribute string. */
  const optionFor = (attr: string): AttrOption | undefined =>
    attrOptions.find((o) => o.path === attr)

  const updateLocal = useSpatialStore((s) => s.updateLocal)

  useEffect(() => {
    if (rule.id === undefined) return
    const t = window.setTimeout(() => {
      updateLocal('style-rules', rule.id!, { ...local, updatedAt: new Date() })
    }, 200)
    return () => window.clearTimeout(t)
  }, [local, rule.id, updateLocal])

  const update = <K extends keyof StyleRuleRow>(key: K, value: StyleRuleRow[K]) => {
    setLocal((r) => ({ ...r, [key]: value }))
  }
  const updateStyle = <K extends keyof StyleRuleStyle>(
    key: K,
    value: StyleRuleStyle[K],
  ) => {
    setLocal((r) => ({ ...r, style: { ...r.style, [key]: value } }))
  }
  const replaceCondition = (idx: number, next: StyleRuleCondition) => {
    setLocal((r) => ({
      ...r,
      conditions: r.conditions.map((c, i) => (i === idx ? next : c)),
    }))
  }
  const addAttrCondition = () => {
    const next: AttrCondition = {
      type: 'attr',
      attribute: 'status',
      op: 'equals',
      value: '',
    }
    setLocal((r) => ({ ...r, conditions: [...r.conditions, next] }))
  }
  const addAggregateCondition = () => {
    const next: AggregateCondition = {
      type: 'aggregate',
      fn: 'count',
      op: 'gt',
      value: 0,
    }
    setLocal((r) => ({ ...r, conditions: [...r.conditions, next] }))
  }
  const removeCondition = (idx: number) => {
    setLocal((r) => ({
      ...r,
      conditions: r.conditions.filter((_, i) => i !== idx),
    }))
  }

  /** True when the rule's source resolves to many bins — enables quantifiers/aggregates. */
  const sourceIsMulti = (() => {
    const s = local.source
    if (!s) return false
    return s.type === 'allCellsOf' || s.type === 'allOfKind'
  })()

  return (
    <div className="border-t bg-background/60 p-2.5 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px]">{t('styleRuleEditor.form.name')}</Label>
          <Input
            value={local.name}
            onChange={(e) => update('name', e.target.value)}
            className="h-7 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px]">{t('styleRuleEditor.form.priority')}</Label>
          <Input
            type="number"
            value={local.priority}
            onChange={(e) => update('priority', Number(e.target.value) || 0)}
            className="h-7 text-xs font-mono"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px]">{t('styleRuleEditor.form.scope')}</Label>
          <select
            value={local.scope}
            onChange={(e) => update('scope', e.target.value as StyleRuleRow['scope'])}
            className="h-7 w-full text-xs rounded border border-input bg-background px-1.5"
          >
            {SCOPES.map((s) => (
              <option key={s.id} value={s.id}>{t(`styleRuleEditor.scope.${s.key}`)}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-[10px]">{t('styleRuleEditor.form.combine')}</Label>
          <select
            value={local.combine}
            onChange={(e) => update('combine', e.target.value as 'and' | 'or')}
            className="h-7 w-full text-xs rounded border border-input bg-background px-1.5"
          >
            <option value="and">{t('styleRuleEditor.form.combineAll')}</option>
            <option value="or">{t('styleRuleEditor.form.combineAny')}</option>
          </select>
        </div>
      </div>

      {/* Optional data-link picker. Selecting a layer surfaces its real
          payload fields (with sampled values) in the Attribute dropdown
          below. Purely ephemeral — the picker doesn't persist on the
          rule. Also auto-aligns Scope with the layer's targetKind so the
          shape-side attribute defs continue to match. */}
      {zoneDataLinks.length > 0 && (
        <div className="space-y-1 rounded-md border border-dashed border-primary/30 bg-primary/5 p-2">
          <Label className="text-[10px] font-semibold uppercase tracking-wider text-primary/80">
            {t('styleRuleEditor.form.suggestFromDataLink')}
          </Label>
          <select
            value={pickedDataLinkId ?? ''}
            onChange={(e) => {
              const raw = e.target.value
              const id = raw ? Number(raw) : null
              setPickedDataLinkId(id)
              if (id === null) return
              const cfg = zoneDataLinks.find((c) => c.id === id)
              if (!cfg) return
              // Auto-align scope so attribute_definitions filter matches
              // and downstream sub-renderer honours the rule.
              const nextScope = cfg.targetKind as StyleRuleRow['scope']
              if (SCOPES.some((s) => s.id === nextScope)) {
                update('scope', nextScope)
              }
            }}
            className="h-7 w-full text-xs rounded border border-input bg-background px-1.5"
          >
            <option value="">{t('styleRuleEditor.form.noDataLink')}</option>
            {zoneDataLinks.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.renderMode} · {c.targetKind}
              </option>
            ))}
          </select>
          {pickedDataLink && (
            <p className="text-[10px] text-muted-foreground px-0.5">
              {dlFieldOptions.length === 0
                ? t('styleRuleEditor.form.loadingFields')
                : t('styleRuleEditor.form.fieldsAvailable', { count: dlFieldOptions.length })}
            </p>
          )}
        </div>
      )}

      {/* Target picker — every shape of scope, a specific shape, a
          specific cell, or every shape in a warehouse. */}
      <TargetPicker
        scope={local.scope}
        target={local.target}
        legacyShapeId={local.targetShapeId}
        legacyCell={local.targetGridCell}
        t={t}
        onChange={(target) =>
          setLocal((r) => ({
            ...r,
            target,
            // Clear legacy fields when the new selector is set so the
            // resolver doesn't see contradictory values.
            targetShapeId: undefined,
            targetGridCell: undefined,
          }))
        }
      />

      {/* Source picker — self, a specific shape, all cells of a rack,
          or every shape of a kind. */}
      <SourcePicker
        source={local.source}
        legacySourceShape={local.sourceShape}
        t={t}
        onChange={(source) =>
          setLocal((r) => ({
            ...r,
            source,
            sourceShape: undefined,
          }))
        }
      />

      {/* Conditions */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-[10px]">{t('styleRuleEditor.form.conditions')}</Label>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              onClick={addAttrCondition}
            >
              <Plus className="w-3 h-3 me-1" />
              {t('styleRuleEditor.button.attribute')}
            </Button>
            {sourceIsMulti && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px]"
                onClick={addAggregateCondition}
              >
                <Sigma className="w-3 h-3 me-1" />
                {t('styleRuleEditor.button.aggregate')}
              </Button>
            )}
          </div>
        </div>
        {local.conditions.length === 0 && (
          <p className="text-[10px] text-muted-foreground px-1">
            {t('styleRuleEditor.description.noConditions')}
          </p>
        )}
        {local.conditions.map((rawCond, idx) => {
          // Widen the legacy `{attribute, op, value}` shape to the v3
          // `attr` variant on read so the UI dispatches uniformly.
          const cond: AttrCondition | AggregateCondition =
            'type' in rawCond ? rawCond : { type: 'attr', ...rawCond }
          if (cond.type === 'aggregate') {
            return (
              <AggregateConditionRow
                key={idx}
                cond={cond}
                attrOptions={attrOptions}
                t={t}
                onChange={(next) => replaceCondition(idx, next)}
                onRemove={() => removeCondition(idx)}
              />
            )
          }
          return (
            <AttrConditionRow
              key={idx}
              cond={cond}
              attrOptions={attrOptions}
              showQuantifier={sourceIsMulti}
              optionFor={optionFor}
              t={t}
              onChange={(next) => replaceCondition(idx, next)}
              onRemove={() => removeCondition(idx)}
            />
          )
        })}
      </div>

      {/* Style */}
      <div className="space-y-1.5">
        <Label className="text-[10px]">{t('styleRuleEditor.form.paintWhenMatched')}</Label>
        <div className="grid grid-cols-2 gap-2">
          <ColorField label={t('styleRuleEditor.form.fill')} t={t} value={local.style.fillColor} onChange={(v) => updateStyle('fillColor', v)} />
          <ColorField label={t('styleRuleEditor.form.border')} t={t} value={local.style.borderColor} onChange={(v) => updateStyle('borderColor', v)} />
          <NumberField label={t('styleRuleEditor.form.opacity')} value={local.style.fillOpacity} onChange={(v) => updateStyle('fillOpacity', v)} min={0} max={100} />
          <NumberField label={t('styleRuleEditor.form.borderWidth')} value={local.style.borderWidth} onChange={(v) => updateStyle('borderWidth', v)} min={0} max={10} />
          <NumberField label={t('styleRuleEditor.form.elevation')} value={local.style.elevation} onChange={(v) => updateStyle('elevation', v)} min={0} />
          <NumberField label={t('styleRuleEditor.form.height')} value={local.style.height} onChange={(v) => updateStyle('height', v)} min={0} />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px]">{t('styleRuleEditor.form.labelTemplate')}</Label>
          <Input
            value={local.style.labelText ?? ''}
            onChange={(e) => updateStyle('labelText', e.target.value || undefined)}
            placeholder={t('styleRuleEditor.form.labelTemplatePlaceholder')}
            className="h-7 text-xs"
          />
        </div>
      </div>

      <div className="flex justify-end pt-1">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={onClose}>
          {t('styleRuleEditor.button.done')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Renders the value input for one condition. Switches on the widget
 * type of the picked attribute so an enum becomes a select, a number
 * becomes a numeric input, and `in` / `notIn` always accept a
 * comma-separated list regardless of widget.
 */
function ValueInput({
  cond,
  widget,
  enumValues,
  t,
  onChange,
}: {
  cond: StyleRuleCondition
  widget: string
  enumValues?: string[]
  t: TFunc
  onChange: (v: StyleRuleCondition['value']) => void
}) {
  const isListOp = cond.op === 'in' || cond.op === 'notIn'

  // `in` / `notIn` always operate on lists. When the attribute is an
  // enum we render a multi-pick of toggles so the user can build the
  // list without remembering exact spellings.
  if (isListOp && enumValues && enumValues.length > 0) {
    const selected = Array.isArray(cond.value) ? cond.value.map(String) : []
    return (
      <div className="flex flex-wrap gap-1 max-w-[180px]">
        {enumValues.map((v) => {
          const on = selected.includes(v)
          return (
            <button
              key={v}
              type="button"
              onClick={() => {
                const next = on ? selected.filter((s) => s !== v) : [...selected, v]
                onChange(next)
              }}
              className={
                'px-1.5 py-0.5 text-[10px] font-mono rounded border ' +
                (on
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent')
              }
            >
              {v}
            </button>
          )
        })}
      </div>
    )
  }

  if (isListOp) {
    return (
      <Input
        value={Array.isArray(cond.value) ? cond.value.join(', ') : ''}
        onChange={(e) =>
          onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))
        }
        placeholder={t('styleRuleEditor.placeholder.list')}
        className="h-7 text-xs font-mono w-28"
      />
    )
  }

  if (widget === 'enum' && enumValues && enumValues.length > 0) {
    return (
      <select
        value={cond.value === undefined || cond.value === null ? '' : String(cond.value)}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-xs font-mono rounded border border-input bg-background px-1 w-28"
      >
        <option value="">—</option>
        {enumValues.map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    )
  }

  if (widget === 'boolean') {
    return (
      <select
        value={cond.value === true || cond.value === 'true' ? 'true' : 'false'}
        onChange={(e) => onChange(e.target.value === 'true')}
        className="h-7 text-xs rounded border border-input bg-background px-1 w-20"
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }

  if (
    widget === 'number' ||
    widget === 'integer' ||
    widget === 'currency' ||
    widget === 'measure' ||
    widget === 'duration'
  ) {
    return (
      <Input
        type="number"
        value={typeof cond.value === 'number' ? cond.value : cond.value === undefined ? '' : String(cond.value)}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        placeholder={t('styleRuleEditor.placeholder.value')}
        className="h-7 text-xs font-mono w-24"
      />
    )
  }

  if (widget === 'date') {
    return (
      <Input
        type="date"
        value={typeof cond.value === 'string' ? cond.value : ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-xs w-32"
      />
    )
  }

  if (widget === 'datetime') {
    return (
      <Input
        type="datetime-local"
        value={typeof cond.value === 'string' ? cond.value : ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-xs w-40"
      />
    )
  }

  return (
    <Input
      value={cond.value === undefined || cond.value === null ? '' : String(cond.value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t('styleRuleEditor.placeholder.value')}
      className="h-7 text-xs font-mono w-24"
    />
  )
}

function ColorField({
  label,
  value,
  t,
  onChange,
}: {
  label: string
  value?: string
  t: TFunc
  onChange: (v: string | undefined) => void
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px]">{label}</Label>
      <div className="flex items-center gap-1">
        <input
          type="color"
          value={value ?? '#6366f1'}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-9 cursor-pointer rounded border border-input"
        />
        <Input
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder={t('styleRuleEditor.placeholder.hex')}
          className="h-7 text-xs font-mono flex-1"
        />
      </div>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string
  value?: number
  onChange: (v: number | undefined) => void
  min?: number
  max?: number
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px]">{label}</Label>
      <Input
        type="number"
        value={value ?? ''}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : Number(e.target.value))
        }
        min={min}
        max={max}
        className="h-7 text-xs font-mono"
      />
    </div>
  )
}

// ---------------------------------------------------------- TargetPicker
/**
 * "Where does this rule apply?" — All shapes of the rule's scope, a
 * specific shape instance, a specific grid cell, or every shape of
 * the kind in a particular warehouse. Backward compat: when the user
 * picks "specific shape", we keep writing both the new `target`
 * selector AND the legacy `targetShapeId` so old call sites still see
 * a sensible value.
 */
function TargetPicker({
  scope,
  target,
  legacyShapeId,
  legacyCell,
  t,
  onChange,
}: {
  scope: StyleRuleRow['scope']
  target?: TargetSelector
  legacyShapeId?: number
  legacyCell?: StyleRuleRow['targetGridCell']
  t: TFunc
  onChange: (next: TargetSelector | undefined) => void
}) {
  const { data: polygons = [] } = useSpatialPolygons()
  const { data: circles = [] } = useSpatialCircles()
  const { data: lines = [] } = useSpatialLines()
  const { data: markers = [] } = useSpatialMarkers()
  const { data: images = [] } = useSpatialImages()
  const { data: models = [] } = useSpatialModels()
  const { data: texts = [] } = useSpatialTextLabels()
  const { data: stairs = [] } = useSpatialStairs()
  const { data: grids = [] } = useSpatialGrids()
  const { data: zones = [] } = useSpatialZones()

  const shapes = useMemo<ReadonlyArray<{ id?: number; name?: string }>>(() => {
    if (scope === 'any') return []
    if (scope === 'grid-cell') return []
    const map = {
      polygon: polygons,
      circle: circles,
      line: lines,
      marker: markers,
      image: images,
      model: models,
      'text-label': texts,
      stair: stairs,
    } as const
    return map[scope as keyof typeof map] ?? []
  }, [scope, polygons, circles, lines, markers, images, models, texts, stairs])

  // Effective target — synthesise from legacy fields when the new
  // selector is unset so the picker reflects the actual rule shape.
  const effective: TargetSelector =
    target ??
    (legacyCell
      ? {
          type: 'cell',
          gridId: legacyCell.gridId,
          row: legacyCell.row,
          col: legacyCell.col,
          level: legacyCell.level,
        }
      : legacyShapeId !== undefined && scope !== 'any' && scope !== 'grid-cell'
      ? { type: 'shape', kind: scope, id: legacyShapeId }
      : { type: 'all' })

  const allLabel = scope === 'any'
    ? t('styleRuleEditor.target.allShapes')
    : t('styleRuleEditor.target.allOfScope', { scope: t(`styleRuleEditor.scope.${scopeKey(scope)}`) })

  return (
    <div className="space-y-1 rounded-md border border-dashed bg-muted/20 p-2">
      <div className="flex items-center gap-1.5">
        <Target className="w-3 h-3 text-muted-foreground" />
        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('styleRuleEditor.form.target')}
        </Label>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        <select
          value={effective.type}
          onChange={(e) => {
            const next = e.target.value as TargetSelector['type']
            if (next === 'all') onChange({ type: 'all' })
            else if (next === 'shape') {
              if (scope === 'any' || scope === 'grid-cell') return
              const first = shapes[0]
              if (first?.id !== undefined)
                onChange({ type: 'shape', kind: scope as Exclude<typeof scope, 'any' | 'grid-cell'>, id: first.id })
            } else if (next === 'cell') {
              const firstGrid = grids[0]
              if (firstGrid?.id !== undefined)
                onChange({ type: 'cell', gridId: firstGrid.id, row: 0, col: 0, level: 0 })
            } else if (next === 'inWarehouse') {
              if (scope === 'any' || scope === 'grid-cell') return
              const firstZone = zones[0]
              if (firstZone?.id !== undefined)
                onChange({
                  type: 'inWarehouse',
                  kind: scope as Exclude<typeof scope, 'any' | 'grid-cell'>,
                  zoneId: firstZone.id,
                })
            }
          }}
          className="h-7 text-xs rounded border border-input bg-background px-1.5"
        >
          <option value="all">{allLabel}</option>
          {scope !== 'any' && scope !== 'grid-cell' && (
            <option value="shape">{t('styleRuleEditor.target.specificShape')}</option>
          )}
          {(scope === 'grid-cell' || scope === 'any') && (
            <option value="cell">{t('styleRuleEditor.target.specificCell')}</option>
          )}
          {scope !== 'any' && scope !== 'grid-cell' && (
            <option value="inWarehouse">{t('styleRuleEditor.target.allInFacility')}</option>
          )}
        </select>
        {effective.type === 'shape' && (
          <select
            value={effective.id ?? ''}
            onChange={(e) =>
              onChange({
                type: 'shape',
                kind: effective.kind,
                id: Number(e.target.value),
              })
            }
            className="h-7 text-xs rounded border border-input bg-background px-1.5 flex-1 min-w-0 font-mono"
          >
            {shapes.length === 0 && <option value="">{t('styleRuleEditor.target.noShapesYet')}</option>}
            {shapes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name?.trim() || t('styleRuleEditor.target.shapeN', { scope: t(`styleRuleEditor.scope.${scopeKey(scope)}`), id: s.id })}
              </option>
            ))}
          </select>
        )}
        {effective.type === 'cell' && (
          <CellCoords
            value={effective}
            grids={grids}
            t={t}
            onChange={(v) => onChange(v)}
          />
        )}
        {effective.type === 'inWarehouse' && (
          <select
            value={effective.zoneId}
            onChange={(e) =>
              onChange({ ...effective, zoneId: Number(e.target.value) })
            }
            className="h-7 text-xs rounded border border-input bg-background px-1.5 flex-1 min-w-0"
          >
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name?.trim() || t('styleRuleEditor.target.facilityN', { id: z.id })}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------- SourcePicker
/**
 * "Where do conditions read their values from?" — `self`, one specific
 * shape (or cell), every cell of a rack, or every shape of a kind.
 * The first two resolve to a single bin (conditions evaluate the
 * legacy way). The last two resolve to MANY bins, which is what makes
 * quantified ("every cell is full") and aggregate ("count > 10")
 * conditions meaningful.
 */
function SourcePicker({
  source,
  legacySourceShape,
  t,
  onChange,
}: {
  source?: SourceSelector
  legacySourceShape?: ShapeLink
  t: TFunc
  onChange: (next: SourceSelector | undefined) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const { data: grids = [] } = useSpatialGrids()

  const effective: SourceSelector =
    source ??
    (legacySourceShape
      ? { type: 'single', shape: legacySourceShape }
      : { type: 'self' })

  return (
    <div className="space-y-1 rounded-md border border-dashed bg-muted/20 p-2">
      <div className="flex items-center gap-1.5">
        <Link2 className="w-3 h-3 text-muted-foreground" />
        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('styleRuleEditor.form.dataSource')}
        </Label>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        <select
          value={effective.type}
          onChange={(e) => {
            const next = e.target.value as SourceSelector['type']
            if (next === 'self') onChange({ type: 'self' })
            else if (next === 'single') setPickerOpen(true)
            else if (next === 'allCellsOf') {
              const g = grids[0]
              if (g?.id !== undefined) onChange({ type: 'allCellsOf', gridId: g.id })
            } else if (next === 'allOfKind') {
              onChange({ type: 'allOfKind', kind: 'polygon' })
            }
          }}
          className="h-7 text-xs rounded border border-input bg-background px-1.5"
        >
          <option value="self">{t('styleRuleEditor.source.self')}</option>
          <option value="single">{t('styleRuleEditor.source.single')}</option>
          <option value="allCellsOf">{t('styleRuleEditor.source.allCellsOf')}</option>
          <option value="allOfKind">{t('styleRuleEditor.source.allOfKind')}</option>
        </select>

        {effective.type === 'single' && (
          <>
            <span className="flex-1 px-2 py-1 text-[11px] font-mono rounded bg-background border truncate">
              {linkId(effective.shape)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setPickerOpen(true)}
            >
              {t('styleRuleEditor.button.change')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10"
              onClick={() => onChange({ type: 'self' })}
              title={t('styleRuleEditor.source.useTargetOwnData')}
              aria-label={t('styleRuleEditor.source.useTargetOwnData')}
            >
              <Unlink className="w-3 h-3" />
            </Button>
          </>
        )}

        {effective.type === 'allCellsOf' && (
          <select
            value={effective.gridId}
            onChange={(e) => onChange({ type: 'allCellsOf', gridId: Number(e.target.value) })}
            className="h-7 text-xs rounded border border-input bg-background px-1.5 flex-1 min-w-0"
          >
            {grids.length === 0 && <option value="">{t('styleRuleEditor.source.noRacksYet')}</option>}
            {grids.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name?.trim() || t('styleRuleEditor.source.rackN', { id: g.id })}
              </option>
            ))}
          </select>
        )}

        {effective.type === 'allOfKind' && (
          <select
            value={effective.kind}
            onChange={(e) => onChange({ type: 'allOfKind', kind: e.target.value as BindingKind })}
            className="h-7 text-xs rounded border border-input bg-background px-1.5 flex-1 min-w-0"
          >
            <option value="grid-cell">{t('styleRuleEditor.source.allRackCells')}</option>
            <option value="polygon">{t('styleRuleEditor.source.allPolygons')}</option>
            <option value="circle">{t('styleRuleEditor.source.allCircles')}</option>
            <option value="line">{t('styleRuleEditor.source.allLines')}</option>
            <option value="marker">{t('styleRuleEditor.source.allMarkers')}</option>
            <option value="image">{t('styleRuleEditor.source.allImages')}</option>
            <option value="model">{t('styleRuleEditor.source.all3dModels')}</option>
          </select>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">
        {effective.type === 'self' && t('styleRuleEditor.description.sourceSelf')}
        {effective.type === 'single' && t('styleRuleEditor.description.sourceSingle')}
        {effective.type === 'allCellsOf' && t('styleRuleEditor.description.sourceAllCellsOf')}
        {effective.type === 'allOfKind' && t('styleRuleEditor.description.sourceAllOfKind')}
      </p>
      <ShapeLinkPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        current={effective.type === 'single' ? effective.shape : undefined}
        onSelect={(next) => {
          if (next) onChange({ type: 'single', shape: next })
          else onChange({ type: 'self' })
        }}
        viewerLabel={t('styleRuleEditor.source.viewerLabel')}
      />
    </div>
  )
}

// ---------------------------------------------------------- CellCoords
function CellCoords({
  value,
  grids,
  t,
  onChange,
}: {
  value: Extract<TargetSelector, { type: 'cell' }>
  grids: ReadonlyArray<{ id?: number; name?: string }>
  t: TFunc
  onChange: (next: Extract<TargetSelector, { type: 'cell' }>) => void
}) {
  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      <select
        value={value.gridId}
        onChange={(e) => onChange({ ...value, gridId: Number(e.target.value) })}
        className="h-7 text-xs rounded border border-input bg-background px-1.5 min-w-0 flex-1"
      >
        {grids.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name?.trim() || t('styleRuleEditor.source.rackN', { id: g.id })}
          </option>
        ))}
      </select>
      <Input
        type="number"
        value={value.row}
        onChange={(e) => onChange({ ...value, row: Number(e.target.value) })}
        className="h-7 w-12 text-xs font-mono"
        title={t('styleRuleEditor.cell.row')}
        aria-label={t('styleRuleEditor.cell.row')}
        min={0}
      />
      <Input
        type="number"
        value={value.col}
        onChange={(e) => onChange({ ...value, col: Number(e.target.value) })}
        className="h-7 w-12 text-xs font-mono"
        title={t('styleRuleEditor.cell.col')}
        aria-label={t('styleRuleEditor.cell.col')}
        min={0}
      />
      <Input
        type="number"
        value={value.level ?? 0}
        onChange={(e) => onChange({ ...value, level: Number(e.target.value) })}
        className="h-7 w-12 text-xs font-mono"
        title={t('styleRuleEditor.cell.level')}
        aria-label={t('styleRuleEditor.cell.level')}
        min={0}
      />
    </div>
  )
}

// ---------------------------------------------------------- AttrConditionRow
/**
 * One standard attribute condition. When the rule's source resolves
 * to many bins, exposes a quantifier dropdown (`every`/`some`/`none`)
 * so the user can express "every cell of rack #2 has status=full".
 */
function AttrConditionRow({
  cond,
  attrOptions,
  showQuantifier,
  optionFor,
  t,
  onChange,
  onRemove,
}: {
  cond: AttrCondition
  attrOptions: AttrOption[]
  showQuantifier: boolean
  optionFor: (attr: string) => AttrOption | undefined
  t: TFunc
  onChange: (next: AttrCondition) => void
  onRemove: () => void
}) {
  const opt = optionFor(cond.attribute)
  const allowedOps = opt
    ? new Set(operatorsForWidget(getAttributeType(opt.typeId).widget))
    : null
  const filteredOps = allowedOps ? OPS.filter((o) => allowedOps.has(o.id)) : OPS
  const opDef = OPS.find((o) => o.id === cond.op)
  const widget = opt ? getAttributeType(opt.typeId).widget : 'text'
  const q: RuleQuantifier = cond.quantifier ?? 'single'
  return (
    <div className="flex items-center gap-1">
      {showQuantifier && (
        <select
          value={q}
          onChange={(e) =>
            onChange({ ...cond, quantifier: e.target.value as RuleQuantifier })
          }
          className="h-7 text-xs rounded border border-input bg-background px-1 flex-shrink-0"
          title={t('styleRuleEditor.form.quantifier')}
          aria-label={t('styleRuleEditor.form.quantifier')}
        >
          {(['every', 'some', 'none'] as RuleQuantifier[]).map((id) => (
            <option key={id} value={id}>{t(`styleRuleEditor.quantifier.${id}`)}</option>
          ))}
        </select>
      )}
      <select
        value={cond.attribute}
        onChange={(e) => onChange({ ...cond, attribute: e.target.value })}
        className="h-7 text-xs font-mono rounded border border-input bg-background px-1 flex-1 min-w-0"
      >
        {opt === undefined && cond.attribute && (
          <option value={cond.attribute}>{cond.attribute} {t('styleRuleEditor.customAttrSuffix')}</option>
        )}
        <optgroup label={t('styleRuleEditor.optgroup.builtin')}>
          {attrOptions.filter((o) => o.origin === 'builtin' || (!o.custom && o.origin === undefined)).map((o) => (
            <option key={o.path} value={o.path}>{o.label}</option>
          ))}
        </optgroup>
        {attrOptions.some((o) => o.origin === 'schema' || (o.custom && o.origin === undefined)) && (
          <optgroup label={t('styleRuleEditor.optgroup.schema')}>
            {attrOptions.filter((o) => o.origin === 'schema' || (o.custom && o.origin === undefined)).map((o) => (
              <option key={o.path} value={o.path}>{o.label}</option>
            ))}
          </optgroup>
        )}
        {attrOptions.some((o) => o.origin === 'data-link') && (
          <optgroup label={t('styleRuleEditor.optgroup.dataLink')}>
            {attrOptions.filter((o) => o.origin === 'data-link').map((o) => (
              <option key={o.path} value={o.path}>{o.label}</option>
            ))}
          </optgroup>
        )}
      </select>
      <select
        value={cond.op}
        onChange={(e) => onChange({ ...cond, op: e.target.value as RuleOp })}
        className="h-7 text-xs rounded border border-input bg-background px-1 flex-shrink-0"
      >
        {filteredOps.map((o) => (
          <option key={o.id} value={o.id}>{opLabel(o, t)}</option>
        ))}
      </select>
      {opDef?.needsValue && (
        <ValueInput
          cond={cond}
          widget={widget}
          enumValues={opt?.enumValues}
          t={t}
          onChange={(v) => onChange({ ...cond, value: v as AttrCondition['value'] })}
        />
      )}
      <button
        type="button"
        onClick={onRemove}
        className="flex items-center justify-center w-6 h-6 rounded hover:bg-destructive/10 hover:text-destructive transition-colors flex-shrink-0"
        aria-label={t('styleRuleEditor.button.removeCondition')}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------- AggregateConditionRow
/**
 * Aggregate condition over many source bins.
 *   `count   op value`       — number of bins in source
 *   `sum/avg/min/max attr op value` — numeric reduce over attr
 *
 * Only shown when the rule's source resolves to many bins.
 */
function AggregateConditionRow({
  cond,
  attrOptions,
  t,
  onChange,
  onRemove,
}: {
  cond: AggregateCondition
  attrOptions: AttrOption[]
  t: TFunc
  onChange: (next: AggregateCondition) => void
  onRemove: () => void
}) {
  const needsAttribute = cond.fn !== 'count' && cond.fn !== 'countWhere'
  return (
    <div className="space-y-1 rounded border border-dashed border-amber-500/40 bg-amber-50/30 dark:bg-amber-950/10 p-1.5">
      <div className="flex items-center gap-1">
        <Sigma className="w-3 h-3 text-amber-600 flex-shrink-0" />
        <select
          value={cond.fn}
          onChange={(e) => onChange({ ...cond, fn: e.target.value as AggregateFn })}
          className="h-7 text-xs rounded border border-input bg-background px-1.5 flex-shrink-0"
        >
          {(['count', 'countWhere', 'sum', 'avg', 'min', 'max'] as AggregateFn[]).map((id) => (
            <option key={id} value={id}>{t(`styleRuleEditor.aggregate.${id}`)}</option>
          ))}
        </select>
        {needsAttribute && (
          <select
            value={cond.attribute ?? ''}
            onChange={(e) => onChange({ ...cond, attribute: e.target.value })}
            className="h-7 text-xs font-mono rounded border border-input bg-background px-1 flex-1 min-w-0"
          >
            <option value="">{t('styleRuleEditor.placeholder.pickAttribute')}</option>
            {attrOptions.map((o) => (
              <option key={o.path} value={o.path}>{o.label}</option>
            ))}
          </select>
        )}
        <select
          value={cond.op}
          onChange={(e) => onChange({ ...cond, op: e.target.value as AggregateOp })}
          className="h-7 text-xs rounded border border-input bg-background px-1 flex-shrink-0"
        >
          {AGGREGATE_OPS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <Input
          type="number"
          value={cond.value}
          onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })}
          className="h-7 w-20 text-xs font-mono"
        />
        <button
          type="button"
          onClick={onRemove}
          className="flex items-center justify-center w-6 h-6 rounded hover:bg-destructive/10 hover:text-destructive transition-colors flex-shrink-0"
          aria-label={t('styleRuleEditor.button.removeCondition')}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      {cond.fn === 'countWhere' && (
        <div className="flex items-center gap-1 ps-5">
          <span className="text-[10px] text-muted-foreground">{t('styleRuleEditor.placeholder.where')}</span>
          <select
            value={cond.whereAttribute ?? ''}
            onChange={(e) => onChange({ ...cond, whereAttribute: e.target.value })}
            className="h-7 text-xs font-mono rounded border border-input bg-background px-1 flex-1 min-w-0"
          >
            <option value="">{t('styleRuleEditor.placeholder.pickAttribute')}</option>
            {attrOptions.map((o) => (
              <option key={o.path} value={o.path}>{o.label}</option>
            ))}
          </select>
          <select
            value={cond.whereOp ?? 'equals'}
            onChange={(e) => onChange({ ...cond, whereOp: e.target.value as RuleOp })}
            className="h-7 text-xs rounded border border-input bg-background px-1 flex-shrink-0"
          >
            {OPS.filter((o) => o.needsValue).map((o) => (
              <option key={o.id} value={o.id}>{opLabel(o, t)}</option>
            ))}
          </select>
          <Input
            value={cond.whereValue === undefined || cond.whereValue === null ? '' : String(cond.whereValue)}
            onChange={(e) => onChange({ ...cond, whereValue: e.target.value })}
            placeholder={t('styleRuleEditor.placeholder.value')}
            className="h-7 w-20 text-xs font-mono"
          />
        </div>
      )}
    </div>
  )
}
