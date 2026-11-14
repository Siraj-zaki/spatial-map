/**
 * The facility on a real map, embedded in a report: the same MapboxMap +
 * map-*-overlay stack the read-only viewer (routes/view.tsx) mounts, cut
 * down to one floor at a time with one highlighted item. Never a bare
 * Mapbox — the shapes, floor plans, walls and 3D models are the real ones.
 *
 * Loads the facility into the spatial store (setActiveZoneId + loadAll) and
 * the door store, like the viewer; the store holds one facility at a time,
 * so a report page shows one facility map.
 *
 * Only the active kind is clickable (`selectableKind`); everything else
 * passes clicks through so a click on a rack doesn't select the area
 * under it.
 *
 * The picked item is a focus target (src/lib/focus): the map flies to a
 * clear view of it, it is never hidden by occlusion, whatever stands in
 * front of it turns see-through, its NEAR set fades part-way — solids it
 * sits inside, volumetric shapes on its floor within 5 m, anything
 * overhead (focus-near.ts; flat floor tints and floor plans never) — and
 * a ring pulses on it. A large faded shape fades only around the item /
 * where the line of sight crosses it (the cut-away); everything else
 * stays exactly as drawn — nothing is dimmed. The same pipeline as the
 * viewer: one prism list feeds the blockers and the near set, and every
 * overlay reads both from the focus contexts. A click that picks nothing
 * (or Esc, in the widget) lets go. With nothing picked the map renders
 * exactly as before.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'
import { FollowChip } from '@/components/follow-chip'
import { useFollowEntity } from '@/lib/focus/use-follow-entity'
import { MapboxMap, DEFAULT_MAP_STYLE, type MapStyleId } from '@/components/mapbox-map'
import { MapFocusOverlay } from '@/components/map-focus-overlay'
import { MapDoorOverlay } from '@/components/door/map-door-overlay'
import { MapGridOverlay, type CommittedLine } from '@/components/map-grid-overlay'
import { MapImageOverlay } from '@/components/map-image-overlay'
import { MapLineOverlay } from '@/components/map-line-overlay'
import { MapMarkerOverlay } from '@/components/map-marker-overlay'
import { MapModelOverlay } from '@/components/map-model-overlay'
import { MapPolygonOverlay } from '@/components/map-polygon-overlay'
import { MapStairOverlay } from '@/components/map-stair-overlay'
import { MapFloorBaseOverlay } from '@/components/map-floor-base-overlay'
import { MapTextLabelOverlay } from '@/components/map-text-label-overlay'
import { MapDataLinkedOverlay } from '@/components/map-data-linked-overlay'
import type { DataLinkConfig, DataLinkFilter } from '@/lib/db'
import type { StyleRule } from '@/lib/style-rules'
import { SIDE_PANEL_DEFAULT_CONFIG } from '@/components/side-panel'
import { useDoorStore } from '@/lib/door/store'
import type { DoorShape } from '@/lib/door/types'
import { imageCorners } from '@/lib/image-generators'
import { useModelBoundingCenterMap, useModelBoundsMap, useModelInspectorMap, useModelUrlMap } from '@/lib/model-assets'
import { liftFloorPlanIds } from '@/lib/shapes'
import { useSpatialStore } from '@/lib/spatial-store'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { hasMapLayer, rootLayerOrder } from '@/lib/data-link/dl-layer-stack'
import { flyToFocus } from '@/lib/focus/focus-camera'
import { useTrackFocusBlockers } from '@/lib/focus/focus-blockers'
import { useFocusNear } from '@/lib/focus/focus-near'
import { FocusBlockersContext, FocusSceneContext, useFocusSceneValue } from '@/lib/focus/focus-scene'
import { focusKey, resolveFocus, type DlAnchor, type FocusTarget } from '@/lib/focus/focus-target'
import { buildOccluders, type OccluderPrism } from '@/lib/marker-occlusion'
import {
  CLUSTER_MAX_ZOOM,
  getRuntimeClusterMembers,
  isClusterExpandable,
  type ClusterPick,
  type PointClusterSpec,
} from '@/lib/data-link/point-clusters'
import { useSSE } from '@/lib/useSSE'
import { reportShareToken } from '@/lib/reports/report-share'
import type { PointHeatmapSpec } from '@/components/map-dl-heatmap-overlay'
import type { HeatBarriers } from '@/lib/data-link/heat-spread'
import { shapeBounds, type ExplorerKind, type ExplorerShape, type ExplorerShapes } from './explorer-geometry'

/** Floor plans ignore the editor's hide flag (the floor picker decides which floors show); every other shape honours it, as the viewer does. */
function forceVisible<T>(rows: readonly T[]): T[] {
  return rows.map((r) => ((r as { visible?: boolean }).visible === false ? { ...r, visible: true } : r))
}

/** `floors` null = every floor; unassigned shapes show on any floor (as view.tsx). */
function onFloor<T extends { floorPlanId?: number }>(row: T, floors: ReadonlySet<number> | null): boolean {
  return floors === null || row.floorPlanId === undefined || floors.has(row.floorPlanId)
}

