import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'

import { type Tool } from '@/lib/keyboard-shortcuts'
import { assistedPoint, distanceM, type DrawAssist, type LngLat } from '@/lib/measure/geometry'
import { unprojectAtAltitude } from '@/lib/unproject-at-altitude'

/** Screen distance for snapping onto a corner / closing the shape. */
const SNAP_PX = 10

/** Drop the repeated vertex a double-click leaves behind. */
function dedupe(vertices: LngLat[]): LngLat[] {
  const out: LngLat[] = []
  for (const v of vertices) {
    const last = out[out.length - 1]
    if (!last || distanceM(last, v) > 0.005) out.push(v)
  }
  return out
}

/**
 * Measure tool — a ruler that leaves guides behind. Click to add points;
 * the overlay shows every segment's length and the running total. Click
 * the first point again (3+ points) to close it into an area; double-
 * click or Enter keeps an open run. Either way the result is handed to
 * `onFinish` and stays on the map as a guide. Backspace removes the last
 * point; Esc cancels the run, a second Esc leaves the tool.
 *
 * Unlike the wall tool's hint-only snap, the cursor really lands on a
 * nearby corner (wall / room vertices, other guides) — a measurement
 * between two corners should read exactly corner to corner. The drafting
 * bar's angle lock applies when no corner is in reach.
 */
export function useMeasureTool({
  mapInstance,
  activeTool,
  elevation,
  drawAssistRef,
  snapTargetsRef,
  measureVerticesRef,
  setMeasureDraftVertices,
  setMeasureDraftCursor,
  setMeasureSnapped,
  onFinish,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  /** Altitude of the active floor, metres — clicks are cast onto it. */
  elevation: number
  drawAssistRef: MutableRefObject<DrawAssist>
  /** Corners the cursor snaps to. */
  snapTargetsRef: MutableRefObject<LngLat[]>
  measureVerticesRef: MutableRefObject<LngLat[]>
  setMeasureDraftVertices: Dispatch<SetStateAction<LngLat[]>>
  setMeasureDraftCursor: Dispatch<SetStateAction<LngLat | null>>
  setMeasureSnapped: Dispatch<SetStateAction<boolean>>
  onFinish: (vertices: LngLat[], closed: boolean) => void
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  useEffect(() => {
    if (!mapInstance) return
    if (activeTool !== 'measure') {
      setMeasureDraftVertices([])
      setMeasureDraftCursor(null)
      setMeasureSnapped(false)
      return
    }
    const map = mapInstance
    map.getCanvas().style.cursor = 'crosshair'

    const pxDist = (a: LngLat, b: { x: number; y: number }) => {
      const p = map.project(a)
      return Math.hypot(p.x - b.x, p.y - b.y)
    }

    /** Snapped corner if one is in reach, else the (angle-locked) cursor. */
    const resolve = (e: MapMouseEvent): { at: LngLat; snapped: boolean } => {
      const chain = measureVerticesRef.current
      let best: LngLat | null = null
      let bestPx = SNAP_PX
      for (const v of [...snapTargetsRef.current, ...chain.slice(0, -1)]) {
        const d = pxDist(v, e.point)
        if (d <= bestPx) {
          best = v
          bestPx = d
        }
      }
      if (best) return { at: best, snapped: true }
      const hit = unprojectAtAltitude(map, e.point, elevation)
      return {
        at: assistedPoint(drawAssistRef.current, e.originalEvent.shiftKey, chain, [hit.lng, hit.lat]),
        snapped: false,
      }
    }

    const finish = (closed: boolean) => {
      const verts = dedupe(measureVerticesRef.current)
      setMeasureDraftVertices([])
      setMeasureSnapped(false)
      if (verts.length < (closed ? 3 : 2)) return
      onFinish(verts, closed)
    }

    const onClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      const chain = measureVerticesRef.current
      if (chain.length >= 3 && pxDist(chain[0], e.point) <= SNAP_PX) {
        finish(true)
        return
      }
      const { at } = resolve(e)
      setMeasureDraftVertices((prev) => [...prev, at])
    }
    const onDblClick = (e: MapMouseEvent) => {
      e.preventDefault?.()
      finish(false)
    }
    let pending: MapMouseEvent | null = null
    let raf = 0
    const flush = () => {
      raf = 0
      const e = pending
      pending = null
      if (!e) return
      const { at, snapped } = resolve(e)
      setMeasureDraftCursor(at)
      setMeasureSnapped(snapped)
    }
    const onMouseMove = (e: MapMouseEvent) => {
      pending = e
      if (raf === 0) raf = requestAnimationFrame(flush)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (measureVerticesRef.current.length === 0) return
        e.preventDefault()
        setMeasureDraftVertices((prev) => prev.slice(0, -1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        finish(false)
      } else if (e.key === 'Escape') {
        if (measureVerticesRef.current.length > 0) {
          setMeasureDraftVertices([])
        } else {
          setActiveTool('pan')
        }
      }
    }

    map.on('click', onClick)
    map.on('dblclick', onDblClick)
    map.on('mousemove', onMouseMove)
    map.doubleClickZoom.disable()
    window.addEventListener('keydown', onKey)
    return () => {
      map.off('click', onClick)
      map.off('dblclick', onDblClick)
      map.off('mousemove', onMouseMove)
      map.doubleClickZoom.enable()
      window.removeEventListener('keydown', onKey)
      if (raf !== 0) cancelAnimationFrame(raf)
      pending = null
      map.getCanvas().style.cursor = ''
    }
  }, [
    mapInstance,
    activeTool,
    elevation,
    drawAssistRef,
    snapTargetsRef,
    measureVerticesRef,
    setMeasureDraftVertices,
    setMeasureDraftCursor,
    setMeasureSnapped,
    onFinish,
    setActiveTool,
  ])
}
