/**
 * Phase 7 — one-time backfill from IndexedDB (Dexie) to the Go backend.
 *
 * The SPA has been running against `db` for a long time. Once the backend
 * stack is reachable, this module reads the local catalog/config tables in
 * dependency order, uploads inline binary assets, remaps auto-increment local
 * IDs to backend server IDs, patches foreign keys, and POSTs/PUTs rows via
 * `apiDb`.
 *
 * Live-entity state tables (assets, sensors, RFID tags, shipments, cameras)
 * and their append-only event logs are intentionally skipped: the Go backend
 * rebuilds that state from the retargeted WebSocket ingest (M8). Migrating
 * those rows would require dedicated live-entity CRUD endpoints that the
 * project does not expose.
 *
 * After a successful run it writes a `migration-completed-at` setting on
 * the backend (with an IndexedDB fallback) so the migration only happens
 * once per browser/backend pair.
 */

import { apiPost } from './api-client'
import { apiDb } from './api-db'
import {
  fileFromImageData,
  fileFromModelData,
  imageNeedsUpload,
  modelNeedsUpload,
  uploadImage,
  uploadModel,
} from './binary-store'
import { db } from './db'
import { queryCache } from './useApiQuery'

const MARKER_KEY = 'migration-completed-at'
const MIGRATION_ERROR_KEY = 'migration-last-error'

export interface MigrationProgress {
  phase: 'reading' | 'uploading' | 'writing' | 'done' | 'error'
  table: string
  done: number
  total: number
  message?: string
}

export interface MigrateOptions {
  tenantId: number
  onProgress?: (p: MigrationProgress) => void
}

export interface MigrateResult {
  success: boolean
  migratedTables: string[]
  skippedTables: string[]
  errors: string[]
}

type MigratedTableName =
  | 'zones'
  | 'attributeDefinitions'
  | 'images'
  | 'userModels'
  | 'grids'
  | 'polygons'
  | 'circles'
  | 'lines'
  | 'markers'
  | 'models'
  | 'textLabels'
  | 'bins'
  | 'styleRules'
  | 'dataSources'
  | 'connections'
  | 'streams'
  | 'importJobs'
  | 'references'
  | 'correlationRules'
  | 'alerts'
  | 'settings'

class Remapper {
  private maps = new Map<MigratedTableName, Map<number, number>>()

  set(table: MigratedTableName, localId: number, serverId: number): void {
    let m = this.maps.get(table)
    if (!m) {
      m = new Map()
      this.maps.set(table, m)
    }
    m.set(localId, serverId)
  }

  get(table: MigratedTableName, localId: number | undefined): number | undefined {
    if (localId === undefined) return undefined
    return this.maps.get(table)?.get(localId)
  }

  shapeId(kind: import('./db').BindingKind | undefined, localId: number | undefined): number | undefined {
    if (localId === undefined) return undefined
    const table = shapeTableForKind(kind)
    if (!table) return undefined
    return this.get(table, localId)
  }

  modelAssetId(assetId: string | undefined): string | undefined {
    if (assetId === undefined) return undefined
    if (!assetId.startsWith('user_')) return assetId
    const localId = Number(assetId.slice(5))
    if (!Number.isFinite(localId)) return assetId
    const serverId = this.get('userModels', localId)
    return serverId !== undefined ? `user_${serverId}` : assetId
  }
}

function shapeTableForKind(kind: import('./db').BindingKind | undefined): MigratedTableName | null {
  switch (kind) {
    case 'polygon':
      return 'polygons'
    case 'circle':
      return 'circles'
    case 'line':
      return 'lines'
    case 'marker':
      return 'markers'
    case 'image':
      return 'images'
    case 'model':
      return 'models'
    default:
      return null
  }
}

function emitProgress(
  onProgress: ((p: MigrationProgress) => void) | undefined,
  progress: MigrationProgress,
): void {
  try {
    onProgress?.(progress)
  } catch {
    // Progress callback must never abort the migration.
  }
}

async function localRows<T>(getter: () => Promise<T[]>): Promise<T[]> {
  try {
    return await getter()
  } catch {
    return []
  }
}

async function writeMarker(): Promise<void> {
  const value = new Date().toISOString()
  try {
    await apiDb.settings.put({ key: MARKER_KEY, value })
  } catch (err) {
    console.warn('[migrate] backend marker write failed', err)
  }
  try {
    await db.settings.put({ key: MARKER_KEY, value })
  } catch {
    // IndexedDB fallback is best-effort.
  }
}

