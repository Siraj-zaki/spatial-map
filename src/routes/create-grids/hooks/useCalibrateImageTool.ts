import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'

import { type Tool } from '@/lib/keyboard-shortcuts'
import {
  imageUVToLngLat,
  lngLatToImageUV,
  type ImageFrame,
} from '@/lib/measure/calibration'
import { assistedPoint, planBaseAngle, type DrawAssist, type LngLat } from '@/lib/measure/geometry'
import { unprojectAtAltitude } from '@/lib/unproject-at-altitude'
import type { CalibrationSession } from '../state/useMeasureEditorState'

/**
 * Calibrate-scale tool, driven by the calibration panel's mode:
 *
 *   - area: click two opposite corners of a room → a rectangle aligned
 *     to the image's own axes; the panel then asks for its real area.
 *   - length: click both ends of a known dimension; the panel asks for
 *     its real length.
 *   - straighten: click both ends of a wall that should run straight
 *     across or up the plan; `onStraighten` turns the image to match.
 *
 * Clicks are cast onto the image's own altitude, and the angle lock
 * (relative to the image's axes here) helps keep a length mark on a
 * wall. Points are kept image-normalised — see lib/measure/calibration.
 * Esc drops the half-made mark, a second Esc leaves the tool.
 */
export function useCalibrateImageTool({
  mapInstance,
  activeTool,
  session,
  frame,
  elevation,
  drawAssistRef,
  setSession,
  setCursor,
  onStraighten,
  onExit,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  session: CalibrationSession | null
  frame: ImageFrame | null
  elevation: number
  drawAssistRef: MutableRefObject<DrawAssist>
  setSession: Dispatch<SetStateAction<CalibrationSession | null>>
  setCursor: Dispatch<SetStateAction<LngLat | null>>
  onStraighten: (a: LngLat, b: LngLat) => void
  onExit: () => void
}) {
  const sessionRef = useRef(session)
  const frameRef = useRef(frame)
  const onStraightenRef = useRef(onStraighten)
  const onExitRef = useRef(onExit)
  useEffect(() => {
    sessionRef.current = session
    frameRef.current = frame
    onStraightenRef.current = onStraighten
    onExitRef.current = onExit
  })

  const active = activeTool === 'calibrate-image' && session !== null

  useEffect(() => {
    if (!mapInstance || !active) {
      setCursor(null)
      return
    }
    const map = mapInstance
    map.getCanvas().style.cursor = 'crosshair'

    const pointFor = (e: MapMouseEvent): LngLat | null => {
      const s = sessionRef.current
      const f = frameRef.current
      if (!s || !f) return null
      const hit = unprojectAtAltitude(map, e.point, elevation)
      const raw: LngLat = [hit.lng, hit.lat]
      if (!s.firstPick || s.mode === 'area') return raw
      // Lock relative to the image's own axes, not the active floor plan's.
      const assist = { ...drawAssistRef.current, baseDeg: planBaseAngle(f.rotation) }
      return assistedPoint(assist, e.originalEvent.shiftKey, [imageUVToLngLat(f, s.firstPick)], raw)
    }

    const onClick = (e: MapMouseEvent) => {
      if (e.defaultPrevented) return
      const s = sessionRef.current
      const f = frameRef.current
      const at = pointFor(e)
      if (!s || !f || !at) return
      const uv = lngLatToImageUV(f, at)
      if (!s.firstPick) {
        setSession({ ...s, firstPick: uv, pending: null })
        return
      }
      if (s.mode === 'straighten') {
        onStraightenRef.current(imageUVToLngLat(f, s.firstPick), at)
        setSession({ ...s, firstPick: null, pending: null })
        return
      }
      setSession({
        ...s,
        firstPick: null,
        pending: { kind: s.mode === 'area' ? 'area' : 'length', a: s.firstPick, b: uv },
      })
    }
    let pending: MapMouseEvent | null = null
    let raf = 0
    const flush = () => {
      raf = 0
      const e = pending
      pending = null
      if (e) setCursor(pointFor(e))
    }
    const onMouseMove = (e: MapMouseEvent) => {
      pending = e
      if (raf === 0) raf = requestAnimationFrame(flush)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const s = sessionRef.current
      if (s && (s.firstPick || s.pending)) {
        setSession({ ...s, firstPick: null, pending: null })
      } else {
        onExitRef.current()
      }
    }

    map.on('click', onClick)
    map.on('mousemove', onMouseMove)
    window.addEventListener('keydown', onKey)
    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMouseMove)
      window.removeEventListener('keydown', onKey)
      if (raf !== 0) cancelAnimationFrame(raf)
      pending = null
      map.getCanvas().style.cursor = ''
    }
  }, [mapInstance, active, elevation, drawAssistRef, setSession, setCursor])
}
