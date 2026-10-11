/**
 * ai-accept — turn an accepted AIDetection into a real spatial-store
 * row via the existing apiDb.<kind>.add path, matching how each of
 * the four kinds is normally created in-editor.
 *
 * Kind → apiDb mapping (matches the toolbar's mental model, see
 * public/locales/en/translation.json's "layerLine: Aisles / lines"):
 *   - aisle  → `lines`   (aisles ARE lines in this project)
 *   - area   → `polygons`
 *   - door   → `doors`
 *   - stair  → `stairs`
 *
 * Model output is heterogeneous — Qwen3-VL might return an aisle as a
 * line, a polygon, or a rect. Each kind's handler is permissive: it
 * pulls out whatever geometry it can use and returns `error` when the
 * shape is unusable (e.g. a point can't become an area). Errors are
 * surfaced in the review dialog per detection so the user knows why
 * something didn't materialize instead of silently vanishing.
 *
 * Fires each apiDb.add() sequentially inside the caller's Promise.all
 * — matching how magic-wall commits ~dozens of walls in one batch.
 * queryCache.invalidate is the CALLER's responsibility (once per kind
 * touched, not once per detection) so a large accept-all doesn't
 * trigger N redundant reloads.
 */

import { apiDb } from './api-db'
import type { AIDetection } from './ai-client'
import type { LengthUnit } from './units'
import {
  DEFAULT_FILL_CONFIG,
  DEFAULT_LINE_CONFIG,
  DEFAULT_STAIR_CONFIG,
} from './shapes'
import { DEFAULT_DOOR_CONFIG } from './door/types'
import type { EntityKind } from './spatial-store'

export interface AcceptContext {
  /** Warehouse (zone) id to assign the new row to. Required — a shape
   *  without a zone is invisible everywhere the editor filters by zone. */
  zoneId: number
  /** Floor-plan (image) id the AI job was run against. Wired so the new
   *  shape follows the image's visibility toggle. */
  floorPlanId?: number
  /** Display unit stamped on the row (mirrors what all other draw tools do). */
  unit: LengthUnit
}

export interface AcceptResult {
  detectionId: string
  kind: AIDetection['kind']
  /** Newly-created row id — only present on success. */
  createdId?: number
  /** Kind that got written (matches EntityKind for queryCache.invalidate). */
  writtenAs?: Extract<EntityKind, 'lines' | 'polygons' | 'doors' | 'stairs'>
  /** Human-readable reason we couldn't accept this detection. Null on success. */
  error: string | null
}

/**
 * Accept one detection. Never throws — every failure mode is captured
 * in `AcceptResult.error`. The caller shows the message inline in the
 * review dialog.
 */
