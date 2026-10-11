/**
 * Summary view of a previewed import. Shows tallies up top and a
 * scrollable table of resolved rows so the user can spot-check before
 * importing. Read-only — the import happens via the parent's button.
 */

import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { PreviewResult, ResolvedTarget } from '@/lib/data-link'
import { AlertTriangle, CheckCircle2, FilePlus2, Tag, XCircle } from 'lucide-react'

interface ImportPreviewProps {
  preview: PreviewResult
  /** Cap displayed rows. Default 200 — the rest are summarised in a footer. */
  rowCap?: number
}

export function ImportPreview({ preview, rowCap = 200 }: ImportPreviewProps) {
  const { t } = useTranslation()
  const { totals, rows, unknownAttributeKeys } = preview
  const shown = rows.slice(0, rowCap)
  const truncated = rows.length - shown.length

  return (
    <div className="space-y-3">
      {/* Tallies */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          label={t('integrations.import.preview.matchedGrid', {
            defaultValue: 'Matched grid cells',
          })}
          value={totals.rowsMatchedGrid}
          tone={totals.rowsMatchedGrid > 0 ? 'positive' : undefined}
        />
        <Stat
          icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          label={t('integrations.import.preview.matchedShape', {
            defaultValue: 'Matched shapes',
          })}
          value={totals.rowsMatchedShape}
          tone={totals.rowsMatchedShape > 0 ? 'positive' : undefined}
        />
        <Stat
          icon={<FilePlus2 className="h-3.5 w-3.5" />}
          label={t('integrations.import.preview.willCreate', {
            defaultValue: 'New bins',
          })}
          value={totals.rowsWillCreate}
          tone={totals.rowsWillCreate > 0 ? 'info' : undefined}
        />
        <Stat
          icon={<XCircle className="h-3.5 w-3.5" />}
          label={t('integrations.import.preview.unmatched', {
            defaultValue: 'Skipped',
          })}
          value={totals.rowsUnmatched}
          tone={totals.rowsUnmatched > 0 ? 'negative' : undefined}
        />
      </div>

      {/* Warning + new-attributes notes */}
      <div className="space-y-2">
        {totals.rowsWithWarnings > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {t('integrations.import.preview.warnings', {
                defaultValue: '{{count}} rows have warnings — check them before importing.',
                count: totals.rowsWithWarnings,
              })}
            </span>
          </div>
        )}
        {unknownAttributeKeys.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
            <Tag className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">
              <span className="font-medium">
                {t('integrations.import.preview.newAttributes', {
                  defaultValue: 'New custom attributes:',
                })}
              </span>{' '}
              <span className="break-words font-mono" dir="ltr">
                {unknownAttributeKeys.join(', ')}
              </span>
              <span className="mt-0.5 block text-muted-foreground">
                {t('integrations.import.preview.newAttributesHint', {
                  defaultValue: 'They’ll be added so the side panel can show them.',
                })}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Resolved rows table */}
      <div className="overflow-hidden rounded-md border bg-background">
        <div className="hidden grid-cols-[44px_88px_minmax(0,1.4fr)_minmax(0,1.6fr)] gap-x-3 border-b sm:grid bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
          <span className="text-end">#</span>
          <span>
            {t('integrations.import.preview.colStatus', {
              defaultValue: 'Status',
            })}
          </span>
          <span>
            {t('integrations.import.preview.colTarget', {
              defaultValue: 'Lands on',
            })}
          </span>
          <span>
            {t('integrations.import.preview.colWrites', {
              defaultValue: 'Will write',
            })}
          </span>
        </div>
        <div className="max-h-[40dvh] divide-y overflow-y-auto">
          {shown.map((r) => (
            <div
              key={r.rowIndex}
              className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-x-3 px-3 py-2 text-xs transition-colors hover:bg-accent/30 sm:grid-cols-[44px_88px_minmax(0,1.4fr)_minmax(0,1.6fr)] sm:py-1.5"
            >
              <span className="text-end font-mono text-muted-foreground">{r.rowIndex + 1}</span>
              {/* Phones: badge + target on one line, fields below. From sm up
                  `contents` flattens this wrapper into the 4-column grid. */}
              <div className="min-w-0 space-y-1 sm:contents">
                <div className="flex min-w-0 items-center gap-2 sm:contents">
                  <div className="shrink-0 sm:pt-0.5">
                    <StatusBadge resolved={r.resolved} />
                  </div>
                  <span className="truncate text-xs leading-relaxed" title={describeTarget(r.resolved, t)}>
                    {describeTarget(r.resolved, t)}
                  </span>
                </div>
                <div className="min-w-0 space-y-0.5" dir="ltr">
                  {Object.entries(r.patch)
                    .filter(([k]) => k !== 'syncSource' && k !== 'lastSyncedAt' && k !== 'customProperties')
                    .map(([k, v]) => (
                      <FieldRow key={k} field={k} value={String(v)} />
                    ))}
                  {r.patch.customProperties &&
                    Object.entries(r.patch.customProperties).map(([k, v]) => <FieldRow key={`p-${k}`} field={`prop.${k}`} value={String(v)} custom />)}
                  {r.warnings.length > 0 && (
                    <div className="mt-1 flex items-start gap-1 text-warning">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span className="text-[11px] leading-relaxed">{r.warnings.join('; ')}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        {truncated > 0 && (
          <div className="border-t bg-muted/30 px-3 py-1.5 text-center text-xs text-muted-foreground">
            {t('integrations.import.preview.truncated', {
              defaultValue: '{{count}} more rows not shown — all of them will be imported.',
              count: truncated,
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone?: 'positive' | 'info' | 'negative' }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 transition-colors',
        tone === 'positive' && 'border-success/30 bg-success/5',
        tone === 'info' && 'border-info/30 bg-info/5',
        tone === 'negative' && 'border-danger/30 bg-danger/5',
      )}
    >
      <span
        className={cn(
          'shrink-0',
          tone === 'positive' && 'text-success',
          tone === 'info' && 'text-info',
          tone === 'negative' && 'text-danger',
          !tone && 'text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs leading-tight text-muted-foreground">{label}</div>
        <div className="text-sm font-semibold leading-tight tabular-nums">{value}</div>
      </div>
    </div>
  )
}

function FieldRow({ field, value, custom }: { field: string; value: string; custom?: boolean }) {
  return (
    <div className="truncate text-[11px] leading-relaxed">
      <span className={cn('font-mono', custom ? 'text-info' : 'text-muted-foreground')}>{field}</span>
      <span className="mx-1.5 text-muted-foreground">=</span>
      <span className="font-mono">{value}</span>
    </div>
  )
}

function StatusBadge({ resolved }: { resolved: ResolvedTarget }) {
  const { t } = useTranslation()
  const map = {
    'matched-grid': {
      label: t('integrations.import.preview.badgeGrid', {
        defaultValue: 'Grid',
      }),
      klass: 'bg-success/10 text-success border-success/30',
    },
    'matched-shape': {
      label: t('integrations.import.preview.badgeShape', {
        defaultValue: 'Shape',
      }),
      klass: 'bg-success/10 text-success border-success/30',
    },
    'will-create': {
      label: t('integrations.import.preview.badgeNew', { defaultValue: 'New' }),
      klass: 'bg-info/10 text-info border-info/30',
    },
    unmatched: {
      label: t('integrations.import.preview.badgeSkip', {
        defaultValue: 'Skip',
      }),
      klass: 'bg-danger/10 text-danger border-danger/30',
    },
  } as const
  const m = map[resolved.status]
  return <span className={cn('inline-block rounded border px-1.5 py-0.5 text-[11px] font-medium', m.klass)}>{m.label}</span>
}

function describeTarget(r: ResolvedTarget, t: TFunction): string {
  switch (r.status) {
    case 'matched-grid':
      return t('integrations.import.preview.targetGrid', {
        defaultValue: 'Grid {{grid}} · row {{row}}, column {{col}}, level {{level}}',
        grid: r.gridId,
        row: r.row,
        col: r.col,
        level: r.level,
      })
    case 'matched-shape':
      return `${r.targetKind} #${r.shapeId}`
    case 'will-create':
      return r.existing
        ? t('integrations.import.preview.targetUpdate', {
            defaultValue: 'Existing bin · code {{code}}',
            code: r.externalCode,
          })
        : t('integrations.import.preview.targetNew', {
            defaultValue: 'New bin · code {{code}}',
            code: r.externalCode,
          })
    case 'unmatched':
      return r.reason
  }
}
