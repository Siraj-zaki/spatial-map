/**
 * How often the data-link layers re-poll their rows (`layer-rows` queries in
 * map-data-linked-overlay.tsx). 30 s by default — the safety net behind SSE
 * invalidation. The facility viewer's Live pill changes it (10 s … 5 min, or
 * 0 = paused: no polling, rows still refresh on SSE writes and on "Refresh
 * now"), and resets it when the viewer unmounts, so the editor and reports
 * keep the default.
 */

import { create } from 'zustand'

export const DEFAULT_LAYER_POLL_MS = 30_000

export const useLayerRefresh = create<{ pollMs: number; refreshedAt: number }>(() => ({
  pollMs: DEFAULT_LAYER_POLL_MS,
  refreshedAt: Date.now(),
}))

/** `intervalMs` for a layer query: undefined while paused. */
export function useLayerPollMs(): number | undefined {
  const ms = useLayerRefresh((s) => s.pollMs)
  return ms > 0 ? ms : undefined
}

export function setLayerPollMs(ms: number) {
  useLayerRefresh.setState({ pollMs: ms })
}

/** Stamp a completed refresh (the Live pill counts down from it). */
export function markLayersRefreshed() {
  useLayerRefresh.setState({ refreshedAt: Date.now() })
}
