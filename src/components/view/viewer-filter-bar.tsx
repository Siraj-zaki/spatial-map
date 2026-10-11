/**
 * ViewerFilterBar — the read-only side of saved report filters.
 *
 * v5 split filter authoring from filter *use*: the layer's author
 * publishes named presets in the data-link editor; here the viewer just
 * picks one per layer, the way a report tool exposes saved views. There
 * is deliberately no escape hatch to build an ad-hoc condition — a
 * shared link that says "Overdue" has to mean the same thing for
 * everyone who opens it.
 *
 * v5.2 — the picker moved out of a dropdown menu into a proper dialog
 * with a draft/Apply/Clear/Cancel model, because a real report has more
 * than three filters and needs the room. Nothing takes effect on the
 * map until Apply; Cancel throws away the draft; Clear all resets every
 * layer to "All records" and drops any runtime-prompt values. The
 * trigger button still renders nothing when no visible layer has
 * presets, so viewers of an unfiltered map never see a dead control.
 */

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Filter as FilterIcon, RotateCcw, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  OP_LABEL,
  collectPromptLeaves,
} from '@/components/data-link/filter-tree-builder'
import type {
  DataLinkConfig,
  DataLinkFilterCondition,
  DataLinkFilterPreset,
} from '@/lib/db'

export interface ViewerFilterBarProps {
  configs: ReadonlyArray<DataLinkConfig>
  /**
   * Currently-applied selection per config id — `''` means "all records".
   * Every filterable config is present so the chips always reflect
   * exactly what the map is showing.
   */
  activePresetIds: Readonly<Record<number, string>>
  /**
   * Currently-applied runtime prompt values, keyed [configId][presetId] =
   * positional array (see `collectPromptLeaves`).
   */
  promptValues: Readonly<
    Record<number, Record<string, ReadonlyArray<DataLinkFilterCondition['value']>>>
  >
  /**
   * Commit a whole draft at once. The dialog holds a local draft until
   * the user hits Apply, so the map never renders half-set filters.
   */
  onApply: (
    presetIds: Record<number, string>,
    promptValues: Record<
      number,
      Record<string, Array<DataLinkFilterCondition['value']>>
    >,
  ) => void
}

