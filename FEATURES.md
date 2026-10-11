# Spatial Map — Feature Inventory

---

## 🗺️ Map & Rendering

| Feature | Description |
|---|---|
| **Mapbox Map** | Core map wrapper with Mapbox GL JS 3.x |
| **Map Styles** | 8 basemap styles (standard, standard-simple, monochrome-light/dark, dusk, streets, dark, light) from `/map-styles.json` |
| **Map Toolbar** | Vertical glassy rail with all tools, layers, style picker, data actions |
| **Map Style Picker** | Switch between 8 Mapbox Studio basemap styles |
| **Layer Visibility** | Toggle per-kind visibility (12 kinds) from Layers dropdown |
| **2D Shapes** | Polygons, circles, lines rendered as fill-extrusion geometry |
| **3D Models** | GLB model placement with Mapbox `model` layer |
| **3D Image Planes** | Elevatable billboard textures with XYZ rotation via runtime GLB synthesis |
| **Floor Plan Images** | Raster floor plans with crop support and raster-elevation |
| **Stairs** | Stair shapes with compliance indicators (ADA count, run width, headroom) |
| **Doors** | Single/double/sliding/revolving doors with swing arcs and wall-snapping |
| **Text Labels** | Billboard and flat (map-aligned) text symbol layers |
| **Markers** | HTML overlay markers with Lucide icons + selection states |
| **Grids/Racks** | Two-click rack rectangle placement with configurable cells |
| **Routes/Paths** | Wayfinding paths with directional arrows and type-based coloring |
| **Opacity Bucketing** | Per-shape opacity via 11 pre-created extruded layers |
| **Selection Tint** | Theme-primary wash + outline on selected shapes |
| **Transform Handles** | Move/rotate/scale handles per shape kind |
| **Theme-tinted Handles** | Dynamic handle icon colors from CSS theme variables |
| **Clip Layers** | Mapbox `clip` layer erases basemap content inside drawn footprints |
| **Lighting System** | Ambient + directional lights, shadows, AO intensity per graphics settings |
| **Label Suppression** | Auto-hides basemap POI/place/road/transit labels |

---

## 🛠️ Creation Tools

| Tool | Shortcut | Description |
|---|---|---|
| **Pan** | V, H / 1 | Hand tool |
| **Select** | Space / 2 | Selection tool |
| **Create Grid/Rack** | G, R / 3 | Two-click rectangle rack placement |
| **Create Marker** | M / 4 | Single-click pin placement |
| **Create Circle** | C, O / 5 | Click center + drag radius |
| **Create Polygon** | P / 6 | Click vertices, auto-close or double-click |
| **Create Line/Wall** | L / 7 | Click vertices for 3D wall extrusions |
| **Create Route** | (none) / 8 | Click vertices for wayfinding paths |
| **Create Floor Image** | I / 9 | Click center + drag size |
| **Create 3D Model** | (none) / 0 | Click to place from library |
| **Create Image Plane** | (none) | Click to place vertical billboards |
| **Create Text Label** | T | Click to place editable text |
| **Create Stair** | S | Two-click bottom/top anchors |
| **Create Door** | D | Two-click jamb anchors |
| **Magic Wall** | (none) | Auto-generate walls from floor plan boundary |
| **Bulk Assign** | (none) | Move multi-selection across warehouses/floor plans |

---

## 🎨 Style & Theme System

| Feature | Description |
|---|---|
| **Theme Mode** | Light / Dark / System toggle |
| **Palette Picker** | 46 color palettes (default Zinc + 45 spectrum colors) |
| **Graphics Settings** | Shadows toggle, ambient occlusion intensity |
| **Schema Builder** | Define custom attribute fields per shape kind |
| **Style Rules** | Data-driven conditional paint overrides |
| **Color Picker** | Hex input + swatch (accepts `#abc`, `abc`, `#abcdef`, `abcdef`) |

---

## 📦 Spatial Data

| Feature | Description |
|---|---|
| **Spatial Store** | Optimistic local-first Zustand store for all entities |
| **SSE Real-time Sync** | Server-Sent Events for cross-tab entity invalidation |
| **Mutation Queue** | Debounced (400ms) auto-flush with offline queue |
| **Offline Queue** | IndexedDB-backed offline mutation store |

---

## 🔗 Data Link System

