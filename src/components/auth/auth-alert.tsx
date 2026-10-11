/**
 * Form-level message on the auth screens.
 *
 * `error` uses role="alert" so it's announced without stealing focus (the
 * user usually wants to stay in the field they're fixing); `info` and
 * `success` use role="status" (WCAG 4.1.3). Errors also get the brief
 * shake — never the only signal, and skipped under reduced motion. Give
 * the alert a changing `key` per occurrence so a repeated error replays
 * the entry and is re-announced.
 */

import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

type Tone = 'error' | 'info' | 'success'

const TONE: Record<Tone, { cls: string; Icon: typeof Info; role: 'alert' | 'status' }> = {
  error: {
    cls: 'border-destructive/40 bg-destructive/[0.07] text-destructive sgv-auth-shake',
    Icon: CircleAlert,
    role: 'alert',
  },
  info: { cls: 'border-border bg-muted/60 text-foreground', Icon: Info, role: 'status' },
  success: { cls: 'border-primary/30 bg-primary/[0.07] text-foreground', Icon: CircleCheck, role: 'status' },
}

export function AuthAlert({
  tone = 'error',
  children,
  action,
  className,
}: {
  tone?: Tone
  children: ReactNode
  /** Optional follow-up link/button rendered under the message. */
  action?: ReactNode
  className?: string
}) {
  const { cls, Icon, role } = TONE[tone]
  return (
    <div role={role} className={cn('sgv-auth-alert flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm', cls, className)}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'success' && 'text-primary')} />
      <div className="min-w-0 space-y-1.5 leading-snug">
        <div>{children}</div>
        {action && <div className="font-medium">{action}</div>}
      </div>
    </div>
  )
}