export async function acceptDetection(
  det: AIDetection,
  ctx: AcceptContext,
): Promise<AcceptResult> {
  try {
    switch (det.kind) {
      case 'aisle':
        return await acceptAisle(det, ctx)
      case 'area':
        return await acceptArea(det, ctx)
      case 'door':
        return await acceptDoor(det, ctx)
      case 'stair':
        return await acceptStair(det, ctx)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { detectionId: det.id, kind: det.kind, error: `create failed: ${msg}` }
  }
}

// ---------------------------------------------------------------------------
// Per-kind handlers
// ---------------------------------------------------------------------------

async function acceptAisle(det: AIDetection, ctx: AcceptContext): Promise<AcceptResult> {
  const vertices = extractPolyline(det)
  if (vertices.length < 2) {
    return { detectionId: det.id, kind: det.kind, error: 'aisle needs 2+ points; model returned less' }
  }
  const now = new Date()
  const id = await apiDb.lines.add({
    name: labelOrDefault(det.label, 'Aisle'),
    unit: ctx.unit,
    visible: true,
    zoneId: ctx.zoneId,
    floorPlanId: ctx.floorPlanId,
    vertices,
    rotation: 0,
    config: { ...DEFAULT_LINE_CONFIG },
    createdAt: now,
    updatedAt: now,
  })
  return { detectionId: det.id, kind: det.kind, createdId: id as number, writtenAs: 'lines', error: null }
}

async function acceptArea(det: AIDetection, ctx: AcceptContext): Promise<AcceptResult> {
  const ring = extractPolygonRing(det)
  if (ring.length < 3) {
    return { detectionId: det.id, kind: det.kind, error: 'area needs 3+ vertex ring; model returned less' }
  }
  const now = new Date()
  const id = await apiDb.polygons.add({
    name: labelOrDefault(det.label, 'Area'),
    unit: ctx.unit,
    visible: true,
    zoneId: ctx.zoneId,
    floorPlanId: ctx.floorPlanId,
    vertices: ring,
    rotation: 0,
    // role stays unset — the tenant's roleVocabulary drives the picker
    // and we don't know their labels. Users can classify after accept.
    config: { ...DEFAULT_FILL_CONFIG },
    createdAt: now,
    updatedAt: now,
  })
  return { detectionId: det.id, kind: det.kind, createdId: id as number, writtenAs: 'polygons', error: null }
}

async function acceptDoor(det: AIDetection, ctx: AcceptContext): Promise<AcceptResult> {
  const jambs = extractPointPair(det)
  if (!jambs) {
    return { detectionId: det.id, kind: det.kind, error: 'door needs 2 jamb points; model returned an unusable shape' }
  }
  const now = new Date()
  const id = await apiDb.doors.add({
    name: labelOrDefault(det.label, 'Door'),
    unit: ctx.unit,
    visible: true,
    zoneId: ctx.zoneId,
    floorPlanId: ctx.floorPlanId,
    vertices: jambs,
    rotation: 0,
    config: { ...DEFAULT_DOOR_CONFIG },
    createdAt: now,
    updatedAt: now,
  })
  return { detectionId: det.id, kind: det.kind, createdId: id as number, writtenAs: 'doors', error: null }
}

async function acceptStair(det: AIDetection, ctx: AcceptContext): Promise<AcceptResult> {
  const anchors = extractPointPair(det)
  if (!anchors) {
    return { detectionId: det.id, kind: det.kind, error: 'stair needs 2 anchor points (bottom+top); model returned an unusable shape' }
  }
  const now = new Date()
  const id = await apiDb.stairs.add({
    name: labelOrDefault(det.label, 'Stairs'),
    unit: ctx.unit,
    visible: true,
    zoneId: ctx.zoneId,
    floorPlanId: ctx.floorPlanId,
    vertices: anchors,
    rotation: 0,
    config: { ...DEFAULT_STAIR_CONFIG },
    createdAt: now,
    updatedAt: now,
  })
  return { detectionId: det.id, kind: det.kind, createdId: id as number, writtenAs: 'stairs', error: null }
}

// ---------------------------------------------------------------------------
// Geometry extractors — permissive by design
// ---------------------------------------------------------------------------

/** For aisle/stair — a 2+ vertex ordered list. Polygons collapse to
 *  their boundary; rects use their 4 corners as a walk. */
function extractPolyline(det: AIDetection): [number, number][] {
  const coords = det.geometry.coords
  switch (det.geometry.type) {
    case 'line':
      return coords as [number, number][]
    case 'polygon':
      return dedupeClosingPoint(coords as [number, number][])
    case 'rect':
      if (coords.length < 2) return []
      return rectRing(coords[0], coords[1])
    case 'point':
      return []
  }
}

/** For area — a 3+ vertex closed ring. */
function extractPolygonRing(det: AIDetection): [number, number][] {
  const coords = det.geometry.coords
  switch (det.geometry.type) {
    case 'polygon':
      return dedupeClosingPoint(coords as [number, number][])
    case 'rect':
      if (coords.length < 2) return []
      return rectRing(coords[0], coords[1])
    case 'line':
    case 'point':
      return []
  }
}

/** For door/stair — exactly 2 anchor points. */
function extractPointPair(det: AIDetection): [[number, number], [number, number]] | null {
  const coords = det.geometry.coords
  switch (det.geometry.type) {
    case 'line': {
      if (coords.length < 2) return null
      // Use the polyline's endpoints — for a doorway detected as a
      // multi-segment line, the two jambs are at the extremes.
      const a = coords[0]
      const b = coords[coords.length - 1]
      return [[a[0], a[1]], [b[0], b[1]]]
    }
    case 'rect': {
      if (coords.length < 2) return null
      // Take the two opposite corners — for a narrow door detected as
      // a small rect, this is the diagonal, which is close enough to
      // the jamb axis for a first-pass user review + nudge.
      return [[coords[0][0], coords[0][1]], [coords[1][0], coords[1][1]]]
    }
    case 'polygon': {
      if (coords.length < 2) return null
      // Two farthest-apart vertices — the "long axis" heuristic.
      // Cheap O(n^2) is fine for the small polygons the model emits.
      let best: [number, number][] | null = null
      let bestD = -1
      for (let i = 0; i < coords.length; i++) {
        for (let j = i + 1; j < coords.length; j++) {
          const d = dist2(coords[i], coords[j])
          if (d > bestD) {
            bestD = d
            best = [coords[i] as [number, number], coords[j] as [number, number]]
          }
        }
      }
      if (!best) return null
      return [best[0], best[1]]
    }
    case 'point':
      return null
  }
}

function dedupeClosingPoint(ring: [number, number][]): [number, number][] {
  if (ring.length < 2) return ring
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1)
  return ring
}

function rectRing(a: [number, number] | number[], b: [number, number] | number[]): [number, number][] {
  const minLng = Math.min(a[0], b[0])
  const maxLng = Math.max(a[0], b[0])
  const minLat = Math.min(a[1], b[1])
  const maxLat = Math.max(a[1], b[1])
  return [
    [minLng, maxLat],
    [maxLng, maxLat],
    [maxLng, minLat],
    [minLng, minLat],
  ]
}

function dist2(a: number[], b: number[]): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

function labelOrDefault(label: string | undefined, fallback: string): string {
  const t = (label ?? '').trim()
  return t.length > 0 ? t : fallback
}
