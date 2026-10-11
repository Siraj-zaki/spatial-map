# Frontend pitfalls

Read this before touching map overlays, the spatial store, or theming — every entry below is a bug that already cost debugging time once.

## Quick rules

| Gotcha | What goes wrong | Fix |
|---|---|---|
| Hardcoding colors | Breaks dark mode | Use `hsl(var(--token))` or Tailwind theme classes |
| `fill-extrusion-opacity` data expr | Mapbox 3.x rejects it | Use opacityBucket layers |
| Calling `apiDb.X.update` from component | Bypasses optimistic spatial-store | Use `updateLocal` |
| Forgetting to add i18n keys | Strings missing in non-EN locales | Edit all 6 `translation.json` files |
| Mutating Zustand state directly | Doesn't trigger re-renders | Use store actions or `set(state => ...)` |
| Creating an EventSource (or a second `/events` stream) in components | Multiple connections, leaks; EventSource can't send the JWT/tenant headers `/events` now requires | Use `useSSE` / `subscribeExternalSSE` |
| Forgetting `await` on async store actions | Race conditions | All `loadX`, `commit`, `flush` are async |
| Loading GLBs that aren't self-contained | Black/missing model on map | Run `npm run models:build` |
| Adding raw hex colors to map paint | Theme-blind | Read from theme tokens or shape config |
| Hiding a marker via `el.style.opacity` | `Marker._evaluateOpacity` stomps it on the next camera move | Set a `data-` attribute + a `!important` rule |
| Hiding a layer with a false `setFilter` | Still recalculates every frame, and forces a source reload | `setLayoutProperty(id, 'visibility', 'none')` |
| Reading `map.getLayer(id).visibility` | Always `undefined` — `getLayer` returns `serialize()` | `map.getLayoutProperty(id, 'visibility')` |
| `queryRenderedFeatures` with hardcoded ids | Throws when a layer isn't mounted yet | `.filter((l) => map.getLayer(l))` first |
| Assuming GL JS scales to the machine | Hardcoded 2 workers; never asks for the discrete GPU | `tuneMapboxRuntime()` before `new mapboxgl.Map` |
| Subscribing to `gpu-timing-layer` | Broken upstream in GL JS 3.25 — throws once per layer per frame | Use `gpu-timing-frame`; it carries `cpuTime` + `gpuTime` |
| Trusting GL JS's `averageFPS` in prod | Always `0` — the code computing it is stripped from prod builds | Sample the `render` event yourself (`?perf=1` HUD) |
| Measuring fps with a rAF loop | Reads a fictional 60fps while the map is idle | Sample the map's own `render` event |
| Re-raising layers on `styledata` | `moveLayer` *fires* `styledata` → cascade that never converges | Guard, or raise once on `style.load` |

---

## Spatial store, SSE and entity kinds

### Mirror every kind-aware list when adding an entity kind

**Symptom** — you wire a new shape kind into `useSpatialStore` but forget the `useSSE` whitelist (or any other kind-aware list). The spatial store loads the rows on cold start, the create POST succeeds, and the row shows up in the editor — but after refresh OR cross-tab, the row vanishes from the local snapshot because the SSE event was silently dropped. There are **at least seven** kind-aware lists that all need the new literal: the `EntityKind` union, the `CatalogEntity` union, `ALL_KINDS`, `tablePath`, `kindStateKey`, the state slice + initial value (`useSpatialStore.<kind>`), and `mutation-queue.ts`'s `tablePath`. Plus `useSSE.ts`'s `VALID_KINDS` — and that's the one most likely to be missed because it lives in a different file.

**Fix** — when adding a new entity kind, grep for one of the existing literals (e.g. `'models'`) across `src/lib/` and `src/hooks/` and mirror **every** hit. Run a TS check after — most of these lists are typed `Record<EntityKind, …>` so omissions surface, but `useSSE.ts`'s set is a runtime check that won't complain at compile time.

### Route non-spatial-store SSE traffic through `subscribeExternalSSE`

**Symptom** — you broadcast SSE for a non-spatial-store entity kind and add it to `useSSE`'s `VALID_KINDS` set. Adding a new kind (e.g. the Data screen's `data-events` synthetic broadcast) to `VALID_KINDS` in `useSSE.ts` fires `useSpatialStore.getState().loadKind(kind)` — which reads `tablePath[kind]` and blows up because the store has no slice for that kind.

**Fix** — non-spatial-store SSE traffic (Data screen, future dashboards, etc.) uses `subscribeExternalSSE(cb)` from `src/lib/useSSE.ts`. `useSSE`'s message handler routes events whose entity name is NOT in `VALID_KINDS` to every registered external listener instead of dropping them. See `src/routes/data.tsx` for the pattern: subscribe on mount → invalidate the Data screen's own react-query cache prefixes. Backend broadcasts `BroadcastEntityEvent("ENTITY_DELETED", "data-events", ...)` from every mutation in `data_screen.go`.

### Don't `createLocal` a batch of imported or generated shapes

**Symptom** — the spatial store's flush is **sequential**, so creating a batch with `createLocal` per row is one ordered POST per row. A batch of even a few hundred is that many round trips before the map shows anything, plus that many SSE broadcasts, and the user watches an empty map for the whole of it with no way to tell a slow import from a failed one. It is the same mistake the bulk-assign entry below describes, in the create direction.

**Fix** — POST to the kind's `/bulk` route (`lines`, `polygons`, `circles`, `doors`, `stairs`, `grids` today — built for the since-removed CAD entity extraction and currently without a caller, kept because any future bulk-create path needs exactly this) in chunks of ~1,000: one transaction, one kind-wide SSE event, every item validated before any is written. Afterwards refresh with `loadKind` per touched kind, because these rows bypassed the optimistic path and the local snapshot has not seen them — plus `useDoorStore.loadForWarehouse` for doors, which keep their own store. Adding `/bulk` to a seventh kind is one `r.Post("/bulk", shapeBulkCreate(…))` line plus a `*pgxpool.Pool` on that kind's router. And say something while it runs — an inline pill, not a new toast library (see the "don't introduce these" list in `docs/frontend.md`).

### Bulk-assign posts once, not one PATCH per id

**Symptom** — firing one PATCH per id per kind from the bulk-assign dialog (the `for (const id of ids) await apiDb.X.update(id, …)` pattern). A 200-item bulk reassignment kicks off 200 sequential HTTP round trips (plus 200 SSE broadcasts), so wall-clock time balloons to seconds even on a fast network and the SSE stream floods with per-row events. Users see the "one by one" pattern in the network tab and correctly interpret it as a stuck / bloated flow.

