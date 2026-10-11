import { apiDelete, apiGet, ApiError } from './api-client'
import { rewriteFilesUrlSameOrigin } from './binary-store'

/** Compact warehouse reference used on {@link FileReference.usedInZones}. */
export interface ZoneRef {
  id: number
  name: string
}

/** One DB row referencing a stored file — one entry per row, so the
 *  parent card's `referencedBy` list can have multiple entries.
 *
 *  `zoneId` / `zoneName` are set for shape kinds bound to a warehouse
 *  (image, image_plane). `usedInZones` is set only for user_model
 *  catalog entries — one entry per warehouse where the catalog has at
 *  least one placement, so a single GLB placed in multiple warehouses
 *  surfaces under each. Avatars are intentionally NOT in the response
 *  (personal profile data, not warehouse assets). */
export interface FileReference {
  kind: 'image' | 'image_plane' | 'user_model'
  id: number
  name: string
  zoneId?: number
  zoneName?: string
  isGhost: boolean
  usedInZones?: ZoneRef[]
}

/** Categories mirror the backend classifier in
 *  `internal/handlers/files.go::categorizeFile`. */
export type FileCategory = 'attached' | 'ghost' | 'orphan' | 'missing'

/** Filter bucket, classified server-side (`files.go::fileType`). */
export type FileType = 'floorplan' | 'plane' | 'model' | 'image' | 'other'

export interface FileCard {
  key: string
  /** Same-origin URL. Wrap with `rewriteFilesUrlSameOrigin` (already
   *  applied in {@link listFiles}) before rendering to survive legacy
   *  absolute-host URLs. */
  url: string
  size: number
  contentType: string
  /** ISO 8601 UTC, or empty string when the file is missing from the
   *  bucket but still referenced from the DB (category === 'missing'). */
  uploadedAt: string
  category: FileCategory
  type: FileType
  referencedBy: FileReference[]
}

export type FileStatusFilter = 'all' | 'inUse' | 'cleanup' | 'missing'
export type FileSort = 'newest' | 'oldest' | 'largest' | 'name'

export interface FilesQuery {
  status?: FileStatusFilter
  type?: FileType
  facility?: number
  q?: string
  sort?: FileSort
  /** Rows to skip — "Load more" asks for the rows after those it holds. */
  offset?: number
  pageSize?: number
}

/** Whole-workspace totals, independent of every filter. */
export interface FilesStats {
  files: number
  bytes: number
  inUse: number
  inUseBytes: number
  cleanup: number
  cleanupBytes: number
  leftovers: number
  missing: number
  models: number
  facilities: number
}

export interface FilesPage {
  rows: FileCard[]
  /** Rows matching every filter (not just this page). */
  total: number
  page: number
  pageSize: number
  stats: FilesStats
  /** Each status tab's count under the current facility / search / type. */
  statusCounts: Partial<Record<FileStatusFilter, number>>
  /** Each type's count under the current facility / search / status. */
  typeCounts: Partial<Record<FileType, number>>
  /** Every facility the workspace's files appear on. */
  facilities: { id: number; name: string; count: number }[]
}

/** One page of this workspace's files — the ones it uploaded or uses,
 *  never another workspace's. Owner/admin only; others get 403. */
export async function listFiles(query: FilesQuery = {}): Promise<FilesPage> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '' && v !== 'all') params.set(k, String(v))
  }
  const qs = params.toString()
  const page = await apiGet<FilesPage>(`/files${qs ? `?${qs}` : ''}`)
  return { ...page, rows: page.rows.map((c) => ({ ...c, url: rewriteFilesUrlSameOrigin(c.url) })) }
}

/** Delete a file. Returns void on success. Throws {@link ApiError} on
 *  409 when the file is attached to a live warehouse, 404 when it isn't
 *  this workspace's. */
export async function deleteFile(key: string): Promise<void> {
  // Encode the key so slashes and special chars survive the URL —
  // matches the backend's chi.URLParam("key") which handles the raw value.
  const encoded = encodeURIComponent(key)
  await apiDelete<void>(`/files/${encoded}`)
}

export { ApiError }
