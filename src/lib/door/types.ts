/**
 * Door tool — type definitions.
 *
 * A door is a parametric shape anchored by two lng/lat vertices that
 * define the opening (width + heading). The visual is a built mesh
 * (`door/mesh.ts`: frame + architrave, one or more leaves — single /
 * double / sliding / revolving — with panels and hardware), plus an
 * optional dashed swing arc for plan-view clarity and an optional label
 * point above the opening. Extruded jambs / leaves / lintel remain as
 * invisible click targets.
 *
 * The module is intentionally self-contained: it never imports from
 * `src/lib/shapes.ts`, the shared spatial store, or any other tool's
 * code, so adding a door tool can't affect existing shape pipelines.
 */

/**
 * Door variant. Drives leaf count + render strategy.
 *   - `single`     — one hinged leaf attached at `hingeSide`.
 *   - `double`     — two hinged leaves meeting at the opening centre.
 *   - `sliding`    — a single leaf that translates along the opening
 *                    axis into a wall pocket on `hingeSide`.
 *   - `revolving`  — four leaves at 90° intervals rotating around the
 *                    opening centre.
 */
export type DoorKind = 'single' | 'double' | 'sliding' | 'revolving'

/**
 * Activation state. Hinged doors interpret these as rotation amounts
 * (`closed` = 0°, `ajar` = openAngle/2, `open` = openAngle). Sliding
 * doors interpret them as translation fractions. Revolving doors get
 * a continuous rotation in `open` and a frozen 0° in `closed`.
 */
export type DoorState = 'closed' | 'ajar' | 'open'

/** Which end of the opening the leaf is hinged / pocketed on. */
export type HingeSide = 'left' | 'right'

/**
 * Swing direction for hinged variants. Inward means the leaf swings
 * to the perpendicular-left of the opening's heading vector (v0 → v1).
 * Outward is the opposite side. Sliding / revolving variants ignore
 * this field.
 */
export type SwingDirection = 'inward' | 'outward'

/** Visual style + parametric controls. All physical units are METERS. */
export interface DoorConfig {
  // ---- structure -------------------------------------------------------
  kind: DoorKind
  state: DoorState
  /** Maximum swing angle in degrees (0..180). Used when `state === 'open'`. */
  openAngle: number
  hingeSide: HingeSide
  swingDirection: SwingDirection

  // ---- dimensions ------------------------------------------------------
  /** Door panel height (z extrusion), meters. */
  doorHeight: number
  /** Base elevation above the basemap surface, meters. 0 = on ground. */
  elevation: number
  /** Frame jamb wall thickness perpendicular to the opening, meters. */
  frameThickness: number
  /** Frame jamb width along the opening direction at each end, meters. */
  frameWidth: number
  /** Door leaf thickness, meters. */
  leafThickness: number

  // ---- visibility toggles ---------------------------------------------
  showFrame: boolean
  showSwingArc: boolean
  showLabels: boolean

  // ---- colors ----------------------------------------------------------
  frameColor: string
  leafColor: string
  arcColor: string
  labelColor: string

  // ---- misc ------------------------------------------------------------
  /** Whole-shape opacity 0..100. */
  opacity: number
  label: string
  labelSize: number

  // ---- wall attachment (2026-07) --------------------------------------
  /**
   * Optional. When present, this door is attached to the LineShape with
   * this id — its opening cuts a real hole in the wall's fill-extrusion
   * (see `line-generators.ts` → `buildLineWallFeature`). Doors attached
   * to a wall stay in sync when the wall moves/rotates because the wall
   * generator re-derives the hole footprint from the door's own
   * vertices on every render.
   *
   * A leaked stale id (the wall was deleted while the door still refers
   * to it) is harmless: the wall generator's Map lookup misses and no
   * hole is cut. The door itself keeps rendering at its own vertices.
   */
  attachedToLineId?: number
  /**
   * 0..1 fractional position along the wall's polyline where the door
   * centre sits. Kept as a diagnostic + for future "slide door along
   * wall" UX; not consumed by the render pipeline (which reads the
   * door's own vertices).
   */
  attachPositionOnLine?: number
}

