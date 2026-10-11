.PHONY: all build run dev prod up down test migrate-up migrate-down migrate-storage cleanup-orphans sqlc lint fmt clean

all: build

build:
	go build -o bin/api ./cmd/api

run:
	go run ./cmd/api

# `make dev` sources the committed dev env plus any local overlay so a
# freshly-cloned box can boot the API with a single command. Same trick
# for `make prod` — CI / your deploy platform sets the real secrets in
# the environment before invoking us.
dev:
	@set -a; \
	  test -f .env.development && . ./.env.development; \
	  test -f .env.development.local && . ./.env.development.local; \
	  set +a; \
	  go run ./cmd/api

prod:
	@set -a; \
	  test -f .env.production && . ./.env.production; \
	  test -f .env.production.local && . ./.env.production.local; \
	  set +a; \
	  ./bin/api

up:
	docker compose up --build -d

down:
	docker compose down -v

test:
	go test -race -count=1 ./...

# Migrations use the same env layers as `dev` (committed dev env +
# optional local overlay) so `make migrate-up` on a fresh box works
# without exporting SGV_DATABASE.URL by hand. Set `ENV=production` to
# use the prod files instead (e.g. `make migrate-up ENV=production`).
#
# Why not `. ./.env.*` like the `dev` target? Bash 3.2 (macOS default)
# refuses to `source` a file that contains var names with periods
# (`SGV_DATABASE.URL=…`). The Go binary reads these via `os.Getenv`
# which is happy with periods, but bash can't run `X.Y=z` as an
# assignment. Workaround: build one big `env NAME=VAL NAME=VAL …`
# invocation from the file. The `env` command accepts any name string
# via environ(7), including periods.
ENV ?= development

migrate-up:
	@bash -c ' \
	  ARGS=(); \
	  for f in .env.$(ENV) .env.$(ENV).local; do \
	    [[ -f "$$f" ]] || continue; \
	    while IFS= read -r line; do \
	      case "$$line" in "#"*|"") continue;; esac; \
	      ARGS+=("$$line"); \
	    done < "$$f"; \
	  done; \
	  env "$${ARGS[@]}" go run ./cmd/migrate up'

migrate-down:
	@bash -c ' \
	  ARGS=(); \
	  for f in .env.$(ENV) .env.$(ENV).local; do \
	    [[ -f "$$f" ]] || continue; \
	    while IFS= read -r line; do \
	      case "$$line" in "#"*|"") continue;; esac; \
	      ARGS+=("$$line"); \
	    done < "$$f"; \
	  done; \
	  env "$${ARGS[@]}" go run ./cmd/migrate down'

# migrate-storage bulk-copies the local uploads dir into MinIO.
# Idempotent + non-destructive: skips files already in the bucket and
# never deletes anything from disk. See cmd/migrate-storage/main.go for
# the recommended cutover procedure.
migrate-storage:
	@bash -c ' \
	  ARGS=(); \
	  for f in .env.$(ENV) .env.$(ENV).local; do \
	    [[ -f "$$f" ]] || continue; \
	    while IFS= read -r line; do \
	      case "$$line" in "#"*|"") continue;; esac; \
	      ARGS+=("$$line"); \
	    done < "$$f"; \
	  done; \
	  env "$${ARGS[@]}" go run ./cmd/migrate-storage'

# cleanup-orphans reclaims object-store files no longer referenced by
# any DB row. Dry-run by default; pass APPLY=1 to actually delete.
# See cmd/cleanup-orphans/main.go for the full contract.
cleanup-orphans:
	@bash -c ' \
	  ARGS=(); \
	  for f in .env.$(ENV) .env.$(ENV).local; do \
	    [[ -f "$$f" ]] || continue; \
	    while IFS= read -r line; do \
	      case "$$line" in "#"*|"") continue;; esac; \
	      ARGS+=("$$line"); \
	    done < "$$f"; \
	  done; \
	  FLAGS=""; \
	  if [[ "$(APPLY)" = "1" ]]; then FLAGS="--apply"; fi; \
	  env "$${ARGS[@]}" go run ./cmd/cleanup-orphans $$FLAGS'

sqlc:
	sqlc generate

lint:
	golangci-lint run ./...

fmt:
	go fmt ./...

clean:
	rm -rf bin/
