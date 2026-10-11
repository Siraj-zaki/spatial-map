/**
 * Dev-only Mapbox mount diagnostics.
 *
 * Wraps `map.addSource / addLayer / removeSource / removeLayer` on a
 * Mapbox map instance and logs every call with grep-friendly `[map-diag]`
 * prefixes. Flags DUPLICATE mounts — the same source or layer id being
 * added twice without a matching remove in between — so we can spot
 * overlays that redundantly mount the same thing.
 *
 * Usage:
 *   installMapMountDiagnostics(map)
 * Call once per map instance, right after construction. No-op outside
 * `import.meta.env.DEV`.
 *
 * Log grammar:
 *   [map-diag] addSource   id=<id> mount#=N (prev-still-mounted=<bool>, elapsed=<ms>ms)
 *   [map-diag] addLayer    id=<id> source=<src> mount#=N (prev-still-mounted=<bool>, elapsed=<ms>ms)
 *   [map-diag] removeSource id=<id>
 *   [map-diag] removeLayer  id=<id>
 *   [map-diag] ⚠ DUPLICATE addSource id=<id> — still mounted from add #N (<ms>ms ago), no removeSource between
 *   [map-diag] ⚠ DUPLICATE addLayer  id=<id> — still mounted from add #N (<ms>ms ago), no removeLayer between
 */

import type { Map as MapboxMapInstance } from 'mapbox-gl'

interface MountRecord {
  addCount: number
  mounted: boolean
  lastAddAt: number
}

const INSTALLED = Symbol.for('sgv.map-mount-diagnostics.installed')

export function installMapMountDiagnostics(map: MapboxMapInstance): void {
  if (!import.meta.env.DEV) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyMap = map as any
  if (anyMap[INSTALLED]) return
  anyMap[INSTALLED] = true

  const sources = new Map<string, MountRecord>()
  const layers = new Map<string, MountRecord>()
  const t0 = performance.now()
  const now = () => Math.round(performance.now() - t0)

  const origAddSource = map.addSource.bind(map)
  const origAddLayer = map.addLayer.bind(map)
  const origRemoveSource = map.removeSource.bind(map)
  const origRemoveLayer = map.removeLayer.bind(map)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(map as any).addSource = ((id: string, spec: unknown) => {
    const rec = sources.get(id) ?? { addCount: 0, mounted: false, lastAddAt: -1 }
    const wasMounted = rec.mounted
    const elapsed = rec.lastAddAt < 0 ? -1 : now() - rec.lastAddAt
    rec.addCount += 1
    rec.mounted = true
    rec.lastAddAt = now()
    sources.set(id, rec)
    if (wasMounted) {
      console.warn(
        '[map-diag] ⚠ DUPLICATE addSource',
        'id=', id,
        `— still mounted from add #${rec.addCount - 1} (${elapsed}ms ago), no removeSource between`,
      )
    } else {
      console.debug(
        '[map-diag] addSource  ',
        'id=', id,
        `mount#=${rec.addCount}`,
        `(prev-still-mounted=false, elapsed=${elapsed}ms)`,
      )
    }
    return origAddSource(id, spec as never)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(map as any).addLayer = ((layerSpec: any, beforeId?: string) => {
    const id = layerSpec?.id ?? '<unknown>'
    const src = layerSpec?.source ?? '<none>'
    const rec = layers.get(id) ?? { addCount: 0, mounted: false, lastAddAt: -1 }
    const wasMounted = rec.mounted
    const elapsed = rec.lastAddAt < 0 ? -1 : now() - rec.lastAddAt
    rec.addCount += 1
    rec.mounted = true
    rec.lastAddAt = now()
    layers.set(id, rec)
    if (wasMounted) {
      console.warn(
        '[map-diag] ⚠ DUPLICATE addLayer ',
        'id=', id,
        'source=', src,
        `— still mounted from add #${rec.addCount - 1} (${elapsed}ms ago), no removeLayer between`,
      )
    } else {
      console.debug(
        '[map-diag] addLayer   ',
        'id=', id,
        'source=', src,
        `mount#=${rec.addCount}`,
        `(prev-still-mounted=false, elapsed=${elapsed}ms)`,
      )
    }
    return origAddLayer(layerSpec, beforeId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(map as any).removeSource = ((id: string) => {
    const rec = sources.get(id)
    if (rec) rec.mounted = false
    console.debug('[map-diag] removeSource', 'id=', id)
    return origRemoveSource(id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(map as any).removeLayer = ((id: string) => {
    const rec = layers.get(id)
    if (rec) rec.mounted = false
    console.debug('[map-diag] removeLayer ', 'id=', id)
    return origRemoveLayer(id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

  console.debug('[map-diag] installed on map instance')
}
