import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, MapPin, X, Loader2 } from 'lucide-react'
import type { Map as MapboxMap } from 'mapbox-gl'
import { cn } from '@/lib/utils'

import { MAPBOX_TOKEN } from '@/config/runtime'

interface PlaceSearcherProps {
  map: MapboxMap | null
  /**
   * Current i18n language (e.g. "en", "es", "fr", "de", "zh", "ar"). Used
   * to localize the geocoding results so the dropdown matches the rest of
   * the UI.
   */
  language: string
  /** Positioning classes; replaces the default centred-at-top placement
   *  (the editor moves it beside its side panel or onto a second row). */
  className?: string
}

interface GeocodeFeature {
  id: string
  place_name: string
  text: string
  center: [number, number]
  bbox?: [number, number, number, number]
  /** Short context like "France", "California, United States". */
  context?: string
  /** Feature type ("place", "poi", "address", ...). */
  place_type?: string[]
}

const DEBOUNCE_MS = 250

/**
 * Mapbox Geocoding v5 — `mapbox.places` returns a FeatureCollection. We only
 * use the top 5 suggestions.
 */
async function searchPlaces(query: string, language: string, signal: AbortSignal): Promise<GeocodeFeature[]> {
  if (!MAPBOX_TOKEN || query.trim().length < 2) return []
  const params = new URLSearchParams({
    access_token: MAPBOX_TOKEN,
    autocomplete: 'true',
    limit: '5',
    language,
  })
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params.toString()}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`)
  const data = (await res.json()) as { features?: GeocodeFeature[] }
  return data.features ?? []
}

/**
 * Top-center map place searcher. Renders a search input that calls the
 * Mapbox Geocoding API, shows a dropdown of suggestions, and on click
 * flies the map to the chosen place. Empty state hides the dropdown;
 * loading state shows a spinner; error state shows a small message.
 *
 * The component is unmounted/disabled gracefully when the map hasn't
 * loaded yet.
 */
export function PlaceSearcher({ map, language, className }: PlaceSearcherProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GeocodeFeature[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Latest request id — older responses are ignored to avoid race conditions
  // when the user types quickly.
  const reqIdRef = useRef(0)

  // Fly to a chosen place ------------------------------------------------------
  const selectPlace = useCallback(
    (feature: GeocodeFeature) => {
      if (!map) return
      const [lng, lat] = feature.center
      if (feature.bbox) {
        map.fitBounds(
          [
            [feature.bbox[0], feature.bbox[1]],
            [feature.bbox[2], feature.bbox[3]],
          ],
          { padding: 80, duration: 900, maxZoom: 16 }
        )
      } else {
        map.flyTo({ center: [lng, lat], zoom: 13, duration: 900, essential: true })
      }
      setQuery(feature.text)
      setOpen(false)
    },
    [map]
  )

  // Debounced search ------------------------------------------------------------
  useEffect(() => {
    const trimmed = query.trim()
    // Too short — clear results by scheduling a no-op fetch that returns
    // `[]` and resolves synchronously (the geocoder short-circuits inside
    // `searchPlaces`). We can't call `setState` synchronously inside the
    // effect body (would cause cascading renders), so we let the .then()
    // branch handle the reset.
    const controller = new AbortController()
    const myReqId = ++reqIdRef.current
    const handle = setTimeout(() => {
      const willSearch = trimmed.length >= 2
      // setLoading is also a setState in effect, but it's setting a value
      // derived from the current props (we only set it to true if we'll
      // actually search), so it's safe and the linter's "set-state-in-effect"
      // rule allows derived state updates.
      if (willSearch) {
        setError(null)
        setLoading(true)
      }
      void searchPlaces(trimmed, language, controller.signal)
        .then((features) => {
          if (myReqId !== reqIdRef.current) return
          setResults(features)
          setHighlight(0)
          setLoading(false)
        })
        .catch((err) => {
          if (myReqId !== reqIdRef.current) return
          if (err instanceof DOMException && err.name === 'AbortError') return
          setError(t('placeSearcher.error'))
          setLoading(false)
          setResults([])
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(handle)
      controller.abort()
    }
  }, [query, language, t])

  // Click outside to close -----------------------------------------------------
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Keyboard navigation (arrow up/down + enter) --------------------------------
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!open || results.length === 0) {
        if (e.key === 'Escape') setOpen(false)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => Math.min(h + 1, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => Math.max(h - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const r = results[highlight]
        if (r) selectPlace(r)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    },
    [open, results, highlight, selectPlace]
  )

  const clear = useCallback(() => {
    setQuery('')
    setResults([])
    setError(null)
    setOpen(false)
    inputRef.current?.focus()
  }, [])

  const showDropdown = open && (loading || error || results.length > 0 || query.trim().length >= 2)

  return (
    <div
      ref={containerRef}
      className={cn('absolute z-20', className ?? 'top-4 left-1/2 -translate-x-1/2 w-[min(420px,calc(100vw-2rem))]')}
    >
      <div className="relative">
        <div className="flex items-center gap-2 bg-card/95 backdrop-blur border rounded-lg shadow-lg px-3 h-10">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={t('placeSearcher.placeholder')}
            aria-label={t('placeSearcher.placeholder')}
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          />
          {loading && <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />}
          {query && !loading && (
            <button
              type="button"
              onClick={clear}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t('placeSearcher.clear')}
              title={t('placeSearcher.clear')}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {showDropdown && (
          <div
            className="absolute top-full left-0 right-0 mt-1.5 bg-popover border rounded-lg shadow-lg overflow-hidden"
            role="listbox"
          >
            {error && (
              <div className="px-3 py-2 text-xs text-destructive" role="alert">
                {error}
              </div>
            )}
            {!error && !loading && results.length === 0 && query.trim().length >= 2 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t('placeSearcher.noResults')}
              </div>
            )}
            {results.map((r, i) => (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={i === highlight}
                onClick={() => selectPlace(r)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  'w-full flex items-start gap-2 px-3 py-2 text-start text-sm',
                  i === highlight ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                )}
              >
                <MapPin className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{r.text}</div>
                  {r.context && (
                    <div className="truncate text-xs text-muted-foreground">{r.place_name}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
