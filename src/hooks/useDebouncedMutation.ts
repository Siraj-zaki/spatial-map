/**
 * Debounced mutation hook for map interactions.
 *
 * Dragging / rotating / scaling a shape produces many small updates. This hook
 * accumulates the latest patch and only sends one backend call after the user
 * stops interacting for `delayMs`. If a mutation is currently in flight, the
 * next change is queued and sent as soon as the in-flight call finishes.
 *
 * Usage:
 *   const patch = useDebouncedMutation({
 *     kind: 'images',
 *     id: imageId,
 *     delayMs: 250,
 *   })
 *   patch({ rotation: newRotation })
 *
 * Internally it writes optimistically to the spatial store and flushes to the
 * backend after the debounce window. On error the spatial store rolls back.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import debounce from 'lodash-es/debounce'
import { useSpatialStore, type EntityKind, type CatalogEntity } from '@/lib/spatial-store'

export interface UseDebouncedMutationOptions {
  kind: EntityKind
  id?: number
  delayMs?: number
  onError?: (err: unknown) => void
  onSuccess?: () => void
}

export function useDebouncedMutation<T extends CatalogEntity = CatalogEntity>(
  options: UseDebouncedMutationOptions,
) {
  const { kind, id, delayMs = 250, onError, onSuccess } = options
  const updateLocal = useSpatialStore((s) => s.updateLocal)
  const commit = useSpatialStore((s) => s.commit)
  const [isSaving, setIsSaving] = useState(false)

  // Accumulate patches across rapid calls.
  const accRef = useRef<Partial<T>>({})
  const inFlightRef = useRef<Promise<void> | null>(null)
  const flushRef = useRef<ReturnType<typeof debounce> | null>(null)

  useEffect(() => {
    flushRef.current = debounce(async () => {
      if (id === undefined) return
      const patch = { ...accRef.current }
      accRef.current = {}

      // Apply optimistically now (if not already applied by updateLocal callers).
      updateLocal(kind, id, patch)

      setIsSaving(true)
      try {
        if (inFlightRef.current) {
          await inFlightRef.current
        }
        const promise = commit(kind, id)
        inFlightRef.current = promise
        await promise
        onSuccess?.()
      } catch (err) {
        onError?.(err)
      } finally {
        inFlightRef.current = null
        setIsSaving(false)
      }
    }, delayMs, { leading: false, trailing: true })

    return () => {
      flushRef.current?.flush()
      flushRef.current?.cancel()
    }
  }, [kind, id, delayMs, updateLocal, commit, onError, onSuccess])

  const patch = useCallback(
    (next: Partial<T>) => {
      // Optimistically update local store immediately.
      if (id !== undefined) {
        updateLocal(kind, id, next)
      }
      // Accumulate for the debounced backend write.
      accRef.current = { ...accRef.current, ...next }
      flushRef.current?.()
    },
    [kind, id, updateLocal],
  )

  return { patch, isSaving }
}
