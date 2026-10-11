/**
 * "Full map" report layout (`layout.kind = 'map'`).
 *
 * The report's facility map & list (facilityExplorer) fills the page; its
 * list floats on the left, the picked record on the right, and every other
 * widget floats over the map in a slot:
 *   - `kpi`      — the glass number strip along the top (KPI / big value);
 *   - `insights` — stacked cards in the right-hand Insights panel (charts,
 *                  tables, notes), tucked into a bottom tray while a
 *                  record is open;
 *   - `hidden`   — off at first; viewers turn it on from Panels.
 * Authors set slots in the builder's Layout step (`layout.mapSlots`);
 * anything unset takes `defaultMapSlot`. Viewers can still switch to the
 * page layout, and exports / prints always use it.
 */

import type { LayoutConfig, MapSlot, ReportSpecV2, ReportWidgetV2, WidgetKindV2 } from '@/lib/reports/v2-types'
import { readExplorerBindings } from '@/lib/reports/explorer-spec'

/** Widgets that have no place on a map (layout-only). */
const NOT_ON_MAP = new Set<WidgetKindV2>(['divider', 'facilityExplorer', 'tabs', 'accordion', 'map'])

export function defaultMapSlot(kind: WidgetKindV2): MapSlot {
  return kind === 'kpi' || kind === 'bigValue' ? 'kpi' : 'insights'
}

/** KPI slot only fits number widgets; anything else falls back. */
export function mapSlotOf(w: Pick<ReportWidgetV2, 'id' | 'kind'>, layout: LayoutConfig | undefined): MapSlot {
  const set = layout?.mapSlots?.[w.id]
  if (set === 'kpi' && w.kind !== 'kpi' && w.kind !== 'bigValue') return 'insights'
  return set ?? defaultMapSlot(w.kind)
}

export function canSitOnMap(w: Pick<ReportWidgetV2, 'kind'>): boolean {
  return !NOT_ON_MAP.has(w.kind)
}

/** The widget the full map is built around: the first configured map & list. */
export function mapExplorer(spec: Pick<ReportSpecV2, 'widgets'>): ReportWidgetV2 | null {
  return (
    (spec.widgets ?? []).find((w) => {
      if (w.kind !== 'facilityExplorer') return false
      const b = readExplorerBindings(w)
      return Boolean(b.zoneId) && b.tabs.length > 0
    }) ?? null
  )
}

/** Whether this report can be shown as a full map at all. */
export function hasMapView(spec: Pick<ReportSpecV2, 'widgets'>): boolean {
  return mapExplorer(spec) !== null
}

/** Widgets per slot, in report order (the explorer itself excluded). */
export function mapSlots(spec: Pick<ReportSpecV2, 'widgets' | 'layout'>): Record<MapSlot, ReportWidgetV2[]> {
  const out: Record<MapSlot, ReportWidgetV2[]> = { kpi: [], insights: [], hidden: [] }
  const ordered = [...(spec.widgets ?? [])].sort(
    (a, b) => (a.order ?? a.position?.y ?? 0) - (b.order ?? b.position?.y ?? 0),
  )
  for (const w of ordered) {
    if (!canSitOnMap(w)) continue
    out[mapSlotOf(w, spec.layout)].push(w)
  }
  return out
}
