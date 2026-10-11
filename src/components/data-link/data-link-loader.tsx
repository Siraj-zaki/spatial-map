/**
 * Full-screen premium loader for data-link layers.
 *
 * Shows when at least one MapDataLinkedOverlay sub-renderer's fetch is
 * in flight. Reads from `useDataLinkLoadingStore` — no React re-render
 * unless the aggregate flips or the loading-layer set changes.
 *
 * Behaviour:
 *   • Grace period (200 ms): a fetch that completes fast doesn't
 *     produce a flash. Skips mount until loading has been sustained.
 *   • Progress readout: shows N loading + names of up to 3 layers so
 *     users know WHICH feed is stalling.
 *   • Smooth fade in / fade out, no layout thrash.
 *   • Fully overlays the map but sits below dialogs (z-30, well below
 *     shadcn Dialog's z-50).
 *   • Backdrop-blur + gradient card matches the /view drawer aesthetic
 *     already used in the app.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Radio, Sparkles } from 'lucide-react'
import { useDataLinkLoadingStore } from '@/lib/data-link/loading-store'
import { cn } from '@/lib/utils'

const GRACE_MS = 200

/**
 * `overlay` (viewer): the full-screen card described above.
 * `pill` (editor): a small non-blocking status under the place search —
 * the editor is a working surface, and covering it every time a layer
 * refetched for more than 200 ms stopped the user mid-edit.
 */
export function DataLinkFullScreenLoader({
  variant = 'overlay',
  pillClassName = 'start-1/2 top-16 -translate-x-1/2 rtl:translate-x-1/2',
}: {
  variant?: 'overlay' | 'pill'
  /** Pill placement, so the editor can keep it clear of the place search. */
  pillClassName?: string
}) {
  const { t } = useTranslation()
  const loading = useDataLinkLoadingStore((s) => s.loading)
  const anyLoading = loading.size > 0
  // Shown only once loading has lasted GRACE_MS (fast loads never flash).
  const [graceDone, setGraceDone] = useState(false)
  if (!anyLoading && graceDone) setGraceDone(false)
  useEffect(() => {
    if (!anyLoading) return
    const h = setTimeout(() => setGraceDone(true), GRACE_MS)
    return () => clearTimeout(h)
  }, [anyLoading])

  if (!anyLoading || !graceDone) return null

  const names = Array.from(loading.values())
    .map((v) => v.configName)
    .slice(0, 3)
  const overflow = loading.size - names.length
  const title = t('dataLink.loadingLayers', { count: loading.size, defaultValue: 'Loading {{count}} layers' })

  if (variant === 'pill') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn('sgv-fade pointer-events-none absolute z-20 flex items-center gap-2 rounded-full border bg-card/95 px-3 py-1.5 text-xs shadow-md backdrop-blur', pillClassName)}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
        <span className="font-medium">{title}</span>
        {names[0] && <span className="max-w-[12rem] truncate text-muted-foreground">{names.join(', ')}{overflow > 0 ? ` +${overflow}` : ''}</span>}
      </div>
    )
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center animate-in fade-in duration-200"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-background/50 backdrop-blur-md" />

      {/* Card */}
      <div className="relative min-w-[320px] max-w-md rounded-2xl border border-border/60 bg-background/95 px-8 py-6 shadow-2xl">
        {/* Ambient gradient behind spinner */}
        <div className="pointer-events-none absolute -start-6 -top-6 h-24 w-24 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-6 -end-6 h-24 w-24 rounded-full bg-info/20 blur-3xl" />

        <div className="relative flex flex-col items-center gap-4">
          {/* Spinner ring */}
          <div className="relative">
            <div className="absolute inset-0 animate-ping rounded-full bg-primary/10 motion-reduce:animate-none" />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-primary to-info shadow-lg shadow-primary/20">
              <Loader2 className="h-7 w-7 animate-spin text-primary-foreground motion-reduce:animate-none" strokeWidth={2.5} />
            </div>
          </div>

          {/* Title */}
          <div className="text-center">
            <div className="mb-1 flex items-center justify-center gap-1.5">
              <Radio size={13} className="text-primary" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                {t('dataLink.liveData', { defaultValue: 'Live data' })}
              </span>
            </div>
            <h3 className="text-base font-semibold">{title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('dataLink.loadingBody', { defaultValue: 'Filtering records on the server and staging features for the map.' })}
            </p>
          </div>

          {/* Layer names */}
          {names.length > 0 && (
            <div className="w-full">
              <div className="grid gap-1.5 border-t border-border/60 pt-3">
                {names.map((n) => (
                  <div key={n} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Sparkles size={11} className="shrink-0 text-primary/80" />
                    <span className="truncate">{n}</span>
                  </div>
                ))}
                {overflow > 0 && (
                  <div className="ps-4 text-xs text-muted-foreground/60">
                    {t('dataLink.loadingMore', { count: overflow, defaultValue: '+ {{count}} more' })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
