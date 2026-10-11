# Backend patterns

Read this before touching anything under `backend/` — adding a shape kind, an endpoint, a file-owning column, or an auth/role check.

---

## Adding a new shape type (end-to-end recipe)

1. **Migration** — create `backend/migrations/00NN_<name>.up.sql` + `.down.sql`. Include `tenant_id BIGINT NOT NULL` + index, plus any geometry/PostGIS columns. Register the up file in `backend/sqlc.yaml`'s `schema:` list.
2. **Queries** — write `backend/queries/<name>.sql` with `:one|:many|:exec` annotations. Keep the column order in INSERT/SELECT/RETURNING matched to the model struct so sqlc reuses `db.<Entity>` instead of generating per-query Row types.
3. **Generate** — `cd backend && make sqlc`. Edit nothing in `internal/db/`.
4. **Handler** — create `backend/internal/handlers/<name>.go`. **Use generic CRUD helpers** in `shape_crud.go` (`shapeCreate`, `shapeGet`, `shapeList`, `shapeUpdate`, `shapeDelete`) — don't reimplement boilerplate.
5. **Routes** — register on the router (find existing shape route block, follow the pattern).
6. **SSE entity-kind alias** — add the singular handler name to the switch in `sseEntityKind()` (in `backend/internal/handlers/shape_helpers.go`) so the broadcast event uses the plural hyphenated kind the SPA listens for. Frontend then needs the same kind in `useSSE.ts`'s `VALID_KINDS`.
7. **SSE broadcast** — handled automatically by the `shape_crud` helpers (`BroadcastEntityEvent` is called inside `shapeCreate`/`shapeUpdate`/`shapeDelete`).
8. **Public WarehouseView** — if the shape should appear in shared views, add it to the aggregator in `public_warehouse.go` (new field on `WarehouseView`, new `[]db.<Entity>` local, new `q.List<Entity>ByZone` call inside the `errgroup`, new `to<Entity>Response` append loop).
9. **Tests** — extend `handlers_test.go` or add `<name>_test.go` with testcontainers Postgres.
10. **Reports** — if users should be able to report on the kind, add a `FacilityEntity` to `internal/reports/facility.go` (subquery + fixed `Fields`), its explorer subtitle / editable columns in `facility_report.go`'s `explorerFacts` (and a report in `facilityReportMeta` + `FacilityReportSet` if it should get its own), the API kind to `parseFacilityKey` + `tableFor` in `src/lib/reports/facility-sources.ts`, an icon in the wizard's `FACILITY_ICON`, and `reports.facility.entities/fields` keys in all six locales. Extend `TestFacilitySources`.

**Frontend follow-up** (a new kind is half the work — the spatial-store wiring is the other half):

- Type in `src/lib/shapes.ts`; add to the `ShapeKind` union and the `NonGridShape` discriminated union.
- Generator at `src/lib/<kind>-generators.ts`.
- Overlay at `src/components/map-<kind>-overlay.tsx`; mount it in `src/routes/create-grids/layers/OverlayStack.tsx` next to the sibling overlays (registration order there IS click priority — see the click-priority section of `docs/frontend.md`).
- Editor wiring, one file per folder: `src/routes/create-grids/state/use<Kind>EditorState.ts` (config + draft + selection), `handlers/use<Kind>Handlers.ts` (create/patch/delete callbacks), `hooks/use<Kind>PlacementTool.ts` or `use<Kind>DrawTool.ts` (map event bindings). Then wire all three into `create-grids/index.tsx`.
- `src/lib/spatial-store.ts`: add the plural-hyphenated kind to `EntityKind`, `CatalogEntity` union, `ALL_KINDS`, `tablePath`, `kindStateKey`, the state slice + its `[]` initial value.
- `src/lib/api-db.ts`: `<kind>: makeTable<Shape>('/<kind>', { dateFields: [...] })`.
- `src/lib/mutation-queue.ts`: add to its own `tablePath`.
- `src/lib/useSSE.ts`: add to `VALID_KINDS` — **missing this is the most common silent regression**; everything appears to work until SSE-driven reloads lose the row.
- `src/hooks/useSpatialShapes.ts`: `useSpatial<Kind>()` hook.
- `src/lib/keyboard-shortcuts.ts`: add to `Tool` union + `CREATION_TOOLS` + `TOOL_SHORTCUTS`.
- `src/components/map-toolbar.tsx`: add to `LayerVisibilityKind`, `LAYER_ROWS`, and the `drawTools` flyout.
- `src/components/side-panel.tsx`: extend `SidePanelMode` with `<kind>-placement` / `<kind>-selected` (+ bulk if applicable); add header branch; add `Saved<Kind>sContent` workspace-tree section + mount it; add `<Kind>SelectedContent` editor with the **Actions → properties** Section order (Move / Fit / Duplicate / Delete in a row, then kind-specific sections). Look at `PolygonSelectedContent` / `ModelSelectedContent` / `ImagePlaneSelectedContent` as canonical templates.
- i18n: add every new key in **all six** `public/locales/<lang>/translation.json` files (toolbar.toolCreate<Kind>, toolbar.layer<Kind>, sidePanel.saved<Kind>sTitle, sidePanel.layer_<kind>, plus any kind-specific labels).

