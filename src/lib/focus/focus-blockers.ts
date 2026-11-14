/**
 * Focus mode — which shapes stand between the camera and the focused item.
 *
 * `computeFocusBlockers` runs `collectOccluders` (the all-hits twin of the
 * occlusion pass's `queryOccluder`, same exact test, same shared index)
 * from the camera to each of the item's samples, drops the item's own
 * prisms and sorts the rest into per-kind id sets. Overlays fade exactly
 * those ids (`focusTier` → 'ghost'); nothing else about them changes —
 * a faded blocker keeps occluding other markers, and no occluder input
 * or prism list is touched.
 *
 * With the sets come the PIERCE discs (`FocusBlockers.pierce`): for every
 * blocker, where each camera→sample ray enters its prism (and leaves it,
 * when that is more than half a radius further on) — `prismPierceSpan`.
 * At most 6 per blocker, de-duplicated within half a radius. A big
 * blocker fades only around them (`focus-cutaway.ts`), not as a whole.
 *
 * `useTrackFocusBlockers` keeps the set current for a host:
 *  - focus change → computed at once from the current camera, plus the
 *    camera `flyToFocus` planned for this key, so blockers at the
 *    destination fade before arrival;
 *  - camera `move` → throttled to 250 ms and ADD-only (show immediately);
 *    ids already published keep their discs, new ids bring theirs;
 *  - `moveend` → the exact set and discs (hide late);
 *  - same key, new geometry or prism list → one throttled exact recompute.
 * State is set only when the set changes, and a kind's Set / pierce Map
 * object is kept while its content is unchanged, so `blockerIdsOf` /
 * `blockerPierceOf(blockers, kind)` are safe memo dependencies for an
 * overlay.
 */

import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'
import { useEffect, useRef, useState } from 'react'

import { collectOccluders, occluderIndexFor, prismPierceSpan, type OccluderPrism } from '@/lib/occluder-index'

import { lastFocusCameraPlan, type FocusCameraPlan } from './focus-camera'
import { FOCUS_NEAR_RADIUS_M } from './focus-near'
import { NO_BLOCKERS, NO_PIERCE, type BlockerKind, type FocusBlockers, type FocusDiscs } from './focus-scene'
import { isOwnPrismKey, type ResolvedFocus } from './focus-target'

type IdKind = BlockerKind

/** Most cut-away discs kept per blocker. */
const MAX_DISCS_PER_BLOCKER = 6

const ID_KINDS: readonly IdKind[] = ['images', 'polygons', 'circles', 'lines', 'stairs', 'grids']

/** Prism key prefix → blocker kind (`<prefix>:<id>[:…]`, see `buildOccluders`). */
const KIND_OF_PREFIX: Readonly<Record<string, IdKind>> = {
  image: 'images',
  polygon: 'polygons',
  circle: 'circles',
  line: 'lines',
  stair: 'stairs',
  grid: 'grids',
}

/** Short tags used in `FocusBlockers.key`. */
const KEY_TAG: Readonly<Record<IdKind, string>> = {
  images: 'i',
  polygons: 'p',
  circles: 'c',
  lines: 'l',
  stairs: 's',
  grids: 'g',
}

interface MutableBlockers {
  images: Set<number>
  polygons: Set<number>
  circles: Set<number>
  lines: Set<number>
  stairs: Set<number>
  grids: Set<number>
  gridCells: Set<string>
  pierce: Record<IdKind, Map<number, FocusDiscs>>
}

function emptyMutable(): MutableBlockers {
  return {
    images: new Set(),
    polygons: new Set(),
    circles: new Set(),
    lines: new Set(),
    stairs: new Set(),
    grids: new Set(),
    gridCells: new Set(),
    pierce: { images: new Map(), polygons: new Map(), circles: new Map(), lines: new Map(), stairs: new Map(), grids: new Map() },
  }
}

/** Adds the prism's id (and cell) to `into`; returns its kind and id, or null for a key it doesn't track. */
function addPrismKey(into: MutableBlockers, prismKey: string): { kind: IdKind; id: number } | null {
  const parts = prismKey.split(':')
  const kind = KIND_OF_PREFIX[parts[0]]
  if (!kind || parts.length < 2) return null
  const id = Number(parts[1])
  if (!Number.isFinite(id)) return null
  into[kind].add(id)
  if (kind === 'grids' && parts.length === 5) into.gridCells.add(`${id}:${parts[2]}:${parts[3]}:${parts[4]}`)
  return { kind, id }
}

