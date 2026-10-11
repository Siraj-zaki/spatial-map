package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/aiworker"
	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/auth"
	"github.com/Siraj-zaki/spatial-map/backend/internal/config"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/demo"
	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/Siraj-zaki/spatial-map/backend/internal/health"
	"github.com/Siraj-zaki/spatial-map/backend/internal/mailer"
	"github.com/Siraj-zaki/spatial-map/backend/internal/migrate"
	"github.com/Siraj-zaki/spatial-map/backend/internal/pdfconv"
	"github.com/Siraj-zaki/spatial-map/backend/internal/polling"
	"github.com/Siraj-zaki/spatial-map/backend/internal/reports"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: config.SlogLevel(),
	}))
	slog.SetDefault(logger)

	cfgPath := config.StrEnv("SGV_CONFIG", "")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	ctx := context.Background()
	pool, err := db.NewPool(ctx, cfg.Database.URL, cfg.Database.MaxOpenConns, cfg.Database.MaxIdleConns, cfg.Database.ConnMaxLifetime)
	if err != nil {
		logger.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	if cfg.Migration.OnStart {
		if err := migrate.Up(cfg.Database.URL, cfg.Migration.Path); err != nil {
			logger.Error("failed to run migrations", "error", err)
			os.Exit(1)
		}
		logger.Info("migrations applied")
	}

	// Register the trusted-proxy list BEFORE the router is wired so
	// api.ClientIP (used by the rate limiters) reads a populated allow-
	// list. Bad CIDR entries in config are fatal — silently ignoring them
	// would give the operator a false sense of protection.
	if parseErrs := api.SetTrustedProxies(cfg.Server.TrustedProxies); len(parseErrs) > 0 {
		for _, err := range parseErrs {
			logger.Error("invalid trusted_proxies entry", "error", err)
		}
		os.Exit(1)
	}

	// Per-token rate limiter for the public per-table REST surface.
	// Initialised before the router is wired so the middleware sees a
	// populated limiter on the first request. Pass 0 to disable.
	handlers.InitTableTokenRateLimiter(cfg.Tables.RateLimitPerMin)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	// Deliberately NOT using chi's middleware.RealIP — it rewrites
	// r.RemoteAddr from X-Forwarded-For / X-Real-IP unconditionally, which
	// would let any caller bypass the auth rate limiter by spoofing the
	// header. api.ClientIP does the same lookup but only trusts those
	// headers when the connection RemoteAddr matches a configured
	// trusted-proxy CIDR (SGV_SERVER.TRUSTED_PROXIES).
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))
	// CORS: driven by SGV_SERVER.ALLOWED_ORIGINS. Empty = block all
	// cross-origin (the safe default in prod). Dev seeds the Vite origin
	// in config.dev.yaml so `npm run dev` works out of the box.
	corsOrigins := cfg.Server.AllowedOrigins
	if len(corsOrigins) == 0 {
		logger.Warn("no CORS allowed_origins configured; all cross-origin requests will be blocked")
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: corsOrigins,
		AllowedMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{"Accept", "Authorization", "Content-Type", "X-Api-Key", "X-Tenant-Id"},
		// Retry-After drives the SPA's "try again in 42s" countdown on 429s;
		// cross-origin JS can't read it unless it's exposed.
		ExposedHeaders: []string{"Retry-After"},
		MaxAge:         300,
	}))

	// Health and readiness endpoints (no auth)
	r.Get("/healthz", health.HealthHandler)
	r.Get("/ready", health.ReadyHandler(pool))

	queries := db.New(pool)

	// Record the bootstrap admin email so auth responses can flag
	// the corresponding user with IsPlatformAdmin=true, and so
	// admin-only routes can gate on the same match.
	handlers.SetPlatformAdminEmail(cfg.Auth.BootstrapEmail)
	// Reject JWTs issued before the user's last password change, so a
	// password reset signs out every session (api/session_revocation.go).
	api.EnableSessionRevocation(queries)
	// Auth emails link back to the SPA (SGV_APP.PUBLIC_URL).
	mailer.SetAppURL(cfg.App.PublicURL)

	objectStore, err := store.New(store.Config{
		Type:     cfg.Storage.Type,
		BasePath: cfg.Storage.BasePath,
		BaseURL:  cfg.Storage.BaseURL,
		MinIO: store.MinIOConfig{
			Endpoint:  cfg.Storage.MinIOEndpoint,
			AccessKey: cfg.Storage.MinIOAccessKey,
			SecretKey: cfg.Storage.MinIOSecretKey,
			Bucket:    cfg.Storage.MinIOBucket,
			Region:    cfg.Storage.MinIORegion,
			UseSSL:    cfg.Storage.MinIOUseSSL,
		},
	})
	if err != nil {
		logger.Error("failed to create object store", "error", err)
		os.Exit(1)
	}
	logger.Info("object store ready", "type", cfg.Storage.Type)

	// Demo workspace: sample facilities, tables and reports, loaded once
	// into an empty database (internal/demo). Runs before the bootstrap
	// admin so the admin becomes its owner. A failure is logged, not
	// fatal — the next start tries again.
	if cfg.Demo.Enabled {
		if _, err := demo.Seed(ctx, pool, objectStore); err != nil {
			logger.Error("demo workspace seed failed", "error", err)
		}
	}

	// Idempotently create the bootstrap admin user when configured. Runs
	// after migrations so user_tenants exists, and after the demo seed so
	// the admin is linked to the demo workspace. No-op when both bootstrap
	// fields are empty or the user already exists.
	if err := auth.Bootstrap(ctx, queries, cfg.Auth.BootstrapEmail, cfg.Auth.BootstrapPassword); err != nil {
		logger.Error("bootstrap admin failed", "error", err)
		os.Exit(1)
	}

	// External source polling worker. Ticks every 60s, queries for
	// due table-kind sources with a non-empty config.pollUrl, polls
	// each in its own goroutine, upserts rows via the shared
	// handlers.UpsertTableRow helper. Non-blocking; exits when ctx
	// is canceled at shutdown.
	pollingWorker := polling.New(queries)
	pollingWorker.Start(ctx)
	logger.Info("polling worker started", "tickInterval", "60s")

	// PDF floor-plan conversion. Init compiles a 5 MB PDFium WASM module,
	// far too expensive to do per request, so it happens once here.
	// A failure disables PDF import but must not stop the API booting —
	// see PDFRouter, which answers 503 on a nil renderer.
	pdfRenderer, err := pdfconv.New(pdfconv.Config{})
	if err != nil {
		logger.Error("pdf conversion unavailable", "error", err)
	} else {
		logger.Info("pdf conversion ready")
		defer pdfRenderer.Close()
	}

	// Mailer for OTP / notification emails. When SGV_MAIL.HOST is empty
	// (default in dev), the console mailer logs codes to stdout so operators
	// can grep the docker logs during triage without setting up SMTP first.
	mail := mailer.New(mailer.Config{
		From:     cfg.Mail.From,
		FromName: cfg.Mail.FromName,
		Host:     cfg.Mail.Host,
		Port:     cfg.Mail.Port,
		Username: cfg.Mail.Username,
		Password: cfg.Mail.Password,
	})
	if cfg.Mail.Host == "" {
		logger.Info("mailer: no SMTP host configured — falling back to console output")
	} else {
		logger.Info("mailer: SMTP configured", "host", cfg.Mail.Host, "port", cfg.Mail.Port)
	}

	// Event broadcaster for real-time entity invalidation. Shared across all
	// catalog handlers so every mutation broadcasts a lightweight SSE event.
	sseBroadcaster := handlers.NewSSEBroadcaster()
	go sseBroadcaster.Run()
	handlers.SetDefaultBroadcaster(sseBroadcaster)

	// AI floor plan detection — Phase-4 architecture. The Go API is a
	// thin dispatcher that enqueues a task on the Python ai-worker
	// (backend/ai-worker/, over Dramatiq/Redis) and polls for the
	// result. The old Ollama-Cloud path (formerly internal/ai/) is
	// retired.
	//
	// Empty AIWorker.URL disables the feature (detect endpoint 503s)
	// so an operator who doesn't run the worker service in a
	// deployment isn't stuck with a broken button.
	aiWorkerClient := aiworker.NewClient(
		cfg.AIWorker.URL,
		cfg.AIWorker.RequestTimeout,
		cfg.AIWorker.PollInterval,
		cfg.AIWorker.PollMaxDuration,
	)
	if cfg.AIWorker.URL == "" {
		logger.Info("ai-worker: disabled (SGV_AI_WORKER.URL empty)")
	} else {
		logger.Info("ai-worker: configured",
			"url", cfg.AIWorker.URL,
			"poll_interval", cfg.AIWorker.PollInterval,
			"poll_max_duration", cfg.AIWorker.PollMaxDuration,
			"monthly_cap", cfg.AIWorker.MonthlyCapPerTenant)
	}

	// Public file serving for uploaded images and models (no auth).
	// PathUnescape the key because chi.URLParam returns the RAW path
	// segment — for a request to `/files/foo%20bar.png` we need the
	// key `foo bar.png` (with a literal space) to match what's in
	// the object store. Missing this made every filename with a
	// space 404 silently.
	r.Get("/files/{key}", func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		if dec, err := url.PathUnescape(key); err == nil {
			key = dec
		}
		obj, err := objectStore.Get(r.Context(), key)
		if err != nil {
			api.NotFound(w, "file not found")
			return
		}
		w.Header().Set("Content-Type", obj.ContentType)
		w.Write(obj.Data)
	})

	// Public, unauthenticated presentation view. Mounted before the authed
	// /api/v1 group so APIKeyMiddleware never applies — anyone with the
	// warehouse ID can open the shareable view. The by-token route is the
	// primary share-link target; the by-id route is kept for the dashboard
	// preview button and legacy links.
	r.Route("/api/v1/public", func(r chi.Router) {
		r.Get("/warehouses/by-token/{token}", handlers.GetPublicWarehouseByToken(queries))
		r.Get("/warehouses/{id}", handlers.GetPublicWarehouse(queries))
		// Rich shareable-presentation endpoint. Unauthenticated, tokens
		// minted by /api/v1/share-links (below). Enforces per-link expiry,
		// view cap, and revocation in SQL. Returns `{ link: { settings,
		// ... }, warehouse: WarehouseView }` so the viewer hydrates in
		// one round-trip. Mounted INSIDE the /public group so the SPA's
		// `publicFetch` helper (which prefixes `/api/v1/public`) reaches
		// it without a special path branch.
		r.Get("/share/{token}", handlers.PublicShareHandler(queries))
		// Public per-table CRUD: users POST/GET/PATCH/DELETE rows into
		// their thing-type tables from their own code using a scoped
		// `table_api_tokens` bearer token (no X-Tenant-Id, no API key
		// — the token resolves the tenant). The middleware stamps
		// (tenant_id, source_id, token_id) into the request context.
		// See handlers/table_token_auth.go + table_rows_public.go.
		r.Mount("/tables", handlers.PublicTableRowsRouter(queries, pool))
	})

	// Auth endpoints — no API key, no tenant. Mounted in a separate Route
	// block (mirroring the /api/v1/public pattern above) so chi's "all Use()
	// must come before any route" rule doesn't conflict with the authed
	// /api/v1 group below.
	//
	// OptionalJWTMiddleware runs here too because /auth/me reads the user
	// from JWT claims. /signup and /login don't have a token yet — the
	// middleware no-ops when no Authorization header is present.
	r.Route("/api/v1/auth", func(r chi.Router) {
		r.Use(api.OptionalJWTMiddleware(cfg.Auth.JWTSecret))
		r.Mount("/", handlers.AuthRouter(queries, pool, cfg.Auth.JWTSecret, mail))
	})

	r.Route("/api/v1", func(r chi.Router) {
		// OptionalJWTMiddleware runs first so the API key check can detect
		// "JWT already authenticated this request" and skip the key check.
		r.Use(api.OptionalJWTMiddleware(cfg.Auth.JWTSecret))
		r.Use(api.APIKeyMiddleware(cfg.Auth.APIKey))

		// Workspace (tenant) management is global; does not require
		// X-Tenant-Id (you may not have one yet, or you may be deleting
		// the current one). Auth is enforced inside the handlers — every
		// mutation demands a JWT userID; JWT callers get role gates,
		// API-key callers keep legacy ungated behaviour.
		r.Mount("/tenants", handlers.TenantsRouter(queries, objectStore))

		// Per-user profile self-service. Authenticated but NOT tenant-scoped
		// because profile data belongs to the user, not the workspace.
		r.Mount("/profile", handlers.ProfileRouter(queries, objectStore))

		// Platform-admin surface — signup + workspace rollups for the
		// bootstrap owner's dashboard. NOT tenant-scoped; each handler
		// enforces IsPlatformAdminEmail on the JWT-authenticated caller.
		r.Mount("/admin", handlers.AdminRouter(nil, pool))

		// WebSocket ingest route: browsers cannot send custom headers on the
		// handshake, so it is mounted outside the TenantMiddleware group. The
		// stream token resolves the tenant, and the API key is checked via query
		// parameter fallback in the handler.
		r.Get("/streams/{token}/ws", handlers.StreamWebSocketHandler(queries, pool, cfg.Auth.APIKey))

		// Webhook ingest + drain: external senders cannot send X-Tenant-Id,
		// so the token resolves the tenant and the API key is accepted via query
		// parameter too. The drain endpoint is called by the SPA with headers.
		r.Mount("/webhooks", handlers.WebhookEventsRouter(queries, cfg.Auth.APIKey))

		// All other catalog routes require a tenant header. The membership
		// check inside TenantMiddleware also enforces that a JWT user can
		// only access tenants they belong to.
		r.Group(func(r chi.Router) {
			r.Use(api.TenantMiddleware(queries))
			// Real-time invalidation stream. The SPA reads it with fetch
			// (not EventSource) so it can send the JWT and X-Tenant-Id;
			// TenantMiddleware checks membership and the broadcaster only
			// forwards that tenant's events.
			r.Get("/events", sseBroadcaster.ServeHTTP)
			r.Mount("/members", handlers.TenantMembersRouter(queries))
			r.Mount("/dashboard-overview", handlers.DashboardOverviewRouter(pool, objectStore))
			r.Mount("/warehouse-summaries", handlers.WarehouseSummariesRouter(pool))
			r.Mount("/data", handlers.DataScreenRouter(queries, pool))
			r.Mount("/zones", handlers.ZonesRouter(queries, pool, objectStore))
			r.Mount("/grids", handlers.GridsRouter(queries, pool))
			r.Mount("/bins", handlers.BinsRouter(queries))
			r.Mount("/polygons", handlers.PolygonsRouter(queries, pool))
			r.Mount("/circles", handlers.CirclesRouter(queries, pool))
			r.Mount("/lines", handlers.LinesRouter(queries, pool))
			r.Mount("/routes", handlers.RoutesRouter(queries))
			r.Mount("/stairs", handlers.StairsRouter(queries, pool))
			r.Mount("/doors", handlers.DoorsRouter(queries, pool))
			r.Mount("/markers", handlers.MarkersRouter(queries))
			r.Mount("/images", handlers.ImagesRouter(queries, objectStore))
			// AI floor plan detection. Guarded by per-tenant app_settings
			// key (see handlers.AIFloorPlansRouter for the flag format);
			// the endpoint 503s when SGV_AI_WORKER.URL is unset.
			r.Mount("/floorplans", handlers.AIFloorPlansRouter(queries, objectStore, handlers.AIFloorPlansConfig{
				Worker:               aiWorkerClient,
				MonthlyCapPerTenant:  cfg.AIWorker.MonthlyCapPerTenant,
				HourlyRatePerTenant:  cfg.AIWorker.HourlyRatePerTenant,
				HourlyBurstPerTenant: cfg.AIWorker.HourlyBurstPerTenant,
			}))
			r.Mount("/pdf", handlers.PDFRouter(pdfRenderer, queries, objectStore))
			// CAD import. No boot-time dependency to check — the reader is
			// pure Go and holds no state — so unlike PDF there is no
			// renderer to pass and no 503 path. The store is for the
			// rendered sheet; the drawing itself is never persisted.
			r.Mount("/cad", handlers.CADRouter(queries, objectStore))
			r.Mount("/models", handlers.ModelsRouter(queries))
			r.Mount("/image-planes", handlers.ImagePlanesRouter(queries, objectStore))
			r.Mount("/text-labels", handlers.TextLabelsRouter(queries))
			r.Mount("/attribute-definitions", handlers.AttributeDefinitionsRouter(queries))
			r.Mount("/style-rules", handlers.StyleRulesRouter(queries))
			r.Mount("/references", handlers.EntityReferencesRouter(queries))
			r.Mount("/user-models", handlers.UserModelsRouter(queries, objectStore))
			r.Mount("/files", handlers.FilesRouter(queries, objectStore))
			r.Mount("/library", handlers.LibraryRouter(queries, objectStore))
			r.Mount("/solutions", handlers.SolutionsRouter(queries, pool))
			r.Mount("/connections", handlers.ConnectionsRouter(queries))
			r.Mount("/data-sources", handlers.DataSourcesRouter(queries, pool))
			// User-defined "thing type" tables — the third ingestion
			// mode. Authed CRUD lives here; the public per-table CRUD
			// for row writes from the user's own code is mounted under
			// /api/v1/public/tables (see above).
			r.Mount("/tables", handlers.TablesRouter(queries, pool))
			// Dynamic Report Builder — the executor compiles the JSON
			// spec to safe parameterized SQL over `data_source_rows` and
			// records each run in `report_runs` for the history drawer.
			r.Mount("/reports", handlers.ReportsRouter(queries, pool, reports.NewExecutor(pool)))
			// One-shot "seed a starter demo" endpoint. Creates a demo
			// warehouse-events table with ~120 rows and 3 v2 reports so
			// a new tenant can click through the whole builder + viewer
			// stack without hand-composing a spec.
			r.Mount("/demo", handlers.DemoRouter(queries, pool))
			r.Mount("/streams", handlers.StreamsRouter(queries))
			r.Mount("/entity-states", handlers.EntityStatesRouter(queries))
			r.Mount("/data-links", handlers.DataLinkConfigsRouter(queries))
			r.Mount("/import-jobs", handlers.ImportJobsRouter(queries, pool))
			r.Mount("/correlation-rules", handlers.CorrelationRulesRouter(queries))
			r.Mount("/alerts", handlers.AlertsRouter(queries))
			r.Mount("/audit-log", handlers.AuditLogRouter(queries))
			r.Mount("/bulk-assign", handlers.BulkAssignRouter(queries))
			// Share-link CRUD. The `/warehouses/{id}/share-links` nested
			// pair (list + create) is scoped by warehouse; the flat
			// `/share-links/{id}` handles PATCH / revoke / DELETE now that
			// the caller knows which link to touch.
			r.Mount("/warehouses/{id}/share-links", handlers.TenantWarehouseShareLinksRouter(queries))
			r.Mount("/share-links", handlers.ShareLinksRouter(queries))
			// Slice 6c2 — tenant-scoped live-entity routes collapsed
			// into the single /entity-states endpoint mounted above.
			// The five per-entity routers (asset-positions,
			// sensor-readings, rfid-reads, cv-detections, shipments)
			// and their handlers were deleted alongside their tables.
		})
		// App settings are global key/value; no tenant required.
		r.Mount("/settings", handlers.AppSettingsRouter(queries))
	})

	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      r,
		ReadTimeout:  cfg.Server.ReadTimeout,
		WriteTimeout: cfg.Server.WriteTimeout,
		IdleTimeout:  cfg.Server.IdleTimeout,
	}

	go func() {
		logger.Info("starting server", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down server")
	shutdownCtx, cancel := context.WithTimeout(ctx, cfg.Server.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("failed to shutdown server", "error", err)
		os.Exit(1)
	}
	logger.Info("server stopped")
}
