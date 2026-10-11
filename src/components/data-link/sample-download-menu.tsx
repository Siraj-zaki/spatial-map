/**
 * Dropdown that lets the user download a sample data file for a given
 * `DataSourceEntityKind`. Two record + one reference download group,
 * with an optional warehouse-schema targeting picker at the top.
 *
 * Sections:
 *   0. WAREHOUSE SCHEMA  — pick "Generic" or a specific warehouse.
 *                          Picking a warehouse tailors the sample:
 *                          - attribute_definitions become `custom.<key>` columns
 *                          - real shape names substitute into linked_shape_name
 *                          - real role vocab keys cycle into role columns (poly/circle)
 *                          - filename is tagged with the warehouse slug
 *   1. RECORDS          — CSV / XLSX / JSON / GeoJSON, pure data. What
 *                         you upload to the importer or serve from a REST endpoint.
 *   2. SCHEMA           — stand-alone JSON reference doc. NOT ingested.
 *
 * Data sources: `useSpatialZones` for the warehouse list,
 * `useSpatialAttributeDefinitions` for custom-field discovery, and
 * per-kind shape slices via `useSpatialStore` for real shape names.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BookText,
  Building2,
  Download,
  FileJson,
  FileSpreadsheet,
  FileText,
  Globe,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { DataSourceEntityKind, Zone } from '@/lib/db'
import {
  downloadSample,
  formatsFor,
  type SampleDownloadFormat,
} from '@/lib/data-link/sample-generators'
import {
  sampleSpecFor,
  type SampleFormat,
} from '@/lib/data-link/sample-records'
import {
  augmentSampleSpec,
  buildWarehouseSampleContext,
} from '@/lib/data-link/sample-augmentation'
import { useSpatialStore } from '@/lib/spatial-store'
import {
  useSpatialAttributeDefinitions,
  useSpatialZones,
} from '@/hooks/useSpatialShapes'

const RECORD_FORMAT_META: Record<
  SampleFormat,
  { labelKey: string; labelDefault: string; hintKey: string; hintDefault: string; icon: typeof FileText }
> = {
  csv: {
    labelKey: 'integrations.sampleFormatCsv',
    labelDefault: 'CSV (.csv)',
    hintKey: 'integrations.sampleFormatCsvHint',
    hintDefault: 'Header row + data rows. Upload as-is.',
    icon: FileText,
  },
  xlsx: {
    labelKey: 'integrations.sampleFormatXlsx',
    labelDefault: 'Excel (.xlsx)',
    hintKey: 'integrations.sampleFormatXlsxHint',
    hintDefault: 'Single sheet named "records". Upload as-is.',
    icon: FileSpreadsheet,
  },
  json: {
    labelKey: 'integrations.sampleFormatJson',
    labelDefault: 'JSON (.json)',
    hintKey: 'integrations.sampleFormatJsonHint',
    hintDefault: 'Bare array. Return this from your REST endpoint verbatim.',
    icon: FileJson,
  },
  geojson: {
    labelKey: 'integrations.sampleFormatGeojson',
    labelDefault: 'GeoJSON (.geojson)',
    hintKey: 'integrations.sampleFormatGeojsonHint',
    hintDefault: 'Standard FeatureCollection. Upload as-is.',
    icon: Globe,
  },
}

const GENERIC_WAREHOUSE_ID = 0 as const // sentinel — no warehouse targeting

export interface SampleDownloadMenuProps {
  kind: DataSourceEntityKind
  /** Visual style of the trigger button. Default: `outline`. */
  variant?: 'default' | 'outline' | 'ghost' | 'link'
  /** Size of the trigger button. Default: `sm`. */
  size?: 'default' | 'sm' | 'lg' | 'icon'
  /** Compact mode — hides the label, keeps the icon only. */
  iconOnly?: boolean
  /** Extra classNames for the trigger. */
  className?: string
}