function discsKey(discs: FocusDiscs): string {
  return discs.map((d) => `${d[0].toFixed(5)},${d[1].toFixed(5)}`).join(';')
}

function keyOf(b: Omit<FocusBlockers, 'key'>): string {
  const segs: string[] = []
  for (const kind of ID_KINDS) {
    const set = b[kind]
    if (set.size > 0) segs.push(`${KEY_TAG[kind]}:${[...set].sort((x, y) => x - y).join(',')}`)
  }
  if (b.gridCells.size > 0) segs.push(`gc:${[...b.gridCells].sort().join(',')}`)
  for (const kind of ID_KINDS) {
    const discs = b.pierce[kind]
    if (discs.size === 0) continue
    const ids = [...discs.keys()].sort((x, y) => x - y)
    segs.push(`x${KEY_TAG[kind]}:${ids.map((id) => `${id}=${discsKey(discs.get(id)!)}`).join('/')}`)
  }
  return segs.join('|')
}

/** Freeze a mutable set bag into a FocusBlockers (NO_BLOCKERS when empty). */
function finish(m: MutableBlockers): FocusBlockers {
  const key = keyOf(m)
  if (key === '') return NO_BLOCKERS
  return { key, ...m }
}

/**
 * Collects one blocker's disc centres in Mercator while sampling:
 * de-duplicated within `minD` (Mercator units), capped at
 * MAX_DISCS_PER_BLOCKER.
 */
function addDisc(list: [number, number][], x: number, y: number, minD: number): void {
  if (list.length >= MAX_DISCS_PER_BLOCKER || !Number.isFinite(x) || !Number.isFinite(y)) return
  const min2 = minD * minD
  for (const d of list) {
    const dx = d[0] - x
    const dy = d[1] - y
    if (dx * dx + dy * dy <= min2) return
  }
  list.push([x, y])
}

export function computeFocusBlockers(
  camera: { x: number; y: number; z: number },
  resolved: ResolvedFocus,
  prisms: ReadonlyArray<OccluderPrism>,
): FocusBlockers {
  if (prisms.length === 0 || resolved.samples.length === 0) return NO_BLOCKERS
  if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y) || !Number.isFinite(camera.z)) return NO_BLOCKERS
  const index = occluderIndexFor(prisms)
  const out = emptyMutable()
  // Disc centres in Mercator per (kind, id), in sampling order.
  const centres: Record<IdKind, Map<number, [number, number][]>> = {
    images: new Map(),
    polygons: new Map(),
    circles: new Map(),
    lines: new Map(),
    stairs: new Map(),
    grids: new Map(),
  }
  const anchor = mapboxgl.MercatorCoordinate.fromLngLat([resolved.position[0], resolved.position[1]], 0)
  const half = (FOCUS_NEAR_RADIUS_M / 2) * anchor.meterInMercatorCoordinateUnits()
  const hits: OccluderPrism[] = []
  let any = false
  for (const s of resolved.samples) {
    const alt = Math.max(0, s.elevationM ?? 0)
    const p = mapboxgl.MercatorCoordinate.fromLngLat([s.position[0], s.position[1]], alt)
    hits.length = 0
    collectOccluders(index, camera.x, camera.y, camera.z, p.x, p.y, p.z, alt, s.floorPlanId, hits)
    for (const prism of hits) {
      if (isOwnPrismKey(resolved, prism.key)) continue
      const at = addPrismKey(out, prism.key)
      if (!at) continue
      any = true
      const span = prismPierceSpan(prism, camera.x, camera.y, camera.z, p.x, p.y, p.z)
      if (!span) continue
      const byId = centres[at.kind]
      let list = byId.get(at.id)
      if (!list) {
        list = []
        byId.set(at.id, list)
      }
      addDisc(list, span[0], span[1], half)
      const dx = span[2] - span[0]
      const dy = span[3] - span[1]
      if (dx * dx + dy * dy > half * half) addDisc(list, span[2], span[3], half)
    }
  }
  if (!any) return NO_BLOCKERS
  for (const kind of ID_KINDS) {
    for (const [id, list] of centres[kind]) {
      if (list.length === 0) continue
      out.pierce[kind].set(
        id,
        Object.freeze(
          list.map(([x, y]) => {
            const ll = new mapboxgl.MercatorCoordinate(x, y, 0).toLngLat()
            return Object.freeze([ll.lng, ll.lat] as const)
          }),
        ),
      )
    }
  }
  return finish(out)
}

