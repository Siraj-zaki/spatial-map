import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Loader2, Ruler, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  describeSheet,
  inspectPdf,
  realWorldSize,
  renderPdfPage,
  type PdfInspectResult,
  type PdfPage,
  type PdfRenderResult,
} from '@/lib/pdf-import'

/**
 * Page + scale picker shown when the user drops a PDF into the floor-plan
 * image tool.
 *
 * Two decisions are made here that the raster path can't make for the
 * user. Which sheet in the drawing set is the floor plan (a set is
 * typically 20+ pages of which one or two are plans), and what plot
 * scale it was drawn at. The second one is the valuable half: knowing
 * the scale turns "drag a rectangle until it looks right" into a
 * placement at the drawing's true real-world width.
 *
 * Position and rotation still have to be a human judgement — a PDF
 * carries no CRS, no origin and no north — so this hands off to the
 * existing drag-to-place interaction rather than replacing it.
 */

export interface PdfPickResult {
  render: PdfRenderResult
  /** Chosen plot scale denominator (N in 1:N), or 0 when not calibrated. */
  scaleDenominator: number
  /** Real-world width implied by the scale, 0 when not calibrated. */
  realWidthMeters: number
  /** Real-world height implied by the scale, 0 when not calibrated. */
  realHeightMeters: number
}