async function writeErrorMarker(error: string): Promise<void> {
  const value = JSON.stringify({ message: error, at: new Date().toISOString() })
  try {
    await apiDb.settings.put({ key: MIGRATION_ERROR_KEY, value })
  } catch {
    // Ignore.
  }
  try {
    await db.settings.put({ key: MIGRATION_ERROR_KEY, value })
  } catch {
    // Ignore.
  }
}

export async function isMigrationNeeded(): Promise<boolean> {
  try {
    const backend = await apiDb.settings.get(MARKER_KEY)
    if (backend?.value) return false
  } catch {
    // Backend unreachable; fall through to local marker.
  }
  try {
    const local = await db.settings.get(MARKER_KEY)
    if (local?.value) return false
  } catch {
    // Ignore.
  }
  return true
}

export async function runBackendMigration(options: MigrateOptions): Promise<MigrateResult> {
  const { tenantId, onProgress } = options
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[migrate] starting backfill for tenant ${tenantId}`)
  }
  const result: MigrateResult = {
    success: false,
    migratedTables: [],
    skippedTables: [
      'assets',
      'assetPositions',
      'sensors',
      'sensorReadings',
      'rfidTags',
      'rfidReads',
      'shipments',
      'cameras',
      'cvDetections',
      'auditLog',
    ],
    errors: [],
  }

  if (!(await isMigrationNeeded())) {
    result.migratedTables.push('(already complete)')
    result.success = true
    return result
  }

  const remapper = new Remapper()

  // ------------------------------------------------------------------
  // 1. Static catalog (no FKs or only soft FKs we patch later).
  // ------------------------------------------------------------------

  await migrateSimpleTable('zones', () => db.zones.toArray(), apiDb.zones.add, remapper, onProgress, result)
  await migrateSimpleTable(
    'attributeDefinitions',
    () => db.attributeDefinitions.toArray(),
    apiDb.attributeDefinitions.add,
    remapper,
    onProgress,
    result,
  )

  // Binary assets: upload inline payloads before creating the parent row.
  await migrateImages(remapper, onProgress, result)
  await migrateUserModels(remapper, onProgress, result)

  await migrateSimpleTable('grids', () => db.grids.toArray(), async (row) => {
    const patched = patchGrid(row, remapper)
    return apiDb.grids.add(patched)
  }, remapper, onProgress, result)

  for (const table of ['polygons', 'circles', 'lines', 'markers', 'models', 'textLabels'] as MigratedTableName[]) {
    await migrateShapeTable(table, remapper, onProgress, result)
  }

  await migrateBins(remapper, onProgress, result)
  await migrateStyleRules(remapper, onProgress, result)

  // ------------------------------------------------------------------
  // 2. Data-link layer. DataSources use the with-mirror endpoint so the
  //    backend keeps Connection + Stream in sync. Mirrored connection/stream
  //    rows are NOT migrated separately — they are recreated by the backend.
  // ------------------------------------------------------------------

  await migrateDataSources(remapper, onProgress, result)
  await migrateConnections(remapper, onProgress, result)
  await migrateStreams(remapper, onProgress, result)
  await migrateImportJobs(remapper, onProgress, result)

  // ------------------------------------------------------------------
  // 3. Cross-entity graph + correlation.
  // ------------------------------------------------------------------

  await migrateSimpleTable('references', () => db.references.toArray(), async (row) => {
    const patched = { ...row }
    if (patched.sourceStreamId !== undefined) {
      patched.sourceStreamId = remapper.get('streams', patched.sourceStreamId)
    }
    return apiDb.references.add(patched)
  }, remapper, onProgress, result)

  await migrateCorrelationRules(remapper, onProgress, result)
  await migrateSimpleTable('alerts', () => db.alerts.toArray(), async (row) => {
    const patched = { ...row }
    if (patched.ruleId !== undefined) {
      patched.ruleId = remapper.get('correlationRules', patched.ruleId)
    }
    return apiDb.alerts.add(patched)
  }, remapper, onProgress, result)

  // ------------------------------------------------------------------
  // 4. Settings (except legacy tenant.current and migration markers).
  // ------------------------------------------------------------------

  await migrateSettings(onProgress, result)

  // ------------------------------------------------------------------
  // 5. Mark completion and invalidate caches.
  // ------------------------------------------------------------------

  if (result.errors.length === 0) {
    try {
      await writeMarker()
      result.success = true
      queryCache.invalidateAll()
    } catch (err) {
      result.errors.push(`marker write failed: ${(err as Error).message}`)
    }
  } else {
    const summary = result.errors.slice(0, 3).join('; ')
    await writeErrorMarker(summary)
    emitProgress(onProgress, {
      phase: 'error',
      table: '',
      done: 0,
      total: 0,
      message: summary,
    })
  }

  return result
}

// ============================================================ helpers

async function migrateSimpleTable<T extends { id?: number }>(
  table: MigratedTableName,
  getter: () => Promise<T[]>,
  add: (row: Omit<T, 'id'>) => Promise<number>,
  remapper: Remapper,
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const rows = await localRows(getter)
  if (rows.length === 0) {
    result.migratedTables.push(table)
    return
  }
  emitProgress(onProgress, { phase: 'writing', table, done: 0, total: rows.length })
  let done = 0
  for (const row of rows) {
    try {
      const localId = row.id
      const { id: _id, ...rest } = row as T & { id?: number }
      const serverId = await add(rest)
      if (localId !== undefined) {
        remapper.set(table, localId, serverId)
      }
      done++
    } catch (err) {
      result.errors.push(`${table}[${row.id}]: ${(err as Error).message}`)
    }
    if (done % 10 === 0 || done === rows.length) {
      emitProgress(onProgress, { phase: 'writing', table, done, total: rows.length })
    }
  }
  result.migratedTables.push(table)
}

async function migrateShapeTable(
  table: MigratedTableName,
  remapper: Remapper,
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const apiTable = (apiDb as unknown as Record<MigratedTableName, { add: (row: Record<string, unknown>) => Promise<number> }>)[table]
  const rows = await localRows(() => (db as unknown as Record<string, { toArray: () => Promise<Record<string, unknown>[]> }>)[table].toArray())
  if (rows.length === 0) {
    result.migratedTables.push(table)
    return
  }
  emitProgress(onProgress, { phase: 'writing', table, done: 0, total: rows.length })
  let done = 0
  for (const row of rows) {
    try {
      const localId = row.id as number | undefined
      const patched = patchShape(row, table, remapper)
      const serverId = await apiTable.add(patched)
      if (localId !== undefined) {
        remapper.set(table, localId, serverId)
      }
      done++
    } catch (err) {
      result.errors.push(`${table}[${row.id}]: ${(err as Error).message}`)
    }
    if (done % 10 === 0 || done === rows.length) {
      emitProgress(onProgress, { phase: 'writing', table, done, total: rows.length })
    }
  }
  result.migratedTables.push(table)
}

function patchShape(row: Record<string, unknown>, table: MigratedTableName, remapper: Remapper): Record<string, unknown> {
  const patched = { ...row }
  delete patched.id
  delete patched.tenantId
  if (patched.zoneId !== undefined) {
    patched.zoneId = remapper.get('zones', patched.zoneId as number)
  }
  if (patched.floorPlanId !== undefined) {
    patched.floorPlanId = remapper.get('images', patched.floorPlanId as number)
  }
  if (table === 'models' && patched.config && typeof patched.config === 'object') {
    const config = patched.config as Record<string, unknown>
    if (config.modelAssetId !== undefined) {
      config.modelAssetId = remapper.modelAssetId(config.modelAssetId as string)
    }
  }
  return patched
}

function patchGrid(row: import('./db').Grid, remapper: Remapper): Omit<import('./db').Grid, 'id'> {
  const { id: _id, ...patched } = { ...row }
  if (patched.zoneId !== undefined) patched.zoneId = remapper.get('zones', patched.zoneId)
  if (patched.floorPlanId !== undefined) patched.floorPlanId = remapper.get('images', patched.floorPlanId)
  return patched
}

async function migrateImages(
  remapper: Remapper,
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const rows = await localRows(() => db.images.toArray())
  if (rows.length === 0) {
    result.migratedTables.push('images')
    return
  }
  emitProgress(onProgress, { phase: 'uploading', table: 'images', done: 0, total: rows.length })
  let done = 0
  for (const row of rows) {
    try {
      let patched: import('./shapes').ImageShape = { ...row }
      if (imageNeedsUpload(patched)) {
        const file = fileFromImageData(patched)
        if (file) {
          const uploaded = await uploadImage(file)
          patched = { ...patched, imageUrl: uploaded.url, imageData: undefined }
        }
      }
      const { id: localId, ...body } = patched
      const serverId = await apiDb.images.add(body)
      if (localId !== undefined) remapper.set('images', localId, serverId)
      done++
    } catch (err) {
      result.errors.push(`images[${row.id}]: ${(err as Error).message}`)
    }
    emitProgress(onProgress, { phase: 'uploading', table: 'images', done, total: rows.length })
  }
  result.migratedTables.push('images')
}

async function migrateUserModels(
  remapper: Remapper,
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const rows = await localRows(() => db.userModels.toArray())
  if (rows.length === 0) {
    result.migratedTables.push('userModels')
    return
  }
  emitProgress(onProgress, { phase: 'uploading', table: 'userModels', done: 0, total: rows.length })
  let done = 0
  for (const row of rows) {
    try {
      let patched: import('./db').UserModel = { ...row }
      if (modelNeedsUpload(patched)) {
        const file = fileFromModelData(patched)
        if (file) {
          const uploaded = await uploadModel(file)
          patched = { ...patched, modelUrl: uploaded.url, data: undefined, bytes: uploaded.bytes }
        }
      }
      const { id: localId, ...body } = patched
      const serverId = await apiDb.userModels.add(body)
      if (localId !== undefined) remapper.set('userModels', localId, serverId)
      done++
    } catch (err) {
      result.errors.push(`userModels[${row.id}]: ${(err as Error).message}`)
    }
    emitProgress(onProgress, { phase: 'uploading', table: 'userModels', done, total: rows.length })
  }
  result.migratedTables.push('userModels')
}

async function migrateBins(
  remapper: Remapper,
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const rows = await localRows(() => db.bins.toArray())
  if (rows.length === 0) {
    result.migratedTables.push('bins')
    return
  }
  emitProgress(onProgress, { phase: 'writing', table: 'bins', done: 0, total: rows.length })
  let done = 0
  for (const row of rows) {
    try {
      const { id: localId, ...patched } = { ...row }
      if (patched.targetKind === 'grid-cell') {
        if (patched.gridId !== undefined) patched.gridId = remapper.get('grids', patched.gridId)
      } else {
        const newShapeId = remapper.shapeId(patched.targetKind, patched.shapeId)
        if (newShapeId !== undefined) patched.shapeId = newShapeId
        patched.gridId = undefined
        patched.row = undefined
        patched.col = undefined
        patched.level = undefined
      }
      if (patched.syncSource !== undefined) {
        patched.syncSource = remapper.get('dataSources', patched.syncSource)
      }
      if (patched.floorPlanId !== undefined) {
        patched.floorPlanId = remapper.get('images', patched.floorPlanId)
      }
      const serverId = await apiDb.bins.add(patched)
      if (localId !== undefined) remapper.set('bins', localId, serverId)
      done++
    } catch (err) {
      result.errors.push(`bins[${row.id}]: ${(err as Error).message}`)
    }
    if (done % 50 === 0 || done === rows.length) {
      emitProgress(onProgress, { phase: 'writing', table: 'bins', done, total: rows.length })
    }
  }
  result.migratedTables.push('bins')
}

async function migrateStyleRules(
  remapper: Remapper,
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const rows = await localRows(() => db.styleRules.toArray())
  if (rows.length === 0) {
    result.migratedTables.push('styleRules')
    return
  }
  emitProgress(onProgress, { phase: 'writing', table: 'styleRules', done: 0, total: rows.length })
  let done = 0
  for (const row of rows) {
    try {
      const { id: localId, ...patched } = { ...row }
      if (patched.zoneId !== undefined) patched.zoneId = remapper.get('zones', patched.zoneId)
      const serverId = await apiDb.styleRules.add(patched)
      if (localId !== undefined) remapper.set('styleRules', localId, serverId)
      done++
    } catch (err) {
      result.errors.push(`styleRules[${row.id}]: ${(err as Error).message}`)
    }
    if (done % 10 === 0 || done === rows.length) {
      emitProgress(onProgress, { phase: 'writing', table: 'styleRules', done, total: rows.length })
    }
  }
  result.migratedTables.push('styleRules')
}

async function migrateDataSources(
  remapper: Remapper,
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const rows = await localRows(() => db.dataSources.toArray())
  if (rows.length === 0) {
    result.migratedTables.push('dataSources')
    return
  }
  emitProgress(onProgress, { phase: 'writing', table: 'dataSources', done: 0, total: rows.length })
  let done = 0
  for (const row of rows) {
    try {
      const localId = row.id
      const body: Record<string, unknown> = {
        name: row.name,
        kind: row.kind,
        config: row.config,
        mapping: row.mapping,
      }
      if (row.zoneId !== undefined) {
        body.zoneId = remapper.get('zones', row.zoneId)
      }
      if (row.schedule !== undefined) body.schedule = row.schedule
      if (row.intervalSeconds !== undefined) body.intervalSeconds = row.intervalSeconds
      if (row.lastRunAt !== undefined) body.lastRunAt = row.lastRunAt.toISOString()
      if (row.lastResult !== undefined) body.lastResult = row.lastResult

      const res = await apiPost<{
        dataSource: { id: number }
        connection: { id: number }
        stream: { id: number }
      }>('/data-sources/with-mirror', body)

      if (localId !== undefined) {
        remapper.set('dataSources', localId, res.dataSource.id)
      }
      // The mirrored connection/stream are managed by the backend; we still
      // record their IDs so other tables that referenced the local mirrored
      // connection/stream can be patched if necessary.
      const mirrorConn = (row as unknown as Record<string, unknown>).connectionId
      const mirrorStream = (row as unknown as Record<string, unknown>).streamId
      if (typeof mirrorConn === 'number') {
        remapper.set('connections', mirrorConn, res.connection.id)
      }
      if (typeof mirrorStream === 'number') {
        remapper.set('streams', mirrorStream, res.stream.id)
      }
      done++
    } catch (err) {
      result.errors.push(`dataSources[${row.id}]: ${(err as Error).message}`)
    }
    if (done % 5 === 0 || done === rows.length) {
      emitProgress(onProgress, { phase: 'writing', table: 'dataSources', done, total: rows.length })
    }
  }
  result.migratedTables.push('dataSources')
}

async function migrateConnections(
  remapper: Remapper,
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const rows = await localRows(() => db.connections.toArray())
  // Exclude connections that were mirrored from a DataSource; those are
  // owned by the backend's with-mirror endpoint.
  const localStreamRows = await localRows(() => db.streams.toArray())
  const mirroredConnectionIds = new Set(
    localStreamRows.filter((s) => s.dataSourceId !== undefined).map((s) => s.connectionId),
  )
  const independent = rows.filter((c) => !mirroredConnectionIds.has(c.id ?? -1))
  if (independent.length === 0) {
    result.migratedTables.push('connections')
    return
  }
  emitProgress(onProgress, { phase: 'writing', table: 'connections', done: 0, total: independent.length })
  let done = 0
  for (const row of independent) {
    try {
      const localId = row.id
      const { id: _id, ...body } = row
      const serverId = await apiDb.connections.add(body)
      if (localId !== undefined) remapper.set('connections', localId, serverId)
      done++
    } catch (err) {
      result.errors.push(`connections[${row.id}]: ${(err as Error).message}`)
    }
    if (done % 5 === 0 || done === independent.length) {
      emitProgress(onProgress, { phase: 'writing', table: 'connections', done, total: independent.length })
    }
  }
  result.migratedTables.push('connections')
}

async function migrateStreams(
  remapper: Remapper,
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const rows = await localRows(() => db.streams.toArray())
  // Independent streams are those NOT mirrored from a DataSource.
  const independent = rows.filter((s) => s.dataSourceId === undefined)
  if (independent.length === 0) {
    result.migratedTables.push('streams')
    return
  }
  emitProgress(onProgress, { phase: 'writing', table: 'streams', done: 0, total: independent.length })
  let done = 0
  for (const row of independent) {
    try {
      const localId = row.id
      const { id: _id, ...patched } = { ...row }
      const newConnectionId = remapper.get('connections', patched.connectionId)
      if (newConnectionId !== undefined) patched.connectionId = newConnectionId
      if (patched.dataSourceId !== undefined) {
        const newDataSourceId = remapper.get('dataSources', patched.dataSourceId)
        if (newDataSourceId !== undefined) patched.dataSourceId = newDataSourceId
      }
      if (patched.zoneId !== undefined) {
        const newZoneId = remapper.get('zones', patched.zoneId)
        if (newZoneId !== undefined) patched.zoneId = newZoneId
      }
      const serverId = await apiDb.streams.add(patched)
      if (localId !== undefined) remapper.set('streams', localId, serverId)
      done++
    } catch (err) {
      result.errors.push(`streams[${row.id}]: ${(err as Error).message}`)
    }
    if (done % 5 === 0 || done === independent.length) {
      emitProgress(onProgress, { phase: 'writing', table: 'streams', done, total: independent.length })
    }
  }
  result.migratedTables.push('streams')
}

async function migrateImportJobs(
  remapper: Remapper,
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const rows = await localRows(() => db.importJobs.toArray())
  if (rows.length === 0) {
    result.migratedTables.push('importJobs')
    return
  }
  emitProgress(onProgress, { phase: 'writing', table: 'importJobs', done: 0, total: rows.length })
  let done = 0
  for (const row of rows) {
    try {
      const { id: localId, ...patched } = { ...row }
      const newSourceId = remapper.get('dataSources', patched.sourceId)
      if (newSourceId !== undefined) patched.sourceId = newSourceId
      const serverId = await apiDb.importJobs.add(patched)
      if (localId !== undefined) remapper.set('importJobs', localId, serverId)
      done++
    } catch (err) {
      result.errors.push(`importJobs[${row.id}]: ${(err as Error).message}`)
    }
    if (done % 5 === 0 || done === rows.length) {
      emitProgress(onProgress, { phase: 'writing', table: 'importJobs', done, total: rows.length })
    }
  }
  result.migratedTables.push('importJobs')
}

async function migrateCorrelationRules(
  remapper: Remapper,
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const rows = await localRows(() => db.correlationRules.toArray())
  if (rows.length === 0) {
    result.migratedTables.push('correlationRules')
    return
  }
  emitProgress(onProgress, { phase: 'writing', table: 'correlationRules', done: 0, total: rows.length })
  let done = 0
  for (const row of rows) {
    try {
      const { id: localId, ...patched } = { ...row }
      patched.trigger = patchCorrelationTrigger(row.trigger, remapper)
      patched.action = patchCorrelationAction(row.action, remapper)
      const serverId = await apiDb.correlationRules.add(patched)
      if (localId !== undefined) remapper.set('correlationRules', localId, serverId)
      done++
    } catch (err) {
      result.errors.push(`correlationRules[${row.id}]: ${(err as Error).message}`)
    }
    if (done % 5 === 0 || done === rows.length) {
      emitProgress(onProgress, { phase: 'writing', table: 'correlationRules', done, total: rows.length })
    }
  }
  result.migratedTables.push('correlationRules')
}

function patchCorrelationTrigger(
  trigger: import('./db').CorrelationTrigger,
  remapper: Remapper,
): import('./db').CorrelationTrigger {
  const t = { ...trigger }
  if (t.kind === 'cv-detection') {
    if (t.targetShapeId !== undefined && t.targetShapeKind !== undefined) {
      t.targetShapeId = remapper.shapeId(t.targetShapeKind, t.targetShapeId)
    }
  } else if (t.kind === 'rfid-read' || t.kind === 'asset-position') {
    if (t.polygonId !== undefined) {
      const newPolygonId = remapper.get('polygons', t.polygonId)
      if (newPolygonId !== undefined) t.polygonId = newPolygonId
    }
  }
  return t
}

function patchCorrelationAction(
  action: import('./db').CorrelationAction,
  remapper: Remapper,
): import('./db').CorrelationAction {
  const a = { ...action }
  if (a.kind === 'set-bin-status') {
    if (a.binId !== undefined) {
      const newBinId = remapper.get('bins', a.binId)
      if (newBinId !== undefined) a.binId = newBinId
    }
  } else if (a.kind === 'call-outbound') {
    const newStreamId = remapper.get('streams', a.streamId)
    if (newStreamId !== undefined) a.streamId = newStreamId
  } else if (a.kind === 'set-zone-status') {
    const newZoneId = remapper.get('zones', a.zoneId)
    if (newZoneId !== undefined) a.zoneId = newZoneId
  }
  return a
}

async function migrateSettings(
  onProgress: ((p: MigrationProgress) => void) | undefined,
  result: MigrateResult,
): Promise<void> {
  const rows = await localRows(() => db.settings.toArray())
  const skipKeys = new Set([MARKER_KEY, MIGRATION_ERROR_KEY, 'tenant.current'])
  const toMigrate = rows.filter((s) => !skipKeys.has(s.key))
  if (toMigrate.length === 0) {
    result.migratedTables.push('settings')
    return
  }
  emitProgress(onProgress, { phase: 'writing', table: 'settings', done: 0, total: toMigrate.length })
  let done = 0
  for (const row of toMigrate) {
    try {
      await apiDb.settings.put({ key: row.key, value: row.value })
      done++
    } catch (err) {
      result.errors.push(`settings[${row.key}]: ${(err as Error).message}`)
    }
  }
  emitProgress(onProgress, { phase: 'writing', table: 'settings', done, total: toMigrate.length })
  result.migratedTables.push('settings')
}
