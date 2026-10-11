/**
 * Minimal IndexedDB-backed queue for mutations made while the browser is
 * offline. GET/HEAD requests are never queued — they fail immediately. Only
 * JSON-serializable mutation bodies are queued; multipart file uploads are not
 * supported offline.
 *
 * The queue lives in a dedicated Dexie database so the legacy app database
 * stays read-only except for migration.
 */

import Dexie, { type EntityTable } from 'dexie'

export interface QueuedRequest {
  id?: number
  method: string
  path: string
  body: unknown
  tenantId: number | null
  apiKey: string
  createdAt: Date
  retryCount: number
}

const queueDb = new Dexie('SpatialGridVisOfflineQueue') as Dexie & {
  requests: EntityTable<QueuedRequest, 'id'>
}

queueDb.version(1).stores({
  requests: '++id, createdAt',
})

export function isOnline(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true
}

export async function enqueueRequest(
  req: Omit<QueuedRequest, 'id' | 'createdAt' | 'retryCount'>,
): Promise<void> {
  await queueDb.requests.add({
    ...req,
    createdAt: new Date(),
    retryCount: 0,
  })
}

export async function peekQueue(): Promise<QueuedRequest[]> {
  return queueDb.requests.orderBy('createdAt').toArray()
}

export async function removeFromQueue(id: number): Promise<void> {
  await queueDb.requests.delete(id)
}

export async function incrementRetry(id: number): Promise<void> {
  await queueDb.requests.update(id, (req) => {
    req.retryCount += 1
  })
}

export async function clearQueue(): Promise<void> {
  await queueDb.requests.clear()
}

export function listenOnline(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('online', callback)
  return () => window.removeEventListener('online', callback)
}
