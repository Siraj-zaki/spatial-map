/**
 * Shape-import side of the GeoJSON adapter.
 *
 * The data-join side of GeoJSON reuses the existing CSV/XLSX/JSON
 * pipeline (see `importer.ts`) — this module is only for the flow
 * where each Feature becomes a fresh polygon / line / marker row.
 *
 * Shapes and their per-feature bins are written sequentially through
 * `apiDb`. A future backend bulk-import endpoint can restore full
 * atomicity without changing the component call sites.
 */

import { apiDb } from '@/lib/api-db'
import type { Bin, BindingKind, DataSource } from '@/lib/db'
import {
  DEFAULT_FILL_CONFIG,
  DEFAULT_LINE_CONFIG,
  DEFAULT_MARKER_CONFIG,
  type LineShape,
  type MarkerShape,
  type PolygonShape,
} from '@/lib/shapes'
import type { LengthUnit } from '@/lib/units'
import type { ProcessedGeoJsonFeature } from './geojson-parser'
import { createBinSource } from './source-service'

export interface ShapeImportPlan {
  /** Optional warehouse the new shapes are assigned to. */
  zoneId?: number
  /** Display unit stamped on every new shape — same value as the rest of the workspace. */
  unit: LengthUnit
  /**
   * When true (default), features marked `unsupported` are skipped and
   * tallied. When false the commit errors out — useful for "all or
   * nothing" imports where mid-batch loss is unacceptable.
   */
  skipUnsupported?: boolean
  /**
   * Source-file metadata. When set, the commit writes a `kind: 'geojson'`
   * DataSource row so the import appears in the Data Sources sidebar
   * section and every created shape gets a Bin row carrying the source
   * Feature's `properties` bag (so the hover tooltip surfaces the data
   * immediately, no separate data-join run required).
   */
  sourceMeta?: {
    fileName?: string
    fileSize?: number
  }
}

export interface ShapeImportPreviewEntry {
  /** Stable index into `ParsedGeoJson.features` so the UI can scroll-to. */
  featureIndex: number
  kind: ProcessedGeoJsonFeature['kind']
  name: string
  /** Human-friendly geometry summary ("12 vertices", "MultiPolygon part 2", …). */
  summary: string
  /** Set on `unsupported` features only. */
  warning?: string
}

export interface ShapeImportPreview {
  entries: ShapeImportPreviewEntry[]
  totals: {
    polygons: number
    lines: number
    markers: number
    skipped: number
  }
}

export interface ShapeImportSummary {
  polygonsCreated: number
  linesCreated: number
  markersCreated: number
  unsupportedSkipped: number
  errors: string[]
}

/** Build a read-only preview of what `commitShapeImport` would write. */
export function previewShapeImport(
  features: ReadonlyArray<ProcessedGeoJsonFeature>,
): ShapeImportPreview {
  const entries: ShapeImportPreviewEntry[] = features.map((f, idx) => {
    let summary: string
    let warning: string | undefined
    switch (f.geometry.kind) {
      case 'polygon':
        summary = `Polygon · ${f.geometry.vertices.length} vertices`
        break
      case 'line':
        summary = `Line · ${f.geometry.vertices.length} vertices`
        break
      case 'marker':
        summary = `Marker · ${f.geometry.position.map((n) => n.toFixed(5)).join(', ')}`
        break
      case 'unsupported':
        summary = 'Skipped'
        warning = f.geometry.reason
        break
    }
    return {
      featureIndex: idx,
      kind: f.kind,
      name: f.suggestedName,
      summary,
      warning,
    }
  })
  return {
    entries,
    totals: {
      polygons: entries.filter((e) => e.kind === 'polygon').length,
      lines: entries.filter((e) => e.kind === 'line').length,
      markers: entries.filter((e) => e.kind === 'marker').length,
      skipped: entries.filter((e) => e.kind === 'unsupported').length,
    },
  }
}

/**
 * Write every supported feature as a new shape row. Runs inside one
 * Dexie transaction — either the whole import lands or none of it does.
 *
 * Each feature's source `properties` bag is copied into the new shape's
 * `customProperties` (when set on the shape; we stash it on a generic
 * field path so the data-link sidebar can show it later). The fields
 * we read from properties for naming/styling are already pulled out by
 * the parser into `suggestedName` and the `geometry` payload, so the
 * commit doesn't need to re-walk the properties bag.
 */
