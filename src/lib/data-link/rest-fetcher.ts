/**
 * REST adapter.
 *
 * The goal is to keep the existing parse → preview → commit pipeline
 * untouched. So instead of writing a new parser for "JSON arrived over
 * HTTP", we fetch the URL, wrap the response in a synthetic `File`
 * (named so its extension drives the dispatcher), and hand it back to
 * `parseFile()`. Everything downstream behaves exactly like a local
 * pick.
 *
 * What this module owns:
 *   - the fetch (with headers, timeout, response-type guess)
 *   - a typed `RestSourceConfig` shape persisted on `DataSource.config`
 *   - small error type so the UI can render network failures clearly
 */

export class RestFetchError extends Error {}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

/** Persisted under `DataSource.config` when `DataSource.kind === 'rest'`. */
export interface RestSourceConfig {
  /** Full URL the source fetches. CORS rules apply — the server has to allow our origin. */
  url: string
  /** HTTP method. Defaults to GET; POST is useful for graphql-style endpoints. */
  method?: 'GET' | 'POST'
  /**
   * Headers sent with every request. Use this for API keys
   * (`X-Api-Key: …`) or bearer tokens (`Authorization: Bearer …`).
   * Stored as plain text — fine for local-only apps; we can move to a
   * relay later if secrets need to leave the browser.
   *
   * When `authMode` is `'apiKey'` or `'bearer'`, the fetcher derives the
   * appropriate header automatically — `headers` is then for everything
   * else the endpoint needs (custom tracing, content-type overrides, …).
   */
  headers?: Record<string, string>
  /**
   * How the fetcher should construct the auth header(s):
   *   - `'none'`    — no auth header added
   *   - `'apiKey'`  — `X-Api-Key: <apiKey>`
   *   - `'bearer'`  — `Authorization: Bearer <bearerToken>`
   *   - `'custom'`  — caller-supplied `headers` are passed through as-is
   *
   * Defaults to `'custom'` to preserve pre-existing DataSources whose
   * config bag predates this field.
   */
  authMode?: 'none' | 'apiKey' | 'bearer' | 'custom'
  /** Used when `authMode === 'apiKey'`. */
  apiKey?: string
  /** Used when `authMode === 'bearer'`. */
  bearerToken?: string
  /** Optional request body for POST. */
  body?: string
  /**
   * Hint for the parser when the response is JSON. Same semantics as
   * `parseJsonFile`'s `rootPath` (dot path into nested data).
   */
  rootPath?: string
  /**
   * Hint for the dispatcher when the response doesn't carry a useful
   * Content-Type. `'json'` is the default. CSV is supported too —
   * useful for endpoints that stream tabular exports.
   */
  responseFormat?: 'json' | 'csv' | 'geojson'
}

/**
 * Run the fetch and return a `File` carrying the response bytes. The
 * file's name uses the responseFormat extension so `detectFileKind`
 * picks the right parser when `parseFile` is called.
 */
export async function fetchRestSource(config: RestSourceConfig): Promise<File> {
  if (!config.url || config.url.trim() === '') {
    throw new RestFetchError('URL is required')
  }
  let url: URL
  try {
    url = new URL(config.url)
  } catch {
    throw new RestFetchError(`Not a valid URL: "${config.url}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RestFetchError(`Unsupported URL scheme "${url.protocol}" — use http or https.`)
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(config.url, {
      method: config.method ?? 'GET',
      headers: buildHeaders(config),
      body: config.method === 'POST' ? config.body : undefined,
      signal: controller.signal,
      // `redirect: 'follow'` is the browser default; keep it explicit so
      // a server that 301s to another origin still resolves.
      redirect: 'follow',
    })
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new RestFetchError(`Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`)
    }
    // Network failures + CORS show up as `TypeError: Failed to fetch`.
    // Surface a more useful hint instead of the raw browser message.
    throw new RestFetchError(
      `Could not reach ${url.host}. Check the URL is reachable and the server allows browser requests (CORS).`,
    )
  } finally {
    window.clearTimeout(timeout)
  }

  if (!res.ok) {
    throw new RestFetchError(
      `Server responded ${res.status} ${res.statusText}.`,
    )
  }

  const blob = await res.blob()
  if (blob.size > MAX_RESPONSE_BYTES) {
    throw new RestFetchError(
      `Response too large: ${(blob.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_RESPONSE_BYTES / 1024 / 1024} MB).`,
    )
  }

  const ext = pickExtension(res.headers.get('content-type'), config.responseFormat)
  const filename = `rest-${url.host}${url.pathname.replace(/[^a-zA-Z0-9_-]+/g, '-')}.${ext}`
  const mime = mimeForExt(ext)
  return new File([blob], filename, { type: mime })
}

/**
 * Merge the caller-supplied `headers` with the auth-mode-derived header.
 * Explicit `headers` entries win, so the user can always override (e.g.
 * point at a custom auth header name) by switching to `authMode: 'custom'`
 * and stamping the header themselves.
 */
function buildHeaders(config: RestSourceConfig): Record<string, string> | undefined {
  const mode = config.authMode ?? 'custom'
  const bag: Record<string, string> = { ...(config.headers ?? {}) }
  if (mode === 'apiKey' && config.apiKey) {
    bag['X-Api-Key'] = config.apiKey
  } else if (mode === 'bearer' && config.bearerToken) {
    bag['Authorization'] = `Bearer ${config.bearerToken}`
  }
  return Object.keys(bag).length > 0 ? bag : undefined
}

function pickExtension(
  contentType: string | null,
  hint: RestSourceConfig['responseFormat'],
): 'json' | 'csv' | 'geojson' {
  if (hint) return hint
  if (!contentType) return 'json'
  const ct = contentType.toLowerCase()
  if (ct.includes('json')) {
    return ct.includes('geo+json') ? 'geojson' : 'json'
  }
  if (ct.includes('csv') || ct.includes('tab-separated')) return 'csv'
  return 'json'
}

function mimeForExt(ext: 'json' | 'csv' | 'geojson'): string {
  switch (ext) {
    case 'json':    return 'application/json'
    case 'geojson': return 'application/geo+json'
    case 'csv':     return 'text/csv'
  }
}
