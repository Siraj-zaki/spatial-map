/**
 * Maps a failed /auth/* call to a translated message.
 *
 * The server sends a stable `code` next to its English `error` (see the
 * `code*` constants in backend/internal/handlers/auth.go — keep the two
 * lists in sync). The UI never shows the server's English: it picks an
 * `auth.errors.*` key here, falling back on the HTTP status / error kind
 * for responses without a code (proxies, 5xx, network failures).
 */

import { ApiError } from './api-client'

/** Which input an error belongs to, so the page can focus + mark it. */
export type AuthErrorField = 'email' | 'password' | 'code'

export interface AuthErrorInfo {
  /** i18n key under `auth.errors.*` (or another `auth.*` key). */
  key: string
  /** Seconds until the user may retry (429s). Drives the countdown. */
  retryAfter?: number
  /** Set when the message belongs next to one field rather than the form. */
  field?: AuthErrorField
  /** Server code, for pages that branch on a specific failure. */
  code?: string
}

/** Default wait when a 429 arrives without a Retry-After header. */
const DEFAULT_RETRY_SECONDS = 60

export function describeAuthError(err: unknown): AuthErrorInfo {
  if (!(err instanceof ApiError)) return { key: 'auth.errors.generic' }

  if (err.kind === 'network') {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    return { key: offline ? 'auth.errors.offline' : 'auth.errors.network' }
  }

  const code = err.code
  switch (code) {
    case 'rate_limited':
      return { key: 'auth.errors.rateLimited', retryAfter: err.retryAfter ?? DEFAULT_RETRY_SECONDS, code }
    case 'invalid_credentials':
      return { key: 'auth.errors.invalidCredentials', code }
    case 'invalid_email':
      return { key: 'auth.errors.invalidEmail', field: 'email', code }
    case 'otp_incorrect':
      return { key: 'auth.errors.otpIncorrect', field: 'code', code }
    case 'otp_expired':
      return { key: 'auth.errors.otpExpired', field: 'code', code }
    case 'otp_locked':
      return { key: 'auth.errors.otpLocked', field: 'code', code }
    case 'password_weak':
      return { key: 'auth.passwordRequirementsNotMet', field: 'password', code }
    case 'email_taken':
      return { key: 'auth.errors.emailTaken', code }
    case 'verification_expired':
      return { key: 'auth.verificationExpired', code }
    case 'session_revoked':
      return { key: 'auth.notices.sessionRevoked', code }
  }

  if (err.status === 429) {
    return { key: 'auth.errors.rateLimited', retryAfter: err.retryAfter ?? DEFAULT_RETRY_SECONDS }
  }
  if (err.kind === 'server' || (err.status ?? 0) >= 500) return { key: 'auth.errors.server' }
  return { key: 'auth.errors.generic' }
}

/** Loose client-side check; the server's regex is the authority. */
export function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())
}

/** "0:42" / "12:05" — a countdown readout that needs no plural forms. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
