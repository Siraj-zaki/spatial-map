import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { apiDb } from '@/lib/api-db'
import {
  useCorrelationEngine,
  useLiveStreamScheduler,
} from '@/lib/data-link'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { useDoorStore } from '@/lib/door/store'
import { useSpatialStore } from '@/lib/spatial-store'
import { queryCache } from '@/lib/useApiQuery'
import { useSSE } from '@/lib/useSSE'

/**
 * Route-bootstrap concerns for the editor:
 *   - tenant + SSE subscription + spatial store hydration
 *   - preview-only live schedulers (streams, correlation)
 *   - `activeWarehouseId` derivation from the URL (+ ref mirror for
 *     tool-placement effects that shouldn't re-bind on switch)
 *   - per-warehouse `defaultFloorPlanId` state, persistence, ref mirror,
 *     and the change handler that writes localStorage
 *   - one-shot `pinWarehouseCenterIfNeeded` used by every create-*
 *     tool's first save
 *   - initial-viewport reset flag (the auto-fit `useEffect` remains in
 *     the route file for now — Phase 2 will move it into
 *     `useMapLifecycle`)
 *   - per-warehouse attribute-definitions catalog reload
 *   - door store scope (warehouse + default floor plan)
 *
 * Everything else stays in `create-grids.tsx` for later phases so this
 * extraction is pure code motion — no behaviour changes.
 */
