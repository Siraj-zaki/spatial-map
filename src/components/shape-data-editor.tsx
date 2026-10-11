/**
 * Floating editor card for the linked-data (Bin) row attached to a
 * non-grid shape (polygon / circle / line / marker / image / model).
 *
 * Grid cells already have `BinEditor` — that one needs the rack
 * level ladder and `binCode` label which don't apply to free-standing
 * shapes, so this is a leaner cousin focused on the data side:
 *
 *   - external code / sku / capacity / notes / status (re-used)
 *   - custom properties (free-form add / remove / edit)
 *   - "Add image URL", "Add video URL", "Add stream URL" presets that
 *     stamp the right key so the tooltip renders the media right away
 *
 * All edits upsert into `db.bins` via `upsertShapeBin(kind, shapeId, …)`
 * so the tooltip overlay sees changes in real time.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Trash2,
  Boxes,
  Loader2,
  Image as ImageIcon,
  Video as VideoIcon,
  Radio,
  Plus,
  X,
  Link2,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast-store'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  apiDb,
  getBinForShape,
  upsertShapeBin,
} from '@/lib/api-db'
import {
  type Bin,
  type BinStatus,
  type BindingKind,
} from '@/lib/db'
import { useSpatialAttributeDefinitions } from '@/hooks/useSpatialShapes'
import { classifyValue } from '@/lib/rich-data'
import { defsForKind } from '@/lib/data-link/attribute-defs'
import { AttributeField } from '@/components/attribute-field'
import { applyDefaultsForBin } from '@/lib/schema-defaults'

export type ShapeEditorTarget = {
  kind: Exclude<BindingKind, 'grid-cell'>
  shapeId: number
  /** Display name pulled from the shape row; rendered in the header. */
  shapeName?: string
}

