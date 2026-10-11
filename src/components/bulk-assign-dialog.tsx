import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Box,
  Check,
  ChevronDown,
  Circle as CircleIcon,
  DoorOpen,
  FolderInput,
  Loader2,
  Footprints,
  Grid3X3,
  Type,
  Image as ImageIcon,
  MapPin,
  Pentagon,
  Search,
  Spline,
  Tag,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast-store'
import type {
  CircleShape,
  ImagePlaneShape,
  ImageShape,
  LineShape,
  MarkerShape,
  ModelShape,
  PolygonShape,
  StairShape,
  TextLabelShape,
} from '@/lib/shapes'
import type { DoorShape } from '@/lib/door/types'
import type { Grid, Zone } from '@/lib/db'

/**
 * Patch shape: each field can be `undefined` (skip — don't change this
 * dimension) or `null` (clear it) or a number (assign that id).
 */
export interface BulkAssignPatch {
  zoneId?: number | null
  floorPlanId?: number | null
}

/**
 * What the user picked in the dialog's checkbox list — a Set of ids
 * per shape kind. The host iterates and writes the patch to each.
 * Warehouses aren't included: they're the destination dimension, not
 * assignable items. Images ARE assignable — an image can live inside
 * a warehouse and can even be pinned to a floor plan (multi-storey
 * stacks) — but the apply path filters out any self-referential
 * image → floor-plan assignment.
 */
export interface BulkAssignSelection {
  grid: ReadonlySet<number>
  marker: ReadonlySet<number>
  circle: ReadonlySet<number>
  polygon: ReadonlySet<number>
  line: ReadonlySet<number>
  model: ReadonlySet<number>
  stair: ReadonlySet<number>
  text: ReadonlySet<number>
  door: ReadonlySet<number>
  image: ReadonlySet<number>
  imagePlane: ReadonlySet<number>
}

interface BulkAssignDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Initial selection from the map / list (seeds the dialog's local state). */
  initialSelection?: Partial<{
    grid: ReadonlySet<number>
    marker: ReadonlySet<number>
    circle: ReadonlySet<number>
    polygon: ReadonlySet<number>
    line: ReadonlySet<number>
    model: ReadonlySet<number>
    stair: ReadonlySet<number>
    text: ReadonlySet<number>
    door: ReadonlySet<number>
    image: ReadonlySet<number>
    imagePlane: ReadonlySet<number>
  }>
  // Full shape lists for the picker UI. Already scoped to the active
  // warehouse + floor-plan visibility by the host.
  grids: ReadonlyArray<Grid>
  markers: ReadonlyArray<MarkerShape>
  circles: ReadonlyArray<CircleShape>
  polygons: ReadonlyArray<PolygonShape>
  lines: ReadonlyArray<LineShape>
  /** Floor-plan candidates + assignable items — images populate both
   *  the "Floor plan" destination dropdown AND the assignable list
   *  (they can themselves be pinned to a warehouse or, in multi-storey
   *  stacks, to another floor plan). Self-referential assignments are
   *  filtered out on Apply. */
  images: ReadonlyArray<ImageShape>
  models: ReadonlyArray<ModelShape>
  stairs: ReadonlyArray<StairShape>
  textLabels: ReadonlyArray<TextLabelShape>
  doors: ReadonlyArray<DoorShape>
  imagePlanes: ReadonlyArray<ImagePlaneShape>
  // Target dimensions.
  zones: ReadonlyArray<Zone>
  /** Apply: write `patch` to every id in `selection`. */
  onApply: (
    selection: BulkAssignSelection,
    patch: BulkAssignPatch,
  ) => Promise<void> | void
}

// Kinds that can be ASSIGNED to a warehouse / floor plan. Warehouses
// stay excluded — they're the destination dimension, not a shape.
// Images are IN because they can be moved between warehouses AND
// pinned to another floor plan (a mezzanine over a ground floor); the
// self-assignment case (image → its own floor plan) is filtered out
// in `apply` below.
type Kind =
  | 'grid'
  | 'marker'
  | 'circle'
  | 'polygon'
  | 'line'
  | 'model'
  | 'stair'
  | 'text'
  | 'door'
  | 'image'
  | 'imagePlane'

