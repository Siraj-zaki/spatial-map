/**
 * Text-label geometry helpers.
 *
 * Text labels are anchored Point features rendered through a native
 * Mapbox `symbol` layer. The overlay's paint expressions read every
 * per-feature property via `['get', ...]`, so adding/removing a label
 * just re-emits the FeatureCollection — there is no layer config to
 * rebroadcast.
 *
 * "Effects" (halo + emissive + occlusion) flow through `TextEffectPreset`
 * — the preset gets resolved to concrete numeric values at build time so
 * the layer paint expressions stay simple `get`s.
 */

import type { Feature, FeatureCollection, Point } from 'geojson'
import type {
  TextAlignment,
  TextAnchor,
  TextEffectPreset,
  TextLabelConfig,
  TextLabelShape,
} from './shapes'

/** Stamped per-feature so paint expressions can read via `['get', ...]`. */
export interface TextLabelProps {
  id: string
  textLabelId?: number
  text: string
  size: number
  color: string
  opacity: number
  /** 0..100 percent rounded to a 10-step bucket (see overlay docstring). */
  opacityBucket: number
  haloColor: string
  haloWidth: number
  haloBlur: number
  emissive: number
  /** Lift altitude in METERS — read by the symbol layer's z-offset. */
  elevation: number
  /** 0..1 — `text-occlusion-opacity` per feature (Mapbox 3.5+). */
  occlusionOpacity: number
  /**
   * Per-feature pitch/rotation alignment. Routes the feature to the
   * matching constant-alignment symbol layer at render time
   * (Mapbox rejects data expressions on these layout properties).
   */
  pitchAlignment: TextAlignment
  anchor: TextAnchor
  /**
   * Plain font weight enum stamped on the feature. The overlay's
   * `text-font` paint expression uses `match` against this string,
   * with each branch wrapped in `['literal', [...]]` — Mapbox
   * requires text-font output values to be literals.
   */
  fontWeight: 'regular' | 'bold' | 'italic'
  letterSpacing: number
  transform: 'none' | 'uppercase' | 'lowercase'
  /**
   * Resolved size behaviour stamped per feature so the shared symbol
   * layer's text-size expression can pick between the three branches
   * (screen / fixed / shape) via a single `case` on this property.
   * Legacy `config.fixedSize: true` rows resolve to 'fixed' here.
   */
  sizeMode: 'screen' | 'fixed' | 'shape'
  rotation: number
  preview?: boolean
}

export type TextLabelFeature = Feature<Point, TextLabelProps>

function opacityBucketFor(opacity: number): number {
  return Math.max(0, Math.min(100, Math.round((opacity ?? 100) / 10) * 10))
}

/**
 * Mapbox-available font stacks. Each style ships glyphs for these
 * fonts, with the next entry used as fallback. The overlay re-builds
 * these literally inside its `text-font` match expression — Mapbox
 * rejects data expressions whose output isn't a literal, so we can't
 * `['get', 'font']` an array off the feature properties.
 *
 * Kept here as a single source of truth so the overlay and any
 * future tooling agree on which fonts ship with the styles we use.
 */
export const TEXT_FONT_STACKS = {
  regular: ['Open Sans Regular', 'Arial Unicode MS Regular'],
  bold: ['Open Sans Bold', 'Arial Unicode MS Bold'],
  italic: ['Open Sans Italic', 'Arial Unicode MS Regular'],
} as const

/**
 * Apply the visual preset on top of the user's config. The preset only
 * overrides fields it cares about — `'normal'` returns the config
 * unchanged so custom tweaks aren't wiped by re-selecting it.
 */
export function applyPreset(
  cfg: TextLabelConfig,
  preset: TextEffectPreset = cfg.preset,
): TextLabelConfig {
  switch (preset) {
    case 'glow':
      return {
        ...cfg,
        haloColor: cfg.haloColor === '#ffffff' ? '#fde047' : cfg.haloColor,
        haloWidth: Math.max(cfg.haloWidth, 2),
        haloBlur: Math.max(cfg.haloBlur, 1.5),
        emissive: Math.max(cfg.emissive, 1.8),
      }
    case 'outlined':
      return {
        ...cfg,
        haloColor: '#000000',
        haloWidth: Math.max(cfg.haloWidth, 1.5),
        haloBlur: 0,
        emissive: 1,
      }
    case 'subtle':
      return {
        ...cfg,
        haloColor: '#ffffff',
        haloWidth: 1,
        haloBlur: 0.5,
        emissive: 0.4,
        opacity: Math.min(cfg.opacity, 80),
      }
    case 'sign':
      // "Sign" reads as an opaque rectangle vibe: heavy halo with no
      // blur, full emissive so it stays readable on dark map styles.
      return {
        ...cfg,
        haloColor: '#ffffff',
        haloWidth: 3,
        haloBlur: 0,
        emissive: 1.4,
      }
    case 'normal':
    default:
      return cfg
  }
}

