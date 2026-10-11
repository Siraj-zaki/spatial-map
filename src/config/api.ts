/**
 * Runtime configuration for the Go + Postgres backend that replaces Dexie.
 * Values are read from Vite environment variables so the same build can be
 * pointed at different backends (local dev, staging, production).
 *
 * Default is an empty base (same-origin) so the browser calls `/api/v1/*`
 * on whatever host served the page. In dev, Vite's `server.proxy` forwards
 * those to the Go backend (see vite.config.ts), which lets other devices
 * on the LAN hit the frontend via the host machine's IP without their
 * `localhost:8080` resolution failing. For a production build, set
 * `VITE_API_BASE_URL` to the absolute public URL of the backend.
 */

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''
export const API_KEY = import.meta.env.VITE_API_KEY ?? 'dev-api-key-change-in-production'

/** Prefix used for all REST calls. */
export const API_V1_URL = `${API_BASE_URL}/api/v1`

/** Prefix used for unauthenticated public endpoints (shareable presentation view). */
export const API_PUBLIC_URL = `${API_BASE_URL}/api/v1/public`

/** Public file serving prefix for uploaded images and 3D models. */
export const FILES_URL = `${API_BASE_URL}/files`