---

## Adding a new endpoint

- Routes are declared in `cmd/api/main.go` (or wherever the chi router is wired). Find the right section (public / api-key-only / tenant-scoped) by what auth it needs.
- Wrap with `APIKeyMiddleware` and `TenantMiddleware` as appropriate.
- Use response envelope helpers from `internal/api/response.go`: `JSON(w, http.StatusOK, data)`, `BadRequest(w, msg)`, `NotFound(w)`, `InternalError(w, err)`, etc. Don't `json.NewEncoder` directly.
- Decode + validate request with `api.ValidateBody[T](r)` (uses validator/v10 struct tags).

## PATCH semantics

Always **fetch → merge → validate → update all fields**, not sparse update. The shape_crud `shapeUpdate` helper does this. This is what lets the frontend send partial patches mid-drag without losing untouched fields.

## Tenant scoping — non-negotiable

- Every query that touches a tenant-scoped table **must** include `WHERE tenant_id = $1` (plus the entity filter).
- Pull tenant from request context: `tenant.FromContext(r.Context())`.
- Never accept tenant_id from request body.
- Public/share-token endpoints are the only exception; they read `is_public` + token from URL.

## Real-time fan-out

- **SSE** for catalog events (anything other clients should re-fetch). Call `BroadcastEntityEvent` from the handler after the DB commit.
- **WebSocket** for live data fan-out only (stream tokens). Don't use WS for catalog mutations.
- Sends are non-blocking; slow clients drop messages. Don't change that — it's intentional.
- `/events` is tenant-scoped: it sits behind `TenantMiddleware` and each stream only receives its own tenant's events. Every broadcast must carry the right `tenantID` — an event with the wrong one simply never arrives.
- A long-lived connection (SSE, WebSocket) must not do work on `r.Context()` past the router's 60s `middleware.Timeout`: SSE rotates its stream at ~50s; the WS reader uses `context.WithoutCancel` plus a per-message timeout.

## Device and webhook ingest

- **Signed webhooks.** A webhook stream with an `hmacSecret` requires `X-Webhook-Signature: t=<unix>,v1=<hex>` (HMAC-SHA256 of `<t>.<raw body>`, ±300s). Verify against the raw bytes before parsing (`checkWebhookSignature` in `handlers/webhook_signature.go`). `requireSignature: false` in the source config is the only way to accept unsigned posts.
- **Secrets compare in constant time.** Use `api.APIKeyMatches` / `hmac.Equal`, never `==` / `!=`.
- **Event time.** Parse publisher timestamps with `parseEventTime` (RFC 3339, epoch s/ms; far-future rejected) — never fall back to `now()` silently. Latest-state upserts keep the `WHERE last_seen_at <= EXCLUDED.last_seen_at` guard; write through `writeEntityEvent`, which treats the resulting `pgx.ErrNoRows` as "stale".
- **Bound every ingest body** with `http.MaxBytesReader` and an item-count cap; return 413 with a "send smaller batches" message.
- **Partial-success batches need savepoints** — see `bulkUpsertRows`.

---

## File uploads

