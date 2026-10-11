/**
 * LucideIconPicker — searchable, virtualised grid of every Lucide icon
 * (~1714). Used by the data-link editor to pick a marker icon; also
 * exposes icon-color and marker-background-color controls.
 *
 * Design constraints (from DESIGN-data-link-v2.md §3):
 *   - Lucide-only, no emoji, no URL.
 *   - ALL icons available. Not a curated subset.
 *   - Live search, high performance — perf target <100ms on open.
 *   - Icon color + marker color pickers, both use the shared ColorPicker.
 *
 * Perf strategy
 * -------------
 *   1. `lucide-react` exports ~1714 named forward-ref components. We
 *      derive the icon manifest ONCE at module load (~2ms) by filtering
 *      the module's exports.
 *   2. The grid renders only visible rows using a simple scroll-offset
 *      virtualiser (fixed row height + overscan) — no third-party lib.
 *   3. Search runs on a pre-lowercased name array; O(N) per keystroke
 *      on 1714 items is <2ms.
 *   4. Icon glyphs are React components rendered at ~24×24; DOM cost is
 *      ~64 visible tiles × trivial SVG = negligible.
 *
 * Persistence contract
 * --------------------
 *   The picker stores/returns kebab-case ids (`'map-pin'`, `'alert-circle'`)
 *   which is the same format `DataLinkStyle.defaultIcon` uses today. This
 *   keeps existing 18-icon configs valid without migration.
 */

import { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  LUCIDE_ICONS as ALL_ICONS,
  iconComponentForId,
  allLucideIconIds,
} from '@/lib/lucide-icons'

// Re-exported so existing consumers (data-link editor, etc.) don't
// need to update their imports.
export { iconComponentForId, allLucideIconIds }

// -------------------------------------------------------- picker UI

const ROW_HEIGHT = 44
const COLS = 10
const OVERSCAN_ROWS = 2
const VIEWPORT_HEIGHT = 260

export interface LucideIconPickerProps {
  /** Currently selected kebab id (e.g. `'map-pin'`). */
  value: string | undefined
  onChange: (id: string) => void
  /** Optional test-id for E2E. */
  'data-testid'?: string
}

/**
 * Searchable virtualised grid of every Lucide icon.
 *
 * The consumer supplies the color pickers separately — this component
 * is icon-only. See `MarkerIconAndColors` below for the combined
 * icon-plus-color block used in the data-link editor.
 */
export function LucideIconPicker({ value, onChange, ...rest }: LucideIconPickerProps) {
  const [query, setQuery] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ALL_ICONS
    return ALL_ICONS.filter((e) => e.hay.includes(q))
  }, [query])

  const totalRows = Math.ceil(filtered.length / COLS)
  const totalHeight = totalRows * ROW_HEIGHT

  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS)
  const endRow = Math.min(
    totalRows,
    Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN_ROWS,
  )
  const visible = filtered.slice(startRow * COLS, endRow * COLS)
  const topPad = startRow * ROW_HEIGHT

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  // Scroll the currently-selected icon into view when the picker mounts
  // OR when the query changes and the selection is still in the filtered
  // set. Keeps the UX consistent with "here's what you have picked".
  useEffect(() => {
    if (!value) return
    const idx = filtered.findIndex((e) => e.id === value)
    if (idx < 0) return
    const row = Math.floor(idx / COLS)
    const wantScroll = row * ROW_HEIGHT
    if (scrollRef.current) {
      // Only scroll if the item isn't already visible.
      const t = scrollRef.current.scrollTop
      if (wantScroll < t || wantScroll > t + VIEWPORT_HEIGHT - ROW_HEIGHT) {
        scrollRef.current.scrollTop = Math.max(0, wantScroll - VIEWPORT_HEIGHT / 2)
      }
    }
    // Only re-run when query changes; not when scrollTop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, value])

  return (
    <div className="flex flex-col gap-2" data-testid={rest['data-testid']}>
      <div className="relative">
        <Search className="absolute start-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setScrollTop(0)
            if (scrollRef.current) scrollRef.current.scrollTop = 0
          }}
          placeholder={`Search ${ALL_ICONS.length.toLocaleString()} icons…`}
          className="ps-8 pe-8 h-8 text-xs"
          aria-label="Search Lucide icons"
        />
        {query && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              setQuery('')
              setScrollTop(0)
              if (scrollRef.current) scrollRef.current.scrollTop = 0
            }}
            className="absolute end-1 top-1/2 -translate-y-1/2 h-6 w-6"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="text-xs text-muted-foreground text-center py-8 border rounded-md bg-muted/30">
          No icons match &ldquo;{query}&rdquo;.
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="border rounded-md bg-muted/20 overflow-y-auto"
          style={{ height: VIEWPORT_HEIGHT }}
          role="listbox"
          aria-label="Lucide icons"
        >
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                top: topPad,
                left: 0,
                right: 0,
                display: 'grid',
                gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
                gap: 2,
                padding: '0 4px',
              }}
            >
              {visible.map((entry) => {
                const Icon = entry.Component
                const selected = entry.id === value
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => onChange(entry.id)}
                    title={entry.id}
                    className={
                      'flex items-center justify-center rounded transition-colors ' +
                      (selected
                        ? 'bg-primary/20 ring-1 ring-primary'
                        : 'hover:bg-accent')
                    }
                    style={{ height: ROW_HEIGHT - 4, marginTop: 2 }}
                  >
                    <Icon size={20} aria-hidden="true" />
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] text-muted-foreground px-1">
        <span>
          {filtered.length.toLocaleString()} / {ALL_ICONS.length.toLocaleString()}
        </span>
        {value && <span className="font-mono">{value}</span>}
      </div>
    </div>
  )
}

