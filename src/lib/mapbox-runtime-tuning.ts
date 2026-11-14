/**
 * Runtime tuning for Mapbox GL JS that the `Map` constructor doesn't expose.
 *
 * The first two tweaks change *which hardware* and *how many threads* GL JS
 * is allowed to use. The last two cut main-thread work that GL JS repeats
 * every frame: a redundant `loaded()` walk per marker, and per-tile
 * bookkeeping for tiles that can't hold data (see `mapbox-tile-cover.ts`).
 * None of them changes what is drawn — there is no styling, geometry or
 * interaction surface here.
 *
 * Must run before the first `new mapboxgl.Map(...)`: the GL context is created
 * inside the constructor and the worker pool is sized on first acquire, so
 * neither can be changed after a map exists.
 */
import mapboxgl from 'mapbox-gl'
import { installTileCoverTuning } from '@/lib/mapbox-tile-cover'

const TUNED_KEY = '__sgvMapboxRuntimeTuned'

/**
 * GL JS builds its WebGL2 context attributes from a fixed set — `antialias`,
 * `alpha`, `stencil`, `depth`, `failIfMajorPerformanceCaveat`,
 * `preserveDrawingBuffer` — with no `powerPreference` (the string does not
 * appear anywhere in the shipped bundle). Without that hint the browser hands
 * back the default adapter, which on a hybrid-graphics Windows laptop is
 * normally the integrated GPU rather than the discrete one.
 *
 * Patching `getContext` is the only injection point, since GL JS owns the
 * canvas. The hint is advisory: a driver or OS policy that ignores it just
 * leaves us on the adapter we would have gotten anyway. Left installed rather
 * than scoped to construction because GL JS re-runs `_setupPainter` after a
 * context-loss/restore cycle.
 */
function preferHighPerformanceGpu(): void {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (this: HTMLCanvasElement, id: string, attrs?: unknown) => unknown
  }
  const original = proto.getContext
  proto.getContext = function (id, attrs) {
    if (id !== 'webgl2' && id !== 'webgl') return original.call(this, id, attrs)
    const existing = (attrs ?? {}) as Record<string, unknown>
    if (existing.powerPreference !== undefined) return original.call(this, id, attrs)
    return original.call(this, id, { ...existing, powerPreference: 'high-performance' })
  }
}

/**
 * `WorkerPool.workerCount` is hardcoded to 2 and is never derived from
 * `navigator.hardwareConcurrency`. Every `GeoJSONSource` pins itself to one
 * actor round-robin in its constructor, so with the stock setting all of our
 * ~100+ sources parse and tessellate on exactly two threads no matter how many
 * cores the machine has. Widening the pool spreads that work out — it matters
 * most on cold load, floor switches and bulk edits, when many sources call
 * `setData` at once.
 *
 * Three quarters of the reported cores, floored at the stock 2 so we can never
 * make a low-core machine worse, and capped at 8 because each worker is a
 * thread with its own heap and the returns flatten well before then. The
 * remaining quarter is headroom for the main thread (render + React) and the
 * browser's own threads.
 */
function widenWorkerPool(): void {
  const cores = navigator.hardwareConcurrency
  if (!cores) return
  mapboxgl.workerCount = Math.max(2, Math.min(8, Math.floor(cores * 0.75)))
}

/**
 * `Map._requestDomTask` decides whether a marker / popup / scale-control DOM
 * update runs now or waits for the next frame:
 *
 *     !this.loaded() || this.loaded() && !this.isMoving() ? task() : queue(task)
 *
 * That is `!isMoving() || !loaded()`, but evaluated so that `loaded()` runs
 * first and, when it's true, runs twice. `Map.loaded()` falls through to
 * `Style.loaded()`, which walks every source cache and every one of their
 * tiles. `_render` calls `_forceMarkerAndPopupUpdate()` on every frame where
 * the map is not moving (hover, selection, live-data repaints), and that
 * reaches this check once per marker. In the editor that is 194 markers ×
 * ~200 sources per frame: `Style.loaded` was the top self-time function of
 * the hover/click profile (10.9 %).
 *
 * Both getters are pure, so asking `isMoving()` first is exactly equivalent
 * and skips `loaded()` entirely whenever the map is still. While it moves,
 * `loaded()` runs once instead of up to twice.
 *
 * Replaced only when the stock method has exactly the audited body, so a GL
 * JS upgrade that changes it keeps its own version.
 */
function cheaperDomTaskCheck(): void {
  const proto = mapboxgl.Map.prototype as unknown as {
    _requestDomTask?: (this: DomTaskMap, task: () => void) => void
  }
  const original = proto._requestDomTask
  if (typeof original !== 'function') return
  const body = Function.prototype.toString.call(original).replace(/\s+/g, '')
  const audited =
    /^_requestDomTask\((\w+)\)\{!this\.loaded\(\)\|\|this\.loaded\(\)&&!this\.isMoving\(\)\?\1\(\):this\._domRenderTaskQueue\.add\(\1\);?\}$/
  if (!audited.test(body)) return
  proto._requestDomTask = function (this: DomTaskMap, task: () => void) {
    if (!this.isMoving() || !this.loaded()) task()
    else this._domRenderTaskQueue.add(task)
  }
}

interface DomTaskMap {
  isMoving(): boolean
  loaded(): boolean
  _domRenderTaskQueue: { add(task: () => void): unknown }
}

export function tuneMapboxRuntime(): void {
  const globals = globalThis as unknown as Record<string, boolean>
  if (globals[TUNED_KEY]) return
  globals[TUNED_KEY] = true
  preferHighPerformanceGpu()
  widenWorkerPool()
  cheaperDomTaskCheck()
  installTileCoverTuning(mapboxgl)
}
