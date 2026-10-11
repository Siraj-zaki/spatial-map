/**
 * Load-failure state for a page or panel: says what failed in plain words,
 * distinguishes "you're offline" from "the server had a problem", and
 * offers Retry (and retries by itself when the connection comes back).
 */

import { useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { CloudOff, RefreshCw, ServerCrash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api-client'
import { cn } from '@/lib/utils'

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
}

export function QueryError({
  error,
  onRetry,
  what,
  compact,
  className,
}: {
  error: unknown
  onRetry: () => void
  /** What failed to load, e.g. "your facilities". */
  what?: string
  compact?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const online = useOnline()
  // Reconnecting retries automatically.
  useEffect(() => {
    if (!online) return
    const handler = () => onRetry()
    window.addEventListener('online', handler)
    return () => window.removeEventListener('online', handler)
  }, [online, onRetry])

  const offline = !online || (error instanceof ApiError && error.kind === 'network')
  const Icon = offline ? CloudOff : ServerCrash
  const title = offline
    ? t('errors.offlineTitle', { defaultValue: 'You’re offline' })
    : t('errors.loadTitle', { defaultValue: 'Couldn’t load {{what}}', what: what ?? t('errors.thisPage', { defaultValue: 'this page' }) })
  const body = offline
    ? t('errors.offlineBody', { defaultValue: 'Check your connection. We’ll retry automatically when you’re back online.' })
    : t('errors.loadBody', { defaultValue: 'Something went wrong on our side. Try again in a moment.' })

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center',
        compact ? 'px-4 py-8' : 'rounded-xl border border-dashed bg-card/50 px-6 py-12',
        className,
      )}
    >
      <div className={cn('flex h-10 w-10 items-center justify-center rounded-full', offline ? 'bg-muted text-muted-foreground' : 'bg-danger/10 text-danger')}>
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="h-3.5 w-3.5" />
        {t('common.retry', { defaultValue: 'Retry' })}
      </Button>
    </div>
  )
}
