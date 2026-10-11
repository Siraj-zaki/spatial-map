# Backend pitfalls

Read this before touching handlers, migrations, the object store, or auth — every entry below is a bug that actually shipped, and several are security findings.

---

## Quick rules

| Gotcha | What goes wrong | Fix |
|---|---|---|
| Manually editing `internal/db/*.sql.go` | Overwritten on next `make sqlc` | Edit `queries/*.sql` instead |
| Adding tenant_id to request body | Trust boundary violation | Read tenant from context |
| Adding a JWT library | Already implemented in stdlib at `internal/auth/jwt.go` | Use `auth.IssueToken` / `auth.ParseToken` |
| Storing plaintext passwords or weak hashes (md5/sha1) | Credential leak risk | `auth.HashPassword` (bcrypt) only |
| Skipping the `user_tenants` membership check for a JWT user | Cross-tenant data leak | Use `TenantMiddleware(queries)` (already wired); for owner-only routes call `requireRole(w, r, q, RoleOwner)` |
| Comparing an API key or signature with `==` | Timing leak lets the secret be guessed byte by byte | `api.APIKeyMatches` / `hmac.Equal` |
| Mounting a streaming endpoint outside `TenantMiddleware` | Every tenant's events reach every client (the pre-2026-10 `/events`) | Read it with `fetch` + headers on the SPA side; filter by tenant in the broadcaster |

---

## Security & auth

### Wire every new `/auth/*` mutating endpoint into the rate limiter

**Symptom** — The abuse mitigations for signup/login live in `handlers/auth.go::AuthRouter`. Each mutating endpoint gets a per-IP chi middleware (`api.RateLimitByIP(...)`) AND a per-email `api.KeyedLimiter` that runs inside the handler after body decode. A new endpoint that skips both is a fresh email-bomb or brute-force target the moment it ships. The password-reset trio (`/password-reset-request`, `-verify`, `-complete`, 2026-09) is the worked example: request and verify have both limiters in their own buckets, complete has per-IP only because it requires a reset token. Skipping the per-email limiter is the more common miss because it lives in the handler body, not in the router wiring where the eye naturally lands.

**Fix** — When adding a mutating `/auth/*` endpoint, create both limiters at the top of `AuthRouter` alongside the existing six (`otpSendIP`, `otpSendEmail`, `otpVerifyIP`, `otpVerifyEmail`, `loginIP`, `loginEmail`), wrap the route with `r.With(api.RateLimitByIP(newIPLimiter, tooManyMsg)).Post(...)`, and pass the new email limiter into the handler factory. Inside the handler, call `if ok, wait := emailLimiter.Check(email); !ok { api.TooManyRequests(w, wait, tooManyMsg); return }` (sets `Retry-After` for the SPA's countdown) AFTER body decode + email normalization but BEFORE any DB work (so timing doesn't leak whether the email exists). Limits are process-local — a horizontally-scaled deploy needs Redis. Tests: extend `internal/api/ratelimit_test.go`; the frontend `ApiError` from `unauthenticatedJson` in `src/lib/auth-client.ts` already carries `status: 429` so surface a user-friendly "slow down" message.

### Never trust `X-Forwarded-For` outside `api.ClientIP` (and never re-add chi's `middleware.RealIP`)

**Symptom** — Chi's `RealIP` rewrites `r.RemoteAddr` from the header unconditionally. Combined with the rate limiter, that lets any internet caller rotate `X-Forwarded-For` per request and bypass every per-IP throttle we have. This exact bug shipped in the first hardening pass and was verified as exploitable by a live curl demo — 5 rotated-XFF requests all reached the handler while the raw IP was hard-blocked. `api.ClientIP` in `internal/api/ratelimit.go` now only honours those headers when the TCP `RemoteAddr` matches a configured trusted-proxy CIDR (`SGV_SERVER.TRUSTED_PROXIES`, empty = trust nothing).

