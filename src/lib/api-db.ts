/**
 * Dexie-shaped data-access layer backed by the Go backend.
 *
 * This module exposes an object named `apiDb` that mirrors the tables in
 * `src/lib/db.ts` but routes every read/write through the REST API. The goal
 * is to let existing components swap `import { db } from '@/lib/db'` for
 * `import { apiDb } from '@/lib/api-db'` with minimal other changes.
 *
 * For now the `where()` implementation fetches the tenant-scoped list and
 * filters client-side. This is fine for the current catalog sizes; backend
 * filtering can be added later without changing the component call sites.
 */

import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from './api-client'
import {
  fileFromImageData,
  fileFromModelData,
  imageNeedsUpload,
  modelNeedsUpload,
  uploadImage,
  uploadModel,
} from './binary-store'
import {
  type Zone,
  type Grid,
  type Bin,
  type AttributeDefinition,
  type StyleRuleRow,
  type DataSource,
  type ImportJob,
  type Tenant,
  type Setting,
  type UserModel,
  type BindingKind,
  type Reference,
  type CorrelationRule,
  type Alert,
  type AuditLogEntry,
  // Slice 6c2 removed the `Shipment` type + apiDb.shipments table.
  type DataLinkConfig,
} from './db'
import type {
  PolygonShape,
  CircleShape,
  LineShape,
  RouteShape,
  MarkerShape,
  ImageShape,
  ModelShape,
  ImagePlaneShape,
  StairShape,
  TextLabelShape,
} from './shapes'
import type { DoorShape } from './door/types'
import type { Connection, Stream } from './data-link/contracts'

type TableDef<T> = {
  dateFields?: string[]
  /** Optional first-read migration: upload inline binary assets and patch the row with a URL. */
  migrate?: (row: T) => Promise<T>
}

function parseDates<T>(row: T, dateFields?: string[]): T {
  if (!dateFields || dateFields.length === 0) return row
  const out = { ...row }
  for (const f of dateFields) {
    const v = (out as Record<string, unknown>)[f]
    if (typeof v === 'string') {
      ;(out as Record<string, unknown>)[f] = new Date(v)
    } else if (v === null || v === undefined) {
      ;(out as Record<string, unknown>)[f] = undefined
    }
  }
  return out
}

function stripServerFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (k === 'id' || k === 'tenantId' || k === 'tenantID' || k === 'createdAt' || k === 'updatedAt') {
      continue
    }
    if (v === undefined) continue
    out[k] = v
  }
  return out
}

/**
 * Sync hook so locally-initiated CRUD calls can be reflected in
 * `useSpatialStore` without bouncing through SSE. The spatial store
 * registers a callback at module load (via {@link setEntitySync}); each
 * successful add/update/delete here invokes it so the local snapshot
 * stays in step with the backend before the SSE echo arrives. We use a
 * setter instead of a direct import to avoid a runtime cycle between
 * `api-db` and `spatial-store`.
 */
export type EntitySyncOp = 'add' | 'update' | 'delete'
export type EntitySyncCallback = (
  /** Kind slug — matches the table's URL path without the leading slash. */
  kind: string,
  op: EntitySyncOp,
  id: number,
  /** Parsed row, populated for `add`/`update` and absent for `delete`. */
  row?: unknown,
) => void

let entitySync: EntitySyncCallback | null = null

export function setEntitySync(cb: EntitySyncCallback | null): void {
  entitySync = cb
}

function notifySync(path: string, op: EntitySyncOp, id: number, row?: unknown): void {
  if (!entitySync) return
  // Strip the leading '/' so the kind matches the EntityKind slug
  // (e.g. '/text-labels' -> 'text-labels'). Tables not tracked by the
  // spatial store can be ignored by the callback.
  entitySync(path.slice(1), op, id, row)
}

interface WhereClause<T> {
  equals: (value: unknown) => {
    first: () => Promise<T | undefined>
    toArray: () => Promise<T[]>
    count: () => Promise<number>
  }
  anyOf: (values: unknown[]) => {
    toArray: () => Promise<T[]>
  }
  filter: (predicate: (row: T) => boolean) => {
    toArray: () => Promise<T[]>
    count: () => Promise<number>
  }
}

