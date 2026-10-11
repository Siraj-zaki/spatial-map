# Spatial Map — Architecture

> Living reference for the entire codebase. Keep it in sync with code changes (see the maintenance section at the end).
> Last full scan: 2026-06-29 · Last incremental update: 2026-09-30 (auth screens redesign + password reset + session revocation)


---

## 1. What this project is

**Spatial Map** is a self-hosted, multi-tenant indoor / facility layout planner and real-time visualization platform. (Internal identifiers keep the historical `sgv` prefix — env vars `SGV_*`, CSS classes `sgv-*`.) It lets users:

- **Draw** spatial layouts (grids/racks, polygons, circles, lines, markers, images, 3D GLB models, 3D image planes, stairs, doors, text labels) on top of a Mapbox map.
- **Bind** the drawn shapes to inventory bins, sensors, assets, RFID tags, shipments, and CV detections.
- **View** live data overlays — asset positions, sensor heatmaps, alerts, camera feeds, correlation events.
- **Import** data from CSV/XLSX/JSON/GeoJSON or stream it in via REST, webhooks, or WebSockets.
- **Share** read-only warehouse views via tokens.

The stack: **React 19 + TypeScript + Vite + Mapbox GL 3** on the front, **Go (Chi + sqlc + PostgreSQL/PostGIS)** on the back, with an optional **Cloudflare Worker** for local pub/sub testing.

---

## 2. Top-level layout

```
spatial-map/
├── docker-compose.yml    Self-hosted stack: web + API + Postgres/PostGIS + MinIO + Redis (+ ai profile)
├── Dockerfile            Web image: Vite build → nginx (serves the SPA, proxies /api + /files)
├── docker/web/           nginx template + entrypoint that writes /config.js from SPATIAL_MAP_* env
├── .github/workflows/    ci.yml (typecheck, lint, build, Go tests, image builds); release.yml (tag → GHCR images + GitHub release)
├── src/                  React SPA (frontend)
│   ├── App.tsx, main.tsx, i18n.ts
│   ├── components/       UI components (Mapbox map, editor panels, dialogs)
│   ├── routes/           Route screens (dashboard, viewer, integrations); the layout
│   │                     editor is a folder, `create-grids/` — see §3.1
│   ├── hooks/            Custom React hooks
│   ├── config/           Frontend config (runtime.ts: settings from /config.js, falling back to VITE_*)
│   └── lib/              Core business logic (see §5)
├── backend/              Go API service (see §6)
│   ├── cmd/{api,migrate}/   Entry points
│   ├── internal/         Handlers, db, store, middleware, etc.
│   ├── migrations/       Numbered SQL migrations
│   ├── queries/          sqlc query templates
│   └── docker-compose.yml
├── worker/               Cloudflare Worker (local pub/sub + webhook replay)
├── e2e/                  Playwright tests
├── scripts/              Model build pipeline + simulators
├── public/
│   ├── locales/          i18n JSON (en, es, fr, de, ar, zh)
│   ├── models/           Built GLBs (CC BY 4.0 — see CREDITS.md)
│   └── icons.svg
├── docs/                 Topic guides + docs/media (README screenshots, hero animation)
└── ARCHITECTURE.md       (this file)
```

---

## 3. Frontend — UI layer (src/components, src/routes)

The app has four main screens:

