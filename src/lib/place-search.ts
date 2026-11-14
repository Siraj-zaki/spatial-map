/**
 * Place search for the editor's "Search places" box.
 *
 * Three sources, merged into one ranked list:
 *   1. Typed coordinates — parsed locally, no network. Decimal ("31.52, 74.35"),
 *      hemisphere letters ("31.52 N 74.35 E"), DMS / DDM (31°31'13"N 74°21'31"E),
 *      and Google Maps / OSM links ("…/@31.52,74.35,17z", "?q=31.52,74.35").
 *   2. Mapbox Search Box API (suggest → retrieve) — good POI coverage in the
 *      US/EU, biased to the current map centre.
 *   3. Photon (OpenStreetMap, photon.komoot.io) — fills the gaps Mapbox has
 *      in South Asia / the Middle East (malls, hospitals, landmarks). Public
 *      fair-use instance; results need "© OpenStreetMap contributors" shown.
 *
 * Each network source fails independently; the caller only shows an error
 * when every source failed.
 */

/**
 * Read lazily so the pure helpers (parseCoordinates) also run outside Vite.
 * The runtime token (`/config.js`, set by the web container) wins over the
 * build-time one — the same rule as `config/runtime.ts`.
 */
const mapboxToken = (): string | undefined => {
  const runtime =
    typeof window !== 'undefined'
      ? (window as unknown as { __SPATIAL_MAP_CONFIG__?: { mapboxToken?: string } }).__SPATIAL_MAP_CONFIG__?.mapboxToken
      : undefined
  return (runtime || import.meta.env?.VITE_MAPBOX_ACCESS_TOKEN || '').trim() || undefined
}

export type PlaceSource = 'coords' | 'mapbox' | 'osm'

export interface PlaceResult {
  id: string
  source: PlaceSource
  title: string
  subtitle?: string
  /** [lng, lat]. Absent for Mapbox suggestions until `resolvePlace` runs. */
  center?: [number, number]
  /** [minLng, minLat, maxLng, maxLat] */
  bbox?: [number, number, number, number]
  /** Mapbox Search Box id, needed by `/retrieve`. */
  mapboxId?: string
  /** Coordinates typed in lng-first order (we swapped them). */
  swapped?: boolean
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export type CoordParse =
  | { kind: 'none' }
  | { kind: 'outOfRange' }
  | { kind: 'ok'; lat: number; lng: number; alt?: { lat: number; lng: number } }

const NUM = '[-+]?\\d+(?:\\.\\d+)?'

function inRange(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

/** Pull a lat,lng pair out of a Google Maps / OSM / generic map link. */
function parseFromUrl(s: string): { lat: number; lng: number } | null {
  if (!/^https?:\/\/|^www\.|maps\./i.test(s)) return null
  const patterns = [
    new RegExp(`!3d(${NUM})!4d(${NUM})`), // Google place pin (more precise than @)
    new RegExp(`@(${NUM}),(${NUM})`), // Google viewport centre
    new RegExp(`[?&#](?:q|ll|query|center|destination|map=\\d+(?:\\.\\d+)?)[=/](${NUM})(?:,|%2C|/)\\s*(${NUM})`, 'i'),
  ]
  const decoded = (() => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  })()
  for (const re of patterns) {
    const m = decoded.match(re)
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) }
  }
  return null
}

interface Component {
  deg: number
  negative: boolean
  min?: number
  sec?: number
  hemi?: 'N' | 'S' | 'E' | 'W'
  hasUnit: boolean
}

/**
 * Parse typed coordinates. Returns `none` when the text isn't coordinates
 * (so ordinary place names fall through to the geocoders), `outOfRange` when
 * it clearly is coordinates but the numbers can't be a lat/lng.
 */
