import { useCallback } from 'react'

import type { SavedListKind } from '@/components/side-panel'
import { useSpatialStore, type EntityKind } from '@/lib/spatial-store'

const STORE_KIND: Record<SavedListKind, EntityKind> = {
  grid: 'grids',
  marker: 'markers',
  circle: 'circles',
  polygon: 'polygons',
  line: 'lines',
  route: 'routes',
  model: 'models',
  imagePlane: 'image-planes',
  stair: 'stairs',
  textLabel: 'text-labels',
}

/**
 * Hide / show many shapes of one kind at once — the saved lists' bulk
 * toolbar. One store update and one save for the lot (a per-row toggle
 * commits each row on its own, which is slow for a few hundred walls).
 */
export function useSavedListBulk() {
  const handleBulkSetVisible = useCallback((kind: SavedListKind, ids: number[], visible: boolean) => {
    if (ids.length === 0) return
    const store = useSpatialStore.getState()
    const now = new Date()
    store.updateManyLocal(
      STORE_KIND[kind],
      ids.map((id) => [id, { visible, updatedAt: now }] as const),
    )
    void store.flush()
  }, [])
  return { handleBulkSetVisible }
}
