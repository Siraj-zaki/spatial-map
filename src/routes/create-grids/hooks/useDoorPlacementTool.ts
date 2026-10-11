import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'

import type { Map as MapboxMapInstance, MapMouseEvent } from 'mapbox-gl'

import type { DoorShape } from '@/lib/door/types'
import { useDoorStore } from '@/lib/door/store'
import {
  doorAnchorsAroundCursor,
  doorAnchorsFromWallSnap,
  resolveDoorWallSnap,
  type DoorWallSnap,
} from '@/lib/door/wall-snap'
import { type Tool } from '@/lib/keyboard-shortcuts'
import { type LineShape } from '@/lib/shapes'

import type { DoorCursorPreview } from '../state/useDoorEditorState'

/**
 * Door placement tool. Two commit paths:
 *   - **Wall single-click**: when the cursor is snapped to a wall AND
 *     no anchors have been placed, one click commits the door with
 *     `attachedToLineId` + `attachPositionOnLine` set so the wall
 *     generator cuts a hole where it lands.
 *   - **Free-space two-click**: click 1 places the first jamb,
 *     click 2 places the opposite jamb and commits a free-standing
 *     door via `useDoorStore.addDoor`.
 *
 * Also owns the door-selection lifecycle: switching to Pan (or to any
 * creation tool other than `create-door`) clears the door selection
 * so the side-panel stops showing the door editor after the user is
 * done. And the chain-drawing seed: activating the tool while a door
 * is selected copies that door's config into `pendingConfig` so the
 * next placement stamps a visually-identical door.
 */
