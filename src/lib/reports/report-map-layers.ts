/**
 * Report map layers — the pure side of a report's live map: which data-link
 * layers it draws, how the report's (viewer-filtered) rows narrow each one,
 * and the viewer's hidden layers in the URL.
 *
 * A layer is narrowed to its tab's rows by an `in` filter on the payload
 * field that carries the row's entity key (`keyFieldOf`): report rows and
 * map entities share that value, so the map draws exactly what the list
 * lists — a viewer filter, a search or the author's `where` included.
 */

import type { DataLinkFilter } from '@/lib/db'

type Row = Record<string, unknown> & { entity_key: string }

/** The column whose value is the entity key on every row (a table's unique
 *  key field, e.g. `stock_no`), or null when no single column carries it. */
export function keyFieldOf(rows: ReadonlyArray<Row>, columns: ReadonlyArray<string>): string | null {
  if (rows.length === 0) return null
  const sample = rows.length > 200 ? rows.slice(0, 200) : rows
  for (const c of columns) {
    if (c === 'entity_key') continue
    if (sample.every((r) => r[c] !== null && r[c] !== undefined && String(r[c]) === r.entity_key)) return c
  }
  return null
}

/** The filter that keeps exactly these rows on the layer, or null (draw everything). */
export function rowKeyFilter(rows: ReadonlyArray<Row>, columns: ReadonlyArray<string>): DataLinkFilter | null {
  const field = keyFieldOf(rows, columns)
  if (!field) return rows.length === 0 && columns.length > 0 ? NOTHING : null
  return { kind: 'condition', field, op: 'in', value: rows.map((r) => r.entity_key) }
}
/** A filter no entity passes (the report's rows are empty). */
const NOTHING: DataLinkFilter = { kind: 'condition', field: '__none__', op: 'in', value: [] }

// ---- hidden layers in the URL (?layersOff=12,15) ---------------------------

const PARAM = 'layersOff'

export function readHiddenLayersFromURL(): ReadonlySet<number> {
  if (typeof window === 'undefined') return new Set()
  const raw = new URL(window.location.href).searchParams.get(PARAM)
  return new Set((raw ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0))
}

/** replaceState, touching only its own param (like `?cluster=`), so a shared link keeps it. */
export function writeHiddenLayersToURL(hidden: ReadonlySet<number>): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (hidden.size === 0) url.searchParams.delete(PARAM)
  else url.searchParams.set(PARAM, [...hidden].sort((a, b) => a - b).join(','))
  window.history.replaceState(window.history.state, '', url)
}
