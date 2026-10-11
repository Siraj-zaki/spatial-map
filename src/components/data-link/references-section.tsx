/**
 * References — typed key → key links the popup resolver uses to add
 * context (e.g. `sku-supplier`: SKU-123 → ACME Ltd).
 *
 * List first (search across type / keys / label, grouped visually by a
 * type chip); "Add reference" opens a dialog; delete confirms and toasts.
 * Owners/admins manage; others read.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, CircleAlert, Link as LinkIcon, Loader2, Plus, Search, Trash2 } from 'lucide-react'
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
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { RoleGate } from '@/components/feedback/role-gate'
import { apiDb } from '@/lib/api-db'
import { useApiQuery, queryCache } from '@/lib/useApiQuery'
import type { Reference } from '@/lib/db'
import { addReference, deleteReference, useCurrentTenantId } from '@/lib/data-link'
import { toast } from '@/lib/toast-store'

export function ReferencesSection({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const query = useApiQuery(
    async () => {
      const rows = await apiDb.references.toArray()
      return tenantId === null ? rows : rows.filter((r) => r.tenantId === undefined || r.tenantId === tenantId)
    },
    ['references', tenantId],
  )
  const references = useMemo(() => query.data ?? [], [query.data])
  const [q, setQ] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Reference | null>(null)
  const [deleting, setDeleting] = useState(false)

  const visible = useMemo(() => {
    const n = q.trim().toLowerCase()
    return references
      .filter((r) => !n || [r.type, r.sourceKey, r.targetKey, r.label].some((v) => v && v.toLowerCase().includes(n)))
      .sort((a, b) => a.type.localeCompare(b.type) || a.sourceKey.localeCompare(b.sourceKey))
  }, [references, q])

  const doDelete = async () => {
    if (pendingDelete?.id === undefined) return
    setDeleting(true)
    try {
      await deleteReference(pendingDelete.id)
      queryCache.invalidate('references')
      queryCache.invalidate('references-count')
      toast.success(t('integrations.refs.deleted', { defaultValue: 'Reference removed' }))
      setPendingDelete(null)
    } catch (err) {
      toast.error(t('integrations.refs.deleteFailed', { defaultValue: 'Couldn’t remove the reference' }), { description: (err as Error).message })
    } finally {
      setDeleting(false)
    }
  }

  const addButton = (
    <RoleGate allowed={canManage} message={t('common.needsAdmin', { defaultValue: 'Only workspace owners and admins can do this.' })}>
      <Button onClick={() => setAddOpen(true)} disabled={!canManage}>
        <Plus className="h-4 w-4" />
        {t('integrations.refs.add', { defaultValue: 'Add reference' })}
      </Button>
    </RoleGate>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('integrations.refs.intro', { defaultValue: 'Links between keys in different systems. Map popups use them to show related details — a SKU’s supplier, a tag’s pallet.' })}
        </p>
        {references.length > 0 && addButton}
      </div>

      {query.isLoading && !query.data ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : references.length === 0 ? (
        <EmptyState
          icon={LinkIcon}
          title={t('dataLink.references.emptyTitle', { defaultValue: 'No references yet' })}
          description={t('integrations.refs.emptyBody', { defaultValue: 'Example: type “sku-supplier”, SKU-123 → SUPP-ACME, labelled “ACME Ltd”.' })}
          action={addButton}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-4 py-3">
            <div className="relative max-w-xs">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('integrations.refs.search', { defaultValue: 'Search references' })} aria-label={t('integrations.refs.search', { defaultValue: 'Search references' })} className="ps-9" />
            </div>
          </div>
          {visible.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('integrations.noMatchBody', { defaultValue: 'Try another search or filter.' })}</p>
          ) : (
            <ul className="divide-y">
              {visible.map((r) => (
                <li key={r.id} className="group flex items-center gap-3 px-4 py-3">
                  <Badge variant="secondary" className="shrink-0 font-mono">{r.type}</Badge>
                  <div className="flex min-w-0 flex-1 items-center gap-2 text-sm" dir="ltr">
                    <span className="truncate font-mono text-xs">{r.sourceKey}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate font-mono text-xs">{r.targetKey}</span>
                  </div>
                  <span className="hidden max-w-[30%] truncate text-sm text-muted-foreground sm:block">{r.label ?? ''}</span>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground opacity-0 hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                      onClick={() => setPendingDelete(r)}
                      aria-label={t('integrations.refs.remove', { defaultValue: 'Remove {{key}} → {{target}}', key: r.sourceKey, target: r.targetKey })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {addOpen && <AddReferenceDialog onClose={() => setAddOpen(false)} knownTypes={[...new Set(references.map((r) => r.type))]} />}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('integrations.refs.deleteTitle', { defaultValue: 'Remove this reference?' })}
        description={pendingDelete ? `${pendingDelete.type}: ${pendingDelete.sourceKey} → ${pendingDelete.targetKey}` : undefined}
        confirmLabel={t('common.remove', { defaultValue: 'Remove' })}
        onConfirm={() => void doDelete()}
        busy={deleting}
      />
    </div>
  )
}

function AddReferenceDialog({ onClose, knownTypes }: { onClose: () => void; knownTypes: string[] }) {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const [type, setType] = useState(knownTypes[0] ?? '')
  const [sourceKey, setSourceKey] = useState('')
  const [targetKey, setTargetKey] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (another: boolean) => {
    if (!type.trim() || !sourceKey.trim() || !targetKey.trim()) {
      setError(t('integrations.refs.required', { defaultValue: 'Type, from and to are all required.' }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await addReference({
        type: type.trim(),
        sourceKey: sourceKey.trim(),
        targetKey: targetKey.trim(),
        label: label.trim() || undefined,
        tenantId: tenantId ?? undefined,
      })
      queryCache.invalidate('references')
      queryCache.invalidate('references-count')
      toast.success(t('integrations.refs.added', { defaultValue: 'Reference added' }))
      if (another) {
        setSourceKey('')
        setTargetKey('')
        setLabel('')
      } else onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('integrations.refs.add', { defaultValue: 'Add reference' })}</DialogTitle>
          <DialogDescription>{t('integrations.refs.addBody', { defaultValue: 'Say which key points to which, and what kind of link it is.' })}</DialogDescription>
        </DialogHeader>
        <form
          id="add-reference"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save(false)
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="ref-type">{t('integrations.refs.type', { defaultValue: 'Link type' })}</Label>
            <Input id="ref-type" list="ref-types" dir="ltr" value={type} onChange={(e) => setType(e.target.value)} placeholder="sku-supplier" className="font-mono" autoFocus />
            <datalist id="ref-types">
              {knownTypes.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </div>
          <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="ref-from">{t('integrations.refs.from', { defaultValue: 'From key' })}</Label>
              <Input id="ref-from" dir="ltr" value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} placeholder="SKU-123" className="font-mono" />
            </div>
            <ArrowRight className="mb-2.5 hidden h-4 w-4 text-muted-foreground sm:block rtl:rotate-180" aria-hidden />
            <div className="space-y-1.5">
              <Label htmlFor="ref-to">{t('integrations.refs.to', { defaultValue: 'To key' })}</Label>
              <Input id="ref-to" dir="ltr" value={targetKey} onChange={(e) => setTargetKey(e.target.value)} placeholder="SUPP-ACME" className="font-mono" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-label">
              {t('integrations.refs.label', { defaultValue: 'Label' })}
              <span className="ms-1.5 text-xs font-normal text-muted-foreground">{t('profile.optional', { defaultValue: 'Optional' })}</span>
            </Label>
            <Input id="ref-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ACME Ltd" />
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
          <Button variant="outline" onClick={() => void save(true)} disabled={busy}>
            {t('integrations.refs.saveAnother', { defaultValue: 'Add and another' })}
          </Button>
          <Button type="submit" form="add-reference" disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
            {t('integrations.refs.add', { defaultValue: 'Add reference' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
