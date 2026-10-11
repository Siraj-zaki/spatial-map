/**
 * Door tool — persistence layer.
 *
 * The store owns the canonical door rows and the editor's default
 * config. Selection, draw-mode, anchor accumulation and any other
 * ephemeral UI state lives in the host route (`create-grids.tsx`) so
 * the door tool mirrors how the existing stair / line / polygon tools
 * separate persisted data from interactive state.
 *
 * Doors persist to the backend (`/api/v1/doors`) tenant- and
 * warehouse-scoped, mirroring the stairs/lines pattern. The store
 * caches the canonical row list in memory and applies mutations
 * optimistically; the server writes go through the spatial store's save
 * pipeline (`updateLocal` / `deleteLocal`), so a slider drag sends one
 * coalesced PATCH when it settles — never one per frame landing out of
 * order — and changes made elsewhere (SSE) flow back in. Only the
 * editor's `pendingConfig` is persisted to localStorage — the door
 * rows themselves are always sourced from the backend so a fresh
 * signup on a browser that used to hold another user's session can't
 * see leftover doors leak into the new tenant's warehouses.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { ApiError } from '../api-client'
import { apiDb } from '../api-db'
import { DEFAULT_DOOR_CONFIG, type DoorConfig, type DoorShape } from './types'
import { useSpatialStore } from '../spatial-store'
import { LIMIT_DOOR_WIDTH_M } from '@/lib/input-limits'

function nextName(existing: ReadonlyArray<DoorShape>): string {
  const taken = new Set(existing.map((d) => d.name))
  for (let i = 1; i < 10_000; i++) {
    const candidate = `Door ${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `Door ${Date.now()}`
}

/** Temp negative ids let the UI render optimistically while POST is in flight. */
let tempIdCounter = -1
function nextTempId(): number {
  const id = tempIdCounter
  tempIdCounter -= 1
  return id
}

/**
 * Default opening width (m) for the next-drawn door. Sized to match the
 * hardcoded constant that used to live in the placement tool so the
 * out-of-the-box behavior is unchanged.
 */
export const DEFAULT_DOOR_WIDTH_METERS = 0.9

interface DoorStore {
  /** In-memory door rows. Synced from backend on `loadForWarehouse`. */
  doors: DoorShape[]
  /** Active warehouse (zoneId). Doors are scoped to this on every mutation. */
  warehouseId: number | null
  /** Active floor (floorPlanId). Doors created while this is set inherit it. */
  floorPlanId: number | null
  /** Editor's draft config — seed for the next-drawn door. Persists across reloads. */
  pendingConfig: DoorConfig
  /**
   * Default opening width for the next-drawn door, in meters. Lives
   * outside `pendingConfig` because per-door width is stored in
   * `vertices` (not `config`), so this is placement-only state.
   */
  pendingWidthMeters: number

  // ---- scope --------------------------------------------------------------
  setScope: (warehouseId: number | null, floorPlanId?: number | null) => void

  // ---- backend round-trips ------------------------------------------------
  loadForWarehouse: (warehouseId: number) => Promise<void>
  applyServerDoor: (door: DoorShape) => void
  removeServerDoor: (id: number) => void

  // ---- actions (mirror the legacy localStorage API) -----------------------
  addDoor: (vertices: [[number, number], [number, number]], name?: string) => DoorShape
  updateDoor: (id: number, patch: Partial<Omit<DoorShape, 'id' | 'createdAt'>>) => void
  updateDoorConfig: (id: number, patch: Partial<DoorConfig>) => void
  deleteDoor: (id: number) => void
  setVisible: (id: number, visible: boolean) => void
  setName: (id: number, name: string) => void
  duplicateDoor: (id: number) => DoorShape | null
  clearAll: () => void
  setPendingConfig: (cfg: DoorConfig) => void
  updatePendingConfig: (patch: Partial<DoorConfig>) => void
  setPendingWidthMeters: (widthMeters: number) => void
  /**
   * Fully-reset the store to its post-boot defaults. Called by the auth
   * client on login / signup / logout so a browser that just switched
   * tenants doesn't carry over the previous session's doors, scope, or
   * pending config.
   */
  resetForNewSession: () => void
}

/**
 * Lifts the door from internal "temp id" form to a backend-shaped POST body.
 * Strips id/createdAt/updatedAt/tenantId which the server assigns.
 */
