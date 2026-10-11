import { useTranslation } from 'react-i18next'
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import {
  getCurrentTenantIdSync,
  initTenantStore,
  setCurrentTenantId,
  subscribeTenantChanges,
} from '@/lib/tenant-store'
import { runBackendMigration, type MigrationProgress } from '@/lib/migrate-to-backend'
import { useAuthStore } from '@/lib/auth-store'
import { AppSplash } from '@/components/feedback/app-splash'

interface TenantContextValue {
  /** The active tenant id, or null while the store is still initializing. */
  tenantId: number | null
  /** True during tenant init and during the one-time IndexedDB backfill. */
  isLoading: boolean
  /** True only while the backend migration is running. */
  isMigrating: boolean
  /** Last migration progress snapshot, if any. */
  migrationProgress: MigrationProgress | null
  /** Persist a new tenant id to the backend and notify subscribers. */
  setTenantId: (id: number) => Promise<void>
}

const TenantContext = createContext<TenantContextValue>({
  tenantId: null,
  isLoading: true,
  isMigrating: false,
  migrationProgress: null,
  setTenantId: async () => {},
})

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true)
  const [isMigrating, setIsMigrating] = useState(false)
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null)
  // Only a signed-in visit waits on the workspace; /login never does.
  const signedIn = useAuthStore((s) => Boolean(s.token))

  const tenantId = useSyncExternalStore(
    subscribeTenantChanges,
    () => getCurrentTenantIdSync(),
    () => null,
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const id = await initTenantStore()
      if (cancelled) return

      if (id !== null) {
        setIsMigrating(true)
        try {
          await runBackendMigration({
            tenantId: id,
            onProgress: (p) => {
              setMigrationProgress(p)
              if (process.env.NODE_ENV !== 'production') {
                console.log('[migrate]', p.phase, p.table, `${p.done}/${p.total}`, p.message ?? '')
              }
            },
          })
        } catch (err) {
          console.error('[migrate] migration failed', err)
        } finally {
          setIsMigrating(false)
        }
      }

      if (!cancelled) setIsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <TenantContext.Provider
      value={{
        tenantId,
        isLoading,
        isMigrating,
        migrationProgress,
        setTenantId: setCurrentTenantId,
      }}
    >
      {isMigrating ? (
        <MigrationOverlay progress={migrationProgress} />
      ) : isLoading && tenantId === null && signedIn ? (
        // Pages gate their fetches on the workspace id; rendering them
        // before it's known flashed "No facilities yet" on every start.
        <AppSplash />
      ) : (
        children
      )}
    </TenantContext.Provider>
  )
}

function MigrationOverlay({ progress }: { progress: MigrationProgress | null }) {
  const { t } = useTranslation()
  return (
    <div className="fixed inset-0 z-50">
      <AppSplash
        label={t('common.syncingLocal', { defaultValue: 'Syncing local data to the cloud…' })}
        detail={progress && progress.total > 0 ? `${progress.phase} ${progress.table} ${progress.done}/${progress.total}` : undefined}
      />
    </div>
  )
}

export function useTenant(): TenantContextValue {
  return useContext(TenantContext)
}
