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
 */

import { useEffect, useRef } from 'react'
import { API_V1_URL, API_KEY } from '@/config/api'
import { getAuthToken } from './auth-store'
import { applySSEEntityUpdate, useSpatialStore, type EntityKind } from './spatial-store'

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

function handleMessage(raw: string, tenantId: number): void {
  let data: SSEEvent
  try {
    data = JSON.parse(raw) as SSEEvent
  } catch {
    return // Ignore malformed SSE payloads.
  }
  // The server already filters by tenant; this guards a stream that was
  // opened for a tenant the user has since switched away from.
  if (data.tenantId !== undefined && data.tenantId !== tenantId) return
  if (!VALID_KINDS.has(data.entity)) {
    externalListeners.forEach((cb) => cb(data.entity as string, data))
    return
  }
  const id = Number(data.id)
  if (!Number.isFinite(id)) return
  if (id === 0) {
    // Bulk/kind-wide invalidation (e.g., after a CSV import). Reload
    // the entire entity kind instead of a single row.
    void useSpatialStore.getState().loadKind(data.entity)
    return
  }
  if (data.type === 'ENTITY_DELETED') {
    // Don't try to GET a row that was just deleted — that would
    // 404 and the loadEntity catch path used to swallow the
    // error, leaving the deleted entity in the local snapshot
    // until a full refresh. Drop it from the store directly.
    useSpatialStore.getState().removeServerEntity(data.entity, id)
    return
  }
  applySSEEntityUpdate(data.entity, id)
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
          buffer = drainFrames(buffer + value, (data) => handleMessage(data, tenantRef.current ?? tenantId))
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
    }
  }, [tenantId, enabled])
}
