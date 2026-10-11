/**
 * Data-link event bus. Plugins subscribe here to react to user clicks
 * on rendered features when a config's `tooltip.onClick.kind` is
 * `'custom-event'`. Kept intentionally tiny — no Zustand slice, no
 * React subscription; a plain Set of listeners the TooltipManager
 * fires into.
 *
 * See DESIGN-data-link-v2.md §3 (Common options / On-click).
 */

import type { DataLinkConfig } from '@/lib/db'

export interface DataLinkClickEvent {
  /** Event name (from `config.tooltip.onClick.event`, defaults 'dl:click'). */
  event: string
  config: DataLinkConfig
  payload: Record<string, unknown>
  /** LngLat where the click happened, in case the handler cares. */
  lngLat: { lng: number; lat: number }
}

type Listener = (e: DataLinkClickEvent) => void

const listeners = new Set<Listener>()

/** Subscribe. Returns an unsubscribe function. */
export function subscribeDataLinkClicks(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Dispatch. Errors in listeners are logged, not rethrown. */
export function emitDataLinkClick(e: DataLinkClickEvent): void {
  for (const fn of listeners) {
    try {
      fn(e)
    } catch (err) {
      console.warn('[data-link] click listener threw', err)
    }
  }
}
