/**
 * Re-run a previously-committed DataSource. Reads back the URL/headers
 * (REST), drains the webhook queue, or loads the stored file bytes from
 * `source_files` for file-backed sources (csv / xlsx / json / geojson),
 * then runs the saved field mapping through the import pipeline exactly
 * like the original wizard run.
 *
 * File re-imports hit POST /api/v1/data-sources/:id/reimport, which
 * fetches the bytes the backend persisted during the original commit
 * and re-runs the parse → resolve → write loop server-side. No
 * re-upload needed.
 */

import {
  type DataSource,
  type DataSourceMapping,
  type WebhookSourceConfig,
} from '@/lib/db'
import { apiPost } from '@/lib/api-client'
import { commitImport } from './importer'
import { fetchRestSource } from './rest-fetcher'
import type { RestSourceConfig } from './rest-fetcher'
import { previewImport } from './importer'
import { purgeDataRecords } from '@/lib/data-screen-client'
import { getMergeMode, stampSourceRun } from './source-service'
import { queryCache } from '@/lib/useApiQuery'
import type {
  FieldTarget,
  ImportPlan,
  ImportSummary,
  MatchStrategy,
} from './types'
import { drainWebhookSource } from './webhook-fetcher'

export class RerunError extends Error {}

/**
 * What a finished run should record. "Rows read but none landed" is a
 * failure, not ok — e.g. a REST source with no row-key column skips every
 * row, which used to stamp `ok` and show a healthy source that imported
 * nothing.
 */
export function resultOf(summary: ImportSummary): NonNullable<DataSource['lastResult']> {
  if (summary.rowsRead === 0) return 'empty'
  if (summary.rowsImported === 0 && summary.rowsMatched === 0) return 'error'
  if (summary.rowsErrored > 0 || summary.rowsSkipped > 0) return 'partial'
  return 'ok'
}

/**
 * Re-run one data source. Returns the summary so the caller can toast
 * "Imported N rows" and update its derived state.
 */
export async function rerunDataSource(source: DataSource): Promise<ImportSummary> {
  if (source.id === undefined) {
    throw new RerunError('Source has no id — was it persisted?')
  }
  if (source.kind === 'rest') {
    return runRest(source)
  }
  if (source.kind === 'webhook') {
    return runWebhook(source)
  }
  return runReimportFile(source)
}

/**
 * Re-run a file-backed source by hitting the backend re-import
 * endpoint. The backend loads the bytes it persisted in source_files
 * during the original commit, runs them through the same pipeline,
 * and returns the summary. Throws `RerunError` when the backend has
 * no stored bytes (e.g. the source was created before persistence was
 * wired up) — the UI should prompt the user to re-upload.
 */
async function runReimportFile(source: DataSource): Promise<ImportSummary> {
  if (source.id === undefined) {
    throw new RerunError('Source has no id — was it persisted?')
  }
  interface BackendCommitResponse {
    rowsRead: number
    rowsMatched: number
    rowsImported: number
    rowsSkipped: number
    rowsErrored: number
    errors: string[]
  }
  try {
    const res = await apiPost<BackendCommitResponse>(
      `/data-sources/${source.id}/reimport`,
      {},
    )
    const summary: ImportSummary = {
      rowsRead: res.rowsRead,
      rowsMatched: res.rowsMatched,
      rowsImported: res.rowsImported,
      rowsSkipped: res.rowsSkipped,
      rowsErrored: res.rowsErrored,
      errors: res.errors,
    }
    await stampSourceRun(source.id, {
      lastRunAt: new Date(),
      lastResult: resultOf(summary),
      updatedAt: new Date(),
    })
    queryCache.invalidate('layer-rows')
    return summary
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/no stored file/i.test(msg) || /404/.test(msg)) {
      throw new RerunError(
        `No stored file for this source — re-upload from the import wizard to enable re-import.`,
      )
    }
    throw new RerunError(`Re-import failed: ${msg}`)
  }
}

async function runRest(source: DataSource): Promise<ImportSummary> {
  const config = source.config as unknown as RestSourceConfig
  if (typeof config?.url !== 'string') {
    throw new RerunError('REST source is missing a URL.')
  }
  const file = await fetchRestSource(config)
  const plan = planFromMapping(source.mapping, file.name, file.size, source.entityKind)
  const preview = await previewImport(file, plan)

  // `mergeMode: 'replace-all'` treats the REST endpoint as the source
  // of truth on every poll — purge the existing rows first so the
  // fresh ingest replaces (rather than appends to) whatever was
  // stored before. Legacy sources with no mergeMode default to
  // 'append', matching the pre-mergeMode behaviour of the pipeline.
  //
  // Purge runs BEFORE commit so a failed fetch/parse leaves the
  // previous rows intact — surprises less than a "cleared everything
  // and then blew up" outcome.
  if (getMergeMode(source) === 'replace-all' && source.id !== undefined) {
    try {
      await purgeDataRecords('rows', { sourceId: source.id })
    } catch (err) {
      throw new RerunError(
        `Could not purge existing rows before replace-all import: ${(err as Error).message}`,
      )
    }
  }

  const summary = await commitImport(file, plan, preview, source.id!)
  // Stamp the last-run timestamp so the sidebar can show "synced 5m ago".
  await stampSourceRun(source.id!, {
    lastRunAt: new Date(),
    lastResult: resultOf(summary),
  })
  // Nudge every `useApiQuery(['layer-rows', …])` in the tab to refetch
  // NOW instead of waiting for its 30s poll to tick. This is what
  // makes scheduled ingests show up instantly on the map without the
  // overlay having to poll aggressively.
  queryCache.invalidate('layer-rows')
  return summary
}

