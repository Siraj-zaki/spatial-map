# Contributing to Spatial Map

Thanks for helping! Bug reports, docs fixes, translations and code are all welcome.

## Before you start

- **Bugs / ideas:** search the [issues](../../issues) first, then open one with the template.
- **Bigger changes** (a new entity kind, a new store, a new protocol, a new top-level folder): open an issue to discuss the design before writing code.
- **Security problems:** see [SECURITY.md](SECURITY.md) — never in a public issue.

## Local setup

See the [README](README.md#development). In short: `cp .env.example .env` (add your Mapbox token), `cd backend && make up` (Postgres/PostGIS, MinIO, Redis, API on :8080), then `npm install && npm run dev` for the SPA on http://localhost:5173. `docker compose up -d` at the repo root runs the full production-style stack on :3000 instead.

## Ground rules

These keep a large codebase consistent — please read [AGENTS.md](AGENTS.md) and the topic guides in [`docs/`](docs/) before changing an area.

- **Match the surrounding code.** Naming, comment density, idioms. Mirror the nearest sibling (e.g. a new shape kind mirrors `polygons`/`circles` end to end — see `docs/backend.md`).
- **Spatial state goes through `useSpatialStore`** (`updateLocal` / `createLocal` / `commit`), never straight to the API from a component.
- **Tenant scoping is mandatory** on every tenant-scoped query, with the tenant id read from request context — never from the request body.
- **Never hand-edit `backend/internal/db/*.sql.go`.** Edit `backend/queries/*.sql`, then `make sqlc`.
- **No hardcoded user-facing strings** — add keys to all six `public/locales/<lang>/translation.json` files (en, de, es, fr, ar, zh).
- **No hardcoded colors** — use theme tokens (`bg-card`, `hsl(var(--token))`) so light/dark and every palette keep working.
- **One overlay file per map layer** (`map-<thing>-overlay.tsx`).
- **No new libraries without discussion.** Never GPL/AGPL dependencies (the project is MIT). Bundled assets must allow redistribution and commercial use — see [CREDITS.md](CREDITS.md).
- **No secrets or real data in commits** — `.env*` files (except `.env.example`), customer exports, database dumps.

## Checks

Your PR must pass CI. Run locally:

```bash
npx tsc -p tsconfig.app.json --noEmit   # typecheck
npm run lint                            # ESLint (no errors)
npm run build                           # production build
cd backend && go build ./... && go vet ./... && make test
```

There's no Prettier config — don't run Prettier over files; match the existing style.

## Pull requests

- Keep PRs focused; split unrelated changes.
- Describe what changed and why, and how you tested it (screenshots for UI changes).
- Update docs with the change: `ARCHITECTURE.md` for new files/routes/migrations/env vars, the matching `docs/*.md` for new patterns or pitfalls.
- By contributing you agree your work is released under the [MIT License](LICENSE).

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).
