import { Boxes, Clock, Layers, MapPin, Package, Search as SearchIcon, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Bin, Grid } from '@/lib/db'
import type { MarkerShape, ModelShape } from '@/lib/shapes'

type ResultKind = 'rack' | 'bin' | 'marker' | 'model'

interface BaseResult {
  kind: ResultKind
  /** Stable key for React + the keyboard-cursor selection. */
  key: string
  name: string
  subtitle?: string
  /** Tie-break score — higher = better. Computed once per query. */
  score: number
}

interface RackResult extends BaseResult { kind: 'rack'; grid: Grid }
interface BinResult extends BaseResult { kind: 'bin'; bin: Bin; parentGrid?: Grid }
interface MarkerResult extends BaseResult { kind: 'marker'; marker: MarkerShape }
interface ModelResult extends BaseResult { kind: 'model'; model: ModelShape }

export type SearchResult = RackResult | BinResult | MarkerResult | ModelResult

type CategoryFilter = 'all' | ResultKind

interface ViewSearchProps {
  grids: Grid[]
  bins: Bin[]
  markers: MarkerShape[]
  models: ModelShape[]
  onPick: (result: SearchResult) => void
  /** Used as a localStorage namespace for the recents list so each
   * warehouse keeps its own history. Omit to disable recents. */
  warehouseId?: string
}

/** Stripped-down record we serialize per recent. We never store the
 * raw entity because that snapshot can go stale; instead we re-resolve
 * by `id` (or compound rack key) against the live data on render. */
interface RecentEntry {
  kind: ResultKind
  /** Stable lookup id — number for shapes, compound string for racks. */
  ref: string
  /** Display name as it was when added. Shown if the entity has been
   * renamed or deleted since. */
  name: string
  subtitle?: string
  ts: number
}

const RECENT_LIMIT = 8
const RECENT_LS_PREFIX = 'viewerSearchRecents:'

function loadRecents(warehouseId: string | undefined): RecentEntry[] {
  if (!warehouseId || typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENT_LS_PREFIX + warehouseId)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

function saveRecents(warehouseId: string | undefined, entries: RecentEntry[]): void {
  if (!warehouseId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      RECENT_LS_PREFIX + warehouseId,
      JSON.stringify(entries.slice(0, RECENT_LIMIT)),
    )
  } catch {
    /* private-mode storage block — ignore */
  }
}

function entryRefFor(r: SearchResult): string {
  switch (r.kind) {
    case 'rack':   return String(r.grid.id ?? '')
    case 'bin':    return String(r.bin.id ?? '')
    case 'marker': return String(r.marker.id ?? '')
    case 'model':  return String(r.model.id ?? '')
  }
}

const MIN_QUERY_LENGTH = 2
const MAX_RESULTS_PER_KIND = 8

/**
 * Cheap fuzzy-ish score. Matches the substring case-insensitively and
 * boosts prefix matches. Returns 0 when the query doesn't match.
 * Good enough for ~10k items without bringing in fuse.js.
 */
function scoreMatch(haystack: string | undefined, q: string): number {
  if (!haystack) return 0
  const h = haystack.toLowerCase()
  const idx = h.indexOf(q)
  if (idx < 0) return 0
  // Earlier match = higher score; exact = 1, then linearly decaying.
  if (h === q) return 1
  if (idx === 0) return 0.85
  // Boost when the match starts after a word boundary.
  const prev = h[idx - 1]
  if (prev === ' ' || prev === '-' || prev === '_' || prev === '/') return 0.7
  return 0.5
}

