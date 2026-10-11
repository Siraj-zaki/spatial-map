import type { Map as MapboxMapInstance } from 'mapbox-gl'

/**
 * Shared transform-handle rendering for the editor overlays.
 *
 * Every shape overlay that supports the move / rotate / scale
 * side-panel actions needs to render a draggable handle at the shape's
 * anchor point. Historically each overlay drew a `type: 'circle'` dot
 * hardcoded to Mapbox's orange (`#fbb03b`). That had three problems:
 *
 *   1. `circle` layers in Mapbox 3.25 have no `circle-z-offset`, so
 *      handles for elevated shapes (a floor plan at 4 m, a polygon at
 *      rooftop, etc.) always rendered on the ground plane. The user
 *      then had to click on empty ground to grab a handle for a shape
 *      that visually sat 4 m above.
 *   2. Even at ground level, the `circle` handle participates in the
 *      normal depth test, so a 3D fill-extrusion at the same elevation
 *      occluded it. Rotating a floor plan next to a rack made the
 *      handle disappear behind the rack.
 *   3. The hardcoded orange ignored the app's theme palette + light /
 *      dark mode. Any user who picked a non-orange palette had UI
 *      chrome (buttons, selected rows, focus rings) in their palette
 *      color and transform handles in orange — visually incoherent.
 *
 * This module solves all three at once by:
 *
 *   - Rendering handles via `type: 'symbol'` with `icon-image`, which
 *     supports both `symbol-z-offset` (place at the shape's altitude)
 *     and `symbol-z-elevate: true` (always drawn above 3D content).
 *   - Generating the icons as canvas bitmaps painted with the current
 *     theme's `--primary` colour so they match the rest of the UI.
 *   - Subscribing to `<html>` classlist changes so a live palette / mode
 *     swap re-renders the icons without needing to reselect the shape.
 *
 * Each icon carries a distinct glyph so the user can tell at a glance
 * which action they're about to perform:
 *
 *   - `move`   → four-directional cross-arrow ("drag to translate")
 *   - `rotate` → curved rotation arrow ("drag around center")
 *   - `scale`  → diagonal double-arrow ("drag to resize corner")
 *
 * The icons are 40×40 CSS px rendered at 2× DPR for retina, with a soft
 * outer glow so they read on any basemap colour + a bright white glyph
 * for maximum contrast.
 *
 * Any overlay wanting to adopt the pattern:
 *
 * ```ts
 * const [primaryHex, setPrimaryHex] = useState(readThemePrimaryHex())
 * useEffect(() => subscribeThemeChanges(() => setPrimaryHex(readThemePrimaryHex())), [])
 * useEffect(() => {
 *   if (!map || !styleLoaded) return
 *   registerTransformHandleIcons(map, primaryHex)
 * }, [map, styleLoaded, primaryHex])
 * ```
 *
 * The overlay's transform layer then declares:
 *
 * ```ts
 * type: 'symbol',
 * layout: {
 *   'icon-image': ['coalesce', ['get', 'iconId'], TRANSFORM_ICON.move],
 *   'icon-size': 1,
 *   'icon-allow-overlap': true,
 *   'icon-ignore-placement': true,
 *   'symbol-z-elevate': true,
 * },
 * paint: {
 *   'icon-emissive-strength': 1,
 *   'symbol-z-offset': ['coalesce', ['get', 'elevation'], 0],
 * },
 * ```
 *
 * with the transform feature stamped `{ iconId: TRANSFORM_ICON[kind], elevation, kind }`.
 */

export type TransformHandleKind =
  | 'move'
  | 'rotate'
  | 'scale'
  /**
   * Solid theme-primary dot — grab-to-drag a specific polygon /
   * grid vertex. Rendered smaller than move/rotate/scale (no glyph
   * inside the disk) so many can appear together without clutter.
   */
  | 'vertex'
  /**
   * Hollow theme-primary ring — click to INSERT a new vertex at
   * the midpoint of an edge. Visually secondary to `vertex` so
   * users distinguish "grab" from "add" at a glance.
   */
  | 'midpoint'

/**
 * Mapbox icon-image ids for every handle glyph. Kept as constants
 * (not derived from a template) so consumers can reference them by
 * name in expressions and TS catches typos.
 */
