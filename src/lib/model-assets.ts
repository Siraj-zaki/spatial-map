/**
 * Helpers that bridge the model asset catalogue with the live UI:
 *   - `useModelAssets()` — React hook that returns a unified
 *     `ModelAsset[]` covering bundled + user-uploaded assets.
 *   - `useModelUrlMap()` — same data, projected to `{ [id]: url }`
 *     for the map overlay's `urlMap` prop.
 *   - `useModelInspectorMap()` — `{ [id]: ModelInspector }` projection.
 *     Uploaded rows ship with an inspector (parsed at upload time);
 *     bundled assets are fetched + parsed lazily on first observation
 *     and cached in a module-level Map.
 *   - `addUploadedModel(file)` — uploads a glb/gltf File to the backend
 *     object store and persists the resulting URL in the user-models
 *     catalog.
 *   - `deleteUploadedModel(id)` — removes one user-uploaded asset.
 *
 * New uploads are stored by URL, not inline Blob. Legacy rows that still
 * carry a `data` Blob are served from a temporary object URL until the
 * M9 backfill migrates them.
 */

import { useEffect, useMemo, useState } from 'react'
import { BUNDLED_MODELS, type ModelAsset } from './model-catalog'
import { type UserModel } from './db'
import { apiDb } from './api-db'
import { apiDelete } from './api-client'
import { queryCache, useApiQuery } from './useApiQuery'
import { useCurrentTenantId } from './data-link/tenant-service'
import { reportShareToken, reportShareUserModels } from './reports/report-share'
import { uploadModel, urlForModel } from './binary-store'
import { invalidateUploadLibrary, renderModelThumbnail } from './upload-library'
import {
  parseGlbInspector,
  type ModelInspector,
} from './glb-bounds'

/** Session-cached object URL per userModel id (only for legacy Blob rows). */
const blobUrlCache = new Map<number, string>()

/**
 * Session-cached inspector per ModelAsset.id. Populated by
 * `useModelInspectorMap()` once a bundled asset has been fetched and
 * parsed; uploaded assets short-circuit via the row's `inspector` field.
 */
const inspectorCache = new Map<string, ModelInspector>()

// Session-wide notification hooks so `useModelBoundsMap` /
// `useModelBoundingCenterMap` re-render when the cache mutates
// (previously only `useModelInspectorMap`'s local `tick` counter did).
const inspectorCacheListeners = new Set<() => void >()
function subscribeInspectorCache(cb: () => void) {
  inspectorCacheListeners.add(cb)
  return () => inspectorCacheListeners.delete(cb)
}
function notifyInspectorCache() {
  inspectorCacheListeners.forEach((cb) => {
    try {
      cb()
    } catch {
      /* listener errors shouldn't break the fetch loop */
    }
  })
}
function useInspectorCacheTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const unsub = subscribeInspectorCache(() => setTick((t) => t + 1))
    return () => {
      unsub()
    }
  }, [])
  return tick
}

function urlForUploaded(row: UserModel): string {
  if (row.id !== undefined && blobUrlCache.has(row.id)) {
    return blobUrlCache.get(row.id)!
  }
  const url = urlForModel(row)
  if (row.id !== undefined && row.data) blobUrlCache.set(row.id, url)
  return url
}

function uploadedToAsset(row: UserModel): ModelAsset {
  return {
    id: `user_${row.id}`,
    label: row.name,
    source: 'uploaded',
    category: row.category ?? 'other',
    url: urlForUploaded(row),
    defaultScale: row.defaultScale ?? 1,
    defaultRotation: [0, 0, 0],
    boundingCenter: row.boundingCenter,
    inspector: row.inspector,
    attribution: 'Uploaded by user',
    thumbnail: row.thumbnail || undefined,
  }
}

