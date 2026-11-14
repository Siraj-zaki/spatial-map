import { useTheme } from '@/components/theme-provider'
import { installEmptyLayerGate } from '@/lib/empty-layer-gate'
import { installTranslucentLayerOrder } from '@/lib/translucent-layer-order'
import { useGraphicsSettings } from '@/lib/graphics-settings'
import { installMapMountDiagnostics } from '@/lib/map-mount-diagnostics'
import { tuneMapboxRuntime } from '@/lib/mapbox-runtime-tuning'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
// The viewer + editor render the Mapbox public styles defined in
// `/map-styles.json` (project root). The JSON is the single source
// of truth — to add or rename a style, edit only that file. The
// MapStyleId union below is derived from its top-level keys and the
// STYLE_URLS map just re-exports it.
import MAP_STYLES from '../../map-styles.json'

import { MAPBOX_TOKEN } from '@/config/runtime'

export type MapStyleId = keyof typeof MAP_STYLES

const STYLE_URLS: Record<MapStyleId, string> = MAP_STYLES

/** Ordered list of styles, used to populate every picker UI so the
 *  options shown in the viewer top strip, viewer controls popover,
 *  and the editor's map toolbar stay in lockstep with the JSON. */
export const MAP_STYLE_IDS = Object.keys(STYLE_URLS) as MapStyleId[]

/**
 * Backward-compat mapping for style ids that were renamed in the
 * 2026 rename pass. The old cryptic keys (`main`, `main-simple`,
 * `main-dark`, ...) are kept on the read path so long-lived
 * bookmarks, saved share-link `settings.mapStyle`, and users'
 * `viewerMapStyle` / `editorMapStyle` localStorage entries continue
 * to resolve to the correct style url. New code should always use
 * the friendly names on the right-hand side.
 */
const LEGACY_STYLE_ALIAS: Record<string, MapStyleId> = {
  'main': 'standard' as MapStyleId,
  'main-simple': 'standard-simple' as MapStyleId,
  'main-dark': 'dark' as MapStyleId,
  'main-light': 'light' as MapStyleId,
  'main-dusk': 'dusk' as MapStyleId,
  'main-streets': 'streets' as MapStyleId,
  'monochrome-day': 'light' as MapStyleId,
  'monochrome-night': 'dark' as MapStyleId,
  'monochrome-light': 'light' as MapStyleId,
  'monochrome-dark': 'dark' as MapStyleId,
}

/** Friendly labels for the picker — derived from each id by replacing
 *  dashes with spaces and capitalising. Override in the i18n
 *  catalogues via `view.controls.style<Id>` if a custom translation
 *  is wanted. */
export function defaultStyleLabel(id: MapStyleId): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** Default style on first load. Picks the JSON's `standard` entry when
 *  present (Mapbox Standard: 3D buildings, light presets, label config).
 *  Falls back to the first key so a rename never breaks the app. */
export const DEFAULT_MAP_STYLE: MapStyleId = ('standard' as MapStyleId) in STYLE_URLS
  ? ('standard' as MapStyleId)
  : MAP_STYLE_IDS[0]

/**
 * Normalise a potentially-stale style id to one the runtime can
 * actually resolve. Older bookmarks / deep links may carry style ids
 * from the previous catalogue (`?style=standard` etc.) — those would
 * otherwise feed `undefined` into `setStyle()` and break overlay
 * mounting. Legacy aliases are translated first, then unknown ids
 * fall through to the JSON default.
 */
export function normalizeStyleId(id: string | null | undefined): MapStyleId {
  if (!id) return DEFAULT_MAP_STYLE
  if ((id as MapStyleId) in STYLE_URLS) return id as MapStyleId
  const aliased = LEGACY_STYLE_ALIAS[id]
  if (aliased && (aliased as MapStyleId) in STYLE_URLS) return aliased
  return DEFAULT_MAP_STYLE
}

interface MapboxMapProps {
  onMapLoad?: (map: mapboxgl.Map) => void
  onMapDestroy?: () => void
  initialView?: { center: [number, number]; zoom: number }
  styleId?: MapStyleId
  /** The page is still loading what goes on the map (a facility's floors and
   *  shapes): keeps the loading pill up, worded by `busyLabel`. */
  busy?: boolean
  busyLabel?: string
  /** Unit shown by the scale bar (bottom-left). Defaults to metric. */
  scaleUnit?: 'metric' | 'imperial'
}

