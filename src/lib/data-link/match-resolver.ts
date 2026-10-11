/**
 * Match resolver — turns a `DataLinkConfig` + one runtime payload into
 * either a list of target shapes (for shape-anchored modes) or a
 * lng/lat pair (for coord modes). See DESIGN-data-link-v2.md §2.
 *
 * Attribute-join supports multi-hit (renders on every matching shape),
 * so shape modes return an array. Coord returns a single position.
 *
 * Performance
 * -----------
 * `attribute-join` and `external-code` build a per-config
 * `Map<normalizedValue, Shape[]>` index the first time they run
 * against a given store snapshot. The index invalidates when the
 * underlying shape or bin array reference changes (Zustand replaces
 * the array on every mutation) so we never miss updates but also
 * never rebuild while the map is quiet.
 *
 * Key normalization mirrors the CSV importer at
 * `src/lib/data-link/csv-parser.ts:74` — `.toLowerCase().replace(/[^a-z0-9]+/g, '')`
 * — because that's the transform the backend applies before writing to
 * `bin.custom_properties`. Both sides of the join go through it so
 * `payload.room_name` matches `bin.custom_properties.roomname`.
 */

import type {
  Bin,
  DataLinkConfig,
  DataLinkMatch,
} from '@/lib/db'
import type {
  PolygonShape,
  MarkerShape,
  CircleShape,
  LineShape,
  StairShape,
  ImageShape,
  ImagePlaneShape,
  ModelShape,
  TextLabelShape,
} from '@/lib/shapes'
import type { DoorShape } from '@/lib/door/types'

// -------------------------------------------------------------- types

export type MatchableShape =
  | PolygonShape
  | MarkerShape
  | CircleShape
  | LineShape
  | StairShape
  | DoorShape
  | ImageShape
  | ImagePlaneShape
  | ModelShape
  | TextLabelShape

/**
 * Minimum store slice the resolver reads. Callers should pass current
 * values from `useSpatialStore.getState()` — the resolver holds no
 * subscription of its own.
 */
export interface MatchStoreSnapshot {
  bins: readonly Bin[]
  polygons: readonly PolygonShape[]
  markers: readonly MarkerShape[]
  circles: readonly CircleShape[]
  lines: readonly LineShape[]
  stairs: readonly StairShape[]
  doors: readonly DoorShape[]
  images: readonly ImageShape[]
  imagePlanes: readonly ImagePlaneShape[]
  models: readonly ModelShape[]
  textLabels: readonly TextLabelShape[]
}

export type MatchResult =
  | { kind: 'coord'; position: [number, number] }
  | { kind: 'shapes'; shapes: MatchableShape[] }
  | { kind: 'none'; reason: string }

// -------------------------------------------------------- key helpers

/**
 * Alphanumeric slug used by the bin importer for custom-property keys.
 * Attribute-join comparisons canonicalise both sides through this.
 */
