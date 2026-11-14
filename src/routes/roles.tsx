/**
 * /roles — the workspace's roles (custom roles, lib/permissions.ts).
 *
 * The four built-in roles are shown read-only with what they allow; any of
 * them can be duplicated into a custom role. A custom role is a name, a
 * description and a permission checklist. Everyone can read
 * this page; changing it needs roles.manage, and nobody can tick a
 * permission they don't have themselves (the API refuses it too).
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Copy, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import { PageContainer, PageHero, rise } from '@/components/page-shell'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { ApiError } from '@/lib/api-client'
import { createRole, deleteRole, listRoles, PERMISSION_GROUPS, updateRole, type Permission, type RoleView } from '@/lib/permissions'
import { getCurrentTenantIdSync } from '@/lib/tenant-store'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'

type Draft = { id?: number; name: string; description: string; permissions: Permission[] }

function errorKey(err: unknown): string {
  switch (err instanceof ApiError ? err.code : undefined) {
    case 'role_name_taken':
      return 'roles.errors.nameTaken'
    case 'role_in_use':
      return 'roles.errors.inUse'
    case 'role_escalates':
      return 'roles.errors.escalates'
  }
  return 'roles.errors.generic'
}

export default function RolesPage() {
  const { t } = useTranslation()
  const { can, permissions } = useWorkspaceRole()
  const canManageRoles = can('roles.manage')
  const tenantId = getCurrentTenantIdSync()
  const [roles, setRoles] = useState<RoleView[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RoleView | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listRoles()
      .then((r) => {
        if (cancelled) return
        setRoles(r.roles)
        setFailed(false)
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [reloadKey, tenantId])
  const reload = () => setReloadKey((k) => k + 1)

  const roleTitle = (r: RoleView) => (r.builtIn ? t(`members.role.${r.key}`, { defaultValue: r.name }) : r.name)
  const permLabel = (p: string) => {
    for (const g of PERMISSION_GROUPS) {
      const found = g.permissions.find((x) => x.key === p)
      if (found) return t(`roles.perm.${p.replace('.', '_')}`, { defaultValue: found.fallback })
    }
    return p === 'workspace.own' ? t('roles.perm.workspace_own', { defaultValue: 'Billing and deleting the workspace' }) : p
  }

  const confirmDelete = async () => {
    if (!pendingDelete?.id || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteRole(pendingDelete.id)
      toast.success(t('roles.deleted', { defaultValue: '{{name}} deleted', name: pendingDelete.name }))
      setPendingDelete(null)
      reload()
    } catch (err) {
      setDeleteError(t(errorKey(err)))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <PageContainer className="gap-6">
      <div {...rise(0)}>
        <Link to="/members" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
          {t('members.title', { defaultValue: 'Members' })}
        </Link>
        <PageHero
          title={t('roles.title', { defaultValue: 'Roles' })}
          description={t('roles.subtitle', {
            defaultValue: 'What each role lets people change. Everyone in the workspace can see its facilities and data; a role adds what they may change.',
          })}
          actions={
            canManageRoles ? (
              <Button onClick={() => setDraft({ name: '', description: '', permissions: [] })}>
                <Plus className="h-4 w-4" />
                {t('roles.new', { defaultValue: 'New role' })}
              </Button>
            ) : undefined
          }
        />
      </div>

      {failed ? (
        <div className="rounded-xl border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">{t('roles.loadFailed', { defaultValue: "Couldn't load the roles." })}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={reload}>
            {t('common.retry', { defaultValue: 'Retry' })}
          </Button>
        </div>
      ) : roles === null ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl border bg-muted/40" />
          ))}
        </div>
      ) : (
        <div {...rise(1, 'grid gap-4 md:grid-cols-2')}>
          {roles.map((r) => (
            <article key={r.id ?? r.key} className="flex flex-col rounded-xl border bg-card p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>
                  <KeyRound className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate font-semibold">{roleTitle(r)}</h2>
                    {r.builtIn && <Badge variant="muted">{t('roles.builtIn', { defaultValue: 'Built-in' })}</Badge>}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {r.builtIn ? t(`members.roleDesc.${r.key}`, { defaultValue: '' }) : r.description}
                  </p>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {t('roles.memberCount', { count: r.memberCount, defaultValue: '{{count}} people' })}
                </span>
              </div>
              <ul className="mt-4 flex flex-wrap gap-1.5" aria-label={t('roles.allows', { defaultValue: 'Allows' })}>
                {r.permissions.length === 0 ? (
                  <li className="text-xs text-muted-foreground">{t('roles.viewOnly', { defaultValue: 'View only' })}</li>
                ) : (
                  r.permissions.map((p) => (
                    <li key={p}>
                      <Badge variant="outline" className="font-normal">
                        {permLabel(p)}
                      </Badge>
                    </li>
                  ))
                )}
              </ul>
              {canManageRoles && (
                <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
                  {r.key !== 'owner' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setDraft({
                          name: t('roles.copyName', { name: roleTitle(r), defaultValue: '{{name}} (copy)' }),
                          description: r.builtIn ? '' : r.description,
                          // Only what this person may grant.
                          permissions: r.permissions.filter((p) => permissions.includes(p)) as Permission[],
                        })
                      }
                    >
                      <Copy className="h-3.5 w-3.5" />
                      {t('roles.duplicate', { defaultValue: 'Duplicate' })}
                    </Button>
                  )}
                  {!r.builtIn && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setDraft({ id: r.id, name: r.name, description: r.description, permissions: r.permissions })}>
                        <Pencil className="h-3.5 w-3.5" />
                        {t('roles.edit', { defaultValue: 'Edit' })}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ms-auto text-muted-foreground hover:bg-danger/10 hover:text-danger"
                        onClick={() => {
                          setDeleteError(null)
                          setPendingDelete(r)
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t('roles.delete', { defaultValue: 'Delete' })}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {draft && (
        <RoleDialog
          draft={draft}
          held={permissions}
          onOpenChange={(o) => !o && setDraft(null)}
          onSaved={() => {
            setDraft(null)
            reload()
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPendingDelete(null)
            setDeleteError(null)
          }
        }}
        title={t('roles.deleteTitle', { name: pendingDelete?.name ?? '', defaultValue: 'Delete {{name}}?' })}
        description={t('roles.deleteBody', { defaultValue: 'Only a role nobody has can be deleted.' })}
        confirmLabel={t('roles.delete', { defaultValue: 'Delete' })}
        onConfirm={() => void confirmDelete()}
        busy={deleting}
        error={deleteError}
      />
    </PageContainer>
  )
}

function RoleDialog({ draft, held, onOpenChange, onSaved }: { draft: Draft; held: string[]; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(draft.name)
  const [description, setDescription] = useState(draft.description)
  const [perms, setPerms] = useState<Permission[]>(draft.permissions)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (p: Permission) => setPerms((list) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p]))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    if (!name.trim()) return setError(t('roles.errors.nameRequired', { defaultValue: 'Give the role a name.' }))
    setSaving(true)
    setError(null)
    try {
      const body = { name: name.trim(), description: description.trim(), permissions: perms }
      if (draft.id) await updateRole(draft.id, body)
      else await createRole(body)
      toast.success(t('roles.saved', { name: body.name, defaultValue: '{{name}} saved' }))
      onSaved()
    } catch (err) {
      setError(t(errorKey(err)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto">
        <form noValidate onSubmit={(e) => void save(e)} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{draft.id ? t('roles.editTitle', { defaultValue: 'Edit role' }) : t('roles.new', { defaultValue: 'New role' })}</DialogTitle>
            <DialogDescription>
              {t('roles.dialogBody', { defaultValue: 'Everyone can view facilities and data. Tick what this role may change.' })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="role-name">{t('roles.name', { defaultValue: 'Name' })}</Label>
            <Input id="role-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus placeholder={t('roles.namePlaceholder', { defaultValue: 'e.g. Security guard' })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-desc">{t('roles.description', { defaultValue: 'Description' })}</Label>
            <Input id="role-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('roles.descriptionPlaceholder', { defaultValue: 'One line on who gets this role' })} />
          </div>
          {PERMISSION_GROUPS.map((g) => (
            <fieldset key={g.key} className="space-y-2">
              <legend className="text-sm font-medium">{t(`roles.group.${g.key}`, { defaultValue: g.fallback })}</legend>
              {g.permissions.map((p) => {
                const allowed = held.includes(p.key)
                const checked = perms.includes(p.key)
                return (
                  <label
                    key={p.key}
                    title={allowed ? undefined : t('roles.notYours', { defaultValue: "Your own role doesn't have this, so you can't grant it." })}
                    className={cn(
                      'flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                      allowed ? 'cursor-pointer hover:bg-accent/50' : 'cursor-not-allowed opacity-60',
                      checked && 'border-primary bg-primary/5',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!allowed}
                      onChange={() => toggle(p.key)}
                      className="mt-1 accent-[hsl(var(--primary))]"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{t(`roles.perm.${p.key.replace('.', '_')}`, { defaultValue: p.fallback })}</span>
                      <span className="block text-xs text-muted-foreground">{t(`roles.hint.${p.key.replace('.', '_')}`, { defaultValue: p.hint })}</span>
                    </span>
                  </label>
                )
              })}
            </fieldset>
          ))}
          {error && <p className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t('roles.saving', { defaultValue: 'Saving…' }) : t('roles.save', { defaultValue: 'Save role' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
