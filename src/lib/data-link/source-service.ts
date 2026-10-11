/**
 * Phase 0 CRUD service for bin-source rows.
 *
 * Every existing call site that used to do `db.dataSources.add/update/
 * delete` now goes through here. The service performs the multi-table
 * write atomically on the backend via `/data-sources/with-mirror`, which
 * creates/updates/deletes the DataSource and its mirrored Connection +
 * Stream in a single Postgres transaction.
 *
 * Reads still go through `apiDb.dataSources` for Phase 0; nothing else
 * needs to change in calling code. Phase 1+ entity types (Asset,
 * Sensor, …) will bypass this file entirely and write directly to
 * `streams` + `connections`.
 */

import { apiDelete, apiPatch, apiPost, ApiError } from '@/lib/api-client'
import { apiDb } from '@/lib/api-db'
import { queryCache } from '@/lib/useApiQuery'
import { type DataSource } from '@/lib/db'

/**
 * Thrown by `deleteBinSource` when the backend refuses because the
 * integration is still wired to one or more warehouse data-link
 * configs. UI catches this and lists the linked configs so the user
 * knows exactly what to remove first.
 */
export interface LinkedDataLinkConfigRef {
  id: number
  name: string
  zoneId: number
  zoneName: string
}

export class IntegrationLinkedError extends Error {
  readonly linkedConfigs: LinkedDataLinkConfigRef[]
  constructor(message: string, linkedConfigs: LinkedDataLinkConfigRef[]) {
    super(message)
    this.name = 'IntegrationLinkedError'
    this.linkedConfigs = linkedConfigs
  }
}

export function isIntegrationLinkedError(
  err: unknown,
): err is IntegrationLinkedError {
  return err instanceof IntegrationLinkedError
}

/**
 * Format an `IntegrationLinkedError` for display in an inline error
 * banner. Accepts the caller's `t` function so the string is locale-
 * aware. Output is intentionally multi-line — the wrapping error slot
 * in both the Integrations card and the sidebar row uses `whitespace-
 * pre-line` (see below) so `\n` renders as a break.
 */
export function formatIntegrationLinkedMessage(
  err: IntegrationLinkedError,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const list = err.linkedConfigs
    .map((c) => `• "${c.name}" — warehouse "${c.zoneName}"`)
    .join('\n')
  return t('integrations.deleteBlocked', {
    defaultValue:
      'This integration is still linked to the following data-link configs on warehouses:\n{{list}}\n\nOpen each warehouse, delete or unlink the config, then try again.',
    list,
  })
}

// ================================================================ CRUD

/** Atomic add: writes DataSource + Connection + Stream together. */
export async function createBinSource(
  input: Omit<DataSource, 'id'>,
): Promise<number> {
  const body = dataSourceToMirrorBody(input)
  const res = await apiPost<{ dataSource: { id: number } }>(
    '/data-sources/with-mirror',
    body,
  )
  invalidateDataLink()
  return res.dataSource.id
}

/**
 * Atomic update: applies patch to DataSource then mirrors to Stream +
 * Connection. The full updated row is re-projected each time so any
 * field can change without the service needing to know which one.
 */
export async function updateBinSource(
  id: number,
  patch: Partial<DataSource>,
): Promise<void> {
  const existing = await apiDb.dataSources.get(id)
  if (!existing) return
  const updated: DataSource = { ...existing, ...patch, id }
  await apiPatch(`/data-sources/${id}/with-mirror`, dataSourceToMirrorBody(updated))
  invalidateDataLink()
}

/**
 * Atomic hard-delete: removes the DataSource + mirror Stream +
 * Connection AND every downstream row (source_files, data_source_rows,
 * entity_states, entity_events) via FK cascade.
 *
 * The backend refuses (409) if the integration is still referenced by
 * a warehouse data-link config. In that case we throw an
 * `IntegrationLinkedError` carrying the list of blocking configs so
 * the UI can tell the user which links to remove first.
 */
export async function deleteBinSource(id: number): Promise<void> {
  try {
    await apiDelete<unknown>(`/data-sources/${id}/with-mirror`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.response) {
      const parsed = await parseLinkedConfigsBlock(err.response)
      if (parsed) throw parsed
    }
    throw err
  }
  invalidateDataLink()
}

