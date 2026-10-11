/**
 * Multi-step plumbing for /signup and /forgot-password: the segmented
 * progress bar, the keyed step container that animates each step in
 * (direction-aware, mirrored in RTL), and the success check.
 */

import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export function StepProgress({ labels, current }: { labels: string[]; current: number }) {
  const { t } = useTranslation()
  return (
    <nav aria-label={t('auth.progressLabel')} className="mb-7">
      <p className="sr-only">
        {t('auth.stepOf', { current: current + 1, total: labels.length })}: {labels[current]}
      </p>
      <ol className="flex gap-2" aria-hidden>
        {labels.map((label, i) => (
          <li key={label} className="min-w-0 flex-1 space-y-1.5">
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none',
                  i <= current ? 'w-full' : 'w-0',
                )}
              />
            </div>
            <p
              className={cn(
                'truncate text-[11px] font-medium transition-colors',
                i === current ? 'text-foreground' : i < current ? 'text-muted-foreground' : 'text-muted-foreground/60',
              )}
            >
              {label}
            </p>
          </li>
        ))}
      </ol>
    </nav>
  )
}

/**
 * Re-mounts its children whenever `step` changes so the entry animation
 * plays; slides from the end side when moving forward, from the start side
 * when moving back.
 */
export function StepTransition({ step, index, children }: { step: string; index: number; children: ReactNode }) {
  // Derive direction from the previous index (React's "adjust state
  // during render" pattern — no effect, no ref read in render).
  const [prevIndex, setPrevIndex] = useState(index)
  const [dir, setDir] = useState<'forward' | 'back'>('forward')
  if (index !== prevIndex) {
    setDir(index < prevIndex ? 'back' : 'forward')
    setPrevIndex(index)
  }
  return (
    <div key={step} className="sgv-auth-step" data-dir={dir}>
      {children}
    </div>
  )
}

/** Animated check for a completed flow (draws in; static under reduced motion). */
export function SuccessCheck() {
  return (
    <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
      <svg viewBox="0 0 52 52" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden>
        <circle className="sgv-auth-check-circle" cx="26" cy="26" r="23" pathLength={1} strokeOpacity={0.35} />
        <path
          className="sgv-auth-check-tick"
          d="M15 27 l7.5 7.5 L37 19"
          pathLength={1}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
