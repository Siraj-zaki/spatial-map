/**
 * table-playback-store — global pub/sub for the table-history player.
 *
 * One source can be playing back at a time (same constraint the
 * stream `replay-controller` enforces, for the same reason: two
 * simultaneous playbacks would race for the map's render slot).
 * When active, sub-renderers whose `config.sourceId ===
 * activeSourceId` bypass their live query and read
 * `visibleEntities()` instead — the row state reconstructed from
 * events with ts ≤ currentMs.
 *
 * State is a plain module-level `let` guarded by a tiny listener
 * set. React callers subscribe via `useTablePlaybackState()`.
 */

import { useEffect, useState } from 'react'

import type { EntityState } from '@/lib/db'
import type { TableRowEvent } from './table-events-client'

export interface TablePlaybackState {
  /** Source currently being played back, or null when idle. */
  activeSourceId: number | null
  /** Events for the active source, ordered ASC by ts. */
  events: TableRowEvent[]
  /** Window bounds. `currentMs` is the playhead within [startMs, endMs]. */
  startMs: number
  endMs: number
  currentMs: number
  playing: boolean
  /** Wall-clock ms of history per wall-clock ms of playback. Higher = faster. */
  speed: number
  /** Set when the fetch failed — surfaced to the player UI. */
  error: string | null
}

type Listener = (s: TablePlaybackState) => void

const initial: TablePlaybackState = {
  activeSourceId: null,
  events: [],
  startMs: 0,
  endMs: 0,
  currentMs: 0,
  playing: false,
  speed: 60, // 1 minute per second of playback ≈ browse-through-an-hour-in-a-minute
  error: null,
}

let state: TablePlaybackState = initial
const listeners = new Set<Listener>()
let raf: number | null = null
let lastTickMs: number | null = null

function emit() {
  for (const fn of listeners) fn(state)
}

function setState(patch: Partial<TablePlaybackState>) {
  state = { ...state, ...patch }
  emit()
}

function stopRaf() {
  if (raf !== null) {
    cancelAnimationFrame(raf)
    raf = null
  }
  lastTickMs = null
}

function tick(now: number) {
  if (!state.playing) {
    stopRaf()
    return
  }
  if (lastTickMs === null) lastTickMs = now
  const delta = now - lastTickMs
  lastTickMs = now
  const advanced = state.currentMs + delta * state.speed
  if (advanced >= state.endMs) {
    // Snap to the end and pause — the user can rewind + play again.
    setState({ currentMs: state.endMs, playing: false })
    stopRaf()
    return
  }
  setState({ currentMs: advanced })
  raf = requestAnimationFrame(tick)
}

export const tablePlayback = {
  getState(): TablePlaybackState {
    return state
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    fn(state)
    return () => {
      listeners.delete(fn)
    }
  },
  /**
   * True when a session is already running for this source AND the
   * window covers `[nowMs - windowSec, nowMs]` — used by the auto-
   * loader in the view so a re-render of the layer list doesn't
   * force-reload the same events.
   */
  isLoadedFor(sourceId: number, _windowSec: number): boolean {
    return state.activeSourceId === sourceId
  },
  /** Kick off a playback session. Replaces any prior one. */
  start(input: {
    sourceId: number
    events: TableRowEvent[]
    startMs?: number
    endMs?: number
  }) {
    stopRaf()
    const events = [...input.events].sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
    )
    const startMs =
      input.startMs ??
      (events.length > 0 ? new Date(events[0]!.ts).getTime() : Date.now())
    const endMs =
      input.endMs ??
      (events.length > 0
        ? new Date(events[events.length - 1]!.ts).getTime()
        : Date.now())
    setState({
      activeSourceId: input.sourceId,
      events,
      startMs,
      endMs,
      currentMs: startMs,
      playing: false,
      error: null,
    })
  },
  setError(msg: string) {
    stopRaf()
    setState({ error: msg, playing: false })
  },
  play() {
    if (state.activeSourceId === null) return
    if (state.currentMs >= state.endMs) {
      // At the end — restart from the beginning so the button is never
      // a no-op after playback finishes.
      setState({ currentMs: state.startMs })
    }
    setState({ playing: true })
    lastTickMs = null
    raf = requestAnimationFrame(tick)
  },
  pause() {
    setState({ playing: false })
    stopRaf()
  },
  seek(ms: number) {
    const clamped = Math.max(state.startMs, Math.min(state.endMs, ms))
    setState({ currentMs: clamped })
    lastTickMs = null
  },
  setSpeed(speed: number) {
    setState({ speed })
    lastTickMs = null
  },
  stop() {
    stopRaf()
    state = initial
    emit()
  },
}

/**
 * Reconstruct the entity states for `sourceId` at the current
 * playhead. Walks events ASC and keeps the last snapshot per
 * `entityKey`; `delete` operations remove the entity from the
 * result. Deliberately O(events) per call — playback windows
 * cap at 5000 events server-side (see `table-events-client.ts`),
 * so this is fine on every animation frame.
 */
export function visibleEntities(sourceId: number): EntityState[] {
  if (state.activeSourceId !== sourceId) return []
  const cutoff = state.currentMs
  const bySnapshot = new Map<string, { ev: TableRowEvent; deleted: boolean }>()
  for (const ev of state.events) {
    if (new Date(ev.ts).getTime() > cutoff) break
    if (ev.operation === 'delete') {
      bySnapshot.set(ev.entityKey, { ev, deleted: true })
    } else {
      bySnapshot.set(ev.entityKey, { ev, deleted: false })
    }
  }
  const out: EntityState[] = []
  for (const [key, entry] of bySnapshot) {
    if (entry.deleted) continue
    const ts = new Date(entry.ev.ts)
    out.push({
      entityKey: key,
      streamId: -1,
      payload: entry.ev.payload,
      lastSeenAt: ts,
      updatedAt: ts,
    })
  }
  return out
}

/**
 * React subscription for the player UI + any overlay renderer that
 * needs to switch its data source when playback is active.
 */
export function useTablePlaybackState(): TablePlaybackState {
  const [snap, setSnap] = useState<TablePlaybackState>(tablePlayback.getState())
  useEffect(() => tablePlayback.subscribe(setSnap), [])
  return snap
}