export function normalizeKey(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Read a possibly nested payload path like:
 *   `props.room`               — dotted object path
 *   `x.y.z`                    — deeper nesting
 *   `currentPosition[0]`       — array-index access on a top-level field
 *   `points[3].lng`            — object inside an array
 *   `positions[0][1]`          — nested arrays (e.g. GeoJSON coords)
 *
 * Array indices are 0-based. Negative indices and slice syntax are not
 * supported. Unknown paths return `undefined`.
 *
 * Kept intentionally lightweight — no dependency on a JSONPath library —
 * because the field-mapping editor accepts short human-typed strings and
 * we want the semantics to be obvious from reading the input alone.
 */
export function readPayloadPath(payload: unknown, path: string): unknown {
  if (!path) return undefined
  // FIRST attempt: treat the entire path as a single flat key. This
  // catches the very common case where sample-augmentation stamps
  // fields as `payload["custom.foo"] = value` (the dot is part of the
  // key NAME, not a nesting separator) — see
  // `src/lib/data-link/sample-augmentation.ts` where `fieldName =
  // \`custom.${def.key}\`` and `records[fieldName] = value` writes the
  // dotted key literally. If the config's path is `custom.foo`, the
  // dot-split walk would never resolve it because the payload has a
  // single flat key called `"custom.foo"`, not a nested `custom`
  // object. Prior to 2026-07-22 this rendered every configured custom
  // attribute as an em-dash in the drawer + popup ATTRIBUTES section.
  if (path.includes('.') && isRecord(payload) && path in payload) {
    return payload[path]
  }
  const direct = walkPath(payload, path)
  if (direct !== undefined) return direct
  // Fallbacks for the `custom.<key>` convention used by the data-link
  // editor. Runtime payloads from different data sources land in one
  // of four container shapes:
  //   1. Literal dotted key      (`payload["custom.foo"]`)        — sample-augmentation
  //   2. Nested `custom` object  (`payload.custom.foo`)           — hand-crafted feeds
  //   3. Bin-style container     (`payload.customProperties.foo`) — JSON/CSV/GeoJSON importers
  //   4. `custom_`-prefixed flat (`payload.custom_foo`)           — REST column-prefix convention
  //   5. Fully-flat top-level    (`payload.foo`)                   — streams with no container
  // We try each in turn so a config path of `custom.foo` resolves
  // against any of them. Mirrors `readPayloadAttribute` in
  // `style-rule-evaluator.ts`, which already treats `custom.<key>` as
  // a synonym for `customProperties.<key>`.
  if (path.startsWith('custom.')) {
    const rest = path.slice('custom.'.length)
    if (rest.length > 0) {
      const viaCustomProperties = walkPath(payload, `customProperties.${rest}`)
      if (viaCustomProperties !== undefined) return viaCustomProperties
      const viaUnderscore = walkPath(payload, `custom_${rest}`)
      if (viaUnderscore !== undefined) return viaUnderscore
      const viaFlat = walkPath(payload, rest)
      if (viaFlat !== undefined) return viaFlat
    }
  }
  return undefined
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function walkPath(payload: unknown, path: string): unknown {
  // Split `foo.bar[3][0].baz` into ['foo', 'bar', '3', '0', 'baz'] while
  // remembering which segments were array indices. Regex globs the two
  // token kinds: [digits] for indices, otherwise a bare identifier
  // fragment. Anything that doesn't match is treated as a literal
  // segment so a stray character doesn't silently drop the tail.
  const tokens: Array<{ kind: 'key' | 'idx'; value: string }> = []
  const re = /\[(\d+)\]|([^.[\]]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) tokens.push({ kind: 'idx', value: m[1] })
    else if (m[2] !== undefined) tokens.push({ kind: 'key', value: m[2] })
  }
  let cur: unknown = payload
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return undefined
    if (tok.kind === 'idx') {
      if (!Array.isArray(cur)) return undefined
      cur = cur[Number(tok.value)]
      continue
    }
    if (typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[tok.value]
  }
  return cur
}

// ----------------------------------------------- targetKind → shapes[]

/** Pick the store slice matching a config's targetKind. */
function shapesForKind(
  targetKind: DataLinkConfig['targetKind'],
  snapshot: MatchStoreSnapshot,
): readonly MatchableShape[] {
  switch (targetKind) {
    case 'polygon':    return snapshot.polygons
    case 'marker':     return snapshot.markers
    case 'circle':     return snapshot.circles
    case 'line':       return snapshot.lines
    case 'stair':      return snapshot.stairs
    case 'door':       return snapshot.doors
    case 'image':      return snapshot.images
    case 'model':      return snapshot.models
    case 'text-label': return snapshot.textLabels
    // grid-cell binds per-cell, not per-shape — attribute-join not
    // supported here. Coord + explicit-shape are the useful modes.
    case 'grid-cell':  return []
    default: {
      // Exhaustiveness for future kinds.
      const _exhaustive: never = targetKind
      void _exhaustive
      return []
    }
  }
}

// ---------------------------------------------- bin lookup by shape id

/**
 * Cached `(targetKind, shapeId) → Bin` map. Rebuilt when the bins array
 * reference changes (Zustand replaces the array on any mutation, so
 * reference equality is a safe cache key).
 */
let binCache: {
  binsRef: readonly Bin[] | null
  byShape: Map<string, Bin>
} = { binsRef: null, byShape: new Map() }

function binByShape(bins: readonly Bin[], targetKind: string, shapeId: number): Bin | undefined {
  if (binCache.binsRef !== bins) {
    const m = new Map<string, Bin>()
    for (const b of bins) {
      if (b.shapeId !== undefined && b.targetKind !== 'grid-cell') {
        m.set(`${b.targetKind}:${b.shapeId}`, b)
      }
    }
    binCache = { binsRef: bins, byShape: m }
  }
  return binCache.byShape.get(`${targetKind}:${shapeId}`)
}

// ---------------------------------------------- attribute-join indices

type JoinKey = string /** normalised value */

interface JoinIndex {
  /** The (bins, shapes) refs this index was built from. */
  binsRef: readonly Bin[]
  shapesRef: readonly MatchableShape[]
  /** targetKind + shapeFieldSource + shapeField that produced this. */
  cacheKey: string
  /** normalisedValue → shapes[] */
  byValue: Map<JoinKey, MatchableShape[]>
}

const joinIndexCache = new WeakMap<readonly MatchableShape[], Map<string, JoinIndex>>()

/**
 * Compute or reuse the value→shape[] index for the given join spec.
 */
function getJoinIndex(
  targetKind: DataLinkConfig['targetKind'],
  join: NonNullable<DataLinkMatch['join']>,
  snapshot: MatchStoreSnapshot,
): JoinIndex {
  const shapes = shapesForKind(targetKind, snapshot)
  const cacheKey = `${targetKind}|${join.shapeFieldSource}|${join.shapeField ?? ''}`

  let perShapesCache = joinIndexCache.get(shapes)
  if (!perShapesCache) {
    perShapesCache = new Map()
    joinIndexCache.set(shapes, perShapesCache)
  }

  const existing = perShapesCache.get(cacheKey)
  if (existing && existing.binsRef === snapshot.bins) return existing

  // Rebuild.
  const byValue = new Map<JoinKey, MatchableShape[]>()
  const normalizedField = join.shapeField ? normalizeKey(join.shapeField) : ''

  for (const shape of shapes) {
    if (shape.id === undefined) continue
    const value = readShapeSide(shape, targetKind, join, snapshot.bins, normalizedField)
    if (value === undefined || value === null || value === '') continue
    const k = normalizeKey(value)
    if (!k) continue
    const list = byValue.get(k)
    if (list) list.push(shape)
    else byValue.set(k, [shape])
  }

  const idx: JoinIndex = {
    binsRef: snapshot.bins,
    shapesRef: shapes,
    cacheKey,
    byValue,
  }
  perShapesCache.set(cacheKey, idx)
  return idx
}

/**
 * Read the join value from a shape according to `shapeFieldSource`. For
 * bin-sourced lookups the associated bin is fetched via `binByShape`.
 */
function readShapeSide(
  shape: MatchableShape,
  targetKind: DataLinkConfig['targetKind'],
  join: NonNullable<DataLinkMatch['join']>,
  bins: readonly Bin[],
  normalizedCustomKey: string,
): unknown {
  switch (join.shapeFieldSource) {
    case 'name':
      return shape.name
    case 'role': {
      // Only polygon + circle carry `role`. Others return undefined.
      const r = (shape as { role?: string }).role
      return typeof r === 'string' ? r : undefined
    }
    case 'bin.externalCode': {
      if (shape.id === undefined) return undefined
      const b = binByShape(bins, targetKind, shape.id)
      return b?.externalCode
    }
    case 'bin.customProp': {
      if (!normalizedCustomKey || shape.id === undefined) return undefined
      const b = binByShape(bins, targetKind, shape.id)
      if (!b?.customProperties) return undefined
      // custom_properties keys are stored already-normalised.
      return b.customProperties[normalizedCustomKey]
    }
    default: {
      const _exhaustive: never = join.shapeFieldSource
      void _exhaustive
      return undefined
    }
  }
}

// -------------------------------------------------- effective match

/**
 * Return the config's match spec — falling back to legacy behaviour
 * (`targetShapeId` present → explicit-shape, otherwise coord) so v1
 * configs continue to render without a data migration.
 */
export function effectiveMatch(config: DataLinkConfig): DataLinkMatch {
  const m = config.fieldMapping?.match
  if (m && m.mode) return m
  if (config.targetShapeId) return { mode: 'explicit-shape' }
  return { mode: 'coord' }
}

// ----------------------------------------------------------- resolve

/**
 * Main entry point. Returns the shape[] the sub-renderer should draw
 * for this payload, or a coord to render at, or a `none` sentinel.
 */
export function resolveMatchTargets(
  payload: unknown,
  config: DataLinkConfig,
  snapshot: MatchStoreSnapshot,
): MatchResult {
  const match = effectiveMatch(config)

  switch (match.mode) {
    case 'coord': {
      const c = config.fieldMapping?.coordFields
      if (!c?.lng || !c?.lat) {
        return { kind: 'none', reason: 'coord mode: coordFields.lng/lat unset' }
      }
      const lng = Number(readPayloadPath(payload, c.lng))
      const lat = Number(readPayloadPath(payload, c.lat))
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return {
          kind: 'none',
          reason: `coord mode: payload missing/invalid ${c.lng}/${c.lat}`,
        }
      }
      return { kind: 'coord', position: [lng, lat] }
    }

    case 'explicit-shape': {
      const id = config.targetShapeId
      if (id === undefined) {
        return { kind: 'none', reason: 'explicit-shape: targetShapeId unset' }
      }
      const shapes = shapesForKind(config.targetKind, snapshot)
      const hit = shapes.find((s) => s.id === id)
      return hit
        ? { kind: 'shapes', shapes: [hit] }
        : { kind: 'none', reason: `explicit-shape: id ${id} not in store` }
    }

    case 'attribute-join':
    case 'external-code': {
      const join = match.mode === 'external-code'
        ? // Preset: same as attribute-join with a fixed shape side.
          {
            payloadField: match.join?.payloadField ?? 'external_code',
            shapeFieldSource: 'bin.externalCode' as const,
            shapeField: undefined,
          }
        : match.join

      if (!join?.payloadField || !join.shapeFieldSource) {
        return {
          kind: 'none',
          reason: `${match.mode}: join.payloadField / shapeFieldSource unset`,
        }
      }
      if (join.shapeFieldSource === 'bin.customProp' && !join.shapeField) {
        return {
          kind: 'none',
          reason: 'bin.customProp requires join.shapeField (the custom-attr key)',
        }
      }

      const rawPayloadValue = readPayloadPath(payload, join.payloadField)
      if (rawPayloadValue === undefined || rawPayloadValue === null || rawPayloadValue === '') {
        return {
          kind: 'none',
          reason: `${match.mode}: payload has no "${join.payloadField}"`,
        }
      }
      const k = normalizeKey(rawPayloadValue)
      if (!k) {
        return { kind: 'none', reason: `${match.mode}: normalized payload key is empty` }
      }

      const idx = getJoinIndex(config.targetKind, join, snapshot)
      const hits = idx.byValue.get(k)
      if (!hits || hits.length === 0) {
        return {
          kind: 'none',
          reason: `${match.mode}: no ${config.targetKind} where ${join.shapeFieldSource}${join.shapeField ? `(${join.shapeField})` : ''} = "${rawPayloadValue}"`,
        }
      }
      return { kind: 'shapes', shapes: hits }
    }

    default: {
      const _exhaustive: never = match.mode
      void _exhaustive
      return { kind: 'none', reason: `unknown match mode` }
    }
  }
}

/**
 * Convenience: get the coordinate for a `coord`-mode config or fall
 * through to null. Sub-renderers that used to read `coordFields`
 * directly can migrate to this without changing their code shape.
 */
export function resolvePayloadCoord(
  payload: unknown,
  config: DataLinkConfig,
): [number, number] | null {
  const result = resolveMatchTargets(payload, config, {
    // Coord mode doesn't touch the store; empty snapshot is fine.
    bins: [], polygons: [], markers: [], circles: [], lines: [],
    stairs: [], doors: [], images: [], imagePlanes: [], models: [], textLabels: [],
  })
  return result.kind === 'coord' ? result.position : null
}

// -------------------------------------------------------- introspect

export const _forTests = { normalizeKey, readPayloadPath, effectiveMatch }