interface KindMeta {
  kind: Kind
  labelKey: string
  defaultLabel: string
  icon: React.ComponentType<{ className?: string }>
}

const KIND_META: KindMeta[] = [
  { kind: 'grid', labelKey: 'bulkAssign.kindGrids', defaultLabel: 'Racks', icon: Grid3X3 },
  { kind: 'marker', labelKey: 'bulkAssign.kindMarkers', defaultLabel: 'Assets', icon: MapPin },
  { kind: 'circle', labelKey: 'bulkAssign.kindCircles', defaultLabel: 'Circles', icon: CircleIcon },
  { kind: 'polygon', labelKey: 'bulkAssign.kindPolygons', defaultLabel: 'Areas', icon: Pentagon },
  { kind: 'line', labelKey: 'bulkAssign.kindLines', defaultLabel: 'Aisles', icon: Spline },
  { kind: 'model', labelKey: 'bulkAssign.kindModels', defaultLabel: '3D models', icon: Box },
  { kind: 'stair', labelKey: 'bulkAssign.kindStairs', defaultLabel: 'Stairs', icon: Footprints },
  { kind: 'door', labelKey: 'bulkAssign.kindDoors', defaultLabel: 'Doors', icon: DoorOpen },
  { kind: 'text', labelKey: 'bulkAssign.kindTextLabels', defaultLabel: 'Text labels', icon: Type },
  { kind: 'image', labelKey: 'bulkAssign.kindImages', defaultLabel: 'Floor plans', icon: ImageIcon },
  { kind: 'imagePlane', labelKey: 'bulkAssign.kindImagePlanes', defaultLabel: 'Image planes', icon: ImageIcon },
]

/**
 * Bulk-assign dialog with an in-modal selectable list. Multi-select
 * across shape kinds (which the sidebar can't do) happens here — the
 * user filters / checks / unchecks items in this dialog, picks a
 * warehouse and/or floor plan to apply, then clicks Apply.
 *
 * `initialSelection` lets the host pre-check items the user already
 * selected on the map or in the sidebar, but the dialog's selection
 * state is otherwise self-contained.
 */