function toCreatePayload(d: DoorShape, warehouseId: number | null, floorPlanId: number | null): Omit<DoorShape, 'id'> {
  return {
    name: d.name,
    vertices: d.vertices,
    rotation: d.rotation ?? 0,
    config: d.config,
    zoneId: warehouseId ?? undefined,
    floorPlanId: d.floorPlanId ?? floorPlanId ?? undefined,
    unit: d.unit ?? 'meters',
    visible: d.visible,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

export const useDoorStore = create<DoorStore>()(
  persist(
    (set, get) => {
      /**
       * A door's POST has returned: swap its temp id for the server row,
       * keeping (and saving) anything the user changed while it was in
       * flight — the create payload was built before those edits.
       */
      const settleCreated = async (tempId: number, serverId: number) => {
        const created = await apiDb.doors.get(serverId)
        if (!created) return
        const local = get().doors.find((d) => d.id === tempId)
        const edits: Partial<DoorShape> = {}
        if (local) {
          for (const k of ['name', 'vertices', 'rotation', 'config', 'visible', 'floorPlanId'] as const) {
            if (JSON.stringify(local[k]) !== JSON.stringify(created[k])) (edits as Record<string, unknown>)[k] = local[k]
          }
        }
        // The sync below may already have added the server row; keep one.
        set((s) => ({
          doors: s.doors.filter((d) => d.id !== serverId).map((d) => (d.id === tempId ? { ...created, ...edits } : d)),
        }))
        if (Object.keys(edits).length > 0) useSpatialStore.getState().updateLocal('doors', serverId, edits)
      }
      return {
      doors: [],
      warehouseId: null,
      floorPlanId: null,
      pendingConfig: { ...DEFAULT_DOOR_CONFIG },
      pendingWidthMeters: DEFAULT_DOOR_WIDTH_METERS,

      setScope(warehouseId, floorPlanId) {
        set({
          warehouseId,
          ...(floorPlanId !== undefined ? { floorPlanId } : {}),
        })
      },

      async loadForWarehouse(warehouseId) {
        set({ warehouseId })
        try {
          // Ask for this warehouse's doors only (the list endpoint scopes by
          // zoneId), and keep the filter in case an older backend ignores it.
          const rows = await apiDb.doors.toArray(warehouseId != null ? `zoneId=${warehouseId}` : undefined)
          const filtered = rows.filter((d) => d.zoneId === warehouseId)
          set({ doors: filtered })
        } catch (err) {
          // Pre-doors-migration backends respond with 404 on /doors.
          // That's the expected state until the dev server is
          // rebuilt + migrated; treat it as "no doors yet" so the
          // viewer renders without a console-level error.
          if (err instanceof ApiError && err.status === 404) {
            set({ doors: [] })
            return
          }
          console.warn('[doorStore] loadForWarehouse failed', err)
        }
      },

      applyServerDoor(door) {
        set((s) => {
          const existingIdx = s.doors.findIndex((d) => d.id === door.id)
          if (existingIdx === -1) {
            return { doors: [...s.doors, door] }
          }
          const next = [...s.doors]
          next[existingIdx] = door
          return { doors: next }
        })
      },

      removeServerDoor(id) {
        set((s) => ({ doors: s.doors.filter((d) => d.id !== id) }))
      },

      addDoor(vertices, name) {
        const now = new Date()
        const cfg = { ...get().pendingConfig }
        const warehouseId = get().warehouseId
        const floorPlanId = get().floorPlanId
        const tempId = nextTempId()
        const door: DoorShape = {
          id: tempId,
          name: name ?? nextName(get().doors),
          vertices,
          rotation: 0,
          config: cfg,
          zoneId: warehouseId ?? undefined,
          floorPlanId: floorPlanId ?? undefined,
          unit: 'meters',
          visible: true,
          createdAt: now,
          updatedAt: now,
        }
        set((s) => ({ doors: [...s.doors, door] }))
        // Fire-and-forget POST. On success, swap temp id for server id.
        void apiDb.doors.add(toCreatePayload(door, warehouseId, floorPlanId)).then((serverId) => settleCreated(tempId, serverId)).catch((err) => {
          if (!(err instanceof ApiError && err.status === 404)) {
            console.warn('[doorStore] addDoor POST failed', err)
          }
        })
        return door
      },

      updateDoor(id, patch) {
        const now = new Date()
        set((s) => ({
          doors: s.doors.map((d) =>
            d.id === id ? { ...d, ...patch, updatedAt: now } : d,
          ),
        }))
        if (id > 0) {
          // Committed doors save through the pipeline. Temp-id doors are
          // still being created — `settleCreated` carries these edits over.
          useSpatialStore.getState().updateLocal('doors', id, patch as Partial<DoorShape>)
        }
      },

      updateDoorConfig(id, patch) {
        const now = new Date()
        set((s) => ({
          doors: s.doors.map((d) =>
            d.id === id
              ? { ...d, config: { ...d.config, ...patch }, updatedAt: now }
              : d,
          ),
        }))
        if (id > 0) {
          const merged = get().doors.find((d) => d.id === id)?.config
          if (merged) useSpatialStore.getState().updateLocal('doors', id, { config: merged })
        }
      },

      deleteDoor(id) {
        set((s) => ({ doors: s.doors.filter((d) => d.id !== id) }))
        if (id > 0) useSpatialStore.getState().deleteLocal('doors', id)
      },

      setVisible(id, visible) {
        get().updateDoor(id, { visible })
      },

      setName(id, name) {
        get().updateDoor(id, { name })
      },

      duplicateDoor(id) {
        const src = get().doors.find((d) => d.id === id)
        if (!src) return null
        const now = new Date()
        const lngOffset = 1 / (111_320 * Math.cos((src.vertices[0][1] * Math.PI) / 180))
        const v0: [number, number] = [src.vertices[0][0] + lngOffset, src.vertices[0][1]]
        const v1: [number, number] = [src.vertices[1][0] + lngOffset, src.vertices[1][1]]
        const tempId = nextTempId()
        const warehouseId = get().warehouseId
        const floorPlanId = get().floorPlanId
        const dup: DoorShape = {
          ...src,
          id: tempId,
          name: nextName(get().doors),
          vertices: [v0, v1],
          config: { ...src.config },
          zoneId: warehouseId ?? src.zoneId,
          floorPlanId: floorPlanId ?? src.floorPlanId,
          createdAt: now,
          updatedAt: now,
        }
        set((s) => ({ doors: [...s.doors, dup] }))
        void apiDb.doors.add(toCreatePayload(dup, warehouseId, floorPlanId)).then((serverId) => settleCreated(tempId, serverId)).catch((err) => {
          console.warn('[doorStore] duplicateDoor POST failed', err)
        })
        return dup
      },

      clearAll() {
        const toDelete = get().doors.filter((d) => d.id > 0).map((d) => d.id)
        set({ doors: [] })
        Promise.all(toDelete.map((id) => apiDb.doors.delete(id))).catch((err) => {
          console.warn('[doorStore] clearAll DELETE batch failed', err)
        })
      },

      setPendingConfig(cfg) {
        set({ pendingConfig: cfg })
      },

      updatePendingConfig(patch) {
        set((s) => ({ pendingConfig: { ...s.pendingConfig, ...patch } }))
      },

      setPendingWidthMeters(widthMeters) {
        // Clamp to the same limits the DoorPropertiesForm row accepts
        // (its slider drags 0.2–6 m but typing goes up to the limit) so
        // a value poked in from outside can't push the ghost preview to
        // a degenerate size.
        const clamped = Math.min(LIMIT_DOOR_WIDTH_M, Math.max(0.2, widthMeters))
        set({ pendingWidthMeters: clamped })
      },

      resetForNewSession() {
        // Restore the exact post-boot snapshot. The persist middleware
        // re-writes the localStorage key on the next tick, so anything
        // the previous session left in `door-tool-v1` gets overwritten
        // with a fresh default. Called from auth-client on login /
        // signup / logout to prevent cross-tenant carryover.
        set({
          doors: [],
          warehouseId: null,
          floorPlanId: null,
          pendingConfig: { ...DEFAULT_DOOR_CONFIG },
          pendingWidthMeters: DEFAULT_DOOR_WIDTH_METERS,
        })
      },
    }},
    {
      name: 'door-tool-v3',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      // Persist only the editor's draft config + default width. The
      // doors[] array is sourced from the backend on each session via
      // `loadForWarehouse`, so we don't snapshot it locally. The
      // width sits outside `pendingConfig` because per-door width is
      // stored in `vertices` — this is placement-only state.
      partialize: (s) => ({
        pendingConfig: s.pendingConfig,
        pendingWidthMeters: s.pendingWidthMeters,
      }),
    },
  ),
)

// One-shot cleanup: wipe the legacy `door-tool-v1` key that older builds
// used. If a browser still has that entry, its serialized doors[] would
// otherwise sit as dead weight in localStorage (it can never be re-read
// now that readLegacyDoors is gone, but keeping it around is confusing
// during triage). Runs at module load; safe even in SSR.
if (typeof window !== 'undefined') {
  try {
    window.localStorage.removeItem('door-tool-v1')
    window.localStorage.removeItem('door-tool-v2')
  } catch {
    // storage access denied (private mode, quota) — ignore
  }
}

// Door rows changed elsewhere (another tab or user, via SSE → spatial store)
// flow into this store — unless the door has unsaved local edits, which win
// until they're saved.
useSpatialStore.subscribe((state, prev) => {
  if (state.doors === prev.doors) return
  const doorStore = useDoorStore.getState()
  const wid = doorStore.warehouseId
  const before = new Map(prev.doors.map((d) => [d.id, d]))
  for (const row of state.doors) {
    if (before.get(row.id) === row) continue
    if (wid !== null && row.zoneId !== wid) continue
    if (useSpatialStore.getState().hasPending('doors', row.id)) continue
    doorStore.applyServerDoor(row)
  }
  const now = new Set(state.doors.map((d) => d.id))
  for (const id of before.keys()) {
    if (!now.has(id) && doorStore.doors.some((d) => d.id === id)) doorStore.removeServerDoor(id)
  }
})
