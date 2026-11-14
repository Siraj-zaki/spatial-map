/**
 * Site helpers. Spatial Map serves one site at the origin root, so these
 * are thin: in-app paths are used as given, the product name is fixed, and a
 * public link always opens where it is.
 *
 * They exist so links, share URLs and product-name strings are built in one
 * place — components call `sitePath` / `siteUrl` / `productName` rather than
 * concatenating `window.location.origin` themselves.
 */

import { API_BASE_URL } from '@/config/api'

/** The product name (a brand name — not translated). Also `{{product}}` in every string (i18n.ts). */
export const MAIN_PRODUCT_NAME = 'Spatial Map'

/** An absolute in-app path (for links the router doesn't build). */
export function sitePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

/** An absolute URL on this site — what a copied share link / QR code carries. */
export function siteUrl(path: string): string {
  return `${window.location.origin}${sitePath(path)}`
}

/** Opens a public link (`open` is the API call). One site, so it never moves elsewhere. */
export async function openOnOwningSite<T>(_key: string, open: () => Promise<T>): Promise<T> {
  return open()
}

/** The name to show for the product. */
export function productName(): string {
  return MAIN_PRODUCT_NAME
}

/** The server returns asset paths (logos, avatars) relative to the API host. */
export function apiAssetUrl(path: string | undefined): string | undefined {
  return path?.startsWith('/') ? `${API_BASE_URL}${path}` : path
}
