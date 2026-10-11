/**
 * Given an ImportPlan + one parsed row, return a ResolvedTarget that
 * tells the importer where the row's data should land (or why it
 * couldn't be matched). Pure function over Dexie — `await`s lookups but
 * has no side effects.
 *
 * All three match strategies funnel through here so the importer's
 * commit loop stays kind-agnostic.
 */

import {
  type Bin,
  type BindingKind,
} from '@/lib/db'
import { apiDb, getBinByExternalCode, getBin, getBinForShape } from '@/lib/api-db'
import {
  cellAddressFromLabel,
  estimateGridDimensions,
  isCellAddress,
  parseLabelString,
  type LabelMismatch,
} from '@/lib/grid-generators'
import type { CsvRow, ImportPlan, ResolvedTarget } from './types'

export async function resolveTarget(row: CsvRow, plan: ImportPlan): Promise<ResolvedTarget> {
  switch (plan.match.mode) {
    case 'externalCode':
      return resolveByExternalCode(row, plan.match.column, plan.zoneId)
    case 'gridCellAddress':
      return resolveByGridCellAddress(row, plan.match, plan.zoneId)
    case 'shapeName':
      return resolveByShapeName(row, plan.match.column, plan.match.kind, plan.zoneId)
    case 'binLabel':
      return resolveByBinLabel(row, plan.match.column, plan.zoneId)
  }
}

// ---------------------------------------------------------------- externalCode
async function resolveByExternalCode(
  row: CsvRow,
  column: string,
  zoneId?: number,
): Promise<ResolvedTarget> {
  const code = (row[column] ?? '').trim()
  if (!code) {
    return { status: 'unmatched', reason: `Empty externalCode in column "${column}"` }
  }
  const existing = await getBinByExternalCode(code)
  if (existing) {
    if (await zoneMismatch(existing, zoneId)) {
      return {
        status: 'unmatched',
        reason: `externalCode "${code}" exists but in a different facility`,
      }
    }
    // Bound grid cell — only treat as matched-grid when the bin
    // actually carries an address. A previous import may have written
    // a placeholder (no gridId/row/col) and that's NOT a cell match
    // even though the targetKind says so. Fall through to will-create
    // with the existing row so the commit upserts.
    if (
      existing.targetKind === 'grid-cell' &&
      typeof existing.gridId === 'number' &&
      typeof existing.row === 'number' &&
      typeof existing.col === 'number'
    ) {
      return {
        status: 'matched-grid',
        gridId: existing.gridId,
        row: existing.row,
        col: existing.col,
        level: existing.level ?? 0,
        existing,
      }
    }
    // Whole-shape binding (polygon / circle / line / marker / image / model).
    if (existing.targetKind !== 'grid-cell' && existing.shapeId !== undefined) {
      return {
        status: 'matched-shape',
        targetKind: existing.targetKind as Exclude<BindingKind, 'grid-cell'>,
        shapeId: existing.shapeId,
        existing,
      }
    }
    // Placeholder row that was created on a prior import — update it
    // instead of inserting a duplicate.
    return { status: 'will-create', via: 'externalCode', externalCode: code, existing }
  }
  // No existing bin — commit step will create a placeholder bin keyed
  // by externalCode (no shape attached). The user can later "bind" it
  // to a cell via the bin editor or another import that carries the
  // grid+row+col address.
  return { status: 'will-create', via: 'externalCode', externalCode: code }
}