/**
 * Drain a webhook source's queue and import any events it returned. A
 * quiet tick (no events) stamps `lastResult: 'empty'` and returns a
 * zero-row summary so the scheduler's backoff counter doesn't trip on
 * "nothing happened".
 */
async function runWebhook(source: DataSource): Promise<ImportSummary> {
  const config = source.config as unknown as WebhookSourceConfig
  if (typeof config?.workerBaseUrl !== 'string' || typeof config.sourceToken !== 'string') {
    throw new RerunError('Webhook source is missing workerBaseUrl or sourceToken.')
  }
  const drained = await drainWebhookSource(config)
  const now = new Date()
  if (drained === null) {
    await stampSourceRun(source.id!, {
      lastRunAt: now,
      lastResult: 'empty',
    })
    return {
      rowsRead: 0,
      rowsMatched: 0,
      rowsImported: 0,
      rowsSkipped: 0,
      rowsErrored: 0,
      errors: [],
    }
  }
  const plan = planFromMapping(source.mapping, drained.file.name, drained.file.size, source.entityKind)
  const preview = await previewImport(drained.file, plan)
  const summary = await commitImport(drained.file, plan, preview, source.id!)
  // Stamp lastEventAt inside the config blob so the sidebar can show
  // "Last event 2m ago" independently of "last polled".
  const nextConfig: WebhookSourceConfig = {
    ...config,
    lastEventAt: drained.lastReceivedAt ? new Date(drained.lastReceivedAt) : new Date(),
  }
  await stampSourceRun(source.id!, {
    config: nextConfig as unknown as Record<string, unknown>,
    lastRunAt: now,
    lastResult: resultOf(summary),
    updatedAt: now,
  })
  queryCache.invalidate('layer-rows')
  return summary
}

/**
 * Reconstruct an ImportPlan from a saved DataSourceMapping. The wire
 * format on disk uses prefixed strings (`match.externalCode`,
 * `bin.sku`, `prop.batch`) — convert them back into the typed
 * MatchStrategy + per-column FieldTarget shape the resolver expects.
 *
 * v3 sources (entity_kind != 'rack-cell') don't need a saved mapping —
 * the backend's `writeOneRow` uses the raw row payload verbatim. When
 * the caller passes `entityKind`, we synthesise a minimal
 * externalCode-based plan so the pipeline still validates.
 */
function planFromMapping(
  mapping: DataSourceMapping,
  fileName: string,
  fileSize: number,
  entityKind?: DataSource['entityKind'],
): ImportPlan {
  let match: MatchStrategy | null = null
  const fieldMapping: Record<string, FieldTarget> = {}
  const columns = Object.keys(mapping.fields)

  for (const [column, target] of Object.entries(mapping.fields)) {
    if (target.startsWith('match.')) {
      const subtype = target.slice('match.'.length)
      // The shapeName writer encodes the shape kind as a `:kind` suffix
      // (e.g. `match.shapeName:polygon`). Split on the first colon so the
      // detection branches still match the canonical mode literal.
      const [head, suffix] = subtype.split(':', 2) as [string, string | undefined]
      if (head === 'externalCode') {
        match = { mode: 'externalCode', column }
      } else if (head === 'binLabel') {
        match = { mode: 'binLabel', column }
      } else if (head === 'shapeName') {
        const kind = (suffix && ['polygon', 'circle', 'line', 'marker', 'image', 'model'].includes(suffix))
          ? (suffix as 'polygon' | 'circle' | 'line' | 'marker' | 'image' | 'model')
          : 'polygon'
        match = { mode: 'shapeName', column, kind }
      }
      // gridCellAddress would need extra columns; not yet round-tripped.
      continue
    }
    if (target.startsWith('bin.')) {
      const field = target.slice('bin.'.length) as
        | 'externalCode' | 'sku' | 'capacity' | 'notes' | 'status'
      fieldMapping[column] = { kind: 'builtin', field }
      continue
    }
    if (target.startsWith('prop.')) {
      fieldMapping[column] = { kind: 'custom', key: target.slice('prop.'.length) }
      continue
    }
    fieldMapping[column] = { kind: 'ignore' }
  }

  if (!match) {
    if (entityKind && entityKind !== 'rack-cell') {
      // v3 — no saved mapping is fine. Synthesize a placeholder match
      // that the backend's `writeOneRow` will ignore (it uses raw row
      // fields directly). The pipeline still validates because Match
      // has one of the accepted modes.
      match = { mode: 'externalCode', column: 'external_code' }
    } else {
      throw new RerunError('Saved mapping has no match column — can\'t re-run automatically.')
    }
  }

  return {
    source: { kind: 'json', name: fileName, size: fileSize },
    columns,
    match,
    fieldMapping,
    zoneId: mapping.zoneId,
    autoDefineAttributes: true,
  }
}
