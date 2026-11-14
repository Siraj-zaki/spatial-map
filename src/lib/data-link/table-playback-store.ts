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

import { useEffect, useState, useSyncExternalStore } from 'react'

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
      // Parked at "now": a freshly loaded window shows the live map (see
      // useTablePlaybackFor) until the viewer plays or scrubs back; play()
      // at the end restarts from the beginning.
      currentMs: endMs,
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
    cursor = null
    emit()
  },
}

/**
 * Incremental reconstruction state for `visibleEntities`. Rebuilt from
 * scratch whenever `state.events` is a different array (a new session)
 * or the playhead moves backwards; otherwise the cursor only walks the
 * events that crossed the playhead since the last call.
 */
interface PlaybackCursor {
  /** The `state.events` array this cursor walks. */
  events: TableRowEvent[]
  /** `new Date(ev.ts).getTime()` per event, parsed once. */
  tsMs: Float64Array
  /** Index of the first event not yet applied. */
  next: number
  /** Playhead of the last call — a smaller one means a backwards seek. */
  cutoff: number
  /**
   * Latest event per entity key, in first-seen order. A delete keeps the
   * key's slot (flagged) so a later re-insert lands where it was — the
   * same order the from-scratch walk produces.
   */
  current: Map<string, { ev: TableRowEvent; deleted: boolean }>
  /** True once `current` changed since `snapshot` was built. */
  dirty: boolean
  /** Last result, returned as-is while nothing crossed the playhead. */
  snapshot: EntityState[]
}

let cursor: PlaybackCursor | null = null

/** One EntityState per event, so a rebuilt snapshot reuses unchanged rows. */
const entityForEvent = new WeakMap<TableRowEvent, EntityState>()

function entityStateFor(key: string, ev: TableRowEvent): EntityState {
  const hit = entityForEvent.get(ev)
  if (hit && hit.entityKey === key) return hit
  const ts = new Date(ev.ts)
  const out: EntityState = {
    entityKey: key,
    streamId: -1,
    payload: ev.payload,
    lastSeenAt: ts,
    updatedAt: ts,
  }
  entityForEvent.set(ev, out)
  return out
}

function freshCursor(events: TableRowEvent[]): PlaybackCursor {
  const tsMs = new Float64Array(events.length)
  for (let i = 0; i < events.length; i++) tsMs[i] = new Date(events[i]!.ts).getTime()
  return {
    events,
    tsMs,
    next: 0,
    cutoff: -Infinity,
    current: new Map(),
    dirty: true,
    snapshot: [],
  }
}

/**
 * Reconstruct the entity states for `sourceId` at the current
 * playhead. Walks events ASC and keeps the last snapshot per
 * `entityKey`; `delete` operations remove the entity from the
 * result.
 *
 * Runs on every animation frame while playing, so the walk is
 * incremental: a cursor remembers how far it got, only events that
 * crossed the playhead since the last call are applied, and when none
 * did the previous array is returned as-is — downstream memos and map
 * pushes then skip the frame entirely. A rebuilt array reuses the
 * EntityState object of every row whose event didn't change. Same
 * entities, same order, same field values as the from-scratch walk
 * (a backwards seek replays from the start).
 */
export function visibleEntities(sourceId: number): EntityState[] {
  if (state.activeSourceId !== sourceId) return []
  const cutoff = state.currentMs
  let c = cursor
  // `!(cutoff >= …)` also replays after a NaN playhead, where the
  // from-scratch walk would have answered differently.
  if (!c || c.events !== state.events || !(cutoff >= c.cutoff)) {
    const prev = c && c.events === state.events ? c : null
    c = freshCursor(state.events)
    // Keep the array identity across a seek that lands on the same set.
    if (prev) c.snapshot = prev.snapshot
    cursor = c
  }
  c.cutoff = cutoff
  const { events, tsMs, current } = c
  // `!(ts > cutoff)` rather than `ts <= cutoff`: an unparseable ts (NaN)
  // never stopped the from-scratch walk either.
  while (c.next < events.length && !(tsMs[c.next]! > cutoff)) {
    const ev = events[c.next]!
    current.set(ev.entityKey, { ev, deleted: ev.operation === 'delete' })
    c.next++
    c.dirty = true
  }
  if (!c.dirty) return c.snapshot
  c.dirty = false
  const out: EntityState[] = []
  for (const [key, entry] of current) {
    if (entry.deleted) continue
    out.push(entityStateFor(key, entry.ev))
  }
  const prevSnap = c.snapshot
  let same = prevSnap.length === out.length
  for (let i = 0; same && i < out.length; i++) same = prevSnap[i] === out[i]
  if (same) return prevSnap
  c.snapshot = out
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

function subscribeRaw(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Narrow subscription for one data source's map layer. Re-renders only
 * when this source starts / stops playing back, or when the set of
 * entities at the playhead actually changed — not on every playhead tick
 * (60 per second while playing). Layers of other sources never re-render.
 *
 * `entities` is `visibleEntities(sourceId)` while active, else null.
 */
export function useTablePlaybackFor(sourceId: number | null | undefined): {
  active: boolean
  entities: EntityState[] | null
} {
  // Active = this source is loaded AND the playhead is somewhere in the past
  // (playing, or scrubbed back). Parked at the end of the window and paused
  // is "now": the layer draws its live rows, so items with no event in the
  // window (a silent tag) don't vanish and new rows keep arriving.
  const getSnapshot = (): EntityState[] | null =>
    sourceId !== undefined && state.activeSourceId === sourceId && (state.playing || state.currentMs < state.endMs)
      ? visibleEntities(sourceId as number)
      : null
  const entities = useSyncExternalStore(subscribeRaw, getSnapshot, getSnapshot)
  return { active: entities !== null, entities }
}
