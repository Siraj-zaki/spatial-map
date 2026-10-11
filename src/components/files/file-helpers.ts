/**
 * Shared vocabulary for the Files screen: what a file is (type), whether
 * it's safe to remove (status), where it's used, and how to show its name
 * and size. Pure functions — the route, card, list row and detail panel
 * all read from here so the four surfaces never disagree.
 */

import type { TFunction } from 'i18next'
import type { FileCard, FileCategory, FileReference, FileType } from '@/lib/files-client'

export type { FileType }
export const FILE_TYPES: FileType[] = ['floorplan', 'plane', 'model', 'image', 'other']

export function isImage(file: Pick<FileCard, 'contentType'>): boolean {
  return file.contentType.startsWith('image/')
}

export function isModel(file: Pick<FileCard, 'contentType' | 'key'>): boolean {
  return (
    file.contentType === 'model/gltf-binary' ||
    file.contentType === 'model/gltf+json' ||
    /\.(glb|gltf)$/i.test(file.key)
  )
}

/** What the file is, for the type filter. Classified server-side (the
 *  filter runs there); the fallback mirrors `files.go::fileType` — the
 *  reference kind wins, unreferenced files use their content type. */
export function fileType(file: FileCard): FileType {
  if (file.type) return file.type
  const kinds = new Set((file.referencedBy ?? []).map((r) => r.kind))
  if (kinds.has('image')) return 'floorplan'
  if (kinds.has('image_plane')) return 'plane'
  if (kinds.has('user_model') || isModel(file)) return 'model'
  if (isImage(file)) return 'image'
  return 'other'
}

export function fileTypeLabel(type: FileType, t: TFunction): string {
  switch (type) {
    case 'floorplan':
      return t('files.type.floorplan', { defaultValue: 'Floor plan' })
    case 'plane':
      return t('files.type.plane', { defaultValue: 'Image plane' })
    case 'model':
      return t('files.type.model', { defaultValue: '3D model' })
    case 'image':
      return t('files.type.image', { defaultValue: 'Image' })
    case 'other':
      return t('files.type.other', { defaultValue: 'Other' })
  }
}

/**
 * Plain-language status. The backend's categories are storage jargon
 * (attached / ghost / orphan); the screen says what each means for the
 * person deciding whether to delete.
 */
export function statusLabel(category: FileCategory, t: TFunction): string {
  switch (category) {
    case 'attached':
      return t('files.status.inUse', { defaultValue: 'In use' })
    case 'ghost':
      return t('files.status.leftover', { defaultValue: 'Leftover' })
    case 'orphan':
      return t('files.status.unused', { defaultValue: 'Unused' })
    case 'missing':
      return t('files.status.missing', { defaultValue: 'Missing' })
  }
}

export function statusExplainer(category: FileCategory, t: TFunction): string {
  switch (category) {
    case 'attached':
      return t('files.status.inUseBody', { defaultValue: 'Shown on at least one facility. Remove it there before deleting the file.' })
    case 'ghost':
      return t('files.status.leftoverBody', {
        defaultValue: 'Belongs to a shape or catalog model that’s no longer on any facility. Deleting removes those leftovers too.',
      })
    case 'orphan':
      return t('files.status.unusedBody', { defaultValue: 'Nothing points to this file. Deleting it frees the space and can’t break anything.' })
    case 'missing':
      return t('files.status.missingBody', {
        defaultValue: 'A facility points to this file but it’s no longer in storage, so it shows as blank. Upload it again from the facility.',
      })
  }
}

export function statusVariant(category: FileCategory): 'success' | 'warning' | 'info' | 'danger' {
  switch (category) {
    case 'attached':
      return 'success'
    case 'ghost':
      return 'warning'
    case 'orphan':
      return 'info'
    case 'missing':
      return 'danger'
  }
}

/** Leftovers and unused files are the only ones the API will delete. */
export function canDelete(file: FileCard): boolean {
  return file.category === 'ghost' || file.category === 'orphan'
}

/**
 * Storage keys are `{name}-{sha256[:12]…}.{ext}` (content-addressed).
 * Show the human part — the full key stays in the tooltip and on download.
 */
export function displayFileName(key: string): string {
  const m = key.match(/^(.*?)(?:-[0-9a-f]{12,})+(\.[a-z0-9]+)$/i)
  return m ? `${m[1]}${m[2]}` : key
}

export function formatBytes(bytes: number, locale: string): string {
  if (!bytes) return '—'
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[i],
    // 'narrow' for bytes: short renders "157 byte" in English.
    unitDisplay: i === 0 ? 'narrow' : 'short',
    maximumFractionDigits: i >= 2 ? 1 : 0,
  }).format(v)
}

export interface FacilityRef {
  id: number
  name: string
}

/** Facilities a file appears on: the zone of an image / image plane, or
 *  every zone a catalog model is placed in. Deduped, in reference order. */
export function facilitiesOf(file: FileCard): FacilityRef[] {
  const seen = new Map<number, string>()
  for (const r of file.referencedBy ?? []) {
    if (r.zoneId != null && !seen.has(r.zoneId)) seen.set(r.zoneId, r.zoneName || `#${r.zoneId}`)
    for (const z of r.usedInZones ?? []) if (!seen.has(z.id)) seen.set(z.id, z.name || `#${z.id}`)
  }
  return [...seen].map(([id, name]) => ({ id, name }))
}

/** One line under the file name saying where it lives. */
export function usageLine(file: FileCard, t: TFunction): string {
  const facilities = facilitiesOf(file)
  if (file.category === 'orphan') return t('files.usage.none', { defaultValue: 'Not used anywhere' })
  if (file.category === 'ghost') {
    const first = (file.referencedBy ?? [])[0]
    return first
      ? t('files.usage.leftoverOf', { defaultValue: 'Left over from “{{name}}”', name: first.name })
      : t('files.usage.leftover', { defaultValue: 'Left over from a deleted shape' })
  }
  if (facilities.length === 0) return t('files.usage.catalog', { defaultValue: 'In the 3D model catalog' })
  if (facilities.length === 1) return facilities[0].name
  return t('files.usage.many', {
    defaultValue: '{{first}} and {{count}} more',
    first: facilities[0].name,
    count: facilities.length - 1,
  })
}

export function referenceKindLabel(kind: FileReference['kind'], t: TFunction): string {
  switch (kind) {
    case 'image':
      return t('files.type.floorplan', { defaultValue: 'Floor plan' })
    case 'image_plane':
      return t('files.type.plane', { defaultValue: 'Image plane' })
    case 'user_model':
      return t('files.type.model', { defaultValue: '3D model' })
  }
}

export function fileMatchesQuery(file: FileCard, q: string): boolean {
  if (!q) return true
  if (file.key.toLowerCase().includes(q)) return true
  return (file.referencedBy ?? []).some(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      (r.zoneName ?? '').toLowerCase().includes(q) ||
      (r.usedInZones ?? []).some((z) => z.name.toLowerCase().includes(q)),
  )
}
