/**
 * Server-Sent Events listener for targeted entity invalidation.
 *
 * The backend broadcasts events like:
 *   { "type": "ENTITY_UPDATED", "entity": "zones", "id": "123", "tenantId": 21 }
 *
 * This hook connects once per tenant and surgically refetches only the
 * affected entity in the spatial store. No polling is triggered by SSE.
 *
 * The stream is read with fetch rather than EventSource because
 * EventSource cannot send headers: the backend needs the JWT and
 * X-Tenant-Id to check membership, and only sends this tenant's events.
 * The server ends each stream after ~50s (before the router's 60s request
 * timeout); a clean end reconnects at once, a failure backs off.
 *
 * Events are queued and handled once per animation frame. A live venue can
 * send hundreds of seat events a second; handled one by one, each was its
 * own GET, its own store update and its own re-render + style-rule resolve
 * over every seat. Per frame, a burst becomes one refetch per distinct row
 * (many rows of a kind: one list reload) and one store update.
 */

import { useEffect, useRef } from 'react'
import { API_V1_URL, API_KEY } from '@/config/api'
import { getAuthToken } from './auth-store'
import { spatialRowCount, useSpatialStore, type EntityKind } from './spatial-store'

export interface SSEEvent {
  type: 'ENTITY_CREATED' | 'ENTITY_UPDATED' | 'ENTITY_DELETED'
  entity: EntityKind
  id: string
  tenantId?: number
}

/**
 * Non-spatial-store SSE channels (e.g. the Data screen's `data-events` kind)
 * subscribe here. `useSSE` fires any incoming event whose kind is NOT in
 * VALID_KINDS into every listener registered via `subscribeExternalSSE`.
 * Keeps a single stream per tenant instead of one per screen.
 */
type ExternalListener = (kind: string, ev: SSEEvent) => void
const externalListeners = new Set<ExternalListener>()
export function subscribeExternalSSE(cb: ExternalListener): () => void {
  externalListeners.add(cb)
  return () => {
    externalListeners.delete(cb)
  }
}

const VALID_KINDS = new Set<EntityKind>([
  'zones',
  'grids',
  'bins',
  'polygons',
  'circles',
  'lines',
  'routes',
  'markers',
  'images',
  'models',
  'image-planes',
  'stairs',
  'doors',
  'text-labels',
  'style-rules',
  'attribute-definitions',
  'connections',
  'streams',
  'data-link-configs',
])

/**
 * Reload a kind's whole list instead of refetching rows one by one when a
 * frame brings more than this many distinct rows of it AND more than
 * 1/RELOAD_KIND_SHARE of the rows held (a 50k-seat list costs far more
 * than a few hundred single-row GETs).
 */
const RELOAD_KIND_ABOVE = 200
const RELOAD_KIND_SHARE = 20

/**
 * Events received since the last flush. Per row only the latest event
 * counts (an update then a delete is a delete); Maps keep first-arrival
 * order.
 */
interface EventQueue {
  /** kind → id → what to do with that row. */
  rows: Map<EntityKind, Map<number, 'load' | 'delete'>>
  /** Kinds to reload whole (an id-0 bulk event, e.g. after a CSV import). */
  reload: Set<EntityKind>
  /** Non-spatial events, one per (kind, id): the latest. */
  external: Map<string, SSEEvent>
}

const newQueue = (): EventQueue => ({ rows: new Map(), reload: new Set(), external: new Map() })

function enqueue(q: EventQueue, raw: string, tenantId: number): boolean {
  let data: SSEEvent
  try {
    data = JSON.parse(raw) as SSEEvent
  } catch {
    return false // Ignore malformed SSE payloads.
  }
  // The server already filters by tenant; this guards a stream that was
  // opened for a tenant the user has since switched away from.
  if (data.tenantId !== undefined && data.tenantId !== tenantId) return false
  if (!VALID_KINDS.has(data.entity)) {
    q.external.set(`${data.entity}\u0000${data.id}`, data)
    return true
  }
  const id = Number(data.id)
  if (!Number.isFinite(id)) return false
  if (id === 0) {
    // Bulk/kind-wide invalidation (e.g., after a CSV import). Reload
    // the entire entity kind instead of a single row.
    q.reload.add(data.entity)
    return true
  }
  let rows = q.rows.get(data.entity)
  if (data.type === 'ENTITY_DELETED') {
    // Don't try to GET a row that was just deleted — that would
    // 404 and the loadEntity catch path used to swallow the
    // error, leaving the deleted entity in the local snapshot
    // until a full refresh. Drop it from the store directly.
    if (!rows) q.rows.set(data.entity, (rows = new Map()))
    rows.set(id, 'delete')
    return true
  }
  // Our own save's echo needs no refetch. Checked on arrival, as before
  // batching: by the flush our save may have settled.
  if (useSpatialStore.getState().isSelfEcho(data.entity, id)) return false
  if (!rows) q.rows.set(data.entity, (rows = new Map()))
  rows.set(id, 'load')
  return true
}

