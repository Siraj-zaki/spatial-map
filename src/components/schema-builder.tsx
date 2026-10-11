/**
 * Schema Builder dialog.
 *
 * Lets the user define which custom fields each shape kind exposes in
 * its data editor (and which fields style rules can match on). Rows
 * persist as `AttributeDefinition` records (scope = the picked kind, or
 * `any` for fields shared across every kind). The plumbing — Dexie
 * table, REST endpoints, spatial-store sync — already exists; this
 * component is the missing author UI on top.
 *
 * Layout:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ Configure properties                                  [×]   │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ [Rack cell][Polygon][Circle][Line][Marker][3D Model][...]  │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ Fields for Polygon                       [+ Add field]      │
 *   │                                                             │
 *   │ ┌─ sku ────────────── Text ─── kg ── 🖉 ── ✕ ┐               │
 *   │ ┌─ status ──────────── Status ── enum ─ 🖉 ── ✕ ┐            │
 *   │ ...                                                         │
 *   └─────────────────────────────────────────────────────────────┘
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useSpatialAttributeDefinitions } from '@/hooks/useSpatialShapes'
import { useSpatialStore } from '@/lib/spatial-store'
import type { AttributeDefinition, BindingKind } from '@/lib/db'
import {
  attributeTypesByCategory,
  coerceDefaultValue,
  getAttributeType,
} from '@/lib/attribute-types'

/**
 * Scopes shown in the kind-picker. `text-label` and `stair` are listed
 * even though they aren't yet `BindingKind` values — defining fields
 * for them up front lets the next phase (cross-shape linking + bin
 * support for those kinds) light up without re-entering the data.
 */
export type SchemaScope = BindingKind | 'text-label' | 'stair' | 'any'

const SCOPE_TABS: ReadonlyArray<{ id: SchemaScope; label: string }> = [
  { id: 'grid-cell',  label: 'Rack cell' },
  { id: 'polygon',    label: 'Polygon' },
  { id: 'circle',     label: 'Circle' },
  { id: 'line',       label: 'Line' },
  { id: 'marker',     label: 'Marker' },
  { id: 'image',      label: 'Image' },
  { id: 'model',      label: '3D model' },
  { id: 'text-label', label: 'Text label' },
  { id: 'stair',      label: 'Stair' },
  { id: 'any',        label: 'Shared (any)' },
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Optional initial tab — useful when launching from a per-shape context. */
  initialScope?: SchemaScope
  /**
   * Active warehouse (zone) id. When set, the catalog is fetched scoped
   * to this warehouse (tenant-shared + zone rows). When undefined, only
   * tenant-shared rows are shown.
   */
  zoneId?: number
}

