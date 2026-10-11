/**
 * Shared Lucide icon manifest.
 *
 * Runs ONCE at module load (~2ms) by walking `lucide-react`'s named
 * exports. Both the data-link editor's `LucideIconPicker` and the
 * marker sidebar picker resolve icons through this file so there's a
 * single source of truth for id → component mapping + the full icon
 * list. `import * as LucideAll` bundles every icon into the app —
 * that's intentional (~130 KB gzipped) so pickers can render any icon
 * synchronously with no code-split loading flash.
 *
 * Semantic search: `lucide-tags.json` (vendored from `lucide-static`)
 * maps each icon to its curated tags (`map-pin → [marker, pin,
 * location, ...]`), which we fold into each entry's search haystack so
 * users can find icons by concept, not just by name. ~50 KB gzipped in
 * the bundle; worth it for the UX.
 */

import type { ComponentType, SVGProps } from 'react'
import * as LucideAll from 'lucide-react'
import lucideTags from './lucide-tags.json'

export type LucideIconComponent = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>

export interface LucideIconEntry {
  /** Kebab-case id (`map-pin`, `alert-circle`). Persisted in config. */
  id: string
  /** PascalCase name matching the lucide-react export. */
  name: string
  /** Precomputed lowercase name for cheap search comparisons. */
  nameLower: string
  /** Semantic tags (`marker`, `pin`, ...). Empty for icons without curated tags. */
  tags: readonly string[]
  /**
   * Legacy combined haystack — id, name, and tag words joined with `\n`
   * so a substring can't span field boundaries. Retained for the
   * data-link picker's simple `hay.includes(q)` filter.
   */
  hay: string
  Component: LucideIconComponent
}

const TAGS_BY_ID = lucideTags as Record<string, readonly string[]>

/** Sentinel exports from lucide-react that AREN'T icon components. */
const NON_ICON_NAMES = new Set([
  'default',
  'createLucideIcon',
  'Icon',
  'LucideIcon',
])

/** `MapPin` → `map-pin`, `ALargeSmall` → `a-large-small`. */
function pascalToKebab(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

export const LUCIDE_ICONS: readonly LucideIconEntry[] = (() => {
  const out: LucideIconEntry[] = []
  for (const [name, value] of Object.entries(LucideAll)) {
    if (NON_ICON_NAMES.has(name)) continue
    if (!/^[A-Z]/.test(name)) continue
    const kind = typeof value
    if (kind !== 'function' && kind !== 'object') continue
    if (value === null) continue
    const id = pascalToKebab(name)
    const nameLower = name.toLowerCase()
    const tags = TAGS_BY_ID[id] ?? []
    // Newline separator prevents cross-field substring matches (e.g.
    // "in-mo" wouldn't match "map-pin\nmonitor").
    const hay = `${id}\n${nameLower}\n${tags.join('\n')}`
    out.push({
      id,
      name,
      nameLower,
      tags,
      hay,
      Component: value as LucideIconComponent,
    })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
})()

const BY_ID = new Map(LUCIDE_ICONS.map((e) => [e.id, e]))

export function iconComponentForId(
  id: string | undefined | null
): LucideIconComponent | null {
  if (!id) return null
  return BY_ID.get(id)?.Component ?? null
}

export function allLucideIconIds(): readonly string[] {
  return LUCIDE_ICONS.map((e) => e.id)
}
