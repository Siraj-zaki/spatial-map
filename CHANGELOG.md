# Changelog

All notable changes to Spatial Map are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-14

### Added

- **Focus mode** — click an item and only what blocks the view of it (and
  what sits right around it) fades; big shapes in the way are cut away
  locally. Works in the viewer, share links, report maps and the editor;
  `?focus=` links open straight onto an item, and a chip follows a moving one.
- **Measure and drafting** — a Measure tool (`U`) for distances and areas
  that leaves guides, live dimension labels while drawing walls and areas,
  typed lengths for every vertex tool (`3.5`, `350cm`, `12'6` then Enter),
  an angle lock, and floor-plan **calibration** from a known length.
- **Wall joins** — walls and aisles meet cleanly at corners and T-joints,
  door openings cut every wall they cross.
- **Leaning and sloped walls** — walls can lean (curved or straight
  profile, either side).
- **Path-layout grids** — racks and seat rows bent along a drawn line
  (U, L, S, arcs).
- **Routing v2** — routes follow the building's axes, pass through door
  centres, and run across floors.
- **Heatmap** on viewer and report maps — one or several layers at once,
  heat spreads along open floor and through open doors, never through walls,
  racks or closed doors, and hides behind walls when the map is tilted.
- **Point clustering** on viewer and report maps.
- **Viewer Live data panel** — counts and a searchable list of what the
  map's data layers show, plus a Live / Cluster / Heatmap control.
- **Master report** — one live report per facility, generated from a setup
  dialog (map layers, counts, status charts, filters).
- **Report share links** — a public link to a single report at `/r/:token`
  (its widgets, live map and history; no account). Migration
  `0049_report_share_links`.
- **Facility share links read their data** — signed-out visitors of a
  `/share/:token` link see the facility's data layers (rows, history).
- **History playback time range**, and a camera live view in the item
  drawer (HLS, MP4/WebM, MJPEG).
- **Place search** — Mapbox and OpenStreetMap results, typed coordinates,
  Google Maps / OSM links.
- **Blank floor sheet** in the floor-plan tool, **bulk select and edit** in
  every saved-shapes list (plus a Saved routes list), per-floor "hide
  shapes" reference views, and **export** to GeoJSON, JSON, XLSX, CSV and
  3D `.glb`.
- `GET /api/v1/zones/{id}/view` — a whole facility (shapes, floors, bins) in
  one call.

### Security

- **Viewers are read-only on the API, not just in the UI.** Every change a
  signed-in member makes now needs the permission its area requires for their
  role (`api.WritePermissionMiddleware`, `internal/api/permissions.go`);
  before, a viewer could write through the API directly. Owners, admins and
  editors keep exactly the access they had.

### Changed

- Faster maps on large facilities: per-frame tile bookkeeping cuts,
  diff-only GeoJSON updates, an exact occlusion index, stable row identity
  across refetches.

## [0.1.1] - 2026-11-14

### Security

- **Workspace routes now require a signed-in user or the configured API
  key.** With `SPATIAL_MAP_API_KEY` unset (the `docker compose` default), a
  request with no session was let through and served whatever workspace its
  `X-Tenant-Id` header named — reads, changes and deletes — and
  `GET /api/v1/tenants` listed every workspace. Such requests now get
  `401 sign in required`. Scripts and integrations keep working with the real
  API key; webhooks, streams, the public table API and share links are
  unchanged (they use their own tokens). **Upgrade every install that is
  reachable from a network.**
- `.env.example`: `VITE_API_KEY` must never hold the real API key in a served
  build — it is bundled into the public JavaScript.

### Fixed

- Opening a facility no longer loads every bin in the workspace:
  `GET /api/v1/bins?zoneId=N` returns that facility's bins only (grid cells
  of its racks and seating, plus bins bound to its shapes). The map already
  sent `zoneId`; the API ignored it.

## [0.1.0] - 2026-10-11

First open-source release of Spatial Map, the self-hosted edition of
[spatialmap.io](https://spatialmap.io).

### Added

- **Facility editor** — multi-floor layouts on a live Mapbox map: floor plans
  from PDF, DWG or images, areas, walls, doors, stairs, lifts and escalators,
  racks with bins, markers, text labels and 3D models, with snapping,
  multi-select bulk editing, undo/redo and keyboard shortcuts.
- **Data links** — bind rows from tables, REST APIs, webhooks, files or live
  streams to shapes by name, external code, coordinates or a fixed shape, with
  style rules that colour, size and label them live.
- **Viewer and share links** — read-only, live-updating facility views; public
  links with chosen floors, layers, filters and chrome.
- **Reports** — report builder (tables, KPIs, charts, viewer filters, editable
  tables), ready-made reports for every facility and every linked table, and a
  full-map layout with floating list, details, key numbers and charts.
- **Tables** — built-in tables with CSV/XLSX import, a per-table REST API with
  bearer tokens, polling sources, row history and playback.
- **Solutions** — group facilities, reports and data (e.g. "Anti-theft") inside
  a workspace.
- **Workspaces and members** — roles (owner / admin / editor / viewer) and
  email-OTP sign-up.
- **Demo workspace** — five sample facilities (hospital, retail mall,
  warehouse, supermarket, retail store) with live tables, data links and 84
  reports, loaded on the first start of an empty database and joined by every
  new account (`SPATIAL_MAP_DEMO=false` to start empty).
- **One-command self-hosting** — `docker compose up -d` runs the web app,
  API, PostgreSQL/PostGIS, MinIO and Redis; prebuilt multi-arch images on
  GHCR (`spatial-map-web`, `spatial-map-api`); the Mapbox token is set at
  container start.
- **AI floor-plan tool** (optional `--profile ai`) — detects rooms and walls
  on an uploaded plan (SAM 2 + OpenCV + Tesseract).
- Six languages (English, German, Spanish, French, Arabic with RTL, Chinese),
  light/dark themes and 46 colour palettes.

[Unreleased]: https://github.com/Siraj-zaki/spatial-map/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Siraj-zaki/spatial-map/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Siraj-zaki/spatial-map/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Siraj-zaki/spatial-map/releases/tag/v0.1.0
