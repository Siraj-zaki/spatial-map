/**
 * Global workspace switcher at the top of the app sidebar. Renders as a
 * full-width row (colour tile + name + plan) — or just the tile when the
 * sidebar is collapsed — that opens a dropdown listing every workspace the
 * user is a member of, plus "Create" and "Manage" entries.
 *
 * Clicking a workspace calls setCurrentTenantId, which triggers the
 * reload cascade wired up in workspace-switch.ts. The switcher does NOT
 * duplicate that cascade — it just changes the current id and lets the
 * subscription do the work.
 *
 * Hidden entirely when the user is signed out (nothing to switch to) or
 * has only one workspace and no other actions to offer. The "Create new"
 * flow always renders even for solo-workspace users, so the switcher is
 * visible whenever the user has any authenticated session.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronsUpDown, Plus, Settings2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuthStore, type AuthTenant } from '@/lib/auth-store'
import { getCurrentTenantIdSync, setCurrentTenantId, subscribeTenantChanges } from '@/lib/tenant-store'
import { useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { WorkspaceCreateDialog } from '@/components/workspace-create-dialog'

function useActiveTenantId(): number | null {
  return useSyncExternalStore(
    subscribeTenantChanges,
    () => getCurrentTenantIdSync(),
    () => null,
  )
}

function roleBadgeClass(role: AuthTenant['role']): string {
  // Owner/admin get a subtle primary hint; editor/viewer stay muted.
  // Keeping it low-contrast so it doesn't shout in the dropdown list.
  switch (role) {
    case 'owner':
      return 'text-primary'
    case 'admin':
      return 'text-primary/80'
    default:
      return 'text-muted-foreground'
  }
}

export function WorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const tenants = useAuthStore((s) => s.tenants)
  const activeId = useActiveTenantId()
  const [open, setOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const active = useMemo(
    () => tenants.find((t) => t.id === activeId) ?? tenants[0] ?? null,
    [tenants, activeId],
  )

  // Hide entirely for unauthenticated users. The header nav also drops
  // the switcher on the login/signup screens because AuthGuard doesn't
  // mount the app shell there.
  if (tenants.length === 0) return null

  const handlePick = async (id: number) => {
    if (id === activeId) {
      setOpen(false)
      return
    }
    await setCurrentTenantId(id)
    // Reload cascade fires via subscribeTenantChanges in workspace-switch.ts.
    // Land on /dashboard so warehouse-scoped URLs (e.g. /create-grids?warehouseId=…)
    // from the previous workspace don't render stale ids for a frame.
    navigate('/dashboard')
    setOpen(false)
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg text-start transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent',
              collapsed ? 'h-9 w-9 justify-center' : 'h-11 px-2',
            )}
            aria-label={t('workspace.switcherLabel')}
            title={collapsed ? active?.name : undefined}
          >
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white shadow-sm"
              style={{ background: active?.color ?? '#3b82f6' }}
              aria-hidden
            >
              {(active?.name ?? '?').charAt(0).toUpperCase()}
            </span>
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold leading-tight">
                    {active?.name ?? t('workspace.pickWorkspace')}
                  </span>
                  {active && (
                    <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                      {t(`members.role.${active.role}`)}
                    </span>
                  )}
                </span>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side={collapsed ? 'right' : 'bottom'} className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
            {t('workspace.dropdownHeading')}
          </DropdownMenuLabel>
          <div className="max-h-64 overflow-y-auto">
            {tenants.map((tenant) => {
              const isActive = tenant.id === activeId
              return (
                <DropdownMenuItem
                  key={tenant.id}
                  onSelect={(e) => {
                    e.preventDefault()
                    void handlePick(tenant.id)
                  }}
                  className={cn(
                    'cursor-pointer gap-2 py-2',
                    isActive && 'bg-muted/60',
                  )}
                >
                  <span
                    className="inline-block h-3 w-3 flex-shrink-0 rounded-full border border-border/60"
                    style={{ background: tenant.color }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{tenant.name}</p>
                    <p className={cn('text-xs', roleBadgeClass(tenant.role))}>
                      {t(`members.role.${tenant.role}`)}
                    </p>
                  </div>
                  {isActive && (
                    <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                  )}
                </DropdownMenuItem>
              )
            })}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              setOpen(false)
              setCreateOpen(true)
            }}
            className="cursor-pointer"
          >
            <Plus className="me-2 h-4 w-4" />
            {t('workspace.create')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setOpen(false)
              navigate('/workspaces')
            }}
            className="cursor-pointer"
          >
            <Settings2 className="me-2 h-4 w-4" />
            {t('workspace.manage')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <WorkspaceCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  )
}
