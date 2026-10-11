/**
 * SchemaBuilder — create / edit form for a thing-type table.
 *
 *   - Create (`existing === null`, used by /tables/new): name, a kind
 *     picked from cards, and the field list — seeded with the kind's
 *     standard columns. A live preview beside the form shows the request
 *     body the table's API will accept. A sticky footer holds Create.
 *     `onDone(newId)` lets the page navigate to the new table.
 *   - Edit (`existing` set, the Schema tab): same fields, pre-filled.
 *     Saved keys are read-only — renaming one would strand existing
 *     records under the old key. A save bar appears only while there are
 *     unsaved changes, with Discard.
 *
 * Fields render as compact rows (label · key · type · required · unique ·
 * reorder/remove) rather than one tall card each, so a 17-field table
 * fits on a screen. The backend auto-mints a "default" API key on create;
 * keys and REST polling live on the detail page, not here.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  Circle,
  Gauge,
  Grid3x3,
  Hexagon,
  KeyRound,
  Loader2,
  Lock,
  MapPin,
  Package,
  Plug,
  Plus,
  Sparkles,
  Table2,
  Tag,
  Trash2,
  Truck,
  Video,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ENTITY_KIND_DEFS } from '@/components/data-link/entity-kind-picker'
import {
  type CreateTableRequest,
  type FieldDataType,
  type FieldDefinitionRequest,
  type FieldDefinitionResponse,
  type TableResponse,
  type UpdateTableRequest,
  createTable,
  updateTable,
} from '@/lib/tables-client'
import { type DataSourceEntityKind } from '@/lib/db'
import { FIELD_DATA_TYPES, FIELD_TYPE_GROUPS, fieldTypeMeta, sampleFieldValue } from '@/lib/table-field-types'
import { type StarterField, missingStarterFields, starterFieldsForKind } from '@/lib/table-starter-fields'
import { cn } from '@/lib/utils'
import { addSolutionItems } from '@/lib/solutions-client'

/**
 * A field row as the form holds it. `uid` keys the React list so a
 * reorder or a removal can't carry one row's input state onto another.
 * `keyTouched` records whether the user edited the key by hand — until
 * they do, it tracks the label. `saved` marks fields that already exist
 * on the server: their key is locked.
 */
interface FieldRow extends FieldDefinitionRequest {
  uid: string
  keyTouched: boolean
  saved: boolean
}

let uidCounter = 0
const nextUid = () => `f${++uidCounter}`

/** Label → field key: lowercase alphanumerics and underscores (keys go into JSON and URLs). */
function slugifyKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63)
}

function emptyRow(sortOrder: number): FieldRow {
  return { uid: nextUid(), keyTouched: false, saved: false, fieldKey: '', fieldLabel: '', dataType: 'text', isRequired: false, isUnique: false, sortOrder }
}

function fieldDefToRow(f: FieldDefinitionResponse): FieldRow {
  return {
    uid: nextUid(),
    keyTouched: true,
    saved: true,
    fieldKey: f.fieldKey,
    fieldLabel: f.fieldLabel,
    dataType: f.dataType,
    isRequired: f.isRequired,
    isUnique: f.isUnique,
    sortOrder: f.sortOrder,
  }
}

function starterRow(s: StarterField, sortOrder: number): FieldRow {
  // The key is the whole point of a seeded field — downstream matching
  // looks it up by name — so a label edit must never rewrite it.
  return { uid: nextUid(), keyTouched: true, saved: false, fieldKey: s.fieldKey, fieldLabel: s.fieldLabel, dataType: s.dataType, isRequired: s.isRequired, isUnique: s.isUnique, sortOrder }
}

/**
 * A new table starts as the entity kind's standard column set rather
 * than one blank row: a hand-built "Marker / POI" table has to carry the
 * same payload keys the marker sample file does, or coordinate
 * auto-detection, external-code match and shape-name joins find nothing.
 */
function rowsFor(existing: TableResponse | null, kind: DataSourceEntityKind): FieldRow[] {
  if (!existing) return starterFieldsForKind(kind).map(starterRow)
  if (existing.fields.length === 0) return [emptyRow(0)]
  return [...existing.fields].sort((a, b) => a.sortOrder - b.sortOrder).map(fieldDefToRow)
}

