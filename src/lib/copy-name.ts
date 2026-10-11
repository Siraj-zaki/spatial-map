import i18n from '@/i18n'
import { useSpatialStore, type CatalogEntity, type EntityKind } from '@/lib/spatial-store'

const STATE_KEY: Partial<Record<EntityKind, string>> = {
  'image-planes': 'imagePlanes',
  'text-labels': 'textLabels',
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The name for a duplicate: "Rack A" → "Rack A (copy)", and copying that
 * again → "Rack A (copy 2)" — never "Rack A (copy) (copy)". Any trailing
 * copy suffixes are stripped first, and the first number not already used
 * by a shape of the same kind wins.
 */
export function copyName(kind: EntityKind, name: string): string {
  const word = i18n.t('editor.copySuffix', { defaultValue: 'copy' })
  const suffix = `(?:${escapeRe(word)}|copy)`
  const trailing = new RegExp(`(?:\\s*\\(${suffix}(?:\\s+\\d+)?\\)|\\s+${suffix})+\\s*$`, 'i')
  const base = name.replace(trailing, '').trim() || name
  const rows = (useSpatialStore.getState() as unknown as Record<string, CatalogEntity[]>)[STATE_KEY[kind] ?? kind] ?? []
  const taken = new Set(rows.map((r) => (r as { name?: string }).name))
  let candidate = `${base} (${word})`
  for (let n = 2; taken.has(candidate); n++) candidate = `${base} (${word} ${n})`
  return candidate
}
