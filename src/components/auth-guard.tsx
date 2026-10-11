import { useEffect, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/lib/auth-store'
import { refreshSession } from '@/lib/auth-client'
import { AppSplash } from '@/components/feedback/app-splash'

/**
 * AuthGuard wraps protected routes. On mount it triggers a one-time
 * /auth/me probe to validate any persisted token. While that probe is in
 * flight (`ready === false`) we show the app splash — flashing the login
 * page and then the dashboard would look worse than a short pause.
 *
 * Unauthenticated users are redirected to /login with the original path
 * preserved in `location.state.from` so login can bounce them back.
 */
export function AuthGuard({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token)
  const ready = useAuthStore((s) => s.ready)
  const location = useLocation()

  useEffect(() => {
    if (!ready) {
      void refreshSession()
    }
  }, [ready])

  if (!ready) {
    return <AppSplash />
  }

  if (!token) {
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />
  }

  return <>{children}</>
}

/**
 * GuestOnly wraps /login and /signup: a signed-in user who lands there
 * (bookmark, back button, a stale tab) goes straight to where they were
 * headed — `state.from` when AuthGuard sent them, else /dashboard — instead
 * of seeing a sign-in form for an account they're already in. A stale
 * token is fine to redirect on: AuthGuard's /auth/me probe rejects it and
 * bounces back to /login with the token cleared.
 *
 * /forgot-password is deliberately NOT wrapped: with no change-password
 * screen, it's how a signed-in user changes their password.
 */
export function GuestOnly({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token)
  const location = useLocation()
  if (token) {
    const from = (location.state as { from?: string } | null)?.from
    return <Navigate to={from ?? '/dashboard'} replace />
  }
  return <>{children}</>
}
