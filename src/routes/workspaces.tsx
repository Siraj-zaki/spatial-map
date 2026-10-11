/**
 * /workspaces — every workspace the user belongs to.
 *
 * One card per workspace: its colour tile + initial (the same mark the
 * sidebar switcher uses), name, Active marker and role, with Open (or Switch) as the primary action and a ⋯ menu
 * for Rename & colour (owner/admin), Leave, and Delete (owner).
 *
 * Actions that aren't possible stay in the menu, disabled, with the
 * reason underneath — owners can't leave (they delete), and nobody can
 * leave or delete their only workspace. Leave confirms; Delete confirms
 * with a typed name (it removes every facility and record inside).
 * Outcomes report through toasts.
 *
 * The switcher and this page are the two entry points into workspace
 * mutations: the switcher is the fast path for "just change context".
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Check, CircleAlert, Loader2, LogOut, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ColorPicker } from '@/components/ui/color-picker'
import { PageContainer, PageHero, rise } from '@/components/page-shell'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { useAuthStore, type AuthTenant } from '@/lib/auth-store'
import { getCurrentTenantIdSync, setCurrentTenantId, subscribeTenantChanges } from '@/lib/tenant-store'
import { deleteWorkspace, leaveWorkspace, refreshWorkspaces, updateWorkspace } from '@/lib/workspace-client'
import { WorkspaceCreateDialog } from '@/components/workspace-create-dialog'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'

function useActiveTenantId(): number | null {
  return useSyncExternalStore(subscribeTenantChanges, () => getCurrentTenantIdSync(), () => null)
}

export default function WorkspacesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const tenants = useAuthStore((s) => s.tenants)
  const activeId = useActiveTenantId()

  const [createOpen, setCreateOpen] = useState(false)
  const [edit, setEdit] = useState<AuthTenant | null>(null)
  const [leaveTarget, setLeaveTarget] = useState<AuthTenant | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AuthTenant | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [switching, setSwitching] = useState<number | null>(null)

  // Re-fetch on mount so a tab that hasn't seen /auth/me in a while gets
  // the current list (e.g. a workspace created or renamed elsewhere).
  useEffect(() => {
    void refreshWorkspaces().catch(() => {
      // Non-fatal — the store already has the cached list from login.
    })
  }, [])

  // Active first, then by name.
  const sorted = useMemo(
    () => [...tenants].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId) || a.name.localeCompare(b.name)),
    [tenants, activeId],
  )
  const onlyOne = tenants.length <= 1

  const open = async (tenant: AuthTenant) => {
    if (tenant.id === activeId) {
      navigate('/dashboard')
      return
    }
    setSwitching(tenant.id)
    try {
      await setCurrentTenantId(tenant.id)
      toast.success(t('workspace.switched', { defaultValue: 'Switched to {{name}}', name: tenant.name }))
      navigate('/dashboard')
    } finally {
      setSwitching(null)
    }
  }

  const doLeave = async () => {
    if (!leaveTarget) return
    setBusy(true)
    setActionError(null)
    try {
      await leaveWorkspace(leaveTarget.id)
      toast.success(t('workspace.left', { defaultValue: 'You left {{name}}', name: leaveTarget.name }))
      const wasActive = leaveTarget.id === activeId
      setLeaveTarget(null)
      if (wasActive) navigate('/dashboard')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('workspace.leaveFailed', { defaultValue: 'Could not leave workspace.' }))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    setActionError(null)
    try {
      await deleteWorkspace(deleteTarget.id)
      toast.success(t('workspace.deleted', { defaultValue: '{{name}} deleted', name: deleteTarget.name }))
      setDeleteTarget(null)
      // If it was active the client already switched to another one; land
      // on /dashboard so no stale warehouse-scoped URL renders.
      navigate('/dashboard')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('workspace.deleteFailed', { defaultValue: 'Could not delete workspace.' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer className="gap-6">
      <div {...rise(0)}>
        <PageHero
          title={t('workspace.pageTitle', { defaultValue: 'Workspaces' })}
          description={t('workspace.pageSubtitle', { defaultValue: 'Every workspace you belong to. Switch, rename, or start a fresh one.' })}
          actions={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              {t('workspace.newWorkspace', { defaultValue: 'New workspace' })}
            </Button>
          }
        />
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          icon={Plus}
          title={t('workspace.emptyTitle', { defaultValue: 'No workspaces yet' })}
          description={t('workspace.empty', { defaultValue: 'No workspaces yet — create one to get started.' })}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              {t('workspace.newWorkspace', { defaultValue: 'New workspace' })}
            </Button>
          }
        />
      ) : (
        <div {...rise(1, 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3')}>
          {sorted.map((tenant) => (
            <WorkspaceCard
              key={tenant.id}
              tenant={tenant}
              active={tenant.id === activeId}
              onlyOne={onlyOne}
              switching={switching === tenant.id}
              onOpen={() => void open(tenant)}
              onEdit={() => setEdit(tenant)}
              onLeave={() => {
                setActionError(null)
                setLeaveTarget(tenant)
              }}
              onDelete={() => {
                setActionError(null)
                setTyped('')
                setDeleteTarget(tenant)
              }}
            />
          ))}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="flex min-h-[168px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
              <Plus className="h-4 w-4" aria-hidden />
            </span>
            {t('workspace.newWorkspace', { defaultValue: 'New workspace' })}
            <span className="max-w-[16rem] text-center text-xs">
              {t('workspace.newHint', { defaultValue: 'Starts empty — a separate set of facilities, data and members.' })}
            </span>
          </button>
        </div>
      )}

      <WorkspaceCreateDialog open={createOpen} onOpenChange={setCreateOpen} />

      {edit && <EditDialog tenant={edit} onClose={() => setEdit(null)} />}

      <ConfirmDialog
        open={leaveTarget !== null}
        onOpenChange={(o) => !o && setLeaveTarget(null)}
        title={t('workspace.leaveTitle', { defaultValue: 'Leave {{name}}?', name: leaveTarget?.name ?? '' })}
        description={t('workspace.leaveBody', {
          defaultValue: 'You’ll lose access straight away. Someone in the workspace can invite you back.',
        })}
        confirmLabel={t('workspace.leave', { defaultValue: 'Leave workspace' })}
        onConfirm={() => void doLeave()}
        busy={busy}
        error={actionError}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t('workspace.deleteTitleNamed', { defaultValue: 'Delete {{name}}?', name: deleteTarget?.name ?? '' })}
        description={t('workspace.deleteWarning', {
          defaultValue: 'This will permanently delete “{{name}}” and every facility, integration, file, and data record inside it. This cannot be undone.',
          name: deleteTarget?.name ?? '',
        })}
        confirmLabel={t('workspace.deleteConfirmButton', { defaultValue: 'Delete workspace' })}
        onConfirm={() => void doDelete()}
        busy={busy}
        confirmDisabled={typed.trim() !== deleteTarget?.name}
        error={actionError}
      >
        <div className="space-y-1.5">
          <Label htmlFor="delete-confirm">
            {t('workspace.deleteConfirmLabel', { defaultValue: 'Type “{{name}}” to confirm.', name: deleteTarget?.name ?? '' })}
          </Label>
          <Input
            id="delete-confirm"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={deleteTarget?.name}
            disabled={busy}
          />
        </div>
      </ConfirmDialog>
    </PageContainer>
  )
}

function WorkspaceCard({
  tenant,
  active,
  onlyOne,
  switching,
  onOpen,
  onEdit,
  onLeave,
  onDelete,
}: {
  tenant: AuthTenant
  active: boolean
  onlyOne: boolean
  switching: boolean
  onOpen: () => void
  onEdit: () => void
  onLeave: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const isOwner = tenant.role === 'owner'
  const canEdit = isOwner || tenant.role === 'admin'

  const leaveReason = isOwner
    ? t('workspace.ownerCantLeave', { defaultValue: 'Owners can’t leave — delete the workspace instead.' })
    : onlyOne
      ? t('workspace.onlyWorkspaceLeave', { defaultValue: 'You can’t leave your only workspace.' })
      : null
  const deleteReason = onlyOne ? t('workspace.onlyWorkspaceDelete', { defaultValue: 'You can’t delete your only workspace.' }) : null

  return (
    <article
      className={cn(
        'sgv-lift flex min-h-[168px] flex-col rounded-xl border bg-card p-5',
        active && 'border-primary/40 ring-1 ring-primary/30',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-base font-semibold text-white shadow-sm"
          style={{ background: tenant.color || 'hsl(var(--muted-foreground))' }}
          aria-hidden
        >
          {tenant.name.trim().charAt(0).toUpperCase() || '?'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold" title={tenant.name}>{tenant.name}</h2>
            {active && (
              <Badge variant="secondary" className="shrink-0 gap-1">
                <Check className="h-3 w-3" aria-hidden />
                {t('workspace.activeBadge', { defaultValue: 'Active' })}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t(`members.role.${tenant.role}`, { defaultValue: tenant.role })}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="-me-2 -mt-1 h-8 w-8 shrink-0 text-muted-foreground" aria-label={t('workspace.actionsFor', { defaultValue: 'Actions for {{name}}', name: tenant.name })}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onSelect={onEdit} disabled={!canEdit}>
              <Pencil className="me-2 h-4 w-4" />
              {t('workspace.renameAndColour', { defaultValue: 'Rename & colour' })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onLeave} disabled={!!leaveReason} className="flex-col items-start">
              <span className="flex items-center">
                <LogOut className="me-2 h-4 w-4" />
                {t('workspace.leave', { defaultValue: 'Leave workspace' })}
              </span>
              {leaveReason && <span className="ms-6 text-xs text-muted-foreground">{leaveReason}</span>}
            </DropdownMenuItem>
            {isOwner && (
              <DropdownMenuItem
                onSelect={onDelete}
                disabled={!!deleteReason}
                className="flex-col items-start text-danger focus:bg-danger/10 focus:text-danger"
              >
                <span className="flex items-center">
                  <Trash2 className="me-2 h-4 w-4" />
                  {t('workspace.delete', { defaultValue: 'Delete workspace' })}
                </span>
                {deleteReason && <span className="ms-6 text-xs text-muted-foreground">{deleteReason}</span>}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-auto pt-4">
        <Button variant="outline" className="w-full" onClick={onOpen} disabled={switching}>
          {switching && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
          {active ? t('workspace.openDashboard', { defaultValue: 'Open dashboard' }) : t('workspace.switchTo', { defaultValue: 'Switch to' })}
          {!switching && <ArrowRight className="h-4 w-4 rtl:rotate-180" />}
        </Button>
      </div>
    </article>
  )
}

function EditDialog({ tenant, onClose }: { tenant: AuthTenant; onClose: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(tenant.name)
  const [color, setColor] = useState(tenant.color)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!name.trim()) {
      setError(t('workspace.nameRequired', { defaultValue: 'A name is required.' }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await updateWorkspace(tenant.id, { name: name.trim(), color })
      toast.success(t('workspace.updated', { defaultValue: '{{name}} updated', name: name.trim() }))
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('workspace.updateFailed', { defaultValue: 'Could not update workspace.' }))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="p-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('workspace.editTitle', { defaultValue: 'Edit workspace' })}</DialogTitle>
          <DialogDescription>{t('workspace.editDescription', { defaultValue: 'Update the name or colour. This does not affect any data inside.' })}</DialogDescription>
        </DialogHeader>
        <form
          id="edit-workspace"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-semibold text-white shadow-sm transition-colors"
              style={{ background: color || 'hsl(var(--muted-foreground))' }}
              aria-hidden
            >
              {name.trim().charAt(0).toUpperCase() || '?'}
            </span>
            <span className="truncate text-sm font-medium">{name.trim() || t('workspace.namePlaceholder', { defaultValue: 'Acme Corp' })}</span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-name">{t('workspace.nameLabel', { defaultValue: 'Name' })}</Label>
            <Input id="edit-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={busy} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('workspace.colorLabel', { defaultValue: 'Colour' })}</Label>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}
        </form>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type="submit" form="edit-workspace" disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
            {t('common.save', { defaultValue: 'Save' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
