# Naming & file conventions

Consult this file when creating any new file, folder, type, hook, store, handler, query or migration, to name and place it the way the rest of the codebase does.

## Frontend (TypeScript)

| What | Convention | Example |
|---|---|---|
| Components | `kebab-case.tsx` | `bin-editor.tsx`, `map-grid-overlay.tsx`, `mapbox-map.tsx` |
| Routes | `kebab-case.tsx` under `src/routes/` | `dashboard.tsx`, `view.tsx`, `files.tsx` |
| Large routes | `kebab-case/` folder: `index.tsx` + `state/` `handlers/` `hooks/` `layers/` `panels/` `dialogs/` | `create-grids/` — the layout editor, split by **tool**, not by layer |
| Hooks | `useCamelCase.ts` under `src/hooks/` | `useSpatialShapes.ts`, `useDebouncedMutation.ts` |
| Lib utilities | `kebab-case.ts` under `src/lib/` | `grid-generators.ts`, `api-client.ts` |
| Sub-feature folders | `kebab-case/` under `src/lib/` | `data-link/`, `style-rules/`, `door/`, `nav/`, `analytics/` |
| Types/interfaces | `PascalCase` exported, often in `types.ts` per feature | `GridConfig`, `PolygonShape`, `StyleRule` |
| React props types | `ComponentNameProps` | `MapboxMapProps` |
| Zustand stores | `useThingStore` hook name | `useSpatialStore`, `useTenantStore`, `useDoorStore` |
| Path alias | `@/*` → `src/*` (configured in tsconfig + components.json) | `import { cn } from '@/lib/utils'` |

**Map overlay convention:** Every layer rendered on the Mapbox map gets its own `map-<thing>-overlay.tsx` component (e.g., `map-grid-overlay.tsx`, `map-bin-overlay.tsx`, `map-rfid-heatmap-overlay.tsx`, `map-cv-detection-overlay.tsx`). When adding a new visualization, create a new overlay file — don't shove it into an existing one.

## Backend (Go)

| What | Convention | Example |
|---|---|---|
| Handler files | `snake_case.go` under `internal/handlers/` | `shape_crud.go`, `stream_ws.go`, `zone_duplicate.go` |
| Test files | `*_test.go` colocated | `handlers_test.go`, `upload_test.go` |
| Queries | `entity.sql` under `queries/` | `zones.sql`, `bins.sql` |
| Migrations | `NNNN_name.up.sql` + `NNNN_name.down.sql` | `0009_doors.up.sql` |
| Package names | lowercase, no underscores | `api`, `handlers`, `db`, `store` |
| Exported types | `PascalCase` | `WarehouseView`, `CreateZoneRequest` |
| Generated DB code | `internal/db/*.sql.go` — **never edit by hand** | Regenerate with `make sqlc` |
