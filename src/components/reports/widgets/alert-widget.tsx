import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ReportWidget } from '@/lib/reports-client'

interface AlertBindings {
  content: string
  tone?: 'info' | 'success' | 'warn' | 'error'
}

const TONES = {
  info: { border: 'border-info/50', bg: 'bg-info/10', fg: 'text-info', Icon: Info },
  success: {
    border: 'border-success/50',
    bg: 'bg-success/10',
    fg: 'text-success',
    Icon: CheckCircle2,
  },
  warn: {
    border: 'border-warning/50',
    bg: 'bg-warning/10',
    fg: 'text-warning',
    Icon: TriangleAlert,
  },
  error: { border: 'border-danger/50', bg: 'bg-danger/10', fg: 'text-danger', Icon: AlertCircle },
} as const

/**
 * Attention-grabbing banner. Meant for dashboard-level context —
 * "revenue dip in Q2 explained here". Distinct from Note by having a
 * strong tone and a leading icon.
 */
export function AlertWidget({ widget }: { widget: ReportWidget }) {
  const b = (widget.bindings ?? {}) as AlertBindings
  const cfg = TONES[b.tone ?? 'info']
  const Icon = cfg.Icon
  return (
    <div className={cn('flex h-full items-start gap-3 rounded-xl border p-4', cfg.border, cfg.bg)}>
      <Icon className={cn('w-5 h-5 mt-0.5 shrink-0', cfg.fg)} />
      <div className={cn('text-sm leading-relaxed', cfg.fg)}>
        {widget.title && <div className="font-semibold mb-0.5">{widget.title}</div>}
        <p className="whitespace-pre-wrap">{b.content ?? ''}</p>
      </div>
    </div>
  )
}
