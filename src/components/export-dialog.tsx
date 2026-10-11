/**
 * "Export shapes" dialog — the toolbar's Data → Export entry point.
 *
 * Three scope modes:
 *   - Everything in the active warehouse
 *   - By kind (checkbox list with live per-kind counts)
 *   - Currently selected shapes only (across every kind that has a
 *     selection)
 *
 * Four formats. The picker restricts multi-kind CSV since a flat table
 * can only carry one schema at a time — XLSX covers the multi-kind
 * case with one sheet per kind, and the two JSON flavours (GeoJSON /
 * envelope JSON) hold everything in a single file.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Circle,
  Database,
  Download,
  DoorOpen,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  Globe,
  Grid3X3,
  Hexagon,
  Image as ImageIcon,
  Info,
  Layers,
  MapPin,
  Package,
  Route as RouteIcon,
  Slash,
  Type,
  Waypoints,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  ALL_EXPORTABLE_KINDS,
  countByKind,
  downloadShapes,
  type ExportableKind,
  type ExportFormat,
  type ExportScope,
  type ExportSource,
} from '@/lib/export-shapes'

type ScopeMode = 'all' | 'byKind' | 'selected'

const KIND_META: Record<
  ExportableKind,
  { labelKey: string; labelDefault: string; icon: typeof MapPin }
> = {
  grid: { labelKey: 'exportDialog.kindGrid', labelDefault: 'Grids', icon: Grid3X3 },
  polygon: { labelKey: 'exportDialog.kindPolygon', labelDefault: 'Polygons / areas', icon: Hexagon },
  circle: { labelKey: 'exportDialog.kindCircle', labelDefault: 'Circles', icon: Circle },
  line: { labelKey: 'exportDialog.kindLine', labelDefault: 'Lines / walls', icon: Slash },
  route: { labelKey: 'exportDialog.kindRoute', labelDefault: 'Routes', icon: RouteIcon },
  marker: { labelKey: 'exportDialog.kindMarker', labelDefault: 'Markers', icon: MapPin },
  image: { labelKey: 'exportDialog.kindImage', labelDefault: 'Floor plan images', icon: ImageIcon },
  imagePlane: { labelKey: 'exportDialog.kindImagePlane', labelDefault: '3D image planes', icon: FileImage },
  model: { labelKey: 'exportDialog.kindModel', labelDefault: '3D models', icon: Package },
  stair: { labelKey: 'exportDialog.kindStair', labelDefault: 'Stairs', icon: Layers },
  door: { labelKey: 'exportDialog.kindDoor', labelDefault: 'Doors', icon: DoorOpen },
  text: { labelKey: 'exportDialog.kindText', labelDefault: 'Text labels', icon: Type },
}

const FORMAT_META: Record<
  ExportFormat,
  { labelKey: string; labelDefault: string; hintKey: string; hintDefault: string; icon: typeof FileText }
> = {
  geojson: {
    labelKey: 'exportDialog.formatGeojson',
    labelDefault: 'GeoJSON (.geojson)',
    hintKey: 'exportDialog.formatGeojsonHint',
    hintDefault: 'FeatureCollection with full geometry. Best for spatial round-trip.',
    icon: Globe,
  },
  json: {
    labelKey: 'exportDialog.formatJson',
    labelDefault: 'JSON (.json)',
    hintKey: 'exportDialog.formatJsonHint',
    hintDefault: 'Object keyed by kind. Vertices go into a JSON string column.',
    icon: FileJson,
  },
  xlsx: {
    labelKey: 'exportDialog.formatXlsx',
    labelDefault: 'Excel (.xlsx)',
    hintKey: 'exportDialog.formatXlsxHint',
    hintDefault: 'One sheet per kind — best for multi-kind spreadsheets.',
    icon: FileSpreadsheet,
  },
  csv: {
    labelKey: 'exportDialog.formatCsv',
    labelDefault: 'CSV (.csv)',
    hintKey: 'exportDialog.formatCsvHint',
    hintDefault: 'Single kind only — a flat table can only carry one schema.',
    icon: FileText,
  },
}

export interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** All shape collections available in the editor. */
  source: ExportSource
  /**
   * Currently-selected shape ids per kind, from the editor's
   * selection state. Missing kind = nothing selected of that kind.
   */
  selectedIds?: Partial<Record<ExportableKind, ReadonlySet<number>>>
  /** Warehouse currently being edited; used to scope "Everything". */
  activeZoneId?: number | null
}