export function MapboxMap({ onMapLoad, onMapDestroy, initialView, styleId = DEFAULT_MAP_STYLE, scaleUnit = 'metric', busy = false, busyLabel }: MapboxMapProps) {
  // 'initial' until the first style + tiles load; 'style' while a new
  // basemap parses (see the styleId effect); null once the map can draw.
  const [mapLoading, setMapLoading] = useState<'initial' | 'style' | null>('initial')
  const { theme } = useTheme()
  const { i18n, t } = useTranslation()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const scaleControlRef = useRef<mapboxgl.ScaleControl | null>(null)
  // Only used to hand the instance to the perf HUD (currently disabled, see
  // the commented-out <MapPerfMonitor> below), which needs it as a prop
  // rather than a ref so it re-subscribes when the map is recreated.
  const [, setMapInstance] = useState<mapboxgl.Map | null>(null)

  const getLightPreset = () => {
    const isDark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    return isDark ? 'day' : 'day'
  }

  // Track the latest styleId in a ref so the `style.load` listener (registered
  // once at create time) always reads the current value when applying the
  // light preset — the closure-captured value would otherwise go stale.
  const styleIdRef = useRef(styleId)
  useEffect(() => {
    styleIdRef.current = styleId
  }, [styleId])

  // Tracks the last applied basemap lightPreset so we never set the
  // same value twice. `setConfigProperty('basemap', 'lightPreset', …)`
  // re-fires `style.load` on Standard-derived styles (the `standard`
  // entry in `/map-styles.json`), so an
  // unguarded call inside the `style.load` handler creates a cascade:
  // style swap → onStyleLoad → setConfigProperty → style.load → …
  // The cascade tears down every overlay's just-added layers, which
  // shows up as "shapes load briefly then vanish".
  const lastLightPresetRef = useRef<string | null>(null)
  const applyLightPreset = (map: mapboxgl.Map) => {
    const next = getLightPreset()
    if (lastLightPresetRef.current === next) return
    try {
      map.setConfigProperty('basemap', 'lightPreset', next)
      lastLightPresetRef.current = next
    } catch {
      // Style doesn't expose the basemap config (non-Standard custom
      // style, or style not ready yet — `style.load` will retry).
    }
  }

  /**
   * Hide every category of Mapbox Standard's built-in text labels — POI
   * pins, place names, road names, and transit labels — so the editor
   * shows a clean base for the user's own shape labels + drawn geometry.
   *
   * The per-shape `clip` layers in the polygon / circle / grid / image
   * overlays already erase 3D building MODELS inside a drawn footprint,
   * but Mapbox's clip layer type doesn't reliably cover the symbol
   * layers labels live on (they're in sub-scopes the `['basemap']`
   * scope filter doesn't always catch in v3.25). Using the Standard
   * style's own StyleConfig properties turns them off at the style
   * level. Classic styles in `/map-styles.json` (streets, light, dark…)
   * don't expose the config, so the call is a caught no-op there.
   *
   * Dedupe pattern mirrors `applyLightPreset` above: `setConfigProperty`
   * re-fires `style.load`, so a naked re-apply from inside the load
   * handler would cascade forever and tear down every overlay's
   * just-added layers. Guarded by a "did we already turn them off?" ref
   * so it only actually calls Mapbox once per style swap.
   */
  const labelsSuppressedRef = useRef<boolean>(false)
  const applyLabelSuppression = (map: mapboxgl.Map) => {
    if (labelsSuppressedRef.current) return
    try {
      map.setConfigProperty('basemap', 'showPointOfInterestLabels', false)
      map.setConfigProperty('basemap', 'showPlaceLabels', false)
      map.setConfigProperty('basemap', 'showRoadLabels', false)
      map.setConfigProperty('basemap', 'showTransitLabels', false)
      labelsSuppressedRef.current = true
    } catch {
      // Non-Standard style or config not ready — retry on next
      // `style.load`. Silent because failure just means labels stay
      // visible, which is a harmless degrade.
    }
  }

  /**
   * Configure the Mapbox GL JS v3 light + shadow stack. A single
   * directional light with `cast-shadows: true` is what drives the
   * Mappedin-style "darker shadow at the base of every wall / rack /
   * extrusion" look — the wall doesn't paint that gradient itself,
   * the renderer projects a real shadow onto adjacent geometry and
   * the ground.
   *
   * The matching ambient light lifts the unlit faces just enough that
   * walls don't read as black on the shadowed side. Shadow intensity
   * 0.5 matches the reference indoor-map render; turning it past ~0.7
   * starts to look stagey.
   *
   * Wrapped in try/catch because `setLights` only exists on GL JS
   * v3+ runtimes; on older builds we silently skip and the rest of
   * the rendering still works.
   *
   * The Shadows toggle sticks on Standard-import styles too (checked
   * against GL JS 3.25): their root has no `lights`, so after load the
   * root's `directionalLight` IS the basemap import's light object, and
   * `setLights` overwrites its properties in place. A later `mergeAll`
   * (import reload, HD-roads load) re-picks that same object, so
   * `cast-shadows: false` survives, and as a non-transitionable property
   * it applies on the very next frame. One leftover: the import's sources
   * were flagged `castsShadows` while Standard's own light was still on,
   * so they keep prefetching (never drawing) shadow-caster tiles.
   */
  const applyLights = (map: mapboxgl.Map) => {
    // Read the current graphics-quality setting at apply-time. The
    // effect below re-invokes this whenever the store toggles, so a
    // stale snapshot here is harmless — the next call has the truth.
    const shadowsEnabled = useGraphicsSettings.getState().shadows
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (map as any).setLights?.([
        {
          id: 'ambient-light',
          type: 'ambient',
          properties: {
            color: '#ffffff',
            intensity: 0.5,
          },
        },
        {
          id: 'directional-light',
          type: 'directional',
          properties: {
            color: '#ffffff',
            intensity: 0.7,
            // Azimuth (compass bearing of the sun, 0 = N, 90 = E)
            // and polar angle (0 = directly overhead, 90 = horizon).
            // 210° azimuth + 45° polar matches Mapbox's daylight
            // preset orientation, so the shadow our walls cast
            // lines up with the basemap building shadows.
            direction: [210, 45],
            // Scene-level shadow kill switch — flipping this to false
            // skips the entire shadow-map generation pass every frame
            // (the single largest 3D GPU cost per the Mapbox docs).
            // Users can re-enable from the SidePanel graphics section.
            'cast-shadows': shadowsEnabled,
            'shadow-intensity': 0.35,
          },
        },
      ])
    } catch {
      // GL JS < 3 — silently skip, no shadows.
    }
  }

  /**
   * Iterate every currently-mounted extrusion + model layer and set
   * paint props that can't be toggled from the scene light config:
   *   - `fill-extrusion-ambient-occlusion-intensity` (screen-space AO pass)
   *   - `model-cast-shadows` / `model-receive-shadows` (per-layer)
   *
   * Called on style.load and whenever the graphics-settings store
   * changes. Safe to invoke repeatedly — `setPaintProperty` is a
   * cheap no-op when the value already matches.
   */
  const applyGraphicsToLayers = (map: mapboxgl.Map) => {
    const { shadows, ambientOcclusion } = useGraphicsSettings.getState()
    try {
      const style = map.getStyle()
      if (!style?.layers) return
      const aoIntensity = ambientOcclusion ? 0.35 : 0
      for (const layer of style.layers) {
        if (layer.type === 'fill-extrusion') {
          try {
            map.setPaintProperty(
              layer.id,
              'fill-extrusion-ambient-occlusion-intensity',
              aoIntensity,
            )
          } catch {
            /* layer removed mid-iteration — ignore */
          }
        } else if (layer.type === 'model') {
          try {
            map.setPaintProperty(layer.id, 'model-cast-shadows', shadows)
            map.setPaintProperty(layer.id, 'model-receive-shadows', shadows)
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* style not ready — the next style.load will re-apply */
    }
  }

  useEffect(() => {
    if (!containerRef.current || !MAPBOX_TOKEN) return
    const center = initialView?.center ?? ([0, 20] as [number, number])
    const zoom = initialView?.zoom ?? 2

    // Normalise styleId before resolving the URL so a stale id from a
    // previous catalogue (e.g. an old bookmark with `?style=standard`)
    // never feeds `undefined` into the Map constructor, which would
    // skip basemap loading entirely and leave the overlay-mount
    // sequence racing against a half-initialised style.
    const safeStyleId = normalizeStyleId(styleIdRef.current)
    styleIdRef.current = safeStyleId
    // Perf: ask for the discrete GPU and widen the worker pool past its
    // hardcoded 2 threads. Both are one-shot and must land before the
    // constructor — the GL context is created inside it and the pool is
    // sized on first acquire.
    tuneMapboxRuntime()
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: STYLE_URLS[safeStyleId],
      center,
      zoom,
      maxZoom: 32,
      minZoom: 0,
      accessToken: MAPBOX_TOKEN,
      // Perf: warehouses live at metropolis-scale zoom, never at the
      // world seam, so multi-world rendering is wasted work.
      renderWorldCopies: false,
      // Labels pop in / out on collision instead of fading. Not a perf
      // win while the camera moves: at 0, GL JS re-runs symbol placement
      // synchronously on every moving frame (a non-zero fade throttles it
      // to once per fade and time-slices it at ~2 ms/frame). Kept at 0
      // because a fade is a visible change.
      fadeDuration: 0,
      // Perf: at warehouse zoom (17-19) GL JS auto-picks mercator
      // anyway; setting it explicitly skips the globe→mercator
      // transition + atmosphere pass at low zoom.
      projection: 'mercator',
    })
    mapRef.current = map
    setMapInstance(map)
    // Dev-only: instrument addSource/addLayer/removeSource/removeLayer
    // so we can spot any overlay that mounts the same id twice without
    // an intervening remove (i.e. redundant work). No-op in production.
    installMapMountDiagnostics(map)
    // Perf: hide overlay layers whose source holds zero features. GL JS only
    // skips per-frame `layer.recalculate()` for `visibility: 'none'`, so an
    // empty layer costs a full style re-evaluation every frame to draw
    // nothing. Installed before any overlay mounts so the gate sees every
    // addSource/addLayer/setData.
    const uninstallEmptyLayerGate = installEmptyLayerGate(map)
    // Translucent extrusions write depth in a pre-pass, so any opaque 3D
    // layer drawn after one and standing behind it vanishes. Keep every
    // translucent fill-extrusion after the opaque 3D layers.
    const uninstallTranslucentOrder = installTranslucentLayerOrder(map)

    const scaleControl = new mapboxgl.ScaleControl({ maxWidth: 100, unit: scaleUnit })
    scaleControlRef.current = scaleControl
    map.addControl(scaleControl, 'bottom-left')
    // map.addControl(new mapboxgl.NavigationControl({ showCompass: false, visualizePitch: true }), 'top-right')

    // NOTE: we deliberately do NOT reset `lastLightPresetRef` inside
    // `onStyleLoad`. `setConfigProperty('basemap', 'lightPreset', …)`
    // itself fires `style.load` (Standard inherits trigger it), so a
    // reset would defeat the dedupe and loop forever — the very
    // failure mode that was hiding the overlays. The ref is reset
    // explicitly in the style-swap effect below where we know the
    // basemap URL truly changed.
    const onStyleLoad = () => {
      applyLightPreset(map)
      // Re-apply the directional light + shadows after a basemap swap
      // because Mapbox resets the lights array when a style loads.
      applyLights(map)
      // Turn off basemap POI / place / road / transit labels every
      // time a style loads so the map stays clean under the user's
      // drawn shapes + custom labels.
      applyLabelSuppression(map)
      // Re-apply per-layer graphics toggles (AO, model shadows) after
      // any style/overlay mount so freshly-added layers pick up the
      // current user preference.
      applyGraphicsToLayers(map)
    }
    map.on('style.load', onStyleLoad)

    // Subscribe to the graphics-quality store so a user toggle at
    // runtime re-applies the scene light + iterates every extrusion /
    // model layer's paint. Store subscription runs outside React so it
    // fires immediately on set, no re-render needed.
    const unsubscribeGraphics = useGraphicsSettings.subscribe(() => {
      applyLights(map)
      applyGraphicsToLayers(map)
    })

    map.on('load', () => {
      setMapLoading(null)
      applyLightPreset(map)
      applyLights(map)
      applyLabelSuppression(map)
      applyGraphicsToLayers(map)
      // Expose the map on window in dev mode so Playwright tests can
      // introspect layers, sources, and rendered features.
      if (import.meta.env.DEV) {
        ; (window as unknown as { __mapboxMap?: mapboxgl.Map }).__mapboxMap = map
      }
      onMapLoad?.(map)
    })

    return () => {
      onMapDestroy?.()
      unsubscribeGraphics()
      uninstallEmptyLayerGate()
      uninstallTranslucentOrder()
      map.off('style.load', onStyleLoad)
      map.remove()
      mapRef.current = null
      setMapInstance(null)
    }
    // Create the map once and reuse it for the lifetime of the component.
    // Style swaps go through `map.setStyle()` in the effect below, per the
    // official Mapbox style-switch example, so the Map instance (and all
    // overlay sources/layers + camera state) is preserved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Swap the basemap in place when `styleId` changes. Mapbox fires
  // `style.load` once the new style is parsed; every overlay component
  // listens for that event and re-adds its sources/layers. Camera state
  // (center/zoom/pitch/bearing) is preserved automatically by `setStyle`.
  // See: https://docs.mapbox.com/mapbox-gl-js/example/style-switch/
  const appliedStyleIdRef = useRef(normalizeStyleId(styleId))
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const safe = normalizeStyleId(styleId)
    if (appliedStyleIdRef.current === safe) return
    appliedStyleIdRef.current = safe
    // Real basemap change — the new style starts with its own light
    // preset baseline, so allow the next `applyLightPreset` to actually
    // run. (Inside `style.load` we never reset, to avoid the cascade.)
    lastLightPresetRef.current = null
    // Same reset for label suppression — a fresh basemap starts with
    // its default label visibility, so re-apply the suppression once
    // the new style parses.
    labelsSuppressedRef.current = false
    // The new basemap shows a small "Loading map…" pill until it parses.
    setMapLoading('style')
    map.once('style.load', () => setMapLoading(null))
    map.setStyle(STYLE_URLS[safe])
  }, [styleId])

  // Update the light preset when the theme changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    applyLightPreset(map)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme])

  // Push unit changes to the scale control. Mapbox's ScaleControl
  // exposes `setUnit()` for this exact case so we don't have to
  // remove + re-add the control on every flip.
  useEffect(() => {
    scaleControlRef.current?.setUnit(scaleUnit)
  }, [scaleUnit])

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex items-center justify-center h-full border-2 border-dashed rounded-lg bg-muted" dir={i18n.dir()}>
        <div className="max-w-md p-6 text-center">
          <p className="mb-2 text-lg font-semibold">{t('mapbox.tokenRequired')}</p>
          <p className="text-sm text-muted-foreground">{t('mapbox.tokenInstructions')}</p>
          <code className="block p-2 mt-2 text-xs rounded bg-muted-foreground/10" dir="ltr">
            {t('mapbox.tokenCode')}
          </code>
        </div>
      </div>
    )
  }

  const isRTL = i18n.dir() === 'rtl'

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        dir={isRTL ? 'rtl' : 'ltr'}
        className="w-full h-full"
      />
      <MapLoadingOverlay state={mapLoading ?? (busy ? 'busy' : null)} label={busy ? busyLabel : undefined} />
      {/* Portals to document.body and renders nothing until opened, so it
          contributes no DOM here and can't affect the map container's box. */}
      {/* {mapInstance ? <MapPerfMonitor map={mapInstance} /> : null} */}
    </div>
  )
}