export function SampleDownloadMenu({
  kind,
  variant = 'outline',
  size = 'sm',
  iconOnly = false,
  className,
}: SampleDownloadMenuProps) {
  const { t } = useTranslation()

  // Warehouse picker state. 0 = generic (no targeting).
  const [warehouseId, setWarehouseId] = useState<number>(GENERIC_WAREHOUSE_ID)

  // The spatial store is only auto-loaded when the user visits the map
  // editor (`/create-grids`) or the viewer (`/view`) — neither of
  // which is where the sample menu typically lives. Trigger a
  // lightweight load on first mount so `useSpatialZones` returns real
  // warehouses instead of an empty array on `/integrations`. loadKind
  // is idempotent + cached so remounts don't refetch.
  useEffect(() => {
    const store = useSpatialStore.getState()
    if (store.zones.length === 0) void store.loadKind('zones')
    if (store.attributeDefinitions.length === 0) {
      void store.loadKind('attribute-definitions')
    }
  }, [])

  // When a specific warehouse is picked, pull its shapes so real names
  // populate the linked_shape_name column in the sample. Cheap:
  // loadKind is a plain fetch that no-ops when the slice is already
  // populated, and each kind is per-tenant so switching warehouses
  // doesn't re-request.
  useEffect(() => {
    if (warehouseId === GENERIC_WAREHOUSE_ID) return
    const store = useSpatialStore.getState()
    const shapeKinds = [
      'polygons',
      'circles',
      'markers',
      'lines',
      'models',
      'stairs',
      'images',
      'routes',
      'text-labels',
      'image-planes',
      'grids',
    ] as const
    for (const k of shapeKinds) {
      // Skip when a fetch is already in flight so an eager remount
      // doesn't stack duplicate requests.
      if (store.isLoading[k]) continue
      void store.loadKind(k)
    }
  }, [warehouseId])

  const { data: warehouses = [] } = useSpatialZones()
  const { data: allAttributes = [] } = useSpatialAttributeDefinitions()
  const allShapeNames = useAllShapeNamesForWarehouse(warehouseId)

  const selectedWarehouse: Zone | null = useMemo(() => {
    if (warehouseId === GENERIC_WAREHOUSE_ID) return null
    return warehouses.find((w) => w.id === warehouseId) ?? null
  }, [warehouseId, warehouses])

  // Build the (possibly-augmented) spec once per render.
  const spec = useMemo(() => {
    const base = sampleSpecFor(kind)
    if (!selectedWarehouse) return base
    const ctx = buildWarehouseSampleContext({
      warehouse: selectedWarehouse,
      kind,
      allAttributes,
      allShapeNames,
    })
    return augmentSampleSpec(base, ctx)
  }, [kind, selectedWarehouse, allAttributes, allShapeNames])

  const formats = formatsFor(spec)
  const label = t('integrations.sampleDownloadButton', {
    defaultValue: 'Download sample',
  })

  const startDownload = (fmt: SampleDownloadFormat) => {
    // Defer to next tick so the dropdown-close animation doesn't race
    // with the download click.
    setTimeout(() => downloadSample(spec, fmt), 0)
  }

  // For the "using X schema" hint — signal empty augmentation so users
  // don't wonder why picking a warehouse changed nothing.
  const augmentationSummary = useMemo(() => {
    if (!selectedWarehouse) return null
    const customAdded = spec.fields.filter((f) => f.name.startsWith('custom.')).length
    const rolePresent = spec.fields.some((f) => f.name === 'role') && (kind === 'polygon' || kind === 'circle')
    const shapeSubs = allShapeNames.length > 0
    const parts: string[] = []
    if (customAdded > 0) parts.push(`${customAdded} custom field(s)`)
    if (rolePresent) parts.push('role vocabulary')
    if (shapeSubs) parts.push('real shape names')
    if (parts.length === 0) return { empty: true, text: '' }
    return { empty: false, text: parts.join(' · ') }
  }, [selectedWarehouse, spec, kind, allShapeNames])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={className}
          title={t('integrations.sampleDownloadTooltip', {
            defaultValue:
              'Download a records file (CSV / XLSX / JSON / GeoJSON) ready to upload or serve from your REST endpoint. Schema reference is a separate download.',
          })}
          aria-label={label}
        >
          <Download className="w-3.5 h-3.5" />
          {!iconOnly && <span className="ms-1.5">{label}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-xs font-medium">
            {t('integrations.sampleDownloadHeading', {
              defaultValue: 'Sample for {{label}}',
              label: labelForKind(kind, t),
            })}
          </span>
          <span className="text-[10px] font-normal text-muted-foreground">
            {spec.headline}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Warehouse schema picker */}
        <div className="px-2 py-1.5">
          <label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium flex items-center gap-1">
            <Building2 className="w-3 h-3" />
            {t('integrations.sampleWarehouseSection', { defaultValue: 'Warehouse schema' })}
          </label>
          <select
            value={warehouseId}
            onChange={(e) => setWarehouseId(Number(e.target.value))}
            className="mt-1 w-full h-7 rounded border border-border bg-background px-2 text-xs"
          >
            <option value={GENERIC_WAREHOUSE_ID}>
              {t('integrations.sampleWarehouseGeneric', { defaultValue: 'Generic (Schiphol demo)' })}
            </option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {selectedWarehouse && augmentationSummary && (
            <p className="mt-1 text-[10px] text-muted-foreground leading-snug">
              {augmentationSummary.empty
                ? t('integrations.sampleWarehouseNoCustom', {
                    defaultValue:
                      'No custom fields, roles, or shapes defined yet — using the generic schema tagged with this warehouse name.',
                  })
                : t('integrations.sampleWarehouseUsing', {
                    defaultValue: 'Tailored using: {{parts}}.',
                    parts: augmentationSummary.text,
                  })}
            </p>
          )}
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          {t('integrations.sampleRecordsSection', { defaultValue: 'Records — upload / REST payload' })}
        </DropdownMenuLabel>
        {formats.map((fmt) => {
          const meta = RECORD_FORMAT_META[fmt]
          const Icon = meta.icon
          return (
            <DropdownMenuItem
              key={fmt}
              onSelect={() => startDownload(fmt)}
              className="flex-col items-start gap-0.5 py-2"
            >
              <div className="flex items-center gap-2 w-full">
                <Icon className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="text-xs font-medium">
                  {t(meta.labelKey, { defaultValue: meta.labelDefault })}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground ps-5 leading-snug">
                {t(meta.hintKey, { defaultValue: meta.hintDefault })}
              </span>
            </DropdownMenuItem>
          )
        })}

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          {t('integrations.sampleSchemaSection', { defaultValue: 'Reference — not for upload' })}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => startDownload('schema')}
          className="flex-col items-start gap-0.5 py-2"
        >
          <div className="flex items-center gap-2 w-full">
            <BookText className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
            <span className="text-xs font-medium">
              {t('integrations.sampleSchemaFormat', { defaultValue: 'Schema doc (.json)' })}
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground ps-5 leading-snug">
            {t('integrations.sampleSchemaHint', {
              defaultValue: 'Field names, types, required flags, enum values. For your pipeline docs — don\'t upload this.',
            })}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// -------------------------------------------------------- helpers

