# AGENTS.md — working in the Spatial Map codebase

Guidance for contributors and AI coding agents (Claude Code, Codex, Cursor, …). It carries only what applies to every change; the details live in `docs/`.

- **What exists** (file inventory, schema, routes, architecture) → [`ARCHITECTURE.md`](ARCHITECTURE.md).
- **How to write code that fits** → the `docs/` files below.
- **How to contribute** → [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Orientation

- **Project**: Spatial Map — multi-tenant indoor / facility layout editor + live data visualization on Mapbox (floors, areas, racks, markers, doors, 3D models, data links, reports).
- **Stack**: React 19 + TS + Vite + Mapbox GL 3 + Zustand 5 + Tailwind 3.4 + shadcn/ui (new-york, zinc). Backend: Go 1.25 + Chi + sqlc + PostgreSQL/PostGIS, MinIO (S3-compatible uploads), Redis. Optional Python AI worker (`backend/ai-worker`) and Cloudflare Worker (`worker/`).

---

## Doc map

| Read | Before you |
|---|---|
| `docs/conventions.md` | Name a file, component, hook, route, handler, query, or migration |
| `docs/frontend.md` | Touch React, the spatial store, styling, theming, i18n, a map overlay, loading states, or an auth screen |
| `docs/pitfalls-frontend.md` | Debug an overlay, a draw tool, a data-link layer, or anything Mapbox |
| `docs/backend.md` | Add an endpoint, a shape kind, a migration, a file upload, or an auth check |
| `docs/pitfalls-backend.md` | Debug handlers, deletes/cascades, object storage, or auth |
| `docs/cad-import.md` | Touch PDF/DWG import (`internal/pdfconv`, `internal/cad`, the import UI) |
| `docs/dwg-format.md` | Touch the DWG reader (`backend/internal/cad/dwg/`) |
| `docs/ai-floorplan.md` | Touch the AI Map tool (`internal/aiworker`, `handlers/ai_floorplan.go`, `backend/ai-worker/`, `useAIMapTool`) |
| `docs/workflow.md` | Build, run, test, or commit |

The two `pitfalls-*` files record bugs that already cost real debugging time. Skim the relevant one **before** working in that area.

---

## Golden rules

1. **Never bypass `useSpatialStore`.** Use `updateLocal` / `createLocal` / `commit`. Calling `apiDb.X.update()` from a component skips the optimistic path. (One exception: report rows of the built-in facility sources, written via `src/lib/reports/facility-sources.ts` — see `docs/pitfalls-frontend.md`.)
2. **Adding an entity kind touches ~15 kind-aware lists.** Follow the recipe in `docs/backend.md` end to end. Missing `useSSE.ts`'s `VALID_KINDS` is the classic silent regression.
3. **Never hand-edit `backend/internal/db/*.sql.go`.** Edit `queries/*.sql`, then `make sqlc`.
4. **Tenant scoping is non-negotiable.** Every tenant-scoped query filters on `tenant_id` read from request context — never from the request body.
5. **No hardcoded user-facing strings.** Add keys to all six `public/locales/<lang>/translation.json` files (en, de, es, fr, ar, zh).
6. **No hardcoded colors.** Use theme tokens (`bg-card`, `hsl(var(--token))`) so light/dark and every palette keep working.
7. **One overlay file per map layer** — `map-<thing>-overlay.tsx`. Don't extend an unrelated overlay.
8. **Don't introduce new libraries without discussion.** No Redux/React Query/styled-components/axios/MUI on the frontend; no GORM/Gin/zap/JWT-library on the backend. **Never a GPL or AGPL dependency** — the project is MIT. Bundled assets must allow redistribution and commercial use (`CREDITS.md`).
9. **Prefer project patterns over generic best practice.** This codebase is opinionated (optimistic spatial store, generic `shape_crud` helpers, opacity bucketing); mirror the nearest sibling even when a cleaner-on-paper alternative exists.
10. **No secrets or real data in the repo.** Keep commits atomic; never commit `.env*` (other than `.env.example`), dumps or customer exports.

---

## When a request is ambiguous

1. Read `ARCHITECTURE.md` for the relevant area before guessing.
2. Look at existing siblings — "add a new shape kind" → skim how `polygons` and `circles` are wired end to end and mirror them.
3. Discuss architectural changes first (new stores, new auth model, new build steps, new top-level folders).
4. Check the matching `docs/` file — "why is it done this weird way" is usually written down.

---

## Keep the docs in sync

Documentation is part of the change; a PR that adds an entity without doc updates is incomplete.

- Adding/renaming/removing files, routes, migrations, env vars → update `ARCHITECTURE.md` (see its maintenance section).
- New pattern, new rule, or a bug worth never repeating → update the matching `docs/` file.
- Only edit this file when a rule applies to **every** change, or when the doc map changes.

---

## Out of scope unless discussed first

- Introducing GraphQL, tRPC, or any new protocol layer.
- Replacing the Cloudflare worker with a different platform.
- Migrating off the Dexie-shaped `apiDb` types (the facade is intentional).
- Re-adding DWG entity extraction (walls/rooms/columns from linework) — removed deliberately; see `docs/cad-import.md`.
- Billing, plans or usage limits — the open-source edition is self-hosted with everything unlocked.
