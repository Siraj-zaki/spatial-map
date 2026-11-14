/**
 * Focus mode — fading shapes without touching a layer constant.
 *
 * `fill-extrusion-opacity` is a per-LAYER constant in GL JS (no data
 * expressions), which is why the shape overlays split each kind into
 * opacity-bucket layers (`…-op0 … -op100`) selected by a stamped
 * `opacityBucket`. Fading one shape therefore means MOVING it to another
 * bucket layer: re-stamp `opacity` / `opacityBucket` on its feature and
 * push the collection again. The helpers here do that as a copy-on-write
 * post-pass over the overlay's cached collection:
 *
 *  - unchanged features keep their identity (diff writers / per-feature
 *    caches downstream stay valid),
 *  - a faded copy is cached per (feature, factor), so the same focus
 *    state hands back the same objects,
 *  - with nothing to change the INPUT collection object itself comes
 *    back, so an overlay's "same collection → skip setData" check makes
 *    focus-off cost nothing.
 *
 * Layer constants never change, so the translucent-layer ordering never
 * moves. Grids can't be re-stamped (30k-cell sources), so they hide the
 * shape in its bucket layer with a feature-state "lift" instead
 * (`withFocusLift`, GL 3.25 only) and draw it on a twin layer.
 */

import mapboxgl, { type ExpressionSpecification } from 'mapbox-gl'

import type { LiftMeshData } from '@/lib/lift-mesh-layer'

/** What a bucketed shape feature carries (polygon / circle / line props). */
export interface FadeableProps {
  /** User opacity, 0–100. */
  opacity: number
  /** `opacity` rounded to a multiple of 10 — picks the bucket layer. */
  opacityBucket: number
  /** Drawn by a mesh layer; the feature is only a hit target (bucket 0). */
  meshed?: boolean
}

function bucketOf(opacityPercent: number): number {
  return Math.max(0, Math.min(100, Math.round(opacityPercent / 10) * 10))
}

/**
 * opacity' = opacity*factor; bucket' = opacity>=10 ? clamp(round(opacity'/10)*10, 10, 100) : original bucket.
 *
 * The floor of 10 keeps a faded shape out of bucket 0 (the hit-only /
 * invisible bucket): a ghosted wall must stay faintly drawn.
 */
export function fadedOpacity(opacityPercent: number, factor: number): { opacity: number; opacityBucket: number } {
  const opacity = opacityPercent * factor
  const opacityBucket =
    opacityPercent >= 10 ? Math.max(10, Math.min(100, Math.round(opacity / 10) * 10)) : bucketOf(opacityPercent)
  return { opacity, opacityBucket }
}

type AnyFeature = GeoJSON.Feature<GeoJSON.Geometry, GeoJSON.GeoJsonProperties>

/** feature → factor → faded copy. */
const fadeCache = new WeakMap<object, Map<number, AnyFeature>>()

/**
 * One feature faded whole by `factor` — exactly what `fadeFeatureCollection`
 * does per feature (meshed: opacity only; else opacity and bucket, floor
 * 10). The same copy for the same (feature, factor); `f` itself when
 * nothing changes.
 */
export function fadedFeature<G extends GeoJSON.Geometry, P extends FadeableProps>(
  f: GeoJSON.Feature<G, P>,
  factor: number,
): GeoJSON.Feature<G, P> {
  const props = f.properties
  if (!props) return f
  const opacity = props.opacity
  if (typeof opacity !== 'number' || !Number.isFinite(opacity)) return f
  let byFactor = fadeCache.get(f)
  const hit = byFactor?.get(factor)
  if (hit) return hit as unknown as GeoJSON.Feature<G, P>
  let nextOpacity: number
  let nextBucket: number
  if (props.meshed) {
    // Meshed shapes draw through a mesh layer that reads `opacity`; the
    // feature itself stays a bucket-0 hit target.
    nextOpacity = opacity * factor
    nextBucket = props.opacityBucket
  } else {
    const faded = fadedOpacity(opacity, factor)
    nextOpacity = faded.opacity
    // Below 10 % the generator's own bucket stands (overrides may have
    // stamped it from a different opacity than `opacity`).
    nextBucket = opacity >= 10 ? faded.opacityBucket : props.opacityBucket
  }
  if (nextOpacity === opacity && nextBucket === props.opacityBucket) return f
  const copy: GeoJSON.Feature<G, P> = {
    ...f,
    properties: { ...props, opacity: nextOpacity, opacityBucket: nextBucket },
  }
  if (!byFactor) {
    byFactor = new Map()
    fadeCache.set(f, byFactor)
  }
  byFactor.set(factor, copy as unknown as AnyFeature)
  return copy
}