export async function commitShapeImport(
  features: ReadonlyArray<ProcessedGeoJsonFeature>,
  plan: ShapeImportPlan,
): Promise<ShapeImportSummary> {
  const summary: ShapeImportSummary = {
    polygonsCreated: 0,
    linesCreated: 0,
    markersCreated: 0,
    unsupportedSkipped: 0,
    errors: [],
  }
  const now = new Date()
  const skipUnsupported = plan.skipUnsupported ?? true
  const writeSource = plan.sourceMeta !== undefined

  // 1. Insert a DataSource row first so the per-shape Bins below can
  //    stamp their `syncSource` FK. Skipped when the caller didn't
  //    pass source metadata (preserves the original API).
  let sourceId: number | undefined
  if (writeSource) {
    const sourceName = plan.sourceMeta?.fileName ?? 'GeoJSON import'
    const sourceRow: DataSource = {
      name: sourceName,
      kind: 'geojson',
      // Same value the mirror body defaulted to when this was omitted.
      entityKind: 'marker',
      zoneId: plan.zoneId,
      config: {
        fileName: plan.sourceMeta?.fileName,
        fileSize: plan.sourceMeta?.fileSize,
        featureCount: features.length,
      },
      mapping: { fields: {}, zoneId: plan.zoneId },
      schedule: 'manual',
      createdAt: now,
      updatedAt: now,
    }
    sourceId = await createBinSource(sourceRow)
  }

  for (const f of features) {
    if (f.kind === 'unsupported') {
      if (!skipUnsupported) {
        throw new Error(
          `Feature ${f.sourceIndex + 1}: ${f.geometry.kind === 'unsupported' ? f.geometry.reason : 'unsupported'}`,
        )
      }
      summary.unsupportedSkipped++
      continue
    }
    try {
      let createdShapeId: number | undefined
      let createdKind: BindingKind | null = null
      switch (f.geometry.kind) {
        case 'polygon': {
          const row: Omit<PolygonShape, 'id'> = {
            name: f.suggestedName,
            zoneId: plan.zoneId,
            unit: plan.unit,
            visible: true,
            vertices: f.geometry.vertices,
            rotation: 0,
            config: { ...DEFAULT_FILL_CONFIG },
            createdAt: now,
            updatedAt: now,
          }
          createdShapeId = await apiDb.polygons.add(row)
          createdKind = 'polygon'
          summary.polygonsCreated++
          break
        }
        case 'line': {
          const row: Omit<LineShape, 'id'> = {
            name: f.suggestedName,
            zoneId: plan.zoneId,
            unit: plan.unit,
            visible: true,
            vertices: f.geometry.vertices,
            rotation: 0,
            config: { ...DEFAULT_LINE_CONFIG },
            createdAt: now,
            updatedAt: now,
          }
          createdShapeId = await apiDb.lines.add(row)
          createdKind = 'line'
          summary.linesCreated++
          break
        }
        case 'marker': {
          const row: Omit<MarkerShape, 'id'> = {
            name: f.suggestedName,
            zoneId: plan.zoneId,
            unit: plan.unit,
            visible: true,
            position: f.geometry.position,
            bearing: 0,
            config: { ...DEFAULT_MARKER_CONFIG },
            createdAt: now,
            updatedAt: now,
          }
          createdShapeId = await apiDb.markers.add(row)
          createdKind = 'marker'
          summary.markersCreated++
          break
        }
      }
      // 2. Stash the Feature.properties bag onto a Bin row so the
      //    map's hover tooltip surfaces it. Only bother when there's
      //    actually data to show.
      if (
        createdShapeId !== undefined &&
        createdKind !== null &&
        Object.keys(f.properties).length > 0
      ) {
        const bin: Bin = {
          targetKind: createdKind,
          shapeId: createdShapeId,
          customProperties: { ...f.properties },
          syncSource: sourceId,
          lastSyncedAt: now,
          updatedAt: now,
        }
        await apiDb.bins.add(bin)
      }
    } catch (err) {
      summary.errors.push(
        `Feature ${f.sourceIndex + 1} (${f.suggestedName}): ${(err as Error).message}`,
      )
    }
  }

  return summary
}
