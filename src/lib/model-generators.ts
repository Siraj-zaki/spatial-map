/**
 * Helpers that translate a `ModelShape` (the saved Dexie row) into the
 * two payloads the source-driven overlay needs:
 *
 *   1. **`ModelEntry`** — the `(key, spec)` pair that goes into a
 *      Mapbox `type: 'model'` source's `models` map. Carries the URI,
 *      the lng/lat position, plus `materialOverrides` / `nodeOverrides`
 *      (the only knobs that read names lifted from the GLB itself).
 *
 *   2. **`ModelLayerPaint`** — the paint properties applied to the
 *      `model` layer that renders this shape's source. Each layer
 *      renders one instance so the paint values are constants per
 *      layer (rotation, scale, translation, global tint, emissive,
 *      opacity). The previous GeoJSON-driven pattern used
 *      `['get', ...]` data expressions over a shared layer; one
 *      layer per shape means we no longer need expressions and can
 *      push literals directly.
 *
 * Data-link integration:
 *   `extraProps` lets the overlay inject the matched bin's
 *   `customProperties` per shape. Conventional keys recognised at
 *   build time:
 *     - `status` (string): swapped to a tint via the rule engine
 *     - `tintColor` (string): direct override of the global tint
 *     - `emissive` (number 0..5): override emissive strength
 *     - `opacity` (number 0..100): override opacity
 *     - `active` (boolean): override active flag
 *     - `materialOverrides` (record): merged into the source entry's
 *        materialOverrides, with config values losing to extras
 *     - `nodeOverrides` (record): merged into the source entry's
 *        nodeOverrides
 *   Unknown keys are silently dropped — model sources don't have a
 *   feature-property passthrough the way GeoJSON layers did.
 */

import type {
  ModelMaterialOverride,
  ModelNodeOverride,
  ModelShape,
  ModelShapeConfig,
} from './shapes'

// ---------------------------------------------------------------------------
// Source entry — what lives in `models: { [key]: spec }`
// ---------------------------------------------------------------------------

/**
 * Mapbox model source entry shape. We type the bits we set so callers
 * can't accidentally drop a required field; everything else is
 * forwarded through `unknown` so newer Mapbox builds with extra fields
 * don't fight the type checker.
 */
export interface ModelSourceSpec {
  /** Absolute glTF/GLB URI. */
  uri: string
  /** Map position [lng, lat] (Mapbox accepts an optional altitude as `[lng, lat, alt]`). */
  position: [number, number] | [number, number, number]
  /** Per-axis orientation in degrees [pitch, yaw, roll]. Optional. */
  orientation?: [number, number, number]
  /** Per-material PBR overrides, keyed by material name. */
  materialOverrides?: Record<string, ModelMaterialOverride>
  /** Per-node overrides, keyed by node name. */
  nodeOverrides?: Record<string, ModelNodeOverride>
  /** Free-form passthrough so newer Mapbox fields can be forwarded. */
  [key: string]: unknown
}

export interface ModelEntry {
  /** Key inside the source's `models` map. We use `shape-<id>`. */
  key: string
  spec: ModelSourceSpec
}

// ---------------------------------------------------------------------------
// Layer paint — applied to the per-shape `model` layer
// ---------------------------------------------------------------------------

