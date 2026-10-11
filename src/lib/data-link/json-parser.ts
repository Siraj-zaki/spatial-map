/**
 * JSON adapter for the Data-Link pipeline.
 *
 * Real-world JSON exports rarely arrive as a clean top-level array of
 * flat objects — every WMS, ERP, or third-party API wraps the payload
 * differently. This parser handles the common shapes:
 *
 *   1. Top-level array            `[ { ... }, ... ]`
 *   2. Wrapped in a known key     `{ data: [ ... ] }`, `{ items: [...] }`
 *   3. Buried deeper              found via breadth-first scan
 *   4. Manual override            caller passes `rootPath` (dot-separated)
 *
 * Each object becomes a row. Nested objects are flattened one level into
 * dot-notation columns (`stock.qty`, `stock.unit`) so they're addressable
 * by the FieldMapper. Anything deeper (arrays of objects, three-level
 * trees) is JSON-stringified — users can still match on it, or we can
 * teach the parser more shapes later.
 *
 * What ends up on `ParsedFile.meta.rootPath` is the path actually used
 * so the dialog can show "Reading from $.data.bins" — important when
 * the auto-pick lands somewhere surprising.
 */

import type { ParsedFile } from './types'

const MAX_FILE_BYTES = 10 * 1024 * 1024

/** Common root keys we'll auto-look-into before falling back to BFS. */
const CANDIDATE_ROOTS = [
  'data',
  'items',
  'results',
  'rows',
  'records',
  'bins',
  'payload',
  'response',
  'list',
  'entries',
]

export class JsonParseError extends Error {}

export interface JsonParseOptions {
  /**
   * Dot-separated path into the JSON to find the row array. Examples:
   *   ""           → top-level
   *   "data"       → obj.data
   *   "data.bins"  → obj.data.bins
   *
   * When omitted, the parser auto-detects the first non-empty array of
   * objects (root, then well-known root keys, then breadth-first).
   */
  rootPath?: string
}

export async function parseJsonFile(
  file: File,
  opts: JsonParseOptions = {},
): Promise<ParsedFile> {
  if (file.size > MAX_FILE_BYTES) {
    throw new JsonParseError(
      `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`,
    )
  }
  let text: string
  try {
    text = await file.text()
  } catch (err) {
    throw new JsonParseError(`Could not read file: ${(err as Error).message}`)
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch (err) {
    throw new JsonParseError(`Malformed JSON: ${(err as Error).message}`)
  }

  const { array: arr, path } = pickRowArray(payload, opts.rootPath)
  if (!arr) {
    throw new JsonParseError(
      opts.rootPath
        ? `No array of objects found at "${opts.rootPath}".`
        : `Couldn't find an array of objects in the file. If your data is buried, set rootPath (e.g. "data.bins").`,
    )
  }

  // First pass: collect every key that appears on any flattened row so
  // the column order is stable even if some rows are missing fields.
  const columns: string[] = []
  const seen = new Set<string>()
  const flatRows: Record<string, string>[] = arr.map((row) => {
    const flat = flattenRow(row)
    for (const k of Object.keys(flat)) {
      if (!seen.has(k)) {
        seen.add(k)
        columns.push(k)
      }
    }
    return flat
  })

  // Second pass: fill missing cells with '' so the FieldMapper has a
  // dense grid (matches the CSV / XLSX path's behavior).
  const rows: Record<string, string>[] = flatRows.map((r) => {
    const dense: Record<string, string> = {}
    for (const col of columns) dense[col] = r[col] ?? ''
    return dense
  })

  return {
    columns,
    rows,
    errors: [],
    totalBytes: file.size,
    parsedAt: new Date(),
    meta: { kind: 'json', rootPath: path },
  }
}

/**
 * Walk a dot-separated path into `payload`. Each segment must resolve
 * to an object property; a numeric segment indexes into an array.
 */
function followPath(payload: unknown, path: string): unknown {
  if (path === '') return payload
  let cur: unknown = payload
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    if (Array.isArray(cur)) {
      const idx = Number.parseInt(seg, 10)
      if (Number.isNaN(idx)) return undefined
      cur = cur[idx]
    } else {
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  return cur
}

/**
 * Find the array of objects this parser should treat as rows.
 *
 *  1. If `rootPath` is given, follow it (and fail if it doesn't resolve
 *     to a row-shaped array).
 *  2. If the payload is itself an array of objects, return it.
 *  3. Try each well-known root key in order.
 *  4. Breadth-first scan for the first array of objects.
 */
function pickRowArray(
  payload: unknown,
  rootPath?: string,
): { array: Array<Record<string, unknown>> | null; path: string } {
  if (rootPath !== undefined) {
    const node = followPath(payload, rootPath)
    if (isArrayOfObjects(node)) return { array: node, path: rootPath }
    return { array: null, path: rootPath }
  }
  if (isArrayOfObjects(payload)) return { array: payload, path: '' }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>
    for (const k of CANDIDATE_ROOTS) {
      if (k in obj && isArrayOfObjects(obj[k])) {
        return { array: obj[k] as Array<Record<string, unknown>>, path: k }
      }
    }
    // Breadth-first scan: walk every nested object property until we
    // find an array of objects. Caps depth at 6 so deeply pathological
    // documents don't burn cycles.
    type QueueEntry = { node: unknown; path: string; depth: number }
    const queue: QueueEntry[] = [{ node: payload, path: '', depth: 0 }]
    while (queue.length > 0) {
      const { node, path, depth } = queue.shift() as QueueEntry
      if (depth > 6) continue
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue
      const o = node as Record<string, unknown>
      for (const [k, v] of Object.entries(o)) {
        const childPath = path === '' ? k : `${path}.${k}`
        if (isArrayOfObjects(v)) return { array: v, path: childPath }
        queue.push({ node: v, path: childPath, depth: depth + 1 })
      }
    }
  }
  return { array: null, path: rootPath ?? '' }
}

function isArrayOfObjects(v: unknown): v is Array<Record<string, unknown>> {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))
  )
}

/**
 * Turn one row object into a flat `{ column: string }` map.
 *
 *  - Primitives (string / number / boolean) → stringified
 *  - `null` / `undefined`                   → ""
 *  - One-level nested objects               → dot-notation columns
 *  - Arrays + deeper objects                → JSON-stringified blob
 */
function flattenRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      out[key] = ''
      continue
    }
    const t = typeof value
    if (t === 'string') {
      out[key] = (value as string).trim()
      continue
    }
    if (t === 'number' || t === 'boolean') {
      out[key] = String(value)
      continue
    }
    if (Array.isArray(value)) {
      // Arrays are opaque from the FieldMapper's perspective — store as
      // a JSON blob so the user can still match on it or save it as a
      // custom attribute.
      out[key] = JSON.stringify(value)
      continue
    }
    // Plain object: flatten one level into `key.subkey` columns. We
    // stop at one level because the column-mapping UI gets unusable
    // with three-deep paths.
    for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) {
      const flatKey = `${key}.${k2}`
      if (v2 === null || v2 === undefined) {
        out[flatKey] = ''
      } else if (typeof v2 === 'object') {
        out[flatKey] = JSON.stringify(v2)
      } else {
        out[flatKey] = String(v2).trim()
      }
    }
  }
  return out
}
