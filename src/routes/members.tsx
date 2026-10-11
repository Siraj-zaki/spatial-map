/**
 * /members — who has access to the current workspace, and at what role.
 *
 * Layout: page header with "Invite people"; the roster (search + role
 * filter, both URL-synced as `?q=` / `?role=`) beside a "What roles can
 * do" card, so the choice an admin is making is explained where it's
 * made.
 *
 * Behaviour (owner/admin): invite from a dialog with role cards
 * (invitees need an existing account — a 404 becomes a plain-language
 * hint, and an existing member is caught before the request); change a
 * role inline, optimistically, with Undo in the toast; remove through a
 * ConfirmDialog. The owner's row and your own row are never editable.
 * Everyone else sees the roster read-only with the controls explained.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, Loader2, Search, Trash2, UserPlus, Users, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageContainer, PageHero, rise } from '@/components/page-shell'
import { EmptyState } from '@/components/empty-state'
import { FilterTabs } from '@/components/filter-tabs'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { QueryError } from '@/components/feedback/query-error'
import { RoleGate } from '@/components/feedback/role-gate'
import { useUrlState } from '@/hooks/useUrlState'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { ApiError } from '@/lib/api-client'
import { inviteMember, listMembers, removeMember, updateMemberRole, type MemberRow } from '@/lib/auth-client'
import { useAuthStore, type AuthRole } from '@/lib/auth-store'
import { getCurrentTenantIdSync } from '@/lib/tenant-store'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'

// "owner" is never assignable — there is exactly one, created at signup.
const ASSIGNABLE_ROLES: AuthRole[] = ['admin', 'editor', 'viewer']
const ROLE_ORDER: Record<AuthRole, number> = { owner: 0, admin: 1, editor: 2, viewer: 3 }

const ROLE_DESCRIPTIONS: Record<AuthRole, string> = {
  owner: 'Everything, including deleting the workspace.',
  admin: 'Manage members, integrations and files, plus everything editors can do.',
  editor: 'Create and edit facilities, tables and reports.',
  viewer: 'See facilities, data and reports. Can’t change anything.',
}

type RoleFilter = 'all' | AuthRole

export default function MembersPage() {
  const { t } = useTranslation()
  const currentUser = useAuthStore((s) => s.user)
  const tenants = useAuthStore((s) => s.tenants)
  const tenantId = getCurrentTenantIdSync()
  const workspace = tenants.find((x) => x.id === tenantId)
  const { canManage } = useWorkspaceRole()

  const [reloadToken, setReloadToken] = useState(0)
  const [result, setResult] = useState<{ key: string; members: MemberRow[]; error: unknown } | null>(null)
  const queryKey = `${tenantId}:${reloadToken}`

  useEffect(() => {
    let cancelled = false
    listMembers()
      .then((members) => {
        if (!cancelled) setResult({ key: queryKey, members, error: null })
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ key: queryKey, members: [], error })
      })
    return () => {
      cancelled = true
    }
  }, [queryKey])

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])
  const loading = result?.key !== queryKey && !result?.members.length
  const members = useMemo(() => result?.members ?? [], [result])
  const setMembers = (fn: (m: MemberRow[]) => MemberRow[]) =>
    setResult((r) => (r ? { ...r, members: fn(r.members) } : r))

  const [q, setQ] = useUrlState<string>('q', '')
  const [roleParam, setRoleParam] = useUrlState<string>('role', 'all')
  const roleFilter: RoleFilter = roleParam === 'all' || roleParam in ROLE_ORDER ? (roleParam as RoleFilter) : 'all'

  const counts = useMemo(() => {
    const c: Record<AuthRole, number> = { owner: 0, admin: 0, editor: 0, viewer: 0 }
    for (const m of members) c[m.role] = (c[m.role] ?? 0) + 1
    return c
  }, [members])

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return members
      .filter((m) => (roleFilter === 'all' || m.role === roleFilter) && (!needle || m.email.toLowerCase().includes(needle)))
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.email.localeCompare(b.email))
  }, [members, q, roleFilter])

  const [inviteOpen, setInviteOpen] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<MemberRow | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const roleName = (role: AuthRole) => t(`members.role.${role}`, { defaultValue: role })

  const changeRole = async (m: MemberRow, role: AuthRole, undo = false) => {
    const previous = m.role
    if (previous === role) return
    setMembers((list) => list.map((x) => (x.userId === m.userId ? { ...x, role } : x)))
    try {
      await updateMemberRole(m.userId, role)
      if (!undo) {
        toast.success(t('members.roleChanged', { defaultValue: '{{email}} is now {{role}}', email: m.email, role: roleName(role) }), {
          action: { label: t('common.undo', { defaultValue: 'Undo' }), onClick: () => void changeRole({ ...m, role }, previous, true) },
        })
      }
    } catch (err) {
      setMembers((list) => list.map((x) => (x.userId === m.userId ? { ...x, role: previous } : x)))
      toast.error(t('members.updateFailed', { defaultValue: 'Could not update role.' }), { description: (err as Error).message })
    }
  }

  const confirmRemove = async () => {
    if (!pendingRemove || removing) return
    setRemoving(true)
    setRemoveError(null)
    try {
      await removeMember(pendingRemove.userId)
      setMembers((list) => list.filter((x) => x.userId !== pendingRemove.userId))
      toast.success(t('members.removed', { defaultValue: '{{email}} removed', email: pendingRemove.email }))
      setPendingRemove(null)
    } catch (err) {
      setRemoveError((err as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  const inviteButton = (
    <RoleGate allowed={canManage} message={t('common.needsAdmin', { defaultValue: 'Only workspace owners and admins can do this.' })}>
      <Button onClick={() => setInviteOpen(true)} disabled={!canManage}>
        <UserPlus className="h-4 w-4" />
        {t('members.invitePeople', { defaultValue: 'Invite people' })}
      </Button>
    </RoleGate>
  )

  const filterItems = [
    { value: 'all' as RoleFilter, label: t('members.filterAll', { defaultValue: 'All' }), count: members.length },
    ...(['owner', 'admin', 'editor', 'viewer'] as AuthRole[])
      .filter((r) => counts[r] > 0)
      .map((r) => ({ value: r as RoleFilter, label: roleName(r), count: counts[r] })),
  ]

  return (
    <PageContainer className="gap-6">
      <div {...rise(0)}>
        <PageHero
          title={t('members.title', { defaultValue: 'Members' })}
          description={
            workspace
              ? t('members.subtitle', { defaultValue: 'People with access to {{workspace}}.', workspace: workspace.name })
              : t('members.subtitleFallback', { defaultValue: 'People with access to this workspace.' })
          }
          actions={inviteButton}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <section {...rise(1, 'overflow-hidden rounded-xl border bg-card')}>
          <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center">
            <div className="relative flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('members.searchPlaceholder', { defaultValue: 'Search by email' })}
                aria-label={t('members.searchPlaceholder', { defaultValue: 'Search by email' })}
                className="ps-9"
              />
              {q && (
                <button
                  type="button"
                  onClick={() => setQ('')}
                  className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                  aria-label={t('common.clear', { defaultValue: 'Clear' })}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {members.length > 0 && (
              <FilterTabs
                ariaLabel={t('members.filterLabel', { defaultValue: 'Filter by role' })}
                value={roleFilter}
                onChange={(v) => setRoleParam(v)}
                items={filterItems}
              />
            )}
          </div>

          {loading ? (
            <ul className="divide-y" aria-busy>
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-3.5">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <Skeleton className="h-4 w-56 max-w-[50%]" />
                  <Skeleton className="ms-auto h-8 w-28" />
                </li>
              ))}
            </ul>
          ) : result?.error ? (
            <QueryError compact error={result.error} onRetry={reload} what={t('members.what', { defaultValue: 'the member list' })} />
          ) : visible.length === 0 ? (
            <EmptyState
              compact
              icon={Search}
              title={t('members.noMatch', { defaultValue: 'No members match' })}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQ('')
                    setRoleParam('all')
                  }}
                >
                  {t('tables.clearFilters', { defaultValue: 'Clear filters' })}
                </Button>
              }
            />
          ) : (
            <ul className="divide-y">
              {visible.map((m) => {
                const isSelf = m.userId === currentUser?.id
                const editable = canManage && m.role !== 'owner' && !isSelf
                return (
                  <li key={m.userId} className="flex items-center gap-3 px-4 py-3">
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground"
                      aria-hidden
                    >
                      {m.email.charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate text-sm font-medium">
                        <span className="truncate" dir="ltr">{m.email}</span>
                        {isSelf && <Badge variant="muted">{t('members.you', { defaultValue: 'You' })}</Badge>}
                      </p>
                      <p className="mt-0.5 hidden truncate text-xs text-muted-foreground sm:block">
                        {t(`members.roleDesc.${m.role}`, { defaultValue: ROLE_DESCRIPTIONS[m.role] })}
                      </p>
                    </div>
                    {editable ? (
                      <>
                        <select
                          value={m.role}
                          onChange={(e) => void changeRole(m, e.target.value as AuthRole)}
                          aria-label={t('members.roleFor', { defaultValue: 'Role for {{email}}', email: m.email })}
                          className="h-9 rounded-md border border-input bg-background px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          {ASSIGNABLE_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {roleName(r)}
                            </option>
                          ))}
                        </select>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-muted-foreground hover:bg-danger/10 hover:text-danger"
                          onClick={() => {
                            setRemoveError(null)
                            setPendingRemove(m)
                          }}
                          aria-label={t('members.removeNamed', { defaultValue: 'Remove {{email}}', email: m.email })}
                          title={t('members.remove', { defaultValue: 'Remove member' })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <Badge variant={m.role === 'owner' ? 'secondary' : 'outline'} className="font-normal">
                        {roleName(m.role)}
                      </Badge>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {!loading && !result?.error && canManage && members.length === 1 && (
            <div className="flex flex-col items-start gap-3 border-t bg-muted/30 px-4 py-4 sm:flex-row sm:items-center">
              <Users className="hidden h-5 w-5 shrink-0 text-muted-foreground sm:block" aria-hidden />
              <p className="flex-1 text-sm text-muted-foreground">
                {t('members.justYou', { defaultValue: 'It’s just you so far. Invite the people who manage your facilities.' })}
              </p>
              <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)}>
                <UserPlus className="h-4 w-4" />
                {t('members.invitePeople', { defaultValue: 'Invite people' })}
              </Button>
            </div>
          )}
        </section>

        <aside {...rise(2, 'rounded-xl border bg-card p-5')}>
          <h2 className="text-sm font-semibold">{t('members.rolesTitle', { defaultValue: 'What roles can do' })}</h2>
          <dl className="mt-3 space-y-3">
            {(['owner', 'admin', 'editor', 'viewer'] as AuthRole[]).map((r) => (
              <div key={r}>
                <dt className="text-sm font-medium">{roleName(r)}</dt>
                <dd className="mt-0.5 text-sm text-muted-foreground">
                  {t(`members.roleDesc.${r}`, { defaultValue: ROLE_DESCRIPTIONS[r] })}
                </dd>
              </div>
            ))}
          </dl>
          {!canManage && (
            <p className="mt-4 border-t pt-4 text-xs text-muted-foreground">
              {t('members.readOnly', { defaultValue: 'Only owners and admins can invite people or change roles.' })}
            </p>
          )}
        </aside>
      </div>

      {inviteOpen && (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          members={members}
          workspaceName={workspace?.name}
          onInvited={(row) => {
            setMembers((list) => [...list.filter((x) => x.userId !== row.userId), row])
            reload()
          }}
        />
      )}

      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPendingRemove(null)
            setRemoveError(null)
          }
        }}
        title={t('members.removeTitle', { defaultValue: 'Remove {{email}}?', email: pendingRemove?.email ?? '' })}
        description={t('members.removeBody', {
          defaultValue: 'They lose access to {{workspace}} straight away. Everything they created stays. You can invite them again later.',
          workspace: workspace?.name ?? '',
        })}
        confirmLabel={t('members.removeConfirm', { defaultValue: 'Remove' })}
        onConfirm={() => void confirmRemove()}
        busy={removing}
        error={removeError}
      />
    </PageContainer>
  )
}

function InviteDialog({
  open,
  onOpenChange,
  members,
  workspaceName,
  onInvited,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  members: MemberRow[]
  workspaceName?: string
  onInvited: (row: MemberRow) => void
}) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<AuthRole>('editor')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const roleName = (r: AuthRole) => t(`members.role.${r}`, { defaultValue: r })

  const submit = async () => {
    const clean = email.trim().toLowerCase()
    if (!clean) return
    const existing = members.find((m) => m.email.toLowerCase() === clean)
    if (existing) {
      setError(t('members.alreadyMember', { defaultValue: '{{email}} is already a member ({{role}}).', email: clean, role: roleName(existing.role) }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const row = await inviteMember(clean, role)
      onInvited(row.email ? row : { userId: row.userId, email: clean, role })
      toast.success(t('members.invited', { defaultValue: '{{email}} added as {{role}}', email: clean, role: roleName(role) }))
      onOpenChange(false)
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? t('members.noAccount', {
              defaultValue: 'No Spatial Map account uses {{email}}. Ask them to sign up first, then invite them here.',
              email: clean,
            })
          : (err as Error).message,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('members.inviteTitle', { defaultValue: 'Invite to {{workspace}}', workspace: workspaceName ?? '' })}</DialogTitle>
          <DialogDescription>
            {t('members.inviteHint', {
              defaultValue: 'The invitee must already have an account. They’ll see this workspace after their next sign-in.',
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          id="invite-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">{t('auth.email', { defaultValue: 'Email' })}</Label>
            <Input
              id="invite-email"
              type="email"
              autoFocus
              required
              dir="ltr"
              autoComplete="off"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setError(null)
              }}
              placeholder="teammate@example.com"
              aria-invalid={!!error}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium">{t('members.roleLabel', { defaultValue: 'Role' })}</legend>
            {ASSIGNABLE_ROLES.map((r) => (
              <label
                key={r}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                  role === r ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent/50',
                )}
              >
                <input
                  type="radio"
                  name="invite-role"
                  value={r}
                  checked={role === r}
                  onChange={() => setRole(r)}
                  className="mt-1 accent-[hsl(var(--primary))]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{roleName(r)}</span>
                  <span className="block text-sm text-muted-foreground">
                    {t(`members.roleDesc.${r}`, { defaultValue: ROLE_DESCRIPTIONS[r] })}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 break-words">{error}</span>
            </div>
          )}
        </form>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type="submit" form="invite-form" disabled={busy || !email.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <UserPlus className="h-4 w-4" />}
            {t('members.sendInvite', { defaultValue: 'Add to workspace' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
