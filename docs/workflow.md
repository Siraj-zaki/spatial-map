# Build, test & git workflow

Consult this file when running or writing tests, starting the stack, regenerating SQL code, building for production, or committing.

## Testing

- **E2E** (Playwright): `npm run e2e:stack` to spin up backend, then `npm run e2e`. Backend must be reachable at `localhost:8080`, frontend dev server at `localhost:5173`.
- Tests use `globalSetup.ts` to create an E2E tenant. Don't hardcode tenant IDs — read from `E2E_TENANT_ID` env.
- Use `test-utils.ts` helpers (`waitForBackendReady`, `navigateTo`, `createWarehouse`) — extend them rather than duplicating logic.
- **Backend unit tests**: `cd backend && make test` (`-race -count=1`). Uses `testcontainers-go` for Postgres.
- **No unit tests on frontend yet.** Don't introduce a new test runner; add to Playwright if you need coverage.

## Self-hosted stack (Docker)

`docker compose up -d` at the repo root runs the whole app on :3000 (`SPATIAL_MAP_PORT`): the `web` image (root `Dockerfile` — Vite build served by nginx, which proxies `/api` and `/files` to the API; `docker/web/40-spatial-map-config.sh` writes `/config.js` from `SPATIAL_MAP_*` env at start), the `api` image (`backend/Dockerfile`), Postgres/PostGIS, MinIO and Redis. Only `web` is published; the API trusts forwarded client IPs from the compose network (`SPATIAL_MAP_TRUSTED_PROXIES`). Settings live in the root `.env` (`.env.example`), which Vite reads too. The Mapbox token is a runtime setting (`src/config/runtime.ts` reads `window.__SPATIAL_MAP_CONFIG__` before `VITE_*`), so one published image serves any token.

- **Files copied into the web image must be world-readable** — the Dockerfile `chmod`s the html root; a `0600` locale file once 403'd and silently dropped every translation.
- **Postgres healthchecks use TCP** (`pg_isready -h 127.0.0.1`): on first start the image runs a socket-only init server that would report ready too early.

## Releases

1. Move the `[Unreleased]` notes in `CHANGELOG.md` under a new `## [x.y.z] - date` heading and add the compare links.
2. Commit, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` builds `ghcr.io/siraj-zaki/spatial-map-{api,web}` for amd64 + arm64 (tags `X.Y.Z`, `X.Y`, `latest`) and creates the GitHub release from that CHANGELOG section.

## Build & dev commands

```bash
# Start backend (Postgres + Go API)
cd backend && make up         # docker compose
cd backend && make run        # bare metal (needs local Postgres)

# Start frontend
npm install
npm run dev                   # Vite on :5173, proxies /api → :8080

# Start worker (optional)
cd worker && npm run dev      # wrangler dev on :8787

# Production build
npm run build                 # models:build → tsc -b → vite build

# Backend SQL changes
cd backend && make sqlc       # regenerate db code after editing queries/*.sql
cd backend && make migrate-up # apply migrations

# One-time: seed the initial admin user (creates user + links to all existing tenants as owner)
cd backend && SEED_EMAIL=you@example.com SEED_PASSWORD=somepassword go run ./cmd/seed-admin
```

**Don't run `npx prettier` on a file.** There's no Prettier config in the repo, so it formats with defaults (double quotes, semicolons) and rewrites a single-quote, no-semicolon file wholesale. Match the surrounding style by hand; ESLint is the only enforced check.

**If `npm run build` fails:** fix the underlying TypeScript/ESLint error — don't paper over it with `any` or disable comments. CI runs the same checks.

## Git & commit hygiene

- Keep commits focused and small; one logical change per commit.
- Open pull requests against `main`; CI (`.github/workflows/ci.yml`) must pass.
- Files **never** to commit:
  - `.env`, `.env.*` other than the `.env.example` templates, and a filled-in production config (copy `backend/config.prod.example.yaml` outside the repo).
  - Customer or sample data: CSV/XLSX exports, GeoJSON facility fixtures, database dumps, backup JSON — generate test data with the seed scripts instead.
  - 3D assets or images whose license doesn't allow redistribution and commercial use (see `CREDITS.md`).
  - `node_modules/`, `dist/`, `playwright-report/`, `test-results/`, `backend/uploads/`.