/**
 * A persisted door. `vertices` carries the two anchors the user
 * clicked to draw the opening — vertices[0] is the v0 end, vertices[1]
 * is the v1 end, which together define width + heading.
 *
 * `id` is the backend row id once the door has been persisted via
 * `apiDb.doors`. Newly-drawn doors get a temporary negative id from
 * `useDoorStore`'s draft counter until the round-trip completes; the
 * door store reconciles the temp id to the server id when the response
 * lands. The store still mirrors the row to localStorage for instant
 * cold-start so the editor stays responsive across reloads.
 *
 * `zoneId` is the warehouse FK. `floorPlanId` is the floor FK so a
 * door can be scoped to a single level when the warehouse has stacked
 * floor plans. `unit`, `rotation`, `tenantId` and `createdAt/updatedAt`
 * mirror the canonical `ShapeBase` shape used by every other shape kind
 * so doors can ride the same SSE + spatial-store plumbing.
 */
export interface DoorShape {
  id: number
  tenantId?: number
  name: string
  vertices: [[number, number], [number, number]]
  rotation?: number
  config: DoorConfig
  zoneId?: number
  floorPlanId?: number
  unit?: string
  visible: boolean
  createdAt: number | Date
  updatedAt: number | Date
}

/** Default config for newly-drawn doors. Residential-scale defaults. */
export const DEFAULT_DOOR_CONFIG: DoorConfig = {
  kind: 'single',
  state: 'closed',
  // 90° is the conventional "fully open" swing in architectural drawings.
  openAngle: 90,
  hingeSide: 'left',
  swingDirection: 'inward',
  // 2.05 m is the typical interior door height (≈ 6'9").
  doorHeight: 2.05,
  elevation: 0,
  // 0.15 m jamb wall thickness — reads cleanly at warehouse scale
  // without dominating the leaf.
  frameThickness: 0.15,
  // 0.1 m of jamb visible on each side of the opening along the
  // heading direction.
  frameWidth: 0.1,
  // 0.04 m (~ 1.6") is a typical interior leaf thickness.
  leafThickness: 0.04,
  showFrame: true,
  showSwingArc: true,
  showLabels: false,
  // Classic interior door: light grey-white frame, white slab,
  // brass hardware. Matches the architectural palette most
  // floor-plan renderings use; the user can still override.
  frameColor: '#e5e7eb',
  leafColor: '#f8fafc',
  arcColor: '#94a3b8',
  labelColor: '#0f172a',
  opacity: 100,
  label: '',
  labelSize: 12,
}

/** Bumps every time the persisted schema changes, so older payloads can be migrated or discarded. */
export const DOOR_SCHEMA_VERSION = 1

/** Per-feature property bag emitted by `buildDoorFeatures`. */
export interface DoorFeatureProps {
  doorId: number
  /**
   * Discriminates the role of this feature within a door:
   *   - `frame`  → jamb at either end of the opening (click target)
   *   - `leaf`   → the door slab footprint (click target)
   *   - `lintel` → header bar over the opening (click target)
   *   - `arc`    → dashed swing-arc indicator
   *   - `label`  → text point above the opening
   * Panels, handles and hinges live in the mesh (door/mesh.ts).
   */
  kind: 'frame' | 'leaf' | 'lintel' | 'arc' | 'label'
  /** Bottom z in meters (drives `fill-extrusion-base`). */
  base_height: number
  /** Top z in meters (drives `fill-extrusion-height`). */
  height: number
  color: string
  /** 0..1, Mapbox-friendly. */
  opacity: number
  /** Display name when `kind === 'label'`. */
  text?: string
  textColor?: string
  textSize?: number
}
