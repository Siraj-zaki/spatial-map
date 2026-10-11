/**
 * Catalogue of glTF / GLB models the user can place on the map.
 *
 * A model entry is one of:
 *  - `bundled`: ships in `/public/models/<slug>/scene.glb` (or `.glb`).
 *    Always available, no upload required. Listed in `BUNDLED_MODELS`.
 *  - `uploaded`: stored as a Blob in IndexedDB under the `userModels`
 *    table. Surfaced through `useLiveQuery` in the model library UI.
 *    The runtime URL is created with `URL.createObjectURL(blob)` and
 *    cached for the session.
 *
 * Both kinds share the same `ModelAsset` shape so the picker UI and the
 * map overlay can treat them uniformly.
 *
 * Why a single catalogue (instead of two parallel lists in the UI):
 *   - the model overlay needs a stable `id` → URL map regardless of source,
 *     because Mapbox's top-level `style.models` index is keyed by id;
 *   - data-link rules can refer to a model by id without caring whether it
 *     was bundled or uploaded;
 *   - swapping a bundled model for an uploaded one (same id) is a no-op
 *     for downstream code.
 *
 * Build pipeline:
 *   Bundled assets are stored as `.gltf + .bin + textures/` Sketchfab
 *   packs in `public/models/<slug>/`, but at build time
 *   `scripts/build-models.mjs` (npm run `models:build`) re-packs each
 *   into a single `scene.glb` next to the source. Mapbox loads the
 *   `.glb` with embedded buffers + textures so PBR materials, emissive
 *   strength, etc. survive — none of the external URI lookups that
 *   were silently failing on the raw `.gltf` pack.
 *   The URLs below reference `scene.glb`; the `.gltf` source stays in
 *   the repo so re-runs of the pipeline can re-generate the binary.
 */

export type ModelSource = 'bundled' | 'uploaded'

/**
 * Category drives the default ground footprint, the icon used in the
 * picker, and the data-link rule presets ("vehicle => animate along
 * route", "fixture => static + variant swap on status").
 */
export type ModelCategory = 'vehicle' | 'fixture' | 'building' | 'cargo' | 'other'

export interface ModelAsset {
  /** Stable id used both in `style.models[id]` and in saved ModelShape rows. */
  id: string
  /** Human label shown in the picker. */
  label: string
  source: ModelSource
  category: ModelCategory
  /**
   * URL the Mapbox `model` source resolves. For bundled assets this is the
   * absolute path under Vite's public dir (e.g. `/models/forklift_with_rig/scene.glb`).
   * For uploaded assets it's a session blob URL.
   */
  url: string
  /**
   * Suggested default scale in METERS-per-source-unit. Sketchfab assets
   * arrive at wildly different intrinsic scales (some in cm, some normalized
   * to 1×1×1). These defaults make first placement look reasonable; the
   * user can still tweak per-instance in the editor.
   */
  defaultScale: number
  /** Suggested default rotation [pitch, yaw, roll] in degrees. */
  defaultRotation: [number, number, number]
  /**
   * Local-space centre of the model's bounding box, in meters. Lets the
   * renderer compensate for Mapbox's origin-anchored `model-scale` so
   * the visual centre stays put as scale changes. Uploaded assets get
   * this computed on upload; bundled ones can hardcode it (optional —
   * undefined falls back to no compensation, matching pre-fix behaviour).
   */
  boundingCenter?: [number, number, number]
  /**
   * Flat schema describing what's inside the GLB — named materials,
   * named nodes, animation clips, root extras. Drives the dynamic
   * controls in `model-editor.tsx`. Uploaded assets carry it on the
   * UserModel row (parsed at upload time); for bundled assets it's
   * populated lazily by `useModelInspectorMap()` on first fetch.
   *
   * `undefined` here means "schema not loaded yet" — the editor falls
   * back to its built-in tint/emissive/opacity controls in that case.
   */
  inspector?: import('./glb-bounds').ModelInspector
  /** Credit line (author + license) shown in the Models picker. Bundled
   *  CC-BY-4.0 assets require it; keep in sync with each pack's license.txt. */
  attribution?: string
  /** Preview image: a pre-rendered `/models/thumbs/<id>.webp` for bundled
   *  models (`scripts/generate-model-thumbnails.mjs`), the inline data URL
   *  rendered at upload time for uploaded ones. */
  thumbnail?: string
  /** `<model-viewer>` orientation that shows the asset the way the map
   *  does — for GLBs that render correctly on the map but land on their
   *  side in model-viewer, so previews / thumbnails rotate them back. */
  previewOrientation?: string
}

/**
 * Models that ship in `/public/models`. The slug matches the folder name
 * created by the extraction step (see `scripts`/manual unzip). The url
 * path is the publicly-served gltf entry point — Vite serves `public/*`
 * at the site root in dev and copies it to `dist/` at build time.
 */
export const BUNDLED_MODELS: ModelAsset[] = [
  {
    id: 'forklift_with_rig',
    label: 'Forklift (rigged)',
    source: 'bundled',
    category: 'vehicle',
    url: '/models/forklift_with_rig/scene.glb',
    defaultScale: 1,
    defaultRotation: [0, 0, 0],
    // The Sketchfab-rigged forklift ships with its mesh anchored ~193m
    // from origin along Z. Without this compensation the model renders
    // hundreds of metres away from its placement pin (issue #115).
    // Values from `parseGlbInspector(scene.glb)` — keep in sync if the
    // asset is ever re-exported.
    boundingCenter: [0.094, -192.123, 193.253],
    attribution: '“Forklift with Rig” by Daniel Orozco (Sketchfab) — CC-BY-4.0',
  },
  {
    id: 'industrial_forklift_pnuematic_tire',
    label: 'Industrial forklift (pneumatic)',
    source: 'bundled',
    category: 'vehicle',
    url: '/models/industrial_forklift_pnuematic_tire/scene.glb',
    defaultScale: 1,
    defaultRotation: [0, 0, 0],
    attribution: '“Industrial Forklift (Pnuematic Tire)” by doty_aecom (Sketchfab) — CC-BY-4.0',
  },
  {
    id: 'basket_shelving_for_store_or_warehouse',
    label: 'Basket shelving',
    source: 'bundled',
    category: 'fixture',
    url: '/models/basket_shelving_for_store_or_warehouse/scene.glb',
    defaultScale: 1,
    defaultRotation: [0, 0, 0],
    attribution: '“Basket Shelving for Store or Warehouse” by jimbogies (Sketchfab) — CC-BY-4.0',
  },
  {
    id: 'rusty_metal_warehouse_shelving',
    label: 'Warehouse shelving (rusty)',
    source: 'bundled',
    category: 'fixture',
    url: '/models/rusty_metal_warehouse_shelving/scene.glb',
    defaultScale: 1,
    defaultRotation: [0, 0, 0],
    attribution: '“Rusty Metal Warehouse Shelving” by jimbogies (Sketchfab) — CC-BY-4.0',
  },
  {
    id: 'simple_factory_scene',
    label: 'Simple factory scene',
    source: 'bundled',
    category: 'building',
    url: '/models/simple_factory_scene/scene.glb',
    defaultScale: 1,
    defaultRotation: [0, 0, 0],
    attribution: '“Simple Factory Scene” by Pickeri (Sketchfab) — CC-BY-4.0',
  },
]

for (const m of BUNDLED_MODELS) m.thumbnail = `/models/thumbs/${m.id}.webp`

/** Lookup a bundled asset by id. */
export function getBundledModel(id: string): ModelAsset | undefined {
  return BUNDLED_MODELS.find((m) => m.id === id)
}
