/**
 * Focus mode — the view state overlays read.
 *
 * A host (the viewer, the report map, the editor) owns the focus target in
 * its own state and publishes two values through React context — never a
 * store:
 *
 *  - `FocusSceneContext` — WHAT is focused, the item's floor, and the
 *    NEAR column around it (`scene.near`, `focus-near.ts`). Its identity
 *    changes only when focus is entered, left or changed (or the column's
 *    content changes).
 *  - `FocusBlockersContext` — the shapes standing between the camera and
 *    the focused item right now (`focus-blockers.ts`). Changes only when
 *    that set changes (camera settle, throttled additions mid-move).
 *
 * The fade policy is the same for every host: the focused item stays as
 * drawn (plus its highlight and the ring), line-of-sight blockers fade to
 * `FOCUS_FACTOR.ghost`, shapes in the NEAR column fade to
 * `FOCUS_FACTOR.near`, and EVERYTHING ELSE stays exactly as it was — no
 * global dim, no whole-floor fades.
 *
 * Overlays turn the pair into a per-item tier with `focusTier`, and the
 * tier into an opacity factor with `FOCUS_FACTOR` / `focusFactor`. Outside
 * a provider both contexts read FOCUS_OFF / NO_BLOCKERS, every tier is
 * 'normal' and every factor 1 — so an overlay mounted without a host
 * behaves exactly as before focus mode existed.
 */

import { createContext, useContext, useMemo } from 'react'

import { NO_NEAR, nearIdsOf, type FocusNear } from './focus-near'
import {
  focusDlRef,
  focusKey,
  type DlAnchor,
  type FocusCell,
  type FocusDlRef,
  type FocusShapeKind,
  type FocusTarget,
  type ResolvedFocus,
} from './focus-target'

/** Precedence focus > ghost > near > normal. */
export type FocusTier = 'normal' | 'focus' | 'near' | 'ghost'

export const FOCUS_FACTOR: Readonly<Record<FocusTier, number>> = Object.freeze({
  normal: 1,
  focus: 1,
  near: 0.35,
  ghost: 0.15,
})

/** Opacity of an occluded marker / label / data symbol while Graphics → "faint ghosts" is on. */
export const GHOST_OCCLUDED_OPACITY = 0.25

export interface FocusScene {
  /** false only for FOCUS_OFF */
  active: boolean
  /** focusKey(target), '' when off */
  key: string
  target: FocusTarget | null
  /** focusDlRef(target) */
  dl: FocusDlRef | null
  /** target?.kind === 'dl' && !target.anchor */
  needsDlAnchor: boolean
  /** resolved?.floorPlanId ?? null */
  floorPlanId: number | null
  /**
   * The NEAR column around the item (NO_NEAR while off, pending or for a
   * floor-plan target). `near.region` is what data-link symbols test with
   * `isFocusNearPoint`.
   */
  near: FocusNear
  /** Data-link overlay → host: the pending dl target's drawn anchor (null = not drawn). */
  onDlAnchor: ((key: string, anchor: DlAnchor | null) => void) | null
}

export const FOCUS_OFF: FocusScene = Object.freeze({
  active: false,
  key: '',
  target: null,
  dl: null,
  needsDlAnchor: false,
  floorPlanId: null,
  near: NO_NEAR,
  onDlAnchor: null,
})

/** The kinds that can stand in the line of sight (they have occluder prisms). */
export type BlockerKind = 'images' | 'polygons' | 'circles' | 'lines' | 'stairs' | 'grids'

/**
 * Cut-away disc centres, [lng, lat], each of radius `FOCUS_NEAR_RADIUS_M`:
 * where the camera→item rays enter / leave one blocker.
 */
export type FocusDiscs = ReadonlyArray<readonly [number, number]>