export interface ModelLayerPaint {
  /** Per-axis rotation in degrees. */
  'model-rotation': [number, number, number]
  /** Per-axis scale multiplier. */
  'model-scale': [number, number, number]
  /** Per-axis translation in meters [tx, ty, tz]. */
  'model-translation': [number, number, number]
  /** Hex tint blended over the model's source materials. */
  'model-color'?: string
  /** 0..1 intensity for the tint mix. */
  'model-color-mix-intensity'?: number
  /** 0..5 (HDR allowed) emissive boost. */
  'model-emissive-strength'?: number
  /**
   * 0..1 scalar OR a Mapbox expression. Expressions are only used for
   * the v5.5 facility-shell fade — everywhere else this is a plain
   * number. Typed as `unknown` because Mapbox's type surface for
   * expression-valued paint properties is untyped in the SDK.
   */
  'model-opacity'?: number | unknown
  /** Mapbox GL JS ≥ 3.x — model casts a shadow when a directional
   * light with `cast-shadows: true` is configured. */
  'model-cast-shadows'?: boolean
  /** Mapbox GL JS ≥ 3.x — model surfaces darken where other shadow
   * casters land on them. */
  'model-receive-shadows'?: boolean
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build the `(key, spec)` pair for a placed model shape's `model`
 * source. Returns null when the shape has no asset selected (in-flight
 * placement preview).
 *
 * Args:
 *   - `shape`: the ModelShape row.
 *   - `uri`: absolute URI for the asset (caller already resolved
 *     bundled/upload + made it absolute).
 *   - `opts.extraProps`: data-link override bag for this shape.
 *   - `opts.boundingCenter`: bbox centre in local meters (for scale-
 *     anchor compensation — applied via `model-translation` in the
 *     layer paint, not here).
 */
export function buildModelEntry(
  shape: ModelShape,
  uri: string,
  opts?: {
    extraProps?: Record<string, unknown>
    boundingCenter?: [number, number, number]
  },
): ModelEntry | null {
  if (!shape.config.modelAssetId) return null
  if (shape.id === undefined) return null

  // Merge the config's per-material/per-node overrides with any
  // extras pushed by the data-link layer. Extras win on conflict —
  // that matches the existing rule engine behaviour for tint / status.
  const merged = mergeOverrides(shape.config, opts?.extraProps)

  const spec: ModelSourceSpec = {
    uri,
    position: shape.position,
    orientation: shape.config.rotation,
  }
  if (Object.keys(merged.materialOverrides).length > 0) {
    spec.materialOverrides = merged.materialOverrides
  }
  if (Object.keys(merged.nodeOverrides).length > 0) {
    spec.nodeOverrides = merged.nodeOverrides
  }

  return {
    key: `shape-${shape.id}`,
    spec,
  }
}

/**
 * Build the paint object for the per-shape `model` layer.
 *
 * Why this is separate from `buildModelEntry`: Mapbox's model source
 * only carries position, orientation, and overrides. Per-instance
 * scale / translation / global tint / emissive / opacity live on the
 * layer's paint properties — which works cleanly here because each
 * layer renders exactly one model.
 */
/**
 * v5.5 — viewer chip override for a facility-shell model. Auto lets
 * the shell fade by zoom (the default paint expression). `shell-only`
 * pins it fully opaque; `interior-only` pins it fully transparent.
 * Applied AFTER the config-level opacity + facilityShell block, so
 * the chip always wins over the flag.
 */
export type FacilityShellOverride = 'auto' | 'shell-only' | 'interior-only'

export function buildModelLayerPaint(
  cfg: ModelShapeConfig,
  extraProps?: Record<string, unknown>,
  boundingCenter?: [number, number, number],
  bounds?: { min: [number, number, number]; max: [number, number, number] },
  facilityShellOverride: FacilityShellOverride = 'auto',
): ModelLayerPaint {
  // Translation has two responsibilities:
  //   1. Anchor the model at the user's placement point despite
  //      Mapbox scaling around the glTF's local (0,0,0).
  //   2. Lift the model to `cfg.elevation`.
  //
  // Horizontal (X, world lng and world lat): keep the model's bbox
  // CENTRE glued to the placement point. `-center * (scale - 1)` per
  // axis is the standard scale-anchor compensation.
  //
  // Vertical (Z, world altitude): keep the model's bbox BOTTOM at
  // the placement altitude. glTF is Y-up (see the spec) and Mapbox
  // auto-remaps Y-up → Z-up at render time, so the "bottom" in world
  // Z corresponds to the glTF `bounds.min[1]`. Anchoring the bottom
  // (instead of the centre) means:
  //   - `scale = 1`   → model rests on the ground at `elevation`
  //   - `scale = 0.1` → model shrinks in place, bottom stays on the
  //                     ground (previously it sank into the terrain
  //                     because centre-anchor pulled the model down
  //                     by half its shrunk height).
  //
  // Falls back to centre-anchor when bounds are unknown so pre-
  // bounds-aware uploads keep their old rendering.
  const center = boundingCenter ?? [0, 0, 0]
  // Off-origin meshes (e.g. Forklift (rigged) at Z=193 in glTF) need a
  // constant translation to bring the centre TO the origin BEFORE the
  // scale-anchor compensation. Adding `-center[i]` here does nothing
  // for models already centred (center=[0,0,0]) so it's a safe extension.
  //
  // The glTF spec says Y is up. Mapbox remaps Y-up → Z-up, so glTF Y
  // becomes world Z (altitude) and glTF Z becomes world Y (north-south).
  //   world X = glTF X → `center[0]` (east-west)
  //   world Y = glTF Z → `center[2]` (north-south)
  //   world Z = glTF Y → `center[1]` (altitude, then lift by `-upMin` so
  //                                   the bottom sits at `elevation`)
  const tx = -center[0] - center[0] * (cfg.scale[0] - 1)
  const ty = -center[2] - center[2] * (cfg.scale[1] - 1)
  const upMin = bounds?.min[1]
  const tz =
    upMin !== undefined
      ? cfg.elevation - upMin * cfg.scale[2]
      : cfg.elevation - center[1] * (cfg.scale[2] - 1)

  // Recognised data-link overrides — same set the GeoJSON pipeline
  // recognised before the source-driven rewrite.
  let color: string | undefined = cfg.color
  let colorMix: number = cfg.colorMix
  let emissive: number = cfg.emissive
  let opacity: number = cfg.opacity
  let active: boolean = cfg.active
  if (extraProps) {
    for (const [k, v] of Object.entries(extraProps)) {
      if (k === 'tintColor' && typeof v === 'string') {
        color = v
        if (colorMix < 1) colorMix = 1
      } else if (k === 'emissive' && typeof v === 'number') {
        emissive = v
      } else if (k === 'opacity' && typeof v === 'number') {
        opacity = v
      } else if (k === 'active' && typeof v === 'boolean') {
        active = v
      }
    }
  }
  // Inactive instances are dimmed and lose their emissive — matches
  // the legacy overlay behaviour.
  if (!active) {
    opacity = Math.min(opacity, 30)
    emissive = 0
  }

  // v5.5 — facility-shell fade. When the shell flag is on AND the
  // viewer chip isn't forcing shell-only/interior-only, swap the flat
  // opacity for a zoom-interpolated expression so the shell paints
  // opaque at low zoom and vanishes as the user zooms into the
  // interior. `shell-only` pins to config opacity; `interior-only`
  // pins to zero. The chip always wins over the flag.
  let modelOpacityPaint: unknown = opacity / 100
  const shell = cfg.facilityShell
  if (facilityShellOverride === 'shell-only' && shell?.enabled) {
    modelOpacityPaint = opacity / 100
  } else if (facilityShellOverride === 'interior-only' && shell?.enabled) {
    modelOpacityPaint = 0
  } else if (shell?.enabled) {
    const start = Number.isFinite(shell.fadeStartZoom) ? shell.fadeStartZoom : 16
    const end = Number.isFinite(shell.fadeEndZoom) ? shell.fadeEndZoom : 19
    // Guard against reversed / equal thresholds so the expression is
    // monotonic — Mapbox rejects duplicate stop inputs.
    const lo = Math.min(start, end)
    const hi = Math.max(start, end) === lo ? lo + 0.01 : Math.max(start, end)
    modelOpacityPaint = [
      'interpolate',
      ['linear'],
      ['zoom'],
      lo, opacity / 100,
      hi, 0,
    ]
  }

  return {
    'model-rotation': cfg.rotation,
    'model-scale': cfg.scale,
    'model-translation': [tx, ty, tz],
    'model-color': color,
    'model-color-mix-intensity': colorMix,
    'model-emissive-strength': emissive,
    // Stored as 0..100 percent — Mapbox's 'model-opacity' takes 0..1.
    'model-opacity': modelOpacityPaint,
    // Mapbox GL JS v3 native shadow stack — same directional light
    // configured in `mapbox-map.tsx` drives both fill-extrusion walls
    // and model meshes. Casting + receiving together is what makes a
    // 3D forklift / shelving / desk look grounded instead of floating;
    // Mappedin and the other pro indoor viewers rely on this pair too.
    // Unknown properties are silently ignored on older GL JS builds,
    // so this is safe to set unconditionally.
    'model-cast-shadows': true,
    'model-receive-shadows': true,
  }
}

// ---------------------------------------------------------------------------
// Override merging
// ---------------------------------------------------------------------------

interface MergedOverrides {
  materialOverrides: Record<string, ModelMaterialOverride>
  nodeOverrides: Record<string, ModelNodeOverride>
}

function mergeOverrides(
  cfg: ModelShapeConfig,
  extraProps?: Record<string, unknown>,
): MergedOverrides {
  const materialOverrides: Record<string, ModelMaterialOverride> = {
    ...(cfg.materialOverrides ?? {}),
  }
  const nodeOverrides: Record<string, ModelNodeOverride> = {
    ...(cfg.nodeOverrides ?? {}),
  }
  if (extraProps) {
    const mExtras = extraProps.materialOverrides
    if (isRecord(mExtras)) {
      for (const [name, override] of Object.entries(mExtras)) {
        if (!isRecord(override)) continue
        materialOverrides[name] = {
          ...(materialOverrides[name] ?? {}),
          ...(override as Partial<ModelMaterialOverride>),
        }
      }
    }
    const nExtras = extraProps.nodeOverrides
    if (isRecord(nExtras)) {
      for (const [name, override] of Object.entries(nExtras)) {
        if (!isRecord(override)) continue
        nodeOverrides[name] = {
          ...(nodeOverrides[name] ?? {}),
          ...(override as Partial<ModelNodeOverride>),
        }
      }
    }
  }
  return { materialOverrides, nodeOverrides }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