interface Props {
  target: ShapeEditorTarget | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

const STATUS_LIST: BinStatus[] = ['empty', 'occupied', 'reserved']
const STATUS_DOT: Record<BinStatus, string> = {
  empty: 'bg-muted-foreground/40',
  occupied: 'bg-blue-500',
  reserved: 'bg-amber-500',
}

const KIND_LABEL: Record<Exclude<BindingKind, 'grid-cell'>, string> = {
  polygon: 'Polygon',
  circle: 'Circle',
  line: 'Line',
  marker: 'Marker',
  image: 'Image',
  model: '3D Model',
}

export function ShapeDataEditor({ target, open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const [bin, setBin] = useState<Bin | null>(null)
  const [syncedSource, setSyncedSource] = useState<{ name: string } | null>(null)
  const [newPropKey, setNewPropKey] = useState('')

  useEffect(() => {
    if (!target) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBin(null)
      return
    }
    let cancelled = false
    void (async () => {
      const b = await getBinForShape(target.kind, target.shapeId)
      if (cancelled) return
      setBin(
        b ?? {
          targetKind: target.kind,
          shapeId: target.shapeId,
          updatedAt: new Date(),
        },
      )
      if (b?.syncSource !== undefined) {
        const src = await apiDb.dataSources.get(b.syncSource)
        if (!cancelled) setSyncedSource(src ?? null)
      } else {
        setSyncedSource(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target])

  // Attribute definitions come from the spatial store, which is loaded once
  // per tenant and updated via SSE. No polling inside the editor.
  const { data: allAttrDefs = [] } = useSpatialAttributeDefinitions()
  const attrDefs = useMemo(
    () => defsForKind(target?.kind ?? 'polygon', allAttrDefs),
    [allAttrDefs, target?.kind],
  )

  // Seed defaults the first time this shape's data editor opens with
  // no persisted customProperties — same behaviour BinEditor uses.
  useEffect(() => {
    if (!bin || !target) return
    const hasExisting = bin.customProperties && Object.keys(bin.customProperties).length > 0
    if (hasExisting) return
    const seeded = applyDefaultsForBin(target.kind, allAttrDefs, bin)
    if (Object.keys(seeded).length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBin((b) => (b ? { ...b, customProperties: seeded } : b))
  }, [bin, target, allAttrDefs])

  const persist = (patch: Partial<Bin>) => {
    if (!target || !bin) return
    const merged: Partial<Bin> = {
      status: patch.status ?? bin.status,
      sku: patch.sku !== undefined ? patch.sku : bin.sku,
      capacity: patch.capacity !== undefined ? patch.capacity : bin.capacity,
      notes: patch.notes !== undefined ? patch.notes : bin.notes,
      externalCode:
        patch.externalCode !== undefined ? patch.externalCode : bin.externalCode,
      customProperties:
        patch.customProperties !== undefined
          ? patch.customProperties
          : bin.customProperties,
    }
    setBin((b) => (b ? { ...b, ...patch, updatedAt: new Date() } : b))
    void upsertShapeBin(target.kind, target.shapeId, merged)
  }

  /** Patch one key inside customProperties without losing the others. */
  const persistCustom = (key: string, value: unknown) => {
    if (!bin) return
    const next = { ...(bin.customProperties ?? {}) }
    if (value === '' || value === undefined || value === null) {
      delete next[key]
    } else {
      next[key] = value
    }
    persist({ customProperties: next })
  }

  /** Append a value to an array-valued custom property (creating the array if absent). */
  const appendToArray = (key: string, value: string) => {
    if (!bin) return
    const existing = bin.customProperties?.[key]
    const next: unknown[] = Array.isArray(existing) ? [...existing, value] : [value]
    persistCustom(key, next)
  }

  const removeFromArray = (key: string, index: number) => {
    if (!bin) return
    const existing = bin.customProperties?.[key]
    if (!Array.isArray(existing)) return
    const next = existing.filter((_, i) => i !== index)
    persistCustom(key, next.length > 0 ? next : '')
  }

  const removeProp = (key: string) => persistCustom(key, '')

  const [clearing, setClearing] = useState(false)
  const clearAll = async () => {
    if (!target || clearing) return
    setClearing(true)
    try {
      const existing = await getBinForShape(target.kind, target.shapeId)
      if (existing && existing.id !== undefined) {
        await apiDb.bins.delete(existing.id)
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(t('shapeData.clearFailed', { defaultValue: 'Couldn’t clear the data — try again.' }), {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setClearing(false)
    }
  }

  const customEntries = useMemo(
    () => (bin?.customProperties ? Object.entries(bin.customProperties) : []),
    [bin],
  )

  const addNewProp = () => {
    const key = newPropKey.trim()
    if (key.length === 0 || !bin) return
    if (bin.customProperties?.[key] !== undefined) return
    // Bypass `persistCustom` — it treats '' as "delete this key" (so
    // the row can be cleared by emptying the input), which would
    // immediately drop the new key. A fresh prop needs to land in the
    // bag with an empty-string placeholder the user can then type
    // into.
    const next = { ...(bin.customProperties ?? {}), [key]: '' }
    persist({ customProperties: next })
    setNewPropKey('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden" aria-describedby={undefined}>
        {target && bin ? (
          <div className="flex flex-col max-h-[80dvh]">
            <DialogHeader className="flex flex-row items-center gap-2 px-4 py-3 border-b space-y-0">
              <Boxes className="w-4 h-4 text-primary flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <DialogTitle className="font-semibold text-sm leading-tight truncate">
                  {target.shapeName ?? `${KIND_LABEL[target.kind]} #${target.shapeId}`}
                </DialogTitle>
                <p className="text-[11px] text-muted-foreground">
                  {KIND_LABEL[target.kind]} · #{target.shapeId}
                </p>
              </div>
            </DialogHeader>

            <div className="p-4 flex flex-col gap-3 overflow-y-auto">
              <div className="space-y-1.5">
                <Label className="text-xs">Status</Label>
                <div className="grid grid-cols-3 gap-1.5">
                  {STATUS_LIST.map((s) => {
                    const active = bin.status === s
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => persist({ status: s })}
                        className={
                          'flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-xs transition-colors ' +
                          (active
                            ? 'border-primary bg-primary/10 text-foreground'
                            : 'border-border hover:bg-accent text-muted-foreground')
                        }
                      >
                        <span
                          className={'w-2 h-2 rounded-full ' + STATUS_DOT[s]}
                          aria-hidden="true"
                        />
                        {s}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">External code</Label>
                <Input
                  value={bin.externalCode ?? ''}
                  onChange={(e) => persist({ externalCode: e.target.value })}
                  placeholder="WMS code / barcode"
                  className="h-8 text-sm font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">SKU</Label>
                  <Input
                    value={bin.sku ?? ''}
                    onChange={(e) => persist({ sku: e.target.value })}
                    placeholder="optional"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Capacity</Label>
                  <Input
                    type="number"
                    value={bin.capacity ?? ''}
                    onChange={(e) =>
                      persist({
                        capacity:
                          e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                    placeholder="optional"
                    className="h-8 text-sm"
                    min={0}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Notes</Label>
                <Input
                  value={bin.notes ?? ''}
                  onChange={(e) => persist({ notes: e.target.value })}
                  placeholder="free-form note"
                  className="h-8 text-sm"
                />
              </div>

              {/* Media presets */}
              <div className="space-y-1.5 pt-3 border-t -mx-4 px-4">
                <div className="flex items-center gap-1.5">
                  <ImageIcon className="w-3 h-3 text-muted-foreground" />
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Media
                  </Label>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Image URLs (or <code className="font-mono">data:image/…;base64,…</code>),
                  video URLs (.mp4 / .webm) and stream URLs (RTSP / RTMP / HLS) all
                  render in the hover tooltip.
                </p>
                <MediaAdder
                  label="Add image"
                  icon={<ImageIcon className="w-3 h-3" />}
                  placeholder="https://… or data:image/png;base64,…"
                  onAdd={(v) => appendToArray('images', v)}
                />
                <MediaAdder
                  label="Add video"
                  icon={<VideoIcon className="w-3 h-3" />}
                  placeholder="https://…/clip.mp4"
                  onAdd={(v) => appendToArray('videos', v)}
                />
                <MediaAdder
                  label="Add stream / camera"
                  icon={<Radio className="w-3 h-3" />}
                  placeholder="rtsp://… or https://…/feed.m3u8"
                  onAdd={(v) => appendToArray('cameras', v)}
                />
              </div>

              {/* Definition-driven attribute fields */}
              {attrDefs.length > 0 && (
                <div className="space-y-2 pt-3 border-t -mx-4 px-4">
                  <div className="flex items-center gap-1.5">
                    <Link2 className="w-3 h-3 text-muted-foreground" />
                    <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Defined attributes
                    </Label>
                  </div>
                  {attrDefs.map((def) => (
                    <AttributeField
                      key={def.key}
                      def={def}
                      value={bin.customProperties?.[def.key]}
                      onChange={(v) => persistCustom(def.key, v)}
                    />
                  ))}
                </div>
              )}

              {/* Free-form custom properties */}
              <div className="space-y-2 pt-3 border-t -mx-4 px-4">
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Custom properties
                </Label>
                {customEntries.length === 0 && (
                  <p className="text-[10px] text-muted-foreground italic">
                    None yet.
                  </p>
                )}
                {customEntries
                  .filter(([k]) => !attrDefs.some((d) => d.key === k))
                  .map(([k, v]) => (
                    <CustomPropertyRow
                      key={k}
                      propKey={k}
                      value={v}
                      onChange={(value) => persistCustom(k, value)}
                      onRemove={() => removeProp(k)}
                      onRemoveItem={(idx) => removeFromArray(k, idx)}
                    />
                  ))}
                <div className="flex items-center gap-1.5 pt-1">
                  <Input
                    value={newPropKey}
                    onChange={(e) => setNewPropKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addNewProp()
                      }
                    }}
                    placeholder="new_property_key"
                    className="h-7 text-xs font-mono flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={addNewProp}
                    disabled={newPropKey.trim().length === 0}
                  >
                    <Plus className="w-3 h-3 me-1" />
                    Add
                  </Button>
                </div>
              </div>

              {(bin.lastSyncedAt || syncedSource) && (
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground pt-2 border-t -mx-4 px-4">
                  <RefreshCw className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">
                    {syncedSource ? syncedSource.name : 'External source'}
                    {bin.lastSyncedAt && ` · ${new Date(bin.lastSyncedAt).toLocaleString()}`}
                  </span>
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t flex items-center justify-between bg-background flex-shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void clearAll()}
                disabled={clearing}
                aria-busy={clearing}
                className="text-destructive hover:bg-destructive/10"
              >
                {clearing ? <Loader2 className="w-3.5 h-3.5 me-1 animate-spin motion-reduce:animate-none" /> : <Trash2 className="w-3.5 h-3.5 me-1" />}
                {t('shapeData.clearAll', { defaultValue: 'Clear all data' })}
              </Button>
              <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

// -------------------------------------------------------- helper sub-components

function MediaAdder({
  label,
  icon,
  placeholder,
  onAdd,
}: {
  label: string
  icon: React.ReactNode
  placeholder: string
  onAdd: (value: string) => void
}) {
  const [v, setV] = useState('')
  const submit = () => {
    const value = v.trim()
    if (value.length === 0) return
    onAdd(value)
    setV('')
  }
  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={placeholder}
        className="h-7 text-xs font-mono flex-1"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2 text-xs whitespace-nowrap"
        onClick={submit}
        disabled={v.trim().length === 0}
      >
        {icon}
        <span className="ms-1">{label}</span>
      </Button>
    </div>
  )
}

function CustomPropertyRow({
  propKey,
  value,
  onChange,
  onRemove,
  onRemoveItem,
}: {
  propKey: string
  value: unknown
  onChange: (value: unknown) => void
  onRemove: () => void
  onRemoveItem: (idx: number) => void
}) {
  const { t } = useTranslation()
  if (Array.isArray(value)) {
    return (
      <div className="space-y-1">
        <Label className="flex items-center justify-between text-xs">
          <span className="font-mono text-[11px] truncate" title={propKey}>{propKey}</span>
          <span className="text-[10px] text-muted-foreground">array · {value.length}</span>
        </Label>
        <div className="space-y-1 pl-2 border-l border-border">
          {value.map((item, idx) => {
            const detected = typeof item === 'string' ? classifyValue(propKey, item) : []
            const previewKind = detected[0]?.kind
            return (
              <div key={idx} className="flex items-center gap-1">
                <Input
                  value={typeof item === 'string' ? item : JSON.stringify(item)}
                  onChange={(e) => {
                    const next = [...value]
                    next[idx] = e.target.value
                    onChange(next)
                  }}
                  className="h-7 text-xs font-mono flex-1"
                />
                {previewKind && (
                  <span className="text-[9px] font-mono uppercase text-muted-foreground px-1">
                    {previewKind}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveItem(idx)}
                  className="flex items-center justify-center w-6 h-6 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
                  title={t('common.remove', { defaultValue: 'Remove' })}
                  aria-label={t('common.remove', { defaultValue: 'Remove' })}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
  if (value && typeof value === 'object') {
    return (
      <div className="space-y-1">
        <Label className="flex items-center justify-between text-xs">
          <span className="font-mono text-[11px] truncate" title={propKey}>{propKey}</span>
          <button
            type="button"
            onClick={onRemove}
            className="flex items-center justify-center w-5 h-5 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
            title={t('common.remove', { defaultValue: 'Remove' })}
            aria-label={t('common.remove', { defaultValue: 'Remove' })}
          >
            <X className="w-3 h-3" />
          </button>
        </Label>
        <textarea
          value={JSON.stringify(value, null, 2)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value))
            } catch {
              /* keep typing; only commit when valid JSON */
            }
          }}
          rows={4}
          className="w-full text-[10px] font-mono rounded border border-input bg-background px-2 py-1.5"
        />
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1">
      <Label className="flex-shrink-0 w-32 truncate font-mono text-[11px]" title={propKey}>
        {propKey}
      </Label>
      <Input
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-xs flex-1"
      />
      <button
        type="button"
        onClick={onRemove}
        className="flex items-center justify-center w-6 h-6 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
        title={t('common.remove', { defaultValue: 'Remove' })}
        aria-label={t('common.remove', { defaultValue: 'Remove' })}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}