export function ViewerFilterBar({
  configs,
  activePresetIds,
  promptValues,
  onApply,
}: ViewerFilterBarProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const filterable = useMemo(
    () =>
      configs.filter(
        (c) => c.id !== undefined && (c.fieldMapping?.filters?.length ?? 0) > 0,
      ),
    [configs],
  )

  // How many filterable layers are currently NOT on "All records" — drives
  // the count badge on the trigger button. Uses the applied state, never
  // the draft, so closing the dialog without applying doesn't lie.
  const activeCount = filterable.filter(
    (c) => (activePresetIds[c.id!] ?? '') !== '',
  ).length

  if (filterable.length === 0) return null

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-9 gap-2 rounded-full border-border/60 bg-background/70 pl-3 pr-3 shadow-lg shadow-black/5 backdrop-blur-xl hover:bg-background/90"
      >
        <FilterIcon
          className={
            'h-3.5 w-3.5 ' +
            (activeCount > 0 ? 'text-primary' : 'text-muted-foreground')
          }
        />
        <span className="text-xs font-medium">
          {t('view.filters', { defaultValue: 'Filters' })}
          {activeCount > 0 && (
            <span className="ms-1 text-primary">({activeCount})</span>
          )}
        </span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[92vw] max-w-md max-h-[85dvh] p-0 gap-0 overflow-hidden flex flex-col" aria-describedby={undefined}>
          {open && (
            <FilterDialogBody
              configs={filterable}
              appliedPresetIds={activePresetIds}
              appliedPromptValues={promptValues}
              onApply={(ids, vals) => {
                onApply(ids, vals)
                setOpen(false)
              }}
              onCancel={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Mounted only while the dialog is open, so the draft state is naturally
 * fresh on every open — no hydrating effect to keep in sync with the
 * dialog's open/close cycle.
 */
function FilterDialogBody({
  configs,
  appliedPresetIds,
  appliedPromptValues,
  onApply,
  onCancel,
}: {
  configs: ReadonlyArray<DataLinkConfig>
  appliedPresetIds: Readonly<Record<number, string>>
  appliedPromptValues: Readonly<
    Record<number, Record<string, ReadonlyArray<DataLinkFilterCondition['value']>>>
  >
  onApply: (
    presetIds: Record<number, string>,
    promptValues: Record<
      number,
      Record<string, Array<DataLinkFilterCondition['value']>>
    >,
  ) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()

  const [draftIds, setDraftIds] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      configs.map((c) => [c.id!, appliedPresetIds[c.id!] ?? '']),
    ),
  )
  const [draftValues, setDraftValues] = useState<
    Record<number, Record<string, Array<DataLinkFilterCondition['value']>>>
  >(() =>
    Object.fromEntries(
      Object.entries(appliedPromptValues).map(([cfg, byPreset]) => [
        Number(cfg),
        Object.fromEntries(
          Object.entries(byPreset).map(([pid, arr]) => [pid, [...arr]]),
        ),
      ]),
    ),
  )

  const selectPreset = useCallback((configId: number, presetId: string) => {
    setDraftIds((prev) => ({ ...prev, [configId]: presetId }))
  }, [])

  const setPromptValue = useCallback(
    (
      configId: number,
      presetId: string,
      index: number,
      value: DataLinkFilterCondition['value'],
    ) => {
      setDraftValues((prev) => {
        const perConfig = { ...(prev[configId] ?? {}) }
        const arr = [...(perConfig[presetId] ?? [])]
        arr[index] = value
        perConfig[presetId] = arr
        return { ...prev, [configId]: perConfig }
      })
    },
    [],
  )

  const clearLayer = useCallback((configId: number) => {
    setDraftIds((prev) => ({ ...prev, [configId]: '' }))
    setDraftValues((prev) => {
      if (!prev[configId]) return prev
      const next = { ...prev }
      delete next[configId]
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    setDraftIds(Object.fromEntries(configs.map((c) => [c.id!, ''])))
    setDraftValues({})
  }, [configs])

  const activeCount = configs.filter(
    (c) => (draftIds[c.id!] ?? '') !== '',
  ).length

  // Dirty check drives the Apply button's disabled state so a viewer who
  // opens the dialog "to see what's there" and closes with Apply doesn't
  // trigger a needless re-render on the overlay.
  const isDirty = useMemo(() => {
    for (const c of configs) {
      const id = c.id!
      if ((draftIds[id] ?? '') !== (appliedPresetIds[id] ?? '')) return true
    }
    // Prompt-value comparison — shallow enough because the arrays are
    // small (one entry per prompt leaf) and values are primitives or
    // primitive tuples.
    const stringify = (
      v: Record<number, Record<string, ReadonlyArray<unknown>>>,
    ) => JSON.stringify(v)
    return stringify(draftValues) !== stringify(appliedPromptValues)
  }, [configs, draftIds, draftValues, appliedPresetIds, appliedPromptValues])

  return (
    <>
      <div className="border-b px-4 py-3 shrink-0">
        <DialogTitle className="text-sm font-semibold flex items-center gap-2">
          <FilterIcon size={14} className="text-primary" />
          {t('view.filtersTitle', { defaultValue: 'Filters' })}
          {activeCount > 0 && (
            <span className="text-[11px] font-normal text-muted-foreground">
              · {activeCount} {t('view.filtersActiveSuffix', { defaultValue: 'active' })}
            </span>
          )}
        </DialogTitle>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-border/50">
        {configs.map((cfg) => (
          <LayerFilterSection
            key={cfg.id}
            config={cfg}
            selectedId={draftIds[cfg.id!] ?? ''}
            values={draftValues[cfg.id!] ?? {}}
            onSelect={selectPreset}
            onPromptValueChange={setPromptValue}
            onClear={clearLayer}
          />
        ))}
      </div>

      <div className="border-t bg-background shrink-0 px-4 py-2.5 flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearAll}
          disabled={activeCount === 0}
        >
          <RotateCcw className="h-3.5 w-3.5 me-1.5" />
          {t('view.filtersClearAll', { defaultValue: 'Clear all' })}
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t('view.filtersCancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onApply(draftIds, draftValues)}
            disabled={!isDirty}
          >
            {t('view.filtersApply', { defaultValue: 'Apply' })}
          </Button>
        </div>
      </div>
    </>
  )
}

/**
 * One compact row per layer, in the mould of Metabase / Superset / Grafana
 * filter bars: color dot + name on the left, dropdown taking the rest of
 * the row, tiny clear icon when a preset is picked. Runtime prompts
 * expand as a small stack below; the row collapses back to a single line
 * when the viewer returns to "All records".
 */
function LayerFilterSection({
  config,
  selectedId,
  values,
  onSelect,
  onPromptValueChange,
  onClear,
}: {
  config: DataLinkConfig
  selectedId: string
  values: Readonly<Record<string, ReadonlyArray<DataLinkFilterCondition['value']>>>
  onSelect: (configId: number, presetId: string) => void
  onPromptValueChange: (
    configId: number,
    presetId: string,
    index: number,
    value: DataLinkFilterCondition['value'],
  ) => void
  onClear: (configId: number) => void
}) {
  const { t } = useTranslation()
  const presets: DataLinkFilterPreset[] = config.fieldMapping?.filters ?? []
  const active = presets.find((p) => p.id === selectedId) ?? null
  const prompts = useMemo(
    () => (active ? collectPromptLeaves(active.filter) : []),
    [active],
  )
  const currentValues = active ? values[active.id] ?? [] : []

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="h-2 w-2 rounded-full ring-1 ring-black/10 shrink-0"
          style={{
            backgroundColor: config.style?.defaultColor ?? 'currentColor',
          }}
          aria-hidden
        />
        <span
          className="text-xs font-medium truncate shrink-0 max-w-[35%]"
          title={config.name}
        >
          {config.name || `Layer #${config.id}`}
        </span>
        <select
          value={selectedId}
          onChange={(e) => onSelect(config.id!, e.target.value)}
          aria-label={config.name}
          title={active?.description}
          className="h-7 flex-1 min-w-0 rounded-md border border-input bg-background px-2 text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">
            {t('view.filterAllRecords', { defaultValue: 'All records' })}
          </option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => onClear(config.id!)}
          disabled={selectedId === ''}
          className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-0 disabled:pointer-events-none transition-opacity"
          title={
            t('view.filtersClearLayer', {
              defaultValue: 'Clear this layer',
            }) as string
          }
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {active && prompts.length > 0 && (
        <div className="mt-2 ms-4 grid gap-1.5">
          {prompts.map((leaf, i) => (
            <PromptInput
              key={`${active.id}-${i}`}
              leaf={leaf}
              value={currentValues[i]}
              onChange={(v) => onPromptValueChange(config.id!, active.id, i, v)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Compact runtime editor for a single prompt leaf. Label sits inline
 * with the input in a two-column grid so a preset with many prompts
 * stays scannable at a glance, à la Grafana / Superset filter panels.
 */
function PromptInput({
  leaf,
  value,
  onChange,
}: {
  leaf: DataLinkFilterCondition
  value: DataLinkFilterCondition['value'] | undefined
  onChange: (v: DataLinkFilterCondition['value']) => void
}) {
  const { op } = leaf
  const type = leaf.type ?? 'unknown'
  const opSymbol = OP_LABEL[op]?.split(' ')[0] ?? op

  const label = (
    <div
      className="text-[10.5px] font-mono text-muted-foreground truncate self-center"
      title={`${leaf.field} ${OP_LABEL[op] ?? op}`}
    >
      <span className="text-foreground">{leaf.field}</span>{' '}
      <span>{opSymbol}</span>
    </div>
  )

  const wrap = (control: React.ReactNode) => (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-2">
      {label}
      {control}
    </div>
  )

  if (op === 'between') {
    const [lo, hi] = Array.isArray(value)
      ? (value as [string | number, string | number])
      : ['', '']
    const inputType =
      type === 'date' ? 'datetime-local' : type === 'number' ? 'number' : 'text'
    return wrap(
      <div className="grid grid-cols-2 gap-1">
        <Input
          type={inputType}
          value={String(lo ?? '')}
          onChange={(e) => onChange([e.target.value, String(hi ?? '')])}
          placeholder="min"
          className="h-7 text-[11px] px-2"
        />
        <Input
          type={inputType}
          value={String(hi ?? '')}
          onChange={(e) => onChange([String(lo ?? ''), e.target.value])}
          placeholder="max"
          className="h-7 text-[11px] px-2"
        />
      </div>,
    )
  }

  if (op === 'in' || op === 'notIn') {
    const arr = Array.isArray(value) ? (value as Array<string | number>) : []
    return wrap(
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
        placeholder="a, b, c"
        className="h-7 text-[11px] px-2"
      />,
    )
  }

  if (op === 'lastNDays' || op === 'nextNDays') {
    return wrap(
      <Input
        type="number"
        min={1}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(Number(e.target.value))}
        placeholder="days"
        className="h-7 text-[11px] px-2"
      />,
    )
  }

  if (op === 'before' || op === 'after' || (op === 'eq' && type === 'date')) {
    return wrap(
      <Input
        type="datetime-local"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-[11px] px-2"
      />,
    )
  }

  if (type === 'boolean' && (op === 'eq' || op === 'neq')) {
    return wrap(
      <select
        value={typeof value === 'boolean' ? String(value) : ''}
        onChange={(e) => onChange(e.target.value === 'true')}
        className="h-7 rounded-md border border-input bg-background px-2 text-[11px]"
      >
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>,
    )
  }

  if (type === 'number') {
    return wrap(
      <Input
        type="number"
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(Number(e.target.value))}
        placeholder="value"
        className="h-7 text-[11px] px-2"
      />,
    )
  }

  return wrap(
    <Input
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder="value"
      className="h-7 text-[11px] px-2"
    />,
  )
}
