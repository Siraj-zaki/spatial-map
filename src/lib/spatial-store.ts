/**
 * Optimistic, local-first spatial state store for the map editor.
 *
 * Every edit to a catalog entity goes through here so the map and the side
 * panel update instantly while the server catches up:
 *
 * 1. **Drafts.** `updateLocal` writes a local draft over the server row; the
 *    UI reads `row + draft` (see `useSpatialShapes`). Drafts are kept per
 *    kind, so editing a rack re-renders only racks — not every overlay.
 *    A draft stays until the server confirms that value, so the UI never
 *    snaps back to the old value while a save is in flight.
 * 2. **Settle, then save.** Changes are sent after the user stops changing
 *    things for `getSpatialDebounceMs()` (400 ms), or at once on `commit()`
 *    (slider release, Enter, toggles). One request per entity carries every
 *    field changed since the last save.
 * 3. **One write in flight per entity.** Edits made while that entity's save
 *    is in flight queue up behind it and go out as one follow-up — never two
 *    concurrent PATCHes for the same row, so responses can't land out of
 *    order. Different entities save in parallel (up to `MAX_PARALLEL`).
 * 4. **Monotonic apply.** A server row only replaces the local one if its
 *    `updatedAt` isn't older; identical rows are skipped (no re-render). That
 *    makes late PATCH responses, SSE refetches and `loadKind` lists safe.
 * 5. **No self-echo.** The SSE broadcast our own save causes is recognised
 *    (`isSelfEcho`) and not refetched; changes from other clients still are.
 * 6. **Failures are visible.** Network / 5xx failures keep the draft, retry
 *    with backoff and show in `sync.failed`; 4xx failures (the server refused
 *    the value) roll back and are reported once.
 *
 * Creates render instantly under a temporary negative id and are remapped to
 * the server id when the POST returns. The store is scoped to the layout
 * editor; other pages keep using `useApiQuery`.
 */

import { create } from 'zustand'
import { ApiError } from './api-client'
import { apiDb, setEntitySync } from './api-db'
import { queryCache } from './useApiQuery'
import type { AttributeDefinition, Grid, Zone, Bin, DataLinkConfig } from './db'
import type {
  CircleShape,
  ImagePlaneShape,
  ImageShape,
  LineShape,
  MarkerShape,
  ModelShape,
  PolygonShape,
  RouteShape,
  StairShape,
  TextLabelShape,
} from './shapes'
import type { DoorShape } from './door/types'
import type { StyleRule } from './style-rules/types'
import type { Connection, Stream } from './data-link/contracts'

export type CatalogEntity =
  | Zone
  | Grid
  | Bin
  | PolygonShape
  | CircleShape
  | LineShape
  | RouteShape
  | MarkerShape
  | ImageShape
  | ModelShape
  | ImagePlaneShape
  | StairShape
  | DoorShape
  | TextLabelShape
  | StyleRule
  | AttributeDefinition
  | Connection
  | Stream
  | DataLinkConfig

export type EntityKind =
  | 'zones'
  | 'grids'
  | 'bins'
  | 'polygons'
  | 'circles'
  | 'lines'
  | 'routes'
  | 'markers'
  | 'images'
  | 'models'
  | 'image-planes'
  | 'stairs'
  | 'doors'
  | 'text-labels'
  | 'style-rules'
  | 'attribute-definitions'
  | 'connections'
  | 'streams'
  | 'data-link-configs'

type Draft = Partial<CatalogEntity> & { __deleted?: boolean }
export type KindDrafts = ReadonlyMap<number, Draft>

interface PendingMutation {
  id: number
  kind: EntityKind
  operation: 'create' | 'update' | 'delete'
  payload: Record<string, unknown>
  /** Send as soon as the entity is free, skipping the settle delay. */
  urgent: boolean
  waiters: Array<{ resolve: (v?: unknown) => void; reject: (e: unknown) => void }>
}

export interface SyncFailure {
  kind: EntityKind
  id: number
  message: string
  /** False once the store has rolled the change back (the server refused it). */
  retrying: boolean
}