export function SchemaBuilder({ open, onOpenChange, initialScope = 'grid-cell', zoneId }: Props) {
  const { t } = useTranslation()
  const [scope, setScope] = useState<SchemaScope>(initialScope)
  const [editingId, setEditingId] = useState<number | 'new' | null>(null)

  const { data: allDefs = [] } = useSpatialAttributeDefinitions(zoneId)
  const createLocal = useSpatialStore((s) => s.createLocal)
  const updateLocal = useSpatialStore((s) => s.updateLocal)
  const deleteLocal = useSpatialStore((s) => s.deleteLocal)

  // Only show fields for the current scope (not the "any" inheritance —
  // that's surfaced as a separate tab so authors can manage it
  // explicitly without confusion).
  const fields = useMemo(
    () =>
      [...allDefs]
        .filter((d) => d.scope === (scope as AttributeDefinition['scope']))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [allDefs, scope],
  )

  const handleAdd = async () => {
    const created = (await createLocal('attribute-definitions', {
      scope: scope as AttributeDefinition['scope'],
      key: nextKey(allDefs),
      label: 'New field',
      type: 'text',
      createdAt: new Date(),
    } as Omit<AttributeDefinition, 'id'>)) as AttributeDefinition
    setEditingId(created.id ?? 'new')
  }

  const handleDelete = (id: number) => {
    deleteLocal('attribute-definitions', id)
    if (editingId === id) setEditingId(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 gap-0 overflow-hidden" aria-describedby={undefined}>
        <DialogHeader className="flex flex-row items-center gap-2 px-4 py-3 border-b space-y-0">
          <Database className="w-4 h-4 text-primary flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <DialogTitle className="font-semibold text-sm leading-tight">
              Configure properties
            </DialogTitle>
            <p className="text-[11px] text-muted-foreground">
              Define the fields each shape can store. Fields appear in
              the linked-data editor and can be used in style rules.
            </p>
          </div>
        </DialogHeader>

        {/* Kind tabs */}
        <div className="px-4 pt-3 border-b bg-muted/20">
          <div className="flex flex-wrap gap-1">
            {SCOPE_TABS.map((tab) => {
              const active = scope === tab.id
              const count = allDefs.filter((d) => d.scope === tab.id).length
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setScope(tab.id)
                    setEditingId(null)
                  }}
                  className={
                    'px-3 py-1.5 text-xs font-medium rounded-t-md border-b-2 transition-colors ' +
                    (active
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground')
                  }
                >
                  {tab.label}
                  {count > 0 && (
                    <span className="ms-1.5 px-1.5 py-0.5 text-[9px] font-mono rounded bg-muted">
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto max-h-[60dvh] p-4 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              {scope === 'any'
                ? 'Shared fields (appear on every kind)'
                : `Fields for ${SCOPE_TABS.find((t) => t.id === scope)?.label}`}
            </Label>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => void handleAdd()}
            >
              <Plus className="w-3 h-3 me-1" />
              Add field
            </Button>
          </div>

          {fields.length === 0 && (
            <div className="px-3 py-6 text-[11px] text-muted-foreground border border-dashed rounded-md text-center">
              No fields yet. Click <strong>Add field</strong> to define
              one — for example a <code>sku</code> (Text), a{' '}
              <code>qty</code> (Quantity), or a <code>camera_url</code> (Stream).
            </div>
          )}

          <div className="space-y-1.5">
            {fields.map((def) => {
              const typeDef = getAttributeType(def.type)
              const isEditing = editingId === def.id
              return (
                <div
                  key={def.id ?? def.key}
                  className="border rounded-md overflow-hidden bg-background/40"
                >
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium truncate">{def.label}</span>
                        <span className="font-mono text-[10px] text-muted-foreground truncate">
                          {def.key}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="font-mono">{typeDef.label}</span>
                        {def.unit && <span>· {def.unit}</span>}
                        {typeDef.widget === 'enum' && def.enumValues && def.enumValues.length > 0 && (
                          <span>· {def.enumValues.length} options</span>
                        )}
                        {def.defaultValue !== undefined && def.defaultValue !== null && def.defaultValue !== '' && (
                          <span>· default: <span className="font-mono">{String(def.defaultValue)}</span></span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditingId(isEditing ? null : def.id ?? null)}
                      className="flex items-center justify-center w-6 h-6 rounded hover:bg-accent transition-colors"
                      title={t('schemaBuilder.editField', { defaultValue: 'Edit field' })}
                      aria-label={t('schemaBuilder.editField', { defaultValue: 'Edit field' })}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => def.id !== undefined && handleDelete(def.id)}
                      className="flex items-center justify-center w-6 h-6 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
                      title={t('schemaBuilder.deleteField', { defaultValue: 'Delete field' })}
                      aria-label={t('schemaBuilder.deleteField', { defaultValue: 'Delete field' })}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                  {isEditing && def.id !== undefined && (
                    <FieldEditor
                      def={def}
                      onChange={(patch) => updateLocal('attribute-definitions', def.id!, patch)}
                      onClose={() => setEditingId(null)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="px-4 py-3 border-t flex items-center justify-end bg-background flex-shrink-0">
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- FieldEditor

function FieldEditor({
  def,
  onChange,
  onClose,
}: {
  def: AttributeDefinition
  onChange: (patch: Partial<AttributeDefinition>) => void
  onClose: () => void
}) {
  const typeDef = getAttributeType(def.type)
  const showEnum = typeDef.widget === 'enum'
  const showUnit =
    typeDef.widget === 'measure' ||
    typeDef.widget === 'number' ||
    typeDef.widget === 'integer' ||
    typeDef.widget === 'duration' ||
    typeDef.widget === 'currency'

  const handleTypeChange = (nextTypeId: string) => {
    const next = getAttributeType(nextTypeId)
    const patch: Partial<AttributeDefinition> = { type: nextTypeId }
    if (next.defaultUnit && !def.unit) patch.unit = next.defaultUnit
    if (next.widget === 'enum' && (!def.enumValues || def.enumValues.length === 0)) {
      patch.enumValues = next.defaultEnumValues ?? []
    }
    onChange(patch)
  }

  return (
    <div className="border-t bg-muted/10 p-3 space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px]">Label</Label>
          <Input
            value={def.label}
            onChange={(e) => onChange({ label: e.target.value })}
            className="h-7 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px]">Key</Label>
          <Input
            value={def.key}
            onChange={(e) => onChange({ key: sanitizeKey(e.target.value) })}
            className="h-7 text-xs font-mono"
            placeholder="snake_case_key"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-[10px]">Type</Label>
        <select
          value={def.type}
          onChange={(e) => handleTypeChange(e.target.value)}
          className="h-7 w-full text-xs rounded border border-input bg-background px-1.5"
        >
          {attributeTypesByCategory().map((group) => (
            <optgroup key={group.category} label={group.label}>
              {group.types.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {typeDef.hint && (
          <p className="text-[10px] text-muted-foreground">{typeDef.hint}</p>
        )}
      </div>

      {showUnit && (
        <div className="space-y-1">
          <Label className="text-[10px]">Unit</Label>
          <Input
            value={def.unit ?? ''}
            onChange={(e) => onChange({ unit: e.target.value || undefined })}
            placeholder={typeDef.defaultUnit ?? 'optional'}
            className="h-7 text-xs"
          />
        </div>
      )}

      {showEnum && (
        <EnumValuesEditor
          values={def.enumValues ?? []}
          onChange={(v) => onChange({ enumValues: v.length > 0 ? v : undefined })}
        />
      )}

      <div className="space-y-1">
        <Label className="text-[10px]">Default value (optional)</Label>
        <Input
          value={
            def.defaultValue === undefined || def.defaultValue === null
              ? ''
              : String(def.defaultValue)
          }
          onChange={(e) =>
            onChange({
              defaultValue:
                e.target.value === ''
                  ? undefined
                  : coerceDefaultValue(typeDef.widget, e.target.value),
            })
          }
          placeholder="applied when a new bin is created"
          className="h-7 text-xs"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-[10px]">Description (optional)</Label>
        <Input
          value={def.description ?? ''}
          onChange={(e) => onChange({ description: e.target.value || undefined })}
          placeholder="shown as help text under the field"
          className="h-7 text-xs"
        />
      </div>

      <div className="flex justify-end pt-1">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ EnumValuesEditor

function EnumValuesEditor({
  values,
  onChange,
}: {
  values: string[]
  onChange: (v: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (v.length === 0 || values.includes(v)) {
      setDraft('')
      return
    }
    onChange([...values, v])
    setDraft('')
  }
  return (
    <div className="space-y-1">
      <Label className="text-[10px]">Allowed values</Label>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded-full bg-muted"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="flex items-center justify-center w-3.5 h-3.5 rounded-full hover:bg-destructive/20 hover:text-destructive transition-colors"
              aria-label={`Remove ${v}`}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder="add an option"
          className="h-7 text-xs font-mono flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={add}
          disabled={draft.trim().length === 0}
        >
          Add
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- helpers

function sanitizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 64)
}

function nextKey(existing: AttributeDefinition[]): string {
  const taken = new Set(existing.map((d) => d.key))
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `field_${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `field_${Date.now()}`
}