- Multipart parsing via Go stdlib. Store via `objectStore.Put(ctx, key, contentType, data)`. The `ObjectStore` interface in `internal/store/store.go` has two backends: `LocalStore` (filesystem) and `MinIOStore` (S3-compatible). A `FallbackStore` wrapper composes them for zero-downtime cutovers. Backend selected by `SGV_STORAGE.TYPE={local,minio,minio-fallback}`.
- Keys are deterministic: `{name}-{sha256[:12]}.{ext}`. Don't roll your own scheme.
- **Uploads remember their facility.** An optional multipart `zoneId` on `/images/upload` and `/user-models/upload` is stored on `tenant_files.zone_id` (and `user_models.zone_id` via the create body) — migration 0044. The zone is resolved **inside the SQL** (`(SELECT id FROM zones WHERE id = … AND tenant_id = …)`), so a zone id from another workspace silently becomes NULL; the first facility wins on re-upload. This is what the editor's upload library (`GET /library/images|models`, `handlers/library.go`) splits "This facility" from "Whole workspace" with.
- **Every upload records its owner: call `recordTenantFile(r, q, key, contentType, len(data))` right after a successful `Put`** (`file_cleanup.go`; table `tenant_files`, migration 0043). The bucket is shared by all tenants, so this is the only way an upload nobody references yet belongs to a workspace — skip it and the file is invisible on that workspace's Files screen. Wired in `/images/upload`, `/user-models/upload`, `/pdf/render`, `/cad/render`. Avatars are deliberately not recorded (profile data, never listed).
- Update the DB row's `*_url` field with the served URL (`/files/{key}`) — **always relative**. Files are served via a proxy handler (`GET /files/{key}` in `cmd/api/main.go`) regardless of backend; the MinIO endpoint is never exposed to the browser. Don't build a code path that writes a presigned/absolute URL into the DB.
- Get implementations MUST return `store.ErrNotFound` on missing keys so `FallbackStore` can fall through to the secondary. `os.IsNotExist(err)` in `LocalStore.Get` and `minio.ErrorResponse.Code == "NoSuchKey"` in `MinIOStore.Get` both translate to it.
- The cutover procedure and migration script live in `cmd/migrate-storage/main.go` (also `make migrate-storage`). Idempotent, non-destructive — safe to re-run.

## Files admin screen (`/files`)

- Route: `src/routes/files.tsx` (components in `src/components/files/`, paging in `src/hooks/useFilesPages.ts`). Client: `src/lib/files-client.ts`. Backend: `internal/handlers/files.go` mounted at `/api/v1/files`.
- **The editor's upload library is a separate, read-only endpoint** (`/api/v1/library/images|models`, any member — editors need it). Don't point the editor at `/files`: it's owner/admin-only and paged for administration.
- **Strictly tenant-scoped.** A tenant's files = keys it owns (`tenant_files`) ∪ keys its rows reference. Objects nobody owns or references are listed to no one (the sweeper reclaims them); DELETE answers 404 for anything outside the set, and only drops the caller's ownership when another tenant also owns the key.
- **Paging, filtering, search, sort and counts run server-side.** `GET /files?status=&type=&facility=&q=&sort=&offset=|page=&pageSize=` → `{rows,total,page,pageSize,stats,statusCounts,typeCounts,facilities}`. `stats` ignores filters (KPIs); `statusCounts`/`typeCounts` are each computed under the *other* filters. The client loads by `offset` so a delete shifting page boundaries never skips or repeats a row.
- Only shows when the current tenant membership is `owner` or `admin` — viewers/editors see a no-permission stub. Same role check runs on the backend (`requireRole(w, r, q, RoleOwner, RoleAdmin)`) so gating a role client-side alone isn't enough.
- 3D previews use **`@google/model-viewer`** — 30 KB web component (`components/files/file-preview.tsx`; the JSX declaration lives in `model-preview.tsx`). Don't reach for `@react-three/fiber` for previews — the model-viewer element is a one-liner and hosts its own three.js scene internally.
- Category derivation lives on the SERVER (`categorizeFile` in `files.go`), not the client. Adding a new URL-holding column requires: (1) new SELECT branch in `queries/files.sql::ListFileReferencesByTenant`, (2) if the column can be "detached" (analogous to `zone_id IS NULL`), a new `ListGhost<Kind>IDsByTenant` query + a `Delete<Kind>ByIDs` DELETE query + a branch in `deleteGhostRowsForFile`. Miss the last one and admins can see the ghost in the UI but can't reclaim it.
- Bucket enumeration uses `ObjectStore.ListObjects` (not `ListKeys` — that name was replaced when metadata was added). Content-type is derived server-side from filename extension via `mime.TypeByExtension` — the store deliberately doesn't track it because LocalStore has no place to keep it.
- **Avatars are excluded from the listing AND filtered from bucket enumeration AND explicitly rejected by DELETE.** `users.avatar_url` is personal profile data — the Files screen is a warehouse-asset gallery, so showing avatars was confusing. Three-layer defence because we got bit: (1) `ListFileReferencesByTenant` skips avatars, (2) the Files handler queries `ListAvatarURLsByTenant` and drops any bucket key matching an avatar URL BEFORE building the card list — otherwise avatar files reappear as "orphan" cards with no visible references, (3) the DELETE handler queries the same avatar URLs and returns `409` if the target is an avatar — otherwise `cleanupObjectURL` silently no-ops (refcount finds the avatar, skips `s.Delete`) and the handler returns 204 with no effect. Miss any of these three and users see "delete succeeded" then the file reappears on refresh.
- **User_model catalog entries are enriched with `usedInZones`.** A single catalog GLB placed in Hospital + Airport comes back with `usedInZones: [{id, name}, {id, name}]` on its `referencedBy` row. The `ListUserModelPlacementsByTenant` query populates this so the facility filter (`fileFacilities`) picks the file up under BOTH warehouses. Shape-kind references (image, image_plane) don't need this — they're already 1:1 with a zone.
- **Filters are server predicates.** `fileMatchesStatus`, `fileType`, `fileFacilities`, `fileMatchesQuery` in `files.go` are the single source; the client only sends params. Adding a filter means a param + predicate there and a count map if the UI shows counts for it.