export function BulkAssignDialog({
  open,
  onOpenChange,
  initialSelection,
  grids,
  markers,
  circles,
  polygons,
  lines,
  images,
  models,
  stairs,
  textLabels,
  doors,
  imagePlanes,
  zones,
  onApply,
}: BulkAssignDialogProps) {
  const { t } = useTranslation()

  // ---- Local selection state ---------------------------------------------
  type SelectionState = Record<Kind, Set<number>>
  const [picked, setPicked] = useState<SelectionState>(() => ({
    grid: new Set(),
    marker: new Set(),
    circle: new Set(),
    polygon: new Set(),
    line: new Set(),
    model: new Set(),
    stair: new Set(),
    text: new Set(),
    door: new Set(),
    image: new Set(),
    imagePlane: new Set(),
  }))

  // ---- Picker tri-state --------------------------------------------------
  type Choice = 'skip' | 'clear' | number
  const [zoneChoice, setZoneChoice] = useState<Choice>('skip')
  const [floorChoice, setFloorChoice] = useState<Choice>('skip')
  const [query, setQuery] = useState('')

  // Re-seed all local state whenever the dialog opens — `initialSelection`
  // may have changed since the last open, and choices / query should
  // start fresh each session.
  useEffect(() => {
    if (!open) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setPicked({
      grid: new Set(initialSelection?.grid ?? []),
      marker: new Set(initialSelection?.marker ?? []),
      circle: new Set(initialSelection?.circle ?? []),
      polygon: new Set(initialSelection?.polygon ?? []),
      line: new Set(initialSelection?.line ?? []),
      model: new Set(initialSelection?.model ?? []),
      stair: new Set(initialSelection?.stair ?? []),
      text: new Set(initialSelection?.text ?? []),
      door: new Set(initialSelection?.door ?? []),
      image: new Set(initialSelection?.image ?? []),
      imagePlane: new Set(initialSelection?.imagePlane ?? []),
    })
    setZoneChoice('skip')
    setFloorChoice('skip')
    setQuery('')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, initialSelection])

  // ---- Derived: items grouped by kind, filtered by query -----------------
  type Item = {
    kind: Kind
    id: number
    name: string
    color: string | null
    zoneId?: number
    floorPlanId?: number
  }
  const itemsByKind = useMemo<Record<Kind, Item[]>>(() => {
    const q = query.trim().toLowerCase()
    const matches = (name: string) => q === '' || name.toLowerCase().includes(q)
    return {
      grid: grids
        .filter((g) => matches(g.name))
        .map((g) => ({
          kind: 'grid' as const,
          id: g.id!,
          name: g.name,
          color: g.config.color,
          zoneId: g.zoneId,
          floorPlanId: g.floorPlanId,
        })),
      marker: markers
        .filter((m) => matches(m.name))
        .map((m) => ({
          kind: 'marker' as const,
          id: m.id!,
          name: m.name,
          color: m.config.iconColor,
          zoneId: m.zoneId,
          floorPlanId: m.floorPlanId,
        })),
      circle: circles
        .filter((c) => matches(c.name))
        .map((c) => ({
          kind: 'circle' as const,
          id: c.id!,
          name: c.name,
          color: c.config.color,
          zoneId: c.zoneId,
          floorPlanId: c.floorPlanId,
        })),
      polygon: polygons
        .filter((p) => matches(p.name))
        .map((p) => ({
          kind: 'polygon' as const,
          id: p.id!,
          name: p.name,
          color: p.config.color,
          zoneId: p.zoneId,
          floorPlanId: p.floorPlanId,
        })),
      line: lines
        .filter((l) => matches(l.name))
        .map((l) => ({
          kind: 'line' as const,
          id: l.id!,
          name: l.name,
          color: l.config.color,
          zoneId: l.zoneId,
          floorPlanId: l.floorPlanId,
        })),
      model: models
        .filter((m) => matches(m.name))
        .map((m) => ({
          kind: 'model' as const,
          id: m.id!,
          name: m.name,
          color: null,
          zoneId: m.zoneId,
          floorPlanId: m.floorPlanId,
        })),
      stair: stairs
        .filter((s) => matches(s.name))
        .map((s) => ({
          kind: 'stair' as const,
          id: s.id!,
          name: s.name,
          color: s.config.color,
          zoneId: s.zoneId,
          floorPlanId: s.floorPlanId,
        })),
      text: textLabels
        .filter((tl) => matches(tl.name))
        .map((tl) => ({
          kind: 'text' as const,
          id: tl.id!,
          name: tl.name,
          color: tl.config.color,
          zoneId: tl.zoneId,
          floorPlanId: tl.floorPlanId,
        })),
      door: doors
        .filter((d) => matches(d.name))
        .map((d) => ({
          kind: 'door' as const,
          id: d.id!,
          name: d.name,
          // Doors have no top-level color — use the frame color from
          // their config so the swatch matches how the shape reads
          // on the map.
          color: d.config.frameColor ?? null,
          zoneId: d.zoneId,
          floorPlanId: d.floorPlanId,
        })),
      image: images
        .filter((img) => matches(img.name))
        .map((img) => ({
          kind: 'image' as const,
          id: img.id!,
          name: img.name,
          color: null,
          zoneId: img.zoneId,
          floorPlanId: img.floorPlanId,
        })),
      imagePlane: imagePlanes
        .filter((ip) => matches(ip.name))
        .map((ip) => ({
          kind: 'imagePlane' as const,
          id: ip.id!,
          name: ip.name,
          color: null,
          zoneId: ip.zoneId,
          floorPlanId: ip.floorPlanId,
        })),
    }
  }, [grids, markers, circles, polygons, lines, models, stairs, textLabels, doors, images, imagePlanes, query])

  const totalAvailable = useMemo(
    () =>
      itemsByKind.grid.length +
      itemsByKind.marker.length +
      itemsByKind.circle.length +
      itemsByKind.polygon.length +
      itemsByKind.line.length +
      itemsByKind.model.length +
      itemsByKind.stair.length +
      itemsByKind.text.length +
      itemsByKind.door.length +
      itemsByKind.image.length +
      itemsByKind.imagePlane.length,
    [itemsByKind],
  )
  const totalPicked = useMemo(
    () =>
      picked.grid.size +
      picked.marker.size +
      picked.circle.size +
      picked.polygon.size +
      picked.line.size +
      picked.model.size +
      picked.stair.size +
      picked.text.size +
      picked.door.size +
      picked.image.size +
      picked.imagePlane.size,
    [picked],
  )

  const togglePick = (kind: Kind, id: number) => {
    setPicked((prev) => {
      const next = { ...prev, [kind]: new Set(prev[kind]) }
      if (next[kind].has(id)) next[kind].delete(id)
      else next[kind].add(id)
      return next
    })
  }
  const selectAll = () => {
    setPicked({
      grid: new Set(itemsByKind.grid.map((x) => x.id)),
      marker: new Set(itemsByKind.marker.map((x) => x.id)),
      circle: new Set(itemsByKind.circle.map((x) => x.id)),
      polygon: new Set(itemsByKind.polygon.map((x) => x.id)),
      line: new Set(itemsByKind.line.map((x) => x.id)),
      model: new Set(itemsByKind.model.map((x) => x.id)),
      stair: new Set(itemsByKind.stair.map((x) => x.id)),
      text: new Set(itemsByKind.text.map((x) => x.id)),
      door: new Set(itemsByKind.door.map((x) => x.id)),
      image: new Set(itemsByKind.image.map((x) => x.id)),
      imagePlane: new Set(itemsByKind.imagePlane.map((x) => x.id)),
    })
  }
  const clearAll = () => {
    setPicked({
      grid: new Set(),
      marker: new Set(),
      circle: new Set(),
      polygon: new Set(),
      line: new Set(),
      model: new Set(),
      stair: new Set(),
      text: new Set(),
      door: new Set(),
      image: new Set(),
      imagePlane: new Set(),
    })
  }
  const toggleKindAll = (kind: Kind) => {
    const visible = itemsByKind[kind]
    const allSelected = visible.length > 0 && visible.every((x) => picked[kind].has(x.id))
    setPicked((prev) => {
      const next = { ...prev, [kind]: new Set(prev[kind]) }
      if (allSelected) {
        for (const x of visible) next[kind].delete(x.id)
      } else {
        for (const x of visible) next[kind].add(x.id)
      }
      return next
    })
  }

  // Apply runs once at a time; the button spins and can't be pressed twice.
  const [applying, setApplying] = useState(false)
  const apply = async () => {
    if (applying) return
    const patch: BulkAssignPatch = {}
    if (zoneChoice === 'clear') patch.zoneId = null
    else if (typeof zoneChoice === 'number') patch.zoneId = zoneChoice
    if (floorChoice === 'clear') patch.floorPlanId = null
    else if (typeof floorChoice === 'number') patch.floorPlanId = floorChoice
    if (patch.zoneId === undefined && patch.floorPlanId === undefined) {
      onOpenChange(false)
      return
    }
    // Self-referential floor plan assignment guard: if the user is
    // assigning images and picked the same image as the destination
    // floor plan, drop it from the image selection so we don't try
    // to set an image's `floorPlanId` to its own id. Zone assignment
    // is fine — an image belongs in a warehouse regardless.
    let selectionToApply: BulkAssignSelection = picked
    if (typeof patch.floorPlanId === 'number' && picked.image.has(patch.floorPlanId)) {
      const cleanedImages = new Set(picked.image)
      cleanedImages.delete(patch.floorPlanId)
      selectionToApply = { ...picked, image: cleanedImages }
    }
    setApplying(true)
    try {
      await onApply(selectionToApply, patch)
      onOpenChange(false)
    } catch (err) {
      toast.error(t('bulkAssign.failed', { defaultValue: 'Couldn’t apply the changes — try again.' }), {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-[95vw] p-0 gap-0 overflow-hidden">
        <div className="flex flex-col max-h-[85dvh]">
          {/* Header — fixed height so the dialog's flex layout never
              tries to squeeze it into the list area. */}
          <DialogHeader className="flex flex-row items-center gap-3 px-5 py-4 border-b space-y-0 flex-shrink-0">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <FolderInput className="w-4 h-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="font-semibold text-base leading-tight">
                {t('bulkAssign.title', { defaultValue: 'Assign facility & floor plan' })}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground leading-snug mt-0.5">
                {t('bulkAssign.subtitle', {
                  defaultValue:
                    'Pick the items you want to update, then choose a destination below.',
                })}
              </DialogDescription>
            </div>
          </DialogHeader>

          {/* Search + master controls — also flex-shrink-0 so the list
              below is the only thing that scrolls. */}
          <div className="px-5 py-3 border-b bg-muted/30 space-y-2.5 flex-shrink-0">
            <div className="relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('bulkAssign.searchPlaceholder', {
                  defaultValue: 'Filter items by name…',
                })}
                className="h-9 text-sm ps-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('bulkAssign.pickedOfTotal', {
                  defaultValue: '{{picked}} of {{total}} selected',
                  picked: totalPicked,
                  total: totalAvailable,
                })}
              </span>
              <div className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={selectAll}
                disabled={totalAvailable === 0}
              >
                {t('bulkAssign.selectAll', { defaultValue: 'Select all' })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={clearAll}
                disabled={totalPicked === 0}
              >
                {t('bulkAssign.clear', { defaultValue: 'Clear' })}
              </Button>
            </div>
          </div>

          {/* Scrollable list, grouped by kind */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-background">
            {totalAvailable === 0 && (
              <div className="text-center text-sm text-muted-foreground py-16">
                {t('bulkAssign.noItems', {
                  defaultValue: 'No items match the current filter.',
                })}
              </div>
            )}
            {KIND_META.map((meta) => {
              const visible = itemsByKind[meta.kind]
              if (visible.length === 0) return null
              const allChecked = visible.every((x) => picked[meta.kind].has(x.id))
              const someChecked =
                !allChecked && visible.some((x) => picked[meta.kind].has(x.id))
              const Icon = meta.icon
              const pickedInKind = picked[meta.kind].size
              return (
                <div
                  key={meta.kind}
                  className="border rounded-lg bg-card overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => toggleKindAll(meta.kind)}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-start hover:bg-accent/40 transition-colors bg-muted/30 border-b"
                  >
                    <Checkbox checked={allChecked} indeterminate={someChecked} />
                    <Icon className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {t(meta.labelKey, { defaultValue: meta.defaultLabel })}
                    </span>
                    <span
                      className={cn(
                        'ms-auto text-xs tabular-nums px-2 py-0.5 rounded-full',
                        pickedInKind > 0
                          ? 'bg-primary/15 text-primary font-medium'
                          : 'text-muted-foreground',
                      )}
                    >
                      {pickedInKind > 0
                        ? `${pickedInKind} / ${visible.length}`
                        : `${visible.length}`}
                    </span>
                  </button>
                  <ul className="divide-y">
                    {visible.map((item) => {
                      const isChecked = picked[meta.kind].has(item.id)
                      const zone = zones.find((z) => z.id === item.zoneId)
                      const floorImg = images.find((i) => i.id === item.floorPlanId)
                      const hasMeta = Boolean(zone || floorImg)
                      return (
                        <li
                          key={item.id}
                          className={cn(
                            'flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-accent/40 transition-colors',
                            isChecked && 'bg-primary/5',
                          )}
                          onClick={() => togglePick(meta.kind, item.id)}
                        >
                          <Checkbox checked={isChecked} />
                          {item.color && (
                            <span
                              className="flex-shrink-0 w-3 h-3 rounded-sm border"
                              style={{ backgroundColor: item.color }}
                              aria-hidden="true"
                            />
                          )}
                          {/* Two-line cell: name on top, current
                              assignment on a muted subtitle row so
                              long warehouse / floor-plan names don't
                              get clipped to gibberish on a single line. */}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm truncate leading-tight">
                              {item.name}
                            </div>
                            {hasMeta && (
                              <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground leading-tight">
                                {zone && (
                                  <span className="inline-flex items-center gap-1 truncate">
                                    <span
                                      className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
                                      style={{ backgroundColor: zone.color }}
                                      aria-hidden="true"
                                    />
                                    <span className="truncate">{zone.name}</span>
                                  </span>
                                )}
                                {zone && floorImg && (
                                  <span className="opacity-40">·</span>
                                )}
                                {floorImg && (
                                  <span className="inline-flex items-center gap-1 truncate">
                                    <ImageIcon className="flex-shrink-0 w-2.5 h-2.5" />
                                    <span className="truncate">{floorImg.name}</span>
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </div>

          {/* Target pickers — labeled with a clear section title so the
              user understands these are the "Assign TO" destinations,
              not part of the item list above. Sticky-feeling row in
              muted background. `flex-shrink-0` so it stays visible
              even when the dialog gets squeezed. */}
          <div className="border-t bg-muted/40 px-5 py-4 flex-shrink-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              {t('bulkAssign.applyTo', { defaultValue: 'Apply to selected items' })}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <PickerRow
                icon={Tag}
                label={t('bulkAssign.warehouse', { defaultValue: 'Facility' })}
                choice={zoneChoice}
                onChoice={setZoneChoice}
                skipLabel={t('bulkAssign.noChange', { defaultValue: "Don't change" })}
                clearLabel={t('bulkAssign.unassign', { defaultValue: 'Unassign' })}
                items={zones.map((z) => ({
                  id: z.id!,
                  label: z.name,
                  color: z.color,
                }))}
                emptyLabel={t('bulkAssign.zoneEmpty', {
                  defaultValue: 'No facilities yet',
                })}
              />
              <PickerRow
                icon={ImageIcon}
                label={t('bulkAssign.floorPlan', { defaultValue: 'Floor plan' })}
                choice={floorChoice}
                onChoice={setFloorChoice}
                skipLabel={t('bulkAssign.noChange', { defaultValue: "Don't change" })}
                clearLabel={t('bulkAssign.unassign', { defaultValue: 'Unassign' })}
                items={images.map((img) => ({
                  id: img.id!,
                  label: img.name,
                  color: null,
                }))}
                emptyLabel={t('bulkAssign.floorPlanEmpty', {
                  defaultValue: 'No floor plans yet',
                })}
              />
            </div>
          </div>

          {/* Footer — left-aligned status hint, right-aligned actions.
              Apply uses an explicit inline width + light visual treatment
              so its label stays readable in the disabled state instead
              of dimming to a near-invisible square. */}
          <div className="px-5 py-4 border-t flex items-center justify-between gap-3 bg-background flex-shrink-0">
            <div className="text-xs text-muted-foreground min-w-0 truncate">
              {totalPicked === 0
                ? t('bulkAssign.footerHintEmpty', {
                    defaultValue: 'Pick items above to enable Apply',
                  })
                : zoneChoice === 'skip' && floorChoice === 'skip'
                  ? t('bulkAssign.footerHintNoTarget', {
                      defaultValue: 'Choose a facility or floor plan to apply',
                    })
                  : t('bulkAssign.footerHintReady', {
                      defaultValue: `Ready to apply to ${totalPicked} ${totalPicked === 1 ? 'item' : 'items'}`,
                      count: totalPicked,
                    })}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                style={{ minWidth: 96 }}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button
                onClick={() => void apply()}
                disabled={
                  applying ||
                  totalPicked === 0 ||
                  (zoneChoice === 'skip' && floorChoice === 'skip')
                }
                aria-busy={applying}
                style={{ minWidth: 180 }}
              >
                {applying ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <Check className="w-4 h-4" />}
                <span>
                  {totalPicked === 0
                    ? t('bulkAssign.applyEmpty', { defaultValue: 'Apply' })
                    : t('bulkAssign.apply', {
                        defaultValue: `Apply to ${totalPicked} ${totalPicked === 1 ? 'item' : 'items'}`,
                        count: totalPicked,
                      })}
                </span>
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---- Inline checkbox -----------------------------------------------------
// The project has no shared Checkbox primitive, and the only place that
// needs one is this dialog. Lightweight inline implementation — visual-
// only, accessibility handled by the parent button / li containing it.

function Checkbox({
  checked,
  indeterminate,
}: {
  checked: boolean
  indeterminate?: boolean
}) {
  return (
    <span
      className={cn(
        'flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors',
        checked
          ? 'bg-primary border-primary text-primary-foreground'
          : indeterminate
            ? 'bg-primary/30 border-primary'
            : 'border-input bg-background',
      )}
      aria-hidden="true"
    >
      {checked && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
      {!checked && indeterminate && (
        <span className="w-1.5 h-0.5 bg-primary-foreground rounded-full" />
      )}
    </span>
  )
}

// ---- Picker row ---------------------------------------------------------
// Same tri-state dropdown as before — extracted into its own component
// because the dialog needs two of them (warehouse + floor plan) with
// identical visual + interaction behaviour.

interface PickerItem {
  id: number
  label: string
  color: string | null
}

function PickerRow({
  icon: Icon,
  label,
  choice,
  onChoice,
  skipLabel,
  clearLabel,
  items,
  emptyLabel,
  disabled,
  disabledHint,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  choice: 'skip' | 'clear' | number
  onChoice: (next: 'skip' | 'clear' | number) => void
  skipLabel: string
  clearLabel: string
  items: ReadonlyArray<PickerItem>
  emptyLabel: string
  disabled?: boolean
  disabledHint?: string
}) {
  const [open, setOpen] = useState(false)
  const current = typeof choice === 'number' ? items.find((i) => i.id === choice) : null
  const display =
    choice === 'skip' ? skipLabel : choice === 'clear' ? clearLabel : current?.label ?? skipLabel

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (!target) return
      const rootEl = document.querySelector(`[data-picker-row-id="${label}"]`)
      if (rootEl && !rootEl.contains(target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, label])

  return (
    <div className="space-y-1.5" data-picker-row-id={label}>
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
        <Label className="text-xs">{label}</Label>
      </div>
      <div className="relative">
        <button
          type="button"
          onClick={() => !disabled && setOpen((v) => !v)}
          disabled={disabled}
          className={cn(
            'w-full flex items-center gap-2 h-9 px-3 rounded-md border bg-background text-sm transition-colors',
            !disabled && 'hover:bg-accent',
            disabled && 'opacity-50 cursor-not-allowed',
            choice === 'skip' && 'text-muted-foreground',
          )}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={disabled ? disabledHint : undefined}
        >
          {current?.color && (
            <span
              className="flex-shrink-0 w-2.5 h-2.5 rounded-full border"
              style={{ backgroundColor: current.color }}
              aria-hidden="true"
            />
          )}
          <span className="flex-1 text-start truncate">{display}</span>
          <ChevronDown className="w-4 h-4 opacity-60 flex-shrink-0" />
        </button>
        {open && !disabled && (
          <div
            className="absolute start-0 end-0 bottom-full mb-1 z-30 max-h-[200px] overflow-y-auto bg-popover border rounded-md shadow-lg p-1 text-xs"
            role="listbox"
          >
            <PickerOption
              active={choice === 'skip'}
              onClick={() => {
                onChoice('skip')
                setOpen(false)
              }}
              dim
            >
              {skipLabel}
            </PickerOption>
            <PickerOption
              active={choice === 'clear'}
              onClick={() => {
                onChoice('clear')
                setOpen(false)
              }}
              dim
            >
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 border border-dashed rounded-full border-muted-foreground" />
                {clearLabel}
              </span>
            </PickerOption>
            <div className="h-px bg-border my-1" aria-hidden="true" />
            {items.length === 0 ? (
              <div className="px-2 py-1.5 text-muted-foreground">{emptyLabel}</div>
            ) : (
              items.map((item) => (
                <PickerOption
                  key={item.id}
                  active={choice === item.id}
                  onClick={() => {
                    onChoice(item.id)
                    setOpen(false)
                  }}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {item.color && (
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: item.color }}
                      />
                    )}
                    {item.label}
                  </span>
                </PickerOption>
              ))
            )}
          </div>
        )}
      </div>
      {disabled && disabledHint && (
        <div className="text-[10px] text-muted-foreground">{disabledHint}</div>
      )}
    </div>
  )
}

function PickerOption({
  active,
  onClick,
  dim,
  children,
}: {
  active: boolean
  onClick: () => void
  dim?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="option"
      aria-selected={active}
      className={cn(
        'w-full flex items-center justify-between px-2 py-1.5 rounded text-start hover:bg-accent transition-colors',
        active && 'bg-accent',
        dim && 'text-muted-foreground',
      )}
    >
      <span className="flex-1 truncate">{children}</span>
      {active && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
    </button>
  )
}
