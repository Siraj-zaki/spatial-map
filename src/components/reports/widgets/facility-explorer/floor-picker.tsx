/**
 * Floor picker for the full-map report's top bar — the same model as the
 * viewer's (routes/view.tsx FloorSwitcher): All floors, or any set of
 * floors at once (shown stacked; the map tilts). Floors are listed top
 * floor first; ticking keeps the menu open, "Only" isolates one floor.
 */

import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Layers } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface PickerFloor {
  id: number
  name: string
  elevation: number
}

export function FloorPicker({
  floors,
  selected,
  onChange,
}: {
  /** Lowest first (as the explorer sorts them). */
  floors: readonly PickerFloor[]
  /** null = all floors. */
  selected: ReadonlySet<number> | null
  onChange: (next: ReadonlySet<number> | null) => void
}) {
  const { t, i18n } = useTranslation()
  if (floors.length < 2) return null
  const isAll = selected === null || floors.every((f) => selected.has(f.id))
  const level = (f: PickerFloor) => floors.findIndex((x) => x.id === f.id)
  const label = isAll
    ? t('reports.mapView.allFloors', { defaultValue: 'All floors' })
    : selected.size === 1
      ? (floors.find((f) => selected.has(f.id))?.name ?? '')
      : t('reports.mapView.nFloors', { count: selected.size, defaultValue: '{{count}} floors' })

  // From "All floors" a tick means "just this one" (as the viewer does).
  const toggle = (id: number) => {
    if (isAll) return onChange(new Set([id]))
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next.size === 0 || next.size === floors.length ? null : next)
  }
  const metres = (m: number) => new Intl.NumberFormat(i18n.language, { style: 'unit', unit: 'meter', maximumFractionDigits: 1 }).format(m)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 min-w-0 shrink items-center gap-2 rounded-lg border bg-background/60 px-2.5 text-xs font-medium transition-colors hover:bg-accent data-[state=open]:bg-accent"
          title={t('reports.mapView.levels', { defaultValue: 'Floors' })}
        >
          <Layers className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <span className="sr-only">{t('reports.mapView.levels', { defaultValue: 'Floors' })}: </span>
          <span className="hidden max-w-[11rem] truncate sm:inline">{label}</span>
          {/* Phones: a short label so the report title keeps its room. */}
          <span className="tabular-nums sm:hidden" aria-hidden>
            {isAll
              ? t('reports.mapView.allShort', { defaultValue: 'All' })
              : selected.size === 1
                ? t('reports.mapView.levelShort', { n: level(floors.find((f) => selected.has(f.id))!), defaultValue: 'L{{n}}' })
                : selected.size}
          </span>
          <span className="sr-only sm:hidden">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-72 rounded-xl p-1">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
          {t('reports.mapView.levels', { defaultValue: 'Floors' })}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(null)} className="gap-2.5 rounded-lg text-sm">
          <span className={cn('flex h-4 w-4 items-center justify-center rounded-full border', isAll ? 'border-primary bg-primary text-primary-foreground' : 'border-border')} aria-hidden>
            {isAll && <Check className="h-3 w-3" />}
          </span>
          <span className="flex-1">{t('reports.mapView.allFloors', { defaultValue: 'All floors' })}</span>
          <span className="text-[11px] text-muted-foreground">{t('reports.mapView.stacked', { defaultValue: 'stacked' })}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {[...floors].reverse().map((f) => {
          const checked = !isAll && selected.has(f.id)
          return (
            <DropdownMenuItem
              key={f.id}
              // Keep the menu open so several floors can be ticked in a row.
              onSelect={(e) => {
                e.preventDefault()
                toggle(f.id)
              }}
              role="menuitemcheckbox"
              aria-checked={checked || isAll}
              className="group gap-2.5 rounded-lg py-2 text-sm"
            >
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                  checked ? 'border-primary bg-primary text-primary-foreground' : isAll ? 'border-primary/50 bg-primary/15 text-primary' : 'border-border',
                )}
                aria-hidden
              >
                {(checked || isAll) && <Check className="h-3 w-3" />}
              </span>
              <span className="flex h-6 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground">
                {t('reports.mapView.levelShort', { n: level(f), defaultValue: 'L{{n}}' })}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{f.name}</span>
                <span className="block text-[10px] text-muted-foreground">{metres(f.elevation)}</span>
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onChange(new Set([f.id]))
                }}
                className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus:opacity-100 [@media(hover:none)]:opacity-100"
              >
                {t('reports.mapView.only', { defaultValue: 'Only' })}
              </button>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
