package config

import (
	"bufio"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/confmap"
	"github.com/knadh/koanf/providers/env"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
)

// Config holds all runtime configuration for the API server.
//
// The Mode field selects which environment file (.env.development /
// .env.production) is loaded by the operator's shell script — koanf itself
// doesn't split on mode, it reads whatever env vars are present. Mode is
// echoed back to /healthz so operators can confirm the API is running with
// the expected mode after a deploy.
type Config struct {
	Mode      string          `koanf:"mode"`
	Server    ServerConfig    `koanf:"server"`
	Database  DatabaseConfig  `koanf:"database"`
	Auth      AuthConfig      `koanf:"auth"`
	Mail      MailConfig      `koanf:"mail"`
	App       AppConfig       `koanf:"app"`
	WebSocket WSConfig        `koanf:"websocket"`
	Migration MigrationConfig `koanf:"migration"`
	Storage   StorageConfig   `koanf:"storage"`
	Tables    TablesConfig    `koanf:"tables"`
	AIWorker  AIWorkerConfig  `koanf:"ai_worker"`
	Demo      DemoConfig      `koanf:"demo"`
}

// DemoConfig controls the demo workspace (internal/demo): sample
// facilities, tables, data links and reports loaded into an empty
// database on first start, which every new account then joins as an
// editor. Seeding happens once; deleting the workspace keeps it gone.
// Disable it (SGV_DEMO.ENABLED=false) before the first start of an
// install that should begin empty.
type DemoConfig struct {
	Enabled bool `koanf:"enabled"`
}

// AIWorkerConfig points the Go API at the Python detection service
// (`backend/ai-worker/`). Phase 4 rewrite replaced the in-process
// Ollama-Cloud call path (former `internal/ai/` package) with an
// out-of-process worker: Go enqueues a task, polls the worker for
// the result, and stores whatever detection payload the Python side
// produces (currently `{detections: [...], pipeline_version: "..."}`).
//
// Rate-limit fields moved here from the deleted AIConfig — they still
// gate the /detect endpoint the same way (per-tenant hourly + monthly
// caps), just no longer nested under an Ollama-specific config block.
//
// URL default is the docker-compose service hostname; `make dev`
// overrides via env to `http://localhost:8100` (the worker's mapped
// host port).
type AIWorkerConfig struct {
	URL            string        `koanf:"url"`
	RequestTimeout time.Duration `koanf:"request_timeout"`
	// Polling knobs — how the Go handler drains an async job. The
	// handler enqueues via POST /detect, gets back a taskId, then
	// GETs /detect/{taskId} every PollInterval until terminal or
	// PollMaxDuration elapses. PollMaxDuration is the "worst-case
	// worker got stuck" backstop and is loosely tied to the Python
	// side's Dramatiq `time_limit`.
	PollInterval    time.Duration `koanf:"poll_interval"`
	PollMaxDuration time.Duration `koanf:"poll_max_duration"`
	// MonthlyCapPerTenant / HourlyRatePerTenant / HourlyBurstPerTenant
	// gate the /detect endpoint. Moved here from the deleted AIConfig.
	// 0 disables the respective check. Job COUNT (not token sum) is
	// the cap unit — the Python worker doesn't emit token counts,
	// and per-job wall time is a more honest cost proxy anyway.
	MonthlyCapPerTenant  int `koanf:"monthly_cap_per_tenant"`
	HourlyRatePerTenant  int `koanf:"hourly_rate_per_tenant"`
	HourlyBurstPerTenant int `koanf:"hourly_burst_per_tenant"`
}

// TablesConfig describes the user-defined "thing type" tables surface.
// The public per-table REST API is rate-limited per token so one
// runaway script can't DOS the table. Per-token (not per-IP) because
// one IP may legitimately run many tokens (CI, fleet agents) and one
// token shouldn't be able to DOS the table for everyone else.
//
// RateLimitPerMin is the per-token throttle. 0 = unlimited. Default 60
// with a burst of 30 covers real ETL batches while blocking abuse.
// Process-local — a horizontally-scaled deploy would need Redis for
// accurate cross-instance throttling, same caveat as the auth limiter.
type TablesConfig struct {
	RateLimitPerMin int `koanf:"rate_limit_per_min"`
}