| Feature | Description |
|---|---|
| **Data Sources** | REST polling, webhook, file-upload (CSV/XLSX/JSON/GeoJSON) |
| **Stream Processing** | Record ingestion with field mapping and entity resolution |
| **Render Modes** | 9 modes: point-at-coord, point-on-shape, gauge-on-shape, shape-tint, heatmap, track, fov-cone, roi-pulse, color-label |
| **Style Rules Engine** | Conditional paint overrides from payload field values |
| **Lucide Icon Sprites** | On-demand rasterization of 1700+ Lucide icons for symbol layers |
| **Field Mapping** | Map source fields to entity keys, labels, colors, coordinates |
| **Floor Scope** | Per-config floor plan filtering with orphan detection |
| **Config Filters** | Per-config filter expressions from the Layers panel |
| **Cluster Modes** | Native Mapbox geographic clusters + manual semantic grouping |
| **Tooltip System** | Hover/click tooltips with label templates + "View More" drawer |
| **Live Stream (WebSocket)** | Real-time WebSocket fan-out for low-latency updates |
| **Event Replay** | Replay past events through a stream |
| **Correlation Rules** | Cross-stream alert conditions with audit log |
| **Webhook Outbound** | Forward events to external systems |
| **Import Pipeline** | CSV/XLSX/JSON/GeoJSON preview → commit flow |

---

## 📊 Pages & Screens

| Page | Route | Description |
|---|---|---|
| **Editor** | `/create-grids` | Main warehouse layout editor with map + side panel + all tools |
| **Dashboard** | `/dashboard` | Workspace overview: KPIs, 30-day growth, recent warehouses |
| **Warehouses** | `/warehouses` | Filterable facility list with per-row/bulk actions + filter-aware KPIs |
| **Data** | `/data` | Fixed-viewport data explorer with table, filtering, search, bulk actions |
| **Files** | `/files` | Asset gallery for images/3D models/floor plans with sidebar scoping |
| **Integrations** | `/integrations` | External data connection management (REST/webhook/file sources) |
| **Members** | `/members` | Workspace member management (invite, roles, remove) |
| **Profile** | `/profile` | User profile editing (display name, bio, location, pronouns, job title, avatar) |
| **Viewer** | `/view` | Public read-only presentation viewer |
| **Login** | `/login` | Email/password login |
| **Signup** | `/signup` | Multi-step signup (email → OTP → password) |
| **Workspaces** | `/workspaces` | Workspace management (rename, delete, leave, switch) |

---

## 📐 Editor Panels & Sidebar

| Feature | Description |
|---|---|
| **Side Panel** | Main editor panel: workspace tree, shape editors, layer ordering |
| **Workspace Tree** | Hierarchical shape browser by warehouse → floor plan → shape |
| **Shape Editors** | Per-kind property editors (color, elevation, dimensions, labels, linked data) |
| **Bulk Editor** | Multi-selection property panel with Mixed-state detection |
| **Layer Ordering** | Drag-reorder overlay stacking (persisted per-warehouse) |
| **Status Bar** | Bottom bar: selection count, active tool, viewport coords |
| **Keyboard Status Bar** | Shows active modifier keys |
| **Warehouse Pill** | Active warehouse indicator |
| **Data Link Pill** | Data-link status indicator |
| **Command Palette** | Ctrl+K keyboard-driven navigation |
| **Default Floor Plan Picker** | Sets auto-assigned floor plan for new shapes |
| **Floor Plan Ordering** | Drag-reorder floor plans in the workspace tree |

---

## 🔐 Authentication & Multi-tenant

| Feature | Description |
|---|---|
| **Auth** | JWT-based sessions with bcrypt password hashing |
| **Login/Signup/Logout** | Standard auth flow |
| **Auth Guard** | Protected route wrapper |
| **Role-based Access** | owner/admin/editor/viewer roles with fine-grained UI gating |
| **Workspace Switcher** | Tenant dropdown switcher |
| **Invite System** | Email-based member invitation |
| **Bootstrap Admin** | Auto-create admin on first startup |

---

## 🔗 Share & Collaboration

| Feature | Description |
|---|---|
| **Share Links** | Many-per-warehouse with settings (map style, palette, theme, layers, filters, expiry) |
| **Legacy Share Tokens** | One-token-per-warehouse fallback |
| **Public Viewer** | Read-only `/view` route with full presentation controls |
| **Viewer Controls** | Zoom, compass, fullscreen, floor switcher, search, measure tool, layers, legend |
| **Viewer Tour** | Guided onboarding overlay |
| **Viewer QR Share** | QR code generation for share links |

---

## 🌐 Internationalization

| Feature | Description |
|---|---|
| **6 Languages** | English, Spanish, French, German, Arabic (RTL), Chinese |
| **Language Switcher** | Dropdown on public pages + editor |
| **RTL Support** | Arabic right-to-left layout |