export interface FocusBlockers {
  /** '' when empty; changes iff some set or some disc changed */
  key: string
  images: ReadonlySet<number>
  polygons: ReadonlySet<number>
  circles: ReadonlySet<number>
  lines: ReadonlySet<number>
  stairs: ReadonlySet<number>
  grids: ReadonlySet<number>
  /** `${gridId}:${row}:${col}:${level}` */
  gridCells: ReadonlySet<string>
  /**
   * Per kind: blocker id → where the line of sight pierces it (computed
   * with the sets, at focus enter and camera settle; a mid-move pass only
   * adds ids, never moves an existing id's discs). `focus-cutaway.ts`
   * fades only the part of a big blocker around these discs. Each kind's
   * Map object is kept while its content is unchanged.
   */
  pierce: Readonly<Record<BlockerKind, ReadonlyMap<number, FocusDiscs>>>
}

/** Shared empty id set — also what `blockerIdsOf` returns for kinds that never occlude. */
const NO_IDS: ReadonlySet<number> = new Set()
const NO_CELLS: ReadonlySet<string> = new Set()
/** Shared empty pierce map — what `blockerPierceOf` returns for kinds that never occlude. */
const NO_DISCS: ReadonlyMap<number, FocusDiscs> = new Map()

export const NO_PIERCE: Readonly<Record<BlockerKind, ReadonlyMap<number, FocusDiscs>>> = Object.freeze({
  images: NO_DISCS,
  polygons: NO_DISCS,
  circles: NO_DISCS,
  lines: NO_DISCS,
  stairs: NO_DISCS,
  grids: NO_DISCS,
})

export const NO_BLOCKERS: FocusBlockers = Object.freeze({
  key: '',
  images: NO_IDS,
  polygons: NO_IDS,
  circles: NO_IDS,
  lines: NO_IDS,
  stairs: NO_IDS,
  grids: NO_IDS,
  gridCells: NO_CELLS,
  pierce: NO_PIERCE,
})

export const FocusSceneContext = createContext<FocusScene>(FOCUS_OFF)
FocusSceneContext.displayName = 'FocusScene'
export const FocusBlockersContext = createContext<FocusBlockers>(NO_BLOCKERS)
FocusBlockersContext.displayName = 'FocusBlockers'

export function useFocusScene(): FocusScene {
  return useContext(FocusSceneContext)
}

export function useFocusBlockers(): FocusBlockers {
  return useContext(FocusBlockersContext)
}

export interface FocusSceneArgs {
  target: FocusTarget | null
  resolved: ResolvedFocus | null
  /** `useFocusNear(resolved, prisms, shapes)`; used only when computed for this target's key. */
  near?: FocusNear
  onDlAnchor?: ((key: string, anchor: DlAnchor | null) => void) | null
}

/** `resolved` when it belongs to `key` — a stale resolution never leaks its floor into a new focus. */
function resolvedFor(key: string, resolved: ResolvedFocus | null): ResolvedFocus | null {
  return resolved && resolved.key === key ? resolved : null
}

/** `near` when it was computed for `key` — a stale column never leaks into a new focus. */
function nearFor(key: string, near: FocusNear | undefined): FocusNear {
  return near && key !== '' && near.focusKey === key ? near : NO_NEAR
}

export function buildFocusScene(args: FocusSceneArgs): FocusScene {
  const target = args.target
  if (!target) return FOCUS_OFF
  const key = focusKey(target)
  const resolved = resolvedFor(key, args.resolved)
  return {
    active: true,
    key,
    target,
    dl: focusDlRef(target),
    needsDlAnchor: target.kind === 'dl' && !target.anchor,
    floorPlanId: resolved?.floorPlanId ?? null,
    near: nearFor(key, args.near),
    onDlAnchor: args.onDlAnchor ?? null,
  }
}

/**
 * Memoised: identity changes only when key / needsDlAnchor / resolved
 * floor and altitude / the effective near column / onDlAnchor change.
 * Returns FOCUS_OFF for a null target.
 */