**Fix** — post the whole selection to `POST /api/v1/bulk-assign` in one call with a `{ zoneId?, floorPlanId?, kinds: { <singular>: id[] } }` body. Backend runs one `UPDATE ... WHERE id = ANY($ids)` per kind (see `backend/queries/bulk_assign.sql` + `backend/internal/handlers/bulk_assign.go`), broadcasts SSE per updated row (still cheap since it's channel sends, not HTTP), and returns a `{ updated: { <singular>: count } }` summary. The tri-state (skip / clear / assign) survives via `json.RawMessage` fields on the request — the backend's `parseBulkAssignField` distinguishes "absent" from "null" from "number". After the response, invalidate every touched kind's `queryCache` prefix; doors need an extra `useDoorStore.loadForWarehouse(...)` since they don't ride the spatial-store query cache.

### Scope doors through `scopeToWarehouse` before rendering them

**Symptom** — passing `doors` straight from `useDoorStore` to the door overlay / sidebar / bulk-assign dialog. Every other shape kind (grids / markers / circles / polygons / lines / models / stairs / text labels / images) is fed through `scopeToWarehouse()` in `create-grids/index.tsx`, which handles the active-warehouse filter AND the hidden-floor-plan cascade (any shape whose `floorPlanId` is in `hiddenFloorPlanIds` disappears from the render list). Doors bypassed this because they come from a separate store (`useDoorStore`), so hiding a floor plan wiped every polygon / grid / circle / marker / model / stair / text / image assigned to that plan — but the doors sitting on that same floor stayed pinned to the map, the sidebar, and the bulk-assign dialog.

**Fix** — compute `scopedDoors = useMemo(() => scopeToWarehouse(doors), [doors, scopeToWarehouse])` and hand THAT to `MapDoorOverlay`, `SidePanel`, `BulkAssignDialog`, and `statusBarCounts`. The raw `doors` list stays available for id-lookups / mutations (finding a specific door by id, bulk-config patching, delete). Rule of thumb: rendering paths → scoped list, mutation paths → raw list.

### Values snapping back after an edit — keep the draft until the server confirms

**Symptom** — drag a rack's Opacity slider to 45 and let go: it showed 45, jumped back to the old 100 ~770 ms later, then returned to 45. The editor kept a route-level `draftConfig`, fired the save without awaiting it and cleared the draft immediately, so the map read the stale server row until the PATCH response landed; the SSE echo then triggered a second GET of the same row.

**Fix** — every editor edit goes through `useSpatialStore` (`updateLocal` / `saveSpatialEntity`): the draft holds until the server confirms that value, one request per entity is ever in flight (edits made meanwhile coalesce into one follow-up), server rows apply only if `updatedAt` isn't older, and `isSelfEcho` skips refetching our own echo. Measure it: a rapid drag must produce one PATCH, no GET, and zero value changes after release.

### One edit re-rendering every layer

**Symptom** — any slider tick on any shape blocked the main thread for 5.4 s over a 7 s drag (dev). The single `drafts` Map gave every `useSpatial*` hook a new array, `buildOccluders` rebuilt every wall/stair/rack prism five times per tick, and closed dialogs (bulk assign, model library, cheatsheet) recomputed on every render.

**Fix** — drafts are per kind and applied once per animation frame; unchanged rows keep their object identity, so per-row caches (`cachedPrisms` in `marker-occlusion.ts`, `rackCells` in `map-bin-overlay.tsx`, the grid overlay's cell cache) only rebuild the edited shape; heavy dialogs mount only while open; memoised chrome gets stable callbacks (`useStableCallback`). Profile with the CDP Profiler (see the scratch `ed-profile.mjs` pattern) before guessing.

### The first camera fit raced the floor-plan load

**Symptom** — opening a facility sometimes left the camera on the globe: the warehouse centre is stored as (0,0), so when the map was ready before the floor plans loaded the fit fell through to the globe fallback and locked; the floor plan arriving a moment later never refit. Fast local APIs hid it; a slower backend showed it every time.

**Fix** — the fit effect waits until `loadedFor` shows this warehouse's images and shapes have loaded. Reproduce races with a delayed route (`page.route(..., setTimeout)`) — a fast dev box will pass the broken version.

### Arrow keys on a focused slider also nudged the shape

**Symptom** — pressing ← on the Opacity slider changed opacity AND moved the selected rack on the map; both were saved.

**Fix** — `isTextInput` (the shortcut guard in `keyboard-shortcuts.ts`) also ignores keys inside sliders, spinbuttons, comboboxes, listboxes, menus, radio groups, tablists and dialogs.

### Editor chrome overlapping at 1024 px — position from the visible map, not the viewport

**Symptom** — at 1024×768 with the side panel open, the status bar's shape count ran under the panel (its contents didn't shrink), the place search (centred on the full map width) ran under the panel, and the pill row wrapped "Data links" onto the tool rail.

**Fix** — the editor root measures its width and sets `--panel-inset` (416 px when the panel is open at `sm+`). With ≥ 860 px of visible map the search sits on the top row against the panel; below that it drops to a second row starting past the tool rail (`start-[5.5rem]`, the rail is vertically centred and reaches the top on short screens). The pill row's `max-w` subtracts the inset and the search. Coordinates in the status bar only show at `xl+`. Check every new floating control at 1440 / 1024 / 390 with the panel open.

### The side panel opened half off-screen — `overflow-hidden` is still scrollable

**Symptom** — on a phone the panel reopened ~35 px to one side, clipping its buttons. Focus (or `scrollIntoView`) on an element inside the closed, translated-away panel scrolled the editor root sideways; `overflow: hidden` only hides scrollbars, it doesn't prevent programmatic scrolling.

**Fix** — the editor root is `overflow-clip` (can't be scrolled at all), and the closed panel is `inert`. Below `md` the panel also starts closed — it is a drawer over the map.

### `t(hint)` with a bare key — the status-bar hint was never translated

**Symptom** — every language showed the English keyboard hint. `KeyboardHint` called `t('selected', { defaultValue })`, so the lookup missed and the English default always won; the locales had no `kbHint.*` keys either.

**Fix** — ``t(`kbHint.${hint}`)`` plus the keys in all six locales. When a `t()` call builds its key, grep the locale files for the full key before trusting the `defaultValue`.

---

## Mapbox layers and sources

### The style-readiness effect's deps are `[map]` only

**Symptom** — putting `styleLoaded` / `styleGen` into the deps of the *style-readiness* `useEffect` in a map overlay. The effect itself calls `setStyleLoaded(true)` + `setStyleGen(g => g + 1)`. Including those state values in the dep array causes the effect to re-run on every state change → React bails with "Maximum update depth exceeded" and the overlay's sources/layers get torn down between runs, so features briefly appear then vanish. Bit `map-grid-overlay.tsx` (grids loaded then disappeared).

**Fix** — the style-readiness effect's dep array must be `[map]` only. Downstream *data* effects can still depend on `[map, styleLoaded, styleGen, ...]` — that's how they react to style swaps. Mirror the pattern in `map-polygon-overlay.tsx` / `map-stair-overlay.tsx`.

### `clearInterval` on the success branch of an `isStyleLoaded()` poll

**Symptom** — `setInterval` polling for `map.isStyleLoaded()` without `clearInterval` on the success branch. The interval keeps firing every 100ms after the style loads, calling `setStyleLoaded(true)` + `setStyleGen(g => g + 1)` on every tick. React detects the infinite setState loop and throws "Maximum update depth exceeded". Bit `map-door-overlay.tsx`.

**Fix** — in the interval callback, call `clearInterval(interval)` immediately after `setReady()`. Better yet, if `map.isStyleLoaded()` is already true on first run, do a microtask-scheduled `setReady()` and `return` before starting the interval. Both polygon and stair overlays follow this pattern.

### Mapbox `image` sources are immutable — remount to change the bytes

**Symptom** — trying to `setUrl` / mutate the `url` of an existing Mapbox `image` source when the crop or upload changes. Mapbox `image` sources are immutable — there's no `setUrl` API. `setCoordinates` updates the four world corners in place, but there's no equivalent for the bytes. Attempting to swap URL by, say, updating the `url` field on the source object silently no-ops. The first-pass floor-plan crop shipped bytes to a canvas + tried to point the existing source at the new data URL; the raster kept showing the uncropped image.

**Fix** — track the URL currently mounted per shape in a ref (`mountedSignatureRef` in `map-image-overlay.tsx`). When the desired URL differs, `removeLayer` + `removeSource`, then `addSource` + `addLayer` with the new URL. `setCoordinates` remains fine for the pure move/rotate/scale path where the URL isn't changing. The same rule bit the 3D-plane GLB overlay first — see "Remount a `model` source whose URI wasn't fetchable at mount time" below.

### Remount a `model` source whose URI wasn't fetchable at mount time

**Symptom** — you add a Mapbox `type: 'model'` source whose URI isn't immediately fetchable, then expect the layer to render. When the URI is a blob URL synthesised seconds after the source mounted (or any URI Mapbox hasn't already cached), `addSource` silently succeeds but the model layer stays **blank** until the source is explicitly re-mounted. The symptom is "shape doesn't appear after refresh, but appears after the user toggles visibility off/on" — because the toggle accidentally tears down + re-adds the source. Bit `map-image-plane-overlay.tsx`.

**Fix** — track the URI you most recently handed to Mapbox per shape (e.g. `mountedUriRef = new Map<shapeId, string>()`). When the new entry's URI differs from the mounted one, do a full `removeLayer` + `removeSource` + `addSource` + `addLayer` instead of `setModels`. `setModels` is fine for paint/orientation changes; it is NOT sufficient for the first-time GLB attach.

### Hand-write GLBs for Mapbox, don't use `@gltf-transform/core`

**Symptom** — using `@gltf-transform/core`'s `WebIO.writeBinary()` to produce GLBs Mapbox will consume. Mapbox is **very strict** about GLB chunk alignment and `buffer.byteLength` semantics (see the existing note on `npm run models:build`). `@gltf-transform/core` produces self-contained GLBs that pass most validators but Mapbox rejects with `offset is out of bounds`. Bit `image-plane-generators.ts` on first ship.

**Fix** — hand-write the GLB with: (1) JSON chunk padded to 4-byte boundary with `0x20` (space), (2) BIN chunk padded to 4-byte boundary with `0x00`, (3) every `bufferView.byteOffset` 4-byte aligned, (4) `buffer.byteLength` = the actual data length (NOT the padded chunk length — the glTF spec allows up to 3 trailing padding bytes in the chunk that the buffer doesn't claim). See `createImagePlaneGlb()` for the layout.

### Author image-plane meshes in the GLB's XZ plane, not XY

**Symptom** — using the glTF Y-up convention for an `ImagePlaneShape` mesh and stretching the wrong axis. Mapbox's `model` layer applies `model-translation` AND `model-scale` in **world Z-up coords** (`[0]` = east-west, `[1]` = north-south, `[2]` = up) — confirmed by `model-generators.ts` where `cfg.elevation` is fed into `model-translation[2]`. The GLB itself is read in standard glTF Y-up and Mapbox auto-remaps Y → Z before applying transforms. Authoring the plane in the GLB's XY plane (Z = 0) ends up vertical-wall-facing-south after remap; scaling `[w, h, 1]` then stretches one of the dimensions **into the sky** and produces a thin vertical sliver.

**Fix** — author the plane in the GLB's **XZ plane** (Y = 0, normal +Y) so after Mapbox's Y → Z remap it lies flat on the world's X-Y plane. Then `model-scale = [width, height, 1]` and `model-translation = [0, 0, elevation]` work intuitively in world coords.

### Don't draw floor plans with `raster-elevation` — use `FloorPlanLayer`

**Symptom** — floor plans used to be an `image` source + `raster` layer lifted with `raster-elevation` (experimental in 3.25). Two engine bugs followed, measured across zoom 14–28 × pitch 0–70 on real facilities:
- **The plan vanished when zoomed in without tilt** (zoom ≥ ~21–21.5, pitch < ~3–5°) and came back with a few degrees of tilt. The Standard style switches to an orthographic camera below 15° pitch; the elevated-raster shader always compiles its `RENDER_CUTOFF` fade and `cutoffParamsForElevation()` returns all zeros for an orthographic camera, so the fade divides by zero and every fragment goes transparent once the far plane passes ~2× the camera distance.
- **Shapes standing on the plan vanished at zoom 16–21.** `drawRaster` gives an elevated raster `DepthMode(LEQUAL, ReadWrite)` whatever its opacity, and its `ELEVATED` vertex block pulls depth ~2 px toward the camera (~1 m at zoom 18, 6 cm at zoom 22). Extrusions a few centimetres above lost the depth test at some zooms. At opacity 0 `drawRaster` returns before drawing — that is why shapes "came back at opacity 0".

Earlier patches (10 cm minimum `raster-elevation`, opacity capped at 254/255 "to skip the depth write", `slot: 'top'` then a `beforeId`) treated symptoms: the 254/255 cap does nothing on the elevated path, and the 10 cm lift put the plan *above* flat shapes.

**Fix** — `src/lib/floor-plan-layer.ts`: a custom layer (`renderingMode: '3d'`, slot `top`) drawing the image as a textured quad at its exact elevation. Vertices are metres from the plan centre and the matrix is composed in float64, so it is pixel-identical to a flat raster up to zoom 32. Depth: slight polygon offset (coplanar shapes win), depth written only for a raised, opaque floor (so it hides the floors below), transparent texels discarded. Crop is texture coordinates on the full image. Every GL call happens inside `render()` (Mapbox dirties its state cache after a custom layer), image decoding happens off the render path. Verify with an in-browser zoom × pitch matrix, never a single camera — both bugs were camera-dependent.

### A translucent extrusion drawn before an opaque one hides it

**Symptom** — a 40% polygon standing in front of a 100% polygon: looking through the translucent one you see the floor plan, not the opaque shape behind it. Mapbox draws a fill-extrusion with opacity < 1 as a depth-only pre-pass that **writes depth** (`DepthMode(LEQUAL, ReadWrite)` + `ColorMode.disabled`), then the blended colour pass. Any 3D layer drawn later that sits behind it fails the depth test. Our natural style order made that the common case: opacity buckets are added `-op0 … -op100` (ascending), selection tints (`*-selection-tint-layer`, 18%) mount early, and overlay kinds follow the user's layer order.

**Fix** — `src/lib/translucent-layer-order.ts`, installed once per map in `mapbox-map.tsx`, keeps every translucent fill-extrusion after every opaque 3D layer (fill-extrusion / model), most opaque first. It re-checks in a microtask after `addLayer` / `moveLayer` / `fill-extrusion-opacity` changes and makes no moves when the order is already right. It ignores `dl-…` layers (the data-link overlay raises them on every `styledata`; sorting them too made the two chase each other and the map never went idle), and its loop guard always schedules a catch-up pass when it pauses — initial load legitimately moves layers many times in a row, and 3D models mounting last were left unsorted without it. Don't "fix" this per overlay by reversing bucket order — the cross-overlay case (a translucent grid in front of an opaque polygon) needs the global rule. Opaque 3D layers resolve against each other by depth, so the reorder doesn't change what the user's layer order means for 3D content.

### `line-z-offset` / `line-elevation-reference` are layout, not paint

**Symptom** — declaring `line-z-offset` / `line-elevation-reference` in a `line` layer's `paint` block, or updating them with `setPaintProperty`. Both are **layout** properties in Mapbox GL JS 3.x. The neighbours make the opposite feel obvious — `fill-extrusion-base` really is paint, and the elevation knobs read like visual properties — so this is the natural first guess. On the typed API it surfaces as TS2353 on the paint spec and TS2345 on the setter, which is the good case; in plain JS the layer simply renders on the ground and nothing says why. Bit the (since-removed) CAD linework overlay while lifting a drawing to its floor's altitude.

**Fix** — put both inside `layout` on `addLayer` and update with `setLayoutProperty`. `map-polygon-overlay.tsx` is the reference implementation. Rule of thumb for `line` layers: anything deciding **where the geometry sits** is layout; only colour / width / opacity are paint.

### An *absent* `*-occlusion-opacity` occludes against terrain only

**Symptom** — a symbol layer that should vanish behind a rack or an upper-floor slab ghosts straight through it instead, and the style JSON looks correct because the spec lists `text-occlusion-opacity`'s default as `0` — the "hide when occluded" value. The doc line that matters is the next one: *"Absent value means full occlusion against terrain only."* An unset property is not the same as the property set to its default here; it opts the layer out of depth-testing against 3D **content** and leaves only terrain. Every data-link render mode was in this state, which is why markers hid correctly (they use the analytic prism test in `marker-occlusion.ts`) while the layers next to them did not.

**Fix** — name `text-occlusion-opacity` / `icon-occlusion-opacity` explicitly in `paint` on every symbol layer that should hide behind geometry, even to write the value the spec already claims as default. `line-occlusion-opacity` genuinely does default to 0, but it is **not** data-driven and is ignored when `line-opacity` uses a data expression — so an occludable line must keep `line-opacity` constant. `fill` has no occlusion property at all in 3.25: a fill can be elevated with `fill-z-offset` but can never be depth-occluded.

### A `circle` layer can neither be elevated nor occluded — draw a `●` symbol

**Symptom** — reaching for `circle-z-offset` or `circle-occlusion-opacity` to lift a dot to its floor. Neither exists in Mapbox 3.25. `layout_circle` does expose `circle-elevation-reference`, which makes it look solvable, but its only values are `none` and `hd-road-markup` — there is no altitude input at all. A `circle` is therefore permanently glued to the ground and permanently visible through solid geometry.

**Fix** — draw the disc as a `symbol` layer with `'text-field': '●'`, then `symbol-z-offset` and `text-occlusion-opacity` both apply. Convert the size with the `DISC_EM_SCALE` constant in `map-data-linked-overlay.tsx`: the glyph fills ≈0.72 of its em-box, so `text-size = radius * 2.8` reproduces a circle of that radius. `'○'` covers the stroked-ring case, at the cost of a stroke thickness that scales with size instead of being a fixed pixel width. One knock-on: `text-size` is **layout**, so anything that animated `circle-radius` on a timer has to become a `text-opacity` (paint) animation or it re-runs symbol layout every tick.

### `mapboxgl.Marker` overwrites inline `opacity` and `pointer-events` every frame

**Symptom** — setting `el.style.opacity = '0'` to hide a marker works for a moment and then silently reverts. `Marker._evaluateOpacity()` writes both `_element.style.opacity` and `_element.style.pointerEvents` as **inline** styles as part of its fog/terrain fade, and it runs on camera movement — so it wins every specificity contest against a stylesheet rule and stomps whatever you wrote inline. The failure looks intermittent, because it only reverts once the camera moves.

**Fix** — express marker state as a **data attribute** and style it from `index.css` with `!important`, which is the one thing an inline style loses to: `.shape-marker[data-occluded='true'] { opacity: 0 !important; pointer-events: none !important }`. Set/delete `el.dataset.occluded` from the overlay and let CSS do the rest (see `map-marker-overlay.tsx` + `marker-occlusion.ts`). Keep the rule **outside** `@layer` — same trap as the palette rules below: the state only ever exists as a runtime `dataset` write, so Tailwind can't see it in `content` and would tree-shake the rule out of a layer. Corollary: don't add `occludedOpacity` to `MarkerOptions` expecting it to help — it only covers 3D terrain, never custom layers.

### Marker occlusion tests against a *set* of kinds — a missing kind fails silently

**Symptom** — marker occlusion "works" in a test scene and does nothing in a real warehouse. The wiring is fine and the toggle is on; `buildOccluders` simply received no geometry it understands, so `computeOccludedMarkerIds` returns an empty set and `data-occluded` is never written. This first shipped covering only floor-plan **rasters**, which meant it did nothing in every scene where the thing above the marker was an extruded slab, wall or staircase — i.e. most real scenes. It was verified against a synthetic three-raster stack, which is exactly the one case the code handled, so the test passed and the feature was broken.

**Fix** — when you change the occluder set, build the check scene out of the kinds **users actually draw** (a polygon slab at elevation, a wall line with `height`, a staircase), not the kind the code happens to handle. A no-op is the failure mode here, and a no-op looks identical to "feature off" from the outside. Same rule for the `occluders` prop: hosts build it as an inline object, so the `useMemo` inside the overlay must key on the **individual arrays** (destructure first) — keying on the bag's identity rebuilds every prism on every render.

### Let the marker fade settle before asserting on its opacity

**Symptom** — a browser-driven check of marker visibility reads nonsense values like `computedOpacity: 0.0255` when you expect a clean `0` or `1`, and the numbers differ run to run. Nothing is wrong with the code: `mapbox-gl.css` ships `.mapboxgl-marker { transition: opacity .2s }`, so a two-`requestAnimationFrame` probe samples ~32 ms into a 200 ms fade. Chasing this as a logic bug wastes real time.

**Fix** — wait out the transition (~400 ms is comfortable) before reading `getComputedStyle` or taking a screenshot in any marker-visibility test. The upside of the same rule: occlusion transitions in and out smoothly for free, so don't add your own animation.

### `visibility: 'none'` is the only way to make a layer free per frame

**Symptom** — you "hide" a layer with an always-false `setFilter`, or push it out of range with `setLayerZoomRange`, expecting it to stop costing anything. It still costs a full style re-evaluation on **every frame**. `Style.update()` skips `layer.recalculate()` for exactly one condition — `visibility === 'none'` — so any other way of emptying a layer keeps it in the recalculate loop, keeps its symbol layers in `_updatePlacement`'s first pass, and keeps it in `queryRenderedFeatures`' two full passes over `_mergedOrder`. Worse, `setFilter` and `setLayerZoomRange` both route through `_updateLayer`, which triggers a **source reload** — so the "cheap hide" is more expensive than doing nothing. This matters here because a loaded scene mounts ~200 root-scope overlay layers and 40–50% of them are empty at any moment (live-draw, selection, transform, edit-handle, per-kind and per-opacity-bucket layers all sit at zero features until the user acts).

**Fix** — hide with `setLayoutProperty(id, 'visibility', 'none')`. `src/lib/empty-layer-gate.ts` does this automatically for any layer whose GeoJSON source holds zero features: it wraps `addSource` / `addLayer` / `removeSource` / `removeLayer` / `setLayoutProperty` on the map plus each source's own `setData`, so no overlay file has to opt in. Two invariants keep it UX-neutral — **app intent wins** (a layer the app hid stays hidden even when data arrives, which is what protects the per-kind toggles) and **unknown means visible** (a source whose feature count can't be read is never gated). Restore happens synchronously inside `setData`, before the worker parse that makes the data renderable, so it can't flicker. Don't add a second, competing hide mechanism; if a new overlay needs a layer hidden for app reasons, call `setLayoutProperty` and let the gate compose with it.

### `map.getLayer(id)` returns `serialize()` — visibility is nested, not top-level

**Symptom** — you read `map.getLayer(id).visibility` to check whether a layer is hidden and always get `undefined`, so every layer looks visible. `Map.getLayer` returns `layer.serialize()`, which nests layout props under `.layout`, so the property is at `.layout.visibility` — and it's omitted entirely when the layer is at the default `'visible'`. Reading the top-level field produces a silent, uniform "nothing is hidden" answer, which cost real debugging time here: a browser check of the empty-layer gate reported *0 gated layers* and a null A/B result, and the gate was working the whole time.

**Fix** — read visibility with `map.getLayoutProperty(id, 'visibility') ?? 'visible'`, never off the `getLayer` result. Related, if you ever need to bypass a Map-level wrapper (only ever justified in a throwaway measurement script), note that `map.setLayoutProperty` delegates to `map.style.setLayoutProperty` + `_update(true)` — so `map.style.setLayoutProperty` writes underneath anything that wraps the public method.

### Retry `addLayer` on "source not found" — `getSource()` lies about presence in Mapbox 3.x

**Symptom** — `Error: layers.dl-N-icon: source "dl-N-src" not found` inside a multi-step install. The install just added the source (previous `[map-diag] addSource` line for the same id is present), the point layer went on fine, then the icon/label adds throw. Guarding with `if (!map.getSource(id)) addSource(...)` DOESN'T help — `getSource` returns undefined right after a successful `addSource`, and the follow-up re-add throws Mapbox's confusingly-worded `sources.dl-N-src.clusterProperties: object expected, object found` because the source is actually still there and Mapbox is refusing the duplicate. The mount-diagnostics show `⚠ DUPLICATE addSource … still mounted from add #2, no removeSource between`, confirming the source never actually left.

**Fix** — never trust `map.getSource(id)` mid-install; wrap `map.addLayer` in a try/catch that only re-installs the source when Mapbox specifically complains `source … not found`, and cap the retry at one attempt so a stuck loop doesn't spin. See `installSourcesAndLayers` → `addLayerGuarded` in `map-data-linked-overlay.tsx`. Also OMIT (not `undefined`) the `cluster*` keys when clustering is off — the geojson-source validator rejects `clusterProperties: undefined` with the same "object expected, object found" message, which masquerades as the layer-add error above when both fire in the same install pass.

### `queryRenderedFeatures` throws on a layer id that isn't mounted

**Symptom** — a qRF call with an explicit `layers` array throws as soon as one of those ids isn't on the style yet. Overlays mount asynchronously and layers come and go across style swaps, floor changes and HMR, so any hardcoded id list is periodically wrong. It surfaces as an exception inside a click or mousemove handler, which usually means the interaction just stops working with a console error and no other symptom.

**Fix** — filter the list first: `const layers = IDS.filter((l) => map.getLayer(l)); if (!layers.length) return`. `map-polygon-overlay.tsx` and `map-circle-overlay.tsx` have always done this; `map-grid-overlay.tsx` had two unguarded calls and was fixed. Note the guard also has to handle the empty result — passing `{ layers: [] }` queries nothing, which is fine, but skipping the call entirely is clearer about the "no layers yet" case.

### GL JS runs on 2 worker threads and the default GPU unless you say otherwise

**Symptom** — you assume GL JS scales itself to the machine. It doesn't, in two ways, and both are invisible until you read its source. `WorkerPool.workerCount` is **hardcoded to `2`** and never derived from `navigator.hardwareConcurrency`; since every `GeoJSONSource` pins itself to one actor round-robin in its constructor, all ~100+ of our sources parse and tessellate on two threads whether the machine has 4 cores or 24. Separately, GL JS builds its WebGL2 context attributes from a fixed set that contains **no `powerPreference`**, so on a hybrid-graphics laptop the browser hands back the default adapter — on Windows that's normally the integrated GPU, not the discrete one. Neither is exposed as a `Map` constructor option, so nothing in the public API hints that they exist.

**Fix** — `src/lib/mapbox-runtime-tuning.ts` sets both, and `mapbox-map.tsx` calls it immediately **before** `new mapboxgl.Map(...)`. Ordering is not optional: the GL context is created inside the constructor and the worker pool is sized on first acquire, so neither can be changed once a map exists. If you ever add a second map construction site, call `tuneMapboxRuntime()` there too — it's idempotent. Don't bother with `mapboxgl.prewarm()` alongside it: it only saves worker-spawn latency on the *first* mount (the pool is module-global and stays warm afterwards), and since `mapbox-map.tsx` is in the main bundle, calling it at module scope would spawn workers on the login screen.

### Measuring the map: `gpu-timing-layer` is broken and `averageFPS` is always 0

**Symptom** — the two things you reach for first when profiling the map both mislead you. (1) GL JS's own `averageFPS` reads `0` forever in a production build: `updateAverageFPS` is defined inside an `index.Debug.run(...)` block, and `@rollup/plugin-strip` removes every `Debug.*` call site from the shipped bundle — verified absent from `dist/mapbox-gl.js`. Its Tweakpane devtools panel is gone for the same reason (tweakpane isn't in the production bundle at all). (2) Subscribing to the official **`gpu-timing-layer`** event throws `r.getQueryParameter is not a function` **once per layer per frame** — 208 page errors in a single short pan. It's an upstream bug: `Painter.queryGpuTimers` calls `ext.getQueryParameter(...)` / `ext.deleteQueryEXT(...)` on `context.extTimerQuery`, but that ext is `EXT_disjoint_timer_query_webgl2`, which exposes only the `TIME_ELAPSED_EXT` / `GPU_DISJOINT_EXT` constants — the query methods live on the *context*. It's leftover WebGL1 `EXT_disjoint_timer_query` API applied to the WebGL2 extension. The frame-level paths get it right (`gl.getQueryParameter`), which is why one works and the other doesn't.

