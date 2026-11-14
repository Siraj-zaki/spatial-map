/**
 * Share-link client
 *
 * Wraps the backend's `/api/v1/warehouses/{id}/share-links`,
 * `/api/v1/share-links/{id}` and the unauthed `/api/v1/share/{token}`
 * endpoints. Everything below is pure fetch + type — no React, no store
 * — so the editor and the public viewer can both import it without
 * dragging Zustand into the public bundle.
 *
 * ## Settings blob
 *
 * The backend stores `settings` as opaque JSONB. This module is the only
 * place in the SPA that ascribes structure to it. The blob is fully
 * optional: every field defaults to "use whatever the viewer would
 * choose on its own" so an empty {} is a valid share link that behaves
 * exactly like the legacy `/share/:token` URLs.
 *
 * When adding a new customisation to the share dialog, add its field
 * here first + document defaults; the dialog then wires the control and
 * the viewer wires the consumption. Never invent new keys inline in the
 * dialog — they must round-trip through this file.
 */

import { apiDelete, apiGet, apiPatch, apiPost, publicFetch } from '@/lib/api-client'
import { openOnOwningSite, siteUrl } from '@/lib/site'
import type { MapStyleId } from '@/components/mapbox-map'
import type { ThemeMode, ThemePalette } from '@/components/theme-provider'
import type { WarehouseView } from '@/hooks/usePublicWarehouse'

/**
 * Every rendering-relevant option the share dialog can pin. All fields
 * optional: `undefined` means "let the viewer decide" (the viewer's
 * localStorage or its own defaults).
 */
export interface ShareLinkSettings {
  // ---- Appearance ---------------------------------------------------
  /** Basemap picked from `/map-styles.json`. */
  mapStyle?: MapStyleId
  /** Accent palette from theme-provider.tsx PALETTES. */
  palette?: ThemePalette
  /** Light / dark / system. */
  themeMode?: ThemeMode
  /** Free-form watermark text drawn over the bottom of the viewer. */
  watermark?: string

  // ---- Initial state ------------------------------------------------
  /** Numeric id of the image (= floor plan) the viewer opens on. */
  defaultFloorPlanId?: number | null

  // ---- Layer visibility --------------------------------------------
  /**
   * Per-kind eye toggles. Missing entries default to `true`. Set to
   * `false` to force a layer off for viewers of THIS link.
   */
  layerVisibility?: Partial<Record<ShareLayerKind, boolean>>

  // ---- Data-link customisation ------------------------------------
  /** Config ids to hide (viewer + filter widget skip them entirely). */
  hiddenDataLinkConfigIds?: number[]
  /**
   * Which saved filter each data-link layer opens on. Keyed by config
   * id; the value is a `DataLinkFilterPreset.id` authored in the data
   * link editor, or `''` for "all records".
   *
   * Storing the preset *id* rather than the filter tree is deliberate:
   * a shared report must keep meaning what its author says it means, so
   * editing the preset updates every link that references it.
   */
  dataLinkFilterPresets?: Record<number, string>

  // ---- Chrome (which UI panels the viewer renders) ----------------
  chrome?: ShareChromeFlags

  // ---- Optional operator notes shown in the share drawer ---------
  notes?: string
}

/**
 * Layer kinds the toggles cover. Mirrors `view-layers-panel.tsx`'s
 * LayerKind union — kept as a separate literal to avoid a cross-package
 * type dep for the public bundle.
 */
export type ShareLayerKind =
  | 'racks'
  | 'bins'
  | 'markers'
  | 'models'
  | 'images'
  | 'text'
  | 'stairs'
  | 'polygons'
  | 'circles'
  | 'lines'
  | 'doors'
  | 'imagePlanes'
  | 'dataLinks'

/**
 * Chrome flags — each field maps to a viewer panel or button. Missing
 * fields default to `true` (viewer shows everything). Set to `false` to
 * hide.
 */
export interface ShareChromeFlags {
  showFloorPlanFilter?: boolean
  showLayersPanel?: boolean
  showDataLinkFilter?: boolean
  showLegend?: boolean
  showStyleSwitcher?: boolean
  showLanguageSwitcher?: boolean
  showThemePicker?: boolean
  showModeToggle?: boolean
  showShareBadge?: boolean
  /**
   * v5.4 — surfaces the shadows / ambient-occlusion / marker-occlusion
   * toggles on the viewer (same settings the editor's side-panel exposes,
   * persisted in the same localStorage-backed `useGraphicsSettings`
   * store). Off by default only when the share-link author explicitly
   * clears it; presentational share links can hide the pill without
   * touching the toggles the recipient's browser already remembers.
   */
  showGraphicsSettings?: boolean
  /**
   * When false, disable pan / zoom / rotate. Public presentations for
   * kiosks or embed cards where the viewer shouldn't scroll away.
   */
  allowInteraction?: boolean
}