**Fix** — Never call `r.Header.Get("X-Forwarded-For")` directly for rate-limit or audit-log purposes — use `api.ClientIP(r)`. If you introduce a new middleware that stamps a "real IP" into context, gate it behind `api.isTrustedProxy(r.RemoteAddr)` the same way. Config: `SGV_SERVER.TRUSTED_PROXIES: ["10.0.0.0/8", "192.168.1.1"]` (list of CIDRs or bare IPs). Bad entries fail `SetTrustedProxies` and the server exits — better a failed boot than a silent bypass.

### Equalise bcrypt work across "account exists" branches of unauthenticated endpoints

**Symptom** — An endpoint that answers identically for known and unknown emails can still leak existence through latency if only one branch does bcrypt work. `signup-request` shipped that way: the new-address branch hashed an OTP (~60–80 ms) while the existing-account branch did none, so response time alone told an attacker which addresses were registered. Found and fixed during the 2026-09 auth redesign.

**Fix** — Whichever branch skips the expensive work calls `auth.DummyVerify(...)` to burn the same bcrypt cost. `signup-request` does it on the existing-account branch; `password-reset-request` does it on the missing-account branch. Background email sends run in goroutines, so they don't affect latency either way.

### Call `auth.DummyVerify` on the "user not found" branch

**Symptom** — Any `GetUserByEmail` → `ErrNoRows` path that returns 401 without calling `auth.DummyVerify(req.Password)` first reintroduces the timing side-channel that lets an attacker enumerate valid accounts by measuring response latency (real bcrypt = 60-80 ms, missing user = <1 ms). Bit login the first time.

**Fix** — For any endpoint that authenticates by (email + secret), always run `auth.DummyVerify(secret)` on the not-found branch before returning the generic-error response. `DummyVerify` uses a package-init-precomputed bcrypt hash so its per-call cost matches `VerifyPassword`. Test the two costs stay within 3x of each other (see `hash_test.go`) — drift silently re-opens the enumeration vector.

### Return identical status codes whether or not the email exists

**Symptom** — Returning a status code that differs between "email exists" and "email doesn't exist" on any unauthenticated endpoint is a user-enumeration channel. The old `signup-request` 409-on-existing-email was exactly that — a caller could probe any address to learn whether it had an account. Even without a body diff, the HTTP status code alone is enough.

**Fix** — Return the same status (typically 200) for both cases; branch server-side only in what you send by side-channel (an email to the affected user, a log entry, a mailer selection). See `authSignupRequest` for the template: identical 200 envelope for both paths, `mailer.SendAlreadyRegistered` vs `mailer.SendOTP` decides what the affected user actually receives.

### Destructive routes need a role gate, not just tenant membership

**Symptom** — every `/data` delete, bulk-delete and purge only went through `TenantMiddleware`, which proves *membership*, not role. A viewer could `POST /data/rows/purge` and wipe every record a source had ever ingested; the UI hid nothing either.

**Fix** — `DataScreenRouter(q, pool)` wraps each destructive route in `r.With(dataRoleGate(q, RoleOwner, RoleAdmin, RoleEditor))` (a middleware around `requireRole`). Editor, not admin: scheduled replace-all REST syncs purge from editors' browsers (`rerun.ts` → `purgeDataRecords`), so `App.tsx` also only runs `useDataSourceScheduler` for `canEdit` members. When you add a mutating route to a router that has none, decide the role explicitly. Guarded by `TestDataScreenDeleteRoles`.

### A per-object ACL doesn't outrank the workspace role

