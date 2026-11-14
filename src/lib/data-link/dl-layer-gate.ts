/**
 * Which `dl-*` layers draw nothing, for the empty-layer gate
 * (`src/lib/empty-layer-gate.ts`).
 *
 * The gate already hides a layer whose source holds no feature. These
 * helpers cover the layers that sit on a populated source but whose own
 * `filter` can never pass a feature, which Mapbox would otherwise
 * re-evaluate and run through symbol placement on every frame.
 *
 * Today that is the point-at-coord / history-movement bubble pair
 * (`dl-<id>-cluster`, `dl-<id>-cluster-count`) of a config that names a
 * `clusterGroupField` but leaves `style.cluster` off: the install adds
 * both layers with the manual-cluster filter whenever a group field is
 * set, while `buildCoordFeatures` only aggregates bubbles when
 * `style.cluster === true`. Every seeded history-movement layer is
 * configured like that (two per facility on Retail Mart and Silverbay).
 *
 * The point source is `dynamic` and written with diff-only `updateData`
 * calls, so the gate can't run a predicate over it; the overlay hints the
 * layers instead (`hintLayerEmpty`). A hint only ever HIDES a layer when
 * the install-time config guarantees no bubble can be built, and any push
 * that does carry a bubble clears it again before the write lands, so a
 * bubble is never held back.
 */

import type { DataLinkConfig } from '@/lib/db'

/**
 * Mirrors the manual-cluster bubble layers' filter,
 * `['==', ['get', 'manualCluster'], true]` (strict: a missing property
 * reads as null).
 */
export function passesManualClusterFilter(
  feature: { properties?: Record<string, unknown> | null },
): boolean {
  return feature.properties?.manualCluster === true
}

/**
 * True when a point-at-coord install for `config` adds the manual-cluster
 * bubble layers (a `clusterGroupField` is set) but `buildCoordFeatures`
 * can never emit a feature that passes their filter (`style.cluster` is
 * not `true`). The install effect re-runs whenever `style.cluster`
 * changes, so this holds for the lifetime of the layers it installs.
 */
export function manualClusterLayersAlwaysEmpty(
  config: Pick<DataLinkConfig, 'fieldMapping' | 'style'>,
): boolean {
  return !!config.fieldMapping.clusterGroupField && config.style.cluster !== true
}

/** True when at least one of `features` would be drawn by the bubble layers. */
export function anyManualClusterFeature(
  features: ReadonlyArray<{ properties?: Record<string, unknown> | null }>,
): boolean {
  for (const f of features) if (passesManualClusterFilter(f)) return true
  return false
}
