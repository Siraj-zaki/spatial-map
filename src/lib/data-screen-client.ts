/**
 * Typed wrappers around the /api/v1/data/* endpoints that power the Data
 * screen. Mirrors the warehouses-client shape: params in, `{ rows, total,
 * page, pageSize, stats, filteredStats }` back.
 *
 * All list endpoints share the same tenant-wide `stats` block so the
 * screen's header KPI cards stay consistent across tabs.
 */

import { apiDelete, apiGet, apiPost } from './api-client'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type DataScreenDir = 'asc' | 'desc'

export type ArchivedFilter = 'all' | 'active' | 'archived'

export interface DataScreenStats {
  totalRows: number
  totalBins: number
  totalStates: number
  totalEvents: number
  totalFiles: number
  totalRuns: number
  activeSources: number
  archivedSources: number
}

export interface DataScreenSourceRef {
  id: number
  name: string
  kind: string
  entityKind?: string
  archived: boolean
  deletedAt?: string
}

// ---------------------------------------------------------------------------
// Rows tab — data_source_rows
// ---------------------------------------------------------------------------

export type DataRowsSort = 'ts' | 'updatedAt' | 'sourceName' | 'entityKey'

export interface DataRowsParams {
  sourceId?: number
  entityKey?: string
  search?: string
  from?: string
  to?: string
  archived?: ArchivedFilter
  sort?: DataRowsSort
  dir?: DataScreenDir
  page?: number
  pageSize?: number
}

export interface DataRow {
  id: number
  sourceId: number
  sourceName: string
  sourceKind: string
  sourceArchived: boolean
  entityKey: string
  payload: unknown
  linkedShape?: string
  positionWkt?: string
  ts: string
  updatedAt: string
}

export interface DataRowsFilteredStats {
  rows: number
  sources: number
  earliest?: string
  latest?: string
}

export interface DataRowsResponse {
  rows: DataRow[]
  total: number
  page: number
  pageSize: number
  stats: DataScreenStats
  filteredStats: DataRowsFilteredStats
}

// ---------------------------------------------------------------------------
// Rooms & Bins tab
// ---------------------------------------------------------------------------

export type DataBinsSort = 'lastSyncedAt' | 'externalCode' | 'status' | 'sourceName'

export interface DataBinsParams {
  sourceId?: number
  search?: string
  from?: string
  to?: string
  sort?: DataBinsSort
  dir?: DataScreenDir
  page?: number
  pageSize?: number
}

export interface DataBin {
  id: number
  sourceId: number
  sourceName: string
  sourceArchived: boolean
  targetKind: string
  status: string
  externalCode?: string
  sku?: string
  notes?: string
  capacity: number
  custom?: unknown
  lastSyncedAt?: string
  updatedAt: string
}

export interface DataBinsFilteredStats {
  bins: number
  sources: number
  earliest?: string
  latest?: string
}

export interface DataBinsResponse {
  rows: DataBin[]
  total: number
  page: number
  pageSize: number
  stats: DataScreenStats
  filteredStats: DataBinsFilteredStats
}

// ---------------------------------------------------------------------------
// Live tab — entity_states + entity_events
// ---------------------------------------------------------------------------

export type DataLiveStatesSort = 'lastSeenAt' | 'streamName' | 'entityKey'
export type DataLiveEventsSort = 'ts' | 'streamName' | 'entityKey'

export interface DataLiveParams {
  streamId?: number
  entityType?: string
  entityKey?: string
  from?: string
  to?: string
  sort?: DataLiveStatesSort
  dir?: DataScreenDir
  page?: number
  pageSize?: number
}

export interface DataLiveEventsParams {
  streamId?: number
  entityKey?: string
  from?: string
  to?: string
  sort?: DataLiveEventsSort
  dir?: DataScreenDir
  page?: number
  pageSize?: number
}

export interface DataLiveState {
  id: number
  streamId: number
  streamName: string
  streamArchived: boolean
  entityType: string
  entityKey: string
  payload: unknown
  positionWkt?: string
  lastSeenAt: string
  updatedAt: string
}

export interface DataLiveEvent {
  id: number
  streamId: number
  streamName: string
  streamArchived: boolean
  entityKey: string
  payload: unknown
  ts: string
}

export interface DataLiveFilteredStats {
  count: number
  streams: number
  earliest?: string
  latest?: string
}

export interface DataLiveStatesResponse {
  rows: DataLiveState[]
  total: number
  page: number
  pageSize: number
  stats: DataScreenStats
  filteredStats: DataLiveFilteredStats
}