function CategoryButton({
  label,
  active,
  count,
  onClick,
}: {
  label: string
  active: boolean
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium border transition-colors ${
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-card border-border text-muted-foreground hover:bg-muted'
      }`}
    >
      {label}
      <span className="tabular-nums opacity-80">{count}</span>
    </button>
  )
}

function ResultIcon({ kind }: { kind: ResultKind }) {
  const cls = 'w-3.5 h-3.5 flex-shrink-0'
  switch (kind) {
    case 'rack':   return <Layers   className={`${cls} text-sky-500`} />
    case 'bin':    return <Package  className={`${cls} text-blue-500`} />
    case 'marker': return <MapPin   className={`${cls} text-red-500`} />
    case 'model':  return <Boxes    className={`${cls} text-indigo-500`} />
  }
}

export function ViewSearch({ grids, bins, markers, models, onPick, warehouseId }: ViewSearchProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [cursor, setCursor] = useState(0)
  const [recents, setRecents] = useState<RecentEntry[]>(() => loadRecents(warehouseId))
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Re-hydrate recents when the warehouse changes (route nav).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecents(loadRecents(warehouseId))
  }, [warehouseId])

  // Re-resolve each recent against the live data so a renamed entity
  // shows its current label and a deleted entity drops off the list.
  const resolvedRecents = useMemo(() => {
    return recents
      .map<{ entry: RecentEntry; result: SearchResult | null }>((entry) => {
        let result: SearchResult | null = null
        switch (entry.kind) {
          case 'rack': {
            const g = grids.find((x) => String(x.id) === entry.ref)
            if (g) result = {
              kind: 'rack', key: `rack:${g.id}`, name: g.name || entry.name,
              subtitle: entry.subtitle, score: 1, grid: g,
            }
            break
          }
          case 'bin': {
            const b = bins.find((x) => String(x.id) === entry.ref)
            if (b) result = {
              kind: 'bin', key: `bin:${b.id}`, name: b.sku || b.externalCode || entry.name,
              subtitle: entry.subtitle, score: 1, bin: b,
              parentGrid: b.gridId !== undefined ? grids.find((g) => g.id === b.gridId) : undefined,
            }
            break
          }
          case 'marker': {
            const m = markers.find((x) => String(x.id) === entry.ref)
            if (m) result = {
              kind: 'marker', key: `marker:${m.id}`, name: m.name || entry.name,
              subtitle: entry.subtitle, score: 1, marker: m,
            }
            break
          }
          case 'model': {
            const m = models.find((x) => String(x.id) === entry.ref)
            if (m) result = {
              kind: 'model', key: `model:${m.id}`, name: m.name || entry.name,
              subtitle: entry.subtitle, score: 1, model: m,
            }
            break
          }
        }
        return { entry, result }
      })
      .filter((x): x is { entry: RecentEntry; result: SearchResult } => x.result !== null)
  }, [recents, grids, bins, markers, models])

  // Cmd/Ctrl+K and `/` open the search. Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen(true)
        queueMicrotask(() => inputRef.current?.focus())
        return
      }
      if (!inField && e.key === '/') {
        e.preventDefault()
        setOpen(true)
        queueMicrotask(() => inputRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Reset cursor when the result set changes (query / filter).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCursor(0)
  }, [query, filter])

  // Index bins by their parent grid so bin rows can show a useful subtitle
  // ("in Rack A1") without the host having to thread the grid map through.
  const gridById = useMemo(() => {
    const m = new Map<number, Grid>()
    for (const g of grids) if (g.id !== undefined) m.set(g.id, g)
    return m
  }, [grids])

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase()
    if (q.length < MIN_QUERY_LENGTH) return []
    const out: SearchResult[] = []

    if (filter === 'all' || filter === 'rack') {
      const matched: RackResult[] = []
      for (const g of grids) {
        const s = scoreMatch(g.name, q)
        if (s > 0) {
          matched.push({
            kind: 'rack',
            key: `rack:${g.id}`,
            name: g.name || t('view.search.unnamedRack', { defaultValue: 'Unnamed rack' }),
            subtitle: t('view.search.rackSubtitle', { defaultValue: 'Rack' }),
            score: s,
            grid: g,
          })
        }
      }
      matched.sort((a, b) => b.score - a.score)
      out.push(...matched.slice(0, MAX_RESULTS_PER_KIND))
    }

    if (filter === 'all' || filter === 'bin') {
      const matched: BinResult[] = []
      for (const b of bins) {
        const s = Math.max(
          scoreMatch(b.sku, q),
          scoreMatch(b.externalCode, q),
          scoreMatch(b.notes, q),
        )
        if (s > 0) {
          const parent = b.gridId !== undefined ? gridById.get(b.gridId) : undefined
          const where = parent
            ? `${parent.name || t('view.search.unnamedRack', { defaultValue: 'Unnamed rack' })} · ${b.row},${b.col}`
            : t('view.search.binSubtitle', { defaultValue: 'Bin' })
          matched.push({
            kind: 'bin',
            key: `bin:${b.id}`,
            name: b.sku || b.externalCode || t('view.search.unnamedBin', { defaultValue: 'Bin' }),
            subtitle: where,
            score: s,
            bin: b,
            parentGrid: parent,
          })
        }
      }
      matched.sort((a, b) => b.score - a.score)
      out.push(...matched.slice(0, MAX_RESULTS_PER_KIND))
    }

    if (filter === 'all' || filter === 'marker') {
      const matched: MarkerResult[] = []
      for (const m of markers) {
        const s = scoreMatch(m.name, q)
        if (s > 0) {
          matched.push({
            kind: 'marker',
            key: `marker:${m.id}`,
            name: m.name || t('view.search.unnamedMarker', { defaultValue: 'Marker' }),
            subtitle: t('view.search.markerSubtitle', { defaultValue: 'Marker' }),
            score: s,
            marker: m,
          })
        }
      }
      matched.sort((a, b) => b.score - a.score)
      out.push(...matched.slice(0, MAX_RESULTS_PER_KIND))
    }

    if (filter === 'all' || filter === 'model') {
      const matched: ModelResult[] = []
      for (const m of models) {
        const s = scoreMatch(m.name, q)
        if (s > 0) {
          matched.push({
            kind: 'model',
            key: `model:${m.id}`,
            name: m.name || t('view.search.unnamedModel', { defaultValue: '3D model' }),
            subtitle: t('view.search.modelSubtitle', { defaultValue: '3D model' }),
            score: s,
            model: m,
          })
        }
      }
      matched.sort((a, b) => b.score - a.score)
      out.push(...matched.slice(0, MAX_RESULTS_PER_KIND))
    }

    return out
  }, [query, filter, grids, bins, markers, models, gridById, t])

  // Total per-kind counts for the category chips. Computed against the
  // current query (not the filter) so the chips show "how many would I
  // see if I switched to this filter".
  const counts = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < MIN_QUERY_LENGTH) {
      return { rack: 0, bin: 0, marker: 0, model: 0, all: 0 }
    }
    let rack = 0, bin = 0, marker = 0, model = 0
    for (const g of grids) if (scoreMatch(g.name, q) > 0) rack++
    for (const b of bins) if (
      scoreMatch(b.sku, q) > 0 ||
      scoreMatch(b.externalCode, q) > 0 ||
      scoreMatch(b.notes, q) > 0
    ) bin++
    for (const m of markers) if (scoreMatch(m.name, q) > 0) marker++
    for (const m of models) if (scoreMatch(m.name, q) > 0) model++
    return { rack, bin, marker, model, all: rack + bin + marker + model }
  }, [query, grids, bins, markers, models])

  const handlePick = (r: SearchResult) => {
    // Push into recents — dedupe by `${kind}:${ref}` then cap to 8.
    const ref = entryRefFor(r)
    if (ref) {
      const entry: RecentEntry = {
        kind: r.kind,
        ref,
        name: r.name,
        subtitle: r.subtitle,
        ts: Date.now(),
      }
      const dedup = recents.filter((x) => !(x.kind === entry.kind && x.ref === entry.ref))
      const next = [entry, ...dedup].slice(0, RECENT_LIMIT)
      setRecents(next)
      saveRecents(warehouseId, next)
    }
    onPick(r)
    setOpen(false)
    setQuery('')
  }

  const handleClearRecents = () => {
    setRecents([])
    saveRecents(warehouseId, [])
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (query) setQuery('')
      else setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, Math.max(0, results.length - 1)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
      return
    }
    if (e.key === 'Enter' && results[cursor]) {
      e.preventDefault()
      handlePick(results[cursor])
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true)
          queueMicrotask(() => inputRef.current?.focus())
        }}
        aria-label={t('view.search.open', { defaultValue: 'Search' })}
        className="fixed top-12 start-3 z-20 flex items-center gap-1.5 h-9 px-2.5 rounded-md border bg-card/95 backdrop-blur shadow-sm hover:bg-muted/60 text-xs text-muted-foreground"
      >
        <SearchIcon className="w-3.5 h-3.5" />
        <span>{t('view.search.placeholder', { defaultValue: 'Search…' })}</span>
        <kbd className="font-mono text-[9px] px-1 py-0.5 rounded border bg-muted ms-1">⌘K</kbd>
      </button>
    )
  }

  const showResults = query.trim().length >= MIN_QUERY_LENGTH
  const noMatches = showResults && results.length === 0

  return (
    <div className="fixed top-12 start-3 z-30 w-80 max-w-[calc(100vw-1.5rem)] bg-card/95 backdrop-blur border rounded-md shadow-md">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b">
        <SearchIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('view.search.placeholder', { defaultValue: 'Search racks, bins, markers…' })}
          className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t('view.search.close', { defaultValue: 'Close search' })}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-1 px-2 py-1 border-b overflow-x-auto">
        <CategoryButton
          label={t('view.search.all', { defaultValue: 'All' })}
          active={filter === 'all'}
          count={counts.all}
          onClick={() => setFilter('all')}
        />
        <CategoryButton
          label={t('view.search.racks', { defaultValue: 'Racks' })}
          active={filter === 'rack'}
          count={counts.rack}
          onClick={() => setFilter('rack')}
        />
        <CategoryButton
          label={t('view.search.bins', { defaultValue: 'Bins' })}
          active={filter === 'bin'}
          count={counts.bin}
          onClick={() => setFilter('bin')}
        />
        <CategoryButton
          label={t('view.search.markers', { defaultValue: 'Markers' })}
          active={filter === 'marker'}
          count={counts.marker}
          onClick={() => setFilter('marker')}
        />
        <CategoryButton
          label={t('view.search.models', { defaultValue: 'Models' })}
          active={filter === 'model'}
          count={counts.model}
          onClick={() => setFilter('model')}
        />
      </div>

      {!showResults && resolvedRecents.length === 0 && (
        <div className="px-3 py-3 text-[11px] text-muted-foreground">
          {t('view.search.hint', {
            defaultValue: 'Type at least 2 characters to search. Use arrow keys to navigate, Enter to jump.',
          })}
        </div>
      )}

      {!showResults && resolvedRecents.length > 0 && (
        <div className="py-1">
          <div className="flex items-center justify-between px-2.5 pt-1 pb-0.5">
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Clock className="w-3 h-3" />
              {t('view.search.recent', { defaultValue: 'Recent' })}
            </span>
            <button
              type="button"
              onClick={handleClearRecents}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              {t('view.search.clear', { defaultValue: 'Clear' })}
            </button>
          </div>
          <ul className="max-h-[40dvh] overflow-y-auto">
            {resolvedRecents.map(({ result }) => (
              <li key={result.key}>
                <button
                  type="button"
                  onClick={() => handlePick(result)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/60"
                >
                  <ResultIcon kind={result.kind} />
                  <span className="flex flex-col min-w-0">
                    <span className="truncate font-medium">{result.name}</span>
                    {result.subtitle && (
                      <span className="truncate text-[10px] text-muted-foreground">
                        {result.subtitle}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {noMatches && (
        <div className="px-3 py-3 text-[11px] text-muted-foreground">
          {t('view.search.empty', { defaultValue: 'No matches.' })}
        </div>
      )}

      {showResults && results.length > 0 && (
        <ul className="max-h-[40dvh] overflow-y-auto py-1">
          {results.map((r, i) => (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => handlePick(r)}
                onMouseEnter={() => setCursor(i)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
                  i === cursor ? 'bg-muted/70' : 'hover:bg-muted/60'
                }`}
              >
                <ResultIcon kind={r.kind} />
                <span className="flex flex-col min-w-0">
                  <span className="truncate font-medium">{r.name}</span>
                  {r.subtitle && (
                    <span className="truncate text-[10px] text-muted-foreground">
                      {r.subtitle}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
