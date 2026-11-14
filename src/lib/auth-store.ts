/**
 * Auth store — owns the current user's session.
 *
 * Persists to localStorage so a hard reload doesn't bounce the user back to
 * the login screen. The api-client reads `getAuthToken()` synchronously to
 * stamp Authorization: Bearer on outgoing requests.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export type AuthRole = 'owner' | 'admin' | 'editor' | 'viewer'

export interface AuthUser {
  id: number
  email: string
  displayName: string
  bio: string
  location: string
  pronouns: string
  jobTitle: string
  avatarUrl: string
  /** RFC3339 timestamp. Absent for legacy bootstrap admins (still trusted). */
  verifiedAt?: string
  /** True when this user's email matches SGV_AUTH.BOOTSTRAP_EMAIL on
   *  the backend — the platform-level admin. Unlocks the /admin
   *  metrics endpoint + the admin section on /dashboard. */
  isPlatformAdmin?: boolean
}

export interface AuthTenant {
  id: number
  name: string
  color: string
  role: AuthRole
  /** What the member may change here (custom roles; see lib/permissions.ts). */
  permissions?: string[]
  /** Set for a custom role: its id and name (`role` is then its base role). */
  customRoleId?: number
  roleName?: string
}

export interface AuthSession {
  token: string
  user: AuthUser
  tenants: AuthTenant[]
}

interface AuthState {
  token: string | null
  user: AuthUser | null
  tenants: AuthTenant[]
  /** Set after the first /auth/me probe so route guards know we're done bootstrapping. */
  ready: boolean
  setSession: (session: AuthSession) => void
  setUser: (user: AuthUser) => void
  setTenants: (tenants: AuthTenant[]) => void
  setReady: (ready: boolean) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      tenants: [],
      ready: false,
      setSession: (session) => set({
        token: session.token,
        user: session.user,
        tenants: session.tenants,
        ready: true,
      }),
      setUser: (user) => set({ user }),
      setTenants: (tenants) => set({ tenants }),
      setReady: (ready) => set({ ready }),
      clear: () => set({ token: null, user: null, tenants: [], ready: true }),
    }),
    {
      name: 'sgv-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ token: s.token, user: s.user, tenants: s.tenants }),
    },
  ),
)

/**
 * Synchronous token accessor for api-client. Reads from the Zustand store's
 * latest snapshot so it never lags behind setSession / clear.
 */
export function getAuthToken(): string | null {
  return useAuthStore.getState().token
}

export function isAuthenticated(): boolean {
  return !!useAuthStore.getState().token
}

/**
 * Find the user's role on a given tenant, or null if they aren't a member.
 * Used by UI to gate destructive actions.
 */
export function roleForTenant(tenantId: number): AuthRole | null {
  const t = useAuthStore.getState().tenants.find((t) => t.id === tenantId)
  return t?.role ?? null
}

/** Locate a tenant by id in the current session. */
export function tenantById(tenantId: number): AuthTenant | null {
  return useAuthStore.getState().tenants.find((t) => t.id === tenantId) ?? null
}
