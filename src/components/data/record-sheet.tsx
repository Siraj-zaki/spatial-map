/**
 * Record detail panel for the Data screen (records, rooms & bins, runs).
 * Non-modal so the table stays visible and clickable; ↑/↓ (or k/j) and the
 * header arrows step through the rows on the current page, and the body
 * cross-fades per record so stepping reads as motion, not a reload.
 *
 * Header: title + where it came from (a link to the table or integration).
 * Then the facts (received / updated / archived…), and the payload as a
 * readable field list or raw JSON, with copy and delete.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, ChevronDown, ChevronUp, Copy, ExternalLink, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { FilterTabs } from '@/components/filter-tabs'
import { cn } from '@/lib/utils'
import { payloadEntries } from './data-helpers'

export interface RecordDetail {
  /** Stable identity — the body re-animates when it changes. */
  id: string
  title: string
  badges?: React.ReactNode
  source?: { label: string; to?: string }
  facts: { label: string; value: React.ReactNode; title?: string }[]
  payload: unknown
  /** Shown above the payload, e.g. a run's error report. */
  alert?: string
}

export function RecordSheet({
  record,
  onClose,
  onPrev,
  onNext,
  position,
  onDelete,
}: {
  record: RecordDetail | null
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  /** e.g. "3 of 50". */
  position?: string
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'fields' | 'json'>('fields')
  const [copied, setCopied] = useState(false)

  // ↑/↓ or k/j step through the page while the panel is open — but never
  // while typing in a field.
  useEffect(() => {
    if (!record) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if ((e.key === 'ArrowDown' || e.key === 'j') && onNext) {
        e.preventDefault()
        onNext()
      } else if ((e.key === 'ArrowUp' || e.key === 'k') && onPrev) {
        e.preventDefault()
        onPrev()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [record, onNext, onPrev])

  if (!record) return null
  const entries = payloadEntries(record.payload)
  let json: string
  try {
    json = typeof record.payload === 'string' ? record.payload : JSON.stringify(record.payload, null, 2)
  } catch {
    json = String(record.payload)
  }
  const showFields = entries && mode === 'fields'

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} modal={false}>
      <SheetContent side="end" className="w-[min(520px,100vw)] rounded-none sm:rounded-s-xl" onFocusOutside={(e) => e.preventDefault()}>
        <div className="flex items-start gap-2 border-b px-4 py-3 pe-12">
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate font-mono text-base" dir="ltr" title={record.title}>
              {record.title}
            </SheetTitle>
            <SheetDescription asChild>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {record.source &&
                  (record.source.to ? (
                    <Link to={record.source.to} className="inline-flex items-center gap-1 rounded hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {record.source.label}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </Link>
                  ) : (
                    <span>{record.source.label}</span>
                  ))}
                {record.badges}
              </div>
            </SheetDescription>
          </div>
          {(onPrev || onNext) && (
            <div className="flex shrink-0 items-center gap-1">
              {position && <span className="me-1 text-xs tabular-nums text-muted-foreground">{position}</span>}
              <Button variant="outline" size="icon" className="h-7 w-7" disabled={!onPrev} onClick={onPrev} aria-label={t('data.detail.prev', { defaultValue: 'Previous record' })} title={t('data.detail.prevHint', { defaultValue: 'Previous (↑)' })}>
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-7 w-7" disabled={!onNext} onClick={onNext} aria-label={t('data.detail.next', { defaultValue: 'Next record' })} title={t('data.detail.nextHint', { defaultValue: 'Next (↓)' })}>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        <div key={record.id} className="sgv-fade min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
          {record.facts.length > 0 && (
            <dl className="divide-y rounded-lg border text-sm">
              {record.facts.map((f) => (
                <div key={f.label} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-3 px-3 py-2">
                  <dt className="text-muted-foreground">{f.label}</dt>
                  <dd className="min-w-0 truncate" title={f.title}>
                    {f.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {record.alert && (
            <pre role="alert" className="whitespace-pre-wrap break-words rounded-lg border border-danger/30 bg-danger/5 p-3 font-mono text-xs text-danger" dir="ltr">
              {record.alert}
            </pre>
          )}

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              {entries ? (
                <FilterTabs
                  ariaLabel={t('data.detail.view', { defaultValue: 'View' })}
                  value={mode}
                  onChange={setMode}
                  items={[
                    { value: 'fields', label: t('data.detail.fields', { defaultValue: 'Fields' }), count: entries.length },
                    { value: 'json', label: 'JSON' },
                  ]}
                />
              ) : (
                <h3 className="text-sm font-semibold">{t('data.detail.payload', { defaultValue: 'Payload' })}</h3>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(json)
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1500)
                  } catch {
                    /* clipboard blocked */
                  }
                }}
              >
                {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? t('common.copied', { defaultValue: 'Copied' }) : t('data.detail.copyJson', { defaultValue: 'Copy JSON' })}
              </Button>
            </div>
            {showFields ? (
              <dl className="divide-y rounded-lg border">
                {entries.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 px-3 py-2 text-sm">
                    <dt className="truncate font-mono text-xs leading-5 text-muted-foreground" title={k} dir="ltr">
                      {k}
                    </dt>
                    <dd className={cn('min-w-0 break-words', typeof v === 'number' && 'tabular-nums')}>
                      {v === null || v === undefined || v === '' ? (
                        <span className="text-muted-foreground">—</span>
                      ) : typeof v === 'object' ? (
                        <pre className="whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-xs" dir="ltr">
                          {JSON.stringify(v, null, 2)}
                        </pre>
                      ) : typeof v === 'boolean' ? (
                        <Badge variant={v ? 'success' : 'muted'}>{String(v)}</Badge>
                      ) : (
                        String(v)
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <pre className="max-h-[60dvh] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed" dir="ltr">
                {json}
              </pre>
            )}
          </section>
        </div>

        {onDelete && (
          <div className="flex justify-end border-t px-4 py-3">
            <Button variant="ghost" size="sm" className="text-danger hover:bg-danger/10 hover:text-danger" onClick={onDelete}>
              <Trash2 className="h-4 w-4" />
              {t('data.detail.delete', { defaultValue: 'Delete record' })}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