function makeTable<T extends { id?: number }>(path: string, def: TableDef<T> = {}): {
  toArray: (query?: string) => Promise<T[]>
  get: (id: number) => Promise<T | undefined>
  add: (item: Omit<T, 'id'>) => Promise<number>
  update: (id: number, patch: Partial<T>) => Promise<T>
  delete: (id: number) => Promise<void>
  clear: () => Promise<void>
  count: () => Promise<number>
  where: (field: string) => WhereClause<T>
  put: (item: T) => Promise<number>
} {
  const dateFields = def.dateFields
  const migrate = def.migrate
  const migrating = new Set<number>()

  async function runMigrate(row: T): Promise<T> {
    if (!migrate || row.id === undefined) return row
    if (migrating.has(row.id)) return row
    migrating.add(row.id)
    try {
      return await migrate(row)
    } finally {
      migrating.delete(row.id)
    }
  }

  async function fetchAll(query?: string): Promise<T[]> {
    const url = query ? `${path}?${query}` : path
    const rows = await apiGet<T[]>(url)
    const parsed = rows.map((r) => parseDates<T>(r, dateFields))
    if (!migrate) return parsed
    return Promise.all(parsed.map(runMigrate))
  }

  async function fetchOne(id: number): Promise<T | undefined> {
    const row = await apiGet<T>(`${path}/${id}`)
    if (!row) return undefined
    const parsed = parseDates<T>(row, dateFields)
    return runMigrate(parsed)
  }

  return {
    toArray: fetchAll,

    get: fetchOne,

    add: async (item) => {
      const body = stripServerFields(item as Record<string, unknown>)
      const created = await apiPost<T & { id: number }>(path, body)
      const parsed = parseDates<T & { id: number }>(created, dateFields)
      notifySync(path, 'add', created.id, parsed)
      return created.id
    },

    update: async (id, patch): Promise<T> => {
      const body = stripServerFields(patch as Record<string, unknown>)
      const updated = await apiPatch<T>(`${path}/${id}`, body)
      const parsed = parseDates<T>(updated, dateFields)
      notifySync(path, 'update', id, parsed)
      return parsed
    },

    delete: async (id) => {
      await apiDelete<unknown>(`${path}/${id}`)
      notifySync(path, 'delete', id)
    },

    clear: async () => {
      const rows = await fetchAll()
      await Promise.all(rows.map(async (row) => {
        if (row.id === undefined) return
        await apiDelete<unknown>(`${path}/${row.id}`)
        notifySync(path, 'delete', row.id)
      }))
    },

    count: async () => {
      const rows = await fetchAll()
      return rows.length
    },

    where: (field: string) => {
      const match = async (expected: unknown): Promise<T[]> => {
        const rows = await fetchAll()
        if (field.startsWith('[')) {
          // Compound index: expected is an array, compare element-by-element.
          const expectedArr = Array.isArray(expected) ? expected : [expected]
          return rows.filter((row) => {
            const actualArr = field
              .slice(1, -1)
              .split('+')
              .map((k) => (row as Record<string, unknown>)[k])
            return expectedArr.every((v, i) => v === actualArr[i])
          })
        }
        return rows.filter((row) => (row as Record<string, unknown>)[field] === expected)
      }

      return {
        equals: (value: unknown) => ({
          first: async () => (await match(value))[0],
          toArray: () => match(value),
          count: async () => (await match(value)).length,
        }),
        anyOf: (values: unknown[]) => ({
          toArray: async () => {
            const rows = await fetchAll()
            return rows.filter((row) => values.includes((row as Record<string, unknown>)[field]))
          },
        }),
        filter: (predicate: (row: T) => boolean) => ({
          toArray: async () => {
            const rows = await fetchAll()
            return rows.filter(predicate)
          },
          count: async () => {
            const rows = await fetchAll()
            return rows.filter(predicate).length
          },
        }),
      }
    },

    put: async (item) => {
      if (item.id !== undefined) {
        const updated = await apiPut<T>(`${path}/${item.id}`, stripServerFields(item as Record<string, unknown>))
        const parsed = parseDates<T>(updated, dateFields)
        notifySync(path, 'update', item.id, parsed)
        return item.id
      }
      const created = await apiPost<T & { id: number }>(path, stripServerFields(item as Record<string, unknown>))
      const parsed = parseDates<T & { id: number }>(created, dateFields)
      notifySync(path, 'add', created.id, parsed)
      return created.id
    },
  }
}

// Settings is keyed by string and uses PUT /:key with a { value } wrapper.
// Keys often contain `:` (e.g. `warehouse:60:layerOrder`) so we
// `encodeURIComponent` before appending — unescaped colons are legal
// path chars but many intermediaries (Vite's dev proxy, some CDNs) still
// mishandle them, which was returning 404 for every layer-order load
// and forcing a refetch cascade on every hot-reload.
function makeSettingsTable() {
  return {
    get: async (key: string): Promise<Setting | undefined> => {
      try {
        // The backend replies 200 with `{ value: null }` (not 404) for a key
        // that has never been written — a fresh warehouse's `layerOrder`, for
        // example. Callers here expect `undefined` for "no saved setting", so
        // collapse both shapes to `undefined`.
        const row = await apiGet<Setting | { key: string; value: null }>(
          `/settings/${encodeURIComponent(key)}`,
        )
        if (row == null || row.value == null) return undefined
        return row as Setting
      } catch (err) {
        // Kept for older backends that still return 404 for unknown keys.
        if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 404) {
          return undefined
        }
        throw err
      }
    },
    put: async (item: Setting) => {
      await apiPut<unknown>(
        `/settings/${encodeURIComponent(item.key)}`,
        { value: item.value },
      )
    },
    toArray: async () => {
      // Backend exposes `GET /settings` returning all key/value rows. Used
      // by the settings dialog to populate the global-tab form.
      return apiGet<Setting[]>('/settings')
    },
  }
}