export interface SyncStatus {
  /** Entities with changes not yet confirmed by the server (queued or sending). */
  pending: number
  /** Requests on the wire right now. */
  sending: number
  failed: SyncFailure[]
  /** When the last save was confirmed (ms epoch), for "Saved just now". */
  lastSavedAt: number | null
}

interface SpatialState {
  tenantId: number | null
  /**
   * Currently-active warehouse (zone) id. When set, every `loadKind` /
   * `loadAll` call — including SSE-driven reloads — sends the
   * corresponding `?zoneId=…` query so the backend returns ONLY this
   * warehouse's shapes. `null` means tenant-scoped fetches.
   */
  activeZoneId: number | null
  isLoading: Record<EntityKind, boolean>
  /**
   * The warehouse scope each kind last finished loading for (`null` =
   * tenant-wide, `undefined` = never loaded). A failed load counts as done
   * (see `error`) so nothing waits on it forever.
   * "Loaded for THIS warehouse" is `loadedFor[kind] === activeZoneId` —
   * what loading-vs-empty states and the editor's first camera fit wait on.
   */
  loadedFor: Record<EntityKind, number | null | undefined>
  error: Record<EntityKind, Error | null>
  // Local snapshots keyed by entity kind.
  zones: Zone[]
  grids: Grid[]
  bins: Bin[]
  polygons: PolygonShape[]
  circles: CircleShape[]
  lines: LineShape[]
  routes: RouteShape[]
  markers: MarkerShape[]
  images: ImageShape[]
  models: ModelShape[]
  imagePlanes: ImagePlaneShape[]
  stairs: StairShape[]
  doors: DoorShape[]
  textLabels: TextLabelShape[]
  styleRules: StyleRule[]
  attributeDefinitions: AttributeDefinition[]
  connections: Connection[]
  streams: Stream[]
  dataLinkConfigs: DataLinkConfig[]
  /** Optimistic drafts per kind: id → local override (negative ids = unsaved creates). */
  drafts: Record<EntityKind, KindDrafts>
  sync: SyncStatus
  // Operations
  setTenantId: (id: number) => void
  setActiveZoneId: (id: number | null) => void
  loadAll: () => Promise<void>
  loadKind: (kind: EntityKind, opts?: { zoneId?: number }) => Promise<void>
  loadEntity: (kind: EntityKind, id: number) => Promise<void>
  updateLocal: <T extends CatalogEntity>(kind: EntityKind, id: number, patch: Partial<T>) => void
  /** One store update for many entities of a kind (bulk edits). */
  updateManyLocal: <T extends CatalogEntity>(kind: EntityKind, patches: ReadonlyArray<readonly [number, Partial<T>]>) => void
  createLocal: <T extends CatalogEntity>(kind: EntityKind, item: Omit<T, 'id'>) => Promise<T>
  deleteLocal: (kind: EntityKind, id: number) => void
  /**
   * Save now instead of after the settle delay. With an id, resolves when
   * that entity's changes are confirmed; without one, flushes everything.
   */
  commit: (kind?: EntityKind, id?: number) => Promise<void>
  flush: () => Promise<void>
  /** Re-send every failed change now. */
  retryFailed: () => void
  /** Forget a reported failure (after the UI has shown it). */
  dismissFailure: (kind: EntityKind, id: number) => void
  /** True when an SSE event for this entity is (almost certainly) the echo of our own save. */
  isSelfEcho: (kind: EntityKind, id: number) => boolean
  /** True while this entity has unconfirmed local changes. */
  hasPending: (kind: EntityKind, id: number) => boolean
  applyServerEntity: <T extends CatalogEntity>(kind: EntityKind, entity: T) => void
  removeServerEntity: (kind: EntityKind, id: number) => void
}

/**
 * How long after the last change we wait before saving. Override at runtime
 * with `window.__SPATIAL_STORE_DEBOUNCE_MS__ = 250` in tests — re-read on
 * every schedule, so no reload is needed.
 */
const DEFAULT_DEBOUNCE_MS = 400
export function getSpatialDebounceMs(): number {
  const override = (globalThis as { __SPATIAL_STORE_DEBOUNCE_MS__?: number }).__SPATIAL_STORE_DEBOUNCE_MS__
  return typeof override === 'number' && override >= 0 ? override : DEFAULT_DEBOUNCE_MS
}
const MAX_PARALLEL = 4
/** An SSE event this soon after our own confirmed save of the same row is its echo. */
const SELF_ECHO_WINDOW_MS = 2500
const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000]

