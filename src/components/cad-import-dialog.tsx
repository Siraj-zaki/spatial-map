import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  Layers as LayersIcon,
  Loader2,
  Ruler,
  Scan,
  TriangleAlert,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  CAD_UNIT_CHOICES,
  cadColorHex,
  defaultSelectedLayers,
  inspectCad,
  renderCad,
  selectedEntityCount,
  sizeUnderUnits,
  type CadInspectResult,
  type CadRenderResult,
  type CadUnits,
} from '@/lib/cad-import'

/**
 * Units + layer picker shown when the user drops a DWG into the
 * floor-plan tool.
 *
 * Two decisions are made here, and they are the two a CAD file cannot
 * always settle for itself.
 *
 * Units, because `$INSUNITS` is 0 in a large minority of drawings —
 * AutoCAD's default template was unitless for years — and getting it
 * wrong imports the building at a thousandth of its size. That failure
 * is silent and looks like a placement mistake, so the dialog always
 * shows the resulting real-world size rather than the unit name alone:
 * the candidates are orders of magnitude apart, so a building-sized
 * answer is unambiguous the moment it is on screen.
 *
 * Layers, because a construction drawing carries far more than the plan
 * — dimensions, grid bubbles, revision clouds, title-block linework —
 * and rendering all of it produces an unreadable tangle. The drawing's
 * own visibility flags seed the selection, since a layer the author
 * froze is one they chose not to show.
 *
 * Both questions are asked *because* the drawing is read as a drawing:
 * the layer filter is a choice about entities and the ground size comes
 * from the drawing's own coordinates, so the plan lands at its real
 * dimensions instead of being scaled by hand. What comes back is an
 * ordinary floor-plan image.
 *
 * Position and rotation stay a human judgement: a CAD file carries no
 * CRS, no origin and no north, so this hands off to the existing
 * drag-to-place interaction exactly as the PDF picker does.
 */

export interface CadPickResult {
  render: CadRenderResult
  fileName: string
}