function flushQueue(q: EventQueue): void {
  const store = useSpatialStore.getState()
  for (const kind of q.reload) {
    // `fresh`: a list load already running may predate this event.
    void store.loadKind(kind, { fresh: true })
  }
  for (const [kind, rows] of q.rows) {
    const deletes: number[] = []
    const loads: number[] = []
    for (const [id, op] of rows) (op === 'delete' ? deletes : loads).push(id)
    if (deletes.length > 0) store.removeServerEntities(kind, deletes)
    // A list reload of this kind covers its updated rows.
    if (loads.length === 0 || q.reload.has(kind)) continue
    if (loads.length > RELOAD_KIND_ABOVE && loads.length * RELOAD_KIND_SHARE > spatialRowCount(kind)) {
      void store.loadKind(kind, { fresh: true })
    } else {
      void store.loadEntities(kind, loads)
    }
  }
  for (const ev of q.external.values()) {
    externalListeners.forEach((cb) => cb(ev.entity as string, ev))
  }
}

/** Feeds `data:` lines of each complete SSE frame to `onData`; returns the unparsed tail. */
function drainFrames(buffer: string, onData: (data: string) => void): string {
  const frames = buffer.split(/\r?\n\r?\n/)
  const tail = frames.pop() ?? ''
  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data) onData(data)
  }
  return tail
}

export function useSSE(tenantId: number | null, enabled = true) {
  const tenantRef = useRef(tenantId)

  useEffect(() => {
    tenantRef.current = tenantId
  })

  useEffect(() => {
    if (!enabled || tenantId === null) return

    const controller = new AbortController()
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let failures = 0

    // Per-connection queue: a tenant switch or unmount drops what's pending.
    let queue = newQueue()
    let frame: number | null = null
    let fallback: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      if (fallback !== null) clearTimeout(fallback)
      frame = null
      fallback = null
      const q = queue
      queue = newQueue()
      flushQueue(q)
    }
    const onEvent = (raw: string) => {
      if (!enqueue(queue, raw, tenantRef.current ?? tenantId)) return
      if (frame !== null || fallback !== null) return
      // Next frame; a hidden tab gets no frames, so a timer backs it up.
      if (!document.hidden) frame = requestAnimationFrame(flush)
      fallback = setTimeout(flush, document.hidden ? 50 : 250)
    }
    // Background tabs throttle timers; catch up the moment the tab shows.
    const onVisibility = () => {
      if (!document.hidden && (frame !== null || fallback !== null)) flush()
    }
    document.addEventListener('visibilitychange', onVisibility)

    const schedule = (ms: number) => {
      if (controller.signal.aborted) return
      reconnectTimer = setTimeout(() => void connect(), ms)
    }

    const connect = async () => {
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        'X-Api-Key': API_KEY,
        'X-Tenant-Id': String(tenantId),
      }
      const token = getAuthToken()
      if (token) headers.Authorization = `Bearer ${token}`
      try {
        const res = await fetch(`${API_V1_URL}/events`, { headers, signal: controller.signal, cache: 'no-store' })
        if (!res.ok || !res.body) {
          // 401/403 will not fix itself on a quick retry (signed out,
          // removed from the workspace); wait longer before trying again.
          failures++
          schedule(res.status === 401 || res.status === 403 ? 30_000 : Math.min(3000 * failures, 30_000))
          return
        }
        failures = 0
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer = drainFrames(buffer + value, onEvent)
        }
        // Clean end: the server rotates streams every ~50s.
        schedule(100)
      } catch {
        if (controller.signal.aborted) return
        failures++
        schedule(Math.min(3000 * failures, 30_000))
      }
    }

    void connect()

    return () => {
      controller.abort()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (frame !== null) cancelAnimationFrame(frame)
      if (fallback !== null) clearTimeout(fallback)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [tenantId, enabled])
}
