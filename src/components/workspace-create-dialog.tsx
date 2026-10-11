/**
 * Modal for creating a new workspace. Fires createWorkspace on submit,
 * then automatically switches to the freshly-created one so the user
 * lands in an empty workspace ready for their first warehouse.
 *
 * The parent controls open/close via props so the switcher and the
 * /workspaces page can share this component.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Loader2, Plus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ColorPicker } from '@/components/ui/color-picker'
import { createWorkspace } from '@/lib/workspace-client'
import { setCurrentTenantId } from '@/lib/tenant-store'
import { handleWorkspaceSwitch } from '@/lib/workspace-switch'

const DEFAULT_COLOR = '#3b82f6'

interface WorkspaceCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful create + switch, in case the caller needs to react. */
  onCreated?: (id: number) => void
}

export function WorkspaceCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: WorkspaceCreateDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setName('')
    setColor(DEFAULT_COLOR)
    setError(null)
    setBusy(false)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setError(t('workspace.nameRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await createWorkspace({ name: trimmed, color })
      // Switch to the new workspace immediately. Two calls so we get
      // both the persisted setting (setCurrentTenantId) and the full
      // reload cascade (handleWorkspaceSwitch) — the subscription
      // installed at boot would fire the reload too, but running it
      // eagerly here ensures the dialog can navigate away before the
      // spatial-store starts populating (avoids a flash of the old
      // workspace's editor).
      await setCurrentTenantId(created.id)
      await handleWorkspaceSwitch(created.id)
      // Land the user on the dashboard so they see the "empty
      // workspace" state front and centre. Warehouse-scoped URLs
      // wouldn't be valid in a workspace with no warehouses yet.
      navigate('/dashboard', { replace: true })
      onCreated?.(created.id)
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('workspace.createFailed'),
      )
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          if (!next) reset()
          onOpenChange(next)
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('workspace.createTitle')}</DialogTitle>
          <DialogDescription>{t('workspace.createDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="workspace-name">{t('workspace.nameLabel')}</Label>
            <Input
              id="workspace-name"
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('workspace.namePlaceholder')}
              disabled={busy}
              maxLength={80}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('workspace.colorLabel')}</Label>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                reset()
                onOpenChange(false)
              }}
              disabled={busy}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || name.trim().length === 0}>
              {busy ? (
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="me-2 h-4 w-4" />
              )}
              {t('workspace.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
