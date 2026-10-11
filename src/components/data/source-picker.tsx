/**
 * Searchable source picker for the Data screen. A workspace can have
 * dozens of tables, APIs and imports, so a flat sidebar list (the old
 * layout) stopped scaling — this is a popover with a filter box, kind
 * icons and an "Archived" marker for sources that were removed but whose
 * records were kept. Enter picks the first match.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Check, ChevronDown, Cloud, Database, FileText, Layers, Search, Table2, Webhook } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { DataScreenSourceRef } from '@/lib/data-screen-client'
import { cn } from '@/lib/utils'

export function SourceKindIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = kind === 'table' ? Table2 : kind === 'rest' ? Cloud : kind === 'webhook' ? Webhook : kind === 'file' || kind === 'csv' || kind === 'geojson' ? FileText : Database
  return <Icon className={className} aria-hidden />
}

export function SourcePicker({
  sources,
  value,
  onChange,
  disabled,
}: {
  sources: DataScreenSourceRef[]
  value: number | undefined
  onChange: (id: number | undefined) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const current = sources.find((s) => s.id === value)
  const needle = q.trim().toLowerCase()
  const matches = useMemo(() => sources.filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.kind.toLowerCase().includes(needle)), [sources, needle])
  const active = matches.filter((s) => !s.archived)
  const archived = matches.filter((s) => s.archived)

  const pick = (id: number | undefined) => {
    onChange(id)
    setOpen(false)
    setQ('')
  }

  const item = (s: DataScreenSourceRef) => (
    <button
      key={s.id}
      type="button"
      role="option"
      aria-selected={s.id === value}
      onClick={() => pick(s.id)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        s.id === value && 'font-medium',
      )}
    >
      {s.archived ? <Archive className="h-4 w-4 shrink-0 text-warning" aria-hidden /> : <SourceKindIcon kind={s.kind} className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate">{s.name}</span>
      {s.id === value && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
    </button>
  )

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ('') }}>
      <PopoverTrigger asChild>
        <Button variant="outline" disabled={disabled} className={cn('max-w-[15rem] justify-start', current && 'border-primary/40 bg-primary/5')}>
          {current ? (
            current.archived ? <Archive className="h-4 w-4 shrink-0 text-warning" aria-hidden /> : <SourceKindIcon kind={current.kind} className="h-4 w-4 shrink-0" />
          ) : (
            <Layers className="h-4 w-4 shrink-0" aria-hidden />
          )}
          <span className="truncate">{current?.name ?? t('data.source.all', { defaultValue: 'All sources' })}</span>
          <ChevronDown className="ms-auto h-4 w-4 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="relative border-b p-2">
          <Search className="pointer-events-none absolute start-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) {
                e.preventDefault()
                pick(matches[0].id)
              }
            }}
            placeholder={t('data.source.search', { defaultValue: 'Find a source' })}
            aria-label={t('data.source.search', { defaultValue: 'Find a source' })}
            className="h-8 ps-8"
          />
        </div>
        <div role="listbox" aria-label={t('data.source.label', { defaultValue: 'Source' })} className="max-h-72 overflow-y-auto p-1">
          {!needle && (
            <button
              type="button"
              role="option"
              aria-selected={value === undefined}
              onClick={() => pick(undefined)}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none', value === undefined && 'font-medium')}
            >
              <Layers className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1">{t('data.source.all', { defaultValue: 'All sources' })}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{sources.length}</span>
            </button>
          )}
          {active.map(item)}
          {archived.length > 0 && (
            <>
              <p className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{t('data.source.archivedGroup', { defaultValue: 'Removed — records kept' })}</p>
              {archived.map(item)}
            </>
          )}
          {matches.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t('data.source.noMatch', { defaultValue: 'No sources match' })}</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