export function useDoorPlacementTool({
  mapInstance,
  activeTool,
  selectedDoorIds,
  doors,
  savedLines,
  doorWallSnap,
  setDoorPendingConfig,
  addDoorToStore,
  setDoorDraftAnchors,
  setDoorDraftCursor,
  setDoorWallSnap,
  setDoorCursorPreview,
  setSelectedDoorIds,
  setSelectedGridIds,
  setSelectedMarkerIds,
  setSelectedCircleIds,
  setSelectedPolygonIds,
  setSelectedLineIds,
  setSelectedImageIds,
  setSelectedModelIds,
  setSelectedStairIds,
  setActiveTool,
}: {
  mapInstance: MapboxMapInstance | null
  activeTool: Tool
  selectedDoorIds: Set<number>
  doors: DoorShape[]
  savedLines: LineShape[]
  doorWallSnap: DoorWallSnap | null
  setDoorPendingConfig: (config: DoorShape['config']) => void
  addDoorToStore: (vertices: [[number, number], [number, number]]) => DoorShape
  setDoorDraftAnchors: Dispatch<SetStateAction<[number, number][]>>
  setDoorDraftCursor: Dispatch<SetStateAction<[number, number] | null>>
  setDoorWallSnap: Dispatch<SetStateAction<DoorWallSnap | null>>
  setDoorCursorPreview: Dispatch<SetStateAction<DoorCursorPreview>>
  setSelectedDoorIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedGridIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedMarkerIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedCircleIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedPolygonIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedLineIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedImageIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedModelIds: Dispatch<SetStateAction<Set<number>>>
  setSelectedStairIds: Dispatch<SetStateAction<Set<number>>>
  setActiveTool: Dispatch<SetStateAction<Tool>>
}) {
  // ---- Door selection lifecycle ------------------------------------------
  // Match the behavior the user expects from a CAD-style tool: Pan is
  // pure navigation, so switching to it (or to any creation tool other
  // than create-door) clears the door selection.
  useEffect(() => {
    if (selectedDoorIds.size === 0) return
    if (activeTool === 'select' || activeTool === 'create-door') return
    setSelectedDoorIds(new Set())
  }, [activeTool, selectedDoorIds.size, setSelectedDoorIds]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Chain-drawing seed -------------------------------------------------
  // When the user activates the Door tool while a door is selected,
  // seed `pendingConfig` from that door so the next click pair stamps
  // a visually-identical door.
  const lastChainSourceIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (activeTool !== 'create-door') {
      lastChainSourceIdRef.current = null
      return
    }
    if (selectedDoorIds.size !== 1) return
    const id = [...selectedDoorIds][0]
    if (lastChainSourceIdRef.current === id) return
    const src = doors.find((d) => d.id === id)
    if (!src) return
    lastChainSourceIdRef.current = id
    setDoorPendingConfig({ ...src.config })
  }, [activeTool, selectedDoorIds, doors, setDoorPendingConfig])

  // ---- Draw / commit effect ----------------------------------------------
  // Two-click flow: click 1 places the first jamb, click 2 places the
  // opposite jamb and commits the door via `useDoorStore.addDoor`.
  // Single-click flow: when snapped to a wall on the first click, the
  // door commits immediately, attached to the wall.
  const doorDraftAnchorsRef = useRef<[number, number][]>([])
  const doorWallSnapRef = useRef<DoorWallSnap | null>(null)
  useEffect(() => {
    doorWallSnapRef.current = doorWallSnap
  }, [doorWallSnap])
  const savedLinesRef = useRef<LineShape[]>(savedLines)
  useEffect(() => {
    savedLinesRef.current = savedLines
  }, [savedLines])
  // Reset the draft anchors when the tool exits — cleaner than binding
  // that to the main effect's cleanup.
  useEffect(() => {
    if (activeTool !== 'create-door') doorDraftAnchorsRef.current = []
  }, [activeTool])

  useEffect(() => {
    if (!mapInstance) return
    if (activeTool !== 'create-door') {
      setDoorDraftAnchors([])
      setDoorDraftCursor(null)
      setDoorWallSnap(null)
      setDoorCursorPreview(null)
      return
    }
    const map = mapInstance
    map.getCanvas().style.cursor = 'crosshair'

    // Preview + wall-snap commit width comes from the store's
    // `pendingWidthMeters` (bound to the Opening-width slider in the
    // placement panel). Read via getState inside each callback so the
    // effect doesn't need to re-subscribe when the user drags the
    // slider — the next mousemove / click picks up the fresh value.
    const readPreviewWidthM = () =>
      useDoorStore.getState().pendingWidthMeters

    /**
     * Persist a snapped door: commits with `attachedToLineId` and
     * `attachPositionOnLine` set so the wall generator cuts a hole
     * where the door lands. Called from the click handler when the
     * cursor snap is active on the FIRST click (single-click flow).
     */
    const commitSnappedDoor = (
      snap: DoorWallSnap,
      anchors: [[number, number], [number, number]],
    ) => {
      // Seed the door's config from the store's pending draft +
      // stamp the wall-attach fields on top so the row round-trips
      // with the attachment intact.
      const draftCfg = useDoorStore.getState().pendingConfig
      useDoorStore.getState().setPendingConfig({
        ...draftCfg,
        attachedToLineId: snap.wallId,
        attachPositionOnLine: snap.positionOnLine,
      })
      const door = addDoorToStore(anchors)
      // Restore the pending config so subsequent doors don't inherit
      // this specific wall's attachment.
      useDoorStore.getState().setPendingConfig(draftCfg)
      setSelectedDoorIds(new Set([door.id]))
      setSelectedGridIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedMarkerIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedCircleIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedPolygonIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedLineIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedImageIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedModelIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedStairIds((p) => (p.size > 0 ? new Set() : p))
      setActiveTool('select')
    }

    const onClick = (e: MapMouseEvent) => {
      if (e.originalEvent?.defaultPrevented) return
      const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat]

      // ---- Wall single-click commit -----------------------------
      // If the cursor is snapped to a wall AND no anchors placed
      // yet, one click is enough — the door snaps onto the wall,
      // orients to the wall's axis, and cuts a hole in the wall.
      // Two-click free placement stays as a fallback for doors
      // drawn away from any wall.
      if (
        doorWallSnapRef.current &&
        doorDraftAnchorsRef.current.length === 0
      ) {
        const snap = doorWallSnapRef.current
        const anchors = doorAnchorsFromWallSnap(snap, readPreviewWidthM())
        setDoorCursorPreview(null)
        setDoorWallSnap(null)
        commitSnappedDoor(snap, anchors)
        return
      }

      // ---- Free-space 2-click flow ------------------------------
      const next: [number, number][] = [...doorDraftAnchorsRef.current, lngLat]
      if (next.length < 2) {
        doorDraftAnchorsRef.current = next
        setDoorDraftAnchors(next)
        setDoorDraftCursor(lngLat)
        // Once a first anchor is placed, the cursor preview is
        // superseded by the chain preview.
        setDoorCursorPreview(null)
        return
      }
      // Second click — commit a free-standing door.
      const v0 = next[0]
      const v1 = next[1]
      doorDraftAnchorsRef.current = []
      setDoorDraftAnchors([])
      setDoorDraftCursor(null)
      setDoorCursorPreview(null)
      setDoorWallSnap(null)
      const door = addDoorToStore([v0, v1])
      setSelectedDoorIds(new Set([door.id]))
      setSelectedGridIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedMarkerIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedCircleIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedPolygonIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedLineIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedImageIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedModelIds((p) => (p.size > 0 ? new Set() : p))
      setSelectedStairIds((p) => (p.size > 0 ? new Set() : p))
      setActiveTool('select')
    }

    // RAF-coalesce mousemove — Mapbox fires mousemove at pointer rate
    // (120–500 Hz on modern hardware) but we only need one update per
    // paint frame. Without this, every event triggers a React state
    // update → `preview` useMemo in the overlay re-runs
    // `buildDoorFeaturesRaw` (frame jambs + leaves + arcs + labels) →
    // dropped frames on complex hinged doors. With coalescing, we cap
    // the work at 60 fps.
    let pendingLngLat: [number, number] | null = null
    let moveRafId = 0
    const flushMove = () => {
      moveRafId = 0
      const lngLat = pendingLngLat
      pendingLngLat = null
      if (!lngLat) return

      // Between-clicks: keep the existing chain preview cursor in sync
      // so the "click 1 → click 2" free-space flow still shows the
      // opening width guide.
      if (doorDraftAnchorsRef.current.length > 0) {
        setDoorDraftCursor(lngLat)
        setDoorCursorPreview(null)
        setDoorWallSnap(null)
        return
      }

      // Pre-first-click: compute wall snap + a full cursor preview so
      // the user sees the door before committing.
      const snap = resolveDoorWallSnap({
        map,
        cursor: lngLat,
        savedLines: savedLinesRef.current,
      })
      if (snap) {
        setDoorWallSnap(snap)
        const anchors = doorAnchorsFromWallSnap(snap, readPreviewWidthM())
        setDoorCursorPreview({
          vertices: anchors,
          attachedToLineId: snap.wallId,
        })
        map.getCanvas().style.cursor = 'copy'
      } else {
        setDoorWallSnap(null)
        const anchors = doorAnchorsAroundCursor(lngLat, readPreviewWidthM())
        setDoorCursorPreview({ vertices: anchors })
        map.getCanvas().style.cursor = 'crosshair'
      }
    }
    const onMove = (e: MapMouseEvent) => {
      pendingLngLat = [e.lngLat.lng, e.lngLat.lat]
      if (moveRafId === 0) moveRafId = requestAnimationFrame(flushMove)
    }

    const onLeave = () => {
      // Cursor left the map — hide the preview to avoid a stale ghost.
      if (doorDraftAnchorsRef.current.length === 0) {
        setDoorCursorPreview(null)
        setDoorWallSnap(null)
      }
    }

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        if (doorDraftAnchorsRef.current.length > 0) {
          doorDraftAnchorsRef.current = []
          setDoorDraftAnchors([])
          setDoorDraftCursor(null)
        } else {
          setActiveTool('pan')
        }
      }
    }

    map.on('click', onClick)
    map.on('mousemove', onMove)
    map.on('mouseout', onLeave)
    window.addEventListener('keydown', onKey)
    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
      map.off('mouseout', onLeave)
      window.removeEventListener('keydown', onKey)
      if (moveRafId !== 0) cancelAnimationFrame(moveRafId)
      pendingLngLat = null
      map.getCanvas().style.cursor = ''
    }
  }, [mapInstance, activeTool, addDoorToStore]) // eslint-disable-line react-hooks/exhaustive-deps
}
