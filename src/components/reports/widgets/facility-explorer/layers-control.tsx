/**
 * Layers control for a report's live map — every linked-data layer the
 * explorer draws, each with its colour, row count and an eye toggle. The
 * open tab's layer can't be hidden (its list is what the viewer reads).
 * The viewer's choice lives in the URL (`?layersOff=`), so a shared link
 * keeps it.
 */

import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, History, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { DataLinkConfig } from '@/lib/db'

export interface LayerItem {
  link: DataLinkConfig
  label: string
  count: number | null
}

export function LayersControl({
  items,
  hidden,
  pinnedId,
  onChange,
  className,
}: {
  items: ReadonlyArray<LayerItem>
  hidden: ReadonlySet<number>
  /** The open tab's layer: always drawn. */
  pinnedId: number | undefined
  onChange: (next: ReadonlySet<number>) => void
  className?: string
}) {
  const { t } = useTranslation()
  if (items.length < 2) return null
  const shown = items.filter((x) => x.link.id === pinnedId || !hidden.has(x.link.id as number)).length
  const label = t('reports.mapLayers.title', { defaultValue: 'Data layers' })
  const toggle = (id: number) => {
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant={hidden.size > 0 ? 'secondary' : 'ghost'} size="sm" className={cn('h-8 shrink-0 gap-1.5 px-2 text-xs', className)} aria-label={label}>
              <Layers className="h-3.5 w-3.5" />
              <span className="tabular-nums">{shown}/{items.length}</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-1.5rem)] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-sm font-medium">{label}</span>
          {hidden.size > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onChange(new Set())}>
              {t('reports.mapLayers.showAll', { defaultValue: 'Show all' })}
            </Button>
          )}
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {items.map(({ link, label: name, count }) => {
            const id = link.id as number
            const pinned = id === pinnedId
            const on = pinned || !hidden.has(id)
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={pinned}
                  onClick={() => toggle(id)}
                  aria-pressed={on}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-start text-sm hover:bg-accent/60 disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-background" style={{ background: link.style?.defaultColor ?? 'hsl(var(--primary))' }} aria-hidden />
                  <span className={cn('min-w-0 flex-1 truncate', !on && 'text-muted-foreground')}>{name}</span>
                  {link.renderMode === 'history-movement' && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      <History className="h-2.5 w-2.5" aria-hidden />
                      {t('reports.mapLayers.history', { defaultValue: 'History' })}
                    </span>
                  )}
                  {count !== null && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>}
                  {pinned ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">{t('reports.mapLayers.open', { defaultValue: 'Open' })}</span>
                  ) : on ? (
                    <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t('reports.mapLayers.hide', { defaultValue: 'Hide layer' })} />
                  ) : (
                    <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t('reports.mapLayers.show', { defaultValue: 'Show layer' })} />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