// ----------------------------------------------------------- gridCellAddress
async function resolveByGridCellAddress(
  row: CsvRow,
  spec: Extract<ImportPlan['match'], { mode: 'gridCellAddress' }>,
  zoneId?: number,
): Promise<ResolvedTarget> {
  const gridRef = (row[spec.gridColumn] ?? '').trim()
  if (!gridRef) {
    return { status: 'unmatched', reason: `Empty grid identifier in column "${spec.gridColumn}"` }
  }
  // Resolve the grid first — by numeric id or by name.
  let gridId: number | undefined
  if (spec.gridColumnIs === 'id') {
    const n = Number(gridRef)
    if (!Number.isFinite(n) || n <= 0) {
      return { status: 'unmatched', reason: `Invalid numeric gridId "${gridRef}"` }
    }
    gridId = n
  } else {
    // Name lookup — exact match. Multiple grids may share a name; we
    // take the first and warn (warning lives on the PreviewRow).
    const hits = await apiDb.grids
      .where('name')
      .equals(gridRef)
      .toArray()
    const scoped = zoneId !== undefined ? hits.filter((g) => g.zoneId === zoneId) : hits
    if (scoped.length === 0) {
      return { status: 'unmatched', reason: `No grid named "${gridRef}"` }
    }
    gridId = scoped[0].id
  }
  if (gridId === undefined) {
    return { status: 'unmatched', reason: `Failed to resolve grid` }
  }
  const grid = await apiDb.grids.get(gridId)
  if (!grid) {
    return { status: 'unmatched', reason: `Grid #${gridId} does not exist` }
  }
  if (zoneId !== undefined && grid.zoneId !== zoneId) {
    return {
      status: 'unmatched',
      reason: `Grid #${gridId} belongs to a different facility`,
    }
  }
  // Row/col/level — coerce to integers.
  const rowIdx = toNonNegInt(row[spec.rowColumn])
  const colIdx = toNonNegInt(row[spec.colColumn])
  const level = spec.levelColumn ? toNonNegInt(row[spec.levelColumn]) ?? 0 : 0
  if (rowIdx === null) {
    return { status: 'unmatched', reason: `Invalid row index "${row[spec.rowColumn]}"` }
  }
  if (colIdx === null) {
    return { status: 'unmatched', reason: `Invalid col index "${row[spec.colColumn]}"` }
  }
  const existing = await getBin(gridId, rowIdx, colIdx, level)
  return {
    status: 'matched-grid',
    gridId,
    row: rowIdx,
    col: colIdx,
    level,
    existing,
  }
}

// ------------------------------------------------------------------ binLabel
async function resolveByBinLabel(
  row: CsvRow,
  column: string,
  zoneId?: number,
): Promise<ResolvedTarget> {
  const raw = (row[column] ?? '').trim()
  if (!raw) {
    return { status: 'unmatched', reason: `Empty bin label in column "${column}"` }
  }
  const parsed = parseLabelString(raw)
  if (!parsed) {
    return {
      status: 'unmatched',
      reason: `Couldn't parse bin label "${raw}" — expected "PREFIX-N" or "PREFIX-N-L01"`,
    }
  }
  // Find every grid whose labelPrefix matches the parsed prefix.
  // Scope to the active warehouse so an "A-1-L01" import doesn't
  // collide across sites.
  const allGrids = await apiDb.grids.toArray()
  const candidates = allGrids.filter((g) => {
    const cfgPrefix = g.config?.labelPrefix ?? ''
    if (cfgPrefix !== parsed.prefix) return false
    if (zoneId !== undefined && g.zoneId !== zoneId) return false
    return true
  })
  if (candidates.length === 0) {
    return {
      status: 'unmatched',
      reason:
        parsed.prefix === ''
          ? `No rack uses a number-only label scheme matching "${raw}"`
          : `No rack has label prefix "${parsed.prefix}"`,
    }
  }
  // Walk the candidates in stable order. First grid whose dimensions
  // accommodate the parsed index wins — that gives sensible behaviour
  // when multiple racks share a prefix but cover different ranges.
  //
  // Failed attempts are collected so an unmatched row can explain
  // *why* every candidate refused — most often "Levels = 1 but label
  // expects L02", which is otherwise invisible to the user.
  const tried: Array<{ name: string; mismatch: LabelMismatch }> = []
  for (const grid of candidates) {
    if (grid.id === undefined) continue
    const dims = estimateGridDimensions(grid.start, grid.current, grid.config)
    if (!dims) {
      tried.push({
        name: grid.name,
        mismatch: { reason: 'index-out-of-range', detail: { value: 0, max: 0 } },
      })
      continue
    }
    const result = cellAddressFromLabel(parsed, grid.config, dims.rows, dims.cols)
    if (!isCellAddress(result)) {
      tried.push({ name: grid.name, mismatch: result })
      continue
    }
    const existing = await getBin(grid.id, result.row, result.col, result.level)
    return {
      status: 'matched-grid',
      gridId: grid.id,
      row: result.row,
      col: result.col,
      level: result.level,
      existing,
    }
  }
  return {
    status: 'unmatched',
    reason: explainLabelFailure(raw, parsed, tried),
  }
}