// ---- First-read binary migration -----------------------------------------
// Legacy backend rows may still carry inline `imageData` / `data`. On the
// first fetch we upload the bytes to object storage and patch the row to
// use the resulting URL, then return the patched row to callers.

async function migrateImageRow(row: ImageShape): Promise<ImageShape> {
  if (!imageNeedsUpload(row) || row.id === undefined) return row
  const file = fileFromImageData(row)
  if (!file) return row
  try {
    const uploaded = await uploadImage(file)
    await apiDb.images.update(row.id, {
      imageUrl: uploaded.url,
      imageData: undefined,
      updatedAt: new Date(),
    })
    return { ...row, imageUrl: uploaded.url, imageData: undefined }
  } catch (err) {
    console.warn('[apiDb] image migration failed', row.id, err)
    return row
  }
}

async function migrateUserModelRow(row: UserModel): Promise<UserModel> {
  if (!modelNeedsUpload(row) || row.id === undefined) return row
  const file = fileFromModelData(row)
  if (!file) return row
  try {
    const uploaded = await uploadModel(file)
    await apiDb.userModels.update(row.id, {
      modelUrl: uploaded.url,
      data: undefined,
      bytes: uploaded.bytes,
    })
    return { ...row, modelUrl: uploaded.url, data: undefined, bytes: uploaded.bytes }
  } catch (err) {
    console.warn('[apiDb] user-model migration failed', row.id, err)
    return row
  }
}

export const apiDb = {
  zones: makeTable<Zone>('/zones', { dateFields: ['createdAt', 'updatedAt'] }),
  grids: makeTable<Grid>('/grids', { dateFields: ['createdAt', 'updatedAt'] }),
  polygons: makeTable<PolygonShape>('/polygons', { dateFields: ['createdAt', 'updatedAt'] }),
  circles: makeTable<CircleShape>('/circles', { dateFields: ['createdAt', 'updatedAt'] }),
  lines: makeTable<LineShape>('/lines', { dateFields: ['createdAt', 'updatedAt'] }),
  routes: makeTable<RouteShape>('/routes', { dateFields: ['createdAt', 'updatedAt'] }),
  stairs: makeTable<StairShape>('/stairs', { dateFields: ['createdAt', 'updatedAt'] }),
  doors: makeTable<DoorShape>('/doors', { dateFields: ['createdAt', 'updatedAt'] }),
  markers: makeTable<MarkerShape>('/markers', { dateFields: ['createdAt', 'updatedAt'] }),
  images: makeTable<ImageShape>('/images', { dateFields: ['createdAt', 'updatedAt'], migrate: migrateImageRow }),
  models: makeTable<ModelShape>('/models', { dateFields: ['createdAt', 'updatedAt'] }),
  imagePlanes: makeTable<ImagePlaneShape>('/image-planes', { dateFields: ['createdAt', 'updatedAt'] }),
  textLabels: makeTable<TextLabelShape>('/text-labels', { dateFields: ['createdAt', 'updatedAt'] }),
  userModels: makeTable<UserModel>('/user-models', { dateFields: ['createdAt'], migrate: migrateUserModelRow }),
  bins: makeTable<Bin>('/bins', { dateFields: ['lastSyncedAt', 'updatedAt'] }),
  attributeDefinitions: makeTable<AttributeDefinition>('/attribute-definitions', {
    dateFields: ['createdAt'],
  }),
  styleRules: makeTable<StyleRuleRow>('/style-rules', { dateFields: ['createdAt', 'updatedAt'] }),
  dataSources: makeTable<DataSource>('/data-sources', {
    dateFields: ['createdAt', 'updatedAt', 'lastRunAt'],
  }),
  importJobs: makeTable<ImportJob>('/import-jobs', {
    dateFields: ['startedAt', 'finishedAt'],
  }),
  connections: makeTable<Connection>('/connections', {
    dateFields: ['createdAt', 'updatedAt'],
  }),
  streams: makeTable<Stream>('/streams', { dateFields: ['createdAt', 'updatedAt'] }),
  tenants: makeTable<Tenant>('/tenants', { dateFields: ['createdAt'] }),
  references: makeTable<Reference>('/references', { dateFields: ['createdAt', 'updatedAt'] }),
  correlationRules: makeTable<CorrelationRule>('/correlation-rules', {
    dateFields: ['createdAt', 'updatedAt', 'lastFiredAt'],
  }),
  alerts: makeTable<Alert>('/alerts', { dateFields: ['ts', 'acknowledgedAt'] }),
  auditLog: makeTable<AuditLogEntry>('/audit-log', { dateFields: ['ts'] }),
  // Slice 6c2 — apiDb.shipments removed alongside the backend
  // `/shipments` handler + `shipments` table. Live shipment records
  // land in entity_states via `POST /streams/:id/ingest`.
  dataLinkConfigs: makeTable<DataLinkConfig>('/data-links', {
    dateFields: ['createdAt', 'updatedAt'],
  }),
  settings: makeSettingsTable(),
}

