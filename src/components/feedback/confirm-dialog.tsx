/**
 * The one confirmation dialog for destructive or irreversible actions.
 * Replaces native `window.confirm()` (unstyled, untranslatable, blocks the
 * thread). Keeps focus on Cancel by default so Enter never destroys data by
 * accident; shows the server's error inline if the action fails.
 */

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  busy,
  confirmDisabled,
  error,
  destructive = true,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  confirmLabel: string
  onConfirm: () => void
  busy?: boolean
  /** Confirm stays disabled (e.g. until a name is typed) without a spinner. */
  confirmDisabled?: boolean
  error?: string | null
  destructive?: boolean
  children?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="p-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 whitespace-pre-line break-words">{error}</span>
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" autoFocus onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy && <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