/**
 * Build a user-readable reason from the list of candidate rejections.
 * Picks the most specific failure (level-out-of-range > index-out-of-range
 * > everything else) so the message is actionable.
 */
function explainLabelFailure(
  raw: string,
  parsed: { prefix: string; number: number; level: number },
  tried: Array<{ name: string; mismatch: LabelMismatch }>,
): string {
  if (tried.length === 0) {
    return parsed.prefix === ''
      ? `Label "${raw}" parsed, but no rack uses number-only labels in this facility`
      : `Label "${raw}" parsed, but no rack has labelPrefix "${parsed.prefix}" in this facility`
  }
  // Priority order — most specific issue first.
  const priority: LabelMismatch['reason'][] = [
    'level-out-of-range',
    'number-below-start',
    'index-out-of-range',
    'prefix-mismatch',
  ]
  for (const reason of priority) {
    const hit = tried.find((t) => t.mismatch.reason === reason)
    if (!hit) continue
    const d = hit.mismatch.detail
    switch (reason) {
      case 'level-out-of-range':
        return `"${raw}" → rack "${hit.name}" only has ${d?.max} level${d?.max === 1 ? '' : 's'}, but the label expects L${String(d?.value ?? 0).padStart(2, '0')}`
      case 'number-below-start':
        return `"${raw}" → rack "${hit.name}" labels start at ${d?.max}, but the label number is ${d?.value}`
      case 'index-out-of-range':
        return `"${raw}" → rack "${hit.name}" doesn't have a cell at that index (max index ${d?.max})`
      case 'prefix-mismatch':
        return `"${raw}" → no rack with labelPrefix "${parsed.prefix}" found`
    }
  }
  return `"${raw}" → no matching rack`
}

// ------------------------------------------------------------------ shapeName
async function resolveByShapeName(
  row: CsvRow,
  column: string,
  kind: Exclude<BindingKind, 'grid-cell'>,
  zoneId?: number,
): Promise<ResolvedTarget> {
  const name = (row[column] ?? '').trim()
  if (!name) {
    return { status: 'unmatched', reason: `Empty shape name in column "${column}"` }
  }
  const table = shapeTable(kind)
  const hits = await table.where('name').equals(name).toArray()
  const scoped = zoneId !== undefined ? hits.filter((s) => s.zoneId === zoneId) : hits
  if (scoped.length === 0) {
    return { status: 'unmatched', reason: `No ${kind} named "${name}"` }
  }
  const shape = scoped[0]
  if (shape.id === undefined) {
    return { status: 'unmatched', reason: `${kind} "${name}" has no id` }
  }
  const existing = await getBinForShape(kind, shape.id)
  return {
    status: 'matched-shape',
    targetKind: kind,
    shapeId: shape.id,
    existing,
  }
}

// ---------------------------------------------------------------- utilities
function shapeTable(kind: Exclude<BindingKind, 'grid-cell'>) {
  switch (kind) {
    case 'polygon': return apiDb.polygons
    case 'circle':  return apiDb.circles
    case 'line':    return apiDb.lines
    case 'marker':  return apiDb.markers
    case 'image':   return apiDb.images
    case 'model':   return apiDb.models
  }
}

function toNonNegInt(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null
  return n
}

/**
 * Check whether an existing bin lives outside the import's warehouse
 * scope. Bins inherit zone through their parent grid/shape — we walk
 * one hop to get it.
 */
async function zoneMismatch(bin: Bin, zoneId?: number): Promise<boolean> {
  if (zoneId === undefined) return false
  if (bin.targetKind === 'grid-cell') {
    if (bin.gridId === undefined) return false
    const grid = await apiDb.grids.get(bin.gridId)
    return grid?.zoneId !== zoneId
  }
  if (bin.shapeId === undefined) return false
  const table = shapeTable(bin.targetKind as Exclude<BindingKind, 'grid-cell'>)
  const shape = await table.get(bin.shapeId)
  return shape?.zoneId !== zoneId
}
