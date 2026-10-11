import { apiPost } from './api-client'

/**
 * Client for the backend CAD (DWG) drawing import endpoints.
 *
 * Same two-call shape as `pdf-import.ts`, against the same File object
 * the browser is already holding:
 *
 *   1. `inspectCad(file)` — units, extents, layers and entity counts.
 *   2. `renderCad(...)`   — the chosen layers drawn onto a PNG sheet.
 *
 * The source drawing is never persisted server-side (it would become an
 * orphan file with no DB row referencing it, and `cmd/cleanup-orphans`
 * would correctly reclaim it), so the second call re-sends the bytes.
 *
 * What comes back from `renderCad` is shaped like an image upload on
 * purpose: a CAD floor plan becomes an ordinary `images` row, placed and
 * edited exactly like a photo or a rendered PDF page. Reading the drawing
 * properly still earns its keep — the layer filter is a choice about
 * entities and the ground size comes from the drawing's own units, so the
 * plan lands at its real dimensions instead of being scaled by hand.
 */

/** `$INSUNITS`: the real-world length one drawing unit represents. */
export type CadUnits = number

export const CAD_UNITS_UNITLESS = 0
export const CAD_UNITS_INCHES = 1
export const CAD_UNITS_FEET = 2
export const CAD_UNITS_MILLIMETERS = 4
export const CAD_UNITS_CENTIMETERS = 5
export const CAD_UNITS_METERS = 6

/** A colour exactly as the drawing stated it, unresolved. */
export interface CadColor {
  /** ACI palette index. 256 is ByLayer, 0 is ByBlock. */
  index: number
  /** `#rrggbb`, present only when the entity carried a true colour. */
  rgb?: string
}

export interface CadLayer {
  name: string
  color: CadColor
  visible: boolean
  locked: boolean
  plottable: boolean
  /** How much of the flattened drawing lands on this layer. */
  entityCount: number
  /**
   * The server's read of whether the layer describes the drawing rather
   * than the building — title blocks, dimension runs, hatch patterns. A
   * floor plan reads better without them, so they open unticked; nothing
   * else turns on this.
   */
  annotation?: boolean
}

export interface CadUnitGuess {
  units: CadUnits
  name: string
  /** The drawing's width if this candidate is right. */
  widthMeters: number
  /** False for candidates implying a building smaller than a desk. */
  plausible: boolean
}

export interface CadPoint {
  x: number
  y: number
}

export interface CadInspectResult {
  format: string
  version: string
  release: string
  producer?: string

  units: CadUnits
  unitsName: string
  /** True when the file itself declared `$INSUNITS`. */
  unitsDeclared: boolean
  /** True when the units can be applied without asking the user. */
  unitsConfident: boolean
  metersPerUnit: number
  /** Ranked candidates, present only when the file declared nothing. */
  unitGuesses?: CadUnitGuess[]

  widthMeters: number
  heightMeters: number

  min: CadPoint
  max: CadPoint
  headerMin?: CadPoint
  headerMax?: CadPoint

  entityCount: number
  entityKinds: Record<string, number>
  blockCount: number
  layers: CadLayer[]

  missingBlocks?: string[]
  missingXrefs?: string[]
  truncated: boolean
}

/**
 * A rendered drawing, on its way to an `images` row.
 *
 * The first five fields are exactly what `POST /images/upload` returns,
 * which is what lets a CAD plan reuse the placement draft a PDF page or a
 * photo already goes through — no new shape kind, no migration, no second
 * placement path.
 */
export interface CadRenderResult {
  url: string
  mimeType: string
  naturalWidth: number
  naturalHeight: number
  bytes: number

  /**
   * What the image covers on the ground, margin included. A PDF cannot
   * say this — its scale is inferred from a sheet size — but a drawing is
   * authored in real-world coordinates, so the placement starts out
   * correct rather than approximately correct.
   */
  widthMeters: number
  heightMeters: number
  pixelsPerMeter: number

  /** The units the size above is stated in, so the UI can say what it assumed. */
  units: CadUnits
  unitsName: string
  metersPerUnit: number

  entityCount: number
  /** Geometry stranded far from the building, dropped before rendering. */
  detachedEntities?: number
  truncated: boolean
}

const CAD_EXTENSIONS = ['.dwg']

/**
 * Whether this file should detour through the CAD import dialog.
 *
 * Extension only. The server picks the format by content — an extension
 * is the user's claim and a magic string is the file's own — so this is
 * just a routing hint, and a mislabelled file fails with a readable
 * error from `/cad/inspect` rather than being silently misread.
 */
export function isCadFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return CAD_EXTENSIONS.some((ext) => name.endsWith(ext))
}

export async function inspectCad(file: File): Promise<CadInspectResult> {
  const form = new FormData()
  form.append('file', file, file.name)
  return apiPost<CadInspectResult>('/cad/inspect', form)
}

export async function renderCad(
  file: File,
  opts: { layers?: string[]; units?: CadUnits } = {},
): Promise<CadRenderResult> {
  const form = new FormData()
  form.append('file', file, file.name)
  // Newline-separated because a layer name may legally contain a comma.
  // An absent field means the whole drawing.
  if (opts.layers && opts.layers.length > 0) {
    form.append('layers', opts.layers.join('\n'))
  }
  if (opts.units !== undefined) form.append('units', String(opts.units))
  return apiPost<CadRenderResult>('/cad/render', form)
}

