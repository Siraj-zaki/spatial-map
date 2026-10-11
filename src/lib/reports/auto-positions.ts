/**
 * Grid positions for widgets authored for document flow.
 *
 * Generated reports (facility set, linked-data reports, demo seeds) carry
 * `order` / `columnSpan` but no grid `position`; the builder's Layout
 * canvas and the viewer's grid mode both need one. Positions mirror how
 * the document flow lays them out.
 */

import type { ReportWidgetV2, WidgetKindV2, WidgetPosition } from '@/lib/reports/v2-types'

const COLS = 12

export function hasPosition(w: ReportWidgetV2): boolean {
  const p = w.position as WidgetPosition | undefined
  return !!p && [p.x, p.y, p.w, p.h].every((n) => typeof n === 'number' && Number.isFinite(n))
}

function heightFor(kind: WidgetKindV2): number {
  switch (kind) {
    case 'kpi':
    case 'bigValue':
      return 3
    case 'divider':
      return 1
    case 'note':
    case 'alert':
      return 2
    case 'pie':
    case 'donut':
      return 6
    case 'dataTable':
    case 'editableTable':
      return 8
    case 'facilityExplorer':
      return 14
    default:
      return 5
  }
}

/**
 * The leading KPIs as a strip of up to four, `columnSpan: 2` widgets in
 * pairs, the rest full width — placed below any widgets that already
 * have a position. Widgets with a position are returned unchanged.
 */
export function withAutoPositions(widgets: ReportWidgetV2[]): ReportWidgetV2[] {
  if (widgets.every(hasPosition)) return widgets
  let y = widgets.filter(hasPosition).reduce((acc, w) => Math.max(acc, w.position.y + w.position.h), 0)
  let x = 0
  let rowH = 0
  const newRow = () => {
    y += rowH
    x = 0
    rowH = 0
  }
  const ordered = [...widgets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const placed = new Map<string, WidgetPosition>()
  for (const w of ordered) {
    if (hasPosition(w)) continue
    const isKpi = w.kind === 'kpi' || w.kind === 'bigValue'
    const width = isKpi ? 3 : w.columnSpan === 2 ? 6 : COLS
    const height = heightFor(w.kind)
    if (x + width > COLS) newRow()
    placed.set(w.id, { x, y, w: width, h: height })
    x += width
    rowH = Math.max(rowH, height)
    if (x >= COLS) newRow()
  }
  return widgets.map((w) => (placed.has(w.id) ? { ...w, position: placed.get(w.id)! } : w))
}
