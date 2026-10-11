/**
 * Where each explorer row sits on the map.
 *
 * - Facility tabs: the row IS a shape (entity_key "markers:57").
 * - Linked-data tabs: the row is a data record; the data link's own
 *   matching rules place it (resolveMatchTargets — the same code the live
 *   map uses), on a shape (attribute join / explicit shape) or at a
 *   coordinate. Its floor comes from the shape, else the link's floor
 *   scope (floor field + value map).
 */

import type { DataLinkConfig } from '@/lib/db'
import { resolveMatchTargets, type MatchStoreSnapshot } from '@/lib/data-link/match-resolver'
import { resolveEntityFloor } from '@/lib/data-link/filter-evaluator'
import { findShape, parseEntityKey, type ExplorerShape } from './explorer-geometry'
import type { ExplorerShapes } from './explorer-geometry'

export interface Placement {
  shape: ExplorerShape | null
  point: [number, number] | null
  floor: number | null
}

const NOWHERE: Placement = { shape: null, point: null, floor: null }

/** Data-link target kind → explorer shape kind (null = not drawable here). */
function targetToExplorer(targetKind: string, shape: unknown): ExplorerShape | null {
  switch (targetKind) {
    case 'polygon': return { kind: 'polygons', shape } as ExplorerShape
    case 'marker': return { kind: 'markers', shape } as ExplorerShape
    case 'line': return { kind: 'lines', shape } as ExplorerShape
    case 'stair': return { kind: 'stairs', shape } as ExplorerShape
    case 'door': return { kind: 'doors', shape } as ExplorerShape
    case 'image': return { kind: 'images', shape } as ExplorerShape
    case 'model': return { kind: 'models', shape } as ExplorerShape
    case 'text-label': return { kind: 'text-labels', shape } as ExplorerShape
    default: return null
  }
}

/** Shape kind a data link's rows land on (for map clicks), else null. */
export function linkShapeKind(link: DataLinkConfig | undefined): ExplorerShape['kind'] | null {
  if (!link) return null
  return targetToExplorer(link.targetKind, {})?.kind ?? null
}

export function facilityPlacement(shapes: ExplorerShapes, row: Record<string, unknown> & { entity_key: string }): Placement {
  const ref = parseEntityKey(row.entity_key)
  const floor = ref?.kind === 'images' ? ref.id : Number(row.floor_id) > 0 ? Number(row.floor_id) : null
  return { shape: findShape(shapes, row.entity_key), point: null, floor }
}

export function dataPlacement(
  link: DataLinkConfig | undefined,
  snapshot: MatchStoreSnapshot,
  row: Record<string, unknown>,
): Placement {
  if (!link) return NOWHERE
  const scope = link.fieldMapping?.floorScope
  const payloadFloor = () => resolveEntityFloor(row, null, { field: scope?.field, valueMap: scope?.valueMap })
  let res
  try {
    res = resolveMatchTargets(row, link, snapshot)
  } catch {
    return NOWHERE
  }
  if (res.kind === 'coord') return { shape: null, point: res.position, floor: payloadFloor() }
  if (res.kind === 'shapes' && res.shapes.length > 0) {
    // Same name on several floors: prefer the one on the row's floor.
    const want = payloadFloor()
    const s = res.shapes.find((x) => want !== null && (x as { floorPlanId?: number }).floorPlanId === want) ?? res.shapes[0]
    const shape = targetToExplorer(link.targetKind, s)
    return { shape, point: null, floor: (s as { floorPlanId?: number }).floorPlanId ?? want }
  }
  return NOWHERE
}
