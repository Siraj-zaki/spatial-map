/**
 * Low-level debounced mutation queue for spatial edits.
 *
 * This module is used by `useDebouncedMutation` and the spatial store to batch
 * map interactions before sending them to the backend. It lives outside the
 * React lifecycle so re-renders do not reset timers or lose in-flight state.
 */

import debounce from 'lodash-es/debounce'
import { apiDb } from './api-db'
import { queryCache } from './useApiQuery'
import type { EntityKind, CatalogEntity } from './spatial-store'

export interface QueuedMutation<T extends CatalogEntity = CatalogEntity> {
  kind: EntityKind
  id?: number
  operation: 'create' | 'update' | 'delete'
  payload: Partial<T>
}

interface QueueState {
  pending: Map<string, QueuedMutation>
  inFlight: Promise<unknown> | null
  timer: ReturnType<typeof setTimeout> | null
}

const queue: QueueState = {
  pending: new Map(),
  inFlight: null,
  timer: null,
}

const DEBOUNCE_MS = 400

const tablePath: Record<EntityKind, keyof typeof apiDb> = {
  zones: 'zones',
  grids: 'grids',
  bins: 'bins',
  polygons: 'polygons',
  circles: 'circles',
  lines: 'lines',
  routes: 'routes',
  markers: 'markers',
  images: 'images',
  models: 'models',
  'image-planes': 'imagePlanes',
  stairs: 'stairs',
  doors: 'doors',
  'text-labels': 'textLabels',
  'style-rules': 'styleRules',
  'attribute-definitions': 'attributeDefinitions',
  connections: 'connections',
  streams: 'streams',
  'data-link-configs': 'dataLinkConfigs',
}

function queueKey(kind: EntityKind, id?: number): string {
  return id === undefined ? `${kind}:create:${Date.now()}` : `${kind}:${id}`
}

export function enqueueMutation<T extends CatalogEntity>(mutation: QueuedMutation<T>): void {
  const key = queueKey(mutation.kind, mutation.id)
  const existing = queue.pending.get(key)
  if (existing && existing.operation === mutation.operation) {
    existing.payload = { ...existing.payload, ...mutation.payload }
  } else {
    queue.pending.set(key, mutation as QueuedMutation)
  }
  scheduleFlush()
}

const scheduleFlush = debounce(() => {
  void flushQueue()
}, DEBOUNCE_MS, { leading: false, trailing: true })

export async function flushQueue(): Promise<void> {
  if (queue.inFlight) {
    await queue.inFlight
  }
  if (queue.pending.size === 0) return

  const batch = Array.from(queue.pending.values())
  queue.pending.clear()

  const promise = runBatch(batch).finally(() => {
    queue.inFlight = null
  })
  queue.inFlight = promise
  await promise
}

async function runBatch(batch: QueuedMutation[]): Promise<void> {
  for (const mutation of batch) {
    const { kind, id, operation, payload } = mutation
    try {
      if (operation === 'delete' && id !== undefined) {
        const table = apiDb[tablePath[kind]] as { delete: (id: number) => Promise<void> }
        await table.delete(id)
      } else if (operation === 'create') {
        const table = apiDb[tablePath[kind]] as { add: (item: CatalogEntity) => Promise<number> }
        await table.add(payload as CatalogEntity)
      } else if (operation === 'update' && id !== undefined) {
        const table = apiDb[tablePath[kind]] as {
          update: (id: number, patch: Partial<CatalogEntity>) => Promise<CatalogEntity>
        }
        await table.update(id, payload)
      }
      queryCache.invalidate(kind)
    } catch (err) {
      console.error('[mutationQueue] mutation failed', mutation, err)
      throw err
    }
  }
}

export function getPendingCount(): number {
  return queue.pending.size + (queue.inFlight ? 1 : 0)
}
