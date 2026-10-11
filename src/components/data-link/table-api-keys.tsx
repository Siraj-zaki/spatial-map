/**
 * API keys for one table: list, create, revoke.
 *
 * A key authenticates writes to exactly one table on the public row API.
 * The plaintext is returned once, on create — `MintedKeyCard` shows it
 * with a copy button and a "you won't see this again" warning, and stays
 * until dismissed. The list updates locally on create/revoke (the parent's
 * `tokens` prop may be stale until it refetches); `onChanged` lets the
 * parent refetch counts it shows elsewhere.
 *
 * Create/revoke are owner/admin actions — other roles see the list with
 * the controls disabled and a tooltip saying why.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, CircleAlert, Copy, KeyRound, Loader2, Plus, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { RoleGate } from '@/components/feedback/role-gate'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { toast } from '@/lib/toast-store'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { createTableToken, revokeTableToken, type TableTokenResponse } from '@/lib/tables-client'

function byStatusThenNewest(a: TableTokenResponse, b: TableTokenResponse): number {
  if (!!a.revokedAt !== !!b.revokedAt) return a.revokedAt ? 1 : -1
  return Date.parse(b.createdAt) - Date.parse(a.createdAt)
}

export function TableTokensPanel({
  tableId,
  tokens,
  onChanged,
}: {
  tableId: number
  tokens: TableTokenResponse[]
  onChanged?: () => void
}) {
  const { t, i18n } = useTranslation()
  const { canManage } = useWorkspaceRole()
  const manageOnly = t('common.needsAdmin', { defaultValue: 'Only workspace owners and admins can do this.' })

  // Local copy so create/revoke show at once; re-seeded when the parent
  // hands over a fresh list.
  const [seed, setSeed] = useState(tokens)
  const [list, setList] = useState(tokens)
  if (tokens !== seed) {
    setSeed(tokens)
    setList(tokens)
  }

  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [minted, setMinted] = useState<{ id: number; token: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [revokeTarget, setRevokeTarget] = useState<TableTokenResponse | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const create = async () => {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const resp = await createTableToken(tableId, label.trim() || 'default')
      setList((l) => [{ ...resp, token: undefined }, ...l])
      if (resp.token) setMinted({ id: resp.id, token: resp.token })
      setLabel('')
      onChanged?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const revoke = async () => {
    if (!revokeTarget || revoking) return
    setRevoking(true)
    setRevokeError(null)
    try {
      await revokeTableToken(tableId, revokeTarget.id)
      const now = new Date().toISOString()
      setList((l) => l.map((tk) => (tk.id === revokeTarget.id ? { ...tk, revokedAt: now } : tk)))
      // A revoked key's one-time reveal is no longer worth copying.
      if (minted?.id === revokeTarget.id) setMinted(null)
      toast.success(t('tables.keys.revoked', { defaultValue: 'Key “{{label}}” revoked', label: revokeTarget.label }))
      setRevokeTarget(null)
      onChanged?.()
    } catch (err) {
      setRevokeError((err as Error).message)
    } finally {
      setRevoking(false)
    }
  }

  const sorted = [...list].sort(byStatusThenNewest)

  return (
    <div className="space-y-4">
      {minted && <MintedKeyCard token={minted.token} onDone={() => setMinted(null)} />}

      {sorted.length === 0 ? (
        <EmptyState
          compact
          icon={KeyRound}
          className="rounded-lg border border-dashed"
          title={t('tables.keys.emptyTitle', { defaultValue: 'No API keys yet' })}
          description={t('tables.keys.emptyBody', { defaultValue: 'Create a key so your own systems can write rows to this table.' })}
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {sorted.map((tk) => {
            const revoked = !!tk.revokedAt
            return (
              <li key={tk.id} className={cn('flex items-center gap-3 px-4 py-3', revoked && 'bg-muted/30')}>
                <span
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                    revoked ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
                  )}
                >
                  <KeyRound className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cn('truncate text-sm font-medium', revoked && 'text-muted-foreground line-through')}>{tk.label}</span>
                    <Badge variant={revoked ? 'muted' : 'success'}>
                      {revoked ? t('tables.keys.statusRevoked', { defaultValue: 'Revoked' }) : t('tables.keys.statusActive', { defaultValue: 'Active' })}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    <span title={fullTime(tk.createdAt, i18n.language)}>
                      {t('tables.keys.created', { defaultValue: 'Created {{when}}', when: relativeTime(tk.createdAt, i18n.language) })}
                    </span>
                    {' · '}
                    {revoked ? (
                      <span title={fullTime(tk.revokedAt, i18n.language)}>
                        {t('tables.keys.revokedAgo', { defaultValue: 'revoked {{when}}', when: relativeTime(tk.revokedAt, i18n.language) })}
                      </span>
                    ) : tk.lastUsedAt ? (
                      <span title={fullTime(tk.lastUsedAt, i18n.language)}>
                        {t('tables.keys.lastUsed', { defaultValue: 'last used {{when}}', when: relativeTime(tk.lastUsedAt, i18n.language) })}
                      </span>
                    ) : (
                      t('tables.keys.neverUsed', { defaultValue: 'never used' })
                    )}
                  </p>
                </div>
                {!revoked && (
                  <RoleGate allowed={canManage} message={manageOnly}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:bg-danger/10 hover:text-danger"
                      onClick={() => {
                        setRevokeError(null)
                        setRevokeTarget(tk)
                      }}
                      disabled={!canManage}
                    >
                      {t('tables.keys.revoke', { defaultValue: 'Revoke' })}
                    </Button>
                  </RoleGate>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('tables.keys.labelPlaceholder', { defaultValue: 'Key name, e.g. warehouse-scanner' })}
          aria-label={t('tables.keys.labelAria', { defaultValue: 'New key name' })}
          disabled={!canManage || creating}
          className="sm:max-w-xs"
          maxLength={80}
        />
        <RoleGate allowed={canManage} message={manageOnly}>
          <Button type="submit" variant="outline" disabled={!canManage || creating}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Plus className="h-4 w-4" />}
            {t('tables.keys.create', { defaultValue: 'Create key' })}
          </Button>
        </RoleGate>
      </form>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">{error}</span>
        </div>
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(o) => !o && setRevokeTarget(null)}
        title={t('tables.keys.revokeTitle', { defaultValue: 'Revoke “{{label}}”?', label: revokeTarget?.label ?? '' })}
        description={t('integrations.revokeToken', {
          defaultValue: 'Rows already written stay; new writes from this token will be rejected.',
        })}
        confirmLabel={t('tables.keys.revokeConfirm', { defaultValue: 'Revoke key' })}
        onConfirm={() => void revoke()}
        busy={revoking}
        error={revokeError}
      />
    </div>
  )
}

/** The one-time reveal of a freshly created key. */
export function MintedKeyCard({ token, onDone }: { token: string; onDone: () => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the key is still selectable */
    }
  }
  return (
    <div className="sgv-rise space-y-3 rounded-lg border border-success/30 bg-success/5 p-4" role="status">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('tables.keys.mintedTitle', { defaultValue: 'Your new API key' })}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
            {t('tables.keys.mintedBody', { defaultValue: 'Copy it now and store it somewhere safe — it won’t be shown again.' })}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 select-all truncate rounded-md border bg-background px-3 py-2 font-mono text-xs"
          dir="ltr"
        >
          {token}
        </code>
        <Button variant={copied ? 'outline' : 'default'} size="sm" onClick={() => void copy()}>
          {copied ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          {copied ? t('common.copied', { defaultValue: 'Copied' }) : t('common.copy', { defaultValue: 'Copy' })}
        </Button>
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t('tables.keys.mintedDone', { defaultValue: 'I’ve saved it' })}
        </Button>
      </div>
    </div>
  )
}
