# CAD & PDF drawing import

Read this before touching `internal/pdfconv`, `internal/cad/`, or the import UI (`src/lib/cad-import.ts`, `cad-import-dialog.tsx`, `pdf-page-picker.tsx`).

## Design doctrine

### OSS libraries are a base layer only

The design rule: the library supplies the render primitive; we own the domain layer on top of it. Follow this split when adding a new drawing format so the pipeline stays format-agnostic.

### Both import paths end in the same place: a PNG on an `images` row

A PDF page is rendered by PDFium (`internal/pdfconv`); a DWG is read into a `cad.Document` and rendered by our own rasterizer (`internal/cad/raster.go`), because there is no PDFium for DWG. What differs is only how the pixels are produced and what the file could tell us about its own scale — a drawing is authored in real-world coordinates, so its ground size is *known* rather than inferred from a sheet size. DWG's container layer lives at `internal/cad/dwg/` and is written from the ODA specification with no third-party dependency; see `docs/dwg-format.md` for the reader's status and internals.

### Reading the drawing properly still earns its keep, even though the output is a picture

The layer filter is a choice about *entities*, not about pixels — a title block left unticked is removed before anything is drawn, so the rendered sheet and its stated ground size both shrink to the building. And the units come from the drawing's own header, so the plan lands at its real dimensions instead of being scaled by hand. Neither is available to something that rasterizes blind.

### What the library gives us vs. what we own

**What the library gives us** (`klippa-app/go-pdfium` over PDFium): bytes in, pixels out. Nothing else.

**What we own:**

- **Resolution policy** — `Limits` + `clampDPI` in `pdfconv.go`. See the GPU-texture-cap pitfall below; this is not optional polish, it's the difference between working and silently blank.
- **Drawing-sheet recognition** — `standardSheets` in `scale.go`: 17 ISO A / ANSI / ARCH sizes, matched in either orientation with a 2 mm tolerance (CAD-plot → PDF round trips miss nominal sizes by a fraction of a mm; 2 mm catches those without letting adjacent sizes collide, since the closest pair differs by ~13 mm).
- **Plot-scale arithmetic** — `RealWorldSize` / `ScaleForRealWorldWidth`. A PDF point is 1/72 inch by spec, so page dimensions are dimensionally honest: `metres = sheet_mm / 1000 × denominator`. This is exact, not a heuristic.
- **The placement UX** — `pdf-page-picker.tsx` + the snap in `useImagePlacementTool`.

### Licensing is a hard constraint

MuPDF, PyMuPDF and Ghostscript are **AGPL — disqualified.** PDFium is BSD-3 and the Go wrapper is MIT. Check the licence *before* prototyping with a library; a working spike on an AGPL dependency is wasted work.