/**
 * Load one facility's shapes into the stores and return them (zone-scoped,
 * visible). Shared by the map and the explorer's thumbnails.
 */
export function useFacilityShapes(zoneId: number): { shapes: ExplorerShapes; loaded: boolean } {
  const tenantId = useCurrentTenantId()
  // A shared report's page fills the stores from its link (routes/shared-report.tsx).
  const shared = reportShareToken() !== null
  useSSE(shared ? null : tenantId)
  useEffect(() => {
    if (shared || tenantId === null || !Number.isFinite(zoneId)) return
    const s = useSpatialStore.getState()
    s.setTenantId(tenantId)
    s.setActiveZoneId(zoneId)
    void s.loadAll()
    void useDoorStore.getState().loadForWarehouse(zoneId)
  }, [shared, tenantId, zoneId])

  const polygons = useSpatialStore((s) => s.polygons)
  const markers = useSpatialStore((s) => s.markers)
  const grids = useSpatialStore((s) => s.grids)
  const images = useSpatialStore((s) => s.images)
  const lines = useSpatialStore((s) => s.lines)
  const stairs = useSpatialStore((s) => s.stairs)
  const textLabels = useSpatialStore((s) => s.textLabels)
  const models = useSpatialStore((s) => s.models)
  const doors = useDoorStore((s) => s.doors)
  const loaded = useSpatialStore((s) => s.loadedFor.polygons === zoneId && s.loadedFor.images === zoneId)

  const shapes = useMemo<ExplorerShapes>(() => {
    const inZone = <T extends { zoneId?: number }>(rows: readonly T[]) => rows.filter((r) => r.zoneId === zoneId)
    return {
      polygons: inZone(polygons),
      markers: inZone(markers),
      grids: inZone(grids),
      images: forceVisible(inZone(images)),
      lines: inZone(lines),
      stairs: inZone(stairs),
      textLabels: inZone(textLabels),
      models: inZone(models),
      doors: doors.filter((d) => d.zoneId === undefined || d.zoneId === zoneId),
    }
  }, [polygons, markers, grids, images, lines, stairs, textLabels, models, doors, zoneId])
  return { shapes, loaded }
}

export interface FacilityMapProps {
  shapes: ExplorerShapes
  /** Floor shown (an image id), or null for every floor. */
  /** Floors shown — one, several (stacked, the camera tilts) or all (null). */
  floors: ReadonlySet<number> | null
  selected: ExplorerShape | null
  /** Only this kind reacts to clicks. */
  selectableKind: ExplorerKind | null
  onSelect: (kind: ExplorerKind, id: number) => void
  /** Pixels covered by a panel on the map's right edge (the detail card),
   *  kept clear when the camera frames the selection. */
  rightInset?: number
  /** Pixels covered by floating panels on each edge (the full-map
   *  layout's top bar, list, right panel and bottom tray). Added to
   *  `rightInset`. */
  insets?: MapInsets
  /** Where a hovered list row sits: a ghost pin, the camera stays put. */
  hoverPoint?: [number, number] | null
  /** A picked data row placed by coordinates (no shape): pinned + framed. */
  selectedPoint?: [number, number] | null
  /** A picked linked-data record. With its link in `dataLinks`, focus
   *  mode finds the record's live symbol and focuses that (the ring
   *  replaces the `selectedPoint` pin); with `selected` too, the shape
   *  is focused and its symbol stays exempt. */
  selectedDl?: { configId: number; entityKey: string } | null
  /** A live data symbol clicked on the map. */
  onSelectDl?: (configId: number, entityKey: string) => void
  /** A click on the map that picked nothing while something is focused. */
  onClearSelection?: () => void
  /** Data links drawn live on the map (the linked-data reports). */
  dataLinks?: ReadonlyArray<DataLinkConfig>
  styleRules?: ReadonlyArray<StyleRule>
  /** Basemap; swapped in place (the overlays re-add on style.load). */
  styleId?: MapStyleId
  /** Runtime clustering of the data links' points (memoised; null = off). */
  cluster?: PointClusterSpec | null
  /** The viewer's heatmap over one point layer (memoised; null = off). */
  heatmap?: PointHeatmapSpec | null
  /** A bubble whose items can't separate on screen was clicked: list them. */
  onClusterPick?: (pick: ClusterPick) => void
  /** Per link: only these rows draw (the report's filtered rows; null = all). */
  configFilters?: Readonly<Record<number, DataLinkFilter | null>>
  /** The picked record to keep in view while it moves (history playback or
   *  live updates): the camera eases onto it and the focus ring travels. */
  follow?: { config: DataLinkConfig; entityKey: string; livePoint: [number, number] | null; label: string } | null
  /** Bounds to frame when the report's filters narrow the list (by key). */
  frame?: { key: string; bounds: [number, number, number, number] } | null
}

