/**
 * Phase 7b — global replay state with a tiny pub/sub.
 *
 * One replay can be active at a time. The state is plain
 * `{ activeStreamId, totalEvents, doneEvents, speed, startedAt, label }`
 * surfaced through `useReplayState()` for components and
 * `replayController.subscribe(...)` for non-React callers (the live
 * scheduler).
 *
 * Pausing the live channel: while a replay is active, the live
 * scheduler treats the replay's target stream as "do not connect" —
 * any existing WS is closed and no new WS is opened. Other streams
 * stay live. When replay ends, the scheduler effect re-runs and the
 * normal WS comes back automatically.
 */

import { useEffect, useState } from 'react'

export interface ReplayState {
  activeStreamId: number | null
  /** Total events in the fetched window. */
  totalEvents: number
  /** Events already pushed through the dispatch handler. */
  doneEvents: number
  /** Playback speed multiplier. 1, 4, 16, 64. */
  speed: number
  /** When the replay was kicked off — for elapsed clock. */
  startedAt: number | null
  /** Human-friendly stream label rendered in the banner. */
  label: string | null
  /** When set, replay aborted with an error. */
  error: string | null
}

type Listener = (s: ReplayState) => void

const initial: ReplayState = {
  activeStreamId: null,
  totalEvents: 0,
  doneEvents: 0,
  speed: 1,
  startedAt: null,
  label: null,
  error: null,
}

let state: ReplayState = initial
const listeners = new Set<Listener>()
let stopRequested = false

function emit() {
  for (const fn of listeners) fn(state)
}

function setState(patch: Partial<ReplayState>) {
  state = { ...state, ...patch }
  emit()
}

export const replayController = {
  getState(): ReplayState {
    return state
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    fn(state)
    return () => listeners.delete(fn)
  },
  /** Called by `replay-service.runReplay` at the start of a session. */
  begin(input: {
    streamId: number
    label: string
    speed: number
    totalEvents: number
  }) {
    stopRequested = false
    setState({
      activeStreamId: input.streamId,
      label: input.label,
      speed: input.speed,
      totalEvents: input.totalEvents,
      doneEvents: 0,
      startedAt: Date.now(),
      error: null,
    })
  },
  /** Per-event progress tick. */
  tick(doneEvents: number) {
    if (state.activeStreamId === null) return
    setState({ doneEvents })
  },
  end(error?: string) {
    stopRequested = false
    setState({
      activeStreamId: null,
      totalEvents: 0,
      doneEvents: 0,
      startedAt: null,
      label: null,
      error: error ?? null,
    })
  },
  /** Externally requested stop — the loop polls `shouldStop()` between events. */
  requestStop() {
    stopRequested = true
  },
  shouldStop(): boolean {
    return stopRequested
  },
  /** True while a replay is actively writing to this stream. */
  isStreamPaused(streamId: number): boolean {
    return state.activeStreamId === streamId
  },
}

/** React subscription for the banner + button states. */
export function useReplayState(): ReplayState {
  const [snapshot, setSnapshot] = useState<ReplayState>(replayController.getState())
  useEffect(() => replayController.subscribe(setSnapshot), [])
  return snapshot
}
