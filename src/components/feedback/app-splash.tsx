/**
 * Full-screen splash while the app can't render a page yet: the session
 * check (AuthGuard) and the first workspace lookup (TenantProvider). The
 * logo and an indeterminate track show at once; the caption only after
 * 600 ms so a quick start never flashes text. Static under reduced motion.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function AppSplash({ label, detail }: { label?: string; detail?: string }) {
  const { t } = useTranslation()
  const [showCaption, setShowCaption] = useState(false)
  useEffect(() => {
    const h = window.setTimeout(() => setShowCaption(true), 600)
    return () => window.clearTimeout(h)
  }, [])
  const text = label ?? t('common.loadingWorkspace', { defaultValue: 'Loading your workspace…' })
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-background px-6" role="status" aria-live="polite" aria-label={text}>
      <div className="sgv-rise flex items-center gap-2.5">
        <img src="/logo.png" alt="" className="h-9 w-auto" />
        <span className="text-lg font-semibold tracking-tight text-foreground">Spatial Map</span>
      </div>
      <div className="relative h-1 w-44 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className="sgv-indeterminate absolute inset-y-0 start-0 w-1/3 rounded-full bg-primary" />
      </div>
      <div className={`text-center transition-opacity duration-300 ${showCaption ? 'opacity-100' : 'opacity-0'}`}>
        <p className="text-xs text-muted-foreground">{text}</p>
        {detail && <p className="mt-1 text-[11px] tabular-nums text-muted-foreground/80">{detail}</p>}
      </div>
    </div>
  )
}

/**
 * The very first frame, while translations load (main.tsx's Suspense
 * fallback): no i18n and no theme provider yet, so it reads the saved
 * theme itself — a dark-mode user never sees a white flash — and shows
 * only the logo and the track.
 */
export function BootSplash() {
  let dark = true
  try {
    const saved = localStorage.getItem('vite-ui-theme') ?? 'dark'
    dark = saved === 'dark' || (saved === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  } catch {
    /* storage blocked — the default theme is dark */
  }
  return (
    <div className={`${dark ? 'dark ' : ''}fixed inset-0`}>
      <div className="flex h-full flex-col items-center justify-center gap-5 bg-background" role="status" aria-busy>
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="h-9 w-auto" />
          <span className="text-lg font-semibold tracking-tight text-foreground">Spatial Map</span>
        </div>
        <div className="relative h-1 w-44 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className="sgv-indeterminate absolute inset-y-0 start-0 w-1/3 rounded-full bg-primary" />
        </div>
      </div>
    </div>
  )
}