// ---- Row / response types ------------------------------------------

export type ShareLinkStatus = 'active' | 'expired' | 'capped' | 'revoked'

export interface ShareLink {
  id: number
  tenantId: number
  zoneId: number
  /** Set on a report link (see lib/reports/report-share.ts). */
  reportId?: number
  token: string
  label: string
  settings: ShareLinkSettings
  expiresAt?: string
  maxViews?: number | null
  viewCount: number
  lastAccessedAt?: string
  createdBy?: number | null
  createdAt: string
  updatedAt: string
  revokedAt?: string
  revokedBy?: number | null
  status: ShareLinkStatus
}

export interface ShareLinkCreateRequest {
  label?: string
  settings?: ShareLinkSettings
  /** RFC3339 absolute timestamp. `null` / omitted = never expires. */
  expiresAt?: string | null
  /** Seconds-from-now TTL. Simpler than computing timestamps client-side. */
  expirySeconds?: number | null
  /** Total viewer cap. `null` / omitted = unlimited. */
  maxViews?: number | null
}

export type ShareLinkUpdateRequest = ShareLinkCreateRequest

export interface PublicSharedWarehouse {
  link: {
    label: string
    settings: ShareLinkSettings
    expiresAt?: string
    maxViews?: number | null
    viewCount: number
    issuedAt: string
  }
  warehouse: WarehouseView
}

// ---- Expiry presets ------------------------------------------------

/**
 * Ergonomic TTL presets shown in the dialog. Values in seconds so the
 * client can hand `expirySeconds` straight to the backend. Custom lets
 * the user pick an absolute date; NEVER omits both.
 */
export const EXPIRY_PRESETS = {
  ONE_HOUR: 60 * 60,
  ONE_DAY: 24 * 60 * 60,
  SEVEN_DAYS: 7 * 24 * 60 * 60,
  THIRTY_DAYS: 30 * 24 * 60 * 60,
  NINETY_DAYS: 90 * 24 * 60 * 60,
  ONE_YEAR: 365 * 24 * 60 * 60,
} as const

export type ExpiryPresetKey = keyof typeof EXPIRY_PRESETS | 'NEVER' | 'CUSTOM'

// Deserialize server-side `settings` (arrives as unknown) into our type.
// Purely structural; unknown keys are preserved so newer viewers hitting
// older backends don't lose fields.
function parseSettings(raw: unknown): ShareLinkSettings {
  if (!raw || typeof raw !== 'object') return {}
  return raw as ShareLinkSettings
}

/** Wire shape of a share-link row. Optional fields may arrive as
 *  null / empty strings; `parseLink` normalises them. */
export type RawShareLink = Omit<ShareLink, 'label' | 'settings' | 'expiresAt' | 'viewCount' | 'lastAccessedAt' | 'revokedAt' | 'reportId'> & {
  reportId?: number | null
  label?: string | null
  settings?: unknown
  expiresAt?: string | null
  viewCount?: number | null
  lastAccessedAt?: string | null
  revokedAt?: string | null
}

function parseLink(raw: RawShareLink): ShareLink {
  return {
    id: raw.id,
    tenantId: raw.tenantId,
    zoneId: raw.zoneId,
    reportId: raw.reportId ?? undefined,
    token: raw.token,
    label: raw.label ?? '',
    settings: parseSettings(raw.settings),
    expiresAt: raw.expiresAt || undefined,
    maxViews: raw.maxViews ?? null,
    viewCount: raw.viewCount ?? 0,
    lastAccessedAt: raw.lastAccessedAt || undefined,
    createdBy: raw.createdBy ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    revokedAt: raw.revokedAt || undefined,
    revokedBy: raw.revokedBy ?? null,
    status: raw.status,
  }
}

/** Row parser, shared with the report links client. */
export const parseShareLink = parseLink

// ---- API surface ---------------------------------------------------

export async function listShareLinks(warehouseId: number | string): Promise<ShareLink[]> {
  const rows = await apiGet<RawShareLink[]>(`/warehouses/${warehouseId}/share-links`)
  return rows.map(parseLink)
}

