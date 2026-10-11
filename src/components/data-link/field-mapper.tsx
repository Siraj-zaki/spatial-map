/**
 * Per-column field-target picker. Renders one row per source column;
 * each row lets the user route that column to a Bin field (`builtin`,
 * `custom`, or `ignore`). Used by the import wizard's mapping step.
 *
 * Stateless — the parent owns the `mapping` map and updates it through
 * `onChange`. Columns chosen by the match strategy (e.g. the
 * externalCode column) should be excluded from `columns` by the parent
 * so the user can't accidentally route them twice.
 */

import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { FieldTarget } from '@/lib/data-link'
import { ArrowRight } from 'lucide-react'

interface FieldMapperProps {
  columns: string[]
  mapping: Record<string, FieldTarget>
  onChange: (mapping: Record<string, FieldTarget>) => void
  /** Sample row used for the preview cell next to each column. */
  sample?: Record<string, string>
}

const BUILTIN_OPTIONS: { value: string; key: string; label: string }[] = [
  { value: 'builtin:externalCode', key: 'externalCode', label: 'External code' },
  { value: 'builtin:sku', key: 'sku', label: 'SKU' },
  { value: 'builtin:capacity', key: 'capacity', label: 'Capacity' },
  { value: 'builtin:notes', key: 'notes', label: 'Notes' },
  { value: 'builtin:status', key: 'status', label: 'Status' },
]

export function FieldMapper({ columns, mapping, onChange, sample }: FieldMapperProps) {
  const { t } = useTranslation()
  const setColumn = (column: string, target: FieldTarget) => {
    onChange({ ...mapping, [column]: target })
  }

  if (columns.length === 0) {
    return (
      <div className="text-xs text-muted-foreground border rounded-md px-3 py-6 text-center bg-muted/20">
        {t('integrations.import.mapper.noColumns', { defaultValue: 'No columns left to map — the match step uses all of them.' })}
      </div>
    )
  }

  return (
    <div className="border rounded-md overflow-hidden bg-background">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/40 border-b">
        <span>{t('integrations.import.mapper.column', { defaultValue: 'Column in your file' })}</span>
        <span className="hidden sm:block">{t('integrations.import.mapper.sample', { defaultValue: 'First value' })}</span>
        <span>{t('integrations.import.mapper.target', { defaultValue: 'Save as' })}</span>
      </div>
      <div className="divide-y max-h-[42dvh] overflow-y-auto">
        {columns.map((col) => {
          const target = mapping[col] ?? { kind: 'ignore' as const }
          const isIgnored = target.kind === 'ignore'
          return (
            <div
              key={col}
              className={cn(
                'grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 px-3 py-2 items-center transition-colors',
                'hover:bg-accent/30',
                isIgnored && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs font-mono truncate" title={col}>{col}</span>
              </div>
              <span
                className={cn(
                  'hidden sm:block text-[11px] text-muted-foreground truncate font-mono',
                  !sample?.[col] && 'italic opacity-60',
                )}
                title={sample?.[col]}
              >
                {sample?.[col] || '—'}
              </span>
              <div className="flex items-center gap-1.5 min-w-0">
                <ArrowRight className="h-3 w-3 text-muted-foreground/60 flex-shrink-0 rtl:rotate-180" aria-hidden />
                <TargetPicker
                  column={col}
                  value={target}
                  onChange={(t) => setColumn(col, t)}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface TargetPickerProps {
  column: string
  value: FieldTarget
  onChange: (t: FieldTarget) => void
}

function TargetPicker({ column, value, onChange }: TargetPickerProps) {
  const { t } = useTranslation()
  const selectValue =
    value.kind === 'ignore'
      ? 'ignore'
      : value.kind === 'builtin'
        ? `builtin:${value.field}`
        : 'custom'

  return (
    <div className="flex items-center gap-1.5 min-w-0 flex-1">
      <select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'ignore') return onChange({ kind: 'ignore' })
          if (v === 'custom') return onChange({ kind: 'custom', key: '' })
          const field = v.slice('builtin:'.length) as
            | 'externalCode' | 'sku' | 'capacity' | 'notes' | 'status'
          onChange({ kind: 'builtin', field })
        }}
        aria-label={t('integrations.import.mapper.targetFor', { defaultValue: 'Save {{column}} as', column })}
        className="h-7 min-w-0 max-w-full rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <option value="ignore">{t('integrations.import.mapper.ignore', { defaultValue: 'Don’t import' })}</option>
        <optgroup label={t('integrations.import.mapper.builtin', { defaultValue: 'Bin field' })}>
          {BUILTIN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{t(`integrations.import.mapper.field.${o.key}`, { defaultValue: o.label })}</option>
          ))}
        </optgroup>
        <option value="custom">{t('integrations.import.mapper.custom', { defaultValue: 'Custom attribute…' })}</option>
      </select>
      {value.kind === 'custom' && (
        <input
          type="text"
          value={value.key}
          onChange={(e) =>
            onChange({ kind: 'custom', key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') })
          }
          placeholder="attribute_key"
          aria-label={t('integrations.import.mapper.customKey', { defaultValue: 'Attribute name for {{column}}', column })}
          dir="ltr"
          className="h-7 rounded-md border bg-background px-2 text-xs font-mono flex-1 min-w-0 focus:outline-none focus:ring-1 focus:ring-ring"
        />
      )}
    </div>
  )
}
