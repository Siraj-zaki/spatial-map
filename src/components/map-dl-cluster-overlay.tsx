/**
 * The bubble layer of runtime point clustering (src/lib/data-link/
 * point-clusters.ts) for one data-link point config: a small non-dynamic
 * source `dl-<id>-rc-src` drawn by two filter-less symbol layers,
 * `dl-<id>-rc-cluster` (a donut icon: the theme's card disc with a ring of
 * the members' colours) and `dl-<id>-rc-cluster-count` (the count, text
 * size 9). Mounted by `PointAtCoordSubRenderer` only while the host passes
 * a `pointCluster` spec — with clustering off nothing here touches the map.
 *
 * - Ids follow `dl-<configId>-…`, so the container's orphan sweep, the
 *   report map's cluster click (`-cluster(-count)$`) and the dl layer
 *   stack all treat them as the config's own.
 * - Filter-less layers on a source that is empty while nothing is
 *   clustered: the empty-layer gate hides them, no hints needed.
 * - Donuts are images made on `styleimagemissing` (so a basemap swap
 *   re-creates them) and re-added, redrawn, on a theme change; the
 *   count's colour is a constant re-written on a theme change. No
 *   data-driven paint swaps, no feature-state.
 * - Bubble writes during a focus flight are held and the latest goes out
 *   once at `moveend` (the flight's camera settles first).
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'
import { whenStyleLoaded } from '@/lib/mapbox-style-ready'
import { readThemeTokenHex, subscribeThemeChanges } from '@/lib/map-transform-handles'
import { isFocusFlying } from '@/lib/focus/focus-camera'
import { createGeoJSONDiffWriter, type GeoJSONDiffWriter } from '@/lib/geojson-diff-writer'
import { hasMapLayer, raiseDataLinkLayers } from '@/lib/data-link/dl-layer-stack'
import {
  DONUT_IMAGE_PREFIX,
  clearRuntimeClusterMembers,
  clusterZoomBucket,
  getRuntimeClusterMembers,
  isClusterExpandable,
  parseDonutImageId,
  type ClusterBubbleProps,
} from '@/lib/data-link/point-clusters'

export interface RuntimeClusterIds {
  source: string
  bubble: string
  count: string
}

export function runtimeClusterIds(configId: number): RuntimeClusterIds {
  return {
    source: `dl-${configId}-rc-src`,
    bubble: `dl-${configId}-rc-cluster`,
    count: `dl-${configId}-rc-cluster-count`,
  }
}

/**
 * The zoom bucket clustering runs at (`clusterZoomBucket`), updated only on
 * `moveend` and only when it changed — never per frame. No listener while
 * inactive.
 */
export function useClusterZoomBucket(map: MapboxMapInstance | null, active: boolean): number {
  const [state, setState] = useState(() => ({ active, bucket: map ? clusterZoomBucket(map.getZoom()) : 0 }))
  // Turning on: start from where the camera is now.
  if (state.active !== active) {
    setState({ active, bucket: active && map ? clusterZoomBucket(map.getZoom()) : state.bucket })
  }
  useEffect(() => {
    if (!map || !active) return
    const onMoveEnd = () => {
      const bucket = clusterZoomBucket(map.getZoom())
      setState((s) => (s.bucket === bucket ? s : { ...s, bucket }))
    }
    map.on('moveend', onMoveEnd)
    return () => {
      map.off('moveend', onMoveEnd)
    }
  }, [map, active])
  return state.bucket
}

export interface DlClusterLayerHandle {
  /** Make the bubble source hold exactly these bubbles (queued until installed). */
  write: (bubbles: readonly GeoJSON.Feature<GeoJSON.Point, ClusterBubbleProps>[]) => void
}

type TFn = ReturnType<typeof useTranslation>['t']

interface HoverContext {
  colorNames: ReadonlyMap<string, string>
  field?: string
  t: TFn
}

const Z_OFFSET: mapboxgl.ExpressionSpecification = ['coalesce', ['get', 'elevation'], 0]
const COUNT_FONT = ['DIN Offc Pro Medium', 'Arial Unicode MS Bold']
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
const PIXEL_RATIO = 2

/** Donut ids this page added, per map (redrawn on a theme change). */
const donutIds = new WeakMap<MapboxMapInstance, Set<string>>()