const ALL_KINDS: EntityKind[] = [
  'zones',
  'grids',
  'bins',
  'polygons',
  'circles',
  'lines',
  'routes',
  'markers',
  'images',
  'models',
  'image-planes',
  'stairs',
  'doors',
  'text-labels',
  'style-rules',
  'attribute-definitions',
  'connections',
  'streams',
  'data-link-configs',
]

const tablePath: Record<EntityKind, keyof typeof apiDb> = {
  zones: 'zones',
  grids: 'grids',
  bins: 'bins',
  polygons: 'polygons',
  circles: 'circles',
  lines: 'lines',
  routes: 'routes',
  markers: 'markers',
  images: 'images',
  models: 'models',
  'image-planes': 'imagePlanes',
  stairs: 'stairs',
  doors: 'doors',
  'text-labels': 'textLabels',
  'style-rules': 'styleRules',
  'attribute-definitions': 'attributeDefinitions',
  connections: 'connections',
  streams: 'streams',
  'data-link-configs': 'dataLinkConfigs',
}

const kindStateKey: Record<EntityKind, keyof SpatialState> = {
  zones: 'zones',
  grids: 'grids',
  bins: 'bins',
  polygons: 'polygons',
  circles: 'circles',
  lines: 'lines',
  routes: 'routes',
  markers: 'markers',
  images: 'images',
  models: 'models',
  'image-planes': 'imagePlanes',
  stairs: 'stairs',
  doors: 'doors',
  'text-labels': 'textLabels',
  'style-rules': 'styleRules',
  'attribute-definitions': 'attributeDefinitions',
  connections: 'connections',
  streams: 'streams',
  'data-link-configs': 'dataLinkConfigs',
}

function entityKey(kind: EntityKind, id: number): string {
  return `${kind}:${id}`
}

function perKind<V>(make: () => V): Record<EntityKind, V> {
  return Object.fromEntries(ALL_KINDS.map((k) => [k, make()])) as Record<EntityKind, V>
}

/** Structural equality for draft values (configs are small JSON objects). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function timeOf(v: unknown): number | null {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

/** Should `incoming` replace `current`? Not when it's older, nor when nothing changed. */
function isNewer(current: CatalogEntity | undefined, incoming: CatalogEntity): boolean {
  if (!current) return true
  const a = timeOf((current as { updatedAt?: unknown }).updatedAt)
  const b = timeOf((incoming as { updatedAt?: unknown }).updatedAt)
  if (a !== null && b !== null) {
    if (b < a) return false
    if (b === a) return !sameValue(current, incoming)
    return true
  }
  return !sameValue(current, incoming)
}

/** Is the failure worth retrying (network / server), or did the server refuse the value? */
function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) {
    const st = err.status ?? 0
    return st === 0 || st >= 500 || st === 408 || st === 429
  }
  return true // fetch failures (offline, DNS, CORS) carry no status
}

// ---- write pipeline (module scope: shared across components, survives re-renders)

const pending = new Map<string, PendingMutation>()
const inFlight = new Set<string>()
/** key → when our own save of it was last confirmed (for SSE self-echo detection). */
const confirmedAt = new Map<string, number>()
/** Temp id → server id, so late edits / selections on a just-created entity still land. */
const tempToServer = new Map<string, number>()
const retryAttempt = new Map<string, number>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let nextTempId = -1
const loadsInFlight = new Map<string, Promise<void>>()
/**
 * Draft patches not yet applied to state. `updateLocal` stages here and
 * applies once per animation frame, so a slider firing faster than the map
 * can redraw costs one render per frame, not one per pointer event. The
 * write queue (`pending`) is updated immediately — nothing is lost.
 */
const staged = new Map<EntityKind, Map<number, Draft>>()
let stagedFrame: number | null = null