function transformText(text: string, transform: 'none' | 'uppercase' | 'lowercase'): string {
  if (transform === 'uppercase') return text.toUpperCase()
  if (transform === 'lowercase') return text.toLowerCase()
  return text
}

function propsFor(
  id: string,
  cfg: TextLabelConfig,
  rotation: number,
  textLabelId?: number,
  preview = false,
): TextLabelProps {
  const resolved = applyPreset(cfg)
  return {
    id,
    textLabelId,
    text: transformText(resolved.text, resolved.transform),
    size: resolved.size,
    color: resolved.color,
    opacity: resolved.opacity,
    opacityBucket: opacityBucketFor(resolved.opacity),
    haloColor: resolved.haloColor,
    haloWidth: resolved.haloWidth,
    haloBlur: resolved.haloBlur,
    emissive: resolved.emissive,
    elevation: resolved.elevation,
    occlusionOpacity: Math.max(0, Math.min(1, resolved.occlusionOpacity)),
    pitchAlignment: resolved.pitchAlignment,
    anchor: resolved.anchor,
    fontWeight: resolved.fontWeight,
    letterSpacing: resolved.letterSpacing,
    transform: resolved.transform,
    // sizeMode wins if set; otherwise honour the legacy fixedSize
    // boolean (true = 'fixed'); default is the classic 'screen' curve.
    sizeMode: resolved.sizeMode ?? (resolved.fixedSize ? 'fixed' : 'screen'),
    rotation,
    preview,
  }
}

export function buildTextLabelFeature(
  shape: TextLabelShape,
  opts?: { preview?: boolean },
): TextLabelFeature | null {
  if (!shape.position) return null
  return {
    type: 'Feature',
    properties: propsFor(
      `text-${shape.id ?? 'preview'}`,
      shape.config,
      shape.rotation,
      shape.id,
      opts?.preview ?? false,
    ),
    geometry: { type: 'Point', coordinates: shape.position },
  }
}

/** Style-rule override schema, mirroring the other shape kinds. */
export interface TextLabelStyleOverride {
  /** Text color. */
  fillColor?: string
  /** 0..100. */
  fillOpacity?: number
  /** Halo color. */
  borderColor?: string
  /** Halo width in px. */
  borderWidth?: number
  elevation?: number
  labelColor?: string
  labelText?: string
}

function applyOverrideProps(
  base: TextLabelProps,
  override: TextLabelStyleOverride,
): TextLabelProps {
  const p = { ...base }
  if (override.fillColor !== undefined) p.color = override.fillColor
  if (override.fillOpacity !== undefined) {
    p.opacity = override.fillOpacity
    p.opacityBucket = opacityBucketFor(override.fillOpacity)
  }
  if (override.borderColor !== undefined) p.haloColor = override.borderColor
  if (override.borderWidth !== undefined) p.haloWidth = override.borderWidth
  if (override.elevation !== undefined) p.elevation = override.elevation
  if (override.labelColor !== undefined) p.color = override.labelColor
  if (override.labelText !== undefined) p.text = override.labelText
  return p
}

export function buildTextLabelFeatureCollection(
  shapes: ReadonlyArray<TextLabelShape>,
  extras?: ReadonlyMap<number, TextLabelStyleOverride> | null,
): FeatureCollection<Point, TextLabelProps> {
  const features: TextLabelFeature[] = []
  for (const s of shapes) {
    if (s.visible === false) continue
    const f = buildTextLabelFeature(s)
    if (!f) continue
    const override = s.id !== undefined ? extras?.get(s.id) : undefined
    features.push(
      override
        ? { ...f, properties: applyOverrideProps(f.properties, override) }
        : f,
    )
  }
  return { type: 'FeatureCollection', features }
}

/** Live-preview feature built from the current cursor + draft config. */
export function buildTextLabelPreviewFeature(
  position: [number, number],
  config: TextLabelConfig,
  rotation = 0,
): TextLabelFeature {
  return {
    type: 'Feature',
    properties: propsFor('text-preview', config, rotation, undefined, true),
    geometry: { type: 'Point', coordinates: position },
  }
}
