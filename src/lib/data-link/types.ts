/**
 * Shared types for the Data-Link import pipeline.
 *
 * The pipeline runs in three stages:
 *   parse   — raw file → ParsedFile (columns + rows + parse errors)
 *   plan    — user picks a MatchStrategy + per-column FieldTarget
 *   commit  — for each row, resolve to a target bin and upsert
 *
 * Everything here is pure data — UI components and Dexie writes live in
 * sibling modules.
 */

import type { BindingKind, Bin, BinStatus } from '@/lib/db'

/** A row from a parsed tabular source. Values are always strings; we coerce on commit. */
export type CsvRow = Record<string, string>

/** Output of the parse stage. */
export interface ParsedFile {
  /** Header row (in source order). */
  columns: string[]
  /** Data rows, indexed by column name. */
  rows: CsvRow[]
  /** Parser errors (malformed quotes, ragged columns, …). Non-fatal — rows still come through. */
  errors: string[]
  /** Original file size in bytes (for the audit log). */
  totalBytes: number
  parsedAt: Date
  /** Format-specific metadata (sheet info for xlsx, root path for json, …). Optional. */
  meta?: ParsedFileMeta
}

export type ParsedFileMeta =
  | { kind: 'csv' }
  | {
      kind: 'xlsx'
      /** Every worksheet present in the workbook. */
      sheetNames: string[]
      /** The worksheet that produced `rows`. */
      sheetName: string
    }
  | { kind: 'json'; rootPath?: string }
  | { kind: 'geojson' }

/**
 * How to find the bin that a CSV row refers to. The user picks one
 * strategy per import — every row uses the same strategy.
 *
 *  - `externalCode`     — one column → Bin.externalCode (universal, any kind)
 *  - `gridCellAddress`  — 2–5 columns → resolves to a grid cell. The grid
 *                         can be referenced by id (numeric) or name (string);
 *                         `level` is optional and defaults to 0.
 *  - `shapeName`        — one column → matches a non-grid shape's `name`.
 *                         The kind is required (we'd otherwise have to
 *                         search all 5 tables for every row).
 */
export type MatchStrategy =
  | { mode: 'externalCode'; column: string }
  | {
      mode: 'gridCellAddress'
      gridColumn: string
      gridColumnIs: 'id' | 'name'
      rowColumn: string
      colColumn: string
      levelColumn?: string
    }
  | {
      mode: 'shapeName'
      column: string
      kind: Exclude<BindingKind, 'grid-cell'>
    }
  | {
      /**
       * Single-column lookup by the rack's *rendered* cell label
       * (`A-1-L01`, `42`, `Aisle-3-7-L02`). The resolver parses the
       * label, finds the rack whose `labelPrefix` matches, reverses
       * the cell-index math from `formatLabel`, and yields the
       * `(gridId, row, col, level)` address. Handy when the WMS
       * export already uses the same code the user sees on the map.
       */
      mode: 'binLabel'
      column: string
    }

/**
 * What a non-match column gets written to on the resolved bin.
 *
 *  - `builtin`  — a top-level Bin field with native typing & validation.
 *  - `custom`   — goes into `Bin.customProperties[key]`. The set of legal
 *                 keys is declared by `attributeDefinitions` rows; the
 *                 importer can auto-define unknown keys when
 *                 `ImportPlan.autoDefineAttributes` is true.
 *  - `ignore`   — column is preview-only, not written.
 */
export type FieldTarget =
  | { kind: 'builtin'; field: 'externalCode' | 'sku' | 'capacity' | 'notes' | 'status' }
  | { kind: 'custom'; key: string }
  | { kind: 'ignore' }

/** Full plan for one import run. */
export interface ImportPlan {
  source: { kind: 'csv' | 'xlsx' | 'json'; name: string; size: number }
  columns: string[]
  match: MatchStrategy
  /** Per-column target. Columns absent from this map are treated as `ignore`. */
  fieldMapping: Record<string, FieldTarget>
  /** Optional warehouse scope — bins resolved outside this zone are skipped. */
  zoneId?: number
  /** When true, unknown `custom.key` targets create attributeDefinitions on commit. */
  autoDefineAttributes?: boolean
}

/** What the resolver produced for one source row. */
export type ResolvedTarget =
  | {
      status: 'matched-grid'
      gridId: number
      row: number
      col: number
      level: number
      /** The existing bin row, if one already exists (used for diff preview). */
      existing: Bin | null
    }
  | {
      status: 'matched-shape'
      targetKind: Exclude<BindingKind, 'grid-cell'>
      shapeId: number
      existing: Bin | null
    }
  | {
      /** No bin (or a placeholder bin) is bound to a cell/shape yet — the
       *  commit will either insert a new row keyed by externalCode, or
       *  update the placeholder `existing` if one was already created
       *  by a previous import. */
      status: 'will-create'
      via: 'externalCode'
      externalCode: string
      /** Set when re-importing a row whose externalCode already maps to
       *  a placeholder bin. The commit upserts onto that row instead of
       *  inserting a duplicate. */
      existing?: Bin | null
    }
  | { status: 'unmatched'; reason: string }

/** What the importer would write for one row (pre-commit). */
export interface PreviewRow {
  rowIndex: number
  raw: CsvRow
  resolved: ResolvedTarget
  /** The partial Bin patch we'd send to the upsert helper. */
  patch: Partial<Bin>
  /** Non-fatal issues (coerced types, unknown enum values, …). */
  warnings: string[]
}

/** Aggregate of a preview run. */
export interface PreviewResult {
  rows: PreviewRow[]
  totals: {
    rowsRead: number
    rowsMatchedGrid: number
    rowsMatchedShape: number
    rowsWillCreate: number
    rowsUnmatched: number
    rowsWithWarnings: number
  }
  /** Custom keys referenced by the plan that don't have an attribute definition. */
  unknownAttributeKeys: string[]
}

/** Aggregate of a commit run, stored on the importJobs row. */
export interface ImportSummary {
  rowsRead: number
  rowsMatched: number
  rowsImported: number
  rowsSkipped: number
  rowsErrored: number
  errors: string[]
}

/** Helper — narrow a string to BinStatus, returning null on miss. */
export function coerceBinStatus(raw: string | undefined): BinStatus | null {
  if (!raw) return null
  const lower = raw.trim().toLowerCase()
  if (lower === 'empty' || lower === 'occupied' || lower === 'reserved') return lower
  return null
}
