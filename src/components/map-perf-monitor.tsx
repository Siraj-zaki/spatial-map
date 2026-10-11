/**
 * Internal performance HUD for the map. Not part of the product surface:
 * English-only, renders nothing at all when closed. On by default in dev, off
 * by default in a production build; `?perf=1` / `?perf=0` overrides for one
 * load, and Ctrl+Alt+P toggles and remembers. Works in a production build,
 * which is the point — the machines we need numbers from aren't running a dev
 * server.
 *
 * Frame rate is sampled from the map's own `render` event rather than a bare
 * rAF loop: rAF keeps ticking at vsync while the map sits idle, which would
 * read as a confident 60fps while nothing is being drawn.
 *
 * GPU timing is opt-in because switching it on is not free — GL JS only issues
 * timer queries when something is subscribed (`gpuTiming: !!this.listens(...)`),
 * and each frame then costs a query plus a 50ms readback. Leaving it off by
 * default keeps the always-on panel from taxing the thing it measures.
 *
 * `gpu-timing-frame` carries both `cpuTime` and `gpuTime` measured over the same
 * `_render` call, which is why the CPU/GPU verdict compares those two rather
 * than GPU time against the frame interval — the interval also contains
 * compositing, unrelated JS, and vsync waiting, none of which are our render.
 *
 * We deliberately do NOT subscribe to `gpu-timing-layer`. See the pitfalls doc:
 * it is broken upstream in GL JS 3.25 and throws once per layer per frame.
 */
import mapboxgl from 'mapbox-gl'
import type { Map as MapboxMapInstance } from 'mapbox-gl'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface MapPerfMonitorProps {
  map: MapboxMapInstance
}

interface FrameStats {
  fps: number
  p50: number
  p95: number
  idle: boolean
}

interface SceneStats {
  layers: number
  hidden: number
  sources: number
}

/** Both halves of a `gpu-timing-frame` event, medianed over recent frames. */
interface RenderStats {
  cpuMs: number
  gpuMs: number
}

const IDLE_AFTER_MS = 600
const SAMPLE_LIMIT = 180
const FRAME_POLL_MS = 500
const SCENE_POLL_MS = 2000
const GPU_SAMPLE_LIMIT = 60
const HUD_STORAGE_KEY = 'sgv-perf-hud'

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

/**
 * Resolution order, most explicit first: `?perf=1` / `?perf=0` wins for the
 * current load, then whatever you last toggled on this machine, then on in dev
 * and off everywhere else. The stored preference is what makes it stick without
 * a query string, including on a production build — which is the case that
 * matters, since the slow machines run one.
 */
function initialHudState(): boolean {
  if (typeof window === 'undefined') return false
  const param = new URLSearchParams(window.location.search).get('perf')
  if (param === '1') return true
  if (param === '0') return false
  try {
    const stored = window.localStorage.getItem(HUD_STORAGE_KEY)
    if (stored !== null) return stored === '1'
  } catch {
    /* private mode / storage disabled — fall through to the build default */
  }
  return import.meta.env.DEV
}

function useHudEnabled(): [boolean, () => void] {
  const [enabled, setEnabled] = useState(initialHudState)
  const toggle = useCallback(() => {
    setEnabled((v) => {
      const next = !v
      try {
        window.localStorage.setItem(HUD_STORAGE_KEY, next ? '1' : '0')
      } catch {
        /* preference just won't survive the reload */
      }
      return next
    })
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])
  return [enabled, toggle]
}