// ServerConfig describes the HTTP server.
type ServerConfig struct {
	Host            string        `koanf:"host"`
	Port            int           `koanf:"port"`
	ReadTimeout     time.Duration `koanf:"read_timeout"`
	WriteTimeout    time.Duration `koanf:"write_timeout"`
	IdleTimeout     time.Duration `koanf:"idle_timeout"`
	ShutdownTimeout time.Duration `koanf:"shutdown_timeout"`
	// AllowedOrigins is the CORS allow-list. Empty in prod = the browser
	// refuses cross-origin requests, which is the safe default. Dev seeds
	// this with the Vite origin so `npm run dev` works out of the box.
	// Wildcard "*" is honoured only when explicitly configured.
	AllowedOrigins []string `koanf:"allowed_origins"`
	// TrustedProxies is a list of IPs / CIDRs whose X-Forwarded-For and
	// X-Real-IP headers may be trusted by rate-limit ClientIP resolution.
	// Empty (the default) = trust nothing; only RemoteAddr is used. Set to
	// your load balancer / reverse proxy IPs in production so real client
	// IPs surface for rate limiting without letting arbitrary internet
	// callers spoof the header to bypass throttling.
	TrustedProxies []string `koanf:"trusted_proxies"`
}

// DatabaseConfig describes the Postgres connection.
type DatabaseConfig struct {
	URL             string        `koanf:"url"`
	MaxOpenConns    int           `koanf:"max_open_conns"`
	MaxIdleConns    int           `koanf:"max_idle_conns"`
	ConnMaxLifetime time.Duration `koanf:"conn_max_lifetime"`
}

// AuthConfig describes authentication.
type AuthConfig struct {
	APIKey    string `koanf:"api_key"`
	JWTSecret string `koanf:"jwt_secret"`
	Mode      string `koanf:"mode"`
	// BootstrapEmail/Password create an initial admin user on startup if no
	// user with that email exists yet. Useful for claiming a pre-auth database
	// without having to run the seed-admin command by hand. Leave both empty
	// to disable. Idempotent: existing users are not touched.
	BootstrapEmail    string `koanf:"bootstrap_email"`
	BootstrapPassword string `koanf:"bootstrap_password"`
}

// MailConfig describes outbound-email delivery for OTP / notifications.
// When Host is empty the mailer falls back to logging the message to
// stdout so local dev works without an SMTP server. In production, set
// SGV_MAIL.HOST/PORT/USERNAME/PASSWORD to your relay of choice.
type MailConfig struct {
	Host     string `koanf:"host"`
	Port     int    `koanf:"port"`
	Username string `koanf:"username"`
	Password string `koanf:"password"`
	From     string `koanf:"from"`
	FromName string `koanf:"from_name"`
}

// AppConfig describes the public-facing SPA.
type AppConfig struct {
	// PublicURL is the absolute origin the SPA is served from (e.g.
	// https://maps.example.com). Used to build links in auth emails
	// (sign-in, password reset). Defaults to the Vite dev server origin
	// (http://localhost:5173); set SGV_APP.PUBLIC_URL in production.
	PublicURL string `koanf:"public_url"`
}

// WSConfig describes WebSocket tuning.
type WSConfig struct {
	WriteWait        time.Duration `koanf:"write_wait"`
	PongWait         time.Duration `koanf:"pong_wait"`
	PingPeriod       time.Duration `koanf:"ping_period"`
	MaxMessageSize   int64         `koanf:"max_message_size"`
	ReplayEventCount int           `koanf:"replay_event_count"`
}

// MigrationConfig describes migration behavior.
type MigrationConfig struct {
	OnStart bool   `koanf:"on_start"`
	Path    string `koanf:"path"`
}

