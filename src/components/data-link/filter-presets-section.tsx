/**
 * FilterPresetsSection — author-side management of a layer's saved
 * report filters.
 *
 * v5 moved filter *authoring* out of the viewer. The person who builds
 * the data link decides which slices of the data are meaningful ("Active
 * pallets", "Overdue > 7 days") and publishes them as named presets; the
 * viewer picks one from a chip bar and can't invent its own. That keeps
 * shared links reproducible — a link says "preset X", and preset X means
 * the same thing for everyone who opens it.
 *
 * Presets live in `fieldMapping.filters` (opaque JSONB), so this needed
 * no migration and no backend change.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Copy,
  Filter as FilterIcon,
  Loader2,
  Pencil,
  Plus,
  Star,
  Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useApiQuery } from '@/lib/useApiQuery'
import {
  fetchDataSourceSchema,
  queryDataSource,
  type DataSourceSchema,
} from '@/lib/data-link/query-client'
import type { DataLinkFilterGroup, DataLinkFilterPreset } from '@/lib/db'
import {
  FilterTreeBuilder,
  SchemaStatus,
  allLeavesAuthorable,
  collectPromptLeaves,
  countLeaves,
  deepCloneGroup,
  describeFilter,
  emptyGroup,
  normaliseTree,
  stripPromptLeaves,
} from './filter-tree-builder'

export interface FilterPresetsSectionProps {
  /** Null for legacy stream-backed layers — presets are unavailable there. */
  sourceId: number | null
  value: DataLinkFilterPreset[]
  onChange: (next: DataLinkFilterPreset[]) => void
}

