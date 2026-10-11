/**
 * Auth API client. Wraps /api/v1/auth/* and /api/v1/members/* endpoints.
 *
 * Uses bare fetch (not apiFetch) for signup/login because those calls
 * deliberately have no auth context yet. After login, the rest of the app
 * uses the standard api-client which auto-injects the Bearer token.
 */

import { API_V1_URL } from '@/config/api'
import { ApiError, apiGet, apiPost, apiPatch, apiDelete } from './api-client'
import { useAuthStore, type AuthSession, type AuthRole } from './auth-store'
import { resetTenantStore } from './tenant-store'
import { useDoorStore } from './door/store'

/**
 * Wipe every user-scoped store so a login / signup / logout doesn't
 * bleed state across tenants. `useAuthStore` handles the token +
 * memberships block; this helper covers the sibling stores that hold
 * per-tenant data outside the main spatial-store (which is itself
 * re-hydrated from the backend on every tenant switch).
 *
 * Currently the only non-auth persisted store is the door tool — the
 * other shape kinds route through `spatial-store` which does not
 * persist to localStorage. Add new stores here as they get persist()
 * treatment so this stays the one place to update.
 */
function resetUserScopedStores(): void {
  resetTenantStore()
  useDoorStore.getState().resetForNewSession()
}

async function unauthenticatedJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_V1_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    // Callers render this through describeAuthError, which reads `kind`,
    // never this message.
    throw new ApiError(`Network error for ${init?.method ?? 'GET'} ${path}`, 'network')
  }
  const text = await res.text()
  let body: { data?: T; error?: string; code?: string }
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    // non-JSON response (e.g. 502 from a proxy)
    throw new ApiError(`unexpected response (${res.status})`, 'server', res.status, res)
  }
  if (!res.ok) {
    const kind = res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'server' : 'client'
    const err = new ApiError(body.error ?? `request failed (${res.status})`, kind, res.status, res)
    err.code = body.code
    throw err
  }
  return body.data as T
}

// ---------- 3-step signup: email → OTP → password ----------

export interface SignupRequestResult {
  ok: boolean
  email: string
  /** Seconds until the emailed code expires. Used to render the resend countdown. */
  expiresIn: number
}

/**
 * Step 1. Ask the server to email a 6-digit code to `email`. In local dev
 * (no SMTP configured), the code is written to the backend's stdout instead.
 * Answers identically whether or not the email is registered (an existing
 * account gets a "you already have an account" email instead of a code).
 */
export function requestSignupOtp(email: string): Promise<SignupRequestResult> {
  return unauthenticatedJson<SignupRequestResult>('/auth/signup-request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export interface VerifyOtpResult {
  verificationToken: string
  email: string
  expiresAt: string
}

/**
 * Step 2. Hand back the code the user typed. On success, receives a short
 * verification token that the final step exchanges for a real session.
 */
export function verifySignupOtp(email: string, code: string): Promise<VerifyOtpResult> {
  return unauthenticatedJson<VerifyOtpResult>('/auth/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  })
}

/**
 * Step 3. Final commit — creates the user, spawns their first tenant, and
 * signs them in. Populates the auth store on success.
 */
export async function completeSignup(params: {
  email: string
  password: string
  verificationToken: string
  displayName?: string
}): Promise<AuthSession> {
  const session = await unauthenticatedJson<AuthSession>('/auth/complete-signup', {
    method: 'POST',
    body: JSON.stringify(params),
  })
  useAuthStore.getState().setSession(session)
  resetUserScopedStores()
  return session
}

export async function login(email: string, password: string): Promise<AuthSession> {
  const session = await unauthenticatedJson<AuthSession>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  useAuthStore.getState().setSession(session)
  resetUserScopedStores()
  return session
}

// ---------- Password reset: email → OTP → new password ----------

/**
 * Step 1. Emails a reset code when `email` has an account. Answers
 * identically when it doesn't, so the UI must word the next step as
 * "if an account exists…".
 */
export function requestPasswordReset(email: string): Promise<SignupRequestResult> {
  return unauthenticatedJson<SignupRequestResult>('/auth/password-reset-request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export interface VerifyPasswordResetResult {
  resetToken: string
  email: string
  expiresAt: string
}

/** Step 2. Exchanges the emailed code for a single-use, 15-minute reset token. */
export function verifyPasswordReset(email: string, code: string): Promise<VerifyPasswordResetResult> {
  return unauthenticatedJson<VerifyPasswordResetResult>('/auth/password-reset-verify', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  })
}

/**
 * Step 3. Sets the new password. Signs out every existing session
 * server-side and deliberately does NOT sign the caller in — they go to
 * /login with the email prefilled.
 */
export function completePasswordReset(params: {
  email: string
  password: string
  resetToken: string
}): Promise<{ ok: boolean; email: string }> {
  return unauthenticatedJson<{ ok: boolean; email: string }>('/auth/password-reset-complete', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

export function logout(): void {
  // Fire-and-forget the server-side endpoint. Even if it fails (network gone),
  // we still clear the local session — the user wants out.
  void fetch(`${API_V1_URL}/auth/logout`, { method: 'POST' }).catch(() => {})
  useAuthStore.getState().clear()
  resetUserScopedStores()
}

/**
 * Refreshes the session from /auth/me. Called once on app boot when a token
 * is present in localStorage. If the token is invalid/expired, the server
 * 401s and we clear the session — sending the user back to /login.
 */
export async function refreshSession(): Promise<void> {
  const token = useAuthStore.getState().token
  if (!token) {
    useAuthStore.getState().setReady(true)
    return
  }
  try {
    // /auth/me returns `{token: "", user, tenants}` (token is intentionally
    // empty — the live token is whatever the client already holds). Pull out
    // only the fields we want; spreading the response would overwrite the
    // real token with the server's empty placeholder.
    const fresh = await apiGet<AuthSession>('/auth/me')
    useAuthStore.getState().setSession({ token, user: fresh.user, tenants: fresh.tenants })
  } catch (err) {
    // Only a definitive "this token is no good" ends the session. A network
    // blip or a 5xx while the API restarts must not log the user out — keep
    // the persisted session and let the app's own error states take over.
    if (err instanceof ApiError && err.kind === 'auth') {
      useAuthStore.getState().clear()
    } else {
      useAuthStore.getState().setReady(true)
    }
  }
}

// ---------- Members management ----------

export interface MemberRow {
  userId: number
  email: string
  role: AuthRole
}

export function listMembers(): Promise<MemberRow[]> {
  return apiGet<MemberRow[]>('/members')
}

export function inviteMember(email: string, role: AuthRole): Promise<MemberRow> {
  return apiPost<MemberRow>('/members', { email, role })
}

export function updateMemberRole(userId: number, role: AuthRole): Promise<MemberRow> {
  return apiPatch<MemberRow>(`/members/${userId}`, { role })
}

export function removeMember(userId: number): Promise<void> {
  return apiDelete<void>(`/members/${userId}`)
}