const requestFrame = (cb: () => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number)
const cancelFrame = (h: number) =>
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(h) : clearTimeout(h as unknown as ReturnType<typeof setTimeout>)
/** Set once the store exists; lets module-level helpers apply staged drafts. */
let applyStagedRef: () => void = () => {}

function resolveId(kind: EntityKind, id: number): number {
  return id < 0 ? (tempToServer.get(entityKey(kind, id)) ?? id) : id
}

export const useSpatialStore = create<SpatialState>((set, get) => {
  const setKindDrafts = (kind: EntityKind, fn: (m: Map<number, Draft>) => void) => {
    // Staged patches go first so this change applies on top of them.
    if (staged.size > 0) applyStagedRef()
    set((s) => {
      const next = new Map(s.drafts[kind])
      fn(next)
      return { drafts: { ...s.drafts, [kind]: next } }
    })
  }

  /** Apply staged draft patches in one store update. */
  const applyStaged = () => {
    if (stagedFrame !== null) {
      cancelFrame(stagedFrame)
      stagedFrame = null
    }
    if (staged.size === 0) return
    const batch = new Map(staged)
    staged.clear()
    set((s) => {
      const drafts = { ...s.drafts }
      for (const [kind, patches] of batch) {
        const next = new Map(drafts[kind])
        for (const [id, patch] of patches) {
          const cur = next.get(id)
          if (cur?.__deleted) continue
          next.set(id, { ...(cur ?? {}), ...patch })
        }
        drafts[kind] = next
      }
      return { drafts, sync: { ...s.sync, pending: pending.size + inFlight.size, sending: inFlight.size } }
    })
  }
  applyStagedRef = applyStaged

  const stage = (kind: EntityKind, id: number, patch: Draft) => {
    let m = staged.get(kind)
    if (!m) staged.set(kind, (m = new Map()))
    m.set(id, { ...(m.get(id) ?? {}), ...patch })
    if (stagedFrame === null) stagedFrame = requestFrame(applyStaged)
  }

  const refreshSync = (patch: Partial<SyncStatus> = {}) => {
    set((s) => ({ sync: { ...s.sync, pending: pending.size + inFlight.size, sending: inFlight.size, ...patch } }))
  }

  const setFailure = (f: SyncFailure | null, kind: EntityKind, id: number) => {
    set((s) => {
      const rest = s.sync.failed.filter((x) => !(x.kind === kind && x.id === id))
      return { sync: { ...s.sync, failed: f ? [...rest, f] : rest } }
    })
  }

  const scheduleFlush = (delay = getSpatialDebounceMs()) => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null
      void get().flush()
    }, delay)
  }

  /** Queue (or merge into) the pending mutation for an entity. */
  const enqueue = (kind: EntityKind, id: number, operation: PendingMutation['operation'], payload: Record<string, unknown>) => {
    const key = entityKey(kind, id)
    const existing = pending.get(key)
    if (existing) {
      if (operation === 'delete') {
        // A queued-but-unsent create that's deleted again never needs to reach the server.
        if (existing.operation === 'create') {
          pending.delete(key)
          existing.waiters.forEach((w) => w.resolve())
          return null
        }
        existing.operation = 'delete'
        existing.payload = {}
      } else {
        existing.payload = { ...existing.payload, ...payload }
      }
      return existing
    }
    const m: PendingMutation = { id, kind, operation, payload: { ...payload }, urgent: false, waiters: [] }
    pending.set(key, m)
    return m
  }

  /** Send one entity's queued mutation. The caller has checked it isn't in flight. */
  const send = async (m: PendingMutation) => {
    const { kind } = m
    const key = entityKey(kind, m.id)
    const table = apiDb[tablePath[kind]] as unknown as {
      add: (item: CatalogEntity) => Promise<number>
      update: (id: number, patch: Partial<CatalogEntity>) => Promise<CatalogEntity>
      delete: (id: number) => Promise<void>
    }
    inFlight.add(key)
    refreshSync()
    try {
      if (m.operation === 'delete') {
        if (m.id > 0) await table.delete(m.id)
        // api-db's sync callback drops the row; the delete draft goes with it.
        setKindDrafts(kind, (d) => d.delete(m.id))
      } else if (m.operation === 'create') {
        const serverId = await table.add(m.payload as unknown as CatalogEntity)
        tempToServer.set(key, serverId)
        // The server row is in s.<kind> now (api-db sync); retire the temp
        // draft, and carry edits made during the POST over to the real id.
        const later = pending.get(key)
        setKindDrafts(kind, (d) => d.delete(m.id))
        if (later) {
          pending.delete(key)
          if (later.operation === 'delete') {
            enqueue(kind, serverId, 'delete', {})!.waiters.push(...later.waiters)
            setKindDrafts(kind, (d) => d.set(serverId, { __deleted: true }))
          } else {
            const moved = enqueue(kind, serverId, 'update', later.payload)!
            moved.waiters.push(...later.waiters)
            setKindDrafts(kind, (d) => d.set(serverId, { ...(later.payload as Draft) }))
          }
        }
        m.waiters.forEach((w) => w.resolve(serverId))
        m.waiters = []
      } else {
        const flushed = m.payload
        await table.update(m.id, flushed as Partial<CatalogEntity>)
        // Confirmed: drop draft fields whose value is what we just saved;
        // keep any the user changed again while the request was in flight.
        setKindDrafts(kind, (d) => {
          const draft = d.get(m.id) as Record<string, unknown> | undefined
          if (!draft) return
          const remaining: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(draft)) {
            if (!(k in flushed) || !sameValue(v, flushed[k])) remaining[k] = v
          }
          if (Object.keys(remaining).length > 0) d.set(m.id, remaining as Draft)
          else d.delete(m.id)
        })
      }
      confirmedAt.set(key, Date.now())
      retryAttempt.delete(key)
      setFailure(null, kind, m.id)
      if (m.operation !== 'create') m.waiters.forEach((w) => w.resolve())
      queryCache.invalidate(kind)
      refreshSync({ lastSavedAt: Date.now() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isRetryable(err) && m.operation !== 'create') {
        // Keep the draft (the UI still shows the user's value) and try again.
        // Changes queued during the failed request win over the failed payload.
        const queued = pending.get(key)
        const merged = queued ?? enqueue(kind, m.id, m.operation, m.payload)
        if (queued) queued.payload = queued.operation === 'delete' ? {} : { ...m.payload, ...queued.payload }
        if (merged) {
          merged.waiters.unshift(...m.waiters)
          const n = retryAttempt.get(key) ?? 0
          retryAttempt.set(key, n + 1)
          setFailure({ kind, id: m.id, message, retrying: true }, kind, m.id)
          scheduleFlush(RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length - 1)])
        }
      } else {
        // The server refused it (or a create failed): roll back to the
        // server's version and say so once.
        setKindDrafts(kind, (d) => d.delete(m.id))
        setFailure({ kind, id: m.id, message, retrying: false }, kind, m.id)
        if (m.id > 0) void get().loadEntity(kind, m.id)
        m.waiters.forEach((w) => w.reject(err))
      }
    } finally {
      inFlight.delete(key)
      refreshSync()
      // Edits that queued up behind this request go next.
      const next = pending.get(key)
      if (next) {
        if (next.urgent) scheduleFlush(0)
        else if (!flushTimer) scheduleFlush()
      }
    }
  }

  return {
    tenantId: null,
    activeZoneId: null,
    isLoading: perKind(() => false),
    loadedFor: perKind(() => undefined),
    error: perKind(() => null),
    zones: [],
    grids: [],
    bins: [],
    polygons: [],
    circles: [],
    lines: [],
    routes: [],
    markers: [],
    images: [],
    models: [],
    imagePlanes: [],
    stairs: [],
    doors: [],
    textLabels: [],
    styleRules: [],
    attributeDefinitions: [],
    connections: [],
    streams: [],
    dataLinkConfigs: [],
    drafts: perKind(() => new Map()),
    sync: { pending: 0, sending: 0, failed: [], lastSavedAt: null },

    setTenantId(id) {
      set({ tenantId: id })
    },

    setActiveZoneId(id) {
      set({ activeZoneId: id })
    },

    async loadAll() {
      await Promise.all(ALL_KINDS.map((kind) => get().loadKind(kind)))
    },

    async loadKind(kind, opts) {
      const table = apiDb[tablePath[kind]] as { toArray: (query?: string) => Promise<CatalogEntity[]> }
      // Per-warehouse scoping: shape kinds take `zoneId` so the backend
      // (`shape_crud.go::shapeList`) returns only that warehouse's rows;
      // tenant-scoped catalogs ignore the param.
      const explicit = opts?.zoneId
      const effectiveZoneId = explicit !== undefined ? explicit : get().activeZoneId
      const query = effectiveZoneId !== null && effectiveZoneId !== undefined ? `zoneId=${effectiveZoneId}` : undefined
      // The same list already loading (a second caller, StrictMode's double
      // effect, an SSE burst) shares that request.
      const loadKey = `${kind}?${query ?? ''}`
      const running = loadsInFlight.get(loadKey)
      if (running) return running
      const run = (async () => {
      set((s) => ({ isLoading: { ...s.isLoading, [kind]: true }, error: { ...s.error, [kind]: null } }))
      try {
        const rows = (await table.toArray(query)) as CatalogEntity[]
        set((s) => {
          // Keep any local row newer than the list (a save confirmed while
          // the list was in flight) — the list can be older than our write.
          const current = new Map(((s[kindStateKey[kind]] as CatalogEntity[]) ?? []).map((r) => [r.id, r]))
          const merged = rows.map((r) => {
            const mine = current.get(r.id)
            return mine && !isNewer(mine, r) ? mine : r
          })
          return {
            [kindStateKey[kind]]: merged,
            isLoading: { ...s.isLoading, [kind]: false },
            loadedFor: { ...s.loadedFor, [kind]: effectiveZoneId ?? null },
          } as Partial<SpatialState>
        })
      } catch (err) {
        set((s) => ({
          isLoading: { ...s.isLoading, [kind]: false },
          loadedFor: { ...s.loadedFor, [kind]: effectiveZoneId ?? null },
          error: { ...s.error, [kind]: err instanceof Error ? err : new Error(String(err)) },
        }))
      }
      })()
      loadsInFlight.set(loadKey, run)
      try {
        await run
      } finally {
        loadsInFlight.delete(loadKey)
      }
    },

    async loadEntity(kind, id) {
      const table = apiDb[tablePath[kind]] as { get: (id: number) => Promise<CatalogEntity | undefined> }
      try {
        const row = await table.get(id)
        if (row) get().applyServerEntity(kind, row)
        else get().removeServerEntity(kind, id)
      } catch (err) {
        // 404 = deleted server-side; drop it so the UI reflects that.
        if (err instanceof ApiError && err.status === 404) {
          get().removeServerEntity(kind, id)
          return
        }
        console.warn(`[spatialStore] failed to load ${kind}/${id}`, err)
      }
    },

    updateLocal<T extends CatalogEntity>(kind: EntityKind, rawId: number, patch: Partial<T>) {
      const id = resolveId(kind, rawId)
      stage(kind, id, patch as Draft)
      const key = entityKey(kind, id)
      const queuedCreate = pending.get(key)?.operation === 'create'
      enqueue(kind, id, queuedCreate ? 'create' : 'update', patch as Record<string, unknown>)
      scheduleFlush()
    },

    updateManyLocal<T extends CatalogEntity>(kind: EntityKind, patches: ReadonlyArray<readonly [number, Partial<T>]>) {
      if (patches.length === 0) return
      const resolved = patches.map(([rawId, patch]) => [resolveId(kind, rawId), patch] as const)
      for (const [id, patch] of resolved) {
        stage(kind, id, patch as Draft)
        const queuedCreate = pending.get(entityKey(kind, id))?.operation === 'create'
        enqueue(kind, id, queuedCreate ? 'create' : 'update', patch as Record<string, unknown>)
      }
      scheduleFlush()
    },

    createLocal<T extends CatalogEntity>(kind: EntityKind, item: Omit<T, 'id'>): Promise<T> {
      const tempId = nextTempId--
      setKindDrafts(kind, (d) => d.set(tempId, { ...(item as Draft), id: tempId } as Draft))
      return new Promise<T>((resolve, reject) => {
        const m = enqueue(kind, tempId, 'create', item as Record<string, unknown>)!
        m.urgent = true
        m.waiters.push({
          resolve: (serverId) => resolve({ ...(item as object), id: serverId as number } as T),
          reject,
        })
        refreshSync()
        scheduleFlush(0)
      })
    },

    deleteLocal(kind, rawId) {
      const id = resolveId(kind, rawId)
      setKindDrafts(kind, (d) => {
        if (id < 0 && pending.get(entityKey(kind, id))?.operation === 'create') d.delete(id)
        else d.set(id, { __deleted: true })
      })
      enqueue(kind, id, 'delete', {})
      refreshSync()
      scheduleFlush(0)
    },

    commit(kind, rawId) {
      if (kind === undefined || rawId === undefined) {
        for (const m of pending.values()) m.urgent = true
        return get().flush()
      }
      const id = resolveId(kind, rawId)
      const key = entityKey(kind, id)
      const m = pending.get(key)
      if (!m) {
        // Nothing queued; if a save is already in flight, there's nothing to add.
        return Promise.resolve()
      }
      m.urgent = true
      return new Promise<void>((resolve, reject) => {
        m.waiters.push({ resolve: () => resolve(), reject })
        if (inFlight.has(key)) return // it goes out the moment the current request lands
        scheduleFlush(0)
      })
    },

    async flush() {
      applyStaged()
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      // Everything not already on the wire, in queue order.
      const ready = [...pending.entries()].filter(([key]) => !inFlight.has(key))
      if (ready.length === 0) return
      for (const [key] of ready) pending.delete(key)
      const queue = ready.map(([, m]) => m)
      const worker = async () => {
        for (let m = queue.shift(); m; m = queue.shift()) await send(m)
      }
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, worker))
    },

    retryFailed() {
      retryAttempt.clear()
      for (const m of pending.values()) m.urgent = true
      void get().flush()
    },

    dismissFailure(kind, id) {
      setFailure(null, kind, id)
    },

    isSelfEcho(kind, id) {
      const key = entityKey(kind, id)
      if (pending.has(key) || inFlight.has(key)) return true
      const at = confirmedAt.get(key)
      return at !== undefined && Date.now() - at < SELF_ECHO_WINDOW_MS
    },

    hasPending(kind, id) {
      const key = entityKey(kind, resolveId(kind, id))
      return pending.has(key) || inFlight.has(key)
    },

    applyServerEntity(kind, entity) {
      const id = entity.id
      if (id === undefined) return
      const stateKey = kindStateKey[kind]
      const list = (get()[stateKey] as CatalogEntity[]) ?? []
      const idx = list.findIndex((r) => r.id === id)
      // Late responses, SSE refetches and duplicate applies are no-ops.
      if (idx >= 0 && !isNewer(list[idx], entity)) return
      const next = idx >= 0 ? [...list] : [...list, entity]
      if (idx >= 0) next[idx] = entity
      // Drafts are NOT cleared here — they're the user's unconfirmed edits
      // and keep showing on top; `send` retires them once confirmed.
      set({ [stateKey]: next } as Partial<SpatialState>)
    },

    removeServerEntity(kind, id) {
      const stateKey = kindStateKey[kind]
      const list = (get()[stateKey] as CatalogEntity[]) ?? []
      if (!list.some((r) => r.id === id)) return
      set({ [stateKey]: list.filter((r) => r.id !== id) } as Partial<SpatialState>)
    },
  }
})