/** Identity of a field list, ignoring row uids — any edit, including a reorder, changes it. */
function signatureOf(fields: readonly Pick<FieldRow, 'fieldKey' | 'fieldLabel' | 'dataType' | 'isRequired' | 'isUnique'>[]): string {
  return fields.map((f) => [f.fieldKey, f.fieldLabel, f.dataType, f.isRequired ? 1 : 0, f.isUnique ? 1 : 0].join(':')).join('|')
}

const KIND_ICONS: Record<string, LucideIcon> = {
  polygon: Hexagon,
  circle: Circle,
  marker: MapPin,
  asset: Truck,
  camera: Video,
  sensor: Gauge,
  shipment: Package,
  'rfid-tag': Tag,
  'rack-cell': Grid3x3,
  streaming: Activity,
}

const kindKey = (kind: string) => kind.replace(/-/g, '_')

export function SchemaBuilder({
  existing,
  onDone,
  onCancel,
}: {
  existing: TableResponse | null
  onDone: (createdTableId?: number) => void
  /** Rendered as a Cancel button next to Create when provided. */
  onCancel?: () => void
}) {
  const { t } = useTranslation()
  const initialKind = (existing?.dataSource.entityKind as DataSourceEntityKind) ?? 'marker'
  const [name, setName] = useState(existing?.dataSource.name ?? '')
  const [entityKind, setEntityKind] = useState<DataSourceEntityKind>(initialKind)
  const [rows, setRows] = useState<FieldRow[]>(() => rowsFor(existing, initialKind))
  // Signature as last seeded, or null once the schema belongs to the user.
  const [seededSig, setSeededSig] = useState<string | null>(() => (existing ? null : signatureOf(rows)))
  // What edit mode compares against to decide whether there's anything to save.
  const [baseline, setBaseline] = useState(() => ({ name: existing?.dataSource.name ?? '', kind: initialKind, sig: signatureOf(rowsFor(existing, initialKind)) }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Inline errors only appear once the user has tried to save.
  const [showIssues, setShowIssues] = useState(false)
  const nameInvalid = showIssues && name.trim().length === 0
  const labelInputs = useRef(new Map<string, HTMLInputElement | null>())
  const [focusUid, setFocusUid] = useState<string | null>(null)
  useEffect(() => {
    if (focusUid) labelInputs.current.get(focusUid)?.focus()
  }, [focusUid])

  // Reset when the parent swaps the table (or reloads it after a save) —
  // adjusted during render, the React-recommended alternative to an effect.
  const [syncedExisting, setSyncedExisting] = useState(existing)
  if (existing !== syncedExisting) {
    setSyncedExisting(existing)
    const next = rowsFor(existing, initialKind)
    setName(existing?.dataSource.name ?? '')
    setEntityKind(initialKind)
    setRows(next)
    setBaseline({ name: existing?.dataSource.name ?? '', kind: initialKind, sig: signatureOf(next) })
    setSeededSig(existing ? null : signatureOf(next))
    setError(null)
    setShowIssues(false)
  }

  const dirty = existing ? name !== baseline.name || entityKind !== baseline.kind || signatureOf(rows) !== baseline.sig : name.trim().length > 0

  // Leaving with unsaved work asks first (tab close / reload).
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  /**
   * Switching kind re-seeds only while the seeded list is untouched; once
   * the user edited anything their schema wins and the new kind's columns
   * are offered through the "missing standard columns" notice instead.
   */
  const changeKind = (kind: DataSourceEntityKind) => {
    setEntityKind(kind)
    if (existing) return
    if (seededSig === null || signatureOf(rows) !== seededSig) return
    const next = starterFieldsForKind(kind).map(starterRow)
    setSeededSig(signatureOf(next))
    setRows(next)
  }

  const missingStandard = useMemo(() => missingStarterFields(entityKind, rows.map((f) => f.fieldKey)), [entityKind, rows])
  const addMissingStandard = () => {
    setRows((arr) => {
      // A single untouched blank row is the placeholder left by removing the last field.
      const base = arr.length === 1 && arr[0].fieldKey === '' && arr[0].fieldLabel === '' ? [] : arr
      return [...base, ...missingStandard.map((s, i) => starterRow(s, base.length + i))]
    })
  }

  const updateRow = (uid: string, patch: Partial<FieldRow>) => setRows((arr) => arr.map((f) => (f.uid === uid ? { ...f, ...patch } : f)))
  /** The label also writes the key until the user takes the key over. */
  const updateLabel = (uid: string, label: string) =>
    setRows((arr) => arr.map((f) => (f.uid === uid ? { ...f, fieldLabel: label, fieldKey: f.keyTouched ? f.fieldKey : slugifyKey(label) } : f)))
  const addField = () => {
    const row = emptyRow(rows.length)
    setRows((arr) => [...arr, row])
    setFocusUid(row.uid)
  }
  const removeField = (uid: string) => {
    labelInputs.current.delete(uid)
    setRows((arr) => (arr.length > 1 ? arr.filter((f) => f.uid !== uid) : [emptyRow(0)]))
  }
  const moveField = (uid: string, delta: -1 | 1) =>
    setRows((arr) => {
      const idx = arr.findIndex((f) => f.uid === uid)
      const target = idx + delta
      if (idx === -1 || target < 0 || target >= arr.length) return arr
      const next = [...arr]
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })

  const discard = () => {
    const next = rowsFor(existing, initialKind)
    setName(baseline.name)
    setEntityKind(baseline.kind)
    setRows(next)
    setError(null)
    setShowIssues(false)
  }

  /** Per-row problems, derived so they can't drift from what save checks. */
  const issues = useMemo(() => {
    const counts = new Map<string, number>()
    for (const f of rows) {
      const k = f.fieldKey.trim()
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return new Map(
      rows.map((f) => [
        f.uid,
        { missingLabel: f.fieldLabel.trim().length === 0, missingKey: f.fieldKey.trim().length === 0, duplicate: (counts.get(f.fieldKey.trim()) ?? 0) > 1 },
      ]),
    )
  }, [rows])
  const hasFieldIssue = [...issues.values()].some((i) => i.missingLabel || i.missingKey || i.duplicate)

  const save = async () => {
    setError(null)
    setShowIssues(true)
    if (name.trim().length === 0) {
      setError(t('tables.create.errorNameRequired', { defaultValue: 'Name is required.' }))
      return
    }
    if ([...issues.values()].some((i) => i.missingLabel || i.missingKey)) {
      setError(t('tables.create.errorFieldKeyLabel', { defaultValue: 'Every field needs both a key and a label.' }))
      return
    }
    const dupRow = rows.find((f) => issues.get(f.uid)?.duplicate)
    if (dupRow) {
      setError(t('tables.create.errorDuplicateKey', { fieldKey: dupRow.fieldKey.trim(), defaultValue: 'Duplicate field key: {{fieldKey}}' }))
      return
    }
    const cleanFields: FieldDefinitionRequest[] = rows.map((f, i) => ({
      fieldKey: f.fieldKey.trim(),
      fieldLabel: f.fieldLabel.trim(),
      dataType: f.dataType,
      isRequired: f.isRequired,
      isUnique: f.isUnique,
      sortOrder: i,
    }))
    setBusy(true)
    try {
      if (existing) {
        const patch: UpdateTableRequest = { name: name.trim(), entityKind, fields: cleanFields }
        await updateTable(existing.dataSource.id, patch)
        onDone(existing.dataSource.id)
      } else {
        const req: CreateTableRequest = { name: name.trim(), entityKind, fields: cleanFields }
        const created = await createTable(req)
        // Created from inside a solution (/tables/new?solution=…) → it joins it.
        const solutionId = Number(new URLSearchParams(window.location.search).get('solution'))
        if (Number.isInteger(solutionId) && solutionId > 0) {
          await addSolutionItems(solutionId, { dataSourceIds: [created.dataSource.id] }).catch(() => undefined)
        }
        onDone(created.dataSource.id)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const nameField = (
    <div className="space-y-1.5">
      <Label htmlFor="sb-name">{t('tables.create.name', { defaultValue: 'Table name' })}</Label>
      <Input
        id="sb-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('tables.create.namePlaceholder', { defaultValue: 'e.g. Forklifts, Cameras, Shipments' })}
        aria-invalid={nameInvalid}
        autoFocus={!existing}
        className={cn(nameInvalid && 'border-danger focus-visible:ring-danger')}
      />
      {nameInvalid && <p className="text-xs text-danger">{t('tables.create.errorNameRequired', { defaultValue: 'Name is required.' })}</p>}
    </div>
  )

  const errorBox = error && (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{error}</span>
    </div>
  )

  const fieldsEditor = (
    <FieldsEditor
      rows={rows}
      issues={issues}
      showIssues={showIssues}
      editing={!!existing}
      missingStandard={missingStandard}
      onAddMissing={addMissingStandard}
      onAdd={addField}
      onLabel={updateLabel}
      onPatch={updateRow}
      onMove={moveField}
      onRemove={removeField}
      registerLabel={(uid, el) => labelInputs.current.set(uid, el)}
    />
  )

  // ---- create ----------------------------------------------------------
  if (!existing) {
    return (
      <div className="space-y-6">
        {/* The preview sits beside the form only when the field table still
            has room for full-width keys; otherwise it follows the steps. */}
        <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_340px] 2xl:items-start">
          <div className="min-w-0 space-y-6">
            <Step n={1} title={t('tables.create.stepBasics', { defaultValue: 'Name it and say what it holds' })}>
              <div className="space-y-5">
                {nameField}
                <KindCards value={entityKind} onChange={changeKind} />
              </div>
            </Step>
            <Step
              n={2}
              title={t('tables.create.stepFields', { defaultValue: 'Choose its fields' })}
              description={t('tables.create.stepFieldsBody', {
                defaultValue: 'Started with the standard columns for this kind — the ones imports and map layers look for. Rename, retype or remove any.',
              })}
            >
              {fieldsEditor}
            </Step>
            {errorBox}
          </div>
          <aside className="grid gap-4 md:grid-cols-2 2xl:sticky 2xl:top-4 2xl:grid-cols-1">
            <PayloadPreview rows={rows} />
            <WhatYouGet />
          </aside>
        </div>
        <div className="sticky bottom-0 z-10 -mx-4 flex items-center justify-end gap-2 border-t bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <p className="me-auto hidden text-sm text-muted-foreground sm:block">
            {t('tables.create.footerSummary', { defaultValue: '{{count}} fields', count: rows.filter((r) => r.fieldKey).length })}
          </p>
          {onCancel && (
            <Button variant="outline" onClick={onCancel} disabled={busy} type="button">
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
          )}
          <Button onClick={() => void save()} disabled={busy || (showIssues && hasFieldIssue)} type="button">
            {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
            {t('tables.create.createTable', { defaultValue: 'Create table' })}
          </Button>
        </div>
      </div>
    )
  }

  // ---- edit ------------------------------------------------------------
  return (
    <div className="space-y-5">
      <div className="space-y-5 rounded-xl border bg-card p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          {nameField}
          <div className="space-y-1.5">
            <Label htmlFor="sb-kind">{t('tables.create.kindLabel', { defaultValue: 'What kind of data is this?' })}</Label>
            <select
              id="sb-kind"
              value={entityKind}
              onChange={(e) => changeKind(e.target.value as DataSourceEntityKind)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {ENTITY_KIND_DEFS.filter((d) => d.kind !== 'rack-cell' || entityKind === 'rack-cell').map((d) => (
                <option key={d.kind} value={d.kind}>
                  {t(`integrations.entityKind_${kindKey(d.kind)}`, { defaultValue: d.label })}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="rounded-xl border bg-card p-4 sm:p-5">{fieldsEditor}</div>
      {errorBox}
      {dirty && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t bg-background/90 px-4 py-3 backdrop-blur animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <p className="me-auto text-sm font-medium">{t('tables.create.unsaved', { defaultValue: 'You have unsaved changes' })}</p>
          <Button variant="ghost" onClick={discard} disabled={busy} type="button">
            {t('tables.create.discard', { defaultValue: 'Discard' })}
          </Button>
          <Button onClick={() => void save()} disabled={busy || (showIssues && hasFieldIssue)} type="button">
            {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
            {t('tables.create.saveChanges', { defaultValue: 'Save changes' })}
          </Button>
        </div>
      )}
    </div>
  )
}

function Step({ n, title, description, children }: { n: number; title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{n}</span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-6">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </header>
      {children}
    </section>
  )
}

/** Entity kinds as radio cards — the choice decides the starter columns and map behaviour. */
function KindCards({ value, onChange }: { value: DataSourceEntityKind; onChange: (k: DataSourceEntityKind) => void }) {
  const { t } = useTranslation()
  const kinds = ENTITY_KIND_DEFS.filter((d) => d.kind !== 'rack-cell')
  const current = kinds.find((d) => d.kind === value)
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-sm font-medium">{t('tables.create.kindLabel', { defaultValue: 'What kind of data is this?' })}</legend>
      <div role="radiogroup" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {kinds.map((d) => {
          const Icon = KIND_ICONS[d.kind] ?? Table2
          const checked = d.kind === value
          return (
            <button
              key={d.kind}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => onChange(d.kind)}
              className={cn(
                'flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                checked ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:border-foreground/20 hover:bg-muted/40',
              )}
            >
              <Icon className={cn('h-4 w-4 shrink-0', checked ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
              <span className={cn('truncate', checked && 'font-medium')}>{t(`integrations.entityKind_${kindKey(d.kind)}`, { defaultValue: d.label })}</span>
            </button>
          )
        })}
      </div>
      {current && <p className="text-xs text-muted-foreground">{t(`integrations.entityKindHint_${kindKey(current.kind)}`, { defaultValue: current.hint })}</p>}
    </fieldset>
  )
}

interface FieldsEditorProps {
  rows: FieldRow[]
  issues: Map<string, { missingLabel: boolean; missingKey: boolean; duplicate: boolean }>
  showIssues: boolean
  editing: boolean
  missingStandard: StarterField[]
  onAddMissing: () => void
  onAdd: () => void
  onLabel: (uid: string, label: string) => void
  onPatch: (uid: string, patch: Partial<FieldRow>) => void
  onMove: (uid: string, delta: -1 | 1) => void
  onRemove: (uid: string) => void
  registerLabel: (uid: string, el: HTMLInputElement | null) => void
}

// Fixed tracks for type / rules / actions so the header lines up with the rows.
const ROW_GRID = 'md:grid md:grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)_9.5rem_10.5rem_5.25rem] md:items-center md:gap-2'

function FieldsEditor({ rows, issues, showIssues, editing, missingStandard, onAddMissing, onAdd, onLabel, onPatch, onMove, onRemove, registerLabel }: FieldsEditorProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3">
      {editing && (
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              {t('tables.create.fields', { defaultValue: 'Fields' })} <span className="font-normal tabular-nums text-muted-foreground">{rows.length}</span>
            </h3>
            <p className="text-xs text-muted-foreground">{t('tables.create.sectionFieldsDescription', { defaultValue: 'One column per field. The key is what API callers send; the label is what people read.' })}</p>
          </div>
        </div>
      )}

      {missingStandard.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-sm font-medium">
              {t('tables.create.missingStandardTitleV2', { defaultValue: '{{count}} standard columns for this kind are missing', count: missingStandard.length })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('tables.create.missingStandardHint', { defaultValue: 'Imports and map layers look these up by key. Without them this table will not match shapes or place points automatically.' })}
            </p>
            <div className="flex flex-wrap gap-1">
              {missingStandard.map((s) => (
                <span key={s.fieldKey} dir="ltr" title={s.description} className="rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[11px] text-warning">
                  {s.fieldKey}
                </span>
              ))}
            </div>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={onAddMissing} type="button">
            <Sparkles className="h-4 w-4" />
            {t('tables.create.addMissingStandard', { defaultValue: 'Add them' })}
          </Button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border">
        <div className={cn('hidden border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground', ROW_GRID)}>
          <span aria-hidden>#</span>
          <span>{t('tables.create.fieldLabel', { defaultValue: 'Field label' })}</span>
          <span>{t('tables.create.keyLabel', { defaultValue: 'API key' })}</span>
          <span>{t('tables.create.typeLabel', { defaultValue: 'Type' })}</span>
          <span>{t('tables.create.rules', { defaultValue: 'Rules' })}</span>
          <span className="sr-only">{t('tables.create.actions', { defaultValue: 'Actions' })}</span>
        </div>
        <ol className="divide-y">
          {rows.map((f, idx) => {
            const issue = issues.get(f.uid)
            const bad = showIssues && !!(issue?.missingLabel || issue?.missingKey || issue?.duplicate)
            const TypeIcon = fieldTypeMeta(f.dataType).icon
            const name = f.fieldLabel || f.fieldKey || t('tables.create.untitledField', { defaultValue: 'Untitled field' })
            return (
              <li key={f.uid} className={cn('space-y-2 px-3 py-2.5 md:space-y-0', ROW_GRID, bad && 'bg-danger/5')}>
                <span className="hidden text-xs tabular-nums text-muted-foreground md:block" dir="ltr">
                  {idx + 1}
                </span>
                <Input
                  ref={(el) => registerLabel(f.uid, el)}
                  value={f.fieldLabel}
                  onChange={(e) => onLabel(f.uid, e.target.value)}
                  placeholder={t('tables.create.fieldLabelPlaceholder', { defaultValue: 'e.g. Battery level' })}
                  aria-label={t('tables.create.fieldLabelFor', { defaultValue: 'Label of field {{n}}', n: idx + 1 })}
                  aria-invalid={showIssues && issue?.missingLabel}
                  className="h-8"
                />
                <div className="relative">
                  <Input
                    dir="ltr"
                    value={f.fieldKey}
                    readOnly={editing && f.saved}
                    onChange={(e) => onPatch(f.uid, { fieldKey: slugifyKey(e.target.value), keyTouched: true })}
                    placeholder="battery_level"
                    aria-label={t('tables.create.fieldKeyFor', { defaultValue: 'API key of field {{n}}', n: idx + 1 })}
                    aria-invalid={showIssues && (issue?.missingKey || issue?.duplicate)}
                    title={editing && f.saved ? t('tables.create.keyLocked', { defaultValue: 'Saved keys can’t change — existing records store data under this key. Remove the field and add a new one to rename it.' }) : undefined}
                    className={cn('h-8 font-mono text-xs', editing && f.saved && 'cursor-default bg-muted/50 pe-8 text-muted-foreground')}
                  />
                  {editing && f.saved && <Lock className="pointer-events-none absolute end-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />}
                </div>
                <div className="flex flex-wrap items-center gap-2 md:contents">
                  <div className="relative min-w-[7.5rem] flex-1 md:min-w-0 md:flex-none">
                    <TypeIcon className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <select
                      value={f.dataType}
                      onChange={(e) => onPatch(f.uid, { dataType: e.target.value as FieldDataType })}
                      aria-label={t('tables.create.fieldTypeFor', { defaultValue: 'Type of field {{n}}', n: idx + 1 })}
                      className="h-8 w-full rounded-md border border-input bg-background pe-2 ps-8 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:w-[9.5rem]"
                    >
                      {FIELD_TYPE_GROUPS.map((g) => (
                        <optgroup key={g.group} label={t(g.labelKey, { defaultValue: g.labelFallback })}>
                          {FIELD_DATA_TYPES.filter((opt) => opt.group === g.group).map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {t(opt.labelKey, { defaultValue: opt.labelFallback })}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-1">
                    <RuleToggle pressed={!!f.isRequired} onChange={(v) => onPatch(f.uid, { isRequired: v })} label={t('tables.create.required', { defaultValue: 'Required' })} />
                    <RuleToggle pressed={!!f.isUnique} onChange={(v) => onPatch(f.uid, { isUnique: v })} label={t('tables.create.unique', { defaultValue: 'Unique' })} />
                  </div>
                  <div className="ms-auto flex items-center md:ms-0 md:justify-end">
                    <IconAction onClick={() => onMove(f.uid, -1)} disabled={idx === 0} label={t('tables.create.moveUpNamed', { defaultValue: 'Move {{name}} up', name })} icon={ArrowUp} />
                    <IconAction onClick={() => onMove(f.uid, 1)} disabled={idx === rows.length - 1} label={t('tables.create.moveDownNamed', { defaultValue: 'Move {{name}} down', name })} icon={ArrowDown} />
                    <IconAction onClick={() => onRemove(f.uid)} label={t('tables.create.removeNamed', { defaultValue: 'Remove {{name}}', name })} icon={Trash2} danger />
                  </div>
                </div>
                {showIssues && issue?.duplicate && <p className="text-xs text-danger md:col-span-6 md:col-start-2">{t('tables.create.errorDuplicateInline', { defaultValue: 'Another field already uses this key.' })}</p>}
                {showIssues && !issue?.duplicate && (issue?.missingKey || issue?.missingLabel) && (
                  <p className="text-xs text-danger md:col-span-6 md:col-start-2">{t('tables.create.errorFieldKeyLabel', { defaultValue: 'Every field needs both a key and a label.' })}</p>
                )}
              </li>
            )
          })}
        </ol>
        <div className="border-t bg-muted/20 px-3 py-2">
          <Button variant="ghost" size="sm" onClick={onAdd} type="button" className="text-muted-foreground hover:text-foreground">
            <Plus className="h-4 w-4" />
            {t('tables.create.addField', { defaultValue: 'Add field' })}
          </Button>
        </div>
      </div>
      {editing && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('tables.create.keysLockedHint', { defaultValue: 'Saved keys are locked — existing records store their data under them. To rename one, remove the field and add a new one.' })}
        </p>
      )}
    </div>
  )
}

function RuleToggle({ pressed, onChange, label }: { pressed: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={cn(
        'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pressed ? 'border-primary/40 bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {pressed && <Check className="h-3 w-3" aria-hidden />}
      {label}
    </button>
  )
}

function IconAction({ onClick, disabled, label, icon: Icon, danger }: { onClick: () => void; disabled?: boolean; label: string; icon: LucideIcon; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30',
        danger ? 'hover:bg-danger/10 hover:text-danger' : 'hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  )
}

/** What one record of this table looks like on the wire — updates as fields change. */
function PayloadPreview({ rows }: { rows: FieldRow[] }) {
  const { t } = useTranslation()
  const payload: Record<string, unknown> = {}
  for (const r of rows) if (r.fieldKey) payload[r.fieldKey] = sampleFieldValue(r.dataType)
  const body = JSON.stringify({ entityKey: 'ITEM-001', payload }, null, 2)
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="border-b px-4 py-3">
        <p className="text-sm font-semibold">{t('tables.create.previewTitle', { defaultValue: 'One record, as your systems send it' })}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('tables.create.previewBody', { defaultValue: 'Updates as you edit the fields.' })}</p>
      </div>
      <div className="space-y-2 bg-muted/30 p-3" dir="ltr">
        <p className="font-mono text-xs">
          <span className="rounded bg-info/10 px-1.5 py-0.5 font-semibold text-info">POST</span> <span className="text-muted-foreground">/api/v1/public/tables/rows</span>
        </p>
        <pre className="max-h-80 overflow-auto rounded-md border bg-background p-3 font-mono text-[11px] leading-relaxed">{body}</pre>
      </div>
    </div>
  )
}

function WhatYouGet() {
  const { t } = useTranslation()
  const items: [LucideIcon, string, string][] = [
    [Table2, t('tables.create.outcomeGridTitle', { defaultValue: 'An editable grid' }), t('tables.create.outcomeGridBodyV2', { defaultValue: 'Add and edit records by hand, with history for every change.' })],
    [Plug, t('tables.create.outcomeApiTitle', { defaultValue: 'A REST API' }), t('tables.create.outcomeApiBodyV2', { defaultValue: 'Read, write and bulk endpoints generated from these fields.' })],
    [KeyRound, t('tables.create.outcomeKeyTitle', { defaultValue: 'An API key' }), t('tables.create.outcomeKeyBody', { defaultValue: 'Created with the table — copy it from the API & access tab.' })],
  ]
  return (
    <ul className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      {items.map(([Icon, title, body]) => (
        <li key={title} className="flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground">{body}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}