---

## 🗃️ Backend (Go + Chi + sqlc)

| Feature | Description |
|---|---|
| **Entity CRUD** | 17 entity tables with generic `shape_crud` helpers |
| **Bulk Assign** | Single round-trip assignment across shapes/floor plans |
| **File Upload/Storage** | Local/MinIO/S3-compatible object store with refcounted cleanup |
| **Dashboard Overview** | Aggregated workspace KPIs |
| **Warehouse Summaries** | Paginated list with CTE aggregates + filter-aware stats |
| **Data Screen Endpoints** | Entity events, states, data source rows with filtering |
| **Import Pipeline** | CSV/XLSX/JSON preview + commit |
| **SSE Broadcaster** | Real-time entity event fan-out |
| **WebSocket** | Live stream data fan-out (non-catalog) |
| **Webhook Ingest** | External event webhook receiver |
| **27 Database Migrations** | Full migration history (PostgreSQL/PostGIS) |

---

## 📁 File Management

| Feature | Description |
|---|---|
| **Upload Pipeline** | Upload images/3D models with deterministic SHA keys |
| **URL Rewriting** | Same-origin URL normalization for legacy absolute URLs |
| **File Gallery** | Browse/delete with sidebar scoping (warehouse/catalog/ghost/orphan) |
| **3D Model Preview** | `<model-viewer>` web component for GLB preview |
| **Avatar Upload** | Profile avatar with ref-counted cleanup |
| **Cleanup Orphans** | `make cleanup-orphans` sweeper for leaked files |

---

## 🧭 Viewer Features

| Feature | Description |
|---|---|
| **Floor Switcher** | Dropdown/buttons to switch active floor plan |
| **Measure Tool** | Distance + area measurement on the map |
| **Search** | Shape search within the viewer |
| **Layers Panel** | Per-layer visibility toggles |
| **Legend** | Data-link layer legend |
| **Detail Panel** | Shape property inspector |
| **Summary Card** | Warehouse statistics card |
| **Filter Widget** | Data-link config filter controls |
| **Ghost Floor Overlay** | Hint when all floors hidden |
| **Coordinate Readout** | Cursor lng/lat display |
| **Shadows Control** | Shadow strength slider |
| **Zoom Cluster** | Zoom-dependent cluster level indicator |

---

## 📝 Overlay Components

| Component | Description |
|---|---|
| `map-grid-overlay` | Renders grid/rack layout rectangles as fill-extrusions |
| `map-polygon-overlay` | Renders polygon shapes as fill-extrusions with opacity bucketing |
| `map-circle-overlay` | Renders circle shapes as fill-extrusions with opacity bucketing |
| `map-line-overlay` | Renders lines as 3D wall extrusions |
| `map-route-overlay` | Renders wayfinding routes with directional arrows |
| `map-marker-overlay` | Renders marker icons on the map |
| `map-image-overlay` | Renders floor-plan images as raster sources |
| `map-image-plane-overlay` | Renders 3D image planes via Mapbox model layer |
| `map-model-overlay` | Renders 3D GLB models on the map |
| `map-stair-overlay` | Renders stair shapes with compliance indicators |
| `map-text-label-overlay` | Renders text labels as Mapbox symbol layers |
| `map-bin-overlay` | Renders bin (rack location) data with popups |
| `map-data-linked-overlay` | Renders data-linked layers (heatmap/cluster/label/cone/ring) |
| `map-shape-tooltip` | Unified tooltip popup for shape hover/click |
| `door/map-door-overlay` | Renders door shapes (single/double/sliding/revolving) |

---

## 🔄 Zustand Stores

| Store | Persisted | Description |
|---|---|---|
| `useAuthStore` | Yes | Current user session, token, tenant memberships |
| `useSpatialStore` | No | Optimistic local-first catalog of all spatial entities |
| `tenant-store` | No | Current tenant ID with change listeners |
| `mutation-queue` | No | Debounced mutation queue for spatial edits |
| `useGraphicsSettings` | Yes | Graphics quality toggles (shadows, ambient occlusion) |
| `useHeaderControls` | No | Cross-tree bridge for header-level map controls |
| `useDoorStore` | Yes (partial) | Door tool canonical row list, pending config |
| `useDataLinkLoadingStore` | No | Tracks which data-link layers are loading |

---

## 🧩 shadcn UI Components