// ------------------------------------------- marker icon + color block

export interface MarkerIconAndColorsProps {
  iconId: string | undefined
  onIconChange: (id: string) => void
  iconColor: string | undefined
  onIconColorChange: (hex: string) => void
  markerColor: string | undefined
  onMarkerColorChange: (hex: string) => void
}

/**
 * Combined block used by the data-link editor: icon picker + two color
 * controls, side-by-side with a live preview badge. Consumers get a
 * single component that fully specifies a marker's visual.
 */
export function MarkerIconAndColors({
  iconId,
  onIconChange,
  iconColor,
  onIconColorChange,
  markerColor,
  onMarkerColorChange,
}: MarkerIconAndColorsProps) {
  const Icon = iconComponentForId(iconId) ?? null
  const effectiveIconColor = iconColor || '#ffffff'
  const effectiveMarkerColor = markerColor || '#0ea5e9'

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        {/* Live preview badge — mirrors the map-marker visual so the
            user sees exactly what will render. */}
        <div
          className="flex items-center justify-center rounded-full shrink-0 shadow-sm border border-black/10"
          style={{
            width: 56,
            height: 56,
            background: effectiveMarkerColor,
          }}
          aria-label="Marker preview"
        >
          {Icon ? (
            // eslint-disable-next-line react-hooks/static-components -- icon component is looked up from a static registry, not created
            <Icon size={28} color={effectiveIconColor} strokeWidth={2.25} />
          ) : (
            <span className="text-[10px] text-white/80">no icon</span>
          )}
        </div>

        <div className="flex flex-col gap-2 flex-1 min-w-0">
          <ColorRowInline
            label="Icon color"
            value={effectiveIconColor}
            onChange={onIconColorChange}
            testId="dl-icon-color"
          />
          <ColorRowInline
            label="Marker color"
            value={effectiveMarkerColor}
            onChange={onMarkerColorChange}
            testId="dl-marker-color"
          />
        </div>
      </div>

      <LucideIconPicker value={iconId} onChange={onIconChange} data-testid="dl-icon-picker" />
    </div>
  )
}

// ----------------------------------------------- inline color-row

/**
 * Lightweight color row. Renders a swatch + hex text input, both stay
 * in sync. Accepts `#abc`, `abc`, `#abcdef`, `abcdef`. This is a slim
 * duplicate of `side-panel.tsx`'s `ColorRow` for use OUTSIDE the side
 * panel; the side-panel version stays as-is so its internal spacing
 * conventions don't leak here.
 */
function ColorRowInline({
  label,
  value,
  onChange,
  testId,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
  testId?: string
}) {
  const [text, setText] = useState(value)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setText(value), [value])

  const commit = useCallback(
    (raw: string) => {
      const cleaned = raw.trim().replace(/^#/, '')
      let hex: string | null = null
      if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
        hex = '#' + cleaned.split('').map((c) => c + c).join('')
      } else if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
        hex = '#' + cleaned
      }
      if (hex) {
        onChange(hex.toLowerCase())
      } else {
        setText(value)
      }
    },
    [onChange, value],
  )

  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <label className="text-xs w-24 shrink-0 text-muted-foreground">{label}</label>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-7 h-7 rounded border border-border cursor-pointer shrink-0"
        aria-label={`${label} swatch`}
      />
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
        }}
        maxLength={7}
        spellCheck={false}
        className="h-7 flex-1 min-w-0 rounded border border-border bg-background px-2 text-xs font-mono uppercase focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label={`${label} hex`}
      />
    </div>
  )
}