/** Returns every available model asset (bundled + uploaded). */
export function useModelAssets(): ModelAsset[] {
  const tenantId = useCurrentTenantId()
  // A shared report's facility ships its models with the link.
  const shared = reportShareToken()
  const uploadedQuery = useApiQuery(
    () => (shared !== null ? Promise.resolve(reportShareUserModels()) : apiDb.userModels.toArray()),
    ['userModels', shared ?? tenantId],
    // Event-driven: fetch once per mount/invalidation, not on a timer.
    { intervalMs: 0 },
  )
  const uploaded = uploadedQuery.data ?? []
  return useMemo(() => {
    const sorted = [...uploaded].sort(
      (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
    )
    const u = sorted.map(uploadedToAsset)
    return [...u, ...BUNDLED_MODELS]
  }, [uploaded])
}

/** `{ [assetId]: url }` projection, ready for `MapModelOverlay.urlMap`. */
export function useModelUrlMap(): Record<string, string> {
  const assets = useModelAssets()
  return useMemo(() => {
    const out: Record<string, string> = {}
    for (const a of assets) out[a.id] = a.url
    return out
  }, [assets])
}

/**
 * `Map<assetId, boundingCenter>` projection, ready for
 * `MapModelOverlay.boundingCenterMap`. Only assets with a known centre
 * appear here — undefined entries simply don't get scale compensation.
 */
export function useModelBoundingCenterMap(): Map<string, [number, number, number]> {
  const assets = useModelAssets()
  const tick = useInspectorCacheTick()
  return useMemo(() => {
    const out = new Map<string, [number, number, number]>()
    for (const a of assets) {
      if (a.boundingCenter) {
        out.set(a.id, a.boundingCenter)
        continue
      }
      // Bundled assets that have already been fetched + parsed have their
      // inspector cached; read the bounds centre from there so models
      // whose mesh sits far from origin (e.g. Forklift (rigged), whose
      // bounds are offset ~193m in Z) render at their placement pin.
      const cached = inspectorCache.get(a.id)
      if (cached?.bounds?.center) out.set(a.id, cached.bounds.center)
    }
    return out
    // `tick` is the mutable-cache invalidation signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, tick])
}

/**
 * `Map<assetId, ModelBounds>` — full AABB (min + max + center) for
 * every asset whose GLB parse yielded it. Used by the map overlay's
 * `buildModelLayerPaint` to anchor the BOTTOM of the model at the
 * placement point instead of its centre, so scaling down doesn't
 * sink the model into the ground.
 *
 * Bundled assets carry bounds through their inspector.bounds; uploads
 * get it stamped at upload time (see `addUploadedModel`).
 */
export function useModelBoundsMap(): Map<
  string,
  { min: [number, number, number]; max: [number, number, number] }
> {
  const assets = useModelAssets()
  const tick = useInspectorCacheTick()
  return useMemo(() => {
    const out = new Map<
      string,
      { min: [number, number, number]; max: [number, number, number] }
    >()
    for (const a of assets) {
      // Same fallback chain as `useModelBoundingCenterMap`: prefer the
      // row's stamped inspector, then the lazily-populated cache. Without
      // the cache fallback, bundled assets like the Forklift never
      // supply bounds to `buildModelLayerPaint`, which then can't compute
      // the vertical anchor for off-origin meshes.
      const bounds = a.inspector?.bounds ?? inspectorCache.get(a.id)?.bounds
      if (bounds) out.set(a.id, { min: bounds.min, max: bounds.max })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, tick])
}

/**
 * `Map<assetId, ModelInspector>` projection. Three sources merged:
 *   - the row's stored `inspector` for uploaded assets,
 *   - the module-level `inspectorCache` for bundled assets we've already
 *     fetched + parsed,
 *   - background fetch-and-parse for any bundled asset that's IN
 *     `restrictTo` and hasn't been seen yet.
 *
 * `restrictTo` gates the background fetch to a specific set of asset
 * ids (usually the one asset the editor currently has selected). This
 * used to iterate every asset — bundled + uploaded — which meant
 * opening the editor triggered ~40 GET /public/models/…/scene.gltf
 * requests up front just to populate dropdowns nobody was looking at.
 * Passing the selected asset id (or ids) restricts the network work to
 * exactly what the UI needs.
 *
 * Pass `undefined` to preserve the legacy "fetch all" behaviour (kept
 * for any consumer that genuinely needs every inspector, though there
 * shouldn't be one).
 *
 * The hook re-renders the consumer each time a new bundled inspector
 * lands in cache so the dynamic editor light-up is smooth.
 */
export function useModelInspectorMap(
  restrictTo?: Iterable<string> | undefined,
): Map<string, ModelInspector> {
  const assets = useModelAssets()
  const [tick, setTick] = useState(0)

  // Stable key for the restriction set so the effect only re-runs when
  // the actual membership changes.
  const restrictKey = restrictTo
    ? Array.from(restrictTo).sort().join('|')
    : '*'

  useEffect(() => {
    let cancelled = false
    const restrictSet = restrictTo ? new Set(restrictTo) : null
    const missing = assets.filter((a) => {
      if (a.inspector) return false
      if (inspectorCache.has(a.id)) return false
      if (restrictSet && !restrictSet.has(a.id)) return false
      return true
    })
    if (missing.length === 0) return
    ;(async () => {
      for (const asset of missing) {
        try {
          const res = await fetch(asset.url)
          if (!res.ok) continue
          const blob = await res.blob()
          const ins = await parseGlbInspector(blob)
          if (!ins || cancelled) continue
          inspectorCache.set(asset.id, ins)
          notifyInspectorCache()
          if (!cancelled) setTick((t) => t + 1)
        } catch {
          /* network or parse failure — leave inspector unset; UI falls back to legacy controls */
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // `restrictKey` is the memoised membership signature; `restrictTo`
    // itself is excluded so a fresh iterable identity on every render
    // doesn't refire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, restrictKey])

  return useMemo(() => {
    const out = new Map<string, ModelInspector>()
    for (const a of assets) {
      const fromRow = a.inspector
      const fromCache = inspectorCache.get(a.id)
      const ins = fromRow ?? fromCache
      if (ins) out.set(a.id, ins)
    }
    return out
    // `tick` participates because `inspectorCache` is a mutable side-channel.
  }, [assets, tick])
}

/** Lookup a single asset by id (bundled or uploaded). */
export function findAssetInList(
  assets: ReadonlyArray<ModelAsset>,
  id: string,
): ModelAsset | undefined {
  return assets.find((a) => a.id === id)
}

/**
 * Upload a glTF/GLB file to the backend object store and persist a
 * user-models catalog row that references the returned URL. Returns the
 * assigned row id.
 */
export async function addUploadedModel(
  file: File,
  opts?: { label?: string; category?: UserModel['category']; zoneId?: number | null },
): Promise<number> {
  // Best-effort: parse the GLB for both bounding-box centre (renderer
  // scale-anchor compensation) and the inspector schema (dynamic editor
  // controls). Parsing failure isn't fatal — the model still loads.
  let boundingCenter: [number, number, number] | undefined
  let inspector: ModelInspector | undefined
  try {
    const ins = await parseGlbInspector(file)
    if (ins) {
      inspector = ins
      if (ins.bounds) boundingCenter = ins.bounds.center
    }
  } catch (err) {
    console.warn('[addUploadedModel] inspector parse failed', err)
  }

  // Auto-normalize scale so `scale = 1` renders the model at a
  // reasonable warehouse-object size (~1 m in its longest dimension)
  // regardless of the GLB's intrinsic unit system. Some tools export
  // in metres (typical furniture GLB has extent 0.5–2 m — leave alone),
  // some in cm (extent 50–200 → renders 50–200 m tall in Mapbox,
  // covers a park), some in mm or inches, some at kilometre scale.
  //
  // Rule: if the model's max dimension is outside [0.2 m, 5 m], set
  // `defaultScale = 1 / maxDim` so `scale = 1` yields max dim = 1 m.
  // Models already in the sane range keep `defaultScale = 1` so the
  // user can still hand-tune from there.
  let defaultScale: number | undefined
  if (inspector?.bounds) {
    const { min, max } = inspector.bounds
    const dx = max[0] - min[0]
    const dy = max[1] - min[1]
    const dz = max[2] - min[2]
    const maxDim = Math.max(dx, dy, dz)
    if (maxDim > 0 && (maxDim < 0.2 || maxDim > 5)) {
      defaultScale = 1 / maxDim
    }
  }

  const upload = await uploadModel(file, opts?.zoneId)
  // Rendered from the stored file, so a thumbnail failure never blocks the upload.
  const thumbnail = (await renderModelThumbnail(upload.url)) ?? undefined

  const id = await apiDb.userModels.add({
    name: opts?.label ?? (file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || file.name),
    mimeType: upload.mimeType || guessMime(file.name),
    modelUrl: upload.url,
    bytes: upload.bytes,
    category: opts?.category,
    boundingCenter,
    defaultScale,
    inspector,
    zoneId: opts?.zoneId ?? undefined,
    thumbnail,
    createdAt: new Date(),
  })
  queryCache.invalidate('userModels')
  invalidateUploadLibrary()
  return id
}

/**
 * Give an uploaded model (from before thumbnails existed) its preview the
 * first time the library shows it. Every catalog row sharing the file gets
 * the same image. Best-effort; returns the data URL or null.
 */
const thumbnailsInFlight = new Map<string, Promise<string | null>>()
export function ensureModelThumbnail(ids: number[], modelUrl: string): Promise<string | null> {
  const existing = thumbnailsInFlight.get(modelUrl)
  if (existing) return existing
  const job = (async () => {
    const thumbnail = await renderModelThumbnail(modelUrl)
    if (!thumbnail) return null
    await Promise.all(ids.map((id) => apiDb.userModels.update(id, { thumbnail }).catch(() => undefined)))
    queryCache.invalidate('userModels')
    return thumbnail
  })()
  thumbnailsInFlight.set(modelUrl, job)
  return job
}

/**
 * No-op: M9 backfill has moved user models to the backend. Legacy IndexedDB
 * rows are no longer mutated; the function is kept so callers don't break.
 */
export async function backfillUserModelBounds(): Promise<void> {
  // Legacy backfill retired after M9.
}

/**
 * No-op: M9 backfill has moved user models to the backend. Legacy IndexedDB
 * rows are no longer mutated; the function is kept so callers don't break.
 */
export async function backfillUserModelInspectors(): Promise<void> {
  // Legacy backfill retired after M9.
}

/**
 * Remove a model from the workspace's library: every catalog row sharing
 * the file and — with `withPlacements` — every placement using it (the
 * backend refuses with 409 otherwise). The file goes once no row is left.
 */
export async function deleteLibraryModel(ids: number[], withPlacements: boolean): Promise<void> {
  for (const id of ids) {
    await apiDelete(`/user-models/${id}${withPlacements ? '?force=true' : ''}`)
  }
  if (withPlacements) queryCache.invalidate('models')
  queryCache.invalidate('userModels')
  invalidateUploadLibrary()
}

/** Rename every catalog row sharing one uploaded file. */
export async function renameLibraryModel(ids: number[], name: string): Promise<void> {
  await Promise.all(ids.map((id) => apiDb.userModels.update(id, { name })))
  queryCache.invalidate('userModels')
  invalidateUploadLibrary()
}

/** Delete an uploaded model. Revokes any cached legacy blob URL. */
export async function deleteUploadedModel(id: number): Promise<void> {
  await apiDb.userModels.delete(id)
  invalidateUploadLibrary()
  queryCache.invalidate('userModels')
  const url = blobUrlCache.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    blobUrlCache.delete(id)
  }
}

function guessMime(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.glb')) return 'model/gltf-binary'
  if (lower.endsWith('.gltf')) return 'model/gltf+json'
  return 'application/octet-stream'
}