export function useFocusSceneValue(args: FocusSceneArgs): FocusScene {
  const key = focusKey(args.target)
  const needsDlAnchor = args.target?.kind === 'dl' && !args.target.anchor
  const resolved = resolvedFor(key, args.resolved)
  const hasResolved = resolved !== null
  const floorPlanId = resolved?.floorPlanId ?? null
  const altitudeM = resolved?.altitudeM ?? null
  const near = nearFor(key, args.near)
  const { onDlAnchor } = args
  return useMemo(
    () => buildFocusScene(args),
    // `args` is read only through these: a new target / resolved object
    // with the same key, floor and altitude describes the same scene, and
    // keeping the identity is what stops every overlay re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, needsDlAnchor, hasResolved, floorPlanId, altitudeM, near, onDlAnchor],
  )
}

/**
 * First match wins: !active → normal; the exact (kind, id) target without
 * a cell → focus; id in the blocker set of kind → ghost; id in the NEAR
 * column of kind → near; else normal. A rack-bin target's own grid is
 * never 'focus' (it can be 'near').
 */
export function focusTier(
  scene: FocusScene,
  blockers: FocusBlockers,
  kind: FocusShapeKind,
  id: number | undefined,
): FocusTier {
  if (!scene.active || id === undefined) return 'normal'
  const t = scene.target
  if (t !== null && t.kind === kind && t.id === id && !t.cell) return 'focus'
  if (blockerIdsOf(blockers, kind).has(id)) return 'ghost'
  if (nearIdsOf(scene.near, kind).has(id)) return 'near'
  return 'normal'
}

/** FOCUS_FACTOR[focusTier(...)] — 1 for everything outside the blockers and the NEAR column. */
export function focusFactor(
  scene: FocusScene,
  blockers: FocusBlockers,
  kind: FocusShapeKind,
  id: number | undefined,
): number {
  if (!scene.active) return 1
  return FOCUS_FACTOR[focusTier(scene, blockers, kind, id)]
}

/** target.id when target.kind === kind (cell targets included), else null. */
export function focusedIdOf(scene: FocusScene, kind: FocusShapeKind): number | null {
  const t = scene.target
  return t !== null && t.kind === kind ? t.id : null
}

const focusedCells = new WeakMap<FocusScene, (FocusCell & { gridId: number }) | null>()

/** The focused rack bin, or null. Same object for the same scene (safe memo dep). */
export function focusedCellOf(scene: FocusScene): (FocusCell & { gridId: number }) | null {
  const t = scene.target
  if (t === null || t.kind !== 'grids' || !t.cell) return null
  let hit = focusedCells.get(scene)
  if (hit === undefined) {
    hit = { gridId: t.id, row: t.cell.row, col: t.cell.col, level: t.cell.level }
    focusedCells.set(scene, hit)
  }
  return hit
}

/**
 * Same Set object while that kind's content is unchanged (safe memo dep);
 * a shared empty set for kinds that never occlude.
 */
export function blockerIdsOf(blockers: FocusBlockers, kind: FocusShapeKind): ReadonlySet<number> {
  switch (kind) {
    case 'images':
      return blockers.images
    case 'polygons':
      return blockers.polygons
    case 'circles':
      return blockers.circles
    case 'lines':
      return blockers.lines
    case 'stairs':
      return blockers.stairs
    case 'grids':
      return blockers.grids
    default:
      return NO_IDS
  }
}

/**
 * Where the line of sight pierces each blocker of `kind` (id → disc
 * centres). The SAME Map object while that kind's content is unchanged
 * (safe memo dep); a shared empty map for kinds that never occlude and
 * for blockers built without discs.
 */
export function blockerPierceOf(blockers: FocusBlockers, kind: FocusShapeKind): ReadonlyMap<number, FocusDiscs> {
  const pierce = blockers.pierce ?? NO_PIERCE
  switch (kind) {
    case 'images':
      return pierce.images
    case 'polygons':
      return pierce.polygons
    case 'circles':
      return pierce.circles
    case 'lines':
      return pierce.lines
    case 'stairs':
      return pierce.stairs
    case 'grids':
      return pierce.grids
    default:
      return NO_DISCS
  }
}
