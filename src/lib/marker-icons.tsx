/**
 * Marker icon catalogue.
 *
 * Markers can use ANY lucide icon by kebab-case id (`map-pin`,
 * `warehouse`, `alarm-clock`). Icons resolve synchronously via the
 * shared manifest in `@/lib/lucide-icons`, which bundles the full
 * lucide export at module load so there's no async loading flash on
 * the map or in list rows.
 *
 * `MARKER_QUICK_PICKS` is a small curated strip shown at the top of the
 * picker for warehouse/logistics workflows. It's a UX affordance only;
 * the searchable grid below it exposes the full lucide catalogue.
 *
 * Backward compat: markers created before the migration stored
 * Maki-style ids (`marker`, `industry`, `cargo`, ...). `resolveIconName`
 * translates them to lucide kebab-case names at render time; stored
 * values are never mutated so downgrading is safe.
 */

import { forwardRef } from 'react'
import { MapPin, type LucideProps } from 'lucide-react'
import { iconComponentForId } from '@/lib/lucide-icons'
import type { AssetType } from './shapes'

// Legacy Maki-style ids → lucide kebab-case ids. Add here (never
// remove) if we ever need to rename a curated pick — otherwise old
// stored markers render as MapPin.
const LEGACY_ICON_ALIAS: Record<string, string> = {
  marker: 'map-pin',
  industry: 'building-2',
  cargo: 'package-open',
  ferry: 'anchor',
  'car-rental': 'truck',
  roadblock: 'forklift',
  shop: 'boxes',
  parking: 'parking-square',
}

/**
 * Translate a stored `config.icon` value to the id that
 * `iconComponentForId` will resolve. Falls back to `map-pin` when the
 * id is unknown so the marker never renders blank.
 */
export function resolveIconName(id: string): string {
  if (iconComponentForId(id)) return id
  const aliased = LEGACY_ICON_ALIAS[id]
  if (aliased) return aliased
  return 'map-pin'
}

export interface MarkerQuickPick {
  /** Kebab-case lucide icon id (also stored in `config.icon`). */
  name: string
  /** i18n key suffix for `marker.icon_${labelKey}`. */
  labelKey: string
  /** Suggested asset type when this pick is selected. */
  defaultAssetType?: AssetType
}

export const MARKER_QUICK_PICKS: readonly MarkerQuickPick[] = [
  { name: 'map-pin', labelKey: 'pin' },
  { name: 'warehouse', labelKey: 'warehouse', defaultAssetType: 'storage' },
  { name: 'building-2', labelKey: 'facility' },
  { name: 'package-open', labelKey: 'shipping', defaultAssetType: 'shipping' },
  { name: 'anchor', labelKey: 'receiving', defaultAssetType: 'receiving' },
  { name: 'truck', labelKey: 'dockDoor', defaultAssetType: 'dock-door' },
  { name: 'forklift', labelKey: 'forklift', defaultAssetType: 'forklift' },
  { name: 'boxes', labelKey: 'pickStation', defaultAssetType: 'pick-station' },
  { name: 'parking-square', labelKey: 'parking' },
  { name: 'fuel', labelKey: 'fuel' },
]

export const ASSET_TYPES: AssetType[] = [
  'forklift',
  'pick-station',
  'dock-door',
  'shipping',
  'receiving',
  'storage',
  'other',
]

export interface MarkerIconGlyphProps extends LucideProps {
  /** Stored `config.icon` value (legacy Maki ids auto-translated). */
  icon: string
}

/**
 * Renders a lucide icon by stored id. Synchronous — no loading flash.
 * Falls back to `MapPin` if the id can't be resolved.
 */
export const MarkerIconGlyph = forwardRef<SVGSVGElement, MarkerIconGlyphProps>(
  ({ icon, ...props }, ref) => {
    const Icon = iconComponentForId(resolveIconName(icon)) ?? MapPin
    return <Icon ref={ref} {...props} />
  }
)
MarkerIconGlyph.displayName = 'MarkerIconGlyph'