/**
 * Ids of both. An id already in `a` keeps a's discs (so a mid-move pass
 * never moves a published cut-away); an id new in `b` brings b's.
 */
function union(a: FocusBlockers, b: FocusBlockers): FocusBlockers {
  if (b.key === '' || a.key === b.key) return a
  if (a.key === '') return b
  const m = emptyMutable()
  const aPierce = a.pierce ?? NO_PIERCE
  const bPierce = b.pierce ?? NO_PIERCE
  for (const kind of ID_KINDS) {
    for (const id of a[kind]) m[kind].add(id)
    for (const [id, discs] of aPierce[kind]) m.pierce[kind].set(id, discs)
    for (const id of b[kind]) {
      if (a[kind].has(id)) continue
      m[kind].add(id)
      const discs = bPierce[kind].get(id)
      if (discs) m.pierce[kind].set(id, discs)
    }
  }
  for (const c of a.gridCells) m.gridCells.add(c)
  for (const c of b.gridCells) m.gridCells.add(c)
  return finish(m)
}

function sameDiscs(a: FocusDiscs, b: FocusDiscs): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false
  return true
}

function samePierce(a: ReadonlyMap<number, FocusDiscs>, b: ReadonlyMap<number, FocusDiscs>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [id, discs] of a) {
    const other = b.get(id)
    if (!other || !sameDiscs(discs, other)) return false
  }
  return true
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/** `next` with every Set / pierce Map whose content equals `prev`'s replaced by `prev`'s object. */
function reuseSets(prev: FocusBlockers, next: FocusBlockers): FocusBlockers {
  if (next === NO_BLOCKERS || next.key === '') return NO_BLOCKERS
  const pp = prev.pierce ?? NO_PIERCE
  const np = next.pierce ?? NO_PIERCE
  const pierce = {
    images: samePierce(pp.images, np.images) ? pp.images : np.images,
    polygons: samePierce(pp.polygons, np.polygons) ? pp.polygons : np.polygons,
    circles: samePierce(pp.circles, np.circles) ? pp.circles : np.circles,
    lines: samePierce(pp.lines, np.lines) ? pp.lines : np.lines,
    stairs: samePierce(pp.stairs, np.stairs) ? pp.stairs : np.stairs,
    grids: samePierce(pp.grids, np.grids) ? pp.grids : np.grids,
  }
  const samePierceRecord = ID_KINDS.every((k) => pierce[k] === pp[k])
  return {
    pierce: samePierceRecord ? pp : pierce,
    key: next.key,
    images: sameSet(prev.images, next.images) ? prev.images : next.images,
    polygons: sameSet(prev.polygons, next.polygons) ? prev.polygons : next.polygons,
    circles: sameSet(prev.circles, next.circles) ? prev.circles : next.circles,
    lines: sameSet(prev.lines, next.lines) ? prev.lines : next.lines,
    stairs: sameSet(prev.stairs, next.stairs) ? prev.stairs : next.stairs,
    grids: sameSet(prev.grids, next.grids) ? prev.grids : next.grids,
    gridCells: sameSet(prev.gridCells, next.gridCells) ? prev.gridCells : next.gridCells,
  }
}

const MOVE_THROTTLE_MS = 250

/** Published blockers, tagged with the focus key they were computed for. */
interface Published {
  key: string
  blockers: FocusBlockers
}

const NOTHING_PUBLISHED: Published = { key: '', blockers: NO_BLOCKERS }

/**
 * Host hook. Key change → compute (seeded by flyToFocus's planned camera
 * when one exists for this key); 'move' throttled 250 ms → additions only;
 * 'moveend' → exact; resolved geometry change of the same key → throttled
 * recompute. setState only on change; per-kind Set identity kept when
 * unchanged. NO_BLOCKERS when resolved is null or prisms empty.
 *
 * `prisms` is the host's `buildOccluders(...)` list over the same arrays
 * as its marker overlay's occluder bag (shared index), NOT gated on the
 * markerOcclusion toggle.
 */