**Fix** — use **`gpu-timing-frame`** only. It survives into production, it works, and its payload carries **both `cpuTime` and `gpuTime`** measured over the same `_render` call — which is what you actually want for a CPU-vs-GPU-bound verdict. Don't compare GPU time against the *frame interval*: the interval also contains compositing, unrelated JS and vsync waiting, so it flatters the GPU. For frame rate, sample the map's own **`render` event** rather than a rAF loop — rAF keeps firing at vsync while the map sits idle and will report a confident, fictional 60fps. `src/components/map-perf-monitor.tsx` does all of this — on by default in dev, and on a production build open it once with `?perf=1` (or Ctrl+Alt+P) and the `sgv-perf-hud` preference keeps it up across reloads. Extend it instead of writing a new harness. Note GPU timing is opt-in there because GL JS only issues timer queries when something is subscribed, so leaving it on taxes what it measures.

---

## Drawing tools and elevation

### Lift the in-progress draw chain to the tool's elevation

**Symptom** — rendering the in-progress draw chain (polygon / line click-chain dots + guide line) with plain `circle` and `line` layers that don't specify a `-z-offset`. Users draw a polygon on top of a floor plan sitting at altitude 4 m. The saved shape ends up correctly elevated (fill-extrusion base/top respect the config), but the yellow dots and dashed guide the user is TRACING with sit on the ground plane. As they pitch or pan the map the guide visibly drifts away from the elevated raster and the user can't line up their next click.

