/**
 * The editor's upload library — what this workspace already uploaded, so
 * "Add floor plan", "Add image plane" and "Add 3D model" reuse a file
 * instead of uploading it again (`GET /library/images|models`, backend
 * `handlers/library.go`).
 *
 * Every upload belongs to the workspace and remembers the facility it was
 * uploaded in. Pickers open on "This facility" (uploaded here or used
 * here) with "Whole workspace" one click away — never other workspaces.
 */

import { apiGet } from './api-client'
import { useCurrentTenantId } from './data-link/tenant-service'
import { queryCache, useApiQuery } from './useApiQuery'
import { rewriteFilesUrlSameOrigin } from './binary-store'

export interface LibraryUse {
  /** null = a row not assigned to any facility. */
  zoneId: number | null
  kind: 'floorplan' | 'plane' | 'model'
  count: number
}

export interface LibraryImage {
  key: string
  /** Relative `/files/<key>`. */
  url: string
  name: string
  size: number
  mimeType: string
  /** 0 when no row has measured it yet. */
  naturalWidth: number
  naturalHeight: number
  uploadedAt?: string
  uploadedZoneId: number | null
  uses: LibraryUse[]
}

export interface LibraryModel {
  /** Oldest catalog row — the id new placements reference (`user_<id>`). */
  id: number
  /** Every catalog row that points at the same file. */
  ids: number[]
  name: string
  modelUrl: string
  bytes: number
  thumbnail?: string
  uploadedAt: string
  uploadedZoneId: number | null
  uses: LibraryUse[]
}

export type LibraryScope = 'facility' | 'workspace'

interface Scoped {
  uploadedZoneId: number | null
  uses: LibraryUse[]
}

/** Uploaded in this facility, or used by a shape in it. */
export function inFacility(item: Scoped, zoneId: number | null | undefined): boolean {
  if (zoneId == null) return false
  return item.uploadedZoneId === zoneId || item.uses.some((u) => u.zoneId === zoneId)
}

/** Facilities (other than none) that use the item, most uses first. */
export function usedInZones(item: Scoped): number[] {
  const seen = new Set<number>()
  for (const u of item.uses) if (u.zoneId != null) seen.add(u.zoneId)
  return [...seen]
}

const LIBRARY_KEY = 'uploadLibrary'

export function useImageLibrary(enabled = true) {
  const tenantId = useCurrentTenantId()
  return useApiQuery<LibraryImage[]>(() => apiGet<LibraryImage[]>('/library/images'), [LIBRARY_KEY, 'images', tenantId], {
    intervalMs: 0,
    enabled,
  })
}

export function useModelLibrary(enabled = true) {
  const tenantId = useCurrentTenantId()
  return useApiQuery<LibraryModel[]>(() => apiGet<LibraryModel[]>('/library/models'), [LIBRARY_KEY, 'models', tenantId], {
    intervalMs: 0,
    enabled,
  })
}

/** Refetch both lists — call after an upload, a placement or a delete. */
export function invalidateUploadLibrary(): void {
  queryCache.invalidate(LIBRARY_KEY)
}

/** Pixel size of an image URL, for library files no row has measured. */
export function measureImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('image failed to load'))
    img.src = rewriteFilesUrlSameOrigin(url)
  })
}

// ---- Model thumbnails ------------------------------------------------------

const THUMB_PX = 256

let modelViewerReady: Promise<unknown> | null = null
function loadModelViewer() {
  modelViewerReady ??= import('@google/model-viewer')
  return modelViewerReady
}

interface ModelViewerElement extends HTMLElement {
  toBlob(opts?: { mimeType?: string; qualityArgument?: number; idealAspect?: boolean }): Promise<Blob>
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Render a GLB to a small transparent WebP data URL in the browser, using
 * the `<model-viewer>` element the app already ships (it hosts its own
 * three.js scene). One render at a time: every viewer is a WebGL context
 * and browsers cap them at ~16. Resolves null when the model can't load.
 */
export function renderModelThumbnail(url: string, orientation?: string): Promise<string | null> {
  const job = queue.then(() => renderOne(url, orientation)).catch(() => null)
  queue = job
  return job
}

async function renderOne(url: string, orientation?: string): Promise<string | null> {
  await loadModelViewer()
  const host = document.createElement('div')
  // On screen (model-viewer only renders when intersecting) but invisible.
  host.style.cssText = `position:fixed;inset-inline-end:0;bottom:0;width:${THUMB_PX}px;height:${THUMB_PX}px;opacity:0;pointer-events:none;z-index:-1`
  host.setAttribute('aria-hidden', 'true')
  const el = document.createElement('model-viewer') as ModelViewerElement
  el.setAttribute('src', rewriteFilesUrlSameOrigin(url))
  if (orientation) el.setAttribute('orientation', orientation)
  el.setAttribute('camera-orbit', '35deg 70deg auto')
  el.setAttribute('camera-target', 'auto auto auto')
  el.setAttribute('interpolation-decay', '1')
  el.setAttribute('environment-image', 'neutral')
  el.setAttribute('shadow-intensity', '0')
  el.setAttribute('interaction-prompt', 'none')
  el.style.cssText = 'width:100%;height:100%;background:transparent'
  host.appendChild(el)
  document.body.appendChild(host)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('timeout')), 20000)
      el.addEventListener('load', () => { window.clearTimeout(timer); resolve() }, { once: true })
      el.addEventListener('error', () => { window.clearTimeout(timer); reject(new Error('load failed')) }, { once: true })
    })
    // 'load' fires before textures finish and before the camera settles on
    // the framed bounds — capture too early and a model comes out blank or
    // cropped. Let it settle, snap the camera to its goal, then capture.
    await (el as unknown as { updateComplete?: Promise<unknown> }).updateComplete
    await new Promise((r) => setTimeout(r, 700))
    ;(el as unknown as { jumpCameraToGoal?: () => void }).jumpCameraToGoal?.()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    // The first viewer on a page sometimes captures an empty frame (the
    // environment map isn't ready yet) — retry rather than store a blank.
    for (let attempt = 0; attempt < 4; attempt++) {
      const blob = await el.toBlob({ mimeType: 'image/png', idealAspect: false })
      const out = await scaleToDataUrl(blob, THUMB_PX)
      if (out) return out
      await new Promise((r) => setTimeout(r, 600))
    }
    return null
  } catch {
    return null
  } finally {
    host.remove()
  }
}

/** Null when the capture is (nearly) empty. */
async function scaleToDataUrl(blob: Blob, size: number): Promise<string | null> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  const s = Math.min(size / bitmap.width, size / bitmap.height)
  const w = bitmap.width * s
  const h = bitmap.height * s
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
  bitmap.close()
  const alpha = ctx.getImageData(0, 0, size, size).data
  let drawn = 0
  for (let i = 3; i < alpha.length; i += 4) if (alpha[i] > 8) drawn++
  if (drawn < size * size * 0.004) return null
  return canvas.toDataURL('image/webp', 0.82)
}