export function FilterPresetsSection({
  sourceId,
  value,
  onChange,
}: FilterPresetsSectionProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<DataLinkFilterPreset | null>(null)
  const [isNew, setIsNew] = useState(false)

  const schemaQuery = useApiQuery<DataSourceSchema | null>(
    async () => {
      if (!sourceId) return null
      return await fetchDataSourceSchema(sourceId)
    },
    ['data-source-schema', sourceId ?? 0],
    { intervalMs: 0, enabled: sourceId !== null },
  )
  const schema = schemaQuery.data ?? null

  // Match count per preset, so the author sees at a glance that a rule
  // isn't accidentally empty before publishing it. Keyed by source *and*
  // preset id so a source swap can't briefly show the old table's counts.
  const [counts, setCounts] = useState<Record<string, number | null>>({})
  useEffect(() => {
    if (!sourceId || value.length === 0) return
    let cancelled = false
    void (async () => {
      const next: Record<string, number | null> = {}
      for (const preset of value) {
        // Prompts get filled at runtime, so a count computed now would
        // be misleading — skip the fetch and let the row omit the pill.
        if (collectPromptLeaves(preset.filter).length > 0) continue
        try {
          const res = await queryDataSource(sourceId, {
            filter: preset.filter,
            limit: 1,
            includeCount: true,
          })
          next[`${sourceId}:${preset.id}`] = res.totalCount ?? 0
        } catch {
          next[`${sourceId}:${preset.id}`] = null
        }
      }
      if (!cancelled) setCounts(next)
    })()
    return () => {
      cancelled = true
    }
  }, [sourceId, value])

  const startNew = useCallback(() => {
    setIsNew(true)
    setEditing({
      id: newPresetId(),
      label: '',
      filter: emptyGroup(),
      isDefault: value.length === 0,
    })
  }, [value.length])

  const startEdit = useCallback((preset: DataLinkFilterPreset) => {
    setIsNew(false)
    setEditing({ ...preset, filter: deepCloneGroup(normaliseTree(preset.filter)) })
  }, [])

  const duplicate = useCallback(
    (preset: DataLinkFilterPreset) => {
      onChange([
        ...value,
        {
          ...preset,
          id: newPresetId(),
          label: t('dataLink.filterPresetCopyLabel', {
            defaultValue: '{{label}} (copy)',
            label: preset.label,
          }),
          isDefault: false,
          filter: deepCloneGroup(normaliseTree(preset.filter)),
        },
      ])
    },
    [value, onChange, t],
  )

  const remove = useCallback(
    (id: string) => {
      onChange(value.filter((p) => p.id !== id))
    },
    [value, onChange],
  )

  const setDefault = useCallback(
    (id: string) => {
      onChange(
        value.map((p) => ({ ...p, isDefault: p.id === id ? !p.isDefault : false })),
      )
    },
    [value, onChange],
  )

  const commit = useCallback(
    (preset: DataLinkFilterPreset) => {
      const exists = value.some((p) => p.id === preset.id)
      // A newly-flagged default demotes every sibling — the viewer reads
      // at most one.
      const applied = exists
        ? value.map((p) => (p.id === preset.id ? preset : p))
        : [...value, preset]
      onChange(
        preset.isDefault
          ? applied.map((p) => (p.id === preset.id ? p : { ...p, isDefault: false }))
          : applied,
      )
      setEditing(null)
    },
    [value, onChange],
  )

  if (sourceId === null) {
    return (
      <p className="text-[11px] text-muted-foreground border border-dashed rounded-md p-3">
        {t('dataLink.filterPresetsNeedSource', {
          defaultValue:
            'Saved filters need a data source. Pick one above — legacy stream-backed layers can’t be filtered server-side.',
        })}
      </p>
    )
  }

  return (
    <div className="grid gap-3">
      <SchemaStatus
        loading={schemaQuery.isLoading}
        error={schemaQuery.error?.message ?? null}
        schema={schema}
      />

      {value.length === 0 ? (
        <div className="border border-dashed rounded-md px-4 py-6 text-center grid gap-2 justify-items-center">
          <FilterIcon size={18} className="text-muted-foreground" />
          <p className="text-sm font-medium">
            {t('dataLink.filterPresetsEmptyTitle', {
              defaultValue: 'No saved filters yet',
            })}
          </p>
          <p className="text-[11px] text-muted-foreground max-w-md">
            {t('dataLink.filterPresetsEmptyHint', {
              defaultValue:
                'Saved filters appear as one-click chips for anyone viewing this layer. Without them the layer always shows every record.',
            })}
          </p>
        </div>
      ) : (
        <div className="grid gap-2">
          {value.map((preset) => {
            const summary = describeFilter(preset.filter)
            const count = counts[`${sourceId}:${preset.id}`]
            const prompts = collectPromptLeaves(preset.filter).length
            return (
              <div
                key={preset.id}
                className="rounded-md border border-border bg-background px-3 py-2.5 flex items-start gap-3"
              >
                <div className="min-w-0 flex-1 grid gap-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">
                      {preset.label ||
                        t('dataLink.filterPresetUntitled', {
                          defaultValue: 'Untitled filter',
                        })}
                    </span>
                    {preset.isDefault && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                        {t('dataLink.filterPresetDefaultBadge', {
                          defaultValue: 'Default',
                        })}
                      </span>
                    )}
                    {prompts > 0 && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 font-medium"
                        title={t('dataLink.filterPresetRuntimePromptTitle', {
                          defaultValue:
                            'Viewers will be asked to fill in these values before the filter applies.',
                        })}
                      >
                        {t('dataLink.filterPresetRuntimePromptBadge', {
                          defaultValue: '{{n}} asked at runtime',
                          n: prompts,
                        })}
                      </span>
                    )}
                    {count !== undefined && prompts === 0 && (
                      <span
                        className={
                          'text-[10px] tabular-nums ' +
                          (count === 0
                            ? 'text-amber-600 dark:text-amber-400 font-medium'
                            : 'text-muted-foreground')
                        }
                      >
                        {count === null
                          ? t('dataLink.filterPresetCountUnknown', {
                              defaultValue: 'count unavailable',
                            })
                          : t('dataLink.filterPresetCount', {
                              defaultValue: '{{n}} records',
                              n: count.toLocaleString(),
                            })}
                      </span>
                    )}
                  </div>
                  {preset.description && (
                    <p className="text-[11px] text-muted-foreground truncate">
                      {preset.description}
                    </p>
                  )}
                  <p className="text-[11px] font-mono text-muted-foreground truncate">
                    {summary ||
                      t('dataLink.filterPresetNoRules', {
                        defaultValue: 'no conditions — matches everything',
                      })}
                  </p>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={
                      'h-7 w-7 p-0 ' +
                      (preset.isDefault ? 'text-primary' : 'text-muted-foreground')
                    }
                    onClick={() => setDefault(preset.id)}
                    title={t('dataLink.filterPresetMakeDefault', {
                      defaultValue: 'Apply this filter by default in the viewer',
                    })}
                  >
                    <Star
                      size={13}
                      fill={preset.isDefault ? 'currentColor' : 'none'}
                    />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => startEdit(preset)}
                    title={t('dataLink.filterPresetEdit', { defaultValue: 'Edit' })}
                  >
                    <Pencil size={13} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => duplicate(preset)}
                    title={t('dataLink.filterPresetDuplicate', {
                      defaultValue: 'Duplicate',
                    })}
                  >
                    <Copy size={13} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    onClick={() => remove(preset.id)}
                    title={t('dataLink.filterPresetDelete', {
                      defaultValue: 'Delete',
                    })}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div>
        <Button type="button" variant="outline" size="sm" onClick={startNew}>
          <Plus size={13} className="me-1.5" />
          {t('dataLink.filterPresetAdd', { defaultValue: 'Add saved filter' })}
        </Button>
      </div>

      <PresetDialog
        preset={editing}
        isNew={isNew}
        sourceId={sourceId}
        schema={schema}
        onCancel={() => setEditing(null)}
        onSave={commit}
      />
    </div>
  )
}

// ================================================================
// Preset editor dialog
// ================================================================

function PresetDialog({
  preset,
  isNew,
  sourceId,
  schema,
  onCancel,
  onSave,
}: {
  preset: DataLinkFilterPreset | null
  isNew: boolean
  sourceId: number
  schema: DataSourceSchema | null
  onCancel: () => void
  onSave: (preset: DataLinkFilterPreset) => void
}) {
  return (
    <Dialog open={preset !== null} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="w-[92vw] max-w-3xl max-h-[92dvh] p-0 gap-0 overflow-hidden flex flex-col" aria-describedby={undefined}>
        {preset && (
          <PresetForm
            key={preset.id}
            preset={preset}
            isNew={isNew}
            sourceId={sourceId}
            schema={schema}
            onCancel={onCancel}
            onSave={onSave}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Mounted only while a preset is open, and keyed by preset id, so the draft
 * state can be seeded straight from props — no hydrating effect to keep in
 * step with the dialog's open/close cycle.
 */
function PresetForm({
  preset,
  isNew,
  sourceId,
  schema,
  onCancel,
  onSave,
}: {
  preset: DataLinkFilterPreset
  isNew: boolean
  sourceId: number
  schema: DataSourceSchema | null
  onCancel: () => void
  onSave: (preset: DataLinkFilterPreset) => void
}) {
  const { t } = useTranslation()

  const [label, setLabel] = useState(preset.label)
  const [description, setDescription] = useState(preset.description ?? '')
  const [isDefault, setIsDefault] = useState(preset.isDefault ?? false)
  const [tree, setTree] = useState<DataLinkFilterGroup>(() =>
    normaliseTree(preset.filter),
  )

  // Debounced server-authoritative preview so the author knows the rule
  // returns something before publishing it.
  const [previewCount, setPreviewCount] = useState<{
    matched: number
    total: number
  } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  useEffect(() => {
    const handle = setTimeout(async () => {
      setPreviewing(true)
      try {
        // Prompts are blank slots the viewer fills at runtime, so the
        // preview counts against just the fully-authored leaves.
        const complete = stripPromptLeaves(tree)
        const res = await queryDataSource(sourceId, {
          filter: complete.conditions.length > 0 ? complete : null,
          limit: 1,
          includeCount: true,
        })
        setPreviewCount({
          matched: res.totalCount ?? 0,
          total: schema?.rowCount ?? 0,
        })
      } catch {
        setPreviewCount(null)
      } finally {
        setPreviewing(false)
      }
    }, 250)
    return () => clearTimeout(handle)
  }, [sourceId, tree, schema?.rowCount])

  const leafCount = useMemo(() => countLeaves(tree), [tree])
  const promptCount = useMemo(() => collectPromptLeaves(tree).length, [tree])
  // Values may be blank — the viewer types them in when they pick the
  // chip. We only insist on field + op so the runtime prompt knows what
  // to ask about.
  const canSave =
    label.trim().length > 0 && leafCount > 0 && allLeavesAuthorable(tree)

  const handleSave = () => {
    if (!canSave) return
    onSave({
      id: preset.id,
      label: label.trim(),
      description: description.trim() || undefined,
      filter: tree,
      isDefault: isDefault || undefined,
    })
  }

  return (
    <>
      <div className="border-b px-5 py-4 shrink-0">
        <DialogTitle className="text-base font-semibold flex items-center gap-2">
          <FilterIcon size={16} className="text-primary" />
          {isNew
            ? t('dataLink.filterPresetNewTitle', {
                defaultValue: 'New saved filter',
              })
            : t('dataLink.filterPresetEditTitle', {
                defaultValue: 'Edit saved filter',
              })}
        </DialogTitle>
        <p className="text-xs text-muted-foreground mt-1">
          {t('dataLink.filterPresetDialogHint', {
            defaultValue:
              'Name the slice of data this filter represents. Viewers pick it by name — they never see the underlying conditions as editable controls.',
          })}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="dl-preset-label" className="text-xs">
              {t('dataLink.filterPresetLabel', { defaultValue: 'Filter name' })}
            </Label>
            <Input
              id="dl-preset-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('dataLink.filterPresetLabelPlaceholder', {
                defaultValue: 'e.g. Active pallets',
              })}
              className="h-8 text-sm"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="dl-preset-desc" className="text-xs">
              {t('dataLink.filterPresetDescription', {
                defaultValue: 'Description (optional)',
              })}
            </Label>
            <Input
              id="dl-preset-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('dataLink.filterPresetDescriptionPlaceholder', {
                defaultValue: 'Shown as a tooltip in the viewer',
              })}
              className="h-8 text-sm"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          {t('dataLink.filterPresetDefaultToggle', {
            defaultValue: 'Apply this filter by default when the layer loads',
          })}
        </label>

        <div className="grid gap-2">
          <Label className="text-xs">
            {t('dataLink.filterPresetConditions', { defaultValue: 'Conditions' })}
          </Label>
          <FilterTreeBuilder value={tree} schema={schema} onChange={setTree} />
        </div>
      </div>

      <div className="border-t bg-background shrink-0">
        <div className="px-5 py-3 flex items-center gap-2 flex-wrap text-xs">
          {previewing && (
            <Loader2 size={12} className="animate-spin text-muted-foreground" />
          )}
          {previewCount ? (
            <span
              className={
                previewCount.matched === 0 &&
                leafCount > 0 &&
                promptCount === 0
                  ? 'text-amber-600 dark:text-amber-400 font-medium'
                  : 'text-foreground'
              }
            >
              {promptCount > 0 && promptCount < leafCount
                ? t('dataLink.filterPresetMatchCountPartial', {
                    defaultValue:
                      '~{{matched}} of {{total}} match so far (plus runtime prompts)',
                    matched: previewCount.matched.toLocaleString(),
                    total: previewCount.total.toLocaleString(),
                  })
                : promptCount > 0
                ? t('dataLink.filterPresetPromptsOnly', {
                    defaultValue:
                      'Match count depends on runtime values ({{total}} records total)',
                    total: previewCount.total.toLocaleString(),
                  })
                : t('dataLink.filterPresetMatchCount', {
                    defaultValue: '{{matched}} of {{total}} records match',
                    matched: previewCount.matched.toLocaleString(),
                    total: previewCount.total.toLocaleString(),
                  })}
            </span>
          ) : leafCount > 0 ? (
            <span className="text-muted-foreground">
              {t('dataLink.filterPresetCalculating', {
                defaultValue: 'Calculating…',
              })}
            </span>
          ) : (
            <span className="text-muted-foreground">
              {t('dataLink.filterPresetNeedCondition', {
                defaultValue: 'Add at least one condition to save this filter.',
              })}
            </span>
          )}
          {promptCount > 0 && (
            <span className="ms-auto text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
              {t('dataLink.filterPresetRuntimePromptBadge', {
                defaultValue: '{{n}} asked at runtime',
                n: promptCount,
              })}
            </span>
          )}
        </div>
        <div className="border-t px-5 py-3 flex items-center justify-end gap-2 bg-background flex-shrink-0">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t('dataLink.filterPresetCancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={!canSave}
          >
            {t('dataLink.filterPresetSave', { defaultValue: 'Save filter' })}
          </Button>
        </div>
      </div>
    </>
  )
}

function newPresetId(): string {
  return `flt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
