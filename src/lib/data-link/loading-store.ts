/**
 * v4 — global data-link "which layers are loading" store.
 *
 * Every sub-renderer of `MapDataLinkedOverlay` reports its
 * `useApiQuery.isLoading` state here keyed by config id, together with
 * whether the layer already has rows (`refreshing`). The
 * `DataLinkFullScreenLoader` component reads the aggregate: the viewer's
 * full-screen card covers only layers with no rows yet, the editor's
 * non-blocking pill covers every load.
 *
 * Why a Zustand store instead of a React context: contexts trigger
 * consumers to re-render on every write, which would mean every
 * layer-loading toggle wakes up every sub-renderer. Zustand's
 * subscribe-with-selector semantics let the loader listen to only the
 * count (or the set) without touching the sub-renderers.
 */

import { create } from 'zustand'

interface LoadingEntry {
  configId: number
  configName: string
  /** A refetch of a layer that already has rows (its `data` is defined). */
  refreshing: boolean
}

interface DataLinkLoadingState {
  loading: Map<number, LoadingEntry>
  setLoading: (configId: number, configName: string, on: boolean, refreshing?: boolean) => void
  clearLoadingForConfig: (configId: number) => void
}

export const useDataLinkLoadingStore = create<DataLinkLoadingState>((set) => ({
  loading: new Map(),
  setLoading: (configId, configName, on, refreshing = false) =>
    set((state) => {
      const prev = state.loading.get(configId)
      // Unchanged → keep the same state, so no listener (the loader) wakes.
      if (on ? prev?.configName === configName && prev.refreshing === refreshing : !prev) return state
      const next = new Map(state.loading)
      if (on) {
        next.set(configId, { configId, configName, refreshing })
      } else {
        next.delete(configId)
      }
      return { loading: next }
    }),
  clearLoadingForConfig: (configId) =>
    set((state) => {
      if (!state.loading.has(configId)) return state
      const next = new Map(state.loading)
      next.delete(configId)
      return { loading: next }
    }),
}))

/**
 * Convenience hook for sub-renderers. Reports the (isLoading) state of
 * `useApiQuery` back to the global store; `hasData` is whether the query
 * already holds rows (`data !== undefined`), so a refetch can be told
 * apart from a first load. On unmount, clears the entry so a torn-down
 * layer doesn't leak into the aggregate.
 */
import { useEffect } from 'react'

export function useLayerLoading(
  configId: number | undefined,
  configName: string,
  isLoading: boolean,
  hasData = false,
): void {
  const set = useDataLinkLoadingStore((s) => s.setLoading)
  const clear = useDataLinkLoadingStore((s) => s.clearLoadingForConfig)
  useEffect(() => {
    if (configId === undefined) return
    set(configId, configName, isLoading, hasData)
    return () => {
      clear(configId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configId, isLoading, hasData])
}
