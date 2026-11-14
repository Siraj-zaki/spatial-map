import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type { CalibrationKind, CalibrationSample } from '@/lib/measure/calibration'
import type { LngLat } from '@/lib/measure/geometry'
import { measureUnitFromLength, type MeasureUnit } from '@/lib/measure/units'
import { usePersistedState } from '@/lib/persisted-state'
import { defaultUnitForLocale } from '@/lib/units'

export interface MeasureSettings {
  /** Display unit for live dimensions, the ruler and guides. */
  unit: MeasureUnit
  /** Angle lock on by default (Shift flips it while held). */
  angleLock: boolean
  /** Lock increments in degrees, measured from the floor plan's axes. */
  angleStep: number
  /** Dimension labels on drafts and guides. */
  showLabels: boolean
}

export const ANGLE_STEPS = [15, 30, 45, 90] as const

/**
 * A kept measurement drawn with the Measure tool. Drafting aid only —
 * never rendered in the viewer, never part of routing — so it lives in
 * this browser's storage per facility rather than as a spatial entity.
 */
export interface Guide {
  id: string
  floorPlanId: number | null
  vertices: LngLat[]
  closed: boolean
  /** Altitude of the floor it was drawn on, metres. */
  elevation: number
}

export type CalibrationMode = 'area' | 'length' | 'straighten'

/** A finished mark waiting for its real value. */
export interface PendingCalibrationMark {
  kind: CalibrationKind
  a: [number, number]
  b: [number, number]
}

export interface CalibrationSession {
  imageId: number
  mode: CalibrationMode
  /** First click of an in-progress mark, image-normalised. */
  firstPick: [number, number] | null
  pending: PendingCalibrationMark | null
}

/**
 * localStorage-backed state whose key can change (facility / image
 * switch). `usePersistedState` reads once on mount, so it can't follow a
 * moving key; this reloads on every key change and writes back after.
 */
function useKeyedStorage<T>(key: string | null, fallback: () => T): [T, Dispatch<SetStateAction<T>>] {
  const read = useCallback((k: string | null): T => {
    if (!k) return fallback()
    try {
      const raw = localStorage.getItem(k)
      return raw ? (JSON.parse(raw) as T) : fallback()
    } catch {
      return fallback()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [state, setState] = useState<{ key: string | null; value: T }>(() => ({ key, value: read(key) }))
  // Key changed: swap in that key's stored value during render (the
  // documented "adjust state on prop change" pattern), not in an effect.
  if (state.key !== key) setState({ key, value: read(key) })
  const lastWritten = useRef<string | null>(null)
  useEffect(() => {
    if (!state.key) return
    try {
      const json = JSON.stringify(state.value)
      if (lastWritten.current === `${state.key}|${json}`) return
      lastWritten.current = `${state.key}|${json}`
      localStorage.setItem(state.key, json)
    } catch {
      /* quota / disabled storage — the tool keeps working in memory */
    }
  }, [state])
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setState((prev) => ({
      key: prev.key,
      value: typeof next === 'function' ? (next as (p: T) => T)(prev.value) : next,
    }))
  }, [])
  return [state.key === key ? state.value : read(key), set]
}

/**
 * Editor state for the drafting tools: measurement settings (persisted),
 * the Measure tool's in-flight chain, kept guides (per facility), the
 * typed-length buffer shared by every vertex tool, and the image
 * calibration session with its marks (per image).
 */
export function useMeasureEditorState(zoneId: number | null) {
  const [measureSettings, setMeasureSettings] = usePersistedState<MeasureSettings>(
    'sgv-measure-settings',
    () => ({
      unit: measureUnitFromLength(
        defaultUnitForLocale(typeof navigator === 'undefined' ? undefined : navigator.language),
      ),
      angleLock: false,
      angleStep: 45,
      showLabels: true,
    }),
  )

  const [measureDraftVertices, setMeasureDraftVertices] = useState<LngLat[]>([])
  const [measureDraftCursor, setMeasureDraftCursor] = useState<LngLat | null>(null)
  /** True when the Measure tool's cursor is snapped onto a vertex. */
  const [measureSnapped, setMeasureSnapped] = useState(false)
  const measureVerticesRef = useRef<LngLat[]>([])
  useEffect(() => {
    measureVerticesRef.current = measureDraftVertices
  }, [measureDraftVertices])

  const [guides, setGuides] = useKeyedStorage<Guide[]>(
    `sgv-guides:${zoneId ?? 'none'}`,
    () => [],
  )

  /** Digits typed while drawing ("3.5", "12'6"); empty when not typing. */
  const [typedLength, setTypedLength] = useState('')

  const [calibration, setCalibration] = useState<CalibrationSession | null>(null)
  const [calibrationCursor, setCalibrationCursor] = useState<LngLat | null>(null)
  const [calibrationSamples, setCalibrationSamples] = useKeyedStorage<CalibrationSample[]>(
    calibration ? `sgv-calibration:${calibration.imageId}` : null,
    () => [],
  )

  return {
    measureSettings,
    setMeasureSettings,
    measureDraftVertices,
    setMeasureDraftVertices,
    measureDraftCursor,
    setMeasureDraftCursor,
    measureSnapped,
    setMeasureSnapped,
    measureVerticesRef,
    guides,
    setGuides,
    typedLength,
    setTypedLength,
    calibration,
    setCalibration,
    calibrationCursor,
    setCalibrationCursor,
    calibrationSamples,
    setCalibrationSamples,
  }
}