| Route | Purpose |
|---|---|
| `/login` | Email + password login (public; `GuestOnly` sends a signed-in visitor on to `state.from` or `/dashboard`). Split-screen auth shell (§3 "Auth screens"). Reads `?email=` to prefill (set by signup's "Sign in instead", the reset flow's hand-off and the links in auth emails) and then focuses the password. Show/hide + caps-lock password field, "Forgot password?" → `/forgot-password?email=…`. Errors are code-mapped and translated (`auth-errors.ts`); a 429 locks the button with a live `Retry-After` countdown. Shows a one-shot notice when `api-client` ended the session because the password changed (`sessionStorage['sgv-auth-notice']`). |
| `/signup` | 3-step signup (public, `GuestOnly`): email → OTP → password, with a segmented progress bar and direction-aware step transitions. `step` + `email` mirror into the URL (`?step=otp&email=…`) so a refresh at step 2 preserves progress; the verification token is React-only (a refresh at step 3 downgrades to step 2 so the user re-verifies). The code step is the shared `AuthOtpStep` (one-input 6-slot code field with auto-submit, resend cooldown, spam hint, "Open Gmail/Outlook/…"). Step 3 has a single password field (show/hide instead of a confirm field) + live checklist, and a hidden `username` input so password managers save the pair. A 401 `verification_expired` on step 3 restarts at step 1 with an info banner; a 409 `email_taken` renders "Sign in instead →". Creates a workspace tenant with a 7-day / 5-warehouse trial. |
| `/forgot-password` | Password reset (public; deliberately NOT `GuestOnly` — with no change-password screen it's also how a signed-in user changes theirs): email → OTP → new password + confirm → done. Mirrors the signup URL scheme. Worded "if an account exists…" throughout because the request step never reveals existence. The done screen hands off to `/login?email=…` — no auto sign-in (OWASP). A 401 `verification_expired` restarts at step 1. |
| `/dashboard` | **Workspace at a glance** (2026-09 redesign). Header (workspace name + Invite members / Open facilities) → 4 `StatCard` KPIs (facilities w/ 30-day delta + plan quota, bin occupancy w/ capacity bar, tracked assets, integrations) → **Your facilities**: the 6 most recently updated as `FacilityCard`s with floor-plan thumbnails (`/warehouse-summaries?sort=updatedAt&dir=desc&pageSize=6`, which now returns `thumbnailUrl`) → 30-day activity (recharts stacked bars, theme-token colours, locale-formatted dates) beside the owner-only Plan card + Workspace usage (members, live streams, files, storage) → Quick actions. Data: `/dashboard-overview` + `/warehouse-summaries`. The platform-admin block moved to `/admin`. |
| `/admin` | Platform-admin overview (signups, workspaces, all users — `AdminOverviewChapter`). Only `isPlatformAdmin` users; others redirect to `/dashboard`. Sidebar shows it under "Platform". |
| `/warehouses` | Warehouse list as a table. KPI strip is **filter-aware** (responds to active search / empty-only): in view, bins in filter, avg occupancy, assets in filter. Server-side filter/sort/pagination via `GET /api/v1/warehouse-summaries`. A **Share links** column lists each facility's links by label with a status tone — click an active chip to copy its URL, the pencil to open `ShareLinkDialog` on that link, `+N` to open the Manage tab. Per-row actions (open editor, preview, share, settings, duplicate, delete) + bulk-select with bulk delete. **Protected.** **2026-09 redesign:** compact header, shared `StatCard` KPIs (hint "Showing X of Y" while filtered), one toolbar (search, "Only empty" toggle, sort menu, **grid / table toggle** persisted in `localStorage['sgv-facilities-view']`). Grid = `FacilityCard`s with floor-plan thumbnails; table = `ui/table` with sentence-case headers, Address column hidden when no facility has one. Row/card actions live in one always-visible "⋯" menu (Edit layout, Preview, Share, Duplicate, Settings, Delete). |
| `/create-grids` | Layout editor — full CRUD for shapes with keyboard shortcuts, style rules, live data. Top-left pill row: facility · Data links · save status (`panels/SaveStatus.tsx`: Saving… / Saved / Offline · Retry; refused changes toast once) — `useUnsavedEditsGuard` saves on tab hide / unmount and asks before closing with unsaved edits. The first camera fit waits until this facility's floor plans + shapes have loaded (`loadedFor`). The editor root measures its width (ResizeObserver) and sets `--panel-inset` so the pill row, place search and data-link loading pill never sit under the side panel or each other; the root is `overflow-clip` so focus/scrollIntoView can't scroll the map sideways. Below `md` the side panel starts closed (it is a drawer over the map) and is `inert` while closed. **Upload library**: Add floor plan (side panel **From library / Upload new**, plus **Replace image** on a selected floor plan), Add image plane (`ImageLibraryDialog`) and Add 3D model (model library) all reuse what this workspace already uploaded — **This facility** first, **Whole workspace** one click away, never other workspaces; on a phone the floor-plan tool opens the panel and closes it once an image is picked. A fresh floor-plan upload can be dragged at once — placement awaits the upload so no row stores the image inline. Delete facility keeps its shapes (one `/bulk-assign` clearing `zoneId`, then the delete — the shape FKs CASCADE). **Protected** **`?select=<kind>:<id>`** (2026-10, e.g. `markers:57`, the API kinds) selects that shape once this facility has loaded and eases the camera to it (zoom ≥ 19) — the facility reports' "Open in editor" link (`facilityEditorHref`). A shape on a hidden floor can't be selected. |
| `/view/:warehouseId` or `/share/:token` | Read-only warehouse viewer with live overlays. Top-right control stack: floor switcher, style switcher, `ViewerLayersPanel` (visibility), `ViewerFilterBar` (**saved report filters** — chips over the presets published in the data-link editor; gated by `chrome.showDataLinkFilter`, and renders nothing when no visible layer has presets). **Public** (share token gates access) |
| `/integrations` | Every way data gets in, and whether it's working (redesigned 2026-09). Views via `?view=`: **Sources** (default) — REST + file-import cards (status from the last run, schedule, last run, Run now, ⋯ Edit / Test outbound / Delete) and tables as compact cards that open `/tables/:id`; kind chips `?kind=all|rest|file|table`, search `?q=`, `?status=attention` for the one page-level "N need attention" notice; a card opens `SourceDetailSheet` (`?source=<id>`, non-modal): overview, connection, **recent runs** (`/data/runs?sourceId=`), **latest rows** (`/data/rows?sourceId=`), View all data → `/data?source=<id>`. **Health** (`health-section.tsx`): healthy / need attention / waiting for data; pull sources with Run now; tables with row total + last write (newest row per table); live streams only if any exist. **Audit log** (All/Failed filter, before→after), **References** (list + search + add dialog, confirm delete), **Rules** (sentences via `describeTrigger`/`describeAction`, on/off switch, builder dialog with live preview). KPIs: sources, tables, need attention, last sync. Add integration → REST API (`RestSourceEditor`), Upload file (`ImportDialog context="integrations"` — files only; the File → Match → Mapping → Preview wizard spans `import-dialog.tsx`, `field-mapper.tsx`, `import-preview.tsx`, all strings under `integrations.import.*`), Table (→ `/tables/new`). **Deleting an integration is a soft-delete** (sets `deleted_at` on `data_sources` + `streams` + `connections`); ingested data survives and is visible on `/data`. Tables hard-delete after a `linked-configs` guard — see §6.4. **Protected** |
| `/tables` | **Tables** (redesigned 2026-10, `data-link/entity-dashboard.tsx`): every thing-type table and whether data is getting in. Status comes from what the table holds (`src/lib/table-status.ts`): **Needs fields** / **No records yet** / **Receiving data** (write in the last 24 h) / **No recent writes** (normal for reference tables — no badge). It used to be "no fields or no active token", but `GET /tables` never returned tokens so every table read "No write token", and the grid + REST pulls write without a key anyway. KPIs: tables, records, updated today, not ready; one page-level notice + "Show only these". Cards show record count, last write, field chips, how data gets in (API keys / REST pull / edited in the app) and a ⋯ menu (records, schema, keys, copy ID, delete). URL state `?status=all|receiving|empty|needsFields`, `?kind=`, `?q=`, `?sort=name|written|records|updated`, `?view=grid|list`. Delete confirm names the record count; the `linked-configs` 409 renders as `IntegrationLinkedError`. **Protected** |
| `/tables/new` | **Create a table** (redesigned 2026-10): two numbered steps from `SchemaBuilder` create mode — name + entity kind as icon cards, then the fields (seeded with the kind's standard columns, `table-starter-fields.ts`) as compact rows (label · key · type · Required/Unique toggles · reorder/remove). A live **payload preview** (`sampleFieldValue` from `table-field-types.ts`) shows the record body the API will accept; beside the form only at `2xl`, below it otherwise so keys never clip. Sticky footer with Cancel / Create; a `beforeunload` guard once a name is typed. Owners/admins only (others get an explanation). The backend auto-mints a "default" key; on create we toast and land on `/tables/:id`. SchemaBuilder behaviours worth knowing: the key auto-slugs from the label until edited (`keyTouched`); rows keyed by `uid`, never index; `sortOrder` re-derived from position on save; validation derived from rows, shown after the first save attempt; prop changes reset state during render (no effect). **Protected** |
| `/tables/:id` | **Per-table page** (2026-08; redesigned 2026-09 and 2026-10): header with the shared table status, kind, records, last write and a ⋯ menu; a callout only while there are no fields or no records (Add fields / Add a record / Connect a system). When the grid's live total disagrees with the loaded `stats.rows`, the page refetches so status + last write follow. Tabs `?tab=records|api|schema`. Records = `DataGrid`: server-side **search** (`?q=`, debounced), **sort by any column** (`?sort=field:<key>`), page size 25/50/100 (`?size=`), plus `?page=&dir=`; inline edit, Add row, delete + Undo, per-row history. API & access = `ApiDocsViewer`: a summary strip (keys + last used, endpoints, REST pull on/off) that jumps to each section, then keys, endpoints (curl examples use typed sample values) and the REST pull. Schema = `SchemaBuilder` edit mode — saved keys are read-only (renaming would strand records under the old key), a save bar with Discard appears only when dirty; read-only field list for other roles. **Protected** |
| `/reports/:id` export | **Report export** (2026-10, `src/components/reports/export/`). Header **Export** opens `ReportExportDialog`: PDF / Excel / CSV / JSON, widget checklist, rows "As on screen" (a table's search, sort and hidden columns — published by the table widgets to `view-state.ts`) or "All loaded rows" (each query's rows up to its `limit`; no re-fetch), values formatted (default) or raw, plus per-format options (CSV separator / header / BOM / formula guard; Excel header colour report/neutral/none, conditional colours, freeze, autofilter; PDF paper A4/Letter, orientation, colour/greyscale, filters + timestamp; JSON objects/arrays, displayed text, pretty). Options remembered in `localStorage['sgv-report-export']`. Every widget has a ⋯ menu (`WidgetExportMenu`) with one-click CSV / Excel / JSON / PNG (charts + KPIs) / copy-for-a-spreadsheet / more options. `model.ts` builds one export document (columns, raw + display text, conditional tone, footers, KPIs, filters, a `truncated` flag for raw-row tables whose query returned exactly its limit) that `csv.ts` (RFC 4180, CRLF, formula guard, BOM), `xlsx.ts` (hand-written OOXML zipped with SheetJS's CFB — CE can't write styles), `json.ts`, `png.ts` (computed styles inlined into the Recharts SVG) and `print-view.tsx` (PDF via the browser print dialog: off-screen layout at paper width, charts static, light tokens forced, `html.sgv-printing-report` hides the app) all read. |
| `/solutions/:id` | **Solution overview** (2026-10). A Solution is a named group inside the workspace ("Hospital", "Anti-theft") — facilities, reports and data sources (tables + integrations); an item can be in many, deleting a solution never deletes items. `src/routes/solution.tsx`: hero (icon/colour/name/description, **Manage contents**, ⋯ Edit name & look / Delete), KPIs (facilities + tracked assets, reports, integrations + tables with an attention count, live records + updated in 24 h), facility cards, reports, data & integrations with health dots, recent imports; empty / not-found / loading / error states. The other solution pages are the regular screens with `?solution=<id>`: `/warehouses`, `/reports`, `/tables`, `/data`, `/integrations` filter themselves (`useActiveSolution`), swap their description and empty state, and anything created there (facility, report, table) joins the solution. `SolutionScopeBar` (under the top bar) shows the solution, its page tabs, Manage contents and an exit; the breadcrumb reads Workspace › Solution › Page. Create/edit via `SolutionDialog` (template → name, icon, colour, contents with keyword pre-ticks). Viewers see everything; owners/admins/editors change it. |
| `/reports` | **Reports gallery** (redesigned again 2026-10). Every report the caller can see (backend ACL — owners/admins see all, creators their own, others only reports they're listed on in `report_permissions`). `ReportsDashboard` (`src/components/reports/reports-dashboard.tsx`): KPIs (reports + facilities covered · starred · updated this week + the latest · need setup); facility tabs (`?facility=<id>|all`, default = the facility last open on the map), then type tabs (Summary / Detail / Map / History / **Dashboard** — derived by `classifyReport` from the data widgets, ignoring text/notes/dividers, and knowing the v2 kinds `bigValue`/`dataTable`) + Starred, then search / sort / Grid–List (`?q`, `?type`, `?sort`, `?starred=1`). Cards draw the report's real layout in its own colour (`ReportLayoutPreview`), rise in staggered, zoom the preview on hover; skeletons match the card. **New report / Import JSON / Duplicate / Archive are owner/admin only** (the API's rule — it used to be guessed from `canEdit`); Edit shows for reports the caller can edit. Archive is immediate with an **Undo** toast (`POST /reports/{id}/restore`); Duplicate's toast opens the copy; Import validates JSON and opens the new report. Viewers with nothing shared see a viewer-specific empty state. **Protected.** |
| `/reports/new`, `/reports/:id/edit` | **Report builder** (2026-08; shell redesigned 2026-09). A step wizard (`WizardShell`, steps in `builder/wizard/steps/`; which steps appear depends on the report type — `stepsForType`). Page header: back link (to the report when editing), the report's name + New/Editing badge, save status ("Unsaved changes" / "All changes saved"), Cancel, and **Save on every step** (also ⌘/Ctrl+S). Validation lives in `builder/wizard/wizard-validation.ts`: each issue names its step and whether it **blocks** saving (no name, no source, no columns on a Detail/Editable report, non-table source for Editable) or is a warning (widgets/queries/params that will render empty). The rail dots steps with issues (red = blocking, amber = warning; no fake "done" ticks), each step shows its own issues on top, Review lists all with "go to step" links, and a blocked Save jumps to the first blocking step. New reports only surface issues after the first save attempt. Dirty tracking compares `toV2Spec` + metadata against the loaded version; beforeunload warns and Back/Cancel confirm before discarding. Success → toast → viewer. Below `lg` the rail becomes a step picker. Step labels/hints and the report-type cards live in `wizard-steps.ts`. Skeleton / not-found / `QueryError` states. **Round-trip** (2026-10): `loadDraft` sets `draft.generatePrimary` — true only when the spec has the wizard's own `primary_…` widgets (or no widgets yet); a report authored elsewhere (the seeded ones, imports) saves its widgets and queries verbatim, each query keeping its own source, instead of gaining an overlapping primary chart + KPI and having every query re-pointed at one source. The Widgets/Queries steps hide the "generated automatically" panels and validation skips the primary-bundle checks for those. Create/update always send `zoneId` (it was dropped, so every save moved a report to "Shared"). Widget kinds are named via `builder/wizard/widget-kinds.ts` everywhere (never the raw id); the Review footer's Save mirrors the header's disabled state; owners/admins show "Always has access" instead of an access toggle. **Protected.** **Viewer filters step** (2026-10, `steps/viewer-filters-step.tsx`, after Filters): one-click filters for the report's filter bar — ranked suggestions per field (`suggestViewerFilters`: category-like names → dropdown, name/title → search box, booleans → Yes/No, dates → date range), "Another field…", per filter a label, how it's shown (dropdown · pick several · buttons · search · date range · yes/no, by field type) and which of the report's sources it narrows (sources that have the field, via `useSourceSchemas`), a filter-bar preview. Stored as `draft.viewerFilters` / `spec.viewerFilters` and compiled on save by `src/lib/reports/viewer-filters.ts` (`applyViewerFilters`): a `vf_<field>` param, an options query `opt_vf_<field>` (distinct values within the report's fixed conditions on that source — or `options.filters` — never filtered by the params), and the condition(s) appended to **every** query on its sources (main, extra, own-data widgets). `loadDraft` strips them again (`stripViewerFilters`, `isViewerFilterQuery`) so saves never duplicate conditions; date ranges compile to the whole-day ops `onOrAfter` / `onOrBefore`. The Filters step points there and no longer offers its broken single-condition "Date range" prompt. Viewer dropdowns and button groups have an explicit **All** (= unset = no filter). **Facility map & list in the builder** (2026-10): the Widgets step offers **Facility map & list** (`facilityExplorer`) first in Add widget, and a one-click banner — "Show <source> on the facility map" — when the report reads a facility source (that item type) or a table with a data link (that link, the report's facility's first). Setup lives in `steps/explorer-setup.tsx`: facility picker (defaults to the report's facility, else a `facility_id = N` filter, else the only facility), toggle cards for the 11 facility item types and the facility's data links (each becomes a tab), and per tab a name, the fields under each row (≤ 4, also the sort options), editable fields (facility tabs) or the row-title field (data tabs). Defaults come from `src/lib/reports/explorer-spec.ts` (`EXPLORER_FACTS` mirrors the generated set; `dataLinkTab` ports `pickDataFields`). Tab queries are never authored: `compileExplorer` writes one per tab on save (`w_<widget-id>_<n>`, dropped again by `loadDraft`; facility tabs filter `facility_id`, data tabs read the table), so viewer filters reach them. A generated report's named tab queries (`rows_*`, `rows`) are kept until its explorer is edited, then released if nothing else reads them (`releaseExplorerQueries`). A source a tab adds joins the existing viewer filters whose field it has; removing the last tab on a source drops it from them; a Shared report adopts the map's facility. Validation: facility + ≥ 1 tab (warnings); two maps on different facilities **block** saving (one spatial store per page). `UpdateDraft` also takes `(prev) => patch` for async callers. The add / suggest logic lives in `builder/wizard/use-explorer-setup.ts` (shared by Widgets and Layout). **Layout step — Full map** (`steps/map-layout-editor.tsx`): a third mode beside Document / Grid; a to-scale diagram (list, key numbers, insights) and per widget its slot — Key numbers (KPI / big value only) · Insights · Hidden at first — written to `layout.mapSlots`, plus order for the author's own widgets. Without a configured map & list it offers one (one click when the report's source suggests it, else "Set one up in Widgets") and validation warns (`mapNeedsExplorer`) that the report opens as a page until then. |
| `/reports/:id` | **Report viewer** (2026-08; redesigned 2026-09, charts + layout reworked 2026-10). Header: back link, the report's own icon + colour (`ReportIcon`), name + star, description, facility (or Shared) · class · freshness ("Updated 2 minutes ago"; a manual Refresh reads "Refreshing…" for at least 600 ms so the click visibly lands). Actions: Refresh, **Share** (copies the URL — params are in it), **Export** (one CSV per query with rows, labelled by widget title), Edit (only when `canEdit`), ⋯ Run history (non-modal side panel); folded into ⋯ below `sm`. **Charts** (`chart-widgets.tsx`): single-series charts wear the report's colour via `ReportAccentContext` (the same colour as its gallery thumbnail); multi-series and pie slices use `--chart-1…7`, `--chart-8` is the neutral "Other"; gradient bars with hover-dim, one themed tooltip (humanised series names, locale numbers), compact axis ticks (12K), ISO dates shortened; pies sort largest-first, fold the tail into "Other (n)", show blank labels as "Not set", list value + share beside the plot (below when narrow); donuts carry the total (or hovered slice) in the middle; plots animate in unless reduced motion. KPI numbers count up once. **One scroll**: in reading mode canvas rows grow to fit (`minmax(rowHeight, auto)`), so table widgets show their page of rows instead of scrolling inside the page (the builder's Layout canvas keeps the exact grid); below the mobile breakpoint narrow tiles pair two-across. Widgets rise in, staggered. States: header+grid skeleton, kind-shaped widget skeletons, per-widget error + Retry, not-found, `QueryError`. Files: `report-viewer.tsx`, `widgets.tsx`, `chart-widgets.tsx`, `widgets/*`, `layout/report-canvas.tsx`, `layout/document-flow.tsx`. **Protected.** **Full map** (2026-10, `layout.kind = 'map'`): when a report has a configured facility map & list (`mapExplorer`, `src/lib/reports/map-layout.ts`) the header shows a **Page / Map** switch (`ViewSwitch`; phones: ⋯ → Map view); it opens in the author's layout, then each viewer's own pick per report (`localStorage` `sgv-report-view:<id>`). Map view (`layout/report-map-view.tsx`) fills `<main>`: the explorer renders with `chrome` (`widgets/facility-explorer/explorer-map-layout.tsx`) on one 16 px grid of frosted-glass panels (`.sgv-glass` / `.sgv-glass-dense`, index.css) — top bar — left: back, icon, name, star, facility, a ticking "Updated 4s ago"; right, icon groups with tooltips: the floor dropdown · **Live** (a dot in a countdown ring; menu: Refresh now, every 10 s / 30 s / 1 min / 5 min, pause) · **Filters** (icon + active badge → popover with `ParamFields`) · Page/Map (icons) · **Map style & panels** (`ViewMenu`: the 8 basemaps of `map-styles.json` as tiles — names in `reports.mapView.styles.<id>` — remembered per viewer in prefs and passed to `FacilityMap styleId`; then Panels and Widgets toggles) · **Share & export** (copy link, Export…, run history) · Edit; phones fold the rest into ⋯, the list on the left (rows: status dot in the link's style-rule colour, the first numeric subtitle field right-aligned as the row's headline number, hover → ghost pin on the map via `FacilityMap hoverPoint`; collapses to a chip bottom-left), a **Details | Insights** panel on the right (a pick opens Details — status badge, number tiles, fields; closing it returns to Insights: charts / tables / notes as stacked cards via the viewer's `WidgetCell`), and between them the KPI cards in one row along the top (sharing the width, scrolling sideways when the gap is narrow; `MapKpiChip`: count up on arrival, a changed value glows once with its ↑/↓ difference). **Floors** (`floor-picker.tsx`, in the top bar via `chrome.renderTopBar(floorPicker)`): the viewer's model — All floors or any set (ticks keep the menu open, "Only" isolates one; phones show a short L0 / All / n label); several floors render stacked and the camera tilts (≥ 55°) and closes in. The explorer's floor set (`mapFloors`; default = the one floor every row is on, else the lowest) drives `FacilityMap floors` (shape filters) **and** the data layer (`MapDataLinkedOverlay activeFloorPlanId` now takes `ActiveFloors` = number | Set | null — `passesFloorScope` passes an entity on any listed floor; `fetchLayerRows` only pushes a single floor server-side, `activeFloorKey` keys the cache) **and** the list: rows whose placement floor isn't selected aren't listed (rows with no known floor stay); picking a row never switches floors, hiding the picked row's floor closes it. The page-layout explorer's floor pills gained "All floors" and filter the same way. KPI and chart widgets are report queries — they follow the Filters, not the floor picker. Panels slide in staggered on load and slide out when hidden; the map fades in once the facility is framed. **Live** (`useLiveRefresh`): re-runs every 30 s by default (10 s / 30 s / 1 min / 5 min / pause, per viewer in prefs), counted from the last finished run, never while running or with the tab hidden; a countdown ring in the pill; the re-run is quiet (`onQuietRefresh` → `store.runAll()`, widgets rendered with `quiet` so they don't dim). Widget slots come from `layout.mapSlots` (`kpi` · `insights` · `hidden` = off until a viewer turns it on; default by kind, `mapSlotOf`). Panel + widget toggles persist per viewer (`sgv-report-map:<id>`); shortcuts L list · I insights · F filters. Phones: top bar + floors over the map, one bottom panel with List / Insights / Details tabs (a pick opens Details). The map never resizes: panels pass their footprint to `FacilityMap` as `insets` (camera padding via `framePadding`, scaled to fit). The chrome sits at `z-10` over Mapbox's controls and stops 32 px above the bottom so the logo / attribution stay visible. Exports and prints always use the page layout; a map-layout report shown as a page renders as a document. |
| `/files` | **Files** (redesigned 2026-10): every image / 3D model this workspace stores, and whether it can go. KPIs (files, storage used with an in-use bar, in use + facility count, can be freed), one "X can be freed → Review" notice (plus a danger notice when files are **missing** from storage). Plain-language statuses mapped from the API categories: attached → **In use**, ghost → **Leftover**, orphan → **Unused**, missing → **Missing** (`src/components/files/file-helpers.ts`). URL state: `?status=all|inUse|cleanup|missing`, `?type=floorplan|plane|model|image|other`, `?facility=<zoneId>`, `?q=`, `?sort=newest|oldest|largest|name`, `?view=grid|list`, `?file=<key>` (opens `FileDetailSheet`, non-modal: large preview — interactive `<model-viewer>` for GLB — details incl. pixel dimensions, "Where it’s used" with links to each facility editor, and Delete or the reason it can’t be). Only Leftover/Unused files are selectable; floating selection bar → bulk `ConfirmDialog`. "Delete" on an in-use file opens its panel instead of a dead-end dialog. **Strictly workspace-scoped**: only files this workspace uploaded (`tenant_files`) or references. **Server-side paging**: 24 per page, "Load more" (auto-fires near the end of the list) appends by offset via `useFilesPages`; filters/search/sort/counts run in the API; search is debounced; a filter change dims the current cards until the new page lands. **Protected + gated to `owner`/`admin`** — others get a read-only explanation (the API answers 403). |
| `/data` | Every record ingested through any integration — **including archived ones** (redesigned 2026-10). `PageHero` (Live dot re-keyed on each `data-events` SSE, Refresh) → four KPIs (Records, Latest record, Ingest runs + failures, Sources + archived) from two `pageSize:1` summary queries → a failed-runs notice → tabs **Records / Rooms & bins / Files / Runs** with counts → toolbar (`SourcePicker` with search + an archived group, `DateRangePicker` presets 1h/24h/7d/30d + custom, archived filter only when archived sources exist, runs result filter, search, Export CSV of the current page, ⋯ purge menu) → one card holding the table + `Pager` (25/50/100/200). Components in `src/components/data/` (`data-tables.tsx`, `record-sheet.tsx`, `source-picker.tsx`, `date-range-picker.tsx`, `data-helpers.ts`). **One scroll**: tables have no height cap, the header sticks to the page (card is `overflow-clip`), low-priority columns hide below `xl`, card lists below `md`. Rows open `RecordSheet` (non-modal; ↑/↓ or j/k steps; Fields / JSON; Copy JSON; Delete). Rows animate in (`sgv-row-in`), live arrivals flash (`sgv-row-new`). URL state: `tab, source, q, range, from, to, status, page, size` (so integrations deep-link with `?source=<id>`). Row / bulk / per-source-purge / older-than deletes are **editor+** server-side (`dataRoleGate` in `DataScreenRouter(q, pool)`) and hidden for viewers. `data_source_rows` cascade-deletes on hard source delete, but the mirror handler soft-deletes now, so cascade only fires when the user explicitly purges. **Protected.** |
| `/profile` | Personal settings (redesigned 2026-09) as labelled sections: **Profile** (display name, job title, location, pronouns, about — live "how others see you" card; edits collect in a sticky save bar with Reset/Save, ⌘/Ctrl+S, beforeunload guard, toast), **Photo** (click or drop; image type + 5 MB checked client-side like the API; saves immediately), **Account** (email + Verified badge; Change password → `/forgot-password?email=` code flow, which revokes other sessions), **Preferences** (language, light/dark/system, palette — same as the account menu). **Protected** |
| `/members` | Roster of the current workspace (redesigned 2026-09): search + role filter (`?q=`, `?role=`), each row with a one-line description of its role, a "What roles can do" card beside it. Owner/admin: **Invite people** dialog (email + role cards; invitees need an existing account — a 404 becomes "ask them to sign up first", existing members are caught client-side), inline role change with an **Undo** toast, remove via `ConfirmDialog`. The owner's row and your own are never editable; other roles see it read-only (invite button disabled with a reason). "Just you" nudge when the workspace has one member. Skeleton / `QueryError` / no-match states. **Protected** |
| `/workspaces` | Manage every workspace the user belongs to (redesigned 2026-09 as a card grid, active first): colour tile + initial, Active marker (ring), role, Open dashboard / Switch to (toast), ⋯ menu with Rename & colour (owner/admin; live preview), Leave (`ConfirmDialog`; disabled with the reason for owners and for your only workspace), Delete (owner; typed-name `ConfirmDialog`; not for your only workspace), plus a dashed "New workspace" card. Wired through `src/lib/workspace-client.ts` → `POST/GET/PATCH/DELETE /api/v1/tenants` + `POST /api/v1/tenants/{id}/leave`. Global switcher chip lives in the header (`src/components/workspace-switcher.tsx`) and shares the create dialog. Switching triggers a full reload cascade (spatial-store slices cleared + doors reset + queryCache invalidated + loadAll) wired at boot by `installWorkspaceSwitchReloader()` in `src/main.tsx`. **Protected** |

### Interaction layer (2026-09, second pass)

Shared behaviour every workspace page now uses (research brief: NN/g, Carbon, Atlassian, M3, WCAG 2.2):
- **Toasts** — `src/lib/toast-store.ts` (`toast.success/info/error`, optional single action, auto-dismiss 4s / 8s with an action, pause on hover/focus) rendered by `components/feedback/toaster.tsx` (mounted once in `AppContent`, polite live region). For outcomes only; errors the user must fix stay inline.
- **Confirmations** — `components/feedback/confirm-dialog.tsx` replaces every `window.confirm()` (Cancel focused by default, inline server error, `confirmDisabled` for type-to-confirm). Facility delete requires typing the facility name.
- **Load failures** — `components/feedback/query-error.tsx` (`QueryError`: offline vs server wording, Retry, auto-retry on reconnect; `useOnline()`), plus `offline-banner.tsx` (persistent strip under the top bar while offline).
- **URL state** — `hooks/useUrlState.ts`: search / filters / sort / view / tab are query params on Facilities (`q, empty, sort, dir, view`), Tables (`q, kind, setup, sort`), Integrations (`view, kind, q, status, source`), Data (`tab, source, q, range, from, to, status, page, size`), Reports (`q, type, sort, starred` + `facility`), Table detail (`tab, page, sort, dir`), Members (`q, role`). The setter builds on `window.location.search`, so several setters in one handler compose (see `docs/pitfalls-frontend.md`).
- **Roles** — `hooks/useWorkspaceRole.ts` (`canManage` = owner/admin, `canEdit` = +editor). Disallowed actions stay visible but disabled with a reason rather than disappearing — wrap them in `components/feedback/role-gate.tsx` (`RoleGate allowed message?`, tooltip on a focusable wrapper); Files shows a proper permission page.
- **Times** — `lib/relative-time.ts`: `relativeTime(iso, locale)` for the cell ("3 days ago" via `Intl.RelativeTimeFormat`) and `fullTime(iso, locale)` for its `title`.
- **Motion** — `.sgv-rise` (staggered section entry via `rise(i)` from `page-shell.tsx`), `.sgv-fade` (tab/filter swaps), `.sgv-lift` (card hover), `.sgv-toast`; all static under reduced motion. `components/count-up.tsx` animates KPI values once on first paint (never on refresh polls).
- **Page specifics** — Dashboard: time-of-day greeting, data-derived "Finish setting up" checklist (dismissible per workspace, `localStorage['sgv-onboarding-dismissed:<tenantId>']`), "Jump back in" (recent facilities/reports/tables). Facilities: selectable cards + bulk bar. Data: record detail is a non-modal side panel (Fields / JSON, copy), date presets (24h / 7d / 30d), CSV export of the current rows. Files: storage-used card + reclaimable size, orphan/ghost cleanup callout with "Select all N". Reports: `report-layout-preview.tsx` draws each card's real widget layout at true page proportions (12 cols × 48px rows, top-cropped with a fade); stars per workspace (`localStorage['sgv-starred-reports:<tenantId>']`) float to the top and filter via `?starred=1`. `report-identity.tsx` holds what identifies a report everywhere (`ReportIcon`, `CLASS_META`, `useStarred`, `StarButton`) — the gallery and the viewer share it.
- **Chart colours** — `--chart-1…8` in `src/index.css` (light + dark), palette-independent like the status tokens; Tailwind exposes them as `chart-1…8` (`text-chart-3`, `bg-chart-1/10`). Use them for categorical data (report charts, chips, KPI tones); `--chart-8` is the neutral one ("Other"). Keep `--primary` for brand UI. Report conditional-formatting looks live in `src/lib/reports/condition-styles.ts` (`CONDITION_STYLES` on status/chart tokens; `themeClass` maps raw palette classes saved in older specs onto them).

### Workspace pages after the 2026-09 redesign

All seven pages share `PageContainer`/`PageHero` , `StatCard` KPIs, `FilterTabs`, `EmptyState` and `Badge` — see "Shared kit" below.
- **/tables** (`data-link/entity-dashboard.tsx`) — data-based status (see `/tables` row); one page-level "N tables have no data yet" notice; tables sharing a name show `#id`.
- **/integrations** — "All" now lists tables too (the old count/list mismatch). Two `FilterTabs` groups: Sources (All / REST / Files / Tables) and Monitoring (Health / References / Rules / Audit). One "Add integration" menu (REST API / Upload file / Table). KPIs: REST APIs, File imports, Tables, Failing (lastResult = error). `TableCard` actions moved into a "⋯" menu.
- **/data** — `PageHero` + KPIs + tabs + toolbar + one table card (no browse sidebar since 2026-10). Data payloads render as one readable `key value · key value` line (full JSON in `RecordSheet`).
- **/files** (redesigned again 2026-10) — page flow like `/integrations`, not `BrowseLayout`: KPIs, cleanup notice, status `FilterTabs` + facility/type/sort menus, grid or list, `FileDetailSheet`. Components in `src/components/files/` (`file-helpers.ts`, `file-preview.tsx`, `file-card.tsx`, `file-detail-sheet.tsx`); names drop the content-hash suffix (`displayFileName`).
- **/reports** (`reports/reports-dashboard.tsx`) — `StatCard` KPIs, facility tabs, then type tabs + Starred and search/sort/view (two rows below `xl`), cards use each report's own `icon` + `color` (via `iconComponentForId`, falling back to the type icon). The mixed class is labelled "Dashboard" (`reports.classDashboard`).

### Key UI building blocks

- **App shell** (`src/components/app-shell/`, 2026-09) — replaced the top-nav header. `app-sidebar.tsx`: brand + collapse toggle, `WorkspaceSwitcher`, the 7 `NAV_ITEMS` (`nav-items.ts`, also `activeNavItem()` which matches sub-routes), the workspace's **Solutions** (`sidebar-solutions.tsx` — one entry each, the active one expanded into Overview · Facilities · Reports · Tables · Data · Integrations, + New solution for editors; `useSolutionLocation()` tells which solution/page the URL is on, and while inside one the plain nav item isn't highlighted), Admin (platform admins), and `UserMenu` at the foot (profile, workspaces, members, billing + **Language / Appearance / Palette submenus** — these left the header). Expanded `w-60` or a `w-[60px]` icon rail with tooltips; preference in `localStorage['sgv-sidebar-collapsed']`; map routes force the rail. <md: `MobileSidebar` (a start-side `Sheet`). `app-topbar.tsx` (h-12): mobile menu, `Workspace › Page` breadcrumb, search (⌘K palette), and on map routes the zoom/fullscreen controls from `useHeaderControls`. The shell is viewport-locked (`h-dvh overflow-hidden`); `<main>` scrolls and is reset to top on route change in `AppContent`. `TooltipProvider` wraps the router.
- **Shared kit** (2026-09) — `page-shell.tsx` (`PageContainer` = max-w-[1400px] scroll container; compact `PageHero`/`PageChapter`; `eyebrow` props are accepted but no longer rendered), `stat-card.tsx` (the one KPI card: monochrome icon, value, one of delta / hint / progress), `empty-state.tsx`, `facility-card.tsx` (thumbnail + counts + occupancy; stretched link to the editor, Preview to `/view/:id`), and shadcn primitives `ui/{card,badge,table,tabs,tooltip,skeleton}.tsx` (tabs/tooltip on `@radix-ui/react-{tabs,tooltip}`). Status colours: `--success/--warning/--danger/--info` tokens → `text-success`, `bg-warning/10`, `Badge variant="success"`… Digits are proportional by default; add `tabular-nums` where numbers must align. Also `filter-tabs.tsx` (segmented filter with counts) and `browse-layout.tsx` (`BrowseLayout`, `BrowseSidebarSection`, `BrowseSidebarItem` — no current users since `/data` moved to the page flow in 2026-10). `PageHero` wraps rather than squeezes (title keeps ≥22rem; actions drop to their own line when both don't fit). `StatCard`/`CountUp` format numbers in the app language (`toLocaleString(i18n.language)`), never the browser's locale.

- **Theming** — two orthogonal axes managed by `ThemeProvider`: `mode` (light/dark/system) via `.light`/`.dark` on `<html>`, `palette` (46 total: `default` (Zinc) + 45 colored — reds: red/crimson/maroon/scarlet, oranges: orange/tangerine/coral/salmon/peach, yellows: amber/gold/mustard/yellow, greens: lime/olive/sage/green/forest/emerald/mint/jade/teal, blues: cyan/ocean/sky/blue/navy/royal/indigo/periwinkle, purples-pinks: violet/lavender/purple/plum/fuchsia/magenta/mauve/pink/rose, earth/neutrals: slate/stone/bronze/copper/mocha/midnight) via `.theme-<id>` on `<html>`. Picker UI: `<ModeToggle />` + `<ThemePicker />` (6-column swatch grid) in the header and on login/signup. Palette only overrides `--primary` / `--primary-foreground` / `--ring`; surface tokens stay neutral so every palette reads cleanly in both modes.
- **`page-shell.tsx`** — the shared vocabulary every full-page admin screen is built from: `PageContainer` (mesh background + grid overlay + the single scroll pane, `max-w-7xl`), `PageHero` (hairline eyebrow → oversized title → description → actions/primaryAction) and `PageChapter` (a titled band within the page). Used by `/dashboard`, `/warehouses`, `/integrations`, `/files`, `/tables`, `/tables/new` and `/reports`. **A new full-page screen should compose these rather than hand-rolling headings** — the sizes, tracking and gaps are the thing that makes the screens feel like one product. Note `PageContainer` bleeds negative margins to cancel the App shell's padding and owns the only scroll container, so nesting one inside another breaks scrolling. Per-page KPI cards (`StatCard` + a `TONES` map) are deliberately **copied** into each route rather than shared — the cards diverge per screen and extracting them would couple four working pages together.
- **`themed-background.tsx`** — fixed decorative photo background (`<ThemedBackground variant="dashboard" />`, `bgimages/{light,dark}Two.jpeg`). **Currently mounted nowhere**: the auth screens dropped it in the 2026-09 redesign (a photo behind a form forced text-shadow hacks and failed contrast in some palettes) and the admin screens use `page-shell`'s mesh. `bgimages/{light,dark}One.jpeg` (the old auth images) are likewise unused. Candidates for removal.
- **Auth screens** (`src/components/auth/`, 2026-09) — shared by `/login`, `/signup`, `/forgot-password`:
  - `auth-layout.tsx` — `AuthLayout` (≥lg split screen: brand panel on the start side, form column on the end side with language/palette/mode switchers + `LegalLinks`; <lg the panel drops and the logo + product still move above the form). The form is top-anchored (`lg:pt-[18dvh]`), not vertically centred, so errors/steps don't make the heading jump. Also `AuthHeader`, `AuthSwitchLine`, and `rise(i)` (staggered entry helper).
  - `auth-brand-panel.tsx` — `AuthBrandPanel`: full-bleed **real product footage** (frame-by-frame viewer captures of the demo workspace), cut into one seamless 32 s loop that covers the platform: the full warehouse orbit (every layer incl. live worker markers) → the full supermarket orbit (aisles, zones, safety) → a push-in on live staff/equipment, each cut dipping through the page background, the last dipping back into the first. A caption chip names the current scene (`SCENES`, synced via `timeupdate` — retime together with the encode). Light/dark takes via `useResolvedTheme`; the supermarket was only captured light, so the dark loop runs it through `negate,hue=h=180` (matches the dark map style; labels come out light). Footage fades into a solid band with the headline + 3 feature pills; panel is `sticky top-0 h-dvh`. The `<video>` mounts only at ≥lg and becomes the poster still under reduced motion. `AuthMobileProductShot`: the poster, zoomed onto the facility, as a card above the form on <lg (~160 KB, never the video). Assets: `public/auth/facilities-{light,dark}.{mp4,jpg}` — 1080p H.264 crf 31, `+faststart`, ~8 MB each; the ffmpeg recipe is in the file's header comment.
  - `auth-brand-mark.tsx` — logo (`/logo.png`) + "Spatial Map" wordmark; `PRODUCT_NAME`.
  - `auth-fields.tsx` — `AuthInput`, `PasswordInput` (keyboard-reachable show/hide toggle, caps-lock hint), `FieldError`, `AuthSubmitButton` (in-place spinner, `aria-disabled` so focus isn't lost).
  - `otp-input.tsx` — ONE real `<input autocomplete="one-time-code">` over six aria-hidden slots; strips non-digits before truncating so pasted "123 456" works; fires `onComplete` for auto-submit.
  - `auth-otp-step.tsx` — the "check your email" step shared by signup + reset.
  - `auth-steps.tsx` — `StepProgress`, `StepTransition` (keyed remount, forward/back slide mirrored in RTL), `SuccessCheck`.
  - `auth-alert.tsx` — form-level alert: `role=alert` for errors (with a shake), `role=status` for info/success.
  - Motion lives in `index.css` under "Auth screens" (`.sgv-auth-*`: entry rise, step slide, error shake, OTP caret, success check): every class renders its final state by default and animates only inside `prefers-reduced-motion: no-preference`.
  - Hooks: `useCountdown` (deadline-based; resend cooldown + 429 lockout), `useDocumentTitle` (adds an "Error:" prefix while an error shows), `useAuthAlert`, `useMediaQuery` + `useResolvedTheme` (both `useSyncExternalStore`; the latter resolves `system` by watching `<html class="dark">`).
  - The auth shell sets `font-variant-numeric: normal` (the app-wide `tabular-nums` widens Inter's hyphen: "real - time"); countdown labels opt back into `tabular-nums`. Email inputs are `dir="ltr"` in RTL.
- **`auth-guard.tsx`** — `AuthGuard` (protected routes; `/auth/me` probe on boot) and `GuestOnly` (wraps `/login` + `/signup`).
- **`legal-links.tsx`** — optional Terms / Privacy footer on the auth screens; URLs from `VITE_TERMS_URL` / `VITE_PRIVACY_URL` (`src/config/legal.ts`), hidden when unset.
- **`mapbox-map.tsx`** — wraps Mapbox GL. Owns sources/layers, draw mode, hit-testing, hover/click handlers, 3D lighting, image rasters, model layers. The single highest-complexity file in the frontend.
- **Tool palette** — left rail with creation tools (grid, polygon, circle, line, marker, image, model, stair, door, text label) + selection/pan.
- **Inspector panels** — right-side property editors for each shape kind. Reads live `useSpatialStore`, edits via `updateLocal` (debounced flush).
- **Dialogs** — Radix-based (data import wizard, share dialog, attribute editor, role vocabulary editor, model picker, **PDF sheet/scale picker** — see §5.12).
- **Header controls** — tenant switcher, style picker, search, undo/redo, presence indicators.

### Frameworks & libraries

- React 19, React Router 7
- Radix UI primitives (dialog, dropdown, label, slider, slot, switch)
- TailwindCSS 3.4 + shadcn/ui (style `new-york`, base color `zinc`, alias `@/*` → `src/*`)
- Lucide icons, cmdk command palette
- i18next 26 (browser detect + HTTP backend) — locales loaded from `/public/locales/<lang>/translation.json`
- vaul (drawer) — bottom-anchored only
- `SliderRow` / `BulkSliderRow` (`src/components/ui/slider-row.tsx`) — slider + typed `NumberInput` row used across the side panel. `max` is the drag range; `limitMax` lets typed values go further. The slider part is `StretchSlider` (`src/components/ui/stretch-slider.tsx`): its range grows to a round number above a larger value, grows again when a drag is released at the end, and shrinks back when released inside the base range. Limits live in `src/lib/input-limits.ts` (door 200 m wide, elevation 2000 m, 500 stair steps, 50 rack levels, text 256 px, strokes 100 px, markers 96 px — the marker overlay's own render cap).
- `Sheet` (`src/components/ui/sheet.tsx`) — side-anchored panel on Radix `DialogPrimitive`; `side` prop `"start" | "end" | "top" | "bottom"`. Used for the non-modal detail panels (`SourceDetailSheet`, `FileDetailSheet`, `RecordSheet`).

### Mapbox specifics

- Style: customizable via `map-styles.json` (Mapbox public styles)
- Mapbox 3.x **rejects data expressions on `fill-extrusion-opacity`** → generators bucket features into per-opacity layers (`opacityBucket: 0|10|...|100`).
- 3D model layers use Mapbox native `model` source/layer type. Models must be self-contained `.glb` (see §9 build pipeline).
- Custom draw mode `DrawGridMode` in `src/lib/grid-draw-mode.ts` — two-click rectangle with no preview (anchor dot only).
- **HTML markers are not in the depth buffer.** `mapboxgl.Marker` renders DOM nodes composited *above* the canvas, so GL layers can never hide them; `MarkerOptions.occludedOpacity` only covers 3D terrain, not custom layers. We recover the depth test analytically in `src/lib/marker-occlusion.ts` (camera→marker ray vs. extruded prisms in Mercator space — slabs, walls, staircases, floor-plan rasters) and express the result as `data-occluded` on the marker element. Gated by the `markerOcclusion` graphics setting (default **on**).
- **GL layers occlude natively — but only if you ask.** Anything drawn as a real Mapbox layer skips the analytic prism test above and uses `text-occlusion-opacity` / `icon-occlusion-opacity` / `line-occlusion-opacity` instead. The symbol ones must be **named explicitly**: an absent value means "occlude against terrain only", which is not the same as the spec's stated default of `0`. `line-occlusion-opacity` does default to 0 but is not data-driven and is ignored when `line-opacity` carries an expression. Elevation is `symbol-z-offset` (paint) / `fill-z-offset` (paint) / `line-z-offset` + `line-elevation-reference` (both layout).
- **`circle` layers can do neither.** Mapbox 3.25 has no `circle-z-offset` and no `circle-occlusion-opacity`, and `circle-elevation-reference` accepts only `none` / `hd-road-markup` — so a circle is stuck on the ground and always visible through solid geometry. Every dot, disc and ring in the map overlays is therefore a `symbol` drawing a `●` (or `○`) glyph, sized via `DISC_EM_SCALE` (`text-size = radius * 2.8`, since the glyph fills ≈0.72 of its em-box). `heatmap` is screen-space and supports neither at any size.

---

## 3.1 Layout Editor — deep dive

The `/create-grids` route is the workhorse of the app: it orchestrates 20+ overlays, 13 creation tools, multi-kind selection, transforms, undo/redo, style rules, and live data.

It is a **folder, not a single file** — `src/routes/create-grids/` (~14,700 lines across 47 files). Older notes calling it `create-grids.tsx` refer to the same thing; the split is mechanical, so every pattern below still holds:

| Subfolder | Holds | Naming |
|---|---|---|
| `index.tsx` | The route component — composes everything below, owns the JSX tree and the overlay mount order | — |
| `state/` | One `use<Kind>EditorState.ts` per tool: its config, draft, cursor, transform, selection | `useImageEditorState`, `usePolygonEditorState`, … |
| `handlers/` | One `use<Kind>Handlers.ts` per tool: the create / patch / delete / duplicate callbacks the side panel calls | `useImageHandlers`, `useBulkHandlers`, … |
| `hooks/` | Map-event wiring — one `use<Kind>PlacementTool` / `use<Kind>DrawTool` per creation tool, plus `useMapLifecycle`, `useEditorBootstrap`, `useKeyboardDispatch`, `unproject-at-altitude.ts` | `useImagePlacementTool`, … |
| `layers/` | `OverlayStack.tsx` (the shape overlays, in registration order) + `SecondaryLayers.tsx` (data-link, live data, heatmaps) | — |
| `panels/` | Small always-on chrome: `StatusBar` (one line: coordinates at `xl+`, the contextual `KeyboardHint`, undo/redo buttons via `useHistoryAvailability`, and an "N shapes" popover), `WarehousePill`, `DataLinkPill`, `SaveStatus` | — |
| `dialogs/` | `EditorDialogs.tsx` — bin editor, shape editor, bulk assign, data link, schema builder | — |

The split is by **tool**, not by layer: adding a creation tool means one file in each of `state/`, `handlers/`, `hooks/`, then a mount in `index.tsx` and `layers/OverlayStack.tsx`.

### 3.1.1 Props & top-level state

```ts
interface CreateGridsProps {
  panelOpen: boolean
  onPanelOpenChange: (open: boolean) => void
  preview?: boolean   // read-only operations view with live overlays enabled
}
```

State is grouped by responsibility (line numbers approximate; large file, expect drift):

| Group | Key state |
|---|---|
| **Scope** | `activeWarehouseId` (from `?warehouseId=`), `activeWarehouseIdRef`, `hiddenFloorPlanIds` |
| **Map lifecycle** | `mapInstance`, `drawRef` (MapboxDraw), `viewport`, `mapStyle`, `loadedStyleId`, `initialViewportSetRef` |
| **Layer / selection** | `layerVisibility: Map<LayerVisibilityKind, boolean>`, `layerOrder: string[]`, `selected<Kind>Ids: Set<number>` for every kind |
| **Active tool** | `activeTool` — one of pan / select / create-grid / create-marker / create-circle / create-polygon / create-line / create-image / create-model / create-image-plane / create-text / create-stair / create-door / magic-wall / zones |
| **Grid draw** | `config`, `draftConfig`, `draftGridIds`, `drawMode`, `hasAnchor`, `redrawingGridId` |
| **Per-tool state** | `markerConfig`/`markerCursor`/`markerTransform`; `circleConfig`/`circleSubMode`/`circleCellSize`/`circleCellRadius`/`circleDragStart`/`circleGridStart`; `polygonConfig`/`polygonDraftVertices`; `lineConfig`/`lineDraftVertices`; `stairConfig`/`stairDraftAnchors`; `doorDraftAnchors`/`doorTransform` (door geometry lives in `useDoorStore`, NOT spatial-store); `textLabelConfig`/`textLabelCursor`; `imageConfig`/`imageDraft` (in-flight upload)/`imageDragStart`; `modelConfig`/`modelCursor`/`modelLibraryOpen`. Sidebar edits to a selected rack / model / stair are spatial-store drafts (no route-level `draftConfig` / `draftModelPatch` / `draftStairPatch` since 2026-10) |
| **Transforms** | `transform: { gridId, kind: 'move'\|'rotate'\|'scale' }` + per-kind `<kind>Transform` + `<kind>TransformDraft` (live preview before commit) |
| **Dialogs** | `selectedBin`, `binDialogOpen`, `shapeEditorOpen`/`shapeEditorTarget`, `bulkAssignOpen`, `dataLinkOpen`, `schemaBuilderOpen` |
| **Stored shapes (memoized views)** | `savedGrids`, `savedMarkers`, `savedCircles`, `savedPolygons`, `savedLines`, `savedTextLabels`, `savedImages`, `savedModels`, `savedImagePlanes`, `savedStairs`, `savedBins`, `savedStyleRules`, `savedZones` — all filtered through `scopeToWarehouse()` (warehouse + floor-plan cascade) |

### 3.1.2 Tools + keyboard shortcuts

Defined in `src/lib/keyboard-shortcuts.ts`:

| Tool | Letters | Num | What it does |
|---|---|---|---|
| pan | v, h | 1 | Default cursor, no creation |
| select | space | 2 | Multi-select (Space = momentary) |
| create-grid | g, r | 3 | MapboxDraw 2-click rectangle → grid |
| create-marker | m | 4 | Click to drop marker |
| create-circle | c, o | 5 | Single drag OR 2-click grid-of-circles (toggled via `circleSubMode`) |
| create-polygon | p | 6 | Multi-click chain; Enter finishes |
| create-line | l | 7 | Multi-click chain; Enter finishes |
| create-image | i | 8 | Drag bbox → upload file. Accepts PNG/JPEG/GIF **or a PDF drawing set** — a PDF detours through the sheet/scale picker first (see §5.12) and then places at its true ground size, so the drag only picks position |
| create-model | b | 9 | Click to place 3D model (library picker auto-opens) |
| create-image-plane | f | 0 | File picker → upload → click to place a textured-plane GLB (image rendered with full 3D transforms via Mapbox `model` layer) |
| create-text | t | — | Click to place text label |
| create-stair | s | — | "Stairs & lifts": multi-click straight/L/U stair, or 2 clicks for an escalator (bottom → top) / elevator (door side, left → right corner). Clicks are ray-cast at the base elevation |
| create-door | d | = | Multi-click for door opening |
| magic-wall | w | — | Click polygons to stage them; sidebar Generate button spawns walls around each (shared party walls deduped, existing walls skipped). One-shot — no back-reference to the source polygons. |
| ai-map | a | — | Click a placed floor plan (or drag a rect on it for region-select — the Python worker crops before running SAM for higher recall) → Go handler dispatches to the Python ai-worker (`backend/ai-worker/`, SAM 2 + Tesseract OCR + OpenCV + Shapely, Dramatiq/Redis actor) → pipeline emits aisles / areas / doors / stairs already reprojected to Mapbox lng/lat → review dialog with per-detection Accept/Reject + bulk "Accept N above X%" + confidence slider → accepted detections become normal shapes via `apiDb.<kind>.add`. Vocabulary remap (wall→aisle, room→area) lives at Python emit boundary. Beta; opt-in per tenant via `app_settings` key `ai_floorplan_enabled:tenant:{id}` = "true". Full architecture in `docs/ai-floorplan.md`. |
| zones | z | — | Navigate zones panel |

**Global shortcuts** (dispatched in `useKeyboardShortcuts`):
- `Esc` → cancel transform → cancel draw → deselect (cascade)
- `Enter` → commit transform or finish polygon/line/stair draw
- `Backspace`/`Delete` → remove last vertex or delete selection
- Arrows → nudge 4m (20m with Shift) — uses `nudgeVerticesAlongHeading` for local-frame motion
- `[` / `]` → rotate ±1° (±15° with Shift)
- `-` / `+` → scale ±1
- `PageUp/Down` → elevation ±1
- `F` → fit map to selection
- `Cmd/Ctrl+D` → duplicate
- `Cmd/Ctrl+E` → export GeoJSON
- `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` → undo / redo (in-memory `gridHistory`)
- `?` → toggle cheatsheet

### 3.1.3 Active warehouse + scoping

Warehouse is URL-scoped: `?warehouseId=N`. `activeWarehouseId` drives:
1. **`scopeToWarehouse(rows)`** — filters by `zoneId === activeWarehouseId`, then cascades by `hiddenFloorPlanIds` (floor-plan visibility).
2. **Zone-scoped catalog loads** — attribute definitions and doors are re-fetched per warehouse via `useSpatialStore.loadKind('attributeDefinitions', { zoneId })` and `useDoorStore.loadForWarehouse(zoneId)`.
3. **Initial viewport** — priority: zone's `defaultView` → floor-plan image bounding box → zone's pinned `center` → whole earth. Guarded by `initialViewportSetRef` (one-shot per warehouse change).
4. **Layer order** — persisted per-warehouse to `app_settings` under key `warehouse:<id>:layerOrder`.

When `activeWarehouseId === null`, the editor shows the user's whole catalog across warehouses (used in the "all warehouses" workspace mode).

### 3.1.4 Map lifecycle

```
handleMapLoad(map):
  setMapInstance(map)
  drawRef.current = new MapboxDraw(DRAW_CONTROLS)  // registers DrawGridMode
  map.addControl(draw)

handleMapDestroy():
  drawRef.current = null
  setMapInstance(null)
  setLoadedStyleId(null)
  reset live preview state, initialViewportSetRef
```

**Style swaps are gated:**
- `mapStyle` change → `setLoadedStyleId(null)` → overlays receive `map={null}` and unmount their sources/layers.
- Mapbox fires `style.load` after the new basemap finishes loading → `setLoadedStyleId(mapStyle)` → overlays remount and re-add sources/layers.
- The single line that gates this: `const overlayMap = loadedStyleId === mapStyle ? mapInstance : null`. **Don't add overlays that skip this gate** — they'll crash trying to addLayer to a half-loaded style.

### 3.1.5 Overlay registration & order

Overlays are rendered inside a Fragment keyed by `layerOrder.join('-')`. Reordering the layer panel changes the key → all overlays unmount/remount → Mapbox layer order is rebuilt bottom-up. This is intentional but expensive — don't trigger it on every render.

**Reorderable overlays** (bottom→top default): `image` → `grid` → `circle` → `polygon` → `line` → `stair` → `model`.

The `image` slot is a single `MapImageOverlay` — rasters plus selection / handles / hit-testing for every floor plan. A DWG import is an ordinary raster row here and needs no second component (§5.13).

**Always-on, fixed-position overlays** (outside the fragment so reordering doesn't affect them):
- `MapDoorOverlay` (top of structural geometry)
- `MapMarkerOverlay` (DOM-based, always visually on top of canvas)
- `MapBinOverlay` (status tint above grids)
- `MapTextLabelOverlay` (always-visible labels)

**Live-data overlays** (preview mode + when enabled): `MapAssetOverlay`, `MapCameraOverlay`, `MapCvDetectionOverlay`, `MapRfidHeatmapOverlay`, `MapSensorOverlay`, `MapSensorTintOverlay`, `MapShipmentOverlay`, `MapRuleOverlay`.

### 3.1.6 Key hooks the editor uses

- `useSpatialStore`-backed: `useSpatialGrids/Markers/Circles/Polygons/Lines/Images/Models/TextLabels/Stairs/Bins/Zones/StyleRules/AttributeDefinitions` (in `src/hooks/useSpatialShapes.ts`).
- `useDoorStore(s => s.doors)` — separate Zustand store for doors (legacy localStorage + backend sync).
- `useSSE(tenantId)` — real-time invalidation; fires `loadEntity` for surgical updates.
- `useKeyboardShortcuts(handlers)` — global key listener with modifier state.
- `useHeaderControls.getState().setControls({onZoomIn, onZoomOut, onToggleFullscreen, isFullscreen})` — publishes zoom/fullscreen handlers up to the App header on mount; clears on unmount.
- `useCurrentTenantId()` — drives `useSpatialStore.setTenantId` and `loadAll`.
- `useLiveStreamScheduler()`, `useCorrelationEngine()` — only mounted when `preview=true`.
- `useModelUrlMap()`, `useModelBoundingCenterMap()`, `useModelInspectorMap()` — for the model overlay's per-model paint expressions and editor controls.

### 3.1.7 Selection / transform pattern

**Selection** is multi-kind: each kind has its own `Set<number>`. Clicking a shape:
- Plain click → clears all other kinds, sets this kind's selection to `{id}`
- Shift/Cmd/Ctrl click → toggles `id` in this kind's set (additive multi-select)

**Transforms** follow a draft→commit pattern:
1. Side panel button → set `transform = {kind: 'move'|'rotate'|'scale', <shapeId>}` (or per-kind variant).
2. Overlay renders a drag handle and listens to map events.
3. Each `mousemove` updates `<kind>TransformDraft` (state, not persisted) → overlay redraws live.
4. `mouseup` commits draft to db via `patchSpatialEntity()` or specialized helpers (`updateGridGeometry`).
5. Clears transform state.

Live preview state (`liveStart`, `liveCurrent` for grid draw; `*Draft` for transforms) is intentionally local — it doesn't go through spatial-store's optimistic queue because it's mouse-rate.

### 3.1.8 Side panel modes

The right `SidePanel` switches mode based on tool + selection. Modes include: `idle`, `live-draw`, `grid-selected`, `grid-bulk`, `marker-placement`, `marker-selected`, `marker-bulk`, …and equivalents for every kind. The editor passes `sidePanelActions` — a memoized callback bag for select/deselect, fit, delete, duplicate, rename, start/cancel transform, open data editor, zone assignment, and layer reordering.

### 3.1.9 Persistence

- **Shape mutations**: `patchSpatialEntity(kind, id, patch)` for one-liners; grid geometry has dedicated helpers (`updateGridConfig`, `updateGridGeometry`, `duplicateGrid`, `renameGridInDb`, `deleteBinsForGrid`).
- **Door mutations**: `useDoorStore` (separate store with its own localStorage cache + backend sync).
- **Bin updates**: `upsertBin()` → `db.bins` → SSE re-fires consumers → tint repaints.
- **Undo/redo**: `gridHistory` singleton — in-memory only, 50-entry cap, clears on reload. Tracks deletes and grid redraws.

### 3.1.10 Performance tactics

- **`scopeToWarehouse` cascade** runs once per render in a single pass (not per-shape).
- **Memoized views** (`savedGrids`, etc.) prevent recomputation when only unrelated state changes.
- **`resolvedStyles` (style-rule resolver) is memoized** on `(rules, bins, viewerIndex)` — never inline the calls.
- **Opacity bucketing** (see §3 Mapbox specifics) — 11 layers, each with a fixed opacity, instead of a per-feature data expression.
- **Layer-order fragment key**: changing it remounts everything — only mutate from explicit user action, not effects.
- **Selection sets are `Set`s, not arrays** — O(1) hit-test lookup.
- **Drafts are local state** — they don't queue through `spatial-store`'s 400ms debounce.

### 3.1.11 Editor support components (selected)

| Component | Role |
|---|---|
| `mapbox-map.tsx` (~284 lines) | Wraps Mapbox GL — init, style swap with camera preservation, lights/shadows config, scale control. Exposes `DEFAULT_MAP_STYLE`, `normalizeStyleId`, type `MapStyleId` (union from `map-styles.json` keys). |
| `map-toolbar.tsx` | Top toolbar — tool buttons, layer dropdown, import/export, style picker, place searcher. |
| `side-panel.tsx` | The big right sidebar (very large) — workspace tree, per-kind editors, transform controls, layer order, save buttons. |
| `lift-properties.tsx` | Escalator / elevator fields for the stair editor (direction, pair, floor links, incline + EN 115 badge, moving steps, served floors, car stop, shaft, status). Escalator step edges (`stepEdgeColor` / `stepEdgeWidth`, default yellow 1 px, 0 = none) are set from the stair Appearance section. `configForStairType` applies lift defaults and guesses floor links when the type switches; `withStoredLevels` keeps stored heights equal to the linked floors. |
| `marker-icon-picker.tsx` | Sidebar marker icon picker — quick-picks strip (10 curated) shown when the search box is empty, plus a virtualized (`@tanstack/react-virtual`) 6-column grid of every lucide icon (~1700). Search is `useDeferredValue`-decoupled from typing, filter runs over the shared `LUCIDE_ICONS` haystack. Icons render synchronously via `iconComponentForId` — no async loader flash. |
| `bin-editor.tsx` + `bin-popup-content.tsx` | Inline cell editor — status, SKU, custom properties, level ladder for multi-level racks. |
| `shape-data-editor.tsx` | Generic linked-data editor for non-grid shapes; uses `shape-link.ts` for cross-shape binding. |
| `shape-link-picker.tsx` | Picker for choosing a grid-cell or another shape to link to. |
| `bulk-assign-dialog.tsx` | Multi-select zone + floor-plan reassignment. |
| `model-editor.tsx`, `model-library-dialog.tsx` | 3D model property panel + model library (2026-10 redesign): tabs **This facility · Whole workspace · Built-in**, search, a grid of real thumbnails (`/models/thumbs/<id>.webp` for built-ins, `user_models.thumbnail` for uploads — rendered on first open for older uploads), and a live rotatable `<model-viewer>` preview with size / upload date / usage, rename, and "Remove from library" (ConfirmDialog with the placement count; deletes every duplicate row + the file). Identical uploads show once. Upload = drop/choose a .glb — no category step. Double-click / Enter places. `mode="swap"` when changing a placed model's asset. |
| `upload-library.tsx` | Shared upload-library pieces: `LibraryScopeTabs` (This facility / Whole workspace), `LibrarySearch`, `useScopedLibrary` (opens on the facility when it has items), `useUsageLabel` ("Used here +2" / "Used in Acme Hospital"), `ImageLibraryGrid`, `ImageLibraryPicker` (all loading / error / empty states), `UploadDropzone`, `LibrarySourceTabs` (From library / Upload new) and `ImageLibraryDialog` (modal pick-or-upload, used by **Replace image** and the image-plane tool). |
| `image-plane-tool.tsx`, `map-image-plane-overlay.tsx` | 3D image-plane tool. The tool opens `ImageLibraryDialog` on activation (reuse a workspace image — this facility first — or upload one), then attaches a one-shot map-click listener to place an `ImagePlaneShape` at the click point. The overlay synthesises a textured-plane GLB per shape (cached by `shapeId`), mounts it as a Mapbox `type: 'model'` source + layer, and forces a clean source remount whenever the GLB blob URL for a shape changes (works around a Mapbox quirk where an `addSource` with a not-yet-fetchable URI leaves the layer blank). |
| `schema-builder.tsx` | Define custom attribute fields per shape kind (SKU, qty, status, etc.). |
| `settings-dialog.tsx` | Warehouse-wide settings (default units, grid precision). |
| `command-palette.tsx` | `Cmd/Ctrl+K` search for shapes + actions. |
| `scroll-to-top.tsx` | `BrowserRouter` child that resets `window.scrollTo(0, 0)` on `pathname` change. See `docs/frontend.md` § Scroll & viewport hygiene. |
| `keyboard-status-bar.tsx`, `shortcuts-cheatsheet.tsx` | `KeyboardHint` (contextual hint rendered inside the editor `StatusBar`; strings under `kbHint.*`) + `?` modal. |
| `rail-tooltip.tsx` | `useRailTooltip()` — portal tooltip for the editor tool rail (label + shortcut key parsed from a trailing "(X)"; RTL-aware). |
| `place-searcher.tsx` | Mapbox geocoder for jumping to addresses. Optional `className` replaces its placement (the editor moves it beside the side panel, or onto a second row past the tool rail when the visible map is under 860 px). |

### 3.1.12 Door tool subdirectory

Doors are intentionally isolated from the rest of the editor:
- `src/components/door/map-door-overlay.tsx` — overlay. Subscribes to `useDoorStore`, NOT `spatial-store`. Draws every door as a built mesh on its own two `LiftMeshLayer`s (`door-tool-mesh-layer`, translucent `door-tool-glass-mesh-layer`); the fill-extrusion jambs / leaves / lintel (`door-tool-fill-layer`, opacity 0) are only click / selection targets, and their box outlines are hidden. Move / rotate / scale drags push a live mesh (`pushInflightMesh`).
- `src/lib/door/types.ts` — `DoorShape`, `DoorConfig`.
- `src/lib/door/store.ts` — Zustand + localStorage + backend sync; handles the one-shot localStorage→backend migration.
- `src/lib/door/generators.ts` — door geometry helpers (width, nudge, rotate, resize) and the click-target features (jambs, leaves, lintel, swing arcs, labels). `makeFrame` / `buildLeaves` are shared with the mesh so leaf positions always match.
- `src/lib/door/mesh.ts` — `buildDoorMesh(vertices, config)`: frame (jambs, head, architrave on both faces, threshold); hinged leaves with raised moulded panels on both faces, lever handles on roses at lock height, hinge knuckles; sliding leaf with pull bars + top track; revolving centre post, four glass wings in metal frames, curved glass drum walls, canopy, floor plate. Positions are metres from `vertices[0]` (no rotation field — doors rotate through their vertices).

Doors were prototyped before spatial-store existed; `useDoorStore` still owns their render state, but since 2026-10 its server writes go through the spatial store's save pipeline (`updateLocal('doors', …)` / `deleteLocal`) — one coalesced PATCH per settled edit instead of one per slider frame — and door rows changed elsewhere (SSE → spatial store) flow back into it unless the door has unsaved local edits.

### 3.1.13 Live draw preview convention

Every creation tool renders a preview while the user is drawing — chain dots + cursor edge for click-based tools, plus a **filled body preview that matches the actual paint** so the user sees what they'll get before committing.

| Tool | Preview mechanism |
|---|---|
| Grid | MapboxDraw's anchor dot + `MapGridOverlay` reads `liveLine` and builds preview cells from current `config` |
| Circle | `livePreview` (CircleShape) → `buildCircleFeatureCollection(circles, livePreview, ...)` adds the filled preview alongside committed shapes |
| Polygon | Same pattern — `livePreview` constructed in overlay from `liveVertices + liveCursor + liveConfig`, fed to `buildPolygonFeatureCollection` once vertices ≥ 3 |
| Line | Chain layer (`buildLineChainFeature`) doubles as the preview — lines have no fill, so the dashed chain extending to cursor IS the line preview |
| Image | Dedicated `image-raster-preview-layer` driven by `livePreview` (ImageShape) — the in-flight raster shows during bbox drag |
| Model | Dedicated `model-shapes-preview-layer` driven by `liveCursor + liveModelId` — ghost model at cursor before commit |
| Stair | `livePreview` `{vertices, config}` constructed from `stairDraftAnchors + stairDraftCursor` → dedicated preview source |
| Door | Same as stair — `livePreview` with `doorDraftAnchors + doorDraftCursor` |
| Marker | DOM-based ghost marker via `liveCursor + liveIcon/Color/Size/Elevation/Height` props |
| Text label | Symbol-layer ghost rendered when `liveCursor && liveConfig` |

**Rule for new shape kinds:** if it has area (fill or extrusion), construct a `livePreview` shape and route it through the standard generator/overlay path so the paint stays identical to committed shapes. Don't build a separate "preview-only" layer with different paint unless you have a good reason (image and model are the exceptions because their preview content isn't the same as the committed feature — image preview is a raster, model preview is a ghost at cursor).

### 3.1.14 Multi-select bulk editing

The side panel switches to a `<kind>-bulk` mode whenever more than one shape of the same kind is selected. Bulk panels exist for every shape kind: grid, marker, circle, polygon, line, image, model, stair, door, text-label.

**Selection** is multi-kind by `Set<number>` per kind. The map uses Shift/Cmd/Ctrl+click to add to selection. Selection across DIFFERENT kinds is mutually exclusive — clicking a polygon clears any selected models.

**Bulk-edit panels** (`Bulk<Kind>ShapeContent` in `src/components/side-panel.tsx`) follow a consistent shape:
1. `BulkHeader` at the top — selected count + Fit + Delete (with confirm).
2. One or more `Section`s exposing the most-changed fields (color, border, opacity, elevation, height, kind-specific dims).
3. Each field uses one of the small primitives: `BulkColorRow`, `BulkSliderRow`, `BulkNumberRow`, `BulkToggleRow`. Each row shows a "Mixed" badge when the selected shapes don't agree on that field.

**The patch flow:**
1. User changes one field in the bulk panel.
2. The row's `onChange` fires `onPatchAll?.({ [field]: newValue })` — partial config patch.
3. The action handler in `create-grids/handlers/useBulkHandlers.ts` (`handleBulkPatch<Kind>`) iterates the selected ids, reads each shape's current config, merges the patch on top, and calls `patchSpatialEntity(<kind>, id, { config, updatedAt })`.
4. Other config fields stay at each shape's own value — no "I changed border color and lost everyone's opacity" foot-gun.

**Shared helper:** `sharedValue(items, picker)` in `src/lib/bulk-edit.ts` returns `{ value, isMixed }` for a single field across many items. Use it to seed bulk inputs with the unanimous value (or the first shape's value as a placeholder when mixed).

**Doors** use a slightly different path because they live in `useDoorStore`, not `spatial-store`. The bulk handler calls `updateDoorConfigInStore(id, newConfig)` instead of `patchSpatialEntity`.

**Per-kind editable fields** (current set — extend by adding more `Bulk*Row` invocations):

| Kind | Fields |
|---|---|
| Polygon, Circle | color, borderColor, borderWidth, opacity, elevation, height, showLabels |
| Line | color, width, borderColor, borderWidth, opacity, elevation, height, dash, showLabels |
| Marker | iconColor, iconSize, opacity, elevation, height (pole) |
| Image | opacity, elevation |
| Stair | color, borderColor, borderWidth, opacity, stepCount, riserHeight, treadDepth, width, baseElevation |
| Door | frameColor, leafColor, opacity, doorHeight, elevation |
| Model | color (tint), colorMix, opacity, emissive, elevation |
| Text label | color, size, opacity, haloColor, haloWidth, elevation |

### 3.1.15 Click priority across stacked overlays

Mapbox dispatches `map.on('click', layerId, ...)` handlers in **registration order**, not layer-stack order. Since overlays mount in render order (image → grid → polygon → line → … → model), area-fill overlays like polygon and circle register their click handlers BEFORE narrower shapes (line, model). Without coordination, the polygon's handler claims the click before the model gets a chance.

**Protocol:** every overlay calls `higherPriorityAt(map, e.point, '<kind>')` from `src/lib/overlay-hit-priority.ts` before claiming. The helper queries `queryRenderedFeatures` at the click point with a small hit buffer (4px), maps each hit's layer id back to an overlay kind, and returns true if any higher-priority kind has a feature there. The overlay bails (no `preventDefault`) — the higher-priority overlay's own canvas-level or layer-level handler then claims when it runs.

**Priority order** (high → low):
```
text > model > stair > door > line > polygon > circle > grid > image
```

Markers are DOM-based (`mapboxgl.Marker`), not Mapbox layers — they handle clicks via their own DOM path and aren't in this list.

**Adding a new shape kind:**
1. Add the kind to the `PRIORITY` array in `overlay-hit-priority.ts` at the right position.
2. Extend `kindOfLayer()` to map your overlay's layer ids back to the kind (preview/draft/selection-outline layers must return `null` so they don't block selection of the real shape).
3. Call `higherPriorityAt(map, e.point, '<kind>')` at the top of your overlay's click handler, right after the `defaultPrevented` check.

The image overlay has its own hand-rolled version of this (predates the shared helper) using `HIGHER_PRIORITY_LAYERS` + dynamic model-layer resolution. Both approaches coexist for now; new overlays should use the shared helper.

### 3.1.16 Common pitfalls

- **Adding a new shape kind?** You need ALL of: type in `shapes.ts`, generator in `src/lib/`, overlay component, spatial-store slice + actions, backend migration + queries + handler + route, hook in `useSpatialShapes.ts`, `scopeToWarehouse` wrapper for the saved view, tool entry in `keyboard-shortcuts.ts`, side-panel mode + editor block, and inclusion in `layerOrder` if reorderable. See §5.5 in ARCHITECTURE.md for the generator recipe and docs/backend.md for the backend recipe.
- **Don't bypass `loadedStyleId === mapStyle` gate** when adding an overlay — it'll crash during style swaps.
- **Don't mutate transform state during render** — transforms are mouse-rate; mutate via event handlers only.
- **Layer order changes are expensive** — they remount every overlay. Don't put `setLayerOrder` in an effect that fires from anything other than explicit user drag.
- **Doors are in `useDoorStore`, not `spatial-store`** — every other kind goes through spatial-store.

---

## 4. Frontend — i18n & config

- **`src/i18n.ts`** wires i18next; default language detected from browser, fallback `en`.
- 6 locales committed: `en`, `es`, `fr`, `de`, `ar`, `zh` (Arabic is RTL-aware).
- **`src/config/`** holds runtime config (e.g., default Mapbox style, feature flags).
- **`src/hooks/`** holds React-specific hooks (separate from `src/lib/` which is framework-agnostic where possible).

---

## 5. Frontend — Core library (`src/lib/`)

This is where most domain logic lives. Three layers:

### 5.1 State management (Zustand)

- **`auth-store.ts`** — current user session. Holds `{token, user: {id,email,verifiedAt?}, tenants: [{id,name,color,role,…}], ready}`. Persists `token/user/tenants` to localStorage via Zustand `persist` middleware (key `sgv-auth`). Exports `getAuthToken()` sync accessor consumed by `api-client.ts`. `ready` flag flips to `true` once the boot-time `/auth/me` probe finishes.
- **`spatial-store.ts`** — the central store and the editor's ONE save path (reworked 2026-10). Holds all entity kinds. **Optimistic local-first**: `updateLocal` writes a draft per kind (`drafts: Record<EntityKind, Map<id, Partial>>`, staged and applied once per animation frame), the UI reads row + draft; saves go out when the edit settles (400 ms) or at once on `commit`. **One request in flight per entity** — edits made meanwhile queue behind it and go as one follow-up (latest wins); different entities save in parallel (≤4). A draft stays until the server confirms that value (no snap-back). **Monotonic apply**: server rows (PATCH responses, SSE refetches, `loadKind` lists) only replace local ones when `updatedAt` isn't older; identical rows are no-ops. **Self-echo**: `isSelfEcho` skips the SSE refetch our own save causes. Failures: network/5xx keep the draft and retry with backoff (`sync.failed`, `retryFailed`); 4xx roll back. Creates render instantly under a temp negative id (`resolveSpatialId`). `loadedFor[kind]` = the warehouse scope a kind last loaded for (what loading states and the first camera fit wait on); identical in-flight loads share one request.
  - Key actions: `loadAll`, `loadKind`, `loadEntity`, `updateLocal`, `updateManyLocal`, `createLocal`, `deleteLocal`, `commit(kind?, id?)` (no args = flush all), `flush`, `retryFailed`, `dismissFailure`, `isSelfEcho`, `hasPending`, `applyServerEntity`, `removeServerEntity`. Helpers: `patchSpatialEntity` (settle-save), `saveSpatialEntity` (save now), `updateSpatialLatest(kind, id, fn)` (patch from the latest value — keyboard nudges), `getSpatialEntity`, `resetSpatialSession` (workspace switch, after `commit()`).
- **`tenant-store.ts`** — reactive tenant selection. Source of truth is backend `settings/current-tenant`; falls back to legacy Dexie, then creates a default. All API requests inject `X-Tenant-Id` header.
- **`door/store.ts`** — separate Zustand store for door tool (legacy localStorage migration path).
- **`graphics-settings.ts`** — four map display toggles surfaced in the SidePanel graphics section, persisted to localStorage (`sgv-graphics-settings`): `shadows` and `ambientOcclusion` default **off** (each removes a GPU pass), `markerOcclusion` defaults **on** (correctness, not cost — see §3 "Mapbox specifics"), `liftIcons` defaults **on** (escalator / elevator wayfinding icons + labels; `map-stair-overlay.tsx` hides `stair-lift-icon-layer` when off — editor and viewer, per browser). `floorBase` (`'solid'` default / `'ghost'` / `'off'`) styles the building base below. Adding a key needs no migration: `persist` shallow-merges stored state over the initial state, so existing users pick up the new default.

### 5.2 Data access / network

- **`api-client.ts`** — fetch wrapper. Handles `X-Api-Key` (header or `?apiKey` query), `Authorization: Bearer <jwt>` when `getAuthToken()` is non-null, `X-Tenant-Id`, response envelope `{data: T}`, error categorization (`auth|server|network|client`). Mutating requests with JSON bodies enqueue offline; GETs fail fast. Auto-replays queue on `online` event with max 3 retries. `ApiError` also carries the envelope's `code` and a 429's `Retry-After` (`retryAfter`, seconds). A 401 with code `session_revoked` (password changed elsewhere) clears the session on the spot and leaves a one-shot `sgv-auth-notice` in sessionStorage for `/login` to explain.
- **`loading-bar.ts`** (2026-10) — what the top progress bar (`components/feedback/top-loading-bar.tsx`, mounted in `App`) shows: `apiFetch` calls `trackRequest(method, path, opts.silent)` — reads (GET + query-style POSTs: `/run`, `/query`, `/search`, `/preview`, `/reports/_/…`) only within 2.5 s of a navigation (`markNavigation`, called by the bar on every pathname change), writes always; `/analytics`, `/settings/current-tenant`, `/health` never; `{ silent: true }` opts out (background work). `beginLoading()` / `useLoadingBar(active)` for component-owned waits. Raw `fetch` (SSE `/events`, auth bootstrap) is invisible to it by design.
- **`auth-client.ts`** — `requestSignupOtp / verifySignupOtp / completeSignup / login / logout / refreshSession` + `listMembers / inviteMember / updateMemberRole / removeMember`. The three signup steps and `login` use bare fetch (no `apiFetch`) because there's no session yet; the wrapper `unauthenticatedJson` throws `ApiError` with the HTTP `status` so callers can branch on 401/409/429 without brittle message-substring matching. Everything else flows through `apiFetch` so the Bearer header is auto-stamped. `completeSignup` + `login` + `logout` call `resetTenantStore()` so the next tenant pick uses the new user's memberships. Password reset: `requestPasswordReset / verifyPasswordReset / completePasswordReset` (same bare-fetch path). `refreshSession` only clears the session on an `auth`-kind failure — a network error or 5xx at boot keeps the persisted session instead of logging the user out.
- **`auth-errors.ts`** — `describeAuthError(err)` → `{key, retryAfter?, field?, code?}`: maps the server's `code` (see `code*` constants in `handlers/auth.go` — keep in sync) or, failing that, the HTTP status / error kind to an `auth.errors.*` i18n key. The SPA never shows the server's English. Also `looksLikeEmail` and `formatCountdown` (`m:ss`, no plural forms needed).
- **`profile-client.ts`** — `getProfile/updateProfile/uploadAvatar`. Updates write through `useAuthStore.setUser()` so the header avatar refreshes immediately without a separate re-fetch. Avatar upload uses bare `fetch` with a manually-stamped Bearer header because `apiFetch` only supports JSON bodies.
- **`api-db.ts`** — Dexie-shaped facade over REST so components can use `apiDb.grids.toArray()`-style code. Runs **first-read migrations** for image data URIs and inline model Blobs (upload → patch row → return with URL).
- **`useApiQuery.ts`** — SWR-style polling hook for legacy pages (dashboards, settings). Cache with prefix-based invalidation, slows polling to 60s when result is empty, respects `document.hidden`.
- **`useSSE.ts`** — EventSource client. Connects once per tenant (URL params, since EventSource can't set headers). Handles `ENTITY_CREATED|UPDATED|DELETED` for targeted invalidation. Auto-reconnects with 3s backoff. Only kinds in `VALID_KINDS` drive spatial-store reloads; every other kind fans out to `subscribeExternalSSE` listeners — `data-events` (Data screen), `data-sources` (Integrations, Files, and `MapDataLinkedOverlay`, which invalidates `layer-rows` so table-backed layers refresh on write instead of on the 30 s poll), **and `ai-jobs` (AI Map tool — see `useAIMapTool`)**.
- **`ai-client.ts`** — typed wrappers over the four `/floorplans` endpoints: `startDetection(imageId, region?)`, `getAIJob(jobId)`, `cancelAIJob(jobId)`, `submitAIJobFeedback(jobId, accepted, rejected)`. Consumes the `AIDetection`/`AIJob` types the review dialog + overlay + accept helper all share.
- **`ai-detection-generator.ts`** — `AIDetection[] → FeatureCollection<Polygon|LineString|Point, AIDetectionProps>` for the detection overlay. Rects auto-close to 4-vertex polygons; polygon rings get their closing point normalized. Per-kind color constants (`AI_KIND_COLORS`: aisle=blue, area=green, door=orange, stair=violet).
- **`ai-accept.ts`** — turns an `AIDetection` into a real spatial-store row via the existing `apiDb.<kind>.add` path. Kind→apiDb mapping matches the toolbar mental model: aisle→`lines`, area→`polygons`, door→`doors`, stair→`stairs` (the `layerLine` i18n label is `"Aisles / lines"` — aisles ARE lines here). Permissive geometry extractors handle any of rect/polygon/line/point per kind and return an `error` string when the shape isn't usable rather than throwing.
- **`image-generators.ts` additions**: `imageUVToLngLat(shape, u, v)` (forward, matches backend `ai.UVToLngLat`) + `imageLngLatToUV(shape, lng, lat)` (inverse, used by the AI Map tool's region-select drag). Both handle rotation + crop-percentages composition. Round-trip parity guaranteed by the backend's `TestUVLngLatRoundTrip` (5 frames × 7 UV samples < 1e-9 drift).
- **`mutation-queue.ts`** — legacy debounced queue (mostly superseded by spatial-store).
- **`offline-queue.ts`** — IndexedDB-backed mutation queue for offline mode.
- **`migrate-to-backend.ts`** — one-time backfill from local Dexie → Go backend (run once per browser via `migration-completed-at` marker).

### 5.3 Storage

- **`db.ts`** — Dexie schema (still used as type source-of-truth even after backend migration).
- **`binary-store.ts`** — upload images / 3D models to `/images/upload`, `/user-models/upload` (optional `zoneId` = the facility it was uploaded in). Resolves renderable URLs (URL > inline data URI). Handles legacy migration. Exports `rewriteFilesUrlSameOrigin(url)` — strips an absolute `http(s)://host[:port]` prefix off any URL containing `/files/` so the browser loads it same-origin (works around old rows whose `SGV_STORAGE.BASE_URL` baked in `http://localhost:8080`, which break when the SPA is opened from another LAN machine). Use it at every read site that renders or fetches an object-store URL: floor images (`urlForImage`), user models (`urlForModel`), profile avatars (`user-menu.tsx`, `profile.tsx`), image-plane texture fetch (`createImagePlaneGlb` in `image-plane-generators.ts`), and image-plane side-panel preview.

### 5.4 Shape models

- **`shapes.ts`** — TypeScript types for every shape: `PolygonShape`, `CircleShape`, `LineShape`, `MarkerShape`, `ImageShape`, `ModelShape`, `ImagePlaneShape`, `TextLabelShape`, `StairShape`. Common base: `{id, name, zoneId, floorPlanId, unit, visible, createdAt, updatedAt}`. `PolygonShape` and `CircleShape` also carry an optional top-level `role?: string` (key into the host warehouse's `roleVocabulary`). `ImagePlaneShape` carries `position: [number, number]` + `imageUrl` + `mimeType` + `naturalWidth`/`naturalHeight` plus an `ImagePlaneShapeConfig` (`width`, `height`, `rotation: [x, y, z]`, `elevation`, `opacity`, `color`, `colorMix`).
  `ImageShape` is also what a **CAD floor plan** becomes — an ordinary PNG row with nothing on it to say so. The provenance (`sourceKind: 'pdf' | 'dwg'`) lives on the placement *draft* only, so the side panel can name the source while the user is still positioning it; once committed, a drawing is a floor plan like any other. See §5.13.
- **`shape-link.ts`** — cross-shape data binding (e.g., text label borrows polygon's bin for rule evaluation).
- **`shape-nudge.ts`** — translate vertices in local frame (forward/lateral relative to first segment) for wall-aligned nudging.

### 5.5 Geometry generators (one file per shape kind)

All produce `Feature<Polygon|Point|LineString, Props>` ready for Mapbox sources:

- **`grid-generators.ts`** — square/triangle/hex grids, multi-level rack stacking, cell labels. Inputs: bbox + `GridConfig`. Outputs `GridCellProps`.
- **`circle-generators.ts`** — single circles + circle-grids (64-step polygon ring approximation).
- **`polygon-generators.ts`** — rotation around centroid. Degrades gracefully (0-2 vertices → LineString).
- **`line-generators.ts`** — polylines + wall extrusions (2D footprint + 3D height). Dash code 0/1/2.
- **`magic-wall-generator.ts`** — one-shot "generate walls around N selected polygons" algorithm. Non-destructive: existing walls are never mutated. Pair-wise polygon-edge overlap detection collapses shared edges into a single party wall; existing wall coverage is subtracted so no duplicate stacked walls; endpoint snapping groups near-coincident endpoints (including existing wall endpoints) into a common point for clean corners. All geometric reasoning happens in a local ENU frame (East-North-Up meters anchored at the selection centroid) so it can use Euclidean math instead of great-circle work. Exported: `generateMagicWallSegments(selectedPolygons, existingWalls, options?) → { from, to }[]`. Tolerances: `sharedEdgeToleranceMeters` (default 0.15 m), `endpointSnapMeters` (default 0.20 m), `minSegmentLengthMeters` (default 0.05 m). Consumed by the magic-wall tool in `create-grids/index.tsx` (activation via the `magic-wall` toolbar action / `W` shortcut); the tool commits each returned segment as a fresh `LineShape` row using a snapshot of the current `lineConfig`, then selects the new lines and swaps back to the select tool so the sidebar shows the bulk-line editor for immediate customisation.
- **`image-generators.ts`** — rotated bbox corners for Mapbox `image` source + GeoJSON hit-test polygon. Also owns non-destructive rectangular cropping: `ImageShapeConfig.crop = { top, right, bottom, left }` (percentages 0-95, sums per axis < 100). `imageCroppedCorners()` returns the shrunk rotated corners for the raster source; `getCroppedImageDataUrl()` canvas-crops the bytes off-screen with an LRU cache. The full-image `start`/`current` bbox is unchanged so map alignment doesn't drift when the crop is edited.
  There is deliberately **no CAD generator**: a drawing arrives as a PNG and `image-generators.ts` places it. `cad-generators.ts` and `cad-entities.ts` existed until 2026-08 and were removed with the rest of the vector path — see §5.13.
- **`model-generators.ts`** — model placement, scale/rotation/material/node overrides. Reads data-link `customProperties` for tint/emissive/opacity overrides.
- **`image-plane-generators.ts`** — synthesises a textured-plane GLB at runtime from the user's image so Mapbox's `model` layer can render it with elevation + per-axis (X/Y/Z) rotation. Hand-crafts the GLB binary (no `@gltf-transform/core` dep — see docs/pitfalls-frontend.md for why) with 4-byte-aligned JSON + BIN chunks. Plane lives in GLB XZ plane (Y = 0, normal +Y) so after Mapbox's Y-up → world Z-up remap it lies flat on the ground; `model-scale = [width, height, 1]` and `model-translation = [0, 0, elevation]` operate in world coords.
- **`stair-generators.ts`** — parametric straight/L/U staircases. One shared `stairLayout` (flights + landing) feeds both the per-step + landing extrusions — now invisible click/hover/occlusion targets (`hit: true`, drawn by `stair-lift-hit-layer` at opacity 0; borders and selection lines still use them) — and the built mesh (`stairMeshPlan` → `stair-mesh.ts`). `stairMeshes(shape, floorElevations)` is the one mesh entry point for every stair-tool shape (lifts → `liftMeshes`; stairs rotate about the same step-corner centroid as their extrusions). Also dispatches the stair tool's lift types (`stairType: 'escalator' | 'elevator'`) to `vertical-transport-generators.ts`; `StairBuildOptions` (`floorElevations`, `motion`, `phase`); `liftIconFeatures` for wayfinding icons. Lifts rotate about the drawn run's midpoint.
- **`vertical-transport-generators.ts`** — escalators (entry/exit landings, treads on a truss, side decks, glass balustrades, handrails; single or up+down pair; EN 115 incline check — 30° standard, 35° up to 6 m rise; `inclineFit` makes the length follow rise ÷ tan(angle)) and elevators built like a panoramic mall lift (steel corner posts + front mullions, slab-edge bands at every upper floor, thin glass or solid panes, roof cap with overhang; per stop a door portal — jambs + header standing proud — two steel leaves with a centre split, a sill plate and a call-button panel; a cabin at `carStop` with floor/ceiling slabs, corner posts, glass or solid walls, car doors, a handrail and roof equipment). Every part carries a `part` tag (`door`, `portal`, `sill`, `call`, `band`, `cabin`, `car-door`, `car` = cabin floor, …). `resolveLiftLevels` takes heights from linked floor plans (`fromFloorPlanId`/`toFloorPlanId`, `servedFloorPlanIds`) when their elevations are known, else the stored `baseElevation`/`rise`/`stops`. Parts flagged `glass` go to the overlay's translucent layer and are ignored by marker occlusion.
- **`stair-mesh.ts`** — `buildStairMesh(plan, config)`: built straight/L/U stairs. Each flight is one closed solid (tread slabs with a nosing overhang, risers, stringer faces, a sloped soffit parallel to the pitch line resting on the floor or the landing underside); landings are thick slabs with a tread-colour cap and columns where no flight carries them; railings along every open flight side and landing edge (round handrail 0.9 m above the nosing line, levelling off over a top tread that arrives at a floor; posts + balusters, or glass panes) per `config.railing` (`'metal'` default, `'glass'`, `'none'`) and `config.railingColor`. Colours: `color` = treads, `riserColor` = risers / sides / soffit / columns.
- **Floor-plan "Hide outside walls"** — `ImageShapeConfig.clipToWalls` / `clipMargin` (m, default 0.5): `map-image-overlay.tsx::wallMaskUV` takes the outer outline of the walls on that floor (`floor-base.ts::wallOutline`; falls back to walls with no floor), grows it by the margin and converts it to full-image UV; `FloorPlanLayer` rasterises it into a mask texture (unit 1) and discards fragments outside. Non-destructive, recomputed when walls change; side panel → image → "Outside the building". Wall lines reach the overlay via `wallLines` (editor: `OverlayStack.imageWallLines`, viewer: `allLines`).
- **`floor-base.ts`** — `buildFloorBase(input)`: building base under the lowest visible floor when it is raised (> 0.5 m) and the floors below are hidden. Footprint: that floor's slab areas (`role: 'floor-area'` with a height) → else its walls (buffered, merged, closed by 1.5 m, lift / stair footprints cut out) → else the floor image rectangle. Top = slab bottom, or floor elevation − 0.3 m (closer covers the image at grazing angles). Colour = the floor's exterior (thickest) wall colour, shaded like walls (no vertical gradient — it turned an 8 m block black at the bottom); bands and ghost lines are darker shades of it. Also returns bands at each lower storey, footprint outlines and the hidden floors' walls for the ghost style. Display-only; drawn by `src/components/map-floor-base-overlay.tsx` (mounted in the editor next to `OverlayStack` with floor visibility = image `visible`, and in the viewer with the floor picker's selection). Its layers are in no hit-test list.
- **`lift-mesh-layer.ts`** — `LiftMeshLayer`, a custom layer (`renderingMode: '3d'`) drawing triangle meshes in metres with per-fragment, view-dependent shading (key light, soft fill and a sky/ground gradient + sheen on solids; Fresnel, specular and reflection streaks on glass, using the camera in mesh metres): the sloped escalator parts (truss, cladding/decks, glass balustrades, handrails looping round the newels) that fill-extrusion can only draw as stepped boxes. One opaque instance + one `translucent` glass instance per stair overlay; `liftMeshes(shape, floorElevations)` in stair-generators builds the data (swept along `escalatorProfile`: flat → fillet → incline → fillet → flat). Escalator treads and landing plates stay extrusions.
- **`lift-icons.ts`** — canvas-painted escalator-up/down and elevator wayfinding icons (+ out-of-service variants) in the palette's primary colours, registered as map images.
- **`text-label-generators.ts`** — point features for symbol layers with halo/emissive/font weight.
- **`map-transform-handles.ts`** — shared move / rotate / scale handle rendering for editor overlays. Canvas-paints three distinct icons (cross-arrow for move, curved arrow for rotate, diagonal double-arrow for scale) tinted with the current theme's `--primary` colour and registers them via `map.addImage`. Exports `readThemePrimaryHex()` / `readThemePrimaryForegroundHex()` / `readThemeForegroundHex()` (parse the HSL CSS var into hex) and `subscribeThemeChanges(cb)` (MutationObserver on `<html>` classlist) so palette + light/dark toggles regenerate icons live. Overlays adopt via a `type: 'symbol'` layer with `icon-image: ['coalesce', ['get', 'iconId'], TRANSFORM_ICON.move]`, `symbol-z-elevate: true` (always visible above 3D content), and `symbol-z-offset: ['coalesce', ['get', 'elevation'], 0]` (positions handle at the shape's altitude — fixes the "handle drifts to ground when shape is elevated" + "handle occluded by same-elevation extrusion" bugs that plagued the old hardcoded-orange `type: 'circle'` handles). Image overlay adopted first; polygon / circle / line / text-label / door overlays can migrate the same way.

### 5.6 3D model handling

- **`model-catalog.ts`** — `BUNDLED_MODELS` list pointing to `/public/models/<slug>/scene.glb`.
- **`model-assets.ts`** — React hooks combining bundled + uploaded models. `useModelAssets`, `useModelUrlMap`, `useModelBoundingCenterMap`, `useModelInspectorMap`. Lazy inspector fetch + module-level cache. `addUploadedModel(file, {zoneId})` renders a thumbnail after the upload; `ensureModelThumbnail`, `deleteLibraryModel(ids, withPlacements)`, `renameLibraryModel(ids, name)` act on every catalog row sharing one file.
- **`upload-library.ts`** — the editor's upload library client: `useImageLibrary` / `useModelLibrary` (`GET /library/images|models`, cache key `uploadLibrary`, `invalidateUploadLibrary()` after uploads / placements / deletes), `inFacility` / `usedInZones` scoping helpers, `measureImage`, and `renderModelThumbnail(url)` — renders a GLB to a 256 px WebP data URL with an off-screen `<model-viewer>`, one at a time, retrying empty captures.
- **`glb-bounds.ts`** — parses GLB binary to extract bounds, materials, nodes, animations. Powers scale compensation + dynamic editor controls.

### 5.7 Data-link subsystem (`src/lib/data-link/`)

External data ingestion, correlation, streaming:

- `contracts.ts`, `types.ts`, `attribute-defs.ts` — type definitions.
- `importer.ts` — CSV/XLSX/JSON/GeoJSON upload orchestration.
- `entity-state-service.ts` — generic entity_states client. `listEntityStatesForStream`, `listEntityEventsForStream`, `listAllEntityStatesForTenant`. Slice 6c2 of the data-link refactor collapsed the per-entity service files (asset/sensor/camera/rfid/shipment) into this one.
- `live-stream-client.ts`, `live-stream-health.ts` — WebSocket ingestion. Slice 6c2 routes every stream through the generic `POST /streams/:id/ingest` endpoint regardless of entity type; per-entity dispatch is gone.
- `webhook-fetcher.ts`, `rest-fetcher.ts` — pull-based polling/draining.
- `correlation-engine.ts` — cross-stream event matching. Slice 6c2 STUB — the pre-refactor engine read from per-entity event tables that were deleted. Rules stay stored; the engine's effect body is a no-op until the follow-up ports it to `entity_events`.
- `replay-service.ts`, `replay-controller.ts` — historical playback for **stream** sources (Cloudflare Worker `/events`).
- **Table history (v5.4)** — separate pipeline from streams:
  - `table-events-client.ts` — `listTableEvents(sourceId, {windowSec, limit})` → `GET /tables/{id}/events`; `listRowEvents(sourceId, entityKey, {limit})` → `GET /tables/{id}/events/{key}`. Backend writes to `data_source_row_events` on every insert/update/delete via `recordRowEvent` (both `table_rows_authed.go` and `table_rows_public.go`); no per-tenant retention job is wired yet.
  - Per-row trail in the drawer: `src/components/view/table-history-panel.tsx` renders the events as a collapsible timeline with computed before→after field diffs; mounted via `ShapeDetailDrawer` when `historySourceId` + `historyEntityKey` are set.
  - Heatmap density from history: `DataLinkStyle.heatmapSource: 'live' | 'history'` (+ `heatmapWindowSec`); when `'history'` the heatmap sub-renderer sources from `listTableEvents` via `eventsToEntities`, so a row that changed 200 times contributes 200× the weight.
  - Playback: `table-playback-store.ts` (module-level pub/sub, single active source, RAF-driven playhead). Sub-renderers call `useEffectiveEntities(config, liveEntities)`, which swaps to `visibleEntities(sourceId)` at `currentMs` when the store's `activeSourceId` matches; delete ops disappear, updates walk their trail. Deliberately separate from the stream `replay-controller` — different data source, different pause semantics.
  - `renderMode: 'history-movement'` — first-class render mode alongside heatmap/track/etc., only enabled for table sources. Routed to `PointAtCoordSubRenderer` in the overlay's dispatch switch, so it inherits every point-at-coord capability (label/icon/cluster/elevation/tooltip). Requires no per-layer wiring — the `table-history-player.tsx` bottom-of-map bar auto-fetches events for the first visible `history-movement` layer, populates the playback store, and every sub-renderer instance whose `sourceId` matches then scrubs in lockstep.
  - `table-history-player.tsx` — glassy, video-player-style bar at the bottom of the map. Mounted outside the top-right control stack so it can span the map width. Auto-shows when ≥ 1 visible layer uses `history-movement`; auto-hides + calls `tablePlayback.stop()` when the last one goes. Layer picker + window select on the top row, play/pause/rewind + scrubber + speed + stop on the middle row, start / current / end timestamps + percent complete on the bottom row.
- `target-resolver.ts` — bin row resolution.
- `query-client.ts` — server-side filtering. `fetchDataSourceSchema(sourceId)` (detected fields + inferred types + distinct samples + numeric bounds), `queryDataSource(sourceId, {filter, limit, includeCount})` (POSTs a filter tree, translated to parameterised JSONB WHERE clauses), `normaliseFilter` (legacy flat shape → tree), `isFilterActive`.
- **Saved report filters (v5)** — filter *authoring* lives only in the data-link editor, never in the viewer. `fieldMapping.filters` holds `DataLinkFilterPreset[]` (`{id, label, description?, filter, isDefault?}`); opaque JSONB, so no migration and no backend work — same precedent `floorScope` set. Editor UI: `src/components/data-link/filter-presets-section.tsx` (preset list + match counts + default star) wrapping `filter-tree-builder.tsx` (the AND/OR tree editor, type-aware op catalog, `describeFilter` summariser). Viewer UI: `src/components/view/viewer-filter-bar.tsx` — one chip row per layer ("All records" + a chip per preset) plus the active rule as read-only prose. Share links persist the chosen **preset id** (`ShareLinkSettings.dataLinkFilterPresets`), never a filter tree, so editing a preset updates every link that references it. **v5.1**: a preset condition saved with a blank value slot becomes a *runtime prompt* — `allLeavesAuthorable` gates save (field + op only), `collectPromptLeaves`/`resolvePromptValues`/`stripPromptLeaves` (all in `filter-tree-builder.tsx`) drive the viewer flow, and `view.tsx` holds typed values in `presetPromptValues[configId][presetId]` (per-session, not shared). **v5.2**: `ViewerFilterBar` is a trigger button + `Dialog` (report layout) — dropdown per layer, per-layer clear icon, footer with Clear all / Cancel / Apply; the dialog owns a draft and commits via `onApply(ids, promptValues)` so the overlay re-queries at most once per gesture. **v5.3 — richer elevation spec.** `fieldMapping.elevation: ElevationSpec` (discriminated union `field | static | rules`) supersedes the legacy `elevationField: string`. `static` hard-codes one z for the whole layer (e.g. F2 → 12m); `rules` is first-match-wins with simple per-payload string ops (`equals` / `contains` / `startsWith` / `endsWith`) → number, plus an optional fallback. Editor UI: `src/components/data-link/elevation-input.tsx` (mode selector + rule editor). Resolver: `resolveFromElevationSpec` in `map-data-linked-overlay.tsx`, with the legacy `elevationField` honoured as fallback so old configs keep rendering. On save the editor always emits the new spec and drops the legacy key, so pre-v5.3 configs migrate on first open.
- **Floor map + shape anchoring (2026-10)** — `fetchLayerRows` skips the server floor gate when `floorScope.field` is set (the server can't apply a `valueMap`; it compared `"Level 1"` to `68` and dropped every row). `shapeOnEntityFloor` (`filter-evaluator.ts`) keeps a name/code join on the payload's floor, so repeated room names across floors don't cross-tint. Shape-tint sits on `slabTopM()` — the slab top as the polygon/circle overlays actually draw it (base ≥ 0.11 m, thickness ≥ 0.05 m). roi-pulse shows `fieldMapping.labelField` on the disc when an anchor has exactly one row (e.g. an RFID reader's reads/hour) instead of a constant "1". See `docs/pitfalls-frontend.md` → *A floor `valueMap` must stay client-side*.
- `outbound-service.ts` — bidirectional sync.
- `tenant-service.ts`, `source-service.ts` — CRUD facades.
- `sample-records.ts` — sample-data catalogue used by the "Download sample" menu on the Integrations page + Import dialog. `SAMPLE_SPECS[kind]` has a `SampleSpec` for every `DataSourceEntityKind` (polygon / circle / marker / asset / camera / sensor / shipment / rfid-tag / rack-cell / streaming). Each spec carries `fields` (name/type/required/description, including custom-property columns via the `custom.*` convention), 5 realistic records demonstrating create + upsert-by-external_code + minimum-required + custom-property, and `formats` (CSV/XLSX/JSON/GeoJSON as applicable — streaming skips GeoJSON, rack-cell skips it too). Coords cluster around Schiphol (52.31°N, 4.76°E) so imports land as a legible cluster.
- `sample-generators.ts` — format converters. `generateSample(kind, format)` returns `{ blob, filename, mime }`; `downloadSample(kind, format)` triggers the browser download via an in-memory object URL. CSV uses `papaparse.unparse`, XLSX bundles a companion `schema` sheet with the field docs, JSON is a `{ $schema, records }` envelope (both keys are auto-detected by the JSON parser's root-path heuristic), GeoJSON emits a FeatureCollection with per-record Point/Polygon geometry.

### 5.8 Style rules (`src/lib/style-rules/`)

Declarative data-driven styling:

- `types.ts` — `StyleRule`, `RuleOp`, `RuleQuantifier`, `AggregateFn`.
- `evaluator.ts` — match a bin against a rule (with quantifiers + aggregates).
- `resolver.ts` — bulk evaluation → visual overrides.

### 5.9 Analytics (`src/lib/analytics/`)

- `abc.ts` — ABC/Pareto inventory analysis.
- `dead-stock.ts` — slow-mover detection.
- `metrics.ts` — occupancy/utilization/cycle-time.

### 5.10 Door tool (`src/lib/door/`)

Self-contained: `types.ts`, `store.ts`, `generators.ts`. Parametric doors (single/double/sliding/revolving) with frame, leaf, swing arc, labels.

### 5.11 Schema & utilities

- **`attribute-types.ts`** — ~80 semantic types (SKU, RFID, temperature, currency, address, etc.) with widget hints.
- **`schema-defaults.ts`** — apply attribute defaults to new bins.
- **`role-vocabulary.ts`** — per-warehouse shape roles (office, storage, dock, etc.), with DEFAULT fallback.
- **`value-classifier.ts`** — ~150 value kinds for tooltip rendering (badges, units, icons).
- **`rich-data.ts`** — display hints for nested data.
- **`units.ts`** — length conversions (m/ft/yd/km/mi); locale-aware default unit.
- **`export.ts`** — multi-format export (GeoJSON, CSV).
- **`keyboard-shortcuts.ts`** — central keybindings (`g`/`r`/`3` → create-grid, etc.).
- **`marker-icons.tsx`** — marker icon helpers: `MARKER_QUICK_PICKS` (10 curated warehouse/logistics presets), `resolveIconName()` (translates legacy Maki-style ids like `marker`/`industry`/`cargo` to lucide kebab names), and `<MarkerIconGlyph>` (synchronous renderer that resolves any lucide icon id via `lucide-icons.ts`, falling back to `MapPin`). Any lucide icon id (e.g. `map-pin`, `alarm-clock`) is a valid `MarkerShapeConfig.icon` value.
- **`lucide-icons.ts`** — single-source-of-truth manifest of every lucide-react icon (~1700 entries). Runs once at module load, exports `LUCIDE_ICONS`, `iconComponentForId(id)`, `allLucideIconIds()`. Consumed by both `src/components/data-link/lucide-icon-picker.tsx` and `src/components/marker-icon-picker.tsx` so the id → component mapping is identical everywhere. Each entry carries `nameLower` (precomputed for cheap search) and `tags` (semantic keywords like `marker`, `device`, `sport` — sourced from `lucide-tags.json`, vendored from `lucide-static`). The `hay` field concatenates id + name + tags (newline-separated) for consumers that want simple substring matching.
- **`lucide-tags.json`** — vendored copy of `lucide-static`'s tags data (~237 KB, ~50 KB gzipped in the bundle). Maps each icon id to its curated tag list. Refresh occasionally: `curl -s https://cdn.jsdelivr.net/npm/lucide-static@latest/tags.json -o src/lib/lucide-tags.json`. Fine to lag behind lucide-react's version — the manifest silently uses an empty tag array for unknown ids.
- **`floor-plan-layer.ts`** — `FloorPlanLayer`, the Mapbox custom layer (`renderingMode: '3d'`, slot `top`) that draws each floor-plan image (`ImageShape`) as a textured quad at its exact elevation; used by `map-image-overlay.tsx` for committed plans and the drag-to-place preview. Replaced the `image` source + `raster-elevation` path, which vanished when zoomed in without tilt and hid shapes standing on the plan (see docs/pitfalls-frontend.md). Crop = texture coordinates; depth written only for raised opaque floors; float64 matrix composition (exact to zoom 32). `styleHasSlot(map, slot)` helper.
- **`translucent-layer-order.ts`** — `installTranslucentLayerOrder(map)` (installed in `mapbox-map.tsx` next to the empty-layer gate) keeps every translucent fill-extrusion (constant `fill-extrusion-opacity` < 1 — opacity buckets, selection tints) after every opaque 3D layer, most opaque first, and translucent custom layers (lift glass, no depth write) after all of them. Decides in root order (`style._order`, which `moveLayer` edits), not the merged draw order (`style.order`, re-sorted by Mapbox for occlusion-opacity symbols). Versioned (`ORDER_VERSION`) so a hot-reloaded copy replaces a stale installation. Needed because Mapbox's translucent extrusion pre-pass writes depth, so an opaque shape drawn later behind it vanished (see docs/pitfalls-frontend.md). `orderTranslucentLayers(map)` is the pure pass.
- **`marker-occlusion.ts`** — depth occlusion for HTML markers (see §3 "Mapbox specifics"). `buildOccluders({images, polygons, circles, lines, stairs})` reduces every extruded shape to an `OccluderPrism` — a Mercator footprint ring plus the altitude band `elevation → elevation + height`, with a bbox for broad-phase rejection. Footprints always come from the kind's own generator (`buildPolygonFeature`, `buildCircleFeatures`, `buildLineWallFeature`, `buildStairFeatures`, `imageCroppedCorners`) so rotation, wall thickness and image crops match what is actually painted; a floor-plan raster or a `height: 0` polygon is just the degenerate prism where base = top. Rows that paint nothing are dropped: hidden, missing bytes, or under `OCCLUDER_MIN_OPACITY = 50` (ghosting an upper floor to 30% to peek through must not hide what is below). Stairs contribute one prism per tread/landing, each with its own `base_height`/`height`, so a staircase occludes as the stepped solid it is. `computeOccludedMarkerIds(map, markers, prisms)` casts a ray from `map.getFreeCameraOptions().position` to each marker's `MercatorCoordinate`, clips it to each prism's altitude slab, and tests whether the surviving span crosses the footprint — one test covering both "under a slab" and "behind a wall". The `t ∈ (0,1)` window is what makes geometry *below* a marker fall out for free. Three exemptions: the `images` row matching the marker's own `floorPlanId`, any prism whose top is within `SELF_SURFACE_TOLERANCE_M = 0.5` of the marker's altitude (it is standing on that surface — thin slabs sit a few centimetres proud of their floor), and any prism the marker is embedded inside (an authoring artifact; hiding it would blink as the camera orbits). Not covered: 3D models, image planes and grids/bins — GLB bounding boxes would over-occlude badly. Pure geometry — no React, no map mutation.
- **`empty-layer-gate.ts`** — perf: hides every overlay layer whose GeoJSON source holds zero features, and un-hides it the instant the source gains one. `installEmptyLayerGate(map)` is called once from `mapbox-map.tsx` right after construction (next to `installMapMountDiagnostics`) and returns a disposer. Rationale: GL JS `Style.update()` skips per-frame `layer.recalculate()` **only** for `visibility: 'none'`, so an empty layer pays a full style re-evaluation every frame to draw nothing. On the retail-mall ground floor that is 81 of 205 overlay layers in the viewer and 102 of 203 in the editor — measured at **23.4%** and **33.5%** of median frame time (31→41 fps and 63→95 fps, paired t = 9.3 / 69.2). It works by wrapping `addSource` / `addLayer` / `removeSource` / `removeLayer` / `setLayoutProperty` on the Map, plus each GeoJSON source's own `setData`, so it needs no changes in the 137 `setData` and 148 `addLayer` call sites. Two invariants keep it behaviour-neutral: **app intent wins** (a user-driven hide recorded via `setLayoutProperty` is never un-hidden by incoming data — this is what protects the per-kind layer toggles and the grid toggle), and **unknown means visible** (URL-backed GeoJSON, non-GeoJSON sources and untracked layers are left alone, so every failure mode costs performance, never UX). Restoration is synchronous inside `setData` — earlier than the worker parse that makes the data renderable — so live-draw / selection / transform / in-flight layers can never flicker. Verified: with all gated layers forced visible, every one renders zero features and the whole-viewport `queryRenderedFeatures` count is unchanged (3266 viewer / 1507 editor, delta 0).
- **`mapbox-runtime-tuning.ts`** — perf: two GL JS knobs the `Map` constructor doesn't expose. `tuneMapboxRuntime()` is called once from `mapbox-map.tsx` immediately before `new mapboxgl.Map(...)` — it must be, since the GL context is created inside the constructor and the worker pool is sized on first acquire — and is idempotent via a `globalThis` flag. (1) **Discrete-GPU hint**: GL JS builds its WebGL2 context attributes from a fixed set with no `powerPreference` (the string appears nowhere in the shipped bundle), so on a hybrid-graphics machine the browser returns the default adapter — on Windows laptops normally the *integrated* GPU. We patch `HTMLCanvasElement.prototype.getContext` to inject `powerPreference: 'high-performance'` for `webgl`/`webgl2` when the caller didn't set one. The patch stays installed because GL JS re-runs `_setupPainter` after a context-loss/restore. It is advisory — a driver that ignores it leaves us on the adapter we'd have had anyway. (2) **Wider worker pool**: `WorkerPool.workerCount` is hardcoded to `2` and never derived from `navigator.hardwareConcurrency`, while every `GeoJSONSource` pins itself to one actor round-robin in its constructor — so all ~100+ of our sources parse and tessellate on two threads regardless of core count. We set it to `clamp(floor(cores * 0.75), 2, 8)`, floored at the stock 2 so a low-core machine is never made worse, capped at 8 because each worker is a thread with its own heap. Both tweaks are render-invisible: verified identical layer and rendered-feature counts before and after (205/3266 viewer, 203/1507 editor) with 0 console errors.
- **`../components/map-perf-monitor.tsx`** — internal performance HUD, rendered by `mapbox-map.tsx` once the Map exists. **On by default in dev, off by default in a production build.** Resolution order is `?perf=1` / `?perf=0` (one load) → the `sgv-perf-hud` localStorage value → the build default; **Ctrl+Alt+P** toggles it and writes the preference, so it sticks across reloads without a query string — including on a production build, which is the case that matters since the slow machines run one. Returns `null` when closed and otherwise portals to `document.body`, so it contributes no DOM to the map container either way. Deliberately **not** part of the product surface: English-only, no i18n keys, but it does work in a production build — the machines we need numbers from aren't running a dev server. Shows fps + p50/p95 frame interval, layer/hidden/source counts, an on-demand whole-viewport `queryRenderedFeatures` count, GPU renderer string, dpr, drawing-buffer size, `mapboxgl.workerCount`, JS heap, and toggles for `showOverdrawInspector` / `showTileBoundaries` / `showLayers3DWireframe`. Three measurement decisions matter: frame timing is sampled from the map's own **`render` event**, not rAF (rAF keeps ticking at vsync while the map is idle and would report a confident but fictional 60fps); intervals longer than 600ms are discarded as idle gaps rather than counted as slow frames; and scene stats poll at 2s while frame stats poll at 500ms, because `getStyle()` serializes every layer and at 500ms would show up in the numbers it is reporting. **GPU timing is a separate opt-in toggle, off by default** — GL JS only issues timer queries when something is subscribed (`gpuTiming: !!this.listens(...)`), so an always-on panel would tax the thing it measures. The `gpu-timing-frame` payload carries both `cpuTime` and `gpuTime` over the same `_render` span, which is what the CPU/GPU-bound verdict compares; the frame *interval* is not used for that, since it also contains compositing, unrelated JS and vsync waiting. We deliberately do not subscribe to `gpu-timing-layer` — see `docs/pitfalls-frontend.md`, it is broken upstream in GL JS 3.25.
- **`grid-history.ts`** — in-memory undo/redo stack, 50 entries. `subscribe` / `getVersion` + `useHistoryAvailability()` drive the status-bar undo/redo buttons.
- **`copy-name.ts`** — `copyName(kind, name)`: duplicate names become "X (copy)", "X (copy 2)"… (strips existing copy suffixes, picks the next free number among loaded rows; suffix is i18n `editor.copySuffix`). Every duplicate path uses it.
- **`hooks/useStableCallback.ts`** — identity-stable callback that always calls the latest closure; used for props of memoised editor chrome (`MapToolbar`).
- **`grid-draw-mode.ts`** — Mapbox GL Draw custom mode (two-click rect, no preview).
- **`header-controls.ts`**, **`i18n-helpers.ts`** — minor helpers.

### 5.12 PDF floor-plan import (`src/lib/pdf-import.ts` + `src/components/pdf-page-picker.tsx`)

Architects hand over drawing sets as PDFs, not PNGs. The import path treats a PDF as a **physical sheet** rather than a picture, which is what makes true-size placement possible.

**Why the arithmetic is exact.** A PDF point is defined as 1/72 inch, so page dimensions are dimensionally honest — not a pixel count that has to be guessed at. Combined with a plot scale from the title block:

```
real-world metres = sheet millimetres / 1000 × plot-scale denominator
```

An ARCH D sheet (914 × 610 mm) at 1:100 covers exactly 91.44 × 61.0 m. That converts "drag until it looks about right" into a placement that is correct to within floating-point error (verified end-to-end at 0.0004% width / 0.0000% height).

**What a PDF can't tell you.** There is no CRS, no origin and no north arrow in a drawing PDF. **Only scale is recoverable — position and rotation stay a manual drag on the map.** Don't add a "geo-reference automatically" path; the information isn't in the file.

**Module API** (`pdf-import.ts`, thin client over the backend endpoints):

| Export | Purpose |
|---|---|
| `isPdfFile(file)` | Type + extension sniff; gates the detour in `useImageHandlers` |
| `inspectPdf(file, password?)` | → `PdfInspectResult` — page inventory, thumbnails, ranked scale hints |
| `renderPdfPage(file, page, dpi?, password?)` | → `PdfRenderResult` — the chosen page as a stored PNG |
| `realWorldSize(page, denominator)` | The metres-on-the-ground formula above |
| `scaleForRealWorldWidth(page, widthMeters)` | Its inverse — backs the "I know this building is 45 m wide" calibration path for drawings with a missing or wrong title block |
| `describeSheet(page)` | `ARCH D · 914 × 610 mm` |

**The flow**, end to end:

1. User activates the image tool (`i`) and picks a file. `handlePickImageFile` in `create-grids/handlers/useImageHandlers.ts` sniffs it: a raster uploads as before, a **PDF is parked in `pendingPdfFile`** instead of becoming a draft — which sheet, and at what scale, are questions only the user can answer.
2. `pendingPdfFile` mounts `<PdfPagePicker>`, which calls `inspectPdf` and shows thumbnails + ranked scale chips (or a plain page-number input above `thumbnailPageCap`).
3. On confirm the picker calls `renderPdfPage`, and hands back a `PdfPickResult` carrying the stored PNG **plus `realWidthMeters` / `realHeightMeters`** — taken from `realWorldSize`, not re-derived from the PNG's aspect ratio.
4. `handleConfirmPdfPage` turns that into a normal `ImageDraft` with the two extra size fields set. From here it is an ordinary image draft; the side panel shows a `91.4 × 61.0 m · to scale` badge.
5. The placement drag in `hooks/useImagePlacementTool.ts` sees `realWidthMeters`/`realHeightMeters` on the draft and **snaps the committed bbox to the true size** — the drag picks position only.

**The source PDF is never persisted.** Only the rendered PNG enters the object store, landing on an `images` row exactly like a direct upload — so the refcount / cleanup path in §6.7 needs no changes at all. The cost is that the render step re-uploads bytes the browser already holds; that is deliberate (see §6.4).

**Ordering trap in the snap** — `resizeImageBboxHeightMeters` **must run before** `resizeImageBboxWidthMeters`. `imageBboxSizeMeters` measures width along the south latitude, and metres-per-degree-of-longitude depends on latitude; a height resize moves the latitudes, so doing width first leaves it wrong by `cos(Δlat)` (measured: 2.59% off). Height first, then width, lands both exactly.

**Bidi note** — scale notation (`1/8" = 1'-0"`), dimension readouts (`91.4 × 61.0 m`) and sheet descriptors are **formulas, not prose**. Every one of them carries `dir="ltr"` in the picker; without it the bidi algorithm reorders them into nonsense under the Arabic RTL layout. Arabic also needs the full plural set for `pdfImport.pageCount` (`_zero/_one/_two/_few/_many/_other`) — `Intl.PluralRules` resolves count=3 to `few`, and supplying only `_one`/`_other` silently falls back to English.

**Extending to DXF/DWG** — the shape of this pipeline is the point. `inspect → user picks → render → place at true size` is format-agnostic; the DWG path in §5.13 reuses the detour, the draft and the placement snap verbatim and lands the same artifact, a PNG on an `images` row. All that differs is who draws the pixels (our own rasterizer, since there is no PDFium for DWG) and that a drawing can state its ground size instead of having it inferred from a sheet size.

---

### 5.13 CAD floor-plan import (`src/lib/cad-import.ts`, `cad-import-dialog.tsx`)

A DWG follows the PDF detour exactly — image tool → `isCadFile` sniff → a dialog that asks the questions only the user can answer → a normal `ImageDraft` → the same true-size placement snap. And it produces the same **artifact**: a PNG on an `images` row, indistinguishable downstream from a photo or a rendered PDF page.

**This is a 2026-08 reversal.** The first implementation kept the drawing as vector geometry all the way onto the map and recovered walls, rooms, columns, doors, stairs and racks from it as real editable rows. It worked; the user replaced it with the raster path so that **an AI tool can read the placed image and draw the entities**. `cad-entities.ts`, `cad-generators.ts`, `map-cad-overlay.tsx`, the payload cache, the `CAD_PAYLOAD_MIME` discriminator, the side panel's `CadDrawingSection` and the dialog's per-layer role/appearance surface are all gone. docs/cad-import.md carries the reasoning; §6.12 covers what the reader still does.

**A CAD floor plan is an ordinary `images` row.** No discriminator, no new mime type, no special case in any overlay: `handleConfirmCadDrawing` builds the same `ImageDraft` the PDF picker does, with `sourceKind: 'dwg'` used only for the side panel's provenance badge. **This needs no migration and no backend change beyond the two endpoints** — `uploadImage` is content-agnostic, and `images.image_url` is already covered by `CountFileURLReferences`, `ListReferencedFileURLs`, `ListImageURLsByZone` and `shapeDeleteWithFile`, so refcounting, the orphan sweeper and zone-delete reclaim work unchanged.

Reusing the row also means **the floor-plan role comes for free**: the toolbar's default-floor-plan pin, the `hiddenFloorPlanIds` cascade, the elevation sync into every draw tool, bulk assign, crop and the side panel's Floor plans list all key off `savedImages`. Multi-floor stacking, per-floor hide and default-floor pinning apply to a DWG on day one. A new shape kind would cost the ~15-list registration in docs/backend.md for no behavioural gain.

**The placement is better than a PDF's, and that is what reading the drawing buys.** A PDF's scale is *inferred* from a recognised sheet size and a plot ratio; a DWG is authored in real-world coordinates, so `renderCad` returns the ground size the pixels actually cover and `realWidthMeters` / `realHeightMeters` go straight into the draft. The user drags a box and it snaps to the true footprint — no scale question, no sheet-size table.

| Export (`cad-import.ts`) | Purpose |
|---|---|
| `isCadFile(file)` | Extension sniff; gates the detour in `useImageHandlers` (the server still picks the format by content, so this is only a routing hint) |
| `inspectCad(file)` | → `CadInspectResult` — release, units + ranked guesses, extents, layers, entity histogram |
| `renderCad(file, { layers, units })` | → `CadRenderResult` — the chosen layers drawn onto a stored PNG. First five fields mirror `POST /images/upload` |
| `defaultSelectedLayers(layers)` | Non-empty layers, minus the ones the server flagged as annotation, honouring the drawing's own visibility. Each filter falls back to the wider set rather than emptying the selection |
| `selectedEntityCount(layers, selected)` | The dialog's running total |
| `sizeUnderUnits(info, units)` / `CAD_UNIT_CHOICES` | Building size under a hypothetical unit — what makes a units choice obviously right or absurd. Five choices, not the full `$INSUNITS` table: a building is not authored in parsecs |
| `cadColorHex(color)` | ACI palette → hex. Index 7 / 256 / 0 return `null` **on purpose** so the map's theme picks the colour; a hard white is invisible on a light basemap and a hard black on a dark one |

**The dialog asks two questions and nothing else** (`cad-import-dialog.tsx`, ~466 lines): *which layers* and *what unit*. Both are things the file genuinely cannot settle on its own.

- **Layers open pre-ticked from `defaultSelectedLayers`.** Empty layers are dropped from the list entirely — a plan routinely declares thirty and uses four. Layers the server flagged `annotation` and layers the drawing itself froze come off the *selection* but stay listed and tickable. Each narrowing falls back to the wider set when it would leave nothing ticked, because a dialog that opens with an empty selection and a disabled button reads as a failure rather than as advice.
- **An all-layers selection is sent as no filter at all**, so the server takes its faster path and the request stays small.
- **Units open on the file's own answer when it declared one**, and otherwise on the top-ranked *plausible* guess. `sizeUnderUnits` shows the resulting building size beside each choice, which is what makes the decision obvious — the candidates are five orders of magnitude apart, so there is nothing to weigh once the number is on screen.
- **Position, rotation and north stay a human judgement.** A CAD file carries no CRS and no origin, so the dialog hands off to the existing drag-to-place interaction exactly as the PDF picker does.

**The source file is never stored.** `inspectCad` and `renderCad` are two independent multipart calls against the same `File` the browser is already holding; the second re-sends the bytes. A persisted DWG would have no DB row pointing at it and `cmd/cleanup-orphans` would correctly reclaim it (docs/backend.md and the "don't store intermediates" row in docs/pitfalls-backend.md).

**Known gap.** `cad.Paths` emits geometry only, so **text does not appear in the raster** — room names, dimension values and grid-bubble numbers are decoded by the reader (including CJK, see §6.12) and then dropped at the path stage. For a plan whose rooms are labelled rather than dimensioned this is the most valuable content missing from the image the AI will read. Adding it needs a bundled font plus a CJK font, on the order of 5–15 MB in the binary.

---

## 6. Backend — Go API (`backend/`)

Stack: Go 1.25 + Chi router + pgx + sqlc + golang-migrate + gorilla/websocket + koanf (config) + validator/v10.

### 6.1 Layout

```
backend/
├── cmd/api/             HTTP server entry point
├── cmd/migrate/         CLI migration tool
├── cmd/seed-admin/      One-off bootstrap to create the initial admin user
├── cmd/backfill-inventory-reports/  One-off: the facility report set (Overview, Floors, Areas, …) for existing facilities (§6.4 Reports)
├── cmd/demo-export/     Regenerates the demo-workspace pack from a running instance (§6.5 Demo workspace)
├── internal/
│   ├── api/             Middleware (APIKey, JWT, Tenant), response envelope, validation
│   ├── auth/            bcrypt (hash.go) + minimal HS256 JWT (jwt.go)
│   ├── cad/             Format-agnostic drawing model + geometry (see §6.12)
│   │   └── dwg/         DWG reader, written from the ODA spec (see §6.12)
│   ├── config/          koanf-based config loader
│   ├── db/              sqlc-generated query methods (one file per entity)
│   ├── demo/            Demo workspace seed: embedded pack/ (JSON per table + floor-plan images) loaded once into an empty DB
│   ├── handlers/        ~30 handler files (one per route group), incl. auth.go
│   ├── health/          /healthz, /ready
│   ├── migrate/         golang-migrate runner
│   ├── pdfconv/         PDF → PNG rasterizer over PDFium/wazero (see §6.11)
│   ├── reports/         Report executor; facility.go + facility_report.go = built-in facility sources + the facility report set
│   └── store/           ObjectStore interface + local-filesystem impl
├── migrations/          Numbered SQL migrations 0001-0009
├── queries/             sqlc SQL templates
├── scripts/             Seed scripts (attributes, style rules)
├── docker-compose.yml   PostgreSQL (postgis/postgis:16-3.4) + API
├── Dockerfile           Multi-stage (Go alpine → Debian bookworm-slim)
└── Makefile             build/run/up/down/test/migrate-up/sqlc
```

> Several `internal/` subdirs are **placeholders** (auth, correlation, outbound, retention, streaming, tenant, websocket, middleware, models) — no implementation yet.

### 6.2 Database schema (PostgreSQL + PostGIS)

**38 tables** across these groups:

- **Tenant & Settings**: `tenants`, `app_settings`
- **Spatial catalog**: `zones` (= warehouses), `grids`, `polygons`, `circles`, `lines`, `markers`, `images`, `models`, `image_planes`, `text_labels`, `stairs`, `doors`, `user_models`
- **Inventory**: `bins` (binding_kind: `grid-cell|polygon|circle|line|marker|image|model`)
- **Data link**: `connections`, `streams`, `data_sources`, `source_files`
- **Live entity state**: `assets` + `asset_positions`, `sensors` + `sensor_readings`, `rfid_tags` + `rfid_reads`, `shipments`, `cameras` + `cv_detections`
- **Metadata & rules**: `attribute_definitions` (tenant or warehouse-scoped via nullable `zone_id`), `style_rules`, `entity_references`
- **Events & audit**: `webhook_events` (drain queue), `correlation_rules`, `alerts`, `audit_log`
- **Reports**: `reports` (name + JSONB spec + soft-delete), `report_permissions` (per-user view/edit ACL), `report_runs` (execution snapshots for the history drawer + reproducibility)

Key enums: `binding_kind`, `bin_status`, `data_source_kind`, `shipment_state`, `import_job_status`, `alert_level`.

Indexes: composite `(tenant_id, X)` everywhere; GIST on geometry columns; GIN on JSONB; partial indexes on undrained webhooks + unacknowledged alerts.

### 6.3 Migrations (in order)

| File | What |
|---|---|
| 0001_initial_schema | Full base schema (all tables) |
| 0002_spa_compat | correlation_rules, alerts, audit_log; rotation to text_labels; floor_plan_id to images |
| 0003_object_storage | image_url / model_url columns (transition off inline blobs) |
| 0004_webhook_events | Webhook event queue + token-based stream resolution |
| 0005_stairs | Parametric stairs table |
| 0006_warehouse_share_default | share_token, default_view, is_public on zones |
| 0007_attribute_definitions_zone_id | Warehouse-scoped attribute schema |
| 0008_source_files | Original bytes of file imports for re-upload |
| 0009_doors | Parametric doors table |
| 0010_users | `users` (email UNIQUE, password_hash, last_login_at) + `user_tenants` (composite PK, role enum: owner\|admin\|editor\|viewer) — foundation of the email/password auth system |
| 0011_user_profile | Adds `display_name`, `bio`, `location`, `pronouns`, `job_title`, `avatar_url` columns to `users` (all NOT NULL DEFAULT '') |
| 0012_shape_roles | Adds nullable `role TEXT` column to `polygons` and `circles`. Stores the key of a per-warehouse vocabulary entry (e.g. "office", "loading"). Round-tripped through `PolygonRequest.Role` / `CircleRequest.Role` and surfaced in the side-panel role picker. Color preset comes from the vocabulary entry; role is the only top-level field — old rows stay NULL and render as generic "Polygon"/"Area". |
| 0013_image_planes | New `image_planes` table for the 3D image tool. Stores `lng/lat` anchor + `image_url` + `mime_type` + `natural_width/height` + `config JSONB` (width, height, elevation, rotation X/Y/Z, opacity, color/colorMix). Renderer wraps the image into a textured-plane GLB at runtime (no derived asset persisted). Routes at `/api/v1/image-planes`, SSE entity kind `image-planes`, public-warehouse aggregator key `imagePlanes`. |
| 0014_data_link_configs | `data_link_configs` table binding a Stream to a map object with visual + tooltip + style-rule config. |
| 0015_entity_states | Generic latest-state-per-entity table (`entity_states`) with PostGIS `position` + JSONB `payload`. Replaces the per-entity `assets`/`sensors`/`cameras`/`rfid_tags`/`shipments` state tables. |
| 0016_entity_events | Generic append-only event log (`entity_events`) with the same payload + position + ts shape. Backs heatmap/track render modes + the correlation engine's future rewrite. |
| 0017_drop_legacy_live_tables | Slice 6c2 of the data-link refactor. DROPs `cv_detections`, `asset_positions`, `sensor_readings`, `rfid_reads`, `assets`, `sensors`, `rfid_tags`, `shipments`, `cameras`. Irreversible (`.down.sql` is a comment-only tombstone). Every live-record integration now flows through `entity_states` + `entity_events` via the generic `POST /streams/:id/ingest` endpoint. |
| 0022_auth_trial_subscription | Email-OTP signup (+ trial/subscription columns, dropped by 0047). Adds `users.verified_at` (backfilled to `now()` for pre-existing rows). New `otp_codes` table (`email`, bcrypt `code_hash`, `purpose` = `signup`\|`password_reset`, `attempts`, `expires_at`, `used_at`). Adds `plan` (`trial`\|`basic`\|`pro`\|`custom`\|`lifetime`) + `warehouse_limit` + `trial_ends_at` + `subscription_status` (`trialing`\|`active`\|`expired`\|`canceled`) + `subscribed_at` to `tenants`. Existing tenants are grandfathered to `lifetime` (unlimited warehouses) so a live-DB upgrade doesn't lock anyone out. New `contact_requests` table backs the "Custom plan" contact form. |
| 0023_revenuecat *(dropped by 0047)* | RevenueCat billing integration. Adds `revenuecat_customer_id` (`tenant-<id>` app_user_id we send to RC), `revenuecat_subscription_id`, `revenuecat_product_id`, `revenuecat_entitlement_id`, `plan_renews_at`, `cancel_at_period_end`, and `billing_provider` to `tenants`. New `revenuecat_webhook_events` table (`event_id` PK) provides idempotency — RC retries the same delivery up to 3 times, we treat re-inserts as no-ops. When `SGV_REVENUECAT.SECRET_API_KEY` is empty, the subscription upgrade endpoint runs in "mock" mode (instant plan flip, no real charge) so local dev keeps working. |
| 0028_paddle *(dropped by 0047)* / 0029_paddle_webhook_events_soft_fk / 0030_paddle_plan_names | Paddle billing integration (since-superseded). Added `paddle_customer_id` + `paddle_webhook_events` table. The 2026-08-07 Stripe migration left these in place — the columns/tables stop being written but stay in the schema for non-destructive rollback and historical ledger reads. |
| 0031_stripe *(dropped by 0047)* | Stripe Hosted Checkout + Customer Portal (replaces Paddle, 2026-08-07). Adds `stripe_customer_id` + `stripe_subscription_id` to `tenants` (TEXT, default `''`) with a partial index on `stripe_customer_id`. New `stripe_webhook_events` table (`event_id` PK, `event_type`, `customer_id`, `subscription_id`, `payload JSONB`) provides idempotency — Stripe retries the same delivery on 5xx, we treat re-inserts as no-ops. Paddle's columns + table are KEPT in place for non-destructive rollback; they simply stop being written. Shared `customers` / `subscriptions` tables are reused — Stripe `ctm_…` / `sub_…` ids don't collide with Paddle's. |
| 0033_data_source_kind_table | User-defined "thing-type" tables — the third ingestion mode alongside file/REST/webhook. Extends the `data_source_kind` enum with `'table'`. Adds three sidecar tables: `table_field_definitions` (per-table field schema with `data_type` + `is_required` + `is_unique` + `sort_order`, UNIQUE on `(source_id, field_key)`; `data_type` is unconstrained `TEXT` — the allow-list lives in the handler's `oneof` tag, so widening the type set needs no migration, see the field-type catalogue in §6.4), `data_source_row_events` (append-only history mirroring `entity_events` shape — full-row snapshot per insert/update/delete, soft-FK to `table_api_tokens.id` so revoking a token doesn't erase the audit trail), and `table_api_tokens` (per-table bearer tokens, SHA-256 hashed — plaintext returned only on mint, revocation is non-destructive via `revoked_at`). Rows themselves live in the shared `data_source_rows` JSONB pool (kind='table' is just a discriminator), so the existing overlay pipeline reads them through `listRowsForSource` with no per-source branch. |
| 0034_data_link_configs_stream_nullable | Drops the NOT NULL on `data_link_configs.stream_id` so a config can be bound to a `data_source_id` alone (the v3 table/REST/file path) without a synthetic stream. Paired with `0033` — table-kind sources never have a stream. The SPA sends `streamId: 0` for those and `dataLinkConfigParams` maps 0 → NULL; `DataLinkConfigRequest` enforces "at least one of stream/source" with paired `required_without` tags (a leftover `validate:"required"` on `StreamID` kept 400-ing these until 2026-08). |
| 0035_data_source_rows_payload_gin | GIN index on `data_source_rows.payload` for filter performance at scale. The filter compiler renders `payload->>'field' = $N` / `payload @> $N` etc; without an index those are full-table scans, fine at 100 rows and unusable at 1M. GIN supports the containment operators the compiler emits for `in` / `eq` on JSONB values. Default opclass (jsonb_ops) — `jsonb_path_ops` is smaller but doesn't support the top-level `?` / `@>` operators the compiler uses for `exists` / `missing`. |
| 0036_ai_jobs | Backs the AI Map tool. New `ai_jobs` table: `tenant_id` + `image_id` FKs (both `ON DELETE CASCADE`), `status` (`pending`\|`running`\|`done`\|`failed`\|`canceled`) with a CHECK constraint, `model` (frozen tag actually used), `prompt_version` (frozen prompt fingerprint), `detections JSONB` (null until done), `accepted_ids`/`rejected_ids JSONB` (feedback endpoint fills these post-review, for accuracy telemetry), `tokens_used INT`, `duration_ms`, `error`. Two indexes: `(tenant_id, status, created_at DESC)` for the monthly cap query + status filter; `(image_id, created_at DESC)` for "does this image have an in-flight job" lookups. See `docs/ai-floorplan.md`. |
| 0037_ai_jobs_worker_task_id | Adds `worker_task_id TEXT NOT NULL DEFAULT ''` to `ai_jobs`. Populated by the Go handler right after `aiworker.Client.Enqueue` returns, so support can grep a lost Python worker log line (Dramatiq task id) back to a Go job row. Default `''` keeps the migration backfill trivial for pre-Phase-4 rows. Written via the dedicated `SetAIJobWorkerTaskID` query — kept out of `CreateAIJob`'s RETURNING because the task id isn't known at INSERT time. |
| 0038_reports | Report Builder Phase 1. Three tables: `reports` (name + description + icon + color + `spec JSONB` + `spec_version` + soft-delete via `is_archived` + `created_by` FK to `users` with `ON DELETE SET NULL`), `report_permissions` (composite PK `(report_id, user_id)` with `can_edit BOOLEAN`; extends visibility beyond the default "owners/admins + creator only" rule), and `report_runs` (execution snapshots — `spec_snapshot JSONB` for reproducibility even after the parent spec edits, plus `row_count`/`ms_elapsed`/`status`/`error` for the history drawer). Partial index `reports_tenant_active_idx` skips archived rows for the directory query. Includes `TrimReportRunsBefore` retention hook (mirrors `TrimDataSourceRowEventsBefore` / `TrimEntityEventsBefore`) — not wired to a scheduler yet, operator job in a later phase. History reports themselves aggregate over the existing `data_source_row_events` trail, so no new "row-change" table is needed. |
| 0042_users_password_changed_at | Adds nullable `users.password_changed_at`, stamped by `UpdateUserPassword` (password reset, `cmd/seed-admin` rotation). `OptionalJWTMiddleware` rejects any JWT whose `iat` predates it — this is how a reset signs out every session with stateless tokens (§6.5). NULL = never changed, so existing tokens stay valid. |
| 0045_solutions | `solutions` (name, description, icon = curated Lucide id, color = hex, template, position) + `solution_items` with exactly one of `zone_id` / `report_id` / `data_source_id` — real FKs with `ON DELETE CASCADE`, so a deleted facility/report/data source leaves every solution (those deletes are hard deletes); partial unique indexes per kind. |
| 0046_facility_sources | Adds `facility` to `data_source_kind` (built-in report sources over the shape tables — `internal/reports/facility.go`), a unique index on `(tenant_id, config->>'facilityEntity')` (keyed on config because a value added by `ALTER TYPE` can't be used in the same transaction), and the SQL helpers `sgv_vertices_line(jsonb)` / `sgv_vertices_polygon(jsonb)` that build PostGIS geometry from shape `vertices` (NULL on bad input, never an error). Down deletes the facility rows; the enum value stays. |
| 0047_drop_billing | Open-source edition: drops the Stripe / Paddle / RevenueCat tables (webhook events, `subscriptions`, `customers`, `contact_requests`) and the billing-only `tenants` columns. `users.verified_at` + `otp_codes` stay (email verification, password reset). Down recreates the schema with every workspace unlimited (no data restore). |
| 0048_demo_workspace | Adds `tenants.is_demo` (default false) with a partial unique index so at most one workspace carries it. Set by `internal/demo` on the workspace it seeds; read by `GetDemoTenant` (signup join, bootstrap). |
| 0044_upload_library | `tenant_files.zone_id` + `user_models.zone_id` = facility it was uploaded in (`ON DELETE SET NULL`; foreign zones resolve to NULL in SQL), `user_models.thumbnail` (inline data URL). Backfilled from the earliest row using each file. |
| 0043_tenant_files | `tenant_files (tenant_id, object_key)` ownership index for stored objects (+ size, content type, uploaded_by). Written by every upload (`recordTenantFile`); backfilled from `images` / `image_planes` / `user_models` URLs. Scopes the Files screen to its workspace and keeps owned uploads out of the orphan sweep. Owner-less legacy objects stay unattributed (listed to no one). |

### 6.4 API surface

All routes prefixed `/api/v1`. **Tenant-scoped routes require `X-Api-Key` + `X-Tenant-Id`** unless noted.

#### No auth, no tenant
- `GET /healthz`, `GET /ready`
- `GET /api/v1/public/warehouses/{id}` — full WarehouseView envelope (zone + all shapes + bins). Slice 6c2 removed the per-entity live-data roster from this envelope; authenticated viewers fetch via `/entity-states`, public visitors don't see live records.
- `GET /api/v1/public/warehouses/by-token/{token}`
- `GET /files/{key}` — serves uploaded images/models
- `/api/v1/solutions` — `GET /` (all, with `zoneIds`/`reportIds`/`dataSourceIds`), `POST /` (+ initial members), `GET|PATCH|DELETE /{id}`, `POST|DELETE|PUT /{id}/items` (add / remove / replace; ids the tenant doesn't own are dropped in SQL), `GET /{id}/overview` (`totalRows`, `updated24h`, `lastUpdate`, `recentRuns`). Changes need owner/admin/editor. Broadcasts SSE `solutions`. **`?solution=<id>`** on `GET /warehouse-summaries` (list + both stat blocks) and every `/data/*` list (rows, bins, live, events, files, runs, sources + the KPI `stats`) restricts to that solution's members; a foreign/unknown id is 404 (`solutionScope` in `handlers/solutions.go`). See `internal/handlers/solutions.go`.
- `GET /api/v1/library/images` · `GET /api/v1/library/models` — the editor's upload library, **any workspace member** (unlike `/files`). Images: owned ∪ used image files that still exist in storage → `[{key,url,name,size,mimeType,naturalWidth,naturalHeight,uploadedAt,uploadedZoneId,uses:[{zoneId,kind:floorplan|plane,count}]}]`, newest first; `name` = the oldest using shape's name, else the tidied key. Models: `user_models` collapsed by `model_url` → `[{id (oldest row),ids,name,modelUrl,bytes,thumbnail,uploadedAt,uploadedZoneId,uses:[{zoneId,kind:model,count}]}]`. See `internal/handlers/library.go`.
- `GET /api/v1/files` — admin-only, tenant-scoped (owned ∪ referenced keys). Query `status, type, facility, q, sort, offset|page, pageSize` → `{rows:[{key,url,size,contentType,uploadedAt,category,type,referencedBy}], total, page, pageSize, stats, statusCounts, typeCounts, facilities}`. Categories `attached` / `ghost` / `orphan` / `missing`.
- `DELETE /api/v1/files/{key}` — admin-only. Refuses (409) when any live reference exists; 404 when the file isn't this tenant's. Drops the tenant's `tenant_files` row; the object is removed only when no other tenant owns it and no row references it. For ghost-only files, cascades DB row cleanup first, then reclaims the file via `cleanupObjectURL`. See `internal/handlers/files.go`.

#### Auth (no API key, no tenant; JWT optional)
The whole `/api/v1/auth/*` block runs through `OptionalJWTMiddleware` so endpoints that need the user (`/me`) can read it from the JWT, while endpoints that don't (`/signup-request`, `/verify-otp`, `/complete-signup`, `/login`) see an empty context. Signup is a 3-step OTP flow — an existing account cannot be created a second time (step 1 rejects with 409). Each mutating endpoint is protected by **per-IP + per-email rate limits** (see "Rate limiting" under §6.5) — a throttled request returns 429 with `{error: "too many requests — please slow down and try again in a minute"}`. **Every auth error carries a stable `code`** next to `error` (`invalid_request`, `invalid_email`, `otp_expired`, `otp_locked`, `otp_incorrect`, `verification_expired`, `email_taken`, `password_weak`, `invalid_credentials`, `not_authenticated`, `rate_limited`, and `session_revoked` from the middleware); **every 429 carries `Retry-After`** (seconds until the limiter's next token, exposed via CORS `ExposedHeaders`).
- `POST /api/v1/auth/signup-request` — `{email}` → `{ok, email, expiresIn}`. Generates a 6-digit OTP, hashes it with bcrypt (`otp_codes.code_hash`), and emails it via the SMTP mailer (or logs to stdout when `SGV_MAIL.HOST` is empty). **Never** returns 409 — existing emails get the same 200 response as new ones, but instead of an OTP the account owner receives a "someone tried to sign up as you" courtesy notice from `mailer.SendAlreadyRegistered`. This closes the user-enumeration side channel (a 409 would let callers probe which addresses have accounts). 429 if the caller's IP has sent too many requests OR the email has received too many codes.
- `POST /api/v1/auth/verify-otp` — `{email, code}` → `{verificationToken, email, expiresAt}`. Marks the OTP as used and mints a 15-min HS256 verification token scoped `"signup"` (distinct payload from a login JWT — cannot be replayed as a session token). 429 stops the OTP brute-force loophole where an attacker rotates OTP rows to reset the 5-attempts cap. Per-email throttle is deliberately tight (burst 5, refill 1/10min ≈ ~150 attempts/day) so cracking a 6-digit code against a targeted email takes ~18 years expected-case.
- `POST /api/v1/auth/complete-signup` — `{email, password, verificationToken, displayName?}` → `{token, user, tenants[]}`. Creates user (verified) → creates the user's first workspace (no plan, no limits) → links user as `owner`. Rejects if a user with that email now exists (race — this 409 is legit; the race-case UI shows the "Sign in instead" link). Password policy enforced by `auth.ValidatePassword` (min 12 chars, ≥3 character classes, common-password blocklist including exact matches AND substring matches like `MyPassword123!`). No rate limit — the verification token IS the abuse control (min 15 min for the whole OTP round-trip).
- `POST /api/v1/auth/login` — `{email, password}` → `{token, user, tenants[]}`. Response tenants carry `plan: "self-hosted"`, `subscriptionStatus: "active"`, `isLocked: false`, `warehouseLimit: 0` (= unlimited) for compatibility; the open-source edition has no plans or limits.
- `POST /api/v1/auth/logout` — 204. Client-driven; server has no token blocklist.
- `POST /api/v1/auth/password-reset-request` — `{email}` → `{ok, email, expiresIn}`. Identical status, body and timing whether or not the account exists (the missing-account branch runs `auth.DummyVerify` to match the bcrypt cost of hashing a code). Registered address: rotates prior `password_reset` OTPs, emails a 6-digit code (10 min). Unregistered: sends nothing. Own per-IP (1/min, burst 3) + per-email (1/15 min, burst 2) limiters.
- `POST /api/v1/auth/password-reset-verify` — `{email, code}` → `{resetToken, email, expiresAt}`. Shared `checkOTP` helper (same attempts cap / consume-on-success as signup). 15-min token scoped `"password_reset"`. Per-IP 10/min + per-email 1/10 min, burst 5.
- `POST /api/v1/auth/password-reset-complete` — `{email, password, resetToken}` → `{ok, email}`. Token checked first (so an expired flow restarts before the user fixes a password), then `ValidatePassword`. **Single-use**: rejected when `password_changed_at >= token iat`. Stamps `password_changed_at` (revoking every session, and primes this process's revocation cache), marks the user verified, invalidates outstanding reset OTPs, emails a "password changed" notice. Does NOT sign the caller in. Per-IP 10/min.
- `GET  /api/v1/auth/me` — requires JWT; returns `{user, tenants[]}` (same enriched tenant shape as login).

#### API key only (no tenant)
- `GET|POST|PATCH|DELETE /api/v1/tenants[/{id}]`
- `GET|POST|DELETE /api/v1/settings[/{key}]`

#### Live invalidation (auth + tenant)
- `GET /api/v1/events` — **Server-Sent Events** (entity create/update/delete). Mounted behind `TenantMiddleware` (2026-10): the SPA reads it with `fetch` so it can send `Authorization` + `X-Tenant-Id` (EventSource cannot send headers), membership is checked, and the broadcaster forwards only that tenant's events. Each stream ends after ~50s (before the router's 60s `middleware.Timeout`) and the client reconnects at once; a `: ping` comment every 20s keeps proxies from closing it, `X-Accel-Buffering: no` stops nginx buffering it.

#### Webhook & WebSocket (auth via query param)
- `GET  /api/v1/streams/{token}/ws` — WebSocket upgrade (live ingest). Frames capped at 1 MiB (`SetReadLimit`); each message's writes run on a 15s context detached from the request (the router's 60s timeout would otherwise cancel every write on a long-lived socket). Timestamps and the out-of-order guard as for `/ingest`.
- `POST /api/v1/webhooks/{token}` — receive event(s). When the stream's endpoint has an `hmacSecret`, the Go handler verifies `X-Webhook-Signature: t=<unix>,v1=<hex>` (HMAC-SHA256 over `<t>.<raw body>`, ±300s, several `v1=` allowed during secret rotation — `handlers/webhook_signature.go`, same format as the Worker). Unsigned or badly signed → 401. A source whose config sets `requireSignature: false` (copied onto the stream endpoint) accepts unsigned posts from legacy senders, but a signature that IS sent is always checked. Shared API key compared in constant time (`api.APIKeyMatches`).
- `GET  /api/v1/webhooks/{token}` — list undrained events
- `GET  /api/v1/webhooks/{token}/drain` — mark as consumed

#### Dashboard overview (auth + tenant)
- `GET /api/v1/dashboard-overview` — consolidated screen data in one round-trip. All aggregates computed server-side from real catalog data; no client-side rollup.
  - Response: `{ kpis: { totalWarehouses, totalRacks, totalBins, totalAssets, warehousesLast30d, racksLast30d }, binStatus: { empty, occupied, reserved, unknown, total }, timeline: [{date, warehouses, racks, bins}] (last 30 days, zero-filled), topByBins/topByOccupancy/topByAssets: [{id, name, color, value}] (top 5 each), recentWarehouses: [{id, name, color, createdAt}] (5 most recent) }`.
  - Implementation: 7 SQL queries sequenced; each independently fast on existing indexes. `generate_series` builds the timeline so days with zero activity still appear. Activity dimensions for bins use `bins.updated_at` (no `created_at` on that table). 8-second query timeout.

#### Warehouse summaries (auth + tenant)
- `GET /api/v1/warehouse-summaries?search=&emptyOnly=&sort=&dir=&page=&pageSize=` — paginated, server-aggregated warehouse list. Four SQL queries per request: (1) the listing with CTE per-zone aggregates + `COUNT(*) OVER()` for filtered total, (2) **share links for the visible page** (`attachShareLinks` — one `zone_id = ANY(...)` lookup over `share_links_zone_idx`, never one query per row), (3) tenant-wide stats for the dashboard-style KPIs, (4) **filtered stats** that match the active filter across all pages (drives the `/warehouses` KPI strip). Sort key + direction allow-listed. `pageSize` capped at 200. Each row carries `shareLinks: [{ id, token, label, status, viewCount, expiresAt }]` — active first, capped at `maxShareLinksPerRow` (6) — plus the untruncated `shareLinkCount`. `status` is computed by the same `computeShareLinkStatus` the share-link endpoints use, so the table's badge can never disagree with the dialog's.
- `GET /api/v1/data/sources` — dropdown list for the Data screen. Returns every DataSource (active + archived) with `{ id, name, kind, entityKind, archived, deletedAt }`.

#### Thing-type tables (auth + tenant + bearer-token writes)

A "thing-type table" is a user-defined schema (camera, assets, location, shipping, asn, soh, …) backed by a `data_sources` row with `kind='table'` plus a child `table_field_definitions` set + one or more `table_api_tokens`. It's the third ingestion mode alongside file/REST/webhook: the user defines the columns (text / number / boolean / datetime, required, unique), the backend auto-mints a "default" token on create, and the user writes rows from their own scripts via the public per-table surface. The map overlay's match-resolver pipeline reads them back through the same `data_source_rows` table file/REST/webhook rows already use, so a DataLinkConfig can pick a table-kind source and feed its rows through any sub-renderer (point-at-coord, tint, gauge, track, fov-cone, roi-pulse) with no per-source branch.

- `GET    /api/v1/tables` — list every table-kind data source for the tenant with its field definitions and `stats: { rows, lastWriteAt?, activeKeys, keyLastUsedAt?, polling }` (two aggregate queries in `queries/table_stats.sql`, not one per table). **No `tokens` array** — read key counts from `stats.activeKeys`. Used by `/tables`, Integrations and its Health view.
- `POST   /api/v1/tables` — create a new table. Body: `{ name, entityKind?, zoneId?, config?, fields: [{ fieldKey, fieldLabel, dataType, isRequired?, isUnique?, sortOrder? }] }` (no `tokenLabel` — the backend auto-mints a "default" token and returns the plaintext in `tokens[0].token`). Returns the full table response including the **first plaintext token** in `tokens[0].token` — the only time the plaintext is visible. Save it server-side immediately; the row never returns it again.
- `GET    /api/v1/tables/{id}` — full table response (data source + fields + tokens + `stats`). Tokens come back with `token` omitted after the initial mint.
- `PATCH  /api/v1/tables/{id}` — update name / entityKind / zoneId / config / fields. When `fields` is present it **replaces** the existing field set wholesale (no partial field patching).
- `DELETE /api/v1/tables/{id}` — refuses with 409 `{ reason: "linked-configs", linkedConfigs: [{id, name, zoneId, zoneName}] }` when any `data_link_configs` row references the source. The SPA reshapes that into `IntegrationLinkedError` so the user sees which warehouses block deletion. Same guard pattern as `deleteBinSource`.
- `POST   /api/v1/tables/{id}/tokens` — mint another token. Body `{ label }` → returns `{ id, sourceId, label, token, createdAt }` with the plaintext visible once.
- `DELETE /api/v1/tables/{id}/tokens/{tokenId}` — revoke a token. Subsequent writes with that token get 401.
- `GET    /api/v1/tables/{id}/events?from=&to=&limit=` — table-level event log (insert / update / delete across all rows).
- `GET    /api/v1/tables/{id}/events/{entityKey}` — per-row event log (history for the recap panel).

#### Reports (auth + tenant; admin-only mutations)

A Report is a saved JSON spec (`reports.spec JSONB`) referencing user-defined tables and data_source rows (kind=`table`/`rest`/`webhook`/`file`), a filter DSL, aggregations, sort/pagination, and an ordered widget list (KPI, table, chart, map, markdown, history, …). Phase 1 (2026-08) ships CRUD + ACL + `report_runs` history persistence; the executor (`POST /reports/{id}/run`) is a 501 stub until Phase 2 lands. Access rules: tenant owners/admins can create/edit/archive/delete anything, creators can view/edit their own, other members see reports where they're explicitly listed in `report_permissions`. A workspace **viewer** never edits — not even a report they created or were granted edit on (`roleCanEditReports` caps `canEdit` in both the list and `resolveReportAccess`). Frontend client: `src/lib/reports-client.ts`; UI: `src/components/reports/reports-dashboard.tsx` + `src/routes/report-{detail,builder}.tsx`.

**Built-in facility sources (2026-10, migration 0046).** Every workspace gets 11 `data_sources` rows of kind `facility` (`config.facilityEntity` = floors · areas · racks · markers · walls · doors · stairs · lifts · escalators · text-labels · models), created on first use by `reports.FacilitySourceIDs` (reads first, upserts only what's missing). They hold no rows: `internal/reports/facility.go` swaps the executor's `FROM data_source_rows` for a subquery over the shape table shaped the same way (`tenant_id, source_id, entity_key, payload`, nulls stripped), so filters / group-by / metrics / sort compile unchanged and nothing is ever stale. `entity_key` is `<api-kind>:<id>` (`markers:57`). Columns are fixed per entity (`FacilityEntity.Fields`): common id · name · facility · facility_id · floor · floor_id · visible · created/updated, plus per-kind ones — area/perimeter (PostGIS from the `vertices` JSONB via the migration's `sgv_vertices_polygon` / `sgv_vertices_line`), rack columns × rows × levels → bays (cell count from `xSize`/`ySize` like `grid-generators.ts`), the **area a point sits in** (smallest non-`surface`/`floor-area` polygon on the same facility + floor), wall length, stair from/to floors, per-floor counts. Areas = polygons only (circles are not included). Generic lists (`ListDataSources*`) exclude `kind='facility'`, so Tables / Data / Integrations / the layer editor never show them; `_/history` refuses them (shapes keep no event trail). **Facility report set (2026-10):** `createZone` and `duplicateZone` call `reports.CreateFacilityReports` (best-effort, logged) — eight ordinary, deletable reports pinned to the facility, built in `internal/reports/facility_report.go`: Overview · Floors · Areas · Racks · Markers & sensors · Walls & doors · Stairs, lifts & escalators · Labels & 3D models. Each has viewer filters (Floor / Area / Type / Search / Visible) in the builder's `spec.viewerFilters` format — `vf_*` params, `opt_vf_*` option queries scoped to the facility, conditions in filter-bar order after the fixed ones, so a builder save leaves the queries byte-identical, KPIs, charts (`seriesLabels`, `decimals` bindings) and a `facilityExplorer` widget. `spec.origin = {kind:'facility-set', key, zoneId}` marks them (carried through builder edits via `draft.origin`); `cmd/backfill-inventory-reports [-dry-run] [-tenant N]` creates only the keys a facility is missing, archived ones counting as present, so deleted reports are never re-created. **`facilityExplorer`** (`src/components/reports/widgets/facility-explorer/`): bindings `{zoneId, tabs:[{entity, queryRef, sourceId, title?, label, subtitle[], editable[]}]}` (types + builder compile in `src/lib/reports/explorer-spec.ts`; `title` = the author's tab name, else the translated entity name); reads every tab's rows through `ReportQueryContext` (`report-query-context.ts`, provided by the report viewer with `refresh()`); list with `ShapeThumb` previews (SVG outlines from real geometry — `explorer-geometry.ts` —, marker icons, floor-plan images, model thumbnails), sort, ↑/↓/j/k/Esc, a live `FacilityMap` (`facility-map.tsx` — the viewer's overlay stack, one floor at a time, `useFacilityShapes` loads the facility into the spatial + door stores, only the active tab's kind is clickable, the camera frames the pick clear of the detail card) and a detail panel (desktop: card over the map; mobile: bottom sheet) with every property, Edit (writable columns only), Delete (not floors), Open in editor, previous/next. One facility map per report page — the spatial store holds one facility at a time. **Linked-data reports (2026-10):** one report per data table linked to a facility (`internal/reports/datalink_report.go`, `CreateDataLinkReports`), created when the first link to that table is saved (`data_links.go` create hook) and by the backfill; `spec.origin = {kind:'data-link', key:'source:<id>'}` (`ListReportOriginKeys` — archived count, so deleted ones stay deleted). Built from the table's own fields: Rows + up to three numeric KPIs (avg for pct/temp/fill-like names, else sum), a status donut, a value-by-floor (or top-10) bar, viewer filters on floor / status / a name search, and an explorer tab `{kind:'dataLink', dataLinkId, titleField}`. That tab places each row with the link's own rules (`explorer-placement.ts` → `resolveMatchTargets`; floor from the shape, else `floorScope` field + value map), pins coordinate rows (`.sgv-explorer-pin`), draws the link's live layer (`MapDataLinkedOverlay` inside `FacilityMap`) and is read-only (Open in table / Open in editor for the linked shape). SPA: `src/lib/reports/facility-sources.ts` — translated entity/field names (`reports.facility.*`), `writeFacilityRow` (report column → shape field or **merged** config key; only name · visible · colour · icon · label · text · height · thickness · elevation · area type→`role` are writable), `deleteFacilityRow` (floors can't be deleted from a report), `facilityEditorHref`. The editable table switches to that path when its source schema has `kind: 'facility'` (adds row delete + bulk delete with `ConfirmDialog`, and Open in editor); the wizard groups these under "Facility" in the source step, allows them for Editable reports, locks computed columns in the Edit form step and skips ids/timestamps/coordinates in the default column pick.

- `GET    /api/v1/reports` — list every visible report for the caller. Backend filters — non-admins only see reports they created OR are listed on in `report_permissions`. Each response row carries `canEdit` so the SPA renders builder actions accordingly.
- `POST   /api/v1/reports` — create a report. Admin/owner only (403 otherwise). Body: `{ name, description?, icon?, color?, spec?, specVersion?, permissions?: [{ userId, canEdit }] }`. Permission entries are validated against `ListTenantMembers` (cross-tenant leakage refused with 400).
- `GET    /api/v1/reports/{id}` — full report + ACL (ACL rows only surface to editors; view-only members get the report metadata alone).
- `PUT    /api/v1/reports/{id}` — full replace of every updatable field including the ACL. Requires edit access (admin OR creator OR explicit `can_edit=true`). ACL rewrite pattern is delete-all + re-insert inside a transaction — simpler than diff-and-patch at v1 scale.
- `DELETE /api/v1/reports/{id}` — soft-delete (`SetReportArchived` sets `is_archived = true`). Admin/owner only. `report_runs` and `report_permissions` are preserved so an admin can restore.
- `POST   /api/v1/reports/{id}/restore` — undo an archive (the gallery's Undo toast). Admin/owner only; 404 for an unknown id. Guarded by `TestReportArchiveRestore`.
- `POST   /api/v1/reports/{id}/run` — compiles the stored spec (with optional runtime filter override in the body `{ filters, limit, offset }`) into a parameterized SQL query over `data_source_rows`, executes it under a 30 s statement timeout, records the outcome in `report_runs`, and returns `{ runId, columns, rows, rowCount, msElapsed, spec }`. Compilation is done by `backend/internal/reports/executor.go` — see its package doc for the four safety layers (field allow-list from schema, identifier regex, `$N` args, LIMIT cap). Errors return 422 with the executor's message and the run is still logged with `status='error'` so the history drawer surfaces the failure.
- `GET    /api/v1/reports/{id}/runs?limit=50` — execution history (list of past runs with `msElapsed` / `rowCount` / `status`). Limit clamped to 500 server-side.
- `GET    /api/v1/reports/_/members` — admin-only. Returns the list of tenant members (`{userId, userEmail, role}`) the ACL user-picker in the builder uses. Literal `_/members` route mounted before the `{id}` group so chi matches it first.
- `GET    /api/v1/reports/_/sources` — every data source the tenant can build a report over (kind=`table`/`rest`/`webhook`/`file`). Used by the builder's source picker on open. Also lists the workspace's built-in facility sources (kind `facility`, with `facilityEntity` + `apiKind`), creating them on first call.
- `GET    /api/v1/reports/_/sources/{sourceId}/fields` — schema for one source. For `kind=table` returns the authoritative `table_field_definitions` set; for the others samples the most recent 500 rows via `SampleDataSourceRowFields` and returns the union of top-level payload keys as text-typed fields. Reuses `reports.ResolveSource` so the builder + executor always see the same schema. Facility sources return their fixed column set plus `facilityEntity` / `apiKind`.
- `GET    /api/v1/reports/_/history?sourceId=X&windowDays=7&bucket=hour|day|week|month&recent=20` — Phase 3. Backs the History widget. Aggregates `data_source_row_events` for one source, folded into `{ buckets: [{ts, insert, update, delete}...], recent: [{id, entityKind, operation, ts, payload}...], sourceId, windowDays, bucketUnit, totalEvents }`. `windowDays` clamped to 365; `recent` clamped to 500; `bucket` restricted to hour/day/week/month (validated). Uses `BucketDataSourceRowEvents` + `RecentDataSourceRowEvents` queries. Tenant-membership + source-exists check only — history is a source-level concept, not per-report. 400 for a facility source (no history).

#### Thing-type tables — public per-table CRUD (bearer token, no API key, no tenant header)

Mounted at `/api/v1/public/tables` by `handlers.PublicTableRowsRouter(q, pool)`. Auth is a `Bearer sgv_tbl_...` token (validated by `TableTokenMiddleware` in `table_token_auth.go`); the token resolves `(tenant_id, source_id, token_id)` server-side, so callers MUST NOT send `X-Tenant-Id` or `X-Api-Key` — those headers would actively break the auth path. The SPA's `publicTablesFetch` helper (`src/lib/table-rows-public-client.ts`) is deliberately NOT `apiFetch` to avoid silently leaking the SPA's API key into a request the user thought was scoped to their per-table bearer.

**Per-token rate limiting** — `TableTokenMiddleware` enforces a per-token `api.KeyedLimiter` (token bucket) keyed on `token_id`. Default 60 req/min per token, burst 30, configurable via `SGV_TABLES.RATE_LIMIT_PER_MIN` (0 = unlimited). 429 response: `{ error: "rate limit exceeded for this token" }`. Per-token (not per-IP) because one IP may legitimately run many tokens (CI, fleet agents) and one token shouldn't be able to DOS the table for everyone else. Process-local — a horizontally-scaled deploy would need Redis for accurate cross-instance throttling, same caveat as the auth limiter. Initialised at boot by `handlers.InitTableTokenRateLimiter(cfg.Tables.RateLimitPerMin)` in `main.go`.

**Auto-configured 12-endpoint surface** — every table gets the same 12 endpoints the moment it's created. No user setup. All server-side paginated/filtered so a table with 1M rows is queryable without pulling the whole table over the wire. Filter DSL reuses `FilterCompiler` from `data_source_query.go` (exported alongside this slice) — same tree shape as `POST /api/v1/data-sources/:id/query`.

- `POST   /api/v1/public/tables/rows` — upsert one row. Body: `{ entityKey, payload, position? }`. Validates payload against the table's field definitions (required + unique constraints), then `UpsertDataSourceRow` writes to the same `data_source_rows` table file/REST/webhook rows use. Records a `data_source_row_events` row for the audit trail. Broadcasts `ENTITY_UPDATED` for `data-sources` so the integrations page + any open map re-fetches.
- `POST   /api/v1/public/tables/rows/bulk` — upsert up to 1000 rows in one transaction. Body: `{ rows: [{ entityKey, payload, position? }, …] }` (cap 1000 rows / 32 MB body). Partial-success: per-row validation failures are collected in `errors: [{ index, error }]`, valid rows still commit. Each row runs under its own savepoint (`bulkUpsertRows`, shared with the authed bulk route), so a database error on one row no longer aborts the whole transaction; the audit `operation` (insert/update) is decided before the upsert. One kind-wide SSE broadcast (`BroadcastEntityKindEvent("ENTITY_UPDATED", "data-sources", tenantID)`) — NOT 1000 per-row events (see docs/pitfalls-backend.md on synthetic zero id).
- `GET    /api/v1/public/tables/rows` — paginated list. Query: `page` (default 1), `pageSize` (default 100, max 500), `sortBy` (allow-list: `entity_key`/`ts`/`updated_at`, default `ts`), `sortDir` (`asc`/`desc`, default `desc`). Returns `{ rows, page, pageSize, totalCount }` via `COUNT(*) OVER()`.
- `POST   /api/v1/public/tables/rows/query` — filter + paginate via the filter DSL. Body: `{ filter?, page?, pageSize?, sortBy?, sortDir?, includeCount? }`. Returns `{ rows, page, pageSize, totalCount?, truncated }`. `includeCount` (default false) — clients only pay for the count when they need it. Reuses `NewFilterCompiler` / `PushBase` / `PushFilter` / `PushFloor` from `data_source_query.go`.
- `GET    /api/v1/public/tables/rows/{entityKey}` — one row.
- `PATCH  /api/v1/public/tables/rows/{entityKey}` — partial patch. Reads existing payload, merges, validates, writes.
- `DELETE /api/v1/public/tables/rows/{entityKey}` — deletes the row (event recorded). Broadcasts `ENTITY_UPDATED` for `data-sources`.
- `PATCH  /api/v1/public/tables/rows/bulk` — patch up to 1000 rows by key list. Body: `{ rows: [{ entityKey, patch }] }` (cap 1000). Single transaction, partial-success: `{ updated, errors: [{ index, error }] }`.
- `PATCH  /api/v1/public/tables/rows/by-filter` — patch every row matching a filter. Body: `{ filter, patch }`. Cap 5000 rows touched per call (guard against accidental mass-update). Returns 413 with `{ error: "filter matches >5000 rows; narrow the filter or use paged calls" }` when exceeded. Response: `{ updated }`.
- `DELETE /api/v1/public/tables/rows/bulk` — delete up to 1000 rows by key list. Body: `{ entityKeys: [...] }` (cap 1000). Response: `{ deleted }`.
- `DELETE /api/v1/public/tables/rows/by-filter` — delete every row matching a filter. Body: `{ filter }`. Cap 5000 rows touched. 413 on exceed. Response: `{ deleted }`.
- `GET    /api/v1/public/tables/rows/schema` — returns the table's own field definitions + total row count. `{ fields: [{ fieldKey, fieldLabel, dataType, isRequired, isUnique, sortOrder }], rowCount }`. Cheaper than the generic `/data-sources/:id/schema` introspection because we already know the schema — no `jsonb_each` aggregation needed.

**Caps rationale** — 1000 rows/bulk and 5000 rows/by-filter are deliberate: small enough to finish in one HTTP request, large enough to be useful for real ETL batches. Larger bulk = background-job territory (out of scope for v1). Sort allow-list is `entity_key`/`ts`/`updated_at` only — sorting by arbitrary payload fields would need expression indexes per field; clients that need payload-field sort can do it client-side on the fetched page.

**Filter performance at scale** — migration `0035_data_source_rows_payload_gin` adds a GIN index on `data_source_rows.payload`. The filter compiler renders `payload->>'field' = $N` / `payload @> $N` etc; without an index those are full-table scans, fine at 100 rows and unusable at 1M. GIN supports the containment operators the compiler emits for `in` / `eq` on JSONB values.

**Why a separate public surface instead of `/data-sources/:id/rows`**: the existing per-source rows endpoint is JWT-tenant-gated and meant for the SPA's own internal ingestion pipeline. The thing-type table flow is for the user's *own* scripts (fleet agents, automation, ETL), which have no JWT — only the per-table bearer. A bearer token can be revoked per-table without rotating the SPA's API key, and a compromised token only exposes one table's rows.

**Authed SPA row surface** (`/api/v1/tables/:id/rows/...`, JWT + tenant — see `backend/internal/handlers/table_rows_authed.go`): mirrors the public 12-endpoint surface but authenticates via the SPA's JWT instead of a bearer token. The SPA uses these routes for its own data-grid + history viewer because it doesn't have the plaintext table token after the create-time mint (only the hashed version on `table_api_tokens`). Mounted inside `TablesRouter`'s `/{id}` block as `/rows`, `/rows/bulk`, `/rows/query`, `/rows/schema`, `/rows/by-filter` (literals first), then `/rows/{entityKey}` for the single-row GET/PATCH/PUT/DELETE. PUT is **full-replace** (overwrites the row's payload verbatim, resets position) — the public surface only has PATCH (merge), so callers that want strict replace semantics use the authed surface. Client: `src/lib/table-rows-authed-client.ts` (`apiPost`/`apiPatch`/`apiPut`/`apiDelete` inject the SPA's auth + tenant headers automatically). Frontend grid: `src/components/data-link/table-records-dialog.tsx` (`TableRecordsDialog` opened from a "Records" button on `TableCard`, `TableRowHistoryDialog` opened from a per-row "History" action). The grid renders one column per field definition in `sortOrder`, paginates server-side (25/50/100 per page; sort by `entity_key`/`ts`/`updated_at` or `field:<key>` — numeric fields sort numerically, unknown keys 400; `?q=` matches the row key or any payload value, LIKE wildcards escaped), supports inline cell edit via `patchAuthedRow`, "Add row" via `upsertAuthedRow`, and delete per row. Both the inline cell edit and the create-row form use one `FieldValueInput` driven by the field-type catalogue (native date/time pickers, a textarea for `longtext`/`json`, a true/false select for `boolean`), and cells render through `formatFieldValue` — temporal types via `Intl.DateTimeFormat` in the active locale, `url`/`email` as links. The history viewer pulls `listTableRowEvents(tableId, entityKey)` and renders a per-step timeline with field-level diffs computed client-side from consecutive full-row snapshots (the events table stores snapshots, not diffs — diffing is cheap and runs only when the user opens the dialog).

**Field-type catalogue** (`src/lib/table-field-types.ts`, 2026-08): the single source of truth for what a field's `dataType` means on the client — the picker options, the value editor, the coercion on save, and the grid cell renderer all read from it, so the schema builder, the Integrations-tab form and the record grid can't drift. **13 types in 5 groups**: text (`text`, `longtext`, `email`, `url`, `phone`, `uuid`), numeric (`number`, `integer`), boolean, temporal (`date`, `datetime`, `time`) and structured (`json`). Each entry carries a Lucide icon, an i18n label key, the `<input type>` to render (`textarea` and `select` are special-cased) and a placeholder hint.

Three things to know before extending it. **The list must be extended in three places at once**: the `FieldDataType` union in `src/lib/tables-client.ts`, the `oneof` validate tag on `FieldDefinitionRequest.DataType` in `backend/internal/handlers/tables.go`, and `FIELD_DATA_TYPES` here — plus the `tables.fieldTypes.*` label key in all six locales. **No migration is needed**: `table_field_definitions.data_type` is unconstrained `TEXT` and row payloads stay JSONB, so the type is metadata about the value, never a column type. And **the type is not a write-time constraint** — `validateRowPayloadCtx` (`table_rows_public.go`) enforces only required-presence and uniqueness, so a field declared `number` will accept `"hello"` when written through the public token API. `coerceFieldValue` runs in the SPA's own editors only; treat it as an input affordance, not a trust boundary. `fieldTypeMeta()` falls back to `text` for an unknown string so a type written by a newer client still renders on an older one.

The type also selects the SQL cast in the filter DSL via `typedCompareExpr` (`backend/internal/handlers/data_source_query.go`). Two vocabularies meet there — `inferFieldType`'s inferred set (`number`/`boolean`/`date`/`string`) and a table's declared `data_type` — and they disagree on the temporal names, which was a live bug: a declared `datetime` missed the `date` branch and silently compared as **text**, so range filters on a timestamp field ordered lexicographically. `typedCompareExpr` now accepts both vocabularies (`number`/`integer` → numeric, `date`/`datetime`/`time` → timestamptz). Extend it when adding a type that needs a non-text comparison.

**Starter fields per entity kind** (`src/lib/table-starter-fields.ts`, 2026-08): a new table opens pre-filled with the standard column set for the entity kind the user picked, instead of one blank row. A hand-built table and an ingested source both land in `data_source_rows` and the layer editor can't tell them apart — it reads the payload — so a "Marker / POI" table that doesn't carry the marker sample file's payload keys silently breaks the v3 editor's `suggestField()` coordinate auto-detect, external-code match and `linked_shape_name` attribute joins.

`starterFieldsForKind(kind)` derives the set from `SAMPLE_SPECS` (`src/lib/data-link/sample-records.ts`) rather than a fourth hand-kept per-kind manifest — that file already backs the sample downloads the user compares against, so the two can't drift. It maps `SampleFieldType` → `FieldDataType` (`timestamp` → `datetime`, `latitude`/`longitude` → `number`, `enum` → `text` with the allowed values folded into the description), drops `custom.*` columns (a dot doesn't survive the form's key slug), applies a small label/type `OVERRIDES` table for keys the humaniser can't do justice to, and marks `external_code` unique — it's the upsert key. `external_code` / `lng` / `lat` / `linked_shape_name` are seeded as ordinary payload fields because `writeOneRow` (`import_pipeline.go`) stores the raw import row **unmodified** as the payload and derives `entity_key` / `position` / `linked_shape_name` *in addition*, so this is exact parity with ingest, not duplication.

Seeding is non-destructive. `SchemaBuilder` seeds on create and re-seeds on a kind change **only while the seeded list is still byte-identical to what was seeded** (`signatureOf` over key+label+type+required+unique); once the user edits anything, or in edit mode, their schema wins and the kind's missing columns are offered through an amber "Add them" banner instead. (The old `TableFormPanel` side-panel form was removed in 2026-09 — Integrations now sends table creation to `/tables/new`.)

Two helpers close the loop on row entry. `identityField(fields)` mirrors `rowEntityKey`'s fallback list (`external_code` → `externalCode` → `id` → `name`) and `coordFields(fields)` mirrors `rowCoord`'s column names (lng ∈ `lng`/`longitude`/`long`/`x`, lat ∈ `lat`/`latitude`/`y`). `CreateRowDialog` uses them to take the row's `entity_key` from the identity column and stamp `position` from the lng/lat pair — otherwise a seeded required `external_code` plus the dialog's own `entity_key` input asks for the same value twice. When no identity column exists the standalone `entity_key` input reappears.

Seeded **labels are English on purpose**: they become `table_field_definitions.field_label`, which is row data rather than UI chrome, so translating at seed time would freeze whichever language the creator happened to be using and show it to everyone else. They're pre-filled into editable inputs. The surrounding chrome is translated normally. (`EntityKindPicker` in the same component family is English-hardcoded for the same reason.)

**Frontend wiring**: tables are managed on `/tables` and `/tables/:id`; Integrations lists them as compact cards that link there. `src/components/data-link/table-api-reference.tsx` holds `TableApiReferenceDialog` (the 12 endpoints with curl, inline on the table's API tab or as a dialog); key management lives in `table-api-keys.tsx` (`TableTokensPanel`, `MintedKeyCard`). The old `tables-section.tsx` (`TableCard`, `TableFormPanel`) was deleted in 2026-09. Create flow is schema-only — no token-label input — because the backend auto-mints a "default" token on create and returns the plaintext in `tokens[0].token`. Each `TableCard` has an "API reference" button (Code icon) that opens a dialog listing all 12 endpoints with method + path + curl examples + the bearer-token header pattern + the table's field schema, so the user can copy-paste working requests without leaving the SPA. The SourceEditorDialog handles both new-table and edit-table targets via the `EditTarget` discriminated union. An SSE listener on `/integrations` watches for `data-sources` events and invalidates the `dataSources` + `tables` queryCache prefixes so table mutations + row writes land instantly across open tabs. The Data Link editor v3's source picker already includes table-kind sources (it pulls from `apiDb.dataSources.toArray()`, which sees them), and `fetchLayerRows` is source-kind-agnostic — it branches on `sourceId` vs `streamId`, never on kind — so a DataLinkConfig pointing at a table source flows through the existing match-resolver pipeline without a per-source branch. Picking one was nonetheless unsaveable until 2026-08: the v3 `canSave` still required a resolved `streamId`, which a table can never have, and the backend still carried `validate:"required"` on `StreamID`. Both are fixed — the gate now needs *one of* `sourceId`/`streamId`, and the amber "missing mirror stream" banner is suppressed for table sources in favour of a neutral note. The one mode still requiring a stream is `track` (`STREAM_ONLY_MODES`), whose sub-renderer reads `entity_events` directly rather than through `fetchLayerRows`; its card is disabled when no stream resolves. Table history lives in `data_source_row_events` (`GET /tables/{id}/events`) and has no frontend client yet — wiring one is what would let `track` support tables.

**Per-table page** (`/tables/:id` — authed, rendered by `src/routes/table-detail.tsx`; redesigned 2026-09). Tabs are URL-synced (`?tab=records|api|schema`):
- **Records** — `DataGrid` → `TableRecordsDialog inline`. Columns use field *labels* with a type icon; the key column is sticky at the start and the actions column (History, Delete) sticky at the end. When a named identity field exists — or a unique field equals the row key on every loaded row (e.g. `sku`) — that field is shown once, as the key column. Sort by clicking the Key / Timestamp / Updated headers (backend allow-list). Page + sort live in the URL inline and in memory in the Integrations dialog. Inline edit: click / Enter / F2, the input selects its value, Enter saves, Esc cancels, an unchanged value sends nothing, a saved cell flashes. **Delete is immediate with an Undo toast** (Undo re-upserts the old payload + position) — no confirm. Loading is derived from a query key (no set-state-in-effect); skeleton rows on first load, dimmed rows while paging, `QueryError` on failure, `EmptyState` with Add row / View API, a "page is empty" state for stale `?page=`. `TableRowHistoryDialog` is a **non-modal side Sheet**: newest-first timeline, op dot (created/updated/deleted), relative time, field-label diffs.
- **API & access** — `ApiDocsViewer` renders three cards: **API keys** (`TableTokensPanel` in `table-api-keys.tsx`: list with Active/Revoked + created/last-used, create form, `MintedKeyCard` one-time reveal that closes if that key is revoked, revoke via `ConfirmDialog`; owner/admin only via `RoleGate`), **Endpoints** (`TableApiReferenceDialog inline`: copyable base URL + auth header, 12 endpoints as `<details>` rows with method chips and a copyable curl, first open), **Pull from a REST API** (`TableExternalSourcePanel bare fields=…`: status line — not polling / every N s / last run + result — then the form; http(s) URL + ≥30 s interval validated client-side; Save/Start → toast; Stop → `ConfirmDialog`; mapping values suggest the table's field keys via `<datalist>`).
- **Schema** — `SchemaBuilder` in edit mode (owners/admins; save → toast + refetch), otherwise a read-only field list.

`TableCard` on `/integrations` keeps "Records" and "API reference" as modal quick-peeks (same components, `inline` off).

#### External source polling (auth + tenant — `/api/v1/tables/:id/source`)

Three endpoints mounted inside `TablesRouter`'s `/{id}` block to configure the external REST polling binding on a table-kind source. The binding lives in the existing `data_sources.config` JSONB column (keys: `pollUrl`, `pollHeaders`, `pollJsonPath`, `pollEntityKeyField`, `pollFieldMapping`, `pollPositionLatField`, `pollPositionLngField`) plus `data_sources.interval_seconds` for the cadence — no new sidecar table.

- `GET    /api/v1/tables/{id}/source` — returns the polling config extracted from `config` JSONB (so the SPA doesn't parse the raw JSONB) + `intervalSeconds` + `lastRunAt` + `lastResult` for the integrations panel's status display.
- `POST   /api/v1/tables/{id}/source` — set or replace the binding. Body: `{ pollUrl, pollHeaders?, pollJsonPath?, pollEntityKeyField?, pollFieldMapping?, pollPositionLatField?, pollPositionLngField?, intervalSeconds }`. Empty `pollUrl` = "stop polling" (clears the poll* keys from config and nulls `interval_seconds`). Preserves any non-poll keys already in `config` (e.g. integrations-panel prefs). Returns the updated `TableResponse`. Broadcasts a kind-wide `ENTITY_UPDATED` for `data-sources` so any open Integrations page refetches.
- `DELETE /api/v1/tables/{id}/source` — clears the binding (same as POST with empty `pollUrl`).

**Polling worker** (`backend/internal/polling/worker.go`, started by `cmd/api/main.go` after the object store is ready): stdlib `time.Ticker` on a 60s tick (no cron library — schedules are simple intervals here, not cron expressions). Each tick calls `q.ListPollableTableSources` (queries: `data_sources.sql`) which returns up to 50 table-kind rows with a non-empty `config->>'pollUrl'` AND `interval_seconds > 0` AND `(last_run_at IS NULL OR last_run_at + (interval_seconds * '1 second'::interval) <= now())`, ordered `last_run_at NULLS FIRST`. Bounded concurrency (`maxConcurrent = 8`) via a channel semaphore so 50 due sources don't fan out into 50 goroutines. Each poll runs in its own goroutine:
1. HTTP GET with the configured headers (30s timeout, 10 MB body cap).
2. Parse JSON, walk the dotted JSON path (`walkJSONPath` — empty path means the root is the array).
3. For each item in the array (cap 1000 per source): apply the field mapping (unmapped keys pass through with their external name; the entity-key field is stripped from the payload) and call `handlers.UpsertTableRow` — the shared helper the bearer-token surface uses, so the poll goes through the same validation + audit trail (`data_source_row_events`) as a bearer-token write.
4. `q.UpdateDataSourcePollResult` writes `last_run_at = now()` + `last_result` (short status string like `ok: 42 rows` / `ok: 40, errors: 2` / `error: connection refused`).
5. On any successful upsert, broadcast `ENTITY_UPDATED` for `data-sources` so the integrations page + any open map re-fetches. Kind-wide, not per-row — same pattern as the bulk-upsert surface (see docs/pitfalls-backend.md on synthetic zero id).

**Single-instance by design**: the worker state is process-local, and v1 deploys are single-instance. A horizontally-scaled deploy would need a coordination layer (Postgres advisory lock, Redis lease) to avoid every instance polling the same source. Same caveat applies to the per-token rate limiter and the auth rate limiter.

**Context-only helpers for non-HTTP callers**: `table_rows_public.go` exposes `UpsertTableRow(ctx, q, tenantID, sourceID, req, fields)` and `ListTableFields(ctx, q, sourceID, tenantID)` as exported wrappers around the existing `upsertRowPayloadCtx` / `listFieldDefsCtx` context-only variants. The polling worker has no `*http.Request` so it can't use the r-based helpers — these wrappers let it reuse the same validation + upsert path as the bearer-token surface with zero duplication.

#### PDF floor-plan import (auth + tenant)

Mounted at `/api/v1/pdf` by `handlers.PDFRouter(pdfRenderer, objectStore)`. Both endpoints are **multipart** with a `file` part and an optional `password`. See §6.11 for the renderer and §5.12 for the SPA flow.

- `POST /api/v1/pdf/inspect` → `{ pageCount, pages[], suggestedScales[], suggestedDpi, maxDimensionPx, hasThumbnails, thumbnailPageCap }`. Each page carries `{ index, widthPoints, heightPoints, widthMm, heightMm, sheet?, orientation, thumbnail?, suggestedWidthMeters? }`. Thumbnails render at 24 DPI as inline data URLs (never stored) and are emitted only up to `maxThumbnailPages` (24) — beyond that the picker degrades to a page-number input. **A thumbnail failure never fails the call**: a page that won't preview can still be rendered.
- `POST /api/v1/pdf/render` (+ form fields `page`, optional `dpi`) → `201 { url, mimeType, naturalWidth, naturalHeight, bytes, page, requestedDpi, effectiveDpi }`. Rasterizes one page, stores the PNG via `store.KeyFromData`, and returns a relative `/files/<key>` URL. The first six fields **mirror `POST /images/upload` exactly** so the SPA feeds the response into the existing placement draft with no second code path. An absent `dpi` means "pick the best that fits". `effectiveDpi` is frequently **below** `requestedDpi` (see §6.11) and the UI surfaces it rather than assuming.

**The uploaded PDF is deliberately never persisted.** Storing it would create an object with no DB row pointing at it, which `cmd/cleanup-orphans` would correctly reclaim out from under us. The browser still holds the `File`, so the render step re-sends the bytes — that costs upload bandwidth and buys a completely unchanged file-lifecycle story.

Error mapping (`writePDFError`) — `ErrPasswordRequired` → **422** (the request authenticated fine; it's the *document* that needs a secret, so 401 would be misleading), `ErrNotAPDF` / `ErrTooManyPages` / `ErrPageOutOfRange` → 400, `ErrTooLarge` → 413, anything else → 500.

**When PDFium fails to initialise at boot** the routes stay mounted and answer **503** with `pdf conversion is unavailable on this server`. Returning 404 instead would be indistinguishable from a client typo, and one broken feature is not a reason to refuse every request.

#### CAD drawing import (auth + tenant)

Mounted at `/api/v1/cad` by `handlers.CADRouter(store)` — the object store is the only argument, because the second call writes the rendered PNG and nothing else is kept. Both endpoints are **multipart** with a `file` part. The format is chosen by content, not by filename. See §6.12 for the reader and docs/cad-import.md for why it is hand-written.

- `POST /api/v1/cad/inspect` → `{ format, version, release, producer?, units, unitsName, unitsDeclared, unitsConfident, metersPerUnit, unitGuesses[]?, widthMeters, heightMeters, min, max, headerMin?, headerMax?, entityCount, detachedEntities?, entityKinds{}, blockCount, layers[], missingBlocks[]?, missingXrefs[]?, truncated }`. Each layer carries `{ name, color, visible, locked, plottable, entityCount, annotation? }`, the counts being that layer's share of the **flattened** geometry (so a layer whose content lives inside blocks reports what it actually contributes) and `annotation` being `cad.IsAnnotationLayer`'s read of whether the layer describes the *drawing* rather than the building — a title block, a dimension run, a hatch pattern — omitted when false. `unitsDeclared` means "`units` came from the file", **not** "the file said something" — `cad.ResolveUnits` sets a declaration aside when the extents contradict it, and then the answer is a guess like any other. `unitGuesses` carries the ranked `cad.GuessUnits` list whenever `unitsDeclared` is false, so both a missing `$INSUNITS` and a falsified one become a question rather than an assumption. Every field marked `?` is `omitempty` on the Go side, so a client must read each as possibly absent.
- `POST /api/v1/cad/render` (+ optional form fields `layers` — newline-separated, because a layer name may legally contain a comma; absent means the whole drawing — and `units`, an INSUNITS code overriding the file) → `{ url, mimeType, naturalWidth, naturalHeight, bytes, widthMeters, heightMeters, pixelsPerMeter, units, unitsName, metersPerUnit, entityCount, detachedEntities?, truncated }`. **The first five fields are exactly what `POST /images/upload` returns**, which is what lets a rendered drawing reuse the placement draft a PDF page or a photo already goes through — no new shape kind, no migration, no second placement path. The next three are what a PDF cannot supply: a drawing is authored in real-world coordinates, so its ground size is *known* rather than inferred from a sheet size, and `widthMeters`/`heightMeters` describe the box the **pixels** cover, margin included (`cad.PathBounds` plus the raster's margin — not the entities' extents, which differ by up to a sagitta because chords sag inside the curves they replace and text contributes extents while emitting no points). The client places by the corner and stretches to that size, so the two have to describe the same box.

The layer filter runs at **flatten time**, before extents are measured — so an unticked title block shrinks both the rendered sheet and its stated ground size to the building. Debris is trimmed (`cad.TrimOutliers`) *before* the scale is chosen, because a stray entity a kilometre off poisons the unit guess and eats the fixed 4096 px budget; what it dropped comes back as `detachedEntities`.

**The source drawing is never persisted** — same reasoning as PDF above; the browser re-sends the bytes for the second call. Only the rendered PNG is stored, on an ordinary `images` row, where `images.image_url` is already covered by `CountFileURLReferences` / `ListReferencedFileURLs` / `shapeDeleteWithFile`. Error mapping (`writeCADError`): `ErrNotDWG` → **400**, `ErrUnsupportedVersion` → **422** (a real drawing we cannot read yet, which is not a malformed request), `ErrNoGeometry` → **422**, `ErrMalformed`/`ErrTruncated` → **400**, and **anything else the reader returns → 422 carrying the reader's own message**, warn-logged. That last branch is the load-bearing one: the container layer reports a bad file in prose without reaching for a sentinel (`dwg: no section "AcDb:Handles"`, `dwg: page 3 runs past end of file`), so a 500 default meant a real drawing that would not open came back as "internal server error" — blaming the server and withholding the one sentence that says what is wrong with the file. The size caps (`ErrTooManyEntities`, `ErrTooManyPoints`) are deliberately *not* mapped to a status: a drawing that hits either comes back **partial with `truncated: true`**, because a drawing too big to import whole is still worth importing in part — a partial drawing is useful, an unannounced partial drawing is not.
- `GET /api/v1/data/rows`, `/bins`, `/live`, `/live/events`, `/files`, `/runs` — paginated Data-screen tab endpoints. Each returns `{ rows, total, page, pageSize, stats, filteredStats }` mirroring the warehouse-summaries shape. Sort allowlist per tab, `pageSize` capped at 200. Every row row-set joins to the source table so `sourceArchived` / `streamArchived` badges are stamped at query time.
- `DELETE /api/v1/data/{surface}/{id}`, `POST /api/v1/data/{surface}/bulk-delete` (`{ ids: number[] }`, capped 500), `POST /api/v1/data/{surface}/purge` (`{ sourceId | streamId, before? }`) for `rows`, `bins`, `live/state`, `live/events`, `files`, `runs` — **editor+ only** (`dataRoleGate`; viewers get 403). Every mutation calls `BroadcastEntityEvent("ENTITY_DELETED", "data-events", ...)` — the frontend's Data page subscribes via `subscribeExternalSSE` and invalidates all five tab caches. `data-events` is intentionally **NOT** in `useSSE.ts`'s `VALID_KINDS` set (which drives `spatial-store` reloads) — it fans out via the external listener bus instead.
- Migration `0021_soft_delete_data_sources.up.sql` — adds `deleted_at TIMESTAMPTZ NULL` to `data_sources`, `streams`, `connections`. All `List*`/`Get*` queries for these tables now filter `WHERE deleted_at IS NULL`; new `SoftDelete*` and `List*IncludingArchived` variants let the Data screen see archived rows. `deleteDataSourceMirror` in `data_link.go` was refactored from a 3-way hard delete to a 3-way soft delete so `entity_states.stream_id CASCADE` never fires on integration "deletion".
  - Response shape: `{ rows: [{id, name, color, address, shareToken, isPublic, rackCount, binCount, occupiedCount, occupiedPct, assetCount, floorCount, updatedAt}], total, page, pageSize, stats: { totalWarehouses, totalBins, occupiedBins, totalAssets }, filteredStats: { warehouses, bins, occupied, assets, avgOccupiedPct } }`.
- `GET /api/v1/warehouse-summaries/stats` — stats-only sibling. Returns the same `stats` block alone. Used by `/dashboard` KPI cards so they don't pull a page of rows just to read totals.
- `POST /api/v1/{lines,polygons,circles,doors,stairs,grids}/bulk` — create many rows of one kind in **one request and one transaction**. Body `{ items: [<the kind's normal create request>, …] }` → `201 { created, items[] }`. Built for the since-removed CAD entity extraction, where a single drawing recognised as ~1,100 walls: the spatial store's flush is sequential, so `createLocal` per row would be 1,100 serial POSTs. **Currently without a caller**, and kept because any future bulk-create path needs exactly this and the reasoning behind each property is worth more than the ~40 lines. Adding a seventh kind is one `r.Post("/bulk", shapeBulkCreate(…))` line beside the kind's existing routes plus a `pool *pgxpool.Pool` on its router. Three properties are deliberate: **every item is validated before any is written**, so a body with one bad row is rejected whole rather than half-applied; the writes share **one transaction**, so a mid-run failure leaves nothing behind; and it broadcasts **one kind-wide SSE event** rather than N per-row ones (see below). Caps: 10,000 rows and a 32 MB body, checked independently because either alone can be the binding one.
- `POST /api/v1/bulk-assign` — batch warehouse + floor-plan reassignment across every shape kind (polygon / grid / marker / circle / line / model / stair / text_label / image / door). Request body: `{ zoneId?, floorPlanId?, kinds: { <singular>: id[] } }` where the two write-fields are tri-state (absent = skip, `null` = clear, number = assign). One `UPDATE ... WHERE id = ANY($ids)` per kind, tenant-scoped, followed by SSE broadcasts. Response: `{ updated: { <singular>: count } }`. Replaces the previous per-id PATCH loop from `BulkAssignDialog`.

#### AI floor plan detection (auth + tenant, opt-in per tenant)

Mounted at `/api/v1/floorplans` by `handlers.AIFloorPlansRouter(queries, objectStore, cfg)`. Off by default: **both** `SGV_AI_WORKER.URL` must be set to a reachable Python ai-worker (server-wide enable) and `app_settings` key `ai_floorplan_enabled:tenant:{id}` = `"true"` (per-tenant opt-in, privacy default) must be true. The Go handler is a thin dispatcher over `aiworker.Client`; the actual detection runs in the Python service (`backend/ai-worker/`) as a Dramatiq actor consuming from Redis and reading image bytes directly from the shared MinIO bucket. Pipeline: SAM 2 automatic mask generator → OpenCV/Shapely vectorize → heuristic classify → Tesseract OCR + point-in-polygon label fusion → pixel→lng/lat reproject. Full architecture in `docs/ai-floorplan.md`.

- `POST /api/v1/floorplans/{imageId}/detect` (+ optional body `{ region?: { x0, y0, x1, y1 } }` normalized [0,1] on the source image — passed through to the worker, which crops the image array before SAM sees it and composes the region into the reprojection frame so lng/lat still maps back to full-image world coords) → `202 { jobId }`. Order of guards: tenant present → server-wide enable (`cfg.Worker.BaseURL` non-empty) → per-tenant hourly rate limit (KeyedLimiter, `SGV_AI_WORKER.HOURLY_RATE_PER_TENANT` per hour with burst `SGV_AI_WORKER.HOURLY_BURST_PER_TENANT`, 4h idle TTL) → per-tenant opt-in flag → monthly cap (`CountAIJobsThisMonth < SGV_AI_WORKER.MONTHLY_CAP_PER_TENANT`) → image owned by tenant. Creates `ai_jobs` row `status='pending'` synchronously (`model='python-cv'`, `worker_task_id=''`), then spawns a detached goroutine (context.Background + `Worker.PollMaxDuration + 15s`) that flips to `running` → `aiworker.Client.Enqueue` (POST /detect on the worker, returns `taskId`) → `SetAIJobWorkerTaskID` → `aiworker.Client.Poll` (GET /detect/{taskId} every `SGV_AI_WORKER.POLL_INTERVAL`, default 3s; sentinel `ErrTaskFailed` on worker-side failure) → decode `{detections, pipeline_version}` → `CompleteAIJob`. Every transition broadcasts SSE `entity="ai-jobs"` (not in `useSSE.ts` `VALID_KINDS`, routes to `subscribeExternalSSE`).
- `GET /api/v1/floorplans/jobs/{jobId}` → `{ id, imageId, status, model, promptVersion, region?, detections?, acceptedIds?, rejectedIds?, error?, tokensUsed, durationMs, createdAt, updatedAt }`. `detections` is null until `status='done'`; empty array on `done` means "pipeline saw nothing", not "failed". `promptVersion` is retained in the schema but empty in Python-CV rows (no LLM prompt); the worker's `pipeline_version` string is logged from Go on completion for support triage. SSE clients GET this after each `ai-jobs` event to refresh their view.
- `POST /api/v1/floorplans/jobs/{jobId}/cancel` → `{ canceled: true }`. Flips `status='canceled'` if still pending/running (no-op otherwise). Best-effort: the Dramatiq actor + Go poller run to completion; there is no worker-side cancel signal yet, so a running pipeline finishes before the row is retroactively marked canceled — the wasted CPU still spent.
- `POST /api/v1/floorplans/jobs/{jobId}/feedback` (`{ acceptedIds: string[], rejectedIds: string[] }`) → `{ recorded: true }`. Writes to `ai_jobs.accepted_ids` / `rejected_ids` for accuracy telemetry. Fire-and-forget from the frontend on dialog close; no user-visible dependency.

Geometric detector prototype (2026-10): `backend/ai-worker/src/aiworker/geometric/` — stroke-based walls / doors / racks / rooms + a review package for a vision model (picks and names only) + `evaluate.py` scoring against a hand-built layout. CLI `python -m aiworker.geometric`; not yet wired into the Dramatiq actor. Tests: `tests/test_geometric.py` (synthetic plan). Details and baseline scores in `docs/ai-floorplan.md` § Geometric detector.

Detection coord contract: the Python pipeline computes shapes in pixel space (SAM's native coords) and reprojects to Mapbox lng/lat once at emit time in `backend/ai-worker/src/aiworker/pipeline/reproject.py::pixel_to_lnglat` using the image's persisted `startLng/startLat/currentLng/currentLat` bbox + `rotation` (turf-parity via equirectangular approximation, < 1 mm error at floor-plan scale) + optional `crop` percentages carried on the enqueue payload. Mirrors `src/lib/image-generators.ts::imageUVToLngLat` (forward) and `imageLngLatToUV` (inverse, used by the region-select drag). Round-trip test in `backend/ai-worker/tests/test_reproject.py` (7 samples, < 1e-9 drift). Domain-vocabulary remap (`Kind.WALL → "aisle"`, `Kind.ROOM → "area"`, door/stair 1:1) lives at the Python emit boundary in `run.py::_KIND_TO_SPA`, guarded by `tests/test_run_emit.py` so a new kind added without a SPA mapping fails loud instead of silently producing a no-op accept.

#### Tenant member management (auth + tenant, owner/admin only)
- `GET    /api/v1/members` — list members of current tenant (any member can read)
- `POST   /api/v1/members` — invite existing user by email + role; owners/admins only. Invitee must have signed up first (no email-invite tokens yet).
- `PATCH  /api/v1/members/{userId}` — change role (cannot demote an owner)
- `DELETE /api/v1/members/{userId}` — remove member (cannot remove the owner)





#### User profile (auth, no tenant)
- `GET   /api/v1/profile` — current user's full profile
- `PATCH /api/v1/profile` — update `displayName, bio, location, pronouns, jobTitle`. Field lengths capped server-side (display 80, bio 1000, location 120, pronouns 40, jobTitle 120).
- `POST  /api/v1/profile/avatar` — multipart `file` upload; 5 MB cap; must be `image/*` MIME type. Stored via the same object store as warehouse images.

#### Tenant-scoped catalog (auth + tenant)
- **Zones**: CRUD + `/zones/{id}/duplicate` (clones shapes + bins)
- **Shapes**: `GET|POST /api/v1/{grids|polygons|circles|lines|markers|images|models|image-planes|text-labels|stairs|doors}` and `/{id}` for `GET|PATCH|DELETE`
- **Bins**: full CRUD + `PATCH /bins/bulk-upsert` (for imports)
- **Metadata**: `attribute-definitions` (with `?zoneId=X` filter), `style-rules`
- **Data link**: `connections`, `streams`, `data-sources`, `data-sources/{id}/probe`, `data-sources/{id}/upload`
- **Import pipeline**: `POST /import-jobs/preview` (multipart file + plan), `POST /import-jobs/commit`, `GET /import-jobs[/{id}]`
- **Live queries** (Slice 6c2 — one generic pipeline instead of five per-entity ones):
  - `POST /api/v1/streams/{id}/ingest` — publisher writes a batch of `{entityKey, payload, position?, ts?}` events (upserts `entity_states`, appends `entity_events`). Limits: 8 MB body, 5000 events (413 above either). `ts` is RFC 3339 or epoch seconds/ms (number or numeric string); absent = server now; unreadable or >5 min in the future rejects that event. Response `{accepted, rejected, stale, streamId, errors: [{index, error}]}`. **Out-of-order guard**: an event older than the stored state is logged to `entity_events` but does not overwrite `entity_states` (counted as `stale`).
  - `GET  /api/v1/streams/{id}/entities` — latest state per entity for the stream.
  - `GET  /api/v1/streams/{id}/events?window=SEC&limit=N` — rolling event log (heatmap + track render modes).
  - `GET  /api/v1/entity-states` — tenant-wide join with `streams` so the viewer sidebar groups every live record by `entityType` in one round-trip.
- **Cross-entity**: `entity-references`, `user-models`, `correlation-rules`, `alerts`, `audit-log`

### 6.5 Authentication

Two auth modes coexist:

**JWT (per-user)** — set via `SGV_AUTH.JWT_SECRET`.
- Mint via `POST /api/v1/auth/signup` or `/auth/login` → returns `{token, user, tenants[]}`.
- Pass via `Authorization: Bearer <jwt>`.
- HS256 with claims `{uid, email, iat, exp}`. Lifetime 7 days, no refresh tokens.
- `auth/me` endpoint validates the token + returns fresh memberships.
- Implemented in `internal/auth/{hash.go,jwt.go}` (bcrypt cost 10 + stdlib HMAC — no external JWT library).
- `OptionalJWTMiddleware` validates the token if present. Falls through silently if absent. **Malformed/expired tokens** are rejected with 401 (an active signal).
- **Session revocation** (`internal/api/session_revocation.go`, 2026-09): after the signature check, the middleware rejects (401, code `session_revoked`) any token whose `iat` < `users.password_changed_at`. Lookups are cached per user for 30 s; the instance that performs a reset primes its own cache (`api.NoteSessionRevocation`) so the cut-off is immediate there, other instances catch up within the TTL. Enabled in `main()` via `api.EnableSessionRevocation(queries)` — tests that never call it keep the old behaviour.
- `TenantMiddleware(queries)` cross-checks: when a JWT user requests a `X-Tenant-Id`, membership in `user_tenants` is verified. 403 otherwise.

**API Key (legacy / dev / e2e)** — set via `SGV_AUTH.API_KEY`. Empty disables auth in dev.
- Pass via `X-Api-Key`, `Authorization: Bearer <key>`, or `?apiKey=<key>` (for WS).
- `APIKeyMiddleware` short-circuits when a JWT is already authenticated (so JWT supersedes the key).

**Tenant**: extracted from `X-Tenant-Id` header → request context. For JWT users, also validated against `user_tenants`.

**Bootstrap admin** — two options, both idempotent:
- **Auto on startup** — set `auth.bootstrap_email` + `auth.bootstrap_password` in `config.dev.yaml` (or `SGV_AUTH.BOOTSTRAP_EMAIL` / `SGV_AUTH.BOOTSTRAP_PASSWORD` env vars). On startup, after migrations, if no user with that email exists, the API creates one, stamps them verified (`users.verified_at`), links them as owner to every existing tenant — the demo workspace included — and creates an "Admin workspace" when the DB has none, or only the demo workspace. Runs after the demo seed in `main()`. Does NOT rotate the password if the user already exists.
- **Manual** — `SGV_CONFIG=config.dev.yaml SEED_EMAIL=... SEED_PASSWORD=... go run ./cmd/seed-admin`. Same effect (verified user), plus it WILL rotate the password if the user exists (useful as a password reset).

**Demo workspace** (`internal/demo`, 2026-10). On API start, after the object store is up and before the bootstrap admin, `demo.Seed` loads the embedded pack into the database **once**: only when `tenants` is empty and `app_settings` has no `demo:seeded` key (written on success, so deleting the workspace — or every workspace — never brings it back). Gated by `SGV_DEMO.ENABLED` (default `true`; `false` in `config.prod.example.yaml`; compose `SPATIAL_MAP_DEMO`); a failure is logged, not fatal, and the next start retries. Contents: five facilities (Hospital, Retail Mall, Acme Warehouse, Acme Supermarket, Retail Mart Store) with floors, every shape table, racks + bins, attribute definitions, style rules, 19 data links with their streams/connections and 19 tables (field definitions, rows, row history), 84 reports incl. the facility report sets, linked-data reports and the full-map RFID report, the Anti-theft solution, and 11 floor-plan images (stored through the `ObjectStore`, keys prefixed `demo-`). Mechanics: files first, then one transaction under `pg_advisory_xact_lock` — create the `is_demo` tenant, then per table `INSERT … OVERRIDING SYSTEM VALUE SELECT … FROM jsonb_populate_recordset(NULL::t, $1)` over the columns both the pack and the live schema have (a pack from an older or newer schema still loads), `tenant_id` replaced with the new id, then `setval` past the kept ids. Row ids are the exporter's originals (ids are global, so facilities from several source workspaces merge without collisions). Timestamps move forward: each table's rows + history so its newest row lands at seed time (spacing kept), everything else by the time since export. **Joining:** `authCompleteSignup` adds every new account to the demo workspace as `editor`, grants view on all its reports (`GrantTenantReportsToUser` — editors see a report only with a grant) and lists it first in the response, so a new user lands in it (`tenant-store` picks `tenants[0]`). Owners can delete it from the Workspaces page like any other. **Regenerating the pack:** `cmd/demo-export` (read-only against the source DB; flags `-zones`, `-model-map` for uploaded 3D models → bundled ones (others dropped — licences unknown), `-skip`, `-blank-images` (replace a floor-plan picture that shows third-party logos with a plain sheet; the floor and its shapes stay), `-set table:id:column=value`, `-rewrite` (regex scrub of every string; `cmd/demo-export/rewrites.json` swaps real store brands for generic names)). It strips tenant ids, user references, share tokens, connection credentials and source IPs, keeps one set of facility sources and remaps report specs to it. Test: `internal/demo/demo_test.go` loads the real pack into a PostGIS container.

For local dev, set `SGV_AUTH.BOOTSTRAP_EMAIL` / `SGV_AUTH.BOOTSTRAP_PASSWORD` (Docker Compose: `SPATIAL_MAP_ADMIN_EMAIL` / `SPATIAL_MAP_ADMIN_PASSWORD`) to get a ready-to-use admin on first boot. In production mode the API refuses to start with placeholder secrets.

**Rate limiting** — `internal/api/ratelimit.go` provides a `KeyedLimiter` (token bucket per string key, `golang.org/x/time/rate`-backed, with idle-key eviction after 1 h) plus a `RateLimitByIP` chi middleware factory and an `api.ClientIP` helper. `ClientIP` honours `X-Forwarded-For` / `X-Real-IP` **only** when the TCP RemoteAddr matches a configured trusted-proxy CIDR (`SGV_SERVER.TRUSTED_PROXIES` — empty by default, so headers are ignored). This is critical: an earlier iteration trusted the headers unconditionally, letting any internet caller rotate `X-Forwarded-For` per request to bypass every IP limit. Chi's `middleware.RealIP` is deliberately NOT used for the same reason. `SetTrustedProxies` accepts bare IPs (auto-widened to /32 or /128) and CIDRs; invalid entries surface as errors so boot fails fast rather than silently running with a broken allow-list. `AuthRouter` in `internal/handlers/auth.go` creates six limiters — one per-IP + one per-email for each of `/signup-request`, `/verify-otp`, `/login` — and wires per-IP as chi middleware while per-email checks run inside each handler after the JSON body is decoded (the email lives in the body, not headers). Chosen buckets: signup-request IP 1/min burst 3; signup-request per-email 1/15min burst 2; verify-otp IP 10/min burst 10; verify-otp per-email 1/10min burst 5 (the load-bearing OTP brute-force ceiling — ~150 attempts/day pushes the expected-case crack time for a 6-digit code past 18 years); login IP 10/min burst 10; login per-email 1/min burst 5. All counters are process-local — a restart clears them, and a horizontally-scaled deploy would need Redis. `complete-signup` deliberately has no limit because the 15-min scoped verification token already gates access.

**CORS** — `cors.Options.AllowedOrigins` is driven by `SGV_SERVER.ALLOWED_ORIGINS` (list). Empty = block all cross-origin (the safe default in prod). Dev seeds `http://localhost:5173` and `http://localhost:4173` in `config.dev.yaml`. Previously the code shipped `["*"]` which let any malicious origin phish OTP codes via a victim's browser hitting `/auth/signup-request` for a supplied email; the lockdown removes that vector.

**Password policy** — `auth.ValidatePassword` (`internal/auth/password_policy.go`) enforces: (1) length ≥ 12, (2) not on the exact-match common-password list (~40 top-abused strings), (3) no substring match against `password`, `qwerty`, `letmein`, `welcome`, `12345678`, `iloveyou`, `admin123` (catches `MyPassword123!` style variants), (4) at least 3 of {lowercase, uppercase, digits, symbols}. Runs server-side in `authCompleteSignup` so it can't be bypassed by tampering with the frontend. Client-side check in `signup.tsx` mirrors rule (1) for immediate feedback; server error messages surface the specific violation for rules 2-4.

**Timing-safe login** — `auth.DummyVerify` runs `bcrypt.CompareHashAndPassword` against a package-init-precomputed hash whenever `GetUserByEmail` returns `pgx.ErrNoRows`, so the login response time is indistinguishable between "user missing" and "user exists, wrong password". Both paths spend the ~60-80 ms bcrypt burns. Test coverage in `hash_test.go` pins the two costs to within 3x of each other; drift would silently re-open the enumeration side-channel.

**Email delivery** — `internal/mailer` sends OTP + notification emails. `SGV_MAIL.HOST/PORT/USERNAME/PASSWORD/FROM/FROM_NAME` selects the SMTP backend (auto-detected implicit-TLS on port 465, STARTTLS otherwise). When `SGV_MAIL.HOST` is empty (the dev default), the console mailer logs the OTP body to stdout so operators can grep `docker logs api` for the code without setting up SMTP first. Delivery runs in a background goroutine so a slow relay never stalls the signup request. Auth emails (`mailer/otp.go`: signup code, already-registered notice, reset code, password-changed notice) share one layout (`renderEmail`, "Spatial Map") and link to the SPA origin set by `mailer.SetAppURL(cfg.App.PublicURL)` at boot (`SGV_APP.PUBLIC_URL`, default `http://localhost:5173`).



### 6.6 Real-time delivery

- **SSE** (`/api/v1/events`) — catalog mutations on every Create/Update/Delete, delivered only to streams of the same tenant (filtered server-side since 2026-10; before that every client received every tenant's events and filtered in the browser). Non-blocking send (slow clients drop). No replay buffer (config has `replay_event_count: 100` but unused). Mounted by `useSSE` in the editor (`useEditorBootstrap`) and the viewer only.
- **Two broadcast functions, and the difference matters.** `BroadcastEntityEvent(type, entity, id, tenantID)` names one row, which is what lets a client fetch just that row. It **early-returns on `id == 0`**, and that guard is load-bearing rather than defensive: the id comes from reflection over the response struct, so 0 is what a *failed* reflection returns, and letting it through would turn a bug into a silent kind-wide reload. `BroadcastEntityKindEvent(type, entity, tenantID)` is the deliberate version of the same thing — it sends `id: "0"`, which `useSSE.ts` reads as "reload this entire kind". Bulk create uses it, because 1,100 per-row events would be 1,100 fetches for a snapshot the client is about to refresh wholesale anyway. Adding a bulk path means calling the kind-wide variant, **never** relaxing the zero-id guard.
- **WebSocket** (`/api/v1/streams/{token}/ws`) — per-token hub, multicast among connected clients. Drops messages on slow clients. The hub is removed when its last client leaves (`joinHub`/`unregister` under `hubsMu`). The server stores every message itself, so `useLiveStreamScheduler` does not re-POST messages from a `…/api/v1/streams/<token>/ws` URL to `/ingest` (it only refreshes `entity-states`); third-party WS URLs still go through `/ingest`.

### 6.7 File uploads

- **`ObjectStore` interface** at `internal/store/store.go`. Two backends today, selected by `SGV_STORAGE.TYPE`:
  - `local` — filesystem at `SGV_STORAGE.BASE_PATH` (default `./uploads/`). `internal/store/local.go`.
  - `minio` — S3-compatible MinIO bucket. `internal/store/minio.go`. Requires `SGV_STORAGE.MINIO_{ENDPOINT,ACCESS_KEY,SECRET_KEY,BUCKET,REGION,USE_SSL}`.
  - `minio-fallback` — MinIO primary + local disk read fallback (`internal/store/fallback.go`). Zero-downtime cutover mode: new uploads go to MinIO, legacy files on disk keep serving through a fallback read path. Every fallback hit is logged.
- **File serving is a proxy** either way: `GET /files/{key}` in `cmd/api/main.go:130` calls `objectStore.Get(ctx, key)` and streams the bytes. The DB always stores relative `/files/<key>` URLs — the MinIO endpoint is never exposed to the browser and BaseURL should stay relative for both backends.
- Image flow: multipart POST → `objectStore.Put(ctx, key, contentType, data)` → DB row gets `image_url`.
- 3D model flow: same, into `user_models` table with `model_url`. Inline `data` column kept for backwards-compat.
- Key generation: deterministic `{name}-{sha256[:12]}.{ext}` or timestamp-based `{sha256[:8]}-{unixNano}`.
- **Cutover procedure (local → MinIO)**: (1) boot `docker compose up minio`; (2) set `SGV_STORAGE.TYPE=minio-fallback` and restart the API — new uploads land in MinIO, legacy files still serve from disk; (3) run `make migrate-storage` to bulk-copy `./uploads/` into the bucket (idempotent, non-destructive); (4) set `SGV_STORAGE.TYPE=minio` and restart. `./uploads/` can then be deleted at leisure. See `cmd/migrate-storage/main.go`.
- **File lifecycle & cleanup** (added 0027 migration + `internal/handlers/file_cleanup.go`):
  - Every URL column (`images.image_url`, `image_planes.image_url`, `user_models.model_url`, `users.avatar_url`) is now tied to a physical delete when its row goes away.
  - **Per-row deletes** use `shapeDeleteWithFile` in `shape_crud.go` — fetches the URL, deletes the row, then calls `cleanupObjectURL` which refcounts against every URL column before physically removing the file. Content-addressed keys can collide across users (identical bytes → identical key) so refcount is required, not optional.
  - **Warehouse deletes** cascade to every zone-scoped table via `ON DELETE CASCADE` (migration `0027_cascade_zone_delete`). The `deleteZone` handler SELECTs `image_url` / `image_planes.image_url` for the zone BEFORE the CASCADE, then reclaims those files post-commit.
  - **User_models catalog deletes** count `models.config->>'modelAssetId' = 'user_<id>'` first. Returns `409 { placementCount, hint }` unless `?force=true`, then cascade-deletes the placements + row + file.
  - **Avatar replacement** in `profile.go` fetches the previous `avatar_url` before writing the new file, then calls `cleanupObjectURL` on the old key after the row is updated. Same-bytes reuploads collapse to the same key and cleanup is a no-op.
  - **Orphan sweeper** — `cmd/cleanup-orphans` (`make cleanup-orphans`, dry-run by default; `APPLY=1` to commit). Enumerates the store's `ListKeys`, diffs against `ListReferencedFileURLs` ∪ `ListOwnedFileKeys`, deletes the diff. Reclaims pre-fix orphans + acts as safety net for the "crash between DB commit and file delete" race.

### 6.8 Configuration

`config.dev.yaml` shape (overridable via `SGV_<SECTION>.<KEY>` env vars):

```yaml
server: { host, port, read_timeout, write_timeout, idle_timeout, shutdown_timeout }
database: { url, max_open_conns: 25, max_idle_conns: 25, conn_max_lifetime: 30m }
auth: { mode: apikey, api_key, jwt_secret (unused) }
websocket: { write_wait, pong_wait, ping_period, max_message_size: 64KB, replay_event_count: 100 }
migration: { on_start: true, path: "migrations" }
storage:
  # Backend selector: local | minio | minio-fallback
  type: local
  base_path: "./uploads"
  base_url: "/files"
  # MinIO — required when type is minio or minio-fallback
  minio_endpoint: "localhost:9000"
  minio_access_key: "..."
  minio_secret_key: "..."
  minio_bucket: "sgv-uploads"
  minio_region: "us-east-1"
  minio_use_ssl: false
```

**Config file resolution** (`internal/config/config.go` `Load`): explicit `SGV_CONFIG=...` wins; otherwise the loader auto-detects `config.dev.yaml` in CWD so `go run ./cmd/api` from `backend/` boots without sourcing an env file. Env vars still override any YAML value. `make dev` remains the canonical path when you want the committed `.env.development` overlay applied on top.

### 6.9 Notable patterns

- **Generic CRUD helpers** (`shape_crud.go`): `shapeCreate[Req,DBRow,Params]`, `shapeGet`, `shapeList`, `shapeUpdate`, `shapeDelete`, `shapeBulkCreate` — eliminate boilerplate across 10+ shape types. `shapeBulkCreate` is the only one taking a `*pgxpool.Pool` as well as `*db.Queries`, because it is the only one that needs a transaction of its own; the four routers that mount it (lines / polygons / doors / stairs) therefore take the pool too.
- **Partial PATCH**: fetch → JSON-merge → validate → update all fields. Allows UI drag/rotate without full payload.
- **WarehouseView envelope**: public endpoints return zone + all shapes + bins + aggregated live data in one response.
- **Synchronous import pipeline**: `/commit` blocks during execution (no background workers).

### 6.10 Known limitations / placeholders

Correlation engine, outbound webhook delivery, data retention, background jobs, soft deletes, full-text search — **all not implemented**. Tables exist for some (correlation_rules, alerts, audit_log) but no runner. (MinIO/S3-compatible storage IS implemented via `SGV_STORAGE.TYPE=minio` / `minio-fallback`; see §6.7.)

### 6.11 PDF rasterizer (`internal/pdfconv/`)

The render primitive behind §6.4's `/pdf/*` endpoints and §5.12's import flow. Three files: `pdfconv.go` (renderer + limits), `scale.go` (sheet + plot-scale tables), `pdfconv_test.go`.

**Why PDFium, and why WASM.** MuPDF, PyMuPDF and Ghostscript are all AGPL, which disqualifies them for a product we ship. PDFium is BSD-3; the `klippa-app/go-pdfium` wrapper is MIT. It runs on **wazero (pure-Go WASM)** rather than CGO, so builds stay cross-compilable and the renderer executes inside a sandbox with **no filesystem, no network** — `webassembly.Init` is called with no `FSConfig` at all. That matters because a PDF is a program, not a picture, and this one is arriving from users.

**Renderer lifecycle.** `New(Config)` compiles a ~5 MB WASM module and must be called **once at startup** — never per request. `cmd/api/main.go` does this at boot and `defer`s `Close()`. Failure is logged and left non-fatal; the routes then answer 503 (§6.4). `Config` tunes the worker pool: `MaxWorkers` (default 2 — each worker is a separate WASM instance with its own linear memory, so this multiplies peak memory), `IdleWorkers` (1, kept warm to skip instantiation cost), `AcquireTimeout` (30 s).

**`Limits` — guardrails, because a 40 KB file can describe a page that costs gigabytes to rasterize:**

| Field | Default | Why |
|---|---|---|
| `MaxBytes` | 256 MB | Reject oversized uploads before PDFium sees them |
| `MaxPages` | 2000 | A drawing set is tens of sheets; tens of thousands is abuse or the wrong file |
| **`MaxDimension`** | **4096 px** | **A GPU limit, not a memory one** — see below |
| `MaxPixels` | 4096² | Bounds total pixels independently of aspect ratio; a pathological 1:50 page could pass `MaxDimension` and still be huge |
| `MinDPI` / `MaxDPI` | 36 / 600 | Bound the request before the dimension/pixel caps apply |
| `RenderTimeout` | 90 s | PDFium can spend unbounded time on adversarial content streams |

**`MaxDimension` is the binding constraint and it is a GPU one.** The rendered PNG becomes a Mapbox `image` source, uploaded as a single WebGL texture. `MAX_TEXTURE_SIZE` is **4096 on a meaningful share of supported devices, and exceeding it does not warn** — the raster silently fails to draw or is downsampled to mush. 4096 is the largest value that renders everywhere.

**`clampDPI` lowers resolution rather than failing.** Given a requested DPI it solves both caps analytically (`dpi = px × 72 / points` for the edge, `dpi = √(px × 72² / (w·h))` for the area) and takes the minimum. A legible whole sheet beats a sharp fragment. The clamped value is reported back as `effectiveDpi` — an ARCH D sheet asked for at 300 DPI comes back at **113 DPI / 4068 × 2712 px**, and the UI shows that instead of letting the user believe they got 300.

**`scale.go` — the domain layer over the render primitive.** This is the part OSS doesn't give you:
- `standardSheets` — 17 sizes across ISO A, ANSI and ARCH series. `MatchSheet` compares both orientations with a **2 mm tolerance**, which absorbs the rounding that survives a CAD-plot → PDF round trip without letting adjacent sizes collide (the closest standard pair differs by ~13 mm). ARCH D (24×36") is overwhelmingly the most common floor-plan sheet.
- `CommonScales` — 18 plot scales that building drawings actually use (metric 1:20…1:1000, imperial architectural `1/8" = 1'-0"` etc. as ratios, imperial civil `1" = 40'`). `SuggestScales` ranks them per page. The API also accepts an **arbitrary denominator** — this list only drives the picker.
- `RealWorldSize(page, denominator)` / `ScaleForRealWorldWidth(page, widthM)` — the exact arithmetic and its inverse (§5.12).

### 6.12 CAD import (`internal/cad/`, `internal/cad/dwg/`)

**Status: reader done, HTTP surface live, frontend live (§5.13).** `dwg.Read(data) (*cad.Document, error)` exists and works: the drawing model, the DWG container layer, the object index, the R2007 string stream, nine geometry decoders (LINE, ARC, CIRCLE, POINT, SOLID, ELLIPSE, SPLINE, LWPOLYLINE and the POLYLINE/VERTEX/SEQEND chain), all four text types (TEXT and MTEXT with their escape and formatting languages resolved, plus the ATTRIB/ATTDEF pair), block definitions and their INSERT/MINSERT references, the shared handle stream, the LAYER and BLOCK_HEADER table records, and the `AcDb:Header` variable list are done and tested — so entities come out named by layer and by block rather than by handle, sorted into model space, block definitions and the paper-space sheets that are not the drawing, and the document knows what one drawing unit means in the real world. **84,993 entities plus 40 polyline chain parts across five fixtures at two release levels, every one landing exactly on its declared end.** Still open: HATCH, the LTYPE records (so `Layer.Linetype` is unset) and `AcDb:Classes`.

TRACE and 3DFACE are open **deliberately**: the corpus contains none, and the landing assertion is the only thing that can verify a field layout, so a decoder written without a fixture cannot be checked — while `readEntity`'s errors are fatal to the whole document, so a wrong one would convert today's harmless skip into a hard failure on the first user drawing that has one. (SOLID was deferred on the same grounds and should not have been: the corpus holds 15, and once looked for they decoded and landed at both R2004 and R2018 on the first attempt. The lesson is to *count* before deferring — "no fixture" was an assumption, not a measurement.)

**HATCH is deferred on measurement rather than on absence.** All 507 in the corpus were tallied by layer: roughly 90 sit on layers `IsAnnotationLayer` already reads as pattern fill (`HATCH`, `COL_HATCH`, `…$0$HATCH`, `IBS-Column Hatch`), and most of the rest are decorative finishes (`TILES` ×60, `PCEB000F` ×23, `PUB_H` ×19). The ones on structural layers — `MURO000F` ×22, `WALL-01`/`WALL-06` ×3, `STAIRS` ×1 — are wall *poché*, the solid fill inside a wall whose two faces are drawn as lines either way, so the wall is already in the raster and the hatch would only shade it. Against that, HATCH is among the largest records in the specification (pattern definition, per-edge boundary paths in four geometry types, gradient data from R2004, seed points, associativity handles) and every field must be consumed exactly or the whole document fails. So the cost is high, the failure mode is severe, and the yield is shading. Revisit when a drawing arrives whose rooms read as **blank** without it.

**Geometry coverage is complete for this corpus, and that is a measurement.** Rather than read the specification's table of contents and guess at what is left, every object type in all five fixtures was tallied against `readEntity`'s accept-list. What the reader still skips is, in full: DIMENSION_LINEAR + DIMENSION_ALIGNED (2,047), HATCH (507), LEADER (121), VIEWPORT (12), OLE2FRAME (6) — and everything else undecoded is non-graphical bookkeeping (APPID 91,646, DICTIONARY 1,652, XRECORD 784, plus STYLE / LTYPE / DIMSTYLE / LAYOUT / MLINESTYLE and the control tables). Dimensions and leaders are **annotation**, which `annotationTokens` discards by layer before geometry is ever consulted; viewports and OLE frames are paper-space furniture. So the only skipped type that could plausibly carry building fabric is HATCH, which is deferred on its own measurement above. The 45,778-APPID outlier in one fixture was checked rather than accepted — a drawing with that many registered application IDs is implausible on its face, and a *mistyping* bug would look identical — and they are genuine: 2,000 distinct names in the first 2,000 sampled, `AUDIT_D_011022110041-5`, `ACAD_DIMASSOC_OVERRIDDEN_0`, `AcDbDynamicBlockGUID`, decades of third-party tooling and audit passes accumulated in one file.

**The remaining gap is the pre-R2004 container, and it is blocked on a fixture rather than on effort.** No R13/R14/R2000 drawing exists to test against, and the shortfall is not only the container: those releases have **no `bitsize` field**, so `object.dataEnd()` has nothing to measure from and the shared object path (`object.go`, `strings.go`, `handles.go`) would have to grow a branch — the same path currently proven across 84,993 entities for the releases that do work. Writing it blind would risk verified releases for an unverifiable one, and a LibreDWG-written R2000 file would only verify this reader against LibreDWG's experimental writer rather than against AutoCAD. What shipped instead is the part that *is* verifiable: the refusal. `open` now names the release and the direction to re-save (`dwg: R2000 (AC1015) is older than this reader supports — re-save as AutoCAD R2004 or later`), picking the direction by string-comparing the magic, which rises monotonically with release and so places even an *unrecognised* version on the correct side of the supported range. `Version.container()` reports only containers that exist — a version it names is a version `open` opens — and the consistency loop in `TestUnsupportedVersionNamesTheRemedy` holds that against `oldestSupported`/`newestSupported` so the advice cannot drift from the code. The test is fixture-free on purpose: the releases under test are exactly the ones no fixture exists for.

`POST /api/v1/cad/inspect` and `POST /api/v1/cad/render` (§6.4) are mounted, and the layout editor's floor-plan tool drives both — a `.dwg` dropped on the image tool is inspected, the user ticks layers and confirms the units, and it comes back as a PNG that places at its true ground size and behaves as an ordinary floor plan from there (§5.13).

Three decode rules found late and worth keeping in view, all of which produce a *plausible* wrong answer rather than an error:

- **Anonymous block definitions share one name, so registration has to make them unique.** A DWG does not name its generated definitions individually — it stores them under a bare prefix, and one mezzanine fixture holds **875 BLOCK_HEADERs all called `*D`**, one per dimension. The number a CAD application shows beside them is its own invention. Registered as they stand, 874 are silently redefined as a copy of whichever arrived last; because the source was a **map**, which one that was differed on every read, so *the same drawing converted to a different size each time it was opened*. `document.go` walks the object map's order and suffixes collisions through `uniqueBlockName` (carrying the counter across calls, since a per-collision rescan would be quadratic on a file that costs nothing to produce), and the entity pass reads its block back **by handle** before copying the name, so every insert lands on its own definition.
- **An entity's `shadow` field is a byte-wide enumeration whose value 3 costs a handle.** Its neighbours are two-bit flags and its other three values are plainly "casts", "receives", "both", so there is nothing in the name to suggest a reference — and it is rare enough to look like it doesn't exist: **16 objects in 139,000** across the whole fixture set have it, all inside block definitions in one drawing. Miss it and the handle stream slips by one for those objects only, which mislabels their references while every landing assertion still passes.
- **An ATTRIB is owned by the INSERT it labels, not by a block, so ownership has to resolve *through* the parent.** Every other entity names either a space or a block header, and `document.go` sorts on that directly. An attribute names an insert — which is why it appears in no block's contents list, and why `TestBlockContentsAgreeWithOwners` can only read it as a missing entity. Stopping at the insert puts the tag in model space, so a tag on an insert *inside a block definition* would be drawn once at the definition's own coordinates rather than once per insertion. Every attribute in this corpus hangs off a model-space insert, so the walk is one hop and the difference is invisible here — which is the reason to write the rule rather than the reason to skip it. The forward and backward halves are asserted against each other by `TestAttributesHangOffInserts`: the insert states its attribute count in the **data** stream and spends that many **handles**, while each attribute names its owner from its own handle stream, so a miscount consumes a different number of handles and still lands legally.

**Why this is hand-written.** Every existing DWG reader is AGPL (LibreDWG) or proprietary, and docs/cad-import.md makes an AGPL dependency a non-starter. The format itself is not the obstacle — DWG is undocumented by Autodesk but thoroughly described by the Open Design Alliance's freely published specification, and reading it is what every non-Autodesk CAD tool does. So this is written from that specification rather than ported from anyone's source.

**`internal/cad` — the format-agnostic model.** The split it exists to enforce: a reader knows one file format and nothing about warehouses; this package knows what a drawing *means* and nothing about file bytes. Two normalisations happen at the reader boundary — references are by **name** (resolving DWG's 8-byte handles is the reader's problem), and geometry stays in the **drawing's own units** (whether a conversion to metres is even knowable depends on header fields the reader may not have).

| File | Holds |
|---|---|
| `cad.go` | `Document` (header, layers, blocks, model-space entities), `Layer`, `Block`, `Color` |
| `entity.go` | The `Entity` interface + `Line` / `Polyline` / `ArcEntity` / `Circle` / `Ellipse` / `Spline` / `Point` / `Text` / `Insert` / `Solid` |
| `text.go` | `PlainText` / `PlainMText` — a stored text value rendered as the characters it stands for. Here rather than in a reader because the escapes are the format *family's*: DXF stores identical ones |
| `geom.go` | `Vec3`, `Matrix` (4×4), `BBox`, `Arc`, `ArcFromBulge`, `ArbitraryAxis` |
| `transform.go` | Applies a matrix to an entity. Non-trivial: a non-uniform scale turns a circle into an **ellipse**, and a mirror **reverses** an arc's sweep — an `svd2x2` decomposition decides which |
| `flatten.go` | `Document.Flatten` expands `Insert` entities against block definitions, inheriting layer/colour/linetype. Guards: block-reference **cycles** are cut, array expansion is **capped**, missing blocks and xrefs are **reported** rather than silently dropped |
| `bounds.go` | Extents computed from geometry, not from `$EXTMIN`/`$EXTMAX` (which go stale when geometry is deleted without a regen). Arc bounds are **tight** — the arc, not its chord |
| `paths.go` | `Paths` reduces flattened entities to `Path` — one flat `[]float64` run of x,y **in metres**. Every curve becomes chords within a **sagitta** stated in metres, so `MetersPerUnit` reaches the segment count and the same building tessellates identically in mm and m. Arcs and ellipses invert the sagitta against a radius; a NURBS span has no radius, so it is subdivided against the distance from its control hull to its own chord instead (`deBoor` in homogeneous coordinates, so weights need no separate treatment). `MaxPoints` bounds the whole result (`Flatten`'s entity cap does not: 2 M entities × 128 segments is 4 GB), reporting `ErrTooManyPoints` with the partial result rather than truncating silently |
| `units.go` | `Units` / `Measurement` from the header, `GuessUnits` from drawing size when `$INSUNITS` is 0 (common) or when it is present but the extents contradict it, `Confident` so an ambiguous guess can be surfaced as a question instead of an assumption |
| `extent.go` | `TrimOutliers` — the drawing's real extent, with debris discarded. `PlanBounds` is the read-only variant. Runs **before** units are resolved and before anything is drawn, for the reason below |
| `annotation.go` | `IsAnnotationLayer` — whether a layer describes the *drawing* rather than the building (title block, dimension run, hatch pattern). One `bool`, a proposal about which boxes the import dialog opens ticked, nothing more |
| `raster.go` | `Rasterize(paths, RasterOptions) → Raster{PNG, Width, Height, WidthMeters, HeightMeters, PixelsPerMeter}`. Black ink on white paper, framed on `PathBounds`, capped by the **GPU's** texture limits (4096 px edge, 4096² area) rather than by memory |

**What a CAD file gives us that a PDF cannot: real coordinates.** A PDF records a sheet of paper and the plot scale is an openly-ranked guess (§6.11). A DWG stores model space at 1:1 and usually declares its units, so the scale is *known*. What it still cannot give us is **georeferencing** — no CRS, no origin, no north. Position and rotation on the map stay a human judgement call, exactly as for PDF.

**The drawing becomes a picture, and that is a 2026-08 decision.** An earlier design recovered walls, rooms, columns, doors, stairs and racks from the linework and created them as real `lines` / `polygons` / `circles` / `doors` / `stairs` / `grids` rows — `roles.go`, `segments.go`, `extract.go`, `extract_shapes.go` and `rooms.go`, about 2,600 lines. It worked, and it was **removed on the user's instruction**: a DWG becomes a rendered floor-plan image, and an AI tool reads the placed image and draws the entities. The reasoning is that recognising a wall from geometry plus a layer name is a heuristic with a long tail — the token list has to be multi-language, the AIA naming standard is followed loosely by about half of real drawings and ignored by the rest, and the room derivation failed exactly where a wall layer went unrecognised (`Apartment-1.dwg`'s `W` layer returned 0 rooms until the role was forced by hand). Handing that judgement to a model that can *see* the drawing is a better trade than growing the token table one customer file at a time.

So `internal/cad` reads and draws; it does not classify. The code is recoverable from git history and this paragraph is the record of why it went — **don't re-add it without the user asking**. What survives of the layer-name work is `annotation.go`, reduced to one exported function:

- **`IsAnnotationLayer` is a proposal about the *sheet*, not a classification of the building.** The one question worth asking of a layer name is whether it describes the drawing rather than what was built — a title block, a dimension run, a hatch pattern, a revision cloud — because rendering all of it produces a plan buried in the paper it was plotted on. That is a genuinely easier question than "is this a wall": it has a small vocabulary (`DIM`, `ANNO`, `TEXT`, `TTLB`, `HATCH`, `NPLT`, `GRID`, …), the answer only decides which boxes the import dialog opens **ticked**, and being wrong costs a tick. The wire field is a `bool`, not a string with six values; keep it that way. Matching is **substring on a normalised name** (`normalizeLayerName` upper-cases, strips separators and folds accents, so `A-WALL`, `A2_WALL` and `a2 wall` all reduce alike and a German `TÜR` becomes `TUER`), not the AIA's positional field parsing — the fixtures show positional reading failing on most real files, and a substring test degrades to "not annotation" on those, which is the safe direction because the layer is then drawn and the user can see it.

**Reading the drawing properly still earns its keep, even though the output is a picture.** Two things depend on it and neither could be recovered from a rasterizer bolted onto the front. The **layer filter** is a choice about *entities* and runs at flatten time, so an unticked title block is gone before extents are measured and both the sheet and its stated ground size shrink to the building. And the **scale** comes from the drawing's own header — a DWG stores model space at 1:1 and usually declares `$INSUNITS`, so the plan lands at its real dimensions instead of being fitted by hand against a PDF's inferred sheet size.

**Trim the debris before choosing the scale.** The order is `TrimOutliers` → `ResolveUnits` → `Paths` → `Rasterize`, and each step depends on the one before. A drawing routinely carries a stray entity a kilometre from the building — a leftover from a paste, a construction line, a stray point at the origin — and it does two separate kinds of damage: it stretches the extent, which is what `GuessUnits` measures, so a plausible metre reading becomes an implausible one and the building imports at the wrong size; and it eats the fixed 4096 px budget, so a drawing whose extent is eight times its geometry renders the building at an eighth of the resolution it could have had. `TrimOutliers` weights every entity as **one vote at its own centre** rather than by its extent, so a single site boundary polyline cannot outvote a thousand walls, and it trims **X then Y** independently because debris is usually off in one axis only. What it dropped is reported as `detachedEntities` so the count is visible rather than silent. `planOutlierFraction` is 0.02 — a drawing is allowed to lose 2% of its entities to debris and no more.

**`internal/handlers/cad.go` — the HTTP surface.** Two multipart endpoints, `CADRouter(objectStore)` mounted at `/api/v1/cad` beside `/api/v1/pdf`. `readDrawing` picks the format by **content**, not by filename — a `.dwg` extension on a DXF is a user's mistake, not a reason to fail — and its switch is where a DXF reader joins. Three things worth knowing:

- **The source drawing is never persisted.** The same reasoning as PDF import: a stored file with no DB row pointing at it is indistinguishable from an orphan, and `cmd/cleanup-orphans` would correctly reclaim it (§4.6a). The browser still holds the `File`, so the second call re-sends the bytes. That costs upload bandwidth and buys an entirely unchanged file-lifecycle story. The rendered PNG *is* stored, on an `images` row, where `images.image_url` already flows through the refcount and cleanup path with no new code.
- **The two calls answer two different questions.** `/inspect` answers *is this the right drawing, in the right units* — release, producer, extents, per-layer entity counts, the entity-kind histogram, and when `$INSUNITS` is absent *or contradicted by the extents* the ranked `GuessUnits` list, so the ambiguity is put to the user rather than assumed away. `/render` answers *draw these layers*: a `layers` field (newline-separated; absent means the whole drawing) and an optional `units` INSUNITS override, which exists because the reason to ask was that the file's own answer was missing or untrusted. Rendering first and asking later would mean re-rendering.
- **The reported footprint is anchored on the pixels, not on the entities.** The client places the image by its corner and stretches it to the stated size, so the two have to describe the same box. Entity extents do not: a chord sags inside the curve it replaces, and an entity with no drawable geometry (text) contributes extents but emits no points — `canteen.dwg` was 2.2 mm off its own stated origin until the anchor moved to `PathBounds` of the emitted paths. The raster's margin is then added on top, because the image covers slightly more ground than the geometry does.

**Known gap: text does not appear in the raster.** `cad.Paths` emits nothing for `Text`, so room names, dimension values and grid-bubble numbers are decoded, resolved through `PlainText`/`PlainMText` — including `Apartment-1.dwg`'s Chinese labels — and then dropped before drawing. Closing it needs a bundled vector font and a CJK font alongside it, which is 5–15 MB in the binary, so it is a deliberate open question rather than an oversight.

**`internal/cad/dwg` — the reader.** DWG is really several formats sharing a magic string. The entity encoding is broadly stable across releases; the *container* was rewritten three times, so `version.go` selects a container first.

| Container | Versions | State |
|---|---|---|
| — | R13 / R14 / R2000 | Not implemented, and deliberately **unnamed** in `container()` — see the deferral above. A flat uncompressed section locator at a fixed offset, but the container is the smaller half of the work |
| `containerR18` | R2004 / R2010 / R2013 / R2018 | **Done** — `container18.go` + `compress.go` (LZ77); R2004 verified by fixture, the rest by four |
| `containerR21` | R2007 alone | **Done** — `container21.go` + `compress21.go` + `reedsolomon.go` |

R2007 is the odd one out and cost the most: a Reed-Solomon coded file header, four levels of indirection (header → page map → the page holding the section map → section pages), 64-bit sizes, UTF-16 section names, and a second LZ77 dialect that shares nothing with R2004's. Two properties of that dialect are worth knowing because nothing else behaves this way:

- **Literal runs are stored permuted.** A run is emitted in chunks taken from the end backwards, and the chunk sizes are *recursive* — entry 23's trailing `{16, 0}` means "entry 16 applied to the first sixteen bytes", which swaps their halves. The recursion bottoms out at 1, 4 and 8 bytes.
- **Reed-Solomon decoding is parity-stripping only.** Berlekamp-Massey error correction is deliberately skipped: it buys at most 8 bad bytes in 255, and a DWG damaged that badly is a file the user should re-export rather than one we should silently guess at. The correction step slots in without touching a caller if a corpus ever justifies it.

`bitreader.go` is the layer below the container. A DWG object does not begin on a byte boundary and neither do its fields — a boolean costs one bit, a coordinate that happens to be 0.0 costs two, a 32-bit integer under 256 costs ten. Method names are the specification's own type codes (`bs`, `bl`, `bd`, `dd`, `mc`, `h`, `cmc`, `textU`, `objectType`) so a decoding routine reads like the paragraph it implements. Bits are big-endian **within** a byte but bytes assemble little-endian **within** a number, which is the single easiest thing to get wrong.

**The object index** (`objectmap.go`, `object.go`, `objecttype.go`) sits above the container. `AcDb:AcDbObjects` stores objects back to back with no directory, so `AcDb:Handles` is the drawing's index: for each object, its handle and its byte offset. Both are deltas, which is what keeps the index small, but the accumulators **reset at every chunk boundary** — the first pair of each ~2 KB chunk carries absolute values. Read as one continuous run the offsets drift past the end of the section, which is exactly the failure it produced first time. `object.go` frames each object to its own byte extent (so a decoder that misreads a field errors instead of reading its neighbour) and decodes the prologue: a length, then a type, then the object's own handle. That last field is a free integrity check worth keeping — the object map has already said what the handle should be, and the two agreeing proves the page map, decompressor, delta arithmetic and prologue layout all at once. R2010 reshuffled this prologue: R2000–R2007 store the data length in bits *after* the type, while R2010+ instead store the trailing handle-stream length *before* it. Which of the two a file uses is what decides where its object data ends — see the three-stream note below.

**The R2010+ handle-stream length sits outside the length the object declares.** The object opens with a byte count, and the natural reading is that everything after that field is covered by it. For R2010+ it is not: the handle-stream size that follows is on the same footing as the count itself, so an object's real extent is *both* prologue fields plus the declared bytes. Framing it the obvious way makes every object exactly one byte short — enough that the handle stream ends up truncated mid-handle while the data still appears to decode, because the data is at the other end. It surfaces as a decoder that reads geometry perfectly and then cannot finish the references.

**Three streams per object, and where they divide.** From R2007 an object is not one run of bits but three laid end to end: its own data, then any strings, then the handles of everything it refers to. None is self-delimiting, so the boundary is stored — and *which* boundary is stored changed with R2010, which replaced the count of data bits with a count of handle-stream bits. `object.dataEnd()` answers the resulting question. R2010+ is the specification read literally: the data ends one bit below where the handle stream starts. Up to R2007 the count is of the data, and the thing to know is **what it counts from** — the first bit past the prologue, not bit zero of the object.

**The prologue's own length is not a constant, because the size field is a modular short**: two bytes for an object under 32 KiB and four for anything larger. Assuming two puts the end of every large object sixteen bits early. That is invisible in the geometry, which is read from the other end, and it does not disturb the handle stream either — it surfaces only once something reads *backwards* from the end of the data, as a string stream whose declared length exceeds the whole object. Seven objects in 139,000 are large enough to expose it, all of them the big block headers and 3D solids.

**`strings.go` — the R2007 string stream.** R2007 moved every string out of the object's data into a stream of its own, and wrote that stream **backwards from the end of the data**: a flag saying it exists on the last bit, below it the stream's size as a raw short, below that the strings. So an object with strings has data that stops short of the flag, and finding where means reading down from the end before anything can be read along from the start — `locateStrings` runs in `readObject`, and `dataStop()` (not `dataEnd()`) is what a decoder must land on. The size is itself extensible: a stream too long for fifteen bits sets the top bit of the first word and puts the rest in a second word below it. The arrangement is not perverse — it lets a writer emit data in one forward pass without knowing in advance how much text an object will carry, and lets a reader that does not care about text skip the whole stream by subtraction. `bitReader.window(start, end)` exists for this: the three streams live inside one extent, and each has to be stopped at its own boundary or a decoder that reads one field too many is handed whatever the next stream begins with instead of an error.

R2000/R2004 have no string stream, and their data stops **one bit past** `dataEnd()`. R2007 did not add a bit for the strings-present flag, it took one out of the data — so the flag's absence gives the bit back. `dataEnd()` is right for every release regardless, because the handle stream begins at `dataEnd()+1` either way; the difference is visible only to a decoder asserting where its own reads should finish, which is why the two are separate methods (`dataStop()` is what a decoder lands on). Assume the flag on an old file and every object overruns by exactly one bit — small enough to read as a field decoded slightly too wide, which sends the search to the last field rather than to the boundary. **R2004 is verified** by `Apartment-1.dwg`: 5,967 entities, all landing exactly, every layer reference resolving to a LAYER. R2000 remains untested and nothing can open one anyway.

**`entity.go` — the common block, the geometries, the two curves and the two text types.** Every drawable object opens with the same attribute block: extended entity data, an optional preview bitmap, entity mode, reactor count, colour, linetype scale, and per-release flags for linetype, plot style, material, shadow, visual style, invisibility and lineweight. Almost every field in it is variable-length and several appear only for certain releases, so it must be decoded rather than skipped. `readEntity` switches on the type **before reading anything** and returns `(nil, nil)` for objects it does not handle — a drawing is mostly bookkeeping, and running an entity's layout over a dictionary produces an error that looks like a corrupt file rather than what it is. The block carries more than the attributes an entity ends up with, because the handle stream that follows is not self-describing: which references are present, and how many, is stated only here. Two details cost real time and are worth stating:

- **Exactly one bit separates the reactor count from the colour** in R2007 (the extension-dictionary flag). R2013 adds a second; R2010 adds three visual-style bits after the shadow byte.
- **Colour flag `0x40` suppresses the inline true colour that `0x80` would otherwise introduce**, and spends a handle instead. `0x40` means the colour is a colour-book entry, a separate object named from the handle stream, and that entry is the whole definition. Reading the notional RGB anyway — which the flags taken independently suggest — consumes 10 bits that are not there. One object in 39,096 has both flags set, so the fixture set proves this exactly once; the arithmetic is unambiguous, since the remaining fields cannot fit in what would be left.

**TEXT and MTEXT — the first types whose payload a landing check cannot verify.** They are what carries a room's *name*, so they are the difference between importing 48 anonymous polygons and importing the kitchen, and they are also the first decoders whose correctness the suite's strongest assertion is blind to: from R2007 a string lives in a separate stream, so it costs the data cursor nothing and an entity whose text is read from entirely the wrong place still lands exactly. Rung 16 below exists for that reason alone. Four things about the pair:

- **TEXT is a flag byte and eight fields that may not be there.** R2000 replaced eight always-present values with a byte saying which of them *differ from the obvious default* — no elevation, aligned at the insertion point, upright, unmirrored, unit width, left of the baseline — so the sense is inverted (a set bit means the field is **absent**) and a plan's labels, being mostly default, set most of the bits. Pre-R2000 writes all eight unconditionally, which is a separate branch rather than a special case of the same one.
- **MTEXT states its rotation as a direction vector**, not an angle, so it arrives as a `3BD` X-axis and becomes `math.Atan2(dy, dx)`. It also states the laid-out result — extents width and height — alongside the rectangle it was given, which is output rather than input and is stepped over.
- **MTEXT's R2018 block is gated on a flag stated negatively** ("is **not** annotative"), and the block it guards costs an **AppID handle in the handle stream**. So `readMText` reports the flag to its caller the way `readInsert` reports `hasAttribs` — a decoder that reads the data block correctly and forgets the handle finishes its data exactly and then fails to exhaust its references, which is rung 5 catching what rung 4 cannot.
- **The stored value is not the characters it draws**, and this is the finding that matters most. `\U+XXXX` names a code point outright and `%%d` / `%%p` / `%%c` predate it for the symbols a draughtsman's keyboard lacks; MTEXT adds a whole inline formatting language on top (font, height, colour, stacked fractions, paragraph breaks, grouping braces). `Apartment-1.dwg` stores **every one of its room names** this way — 餐厅 is `\U+9910\U+5385` — so a reader that passes the escape through names the dining room `\U+9910\U+5385` on the map, in the layer list and in every derived area. `cad.PlainText` / `cad.PlainMText` resolve what stands for a character and drop what describes appearance, and **pass through anything they do not recognise**: `\M+` needs the code page the text style names, and a wrong one produces confident nonsense where a stray escape is at least legible and obviously odd.

**ELLIPSE and SPLINE — the curves a plan uses where a polyline will not do.** Together they are 5,568 objects in the corpus, all of them in the two largest fixtures. Both landed exactly on the first attempt, which is worth recording only because SPLINE's layout is the least uniform of any type here.

- **ELLIPSE is the plainest decoder in the reader** — centre, major axis, extrusion, ratio, two parameters, nothing optional and nothing compressed — with one trap: its extrusion is a full `3BD`, the same exception INSERT makes and the only other place it appears. There is no rotation field, because the major axis is a *vector* from the centre and so states the orientation and the size at once. `cad.Ellipse` mirrors that, which is what lets `transform.go` promote a circle under a non-uniform scale by handing the SVD's singular values straight back as a major axis and a ratio.
- **A SPLINE states itself two ways and writes only one.** Scenario 1 is the control net — degree, knots, control points, optionally weights — which defines the curve exactly. Scenario 2 is a list of points it was drawn *through*, with the net left to be recomputed: a statement of intent rather than of geometry. The fields of the unwritten scenario are simply absent, so the two branches share nothing but the trailing arrays, whose lengths come from counts read inside the branch above. Same arrangement as LWPOLYLINE, and the same rule applies — every count is capped before it reaches an allocation, and honoured afterwards even if a read has already failed, because the object's extent has to be consumed either way. R2013 adds two leading `BL`s (a flags word and a knot parameterisation) ahead of the degree. Every spline in the corpus is scenario 1, a quarter of them rational; the fit-only path is therefore **decoded but unproven by fixture**.
- **Tessellating a NURBS curve needed a different argument from every other curve here.** Arcs and ellipses invert the sagitta against a radius; a spline span has none. `paths.go` bounds it by the convex hull instead — the span lies inside the hull of the control points that influence it, so the furthest of those from the span's chord bounds how far the curve can stray, and the error falls with the *square* of the subdivision count, so the answer is a square root. Evaluation is de Boor in homogeneous coordinates, which is the whole of the weights' treatment: a rational curve in the plane is a polynomial one a dimension up, divided through at the end. The knot vector is checked to be non-decreasing before any of this, because de Boor divides by knot differences and a hostile vector answers with infinities that would reach the client as coordinates; a spline that fails any structural check falls back to its fit points and then to its control net, since either beats dropping an object the user drew.
- **The one test that can prove a NURBS evaluator** is the rational quadratic over (1,0), (1,1), (0,1) with weights 1, √2⁄2, 1: it is *exactly* the unit quarter circle, so every emitted point must sit at radius 1. Nothing else about a spline has an answer knowable independently of the evaluator producing it — which is the same problem rung 4 solves for field layouts, and the same shape of solution.

`lwpolyline.go` decodes the modern polyline, which holds all its vertices in one object rather than chaining separate VERTEX objects, and is what a drawing is mostly made of once it is past straight walls. Everything in it is optional and announced by a flag word — a plain open polyline stores nothing but its points. Vertices are a **delta chain**: only the first arrives whole, since successive points on a traced outline share most of their bits. The bulge, width and vertex-ID arrays carry their own counts, independent of each other and of the vertex count, and are consumed in full even when longer than the vertex list, because the object's extent has to be honoured whatever the counts say.

**`polyline.go` — the older chain, and the first type that spans objects.** POLYLINE_2D / POLYLINE_3D keep no points of their own: each is a run of separate VERTEX objects closed by a SEQEND, named from the polyline's handle stream. The type did not go away when LWPOLYLINE arrived — LWPOLYLINE is planar, so anything with a Z per point is still a chain, and so is anything exported for an older release. Skipping it is not a small omission: one fixture is 94,183 objects of which 91,521 are chain parts, and a reader without this file opens that drawing as **empty**. Two consequences shape the code. First, a polyline cannot be finished from the bytes of the object that declares it, so `readEntity` returns a `part` — an entity *or* a loose vertex, plus references — and `document.go` attaches vertices on the same second pass that attaches layer names. A vertex is deliberately **not** a `cad.Entity`: emitting one would put 90,000 stray points into a drawing of lockers. Second, R2004 replaced "name the first and last vertex, walk the map for the rest" with an explicit count plus every handle, so the count lives in the data stream while the handles it counts live in the handle stream — which is exactly the shape of error that lands legally and still means something different. Smaller details: a VERTEX_2D with a **negative** start width is stating that both widths share its magnitude and that the end width was therefore not stored, and a VERTEX_3D carries no bulge at all, because an arc is planar and a 3D run has no plane to measure one in.

**`block.go` — the drawing stops being a flat list.** A drawing does not repeat itself: four hundred desks are one desk drawn once and four hundred references to it, so a reader that decodes every geometry type but skips INSERT opens an office plan and shows an empty floor. `patient-chairs.dwg` is the extreme case — model space holds 27 objects, all of them references, and every one of its 11,794 polylines is inside a block; before this file existed the reader opened it and reported 27 points. BLOCK_HEADER is a table record (same shape as LAYER, read through the same two-stream helper) holding the name, the base point and the list of objects the block is made of; INSERT is an entity naming a BLOCK_HEADER by handle and stating where to put it, at what size and at what angle. MINSERT adds a rectangular array — warehouse racking, seating, parking bays — kept as counts and spacings rather than expanded. Four details:

- **INSERT's extrusion is a full `3BD`.** Every other entity spends one bit to say "the usual Z axis" and stops; INSERT writes three `BD`s, which for 0/0/1 costs six bits. Read as the compressed form, every INSERT in every fixture lands exactly five bits short of its declared end.
- **A table record carries an xref index through R2004 and stops at R2007.** This was recorded as R2004 for months on the strength of a corpus that was entirely R2018 — which cannot distinguish the two rules, since both predict "absent" in every file present. `Apartment-1.dwg` settles it. The cost of the wrong boundary is wildly uneven: in LAYER it is a quiet two-bit slip, but in BLOCK_HEADER the *next* field is a run of non-zero bytes terminated by a zero, so two bits become a ~100-byte overshoot as the loop reads on until it chances on a zero byte. A misalignment ahead of a run-length-terminated field never produces a small error — and a version rule is only as good as the oldest fixture that exercises it.
- **That run is the insert count**, and only its *length* is information: it is how many handles appear near the end of the handle stream. The bytes themselves are all 1.
- **The owned-object list is R2004+.** Before that a header named only its first and last entity and the chain ran through the entities themselves — untested, no fixture is old enough.

The list is not what routes an entity into its block; an entity states its own owner and that is what `document.go` goes by. It is read because it has to be, to reach the handles after it, and returned because two independent statements of the same fact are worth comparing (rung 12).

**`handles.go` — the reference stream.** The shared block is: owner (only when the entity does not imply it by entity mode), reactors, extension dictionary, **layer**, then linetype / material / plot style / visual style, each present only when the corresponding field in the data said `3` — meaning the value is not one of the shorthands the flag itself can express. The colour-book handle above precedes all of them, because it is taken as the colour is read rather than as part of this block. Nothing in `cad.Document` refers to objects by handle, so this stream is where a file's internal wiring stops being the reader's caller's problem.

**`table.go` — the records that supply the names.** Table records are objects but not entities, and open differently: no preview bitmap, no entity mode, no colour or linetype in the shared block, just extended data, a reactor count and two flags. LAYER is the one decoded so far, and it is the one that matters most, because an entity's layer is otherwise an eight-byte number meaningless outside the file it came from. Its attributes — frozen, off, locked, plottable, line weight — arrive packed into a single short with the width in the top five bits; the width is a code into AutoCAD's fixed ladder of offered widths, not a measurement. Two things here differ from the entity path and cannot share code with it: **the R2004+ `CMC` colour a record stores is a different encoding from the one an entity stores** (a record keeps a flag byte of its own and can name a colour in the string stream; an entity packs its flags into the high byte of the index it already had), and **`TV` reads from a different stream per release**, which is what the `streams` type threading `data` and `str` together exists for.

**`headervars.go` — the section that says how big the drawing is.** Everything above decodes geometry in whatever units the file was authored in, and a floor plan whose units are unknown is a shape rather than a building: 42,000 across is a warehouse in millimetres and forty kilometres in metres, and nothing in the geometry distinguishes them. `$INSUNITS` is the field that does, and reaching it means decoding **the entire variable list in front of it** — a few hundred values written back to back with no names, no tags and no lengths, of which perhaps a dozen matter to us and the rest (dimension styles, plot settings, snap modes, two timestamps, a walkthrough camera) are read only to be stepped over. That makes it the most fragile thing in the reader and the one worth checking hardest, because a misread here is not a decode failure but a *plausible number*: two bits early and `$INSUNITS` comes back 4 instead of 6, the drawing imports at a thousandth of its size, and nothing looks wrong until someone measures a door. Seven things about the section are not obvious and each cost real time:

- **The section is laid out exactly like an object**, three streams and all, from R2007 on — but framed differently. `sentinel(16) + RL size(4) + [R2010+: four unnamed bytes] + body + CRC(2) + inverted sentinel(16)`, and inside the body an `RL` bit count that **counts itself**: the string-present flag sits on the *last* bit of the run, not one past it. Read as a count of what follows, the flag reads zero on every fixture and 22 KB of legible text — linetype names, a URL, both GUIDs — is silently discarded as if the drawing had none.
- **R2013 added a `BLL` before everything else** (`REQUIREDVERSIONS`), and in the one fixture that has it the value is zero, so it costs **three bits**. Three bits are enough to make every double, short, timestamp and handle in the section nonsense. It was found by the first of the four unnamed leading doubles, which is `412148564080.0` in every file ever examined — the one value in the section whose correctness can be judged without reading anything before it.
- **Four unnamed shorts at the very end are R2004-and-earlier only.** With them the walk overruns its own declared end by 56 bits; without them it lands exactly, on every fixture.
- **The handle stream cannot be asserted exhausted**, unlike an object's. The body runs about ten bytes past its last handle in every fixture, with contents that differ per file and match nothing else in it — a page allocated in fixed units and left uncleared fits what is there. *What* the handles are is checked instead of how many bits they took (rung 14).
- **`$MEASUREMENT` is not in the DWG header-variable list at all** — it is a DXF variable. `cad.Header.Measurement` is therefore left at zero, which states "the file did not say" rather than asserting "imperial", which is what zero would mean if the reader had actually looked.
- **Only from R2007 can the walk be required to land *exactly*.** The string stream states where it starts, so the data must stop on that bit and several hundred unnamed variables become falsifiable as a group. Before R2007 nothing follows the variables but the section's own byte padding, so the most that can be asserted is that the walk finishes inside the final byte — the R2004 fixture ends 5 bits early at bit 4611 of 4616, and 4616 is 577 bytes exactly, which is what identifies the shortfall as padding rather than a missing field.
- **`$EXTMIN`/`$EXTMAX` are frequently not a measurement.** A drawing saved without a regen since its last edit carries **±1e20** — an inverted box, so the first entity considered replaces both corners — and two of the five fixtures do. That is a fact about those files, not a decode failure, but passing the sentinel on as a measurement offers a bounding box a hundred billion times the size of the building, which the import would then scale to. `cad.Header.HasExtents` reports which it is, and `cad.Bounds` recomputes regardless, because extents also go stale the moment something is deleted without a regen.

`document.go`'s `readUnits` is the one part of the read allowed to **fail quietly**, and the asymmetry is deliberate. Elsewhere a decode failure fails the import, because the alternative is geometry the user never learns was dropped; here the alternative is a question the user is already asked, since a drawing whose `$INSUNITS` is 0 — a large minority of them — reaches `cad.GuessUnits` and the import UI either way. What makes that acceptable rather than merely convenient is that the failure is **one-sided**: `readHeaderVars` asserts all three streams landed exactly before it returns anything, and a wrong walk cannot land, so the degraded outcome is "no answer" and never "wrong answer".

**And a decoded `$INSUNITS` is a claim, not a fact.** All that work buys the number the file chose to write down, which is template metadata that outlives the decision it recorded: `Apartment-1.dwg` decodes cleanly, states **millimetres**, and measures 37.7 units across — a 3.7 cm flat. So `cad.ResolveUnits` prefers the declaration without obeying it. When the declared unit implies an extent no building has *and* some candidate implies one that does, the geometry wins and the answer is returned as a guess rather than a fact, which puts it in front of the user through the same `unitGuesses` path an absent `$INSUNITS` uses. The override is one-sided on purpose: an implausible declaration with no plausible alternative is left alone, because that is a drawing of a bracket and a unit we cannot justify is no improvement on one the file at least asserted — and an override into genuine ambiguity still reports `unitsConfident: false` instead of picking. Of the five fixtures only this one is falsified; the other four declare units their extents agree with (304 m, 226 m, 50 m).

**`document.go` — `dwg.Read`.** One pass over the object map collecting entities with their unresolved handles, layer records with their names, block headers and loose vertices; then a second pass over what was collected to resolve them. Three things an entity needs can appear after it — the layer table that names its layer, the VERTEX objects a polyline is made of, and the block header that names an insert's block and says whether the entity belongs to the drawing or to a definition — so all are deferred rather than decoding every object twice to find them.

The second pass is also where an entity acquires a **destination**, and there are three. Paper space is the sheet the drawing is plotted on — border, title block, viewport frames — and importing it would place a picture of the building beside the building, so it is dropped; this is why `canteen.dwg`'s extent fell from 806,431 × 219,674 to 91,316 × 53,205 once the split existed. A block's contents go on the block, drawn only where something inserts them. Everything else is the drawing. Model space is the one BLOCK_HEADER that does **not** become a `cad.Block`, because its contents *are* `doc.Entities`; layouts and xrefs are registered even though nothing draws them, precisely so `Flatten` can report what it declined to draw and why. **`Read` is strict**: an object it claims to understand but cannot decode fails the whole read rather than being skipped, because an import that silently drops geometry is worse than one that refuses — a user can act on a refusal and cannot act on an absence they never see. Objects it does not claim to understand are skipped without comment. A file that yields no geometry at all returns `ErrNoGeometry` rather than an empty document, since "the drawing is empty" and "it is made entirely of a type we do not decode yet" are indistinguishable to the caller and neither is a success.

**Security posture.** Uploads are attacker-controlled, so every read goes through the bounds-checked `cursor` (byte level) or `bitReader` (bit level); both latch their first error and turn later reads into zero-returning no-ops, so a decoder can read a whole object and check once. Every declared length is capped before allocation (`maxSectionBytes` = 512 MB, `lwMaxVertices`, `maxReactors`) — a count that reaches `make()` or a loop must be checked first, because "the object runs out eventually" is not a bound when the object is 512 MB — and the extended-entity-data loop is capped too, since a corrupt non-zero length would otherwise spin until the object ran out. A slice-bounds panic here would be a denial of service with extra steps.

**Testing.** Two kinds, deliberately. `container_test.go` runs against **real** drawings — a synthetic DWG would only prove our reader agrees with our writer — supplied out of band because customer drawings must not live in the repo (docs/workflow.md):

```bash
DWG_FIXTURES=/path/to/dwgs go test ./internal/cad/dwg/
```

The assertion ladder is what makes it evidence rather than a smoke test, and each rung proves the one below it:

1. Section names come out as clean ASCII (`AcDb:Header`, `AcDb:Handles`, `AcDb:AcDbObjects`, `AcDb:Classes`) and `AcDb:Header` begins with the 16-byte `headerSentinel` — so the header decryption, decompressor, Reed-Solomon strip, page-address running total and section-map layout are all simultaneously right.
2. Every offset the object map produces lands on an object that **identifies itself with the handle the map gave it** (`object_test.go`). One wrong byte anywhere below resynchronises on garbage, and garbage does not name itself correctly 139,000 times.
3. Type codes are cross-checked by **counting**, since nothing else can confirm them: BLOCK, ENDBLK and BLOCK_HEADER must be equinumerous, SEQENDs cannot be fewer than the polylines that require them, and the nine table-control objects are singletons. These held exactly on every fixture.
4. Every decoded entity **finishes exactly on `dataStop()`** (`entity_test.go`). This is the rung that proves the field layout rather than sampling it: a decoder that misreads any field lands somewhere else, and the odds of landing on the right bit anyway are one in the object's length. 84,993 entities across five fixtures land exactly, R2004 among them. The strings-present flag doubles as an independent check — every decoded type *but the two text ones* is pure geometry with no string field, so a wrong landing would have to read zero on an arbitrary bit every time. The exemption is narrow and named by type rather than waived: when TEXT and MTEXT first landed, the counts this assertion reported were **exactly** the per-fixture text counts, which is what identified the check as needing a type test rather than the decoder as needing a fix. R2004 was **excluded** from this rung and the next until a fixture for it existed, which is a hazard worth naming: a version-gated skip silently narrows the strongest assertion in the suite, and the per-file log line is the only place the narrowing is visible.
5. Every decoded entity also **exhausts its handle stream**. That stream states no length of its own — it simply runs to the end of the object — but the object is padded to a byte, so a correct decoder finishes within seven bits of the end and cannot do so having read one handle too few, since the shortest handle is a byte. This assertion is what caught the framing error above, and it is enforced in `readEntity` rather than only in the tests. It belongs to the entity rather than to the shared block: only the type knows whether it has references of its own, which POLYLINE (its vertices) and INSERT (its block and attributes) do.
6. Every entity's **layer reference resolves to an object the map knows, and that object is a LAYER** (`handles_test.go`). Rung 5 proves the stream's extent, not the *order* of what is in it — a stream correctly framed but wrongly labelled consumes exactly as many bits. This is the check on meaning: handles are dense enough that a wrong offset would still resolve to *objects* fairly often, but it would land on dictionaries and vertices and text styles rather than on layers every single time. It doubles as a second check on the data stream, because which handles precede the layer is decided entirely by flags read from the data.
7. The **extent is plausible** — finite, wider than a millimetre, narrower than 10⁶ km. Landing proves the layout but says nothing about whether the bits were read as the right *kind* of value; a coordinate read byte-reversed still consumes 64 bits. Real drawings are bounded, and misread doubles land at 1e300 or at denormal zero, never in the range a building occupies. The bound has to stay loose because the drawing's units are not known at this stage.
8. Every object's **string stream falls inside the object's own extent**. Enforced in `readObject` rather than in a test, so every fixture walk asserts it on all ~139,000 objects. This is the only thing in the reader that reads *backwards* from the end of the data, which makes it the only thing that can detect a framing error in that direction — and it is what exposed the modular-short prologue above, on the 7 objects large enough to have one.
9. Every LAYER record **lands exactly and exhausts its handle stream** (`table_test.go`), the same pair as rungs 4 and 5, and sufficient here because the record has no field whose length does not depend on the ones before it. What landing cannot prove is *meaning*, and the meanings matter — a misread visibility bit hides geometry the user expected to see — so two facts knowable without the file are asserted too: a layer named `0` exists, because the application creates one and will not let it be deleted, and **`Defpoints` and only `Defpoints` is non-plotting**, because the dimensioning tools mark it so on creation. That second one pins the bit positions independently of the framing: a decoder reading the values short at the wrong offset does not single out one layer by name. A majority of layers being visible is checked as a polarity guard, since no fixture has a layer that is off or frozen and both readings of that bit therefore agree on all of them.
10. Every **VERTEX is claimed by exactly one polyline** (`polyline_test.go`) — no orphans, no vertex claimed twice, no named handle that is not a vertex. This is the rung landing cannot reach: a polyline's vertex *count* comes from the data stream and the handles it counts come from the handle stream, so a miscount consumes a different number of handles and still finishes somewhere legal. Counted across the drawing it cannot hide — reading one too many steals the next polyline's first vertex, leaving that one short and this one claiming a vertex twice; one too few orphans the last. 90,304 vertices in 1,796 runs of 4 to 132 points, plus 1,803 more in canteen, each claimed once.
11. **`dwg.Read` names every entity's layer** (`document_test.go`) — 41,104 across four fixtures, each naming a layer the table declares. The reference and the table are decoded from opposite ends of an object by unrelated code, so they agree only if both are right, and a wrong reference lands on a real *object* far more often than on a real *layer*. This is the end-to-end rung: it is the assertion that the model's "reference by name, never by handle" rule is actually satisfied rather than merely intended.
12. **Ownership agrees from both ends** (`block_test.go`). A block header lists the objects it owns by handle; each of those objects separately says who owns it — either by naming the handle back, or by spending two bits to say "model space" or "paper space" and naming nobody. This is the *only* check available on the two-bit form: read as the wrong value it is still a legal value, the object still lands exactly, its handle stream is still exhausted, and the only visible consequence is that a wall ends up filed under the title block. The header's list catches it because the list must contain exactly the objects that claimed it and no others. 161 block headers across five fixtures own 41,913 entities with zero unowned, zero mismatched, zero claiming a space their listing block is not, and zero owned twice. The distribution is itself the finding: `patient-chairs.dwg`'s largest block holds 1,131 entities against model space's 27.
13. **Inserts expand into a drawing** (`block_test.go`). A block reference is not geometry, so the test that it decoded correctly is not that the INSERT parsed but that expanding it yields a drawing — the same extent arrived at by a different route. `Document.Flatten` must leave no unexpanded insert, report no missing block (every reference was already resolved to a name at parse time, so a missing one here means a different bug), not truncate, produce *more* entities than it consumed, and yield a finite plausible extent. patient-chairs goes 27 → 11,855 entities at 7,791 × 5,267; canteen 24,497 → 39,451.
14. **The header's nine table-control handles resolve to the nine control types, in order** (`headervars_test.go`). A header variable has no name, no tag and no length — position is the only thing identifying it, so the section cannot be checked the way everything above it is: there is no field that disagrees with itself, and every misreading yields a number rather than an error. Except in the handle stream. Nineteen of its values are handles, and nine of those are the table controls whose types are fixed by the format, so the section makes nine falsifiable claims about a part of the file it does not own. Landing (which `readHeaderVars` enforces) proves the walk consumed the right *number* of bits and cannot distinguish a correct walk from a wrong one costing the same; these can, and they reach back through the whole list, since the controls come after the dimension block, which comes after both coordinate systems, which come after the timestamps. Three more handles are checked the same way — paper space is a BLOCK_HEADER, the named-object root is a DICTIONARY, and model space must be the *same* handle the block table independently calls `*Model_Space` — plus `$HANDSEED`, which must exceed every handle in use and is the only value in the section read as a handle from the **data** stream rather than the handle stream.
15. **The header's extents and the geometry's describe the same drawing** (`headervars_test.go`). `$EXTMIN`/`$EXTMAX` are eighteen doubles about two thirds of the way through the walk; every entity's coordinates come from a different section entirely, so the two agreeing is a statement about both. They are not asserted equal — extents go stale the moment something is deleted without a regen, which is why `cad.Bounds` recomputes — but within a factor of four, which is loose on purpose: a field-offset error misses by orders of magnitude or by sign, never by a third. The failure it is really watching for is reading the **paper-space** set, since the section states the same nine values twice and only the second is the drawing; on these fixtures a sheet of paper is out by a factor of several hundred. Measured agreement is 0.1–3% on four fixtures (canteen: header 91,391 × 55,120 against geometry 91,316 × 53,205) and 11% on `map-of-uae.dwg`, which contains annotation this reader does not decode yet.

16. **Every decoded text value is non-empty and readable UTF-8** (`entity_test.go`). This is the rung rung 4 cannot reach, and the reason it has to exist: from R2007 a string lives in its own stream, so locating that stream wrongly costs the data cursor nothing and the entity still lands exactly. A string stream found even slightly off decodes as replacement characters or as nothing at all, so the bar is **all 3,733** strings across the five fixtures rather than most — a file where this slips is a file where the room names arrive as mojibake, which is a defect the user sees and the reader does not. The escape languages are tested separately and without fixtures (`internal/cad/text_test.go`), because `\U+9910\U+5385` → 餐厅 is a claim about a published convention rather than about any one file.

A fixture legitimately decoding **zero** entities is not a failure — a drawing may be built entirely from types not decoded yet — so the guard against the decoder quietly finding nothing drawable is taken across the whole fixture set rather than per file.

`bitreader_test.go` is the opposite case: the bit encodings are self-contained, so patterns written by hand from the specification *are* independent evidence, and they exercise branches (reserved patterns, truncation, the `DD` partial-replacement forms) that real files rarely take.

---

## 7. Worker — Cloudflare (`worker/`)

Local-only pub/sub + webhook replay for the data-link layer. Two Durable Objects:

- **`WebhookQueue`** — per `sourceToken`. SQLite-backed FIFO. Caps: 1000 events (LRU), 64 KiB per payload, 7-day retention with daily prune alarm. Methods: `register`, `enqueue`, `drain`, `lastReceivedAt`, `alarm`.
- **`LiveStream`** — per `streamToken`. SQLite + WebSocket hibernation. Snapshot table (10k assets LRU) + event log (50k rows, 24h retention). New WS subscribers get snapshot on connect; `getEvents(from, to, limit)` for replay.

### Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/healthz` | none |
| GET | `/api/v1/test/bins?count=N&seed=S&format=...` | API key / JWT |
| POST | `/api/v1/auth/issue-jwt` | API key |
| POST | `/webhooks/:token/register` | API key |
| POST | `/webhooks/:token` | HMAC sig |
| GET | `/webhooks/:token/drain?max=N` | API key |
| POST | `/streams/:token/register` | API key |
| POST | `/streams/:token/publish` | HMAC sig |
| GET | `/streams/:token/ws` | API key |
| GET | `/streams/:token/stats` | API key |
| GET | `/streams/:token/events?from=ms&to=ms&limit=N` | API key |
| POST | `/streams/:token/proxy-outbound` | API key |

HMAC signature format: `X-Webhook-Signature: t=<unix-sec>,v1=<hex>` over `${t}.${rawBody}`.

CORS: restricted to `http://localhost:5173` by default. `nodejs_compat` flag enabled. Compatibility date `2026-06-01`.

> The worker's production role has been **deprecated** — live streams now use the Go backend's WebSocket endpoint directly. The Worker remains for local dev pub/sub testing + CORS-bypass proxy.

---

## 8. End-to-end tests (`e2e/`, `playwright.config.ts`)

Playwright tests, single worker, 2 CI retries.

- **`globalSetup.ts`** — polls backend `/healthz` (30s), creates/reuses E2E tenant, sets `current-tenant` setting.
- **Env vars**: `PLAYWRIGHT_BASE_URL` (default `http://localhost:5173`), `PLAYWRIGHT_API_URL` (default `http://localhost:8080`), `PLAYWRIGHT_API_KEY`.
- **Test utils**: `waitForBackendReady`, `navigateTo`, `selectTenantIfPrompted`, `createWarehouse`.

### Specs
- `smoke.spec.ts` — landing + nav.
- `warehouse.spec.ts` — warehouse CRUD.
- `import.spec.ts` — CSV upload via "Link external data" wizard (Match → Mapping → Preview → Commit).
- `integrations.spec.ts` — REST source create/delete; tenant switcher.
- `image.spec.ts` — image upload + preview.
- `ws-live.spec.ts` — WebSocket subscriber flow.

Only happy paths covered; no error/permission tests.

---

## 9. Build pipeline + scripts (`scripts/`)

- **`build-models.mjs`** — converts multi-file glTF packs (in `public/models/<slug>/scene.gltf` + `.bin` + `textures/`) into self-contained `.glb` using **gltf-pipeline** (CesiumGS). Idempotent (skips if `.glb` newer than `.gltf`); `--force` to rebuild. Wired into `npm run build`.
- **`generate-model-thumbnails.mjs`** — renders `public/models/thumbs/<id>.webp` (256 px) for every `BUNDLED_MODELS` entry with the app's own `renderModelThumbnail`, against a running dev server: `node scripts/generate-model-thumbnails.mjs [http://localhost:5173] [--force]`. Skips existing files unless `--force`; re-run after adding a bundled model (the catalog points every bundled entry at its thumb).
- **`publish-live-stream.mjs`** — simulator for HMAC-signed live events. Five modes: `asset` (orbiting forklifts), `sensor` (temp drift), `rfid` (random walks), `shipment` (state machine), `camera` (perimeter + CV). Args: `--url --token --secret --mode --assets --hz --center --radius ...`. Used heavily in TESTING.md walkthroughs.

`npm run build` chains: `models:build` → `tsc -b` → `vite build`.

---

## 10. Static assets

- **`public/locales/<lang>/translation.json`** — 6 languages (en, es, fr, de, ar, zh).
- **`public/models/thumbs/<id>.webp`** — pre-rendered previews for the built-in models (`scripts/generate-model-thumbnails.mjs`).
- **`public/models/<sketchfab-pack>/`** — built GLBs from `models/*.zip` source packs.
- **`public/icons.svg`**, **`public/favicon.svg`**.

Bundled 3D packs (Sketchfab, CC BY 4.0 — attribution in `CREDITS.md` and each folder's `license.txt`): basket_shelving, forklift_with_rig, industrial_forklift, rusty_metal_shelving, simple_factory_scene.

---

## 11. Data fixtures

The project is a multi-tenant SaaS. Customer-specific sample data (CSVs, GeoJSON, backup JSON, etc.) **does not live in the repo** — each tenant configures their own warehouse + uploads their own data through the Integrations screen. The only fixtures kept in-tree:

- **`map-styles.json`** — the basemap list (Mapbox public styles); edit only this file to add or rename a style.

---

## 12. Environment variables

### Frontend (`.env.example`)
- `VITE_MAPBOX_ACCESS_TOKEN` (required) — Mapbox token.
- `VITE_API_BASE_URL` (optional) — production API URL; dev proxies to backend.
- `VITE_BACKEND_URL` (optional) — override dev proxy target (default `http://localhost:8080`).
- `VITE_API_KEY` (optional) — only used when backend enforces auth.
- ⚠️ `VITE_WORKER_BASE_URL` is **deprecated**.

### Backend (env-var override of `config.dev.yaml`)
- `SGV_DATABASE.URL`, `SGV_AUTH.API_KEY`, `SGV_AUTH.JWT_SECRET`, `SGV_AUTH.BOOTSTRAP_EMAIL`, `SGV_AUTH.BOOTSTRAP_PASSWORD`, `SGV_STORAGE.BASE_PATH`, `SGV_STORAGE.BASE_URL`, `LOG_LEVEL`, etc.
- `SGV_DEMO.ENABLED` (default `true`) — seed the demo workspace into an empty database on first start (§6.5 Demo workspace). Compose: `SPATIAL_MAP_DEMO`.
- **AI Map** (`SGV_AI_WORKER.*`): `URL` (points the Go API at the Python worker; default `http://ai-worker:8100` — the compose-network hostname. Empty disables the feature server-wide and returns 503 on `/detect`. Under `make dev` the Go binary runs on the host, so override to `http://localhost:8100` to reach the host-mapped worker port), `REQUEST_TIMEOUT` (default `30s` — per single HTTP call: enqueue POST or one poll GET), `POLL_INTERVAL` (default `3s` — pace of `GET /detect/{taskId}` until terminal), `POLL_MAX_DURATION` (default `300s` — absolute wall-clock ceiling for a single job's polling, matches the Python Dramatiq `time_limit`), `MONTHLY_CAP_PER_TENANT` (default `200`), `HOURLY_RATE_PER_TENANT` (default `20`), `HOURLY_BURST_PER_TENANT` (default `3`). Also required: `SGV_REDIS.URL` (Dramatiq broker, worker-side only) and `SGV_STORAGE.MINIO_*` on **both** services (worker fetches image bytes from the same MinIO bucket the API writes to). Per-tenant opt-in is orthogonal: `app_settings` key `ai_floorplan_enabled:tenant:{id}` = `"true"`. No mock mode: an offline dev path would need a stub HTTP server matching the worker's `/detect` contract — leaving `SGV_AI_WORKER.URL` empty is the kill switch.

### Worker (`.dev.vars`)
- `API_KEY`, `JWT_SECRET`, `ALLOWED_ORIGINS`.

---

## 13. Data flow — end-to-end

### Auth path
1. User visits `/login` → `auth-client.login(email, password)` → bare `fetch` to `/api/v1/auth/login`.
2. Backend looks up user by lowercase email, verifies bcrypt hash, issues HS256 JWT, returns `{token, user, tenants[]}`.
3. Frontend `auth-store.setSession()` persists to localStorage; `resetTenantStore()` clears prior tenant pick.
4. `<AuthGuard>` sees `token` is set → renders protected route.
5. Every subsequent `apiFetch` stamps `Authorization: Bearer <token>`.
6. `TenantMiddleware` verifies the requested `X-Tenant-Id` is in the user's `user_tenants`. 403 if not.

### Boot path (returning user, token still in localStorage)
1. Page loads → `auth-store` hydrates from localStorage (token + user + tenants present, `ready=false`).
2. `<AuthGuard>` calls `refreshSession()` → `GET /auth/me`.
3. Server validates token (sig + exp + not issued before the last password change), returns fresh `{user, tenants}`. On a 401/403 → `auth-store.clear()` → redirect to `/login`. A network error or 5xx keeps the persisted session (the API may just be restarting).
4. `ready=true` flips → guard renders the route. Tenant picker uses the first owned tenant by default.

### Password reset path
1. `/login` → "Forgot password?" → `/forgot-password?email=…` → `POST /auth/password-reset-request` (same answer whether or not the account exists).
2. User enters the emailed code → `POST /auth/password-reset-verify` → 15-min single-use `resetToken` (React state only).
3. New password + confirm → `POST /auth/password-reset-complete` → `password_changed_at = now()`; every older JWT now 401s with `session_revoked` (other tabs/devices: `api-client` clears the session and `/login` shows why); "password changed" email sent.
4. Done screen → `/login?email=…` → normal auth path.

### Read path (open warehouse)
1. `initTenantStore()` → backend `settings/current-tenant` (or create default).
2. `useSpatialStore.loadAll()` → parallel `apiDb.<kind>.toArray()`.
3. Each call → `api-client.apiGet('/<kind>')` with `X-Tenant-Id`.
4. Backend filters by `tenant_id`, returns `{data: T[]}`.
5. `applyServerEntity` updates store; components re-render via `useSpatialStore` selectors.

### Write path (user drags a polygon vertex)
1. UI calls `useSpatialStore.updateLocal('polygons', id, patch)`.
2. Store merges into `drafts`, schedules 400ms flush. UI renders optimistically from drafts.
3. Flush → `apiDb.polygons.update(id, draft)` → `apiPatch('/polygons/{id}', body)`.
4. Backend: validate → merge JSON → `UpdatePolygon` query → `BroadcastEntityEvent('UPDATED', 'polygons', id, tenantID)`.
5. Response sync callback → `applyServerEntity` → drafts reconciled (any newer user edits preserved).
6. SSE event broadcast to all subscribed clients → they `loadEntity('polygons', id)`.

### PDF floor-plan import path
1. Image tool (`i`) → user picks a `.pdf`. `handlePickImageFile` sniffs via `isPdfFile` and parks it in `pendingPdfFile` instead of uploading.
2. `<PdfPagePicker>` mounts → `POST /pdf/inspect` (multipart) → page inventory + 24-DPI inline thumbnails + ranked plot scales. **Nothing is stored.**
3. User picks a sheet and a scale (or types a known real-world width, which inverts to a denominator via `scaleForRealWorldWidth`).
4. Confirm → `POST /pdf/render` re-sends the same bytes with `page` + `dpi` → PDFium rasterizes, DPI is clamped to the 4096 px texture cap, PNG is `Put` into the object store → `201 { url, naturalWidth, naturalHeight, effectiveDpi, … }`.
5. `handleConfirmPdfPage` builds an ordinary `ImageDraft` from the response **plus `realWidthMeters`/`realHeightMeters`** from `realWorldSize`.
6. User drags on the map. `useImagePlacementTool` sees the real dimensions and snaps the bbox — height resize first, then width (§5.12) — so the drag picks position only.
7. `createLocal('images', …)` → normal write path from here. The PNG is referenced by an `images` row exactly like a direct upload, so §6.7's refcount/cleanup applies unchanged.

### CAD (DWG) floor-plan import path
1. Image tool (`i`) → user picks a `.dwg`. `handlePickImageFile` sniffs via `isCadFile` and parks it in `pendingCadFile`.
2. `<CadImportDialog>` mounts → `POST /cad/inspect` (multipart) → release, units (+ ranked guesses when `$INSUNITS` is 0), extents, per-layer entity counts. **Nothing is stored.**
3. User confirms the units and ticks the layers to import; the dialog shows the resulting building size so a wrong unit is obvious.
4. Confirm → `POST /cad/render` re-sends the same bytes with `layers` + optional `units` → the chosen layers are flattened, debris-trimmed, tessellated and drawn onto a PNG, which is `Put` into the object store → `{ url, mimeType, naturalWidth, naturalHeight, bytes, widthMeters, heightMeters, … }` (§6.12). The unticked layers are gone *before* extents are measured, so the stated ground size is the building's, not the sheet's.
5. `handleConfirmCadDrawing` builds the same `ImageDraft` the PDF picker does — `rewriteFilesUrlSameOrigin(render.url)` plus `realWidthMeters`/`realHeightMeters` from the response, and `sourceKind: 'dwg'` purely so the side panel can say where it came from. No upload step: `/cad/render` already stored the PNG.
6. User drags on the map. `useImagePlacementTool` snaps the bbox to true size exactly as it does for a PDF sheet — better, in fact, since the size is authored rather than inferred from a sheet size.
7. `createLocal('images', …)` → normal write path, and from here a drawing is a floor plan like any other: `MapImageOverlay` mounts the raster, crop / transform handles / elevation / the default-floor-plan pin / `hiddenFloorPlanIds` all apply, and §6.7's refcount and cleanup cover the file (§5.13).

### Offline path
1. `apiFetch` detects offline + mutating + JSON body → `enqueueOfflineRequest()`.
2. Throws `ApiError('queued', 'network')`.
3. On `online` event → `flushOfflineQueue()` → ordered replay → max 3 retries on failure.

### Live data path (asset positions)
1. External system POSTs HMAC-signed event → Worker `/streams/:token/publish`.
2. Worker `LiveStream` DO fans out to WS subscribers + updates snapshot table.
3. Or: external system → Go backend `/api/v1/streams/{token}/ws` (WebSocket multicast).
4. Frontend `live-stream-client.ts` receives → updates `data-link` store → Mapbox layer paint updates.

---

## 14. Caching strategy

| Layer | TTL | Invalidation |
|---|---|---|
| `apiDb` (Dexie-shaped over REST) | Until next backend UPDATE | SSE → GET latest row |
| `spatial-store` (in-memory) | Session | SSE, manual `loadKind`, flush |
| `drafts` (optimistic edits) | Until flush reconciles | Manual / on response |
| `queryCache` (useApiQuery SWR) | Session | `invalidate(prefix)` or `mutate()` |
| `inspectorCache`, `blobUrlCache` | Session | Manual on delete |
| `offline-queue` (IndexedDB) | Until replay | Manual `clearQueue` or 3-retry drop |

---

## 15. Notable architectural patterns

1. **Multi-tenant by `tenant_id` column** on every catalog table; middleware extracts `X-Tenant-Id` to request context.
2. **Optimistic mutations with debounced flush** (400ms) + draft reconciliation — preserves in-flight user edits.
3. **Dexie-shaped API facade** (`apiDb`) — components written against Dexie continue to work with REST backend.
4. **Sync callbacks before SSE echo** — `api-db` notifies `spatial-store` on response (faster than waiting for SSE round-trip).
5. **Opacity bucketing** for Mapbox 3.x — fill-extrusion-opacity can't take data expressions, so features route to per-opacity layers.
6. **Role vocabulary fallback** — old shapes without `role` backfill to `DEFAULT_ROLE_VOCABULARY` on read.
7. **Lazy GLB inspector loading** — model schema parsed + cached on first observation.
8. **Generic shape CRUD** in Go (`shape_crud.go`) — 10+ shape types share one set of handlers.
9. **First-read migrations** — image data URIs and inline model Blobs upload to object store on first fetch, patching the row.
10. **Two-click grid draw mode** with anchor dot (no live preview) — user can adjust config while drawing.

---

## 16. Dev workflow

### Local dev
```bash
# Terminal 1 — backend
cd backend && make up                # PostgreSQL + Go API on :8080

# Terminal 2 — frontend
npm install
npm run dev                          # Vite on :5173, proxies /api → :8080

# Terminal 3 (optional) — worker
cd worker && npm run dev             # wrangler dev on :8787

# Terminal 4 (optional) — simulator
node scripts/publish-live-stream.mjs --mode asset --hz 2 ...
```

### Tests
```bash
npm run e2e:stack                    # docker compose up backend
npm run e2e                          # playwright run
npm run e2e:ui                       # playwright UI mode
```

### Backend changes (SQL)
```bash
cd backend
# Edit queries/*.sql or migrations/*.sql
make sqlc                            # Regenerate internal/db/*.sql.go
make migrate-up                      # Apply pending migrations
```

### Building production
```bash
npm run build                        # models build + tsc + vite build
```

---

## 17. Known issues / cleanup needed

- 🟡 Backend placeholder packages (correlation, outbound, retention) are scaffolding only.
- 🟡 E2E coverage is happy-path only; no frontend unit-test runner (add Playwright specs).
- Track new issues on GitHub rather than here.

---

## 18. Maintenance protocol for this file

This document should reflect the codebase at all times.

When code changes, update the affected section(s):
- **New file in `src/lib/`** → §5 (categorize into the right subsection).
- **New component or route** → §3.
- **New file under `src/routes/create-grids/`** → §3.1 (the subfolder table).
- **New backend handler / route** → §6.4.
- **New `internal/` package** → §6.1, plus its own §6.x if it carries non-obvious domain logic (see §6.11).
- **New CAD/drawing import format** → §5.12 (frontend flow) and §6.11 (PDF render primitive) or §6.12 (vector CAD readers).
- **New entity kind, container version or reader in `internal/cad/`** → §6.12 (the file table and the container table).
- **New migration** → §6.3 and (if it touches a table you already documented) §6.2.
- **New endpoint on the worker** → §7.
- **New env var** → §12.
- **New e2e spec** → §8.
- **Schema change to a shape type** → §5.4 and §6.2.
- **Architectural decision** (caching, batching, etc.) → §15.
- **Known issue resolved** → §17.

For larger refactors, re-scan the affected areas and bump the date at the top.

Convention: keep section numbering stable across edits — add new subsections rather than renumbering, so existing references stay valid.