export function CadImportDialog({
  file,
  onCancel,
  onConfirm,
}: {
  /** The drawing the user picked. Null closes the dialog. */
  file: File | null
  onCancel: () => void
  onConfirm: (result: CadPickResult) => void
}) {
  const { t } = useTranslation()
  const [inspecting, setInspecting] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<CadInspectResult | null>(null)
  const [units, setUnits] = useState<CadUnits>(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Reset on close: the dialog stays mounted through Radix's exit
  // animation, so without this, reopening with a different drawing would
  // flash the previous file's layers. Same convention as
  // `pdf-page-picker.tsx`.
  useEffect(() => {
    if (!file) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setInfo(null)
      setError(null)
      setSelected(new Set())
      /* eslint-enable react-hooks/set-state-in-effect */
      return
    }
    let cancelled = false
    setInspecting(true)
    setError(null)
    inspectCad(file)
      .then((result) => {
        if (cancelled) return
        setInfo(result)
        setSelected(defaultSelectedLayers(result.layers))
        // A declared $INSUNITS is the file answering the question. When
        // it declared nothing, the top-ranked guess is the best opening
        // position — it is already filtered to plausible building sizes.
        const guess = result.unitGuesses?.find((g) => g.plausible)
        setUnits(result.unitsDeclared ? result.units : (guess?.units ?? result.units))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(
          err instanceof Error
            ? err.message
            : t('cadImport.errorGeneric', {
                defaultValue: 'Could not read this drawing.',
              }),
        )
      })
      .finally(() => {
        if (!cancelled) setInspecting(false)
      })
    return () => {
      cancelled = true
    }
  }, [file, t])

  // Only layers with content are offered. A plan routinely declares
  // thirty and uses four; listing the empty ones makes the list a
  // scrolling exercise with nothing to find in it.
  const layers = useMemo(
    () => (info?.layers ?? []).filter((l) => l.entityCount > 0),
    [info],
  )

  const derived = useMemo(
    () => (info ? sizeUnderUnits(info, units) : null),
    [info, units],
  )

  const entityCount = useMemo(
    () => selectedEntityCount(layers, selected),
    [layers, selected],
  )

  const toggleLayer = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const allSelected = layers.length > 0 && selected.size === layers.length

  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === layers.length ? new Set() : new Set(layers.map((l) => l.name)),
    )
  }, [layers])

  const handleConfirm = useCallback(async () => {
    if (!file || !info) return
    setRendering(true)
    setError(null)
    try {
      // An all-layers selection is sent as "no filter" so the server
      // takes its own faster path and the request stays small.
      const layerFilter =
        selected.size === info.layers.length ? undefined : [...selected]
      const render = await renderCad(file, { layers: layerFilter, units })
      onConfirm({ render, fileName: file.name })
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : t('cadImport.errorRender', {
              defaultValue: 'Could not render this drawing.',
            }),
      )
    } finally {
      setRendering(false)
    }
  }, [file, info, selected, units, onConfirm, t])

  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-3xl w-[95vw] p-0 gap-0 overflow-hidden">
        <div className="flex flex-col max-h-[85dvh]">
          <DialogHeader className="flex flex-row items-center gap-3 px-5 py-4 border-b space-y-0 flex-shrink-0">
            <div className="flex items-center justify-center flex-shrink-0 rounded-lg w-9 h-9 bg-primary/10">
              <Scan className="w-4 h-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-semibold leading-tight">
                {t('cadImport.title', {
                  defaultValue: 'Import floor plan from CAD drawing',
                })}
              </DialogTitle>
              <DialogDescription className="text-xs leading-snug text-muted-foreground mt-0.5">
                {t('cadImport.subtitle', {
                  defaultValue:
                    'Confirm the drawing units, then choose the layers to import.',
                })}
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {inspecting && (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('cadImport.reading', { defaultValue: 'Reading drawing…' })}
              </div>
            )}

            {error && !inspecting && (
              <div className="flex items-start gap-2 px-5 py-4 m-5 text-xs border rounded-md border-destructive/40 bg-destructive/10 text-destructive">
                <TriangleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {info && !inspecting && (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 border-b text-[11px] text-muted-foreground">
                  <span dir="ltr" className="font-medium text-foreground">
                    {info.release}
                  </span>
                  <span>
                    {t('cadImport.entityCount', { count: info.entityCount })}
                  </span>
                  <span>
                    {t('cadImport.layerCount', { count: layers.length })}
                  </span>
                  {info.producer && (
                    <span dir="ltr" className="truncate max-w-[16rem]">
                      {info.producer}
                    </span>
                  )}
                </div>

                {/* Units. Always shown, never auto-applied silently when
                    the file left the question open — a wrong answer here
                    imports the building at a thousandth of its size and
                    looks like a placement mistake. */}
                <div className="px-5 py-4 space-y-3 border-b">
                  <div className="flex items-center gap-2">
                    <Ruler className="w-3.5 h-3.5 text-muted-foreground" />
                    <h3 className="text-xs font-medium tracking-wide uppercase text-muted-foreground">
                      {t('cadImport.unitsTitle', { defaultValue: 'Drawing units' })}
                    </h3>
                  </div>

                  <p className="text-[11px] text-muted-foreground">
                    {info.unitsDeclared
                      ? t('cadImport.unitsDeclared', {
                          units: info.unitsName,
                          defaultValue:
                            'This drawing declares {{units}}. Override only if it looks wrong.',
                        })
                      : t('cadImport.unitsUndeclared', {
                          defaultValue:
                            'This drawing does not declare its units. Pick the one that gives a believable building size.',
                        })}
                  </p>

                  <div className="flex flex-wrap gap-1.5">
                    {CAD_UNIT_CHOICES.map((choice) => {
                      const size = sizeUnderUnits(info, choice.units)
                      return (
                        <button
                          key={choice.units}
                          type="button"
                          onClick={() => setUnits(choice.units)}
                          className={`flex flex-col items-start px-2.5 py-1.5 border rounded-md transition-colors ${
                            choice.units === units
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border hover:bg-accent'
                          }`}
                        >
                          <span className="text-[11px] font-medium">
                            {t(`cadImport.unit_${choice.key}`, {
                              defaultValue: choice.key,
                            })}
                          </span>
                          {/* A dimension readout is a formula, not prose:
                              under RTL the bidi algorithm floats the
                              trailing `m` to the front without this. */}
                          <span
                            dir="ltr"
                            className="text-[10px] font-mono opacity-70"
                          >
                            {size
                              ? `${size.widthMeters.toFixed(1)} × ${size.heightMeters.toFixed(1)} m`
                              : '—'}
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  {!info.unitsConfident && (
                    <div className="flex items-start gap-2 px-3 py-2 text-[11px] border rounded-md border-amber-500/40 bg-amber-500/10">
                      <TriangleAlert className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span>
                        {t('cadImport.unitsWarning', {
                          defaultValue:
                            'No unit could be established with confidence. Check the size below against the real building before continuing.',
                        })}
                      </span>
                    </div>
                  )}
                </div>

                {/* Layers. Entity counts are the whole point of the list:
                    they are what separates the four layers that carry the
                    plan from the twenty-six that carry annotation. */}
                <div className="px-5 py-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <LayersIcon className="w-3.5 h-3.5 text-muted-foreground" />
                      <h3 className="text-xs font-medium tracking-wide uppercase text-muted-foreground">
                        {t('cadImport.layersTitle', { defaultValue: 'Layers' })}
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={toggleAll}
                      className="text-[11px] text-primary hover:underline"
                    >
                      {allSelected
                        ? t('cadImport.selectNone', { defaultValue: 'Select none' })
                        : t('cadImport.selectAll', { defaultValue: 'Select all' })}
                    </button>
                  </div>

                  <p className="text-[11px] text-muted-foreground">
                    {t('cadImport.layersHint', {
                      defaultValue:
                        'Only the ticked layers are drawn onto the floor plan. Annotation, dimensions and title-block linework are left out by default — tick them back on if you need them.',
                    })}
                  </p>

                  <div className="border rounded-md divide-y max-h-64 overflow-y-auto">
                    {layers.map((layer) => {
                      const on = selected.has(layer.name)
                      const swatch = cadColorHex(layer.color)
                      return (
                        <button
                          key={layer.name}
                          type="button"
                          onClick={() => toggleLayer(layer.name)}
                          aria-pressed={on}
                          className={`flex items-center w-full gap-2.5 px-3 py-2 text-start transition-colors hover:bg-accent/60 ${
                            on ? 'bg-primary/5' : ''
                          }`}
                        >
                          <span
                            className={`flex items-center justify-center w-4 h-4 border rounded flex-shrink-0 ${
                              on
                                ? 'bg-primary border-primary text-primary-foreground'
                                : 'border-border'
                            }`}
                          >
                            {on && <Check className="w-3 h-3" />}
                          </span>
                          <span
                            className="w-2.5 h-2.5 rounded-sm flex-shrink-0 border border-border/60"
                            style={swatch ? { backgroundColor: swatch } : undefined}
                          />
                          <span
                            dir="ltr"
                            className="flex-1 text-xs truncate"
                            title={layer.name}
                          >
                            {layer.name}
                          </span>
                          {!layer.visible && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              {t('cadImport.layerFrozen', {
                                defaultValue: 'Off in CAD',
                              })}
                            </span>
                          )}
                          <span
                            dir="ltr"
                            className="text-[10px] font-mono text-muted-foreground tabular-nums"
                          >
                            {layer.entityCount.toLocaleString()}
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  {(info.missingXrefs?.length || info.missingBlocks?.length) && (
                    <div className="flex items-start gap-2 px-3 py-2 text-[11px] border rounded-md border-amber-500/40 bg-amber-500/10">
                      <TriangleAlert className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      {/* An xref is a whole drawing this file only points
                          at — the site plan, the structural grid. Silently
                          importing without it is how a plan arrives with a
                          wing missing and nobody knows why. */}
                      <span>
                        {/* No `defaultValue` on a counted key — i18next
                            wants suffixed defaults, and an unsuffixed
                            one was seen beating the real plural forms. */}
                        {t('cadImport.missingReferences', {
                          count:
                            (info.missingXrefs?.length ?? 0) +
                            (info.missingBlocks?.length ?? 0),
                        })}
                      </span>
                    </div>
                  )}

                  {derived && (
                    <div className="px-3 py-2 text-xs border rounded-md bg-muted/40">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          {t('cadImport.resultingSize', { defaultValue: 'Places at' })}
                        </span>
                        <span dir="ltr" className="font-mono font-medium">
                          {derived.widthMeters.toFixed(1)} ×{' '}
                          {derived.heightMeters.toFixed(1)} m
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-1 text-[11px] text-muted-foreground">
                        <span>
                          {t('cadImport.selectedSummary', {
                            layers: selected.size,
                            count: entityCount,
                          })}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-end flex-shrink-0 gap-2 px-5 py-4 border-t bg-background">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={rendering}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={!info || rendering || inspecting || selected.size === 0}
            >
              {rendering && <Loader2 className="w-3.5 h-3.5 me-2 animate-spin" />}
              {t('cadImport.confirm', { defaultValue: 'Use this drawing' })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
