import { cn } from '@/lib/utils'
import type { ReportWidget } from '@/lib/reports-client'

interface NoteBindings {
  content: string
  /** Optional tone — none = plain card, info/tip/warn colours the border. */
  tone?: 'plain' | 'info' | 'tip' | 'warn'
}

const TONE_CLASSES: Record<NonNullable<NoteBindings['tone']>, string> = {
  plain: 'border-border bg-card',
  info: 'border-info/40 bg-info/5',
  tip: 'border-success/40 bg-success/5',
  warn: 'border-warning/40 bg-warning/5',
}

/**
 * Non-data commentary block — usable inside a dashboard when the
 * report author wants to explain a chart or link to context. Simpler
 * cousin of Markdown: single paragraph, no headings, no lists.
 */
export function NoteWidget({ widget }: { widget: ReportWidget }) {
  const b = (widget.bindings ?? {}) as NoteBindings
  const tone = b.tone ?? 'plain'
  return (
    <div className={cn('h-full rounded-xl border p-4 text-sm leading-relaxed', TONE_CLASSES[tone])}>
      {widget.title && <div className="text-xs font-medium mb-1 text-muted-foreground">{widget.title}</div>}
      <p className="whitespace-pre-wrap">{b.content ?? ''}</p>
    </div>
  )
}