The same test decided DWG: LibreDWG is GPL-3 and every other complete implementation is proprietary (the ODA's own SDK is a paid licence), so there is no dependency to wrap. The reader is therefore ours end to end, written from the ODA's freely published *Open Design Specification for .dwg files* — a published format description, not reverse engineering, and the format itself is unpatented.

### Sandboxing

`pdfconv` runs PDFium on **wazero (pure-Go WASM)**, not CGO: builds stay cross-compilable and the parser gets no filesystem and no network (`webassembly.Init` is called with no `FSConfig`). A drawing file is a program, not a picture, and it's arriving from users. Keep any future format parser inside the same sandbox.

### Lifecycle

`New()` compiles a ~5 MB WASM module — call it **once at startup**, never per request. Boot failure must stay non-fatal: `main.go` logs it and the routes answer **503**, because one broken feature is not a reason to refuse every request. 404 would be indistinguishable from a client typo.

### What a drawing file can and cannot tell you

Scale is recoverable. **CRS, origin and north are not** — they aren't in the file. Position and rotation stay a manual drag on the map; don't build an "auto-georeference" path.

### The CAD path's HTTP surface

`POST /api/v1/cad/inspect` and `POST /api/v1/cad/render` (`internal/handlers/cad.go`, mounted by `CADRouter(store)`). Both are multipart, both pick the format by **content rather than filename**, and neither persists the *upload* — the browser re-sends the bytes on the second call, for the reason in the "don't store intermediates" pitfall (`docs/pitfalls-backend.md`). Only the rendered PNG is stored, on an `images` row, which puts it on the existing refcount/cleanup path with no new code (`docs/backend.md`).

Rules when extending them:

- **`/render` returns the same first five fields as `POST /images/upload`** (`url`, `mimeType`, `naturalWidth`, `naturalHeight`, `bytes`). That is what lets a CAD plan reuse the placement draft a PDF page or a photo already goes through — no new shape kind, no migration, no second placement path. Anything CAD-specific rides *after* those five.
- **The layer filter runs at flatten time, not after the paths are built.** Filtering later would draw the right picture at the wrong ground size, because the reported `widthMeters` comes from the geometry that survived.
- **Trim debris before choosing the scale** (`cad.TrimOutliers`, then `cad.ResolveUnits`). A single stray entity a kilometre from the building both poisons the unit guess — which judges a declared unit by the extent it implies — and eats the pixel budget, since the raster spends a fixed 4096 px across whatever box it is handed. See the pitfall below.
- **Tessellation belongs in `internal/cad/paths.go`**, not in a reader and not in the handler: the sagitta is stated in metres, so `MetersPerUnit` has to reach the segment count or the same building tessellates differently in mm and in m.
- **Anchor the reported footprint on the pixels, not on the entities** (`cad.PathBounds` plus the raster's margin). Chords sag inside the curves they replace and text contributes extents while emitting no points, so the two boxes differ by up to a sagitta — and the client places by the corner while stretching to the stated size, so a footprint that describes anything other than what the image covers lands every import fractionally wrong.

### On the SPA side, a CAD floor plan is an ordinary `images` row

A PNG like any other, indistinguishable downstream from a photo or a rendered PDF page. That single decision is what makes the feature cost no migration and no frontend plumbing: `uploadImage` is content-agnostic, `images.image_url` is already in `CountFileURLReferences` / `ListReferencedFileURLs` / `shapeDeleteWithFile`, and the floor-plan *role* — the default-floor-plan pin, the `hiddenFloorPlanIds` cascade, the elevation sync into every draw tool, bulk assign, crop, the side panel's Floor plans list — is bound to `savedImages` and now applies to a DWG unchanged.

**Don't make CAD a new shape kind, and don't give it a second overlay**: both buy nothing and the first costs the ~15-list shape-kind registration. The whole client surface is `src/lib/cad-import.ts` (two calls plus the layer/unit helpers) and `cad-import-dialog.tsx`; after `renderCad` returns, the flow is identical to the PDF one. Then update `ARCHITECTURE.md` §5.13.

### Adding a raster format

Something that renders to a page image: new `internal/<fmt>conv` package exposing the same `Inspect` / `RenderPage` shape → reuse `scale.go`'s sheet + scale tables → new route pair on the existing `/api/v1/pdf`-style router → the SPA's picker and the placement snap need no changes if the inspect/render response shapes match. Then update `ARCHITECTURE.md` §5.12 + §6.11.

### Adding a vector format

DXF, and any future CAD container: new `internal/cad/<fmt>/` package whose only job is to populate `cad.Document`, plus a branch in `readDrawing`'s content switch — the endpoints, layer filter, unit override and wire format are format-agnostic and should need nothing else. Nothing in the reader may be format-specific past its own package boundary — `internal/cad` owns the entity model, geometry, transforms, flattening and bounds, and a new reader adds to those rather than beside them. Concretely:

- **Reference by name, never by handle** — `Entity.Layer` is a string, so a DXF reader and a DWG reader produce interchangeable documents.
- **Keep the drawing's own units** and record them on the document rather than converting at parse time.
- **Treat every read as attacker-controlled** — bounds-checked cursor/bit-reader, capped lengths, errors latched instead of panicking.
- **Resolve text through `cad.PlainText` / `cad.PlainMText`** rather than reimplementing the escapes: `\U+XXXX`, the `%%` symbol sequences and the MTEXT formatting language belong to the format *family*, not to DWG — DXF stores identical ones — which is why they live in `internal/cad/text.go` and not in a reader.

Then update `ARCHITECTURE.md` §6.12.

### The deliverable is a picture, and that is deliberate

An earlier design recovered walls, rooms, columns, doors, stairs and racks from the linework and created them as real `lines` / `polygons` / `circles` / `doors` / `stairs` / `grids` rows. It worked, and it was removed deliberately in 2026-08: **a DWG becomes a rendered floor-plan image, and an AI tool reads the placed image and draws the entities.** Recognising a wall from geometry plus a layer name is a heuristic with a long tail — the token list has to be multi-language, the AIA naming standard is followed loosely by about half of real drawings and ignored by the rest, and the room derivation failed exactly where a wall layer went unrecognised. Handing that judgement to a model that can see the drawing is a better trade than growing the token table one customer file at a time.

So: `internal/cad/` reads and draws. It does not classify. `roles.go`, `extract.go`, `extract_shapes.go`, `segments.go` and `rooms.go` are gone, along with `cad-entities.ts`, `cad-generators.ts` and `map-cad-overlay.tsx` on the client. What survives of the layer-name work is `internal/cad/annotation.go`, reduced to one exported function:

- **`IsAnnotationLayer` is a proposal about the *sheet*, not a classification of the building.** It answers one question — does this layer describe the drawing (dimension runs, hatching, the title block, the structural grid bubbles) rather than the building? — and all it decides is which boxes the import dialog opens unticked. The wire field is a `bool`, not a string with six values; keep it that way. A guess with two outcomes and a visible tick box is a guess the user can correct at a glance, which is what makes it safe to be wrong.
- **Don't re-add entity extraction without discussing it with the maintainers first.** If the AI path doesn't work out, the deleted code is recoverable from git history and this section is the record of why it went. Reintroducing it as a "small helper" alongside the AI reader gives two sources of truth for the same question.

Then update `ARCHITECTURE.md` §6.12 and §5.13.

## Pitfalls

### Size a rendered raster against the GPU texture cap, not a memory budget

**Symptom** — sizing a rendered raster (PDF page, tiled export, generated texture) by memory budget instead of the **GPU texture cap**. Any PNG that becomes a Mapbox `image` source is uploaded as ONE WebGL texture. `MAX_TEXTURE_SIZE` is **4096 on a meaningful share of supported devices, and overflow does not warn** — the raster silently fails to draw or downsamples to mush, which reads as "the floor plan randomly doesn't appear on some laptops." A 300-DPI ARCH D sheet is 10800 px on its long edge, so the naive "render at the DPI the user asked for" path is broken on arrival.

**Fix** — clamp the longest edge to 4096 px AND clamp total pixels (a 1:50 aspect page can pass the edge cap and still be enormous). Solve it analytically rather than looping: `dpi = maxPx × 72 / longestPoints` for the edge, `dpi = √(maxPx × 72² / (w·h))` for the area, take the minimum. **Downscale, don't fail** — a legible whole sheet beats a sharp fragment. Then report what was actually rendered (`effectiveDpi`) back to the UI: a user who requested 300 DPI and received 113 must not be left believing they got 300. See `clampDPI` / `SuggestDPI` in `backend/internal/pdfconv/pdfconv.go`.

### Resize a bbox's height before its width — latitude first, longitude second

**Symptom** — resizing a geographic bbox to an exact metre width **before** its height (or assuming the two are independent). `imageBboxSizeMeters` measures width along the bbox's south latitude, and metres-per-degree-of-longitude scales with `cos(latitude)`. So a height resize MOVES the latitudes and silently invalidates a width that was already set — measured **2.59% off** on a 91.44 m PDF sheet placement, while height read as exact, which makes it look like a width-specific bug rather than an ordering one.

**Fix** — call `resizeImageBboxHeightMeters` FIRST, then `resizeImageBboxWidthMeters` on its result. The width pass only touches longitudes, so it can't disturb a height that's already correct; the reverse order can't work. Verified end-to-end at 0.0004% / 0.0000% error. Same rule applies to any future "snap this shape to an exact ground size" path — latitude first, longitude second.

### Don't trust `$INSUNITS` because the file states it

**Symptom** — it is template metadata, and a template outlives the decision it recorded. `Apartment-1.dwg` declares **millimetres** and measures 37.7 units across — a 3.7 cm flat. Obeyed, the import places a building at a thousandth of its size with no error, no warning and nothing to search for: just a floor plan nobody can find on the map. A declaration is not more authoritative than the geometry it describes, only easier to read.

**Fix** — `cad.ResolveUnits` prefers the declaration without obeying it: when the declared unit implies an extent no building has **and** some candidate implies one that does, the extents win and the answer comes back as a guess (`known` = `cad.Confident`, so an ambiguous override still asks). Deliberately one-sided — an implausible declaration with *no* plausible alternative is left alone, since that is a drawing of a bracket and a unit we cannot justify is no improvement on one the file at least asserted. When the override fires, `UnitsDeclared` must go **false**: it means "`Units` came from the file", not "the file said something", and the inspect response keys the guess list off it.

### Keep `readUnits` non-fatal

**Symptom** — "fixing" `readUnits` in `internal/cad/dwg/document.go` to fail the import when the header won't decode, on the grounds that the rest of the reader is strict. The strictness rule is about **geometry** — an import that silently drops entities is worse than one that refuses, because the user can act on a refusal and not on an absence. Units are not geometry, and the fallback is a question the user is *already* asked: `$INSUNITS` is 0 in a large minority of DWGs, so `cad.GuessUnits` and the import UI are on that path anyway. Making the header fatal turns a perfectly decodable drawing into a hard failure over a hint, and R2004's branch of the walk has no fixture, so it is the releases we've verified least that would break hardest.

**Fix** — leave it non-fatal. What makes that safe is that the failure is **one-sided**: `readHeaderVars` asserts all three streams landed exactly before returning anything, and a wrong walk cannot land — so the degraded outcome is "no answer", never "wrong answer". A wrong answer is the expensive one here; it imports the building at a thousandth of its size and looks entirely reasonable doing it. Don't weaken the landing assertions to make more headers "succeed" — that trade runs the wrong way.

### Map parser failures to HTTP statuses by origin, not by sentinel

**Symptom** — mapping a parser's failures onto HTTP statuses by **sentinel**, with everything else defaulting to 500. The sentinels cover the failures you thought of. A hand-written binary reader's lower *layers* report the same kind of fact in prose — `internal/cad/dwg`'s container returns `dwg: no section "AcDb:Handles"` and `dwg: page 3 runs past end of file` as plain `fmt.Errorf`, because they are container facts and not one of the five `Err*` values the entity decoder exports. So `writeCADError`'s `default:` turned a drawing the user could re-save into **500 `{"error":"internal server error"}`**, which blames the server, sends the user to support, and withholds the one sentence saying what is wrong with their file. It is invisible in testing too: every fixture opens, so only a drawing you don't have can trigger it.

**Fix** — default on the **origin** of the error, not its type. Everything coming back from the reader is a statement about the file, so map the whole default branch to 422 with `err.Error()` included, and `slog.Warn` it so an unmapped case stays visible without being paged on. Reserve `api.InternalError` for failures in *our* infrastructure — object store, DB, encoding. Test it with bytes that pass the magic check and fail immediately after (`append([]byte("AC1032"), zeros...)`): that reaches the container and produces an error nothing was written against, which is precisely the case a sentinel table cannot cover.

### Trim outlier debris before measuring extent or choosing scale

**Symptom** — measuring a drawing's extent, or choosing its scale, before discarding the debris it carries. Real drawings accumulate geometry nobody meant to keep — an off-sheet furniture legend, a construction line left running to the origin, one entity parked a kilometre away. It ruins **two** things at once and neither says so. The extent it forces is what `ResolveUnits` judges the declared `$INSUNITS` against, so a drawing that is honestly in millimetres can look like it must be in metres and get silently rescaled by a thousand. And the raster spends a **fixed** 4096 px across whatever box it is handed, so the building itself ends up occupying a few dozen of them — the user gets a correct picture of mostly-nothing with their floor plan as a smudge in one corner. The reported bug was "on import it's moving some elements so far away and making the width so much", which names the symptom and not the cause.

**Fix** — call `cad.TrimOutliers(entities)` and hand its output to **both** `ResolveUnits` and `Paths` — the order is trim → resolve → path → rasterize, and it has to be the trimmed *entities*, not just a trimmed box, because a box the debris sits outside of does not stop the debris being drawn (that is why `PlanBounds` exists separately and is the weaker tool). Weight entities **one apiece at their own centre**: ink length lets one tessellated door swing outvote a room, and judging by bounding box lets a single line from the origin to the building bridge the gap it is the only thing inside. Trim X first, then Y over what X kept, so debris dismissed on one axis stops voting on the other. Report the count as `detachedEntities` — a silent trim is indistinguishable from a reader that lost geometry.

### Don't assert a raster is byte-identical

**Symptom** — asserting that a raster is byte-identical after a change that should not affect the picture. The natural test for "the unit override must not change the image" is to compare the two PNGs, and it fails on a correct implementation. A thousandfold coordinate rescale perturbs the last bit of every float, the antialiasing follows, and the content-addressed key differs — while the picture is, to any observer, the same picture. Byte-identity is not a property the code has or should have, so an assertion on it can only be deleted, never satisfied.

**Fix** — assert the relation instead: pixel dimensions **unchanged**, `widthMeters` scaled by exactly the factor, and `pixelsPerMeter` scaled by its inverse. The third is not redundant with the first two — it is what stops a client that places by size and a client that places by density from disagreeing. See `TestRenderCADEndpointAppliesChosenUnits`.
