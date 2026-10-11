/**
 * React hooks that surface the spatial store's server rows + optimistic
 * drafts to the layout editor (and the viewer).
 *
 * Each hook subscribes to ONE kind's rows and ONE kind's drafts, so editing
 * a rack hands only `useSpatialGrids` a new array — polygons, markers and
 * every other overlay keep their previous array and skip their rebuild.
 * With no drafts for a kind, the server array is returned as-is.
 */

import { useMemo } from 'react'
import { useSpatialStore, type CatalogEntity, type EntityKind, type KindDrafts } from '@/lib/spatial-store'

export type UseSpatialShapesResult<T> = {
  data: T[]
  isLoading: boolean
  error: Error | null
}

function mergeDrafts<T extends { id?: number }>(rows: T[] | undefined, drafts: KindDrafts): T[] {
  // Defensive: a stale module that pre-dates a kind can hand back undefined.
  const safeRows = rows ?? []
  if (drafts.size === 0) return safeRows
  const out: T[] = []
  for (const row of safeRows) {
    const draft = row.id === undefined ? undefined : drafts.get(row.id)
    if (!draft) out.push(row)
    else if (!draft.__deleted) out.push({ ...row, ...draft } as T)
  }
  // Creates that haven't reached the server yet (temporary negative ids).
  for (const [id, draft] of drafts) {
    if (id < 0 && !draft.__deleted) out.push(draft as unknown as T)
  }
  return out
}

type RowsKey = {
  [K in keyof ReturnType<typeof useSpatialStore.getState>]: ReturnType<typeof useSpatialStore.getState>[K] extends CatalogEntity[] ? K : never
}[keyof ReturnType<typeof useSpatialStore.getState>]

function useSpatialKind<T extends { id?: number }>(kind: EntityKind, rowsKey: RowsKey): UseSpatialShapesResult<T> {
  const rows = useSpatialStore((s) => s[rowsKey]) as unknown as T[]
  const isLoading = useSpatialStore((s) => s.isLoading[kind])
  const error = useSpatialStore((s) => s.error[kind])
  const drafts = useSpatialStore((s) => s.drafts[kind])
  const data = useMemo(() => mergeDrafts(rows, drafts), [rows, drafts])
  return { data, isLoading, error }
}

export function useSpatialZones() {
  return useSpatialKind<import('@/lib/db').Zone>('zones', 'zones')
}

export function useSpatialGrids() {
  return useSpatialKind<import('@/lib/db').Grid>('grids', 'grids')
}

export function useSpatialBins() {
  return useSpatialKind<import('@/lib/db').Bin>('bins', 'bins')
}

export function useSpatialPolygons() {
  return useSpatialKind<import('@/lib/shapes').PolygonShape>('polygons', 'polygons')
}

export function useSpatialCircles() {
  return useSpatialKind<import('@/lib/shapes').CircleShape>('circles', 'circles')
}

export function useSpatialLines() {
  return useSpatialKind<import('@/lib/shapes').LineShape>('lines', 'lines')
}

export function useSpatialRoutes() {
  return useSpatialKind<import('@/lib/shapes').RouteShape>('routes', 'routes')
}

export function useSpatialMarkers() {
  return useSpatialKind<import('@/lib/shapes').MarkerShape>('markers', 'markers')
}

export function useSpatialImages() {
  return useSpatialKind<import('@/lib/shapes').ImageShape>('images', 'images')
}

export function useSpatialModels() {
  return useSpatialKind<import('@/lib/shapes').ModelShape>('models', 'models')
}

export function useSpatialImagePlanes() {
  return useSpatialKind<import('@/lib/shapes').ImagePlaneShape>('image-planes', 'imagePlanes')
}

export function useSpatialStairs() {
  return useSpatialKind<import('@/lib/shapes').StairShape>('stairs', 'stairs')
}

export function useSpatialDoors() {
  return useSpatialKind<import('@/lib/door/types').DoorShape>('doors', 'doors')
}

export function useSpatialTextLabels() {
  return useSpatialKind<import('@/lib/shapes').TextLabelShape>('text-labels', 'textLabels')
}

export function useSpatialStyleRules() {
  return useSpatialKind<import('@/lib/style-rules/types').StyleRule>('style-rules', 'styleRules')
}

export function useSpatialDataLinks() {
  return useSpatialKind<import('@/lib/db').DataLinkConfig>('data-link-configs', 'dataLinkConfigs')
}

export function useSpatialAttributeDefinitions(_zoneId?: number) {
  return useSpatialKind<import('@/lib/db').AttributeDefinition>('attribute-definitions', 'attributeDefinitions')
}
