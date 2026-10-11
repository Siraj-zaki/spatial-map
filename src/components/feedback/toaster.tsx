/**
 * Renders the toast stack (bottom-end, above everything). Polite live region
 * so screen readers announce outcomes without interrupting. Each toast
 * pauses its timer while hovered or focused so an Undo is never snatched
 * away mid-reach.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { useToastStore, type Toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'

const ICON = { success: CircleCheck, info: Info, error: CircleAlert } as const

function ToastItem({ toast }: { toast: Toast }) {
  const { t } = useTranslation()
  const dismiss = useToastStore((s) => s.dismiss)
  const [paused, setPaused] = useState(false)
  const remaining = useRef(toast.duration)
  const startedAt = useRef(0)

  useEffect(() => {
    if (paused) return
    startedAt.current = Date.now()
    const id = window.setTimeout(() => dismiss(toast.id), remaining.current)
    return () => {
      window.clearTimeout(id)
      remaining.current -= Date.now() - startedAt.current
    }
  }, [paused, dismiss, toast.id])

  const Icon = ICON[toast.tone]
  return (
    <li
      className="sgv-toast pointer-events-auto flex w-full items-start gap-3 rounded-xl border bg-popover p-3.5 text-popover-foreground shadow-lg sm:w-[360px]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          toast.tone === 'success' ? 'text-success' : toast.tone === 'error' ? 'text-danger' : 'text-info',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{toast.title}</p>
        {toast.description && <p className="mt-0.5 text-sm text-muted-foreground">{toast.description}</p>}
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action!.onClick()
            dismiss(toast.id)
          }}
          className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('common.dismiss', { defaultValue: 'Dismiss' })}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  )
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  return (
    <ol
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed bottom-4 end-4 start-4 z-[100] flex flex-col items-end gap-2 sm:start-auto"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </ol>
  )
}
