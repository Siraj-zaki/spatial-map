/**
 * Widgets step — setup for a "Facility map & list" (facilityExplorer)
 * widget: pick the facility, tick what the list shows (facility items
 * and/or the facility's linked tables — each becomes a tab), then
 * optionally rename tabs and choose the fields under each row.
 *
 * The widget's queries are written on save (src/lib/reports/
 * explorer-spec.ts), so nothing here touches the Queries step.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  Box,
  BrickWall,
  Check,
  ChevronDown,
  DoorOpen,
  Footprints,
  Grid3x3,
  Layers,
  Link2,
  Loader2,
  MapPin,
  MoveVertical,
  Shapes,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { DataLinkConfig, Zone } from '@/lib/db'
import type { ReportSourceHint } from '@/lib/reports-client'
import {
  FACILITY_ENTITIES,
  facilityEntityName,
  facilityFieldLabel,
  facilityWritableColumns,
  type FacilityEntity,
} from '@/lib/reports/facility-sources'
import {
  dataLinkTab,
  facilityTab,
  isFacilityEntity,
  type ExplorerBindings,
  type ExplorerTabConfig,
} from '@/lib/reports/explorer-spec'
import { loadSourceSchema, useSourceSchema } from '../use-source-schema'

export const ENTITY_ICON: Record<FacilityEntity, LucideIcon> = {
  floors: Layers,
  areas: Shapes,
  racks: Grid3x3,
  markers: MapPin,
  walls: BrickWall,
  doors: DoorOpen,
  stairs: Footprints,
  lifts: ArrowDownUp,
  escalators: MoveVertical,
  'text-labels': Type,
  models: Box,
}

const MAX_SUBTITLE = 4

const tabKey = (tab: ExplorerTabConfig) => (tab.kind === 'dataLink' ? `link:${tab.dataLinkId}` : `fac:${tab.entity}`)

export function ExplorerSetup({
  bindings,
  sourceHints,
  zones,
  dataLinks,
  onChange,
}: {
  bindings: ExplorerBindings
  sourceHints: readonly ReportSourceHint[]
  zones: readonly Zone[]
  dataLinks: readonly DataLinkConfig[]
  onChange: (next: ExplorerBindings) => void
}) {
  const { t } = useTranslation()
  const { zoneId, tabs } = bindings
  const [pending, setPending] = useState<number | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)

  const facilitySource = (entity: string) =>
    sourceHints.find((h) => h.kind === 'facility' && h.facilityEntity === entity)
  const zoneLinks = zoneId ? dataLinks.filter((l) => l.zoneId === zoneId && l.sourceId && l.id !== undefined) : []
  const tableName = (sourceId: number | undefined) => sourceHints.find((h) => h.id === sourceId)?.name
  const linkFor = (tab: ExplorerTabConfig) => dataLinks.find((l) => l.id === tab.dataLinkId)
  const selected = new Set(tabs.map(tabKey))

  const setTabs = (next: ExplorerTabConfig[]) => onChange({ ...bindings, tabs: next })

  const setZone = (z: number | undefined) => {
    // Facility tabs follow the facility; another facility's links can't.
    const keep = tabs.filter((tab) => tab.kind !== 'dataLink' || dataLinks.find((l) => l.id === tab.dataLinkId)?.zoneId === z)
    onChange({ zoneId: z, tabs: keep })
  }

  const toggleEntity = (entity: FacilityEntity) => {
    const key = `fac:${entity}`
    if (selected.has(key)) return setTabs(tabs.filter((tab) => tabKey(tab) !== key))
    const hint = facilitySource(entity)
    if (hint) setTabs([...tabs, facilityTab(entity, hint.id)])
  }

  const toggleLink = async (link: DataLinkConfig) => {
    const key = `link:${link.id}`
    if (selected.has(key)) return setTabs(tabs.filter((tab) => tabKey(tab) !== key))
    if (!link.sourceId) return
    setPending(link.id ?? null)
    setLinkError(null)
    try {
      const schema = await loadSourceSchema(link.sourceId)
      setTabs([...tabs, { ...dataLinkTab(link, schema.fields), label: schema.name }])
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const patchTab = (i: number, patch: Partial<ExplorerTabConfig>) =>
    setTabs(tabs.map((tab, j) => (j === i ? { ...tab, ...patch } : tab)))
  const moveTab = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= tabs.length) return
    const next = [...tabs]
    ;[next[i], next[j]] = [next[j], next[i]]
    setTabs(next)
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-1.5 sm:grid-cols-[8rem,1fr] sm:items-center">
        <Label htmlFor="explorer-facility" className="text-xs text-muted-foreground">
          {t('reports.wizard.explorer.facility', { defaultValue: 'Facility' })}
        </Label>
        <select
          id="explorer-facility"
          value={zoneId ?? ''}
          onChange={(e) => setZone(e.target.value ? Number(e.target.value) : undefined)}
          className={cn(
            'h-8 w-full rounded-md border bg-background px-2 text-xs',
            zoneId ? 'border-input' : 'border-warning',
          )}
        >
          <option value="">{t('reports.wizard.explorer.pickFacility', { defaultValue: 'Pick a facility…' })}</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-foreground">
          {t('reports.wizard.explorer.shows', { defaultValue: 'What the list shows' })}
        </legend>
        <p className="text-[11px] text-muted-foreground">
          {t('reports.wizard.explorer.showsHint', {
            defaultValue: 'Each one becomes a tab. Its rows sit beside a live map of the facility — pick a row to find it on the map, or click the map to find the row.',
          })}
        </p>

        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground pt-1">
          {t('reports.wizard.explorer.facilityItems', { defaultValue: 'Facility items' })}
        </div>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {FACILITY_ENTITIES.map((entity) => {
            const Icon = ENTITY_ICON[entity]
            const on = selected.has(`fac:${entity}`)
            const available = Boolean(facilitySource(entity))
            return (
              <button
                key={entity}
                type="button"
                aria-pressed={on}
                disabled={!available}
                onClick={() => toggleEntity(entity)}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2 py-1.5 text-start text-xs transition-colors disabled:opacity-50',
                  on ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className={cn('h-3.5 w-3.5 shrink-0', on && 'text-primary')} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{facilityEntityName(entity)}</span>
                {on && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
              </button>
            )
          })}
        </div>

        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground pt-2">
          {t('reports.wizard.explorer.linkedData', { defaultValue: 'Linked data' })}
        </div>
        {!zoneId ? (
          <p className="text-[11px] text-muted-foreground">
            {t('reports.wizard.explorer.pickFacilityFirst', { defaultValue: 'Pick a facility to see the tables linked to its map.' })}
          </p>
        ) : zoneLinks.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {t('reports.wizard.explorer.noLinks', {
              defaultValue: 'No tables are linked to this facility’s map yet. Link one from the map editor’s Data links panel to list its rows here.',
            })}
          </p>
        ) : (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {zoneLinks.map((link) => {
              const on = selected.has(`link:${link.id}`)
              const busy = pending === link.id
              return (
                <li key={link.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => void toggleLink(link)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-start text-xs transition-colors',
                      on ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
                    ) : (
                      <Link2 className={cn('h-3.5 w-3.5 shrink-0', on && 'text-primary')} aria-hidden />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">{link.name}</span>
                      {tableName(link.sourceId) && (
                        <span className="block truncate text-[10px] text-muted-foreground">{tableName(link.sourceId)}</span>
                      )}
                    </span>
                    {on && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {linkError && (
          <p className="flex items-center gap-1.5 text-[11px] text-destructive">
            <AlertCircle className="h-3 w-3" aria-hidden />
            {t('reports.wizard.explorer.fieldsFailed', { defaultValue: 'Couldn’t load that table’s fields — try again.' })}
          </p>
        )}
      </fieldset>

      <div className="space-y-1.5">
        <div className="text-xs font-medium text-foreground">
          {t('reports.wizard.explorer.tabs', { count: tabs.length, defaultValue: 'Tabs ({{count}})' })}
        </div>
        {tabs.length === 0 ? (
          <p className="rounded-md border-2 border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
            {t('reports.wizard.explorer.noTabs', { defaultValue: 'Nothing picked yet — choose at least one item type or table above.' })}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {tabs.map((tab, i) => (
              <TabRow
                key={tabKey(tab)}
                tab={tab}
                index={i}
                total={tabs.length}
                defaultName={
                  tab.kind === 'dataLink'
                    ? tab.label || linkFor(tab)?.name || tableName(tab.sourceId) || ''
                    : facilityEntityName(tab.entity, tab.label)
                }
                apiKind={facilitySource(tab.entity)?.apiKind}
                linkGone={tab.kind === 'dataLink' && !linkFor(tab)}
                onPatch={(p) => patchTab(i, p)}
                onMove={(d) => moveTab(i, d)}
                onRemove={() => setTabs(tabs.filter((_, j) => j !== i))}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function TabRow({
  tab,
  index,
  total,
  defaultName,
  apiKind,
  linkGone,
  onPatch,
  onMove,
  onRemove,
}: {
  tab: ExplorerTabConfig
  index: number
  total: number
  defaultName: string
  apiKind?: string
  linkGone: boolean
  onPatch: (p: Partial<ExplorerTabConfig>) => void
  onMove: (d: -1 | 1) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const isData = tab.kind === 'dataLink'
  const Icon = !isData && isFacilityEntity(tab.entity) ? ENTITY_ICON[tab.entity] : Link2
  return (
    <li className="rounded-md border border-border bg-background">
      <div className="flex items-center gap-1.5 p-1.5">
        <Icon className="ms-1 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        <Input
          value={tab.title ?? ''}
          onChange={(e) => onPatch({ title: e.target.value || undefined })}
          placeholder={defaultName}
          aria-label={t('reports.wizard.explorer.tabName', { defaultValue: 'Tab name' })}
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label={t('reports.builderWidgetMoveUp', { defaultValue: 'Move up' })}
          title={t('reports.builderWidgetMoveUp', { defaultValue: 'Move up' })}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          aria-label={t('reports.builderWidgetMoveDown', { defaultValue: 'Move down' })}
          title={t('reports.builderWidgetMoveDown', { defaultValue: 'Move down' })}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={t('reports.wizard.explorer.details', { defaultValue: 'Details' })}
        >
          <span className="hidden sm:inline">{t('reports.wizard.explorer.details', { defaultValue: 'Details' })}</span>
          <ChevronDown className={cn('h-3 w-3 transition-transform motion-reduce:transition-none', open && 'rotate-180')} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={t('reports.wizard.explorer.removeTab', { defaultValue: 'Remove tab' })}
          title={t('reports.wizard.explorer.removeTab', { defaultValue: 'Remove tab' })}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {linkGone && (
        <p className="flex items-center gap-1.5 border-t border-border px-2.5 py-1.5 text-[11px] text-warning">
          <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />
          {t('reports.wizard.explorer.linkGone', { defaultValue: 'This data link no longer exists — its rows can’t be placed on the map.' })}
        </p>
      )}
      {open && <TabDetails tab={tab} apiKind={apiKind} onPatch={onPatch} />}
    </li>
  )
}

function TabDetails({
  tab,
  apiKind,
  onPatch,
}: {
  tab: ExplorerTabConfig
  apiKind?: string
  onPatch: (p: Partial<ExplorerTabConfig>) => void
}) {
  const { t } = useTranslation()
  const { schema, loading, error } = useSourceSchema(tab.sourceId)
  const isData = tab.kind === 'dataLink'
  const label = (key: string) =>
    isData ? schema?.fields.find((f) => f.key === key)?.label || key : facilityFieldLabel(key, schema?.fields.find((f) => f.key === key)?.label)

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 border-t border-border px-2.5 py-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
        {t('reports.wizard.widgets.data.loading', { defaultValue: 'Loading fields…' })}
      </div>
    )
  }
  if (error || !schema) {
    return (
      <div className="flex items-center gap-1.5 border-t border-border px-2.5 py-2 text-[11px] text-destructive">
        <AlertCircle className="h-3 w-3" aria-hidden />
        {t('reports.wizard.explorer.fieldsFailed', { defaultValue: 'Couldn’t load that table’s fields — try again.' })}
      </div>
    )
  }

  const hiddenKeys = new Set(['entity_key', 'id', 'name', 'facility_id', 'floor_id', 'lng', 'lat'])
  const fields = schema.fields.filter((f) => !hiddenKeys.has(f.key) && f.key !== tab.titleField)
  const subtitle = tab.subtitle ?? []
  const editable = tab.editable ?? []
  const writable = !isData && apiKind ? facilityWritableColumns(apiKind).filter((c) => schema.fields.some((f) => f.key === c)) : []

  return (
    <div className="space-y-3 border-t border-border p-2.5">
      {isData && (
        <div className="grid gap-1.5 sm:grid-cols-[10rem,1fr] sm:items-center">
          <Label className="text-[11px] text-muted-foreground">
            {t('reports.wizard.explorer.titleField', { defaultValue: 'Row title' })}
          </Label>
          <select
            value={tab.titleField ?? ''}
            onChange={(e) => onPatch({ titleField: e.target.value || undefined })}
            className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">{t('reports.wizard.explorer.titleFieldNone', { defaultValue: 'Record key' })}</option>
            {schema.fields.filter((f) => f.type === 'text').map((f) => (
              <option key={f.key} value={f.key}>{f.label || f.key}</option>
            ))}
          </select>
        </div>
      )}

      <ChipField
        label={t('reports.wizard.explorer.subtitle', { defaultValue: 'Shown under each row' })}
        hint={t('reports.wizard.explorer.subtitleHint', { max: MAX_SUBTITLE, defaultValue: 'Up to {{max}}, in the order you pick them. They’re also the list’s sort options.' })}
        options={fields.map((f) => f.key)}
        value={subtitle}
        label_={label}
        max={MAX_SUBTITLE}
        onChange={(v) => onPatch({ subtitle: v })}
      />

      {isData ? (
        <p className="text-[11px] text-muted-foreground">
          {t('reports.wizard.explorer.readOnly', { defaultValue: 'Rows of a linked table are read-only here — viewers open the table to edit them.' })}
        </p>
      ) : (
        writable.length > 0 && (
          <ChipField
            label={t('reports.wizard.explorer.editable', { defaultValue: 'Editable in the detail panel' })}
            hint={t('reports.wizard.explorer.editableHint', { defaultValue: 'Changes save straight to the map. Leave all off for a read-only list.' })}
            options={writable}
            value={editable}
            label_={label}
            onChange={(v) => onPatch({ editable: v })}
          />
        )
      )}
    </div>
  )
}

function ChipField({
  label,
  hint,
  options,
  value,
  label_,
  max,
  onChange,
}: {
  label: string
  hint: string
  options: string[]
  value: string[]
  label_: (key: string) => string
  max?: number
  onChange: (v: string[]) => void
}) {
  const full = max !== undefined && value.length >= max
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((key) => {
          const on = value.includes(key)
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              disabled={!on && full}
              onClick={() => onChange(on ? value.filter((k) => k !== key) : [...value, key])}
              className={cn(
                'rounded-md border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40',
                on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:bg-accent',
              )}
            >
              {label_(key)}
            </button>
          )
        })}
      </div>
      <p className="text-[10px] text-muted-foreground">{hint}</p>
    </div>
  )
}