export function FacilityMap({
  shapes,
  floors,
  selected,
  selectableKind,
  onSelect,
  rightInset = 0,
  insets,
  hoverPoint = null,
  selectedPoint = null,
  selectedDl = null,
  onSelectDl,
  onClearSelection,
  dataLinks,
  styleRules,
  styleId = DEFAULT_MAP_STYLE,
  cluster = null,
  heatmap = null,
  onClusterPick,
  configFilters,
  follow = null,
  frame = null,
}: FacilityMapProps) {
  // One key for every inset so the camera effects re-run only when a
  // panel actually opens or closes.
  const ins = { top: insets?.top ?? 0, right: (insets?.right ?? 0) + rightInset, bottom: insets?.bottom ?? 0, left: insets?.left ?? 0 }
  const insetKey = `${ins.top},${ins.right},${ins.bottom},${ins.left}`
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [map, setMap] = useState<MapboxMapInstance | null>(null)
  const mapStyle = styleId

  // Overlays mount only once the style is ready (mirrors view.tsx).
  const [styleReady, setStyleReady] = useState(false)
  useEffect(() => {
    if (!map) return
    const onLoad = () => setStyleReady(true)
    map.on('style.load', onLoad)
    if (map.isStyleLoaded()) queueMicrotask(onLoad)
    return () => {
      map.off('style.load', onLoad)
    }
  }, [map])
  const overlayMap = styleReady ? map : null

  // The map lives in a resizable report card.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !map) return
    const ro = new ResizeObserver(() => map.resize())
    ro.observe(el)
    return () => ro.disconnect()
  }, [map])

  const polygons = useMemo(() => shapes.polygons.filter((p) => onFloor(p, floors)), [shapes.polygons, floors])
  const markers = useMemo(() => shapes.markers.filter((m) => onFloor(m, floors)), [shapes.markers, floors])
  const grids = useMemo(() => shapes.grids.filter((g) => onFloor(g, floors)), [shapes.grids, floors])
  const lines = useMemo(() => shapes.lines.filter((l) => onFloor(l, floors)), [shapes.lines, floors])
  const textLabels = useMemo(() => shapes.textLabels.filter((l) => onFloor(l, floors)), [shapes.textLabels, floors])
  const models = useMemo(() => shapes.models.filter((m) => onFloor(m, floors)), [shapes.models, floors])
  const doors = useMemo(() => shapes.doors.filter((d) => onFloor(d, floors)), [shapes.doors, floors])
  const images = useMemo(
    () => shapes.images.filter((img) => floors === null || (img.id !== undefined && floors.has(img.id))),
    [shapes.images, floors],
  )
  const stairs = useMemo(
    () => shapes.stairs.filter((s) => onFloor(s, floors) || (floors !== null && liftFloorPlanIds(s.config).some((id) => floors.has(id)))),
    [shapes.stairs, floors],
  )
  // Floor base only (focus derives its own floor heights).
  const floorElevations = useMemo(
    () => new Map(shapes.images.filter((i) => i.id !== undefined).map((i) => [i.id as number, i.config.elevation ?? 0])),
    [shapes.images],
  )
  const floorBaseInput = useMemo(
    () => ({
      floors: shapes.images,
      visibleFloorIds: new Set(images.map((i) => i.id).filter((id): id is number => id !== undefined)),
      polygons: shapes.polygons,
      lines: shapes.lines,
      stairs: shapes.stairs,
      floorElevations,
    }),
    [shapes.images, images, shapes.polygons, shapes.lines, shapes.stairs, floorElevations],
  )
  const attachedDoorsByLineId = useMemo(() => {
    const m = new Map<number, DoorShape[]>()
    for (const d of doors) {
      const wall = d.config.attachedToLineId
      if (wall === undefined) continue
      const list = m.get(wall)
      if (list) list.push(d)
      else m.set(wall, [d])
    }
    return m
  }, [doors])
  const committedLines = useMemo<CommittedLine[]>(
    () =>
      grids
        .filter((g): g is typeof g & { id: number } => g.id !== undefined)
        .map((g) => ({ id: g.id, start: g.start, current: g.current, config: g.config, visible: g.visible })),
    [grids],
  )
  const modelUrlMap = useModelUrlMap()
  const modelBoundingCenters = useModelBoundingCenterMap()
  // Full AABB per asset, as in the editor, so models rest on their
  // elevation instead of sinking (see view.tsx).
  const modelBounds = useModelBoundsMap()
  // Heat stops at walls and solid objects — every floor's shapes, read the
  // way the route planner reads them (data-link/heat-spread.ts).
  const heatBarriers = useMemo<HeatBarriers>(
    () => ({
      images: shapes.images,
      lines: shapes.lines,
      doors: shapes.doors,
      polygons: shapes.polygons,
      grids: shapes.grids,
      stairs: shapes.stairs,
      models: shapes.models,
      modelBounds,
    }),
    [shapes.images, shapes.lines, shapes.doors, shapes.polygons, shapes.grids, shapes.stairs, shapes.models, modelBounds],
  )
  const heatSpec = useMemo(() => (heatmap ? { ...heatmap, barriers: heatBarriers } : null), [heatmap, heatBarriers])
  const placedModelAssetIds = useMemo(() => {
    const s = new Set<string>()
    for (const m of shapes.models) if (m.config?.modelAssetId) s.add(m.config.modelAssetId)
    return s
  }, [shapes.models])
  useModelInspectorMap(placedModelAssetIds)

  // Selection → the overlay's own highlight. Memoised per selection so
  // the overlays' selection effects don't re-run every render.
  const selKey = selected ? `${selected.kind}:${selected.shape.id}` : null
  const selSet = useMemo<ReadonlySet<number>>(
    () => (selected && selected.shape.id !== undefined ? new Set([selected.shape.id]) : EMPTY),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selKey],
  )
  const sel = (kind: ExplorerKind): ReadonlySet<number> => (selected?.kind === kind ? selSet : EMPTY)
  const occluders = useMemo(() => ({ images, polygons, lines, stairs, grids }), [images, polygons, lines, stairs, grids])
  const labelOccluders = useMemo(
    () => ({ images: shapes.images, polygons, lines, stairs, grids }),
    [shapes.images, polygons, lines, stairs, grids],
  )

  // ---- focus ---------------------------------------------------------------
  // The picked item as a focus target. A record is focused through its live
  // symbol only when its link is drawn here (`dataLinks`): nothing else
  // would ever report where the symbol is.
  const dlRef = selectedDl && dataLinks?.some((c) => c.id === selectedDl.configId) ? selectedDl : null
  const dlConfigId = dlRef?.configId ?? null
  const dlEntityKey = dlRef?.entityKey ?? null
  const selKind = selected?.kind ?? null
  const selId = selected?.shape.id ?? null
  const baseTarget = useMemo<FocusTarget | null>(() => {
    const dl = dlConfigId !== null && dlEntityKey !== null ? { configId: dlConfigId, entityKey: dlEntityKey } : null
    if (selKind !== null && selId !== null) return dl ? { kind: selKind, id: selId, dl } : { kind: selKind, id: selId }
    return dl ? { kind: 'dl', ...dl } : null
  }, [selKind, selId, dlConfigId, dlEntityKey])
  const baseKey = focusKey(baseTarget)

  // Where the data-link overlay drew a record target (null = it isn't
  // drawn), reported through `FocusScene.onDlAnchor`, per focus key: a
  // late answer for an earlier key never touches the current one. Only
  // the current key's answer is kept (a re-pick asks again).
  const [anchors, setAnchors] = useState<ReadonlyMap<string, DlAnchor | null>>(NO_ANCHORS)
  if (anchors.size > 1 || (anchors.size === 1 && !anchors.has(baseKey))) {
    const current = anchors.get(baseKey)
    setAnchors(current === undefined ? NO_ANCHORS : new Map([[baseKey, current]]))
  }
  const onDlAnchor = useCallback((key: string, anchor: DlAnchor | null) => {
    setAnchors((prev) => {
      const had = prev.get(key)
      if (had !== undefined && sameAnchor(had, anchor)) return prev
      return new Map(prev).set(key, anchor)
    })
  }, [])
  const answer = anchors.get(baseKey)
  const anchor = answer ?? null
  const anchorMissing = answer === null
  const dlPending = baseTarget?.kind === 'dl' && answer === undefined
  // No answer yet after a while (the layer is still loading its rows):
  // the coordinate pin shows meanwhile, and the ring takes over if the
  // symbol turns up.
  const [slowKey, setSlowKey] = useState<string | null>(null)
  if (slowKey !== null && slowKey !== baseKey) setSlowKey(null)
  useEffect(() => {
    if (!dlPending) return
    const timer = window.setTimeout(() => setSlowKey(baseKey), ANCHOR_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [dlPending, baseKey])
  const anchorSlow = dlPending && slowKey === baseKey
  const hasPoint = selectedPoint !== null

  const target = useMemo<FocusTarget | null>(() => {
    if (!baseTarget || baseTarget.kind !== 'dl') return baseTarget
    if (anchor) return { ...baseTarget, anchor }
    // Not drawn (or never answered, with no pin to show instead): no
    // focus — the old pin / plain highlight, nothing faded.
    if (anchorMissing || (anchorSlow && !hasPoint)) return null
    // Pending: the scene is on so the overlay looks for it.
    return baseTarget
  }, [baseTarget, anchor, anchorMissing, anchorSlow, hasPoint])
  const resolved = useMemo(() => resolveFocus(target, shapes), [target, shapes])
  // A shape is focused once it resolves (never blockers / a near column
  // faded around nothing); a record target is on while pending, so it can
  // be found.
  const sceneTarget = target !== null && (target.kind === 'dl' || resolved !== null) ? target : null
  const focusOn = sceneTarget !== null
  // The marker overlay's occluder list (same arrays → the same cached list
  // and one shared index), built here only while something is focused.
  const prisms = useMemo<ReadonlyArray<OccluderPrism>>(
    () => (focusOn ? buildOccluders(occluders) : NO_PRISMS),
    [focusOn, occluders],
  )
  const focusResolved = focusOn ? resolved : null
  const blockers = useTrackFocusBlockers(map, focusResolved, prisms)
  // The NEAR set (fades to 35 %): what the item sits inside, volumetric
  // shapes on its own floor within 5 m (whether above or below it), and
  // anything overhead — computed once per focus from the same prism list
  // and the whole facility's rows (`shapes.images` gives the floor
  // elevations), never on a camera event. Blockers fade to 15 %; nothing
  // else fades.
  const near = useFocusNear(focusResolved, prisms, shapes)
  const scene = useFocusSceneValue({ target: sceneTarget, resolved: focusResolved, near, onDlAnchor })

  // ---- camera ------------------------------------------------------------
  // Something picked owns the camera; the floor fit stands down.
  const picked = selected !== null || baseTarget !== null || hasPoint
  // First fit: the shown floor's plan (with its bearing), else every floor.
  const fittedFor = useRef<string | null>(null)
  const floorsKey = floors === null ? 'all' : [...floors].sort((a, b) => a - b).join(',')
  // Several floors at once read as a stack only when the camera is tilted.
  const stacked = images.length > 1
  useEffect(() => {
    if (!map) return
    // Re-frame when the floors change or a panel opens / measures in.
    const key = `${floorsKey}|${insetKey}`
    // The first fit always runs (a pick made before the map framed anything —
    // a filter down to one row — may never place: an off-site record); after
    // that, something picked owns the camera.
    if (fittedFor.current === key || (picked && fittedFor.current !== null)) return
    const floors = images.length > 0 ? images : shapes.images
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
    let bearing = 0
    for (const img of floors) {
      const c = imageCorners(img)
      if (!c) continue
      bearing = img.rotation ?? 0
      for (const [x, y] of c) {
        w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y)
      }
    }
    if (!Number.isFinite(w)) return
    const first = fittedFor.current === null
    fittedFor.current = key
    const pitch = stacked ? Math.max(map.getPitch(), 55) : map.getPitch()
    // A tilted fit leaves the stack small and far; bring it closer.
    const cam = map.cameraForBounds([[w, s], [e, n]], { padding: framePadding(map, ins, 40), bearing, pitch })
    if (cam?.zoom !== undefined && cam.center) {
      map.easeTo({ center: cam.center, zoom: Math.min(21, cam.zoom + (stacked ? 0.7 : 0)), bearing, pitch, padding: { top: 0, right: 0, bottom: 0, left: 0 }, duration: first ? 0 : 700 })
    } else {
      map.fitBounds([[w, s], [e, n]], { padding: framePadding(map, ins, 40), bearing, pitch, duration: first ? 0 : 700, maxZoom: 21 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, floorsKey, images, shapes.images, picked, insetKey])

  // Fly to the focused item, clear of the panels, choosing a line of sight
  // nothing blocks when there is one (focus-camera.ts). Re-runs when the
  // item resolves (shapes loaded, the record's symbol found) or a panel
  // opens. No `padding` is left on the map: every later fit stays true.
  const resolvedKey = focusResolved?.key ?? ''
  useEffect(() => {
    if (!map || !focusResolved) return
    flyToFocus(map, focusResolved, prisms, {
      mode: 'always',
      padding: framePadding(map, ins),
      maxZoom: focusResolved.target.kind === 'images' ? 21 : 20.5,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, resolvedKey, insetKey])

  // ---- follow --------------------------------------------------------------
  // The picked record keeps the camera while it moves (playback scrubbing or a
  // live update); the focus anchor moves with it, so the ring and the fades
  // travel too. Anchor updates keep the reported elevation and floor.
  const followDl = follow && dlRef && follow.entityKey === dlRef.entityKey && follow.config.id === dlRef.configId ? follow : null
  // Only moves an anchor the overlay reported: inventing one (1.2 m, no
  // floor) before it answered pinned an upper-floor item's ring to the
  // ground, and the overlay's real answer was then never asked for.
  const onFollowMove = (point: [number, number]) => {
    if (anchor) onDlAnchor(baseKey, { position: point, elevationM: anchor.elevationM, floorPlanId: anchor.floorPlanId })
  }
  const followState = useFollowEntity(map, {
    config: followDl?.config,
    entityKey: followDl?.entityKey ?? null,
    livePoint: followDl?.livePoint ?? null,
    enabled: followDl !== null,
    // Read when the camera moves, clear of the panels open at that moment.
    offset: (m) => padOffset(framePadding(m, insRef.current)),
    onMove: onFollowMove,
  })

  // The report's filters narrowed the list: frame what is left (nothing picked).
  const frameKey = frame?.key ?? null
  useEffect(() => {
    if (!map || !frame || picked) return
    const [w, s, e, n] = frame.bounds
    const pad = framePadding(map, ins, 60)
    if (Math.abs(e - w) < 1e-6 && Math.abs(n - s) < 1e-6) map.easeTo({ center: [w, s], zoom: Math.max(map.getZoom(), 20), offset: padOffset(pad), duration: 700 })
    else map.fitBounds([[w, s], [e, n]], { padding: pad, maxZoom: 20.5, duration: 700, bearing: map.getBearing(), pitch: map.getPitch() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, frameKey])

  // A picked shape focus can't place (degenerate geometry): its box.
  const unresolved = focusResolved === null
  useEffect(() => {
    if (!map || !selected || !unresolved) return
    const b = shapeBounds(selected)
    if (!b) return
    const [w, s, e, n] = b
    const pad = framePadding(map, ins)
    if (w === e && s === n) {
      map.easeTo({ center: [w, s], zoom: Math.max(map.getZoom(), 20), offset: padOffset(pad), duration: 700 })
    } else {
      map.fitBounds([[w, s], [e, n]], { padding: pad, maxZoom: selected.kind === 'images' ? 21 : 20.5, duration: 700, bearing: map.getBearing() })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selKey, insetKey, unresolved])

  // A data row placed by coordinates: a pulsing pin + the camera on it —
  // unless its live symbol is focused (the ring marks it; no second
  // marker), or about to be (pending, briefly).
  const ringCoversPoint = baseTarget?.kind === 'dl' && !anchorMissing && (anchor !== null || !anchorSlow)
  const pinPoint = selectedPoint && !ringCoversPoint ? selectedPoint : null
  const pointKey = pinPoint ? pinPoint.join(',') : null
  useEffect(() => {
    if (!map || !pinPoint) return
    const el = document.createElement('div')
    el.className = 'sgv-explorer-pin'
    el.setAttribute('aria-hidden', 'true')
    const marker = new mapboxgl.Marker({ element: el }).setLngLat(pinPoint).addTo(map)
    // `offset`, not `padding`: an eased padding would stay on the map.
    const pad = framePadding(map, ins)
    map.easeTo({ center: pinPoint, zoom: Math.max(map.getZoom(), 20), offset: padOffset(pad), duration: 700 })
    return () => {
      marker.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, pointKey, insetKey])

  // Map clicks: a live data symbol picks its record; while something is
  // focused, a click nothing claimed lets go. Here only the active kind is
  // clickable — everything else is scenery — so "empty" means "picked
  // nothing", not "hit no layer" (the floor plan covers the whole view
  // once the camera is in close). Claims are counted from `preclick`,
  // which fires before every `click` listener (overlay handlers included,
  // in any registration order), and judged a microtask later, after all
  // of them ran.
  const focusOnRef = useRef(focusOn)
  const onSelectDlRef = useRef(onSelectDl)
  const onClearRef = useRef(onClearSelection)
  const onClusterPickRef = useRef(onClusterPick)
  // The panel insets, for framing an expanded cluster.
  const insRef = useRef(ins)
  useEffect(() => {
    focusOnRef.current = focusOn
    onSelectDlRef.current = onSelectDl
    onClearRef.current = onClearSelection
    onClusterPickRef.current = onClusterPick
    insRef.current = ins
  })
  useEffect(() => {
    if (!overlayMap) return
    let live = true
    let claimsAtPreclick = -1
    const onPreclick = () => {
      claimsAtPreclick = claimsOf(overlayMap)
    }
    const onClick = (e: mapboxgl.MapMouseEvent) => {
      const record = dataRecordAt(overlayMap, e.point)
      if (record) {
        claimClick(overlayMap)
        // A runtime cluster bubble: zoom in when its items can separate,
        // else list them. Never a pick or a let-go.
        if (record.clusterKey !== null && record.configId !== null) {
          const m = getRuntimeClusterMembers(record.configId, record.clusterKey)
          if (!m) return
          if (isClusterExpandable(m)) {
            const [w, s, east, n] = m.bbox
            const padding = framePadding(overlayMap, insRef.current)
            if (w === east && s === n) {
              overlayMap.easeTo({ center: [w, s], zoom: Math.min(overlayMap.getZoom() + 2, CLUSTER_MAX_ZOOM), offset: padOffset(padding), duration: 600 })
            } else {
              overlayMap.fitBounds([[w, s], [east, n]], { padding, maxZoom: CLUSTER_MAX_ZOOM, duration: 600, bearing: overlayMap.getBearing(), pitch: overlayMap.getPitch() })
            }
            return
          }
          onClusterPickRef.current?.({
            configId: record.configId,
            clusterKey: record.clusterKey,
            keys: new Set(m.keys),
            label: m.label,
            labelKind: m.kind === 'room' ? 'room' : m.kind === 'field' ? 'field' : 'location',
            breakdown: m.breakdown,
          })
          return
        }
        if (record.configId !== null && record.entityKey !== null) onSelectDlRef.current?.(record.configId, record.entityKey)
        return
      }
      if (!focusOnRef.current) return
      const seen = claimsAtPreclick
      queueMicrotask(() => {
        if (!live || e.defaultPrevented || claimsOf(overlayMap) !== seen) return
        const el = (e.originalEvent as Event | undefined)?.target
        if (el instanceof Element && el.closest(MAP_ITEM_SELECTOR)) return
        onClearRef.current?.()
      })
    }
    overlayMap.on('preclick', onPreclick)
    overlayMap.on('click', onClick)
    return () => {
      live = false
      overlayMap.off('preclick', onPreclick)
      overlayMap.off('click', onClick)
    }
  }, [overlayMap])

  // A hovered list row: a ghost pin where it is.
  const hoverKey = hoverPoint ? hoverPoint.join(',') : null
  useEffect(() => {
    if (!map || !hoverPoint) return
    const el = document.createElement('div')
    el.className = 'sgv-explorer-hover'
    el.setAttribute('aria-hidden', 'true')
    const marker = new mapboxgl.Marker({ element: el }).setLngLat(hoverPoint).addTo(map)
    return () => {
      marker.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, hoverKey])

  const liveFloorPlanIds = useMemo(
    () => shapes.images.map((i) => i.id).filter((id): id is number => id !== undefined),
    [shapes.images],
  )

  const pick = (kind: ExplorerKind, id: number) => {
    claimClick(map)
    onSelect(kind, id)
  }
  const click = (kind: ExplorerKind) => (id: number) => pick(kind, id)
  const clickable = (kind: ExplorerKind) => selectableKind === kind

  return (
    <div ref={containerRef} className="absolute inset-0">
      <MapboxMap onMapLoad={setMap} onMapDestroy={() => setMap(null)} styleId={mapStyle} />
      {/* Focus is view state: every overlay reads it from these two
          contexts (FOCUS_OFF / NO_BLOCKERS while nothing is picked). */}
      <FocusSceneContext.Provider value={scene}>
        <FocusBlockersContext.Provider value={blockers}>
          <Fragment>
            <MapImageOverlay
              map={overlayMap}
              images={images}
              wallLines={shapes.lines}
              selectedImageIds={sel('images')}
              onImageClick={click('images')}
              selectionEnabled={clickable('images')}
            />
            <MapGridOverlay
              map={overlayMap}
              bbox={null}
              line={null}
              committedLines={committedLines}
              config={grids[0]?.config ?? SIDE_PANEL_DEFAULT_CONFIG}
              selectedGridIds={sel('grids')}
              onCellClick={(gridId) => pick('grids', gridId)}
              selectionEnabled={clickable('grids')}
              occluders={occluders}
            />
            <MapPolygonOverlay
              map={overlayMap}
              polygons={polygons}
              selectedPolygonIds={sel('polygons')}
              onPolygonClick={click('polygons')}
              selectionEnabled={clickable('polygons')}
            />
            <MapLineOverlay
              map={overlayMap}
              lines={lines}
              attachedDoorsByLineId={attachedDoorsByLineId.size > 0 ? attachedDoorsByLineId : null}
              selectedLineIds={sel('lines')}
              onLineClick={click('lines')}
              selectionEnabled={clickable('lines')}
            />
            <MapStairOverlay
              map={overlayMap}
              stairs={stairs}
              floorElevations={floorElevations}
              selectedStairIds={sel('stairs')}
              onStairClick={click('stairs')}
              selectionEnabled={clickable('stairs')}
            />
            <MapModelOverlay
              map={overlayMap}
              models={models}
              urlMap={modelUrlMap}
              boundingCenterMap={modelBoundingCenters}
              boundsMap={modelBounds}
              selectedModelIds={sel('models')}
              onModelClick={click('models')}
              selectionEnabled={clickable('models')}
            />
          </Fragment>
          <MapFloorBaseOverlay map={overlayMap} input={floorBaseInput} />
          <MapDoorOverlay
            map={overlayMap}
            doors={doors}
            committedVisible
            occluders={occluders}
            selectedDoorIds={sel('doors')}
            onDoorClick={click('doors')}
            selectionEnabled={clickable('doors')}
          />
          <MapMarkerOverlay
            map={overlayMap}
            markers={markers}
            occluders={occluders}
            selectedMarkerIds={sel('markers')}
            onMarkerClick={click('markers')}
            selectionEnabled={clickable('markers')}
          />
          <MapTextLabelOverlay
            map={overlayMap}
            labels={textLabels}
            occluders={labelOccluders}
            selectedLabelIds={sel('text-labels')}
            onLabelClick={click('text-labels')}
            selectionEnabled={clickable('text-labels')}
          />
          {dataLinks && dataLinks.length > 0 && (
            <MapDataLinkedOverlay
              map={overlayMap}
              activeZoneId={shapes.images[0]?.zoneId ?? null}
              configs={dataLinks}
              enabled
              polygons={shapes.polygons}
              markers={shapes.markers}
              lines={shapes.lines}
              models={shapes.models}
              occluderPolygons={polygons}
              occluderLines={lines}
              occluderImages={images}
              occluderStairs={stairs}
              styleRules={styleRules}
              disableTooltips
              activeFloorPlanId={floors}
              liveFloorPlanIds={liveFloorPlanIds}
              pointCluster={cluster}
              pointHeatmap={heatSpec}
              configFilters={configFilters}
            />
          )}
          <MapFocusOverlay map={overlayMap} focus={focusResolved} prisms={prisms} />
        </FocusBlockersContext.Provider>
      </FocusSceneContext.Provider>
      {followDl && (followState.playing || followState.paused) && (
        <FollowChip
          label={followDl.label}
          paused={followState.paused}
          onResume={followState.resume}
          style={{ top: ins.top + 12, paddingInlineEnd: ins.right + 16, paddingInlineStart: ins.left + 16 }}
        />
      )}
    </div>
  )
}

const EMPTY: ReadonlySet<number> = new Set()
const NO_PRISMS: ReadonlyArray<OccluderPrism> = []
const NO_ANCHORS: ReadonlyMap<string, DlAnchor | null> = new Map()
/** How long a record target may stay unanswered before the pin shows. */
const ANCHOR_WAIT_MS = 1500
/** DOM on the map that is an item (markers, popups), never "empty map". */
const MAP_ITEM_SELECTOR = '.shape-marker,.mapboxgl-popup'
/** Data-link layers that paint an area or an aggregate, not one record. */
const DL_AREA_LAYER = /-(?:heatmap|heatmap-point|tint|roi-[a-z]+|fov-[a-z]+|track-line)$/

/** Map clicks something on the map took (a pick), per map — see the click effect. */
const mapClaims = new WeakMap<MapboxMapInstance, { n: number }>()
function claimClick(map: MapboxMapInstance | null): void {
  if (!map) return
  const c = mapClaims.get(map)
  if (c) c.n += 1
  else mapClaims.set(map, { n: 1 })
}
function claimsOf(map: MapboxMapInstance): number {
  return mapClaims.get(map)?.n ?? 0
}

function sameAnchor(a: DlAnchor | null, b: DlAnchor | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  return (
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.elevationM === b.elevationM &&
    a.floorPlanId === b.floorPlanId
  )
}

/** Screen offset that centres a point in the padded area (an ease `offset`
 *  doesn't stay on the map the way an eased `padding` does). */
function padOffset(pad: { top: number; right: number; bottom: number; left: number }): [number, number] {
  return [(pad.left - pad.right) / 2, (pad.top - pad.bottom) / 2]
}

/**
 * The topmost live data symbol under a click (`dl-<configId>-…`, or a
 * focused record's `dl-focus-<configId>-…`), as the viewer reads it:
 * `entityKey` null for a cluster. Null when no record symbol is there.
 */
function dataRecordAt(
  map: MapboxMapInstance,
  point: mapboxgl.Point,
): { configId: number | null; entityKey: string | null; clusterKey: string | null } | null {
  const layers = rootLayerOrder(map).filter((id) => id.startsWith('dl-') && !DL_AREA_LAYER.test(id) && hasMapLayer(map, id))
  if (layers.length === 0) return null
  let hits: ReadonlyArray<{ layer?: { id?: string } | null; properties?: Record<string, unknown> | null }>
  try {
    hits = map.queryRenderedFeatures(point, { layers }) as typeof hits
  } catch {
    return null
  }
  const hit = hits[0]
  if (!hit) return null
  const layerId = hit.layer?.id ?? ''
  const m = /^dl-(?:focus-)?(\d+)-/.exec(layerId)
  const props = hit.properties ?? {}
  const cluster = /-cluster(?:-count)?$/.test(layerId) || props.cluster === true || props.manualCluster === true
  const key = props.entityKey
  return {
    configId: m ? Number(m[1]) : null,
    entityKey: !cluster && typeof key === 'string' && key !== '' ? key : null,
    // A runtime cluster bubble (`dl-<id>-rc-cluster(-count)`).
    clusterKey: cluster && typeof props.clusterKey === 'string' && props.clusterKey !== '' ? props.clusterKey : null,
  }
}

export interface MapInsets {
  top?: number
  right?: number
  bottom?: number
  left?: number
}

/**
 * Camera padding that keeps a framed shape in the part of the map no
 * panel covers. Padding must fit inside the canvas — when it doesn't,
 * Mapbox ignores the fit and leaves the shape at an edge — so the panel
 * insets shrink in proportion when the pane is narrow.
 */
function framePadding(
  map: MapboxMapInstance,
  ins: Required<MapInsets>,
  fixed?: number,
): { top: number; right: number; bottom: number; left: number } {
  const width = map.getContainer().clientWidth
  const height = map.getContainer().clientHeight
  const fit = (a: number, b: number, size: number) => {
    const room = Math.max(0, size - 80)
    const k = a + b > room && a + b > 0 ? room / (a + b) : 1
    return [a * k, b * k]
  }
  const [l, r] = fit(ins.left, ins.right, width)
  const [t, b] = fit(ins.top, ins.bottom, height)
  const side = fixed ?? Math.max(16, Math.min(60, (width - l - r) * 0.15))
  const vert = fixed ?? Math.max(16, Math.min(60, (height - t - b) * 0.12))
  const [left, right] = fit(l + side, r + side, width)
  const [top, bottom] = fit(t + vert, b + vert, height)
  return { top, right, bottom, left }
}
