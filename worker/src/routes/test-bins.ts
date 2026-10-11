/**
 * GET /api/v1/test/bins?count=N&seed=S&format=json|csv|geojson
 *
 * Canned data for the SPA to point a `kind: 'rest'` DataSource at. The
 * three formats let the user exercise the file-kind dispatcher in
 * `src/lib/data-link/parse-file.ts` end-to-end.
 *
 * Auth: X-Api-Key OR Authorization: Bearer <JWT>. Either header is
 * sufficient; both being present is fine too.
 */

import { checkApiKey } from '../lib/auth-api-key'
import { verifyBearer } from '../lib/auth-jwt'
import type { Env } from '../env'
import { errorResponse, json, text } from '../lib/json'
import { generateTestBins, type TestBin } from '../lib/seeded-rng'

const MAX_COUNT = 500
const DEFAULT_COUNT = 25

export async function handleTestBins(request: Request, env: Env): Promise<Response> {
  // Dual-auth: pass on either credential.
  const apiKeyOk = checkApiKey(request, env)
  const jwtClaims = apiKeyOk ? null : await verifyBearer(request, env.JWT_SECRET)
  if (!apiKeyOk && !jwtClaims) {
    return errorResponse(request, env, 401, 'unauthorized — supply X-Api-Key or Authorization: Bearer')
  }

  const url = new URL(request.url)
  const count = clampInt(url.searchParams.get('count'), DEFAULT_COUNT, 1, MAX_COUNT)
  const seed = clampInt(url.searchParams.get('seed'), 1, 0, 2 ** 31 - 1)
  const format = (url.searchParams.get('format') ?? 'json').toLowerCase()

  const bins = generateTestBins(count, seed)

  switch (format) {
    case 'json':
      return json(request, env, { bins })
    case 'csv':
      return text(request, env, toCsv(bins), {}, 'text/csv; charset=utf-8')
    case 'geojson':
      return text(
        request,
        env,
        JSON.stringify(toGeoJson(bins)),
        {},
        'application/geo+json; charset=utf-8',
      )
    default:
      return errorResponse(request, env, 400, `unsupported format "${format}"`)
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function toCsv(bins: TestBin[]): string {
  const cols = ['externalCode', 'sku', 'capacity', 'status', 'notes', 'zone'] as const
  const escape = (v: string | number) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = cols.join(',')
  const body = bins.map((b) => cols.map((c) => escape(b[c] as string | number)).join(',')).join('\n')
  return `${header}\n${body}\n`
}

function toGeoJson(bins: TestBin[]) {
  // Anchor the synthesized points around a fixed lng/lat so the SPA can
  // overlay them on the map without leaking real warehouse coordinates.
  const baseLng = -74.0
  const baseLat = 40.71
  return {
    type: 'FeatureCollection',
    features: bins.map((b, i) => ({
      type: 'Feature',
      properties: { ...b },
      geometry: {
        type: 'Point',
        coordinates: [baseLng + (i % 10) * 0.0005, baseLat + Math.floor(i / 10) * 0.0005],
      },
    })),
  }
}