## File lifecycle (delete path)

- **Per-row shape deletes** for kinds that own a file (`images`, `image_planes`) go through `shapeDeleteWithFile` in `shape_crud.go`. It fetches the URL, deletes the DB row, and calls `cleanupObjectURL` post-commit. Don't add a file-owning shape kind without wiring it through this helper — plain `shapeDelete` leaves the file orphaned.
- **An owned upload outlives its last shape.** `cleanupObjectURL` also checks `CountTenantFileOwners` and keeps the object while any workspace owns it, so deleting the last floor plan / image plane using a file leaves it reusable in the upload library. Physical deletion happens where ownership is dropped first: the Files screen DELETE, and the model-library delete (`deleteUserModel` drops the tenant's `tenant_files` row once no catalog row of that workspace points at the file). Don't "fix" orphaned-looking owned files by deleting them on shape delete — that's the behaviour the library relies on.
- **`cleanupObjectURL` (in `file_cleanup.go`) refcounts before delete.** Content-addressed keys mean two rows can point at the same file when users upload identical bytes; deleting unconditionally would leave a dangling reference. When adding a new URL-holding column, extend BOTH the `queries/file_cleanup.sql::CountFileURLReferences` and `ListReferencedFileURLs` queries — miss either and the cleanup path or the sweeper stops seeing the column. Same for a new URL-holding table.
- **Warehouse (zone) deletes** are FK-CASCADE via migration `0027_cascade_zone_delete`. The `deleteZone` handler collects image + image_plane URLs BEFORE the DELETE fires (once CASCADE runs the rows and their URLs are gone), runs the DELETE, then reclaims files post-commit. `user_models` are NOT zone-scoped so their files survive a warehouse delete — they belong to the tenant's shared catalog.
- **`user_models` catalog deletes** must count `models.config->>'modelAssetId'` refs first. The handler returns `409 Conflict` with `{ placementCount, hint }` unless `?force=true` is passed. Frontend renders a "N placements will be deleted — continue?" dialog on the 409, then resends with `?force=true` on confirm.
- **Avatar re-upload** reads the previous `avatar_url` before writing the new file, updates the row, then calls `cleanupObjectURL` on the old URL. Never skip the read — the previous file leaks otherwise.
- **`cmd/cleanup-orphans` (`make cleanup-orphans`)** is the safety-net sweeper. Dry-run by default; `APPLY=1` to commit. Keeps every referenced key AND every owned key (`ListOwnedFileKeys`) — an owned unused upload is that workspace's call on its Files screen. Reclaims owner-less backlog + crash-race stragglers. Safe to run periodically (weekly cron in prod is fine).

---

## Solutions and `?solution=` filters

- `solutions` / `solution_items` (migration 0045). Members are real FKs (`zone_id` / `report_id` / `data_source_id`, exactly one set, `ON DELETE CASCADE`) — not a kind/ref_id pair — because facility, report and data-source deletes are hard deletes and a polymorphic reference would dangle.
- Adds go through `INSERT … SELECT … FROM <table> WHERE tenant_id = $tenant AND id = ANY($ids)`, so foreign ids are silently dropped; `ON CONFLICT DO NOTHING` makes re-adding a no-op.
- To let a list endpoint filter by solution: call `solutionScope(w, r, q, "zones"|"data_sources")` → `nil` (no filter), `[]` (matches nothing) or the member ids, and add `AND ($N::bigint[] IS NULL OR <col> = ANY($N::bigint[]))` to the list, its filtered-stats query **and** any KPI block the page shows (otherwise the cards keep showing workspace totals). pgx sends a nil slice as NULL.

## Auth & permissions

- **JWT** is signed with `SGV_AUTH.JWT_SECRET`. Implemented in `internal/auth/jwt.go` using stdlib HMAC — don't add a JWT library.
- **Password hashing**: `auth.HashPassword` / `auth.VerifyPassword` (bcrypt cost 10). Don't roll your own hashing.
- **Bootstrap admin user** is created on startup by `auth.Bootstrap()` when `SGV_AUTH.BOOTSTRAP_EMAIL/PASSWORD` are set. Idempotent (skips if user exists, never rotates passwords). When wiping the local DB to start fresh, this means the user lands logged-in-ready without manual steps — don't add a separate "auto-create-default-user" path elsewhere.
- **Reading the authenticated user** in a handler: `api.UserID(r.Context())` returns the user's ID (or 0 if API-key auth was used). `api.UserEmail` likewise.
- **Role enforcement**: use the `requireRole(w, r, q, allowed...)` helper in `auth.go`. It writes the 403 response and returns `false` — caller just returns.
- **Don't trust** `X-Tenant-Id` for JWT users: the middleware already verifies membership. But if a handler needs to be stricter (e.g. owner-only), call `requireRole(w, r, q, RoleOwner)`.
- **Auth error responses carry a `code`.** Use `api.ErrorCode(w, status, code, msg)` with one of the `code*` constants in `handlers/auth.go` — the SPA maps codes to translated messages (`src/lib/auth-errors.ts`) and never shows `msg`. Add a constant there AND a case in `auth-errors.ts` for any new failure the user should see explained.
- **429s go through `api.TooManyRequests(w, wait, msg)`**, which sets `Retry-After` + code `rate_limited`. Use `KeyedLimiter.Check(key)` (not `Allow`) where you need the wait. `RateLimitByIP` already does this.
- **Changing a password must go through `UpdateUserPassword`** — it stamps `users.password_changed_at`, which is what revokes older JWTs (`api/session_revocation.go`). Call `api.NoteSessionRevocation(userID, changedAt)` afterwards so this instance cuts off immediately rather than after the 30 s cache TTL. A path that writes `password_hash` directly leaves stolen sessions alive.
- **`users` queries list every column explicitly** (`queries/users.sql`) so sqlc returns `db.User`. Adding a column to `users` means appending it to every SELECT/RETURNING list there, or sqlc silently switches those queries to per-query Row types.
- **Adding a new role**: extend the CHECK constraint on `user_tenants` via a new migration AND the constants in `auth.go`. Don't add roles by SQL update on the existing constraint.

---

## External detection calls (AI Map / Python ai-worker)

The `internal/aiworker/` package is our only outbound-HTTP-to-a-heavy-
compute-service subsystem. The Go handler is a thin dispatcher: enqueue
a task on the Python service (`backend/ai-worker/`, Dramatiq/Redis
actor running SAM 2 + Tesseract + OpenCV + Shapely) and poll until
terminal. Rules if you touch it or add a similar one:

- **Never call from the browser.** All calls go through the backend so
  tenant scoping runs consistently and the worker never has to trust
  a client-supplied tenant id.
- **Feature flag defaults to off.** Two-level gate: server-wide
  (`SGV_AI_WORKER.URL` empty → 503) + per-tenant (`app_settings` key
  `ai_floorplan_enabled:tenant:{id}` = `"true"`). Missing tenant flag =
  treated as false (privacy default).
- **Async, not synchronous.** Pipeline takes 20-180s; the endpoint
  returns 202 with a `jobId` and the goroutine writes to the `ai_jobs`
  table + broadcasts SSE. The frontend attaches to SSE and re-GETs the
  row on each event.
- **Detached context in the goroutine.** `context.Background()` with an
  explicit timeout (`Worker.PollMaxDuration + 15s`). The HTTP request
  ctx is canceled as soon as the client gets the jobId — the goroutine
  needs its own budget for the poll loop + final DB writes.
- **Cost caps + rate limits are non-negotiable.** Both a per-tenant
  hourly `api.KeyedLimiter` (fires 429 before touching the DB) and a
  monthly cap query (`CountAIJobsThisMonth`) run before the job is
  created.
- **Worker task id is persisted.** `aiworker.Client.Enqueue` returns a
  Dramatiq task id; the handler immediately writes it via
  `SetAIJobWorkerTaskID` so support can grep a lost worker log line
  back to a Go job row. Non-fatal on persist failure — the id is still
  in memory for the poll loop.
- **Log every job's duration + pipeline version.** `slog.Info` per
  completed job includes the worker task id and the Python-side
  `pipeline_version` string (embedded in the result payload; not
  promoted to its own column) so operators can bisect a regression to a
  specific worker build without a DB query.
- **The Python side owns pixel bytes.** The Go handler never loads image
  data — it hands the worker the `/files/<key>` URL and the worker
  fetches from the shared MinIO bucket directly. Both services need
  the same `SGV_STORAGE.MINIO_*` credentials for this to work.
- **Region-select crops worker-side.** The frontend sends the region UV
  bbox; the Go handler forwards it verbatim; the Python worker clips
  the pixel array and composes the region into the reprojection frame.
  Never delegate the crop to the browser — the worker needs the same
  pipeline input regardless of client type.
- **Kind vocabulary boundary lives in Python.** `run.py::_KIND_TO_SPA`
  translates the generic CV `Kind` enum to the SPA's warehouse
  vocabulary (`wall→aisle`, `room→area`); `tests/test_run_emit.py`
  fails loud if a new Kind is added without a SPA mapping. Do not add
  a Go-side adapter — the SPA-shape contract is the boundary.

Full architecture in `docs/ai-floorplan.md`, including pipeline stages,
coord math, and the poll-vs-webhook trade-off.

---

## Demo workspace pack

`internal/demo` seeds a "Demo workspace" into an empty database on first start (ARCHITECTURE.md §6.5): an embedded `pack/` holds one JSON file per table plus the floor-plan images, and `cmd/demo-export` regenerates it from a running instance.

- **A schema change doesn't break the pack, but it can leave it behind.** The loader inserts only the columns both the pack and the live table have, so a new NOT NULL column without a default fails the seed (the integration test `internal/demo/demo_test.go` catches it), and a new table kind is simply absent until you re-export. When a new entity kind joins the "~15 kind-aware lists", add its table to the exporter's `shapeTables` too.
- **Regenerate, don't hand-edit.** Load the current pack into a dev instance (fresh DB, `SGV_DEMO.ENABLED=true`), make the changes in the UI, then run the exporter against it — `-zones` with the facility ids, `-rewrite cmd/demo-export/rewrites.json`, plus any `-model-map` / `-skip` / `-blank-images` / `-set` the content needs. Review the diff of `pack/*.json` before committing.
- **Only redistributable content.** Uploaded 3D models are dropped unless mapped to a bundled one (`-model-map`), floor plans with third-party logos get `-blank-images`, and real names go through `-rewrite`. No personal data: the exporter nulls user references and source IPs, but it can't know a row's payload holds a real person — check before committing.
- **Seed once.** `app_settings` key `demo:seeded` stops a re-seed after the workspace is deleted. To start over locally, drop the database.

## Don't introduce these

- GORM, ent, sqlx (we have sqlc).
- Gin, Echo, Fiber (we have Chi).
- Logrus, zap (we have stdlib `slog`).
- A JWT library (we have minimal stdlib HS256 in `internal/auth/jwt.go`).
- Per-feature middleware files unless reused across handlers.
- **Any AGPL or GPL dependency** — MuPDF / PyMuPDF / Ghostscript for PDF, LibreDWG for DWG. See `docs/cad-import.md`.
- A second PDF/CAD rasterizer (we have `internal/pdfconv` over PDFium/wazero).
- A third-party DWG/DXF parser (we have `internal/cad/`; see `docs/cad-import.md` for why it's hand-written).

---

Related: `docs/cad-import.md` (drawing / CAD + PDF import pipeline), `docs/dwg-format.md`, `docs/ai-floorplan.md` (Python ai-worker CV pipeline), `docs/pitfalls-backend.md` (backend gotcha table), `docs/frontend.md`, `docs/conventions.md`, `docs/workflow.md`.