export function parseCoordinates(input: string): CoordParse {
  const raw = input.trim()
  if (!raw) return { kind: 'none' }

  const fromUrl = parseFromUrl(raw)
  if (fromUrl) return inRange(fromUrl.lat, fromUrl.lng) ? { kind: 'ok', ...fromUrl } : { kind: 'outOfRange' }

  // Normalise: unicode primes/quotes, "deg", optional axis words.
  const s = raw
    .toUpperCase()
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″“”]|''/g, '"')
    .replace(/º|˚|DEG(REES?)?/g, '°')
    .replace(/\b(LATITUDE|LONGITUDE|LAT|LNG|LON|LONG)\b\s*[:=]?/g, ' ')

  // Anything other than numbers, units, hemisphere letters and separators
  // means it's a place name, not coordinates.
  if (/[^0-9NSEW.+\-°'"\s,;/]/.test(s)) return { kind: 'none' }
  if (!/\d/.test(s)) return { kind: 'none' }

  const atomRe = new RegExp(`([NSEW])|(${NUM})\\s*([°'"])?`, 'g')
  const atoms: Array<{ hemi?: 'N' | 'S' | 'E' | 'W'; num?: string; unit?: string }> = []
  let m: RegExpExecArray | null
  while ((m = atomRe.exec(s))) {
    if (m[1]) atoms.push({ hemi: m[1] as Component['hemi'] })
    else atoms.push({ num: m[2], unit: m[3] })
  }
  if (atoms.length < 2) return { kind: 'none' }

  // Hemisphere letters are either all prefixes ("N 31 E 74") or all
  // suffixes ("31 N 74 E"); the first atom tells us which.
  const prefixMode = atoms[0].hemi !== undefined
  const comps: Component[] = []
  let pendingHemi: Component['hemi']
  for (const a of atoms) {
    if (a.hemi) {
      if (prefixMode) {
        if (pendingHemi) return { kind: 'none' }
        pendingHemi = a.hemi
      } else {
        const last = comps[comps.length - 1]
        if (!last || last.hemi) return { kind: 'none' }
        last.hemi = a.hemi
      }
      continue
    }
    const value = Number(a.num)
    const last = comps[comps.length - 1]
    if (a.unit === "'" || a.unit === '"') {
      // Minutes / seconds belong to the component in progress.
      if (!last || last.hemi && !prefixMode) return { kind: 'none' }
      if (a.unit === "'") {
        if (last.min !== undefined || last.sec !== undefined) return { kind: 'none' }
        last.min = value
      } else {
        if (last.sec !== undefined) return { kind: 'none' }
        last.sec = value
      }
      last.hasUnit = true
      continue
    }
    comps.push({
      deg: Math.abs(value),
      negative: (a.num ?? '').startsWith('-'),
      hasUnit: a.unit === '°',
      hemi: prefixMode ? pendingHemi : undefined,
    })
    pendingHemi = undefined
  }
  if (pendingHemi || comps.length !== 2) return { kind: 'none' }

  const toDecimal = (c: Component) => {
    if ((c.min ?? 0) >= 60 || (c.sec ?? 0) >= 60) return NaN
    const v = c.deg + (c.min ?? 0) / 60 + (c.sec ?? 0) / 3600
    const neg = c.negative || c.hemi === 'S' || c.hemi === 'W'
    return neg ? -v : v
  }
  const [a, b] = comps
  const va = toDecimal(a)
  const vb = toDecimal(b)
  if (!Number.isFinite(va) || !Number.isFinite(vb)) return { kind: 'outOfRange' }

  const isLatHemi = (h?: string) => h === 'N' || h === 'S'
  const isLngHemi = (h?: string) => h === 'E' || h === 'W'

  // Hemisphere letters settle the order.
  if (a.hemi || b.hemi) {
    let lat: number, lng: number
    if (isLatHemi(a.hemi) || isLngHemi(b.hemi)) {
      if (isLngHemi(a.hemi) || isLatHemi(b.hemi)) return { kind: 'none' }
      lat = va
      lng = vb
    } else {
      lat = vb
      lng = va
    }
    return inRange(lat, lng) ? { kind: 'ok', lat, lng } : { kind: 'outOfRange' }
  }

  // No letters: lat, lng (the Google Maps convention) unless only the
  // reverse is valid. When both orders are valid, offer the reverse too.
  if (inRange(va, vb)) {
    const alt = Math.abs(vb) <= 90 && va !== vb ? { lat: vb, lng: va } : undefined
    return { kind: 'ok', lat: va, lng: vb, alt }
  }
  if (inRange(vb, va)) return { kind: 'ok', lat: vb, lng: va }
  return { kind: 'outOfRange' }
}

export function formatLatLng(lat: number, lng: number) {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`
}

// ---------------------------------------------------------------------------
// Mapbox Search Box
// ---------------------------------------------------------------------------

export function newSessionToken(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

interface SearchContext {
  language: string
  /** Map centre, [lng, lat] — biases results toward what the user is looking at. */
  proximity?: [number, number]
  zoom?: number
  sessionToken: string
  signal: AbortSignal
}

async function searchMapbox(query: string, ctx: SearchContext): Promise<PlaceResult[]> {
  const token = mapboxToken()
  if (!token) return []
  const params = new URLSearchParams({
    q: query,
    access_token: token,
    session_token: ctx.sessionToken,
    language: ctx.language,
    limit: '6',
  })
  if (ctx.proximity) params.set('proximity', `${ctx.proximity[0]},${ctx.proximity[1]}`)
  const res = await fetch(`https://api.mapbox.com/search/searchbox/v1/suggest?${params}`, { signal: ctx.signal })
  if (!res.ok) throw new Error(`Mapbox search failed: ${res.status}`)
  const data = (await res.json()) as {
    suggestions?: Array<{ mapbox_id: string; name: string; place_formatted?: string; full_address?: string; feature_type?: string }>
  }
  return (data.suggestions ?? [])
    // Category / brand rows ("Restaurants") need a different endpoint; skip them.
    .filter((s) => s.feature_type !== 'category' && s.feature_type !== 'brand')
    .map((s) => ({
      id: `mapbox:${s.mapbox_id}`,
      source: 'mapbox' as const,
      title: s.name,
      subtitle: s.place_formatted || s.full_address,
      mapboxId: s.mapbox_id,
    }))
}

// ---------------------------------------------------------------------------
// Photon (OpenStreetMap)
// ---------------------------------------------------------------------------

/** Photon's public instance rejects any other `lang` with HTTP 400. */
const PHOTON_LANGS = new Set(['en', 'de', 'fr'])

interface PhotonFeature {
  geometry: { coordinates: [number, number] }
  properties: {
    osm_type?: string
    osm_id?: number
    name?: string
    housenumber?: string
    street?: string
    district?: string
    city?: string
    county?: string
    state?: string
    country?: string
    /** [minLon, maxLat, maxLon, minLat] — note the odd order. */
    extent?: [number, number, number, number]
  }
}

async function searchPhoton(query: string, ctx: SearchContext): Promise<PlaceResult[]> {
  const params = new URLSearchParams({ q: query, limit: '6' })
  if (PHOTON_LANGS.has(ctx.language)) params.set('lang', ctx.language)
  if (ctx.proximity) {
    params.set('lon', ctx.proximity[0].toFixed(5))
    params.set('lat', ctx.proximity[1].toFixed(5))
    if (ctx.zoom !== undefined) params.set('zoom', String(Math.max(1, Math.min(18, Math.round(ctx.zoom)))))
  }
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal: ctx.signal })
  if (!res.ok) throw new Error(`OSM search failed: ${res.status}`)
  const data = (await res.json()) as { features?: PhotonFeature[] }
  return (data.features ?? []).map((f, i) => {
    const p = f.properties
    const street = [p.housenumber, p.street].filter(Boolean).join(' ')
    const title = p.name || street || p.city || p.state || p.country || query
    const subtitle = uniq([street !== title ? street : undefined, p.district, p.city, p.state, p.country])
      .filter((x) => x !== title)
      .join(', ')
    const e = p.extent
    return {
      id: `osm:${p.osm_type ?? ''}${p.osm_id ?? i}`,
      source: 'osm' as const,
      title,
      subtitle: subtitle || undefined,
      center: f.geometry.coordinates,
      bbox: e ? ([e[0], e[3], e[2], e[1]] as [number, number, number, number]) : undefined,
    }
  })
}

