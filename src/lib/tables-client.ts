/**
 * Authed CRUD client for user-defined "thing type" tables — the third
 * ingestion mode alongside file/REST/webhook. Backed by `/api/v1/tables`
 * (see backend/internal/handlers/tables.go). Each table is a
 * `data_sources` row with `kind='table'` + a child
 * `table_field_definitions` set + one or more `table_api_tokens` for
 * per-table writes from the user's own code.
 *
 * A create returns the first plaintext token in `tokens[0].token` —
 * that's the ONLY time the plaintext is visible. Save it server-side
 * immediately; the row never returns it again.
 *
 * Reads here are scoped to the table itself. The full row payload
 * (GET /rows etc.) lives on the public surface (`/api/v1/public/tables`)
 * and is authenticated by the bearer token — see
 * `table-rows-public-client.ts` for that side.
 */

import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '@/lib/api-client'
import { queryCache } from '@/lib/useApiQuery'

/**
 * Kept in lockstep with the `oneof` tag on `FieldDefinitionRequest.DataType`
 * in `backend/internal/handlers/tables.go`. The per-type picker metadata,
 * coercion and formatting live in `@/lib/table-field-types`.
 */
export type FieldDataType =
  | 'text'
  | 'longtext'
  | 'email'
  | 'url'
  | 'phone'
  | 'uuid'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'json'

export interface FieldDefinitionRequest {
  fieldKey: string
  fieldLabel: string
  dataType: FieldDataType
  isRequired?: boolean
  isUnique?: boolean
  sortOrder?: number
}

export interface FieldDefinitionResponse {
  id: number
  sourceId: number
  fieldKey: string
  fieldLabel: string
  dataType: FieldDataType
  isRequired: boolean
  isUnique: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface TableTokenResponse {
  id: number
  sourceId: number
  label: string
  /** Plaintext — only present on mint (POST /tables or POST /tables/:id/tokens). */
  token?: string
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

export interface DataSourceWire {
  id: number
  tenantId: number
  name: string
  kind: string
  entityKind: string
  zoneId?: number
  config?: Record<string, unknown>
  mapping?: Record<string, unknown>
  schedule?: string
  intervalSeconds?: number
  lastRunAt?: string
  lastResult?: string
  createdAt: string
  updatedAt: string
}

/** What a table holds and how data reaches it (GET /tables and /tables/:id). */
export interface TableStats {
  rows: number
  /** ISO time of the newest row write; absent when the table is empty. */
  lastWriteAt?: string
  activeKeys: number
  keyLastUsedAt?: string
  /** An external REST pull is configured. */
  polling: boolean
}

export interface TableResponse {
  dataSource: DataSourceWire
  fields: FieldDefinitionResponse[]
  /** Only on GET /tables/:id — the list carries `stats.activeKeys` instead. */
  tokens?: TableTokenResponse[]
  stats?: TableStats
}

export interface CreateTableRequest {
  name: string
  entityKind?: string
  zoneId?: number
  config?: Record<string, unknown>
  fields: FieldDefinitionRequest[]
  tokenLabel?: string
}

export interface UpdateTableRequest {
  name?: string
  entityKind?: string
  zoneId?: number
  config?: Record<string, unknown>
  /** When present, the FULL new field set replaces the existing one. */
  fields?: FieldDefinitionRequest[]
}

export interface TableEventWire {
  id: number
  sourceId: number
  entityKey: string
  operation: 'insert' | 'update' | 'delete'
  ts: string
  /** Full row snapshot at this event (not a diff). Omitted on endpoints that don't surface it. */
  payload?: Record<string, unknown>
  sourceIp?: string
  authTokenId?: number
}

// ================================================================ CRUD

export async function listTables(): Promise<TableResponse[]> {
  return apiGet<TableResponse[]>('/tables')
}

export async function getTable(id: number): Promise<TableResponse> {
  return apiGet<TableResponse>(`/tables/${id}`)
}

export async function createTable(req: CreateTableRequest): Promise<TableResponse> {
  const res = await apiPost<TableResponse>('/tables', req)
  queryCache.invalidate('dataSources')
  queryCache.invalidate('tables')
  return res
}

export async function updateTable(id: number, patch: UpdateTableRequest): Promise<TableResponse> {
  const res = await apiPatch<TableResponse>(`/tables/${id}`, patch)
  queryCache.invalidate('dataSources')
  queryCache.invalidate('tables')
  return res
}

export async function deleteTable(id: number): Promise<void> {
  try {
    await apiDelete<void>(`/tables/${id}`)
  } catch (err) {
    // Backend refuses with 409 when the table is still referenced by a
    // data-link config. Re-shape into the same IntegrationLinkedError
    // shape used by deleteBinSource so the UI can render it the same way.
    if (err instanceof ApiError && err.status === 409 && err.response) {
      const parsed = await parseLinkedConfigsBlock(err.response)
      if (parsed) throw parsed
    }
    throw err
  }
  queryCache.invalidate('dataSources')
  queryCache.invalidate('tables')
}

// ============================================================ tokens

export async function createTableToken(
  tableId: number,
  label: string,
): Promise<TableTokenResponse> {
  const res = await apiPost<TableTokenResponse>(`/tables/${tableId}/tokens`, { label })
  queryCache.invalidate('tables')
  return res
}

export async function revokeTableToken(
  tableId: number,
  tokenId: number,
): Promise<void> {
  await apiDelete<void>(`/tables/${tableId}/tokens/${tokenId}`)
  queryCache.invalidate('tables')
}

// ============================================================== events

export async function listTableEvents(
  tableId: number,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<TableEventWire[]> {
  const params = new URLSearchParams()
  if (opts.from) params.set('from', opts.from)
  if (opts.to) params.set('to', opts.to)
  if (opts.limit) params.set('limit', String(opts.limit))
  const q = params.toString()
  return apiGet<TableEventWire[]>(`/tables/${tableId}/events${q ? `?${q}` : ''}`)
}

export async function listTableRowEvents(
  tableId: number,
  entityKey: string,
): Promise<TableEventWire[]> {
  return apiGet<TableEventWire[]>(`/tables/${tableId}/events/${encodeURIComponent(entityKey)}`)
}

// ================================================================ shared

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

export function isIntegrationLinkedError(err: unknown): err is IntegrationLinkedError {
  return err instanceof IntegrationLinkedError
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
    // non-JSON body → caller rethrows the original ApiError
  }
  return null
}

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