export function useEditorBootstrap(preview: boolean) {
  const tenantId = useCurrentTenantId()

  // Event-driven spatial store: load once per tenant, then keep in sync
  // via SSE instead of polling every catalog table every 10 seconds.
  useSSE(tenantId)
  useEffect(() => {
    if (tenantId != null) {
      useSpatialStore.getState().setTenantId(tenantId)
      // Note: don't call loadAll() here — the "active warehouse"
      // effect below owns the initial load so it can pass the
      // warehouse-scoped `zoneId` query (avoids a first-render
      // full-tenant fetch that we'd immediately throw away when
      // the warehouse loads a moment later).
    }
  }, [tenantId])

  // Live runtime plumbing only runs in preview mode. The editor is a
  // quiet design surface; the preview route handles streams, data-source
  // refresh, and correlation rules. Hooks are called unconditionally so
  // React hook counts stay stable between editor and preview renders.
  //
  // Note: `useDataSourceScheduler` was lifted to App.tsx so scheduled
  // REST/webhook pulls fire regardless of which route is open (the
  // integrations page in particular needs pulls to keep running while
  // the user is configuring sources). The other two remain preview-only
  // since they drive live map overlays.
  useLiveStreamScheduler(preview)
  useCorrelationEngine(preview)

  // ---- Active warehouse ----------------------------------------------------
  // The current workspace is scoped to a single warehouse (zone). Driven by
  // the `?warehouseId=` query param so the URL is shareable and bookmarkable.
  // When set, all newly-saved shapes are auto-stamped with this `zoneId`,
  // the saved-shape lists are filtered to it, and the map flies to the
  // warehouse's pinned center on switch.
  const [searchParams] = useSearchParams()
  const warehouseParam = searchParams.get('warehouseId')
  const activeWarehouseId =
    warehouseParam !== null && /^\d+$/.test(warehouseParam)
      ? Number(warehouseParam)
      : null

  // Mirror activeWarehouseId into a ref so the many tool-placement effects
  // can read the latest value without needing it in their dep arrays.
  const activeWarehouseIdRef = useRef<number | null>(activeWarehouseId)
  useEffect(() => {
    activeWarehouseIdRef.current = activeWarehouseId
  }, [activeWarehouseId])

  // Push the active warehouse into the spatial store, then trigger a
  // full reload. Every shape kind's `loadKind` (see spatial-store.ts)
  // reads `activeZoneId` and sends it as `?zoneId=…` on the API list
  // request. The backend (see `shape_crud.go::shapeList`) then returns
  // only shapes in that zone — no more "fetch every tenant row and
  // filter client-side".
  //
  // SSE-driven per-entity reloads inherit the same scoping because
  // they call the same `loadKind` path.
  useEffect(() => {
    if (tenantId == null) return
    useSpatialStore.getState().setActiveZoneId(activeWarehouseId)
    void useSpatialStore.getState().loadAll()
  }, [tenantId, activeWarehouseId])

  /**
   * Default floor plan for new shapes. When set, every newly-created
   * polygon / circle / line / marker / model / stair / text label /
   * grid / image plane / door inherits `floorPlanId = defaultFloorPlanId`
   * so the user doesn't have to hop into the bulk-assign dialog after
   * every draw. Persists per-warehouse (a mezzanine warehouse and a
   * ground-floor warehouse can each keep their own last-used default)
   * under `sgv-default-floor-plan:{warehouseId}` in localStorage. New
   * `image` shapes are deliberately excluded — an image IS a floor
   * plan, and pinning it to another floor plan is a rarer "multi-storey
   * stack" workflow that the user opts into explicitly via bulk assign.
   *
   * The ref mirror lets creation handlers read the CURRENT default
   * without listing `defaultFloorPlanId` in every effect's deps
   * (avoids tearing down click-handler bindings mid-draw).
   */
  const [defaultFloorPlanId, setDefaultFloorPlanId] = useState<number | null>(null)
  const defaultFloorPlanIdRef = useRef<number | null>(null)
  useEffect(() => {
    defaultFloorPlanIdRef.current = defaultFloorPlanId
  }, [defaultFloorPlanId])

  // Load the per-warehouse saved default when the warehouse changes.
  // Runs on every warehouse switch (including initial mount + back
  // navigation between two warehouses in a session).
  useEffect(() => {
    if (activeWarehouseId === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDefaultFloorPlanId(null)
      return
    }
    let parsed: number | null = null
    try {
      const stored = window.localStorage.getItem(
        `sgv-default-floor-plan:${activeWarehouseId}`,
      )
      if (stored) {
        const n = Number.parseInt(stored, 10)
        if (Number.isFinite(n) && n > 0) parsed = n
      }
    } catch {
      /* localStorage unavailable — fall through with null */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDefaultFloorPlanId(parsed)
  }, [activeWarehouseId])

  const handleDefaultFloorPlanChange = useCallback(
    (id: number | null) => {
      setDefaultFloorPlanId(id)
      if (activeWarehouseId === null) return
      const key = `sgv-default-floor-plan:${activeWarehouseId}`
      try {
        if (id === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, String(id))
      } catch {
        /* ignore write failures — the state still applies for this session */
      }
    },
    [activeWarehouseId],
  )

  /**
   * Pin the warehouse's center the first time the user saves a shape into
   * it. We use the saved point as a "good enough" center — subsequent
   * saves don't overwrite a pin that's already set. This lets the
   * dashboard fly-to-warehouse flow work without forcing the user to
   * explicitly drop a centerpin.
   */
  const pinWarehouseCenterIfNeeded = useCallback(
    async (zoneId: number | null, center: [number, number]) => {
      if (zoneId === null) return
      const z = await apiDb.zones.get(zoneId)
      if (!z || z.center) return
      await apiDb.zones.update(zoneId, { center })
      queryCache.invalidate('zones')
    },
    [],
  )

  // Re-fetch the attribute-definitions catalog whenever the active
  // warehouse changes. Definitions are per-warehouse (zone-scoped), so
  // the bin editor, shape data editor, schema builder, and style rule
  // editor all need the store populated with this warehouse's rows.
  // Without this, only tenant-shared rows (zone_id IS NULL) would be
  // visible — and most tenants don't have any.
  useEffect(() => {
    if (activeWarehouseId === null) return
    useSpatialStore.getState().loadKind('attribute-definitions', { zoneId: activeWarehouseId })
  }, [activeWarehouseId])

  // Scope the door store to the active warehouse so newly-drawn doors
  // land in the right `zoneId` and the editor's roster only shows this
  // warehouse's doors. Triggers a backend fetch so the editor starts
  // with the same set the viewer sees, and runs the one-shot
  // localStorage → backend migration on first call.
  useEffect(() => {
    if (activeWarehouseId === null) return
    void useDoorStore.getState().loadForWarehouse(activeWarehouseId)
  }, [activeWarehouseId])

  // Push the current default into `useDoorStore`'s scope so newly-
  // drawn doors inherit it. The door store's `toCreatePayload`
  // already prefers a caller-provided `floorPlanId` over the scope's
  // — this is just the fallback for the "user picked a default and
  // started drawing doors" flow.
  useEffect(() => {
    useDoorStore
      .getState()
      .setScope(activeWarehouseId ?? null, defaultFloorPlanId)
  }, [activeWarehouseId, defaultFloorPlanId])

  // ---- Floor-plan ordering ------------------------------------------------
  // Per-warehouse ordered list of image ids (top → bottom). The first
  // entry is the "default" floor plan — shown in the toolbar dropdown
  // badge, used as the preview initial selection, and highlighted in the
  // sidebar's Saved Images list. Persisted under
  // `sgv-floor-plan-order:{warehouseId}` in localStorage so it survives
  // sessions and is shareable across tabs.
  const [floorPlanOrder, setFloorPlanOrder] = useState<number[]>([])

  useEffect(() => {
    if (activeWarehouseId === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFloorPlanOrder([])
      return
    }
    let parsed: number[] = []
    try {
      const stored = window.localStorage.getItem(
        `sgv-floor-plan-order:${activeWarehouseId}`,
      )
      if (stored) {
        const arr = JSON.parse(stored)
        if (Array.isArray(arr)) parsed = arr.filter((v: unknown) => typeof v === 'number' && v > 0)
      }
    } catch {
      /* localStorage unavailable — fall through with empty */
    }
    setFloorPlanOrder(parsed)
  }, [activeWarehouseId])

  const handleReorderFloorPlans = useCallback(
    (orderedIds: number[]) => {
      setFloorPlanOrder(orderedIds)
      if (activeWarehouseId === null) return
      try {
        window.localStorage.setItem(
          `sgv-floor-plan-order:${activeWarehouseId}`,
          JSON.stringify(orderedIds),
        )
      } catch {
        /* ignore write failures */
      }
      // When reordering, the top item becomes the default floor plan.
      if (orderedIds.length > 0) {
        const newDefault = orderedIds[0]
        setDefaultFloorPlanId(newDefault)
        try {
          window.localStorage.setItem(
            `sgv-default-floor-plan:${activeWarehouseId}`,
            String(newDefault),
          )
        } catch {
          /* ignore */
        }
      }
    },
    [activeWarehouseId],
  )

  // Ensure the initial camera is useful: fit to any floor-plan images,
  // fall back to a whole-earth view, and never fight the user after that.
  // The auto-fit effect itself remains in `create-grids.tsx` for now
  // (Phase 2 moves it into `useMapLifecycle`); we own the ref here so
  // the warehouse-switch reset stays with the rest of warehouse state.
  const initialViewportSetRef = useRef(false)

  // Reset the one-shot fit flag whenever the user switches warehouses
  // so the auto-fit effect below re-runs against the new warehouse's
  // bounds. Without this, switching from a warehouse in NYC to one in
  // London would leave the camera framed on the previous site.
  useEffect(() => {
    initialViewportSetRef.current = false
  }, [activeWarehouseId])

  return {
    activeWarehouseId,
    activeWarehouseIdRef,
    defaultFloorPlanId,
    defaultFloorPlanIdRef,
    handleDefaultFloorPlanChange,
    floorPlanOrder,
    handleReorderFloorPlans,
    pinWarehouseCenterIfNeeded,
    initialViewportSetRef,
  }
}
