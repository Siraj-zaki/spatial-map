import { useCallback, useEffect, useRef, useState } from 'react'

import type { Map as MapboxMapInstance } from 'mapbox-gl'

/**
 * Slow continuous auto-rotation of the map camera. Toggle from a
 * toolbar button; the effect drives a `requestAnimationFrame` loop
 * that increments the map's bearing by a fixed degrees-per-second
 * regardless of frame rate (so a 30 fps device rotates at the same
 * angular speed as 60 fps).
 *
 * `setBearing` (not `easeTo` / `rotateTo`) is used because those queue
 * an animation and would fight our per-frame writes. `setBearing` is a
 * cheap direct set with no camera easing, which is exactly what a
 * frame-driven loop needs.
 *
 * Speed: 15°/sec → one full turn every 24 seconds. Slow enough to
 * read as "cinematic pan" rather than "spin", but brisk enough to
 * feel intentional on a presenter display. Direction is clockwise
 * from above (positive bearing delta in Mapbox = CW yaw).
 *
 * The rotation is a background-only animation: dragging the map, using
 * the built-in `rotate` gesture, or a `flyTo` call from another handler
 * all still work — our next tick just picks up wherever the bearing
 * landed and continues from there.
 */
const DEG_PER_SECOND = 15

export function useMapRotation(mapInstance: MapboxMapInstance | null) {
  const [isRotating, setIsRotating] = useState(false)
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)

  const toggleRotate = useCallback(() => {
    setIsRotating((v) => !v)
  }, [])

  const stopRotate = useCallback(() => {
    setIsRotating(false)
  }, [])

  useEffect(() => {
    if (!mapInstance || !isRotating) return
    const tick = (ts: number) => {
      if (lastTsRef.current === null) lastTsRef.current = ts
      const dt = (ts - lastTsRef.current) / 1000
      lastTsRef.current = ts
      // Wrap the bearing into a stable range so long sessions don't
      // accumulate large numeric values in mapbox's internal camera
      // state. Mapbox normalises internally but keeping the input
      // tidy avoids any floating-point drift over hours of run.
      let next = mapInstance.getBearing() + DEG_PER_SECOND * dt
      if (next >= 180) next -= 360
      else if (next < -180) next += 360
      mapInstance.setBearing(next)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastTsRef.current = null
    }
  }, [mapInstance, isRotating])

  // If the map instance is torn down while rotation is on, drop the
  // flag so a fresh map doesn't come up already spinning without the
  // user having toggled it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!mapInstance && isRotating) setIsRotating(false)
  }, [mapInstance, isRotating])

  return { isRotating, toggleRotate, stopRotate }
}