export function ExportDialog({
  open,
  onOpenChange,
  source,
  selectedIds,
  activeZoneId,
}: ExportDialogProps) {
  const { t } = useTranslation()

  const [scopeMode, setScopeMode] = useState<ScopeMode>('all')
  const [kindChoices, setKindChoices] = useState<Set<ExportableKind>>(
    () => new Set(ALL_EXPORTABLE_KINDS),
  )
  const [format, setFormat] = useState<ExportFormat>('geojson')
  const [includeConfig, setIncludeConfig] = useState(true)
  const [includeTimestamps, setIncludeTimestamps] = useState(false)

  // Per-kind counts respecting the active warehouse. Selection counts
  // computed separately so we don't hide kinds the user could still
  // reach via "Selected only".
  const zoneScope: ExportScope = useMemo(
    () => ({ kinds: ALL_EXPORTABLE_KINDS, zoneId: activeZoneId ?? null }),
    [activeZoneId],
  )
  const allCounts = useMemo(() => countByKind(source, zoneScope), [source, zoneScope])
  const selectedCounts = useMemo(() => {
    if (!selectedIds) return null
    return countByKind(source, { kinds: ALL_EXPORTABLE_KINDS, selectedIds, zoneId: activeZoneId ?? null })
  }, [source, selectedIds, activeZoneId])

  const chosenKinds = useMemo<ExportableKind[]>(() => {
    switch (scopeMode) {
      case 'all':
        return ALL_EXPORTABLE_KINDS.filter((k) => allCounts[k] > 0)
      case 'byKind':
        return ALL_EXPORTABLE_KINDS.filter((k) => kindChoices.has(k) && allCounts[k] > 0)
      case 'selected':
        if (!selectedCounts) return []
        return ALL_EXPORTABLE_KINDS.filter((k) => selectedCounts[k] > 0)
    }
  }, [scopeMode, kindChoices, allCounts, selectedCounts])

  const chosenCount = useMemo(() => {
    const counts = scopeMode === 'selected' ? selectedCounts ?? allCounts : allCounts
    return chosenKinds.reduce((n, k) => n + counts[k], 0)
  }, [scopeMode, chosenKinds, allCounts, selectedCounts])

  const csvBlocked = format === 'csv' && chosenKinds.length > 1
  const nothingToExport = chosenCount === 0

  const activeScope: ExportScope = useMemo(
    () => ({
      kinds: chosenKinds,
      zoneId: activeZoneId ?? null,
      selectedIds: scopeMode === 'selected' ? selectedIds : undefined,
    }),
    [chosenKinds, activeZoneId, scopeMode, selectedIds],
  )

  const totalSelected = selectedCounts
    ? Object.values(selectedCounts).reduce((n, c) => n + c, 0)
    : 0

  const handleExport = () => {
    if (nothingToExport || csvBlocked) return
    downloadShapes(source, {
      format,
      scope: activeScope,
      includeConfig,
      includeTimestamps,
    })
    onOpenChange(false)
  }

  const toggleKind = (kind: ExportableKind) => {
    setKindChoices((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="w-4 h-4" />
            {t('exportDialog.title', { defaultValue: 'Export shapes' })}
          </DialogTitle>
          <DialogDescription>
            {t('exportDialog.subtitle', {
              defaultValue: 'Pick what to export and in which format. Files include full geometry and every config field so exports are lossless.',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Scope */}
          <section className="space-y-2">
            <SectionHeading
              icon={Database}
              title={t('exportDialog.scopeTitle', { defaultValue: 'Scope' })}
            />
            <div className="space-y-1.5">
              <ScopeRadio
                checked={scopeMode === 'all'}
                onCheck={() => setScopeMode('all')}
                label={t('exportDialog.scopeAll', { defaultValue: 'Everything in this warehouse' })}
                sublabel={t('exportDialog.scopeAllSub', {
                  defaultValue: '{{count}} shapes across {{kinds}} kinds',
                  count: ALL_EXPORTABLE_KINDS.reduce((n, k) => n + allCounts[k], 0),
                  kinds: ALL_EXPORTABLE_KINDS.filter((k) => allCounts[k] > 0).length,
                })}
              />
              <ScopeRadio
                checked={scopeMode === 'byKind'}
                onCheck={() => setScopeMode('byKind')}
                label={t('exportDialog.scopeByKind', { defaultValue: 'Only selected kinds' })}
                sublabel={t('exportDialog.scopeByKindSub', {
                  defaultValue: 'Pick which kinds to include',
                })}
              />
              {scopeMode === 'byKind' && (
                <div className="ms-6 mt-1 grid grid-cols-2 gap-x-3 gap-y-1 border border-border/60 rounded-md p-2 bg-muted/20">
                  {ALL_EXPORTABLE_KINDS.map((k) => {
                    const meta = KIND_META[k]
                    const Icon = meta.icon
                    const count = allCounts[k]
                    const disabled = count === 0
                    return (
                      <label
                        key={k}
                        className={cn(
                          'flex items-center gap-2 text-xs cursor-pointer select-none rounded px-1.5 py-1',
                          disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-accent/50',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={kindChoices.has(k)}
                          onChange={() => !disabled && toggleKind(k)}
                          disabled={disabled}
                          className="w-3.5 h-3.5"
                        />
                        <Icon className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                        <span className="flex-1 truncate">
                          {t(meta.labelKey, { defaultValue: meta.labelDefault })}
                        </span>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {count}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
              <ScopeRadio
                checked={scopeMode === 'selected'}
                disabled={totalSelected === 0}
                onCheck={() => setScopeMode('selected')}
                label={t('exportDialog.scopeSelected', { defaultValue: 'Selected shapes only' })}
                sublabel={
                  totalSelected === 0
                    ? t('exportDialog.scopeSelectedNone', { defaultValue: 'Nothing selected in the editor.' })
                    : t('exportDialog.scopeSelectedSub', {
                        defaultValue: '{{count}} shape(s) selected',
                        count: totalSelected,
                      })
                }
              />
            </div>
          </section>

          {/* Format */}
          <section className="space-y-2">
            <SectionHeading
              icon={FileText}
              title={t('exportDialog.formatTitle', { defaultValue: 'Format' })}
            />
            <div className="grid grid-cols-2 gap-2">
              {(['geojson', 'json', 'xlsx', 'csv'] as ExportFormat[]).map((f) => {
                const meta = FORMAT_META[f]
                const Icon = meta.icon
                const disabled = f === 'csv' && chosenKinds.length > 1
                const active = format === f
                return (
                  <button
                    type="button"
                    key={f}
                    onClick={() => !disabled && setFormat(f)}
                    disabled={disabled}
                    className={cn(
                      'text-start rounded-md border p-2 transition-colors',
                      active
                        ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
                        : 'border-border hover:bg-accent',
                      disabled && 'opacity-40 cursor-not-allowed',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium">
                        {t(meta.labelKey, { defaultValue: meta.labelDefault })}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
                      {t(meta.hintKey, { defaultValue: meta.hintDefault })}
                    </p>
                  </button>
                )
              })}
            </div>
          </section>

          {/* Options */}
          <section className="space-y-2">
            <SectionHeading
              icon={Waypoints}
              title={t('exportDialog.optionsTitle', { defaultValue: 'Options' })}
            />
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={includeConfig}
                onChange={(e) => setIncludeConfig(e.target.checked)}
                className="w-3.5 h-3.5 mt-0.5"
              />
              <span>
                {t('exportDialog.optIncludeConfig', {
                  defaultValue: 'Include full visual config (color, opacity, elevation, etc.)',
                })}
                <span className="block text-[10px] text-muted-foreground">
                  {t('exportDialog.optIncludeConfigHint', {
                    defaultValue: 'Off = only geometry and identity fields. Turn off for smaller files.',
                  })}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={includeTimestamps}
                onChange={(e) => setIncludeTimestamps(e.target.checked)}
                className="w-3.5 h-3.5 mt-0.5"
              />
              <span>
                {t('exportDialog.optIncludeTimestamps', {
                  defaultValue: 'Include createdAt / updatedAt',
                })}
              </span>
            </label>
          </section>

          {/* Preview */}
          <div
            className={cn(
              'rounded-md border p-2.5 text-xs flex items-start gap-2',
              csvBlocked || nothingToExport
                ? 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400'
                : 'border-border bg-muted/30 text-muted-foreground',
            )}
          >
            <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span className="flex-1">
              {csvBlocked
                ? t('exportDialog.previewCsvBlocked', {
                    defaultValue:
                      'CSV holds one kind per file. Switch to XLSX (one sheet per kind) or pick a single kind above.',
                  })
                : nothingToExport
                  ? t('exportDialog.previewNothing', {
                      defaultValue: 'Nothing to export with the current selection.',
                    })
                  : t('exportDialog.previewOk', {
                      defaultValue: 'Will export {{count}} shape(s) across {{kinds}} kind(s).',
                      count: chosenCount,
                      kinds: chosenKinds.length,
                    })}
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button onClick={handleExport} disabled={csvBlocked || nothingToExport}>
            <Download className="w-3.5 h-3.5 me-1.5" />
            {t('exportDialog.exportButton', { defaultValue: 'Export' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SectionHeading({ icon: Icon, title }: { icon: typeof MapPin; title: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="w-3.5 h-3.5 text-muted-foreground" />
      <span className="text-xs font-medium">{title}</span>
    </div>
  )
}

function ScopeRadio({
  checked,
  disabled,
  onCheck,
  label,
  sublabel,
}: {
  checked: boolean
  disabled?: boolean
  onCheck: () => void
  label: string
  sublabel?: string
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-2 rounded-md border p-2 cursor-pointer transition-colors',
        checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <input
        type="radio"
        checked={checked}
        onChange={() => !disabled && onCheck()}
        disabled={disabled}
        className="mt-0.5"
      />
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        {sublabel && (
          <span className="block text-[10px] text-muted-foreground">{sublabel}</span>
        )}
      </span>
    </label>
  )
}
