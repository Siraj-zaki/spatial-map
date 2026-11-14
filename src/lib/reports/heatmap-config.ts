/**
 * The viewer's heatmap choice for a facility map (report map view and the
 * facility viewer) — see `map-dl-heatmap-overlay.tsx` for the layer.
 *
 * - `?heatmap=on|only` (absent = off), `&heatmapWeight=<numeric field>`
 *   (absent = count), `&heatmapLayer=<data-link id>[,<id>…]` (the heated
 *   point layers; absent = the host's default — a report's open tab, the
 *   viewer's first point layer). replaceState, never a history entry; only
 *   these params are touched. Off clears all three.
 * - Several layers: each is its own heat in one theme chart colour
 *   (`--chart-1…6`, by the layer's place in the host's list, so ticking
 *   another layer never recolours the others). One layer keeps the
 *   blue → red ramp. A weight applies only to a single layer.
 * - Mutually exclusive with runtime clustering: the hosts switch one off
 *   when the other goes on.
 */

import type { PointHeatmapSpec } from '@/components/map-dl-heatmap-overlay'

export type HeatmapMode = 'off' | 'on' | 'only'

export interface HeatmapSetting {
  mode: HeatmapMode
  weightField?: string
  /** Chosen layers; unset = the host's default layer. */
  layerIds?: number[]
}

export const HEATMAP_OFF: HeatmapSetting = { mode: 'off' }

/** Theme chart tokens for multi-layer heat, in list order. */
export const HEAT_TINTS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6'] as const

const P_MODE = 'heatmap'
const P_WEIGHT = 'heatmapWeight'
const P_LAYER = 'heatmapLayer'

export function readHeatmapFromURL(search: string = typeof window === 'undefined' ? '' : window.location.search): HeatmapSetting {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search)
  } catch {
    return HEATMAP_OFF
  }
  const mode = params.get(P_MODE)
  if (mode !== 'on' && mode !== 'only') return HEATMAP_OFF
  const weight = params.get(P_WEIGHT)?.trim()
  const layers = (params.get(P_LAYER) ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
  return {
    mode,
    ...(weight ? { weightField: weight } : {}),
    ...(layers.length ? { layerIds: [...new Set(layers)] } : {}),
  }
}

export function writeHeatmapToURL(h: HeatmapSetting): void {
  if (typeof window === 'undefined') return
  let url: URL
  try {
    url = new URL(window.location.href)
  } catch {
    return
  }
  const before = url.search
  if (h.mode === 'off') {
    url.searchParams.delete(P_MODE)
    url.searchParams.delete(P_WEIGHT)
    url.searchParams.delete(P_LAYER)
  } else {
    url.searchParams.set(P_MODE, h.mode)
    if (h.weightField) url.searchParams.set(P_WEIGHT, h.weightField)
    else url.searchParams.delete(P_WEIGHT)
    if (h.layerIds?.length) url.searchParams.set(P_LAYER, h.layerIds.join(','))
    else url.searchParams.delete(P_LAYER)
  }
  if (url.search === before) return
  window.history.replaceState(window.history.state, '', url)
}

/**
 * The heated layers: the chosen ones that are still on offer (in list
 * order), else the default. `available` = the host's point layers.
 */
export function resolveHeatLayers(h: HeatmapSetting, available: readonly number[], defaultId: number | undefined): number[] {
  const chosen = available.filter((id) => h.layerIds?.includes(id))
  if (chosen.length) return chosen
  const fallback = defaultId !== undefined && available.includes(defaultId) ? defaultId : available[0]
  return fallback === undefined ? [] : [fallback]
}

/** Layer id → its tint token, by place in `available` (stable as layers are ticked). */
export function heatTintOf(available: readonly number[], id: number): string {
  const i = Math.max(0, available.indexOf(id))
  return HEAT_TINTS[i % HEAT_TINTS.length]!
}

/** The overlay spec (null = off / no layer / blocked). Tints only with several layers. */
export function heatmapSpecFor(h: HeatmapSetting, layerIds: readonly number[], available: readonly number[], blocked: boolean): PointHeatmapSpec | null {
  if (h.mode === 'off' || layerIds.length === 0 || blocked) return null
  const several = layerIds.length > 1
  return {
    mode: h.mode,
    weightField: several ? null : h.weightField ?? null,
    configIds: new Set(layerIds),
    tints: several ? new Map(layerIds.map((id) => [id, heatTintOf(available, id)])) : null,
  }
}