export const TRANSFORM_ICON: Record<TransformHandleKind, string> = {
  move: 'sgv-transform-handle-move',
  rotate: 'sgv-transform-handle-rotate',
  scale: 'sgv-transform-handle-scale',
  vertex: 'sgv-transform-handle-vertex',
  midpoint: 'sgv-transform-handle-midpoint',
}

const ICON_SIZE_CSS = 40
const ICON_DPR = 2
const ICON_SIZE_PX = ICON_SIZE_CSS * ICON_DPR

/**
 * Read the current theme's `--primary` CSS variable and return it as a
 * `#rrggbb` hex string. `--primary` is stored as an HSL triple ("221 83%
 * 53%"); we convert to hex so Mapbox paint props consume it directly.
 *
 * Falls back to a neutral zinc for SSR / uninitialised styles.
 */
/** Any `--token` from the active theme as hex (fallback when unset). */
export function readThemeTokenHex(token: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim()
  const parsed = raw ? parseHslTriple(raw) : null
  return parsed ? hslToHex(parsed.h, parsed.s, parsed.l) : fallback
}

export function readThemePrimaryHex(): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return '#18181b'
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--primary')
    .trim()
  if (!raw) return '#18181b'
  const parsed = parseHslTriple(raw)
  if (!parsed) return '#18181b'
  return hslToHex(parsed.h, parsed.s, parsed.l)
}

/**
 * Read `--primary-foreground` (the readable colour on top of `--primary`)
 * and return as hex. Used for the icon glyph so it contrasts against the
 * disk regardless of palette (light palettes have dark foreground; dark
 * palettes have light foreground).
 */
export function readThemePrimaryForegroundHex(): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return '#fafafa'
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--primary-foreground')
    .trim()
  if (!raw) return '#fafafa'
  const parsed = parseHslTriple(raw)
  if (!parsed) return '#fafafa'
  return hslToHex(parsed.h, parsed.s, parsed.l)
}

/**
 * Read `--foreground` (the theme's body text colour) as hex. Used where
 * geometry has to be legible against the basemap but carries no colour
 * of its own — CAD linework whose drawing left it ByLayer, for
 * instance. Tracks light/dark, so a plan stays readable on both.
 */
export function readThemeForegroundHex(): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return '#18181b'
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--foreground')
    .trim()
  if (!raw) return '#18181b'
  const parsed = parseHslTriple(raw)
  if (!parsed) return '#18181b'
  return hslToHex(parsed.h, parsed.s, parsed.l)
}

/**
 * Subscribe to theme changes (palette pick, light/dark toggle). Both
 * axes swap classes on `<html>` — the ThemeProvider adds/removes
 * `light`/`dark` and `theme-<id>` — so a single MutationObserver on
 * class attribute changes catches everything.
 *
 * Returns a cleanup function.
 */
export function subscribeThemeChanges(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {}
  }
  const root = document.documentElement
  const obs = new MutationObserver(() => cb())
  obs.observe(root, { attributes: true, attributeFilter: ['class'] })
  return () => obs.disconnect()
}

/**
 * Register the three transform-handle icons on the map, tinted with the
 * given primary colour. Safe to call repeatedly — existing images with
 * the same id are replaced, which triggers Mapbox to redraw any symbol
 * layer using them. That's how live theme swaps propagate without any
 * per-layer paint updates.
 */
