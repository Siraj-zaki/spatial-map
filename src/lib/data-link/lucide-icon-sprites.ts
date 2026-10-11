/**
 * Lucide → Mapbox icon sprite loader.
 *
 * The data-link editor lets users pick ANY Lucide icon (~1714 icons via
 * `lucide-react`). Mapbox's `symbol` layer draws icons via `icon-image`
 * — but the image must be registered on the map instance first with
 * `addImage(name, data)`. This module bridges the two: on demand, it
 * turns a Lucide React component into an SVG string, rasterises it to
 * a canvas, and hands the bitmap to Mapbox. Results are memoised per
 * map instance so subsequent renders (style swap, HMR) don't re-do
 * the work.
 *
 * Since v2 the sprite loader is DEMAND-DRIVEN — callers pass the icon
 * ids their configs actually use and only those get rasterised. The
 * legacy `ensureDataLinkSprites(map)` (no ids) still works for tests /
 * the 18 curated defaults, but modern callers should prefer
 * `ensureDataLinkSpritesFor(map, ids, opts)`.
 *
 * Icon names on the map are prefixed with `dl-icon-` so they can't
 * collide with the basemap's built-in Maki sprites. Coloured variants
 * (icon-color driven from DataLinkConfig) get a `-#hexhex` suffix so
 * every colour combination has its own sprite entry.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { Map as MapboxMapInstance } from 'mapbox-gl'
// lucide-react is ~200 KB gzipped — heavy. We dynamic-import the icon
// resolver only when a sub-renderer actually needs to rasterise a
// sprite, so the main app bundle stays lean. See DESIGN-data-link-v2.md
// (Bundle size follow-up).
type IconComponentForId = (id: string) =>
  | React.ComponentType<React.SVGProps<SVGSVGElement> & { size?: number | string; color?: string }>
  | null

let _iconResolverPromise: Promise<IconComponentForId> | null = null
function loadIconResolver(): Promise<IconComponentForId> {
  if (!_iconResolverPromise) {
    _iconResolverPromise = import('@/components/data-link/lucide-icon-picker').then(
      (mod) => mod.iconComponentForId as IconComponentForId,
    )
  }
  return _iconResolverPromise
}

/**
 * Curated 18-icon set kept for backwards compat + fast smoke tests.
 * New callers should just pass their concrete icon-id list; the
 * bundled set no longer limits what users can select.
 */
const LEGACY_DEFAULT_ICON_IDS = [
  'map-pin', 'circle', 'square', 'triangle', 'star', 'flag',
  'truck', 'package', 'forklift', 'user', 'camera', 'activity',
  'zap', 'thermometer', 'wifi', 'radio', 'shield', 'alert-circle',
] as const

/** Kept exported so nothing importing this constant breaks. */
export type DataLinkIconId = string
export const DATA_LINK_ICON_IDS: readonly string[] = LEGACY_DEFAULT_ICON_IDS

const IMAGE_NAME_PREFIX = 'dl-icon-'
const DEFAULT_STROKE = '#111827'

/**
 * Compute the mapbox image id for an icon. When `color` is supplied,
 * the stroke colour is baked into the sprite name so multiple configs
 * can request the same icon in different colours without stomping on
 * each other's bitmap.
 *
 * Both forms are valid inputs to `map.hasImage()` / `icon-image`.
 */
export function mapboxImageIdFor(iconId: string, color?: string): string {
  const c = normalizeColorForKey(color)
  return c
    ? `${IMAGE_NAME_PREFIX}${iconId}-${c}`
    : `${IMAGE_NAME_PREFIX}${iconId}`
}

function normalizeColorForKey(color: string | undefined): string {
  if (!color) return ''
  return color.replace(/^#/, '').toLowerCase()
}

/** Per-map cache of installed sprite names. */
const installedFor = new WeakMap<MapboxMapInstance, Set<string>>()

export interface EnsureSpritesOptions {
  /** Icon color (hex). Baked into the SVG's stroke + fill. Defaults to slate-900. */
  color?: string
  /** Bitmap resolution — 48 = retina-quality on a 24×24 base. */
  size?: number
}

/**
 * Ensure `iconIds` are registered on the map at the requested color.
 * Idempotent per (mapInstance, imageName). Individual failures log a
 * warning but don't reject the promise — a missing sprite manifests as
 * a missing-image warning from Mapbox but never crashes the overlay.
 */
export async function ensureDataLinkSpritesFor(
  map: MapboxMapInstance,
  iconIds: readonly string[],
  opts: EnsureSpritesOptions = {},
): Promise<void> {
  let already = installedFor.get(map)
  if (!already) {
    already = new Set()
    installedFor.set(map, already)
  }
  const color = opts.color ?? DEFAULT_STROKE
  const size = opts.size ?? 48
  const toLoad: string[] = []
  for (const id of iconIds) {
    const name = mapboxImageIdFor(id, color)
    if (map.hasImage(name)) {
      // Cache hit AND image is actually on the map — no need to reload.
      already!.add(name)
      continue
    }
    // Cache says we loaded it but map lost it (style swap via setStyle
    // drops all images). Invalidate the stale entry so we re-register.
    if (already!.has(name)) {
      already!.delete(name)
    }
    toLoad.push(id)
  }
  if (toLoad.length === 0) return

  await Promise.all(
    toLoad.map(async (id) => {
      try {
        const bitmap = await rasterizeLucide(id, color, size)
        const name = mapboxImageIdFor(id, color)
        if (!map.hasImage(name)) {
          map.addImage(name, bitmap, { pixelRatio: 2 })
        }
        already!.add(name)
      } catch (err) {
        console.warn('[data-link] failed to load icon', id, err)
      }
    }),
  )
}

/**
 * Legacy signature — installs the 18-icon curated set at the default
 * slate-900 stroke. Preserved so existing callers keep compiling.
 */
export function ensureDataLinkSprites(map: MapboxMapInstance): Promise<void> {
  return ensureDataLinkSpritesFor(map, LEGACY_DEFAULT_ICON_IDS)
}

// -------------------------------------------------------- rasteriser

/**
 * Render a Lucide React component to an SVG string, then rasterise
 * that SVG to a 48×48 RGBA bitmap Mapbox can consume via addImage.
 *
 * The component is invoked with `color` + `strokeWidth` props so
 * icon-color changes from the DataLinkConfig show up in the bitmap.
 */
async function rasterizeLucide(
  id: string,
  color: string,
  size: number,
): Promise<{ width: number; height: number; data: Uint8Array }> {
  const resolver = await loadIconResolver()
  const IconComponent = resolver(id)
  if (!IconComponent) throw new Error(`no Lucide icon "${id}"`)

  // React → SVG string. Lucide components accept color + strokeWidth as
  // regular props and paint every stroke/fill accordingly.
  const svgString = renderToStaticMarkup(
    // Lucide's default viewBox is 24×24; we set width/height to the
    // rasterisation size so the Image element loads at that resolution.
    createElement(IconComponent, {
      width: size,
      height: size,
      color,
      strokeWidth: 2,
    } as Record<string, unknown>),
  )
  if (!svgString || !svgString.includes('<svg')) {
    throw new Error(`empty svg for ${id}`)
  }

  const blob = new Blob([svgString], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.width = size
    img.height = size
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error(`img load failed for ${id}`))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d ctx unavailable')
    ctx.drawImage(img, 0, 0, size, size)
    const imageData = ctx.getImageData(0, 0, size, size)
    return {
      width: size,
      height: size,
      data: new Uint8Array(imageData.data.buffer),
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}