// StorageConfig describes object storage for binary uploads.
//
// Type selects the backend:
//   - "local" (default) — filesystem at BasePath.
//   - "minio" — S3-compatible MinIO bucket. Existing files on disk are
//     invisible until cmd/migrate-storage copies them over.
//   - "minio-fallback" — MinIO primary + local disk read fallback. Safe
//     cutover mode: flip to it before migrate-storage has run and every
//     legacy file keeps serving until the bulk copy catches up.
//
// The MinIO endpoint is never exposed to the browser — files are served
// through the API's /files/{key} proxy either way, so BaseURL should
// stay relative (`/files`) for both local and MinIO.
type StorageConfig struct {
	Type     string `koanf:"type"`
	BaseURL  string `koanf:"base_url"`
	BasePath string `koanf:"base_path"`
	// MinIO config — required when Type is "minio" or "minio-fallback".
	MinIOEndpoint  string `koanf:"minio_endpoint"`
	MinIOAccessKey string `koanf:"minio_access_key"`
	MinIOSecretKey string `koanf:"minio_secret_key"`
	MinIOBucket    string `koanf:"minio_bucket"`
	MinIORegion    string `koanf:"minio_region"`
	MinIOUseSSL    bool   `koanf:"minio_use_ssl"`
}

// loadDotEnvLocal reads dot-notation env-var files (`.env.development.local`
// et al) into the process environment via os.Setenv, bypassing the shell
// entirely. Necessary because bash rejects `KEY.WITH.DOTS=value` on
// `set -a; . file; set +a` sourcing (dots are invalid POSIX identifier
// characters), but koanf's env provider — the source of truth for our
// dotted keys like SGV_AI_WORKER.URL — needs the vars ACTUALLY in the
// process environment. Reading + setenv-ing here bridges the gap so the
// operator's iteration cycle (`go run ./cmd/api`) matches production
// (`make dev` with a real env file) without a shell dance.
//
// Files loaded in this order (later wins the same key):
//  1. .env.development.local  (or `.env.<Mode>.local` — dev is the
//     default so this is the common case)
//  2. .env.local              (mode-agnostic overrides)
//
// A missing file is fine; syntax errors on a line are logged and the
// line is skipped so one bad row doesn't kill the boot.
func loadDotEnvLocal(mode string) {
	if mode == "" {
		mode = "development"
	}
	for _, name := range []string{".env." + mode + ".local", ".env.local"} {
		f, err := os.Open(name)
		if err != nil {
			continue // missing file is expected
		}
		defer f.Close()
		scanner := bufio.NewScanner(f)
		lineNum := 0
		for scanner.Scan() {
			lineNum++
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			eq := strings.IndexByte(line, '=')
			if eq <= 0 {
				slog.Warn("dotenv: skipping malformed line", "file", name, "line", lineNum)
				continue
			}
			key := strings.TrimSpace(line[:eq])
			val := strings.TrimSpace(line[eq+1:])
			// Strip matching surrounding quotes so `KEY="value with spaces"`
			// works the same as raw shell export would.
			if len(val) >= 2 {
				if (val[0] == '"' && val[len(val)-1] == '"') ||
					(val[0] == '\'' && val[len(val)-1] == '\'') {
					val = val[1 : len(val)-1]
				}
			}
			// Only set if not already in the environment — env-supplied
			// values (real shell exports) take precedence over the file
			// so `SGV_AI_WORKER.URL=other go run ./cmd/api` still wins.
			if _, present := os.LookupEnv(key); present {
				continue
			}
			if err := os.Setenv(key, val); err != nil {
				slog.Warn("dotenv: setenv failed", "file", name, "key", key, "error", err)
			}
		}
	}
}