/**
 * Copy-on-write fade. factor 1 → feature kept by identity; returns `fc`
 * ITSELF when every factor is 1. meshed features: opacity faded,
 * opacityBucket unchanged (stay 0). Faded copies cached per (feature, factor).
 */
export function fadeFeatureCollection<G extends GeoJSON.Geometry, P extends FadeableProps>(
  fc: GeoJSON.FeatureCollection<G, P>,
  factorOf: (f: GeoJSON.Feature<G, P>) => number,
): GeoJSON.FeatureCollection<G, P> {
  const features = fc.features
  let out: GeoJSON.Feature<G, P>[] | null = null
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    const factor = factorOf(f)
    const g = factor === 1 || !Number.isFinite(factor) ? f : fadedFeature(f, factor)
    if (out === null) {
      if (g === f) continue
      out = features.slice(0, i)
    }
    out.push(g)
  }
  return out === null ? fc : { ...fc, features: out }
}

/** feature → tag → patched copy. */
const patchCache = new WeakMap<object, Map<string, AnyFeature>>()

/**
 * Generic copy-on-write property patch: tagOf null → unchanged; patched
 * copies cached per (feature, tag); `patch` must be pure in (props, tag).
 * Returns `fc` itself when nothing is patched.
 *
 * The cache is keyed by (feature, tag) only, so a tag must say everything
 * its patch writes — namespace tags per purpose (e.g. `tier:near`,
 * `dl:focused`) when one feature can go through two different patches.
 */
export function patchFeatureCollection<G extends GeoJSON.Geometry, P extends GeoJSON.GeoJsonProperties>(
  fc: GeoJSON.FeatureCollection<G, P>,
  tagOf: (f: GeoJSON.Feature<G, P>) => string | null,
  patch: (props: P, tag: string) => P,
): GeoJSON.FeatureCollection<G, P> {
  const features = fc.features
  let out: GeoJSON.Feature<G, P>[] | null = null
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    const tag = tagOf(f)
    let g = f
    if (tag !== null) {
      let byTag = patchCache.get(f)
      const hit = byTag?.get(tag)
      if (hit) {
        g = hit as unknown as GeoJSON.Feature<G, P>
      } else {
        g = { ...f, properties: patch(f.properties, tag) }
        if (!byTag) {
          byTag = new Map()
          patchCache.set(f, byTag)
        }
        byTag.set(tag, g as unknown as AnyFeature)
      }
    }
    if (out === null) {
      if (g === f) continue
      out = features.slice(0, i)
    }
    out.push(g)
  }
  return out === null ? fc : { ...fc, features: out }
}

const meshCache = new WeakMap<LiftMeshData, Map<number, LiftMeshData>>()

/**
 * Same key/positions/normals, colours alpha × factor; cached per (mesh,
 * factor); factor 1 → mesh itself. Route the result to a translucent
 * mesh-layer instance (a faded solid must not write depth as if opaque).
 */
export function fadeMeshData(mesh: LiftMeshData, factor: number): LiftMeshData {
  if (factor === 1 || !Number.isFinite(factor)) return mesh
  let byFactor = meshCache.get(mesh)
  const hit = byFactor?.get(factor)
  if (hit) return hit
  const colors = new Float32Array(mesh.colors)
  for (let i = 3; i < colors.length; i += 4) colors[i] *= factor
  const faded: LiftMeshData = { ...mesh, colors }
  if (!byFactor) {
    byFactor = new Map()
    meshCache.set(mesh, byFactor)
  }
  byFactor.set(factor, faded)
  return faded
}

/**
 * True only on GL JS 3.25.x: its fill-extrusion shaders drop a feature
 * whose colour alpha is 0, which is what `withFocusLift` relies on to
 * hide one grid out of a bucket layer without re-stamping its source.
 * Same audited-version gate as `mapbox-tile-cover.ts`.
 */
export function canLiftExtrusions(): boolean {
  const version = (mapboxgl as unknown as { version?: unknown }).version
  return typeof version === 'string' && version.startsWith('3.25.')
}

export const FOCUS_LIFT_STATE = 'focusLift'

/**
 * ['case', ['boolean', ['feature-state', 'focusLift'], false], 'rgba(0,0,0,0)', color]
 *
 * Wrap a bucket layer's `fill-extrusion-color` once, at install. With no
 * feature carrying the state it evaluates to `color` everywhere — the
 * same picture as before.
 */
export function withFocusLift(color: unknown): ExpressionSpecification {
  return ['case', ['boolean', ['feature-state', FOCUS_LIFT_STATE], false], 'rgba(0,0,0,0)', color]
}