// External hook used by the SSE listener: refetch one row unless it's our own echo.
export function applySSEEntityUpdate(kind: EntityKind, id: number): void {
  const s = useSpatialStore.getState()
  if (s.isSelfEcho(kind, id)) return
  void s.loadEntity(kind, id)
}

// Module-level helper for components/hooks that want to fire an optimistic
// local patch without subscribing to the store inside a useCallback.
export function patchSpatialEntity<T extends CatalogEntity>(kind: EntityKind, id: number, patch: Partial<T>): void {
  useSpatialStore.getState().updateLocal(kind, id, patch as Partial<CatalogEntity>)
}

/**
 * Patch from the entity's latest value (row + unsaved edits), not a value
 * captured at render — repeated key presses / nudges can't drop a step.
 * Saves when the edit settles. Returns false if the entity is gone.
 */
export function updateSpatialLatest<T extends CatalogEntity>(kind: EntityKind, id: number, fn: (current: T) => Partial<T>): boolean {
  const current = getSpatialEntity<T>(kind, id)
  if (!current) return false
  useSpatialStore.getState().updateLocal(kind, id, fn(current) as Partial<CatalogEntity>)
  return true
}

/** Patch and save at once (toggles, renames, discrete actions). */
export function saveSpatialEntity<T extends CatalogEntity>(kind: EntityKind, id: number, patch: Partial<T>): Promise<void> {
  const s = useSpatialStore.getState()
  s.updateLocal(kind, id, patch as Partial<CatalogEntity>)
  return s.commit(kind, id)
}