| Component | Description |
|---|---|
| `button` | Button with variants (default, destructive, outline, secondary, ghost, link) |
| `color-picker` | Color input with swatch + hex text field |
| `dialog` | Modal dialog with Radix primitive |
| `drawer` | Bottom sheet drawer |
| `dropdown-menu` | Dropdown menu with Radix primitive |
| `input` | Text input |
| `label` | Form label |
| `number-input` | Number input with increment/decrement |
| `popover` | Popover with Radix primitive |
| `slider-row` | Slider with label row |
| `slider` | Range slider |
| `switch` | Toggle switch |
| `text-field` | Enhanced text field with label |
| `virtual-list` | Virtualized list for performance |

---

## 🌍 i18n Locales

| Locale | File | Language |
|---|---|---|
| `en` | `public/locales/en/translation.json` | English |
| `es` | `public/locales/es/translation.json` | Spanish |
| `fr` | `public/locales/fr/translation.json` | French |
| `de` | `public/locales/de/translation.json` | German |
| `ar` | `public/locales/ar/translation.json` | Arabic (RTL) |
| `zh` | `public/locales/zh/translation.json` | Chinese |

---

## 📋 Backend Handlers (Go)

| Handler | Description |
|---|---|
| `auth` | Auth endpoints: signup (OTP), login, logout, me; member management |
| `bins` | Bin CRUD + bulk-replace |
| `bulk_assign` | Bulk-assign many shapes across kinds in one round-trip |
| `circles` | Circle shape CRUD |
| `correlation` | Correlation rules, alerts, audit log CRUD |
| `dashboard_overview` | Dashboard workspace overview |
| `data_link` | Connections, data sources, streams, import jobs CRUD |
| `data_links` | Data-link config (layer bindings) CRUD |
| `data_screen` | Entity events, states, data source rows |
| `doors` | Door shape CRUD |
| `entity_ingest` | Generic entity event ingest for streams |
| `entity_states` | Tenant-wide entity states listing |
| `file_cleanup` | File cleanup with refcount |
| `files` | Files admin: list + delete with category derivation |
| `grids` | Grid/rack CRUD |
| `images` | Floor-plan image CRUD + file upload |
| `image_planes` | 3D image plane CRUD + file upload |
| `import_pipeline` | CSV/XLSX/JSON import pipeline |
| `lines` | Line/wall shape CRUD |
| `markers` | Marker shape CRUD |
| `models` | 3D model placement CRUD |
| `polygons` | Polygon shape CRUD |
| `profile` | User profile get/update, avatar upload |
| `public_warehouse` | Public read-only warehouse view |
| `routes` | Route/path shape CRUD |
| `shape_crud` | Generic CRUD helpers |
| `share_links` | Share link CRUD + public resolution |
| `sse` | SSE broadcaster for real-time entity events |
| `stairs` | Stair shape CRUD |
| `stream_entities` | Per-stream entity routes |
| `stream_ws` | WebSocket handler for live stream fan-out |
| `supporting_catalog` | Attribute definitions, style rules, app settings |
| `tenants` | Workspace (tenant) CRUD |
| `text_labels` | Text label shape CRUD |
| `warehouse_summaries` | Paginated warehouse summaries with CTE aggregates |
| `webhooks` | External webhook ingest endpoints |
| `zone_duplicate` | Warehouse duplicate endpoint |
| `zones` | Zone/warehouse CRUD |

---

## 🗄️ Database Migrations

| Migration | Description |
|---|---|
| `0001` | Initial schema: zones, grids, bins, polygons, circles, lines, markers, images, models |
| `0002` | SPA compatibility: users table, sessions |
| `0003` | Object storage support |
| `0004` | Webhook events table |
| `0005` | Stairs shape table |
| `0006` | Warehouse share defaults (share_token, is_public) |
| `0007` | Attribute definitions zone_id |
| `0008` | Source files table |
| `0009` | Doors shape table |
| `0010` | Users table (auth system) |
| `0011` | User profile fields |
| `0012` | Shape roles (role_vocabulary on zones, role on shapes) |
| `0013` | Image planes table |
| `0014` | Data-link configs table |
| `0015` | Entity states table |
| `0016` | Entity events table |
| `0017` | Drop legacy live data tables |
| `0018` | Data source entity_kind |
| `0019` | Data source rows table |
| `0020` | Data-link source_id |
| `0021` | Soft-delete for data_sources |
| `0022` | Auth (email OTP signup) |
| `0023` | Billing columns (dropped by `0047`) |
| `0024` | Share links table (many-per-warehouse, settings blob) |
| `0025` | Routes table (wayfinding paths) |
| `0026` | Strip absolute asset URLs from old rows |
| `0027` | Cascade zone delete to child shapes |