export interface DataLiveEventsResponse {
  rows: DataLiveEvent[]
  total: number
  page: number
  pageSize: number
  stats: DataScreenStats
  filteredStats: DataLiveFilteredStats
}

// ---------------------------------------------------------------------------
// Files tab — source_files
// ---------------------------------------------------------------------------

export type DataFilesSort = 'createdAt' | 'updatedAt' | 'filename' | 'bytesSize' | 'sourceName'

export interface DataFilesParams {
  sourceId?: number
  search?: string
  from?: string
  to?: string
  sort?: DataFilesSort
  dir?: DataScreenDir
  page?: number
  pageSize?: number
}

export interface DataFile {
  id: number
  sourceId: number
  sourceName: string
  sourceArchived: boolean
  filename: string
  sourceKind: string
  sheetName?: string
  jsonRootPath?: string
  bytesSize: number
  sha256?: string
  createdAt: string
  updatedAt: string
}

export interface DataFilesFilteredStats {
  files: number
  sources: number
  bytesSize: number
  earliest?: string
  latest?: string
}

export interface DataFilesResponse {
  rows: DataFile[]
  total: number
  page: number
  pageSize: number
  stats: DataScreenStats
  filteredStats: DataFilesFilteredStats
}

// ---------------------------------------------------------------------------
// Runs tab — import_jobs
// ---------------------------------------------------------------------------

export type DataRunsSort = 'startedAt' | 'finishedAt' | 'createdAt' | 'status' | 'sourceName'

export interface DataRunsParams {
  sourceId?: number
  status?: string
  from?: string
  to?: string
  sort?: DataRunsSort
  dir?: DataScreenDir
  page?: number
  pageSize?: number
}

export interface DataRun {
  id: number
  sourceId: number
  sourceName: string
  sourceArchived: boolean
  status: string
  stats?: unknown
  errorReport?: string
  startedAt?: string
  finishedAt?: string
  createdAt: string
}

export interface DataRunsFilteredStats {
  runs: number
  sources: number
  failures: number
  earliest?: string
  latest?: string
}

export interface DataRunsResponse {
  rows: DataRun[]
  total: number
  page: number
  pageSize: number
  stats: DataScreenStats
  filteredStats: DataRunsFilteredStats
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

function toQS(params: object): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    qs.set(k, String(v))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** Optional `solution` scopes every Data list to that solution's sources. */
export interface SolutionScope {
  solution?: number | null
}

export function listDataSources(solution?: number | null): Promise<DataScreenSourceRef[]> {
  return apiGet<DataScreenSourceRef[]>(`/data/sources${toQS({ solution })}`)
}

export function listDataRows(params: DataRowsParams & SolutionScope = {}): Promise<DataRowsResponse> {
  return apiGet<DataRowsResponse>(`/data/rows${toQS(params)}`)
}

export function listDataBins(params: DataBinsParams & SolutionScope = {}): Promise<DataBinsResponse> {
  return apiGet<DataBinsResponse>(`/data/bins${toQS(params)}`)
}

export function listDataLiveStates(params: DataLiveParams & SolutionScope = {}): Promise<DataLiveStatesResponse> {
  return apiGet<DataLiveStatesResponse>(`/data/live${toQS(params)}`)
}

export function listDataLiveEvents(params: DataLiveEventsParams & SolutionScope = {}): Promise<DataLiveEventsResponse> {
  return apiGet<DataLiveEventsResponse>(`/data/live/events${toQS(params)}`)
}

export function listDataFiles(params: DataFilesParams & SolutionScope = {}): Promise<DataFilesResponse> {
  return apiGet<DataFilesResponse>(`/data/files${toQS(params)}`)
}

export function listDataRuns(params: DataRunsParams & SolutionScope = {}): Promise<DataRunsResponse> {
  return apiGet<DataRunsResponse>(`/data/runs${toQS(params)}`)
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type DataSurface = 'rows' | 'bins' | 'live/state' | 'live/events' | 'files' | 'runs'

interface DeletedEnvelope {
  deleted: number
}

export function deleteDataRecord(surface: DataSurface, id: number): Promise<DeletedEnvelope> {
  return apiDelete<DeletedEnvelope>(`/data/${surface}/${id}`)
}

export function bulkDeleteDataRecords(surface: DataSurface, ids: number[]): Promise<DeletedEnvelope> {
  return apiPost<DeletedEnvelope>(`/data/${surface}/bulk-delete`, { ids })
}

export interface PurgeBody {
  sourceId?: number
  streamId?: number
  before?: string
}

export function purgeDataRecords(surface: DataSurface, body: PurgeBody): Promise<DeletedEnvelope> {
  return apiPost<DeletedEnvelope>(`/data/${surface}/purge`, body)
}