/**
 * Pull every named shape belonging to the target warehouse from the
 * spatial store, deduped. Falls back to an empty array while the store
 * is still hydrating or when a Generic warehouse (id 0) is selected.
 */
function useAllShapeNamesForWarehouse(warehouseId: number): readonly string[] {
  const polygons = useSpatialStore((s) => s.polygons)
  const circles = useSpatialStore((s) => s.circles)
  const markers = useSpatialStore((s) => s.markers)
  const lines = useSpatialStore((s) => s.lines)
  const models = useSpatialStore((s) => s.models)
  const stairs = useSpatialStore((s) => s.stairs)
  const images = useSpatialStore((s) => s.images)
  const grids = useSpatialStore((s) => s.grids)
  const routes = useSpatialStore((s) => s.routes)
  const textLabels = useSpatialStore((s) => s.textLabels)
  const imagePlanes = useSpatialStore((s) => s.imagePlanes)
  return useMemo(() => {
    if (warehouseId === GENERIC_WAREHOUSE_ID) return []
    const seen = new Set<string>()
    const push = (arr: readonly { name?: string; zoneId?: number }[] | undefined) => {
      if (!arr) return
      for (const item of arr) {
        if (item.zoneId !== warehouseId) continue
        const nm = (item.name ?? '').trim()
        if (nm.length === 0) continue
        seen.add(nm)
      }
    }
    push(polygons)
    push(circles)
    push(markers)
    push(lines)
    push(models)
    push(stairs)
    push(images)
    push(grids)
    push(routes)
    push(textLabels)
    push(imagePlanes)
    return [...seen]
  }, [
    warehouseId,
    polygons,
    circles,
    markers,
    lines,
    models,
    stairs,
    images,
    grids,
    routes,
    textLabels,
    imagePlanes,
  ])
}

// User-facing labels for each kind. Falls through to the raw kind if
// no i18n key is defined so a new kind never renders blank.
function labelForKind(
  kind: DataSourceEntityKind,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const defaults: Record<DataSourceEntityKind, string> = {
    polygon: 'Polygon / area',
    circle: 'Circle',
    marker: 'Marker / POI',
    asset: 'Asset (mobile)',
    camera: 'Camera',
    sensor: 'Sensor',
    shipment: 'Shipment',
    'rfid-tag': 'RFID tag',
    'rack-cell': 'Rack cell (bin)',
    streaming: 'Streaming / batch replay',
  }
  return t(`integrations.entityKind_${kind.replace('-', '_')}`, {
    defaultValue: defaults[kind],
  })
}