function readHardware(map: MapboxMapInstance) {
  const canvas = map.getCanvas()
  let renderer = 'unavailable'
  try {
    const gl = canvas.getContext('webgl2')
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info')
    if (gl && dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
  } catch {
    /* some browsers withhold the renderer string for fingerprinting reasons */
  }
  return {
    renderer,
    dpr: window.devicePixelRatio,
    buffer: `${canvas.width}x${canvas.height}`,
    workers: mapboxgl.workerCount,
  }
}

type DebugFlag = 'overdraw' | 'tiles' | 'wireframe'

/** These are plain assignable properties on Map, not methods, and they are the
 *  only debug visualizations that survive into a production GL JS bundle. */
function applyDebugFlag(map: MapboxMapInstance, key: DebugFlag, value: boolean) {
  const target = map as unknown as Record<string, boolean>
  if (key === 'overdraw') target.showOverdrawInspector = value
  if (key === 'tiles') target.showTileBoundaries = value
  if (key === 'wireframe') target.showLayers3DWireframe = value
}

export function MapPerfMonitor({ map }: MapPerfMonitorProps) {
  const [enabled, toggle] = useHudEnabled()
  const [gpuOn, setGpuOn] = useState(false)
  const [frame, setFrame] = useState<FrameStats>({ fps: 0, p50: 0, p95: 0, idle: true })
  const [scene, setScene] = useState<SceneStats>({ layers: 0, hidden: 0, sources: 0 })
  const [features, setFeatures] = useState<number | null>(null)
  const [render, setRender] = useState<RenderStats | null>(null)
  const [debugFlags, setDebugFlags] = useState({ overdraw: false, tiles: false, wireframe: false })

  const samplesRef = useRef<number[]>([])
  const lastRenderRef = useRef(0)

  const hardware = useMemo(() => (enabled ? readHardware(map) : null), [enabled, map])

  useEffect(() => {
    if (!enabled) return
    const onRender = () => {
      const now = performance.now()
      const prev = lastRenderRef.current
      lastRenderRef.current = now
      if (prev === 0) return
      const dt = now - prev
      // A gap this long means the map went idle and came back; that interval
      // describes the pause, not the cost of a frame.
      if (dt > IDLE_AFTER_MS) return
      const samples = samplesRef.current
      samples.push(dt)
      if (samples.length > SAMPLE_LIMIT) samples.shift()
    }
    map.on('render', onRender)
    return () => {
      map.off('render', onRender)
    }
  }, [enabled, map])

  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => {
      const samples = samplesRef.current
      const idle = performance.now() - lastRenderRef.current > IDLE_AFTER_MS
      if (samples.length === 0) {
        setFrame({ fps: 0, p50: 0, p95: 0, idle })
        return
      }
      const sorted = [...samples].sort((a, b) => a - b)
      const p50 = percentile(sorted, 50)
      setFrame({ fps: p50 > 0 ? Math.round(1000 / p50) : 0, p50, p95: percentile(sorted, 95), idle })
    }, FRAME_POLL_MS)
    return () => window.clearInterval(id)
  }, [enabled, map])

  // Scene stats poll far slower than the frame stats: `getStyle()` serializes
  // every layer, so at 500ms it would show up in the numbers it is reporting.
  // It also throws before the style has parsed, hence the guard.
  useEffect(() => {
    if (!enabled) return
    const read = () => {
      if (!map.isStyleLoaded()) return
      const style = map.getStyle()
      const layers = style?.layers ?? []
      let hidden = 0
      for (const layer of layers) {
        if (map.getLayoutProperty(layer.id, 'visibility') === 'none') hidden++
      }
      setScene({ layers: layers.length, hidden, sources: Object.keys(style?.sources ?? {}).length })
    }
    read()
    const id = window.setInterval(read, SCENE_POLL_MS)
    return () => window.clearInterval(id)
  }, [enabled, map])

  useEffect(() => {
    if (!enabled || !gpuOn) return
    const evented = map as unknown as {
      on: (type: string, cb: (e: unknown) => void) => void
      off: (type: string, cb: (e: unknown) => void) => void
    }
    const cpu: number[] = []
    const gpu: number[] = []
    let pending: RenderStats | null = null
    const onFrame = (e: unknown) => {
      const { cpuTime, gpuTime } = e as { cpuTime: number; gpuTime: number }
      cpu.push(cpuTime)
      gpu.push(gpuTime)
      if (cpu.length > GPU_SAMPLE_LIMIT) { cpu.shift(); gpu.shift() }
      pending = {
        cpuMs: percentile([...cpu].sort((a, b) => a - b), 50),
        gpuMs: percentile([...gpu].sort((a, b) => a - b), 50),
      }
    }
    evented.on('gpu-timing-frame', onFrame)
    // The event fires from a 50ms setTimeout per frame, so committing state in
    // the handler would re-render the panel dozens of times a second.
    const id = window.setInterval(() => {
      if (pending) setRender(pending)
    }, FRAME_POLL_MS)
    // GL JS decides whether to issue timer queries when it sets up the frame,
    // so nothing is measured until the next paint after we subscribe.
    map.triggerRepaint()
    return () => {
      evented.off('gpu-timing-frame', onFrame)
      window.clearInterval(id)
    }
  }, [enabled, gpuOn, map])

  const toggleGpu = useCallback((value: boolean) => {
    setGpuOn(value)
    if (!value) setRender(null)
  }, [])

  const setDebugFlag = useCallback(
    (key: DebugFlag, value: boolean) => {
      setDebugFlags((prev) => ({ ...prev, [key]: value }))
      applyDebugFlag(map, key, value)
    },
    [map],
  )

  const countFeatures = useCallback(() => {
    const canvas = map.getCanvas()
    const rect = canvas.getBoundingClientRect()
    setFeatures(
      map.queryRenderedFeatures([
        [0, 0],
        [Math.round(rect.width), Math.round(rect.height)],
      ]).length,
    )
  }, [map])

  if (!enabled) return null

  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory

  return createPortal(
    <div
      dir="ltr"
      data-testid="map-perf-monitor"
      className="fixed z-50 font-mono text-[11px] leading-tight border rounded-md shadow-lg pointer-events-auto select-none bottom-4 right-4 w-72 bg-card/95 text-card-foreground border-border backdrop-blur-sm"
    >
      <div className="flex items-center justify-between px-2 py-1 border-b border-border">
        <span className="font-semibold tracking-wide">MAP PERF</span>
        <button type="button" onClick={toggle} className="px-1 rounded hover:bg-muted" aria-label="Close">
          x
        </button>
      </div>

      <div className="px-2 py-1 space-y-0.5 border-b border-border">
        {frame.idle ? (
          <div className="text-muted-foreground">idle — pan or zoom to sample</div>
        ) : (
          <div>
            <span className="font-semibold">{frame.fps} fps</span>
            <span className="ms-2 text-muted-foreground">
              p50 {frame.p50.toFixed(1)} p95 {frame.p95.toFixed(1)} ms
            </span>
          </div>
        )}
        {render && (
          <>
            <div>
              render cpu {render.cpuMs.toFixed(2)} · gpu {render.gpuMs.toFixed(2)} ms
            </div>
            <div className="font-semibold">
              {render.gpuMs > render.cpuMs ? 'GPU-BOUND' : 'CPU-BOUND'}
              <span className="ms-1 font-normal text-muted-foreground">
                (of {(render.cpuMs + render.gpuMs).toFixed(1)}ms, gpu{' '}
                {Math.round((render.gpuMs / (render.cpuMs + render.gpuMs)) * 100)}%)
              </span>
            </div>
          </>
        )}
        {gpuOn && !render && <div className="text-muted-foreground">gpu timing — pan to sample</div>}
      </div>

      <div className="px-2 py-1 space-y-0.5 border-b border-border text-muted-foreground">
        <div>
          layers {scene.layers} · hidden {scene.hidden} · sources {scene.sources}
        </div>
        <div className="flex items-center gap-2">
          <span>features {features ?? '—'}</span>
          <button type="button" onClick={countFeatures} className="px-1 rounded hover:bg-muted text-foreground">
            count
          </button>
        </div>
        {hardware && (
          <>
            <div className="truncate" title={hardware.renderer}>
              {hardware.renderer}
            </div>
            <div>
              dpr {hardware.dpr} · {hardware.buffer} · workers {hardware.workers}
            </div>
          </>
        )}
        {heap && (
          <div>
            heap {Math.round(heap.usedJSHeapSize / 1048576)}/{Math.round(heap.jsHeapSizeLimit / 1048576)} MB
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 px-2 py-1">
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={gpuOn} onChange={(e) => toggleGpu(e.target.checked)} />
          GPU timing
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={debugFlags.overdraw}
            onChange={(e) => setDebugFlag('overdraw', e.target.checked)}
          />
          overdraw
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={debugFlags.tiles} onChange={(e) => setDebugFlag('tiles', e.target.checked)} />
          tiles
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={debugFlags.wireframe}
            onChange={(e) => setDebugFlag('wireframe', e.target.checked)}
          />
          wireframe
        </label>
      </div>
    </div>,
    document.body,
  )
}