/**
 * Forget every snapshot, draft and queued write — for a workspace switch.
 * Call `commit()` first so edits made in the old workspace are saved there
 * (requests carry the tenant header current at send time).
 */
export function resetSpatialSession(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  pending.clear()
  staged.clear()
  confirmedAt.clear()
  tempToServer.clear()
  retryAttempt.clear()
  useSpatialStore.setState({
    activeZoneId: null,
    zones: [],
    grids: [],
    bins: [],
    polygons: [],
    circles: [],
    lines: [],
    routes: [],
    markers: [],
    images: [],
    models: [],
    imagePlanes: [],
    stairs: [],
    doors: [],
    textLabels: [],
    styleRules: [],
    attributeDefinitions: [],
    connections: [],
    streams: [],
    dataLinkConfigs: [],
    drafts: perKind(() => new Map()),
    loadedFor: perKind(() => undefined),
    sync: { pending: inFlight.size, sending: inFlight.size, failed: [], lastSavedAt: null },
  })
}

/**
 * The entity as the user currently sees it (server row + draft), read
 * straight from the store — use it to build a patch from the latest value
 * rather than a render-time closure that may be a frame behind.
 */
export function getSpatialEntity<T extends CatalogEntity>(kind: EntityKind, rawId: number): T | undefined {
  const id = resolveId(kind, rawId)
  const s = useSpatialStore.getState()
  const committed = s.drafts[kind].get(id)
  const pendingPatch = staged.get(kind)?.get(id)
  const draft = pendingPatch ? ({ ...(committed ?? {}), ...pendingPatch } as Draft) : committed
  if (draft?.__deleted) return undefined
  const row = ((s[kindStateKey[kind]] as CatalogEntity[]) ?? []).find((r) => r.id === id)
  if (!row) return id < 0 && draft ? (draft as unknown as T) : undefined
  return (draft ? { ...row, ...draft } : row) as T
}