export function PdfPagePicker({
  file,
  onCancel,
  onConfirm,
}: {
  /** The PDF the user picked. Null closes the dialog. */
  file: File | null
  onCancel: () => void
  onConfirm: (result: PdfPickResult) => void
}) {
  const { t } = useTranslation()
  const [inspecting, setInspecting] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<PdfInspectResult | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [scaleDenominator, setScaleDenominator] = useState(0)
  const [knownWidth, setKnownWidth] = useState('')

  // Clearing on close matters because the dialog stays mounted while
  // Radix plays its exit animation — without the reset, reopening with a
  // different PDF would flash the previous document's sheets. The
  // `react-hooks/set-state-in-effect` disables follow the convention in
  // `model-preview.tsx`: resetting external-derived state when the input
  // changes is exactly what the effect is for.
  useEffect(() => {
    if (!file) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setInfo(null)
      setError(null)
      setPageIndex(0)
      setScaleDenominator(0)
      setKnownWidth('')
      /* eslint-enable react-hooks/set-state-in-effect */
      return
    }
    let cancelled = false
    setInspecting(true)
    setError(null)
    inspectPdf(file)
      .then((result) => {
        if (cancelled) return
        setInfo(result)
        setPageIndex(0)
        setScaleDenominator(result.suggestedScales[0]?.denominator ?? 0)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(
          err instanceof Error
            ? err.message
            : t('pdfImport.errorGeneric', {
                defaultValue: 'Could not read this PDF.',
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

  const page: PdfPage | null = info?.pages[pageIndex] ?? null

  // Scales are ranked per-page: a title sheet and a site plan in the
  // same set can be different sizes, so the plausible scale list moves
  // with the selection.
  const scales = info?.suggestedScales ?? []

  const derived = useMemo(() => {
    if (!page || scaleDenominator <= 0) return null
    return realWorldSize(page, scaleDenominator)
  }, [page, scaleDenominator])

  // Typing a known real-world width solves for the scale instead of
  // requiring the user to read it off a title block they may not have.
  const applyKnownWidth = useCallback(
    (raw: string) => {
      setKnownWidth(raw)
      const meters = Number.parseFloat(raw)
      if (!page || !Number.isFinite(meters) || meters <= 0) return
      setScaleDenominator((meters * 1000) / page.widthMm)
    },
    [page],
  )

  const handleConfirm = useCallback(async () => {
    if (!file || !page) return
    setRendering(true)
    setError(null)
    try {
      const render = await renderPdfPage(file, page.index, info?.suggestedDpi)
      const size = scaleDenominator > 0 ? realWorldSize(page, scaleDenominator) : null
      onConfirm({
        render,
        scaleDenominator: scaleDenominator > 0 ? scaleDenominator : 0,
        realWidthMeters: size?.widthMeters ?? 0,
        realHeightMeters: size?.heightMeters ?? 0,
      })
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : t('pdfImport.errorRender', {
              defaultValue: 'Could not render this page.',
            }),
      )
    } finally {
      setRendering(false)
    }
  }, [file, page, info, scaleDenominator, onConfirm, t])

  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-3xl w-[95vw] p-0 gap-0 overflow-hidden">
        <div className="flex flex-col max-h-[85dvh]">
          <DialogHeader className="flex flex-row items-center gap-3 px-5 py-4 border-b space-y-0 flex-shrink-0">
            <div className="flex items-center justify-center flex-shrink-0 rounded-lg w-9 h-9 bg-primary/10">
              <FileText className="w-4 h-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-semibold leading-tight">
                {t('pdfImport.title', { defaultValue: 'Import floor plan from PDF' })}
              </DialogTitle>
              <DialogDescription className="text-xs leading-snug text-muted-foreground mt-0.5">
                {t('pdfImport.subtitle', {
                  defaultValue:
                    'Choose the sheet to place, then set its drawing scale.',
                })}
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {inspecting && (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('pdfImport.reading', { defaultValue: 'Reading PDF…' })}
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
                <div className="px-5 py-4 border-b">
                  <div className="flex items-baseline justify-between mb-3">
                    <h3 className="text-xs font-medium uppercase text-muted-foreground tracking-wide">
                      {t('pdfImport.pagesTitle', { defaultValue: 'Sheet' })}
                    </h3>
                    <span className="text-[11px] text-muted-foreground">
                      {t('pdfImport.pageCount', { count: info.pageCount })}
                    </span>
                  </div>

                  {info.hasThumbnails ? (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {info.pages.map((p) => (
                        <button
                          key={p.index}
                          type="button"
                          onClick={() => setPageIndex(p.index)}
                          aria-current={p.index === pageIndex ? 'true' : undefined}
                          className={`group flex flex-col gap-1 p-1.5 border rounded-md transition-colors text-start ${
                            p.index === pageIndex
                              ? 'border-primary bg-primary/10'
                              : 'border-border hover:bg-accent'
                          }`}
                        >
                          <div className="flex items-center justify-center w-full overflow-hidden rounded-sm h-28 bg-white">
                            {p.thumbnail ? (
                              <img
                                src={p.thumbnail}
                                alt=""
                                className="object-contain max-w-full max-h-full"
                              />
                            ) : (
                              <FileText className="w-6 h-6 text-muted-foreground" />
                            )}
                          </div>
                          <span className="text-[11px] font-medium">
                            {t('pdfImport.pageLabel', {
                              page: p.index + 1,
                              defaultValue: 'Page {{page}}',
                            })}
                          </span>
                          <span dir="ltr" className="text-[10px] text-muted-foreground truncate">
                            {describeSheet(p)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    // Above the preview cap, rendering every thumbnail
                    // would cost more than it's worth — fall back to a
                    // plain page number.
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-muted-foreground" htmlFor="pdf-page-number">
                        {t('pdfImport.pageNumber', { defaultValue: 'Page number' })}
                      </label>
                      <Input
                        id="pdf-page-number"
                        type="number"
                        min={1}
                        max={info.pageCount}
                        value={pageIndex + 1}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10)
                          if (Number.isFinite(n)) {
                            setPageIndex(Math.min(Math.max(n - 1, 0), info.pageCount - 1))
                          }
                        }}
                        className="w-24 h-8"
                      />
                    </div>
                  )}
                </div>

                <div className="px-5 py-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Ruler className="w-3.5 h-3.5 text-muted-foreground" />
                    <h3 className="text-xs font-medium tracking-wide uppercase text-muted-foreground">
                      {t('pdfImport.scaleTitle', { defaultValue: 'Drawing scale' })}
                    </h3>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t('pdfImport.scaleHint')}
                  </p>

                  <div className="flex flex-wrap gap-1.5">
                    {/* A PDF does not record its plot scale, so the chips
                        below are ranked guesses. Without an explicit way
                        to decline, the top guess gets committed silently
                        and every measurement taken off the plan is wrong
                        — worse than an openly unscaled placement. */}
                    <button
                      type="button"
                      onClick={() => {
                        setScaleDenominator(0)
                        setKnownWidth('')
                      }}
                      className={`px-2.5 py-1 text-[11px] border rounded-md transition-colors ${
                        scaleDenominator <= 0
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:bg-accent'
                      }`}
                    >
                      {t('pdfImport.scaleNone')}
                    </button>
                    {scales.slice(0, 8).map((s) => (
                      <button
                        key={s.label}
                        type="button"
                        // Scale notation (`1/8" = 1'-0"`) is a formula, not
                        // prose — the bidi algorithm reorders it into
                        // nonsense under an RTL paragraph without this.
                        dir="ltr"
                        onClick={() => {
                          setScaleDenominator(s.denominator)
                          setKnownWidth('')
                        }}
                        className={`px-2.5 py-1 text-[11px] font-mono border rounded-md transition-colors ${
                          Math.abs(s.denominator - scaleDenominator) < 0.01
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border hover:bg-accent'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <label
                      className="text-[11px] text-muted-foreground"
                      htmlFor="pdf-known-width"
                    >
                      {t('pdfImport.knownWidth', {
                        defaultValue: 'Or enter a known width (m)',
                      })}
                    </label>
                    <Input
                      id="pdf-known-width"
                      type="number"
                      min={0}
                      step="0.1"
                      value={knownWidth}
                      onChange={(e) => applyKnownWidth(e.target.value)}
                      className="w-28 h-8"
                    />
                  </div>

                  {page && !derived && (
                    <div className="px-3 py-2 text-xs border rounded-md bg-muted/40 text-muted-foreground">
                      {t('pdfImport.scaleNoneNote')}
                    </div>
                  )}

                  {page && derived && (
                    <div className="px-3 py-2 text-xs border rounded-md bg-muted/40">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          {t('pdfImport.resultingSize', {
                            defaultValue: 'Places at',
                          })}
                        </span>
                        {/* Dimension readouts are formulas — under an RTL
                            paragraph the bidi algorithm floats the trailing
                            `m` to the front ("m 39.0 × 58.5"). */}
                        <span dir="ltr" className="font-mono font-medium">
                          {derived.widthMeters.toFixed(1)} × {derived.heightMeters.toFixed(1)} m
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-1 text-[11px] text-muted-foreground">
                        <span dir="ltr">{describeSheet(page)}</span>
                        <span dir="ltr" className="font-mono">1:{Math.round(scaleDenominator)}</span>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-end flex-shrink-0 gap-2 px-5 py-3 border-t bg-muted/30">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={rendering}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={!page || rendering || inspecting}
            >
              {rendering && <Loader2 className="w-3.5 h-3.5 me-2 animate-spin" />}
              {t('pdfImport.confirm', { defaultValue: 'Use this sheet' })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