/**
 * What a map shows while it can't draw yet: on first load a soft
 * placeholder over the whole canvas; while a new basemap parses only a
 * small pill (the old map stays visible). Fades out when ready. Never
 * blocks the map's own pointer events.
 */
function MapLoadingOverlay({ state, label }: { state: 'initial' | 'style' | 'busy' | null; label?: string }) {
  const { t } = useTranslation()
  const [shown, setShown] = useState(state)
  if (state !== null && state !== shown) setShown(state)
  const visible = state !== null
  return (
    <div
      className={`pointer-events-none absolute inset-0 z-[1] flex items-center justify-center transition-opacity duration-500 ${visible ? 'opacity-100' : 'opacity-0'} ${shown === 'initial' ? 'bg-muted' : ''}`}
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
    >
      {shown === 'initial' && <div className="absolute inset-0 animate-pulse bg-muted-foreground/5 motion-reduce:animate-none" aria-hidden />}
      <div className="sgv-glass relative flex items-center gap-3 rounded-full px-4 py-2 text-xs font-medium text-muted-foreground">
        <span className="relative h-1 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
          <span className="sgv-indeterminate absolute inset-y-0 start-0 w-1/3 rounded-full bg-primary" />
        </span>
        {label ?? t('common.loadingMap', { defaultValue: 'Loading map…' })}
      </div>
    </div>
  )
}
