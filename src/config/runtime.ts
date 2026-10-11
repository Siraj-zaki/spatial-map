/**
 * Settings a deployment can change without rebuilding the SPA. The web
 * container's entrypoint (docker/web/entrypoint.sh) writes them to
 * `/config.js` from its environment at start-up; `public/config.js` is the
 * empty default for `npm run dev` / `npm run build`. A runtime value wins
 * over the build-time `VITE_*` one, so one published image works with any
 * Mapbox token.
 */
interface RuntimeConfig {
  mapboxToken?: string
  termsUrl?: string
  privacyUrl?: string
}

const runtime: RuntimeConfig =
  (typeof window !== 'undefined' && (window as unknown as { __SPATIAL_MAP_CONFIG__?: RuntimeConfig }).__SPATIAL_MAP_CONFIG__) || {}

const pick = (value: string | undefined, fallback: string | undefined): string => (value || fallback || '').trim()

export const MAPBOX_TOKEN = pick(runtime.mapboxToken, import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined)
export const TERMS_URL = pick(runtime.termsUrl, import.meta.env.VITE_TERMS_URL as string | undefined)
export const PRIVACY_URL = pick(runtime.privacyUrl, import.meta.env.VITE_PRIVACY_URL as string | undefined)