/** True when any bin linked to the grid was written by an external data source. */
export async function isGridGeometryLocked(gridId: number): Promise<boolean> {
  const rows = await apiDb.bins.where('gridId').equals(gridId).toArray()
  return rows.some((b) => b.externalCode !== undefined || b.syncSource !== undefined)
}

/** Delete every bin row belonging to a grid. */
export async function deleteBinsForGrid(gridId: number): Promise<void> {
  const rows = await apiDb.bins.where('gridId').equals(gridId).toArray()
  await Promise.all(rows.map((row) => (row.id !== undefined ? apiDb.bins.delete(row.id) : Promise.resolve())))
}

/** Look up a grid-cell bin by its (gridId, row, col, level) address. */
export async function getBin(
  gridId: number,
  row: number,
  col: number,
  level: number,
): Promise<Bin | null> {
  const row_ = await apiDb.bins
    .where('[gridId+row+col+level]')
    .equals([gridId, row, col, level])
    .first()
  return row_ ?? null
}

/** Upsert a grid-cell bin row. */
export async function upsertBin(
  gridId: number,
  row: number,
  col: number,
  level: number,
  patch: Partial<Omit<Bin, 'id' | 'gridId' | 'row' | 'col' | 'level' | 'targetKind' | 'shapeId' | 'updatedAt'>>,
): Promise<void> {
  const existing = await getBin(gridId, row, col, level)
  const now = new Date()
  if (existing && existing.id !== undefined) {
    // Backend PATCH /bins/{id} is a full-row REPLACE and validates
    // `targetKind` as required — so we must send the WHOLE row, not
    // just the diff, or (a) validation fails with a 400 toast on every
    // keystroke and (b) unspecified columns (syncSource, floorPlanId,
    // gridId/row/col/level, shapeId) get nulled out. Merge existing
    // over the patch and reassert the immutable coordinates.
    await apiDb.bins.update(existing.id, {
      ...existing,
      ...patch,
      targetKind: 'grid-cell',
      gridId,
      row,
      col,
      level,
      updatedAt: now,
    })
  } else {
    await apiDb.bins.add({
      targetKind: 'grid-cell',
      gridId,
      row,
      col,
      level,
      status: 'empty',
      ...patch,
      updatedAt: now,
    })
  }
}

/** Look up the bin row attached to a non-grid shape. */
export async function getBinForShape(
  kind: Exclude<BindingKind, 'grid-cell'>,
  shapeId: number,
): Promise<Bin | null> {
  const row = await apiDb.bins.where('[targetKind+shapeId]').equals([kind, shapeId]).first()
  return row ?? null
}

/** Upsert a whole-shape binding. */
export async function upsertShapeBin(
  kind: Exclude<BindingKind, 'grid-cell'>,
  shapeId: number,
  patch: Partial<Omit<Bin, 'id' | 'gridId' | 'row' | 'col' | 'level' | 'targetKind' | 'shapeId' | 'updatedAt'>>,
): Promise<void> {
  const existing = await getBinForShape(kind, shapeId)
  const now = new Date()
  if (existing && existing.id !== undefined) {
    // Backend PATCH /bins/{id} is a full-row REPLACE and validates
    // `targetKind` as required — so we must send the WHOLE row, not
    // just the diff, or (a) validation fails with a 400 toast on every
    // keystroke into SKU / notes / external code and (b) unspecified
    // columns (syncSource, floorPlanId, shapeId, targetKind) get
    // nulled out. Merge existing over the patch and reassert the
    // immutable target coordinates.
    await apiDb.bins.update(existing.id, {
      ...existing,
      ...patch,
      targetKind: kind,
      shapeId,
      updatedAt: now,
    })
  } else {
    await apiDb.bins.add({
      targetKind: kind,
      shapeId,
      ...patch,
      updatedAt: now,
    })
  }
}

/** Look up a bin by its external code. */
export async function getBinByExternalCode(code: string): Promise<Bin | null> {
  const row = await apiDb.bins.where('externalCode').equals(code).first()
  return row ?? null
}