function uniq(xs: Array<string | undefined>): string[] {
  const out: string[] = []
  for (const x of xs) if (x && !out.includes(x)) out.push(x)
  return out
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const MAX_RESULTS = 8

function norm(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Share of the query's words found in the result — pushes "Mal, Lahore"
 *  below "Packages Mall, Lahore" for the query "packages mall lahore". */
function relevance(r: PlaceResult, words: string[]) {
  if (words.length === 0) return 0
  const hay = ` ${norm(`${r.title} ${r.subtitle ?? ''}`)} `
  const titleHay = ` ${norm(r.title)} `
  let score = 0
  for (const w of words) {
    if (titleHay.includes(` ${w}`)) score += 1.2
    else if (hay.includes(` ${w}`)) score += 1
  }
  return score / words.length
}

export interface PlaceSearchOutcome {
  results: PlaceResult[]
  /** True when every network source failed (and nothing was parsed locally). */
  failed: boolean
  usedOsm: boolean
}

export async function searchPlaces(query: string, ctx: SearchContext): Promise<PlaceSearchOutcome> {
  const settled = await Promise.allSettled([searchMapbox(query, ctx), searchPhoton(query, ctx)])
  if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const mapbox = settled[0].status === 'fulfilled' ? settled[0].value : []
  const osm = settled[1].status === 'fulfilled' ? settled[1].value : []
  const failed = settled.every((s) => s.status === 'rejected')

  // Interleave so neither source dominates before ranking (stable sort keeps
  // this order for equal scores).
  const interleaved: PlaceResult[] = []
  for (let i = 0; i < Math.max(mapbox.length, osm.length); i++) {
    if (mapbox[i]) interleaved.push(mapbox[i])
    if (osm[i]) interleaved.push(osm[i])
  }
  const seen = new Set<string>()
  const deduped = interleaved.filter((r) => {
    const key = `${norm(r.title)}|${norm((r.subtitle ?? '').split(',')[0] ?? '')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const words = norm(query).split(' ').filter((w) => w.length > 1)
  const ranked = deduped
    .map((r, i) => ({ r, i, s: relevance(r, words) }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .slice(0, MAX_RESULTS)
    .map((x) => x.r)
  return { results: ranked, failed, usedOsm: ranked.some((r) => r.source === 'osm') }
}

/** Fill in `center`/`bbox` for a Mapbox suggestion (ends the billing session). */
export async function resolvePlace(r: PlaceResult, sessionToken: string): Promise<PlaceResult> {
  const token = mapboxToken()
  if (r.center || !r.mapboxId || !token) return r
  const params = new URLSearchParams({ access_token: token, session_token: sessionToken })
  const res = await fetch(`https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(r.mapboxId)}?${params}`)
  if (!res.ok) throw new Error(`Mapbox retrieve failed: ${res.status}`)
  const data = (await res.json()) as {
    features?: Array<{ geometry: { coordinates: [number, number] }; properties?: { bbox?: [number, number, number, number] } }>
  }
  const f = data.features?.[0]
  if (!f) throw new Error('Mapbox retrieve returned no feature')
  return { ...r, center: f.geometry.coordinates, bbox: f.properties?.bbox }
}
