# Credits & third-party assets

Spatial Map's source code is MIT licensed (see [LICENSE](LICENSE)). Some bundled
assets are **not** covered by that license and keep their own terms.

## 3D models (`public/models/`)

All bundled models are from [Sketchfab](https://sketchfab.com) under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — commercial use is
allowed **if the author is credited**. Each model folder keeps its original
`license.txt`; keep it when you redistribute.

| Model | Author | Source |
|---|---|---|
| Basket Shelving for Store or Warehouse | [jimbogies](https://sketchfab.com/jimbogies) | [sketchfab](https://sketchfab.com/3d-models/basket-shelving-for-store-or-warehouse-48b5af11696c45f3970b2a036162bda9) |
| Forklift with Rig | [Daniel Orozco](https://sketchfab.com/danorzc) | [sketchfab](https://sketchfab.com/3d-models/forklift-with-rig-bb8b8dab8b4c4fc1ac6af310b70f1b6e) |
| Industrial Forklift (Pneumatic Tire) | [doty_aecom](https://sketchfab.com/doty_aecom) | [sketchfab](https://sketchfab.com/3d-models/industrial-forklift-pnuematic-tire-930b8091326e4bec9b2607d05548de4a) |
| Rusty Metal Warehouse Shelving | [jimbogies](https://sketchfab.com/jimbogies) | [sketchfab](https://sketchfab.com/3d-models/rusty-metal-warehouse-shelving-ccc250d7e54e4e4399ca3a8c2b477020) |
| Simple Factory Scene | [Pickeri](https://sketchfab.com/uglythree) | [sketchfab](https://sketchfab.com/3d-models/simple-factory-scene-804fbe0cd1fa44fa9ca86ae42c82d63d) |

When adding a model, only use assets whose license allows redistribution **and**
commercial use (CC0, CC BY, MIT, …). Non-commercial (CC BY-NC) or SDK-only
assets can't ship in this repository.

## Demo workspace (`backend/internal/demo/pack/`)

The sample facilities, tables and reports are fictional and made for this
project; you may reuse them under the project's MIT license. The floor-plan
images are AI-generated drawings, and the two Retail Mall plans are plain
sheets (the originals showed real store logos). Store, brand and equipment
names in the sample data describe what a facility might stock or use; they
imply no endorsement. Some asset rows link to photos on
[Wikimedia Commons](https://commons.wikimedia.org) by URL; they are not bundled,
and each keeps the license shown on its Commons page.

## Maps

Basemaps are served by [Mapbox](https://www.mapbox.com) and need your own
access token; their use is governed by the
[Mapbox Terms of Service](https://www.mapbox.com/legal/tos). The Mapbox logo and
attribution must stay visible on every map.

## AI floor-plan detection (optional `backend/ai-worker`)

Uses [SAM 2](https://github.com/facebookresearch/sam2) (Apache-2.0),
[OpenCV](https://opencv.org) (Apache-2.0) and
[Tesseract](https://github.com/tesseract-ocr/tesseract) (Apache-2.0). Model
weights are downloaded at build/run time and are not part of this repository.

## Libraries

npm and Go dependencies are listed in `package.json` / `backend/go.mod`; their
licenses apply to their code. Copyleft (GPL/AGPL) dependencies are not
accepted — see [CONTRIBUTING.md](CONTRIBUTING.md).
