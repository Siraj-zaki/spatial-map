import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Boxes, ChevronUp, ChevronDown, Link2, Loader2, RefreshCw, X } from 'lucide-react'
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
  getBin,
  upsertBin,
} from '@/lib/api-db'
import {
  type Bin,
  type BinStatus,
  type Grid,
} from '@/lib/db'
import { useSpatialAttributeDefinitions } from '@/hooks/useSpatialShapes'
import { defsForKind } from '@/lib/data-link/attribute-defs'
import { AttributeField } from '@/components/attribute-field'
import { applyDefaultsForBin } from '@/lib/schema-defaults'
import {
  buildGridFromLine,
  formatLabel,
  type GridConfig,
} from '@/lib/grid-generators'

interface BinEditorProps {
  /** The cell + level the user clicked. `null` to dismiss the editor. */
  selection: { gridId: number; row: number; col: number; level: number } | null
  /** Whether the dialog is open. Driven by the parent. */
  open: boolean
  /** Fired when the dialog requests close (X, Esc, overlay click). */
  onOpenChange: (open: boolean) => void
  /** Allows the parent (create-grids) to drive level navigation from outside. */
  onLevelChange?: (level: number) => void
}

const STATUS_LIST: BinStatus[] = ['empty', 'occupied', 'reserved']
const STATUS_DOT: Record<BinStatus, string> = {
  empty: 'bg-muted-foreground/40',
  occupied: 'bg-blue-500',
  reserved: 'bg-amber-500',
}

/**
 * Floating bin-editor card. Anchored top-center over the map. Opens
 * when the user clicks a saved rack cell — the cell's identity is
 * `(gridId, row, col, level)`. The underlying `db.bins` row is
 * upserted on every field change so the on-map tint follows the
 * user's edits in real time.
 *
 * For multi-level racks, the right side of the card renders a level
 * ladder so the user can step between levels of the *same* (row, col)
 * footprint without dismissing the card. This is the workaround for
 * Mapbox 3D picking returning only the top face — once the editor is
 * open, the user is in "this column" and can scrub through its levels.
 */
