/**
 * The thin progress bar along the top edge of every screen — shown while a
 * screen loads after navigation and while a save / delete / upload is in
 * flight (src/lib/loading-bar.ts decides what counts). Waits 150 ms before
 * appearing so fast requests never flash it; trickles towards 90 % while
 * waiting, completes to 100 % and fades out when done. Static (no trickle,
 * no glide) under prefers-reduced-motion. Theme colour only.
 */
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { markNavigation, useLoadingActive } from '@/lib/loading-bar'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/utils'

const SHOW_DELAY_MS = 150

export function TopLoadingBar() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const active = useLoadingActive()
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  // idle → (delay) → running → done (fills, fades) → idle
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle')
  const [trickle, setTrickle] = useState(0.12)

  // Reads right after a route change belong to the new screen.
  useEffect(() => {
    markNavigation()
  }, [pathname])

  useEffect(() => {
    if (active) {
      const h = window.setTimeout(() => {
        setPhase((p) => {
          if (p !== 'running') setTrickle(0.12)
          return 'running'
        })
      }, SHOW_DELAY_MS)
      return () => window.clearTimeout(h)
    }
    const h = window.setTimeout(() => setPhase((p) => (p === 'running' ? 'done' : p)), 0)
    return () => window.clearTimeout(h)
  }, [active])

  // Done: hold at 100 % while fading, then reset.
  useEffect(() => {
    if (phase !== 'done') return
    const h = window.setTimeout(() => setPhase('idle'), 420)
    return () => window.clearTimeout(h)
  }, [phase])

  // Trickle: approach 90 % ever more slowly while waiting.
  useEffect(() => {
    if (phase !== 'running' || reduced) return
    const h = window.setInterval(() => setTrickle((p) => p + (0.9 - p) * 0.08), 220)
    return () => window.clearInterval(h)
  }, [phase, reduced])

  const progress = phase === 'done' ? 1 : phase === 'idle' ? 0 : trickle

  return (
    <div
      className={cn(
        'pointer-events-none fixed inset-x-0 top-0 z-[200] h-[3px] transition-opacity duration-300',
        phase === 'idle' ? 'opacity-0' : 'opacity-100',
        phase === 'done' && 'delay-150 opacity-0',
      )}
      role="progressbar"
      aria-hidden={phase === 'idle'}
      aria-label={t('common.loading', { defaultValue: 'Loading…' })}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
    >
      <div
        className={cn('relative h-full origin-left bg-primary rtl:origin-right', !reduced && phase !== 'idle' && 'transition-transform duration-200 ease-out')}
        style={{ transform: `scaleX(${reduced && phase === 'running' ? 1 : progress})` }}
      >
        {/* A soft glow at the leading edge. */}
        <span className="absolute -top-px end-0 h-[5px] w-24 rounded-full bg-primary opacity-60 blur-[3px]" aria-hidden />
      </div>
    </div>
  )
}