export async function createShareLink(
  warehouseId: number | string,
  req: ShareLinkCreateRequest,
): Promise<ShareLink> {
  const raw = await apiPost<RawShareLink>(`/warehouses/${warehouseId}/share-links`, req)
  return parseLink(raw)
}

export async function updateShareLink(
  id: number,
  req: ShareLinkUpdateRequest,
): Promise<ShareLink> {
  const raw = await apiPatch<RawShareLink>(`/share-links/${id}`, req)
  return parseLink(raw)
}

export async function revokeShareLink(id: number): Promise<ShareLink> {
  const raw = await apiPost<RawShareLink>(`/share-links/${id}/revoke`, {})
  return parseLink(raw)
}

export async function deleteShareLink(id: number): Promise<void> {
  await apiDelete<void>(`/share-links/${id}`)
}

/**
 * Fetches a shared warehouse by its public token. Unauthenticated —
 * uses `publicFetch` which skips the X-Api-Key + X-Tenant-Id headers.
 * Returns `null` on 404 so the viewer route can fall through to the
 * legacy `/public/warehouses/by-token/{token}` path.
 *
 * The returned `warehouse` envelope has its date-string fields upcasted
 * to `Date` objects so downstream overlays that call `.getTime()` on
 * `createdAt` / `updatedAt` don't silently receive `NaN`. Mirrors the
 * `parseAll()` step that `usePublicWarehouse` applies for the legacy
 * envelope.
 */
export async function fetchSharedWarehouse(token: string): Promise<PublicSharedWarehouse | null> {
  return parseShared(() => openOnOwningSite(`share:${token}`, () => publicFetch<PublicSharedWarehouse>(`/share/${token}`)))
}

async function parseShared(load: () => Promise<PublicSharedWarehouse>): Promise<PublicSharedWarehouse | null> {
  try {
    const raw = await load()
    return {
      link: {
        label: raw.link.label ?? '',
        settings: parseSettings(raw.link.settings),
        expiresAt: raw.link.expiresAt,
        maxViews: raw.link.maxViews ?? null,
        viewCount: raw.link.viewCount ?? 0,
        issuedAt: raw.link.issuedAt,
      },
      warehouse: parseWarehouseDates(raw.warehouse),
    }
  } catch (err) {
    const anyErr = err as { status?: number }
    if (anyErr?.status === 404) return null
    throw err
  }
}

/**
 * Date-field upcast for a WarehouseView envelope. The wire format ships
 * `createdAt` / `updatedAt` as RFC3339 strings; overlays and the fit-map
 * helpers expect `Date` instances. This mirrors `parseAll` in
 * `usePublicWarehouse.ts` — kept as a local copy to avoid a cross-hook
 * import (share-link-client is meant to be tree-shakeable for the public
 * bundle).
 */
const DATE_FIELDS = ['createdAt', 'updatedAt', 'lastSyncedAt']
function parseDatesRow<T>(row: T): T {
  if (!row || typeof row !== 'object') return row
  const out = { ...(row as Record<string, unknown>) }
  for (const f of DATE_FIELDS) {
    const v = out[f]
    if (typeof v === 'string') out[f] = new Date(v)
  }
  return out as T
}
function parseWarehouseDates(view: WarehouseView): WarehouseView {
  return {
    zone: parseDatesRow(view.zone),
    grids: (view.grids ?? []).map(parseDatesRow),
    polygons: (view.polygons ?? []).map(parseDatesRow),
    circles: (view.circles ?? []).map(parseDatesRow),
    lines: (view.lines ?? []).map(parseDatesRow),
    markers: (view.markers ?? []).map(parseDatesRow),
    images: (view.images ?? []).map(parseDatesRow),
    models: (view.models ?? []).map(parseDatesRow),
    textLabels: (view.textLabels ?? []).map(parseDatesRow),
    stairs: (view.stairs ?? []).map(parseDatesRow),
    doors: (view.doors ?? []).map(parseDatesRow),
    imagePlanes: (view.imagePlanes ?? []).map(parseDatesRow),
    bins: (view.bins ?? []).map(parseDatesRow),
    dataLinkConfigs: (view.dataLinkConfigs ?? []).map(parseDatesRow),
    styleRules: (view.styleRules ?? []).map(parseDatesRow),
  }
}

/**
 * Builds the absolute `/share/{token}` URL from a link. Used by the
 * dialog's copy button and the "open in new tab" affordance.
 */
export function shareLinkUrl(token: string): string {
  if (typeof window === 'undefined') return `/share/${token}`
  return siteUrl(`/share/${token}`)
}