function mapAlive(map: MapboxMapInstance): boolean {
  const m = map as unknown as { style?: unknown; _removed?: boolean }
  return Boolean(m.style) && !m._removed
}

function foregroundHex(): string {
  return readThemeTokenHex('foreground', '#18181b')
}

/** The donut for an image id, as RGBA at PIXEL_RATIO. */
function drawDonut(id: string): ImageData | null {
  const spec = parseDonutImageId(id)
  if (!spec || typeof document === 'undefined') return null
  const r = spec.radiusPx
  const size = (r + 1) * 2
  const canvas = document.createElement('canvas')
  canvas.width = size * PIXEL_RATIO
  canvas.height = size * PIXEL_RATIO
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO)
  const c = size / 2
  // Disc: the theme's card, a 1 px border-token outline.
  ctx.beginPath()
  ctx.arc(c, c, r - 0.5, 0, Math.PI * 2)
  ctx.fillStyle = readThemeTokenHex('card', '#ffffff')
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = readThemeTokenHex('border', '#e4e4e7')
  ctx.stroke()
  // Ring: 3 px of colour segments from 12 o'clock, clockwise.
  const total = spec.segments.reduce((s, g) => s + g.units, 0)
  if (total > 0) {
    const ringR = r - 3
    const gap = spec.segments.length > 1 ? 1 / ringR : 0
    let start = -Math.PI / 2
    ctx.lineWidth = 3
    ctx.lineCap = 'butt'
    for (const seg of spec.segments) {
      const sweep = (Math.PI * 2 * seg.units) / total
      const a0 = start + gap / 2
      const a1 = start + sweep - gap / 2
      if (a1 > a0) {
        ctx.beginPath()
        ctx.arc(c, c, ringR, a0, a1)
        ctx.strokeStyle = seg.color
        ctx.stroke()
      }
      start += sweep
    }
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

const bubbleKey = (f: GeoJSON.Feature): string => String(f.properties?.clusterKey ?? '')

/**
 * One config's bubble source + layers + hover popup. Plain object (not
 * React state): the hook below drives it from effects only.
 */
class RuntimeClusterLayer implements DlClusterLayerHandle {
  readonly ids: RuntimeClusterIds
  private readonly map: MapboxMapInstance
  private readonly configId: number
  private readonly writer: GeoJSONDiffWriter
  private readonly hoverLayers: string[]
  private installed = false
  private visible = true
  private latest: readonly GeoJSON.Feature<GeoJSON.Point, ClusterBubbleProps>[] = []
  private waitingForMoveEnd = false
  private hover: HoverContext | null = null
  private popup: mapboxgl.Popup | null = null
  private popupFor: string | null = null

  constructor(map: MapboxMapInstance, configId: number) {
    this.map = map
    this.configId = configId
    this.ids = runtimeClusterIds(configId)
    this.writer = createGeoJSONDiffWriter(map, this.ids.source)
    this.hoverLayers = [this.ids.bubble, this.ids.count]
  }

  setHoverContext(ctx: HoverContext): void {
    this.hover = ctx
  }

  write = (bubbles: readonly GeoJSON.Feature<GeoJSON.Point, ClusterBubbleProps>[]): void => {
    this.latest = bubbles
    this.flush()
  }

  private flush(): void {
    if (!this.installed || !mapAlive(this.map)) return
    if (isFocusFlying(this.map)) {
      if (!this.waitingForMoveEnd) {
        this.waitingForMoveEnd = true
        this.map.once('moveend', this.onMoveEnd)
      }
      return
    }
    this.writer.write(this.latest, bubbleKey)
  }

  private onMoveEnd = (): void => {
    this.waitingForMoveEnd = false
    this.flush()
  }

  install(): void {
    const { map, ids } = this
    if (map.getSource(ids.source)) this.removeLayers()
    map.addSource(ids.source, { type: 'geojson', data: EMPTY_FC })
    const visibility = this.visible ? 'visible' : 'none'
    map.addLayer({
      id: ids.bubble,
      type: 'symbol',
      source: ids.source,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-z-elevate': false,
        visibility,
      },
      paint: {
        'symbol-z-offset': Z_OFFSET,
        'icon-occlusion-opacity': 0,
      },
    })
    map.addLayer({
      id: ids.count,
      type: 'symbol',
      source: ids.source,
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': COUNT_FONT,
        'text-size': 9,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'symbol-z-elevate': false,
        visibility,
      },
      paint: {
        'text-color': foregroundHex(),
        'symbol-z-offset': Z_OFFSET,
        'text-occlusion-opacity': 0,
      },
    })
    map.off('mousemove', this.hoverLayers, this.onHover)
    map.off('mouseleave', this.hoverLayers, this.onLeave)
    map.on('mousemove', this.hoverLayers, this.onHover)
    map.on('mouseleave', this.hoverLayers, this.onLeave)
    this.installed = true
    try {
      raiseDataLinkLayers(map)
    } catch { /* style not ready — the container's styledata pass catches up */ }
    // A fresh source (first install or a style swap): write what we hold.
    this.flush()
  }

  /** Make a donut image the style asked for. */
  onImageMissing = (e: { id?: string }): void => {
    const id = e.id
    if (!id || !id.startsWith(DONUT_IMAGE_PREFIX)) return
    if (this.map.hasImage(id)) return
    const img = drawDonut(id)
    if (!img) return
    this.map.addImage(id, img, { pixelRatio: PIXEL_RATIO })
    let set = donutIds.get(this.map)
    if (!set) donutIds.set(this.map, (set = new Set()))
    set.add(id)
  }

  /** Theme change: redraw every donut still on the map, re-colour the count. */
  retheme = (): void => {
    const { map } = this
    if (!mapAlive(map)) return
    try {
      const set = donutIds.get(map)
      if (set) {
        for (const id of set) {
          if (!map.hasImage(id)) {
            set.delete(id)
            continue
          }
          const img = drawDonut(id)
          if (!img) continue
          // Re-add, not `updateImage`: GL 3.25 patches an updated image into
          // the tile atlas only on a frame where the style isn't dirty
          // (`Style.update` clears the updated set before the painter runs),
          // and a theme change dirties the style in that very frame (every
          // overlay re-colours). A re-add re-lays out just the tiles that use
          // the id.
          map.removeImage(id)
          map.addImage(id, img, { pixelRatio: PIXEL_RATIO })
        }
      }
      if (hasMapLayer(map, this.ids.count)) map.setPaintProperty(this.ids.count, 'text-color', foregroundHex())
    } catch { /* style mid-swap */ }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (!this.installed || !mapAlive(this.map)) return
    const value = visible ? 'visible' : 'none'
    for (const id of this.hoverLayers) {
      if (hasMapLayer(this.map, id)) this.map.setLayoutProperty(id, 'visibility', value)
    }
    if (!visible) this.closePopup()
  }

  private onHover = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.GeoJSONFeature[] }): void => {
    const f = e.features?.[0]
    const props = f?.properties as Partial<ClusterBubbleProps> | undefined
    const key = typeof props?.clusterKey === 'string' ? props.clusterKey : null
    if (!f || !props || !key || !this.hover) return
    this.map.getCanvas().style.cursor = 'pointer'
    const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number]
    if (!this.popup) {
      const radius = typeof props.icon === 'string' ? parseDonutImageId(props.icon)?.radiusPx ?? 14 : 14
      this.popup = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: radius + 6,
        className: 'bin-hover-popup dl-hover-popup',
        maxWidth: '280px',
      })
    }
    if (this.popupFor !== key) {
      this.popupFor = key
      this.popup.setDOMContent(this.popupContent(props, key))
    }
    this.popup.setLngLat(coords)
    if (!this.popup.isOpen()) this.popup.addTo(this.map)
  }

  private onLeave = (): void => {
    this.map.getCanvas().style.cursor = ''
    this.closePopup()
  }

  private closePopup(): void {
    this.popup?.remove()
    this.popup = null
    this.popupFor = null
  }

  /** Built with textContent only: room names and values are user data. */
  private popupContent(props: Partial<ClusterBubbleProps>, key: string): HTMLElement {
    const { t, colorNames, field } = this.hover!
    const count = Number(props.point_count ?? 0)
    const root = document.createElement('div')
    root.className = 'min-w-[10rem] px-2.5 py-2 text-xs'
    const title = document.createElement('div')
    title.className = 'font-medium text-foreground'
    const label = typeof props.label === 'string' ? props.label : ''
    title.textContent =
      props.labelKind === 'room' && label
        ? `${label} · ${t('reports.cluster.items', { count, defaultValue: '{{count}} items' })}`
        : props.labelKind === 'field'
          ? `${t('reports.cluster.fieldValue', {
              field: field ?? '',
              value: label || t('reports.cluster.emptyValue', { defaultValue: '(empty)' }),
              defaultValue: '{{field}}: {{value}}',
            })} · ${t('reports.cluster.items', { count, defaultValue: '{{count}} items' })}`
          : t('reports.cluster.items', { count, defaultValue: '{{count}} items' })
    root.appendChild(title)
    const list = document.createElement('div')
    list.className = 'mt-1.5 space-y-1'
    for (const part of String(props.breakdown ?? '').split(',')) {
      if (!part) continue
      const colon = part.lastIndexOf(':')
      if (colon <= 0) continue
      const tok = part.slice(0, colon)
      const n = part.slice(colon + 1)
      const row = document.createElement('div')
      row.className = 'flex items-center gap-2'
      const swatch = document.createElement('span')
      swatch.className = 'h-2.5 w-2.5 shrink-0 rounded-full'
      swatch.style.background = /^[0-9a-f]{6}$/.test(tok) ? `#${tok}` : safeDecode(tok)
      const name = document.createElement('span')
      name.className = 'min-w-0 flex-1 truncate text-muted-foreground'
      name.textContent = colorNames.get(tok) ?? t('reports.cluster.defaultColor', { defaultValue: 'Default' })
      const num = document.createElement('span')
      num.className = 'tabular-nums text-foreground'
      num.textContent = n
      row.append(swatch, name, num)
      list.appendChild(row)
    }
    root.appendChild(list)
    const members = getRuntimeClusterMembers(this.configId, key)
    const hint = document.createElement('div')
    hint.className = 'mt-1.5 text-[11px] text-muted-foreground'
    hint.textContent =
      members && isClusterExpandable(members)
        ? t('reports.cluster.zoomHint', { defaultValue: 'Click to zoom in' })
        : t('reports.cluster.listHint', { defaultValue: 'Click to list these items' })
    root.appendChild(hint)
    return root
  }

  private removeLayers(): void {
    const { map, ids } = this
    for (const id of [ids.count, ids.bubble]) {
      if (hasMapLayer(map, id)) map.removeLayer(id)
    }
    if (map.getSource(ids.source)) map.removeSource(ids.source)
  }

  /** Disable / unmount: layers, source, popup, listeners, members. */
  teardown(): void {
    const { map } = this
    this.installed = false
    this.latest = []
    this.writer.dispose()
    this.closePopup()
    clearRuntimeClusterMembers(this.configId)
    if (this.waitingForMoveEnd) {
      map.off('moveend', this.onMoveEnd)
      this.waitingForMoveEnd = false
    }
    if (!mapAlive(map)) return
    try {
      map.off('mousemove', this.hoverLayers, this.onHover)
      map.off('mouseleave', this.hoverLayers, this.onLeave)
      map.getCanvas().style.cursor = ''
      this.removeLayers()
    } catch { /* style swapping — nothing left to remove */ }
  }
}