// Load reads configuration from an optional YAML file and environment variables.
// Environment variables override file values and use the prefix SGV_.
func Load(path string) (*Config, error) {
	// Read .env.<mode>.local (etc) into the process environment BEFORE
	// the koanf env provider runs, so dot-notation keys the shell can't
	// source (SGV_AI_WORKER.URL) still reach the config. See loadDotEnvLocal.
	// We don't know the mode yet — SGV_MODE could be in the file itself —
	// so try "development" (the default) first; a mode override in the
	// file re-parses on the next boot.
	loadDotEnvLocal(os.Getenv("SGV_MODE"))

	k := koanf.New(".")

	// Defaults
	defaults := map[string]interface{}{
		"mode":                       "development",
		"server.host":                "0.0.0.0",
		"server.port":                8080,
		"server.read_timeout":        "30s",
		"server.write_timeout":       "30s",
		"server.idle_timeout":        "120s",
		"server.shutdown_timeout":    "10s",
		"database.max_open_conns":    25,
		"database.max_idle_conns":    25,
		"database.conn_max_lifetime": "30m",
		"auth.mode":                  "apikey",
		"mail.port":                  587,
		"mail.from":                  "no-reply@spatialmap.local",
		"mail.from_name":             "Spatial Map",
		// JWT signing secret. The default is an obvious development
		// placeholder so login works out of the box; Load refuses to
		// start in production mode while it is still in place.
		"auth.jwt_secret":              DevJWTSecretPlaceholder,
		"app.public_url":               "http://localhost:5173",
		"websocket.write_wait":         "10s",
		"websocket.pong_wait":          "60s",
		"websocket.ping_period":        "54s",
		"websocket.max_message_size":   65536,
		"websocket.replay_event_count": 100,
		"migration.on_start":           true,
		"migration.path":               "migrations",
		"storage.type":                 "local",
		"storage.base_path":            "./uploads",
		// Relative by default — see backend/.env.example for the
		// rationale. Avoids LAN-access breakage where the SPA opened
		// from another machine would otherwise resolve image URLs
		// against its own localhost.
		"storage.base_url": "/files",
		// MinIO defaults match the docker-compose service so
		// SGV_STORAGE.TYPE=minio-fallback works with zero extra config
		// on a stock `make up` box.
		"storage.minio_endpoint": "localhost:9000",
		"storage.minio_bucket":   "sgv-uploads",
		"storage.minio_region":   "us-east-1",
		"storage.minio_use_ssl":  false,
		// Tables: per-token rate limit for the public REST surface.
		// 60 req/min with burst 30 covers real ETL batches while
		// blocking a runaway script from DOSing the table.
		"tables.rate_limit_per_min": 60,
		// AI worker (Python service, backend/ai-worker/). `make dev`
		// overrides SGV_AI_WORKER.URL to http://localhost:8100 for
		// a raw `go run ./cmd/api` — the docker-compose default
		// below is what runs inside the container network.
		"ai_worker.url":                     "http://ai-worker:8100",
		"ai_worker.request_timeout":         "30s",  // per single HTTP call
		"ai_worker.poll_interval":           "3s",   // pace of GET /detect/{taskId}
		"ai_worker.poll_max_duration":       "300s", // hard ceiling (matches Python Dramatiq time_limit)
		"ai_worker.monthly_cap_per_tenant":  200,
		"ai_worker.hourly_rate_per_tenant":  20,
		"ai_worker.hourly_burst_per_tenant": 3,
		"demo.enabled":                      true,
	}
	if err := k.Load(confmap.Provider(defaults, "."), nil); err != nil {
		return nil, fmt.Errorf("load defaults: %w", err)
	}

	// Optional YAML file. When no explicit path was supplied via SGV_CONFIG,
	// fall back to config.dev.yaml in the current directory so
	// `go run ./cmd/api` works out of the box without sourcing env files.
	// Env vars loaded below still override any YAML value.
	if path == "" {
		if _, err := os.Stat("config.dev.yaml"); err == nil {
			path = "config.dev.yaml"
		}
	}
	if path != "" {
		if _, err := os.Stat(path); err == nil {
			if err := k.Load(file.Provider(path), yaml.Parser()); err != nil {
				return nil, fmt.Errorf("load config file %q: %w", path, err)
			}
		}
	}

	// Environment variables with SGV_ prefix, e.g. SGV_SERVER.PORT=9090
	if err := k.Load(env.Provider("SGV_", ".", func(s string) string {
		return strings.ToLower(strings.TrimPrefix(s, "SGV_"))
	}), nil); err != nil {
		return nil, fmt.Errorf("load env: %w", err)
	}

	var cfg Config
	if err := k.Unmarshal("", &cfg); err != nil {
		return nil, fmt.Errorf("unmarshal config: %w", err)
	}

	if cfg.Database.URL == "" {
		return nil, fmt.Errorf("database.url is required")
	}

	if err := cfg.checkSecrets(); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// Development placeholder secrets. They are fine on a laptop and in the
// stock docker-compose stack, but must never reach a real deployment:
// in production mode Load refuses to start while any of them is in use.
const (
	DevAPIKeyPlaceholder    = "dev-api-key-change-in-production"
	DevJWTSecretPlaceholder = "dev-jwt-secret-change-in-production"
)

// IsProduction reports whether Mode selects production ("prod" or
// "production", case-insensitive).
func (c *Config) IsProduction() bool {
	switch strings.ToLower(strings.TrimSpace(c.Mode)) {
	case "prod", "production":
		return true
	}
	return false
}

// isPlaceholderSecret matches the shipped dev placeholders plus the
// obvious "change-me" / "replace-me" style values used in example files.
func isPlaceholderSecret(v string) bool {
	l := strings.ToLower(strings.TrimSpace(v))
	if l == "" {
		return false
	}
	return l == DevAPIKeyPlaceholder || l == DevJWTSecretPlaceholder ||
		strings.Contains(l, "change-me") || strings.Contains(l, "change-in-production") ||
		strings.Contains(l, "replace-me") || strings.Contains(l, "changeme")
}

// checkSecrets fails loudly in production mode when a secret is missing or
// still set to a placeholder, and warns in development mode.
func (c *Config) checkSecrets() error {
	var problems []string
	if strings.TrimSpace(c.Auth.APIKey) == "" {
		problems = append(problems, "auth.api_key is empty (the /api/v1 surface would accept unauthenticated API-key requests)")
	} else if isPlaceholderSecret(c.Auth.APIKey) {
		problems = append(problems, "auth.api_key is a placeholder")
	}
	if strings.TrimSpace(c.Auth.JWTSecret) == "" {
		problems = append(problems, "auth.jwt_secret is empty")
	} else if isPlaceholderSecret(c.Auth.JWTSecret) {
		problems = append(problems, "auth.jwt_secret is a placeholder")
	} else if len(c.Auth.JWTSecret) < 32 {
		problems = append(problems, "auth.jwt_secret is shorter than 32 characters")
	}
	if c.Auth.BootstrapPassword != "" && isPlaceholderSecret(c.Auth.BootstrapPassword) {
		problems = append(problems, "auth.bootstrap_password is a placeholder")
	}

	if len(problems) == 0 {
		return nil
	}
	if c.IsProduction() {
		return fmt.Errorf("refusing to start in production mode with insecure secrets: %s "+
			"(set SGV_AUTH.API_KEY / SGV_AUTH.JWT_SECRET / SGV_AUTH.BOOTSTRAP_PASSWORD to long random values, e.g. `openssl rand -hex 32`)",
			strings.Join(problems, "; "))
	}
	for _, p := range problems {
		slog.Warn("config: insecure development setting — never use this in production", "problem", p)
	}
	return nil
}

// SlogLevel parses LOG_LEVEL env var into a slog.Level.
func SlogLevel() slog.Level {
	lvl := strings.ToLower(os.Getenv("LOG_LEVEL"))
	switch lvl {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// StrEnv returns a string env var or default.
func StrEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// IntEnv returns an int env var or default.
func IntEnv(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
