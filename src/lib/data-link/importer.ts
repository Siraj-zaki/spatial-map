/**
 * SPA-side facade for the backend import pipeline.
 *
 * The real parse → resolve → preview → commit work now lives in
 * `backend/internal/handlers/import_pipeline.go`. This module just:
 *   - builds a multipart request from the picked file + ImportPlan,
 *   - unwraps the standard `{ data: ... }` response envelope,
 *   - maps the backend DTO shapes back to the local `PreviewResult` /
 *     `ImportSummary` types the UI already expects,
 *   - stamps the data-source run after a successful commit.
 */

import { apiPost } from '@/lib/api-client'
import type { Bin, ImportJob } from '@/lib/db'
import { stampSourceRun } from './source-service'
import type {
  CsvRow,
  ImportPlan,
  ImportSummary,
  PreviewResult,
  PreviewRow,
  ResolvedTarget,
} from './types'

// Backend endpoints (mounted under /api/v1 via ImportJobsRouter).
const PREVIEW_URL = '/import-jobs/preview'
const COMMIT_URL = '/import-jobs/commit'

// DTOs returned by the backend (kept private to this module).

type BackendResolvedTarget =
  | {
      status: 'matched-grid'
      gridId: number
      row: number
      col: number
      level: number
    }
  | {
      status: 'matched-shape'
      targetKind: string
      shapeId: number
    }
  | {
      status: 'will-create'
      externalCode: string
    }
  | {
      status: 'unmatched'
      reason: string
    }

interface BackendPreviewRow {
  rowIndex: number
  raw: CsvRow
  resolved: BackendResolvedTarget
  patch: Record<string, unknown>
  warnings: string[]
}

interface BackendPreviewResponse {
  rows: BackendPreviewRow[]
  totals: PreviewResult['totals']
  unknownAttributeKeys: string[]
  errors: string[]
}

interface BackendCommitResponse {
  rowsRead: number
  rowsMatched: number
  rowsImported: number
  rowsSkipped: number
  rowsErrored: number
  errors: string[]
}

// ------------------------------------------------------------------ preview
export async function previewImport(file: File, plan: ImportPlan): Promise<PreviewResult> {
  const body = new FormData()
  body.append('file', file)
  body.append('plan', JSON.stringify(toBackendPlan(plan)))

  const res = await apiPost<BackendPreviewResponse>(PREVIEW_URL, body)
  const errors = res.errors ?? []
  if (errors.length > 0) {
    console.warn('[previewImport] parser errors:', errors)
  }
  return {
    rows: (res.rows ?? []).map((r) => toPreviewRow(r)),
    totals: res.totals,
    unknownAttributeKeys: res.unknownAttributeKeys ?? [],
  }
}

/** @deprecated — alias kept for CSV-only callers during the transition. */
export const previewImportCsv = previewImport

// ------------------------------------------------------------------- commit
export async function commitImport(
  file: File,
  plan: ImportPlan,
  _preview: PreviewResult,
  sourceId: number,
): Promise<ImportSummary> {
  const body = new FormData()
  body.append('file', file)
  body.append('plan', JSON.stringify(toBackendPlan(plan)))
  body.append('sourceId', String(sourceId))

  const res = await apiPost<BackendCommitResponse>(COMMIT_URL, body)
  const summary: ImportSummary = {
    rowsRead: res.rowsRead,
    rowsMatched: res.rowsMatched,
    rowsImported: res.rowsImported,
    rowsSkipped: res.rowsSkipped,
    rowsErrored: res.rowsErrored,
    errors: res.errors,
  }

  const status: ImportJob['status'] =
    summary.rowsErrored === 0 ? 'ok' : summary.rowsImported > 0 ? 'partial' : 'error'
  await stampSourceRun(sourceId, {
    lastRunAt: new Date(),
    lastResult: status === 'ok' ? 'ok' : status === 'partial' ? 'partial' : 'error',
    updatedAt: new Date(),
  })

  return summary
}

// -------------------------------------------------------------- mapping helpers

function toBackendPlan(plan: ImportPlan): Record<string, unknown> {
  return {
    columns: plan.columns,
    match: plan.match,
    fieldMapping: plan.fieldMapping,
    zoneId: plan.zoneId,
    autoDefineAttributes: plan.autoDefineAttributes ?? false,
    sourceKind: plan.source.kind,
    sheetName: '',
    jsonRootPath: '',
  }
}

function toPreviewRow(row: BackendPreviewRow): PreviewRow {
  return {
    rowIndex: row.rowIndex,
    raw: row.raw,
    resolved: toResolvedTarget(row.resolved),
    patch: row.patch as Partial<Bin>,
    warnings: row.warnings,
  }
}

function toResolvedTarget(r: BackendResolvedTarget): ResolvedTarget {
  if (r.status === 'matched-grid') {
    return {
      status: 'matched-grid',
      gridId: r.gridId,
      row: r.row,
      col: r.col,
      level: r.level,
      existing: null,
    }
  }
  if (r.status === 'matched-shape') {
    return {
      status: 'matched-shape',
      targetKind: r.targetKind as 'polygon' | 'circle' | 'line' | 'marker' | 'image' | 'model',
      shapeId: r.shapeId,
      existing: null,
    }
  }
  if (r.status === 'will-create') {
    return {
      status: 'will-create',
      via: 'externalCode',
      externalCode: r.externalCode,
      existing: null,
    }
  }
  return { status: 'unmatched', reason: r.reason }
}