export function registerTransformHandleIcons(
  map: MapboxMapInstance,
  primaryHex: string,
  foregroundHex: string,
): void {
  for (const kind of [
    'move',
    'rotate',
    'scale',
    'vertex',
    'midpoint',
  ] as const) {
    const iconId = TRANSFORM_ICON[kind]
    const image = renderHandleIcon(kind, primaryHex, foregroundHex)
    if (!image) continue
    try {
      if (map.hasImage(iconId)) {
        map.updateImage(iconId, image)
      } else {
        map.addImage(iconId, image, { pixelRatio: ICON_DPR })
      }
    } catch (err) {
      if (import.meta.env.DEV) {
        console.debug('[map-transform-handles] registerIcon failed', iconId, err)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Canvas painter
// ---------------------------------------------------------------------------

/**
 * Paint one handle icon into an offscreen canvas and return an ImageData
 * ready for `map.addImage`. Returns null when running in an environment
 * without a canvas (SSR, older jsdom).
 */
function renderHandleIcon(
  kind: TransformHandleKind,
  primaryHex: string,
  foregroundHex: string,
): ImageData | null {
  const canvas = document.createElement('canvas')
  canvas.width = ICON_SIZE_PX
  canvas.height = ICON_SIZE_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Vertex and midpoint are compact dot/ring icons — many appear at
  // once along a polygon edge, so they use a smaller footprint than
  // the transform-mode glyphs (which appear at most 4 at a time).
  if (kind === 'vertex' || kind === 'midpoint') {
    return renderVertexOrMidpointIcon(ctx, kind, primaryHex, foregroundHex)
  }

  const cx = ICON_SIZE_PX / 2
  const cy = ICON_SIZE_PX / 2
  // Bumped from 0.42 / 0.36 so the visible disk is ~15% larger and
  // reads clearly against busy floor plans + satellite basemaps.
  // Move / rotate / scale appear at most 4 at a time so the bump
  // won't crowd the shape they belong to (vertex/midpoint stay
  // small — see `renderVertexOrMidpointIcon`).
  const outerR = ICON_SIZE_PX * 0.48
  const diskR = ICON_SIZE_PX * 0.42

  // Outer glow — a soft alpha ring that reads against any basemap.
  // Drawn as concentric strokes with decreasing alpha (cheaper than a
  // real Gaussian blur and works on every device).
  const glowColor = withAlpha(primaryHex, 0.18)
  ctx.strokeStyle = glowColor
  ctx.lineWidth = ICON_SIZE_PX * 0.08
  ctx.beginPath()
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
  ctx.stroke()

  ctx.strokeStyle = withAlpha(primaryHex, 0.28)
  ctx.lineWidth = ICON_SIZE_PX * 0.05
  ctx.beginPath()
  ctx.arc(cx, cy, outerR - ICON_SIZE_PX * 0.03, 0, Math.PI * 2)
  ctx.stroke()

  // Bright outer rim — solid foreground-colour ring just outside the
  // disk edge. This is the "interactive affordance" cue: it visually
  // frames the disk as a clickable button rather than blending with
  // the semi-transparent glow. Bumped opacity to full + width to
  // ~2.5 CSS px so it reads even at editor default zoom.
  ctx.strokeStyle = foregroundHex
  ctx.lineWidth = Math.max(2, ICON_SIZE_PX * 0.045)
  ctx.beginPath()
  ctx.arc(cx, cy, diskR + ICON_SIZE_PX * 0.02, 0, Math.PI * 2)
  ctx.stroke()

  // Disk — the solid primary-coloured circle the glyph sits on.
  ctx.fillStyle = primaryHex
  ctx.beginPath()
  ctx.arc(cx, cy, diskR, 0, Math.PI * 2)
  ctx.fill()

  // Glyph
  ctx.fillStyle = foregroundHex
  ctx.strokeStyle = foregroundHex
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = ICON_SIZE_PX * 0.075

  switch (kind) {
    case 'move':
      drawMoveGlyph(ctx, cx, cy, ICON_SIZE_PX)
      break
    case 'rotate':
      drawRotateGlyph(ctx, cx, cy, ICON_SIZE_PX)
      break
    case 'scale':
      drawScaleGlyph(ctx, cx, cy, ICON_SIZE_PX)
      break
  }

  return ctx.getImageData(0, 0, ICON_SIZE_PX, ICON_SIZE_PX)
}

/**
 * Compact dot (vertex) or hollow ring (midpoint) glyph. Same theme
 * tinting as the transform-mode handles but half the footprint —
 * polygons routinely have 8+ vertices along their perimeter, so a
 * full-size disk at every one would drown the shape itself.
 *
 * vertex   → solid theme-primary disk with a foreground-tinted rim
 *            + subtle outer glow. Reads as "grab this point".
 * midpoint → hollow: transparent center, theme-primary ring outline.
 *            Reads as "click here to add a point" (secondary affordance).
 */
function renderVertexOrMidpointIcon(
  ctx: CanvasRenderingContext2D,
  kind: 'vertex' | 'midpoint',
  primaryHex: string,
  foregroundHex: string,
): ImageData {
  const cx = ICON_SIZE_PX / 2
  const cy = ICON_SIZE_PX / 2
  // ~60% the footprint of transform-mode disks. At 40 CSS px canvas
  // this puts the visible dot around 18 CSS px — big enough to grab,
  // small enough that a 10-vertex polygon doesn't feel crowded.
  const outerR = ICON_SIZE_PX * 0.24
  const diskR = ICON_SIZE_PX * 0.20

  // Soft outer glow (same construction as the transform-mode icons —
  // reads on any basemap colour).
  ctx.strokeStyle = withAlpha(primaryHex, 0.22)
  ctx.lineWidth = ICON_SIZE_PX * 0.05
  ctx.beginPath()
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
  ctx.stroke()

  if (kind === 'vertex') {
    // Solid disk.
    ctx.fillStyle = primaryHex
    ctx.beginPath()
    ctx.arc(cx, cy, diskR, 0, Math.PI * 2)
    ctx.fill()
    // Foreground rim for definition against busy backgrounds.
    ctx.strokeStyle = withAlpha(foregroundHex, 0.9)
    ctx.lineWidth = Math.max(1, ICON_SIZE_PX * 0.025)
    ctx.beginPath()
    ctx.arc(cx, cy, diskR - ICON_SIZE_PX * 0.015, 0, Math.PI * 2)
    ctx.stroke()
  } else {
    // Midpoint: white disk with a primary ring outline. "Empty circle"
    // reads as "click to add" (whereas the solid vertex reads as
    // "already here, grab me").
    ctx.fillStyle = foregroundHex
    ctx.beginPath()
    ctx.arc(cx, cy, diskR, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = primaryHex
    ctx.lineWidth = Math.max(1.5, ICON_SIZE_PX * 0.04)
    ctx.beginPath()
    ctx.arc(cx, cy, diskR - ctx.lineWidth / 2, 0, Math.PI * 2)
    ctx.stroke()
  }

  return ctx.getImageData(0, 0, ICON_SIZE_PX, ICON_SIZE_PX)
}

/**
 * Four-directional cross with V-shaped stroke arrowheads at each tip.
 * The tip of each arm sits at (cx ± arm, cy) / (cx, cy ± arm); each
 * arrowhead is a two-segment stroke that reads as a clean chevron
 * instead of a filled triangle (which had an ambiguous "wedge" feel).
 */
function drawMoveGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  const arm = size * 0.22
  const head = size * 0.09
  // Shafts — one solid cross so the center reads as a single glyph
  // rather than four disconnected arrows.
  ctx.beginPath()
  ctx.moveTo(cx, cy - arm)
  ctx.lineTo(cx, cy + arm)
  ctx.moveTo(cx - arm, cy)
  ctx.lineTo(cx + arm, cy)
  ctx.stroke()
  // Chevron arrowheads — each is two strokes meeting AT the tip so
  // the wings unambiguously point inward (base is the wide end, tip
  // is the sharp end).
  //   up:    wings from (cx ± head, cy - arm + head) meet at (cx, cy - arm)
  //   right: wings from (cx + arm - head, cy ± head) meet at (cx + arm, cy)
  //   down:  wings from (cx ± head, cy + arm - head) meet at (cx, cy + arm)
  //   left:  wings from (cx - arm + head, cy ± head) meet at (cx - arm, cy)
  ctx.beginPath()
  // Up
  ctx.moveTo(cx - head, cy - arm + head)
  ctx.lineTo(cx, cy - arm)
  ctx.lineTo(cx + head, cy - arm + head)
  // Right
  ctx.moveTo(cx + arm - head, cy - head)
  ctx.lineTo(cx + arm, cy)
  ctx.lineTo(cx + arm - head, cy + head)
  // Down
  ctx.moveTo(cx - head, cy + arm - head)
  ctx.lineTo(cx, cy + arm)
  ctx.lineTo(cx + head, cy + arm - head)
  // Left
  ctx.moveTo(cx - arm + head, cy - head)
  ctx.lineTo(cx - arm, cy)
  ctx.lineTo(cx - arm + head, cy + head)
  ctx.stroke()
}

/**
 * Curved rotation arrow — 3/4 arc with a stroke chevron arrowhead at
 * the near end (top-right of the icon canvas). Default orientation:
 * curl in the top-right quadrant, arrowhead tip pointing up-and-right
 * so it visually reads "rotate around center". The layer's icon-rotate
 * expression rotates this so the curl always faces outward from the
 * image centre at whichever corner the icon sits.
 */
function drawRotateGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  const r = size * 0.18
  // Arc from just before east (-15°) clockwise around to just past
  // west (195°). Leaves the arrowhead gap at the top (east-of-north
  // area) where the curl begins.
  const startAngle = -Math.PI * 0.08
  const endAngle = Math.PI * 1.08
  ctx.beginPath()
  ctx.arc(cx, cy, r, startAngle, endAngle, false)
  ctx.stroke()
  // Chevron arrowhead at the arc's beginning (screen top-right).
  // Tangent direction at the arc start is perpendicular to the radius,
  // rotated -90° (clockwise) since we drew the arc clockwise. That
  // tangent is where the arrow "points" — the chevron opens back
  // along the tangent so both wings sit on the outside of the curl.
  const tipX = cx + Math.cos(startAngle) * r
  const tipY = cy + Math.sin(startAngle) * r
  const tangent = startAngle - Math.PI / 2 // perpendicular, arc-forward
  const head = size * 0.09
  const wing1 = tangent + Math.PI * 0.75
  const wing2 = tangent - Math.PI * 0.75
  ctx.beginPath()
  ctx.moveTo(tipX + Math.cos(wing1) * head, tipY + Math.sin(wing1) * head)
  ctx.lineTo(tipX, tipY)
  ctx.lineTo(tipX + Math.cos(wing2) * head, tipY + Math.sin(wing2) * head)
  ctx.stroke()
}

/**
 * Diagonal double-arrow (NW ↔ SE). Base orientation is `\` — a line
 * from upper-left to lower-right of the icon canvas. The layer's
 * icon-rotate expression flips it to `/` for TR / BL corners.
 *
 * Uses stroke-only chevron arrowheads (not filled triangles). The old
 * filled-triangle version rendered as a solid wedge that hid the shaft
 * end and read like a chevron rather than an arrow tip.
 */
function drawScaleGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  const reach = size * 0.22
  const head = size * 0.09
  const nwx = cx - reach
  const nwy = cy - reach
  const sex = cx + reach
  const sey = cy + reach
  // Shaft
  ctx.beginPath()
  ctx.moveTo(nwx, nwy)
  ctx.lineTo(sex, sey)
  ctx.stroke()
  // NW arrowhead — L-shape wings at the tip, opening toward SE.
  // Both wings sit on the canvas axes (one along +X, one along +Y)
  // which visually reads as a right-angle arrowhead pointing NW,
  // matching the 45° diagonal shaft naturally.
  ctx.beginPath()
  ctx.moveTo(nwx + head, nwy)
  ctx.lineTo(nwx, nwy)
  ctx.lineTo(nwx, nwy + head)
  ctx.stroke()
  // SE arrowhead — mirror.
  ctx.beginPath()
  ctx.moveTo(sex - head, sey)
  ctx.lineTo(sex, sey)
  ctx.lineTo(sex, sey - head)
  ctx.stroke()
}

// ---------------------------------------------------------------------------
// Colour parsing helpers
// ---------------------------------------------------------------------------

interface HslTriple {
  h: number
  s: number
  l: number
}

/**
 * Parse the "H S% L%" triple format used by the shadcn CSS variables.
 * Accepts optional whitespace + comma separators; case-insensitive on
 * the % sign. Returns null for unrecognised input.
 */
function parseHslTriple(raw: string): HslTriple | null {
  const cleaned = raw.replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (cleaned.length < 3) return null
  const h = parseFloat(cleaned[0])
  const s = parseFloat(cleaned[1])
  const l = parseFloat(cleaned[2])
  if (!isFinite(h) || !isFinite(s) || !isFinite(l)) return null
  return { h, s, l }
}

/** Convert H° S% L% → `#rrggbb`. */
function hslToHex(h: number, sPct: number, lPct: number): string {
  const s = sPct / 100
  const l = lPct / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] = hueSector(hp, c, x)
  const m = l - c / 2
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v + m)) * 255)
  const r = to255(r1)
  const g = to255(g1)
  const b = to255(b1)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/** HSL → RGB sextant lookup used by hslToHex. Extracted so the caller
 *  can `const [r1,g1,b1] = hueSector(...)` in a single statement. */
function hueSector(hp: number, c: number, x: number): [number, number, number] {
  if (hp < 1) return [c, x, 0]
  if (hp < 2) return [x, c, 0]
  if (hp < 3) return [0, c, x]
  if (hp < 4) return [0, x, c]
  if (hp < 5) return [x, 0, c]
  return [c, 0, x]
}

/** Return `rgba(r,g,b,a)` from a `#rrggbb` colour + alpha 0..1. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return `rgba(0, 0, 0, ${alpha})`
  const int = parseInt(m[1], 16)
  const r = (int >> 16) & 0xff
  const g = (int >> 8) & 0xff
  const b = int & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
