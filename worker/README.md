# spatial-grid-vis test backend

A Cloudflare Worker that exposes a canned REST endpoint and a webhook
receiver so the SPA's Data-Link Layer can be exercised end-to-end
without standing up real infrastructure.

**Scope:** local-only testing. CORS allow-list is `http://localhost:5173`
by default; the Worker is meant to be run via `wrangler dev`. To go
public, add the deployed SPA origin to `ALLOWED_ORIGINS` in
`wrangler.jsonc` and run `wrangler deploy`. Real external webhooks
(Stripe, GitHub, ...) need a tunnel — see "Receiving external webhooks"
below.

## Install

```bash
cd worker
npm install
```

## Configure secrets

The Worker reads two secrets at runtime. For `wrangler dev`, put them in
`.dev.vars` (gitignored):

```sh
# worker/.dev.vars
API_KEY=local-test-api-key-change-me
JWT_SECRET=local-test-jwt-secret-change-me-too
```

For deployed environments, use `wrangler secret put API_KEY` etc.

## Run

```bash
npm run dev            # wrangler dev — http://localhost:8787
npm run tail           # live logs (separate terminal)
npm run typecheck      # tsc --noEmit
```

## Routes

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/healthz` | none | `200 ok` |
| `GET` | `/api/v1/test/bins?count=N&seed=S&format=json\|csv\|geojson` | `X-Api-Key` or `Bearer <JWT>` | Canned data for the SPA's REST source flow |
| `POST` | `/api/v1/auth/issue-jwt` | `X-Api-Key` | Body `{ ttlSeconds?, subject? }` → `{ token, expiresAt }` |
| `POST` | `/webhooks/:sourceToken/register` | `X-Api-Key` | Body `{ secret }` → stores HMAC secret on the DO |
| `POST` | `/webhooks/:sourceToken` | `X-Webhook-Signature` | Validates HMAC + enqueues raw body |
| `GET` | `/webhooks/:sourceToken/drain?max=N` | `X-Api-Key` | Atomically dequeues up to N events |

## curl examples

```bash
export API_KEY=local-test-api-key-change-me
BASE=http://localhost:8787

# REST: API key
curl -sS -H "X-Api-Key: $API_KEY" "$BASE/api/v1/test/bins?count=5&seed=42"

# REST: bearer
TOKEN=$(curl -sS -X POST -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ttlSeconds":3600,"subject":"verify"}' \
  "$BASE/api/v1/auth/issue-jwt" | jq -r .token)
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/test/bins"

# Webhook: register a source, send a signed event, drain
TOKEN_SRC=$(openssl rand -hex 16)
SECRET=$(openssl rand -hex 32)
curl -sS -X POST -H "X-Api-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"secret\":\"$SECRET\"}" \
  "$BASE/webhooks/$TOKEN_SRC/register"

T=$(date +%s)
BODY='{"externalCode":"A-001","sku":"SKU-1","capacity":42}'
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -sS -X POST \
  -H "X-Webhook-Signature: t=$T,v1=$SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "$BASE/webhooks/$TOKEN_SRC"

curl -sS -H "X-Api-Key: $API_KEY" "$BASE/webhooks/$TOKEN_SRC/drain"
```

## Receiving external webhooks

`wrangler dev` only listens on localhost. To receive deliveries from
Stripe / GitHub / etc. during development:

```bash
cloudflared tunnel --url http://localhost:8787
```

Use the printed `*.trycloudflare.com` URL in the external service's
webhook config. Not automated by this README — it's a manual step.

## Architecture notes

- **Webhook queue** is a Durable Object (one per `sourceToken`) backed by
  SQLite. Drain is a two-statement read-then-delete; SQLite under DOs is
  single-threaded per instance so the pair is atomic.
- **HMAC verification** uses `crypto.subtle.verify` so the comparison is
  timing-attack safe. Per-source `CryptoKey`s are cached in module scope.
- **CORS** allow-list comes from `ALLOWED_ORIGINS` (comma-separated). The
  Worker echoes the request `Origin` when it matches and omits the header
  when it doesn't.
- **Secrets** stay on the Worker. The SPA stores the API key + HMAC secret
  in Dexie under `DataSource.config`. Local-only testing assumption — do
  not reuse this in production without an HttpOnly-cookie BFF.
