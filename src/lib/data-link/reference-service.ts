/**
 * Phase 6 — reference graph service.
 *
 * The first time the data plane lets entities point at each other.
 * Sits orthogonally to the entity tables (assets / sensors / bins /
 * shipments / cameras) — every entity stays narrow and typed, and
 * cross-entity facts live in `references` as `(type, sourceKey,
 * targetKey, label?, payload?)` rows.
 *
 * The convention is **kebab-case type tags** and **opaque string
 * keys** so heterogeneous identifier spaces compose:
 *
 *   sku-supplier        : SKU code        → supplier code
 *   asset-operator      : asset id        → user id
 *   sensor-mounted-bin  : sensor id       → bin id  ("polygon:42")
 *   bin-batch           : bin externalCode → batch number
 *
 * A reference resolver follows links recursively (`bin → SKU → supplier`)
 * up to a small depth bound so popups can present the full provenance
 * without pulling the entire graph.
 */

import { apiDb } from '@/lib/api-db'
import type { Reference } from '@/lib/db'

const MAX_RESOLVE_DEPTH = 4

// =========================================================== CRUD

export async function addReference(input: Omit<Reference, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
  const now = new Date()
  return await apiDb.references.add({
    ...input,
    createdAt: now,
    updatedAt: now,
  })
}

/**
 * Upsert by `[type+sourceKey]`. Same row idempotently rewritten on
 * repeated calls — convenient for ingest pipelines that just want
 * "make sure this link exists".
 */
export async function upsertReference(
  input: Omit<Reference, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<number> {
  const now = new Date()
  const existing = await apiDb.references
    .where('[type+sourceKey]')
    .equals([input.type, input.sourceKey])
    .first()
  if (existing && existing.id !== undefined) {
    await apiDb.references.update(existing.id, {
      targetKey: input.targetKey,
      label: input.label ?? existing.label,
      payload: input.payload ?? existing.payload,
      sourceStreamId: input.sourceStreamId ?? existing.sourceStreamId,
      updatedAt: now,
    })
    return existing.id
  }
  return await apiDb.references.add({
    ...input,
    createdAt: now,
    updatedAt: now,
  })
}

export async function deleteReference(id: number): Promise<void> {
  await apiDb.references.delete(id)
}

export async function deleteReferencesForStream(sourceStreamId: number): Promise<void> {
  const rows = await apiDb.references.where('sourceStreamId').equals(sourceStreamId).toArray()
  await Promise.all(rows.map((row) => (row.id !== undefined ? apiDb.references.delete(row.id) : Promise.resolve())))
}

export async function listReferences(): Promise<Reference[]> {
  return apiDb.references.toArray()
}

/** Find every reference whose `sourceKey` matches. Useful for "outgoing edges". */
export async function referencesFrom(sourceKey: string): Promise<Reference[]> {
  return apiDb.references.where('sourceKey').equals(sourceKey).toArray()
}

/** Reverse lookup — every reference whose `targetKey` matches. */
export async function referencesTo(targetKey: string): Promise<Reference[]> {
  return apiDb.references.where('targetKey').equals(targetKey).toArray()
}

// =========================================================== resolve

/**
 * Single-hop lookup. Returns the row whose `[type+sourceKey]` matches,
 * or null when none exists.
 */
export async function resolveReference(
  type: string,
  sourceKey: string,
): Promise<Reference | null> {
  return (await apiDb.references.where('[type+sourceKey]').equals([type, sourceKey]).first()) ?? null
}

/**
 * Walk the graph from a starting `sourceKey`, following references
 * whose `sourceKey` matches the current cursor's `targetKey`. Cap at
 * `MAX_RESOLVE_DEPTH` hops so a cycle can't lock the popup.
 *
 * Returns the ordered chain of references followed. The caller picks
 * which fields it wants from each hop for rendering.
 */
export async function resolveReferenceChain(
  type: string,
  sourceKey: string,
): Promise<Reference[]> {
  const chain: Reference[] = []
  let cursorKey: string | null = sourceKey
  const cursorType = type
  const seen = new Set<string>()
  for (let i = 0; i < MAX_RESOLVE_DEPTH; i++) {
    if (cursorKey === null) break
    const dedupeKey = `${cursorType}|${cursorKey}`
    if (seen.has(dedupeKey)) break
    seen.add(dedupeKey)
    const hop = await resolveReference(cursorType, cursorKey)
    if (!hop) break
    chain.push(hop)
    // Move forward: by default, follow links of the *same* type. A
    // future variant could parameterise the type transition (e.g.
    // sku→supplier then supplier→address) but we keep it simple in
    // Phase 6a.
    cursorKey = hop.targetKey
  }
  return chain
}

/**
 * Convenience: collect the labels along a chain into a readable
 * provenance string for the popup. Returns `[hop1.label, hop2.label,
 * …]` with `targetKey` as the fallback when a label is missing.
 */
export async function resolveReferenceLabels(
  type: string,
  sourceKey: string,
): Promise<string[]> {
  const chain = await resolveReferenceChain(type, sourceKey)
  return chain.map((hop) => hop.label ?? hop.targetKey)
}
