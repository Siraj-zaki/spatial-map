import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, CloudOff, Loader2, RotateCw } from 'lucide-react'

import { useSpatialStore } from '@/lib/spatial-store'
import { fullTime } from '@/lib/relative-time'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'

/**
 * Save state for the editor, beside the facility name: "Saving…" while
 * changes are queued or on the wire, "Saved" once confirmed (full time on
 * hover), "Offline · Retry" when saves are failing for network
 * reasons. A change the server refused is rolled back by the store and
 * reported here once, as a toast. Nothing shows until the first edit.
 */
export function SaveStatus() {
  const { t, i18n } = useTranslation()
  const pending = useSpatialStore((s) => s.sync.pending)
  const failed = useSpatialStore((s) => s.sync.failed)
  const lastSavedAt = useSpatialStore((s) => s.sync.lastSavedAt)
  const retryFailed = useSpatialStore((s) => s.retryFailed)
  const dismissFailure = useSpatialStore((s) => s.dismissFailure)

  // Refused changes: say so once, then forget them.
  useEffect(() => {
    for (const f of failed) {
      if (f.retrying) continue
      toast.error(t('editor.save.refused', { defaultValue: 'A change couldn’t be saved and was undone' }), {
        description: f.message,
      })
      dismissFailure(f.kind, f.id)
    }
  }, [failed, dismissFailure, t])

  // "Saved" reads as just-happened for a few seconds, then settles.
  const [fresh, setFresh] = useState(false)
  const [seen, setSeen] = useState(lastSavedAt)
  if (seen !== lastSavedAt) {
    setSeen(lastSavedAt)
    setFresh(true)
  }
  useEffect(() => {
    if (!fresh) return
    const h = window.setTimeout(() => setFresh(false), 2500)
    return () => window.clearTimeout(h)
  }, [fresh])

  const retrying = failed.some((f) => f.retrying)
  if (!retrying && pending === 0 && lastSavedAt === null) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border bg-card/90 px-2.5 text-xs shadow-sm backdrop-blur',
        retrying && 'border-warning/40',
      )}
    >
      {retrying ? (
        <>
          <CloudOff className="h-3.5 w-3.5 text-warning" aria-hidden />
          <span className="text-foreground">{t('editor.save.offline', { defaultValue: 'Offline' })}</span>
          <button
            type="button"
            onClick={retryFailed}
            className="ms-0.5 inline-flex items-center gap-1 rounded px-1 font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCw className="h-3 w-3" aria-hidden />
            {t('editor.save.retry', { defaultValue: 'Retry' })}
          </button>
        </>
      ) : pending > 0 ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
          <span className="text-muted-foreground">{t('editor.save.saving', { defaultValue: 'Saving…' })}</span>
        </>
      ) : failed.length > 0 ? (
        <>
          <AlertCircle className="h-3.5 w-3.5 text-danger" aria-hidden />
          <span className="text-foreground">{t('editor.save.failed', { defaultValue: 'Not saved' })}</span>
        </>
      ) : (
        <span
          className="flex items-center gap-1.5 text-muted-foreground"
          title={lastSavedAt ? fullTime(new Date(lastSavedAt).toISOString(), i18n.language) : undefined}
        >
          <Check className={cn('h-3.5 w-3.5', fresh ? 'text-success' : 'text-muted-foreground')} aria-hidden />
          {t('editor.save.saved', { defaultValue: 'Saved' })}
        </span>
      )}
    </div>
  )
}

/**
 * Don't lose queued edits: save them when the tab is hidden or the editor
 * unmounts, and ask before closing / reloading while any are unsaved.
 */
export function useUnsavedEditsGuard() {
  useEffect(() => {
    const store = useSpatialStore
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (store.getState().sync.pending === 0) return
      void store.getState().commit()
      e.preventDefault()
      e.returnValue = ''
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void store.getState().commit()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('visibilitychange', onHidden)
      // Leaving the editor in-app: the queue lives in the store module,
      // so sending it now still completes after unmount.
      void store.getState().commit()
    }
  }, [])
}