export function BinEditor({ selection, open, onOpenChange, onLevelChange }: BinEditorProps) {
  const onClose = () => onOpenChange(false)
  const { t } = useTranslation()
  const [bin, setBin] = useState<Bin | null>(null)
  const [grid, setGrid] = useState<Grid | null>(null)
  const [syncedSource, setSyncedSource] = useState<{ name: string } | null>(null)
  const [newPropKey, setNewPropKey] = useState('')

  const totalLevels = Math.max(1, Math.floor(grid?.config.levels ?? 1))

  // Recompute the bin's "BinCode" from the parent rack's labelling
  // config — same logic the on-map symbol layer uses, so the code the
  // user sees here always matches the label rendered on the cell.
  const binCode = (() => {
    if (!grid || !selection) return ''
    const { row, col, level } = selection
    const result = (() => {
      try {
        return buildGridFromLine(grid.start, grid.current, grid.config, {
          committed: true,
          gridId: grid.id,
        })
      } catch {
        return null
      }
    })()
    if (!result || result.cells.length === 0) return ''
    const maxRow = Math.max(...result.cells.map((c) => c.properties.row)) + 1
    const maxCol = Math.max(...result.cells.map((c) => c.properties.col)) + 1
    return formatLabel(
      row,
      col,
      maxRow,
      maxCol,
      grid.config as GridConfig,
      level,
      totalLevels,
    )
  })()

  // Load (or stub) the bin row whenever the selection changes. The
  // synchronous null-resets here are intentional — when the user
  // dismisses the editor, the stale row would otherwise flash for one
  // render before the new selection's async load lands.
  useEffect(() => {
    if (!selection) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBin(null)
      setGrid(null)
      return
    }
    let cancelled = false
    void (async () => {
      const [b, g] = await Promise.all([
        getBin(
          selection.gridId,
          selection.row,
          selection.col,
          selection.level,
        ),
        apiDb.grids.get(selection.gridId),
      ])
      if (cancelled) return
      setGrid(g ?? null)
      setBin(
        b ?? {
          targetKind: 'grid-cell',
          gridId: selection.gridId,
          row: selection.row,
          col: selection.col,
          level: selection.level,
          status: 'empty',
          updatedAt: new Date(),
        },
      )
      // Load the linked data source once (no polling). Sources don't change
      // often enough to justify a subscription here; SSE keeps the broader
      // catalog fresh, and the editor only needs the display name.
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
  }, [selection])

  // Attribute definitions come from the spatial store, which is loaded once
  // per tenant and updated via SSE. No polling inside the editor.
  const { data: allAttrDefs = [] } = useSpatialAttributeDefinitions()
  const attrDefs = useMemo(
    () => defsForKind('grid-cell', allAttrDefs),
    [allAttrDefs],
  )

  // Seed defaults the first time a bin is opened with no persisted
  // customProperties. We do this in a separate effect (not inside the
  // load effect) so defaults from a freshly-saved schema field also
  // apply to bins that were already in memory.
  useEffect(() => {
    if (!bin) return
    const hasExisting = bin.customProperties && Object.keys(bin.customProperties).length > 0
    if (hasExisting) return
    const seeded = applyDefaultsForBin('grid-cell', allAttrDefs, bin)
    if (Object.keys(seeded).length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBin((b) => (b ? { ...b, customProperties: seeded } : b))
  }, [bin, allAttrDefs])

  const persist = (patch: Partial<Bin>) => {
    if (!selection || !bin) return
    setBin((b) => (b ? { ...b, ...patch, updatedAt: new Date() } : b))
    // Never leave a `void promise` here — API errors were silently
    // swallowed and the user just saw fields snap back on next open
    // with no signal about what failed (401 tenant, 500 backend, etc.).
    upsertBin(
      selection.gridId,
      selection.row,
      selection.col,
      selection.level,
      {
        status: patch.status ?? bin.status,
        sku: patch.sku !== undefined ? patch.sku : bin.sku,
        capacity:
          patch.capacity !== undefined ? patch.capacity : bin.capacity,
        notes: patch.notes !== undefined ? patch.notes : bin.notes,
        externalCode:
          patch.externalCode !== undefined ? patch.externalCode : bin.externalCode,
        customProperties:
          patch.customProperties !== undefined ? patch.customProperties : bin.customProperties,
      },
    ).catch((err) => {
      console.error('[BinEditor] failed to persist bin', {
        selection,
        patch,
        error: err,
      })
    })
  }

  /** Patch one key inside the bin's customProperties bag without losing the others. */
  const persistCustom = (key: string, value: unknown) => {
    if (!bin) return
    const next = { ...(bin.customProperties ?? {}) }
    if (value === '' || value === undefined || value === null) delete next[key]
    else next[key] = value
    persist({ customProperties: next })
  }

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

  const removeProp = (key: string) => persistCustom(key, '')

  const [clearing, setClearing] = useState(false)
  const clearBin = async () => {
    if (!selection || clearing) return
    setClearing(true)
    try {
      const existing = await getBin(
        selection.gridId,
        selection.row,
        selection.col,
        selection.level,
      )
      if (existing && existing.id !== undefined) {
        await apiDb.bins.delete(existing.id)
      }
      onClose()
    } catch (err) {
      toast.error(t('bin.clearFailed', { defaultValue: 'Couldn’t clear this cell — try again.' }), {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setClearing(false)
    }
  }

  const stepLevel = (delta: number) => {
    if (!selection) return
    const next = Math.max(0, Math.min(totalLevels - 1, selection.level + delta))
    if (next === selection.level) return
    onLevelChange?.(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden" aria-describedby={undefined}>
        {selection && bin ? (
          <div className="flex flex-col">
        {/* Header */}
        <DialogHeader className="flex flex-row items-center gap-2 px-4 py-3 border-b space-y-0">
          <Boxes className="w-4 h-4 text-primary flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <DialogTitle className="font-semibold text-sm leading-tight">
              {t('bin.title')}{' '}
              <span className="font-mono text-muted-foreground">
                {binCode}
              </span>
            </DialogTitle>
            <p className="text-[11px] text-muted-foreground">
              {t('bin.cell')}: r{selection.row} · c{selection.col}
              {totalLevels > 1 ? ` · L${selection.level + 1}` : ''}
            </p>
          </div>
        </DialogHeader>

        {/* Body: form + (optional) level ladder */}
        <div className="flex">
          <div className="flex-1 p-4 flex flex-col gap-3 min-w-0">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('bin.status')}</Label>
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
                      {t(`bin.status_${s}`)}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t('bin.sku')}</Label>
              <Input
                value={bin.sku ?? ''}
                onChange={(e) => persist({ sku: e.target.value })}
                placeholder={t('bin.skuPlaceholder')}
                className="h-8 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t('bin.capacity')}</Label>
              <Input
                type="number"
                value={bin.capacity ?? ''}
                onChange={(e) =>
                  persist({
                    capacity:
                      e.target.value === ''
                        ? undefined
                        : Number(e.target.value),
                  })
                }
                placeholder={t('bin.capacityPlaceholder')}
                className="h-8 text-sm"
                min={0}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t('bin.notes')}</Label>
              <Input
                value={bin.notes ?? ''}
                onChange={(e) => persist({ notes: e.target.value })}
                placeholder={t('bin.notesPlaceholder')}
                className="h-8 text-sm"
              />
            </div>

            <div className="pt-3 border-t -mx-4 px-4 space-y-2.5">
              <div className="flex items-center gap-1.5">
                <Link2 className="w-3 h-3 text-muted-foreground" />
                <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('bin.linkedData', { defaultValue: 'Linked data' })}
                </Label>
              </div>

              {/* External code — always editable */}
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {t('bin.externalCode', { defaultValue: 'External code' })}
                </Label>
                <Input
                  value={bin.externalCode ?? ''}
                  onChange={(e) => persist({ externalCode: e.target.value })}
                  placeholder={t('bin.externalCodePlaceholder', { defaultValue: 'WMS code / barcode' })}
                  className="h-8 text-sm font-mono"
                />
              </div>

              {/* One typed widget per schema definition */}
              {attrDefs.map((def) => (
                <AttributeField
                  key={def.key}
                  def={def}
                  value={bin.customProperties?.[def.key]}
                  onChange={(v) => persistCustom(def.key, v)}
                />
              ))}

              {/* Off-schema custom properties — still editable, with remove button */}
              {bin.customProperties &&
                Object.entries(bin.customProperties)
                  .filter(([k]) => !attrDefs.some((d) => d.key === k))
                  .map(([k, v]) => (
                    <div key={k} className="space-y-1.5">
                      <Label className="flex items-center justify-between text-xs">
                        <span className="truncate font-mono text-[11px]" title={k}>prop.{k}</span>
                        <button
                          type="button"
                          onClick={() => removeProp(k)}
                          className="flex items-center justify-center w-4 h-4 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
                          title={t('bin.removeProp', { defaultValue: 'Remove' })}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </Label>
                      <Input
                        value={String(v ?? '')}
                        onChange={(e) => persistCustom(k, e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                  ))}

              {/* Ad-hoc add — parity with ShapeDataEditor so users can attach
                  a property without leaving the editor to update the schema. */}
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
                  placeholder={t('bin.newPropPlaceholder', {
                    defaultValue: 'new_property_key',
                  })}
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
                  {t('bin.addProp', { defaultValue: 'Add' })}
                </Button>
              </div>

              {/* Sync stamp — read-only metadata footer */}
              {(bin.lastSyncedAt || syncedSource) && (
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground pt-0.5">
                  <RefreshCw className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">
                    {syncedSource ? syncedSource.name : t('bin.unknownSource', { defaultValue: 'External source' })}
                    {bin.lastSyncedAt && ` · ${new Date(bin.lastSyncedAt).toLocaleString()}`}
                  </span>
                </div>
              )}
            </div>
          </div>

          {totalLevels > 1 && (
            <div
              className="w-16 flex-shrink-0 border-l flex flex-col items-stretch p-2 gap-1 bg-muted/30"
              aria-label={t('bin.levelLadder')}
            >
              <Button
                variant="ghost"
                size="icon"
                className="h-7"
                onClick={() => stepLevel(1)}
                disabled={selection.level >= totalLevels - 1}
                title={t('bin.levelUp')}
                aria-label={t('bin.levelUp')}
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </Button>
              <div className="flex-1 flex flex-col-reverse gap-0.5 overflow-y-auto py-1">
                {Array.from({ length: totalLevels }, (_, lvl) => {
                  const active = lvl === selection.level
                  return (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => onLevelChange?.(lvl)}
                      className={
                        'h-7 text-[11px] font-mono rounded border transition-colors flex-shrink-0 ' +
                        (active
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-transparent hover:bg-accent text-muted-foreground')
                      }
                    >
                      L{String(lvl + 1).padStart(2, '0')}
                    </button>
                  )
                })}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7"
                onClick={() => stepLevel(-1)}
                disabled={selection.level <= 0}
                title={t('bin.levelDown')}
                aria-label={t('bin.levelDown')}
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t flex items-center justify-between bg-background flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void clearBin()}
            disabled={clearing}
            aria-busy={clearing}
            className="text-destructive hover:bg-destructive/10"
          >
            {clearing ? <Loader2 className="w-3.5 h-3.5 me-1 animate-spin motion-reduce:animate-none" /> : <Trash2 className="w-3.5 h-3.5 me-1" />}
            {t('bin.clear')}
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            {t('bin.close')}
          </Button>
        </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