export function useTrackFocusBlockers(
  map: MapboxMapInstance | null,
  resolved: ResolvedFocus | null,
  prisms: ReadonlyArray<OccluderPrism>,
): FocusBlockers {
  const [published, setPublished] = useState<Published>(NOTHING_PUBLISHED)
  const key = resolved?.key ?? ''

  // Latest inputs for the listeners below (which live per map + key).
  const inputsRef = useRef<{ resolved: ResolvedFocus | null; prisms: ReadonlyArray<OccluderPrism> }>({
    resolved,
    prisms,
  })
  /** Set by the tracker effect: recompute after a same-key input change. */
  const refreshRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    inputsRef.current = { resolved, prisms }
  }, [resolved, prisms])

  useEffect(() => {
    if (!map || key === '') return
    let current: FocusBlockers = NO_BLOCKERS
    let usedResolved: ResolvedFocus | null = null
    let usedPrisms: ReadonlyArray<OccluderPrism> | null = null
    let seededPlan: FocusCameraPlan | null = null
    let disposed = false
    // The first publish for a key always lands, even when empty: the state
    // may still hold this key's set from an earlier focus of the same item.
    let first = true

    const publish = (next: FocusBlockers) => {
      if (disposed || (!first && next.key === current.key)) return
      first = false
      current = reuseSets(current, next)
      setPublished({ key, blockers: current })
    }
    /** Exact set from `camera` (default: the live camera) for the latest inputs. */
    const computeAt = (camera?: { x: number; y: number; z: number }): FocusBlockers => {
      const { resolved: r, prisms: pr } = inputsRef.current
      usedResolved = r
      usedPrisms = pr
      if (!r || r.key !== key || pr.length === 0) return NO_BLOCKERS
      const cam = camera ?? map.getFreeCameraOptions().position
      if (!cam) return NO_BLOCKERS
      return computeFocusBlockers(cam, r, pr)
    }
    /** Union in the blockers at the destination of a focus flight planned for this key. */
    const seedFromPlan = (base: FocusBlockers): FocusBlockers => {
      const last = lastFocusCameraPlan(map)
      if (!last || last.key !== key || last.plan === seededPlan) return base
      seededPlan = last.plan
      return union(base, computeAt(last.plan.position))
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    let lastRun = 0
    let pendingExact = false
    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    const run = () => {
      timer = null
      lastRun = performance.now()
      if (pendingExact) {
        pendingExact = false
        publish(computeAt())
      } else {
        publish(union(current, computeAt()))
      }
    }
    const throttle = () => {
      if (timer !== null) return
      const wait = MOVE_THROTTLE_MS - (performance.now() - lastRun)
      if (wait <= 0) run()
      else timer = setTimeout(run, wait)
    }

    const onMoveStart = () => publish(seedFromPlan(current))
    // Show immediately: mid-move passes only ever ADD blockers.
    const onMove = () => throttle()
    // Hide late: the exact set once the camera settles. The throttle
    // restarts, so the first `move` of the next motion computes at once.
    const onMoveEnd = () => {
      clearTimer()
      pendingExact = false
      lastRun = 0
      publish(computeAt())
    }

    refreshRef.current = () => {
      const { resolved: r, prisms: pr } = inputsRef.current
      if (r === usedResolved && pr === usedPrisms) return
      // Nothing was computable before (dl anchor pending, prisms empty):
      // no reason to wait.
      if (!usedResolved || !usedPrisms || usedPrisms.length === 0) {
        publish(seedFromPlan(computeAt()))
        return
      }
      pendingExact = true
      throttle()
    }

    publish(seedFromPlan(computeAt()))
    map.on('movestart', onMoveStart)
    map.on('move', onMove)
    map.on('moveend', onMoveEnd)
    return () => {
      disposed = true
      clearTimer()
      refreshRef.current = null
      map.off('movestart', onMoveStart)
      map.off('move', onMove)
      map.off('moveend', onMoveEnd)
    }
  }, [map, key])

  useEffect(() => {
    refreshRef.current?.()
  }, [resolved, prisms])

  if (!map || !resolved || prisms.length === 0 || published.key !== key) return NO_BLOCKERS
  return published.blockers
}
