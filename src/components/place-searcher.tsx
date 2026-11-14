import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, MapPin, X, Loader2, Crosshair } from 'lucide-react'
import mapboxgl from 'mapbox-gl'
import type { Map as MapboxMap } from 'mapbox-gl'
import { cn } from '@/lib/utils'
import {
  formatLatLng,
  newSessionToken,
  parseCoordinates,
  resolvePlace,
  searchPlaces,
  type PlaceResult,
} from '@/lib/place-search'

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

const DEBOUNCE_MS = 250
/** Zoom for a typed coordinate / a POI without a bbox — building level. */
const POINT_ZOOM = 18

/**
 * Map place searcher. Accepts place names (Mapbox Search Box + OpenStreetMap
 * via Photon, see `lib/place-search.ts`) and typed coordinates / map links.
 * Choosing a result flies the map there and drops a pin, which stays until
 * the search is cleared.
 */
export function PlaceSearcher({ map, language, className }: PlaceSearcherProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PlaceResult[]>([])
  const [usedOsm, setUsedOsm] = useState(false)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Latest request id — older responses are ignored to avoid race conditions
  // when the user types quickly.
  const reqIdRef = useRef(0)
  // Mapbox Search Box bills per session (suggests … retrieve).
  const sessionRef = useRef(newSessionToken())
  const markerRef = useRef<mapboxgl.Marker | null>(null)

  // Typed coordinates are parsed synchronously and listed first.
  const coords = useMemo(() => parseCoordinates(query), [query])
  const coordResults = useMemo<PlaceResult[]>(() => {
    if (coords.kind !== 'ok') return []
    const out: PlaceResult[] = [
      {
        id: 'coords',
        source: 'coords',
        title: formatLatLng(coords.lat, coords.lng),
        subtitle: t('placeSearcher.coordinates'),
        center: [coords.lng, coords.lat],
      },
    ]
    if (coords.alt) {
      out.push({
        id: 'coords-alt',
        source: 'coords',
        title: formatLatLng(coords.alt.lat, coords.alt.lng),
        subtitle: t('placeSearcher.coordinatesSwapped'),
        center: [coords.alt.lng, coords.alt.lat],
        swapped: true,
      })
    }
    return out
  }, [coords, t])
  const isCoordQuery = coords.kind !== 'none'
  const allResults = useMemo(() => [...coordResults, ...results], [coordResults, results])

  // Pin ------------------------------------------------------------------------
  const removeMarker = useCallback(() => {
    markerRef.current?.remove()
    markerRef.current = null
  }, [])

  const dropMarker = useCallback(
    (lngLat: [number, number], label: string) => {
      if (!map) return
      removeMarker()
      const el = document.createElement('div')
      el.className = 'pointer-events-none flex flex-col items-center'
      const chip = document.createElement('div')
      chip.className =
        'mb-1 max-w-[220px] truncate rounded-md border bg-card px-2 py-0.5 text-[11px] font-medium text-card-foreground shadow-md'
      chip.textContent = label
      const pin = document.createElement('div')
      pin.className = 'relative flex h-4 w-4 items-center justify-center'
      const ping = document.createElement('span')
      ping.className = 'absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60'
      const dot = document.createElement('span')
      dot.className = 'relative inline-flex h-4 w-4 rounded-full border-2 border-background bg-primary shadow-md'
      pin.append(ping, dot)
      el.append(chip, pin)
      el.setAttribute('aria-hidden', 'true')
      // Anchor the dot's centre (8px above the element's bottom) on the spot.
      markerRef.current = new mapboxgl.Marker({ element: el, anchor: 'bottom', offset: [0, 8] })
        .setLngLat(lngLat)
        .addTo(map)
    },
    [map, removeMarker]
  )

  // The map instance can be torn down (floor switch, unmount) — drop the pin
  // with it.
  useEffect(() => removeMarker, [map, removeMarker])

  // Fly to a chosen place ------------------------------------------------------
  const goTo = useCallback(
    (r: PlaceResult) => {
      if (!map || !r.center) return
      const [lng, lat] = r.center
      const isPoint =
        !r.bbox || (Math.abs(r.bbox[2] - r.bbox[0]) < 1e-6 && Math.abs(r.bbox[3] - r.bbox[1]) < 1e-6)
      if (isPoint) {
        map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), POINT_ZOOM), duration: 1200, essential: true })
      } else {
        map.fitBounds(
          [
            [r.bbox![0], r.bbox![1]],
            [r.bbox![2], r.bbox![3]],
          ],
          { padding: 80, duration: 1200, maxZoom: POINT_ZOOM }
        )
      }
      dropMarker([lng, lat], r.title)
    },
    [map, dropMarker]
  )

  const selectPlace = useCallback(
    (r: PlaceResult) => {
      setOpen(false)
      if (r.source === 'coords') {
        // Keep the typed coordinates in the box (normalised) so they can be
        // copied or tweaked.
        setQuery(r.title)
        goTo(r)
        return
      }
      setQuery(r.title)
      if (r.center) {
        goTo(r)
        return
      }
      const token = sessionRef.current
      sessionRef.current = newSessionToken()
      setLoading(true)
      resolvePlace(r, token)
        .then((resolved) => {
          setLoading(false)
          goTo(resolved)
        })
        .catch(() => {
          setLoading(false)
          setError(t('placeSearcher.error'))
          setOpen(true)
        })
    },
    [goTo, t]
  )

  // Debounced search ------------------------------------------------------------
  useEffect(() => {
    const trimmed = query.trim()
    const controller = new AbortController()
    const myReqId = ++reqIdRef.current
    // Coordinates (or coordinate-looking text) never hit the geocoders.
    const willSearch = trimmed.length >= 2 && !isCoordQuery
    const handle = setTimeout(() => {
      if (!willSearch) {
        setResults([])
        setUsedOsm(false)
        setLoading(false)
        setError(null)
        return
      }
      setError(null)
      setLoading(true)
      const center = map?.getCenter()
      void searchPlaces(trimmed, {
        language,
        proximity: center ? [center.lng, center.lat] : undefined,
        zoom: map?.getZoom(),
        sessionToken: sessionRef.current,
        signal: controller.signal,
      })
        .then((outcome) => {
          if (myReqId !== reqIdRef.current) return
          setResults(outcome.results)
          setUsedOsm(outcome.usedOsm)
          setHighlight(0)
          setLoading(false)
          if (outcome.failed) setError(t('placeSearcher.error'))
        })
        .catch((err) => {
          if (myReqId !== reqIdRef.current) return
          if (err instanceof DOMException && err.name === 'AbortError') return
          setError(t('placeSearcher.error'))
          setLoading(false)
          setResults([])
        })
    }, willSearch ? DEBOUNCE_MS : 0)
    return () => {
      clearTimeout(handle)
      controller.abort()
    }
  }, [query, language, t, map, isCoordQuery])

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
      if (e.key === 'Escape') {
        setOpen(false)
        return
      }
      if (allResults.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
        setHighlight((h) => Math.min(h + 1, allResults.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => Math.max(h - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const r = allResults[Math.min(highlight, allResults.length - 1)]
        if (r) selectPlace(r)
      }
    },
    [allResults, highlight, selectPlace]
  )

  const clear = useCallback(() => {
    setQuery('')
    setResults([])
    setError(null)
    setOpen(false)
    removeMarker()
    inputRef.current?.focus()
  }, [removeMarker])

  const trimmedLen = query.trim().length
  const showDropdown =
    open && (loading || error || allResults.length > 0 || coords.kind === 'outOfRange' || trimmedLen >= 2)

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
              setHighlight(0)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={t('placeSearcher.placeholder')}
            aria-label={t('placeSearcher.placeholder')}
            title={t('placeSearcher.hint')}
            className="flex-1 min-w-0 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
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
            {coords.kind === 'outOfRange' && (
              <div className="px-3 py-2 text-xs text-destructive" role="alert">
                {t('placeSearcher.outOfRange')}
              </div>
            )}
            {error && (
              <div className="px-3 py-2 text-xs text-destructive" role="alert">
                {error}
              </div>
            )}
            {!error && !loading && !isCoordQuery && results.length === 0 && trimmedLen >= 2 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t('placeSearcher.noResults')}
                <div className="mt-0.5">{t('placeSearcher.hint')}</div>
              </div>
            )}
            {allResults.map((r, i) => {
              const Icon = r.source === 'coords' ? Crosshair : MapPin
              return (
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
                  <Icon className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className={cn('truncate font-medium', r.source === 'coords' && 'font-mono text-xs leading-5')}>
                      {r.title}
                    </div>
                    {r.subtitle && <div className="truncate text-xs text-muted-foreground">{r.subtitle}</div>}
                  </div>
                </button>
              )
            })}
            {usedOsm && results.length > 0 && (
              <div className="border-t px-3 py-1 text-[10px] text-muted-foreground">
                {t('placeSearcher.attribution')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
