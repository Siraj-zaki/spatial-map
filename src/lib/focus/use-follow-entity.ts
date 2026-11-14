/**
 * useFollowEntity — keeps the camera on one moving data-link record: a
 * `history-movement` row while its table plays back (table-playback-store),
 * or a row whose live position changes between refreshes.
 *
 * The camera eases its centre onto the record — zoom, pitch and bearing stay
 * the viewer's — throttled, and never while a focus flight is under way (that
 * flight already goes to the record). `onMove` (throttled the same way) lets
 * the host move the focus anchor, so the ring and the near / blocker fades
 * travel with the record. Dragging the map pauses following until `resume`
 * or another record is picked.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Map as MapboxMapInstance } from 'mapbox-gl'
import { isFocusFlying } from '@/lib/focus/focus-camera'
import { readPayloadPath } from '@/lib/data-link/match-resolver'
import { useTablePlaybackFor } from '@/lib/data-link/table-playback-store'
import type { DataLinkConfig } from '@/lib/db'

/** Camera / anchor updates at most this often while the record moves. */
const STEP_MS = 450
/** Moves shorter than this (metres) don't move the camera. */
const MIN_MOVE_M = 0.4

/** Where an entity's point is: the link's coordinate fields, else its `position`. */
export function entityPoint(
  config: DataLinkConfig,
  payload: Record<string, unknown> | undefined,
  position?: [number, number] | null,
): [number, number] | null {
  const lngKey = config.fieldMapping?.coordFields?.lng ?? 'lng'
  const latKey = config.fieldMapping?.coordFields?.lat ?? 'lat'
  const lng = Number(payload ? readPayloadPath(payload, lngKey) : NaN)
  const lat = Number(payload ? readPayloadPath(payload, latKey) : NaN)
  if (Number.isFinite(lng) && Number.isFinite(lat) && !(lng === 0 && lat === 0)) return [lng, lat]
  return position ?? null
}

const metres = (a: [number, number], b: [number, number]) => {
  const k = Math.cos((a[1] * Math.PI) / 180) * 111320
  return Math.hypot((a[0] - b[0]) * k, (a[1] - b[1]) * 110540)
}

export interface FollowEntityOptions {
  config: DataLinkConfig | undefined
  entityKey: string | null
  /** The record's position outside playback (e.g. from the report's rows). */
  livePoint?: [number, number] | null
  enabled: boolean
  /** Screen offset (px) applied to the centre, e.g. half a side panel —
   *  read each time the camera moves. */
  offset?: (map: MapboxMapInstance) => [number, number]
  onMove?: (point: [number, number]) => void
}

export interface FollowEntityState {
  /** The record's current point (playback or live), or null. */
  point: [number, number] | null
  /** Its table is playing back — the record moves with the playhead. */
  playing: boolean
  paused: boolean
  resume: () => void
}

export function useFollowEntity(map: MapboxMapInstance | null, opts: FollowEntityOptions): FollowEntityState {
  const { config, entityKey, livePoint = null, enabled, offset, onMove } = opts
  const historySource = config?.renderMode === 'history-movement' ? config.sourceId : null
  const pb = useTablePlaybackFor(historySource)
  const playbackPoint = useMemo(() => {
    if (!pb.active || !pb.entities || !entityKey || !config) return null
    const e = pb.entities.find((x) => x.entityKey === entityKey)
    return e ? entityPoint(config, e.payload as Record<string, unknown>, e.position ?? null) : null
  }, [pb.active, pb.entities, entityKey, config])
  const point = pb.active ? playbackPoint : livePoint

  // Dragging the map pauses following; picking another record resumes it.
  const [paused, setPaused] = useState(false)
  const [pausedFor, setPausedFor] = useState(entityKey)
  if (pausedFor !== entityKey) {
    setPausedFor(entityKey)
    setPaused(false)
  }
  useEffect(() => {
    if (!map || !enabled || !entityKey) return
    const onDrag = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) setPaused(true)
    }
    map.on('dragstart', onDrag)
    return () => {
      map.off('dragstart', onDrag)
    }
  }, [map, enabled, entityKey])

  const onMoveRef = useRef(onMove)
  const offsetRef = useRef(offset)
  useEffect(() => {
    onMoveRef.current = onMove
    offsetRef.current = offset
  })
  const last = useRef<{ at: number; point: [number, number] | null; key: string | null }>({ at: 0, point: null, key: null })
  const trailing = useRef<number | null>(null)
  const pointKey = point ? `${point[0].toFixed(7)},${point[1].toFixed(7)}` : null
  useEffect(() => {
    if (!map || !enabled || paused || !point || !entityKey) return
    if (last.current.key !== entityKey) last.current = { at: 0, point: null, key: entityKey }
    const step = () => {
      trailing.current = null
      const prev = last.current.point
      if (prev && metres(prev, point) < MIN_MOVE_M) return
      last.current = { at: performance.now(), point, key: entityKey }
      onMoveRef.current?.(point)
      // The focus flight is already on its way to the record.
      if (isFocusFlying(map)) return
      map.easeTo({ center: point, offset: offsetRef.current?.(map) ?? [0, 0], duration: STEP_MS + 150, essential: true })
    }
    const wait = STEP_MS - (performance.now() - last.current.at)
    if (wait <= 0) step()
    else {
      if (trailing.current !== null) window.clearTimeout(trailing.current)
      trailing.current = window.setTimeout(step, wait)
    }
    return () => {
      if (trailing.current !== null) {
        window.clearTimeout(trailing.current)
        trailing.current = null
      }
    }
    // `point` is keyed by `pointKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled, paused, pointKey, entityKey])

  const resume = useCallback(() => setPaused(false), [])
  return { point, playing: pb.active && playbackPoint !== null, paused, resume }
}
