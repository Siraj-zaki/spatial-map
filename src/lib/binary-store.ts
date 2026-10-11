/**
 * Binary asset bridge.
 *
 * Uploads images and 3D models to the backend object store and returns
 * the persisted URL. The SPA then stores the URL on the catalog row
 * (`imageUrl` / `modelUrl`) instead of inline base64/Blob data.
 *
 * Legacy rows that still carry inline `imageData` or `data` are served
 * from those inline payloads until a save rewrites them with a URL.
 */

import { apiPost } from './api-client'
import type { UserModel } from './db'
import type { ImageShape } from './shapes'

export interface ImageUploadResult {
  url: string
  mimeType: string
  naturalWidth: number
  naturalHeight: number
  bytes: number
}

export interface ModelUploadResult {
  url: string
  mimeType: string
  bytes: number
}

/**
 * Upload an image file to the backend object store.
 * The caller is responsible for reading dimensions if needed beforehand;
 * the backend also returns them when it can decode the file header.
 */
export async function uploadImage(file: File, zoneId?: number | null): Promise<ImageUploadResult> {
  return apiPost<ImageUploadResult>('/images/upload', uploadForm(file, zoneId))
}

/** Upload a glTF/GLB model file to the backend object store. */
export async function uploadModel(file: File, zoneId?: number | null): Promise<ModelUploadResult> {
  return apiPost<ModelUploadResult>('/user-models/upload', uploadForm(file, zoneId))
}

/** `zoneId` records the facility it was uploaded in — the upload library
 *  (`upload-library.ts`) offers it there first, and across the workspace. */
function uploadForm(file: File, zoneId?: number | null): FormData {
  const form = new FormData()
  form.append('file', file, file.name)
  if (zoneId != null && zoneId > 0) form.append('zoneId', String(zoneId))
  return form
}

/**
 * Strip an absolute `http(s)://host[:port]` prefix off a backend file
 * URL so the browser loads it same-origin instead.
 *
 * Why: the backend used to default `SGV_STORAGE.BASE_URL` to
 * `http://localhost:8080/files`, so every uploaded image / model
 * row in the DB has its full URL baked in starting with that host.
 * Once the SPA is opened from another LAN machine, that absolute URL
 * resolves against THAT machine's localhost — there's no backend
 * there, so the asset never loads. Rewriting it to `/files/<key>`
 * routes the request through whichever host served the SPA, which
 * the dev-server proxy then forwards to the backend.
 *
 * The default has since been changed to the relative form
 * (`/files`) so new uploads don't hit this, but existing rows still
 * carry the absolute prefix and need this rewrite at read time.
 */
export function rewriteFilesUrlSameOrigin(url: string): string {
  if (!url) return url
  // Leave data URLs and protocol-relative URLs alone.
  if (url.startsWith('data:')) return url
  if (url.startsWith('blob:')) return url
  if (url.startsWith('//')) return url
  // Already relative — nothing to do.
  if (!/^https?:\/\//i.test(url)) return url
  // Only rewrite `…/files/…` paths so we don't accidentally hijack
  // unrelated absolute URLs the user might have linked externally.
  const filesIdx = url.indexOf('/files/')
  if (filesIdx === -1) return url
  return url.slice(filesIdx)
}

/** Resolve the renderable URL for an image shape. Legacy `imageData` wins if no URL exists yet. */
export function urlForImage(shape: ImageShape): string {
  if (shape.imageUrl) return rewriteFilesUrlSameOrigin(shape.imageUrl)
  const raw = shape.imageData
  if (!raw) return ''
  if (raw.startsWith('data:')) return raw
  // Backend legacy rows store the raw base64 payload without the data-URL prefix.
  return `data:${shape.mimeType || 'image/png'};base64,${raw}`
}

/** Resolve the renderable URL for a user model. Legacy inline data wins if no URL exists yet. */
export function urlForModel(row: UserModel): string {
  if (row.modelUrl) return rewriteFilesUrlSameOrigin(row.modelUrl)
  const blob = blobForModelData(row.data, row.mimeType)
  if (blob) return URL.createObjectURL(blob)
  return ''
}

function blobForModelData(data: Blob | string | undefined, mimeType: string): Blob | null {
  if (!data) return null
  if (data instanceof Blob) return data
  if (typeof data === 'string') {
    try {
      const bin = atob(data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i)
      }
      return new Blob([bytes], { type: mimeType || 'application/octet-stream' })
    } catch {
      return null
    }
  }
  return null
}

/**
 * True when the image shape is still carrying inline data rather than
 * an object-store URL. Used by migration flows to decide whether to upload.
 */
export function imageNeedsUpload(shape: ImageShape): boolean {
  return !shape.imageUrl && Boolean(shape.imageData)
}

/**
 * True when the user model is still carrying inline data rather than
 * an object-store URL.
 */
export function modelNeedsUpload(row: UserModel): boolean {
  return !row.modelUrl && row.data !== undefined
}

/** Convert a base64 / data-URL payload to a File for upload. */
export function fileFromImageData(shape: ImageShape): File | null {
  const raw = shape.imageData
  if (!raw) return null
  let base64 = raw
  let mime = shape.mimeType || 'image/png'
  if (raw.startsWith('data:')) {
    const idx = raw.indexOf(';base64,')
    if (idx !== -1) {
      mime = raw.slice(5, idx) || mime
      base64 = raw.slice(idx + 8)
    }
  }
  try {
    const bin = atob(base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: mime })
    return new File([blob], shape.name || 'image.png', { type: mime })
  } catch {
    return null
  }
}

/** Convert a base64 string or Blob to a File for model upload. */
export function fileFromModelData(row: UserModel): File | null {
  if (!row.data) return null
  let blob: Blob
  const name = row.name || 'model.glb'
  const mime = row.mimeType || 'application/octet-stream'
  if (row.data instanceof Blob) {
    blob = row.data
  } else if (typeof row.data === 'string') {
    try {
      const bin = atob(row.data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i)
      }
      blob = new Blob([bytes], { type: mime })
    } catch {
      return null
    }
  } else {
    return null
  }
  return new File([blob], name, { type: mime })
}