/**
 * Layers worth pre-selecting.
 *
 * A plan has thirty layers and the four that matter are the four with
 * content, so empty layers are dropped. The drawing's own visibility is
 * honoured on top: a layer the author froze is one they chose not to
 * show, and re-enabling it by default would render a plan covered in
 * construction lines and revision clouds.
 *
 * Layers the server marked as annotation come off as well. That is the
 * one case where a name says positively what a layer is *not* — a title
 * block, a dimension run, a hatch pattern — and leaving them ticked is
 * the difference between a plan arriving as a plan and arriving buried
 * in the sheet it was plotted on. Every one of them is still listed and
 * still tickable; this only decides where the dialog opens.
 *
 * Each filter falls back to the wider set when it would empty the
 * selection, because a dialog that opens with nothing chosen and a
 * disabled button reads as a failure rather than as advice.
 */
export function defaultSelectedLayers(layers: CadLayer[]): Set<string> {
  const useful = layers.filter((l) => l.entityCount > 0)
  const kept = narrow(useful, (l) => !l.annotation)
  return new Set(narrow(kept, (l) => l.visible).map((l) => l.name))
}

function narrow(layers: CadLayer[], keep: (l: CadLayer) => boolean): CadLayer[] {
  const next = layers.filter(keep)
  return next.length > 0 ? next : layers
}

/** Total entities across the selected layers, for the dialog's summary. */
export function selectedEntityCount(
  layers: CadLayer[],
  selected: Set<string>,
): number {
  return layers.reduce(
    (sum, l) => (selected.has(l.name) ? sum + l.entityCount : sum),
    0,
  )
}

/**
 * Real-world size under a hypothetical unit.
 *
 * The extents are fixed by the geometry; only the scale factor is in
 * question. Showing the resulting building size is what makes a units
 * choice obviously right or obviously absurd to a human — the candidates
 * are five orders of magnitude apart, so there is no ambiguity to
 * resolve once the number is on screen.
 */
export function sizeUnderUnits(
  info: CadInspectResult,
  units: CadUnits,
): { widthMeters: number; heightMeters: number } | null {
  const factor = METERS_PER_UNIT[units]
  if (!factor) return null
  const unitWidth = info.metersPerUnit > 0 ? info.widthMeters / info.metersPerUnit : 0
  const unitHeight = info.metersPerUnit > 0 ? info.heightMeters / info.metersPerUnit : 0
  return {
    widthMeters: unitWidth * factor,
    heightMeters: unitHeight * factor,
  }
}

/**
 * The units a drawing is realistically in. Deliberately short — a
 * building is not authored in parsecs, and offering the full $INSUNITS
 * table would bury the four that matter.
 */
export const CAD_UNIT_CHOICES: { units: CadUnits; key: string }[] = [
  { units: CAD_UNITS_MILLIMETERS, key: 'millimeters' },
  { units: CAD_UNITS_CENTIMETERS, key: 'centimeters' },
  { units: CAD_UNITS_METERS, key: 'meters' },
  { units: CAD_UNITS_INCHES, key: 'inches' },
  { units: CAD_UNITS_FEET, key: 'feet' },
]

const METERS_PER_UNIT: Record<number, number> = {
  [CAD_UNITS_INCHES]: 0.0254,
  [CAD_UNITS_FEET]: 0.3048,
  [CAD_UNITS_MILLIMETERS]: 0.001,
  [CAD_UNITS_CENTIMETERS]: 0.01,
  [CAD_UNITS_METERS]: 1,
}

/**
 * The AutoCAD Color Index entries that appear in practice.
 *
 * The full palette is 256 entries, but layer colours in a real drawing
 * are overwhelmingly the first nine (the ones with names in every CAD
 * UI) plus the grey ramp at the top. Shipping the whole table would be
 * 256 hex strings to make the remaining fraction of a percent exact, so
 * anything unlisted falls back to the caller's default — which is the
 * right answer anyway, since an unresolvable index should adopt the
 * map's theme rather than a colour we invented.
 */
const ACI_PALETTE: Record<number, string> = {
  1: '#ff0000',
  2: '#ffff00',
  3: '#00ff00',
  4: '#00ffff',
  5: '#0000ff',
  6: '#ff00ff',
  7: '#ffffff',
  8: '#808080',
  9: '#c0c0c0',
  250: '#333333',
  251: '#5b5b5b',
  252: '#848484',
  253: '#adadad',
  254: '#d6d6d6',
  255: '#ffffff',
}

/**
 * Resolve a CAD colour to a hex string, or null when the drawing did not
 * pin one down.
 *
 * Index 256 is ByLayer and 0 is ByBlock — both mean "inherit", so
 * neither is a colour. Index 7 is the CAD convention for "the default
 * pen", which renders black on paper and white on a dark model-space
 * background; it is deliberately treated as unresolved so the map's
 * theme picks it, because a hard white is invisible on a light basemap
 * and a hard black is invisible on a dark one.
 */
export function cadColorHex(color: CadColor | undefined): string | null {
  if (!color) return null
  if (color.rgb) return color.rgb
  if (color.index === 7 || color.index === 256 || color.index === 0) return null
  return ACI_PALETTE[color.index] ?? null
}