function safeDecode(tok: string): string {
  try {
    return decodeURIComponent(tok)
  } catch {
    return tok
  }
}

const NO_CONFIG = -1

/**
 * The bubble layer of one config while `enabled`. The handle is stable for
 * the map + config; writes made before the install land once it is in.
 */
export function useDlClusterLayer(
  map: MapboxMapInstance,
  configId: number | undefined,
  opts: { enabled: boolean; visible: boolean; colorNames: ReadonlyMap<string, string>; field?: string },
): DlClusterLayerHandle {
  const { t } = useTranslation()
  const { enabled, visible, colorNames, field } = opts
  const layer = useMemo(() => new RuntimeClusterLayer(map, configId ?? NO_CONFIG), [map, configId])

  useEffect(() => {
    layer.setHoverContext({ colorNames, field, t })
  }, [layer, colorNames, field, t])

  useEffect(() => {
    if (!enabled || configId === undefined) return
    map.on('styleimagemissing', layer.onImageMissing)
    const detach = whenStyleLoaded(map, () => layer.install(), `[map-dl-cluster:${configId}]`)
    const offTheme = subscribeThemeChanges(layer.retheme)
    return () => {
      detach()
      offTheme()
      map.off('styleimagemissing', layer.onImageMissing)
      layer.teardown()
    }
  }, [map, layer, enabled, configId])

  useEffect(() => {
    if (enabled) layer.setVisible(visible)
  }, [layer, enabled, visible])

  return layer
}