async function parseLinkedConfigsBlock(
  res: Response,
): Promise<IntegrationLinkedError | null> {
  try {
    const body = (await res.clone().json()) as {
      error?: string
      reason?: string
      linkedConfigs?: LinkedDataLinkConfigRef[]
    }
    if (body.reason === 'linked-configs' && Array.isArray(body.linkedConfigs)) {
      return new IntegrationLinkedError(
        body.error ?? 'integration is linked to data-link configs',
        body.linkedConfigs,
      )
    }
  } catch {
    // non-JSON body → let caller rethrow the original ApiError
  }
  return null
}

/**
 * Stamp lifecycle bookkeeping on a source after a run finishes. Used
 * by `rerun.ts`, the scheduler, the importer's commit-time stamp, and
 * the in-map wizard once it commits. The patch is applied to the
 * DataSource and re-mirrored — `lastEventAt` on the webhook config is
 * a particular concern (it lives inside `config`), so the full source
 * is re-projected after the update.
 */
export async function stampSourceRun(
  id: number,
  patch: {
    lastRunAt?: Date
    lastResult?: DataSource['lastResult']
    config?: Record<string, unknown>
    updatedAt?: Date
  },
): Promise<void> {
  await updateBinSource(id, patch)
}

/**
 * Patch the saved mapping on a source (used by the import wizard when
 * the user re-binds an existing source). Thin wrapper kept here so
 * call sites read symmetrically with the other helpers.
 */
export async function updateSourceMapping(
  id: number,
  mapping: DataSource['mapping'],
  updatedAt: Date,
): Promise<void> {
  await updateBinSource(id, { mapping, updatedAt })
}

// ---------------------------------------------------------- mergeMode
//
// `mergeMode` decides how each rerun reconciles with the rows already in
// `data_source_rows`:
//
//   - `'append'` (default) — keep old rows, add new ones on top. Right
//     answer for event-style APIs whose payload is a delta.
//   - `'replace-all'` — purge every row for this source before importing.
//     Right answer when the API returns the CURRENT full state on each
//     poll (e.g. our hospital mock returning all 241 assets every time).
//
// It lives inside `config` (not as a top-level DataSource column) so we
// don't need a backend migration to persist it — `config` is a JSONB
// bag that survives round-trips through the API unchanged. The two
// helpers below hide the config shape from callers.

export type MergeMode = 'append' | 'replace-all'

export function getMergeMode(source: Pick<DataSource, 'config'>): MergeMode {
  const raw = (source.config as { mergeMode?: unknown } | undefined)?.mergeMode
  return raw === 'replace-all' ? 'replace-all' : 'append'
}

export async function setMergeMode(
  source: DataSource,
  mode: MergeMode,
): Promise<void> {
  if (source.id === undefined) return
  const nextConfig = {
    ...(source.config as Record<string, unknown>),
    mergeMode: mode,
  }
  await updateBinSource(source.id, {
    config: nextConfig,
    updatedAt: new Date(),
  })
}

// ============================================================ helpers

function invalidateDataLink(): void {
  queryCache.invalidate('dataSources')
  queryCache.invalidate('connections')
  queryCache.invalidate('streams')
}

/**
 * Convert a DataSource row into the body expected by
 * `POST /data-sources/with-mirror` and `PATCH /data-sources/:id/with-mirror`.
 * The backend owns the projection from DataSource fields to Connection +
 * Stream, so the SPA only needs to send the source shape.
 */
function dataSourceToMirrorBody(source: Omit<DataSource, 'id'> | DataSource): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: source.name,
    kind: source.kind,
    // v3 — steers write path (rack-cell → bins, else → data_source_rows)
    // and default match strategy in the layer editor. See
    // DESIGN-integrations-v3.md §3.1. Backend coerces missing values
    // to 'marker'.
    entityKind: source.entityKind ?? 'marker',
    config: source.config,
    mapping: source.mapping,
  }
  if (source.zoneId !== undefined) body.zoneId = source.zoneId
  if (source.schedule !== undefined) body.schedule = source.schedule
  if (source.intervalSeconds !== undefined) body.intervalSeconds = source.intervalSeconds
  if ('lastRunAt' in source && source.lastRunAt !== undefined) {
    body.lastRunAt = source.lastRunAt
  }
  if ('lastResult' in source && source.lastResult !== undefined) {
    body.lastResult = source.lastResult
  }
  return body
}

// ====================================== exposed type aliases for callers

export type { Connection, Stream } from '@/lib/db'
