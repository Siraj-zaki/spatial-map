/**
 * Searchable, virtualized lucide-icon picker for markers.
 *
 * - Quick-picks strip (10 curated warehouse/logistics icons) shown when
 *   the search box is empty.
 * - Virtualized grid of ALL lucide icons (~1700) below.
 * - Icons render synchronously via the shared `@/lib/lucide-icons`
 *   manifest — no async loading, no fallback flash.
 * - Filtering runs against a lowercased haystack. Input uses
 *   `useDeferredValue` so typing stays smooth at full catalogue size.
 */

import {
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  LUCIDE_ICONS,
  iconComponentForId,
  type LucideIconEntry,
} from '@/lib/lucide-icons'
import {
  MARKER_QUICK_PICKS,
  MarkerIconGlyph,
  resolveIconName,
} from '@/lib/marker-icons'
import { cn } from '@/lib/utils'

const GRID_COLUMNS = 6
const ROW_HEIGHT = 44 // px, virtual row incl. bottom gap
const CELL_HEIGHT = 40 // px, visible cell height
const VIEWPORT_HEIGHT = 220 // px, scroll container

export function MarkerIconPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (id: string) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  // Decouple filtering from keystrokes — React yields between renders
  // so typing stays responsive across 1.7k icons.
  const deferredQuery = useDeferredValue(query)

  const selectedName = useMemo(() => resolveIconName(value), [value])

  const filtered = useMemo<readonly LucideIconEntry[]>(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q) return LUCIDE_ICONS
    // Two-tier ranking: literal id/name hits come first, then icons
    // whose curated tags match the query. Both tiers stay alphabetical
    // (LUCIDE_ICONS is pre-sorted). This keeps "map" from burying
    // `map-pin` under 20 tag-only matches while still surfacing
    // semantic results for terms like "marker" or "device".
    const primary: LucideIconEntry[] = []
    const secondary: LucideIconEntry[] = []
    for (const e of LUCIDE_ICONS) {
      if (e.id.includes(q) || e.nameLower.includes(q)) {
        primary.push(e)
      } else if (e.tags.some((t) => t.includes(q))) {
        secondary.push(e)
      }
    }
    return primary.length === 0 ? secondary : primary.concat(secondary)
  }, [deferredQuery])

  const rowCount = Math.ceil(filtered.length / GRID_COLUMNS)

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 4,
  })

  const showQuickPicks = deferredQuery.trim().length === 0

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('sidePanel.markerIconSearch')}
          aria-label={t('sidePanel.markerIconSearch')}
          className="h-8 ps-7 pe-7 text-xs"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label={t('common.clear')}
            className="absolute end-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-accent text-muted-foreground"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {showQuickPicks && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 px-0.5">
            {t('sidePanel.markerIconQuick')}
          </p>
          <div className="grid grid-cols-6 gap-1">
            {MARKER_QUICK_PICKS.map((qp) => {
              const active = selectedName === qp.name
              const label = t(`marker.icon_${qp.labelKey}`)
              return (
                <button
                  key={qp.name}
                  type="button"
                  onClick={() => onChange(qp.name)}
                  title={label}
                  aria-label={label}
                  aria-pressed={active}
                  className={cn(
                    'aspect-square flex items-center justify-center rounded border transition-colors',
                    active
                      ? 'border-primary bg-primary/15 text-primary ring-1 ring-primary/40'
                      : 'border-border/60 hover:bg-accent text-muted-foreground'
                  )}
                >
                  <MarkerIconGlyph
                    icon={qp.name}
                    className={cn('w-4 h-4', active && 'scale-110')}
                    aria-hidden="true"
                  />
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between px-0.5">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {showQuickPicks
            ? t('sidePanel.markerIconAll')
            : t('sidePanel.markerIconResults', { count: filtered.length })}
        </p>
      </div>

      {filtered.length === 0 ? (
        <div className="py-6 text-center text-xs text-muted-foreground border border-dashed border-border/60 rounded">
          {t('sidePanel.markerIconNoResults')}
        </div>
      ) : (
        <div
          ref={parentRef}
          className="overflow-y-auto rounded border border-border/60 bg-muted/20"
          style={{ height: VIEWPORT_HEIGHT, contain: 'strict' }}
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((row) => {
              const start = row.index * GRID_COLUMNS
              const cells = filtered.slice(start, start + GRID_COLUMNS)
              const rowStyle: CSSProperties = {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: ROW_HEIGHT,
                transform: `translateY(${row.start}px)`,
              }
              return (
                <div
                  key={row.key}
                  className="grid grid-cols-6 gap-1 px-1"
                  style={rowStyle}
                >
                  {cells.map((entry) => {
                    const active = selectedName === entry.id
                    const Icon = iconComponentForId(entry.id)
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => onChange(entry.id)}
                        title={entry.id}
                        aria-label={entry.id}
                        aria-pressed={active}
                        style={{ height: CELL_HEIGHT }}
                        className={cn(
                          'flex items-center justify-center rounded border transition-colors',
                          active
                            ? 'border-primary bg-primary/15 text-primary ring-1 ring-primary/40'
                            : 'border-border/40 hover:bg-accent text-muted-foreground'
                        )}
                      >
                        {Icon && <Icon size={16} aria-hidden="true" />}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