/** The server id for an id that may still be a temporary (negative) one. */
export function resolveSpatialId(kind: EntityKind, id: number): number {
  return resolveId(kind, id)
}

// ---- api-db sync registration --------------------------------------------
// Reflect locally-initiated CRUD calls into the store the moment the backend
// confirms them, so rows appear / update / disappear without waiting for SSE.
const SPATIAL_KIND_SET: ReadonlySet<EntityKind> = new Set(ALL_KINDS)

function isTrackedKind(slug: string): slug is EntityKind {
  return SPATIAL_KIND_SET.has(slug as EntityKind)
}

/** URL slugs that differ from the EntityKind literal (`/data-links` → `data-link-configs`). */
const PATH_SLUG_TO_KIND: Record<string, EntityKind> = {
  'data-links': 'data-link-configs',
}

setEntitySync((kindSlug, op, id, row) => {
  const kind: EntityKind | undefined = isTrackedKind(kindSlug) ? kindSlug : PATH_SLUG_TO_KIND[kindSlug]
  if (!kind) return
  // Direct api-db writes (outside this store) are ours too: mark them so the
  // SSE echo of them isn't refetched.
  confirmedAt.set(entityKey(kind, id), Date.now())
  if (op === 'delete') {
    useSpatialStore.getState().removeServerEntity(kind, id)
    return
  }
  if (!row) return
  useSpatialStore.getState().applyServerEntity(kind, row as CatalogEntity)
})