**Symptom** — a member demoted to viewer could still edit every report they had created (and any they'd been granted `can_edit` on): `resolveReportAccess` returned edit for "creator" and for the grant without looking at the role, and the SPA showed Edit because the API said `canEdit: true`.

**Fix** — `roleCanEditReports(role)` caps both branches, in `resolveReportAccess` and in the directory list. Any resource with its own ACL (reports today) needs the workspace role as an upper bound, not just as one of the ways in. Guarded by `TestReportArchiveRestore`.

---

## Files & object storage

### Always delete file URLs through `cleanupObjectURL` (it refcounts)

**Symptom** — Deleting a file-owning shape row without calling `cleanupObjectURL` — or building the URL cleanup as "look up the key and delete unconditionally" without the refcount step — breaks other rows. `store.KeyFromData` is `{name}-{sha256[:12]}.{ext}`: pure content-addressed, no nonce. Two users uploading the same bytes (very common with shared floor plans, brand logos, stock 3D models) legitimately end up with two DB rows pointing at the same key. If the first row's delete unconditionally removes the file, the second row now serves a broken `/files/{key}` → 404. Users then blame the "phantom deletion" that came from their innocent teammate clicking Delete on their OWN copy. Also bit avatars: a user replacing their avatar with the same image would have both rows pointing at the same key.

**Fix** — Always go through `handlers.cleanupObjectURL(ctx, q, s, url)` in `internal/handlers/file_cleanup.go`. It calls `q.CountFileURLReferences(url)` first and only physically deletes when the count is zero. When adding a new URL-holding table or column, EXTEND both `queries/file_cleanup.sql::CountFileURLReferences` (add the new `+ (SELECT COUNT(*)…)` line) AND `ListReferencedFileURLs` (add the new UNION branch). The generic `shapeDeleteWithFile` helper in `shape_crud.go` is the canonical wiring — new file-holding shape kinds should use it. Full audit + fix history in the file-lifecycle section of `docs/backend.md`.

### Don't flip `SGV_STORAGE.TYPE` from `local` to `minio` in one step

**Symptom** — The `MinIOStore` reads only from the bucket. Every legacy file in `./uploads/` becomes a `/files/{key}` → 404, which shows up as a black square where a floor plan used to be, a blank 3D model, a missing avatar. No data is lost (`./uploads/` is untouched), but the UI silently degrades because file reads aren't logged at warn level — just plain 404s from the proxy handler.

**Fix** — The safe sequence is (1) boot MinIO, (2) set `SGV_STORAGE.TYPE=minio-fallback` and restart the API — `FallbackStore` tries MinIO first, falls through to the local disk on `ErrNotFound`, and info-logs every fallback so operators can watch the tail shrink, (3) `make migrate-storage` copies `./uploads/` → bucket idempotently, (4) flip to `SGV_STORAGE.TYPE=minio` once fallback-log volume drops to zero. When implementing a new `ObjectStore`, its `Get` MUST translate the backend's not-found error into `store.ErrNotFound` — that's what `FallbackStore` keys on to decide "try the secondary" vs. "surface the transport error"; returning a wrapped filesystem/HTTP error instead makes fallback silently useless.

### Hiding a URL kind from a listing means hiding it from enumeration and DELETE too

**Symptom** — Excluding a URL kind from a listing query while leaving it in the refcount query (`CountFileURLReferences`) produces a silent-no-op DELETE that returns 204 with no effect. Concrete case: avatars were dropped from `ListFileReferencesByTenant` to declutter the Files gallery, but `CountFileURLReferences` still counted them. So an avatar file showed as an "orphan" card (no visible references), the user clicked delete, the DELETE handler's live/ghost checks passed (no visible refs), and `cleanupObjectURL(url)` ran → refcount returned 1 (the avatar) → `s.Delete` skipped → handler returned 204 → user sees "success" → file reappears on next fetch because the DB row still points at it. From the user's perspective the app is broken.

**Fix** — Any URL-kind you exclude from a UI-facing listing MUST ALSO be excluded from the bucket enumeration AND rejected at the DELETE endpoint. For avatars: added `ListAvatarURLsByTenant`, the Files handler skips bucket keys whose URL matches an avatar, AND the DELETE handler returns `409` explicitly when the target is an avatar. Never rely on `cleanupObjectURL`'s refcount alone to prevent the delete — it silently no-ops instead of erroring, which the caller cannot distinguish from a successful delete. If you later add a per-tenant secret asset (say, `tenant_branding.logo_url`) and want to hide it from the gallery, mirror all three steps: skip in `ListFileReferencesByTenant`, filter in the enumeration, refuse in DELETE.

### The object store is shared by every tenant — ownership comes from `tenant_files`, not the bucket

**Symptom** — The Files screen listed every object in the bucket and looked up references only for the current tenant, so (1) a file another workspace used had no refs here and showed as an **orphan** — name, preview and download leaked across tenants, and Delete answered 204 while `cleanupObjectURL`'s *global* refcount quietly kept it; (2) even after skipping other tenants' referenced files, **unused** uploads had no tenant at all and appeared in every workspace.

**Fix** — Record ownership at upload time (`recordTenantFile` → `tenant_files`, migration 0043, backfilled from existing URL columns) and list only owned ∪ referenced keys; DELETE 404s anything else. Keys are content-addressed, so one object can have several owners — Files-screen delete drops only the caller's row and physically deletes only when `CountTenantFileOwners` is 0. Owner-less legacy objects are deliberately listed to nobody and left to `cmd/cleanup-orphans`. Guarded by `TestFilesTenantScope` (`files_test.go`, testcontainers: upload recording, foreign + owner-less files hidden, shared-file delete, paging). A new upload endpoint that skips `recordTenantFile` makes its files invisible until something references them.

### Don't persist an intermediate file no DB column will ever reference

**Symptom** — Persisting a user-uploaded source file that no DB column will ever point at (the PDF behind a rendered page, a source DXF, an intermediate archive) puts it on the sweeper's chopping block. `cmd/cleanup-orphans` diffs bucket keys against `ListReferencedFileURLs` and reclaims the difference — correctly. An intermediate file with no referencing row is indistinguishable from a genuine orphan, so it gets swept, and whatever workflow assumed it was still there breaks later and remotely.

**Fix** — Don't store intermediates. The browser still holds the original `File`, so a multi-step import can simply re-send the bytes on the second call — that costs upload bandwidth and buys a completely unchanged file-lifecycle story. Store only the artifact that lands on a real row (for PDF import: the rendered PNG on an `images` row, which then flows through the existing refcount/cleanup path with zero new code). If an intermediate genuinely must persist, it needs its own table + a branch in both `CountFileURLReferences` and `ListReferencedFileURLs` (see the file-lifecycle section of `docs/backend.md`).

---

## Deletes & cascades

### A zone delete CASCADEs — shapes do not survive as "unassigned"

**Symptom** — Deleting a warehouse (zone) row and expecting its shapes to survive detached is wrong. Migration `0027_cascade_zone_delete` (2026-07) flipped every `zone_id` FK from `ON DELETE SET NULL` to `ON DELETE CASCADE`. That was explicitly requested — the SET NULL behaviour was leaking both DB rows (shapes with no warehouse the UI couldn't render) AND their object-store files (nothing was reclaiming them). A `DELETE FROM zones` now removes every child shape row across 17 tables (images, image_planes, models, grids, polygons, circles, lines, markers, stairs, text_labels, doors, routes, streams, data_sources, share_links, data_link_configs, attribute_definitions) in one FK cascade.

**Fix** — If a workflow needs "detach shapes from a warehouse, don't delete them," build an explicit `PATCH /zones/{id}` step that reassigns them to another warehouse (or nulls `zone_id` on the shapes) BEFORE the caller hits DELETE. Do NOT roll back the migration to restore SET NULL — the file-reclaim path in `deleteZone` assumes CASCADE (it SELECTs URLs before the delete, then cleans them up after; SET NULL would leave both rows and files behind). If reversing is genuinely needed, also revert `deleteZone` to just the DELETE (removing the URL-collection step) and add a background job that re-reclaims detached rows' files.

### An integration delete must be blocked by linked `data_link_configs`, not silently cascade

**Symptom** — `data_link_configs.source_id` and `data_link_configs.stream_id` are both `ON DELETE CASCADE`. So `DELETE FROM data_sources WHERE id = X` also erases every dlc row a user deliberately configured on the map — no warning, no undo. This is what tripped the Integrations page in 2026-07 when it flipped from soft-delete to hard-delete.

**Fix** — `deleteDataSourceMirror` in `backend/internal/handlers/data_link.go` now runs a pre-flight `ListDataLinkConfigRefsForSource` query. If any dlc rows reference the source (directly OR via a stream with `data_source_id = X`), the handler responds `409 Conflict` with `{ reason: "linked-configs", linkedConfigs: [{id, name, zoneId, zoneName}] }` and does nothing. The SPA (`src/lib/data-link/source-service.ts::deleteBinSource`) parses that into an `IntegrationLinkedError`; both `src/routes/integrations.tsx` and `src/components/data-link/data-sources-section.tsx` render it inline via `formatIntegrationLinkedMessage` so the user sees exactly which warehouse + dlc name to unlink first. Only after the last dlc reference is removed does the delete proceed. There is deliberately NO `?force=true` override — silently erasing configs is what we're preventing. Design flipped from the pre-2026-07 soft-delete-and-hope model: integrations now hard-delete when unblocked, and every downstream row (source_files, data_source_rows, entity_states/events) cascades cleanly. If you add a new table/column that references `data_sources` or `streams`, extend `ListDataLinkConfigRefsForSource` if it should participate in the guard, OR make its FK `ON DELETE CASCADE` if it's a pure derivative.

### Deleting a zone CASCADES to every shape in it

**Symptom** — the editor's "Delete facility" promised "Shapes in this facility will become unassigned", but every shape table's `zone_id` FK is `ON DELETE CASCADE`; the client's unassign loop sent `{ zoneId: undefined }`, which `stripServerFields` drops, so the PATCHes were empty and the cascade deleted the shapes (plus data sources, streams, share links, data-link configs and attribute definitions, which genuinely go with the zone).

**Fix** — `handleDeleteZone` clears `zone_id` with one `POST /bulk-assign { zoneId: null, kinds }` (routes, which bulk-assign doesn't cover, get one PATCH each) before deleting the zone. To clear a nullable column from the SPA send `null`, never `undefined`.

---

## Handlers, queries & scale

### `api.InternalError` must log the actual error

**Symptom** — Returning a 500 with "internal server error" but no log line makes the cause invisible in production logs.

**Fix** — The helper now calls `slog.ErrorContext(r.Context(), "internal server error", "path", ..., "method", ..., "error", err)` before responding. Server logs surface the underlying SQL/runtime error; the client message stays opaque.

### Heavy list views aggregate server-side, not client-side

**Symptom** — Adding client-side filter/sort/paginate to a list view that hits N raw tables doesn't scale past hundreds of rows and wastes wire traffic. The `/warehouses` table instead fetches via a single server-aggregated endpoint (`GET /api/v1/warehouse-summaries`) that does one SQL trip with CTE aggregates + a `COUNT(*) OVER()` window for the total + a small stats query for tenant-wide KPI cards.

**Fix** — When adding a new heavy list view, mirror this pattern: dedicated server endpoint with allow-listed sort, parameterized filters, capped `pageSize`, and per-response tenant-wide stats so the KPI cards don't need a second round-trip.

### Reuse `buildWarehouseViewPayload` instead of hand-writing the WarehouseView

**Symptom** — The public warehouse view has 12 parallel `Wait`ed queries (`ListGridsByZone`, `ListPolygonsByZone`, ..., `ListBinsByGridZone`) plus a `WarehouseView` struct with 12 sliced fields plus per-shape `toXxxResponse` conversions. Duplicating that boilerplate makes the `/share/{token}` endpoint drift from `/public/warehouses/by-token/{token}` — a new shape kind added to one path silently misses the other, and viewers-through-share-links stop seeing the new kind.

**Fix** — Use `buildWarehouseViewPayload(q, r, zone, ok)` from `backend/internal/handlers/public_warehouse.go`. It returns `(WarehouseView, bool)` so the caller (`PublicShareHandler` in `share_links.go`) can wrap it inside a richer envelope. The `buildWarehouseView` variant that writes the response inline is kept for the existing `/public/warehouses/by-token/{token}` path. When adding a new shape kind, extend the payload builder — both endpoints then pick it up for free.

### Kind-wide SSE reloads go through `BroadcastEntityKindEvent`, never a zero-id `BroadcastEntityEvent`

**Symptom** — Reaching for `BroadcastEntityEvent` with a synthetic zero id to mean "reload everything of this kind" does nothing: the function early-returns on `id == 0`, so the broadcast is silently dropped and the feature appears to work locally (the caller refreshed its own snapshot) while every other tab and client stays stale. Weakening the guard is worse: the id comes from reflection over the response struct, so 0 is exactly what a *failed* reflection returns, and letting it through converts a bug into a kind-wide reload storm nobody can trace.

**Fix** — Use `BroadcastEntityKindEvent(type, kind, tenantID)` — it sends `id: "0"` deliberately, and `useSSE.ts` reads that as "reload this entire kind". Per-row events stay the default; kind-wide is for bulk paths where N per-row fetches would replace one wholesale reload. Never relax the zero-id guard in `BroadcastEntityEvent`.

---

### A "partial success" batch in one transaction needs a savepoint per item

**Symptom** — `POST /tables/{id}/rows/bulk` promised "valid rows still commit", but one row that failed *in the database* (e.g. a `\u0000` that jsonb rejects) put the transaction into the aborted state: every later statement failed with "current transaction is aborted" and the commit 500'd, losing the valid rows too. The same handlers looked up insert-vs-update *after* the upsert, so the audit trail always said "update".

**Fix** — run each item under `tx.Begin(ctx)` (a pgx savepoint) and roll back only that savepoint on error — `bulkUpsertRows` in `table_rows_public.go`, used by both the public and the authed bulk routes. Decide the operation before writing. Guarded by `TestBulkUpsertSavepoints`.

---

### The router's 60s timeout cancels long-lived connections

**Symptom** — `middleware.Timeout(60s)` wraps every route, so `r.Context()` is cancelled 60s after a request starts. The SSE stream died every minute (plus the server's 30s `WriteTimeout`), and the WebSocket ingest loop kept running on a cancelled context, so every DB write from a device connected for more than a minute failed silently.

**Fix** — SSE pushes its write deadline forward per write (`http.NewResponseController`) and ends the stream itself at ~50s; the client reconnects at once. The WS reader uses `context.WithoutCancel(r.Context())` with a 15s timeout per message.

---

### Out-of-order device events must not roll state back

**Symptom** — devices batch, buffer offline and retry, so an older reading can arrive after a newer one; an unconditional upsert moved the entity back. Silently stamping unreadable timestamps with `now()` made ordering meaningless.

**Fix** — the `UpsertEntityState` conflict update has `WHERE entity_states.last_seen_at <= EXCLUDED.last_seen_at`; a stale event returns no row (`pgx.ErrNoRows`), which `writeEntityEvent` reports as stale while still logging history. Reject far-future timestamps (`parseEventTime`, 5 min tolerance) — with the guard, one device with a bad clock would otherwise freeze that entity until its fake time passes.

---

### Compare Postgres enums as text in dynamic SQL

**Symptom** — `GET /data/runs` returned 500 on every call (`operator does not exist: import_job_status = text`), so the Data page's Runs tab and the Integrations run history never loaded. The handler compared the `import_job_status` enum column with a `$3::TEXT` filter param, and its stats query used `IN ('error','failed','partial')` — `failed` isn't an enum value, which Postgres also rejects at runtime. Both compile fine.

**Fix** — cast the column, not the parameter: `j.status::text = $3`, `j.status::text IN (…)`. Guarded by `TestDataRunsList` (testcontainers, real Postgres) in `handlers_test.go`; add a case there when you touch another enum-filtered dynamic query.

## Schema & typing

### A table field's `dataType` is asserted in three places, and constrains nothing on write

**Symptom** — The type set is asserted in **three** files that nothing checks against each other: the `FieldDataType` union (`src/lib/tables-client.ts`), the `oneof` validate tag on `FieldDefinitionRequest.DataType` (`backend/internal/handlers/tables.go`), and `FIELD_DATA_TYPES` (`src/lib/table-field-types.ts`). Widen only the union and the picker offers a type the API rejects with a validation error naming no field; widen only the tag and nothing can select it. There is deliberately **no CHECK constraint** on `table_field_definitions.data_type`, so the DB won't catch the drift either. The second half is the more dangerous belief: the declared type is **not enforced on write**. `validateRowPayloadCtx` (`table_rows_public.go`) checks required-presence and uniqueness and nothing else, so a field declared `number` accepts `"hello"` through the public token API — `coerceFieldValue` runs in the SPA's own editors only.

**Fix** — Extend all three lists together, add the `tables.fieldTypes.<value>` label to all six locales, and add a `typedCompareExpr` branch (`data_source_query.go`) if the type needs a non-text SQL comparison. Treat client coercion as an input affordance, never a trust boundary. Note the two type vocabularies meeting in the filter DSL: `inferFieldType` emits `number`/`boolean`/`date`/`string` while a table field declares `date`/`datetime`/`time`, and the pre-2026-08 code switched on `"date"` alone — so a declared `datetime` silently compared **lexicographically as text**, which reads as "range filters on my timestamp column return nonsense" and not as a type-name mismatch. Both vocabularies are listed in `typedCompareExpr` now; keep it that way.

### A `validate:"required"` tag outlives the migration that made the column nullable

**Symptom** — `data_link_configs.stream_id` was made nullable by migration `0034` so a `kind='table'` source (which never gets a mirror stream) could back a layer on its own. `dataLinkConfigParams` was updated to map `streamId: 0` → NULL, and the SPA was updated to send 0. The endpoint still 400'd with `validation failed on StreamID`, because `DataLinkConfigRequest.StreamID` kept its `validate:"required"` tag and `required` on an `int64` rejects the zero value. Nothing in the schema, the params mapper, or the SPA hinted at the culprit — the DB column had been nullable for two migrations by then. The generic helpers make this easy to miss: `shapeCreate` and `shapeUpdate` (`shape_crud.go`) both call `api.ValidateStruct` for you, so the check that rejects the request is nowhere near the handler you're reading.

**Fix** — when a migration drops a NOT NULL, grep the matching request struct for `validate:` in the same change. Where the new rule is "at least one of these two", encode it with paired `required_without` tags rather than a hand-rolled check, so the generic CRUD helpers keep enforcing it: `StreamID int64 \`validate:"required_without=SourceID"\`` + `SourceID *int64 \`validate:"required_without=StreamID"\``. The field name in the tag is the **Go** field name, not the JSON name. `TestDataLinkConfigRequestStreamOrSource` (`data_links_test.go`) pins all four combinations and needs no database.

### Two share paths coexist: legacy `zones.share_token` vs the `share_links` table

**Symptom** — Confusing the legacy `zones.share_token` (migration `0006`) with the new `share_links` table (migration `0024`). The legacy `zones.share_token` is one-token-per-warehouse, no expiry, no view cap, no per-link settings, and resolves through `/api/v1/public/warehouses/by-token/{token}` → returns a raw `WarehouseView`. The new `share_links` table is many-per-warehouse, each row carrying a JSONB `settings` blob (map style, palette, theme mode, default floor plan, layer visibility, hidden data-link configs, per-config filters, chrome flags, watermark, notes), plus expiry, max_views, view_count, revocation. It resolves through `/api/v1/share/{token}` → returns `{ link: { settings, ... }, warehouse: WarehouseView }`. The frontend viewer (`src/routes/view.tsx`) calls the new endpoint FIRST via `useShareLink(token)`; if that returns 404 it falls back to `usePublicWarehouse(token, { token: true })` so old links keep working.

**Fix** — When you add a new customisation option to the presentation viewer, add it to `ShareLinkSettings` in `src/lib/share-link-client.ts`, then a control in `src/components/share-link-dialog.tsx`, then a consumer in `view.tsx`. The backend never interprets `settings` — it's opaque JSONB — so no migration is needed per option. Do NOT extend the legacy `zones.share_token` path with new settings; it's frozen at the old envelope shape. The dialog itself creates + revokes + edits + deletes rows via `share-link-client.ts`. The two share buttons — the row-level Share on `/warehouses` and the toolbar Share on `/create-grids` — BOTH open the same `ShareLinkDialog`; the copy-only quick action from the pre-2026 code has been removed. Callers that render their own copy of the link list (the `/warehouses` Share-links column) deep-link into it with `initialTab` / `initialEditLinkId` and re-sync via `onLinksChanged` — the dialog resets its draft on open precisely because that column can swap `zone` underneath it.

**Never gate share UI on `shareToken`.** `WarehouseSummaryRow.shareToken` is still returned, but it is the *legacy* column and is NULL for every warehouse created since `0024`. Until 2026-08 the `/warehouses` row action carried `disabled={!row.shareToken}`, which left the Share button permanently dead on new facilities even though sharing worked fine from the editor — the dialog it opens never reads that token. Anything that asks "can this facility be shared?" is asking about `share_links` (`shareLinkCount` on the summary row), and the answer for the *create* flow is always yes.

### `make sqlc` says a column "does not exist" right after you added it

**Symptom** — `queries/*.sql:…: column "zone_id" of relation "tenant_files" does not exist` although the migration adds it. sqlc doesn't read the DB or the migrations folder — only the files listed under `schema:` in `backend/sqlc.yaml`.

**Fix** — append the new `NNNN_*.up.sql` to that list (the shape recipe in `docs/backend.md` says so; it's easy to miss for a non-shape migration). While there: qualify columns in an `UPDATE … SET x = (SELECT … FROM other_table …)` (`WHERE user_models.id = $1`) — sqlc reports bare `id` as ambiguous once a subquery joins another table with an `id`.

### A new enum value can't be used in the migration that adds it

`ALTER TYPE … ADD VALUE 'x'` commits fine, but any statement in the same transaction that references `'x'` (a partial index `WHERE kind = 'x'`, an `INSERT`) fails with "unsafe use of new value". Migration 0046 keys its unique index on `config->>'facilityEntity'` instead of `kind = 'facility'` for this reason; queries in later migrations or in `queries/*.sql` can use the value normally.

### `INSERT … ON CONFLICT` burns a sequence value even when it conflicts

Every upsert attempt calls `nextval`, so an "ensure these rows exist" upsert on a hot path (the Report Builder's source list runs `FacilitySourceIDs` on every open) silently jumps the id sequence by N per call. Read first and upsert only what's missing — see `ensureFacilitySources` in `internal/reports/facility.go`.

### Generic data-source lists must exclude `kind = 'facility'`

Built-in facility sources (migration 0046) are real `data_sources` rows so every report path keeps its numeric source id — but they have no rows, no fields table and no stream. `ListDataSources`, `ListDataSourcesIncludingArchived` and `ListDataSourcesByEntityKind` filter them out so Tables, Data, Integrations and the layer editor never offer them; only `ListFacilitySources` (Report Builder) returns them. A new list query over `data_sources` needs the same `kind <> 'facility'` unless it is report-specific.

### Date ranges compare whole days: `onOrAfter` / `onOrBefore`

`lte '2026-10-08'` against a `timestamptz` column means "before midnight on the 8th" and silently drops everything later that day. Viewer date-range filters use the queryx ops `onOrAfter` / `onOrBefore`, which compare `(field)::date` with the date part of the value (`dayOp` in `internal/queryx/op.go`). Booleans from viewer params arrive as strings — `ScalarArg` accepts `"true"` / `"false"` for boolean fields.