**Fix** — stamp `elevation` (**only** — NOT `elevation + height`; `height` is the saved-shape extrusion added on top after commit, the draw guide sits at the base) from `liveConfig` onto every chain feature (LineString and Point) and lift the layers explicitly: the guide LineString gets `line-elevation-reference: 'sea'` + `line-z-offset: elevation`; vertex dots switch from `type: 'circle'` to `type: 'symbol'` with `text-field: '●'` + `symbol-z-elevate: false` + `symbol-z-offset: elevation`. Mapbox 3.25 has no `circle-z-offset` (only `circle-elevation-reference`, which anchors to features), so `symbol` is the only reliable path for a screen-space dot at an absolute altitude. See `map-polygon-overlay.tsx` and `map-line-overlay.tsx` for the pattern.

### Unproject draw vertices at the tool's altitude, not at ground level

**Symptom** — storing polygon / line draw vertices from `MapMouseEvent.lngLat` when the tool has non-zero elevation. Mapbox's built-in unproject always hits the ground plane (z = 0), so `e.lngLat` returns the lng/lat of the ground point BENEATH the elevated raster the user is actually pointing at. If the vertex is then rendered at `symbol-z-offset: elevation`, camera pitch parallax makes the dot appear shifted UP-screen from where the mouse actually clicked — the more pitch and the higher the elevation, the worse the offset. Same issue for the cursor-tracking preview edge on `mousemove`.

**Fix** — ray-cast the click's screen point against a horizontal plane at the tool's `elevation` via the `unprojectAtAltitude(map, point, altitudeMeters)` helper (`create-grids/hooks/unproject-at-altitude.ts`): read the free camera in `MercatorCoordinate` space, interpolate the ray from camera to `map.unproject(point)`, and solve for the intersection at the target mercator z. Use the returned lng/lat as the stored vertex and as the cursor preview — that vertex now projects back to exactly the pixel the user clicked, matches the elevated raster under the cursor, and stays aligned as the user pans/pitches.

### Turn `fill-extrusion-vertical-gradient` off on thin elevated slabs

**Symptom** — leaving `fill-extrusion-vertical-gradient: true` on polygon / circle / line-wall layers when the user's shape has `elevation > 0` and `height = 0`. The min-thickness fix (`fill-extrusion-height = elevation + max(height, 0.05)`) makes elevation-only slabs render as a 5 cm-thick paper. Vertical gradient darkens the extrusion from top to bottom across its full vertical span, so a 5 cm span collapses the gradient to almost pure black across the whole polygon. At low zoom / oblique pitch it reads as a shadow blob against the floor plan raster and disappears entirely; at higher zoom it re-appears because the gradient's per-pixel darkening becomes discernible.

**Fix** — disable the gradient on polygon / circle / line-wall extrude layers (`'fill-extrusion-vertical-gradient': false`). Grids already do this. Users lose the subtle Mappedin-style base shadow on tall extrusions, but the trade for "elevated shapes always visible over a floor plan" is worth it. If the shadow look becomes important again, the right path is a data-driven expression that toggles the gradient off only when `height < some threshold` — but data-driven isn't supported on this paint prop today, so `false` globally is the current answer.

### Stamp the toolbar's Default Floor Plan onto every new create-* flow

**Symptom** — forgetting to stamp the toolbar's Default-Floor-Plan onto a NEW create-* flow. Every create-* handler under `create-grids/handlers/` (polygon / circle / line / marker / model / stair / text label / grid / image plane / door) reads `defaultFloorPlanIdRef.current` and passes it as `floorPlanId` on the new row. A new create flow that skips this step will produce shapes with `floorPlanId = undefined`, and the user hits the same "everything's unassigned, now I have to bulk-assign" workflow the picker was built to eliminate. Images are the deliberate exception — an image IS a floor plan, and pinning it to another floor plan is a rarer multi-storey-stack workflow that goes through bulk-assign explicitly.

**Fix** — when you add a new create-* handler, mirror the existing pattern: `floorPlanId: defaultFloorPlanIdRef.current ?? undefined` alongside `zoneId: wid ?? undefined`. The ref (not the state) is what handlers read — it avoids relisting `defaultFloorPlanId` in every draw-mode effect's deps and tearing down click bindings mid-draw. For store-backed kinds (`useDoorStore`), sync the store's scope instead: an effect keyed on `[activeWarehouseId, defaultFloorPlanId]` calls `useDoorStore.setScope(warehouseId, defaultFloorPlanId)`, and the store's `toCreatePayload` picks that up.

### Wire a new draw tool's `elevation` into the floor-plan elevation sync effect

**Symptom** — adding a new draw tool whose config carries an `elevation` field without wiring it into the default-floor-plan elevation sync effect. The toolbar's default floor plan sets `defaultFloorPlanElevation` in `create-grids/index.tsx`; a `useEffect` keyed on that value patches every existing tool config (`polygonConfig` / `circleConfig` / `lineConfig` / `markerConfig` / `modelConfig` / `textLabelConfig`, `stairConfig.baseElevation`, grid `config.elevation`, plus `useDoorStore.updatePendingConfig({ elevation })`). Image planes read the value through the `ImagePlaneTool` `elevation` prop. Miss the sync for a new tool and the sidebar slider stays at 0 while the user's floor plan sits at 24 ft — the shape then lands under the plan and the user has to re-tweak elevation on every draw.

**Fix** — when adding a new draw tool, if its config has an `elevation` (or equivalent — stairs use `baseElevation`) field, add the corresponding `set<Kind>Config((c) => ({ ...c, elevation: elev }))` call inside the sync effect. For store-backed kinds, mirror the door pattern (`updatePendingConfig`). For tools that receive elevation as a prop (image planes), pass `defaultFloorPlanElevation` in the JSX. The sync intentionally overwrites any prior manual tweak on floor plan change — floor plan is the source of truth for "default altitude at this floor"; per-shape overrides happen from the side panel after drawing.

### Ask the owning generator for corners instead of re-deriving them

**Symptom** — placing an overlay that rides on another shape's bbox by re-deriving the rotation and offset from that shape's config. Anything drawn into a floor plan's quad shares it with the raster, the hit polygon, the selection outline and the transform handles. An independently-derived placement drifts from all four by rounding and by whatever the two implementations quietly disagree about, so the shape selects in one place and renders in another — and the error is small enough to read as a rendering artifact rather than as a second implementation of the same arithmetic.

**Fix** — ask the owning generator for the corners **once** (`imageCorners(shape)` in `image-generators.ts` — already turf-rotated) and bilinearly interpolate across them: ~8 multiply-adds per point, exact on the outer edge, and it cannot drift from the raster because it is derived from it. Per-point turf great-circle calls are also not a frame budget.

---

## Shapes, images and floor plans

### Anything sloped can't be a fill-extrusion

**Symptom** — the first escalator drew its truss, side cladding, glass balustrades and handrails as one extrusion per tread, so every inclined surface came out as a staircase of boxes (and the rail as dashes). `fill-extrusion` only extrudes vertical prisms from a flat footprint — there is no sloped top.

**Fix** — escalator treads stay extrusions (they *are* boxes); every inclined or curved part is a swept triangle mesh drawn by `LiftMeshLayer` (`src/lib/lift-mesh-layer.ts`), built from `escalatorProfile` in `vertical-transport-generators.ts`. Custom layers are invisible to `getStyle()` and `queryRenderedFeatures`: the translucent glass instance is ordered through `style.order` by translucent-layer-order.ts, and clicks still select the escalator through its extruded treads and plates.

### Lift glass must draw after every 3D layer, as panes with edges

**Symptom** — balustrade and shaft glass showed on only part of one side, or not at all, in a store with translucent areas/racks. The glass mesh layer writes no depth, and the sorter ranked it like a 35% extrusion; any area under 35% opacity drew *after* it, and that extrusion's depth pre-pass + colour pass painted over every pane in front of it. Separately, a flat tint with constant alpha read as blue plastic, not glass.

**Fix** — `translucent-layer-order.ts` gives translucent custom layers a sort weight of −1, so they draw after every other 3D layer (bump `ORDER_VERSION` when the rules change: a hot-reloaded sorter replaces a stale installation by version). Glass is built with `MeshBuilder.pane` / `paneBand`: clear broad faces (`GLASS`, alpha 0.12) and opaque-ish teal edges (`GLASS_EDGE`), balustrades split into ~1.25 m panels with joints and lifted 5 mm off the deck. `LiftMeshLayer`'s glass path shades per fragment with the camera in mesh metres (`u_camera`, from `getFreeCameraOptions().position`): Schlick Fresnel, specular, and soft world-fixed reflection streaks — face-on glass otherwise disappears. Verify with racks/areas visible, not in an isolated scene.

The sorter must decide in **root** order (`style._order`, what `moveLayer` edits), never `style.order`: that is the merged *draw* order, and Mapbox's `mergeLayers` re-sorts it, pushing symbol layers with occlusion-opacity properties (rack labels, lift icons) after the last 3D layer. Anchoring `moveLayer(glass, 'grid-label-layer')` from the draw order dropped the glass in front of the walls, treads and solid lift mesh in root order, so the panes still vanished on a real store (zone 71) while the test facility happened to pass. Check with "which opaque 3D layers draw after the glass in `style.order`", which must be none.

### Regular stairs are meshes too — their step boxes are only click targets

**Symptom** — straight/L/U stairs were one extrusion per step, each two risers tall: a jagged staircase of boxes underneath, a landing slab floating in mid-air, no railings.

**Fix** — `stair-mesh.ts` builds the stair (treads with nosings, risers, sloped soffit, landing slab + columns, railings) and the overlay draws it through the same mesh layers as lifts (`stairMeshes`). The step extrusions are kept, flagged `hit: true`, so `STEP_LAYER` skips them and the zero-opacity `stair-lift-hit-layer` catches clicks and hovers; borders, selection outlines and marker occlusion keep using them. Both come from one `stairLayout`, so they can't drift apart. Mesh positions are metres from `vertices[0]`: a move changes the mesh *origin*, not its positions — test against `data.origin`. Anything that hides stair extrusions with `NOT_HIT` (the in-flight layer) must push a mesh instead (`pushInflightMesh` handles every stair type).

### Doors: anything on a leaf's face can't be an extrusion either

**Symptom** — door panel mouldings, the knob and the hinges were extrusions raised from footprints *inside* the leaf, so they came out as bumps along the leaf's top edge and the door read as a stack of boxes; box-top outlines floated over it.

