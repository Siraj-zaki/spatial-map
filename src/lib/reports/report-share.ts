/**
 * Report share links — public, read-only links to one report.
 *
 * Signed in: list / create a report's links (`/reports/{id}/share-links`);
 * revoke and delete reuse share-link-client (`/share-links/{id}`).
 *
 * Public: `/r/:token` loads `/public/report-share/{token}` and switches this
 * module into shared mode for the page's lifetime. The report runner, the
 * source schemas, map-layer rows, history events, the History widget and
 * the 3D model list then read through the token's routes instead of the
 * signed-in API — see the `reportShareToken()` callers. The server answers
 * only for the sources the report reads.
 */

import { apiGet, apiPost, publicFetch } from '@/lib/api-client'
import { openOnOwningSite, siteUrl } from '@/lib/site'
import { parseShareLink, type RawShareLink, type ShareLink, type ShareLinkCreateRequest } from '@/lib/share-link-client'
import type { WarehouseView } from '@/hooks/usePublicWarehouse'
import type { Report, ReportSpec } from '@/lib/reports-client'
import type { UserModel } from '@/lib/db'

/** What a report link opens with. Every field optional. */
export interface ReportShareSettings {
  /** The report page's query string when the link was made — its filter
   *  values and hidden map layers. A visitor whose URL has none opens with it. */
  search?: string
  /** Full map or page; unset = the report's own layout. */
  view?: 'map' | 'page'
}

export interface PublicReportShare {
  link: {
    label: string
    settings: ReportShareSettings
    expiresAt?: string
    maxViews?: number | null
    viewCount: number
    issuedAt: string
  }
  report: Report
  /** The map the report's explorer draws on; null for a report without one. */
  facility: { warehouse: WarehouseView; userModels: UserModel[] } | null
}

// ---- shared mode ----------------------------------------------------

let active: { token: string; userModels: UserModel[] } | null = null

/** The open share link's token, or null on every signed-in page. */
export function reportShareToken(): string | null {
  return active?.token ?? null
}

/** The uploaded 3D models the shared facility places (shared mode only). */
export function reportShareUserModels(): UserModel[] {
  return active?.userModels ?? []
}

/** Set by the shared-report page while it is mounted. */
export function setReportShare(share: { token: string; userModels: UserModel[] } | null): void {
  active = share
}

function sharePath(path: string): string {
  return `/report-share/${encodeURIComponent(active?.token ?? '')}${path}`
}

// ---- facility share (`/share/:token`) ---------------------------------
//
// A signed-out visitor of a facility share link reads its data-link rows
// through `/public/share/{token}/sources/{id}/rows|query|events` (limited
// server-side to the facility's data-link sources). Set by the viewer's
// token mode (routes/view.tsx) while it is mounted.

let facilityToken: string | null = null

/** The open facility share link's token, or null. */
export function facilityShareToken(): string | null {
  return facilityToken
}

/** Set by the facility viewer in share-link mode; null on unmount. */
export function setFacilityShare(token: string | null): void {
  facilityToken = token
}

/**
 * True while data-source rows / queries / events read through a public
 * link (a report share or a facility share) instead of the signed-in API.
 */
export function sourceShareActive(): boolean {
  return active !== null || facilityToken !== null
}

function sourceSharePath(path: string): string {
  if (active) return sharePath(path)
  return `/share/${encodeURIComponent(facilityToken ?? '')}${path}`
}

/** GET a `/sources/{id}/…` path through whichever public link is open. */
export function sourceShareGet<T>(path: string): Promise<T> {
  return publicFetch<T>(sourceSharePath(path))
}

/** POST a `/sources/{id}/…` path through whichever public link is open. */
export function sourceSharePost<T>(path: string, body: unknown): Promise<T> {
  return publicFetch<T>(sourceSharePath(path), { method: 'POST', body: JSON.stringify(body) })
}

/** GET through the open share link. */
export function shareGet<T>(path: string): Promise<T> {
  return publicFetch<T>(sharePath(path))
}

/** POST through the open share link. */
export function sharePost<T>(path: string, body: unknown): Promise<T> {
  return publicFetch<T>(sharePath(path), { method: 'POST', body: JSON.stringify(body) })
}

// ---- signed in ------------------------------------------------------

export async function listReportShareLinks(reportId: number): Promise<ShareLink[]> {
  const rows = await apiGet<RawShareLink[]>(`/reports/${reportId}/share-links`)
  return rows.map(parseShareLink)
}

export async function createReportShareLink(
  reportId: number,
  req: Omit<ShareLinkCreateRequest, 'settings'> & { settings?: ReportShareSettings },
): Promise<ShareLink> {
  return parseShareLink(await apiPost<RawShareLink>(`/reports/${reportId}/share-links`, req))
}

/** The public URL of a report link. */
export function reportShareUrl(token: string): string {
  return siteUrl(`/r/${token}`)
}

// ---- public ---------------------------------------------------------

const DATE_FIELDS = ['createdAt', 'updatedAt', 'lastSyncedAt']
function withDates<T>(row: T): T {
  if (!row || typeof row !== 'object') return row
  const out = { ...(row as Record<string, unknown>) }
  for (const f of DATE_FIELDS) if (typeof out[f] === 'string') out[f] = new Date(out[f] as string)
  return out as T
}

interface PublicReportShareWire extends Omit<PublicReportShare, 'report' | 'facility'> {
  report: Omit<Report, 'spec'> & { spec: ReportSpec | string }
  facility?: { warehouse: WarehouseView; userModels: UserModel[] } | null
}

/** Open a report link (counts a view). Throws ApiError 404 for a dead link. */
export async function fetchReportShare(token: string): Promise<PublicReportShare> {
  const raw = await openOnOwningSite(`report:${token}`, () =>
    publicFetch<PublicReportShareWire>(`/report-share/${encodeURIComponent(token)}`),
  )
  const spec = typeof raw.report.spec === 'string' ? (JSON.parse(raw.report.spec) as ReportSpec) : raw.report.spec
  const w = raw.facility?.warehouse
  return {
    link: { ...raw.link, settings: (raw.link.settings ?? {}) as ReportShareSettings },
    report: { ...raw.report, spec, canEdit: false },
    facility: w
      ? {
          warehouse: Object.fromEntries(
            Object.entries(w).map(([k, v]) => [k, Array.isArray(v) ? v.map(withDates) : withDates(v)]),
          ) as unknown as WarehouseView,
          userModels: (raw.facility?.userModels ?? []).map(withDates),
        }
      : null,
  }
}
