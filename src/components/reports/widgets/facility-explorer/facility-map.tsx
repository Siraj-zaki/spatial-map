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
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'
import { MapboxMap, DEFAULT_MAP_STYLE, type MapStyleId } from '@/components/mapbox-map'
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
import type { DataLinkConfig } from '@/lib/db'
import type { StyleRule } from '@/lib/style-rules'
import { SIDE_PANEL_DEFAULT_CONFIG } from '@/components/side-panel'
import { useDoorStore } from '@/lib/door/store'
import type { DoorShape } from '@/lib/door/types'
import { imageCorners } from '@/lib/image-generators'
import { useModelBoundingCenterMap, useModelUrlMap } from '@/lib/model-assets'
import { liftFloorPlanIds } from '@/lib/shapes'
import { useSpatialStore } from '@/lib/spatial-store'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { useSSE } from '@/lib/useSSE'
import { shapeBounds, type ExplorerKind, type ExplorerShape, type ExplorerShapes } from './explorer-geometry'

/** The viewer ignores the editor's per-shape hide flag; so do we. */
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
  useSSE(tenantId)
  useEffect(() => {
    if (tenantId === null || !Number.isFinite(zoneId)) return
    const s = useSpatialStore.getState()
    s.setTenantId(tenantId)
    s.setActiveZoneId(zoneId)
    void s.loadAll()
    void useDoorStore.getState().loadForWarehouse(zoneId)
  }, [tenantId, zoneId])

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
    const inZone = <T extends { zoneId?: number }>(rows: readonly T[]) => forceVisible(rows.filter((r) => r.zoneId === zoneId))
    return {
      polygons: inZone(polygons),
      markers: inZone(markers),
      grids: inZone(grids),
      images: inZone(images),
      lines: inZone(lines),
      stairs: inZone(stairs),
      textLabels: inZone(textLabels),
      models: inZone(models),
      doors: forceVisible(doors.filter((d) => d.zoneId === undefined || d.zoneId === zoneId)),
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
  /** Data links drawn live on the map (the linked-data reports). */
  dataLinks?: ReadonlyArray<DataLinkConfig>
  styleRules?: ReadonlyArray<StyleRule>
  /** Basemap; swapped in place (the overlays re-add on style.load). */
  styleId?: MapStyleId
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
  dataLinks,
  styleRules,
  styleId = DEFAULT_MAP_STYLE,
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

  // ---- camera ------------------------------------------------------------
  // First fit: the shown floor's plan (with its bearing), else every floor.
  const fittedFor = useRef<string | null>(null)
  const floorsKey = floors === null ? 'all' : [...floors].sort((a, b) => a - b).join(',')
  // Several floors at once read as a stack only when the camera is tilted.
  const stacked = images.length > 1
  useEffect(() => {
    if (!map) return
    // Re-frame when the floors change or a panel opens / measures in.
    const key = `${floorsKey}|${insetKey}`
    if (fittedFor.current === key || selected) return
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
  }, [map, floorsKey, images, shapes.images, selected, insetKey])

  // Frame the selection, clear of the detail card.
  useEffect(() => {
    if (!map || !selected) return
    const b = shapeBounds(selected)
    if (!b) return
    const [w, s, e, n] = b
    const point = w === e && s === n
    const pad = framePadding(map, ins)
    if (point) {
      map.easeTo({ center: [w, s], zoom: Math.max(map.getZoom(), 20), padding: pad, duration: 700 })
    } else {
      map.fitBounds([[w, s], [e, n]], { padding: pad, maxZoom: selected.kind === 'images' ? 21 : 20.5, duration: 700, bearing: map.getBearing() })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selKey, insetKey])

  // A data row placed by coordinates: a pulsing pin + the camera on it.
  const pointKey = selectedPoint ? selectedPoint.join(',') : null
  useEffect(() => {
    if (!map || !selectedPoint) return
    const el = document.createElement('div')
    el.className = 'sgv-explorer-pin'
    el.setAttribute('aria-hidden', 'true')
    const marker = new mapboxgl.Marker({ element: el }).setLngLat(selectedPoint).addTo(map)
    map.easeTo({ center: selectedPoint, zoom: Math.max(map.getZoom(), 20), padding: framePadding(map, ins), duration: 700 })
    return () => {
      marker.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, pointKey, insetKey])

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

  const click = (kind: ExplorerKind) => (id: number) => onSelect(kind, id)
  const clickable = (kind: ExplorerKind) => selectableKind === kind

  return (
    <div ref={containerRef} className="absolute inset-0">
      <MapboxMap onMapLoad={setMap} onMapDestroy={() => setMap(null)} styleId={mapStyle} />
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
          onCellClick={(gridId) => onSelect('grids', gridId)}
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
        />
      )}
    </div>
  )
}

const EMPTY: ReadonlySet<number> = new Set()

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