**Fix** — `src/lib/door/mesh.ts` builds the door (frame + architrave, moulded panels on both vertical faces, lever handles, hinges, sliding track, revolving drum) and the door overlay draws it on its own mesh layers. The door features are now just jambs, leaves and lintel, at fill opacity 0 (click / selection targets) with the outline layers at line opacity 0. Leaf placement comes from the same `buildLeaves`, so open / ajar, hinge side and swing stay in sync. Shadowed faces need the solid shader's fill light: with key light + flat ambient only, a door's back face read as one flat grey even with panels on it. When judging a render, plain grey slabs with a vertical gradient are Mapbox extrusions (e.g. a user's bay-divider walls), not meshes.

### Lifts span floors — filter them by every floor they link, and keep the glass split in every stair filter

**Symptom** — an elevator assigned (`floorPlanId`) to the ground floor vanished when the viewer showed only floor 3, and hiding the ground floor in the editor took the whole lift with it. Separately, any `setFilter` on `stair-step-layer` that only matched `shapeId` (the transform exclusion did exactly that) dropped the `glass` split, so shaft and balustrade glass drew as solid grey walls.

**Fix** — floor gates keep a lift while **any** floor in `liftFloorPlanIds(config)` is shown (`view.tsx` stairs memo, `savedStairs` in `create-grids/index.tsx`). In `map-stair-overlay.tsx` every filter on the shared step source is composed: `['all', NOT_GLASS, shapeFilter]` for the solid layer and `['all', IS_GLASS, shapeFilter]` for `stair-glass-layer`. Lift heights come from the linked floors at render time (`floorElevations` prop) and are mirrored into the stored config by `withStoredLevels`, so consumers without floor data (marker occlusion) still match.


### `ImageShape` (floor image) is not `ImagePlaneShape` (3D image plane)

**Symptom** — confusing the two. They're two distinct shape kinds with different rendering pipelines. `ImageShape` is the **floor image** — a flat textured quad (`FloorPlanLayer` custom layer) at a fixed elevation, never rotates in 3D. `ImagePlaneShape` is the **3D image plane** — wrapped at runtime into a textured-plane GLB by a **hand-crafted writer** in `src/lib/image-plane-generators.ts` (not `@gltf-transform/core` — see "Hand-write GLBs for Mapbox" above) and rendered via Mapbox's `model` layer, so it supports elevation + per-axis (X/Y/Z) rotation. They live in separate tables (`images` vs `image_planes`), separate spatial-store slices (`images` vs `imagePlanes`), separate overlays (`map-image-overlay.tsx` vs `map-image-plane-overlay.tsx`), and separate toolbar tools (`create-image` vs `create-image-plane`).

**Fix** — pick the right kind for the use case: floor plans / overhead photos = `ImageShape`. Vertical billboards, signage, posters tilted in space, anything needing 3D rotation = `ImagePlaneShape`. Don't extend the floor-image overlay with 3D transforms — the raster source can't do that. The 3D plane GLB is synthesised at render time (not persisted) so swapping the image automatically rebuilds the texture.

### Store an image crop in config, never by shrinking `start` / `current`

**Symptom** — applying a non-destructive rectangular crop to a floor-plan image by modifying `start` / `current` directly. The natural instinct when the user drags four crop sliders is to shrink the shape's world bbox to match. But `start` / `current` also drive selection outline, hit testing, the clip footprint, and every future transform — collapsing them means a subsequent uncrop (setting the sliders back to 0) has nothing to grow from, and every prior map alignment is silently lost.

**Fix** — store the crop as `ImageShapeConfig.crop = { top, right, bottom, left }` (percentages 0-95, sums per axis < 100) and leave `start` / `current` alone. The raster's own source coordinates come from `imageCroppedCorners(shape)` in `image-generators.ts` (shrunk bbox, rotated around the FULL center); everything else keeps reading `imageCorners(shape)`. Cropped bytes are canvas-produced by `getCroppedImageDataUrl()` with an LRU cache. Backend needs no migration — `config` is JSONB.

### Wrap every object-store URL in `rewriteFilesUrlSameOrigin()`

**Symptom** — rendering or fetching an object-store URL (`/files/<key>`) raw. Old rows in the DB have absolute URLs baked in (e.g. `http://localhost:8080/files/...`) from when `SGV_STORAGE.BASE_URL` defaulted to a fully-qualified host. When another LAN machine opens the SPA, that absolute URL resolves against THAT machine's localhost — no backend there → broken image / blank model / failed plane texture fetch. The default is now relative (`/files`) so new rows are fine, but legacy rows still break. The floor-image overlay was fixed first; profile avatars and the image-plane texture fetch + side-panel preview were doing it raw and broke the same way.

**Fix** — any time you render or fetch a URL that may have come from `imageUrl` / `modelUrl` / `avatarUrl` / `image_url`, wrap it in `rewriteFilesUrlSameOrigin()` from `@/lib/binary-store`. The helper is a no-op on data:/blob:/relative URLs and only rewrites absolute URLs containing `/files/`. Read sites today: `user-menu.tsx`, `routes/profile.tsx`, `side-panel.tsx` (image-plane preview + `urlForImage`), `createImagePlaneGlb()`, `urlForModel()`.

### Routes are their own shape kind, not a `LineShape` config flag

**Symptom** — adding a route-style path shape as another `LineShape` config flag instead of its own kind. The `line` overlay renders 3D-wall extrusions, does wall-thickness buffering, snaps to axis + endpoints, and threads through the door / wall-attachment pipeline. A wayfinding path is semantically opposite — it should draw at any angle without axis lock, carry a `RouteType` (walking / driving / emergency / forklift / accessible / service) that drives colour, render directional arrows, and eventually feed a pathfinding graph. Overloading `LineShape` with an "isRoute" flag would either sprout branches everywhere in `map-line-overlay.tsx` OR silently apply wall paint to routes. Bit no one yet because the tool is new, but shipping it as a config flag would have.

**Fix** — routes are a first-class shape kind: separate table (`routes` migration 0025 mirroring `lines`'s columns), separate type (`RouteShape` in `src/lib/shapes.ts`), separate generator (`src/lib/route-generators.ts`), separate overlay (`src/components/map-route-overlay.tsx`). Every kind-aware list — `EntityKind`, `CatalogEntity`, `ALL_KINDS`, `tablePath`, `kindStateKey`, spatial-store slice, `mutation-queue.ts::tablePath`, `useSSE.ts::VALID_KINDS`, `api-db.ts`, `useSpatialShapes.ts::useSpatialRoutes`, `LayerVisibilityKind` + `LAYER_ROWS` in `map-toolbar.tsx`, `LayerKind` + `DEFAULT_LAYER_ORDER` in `side-panel.tsx`, `SidePanelMode`, `overlay-hit-priority.ts::PRIORITY` (sit above `line`), `keyboard-shortcuts.ts::CREATION_TOOLS` — carries the new `routes` / `route` literal. Pathfinding graph: each `RouteShape.vertices[i]` IS a graph node when A* / Dijkstra ships; consecutive pairs are edges. The solver reads `config.type` to filter to relevant edges (e.g. don't route a wheelchair down `driving`).

---

### Model thumbnails came out blank or cropped

**Symptom** — pre-rendered previews for some built-in models were empty (the first model on the page), white, or cropped to one side. `<model-viewer>`'s `load` event fires before textures finish and before the camera settles on the framed bounds; the very first viewer on a page can also capture an empty frame while its environment map loads. Forcing `updateFraming()` / `field-of-view="auto"` made a rigged model come out empty every time.

**Fix** — `renderModelThumbnail` (`lib/upload-library.ts`) waits for `updateComplete` + ~700 ms, calls `jumpCameraToGoal()`, captures, and **rejects a capture with almost no opaque pixels and retries** (up to 4×). One viewer at a time (each is a WebGL context; browsers cap ~16). A model that's genuinely untextured (`industrial_forklift_pnuematic_tire`) or has stray far-off vertices (`rusty_metal_warehouse_shelving`) will still look pale / small — that's the file, not the renderer. Built-in thumbs are files (`scripts/generate-model-thumbnails.mjs`); uploads store an inline data URL on `user_models.thumbnail`.

**Mappedin built-ins lie on their side in `<model-viewer>` but sit correctly on the map** — the two renderers disagree about these GLBs' up axis. Don't "fix" it with a placement rotation (that tips them over on the map); `ModelAsset.previewOrientation = '0deg -90deg 0deg'` is passed to every preview (`ModelPreview`, the model-library preview, `renderModelThumbnail`). Verify map orientation with the basemap's 3D buildings hidden and the **placement ghost gone** — in place mode the unrotated cursor ghost sits wherever the mouse last was, and it's easy to mistake it for the placed model.

### A placement that reads an in-flight upload must await it

**Symptom** — dragging a fresh floor plan before its upload finished created the row with the whole picture inlined as base64 in `images.image_data` (fixed later by `migrateImageRow`, but it bloated every list fetch until then).

**Fix** — the draft carries `pendingUpload` (the upload promise); `useImagePlacementTool` awaits it before `createLocal` and gives up rather than inlining. The user can still start dragging immediately; the draft card shows "Uploading…".

### Printing any page came out blank

**Symptom** — Ctrl+P / "Save as PDF" on any screen printed an empty page. A global `@media print` block for an old map print layout hid `body *` and only re-showed `#view-root`, which nothing renders any more.

**Fix** — that block is scoped to `html.sgv-print-map`; report PDF export has its own rules under `html.sgv-printing-report`. Never put unscoped `body *` rules in a print block.

### SheetJS Community Edition can't write cell styles

**Symptom** — fills, fonts and colours set on cells vanish in the downloaded .xlsx: styling is a SheetJS Pro feature.

**Fix** — `reports/export/xlsx.ts` writes the OOXML parts itself (styles.xml, sheets with inline strings, freeze panes, autofilter + `_xlnm._FilterDatabase`) and zips them with SheetJS's bundled `XLSX.CFB` writer — no new dependency. Validate a change by opening the file in LibreOffice (`soffice --headless --convert-to pdf file.xlsx`) as well as reading it back with SheetJS; SheetJS is lenient and will read files Excel rejects.

## Data-link layers and tables

### Tooltip templates use single braces, not `{{ }}`

**Symptom** — advertising a data-link tooltip template as `{{payload.field}}` (double-brace Handlebars-ish). The runtime template resolver is `resolveLabelTemplate()` in `src/lib/data-link/style-rule-evaluator.ts`. It matches `\{([^}]+)\}` — SINGLE braces — and looks the key up via `readPayloadAttribute` (flat keys, with a `custom.<key>` shortcut into `payload.customProperties`). So a template of `{{payload.status}}` renders literally as `{{payload.status}}` because the outer braces never match. The v1/v2 editor placeholder + hint text advertised the wrong syntax and users wrote non-working templates without seeing any error.

**Fix** — only advertise + accept `{fieldName}` (or `{custom.key}` for custom-properties). The v3 editor (`data-link-editor-v3.tsx`) uses that syntax in placeholder + info tooltips AND renders a live preview by running `resolveLabelTemplate` against the sample record so users see exactly what the tooltip will show. If you extend the template language (nested paths, filters, conditionals) update BOTH `resolveLabelTemplate` AND the v3 editor's info-tip copy together.

### `readPayloadPath('custom.foo', payload)` tries five container conventions

**Symptom** — assuming it will only resolve `payload.custom.foo`. `sample-augmentation.ts` stamps custom attributes into records as **literal flat keys with a dot in the NAME** — ``records[`custom.${def.key}`] = value`` writes `payload["custom.opstatus"]`, NOT `payload.custom.opstatus`. `flattenPayload` in the editor emits `custom.opstatus` as the path (Object.entries walks flat keys unchanged), the user picks it, and it lands in the DataLinkConfig. But the runtime resolver split on `.` and walked → `payload.custom.opstatus` → undefined → em-dash for every field in the drawer's ATTRIBUTES section and the popup body. In parallel, some feeds use `payload.customProperties.foo` (Bin-style, from JSON/CSV/GeoJSON importers), some `payload.custom_foo` (REST column-prefix), some flat `payload.foo` — five conventions in the wild for the same UI concept. Style-rule-evaluator's `readPayloadAttribute` had ONE shortcut (`custom.foo` → `customProperties.foo`) so rules kept working; the match-resolver had NONE and the two surfaces silently diverged.

**Fix** — `readPayloadPath` in `src/lib/data-link/match-resolver.ts` now tries lookups in priority order: (0) `payload["custom.foo"]` — the whole path as a flat key, catching the sample-augmentation case; (1) dot-split walk `payload.custom.foo`; (2) `payload.customProperties.foo`; (3) `payload.custom_foo`; (4) `payload.foo`. First non-undefined wins. The (0)-first order matters because dotted-key payloads are the norm — sample-augmentation seeded them and the field-picker's paths reflect that shape. If you add a new container convention (say `attrs.<key>`), extend the fallback list rather than teaching every caller about it. Never move (0) below the dot-split — that would break parity with `flattenPayload`.

### Seed user-built tables from `starterFieldsForKind`, not a fourth manifest

**Symptom** — starting a user-built table at one blank field, or hand-writing a fourth per-kind column manifest to seed it. A table built in the SPA and a source ingested from a file or a REST poll both end up in `data_source_rows`, and nothing downstream can tell them apart — the layer editor reads the **payload**. So a hand-built "Marker / POI" table that doesn't carry the marker sample file's keys silently breaks every feature that matches by name: the v3 editor's `suggestField()` coordinate auto-detect finds no `lng` / `lat`, external-code match finds no `external_code`, attribute joins find no `linked_shape_name`. Nothing errors — the table just never links to anything, and the user reads it as "the map layer is broken". The seeding half is easy; the manifest half is the trap: three per-kind lists already exist (`ENTITY_KIND_DEFS` in `entity-kind-picker.tsx`, `SAMPLE_SPECS` in `data-link/sample-records.ts`, `validateColumnsForKind`), and a fourth would drift from the sample file the user is comparing their table against.

**Fix** — seed from `starterFieldsForKind(kind)` (`src/lib/table-starter-fields.ts`), which derives the set from `SAMPLE_SPECS` — the same source the sample downloads use, so the two can't disagree. Seed `external_code` / `lng` / `lat` / `linked_shape_name` as ordinary payload fields: `writeOneRow` (`import_pipeline.go`) stores the raw import row **unmodified** as the payload and derives `entity_key` / `position` / `linked_shape_name` *in addition*, so seeding them is exact ingest parity, not duplication. Re-seed on a kind change **only while the seeded list is untouched** (`signatureOf` over key+label+type+required+unique) — swapping the picker must never discard typed-in fields; offer the missing columns through the "Add them" banner instead. Then close the loop on row entry: a seeded required `external_code` plus `CreateRowDialog`'s own `entity_key` input asks for the same value twice, so the dialog derives the key via `identityField(fields)` (mirrors `rowEntityKey`'s fallback list) and stamps `position` via `coordFields(fields)` (mirrors `rowCoord`'s column names). Seeded **labels stay English** — they become `table_field_definitions.field_label`, i.e. row data, so translating at seed time freezes the creator's language for every other viewer.

### A new `renderMode` needs a `MODE_CAPS` row, not just `RENDER_MODES`

**Symptom** — adding a new `renderMode` to `DataLinkRenderMode` but only wiring it into `data-link-editor-v3.tsx`'s `RENDER_MODES` list without updating `MODE_CAPS`. The v3 editor drives every conditional section (match block, coord fields, elevation, cluster toggle, value vs label field, style block variant, tooltip block, etc.) off `MODE_CAPS[renderMode]`. A missing entry crashes with `Cannot read properties of undefined (reading 'needsShape')` the moment the user picks the new mode.

**Fix** — when you add a mode, add both a `RENDER_MODES` entry (label + description + Lucide icon) AND a `MODE_CAPS` row that flags exactly which sections apply. Colour label (`colorLabel`) is the badge/fill/line/cone/ring naming the picker shows in section 6. Also verify `map-data-linked-overlay.tsx` has a sub-renderer for the new mode — the editor is a mirror of the overlay, not a source of truth.

### Every data-link render mode has to stamp `elevation` itself

**Symptom** — a data-link layer bound to a second-floor shape draws on the ground and stays visible through the slab above it. The cause is not the depth test; it's that only `point-at-coord` ever put an altitude on its features. The other seven modes emitted GeoJSON with no `elevation` property, so `symbol-z-offset` / `line-z-offset` / `fill-z-offset` resolved to 0 no matter which floor the anchor was on. The layers looked "flat but correct" for a long time because a single-floor scene can't tell the two apart.

**Fix** — resolve the altitude per feature and stamp it into `properties.elevation`, then read it back with the shared `Z_OFFSET` expression (`['coalesce', ['get', 'elevation'], 0]`). `resolveAnchorElevation()` is the resolver: `fieldMapping.elevationField` off the payload first, else the matched shape's `config.elevation`, else 0. `forEachEntityAnchor` hands `elevation` to its visit callback so shape-anchored modes get it for free. Two mode-specific rules: **shape-tint** uses `slabTopM()` plus a 2 cm epsilon so the tint lands on the top face instead of being buried inside the solid. `slabTopM` mirrors the overlays' own floors (polygon base ≥ 0.11 m, thickness ≥ 0.05 m): plain elevation + height is 0 for a flat area, which sat the tint *inside* the 0.11–0.16 m slab and hid it on every flat room (2026-10, a demo facility demo); **track** lifts the whole breadcrumb to the *latest* event's floor, because `line-z-offset` elevates a feature, not a vertex. `heatmap` is screen-space and can never be elevated or occluded at all — that is why the mode cross-fades into a `minzoom: 18` dot layer, which can.

### Floor-gate data-link entities through `passesFloorScope`

**Symptom** — filtering data-link entities on `resolveEntityFloor(payload) === activeFloorPlanId` without accounting for orphan floor references. Ingest sources bake `floorId` / `floorPlanId` into the row payload at ingest time. If the referenced floor plan later gets deleted and re-added (new id), every already-ingested row still points at the dead id. The pre-fix filter did strict `entityFloor === activeFloor`, so those rows silently vanished on the current floor — the user sees "layer works on floor 2, empty on floor 1" and blames the layer, not the stale data. Bit `HOSPITAL STAFF` in the hospital demo. It also blocks legitimate use cases like "this REST feed only carries a room id — pin it to floor 3".

**Fix** — every floor gate in `map-data-linked-overlay.tsx` goes through `passesFloorScope(payload, config.fieldMapping.floorScope, activeFloorPlanId, liveFloorPlanIds, matchedShapeFloor?)` from `src/lib/data-link/filter-evaluator.ts`. Hosts (`view.tsx`, `create-grids/index.tsx`) MUST feed `liveFloorPlanIds` (the current set of image-shape ids) into `<MapDataLinkedOverlay>` — the helper uses it to detect orphan payload floors and treat them as *unknown* (show on every floor) instead of dropping the row. Users can override the auto behaviour per-config via the Floor scope section in the data-link editor v3: `auto` (default) / `all` (ignore floor) / `specific` (pin to a picked floor plan id list). Persists inside `fieldMapping.floorScope` — no migration; backend passes JSON through opaque.

### A floor `valueMap` must stay client-side, and name joins must respect it

**Symptom** — a table whose rows say `floor: "Level 1"`, linked with `floorScope {mode:'auto', field:'floor', valueMap:[{value:'Level 1', floorPlanId:68}, …]}`, rendered **nothing** on any single floor. `fetchLayerRows` pushed the active floor id to `POST /data-sources/:id/query`, whose `PushFloor` compares `COALESCE(payload->>'floorPlanId', 'floorId', 'floor')` to the raw id — `"Level 1" ≠ "68"`, so every row was dropped before the client could apply the map. A second bug hid behind it: an attribute join on `name` matches every shape with that name, and floors repeat names ("Bakery" on Ground and Level 1), so a Ground row also tinted the Level 1 room — floating in the air when only Ground was shown.

**Fix** — `layer-rows.ts` only sends the server floor gate in `auto` mode **without** `floorScope.field`; with a mapping field the client's `passesFloorScope` does it. Shape-anchored paths (`forEachEntityAnchor`, shape-tint) also call `shapeOnEntityFloor(payload, scope, shape.floorPlanId)` (`filter-evaluator.ts`): when the payload names a floor, shapes on other floors are skipped. Keep both: the server gate is still the right call for `floorPlanId`-keyed payloads at scale.

### A table-kind source has no stream — never gate the editor on `resolvedStreamId`

**Symptom** — picking a platform table in the v3 editor's source list leaves **Create/Save** permanently greyed out, under an amber banner telling the user to "recreate the source from Integrations". Nothing in the banner is actionable: `kind='table'` sources are created by `tables.go`, which never calls `CreateStream`, so the mirror stream the banner promises can never exist. The user reads it as "tables aren't supported as a source", which is the opposite of the intent — tables are the *easiest* source because they're built inside the platform.

The cause was a stale save gate, `canSave = … && resolvedStreamId !== null && …`. v3 flipped the source of truth from Stream → DataSource, and every other layer of the stack had already followed: `fetchLayerRows` (`layer-rows.ts`) reads `data_source_rows` off `config.sourceId` and only falls back to `streamId`; migration 0034 made `data_link_configs.stream_id` nullable; the handler maps `streamId: 0` → NULL. Even the **v2** editor carried the corrected gate with a comment explaining the flip. Only v3 — the newer file — still had the old one. A newer file is not automatically the more-correct one; when two editors coexist, port fixes forward explicitly.

**Fix** — require **one of** source or stream: `(sourceId !== null || resolvedStreamId !== null)`. Show the missing-stream banner only for a non-table source (`sourceObj?.kind !== 'table'`); for tables show the neutral `dataLink.tableSourceNote` instead. The one genuine exception is `STREAM_ONLY_MODES` (currently just `track`), whose sub-renderer calls `listEntityEventsForStream(config.streamId)` directly instead of going through `fetchLayerRows` — those cards get disabled when no stream is resolved. Table history does exist, in `data_source_row_events` behind `GET /tables/{id}/events`, but no client reads it yet; wiring that is what would let `track` support tables. Also suppress "Ingest records now" for tables — rows are pushed in, never pulled.

Two related traps. **Never leave Save silently disabled**: the button now carries a `saveBlockedReason` tooltip, which is the only reason this class of bug is noticeable at all. And `resolvedStreamId` deliberately falls back to `legacyStreamId` when the selected source has no stream, so re-pointing an old stream-bound config at a table keeps the stale `streamId` on the row; harmless for rendering (`sourceId` wins) but it means `track` stays enabled in that one edit path.

### Table writes reach the map on the *external* SSE channel

**Symptom** — pushing rows into a table via its API token doesn't move a table-backed layer until the 30 s `LAYER_ROWS_POLL_MS` tick. The obvious fix — adding `data-sources` to `VALID_KINDS` in `src/lib/useSSE.ts` — is wrong twice over: it would route the event into `useSpatialStore.loadKind('data-sources')`, which isn't a spatial kind, **and** it would stop forwarding the event to `subscribeExternalSSE`, silently breaking the `/data`, `/integrations`, and `/files` screens that already listen for it there.

**Fix** — `useSSE` forwards every kind *not* in `VALID_KINDS` to `subscribeExternalSSE`, which is the correct hook point for non-spatial kinds. `MapDataLinkedOverlay` subscribes there and calls `queryCache.invalidate('layer-rows')` on a `data-sources` event. `VALID_KINDS` is for kinds the spatial store owns; everything else is an external-channel subscriber.

### Filters are authored in the editor, chosen in the viewer — never both

**Symptom** — the viewer used to ship a full query builder (`view-filter-widget.tsx`) behind a funnel icon in the layers panel, so anyone opening a share link could construct arbitrary AND/OR trees against the raw payload. Three things were wrong with it: the person holding the link is the least likely to know which payload paths are meaningful; the resulting filter was stored on the share link as a **snapshot tree**, so two links "showing overdue pallets" could silently disagree; and it looked like a developer tool, not a report.

**Fix (v5)** — the split is: **the layer's author publishes named presets, the viewer picks one.** Presets live in `fieldMapping.filters` as `DataLinkFilterPreset[]` — opaque JSONB, so zero migration and zero backend work, exactly like `floorScope`. The tree editor moved verbatim into `src/components/data-link/filter-tree-builder.tsx` and is now a controlled sub-form (`value` / `onChange`) rather than a self-applying dialog; `filter-presets-section.tsx` wraps it as the editor's "Saved filters" section. The viewer gets `viewer-filter-bar.tsx` — chips, match state, and the active rule rendered read-only via `describeFilter`. There is deliberately **no ad-hoc escape hatch**: a link that says "Overdue" has to mean the same thing for everyone who opens it.

Three details that are easy to get wrong when extending this:

- **Share links persist the preset *id*, not the tree** (`ShareLinkSettings.dataLinkFilterPresets: Record<number, string>`). That's what makes editing a preset propagate to every link referencing it. The old `dataLinkConfigFilters` snapshot field was removed outright rather than dual-read — honouring it would have re-introduced the divergence the redesign exists to kill.
- **A missing key and `''` mean different things.** Absent = the viewer hasn't chosen, so the layer's `isDefault` preset applies. `''` = the viewer explicitly picked "All records" and the default must NOT reassert itself. `view.tsx` resolves both in one memo that emits the filter tree (for the overlay), the selected id (for the chips) and the label (for the layers-panel badge) together, so those three can't disagree about what's applied.
- **At most one `isDefault` per layer.** Both the star toggle and the dialog's save path demote siblings; the viewer reads `find(p => p.isDefault)` and would otherwise silently pick whichever sorted first.

**v5.1 addendum — runtime prompts.** A leaf whose value is left blank in the editor is a *prompt*: field + operator are fixed, the value is asked of the viewer when they pick the chip. Save uses `allLeavesAuthorable` (field + op only); the full-values check `allLeavesValid` is now only used at query time. `resolvePromptValues` walks the tree in the same traversal order as `collectPromptLeaves`, so runtime values are positional — reordering conditions in a saved preset would silently re-point the viewer's typed values, so treat preset editing as a versioning event. `view.tsx` holds runtime values in `presetPromptValues[configId][presetId]` and only feeds a filter to the overlay when `allLeavesValid` passes on the substituted tree; that's why partially-filled prompts show the layer unfiltered (safer than briefly rendering a broken query result). Prompt values are per-session only — not persisted in share links, so a link isn't handed a stranger's last inputs.

**v5.2 addendum — dialog with Apply/Cancel/Clear.** The viewer's picker is now a proper report-style dialog (`ViewerFilterBar` → `FilterDialogBody`) rather than a dropdown, because a real report can carry more filters than a menu can host and needs a proper form layout with per-layer clear + a global reset. The dialog owns a *draft* copy of the applied state and only commits on Apply, so the map re-queries at most once per gesture instead of on every keystroke in a prompt input. Two things to keep in mind if you extend it: (1) the trigger's `(N)` badge reads the applied state, never the draft, so closing the dialog with pending changes doesn't lie about what's on the map; and (2) the body component is keyed on `open` (mounted only while the dialog is open) so the draft state naturally re-seeds from props each open — do not add a hydration effect on top of that pattern.

---

## Theming, styling and navigation

### Keep `.theme-<id>` palette rules outside `@layer`

**Symptom** — putting `.theme-<id>` palette rules inside `@layer base` in `src/index.css`. Tailwind tree-shakes selectors inside layers when their class names don't appear as literal strings in `content` files. Palette classes are built dynamically (`theme-${id}`) so Tailwind can't see them — the rules are silently stripped from the compiled CSS and the picker does nothing for most palettes (only the few whose names happen to appear as literals in JSDoc/comments survive).

**Fix** — keep the palette block OUTSIDE any `@layer` directive (between the `@layer base` for `:root` / `.dark` tokens and the one for `* { @apply border-border }` resets). Plain top-level CSS rules are never purged. A `safelist: [{ pattern: /^theme-/ }]` in `tailwind.config.js` is also kept as belt-and-suspenders but the layer move is the real fix.

### Use the shared `ColorPicker`, never a raw `<input type="color">`

**Symptom** — a raw `<input type="color">` in the sidebar means the user can't paste a brand hex code or type one — only the OS colour picker works.

**Fix** — use the shared `ColorPicker` (or the `ColorRow` / `BulkColorRow` wrappers) in `src/components/side-panel.tsx`. It pairs the swatch with a hex text input; both stay in sync and the text input commits on Enter/blur. Accepts `#abc`, `abc`, `#abcdef`, and `abcdef`.

### `/dashboard` and `/warehouses` are two screens with two purposes

**Symptom** — conflating them. `/dashboard` is the **overview** (KPIs with 30d deltas, bin-status donut, activity timeline, top-N tables, recently-added) — all from `GET /api/v1/dashboard-overview`. `/warehouses` is the **operational list** (filterable table + per-row + bulk actions) with **filter-aware KPIs** (in-view / bins-in-filter / avg occupancy / assets-in-filter) from `filteredStats` on the listing response. Don't reuse the same 4 KPIs on both screens — the dashboard shows tenant-wide totals, the warehouses page shows totals scoped to the active filter.

**Fix** — put summary/trend/chart content on `/dashboard`; put list/filter/per-row actions + filter-aware KPIs on `/warehouses`. Both have their own nav item, both always visible.

### Never hide the active route from the nav

**Symptom** — the previous nav filtered out the current path, leaving only N-1 visible items. Users get disoriented and can't see they're on the active screen.

**Fix** — always render all `NAV_ITEMS`. Highlight the active one with `aria-current="page"` and a `bg-primary/10 text-primary` style. The convention applies to both desktop and mobile menus in `src/App.tsx`.

### An empty label config means no label — don't fall back to `shape.name`

**Symptom** — falling back to `shape.name` for an empty label config. Polygons/circles silently render their auto-name ("Polygon", "Area") on the map even when the user left the Label field empty.

**Fix** — don't add a name-fallback in the label-rendering path. Empty `config.label` means no label rendered. The `name` field is only for the workspace tree and side panel identification.

### Don't read `auth-store.token` in a component

**Symptom** — reading `auth-store.token` directly in a component couples the UI to the storage shape and bypasses re-renders.

**Fix** — use `useAuthStore(s => s.user)` or `roleForTenant(id)`.

### Every protected route goes inside `<AuthGuard>`

**Symptom** — a new protected route added outside `<AuthGuard>` is accessible to anyone without login.

**Fix** — declare it under the catch-all guarded `<Route path="*">` in App.tsx.

### Run every stored map style id through `normalizeStyleId()`

**Symptom** — editing `map-styles.json` keys without going through `normalizeStyleId()`. The style ids used to be cryptic (`main`, `main-dusk`, `main-streets`, `monochrome-day`, ...). The 2026 rename swapped them for friendly names (`standard`, `dusk`, `streets`, `monochrome-light`, ...). Legacy localStorage entries (`viewerMapStyle`, `editorMapStyle`), bookmarked deep links, and any old `share_links.settings.mapStyle` values still contain the OLD ids — feeding those straight into `map.setStyle()` breaks the entire overlay mount.

**Fix** — every read of a stored / URL-supplied style id must go through `normalizeStyleId(id)` from `src/components/mapbox-map.tsx`. It resolves unknown ids by first checking the current JSON keys, then falling back to `LEGACY_STYLE_ALIAS[id]` (the deprecated → new-key map), then to `DEFAULT_MAP_STYLE`. When adding a new style: add it to `/map-styles.json` (single source of truth) — every picker (viewer top strip, viewer controls, editor toolbar, share-link dialog) reads via `MAP_STYLE_IDS` so no picker code has to change. When renaming an existing style: add the old id → new id row to `LEGACY_STYLE_ALIAS`, don't delete it.

### A non-modal `Sheet` opened from a `DropdownMenuItem` closes itself

**Symptom** — "Run history" in the report viewer's ⋯ menu did nothing: the side panel mounted and unmounted in the same beat. The menu hands focus back to its trigger when its exit animation finishes (~150 ms later), and a `modal={false}` Radix Dialog treats focus landing outside it as a dismiss. A `setTimeout(0)` around the open does not help — it fires before the animation ends.

**Fix** — non-modal side panels pass `onFocusOutside={(e) => e.preventDefault()}` on `SheetContent`. They still close on Esc, the close button, and a pointer-down outside; only the focus hand-back stops dismissing them. (Row history in `table-records-dialog.tsx` and run history in `report-viewer.tsx` both do this.)

### Widgets draw their own card — the canvas cell must not

**Symptom** — doubled borders on every report widget, and KPI cards that didn't reach the bottom of their cell. `ReportCanvas` wrapped each cell in `border bg-card` while every widget also renders its own card (it must, for document-flow layout).

**Fix** — the canvas cell is chrome-free (a focus ring only while editing) and stretches its child with `[&>*]:h-full`; the viewer's `WidgetCell` does the same one level down. A new widget kind must render its own `rounded-xl border bg-card` root with `h-full` and a sensible `min-h-*` — a bare `div` shows up borderless. On phones the canvas switches to content-sized rows (`gridAutoRows: auto`), so rely on the card's `min-h`, not the saved row height. Chart plots sit in `dir="ltr"` boxes: SVG text anchors flip under RTL and the Y-axis labels clip.

### Report rows for built-in facility sources write shapes through `apiDb`

**Symptom to avoid** — routing a facility-report edit through `/tables/:id/rows` (there are no rows: the source reads the shape tables) or through `useSpatialStore.updateLocal` (the reports page has no loaded store, so the optimistic path has nothing to patch). Both look like they work in a quick test against a stale store.

**Rule** — `writeFacilityRow` / `deleteFacilityRow` in `src/lib/reports/facility-sources.ts` are the one place outside the editor that writes shapes with `apiDb.<kind>.update/delete` directly (golden rule 1's exception). `apiDb` still calls `notifySync` and the server broadcasts SSE, so any open map updates. Config columns (colour, icon, label, text, height, …) are **merged** into the shape's current config after a `get` — a PATCH with a partial `config` would replace it and wipe every other setting. Grids also mirror `visible` into `config.visible`. Floors (`images`) are not deletable from a report: deleting one removes its image and strands everything drawn on it.

### Document-flow widgets have no grid `position`

**Symptom** — editing a generated report (facility set, linked-data reports) crashed the builder's Layout tab with `Cannot read properties of undefined (reading 'y')`: their widgets carry `order` / `columnSpan` for document flow and no `position`, while the Layout canvas (and the viewer's grid mode) read `w.position.y` unguarded. **Fix** — `withAutoPositions()` (`src/lib/reports/auto-positions.ts`) gives position-less widgets a grid spot that mirrors the document flow (KPI strip of four, `columnSpan: 2` in pairs, rest full width); the Layout step and `report-viewer`'s grid path run widgets through it, and `document-flow.tsx` sorts with `position?.y`. Never assume `position` exists on a stored widget.

### Builder Filters step: a number is a literal, not "empty"

**Symptom** — saving a generated report from the builder added a stray **Facility ID** text prompt to its filter bar. The Filters step read a condition's value as `typeof value === 'string' ? value : ''`, so `facility_id = 75` (a number) looked empty, and its "legacy empty filter" effect auto-declared an `f_facility_id` param and replaced the 75 with `{{param.f_facility_id}}` — on a wizard-built report that silently turns a fixed number filter into "ask the viewer" (all facilities until they type). It fires just by passing through the step. **Fix** — numbers / booleans stringify as literals (`filters-step.tsx` `FilterRow`). Test builder round trips by walking **every** step with Next, not by jumping to the one you changed.

### Facility map & list tabs own their queries

**Rule** — never add an explorer tab's query to `extraQueries` by hand or expect it in the Queries step. `compileExplorer` (`src/lib/reports/explorer-spec.ts`) writes `w_<widget-id>_<n>` per tab on save and `loadDraft` drops every `w_` query; edit the tab, not the query. When an explorer edit leaves a generated report's `rows_*` query unread, `releaseExplorerQueries` removes it — anything else that reads a query (a widget `queryRef`, another tab, a param's `fromQuery`) must be listed there or the query is dropped under it.

### `map.getStyle()` throws while a basemap swap loads

**Symptom** — switching the full-map report to the Dark style blanked the whole page: `Error: Style is not done loading` from `raiseLayerListToTop` (map-data-linked-overlay) in a React effect, which unmounted the tree. `getStyle()` (and `getStyle().layers`) throw mid `setStyle`; the effect ran in that window. **Rule** — wrap `getStyle()` in effects / non-`style.load` handlers in try/catch and bail; let the `styledata` / `style.load` listener redo the work. Test every overlay host by switching basemaps with data on the map.

### Glass panels that don't blur: an ancestor's held opacity

**Symptom** — the full-map report's frosted panels were see-through but not blurred: map icons showed crisp behind the text. Their wrappers ran an entrance animation with `animation-fill-mode: both`, which keeps the final `opacity: 1` applied as an animated value; Chromium then treats the wrapper as a **backdrop root**, so the panel's `backdrop-filter` only sees the (empty) wrapper, not the map. **Rule** — entrance animations on anything containing glass fill `backwards`, never `both`/`forwards`; and keep entrance (wrapper) and show/hide slide (`[data-open]` transform on the panel) on different elements, or a finished fill pins the panel open.

### Panels floating over a Mapbox map: z-index and the attribution strip

**Symptom** — in the full-map report the Mapbox logo and scale bar drew over the floating list panel, and the right panel covered the "© Mapbox © OpenStreetMap" attribution. Mapbox's controls carry `z-index: 2` inside a map container that forms no stacking context, so they beat a later sibling overlay with `z-index: auto`. **Rule** — give the floating chrome its own `z-10` and stop it ~32 px short of the bottom edge (`pb-8` in `explorer-map-layout.tsx`) so the logo and attribution stay visible — Mapbox's terms require both. Panels never resize the map; pass their footprint as `insets` to `FacilityMap` so `framePadding` frames a pick in the visible gap.

### Overlay readiness: poll `isStyleLoaded()`, don't trust one check

**Symptom** — the building base (`map-floor-base-overlay.tsx`) never appeared in the report explorer's map in Ghost mode, though it did in the viewer and, by luck, in Solid. The overlay checked `map.isStyleLoaded()` once at mount, else waited for `style.load`. But `isStyleLoaded()` is also `false` while any source is still loading — which is exactly the moment an overlay mounts next to a dozen others — and `style.load` doesn't fire again for an already-loaded style, so it waited forever. **Fix** — poll `isStyleLoaded()` (100 ms) until true, plus `style.load` for later style swaps, the way `map-polygon-overlay.tsx` does. Any new overlay must do the same.

### Overlay teardown after the map is gone

**Symptom** — `Uncaught TypeError: Cannot read properties of undefined (reading 'getOwnLayer')` from `map.getLayer` inside a data-link sub-renderer's teardown, on navigating back from a page with a live map (report explorer, viewer). React runs `MapboxMap`'s cleanup — `map.remove()`, which drops `map.style` — before the overlays' cleanups, so their `getLayer` / `removeLayer` hit a dead map. **Fix** — `mapAlive(map)` / `safeTeardown(map, fn)` in `map-data-linked-overlay.tsx` skip teardown once `map.style` is gone or `map._removed` (the layers went with the map). Any overlay cleanup that touches layers or sources must do the same (`map-floor-base-overlay.tsx` already checks `live.style || live._removed`); `map.off(...)` is safe on a removed map.

### A scrolling list inside a card needs every ancestor bounded

**Symptom** — the facility explorer's list showed the first ~10 items and nothing past them: no scrollbar, the card just clipped. The list (`overflow-y-auto`) sat in a `flex-col` whose root had no height, inside a grid cell of a fixed-height grid — the cell was bounded, its child wasn't, so the list grew to fit all rows and `overflow-hidden` on the card cut it off. A test that counted `[role=option]` passed (every row was rendered). **Fix** — `h-full min-h-0 overflow-hidden` on every wrapper down to the scroller; test by scrolling the list to its end and asserting the last item is inside the list's box.

### Viewer filters are compiled on save — and must be stripped on load

**Symptom** — a report saved twice from the builder carried every viewer-filter condition twice (then three times…), and a re-save of a facility report changed its floor dropdown to list every facility's floors. `spec.viewerFilters` is metadata; the runtime only sees the params, option queries and conditions `applyViewerFilters` generates. **Rule** — `loadDraft` must strip what save generated (`stripViewerFilters` on every query's filters, drop `opt_vf_*` queries and `vf_*` params) and save regenerates it. An options query needs the report's *fixed* scope (e.g. `facility_id = 71`): it takes the fixed conditions of the first query on that source, or `options.filters` when nothing else reads that source (the facility set stores it). Keep generated condition order = filter-bar order, fixed conditions first, or a round trip reorders them; `TestFacilitySources` + a builder save of all eight facility reports must stay byte-identical. A date range is two whole-day conditions (`onOrAfter .start`, `onOrBefore .end`) — a single `= {{param.range}}` is invalid and a plain `<=` on a timestamp drops the end day.

### Facility explorer: one map per page, and keep camera padding inside the pane

**Symptom 1** — the explorer's map (`facility-map.tsx`) loads the facility with `setActiveZoneId` + `loadAll`, exactly like the viewer. The spatial store is a singleton holding **one** facility, so two explorers for different facilities on one page would fight over it. The facility report set never does that; a hand-built report must not either.

**Symptom 2** — with the detail card open, a selected lift/model landed at the map's top-left corner instead of in view. `fitBounds` / `easeTo` with `left + right` padding wider than the visible pane is silently ignored by Mapbox. **Fix** — clamp padding to the container (`map.getContainer().clientWidth` minus the card) before framing; keep the card's width in `rightInset`.

**Symptom 3** — tests and screen readers hit the report header's "Edit" (which opens the builder) instead of the detail panel's. The panel is a `<section aria-label={item name}>`; scope to it. On mobile the panel is a bottom `Sheet` with `hideDefaultClose` — the panel has its own close button.

### `bigValue`'s `label` binding names a column, not text

**Symptom** — KPI cards in a generated report showed a bare number with no caption. `BigValueWidget` reads `bindings.label` as a **column name** and takes that row's value; a literal like `"Floors"` matches no column and renders blank. The caption comes from `widget.title` when `label` is unset — set the title, omit `label` (the demo seeder still passes literal labels).

### Document flow: only charts get the 220 px floor

**Symptom** — a section `divider` in a document-layout report reserved ~220 px of blank space, and a two-row table left a gap under it. `document-flow.tsx` put `min-h-[220px]` on every body widget. Text widgets and tables (`COMPACT_KINDS`) now size to their content; keep the floor for charts and maps, which need it while loading.

### An empty `draft.columns` means "all fields" on Summary / History reports

**Symptom** — a saved Summary report couldn't be re-saved from the builder: Save said "Select at least one column" although the Columns step listed 8 of 8 selected. `loadDraft` recovers columns only from a table-shaped primary widget, so Summary/History drafts load with `columns: []`, and the Columns step fills them in only when it mounts. The old `canSave` required `columns.length > 0` for every type.

**Fix** — the column requirement in `wizard-validation.ts` applies to Detail/Editable only. Anything that inspects the draft (validation, dirty tracking) must treat an empty list on the other types as "all fields", not "none" — and dirty tracking compares the generated spec, which for Summary doesn't include the column list, so visiting the step doesn't mark the report unsaved.

### REST syncs run in the browser; "Test connection" runs on the server

**Symptom** — an API tested green in the editor but every Run now / scheduled sync failed. `POST /data-sources/test-rest` fetches server-side, while `rerunDataSource` → `fetchRestSource` fetches from the browser, so an API without CORS headers for the app's origin passes the test and fails the run.

**Fix** — `RestSourceEditor`'s test does both: the server probe for status/columns/sample, then a browser fetch; a server-OK + browser-fail result shows the "Your browser is blocked from this API (CORS)" warning before saving.

### A REST source with no row key imports nothing — and used to say `ok`

**Symptom** — a REST API connected from Integrations synced, showed Healthy, and stored 0 rows: its mapping had no `match.*` column, so the importer skipped every row ("row has no external_code / match key"), and `rerun.ts` stamped `lastResult: 'ok'` because nothing had *errored*.

**Fix** — the editor requires a **Row key** (saved as `mapping.fields[col] = 'match.externalCode'`, auto-suggested from the test's columns); sources saved without one show a "No row key" badge + a "Set row key" callout. `resultOf(summary)` in `rerun.ts` decides the stamp: rows read but none imported/matched → `error`, some skipped/errored → `partial`, none read → `empty`.

### One scroll per page: no height-capped table inside a scrolling page

**Symptom** — `/data` capped its table at `max-h-[…]` with `overflow-auto` inside a page that also scrolled: two scrollbars, and the pager sat below the table's own scroll area, so users scrolled the table to the end and then had to scroll the page to find the pager. Full-page screenshots (`fullPage: true` or a tall viewport) hide this entirely — the inner box never overflows.

**Fix** — tables have no height cap and no sideways scroll; they fit by truncating cells and hiding low-priority columns below a breakpoint (`hidden xl:table-cell`), and become card lists below `md`. The header sticks to the *page* (`thead sticky top-0`). The card around it must use `overflow-clip`, **not** `overflow-hidden`: `overflow-hidden` (and `overflow-x-auto`, which forces `overflow-y` to `auto`) makes the card a scroll container, and `sticky` then sticks to a box that never scrolls. Verify at real viewport sizes (1440×900, 1280×720, 1024×768, 390×844) by counting elements in `main` whose `scrollHeight > clientHeight` with `overflow-y: auto|scroll` — there should be at most one.

### Two `useUrlState` setters in one handler clobbered each other

**Symptom** — picking a source on `/data` (sets `source` and resets `page`) lost the source; "Clear filters" on `/files`, `/tables` and `/data` reset only the last param. React Router v7's functional `setSearchParams(prev => …)` hands every call in one tick the *render-time* params, so each setter overwrote the previous one.

**Fix** — `useUrlState`'s setter builds on `new URLSearchParams(window.location.search)`; `navigate` updates history synchronously, so consecutive calls compose. Don't reintroduce the functional form.

### The report builder must round-trip specs it didn't write

**Symptom** — renaming a seeded report in the builder and saving it added two widgets (an auto "primary" bar chart and a KPI) on top of its layout, and re-pointed every one of its queries at a single source — Store Overview reads four, so most of its widgets broke. `loadDraft` treated the first query as the wizard's "primary" and `toV2Spec` always emitted the wizard bundle and normalised extra queries to the draft's source.

**Fix** — `draft.generatePrimary` is true only when the spec carries the wizard's own `primary_…` widgets (or none yet). Otherwise widgets and queries save verbatim, each query with its own source, and the Widgets/Queries steps and validation drop the primary-bundle parts. Before changing the serialiser, round-trip every stored report through `loadDraft → toV2Spec` and diff widgets (id, kind, queryRef, position, bindings) and queries (name, sourceRef, filters, groupBy, metrics) — all 24 Acme reports must come back identical.

### `PUT /reports/{id}` is a full replace — send `zoneId`

**Symptom** — every report saved from the builder moved to "Shared", and duplicates/imports never kept their facility. `createReport` / `updateReport` built their bodies field by field and left `zoneId` out; the PUT handler sets the column to NULL when it's omitted.

**Fix** — both send `zoneId: req.zoneId ?? null`. When a client helper whitelists fields for a full-replace endpoint, check the request type's every field reaches the body.

### Conditional-formatting classes are stored in report specs

**Symptom** — swapping the builder's condition presets to theme tokens would have stripped the colour from every existing rule: specs (and `cmd/seed-reports`) store the raw class string (`text-emerald-600 dark:text-emerald-400 font-medium`), and Tailwind only generates classes it finds in source.

**Fix** — presets live in `src/lib/reports/condition-styles.ts` on status/chart tokens, and the viewer applies `themeClass(rule.className)`, which maps any raw palette class (`text|bg|border|ring-<hue>-<shade>`, `dark:` twins dropped) onto the matching token. Never key behaviour on the literal saved string — compare through `conditionStyleFor`.

---

## Wire responses

### Read every array at a wire boundary as optional

**Symptom** — reading an array on a wire response as non-optional (`res.entities.walls.length`, or `?.` on the container but not on the array). `?.` on the container without `?.` on the array is the natural thing to type and is wrong in exactly one situation, which happens on every deploy: a **new client against an API binary that predates the field**. The array is `undefined`, and `undefined.length` throws a raw `TypeError` that names no field and no endpoint. In the CAD import it surfaced as a red banner reading "Cannot read properties of undefined (reading 'length')" over a drawing that was completely fine — it reads to the user as a bad file, and the real cause is a stale server.

**Fix** — read every list at a wire boundary as `x?.y?.length ?? 0`, even when the source you are looking at always emits it. It is the *running* server that decides what a response contains. Go's `omitempty` makes this the norm rather than the exception: `cadInspectResponse` alone drops `unitGuesses`, `missingBlocks` and `missingXrefs` from the JSON whenever they are empty, so those three are `undefined` on a perfectly current deploy.

### Don't derive a status from a field the list endpoint doesn't return

**Symptom** — `/tables` flagged every table "No write token · Needs setup" (14 of 14 in Acme) although five had active keys and nine held 25–650 records. The page computed setup status from `table.tokens`, which only `GET /tables/{id}` returns — `GET /tables` omits it, so the count was always 0. The rule was also wrong: the app's grid and the REST pull write without a key, so "no key" never meant "can't receive data".

**Fix** — `GET /tables` now carries `stats` (rows, last write, active keys, polling) and status comes from what the table holds (`src/lib/table-status.ts`). When a list card needs a fact, check the list response actually contains it — `?? []` on an absent array turns "unknown" into "zero" silently. Guarded by `TestTablesStatsAndRowSearch`.

