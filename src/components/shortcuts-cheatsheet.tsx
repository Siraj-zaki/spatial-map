import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SHORTCUT_GROUPS } from '@/lib/keyboard-shortcuts'
import { useTranslation } from 'react-i18next'

interface ShortcutsCheatsheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * `?` overlay. Reads the shortcut registry so the visible keys always
 * match the live bindings. Closes on backdrop click, the X button, or
 * `?` / `Esc` (the latter two are handled by the host's keydown listener
 * and `onOpenChange(false)`).
 */
export function ShortcutsCheatsheet({
  open,
  onOpenChange,
}: ShortcutsCheatsheetProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('kb.title', { defaultValue: 'Keyboard shortcuts' })}</DialogTitle>
          <DialogDescription>
            {t('kb.subtitle', {
              defaultValue: 'Press ? at any time to close this panel.',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6 max-h-[60dvh] overflow-y-auto pe-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.id} className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t(group.titleKey, { defaultValue: group.titleFallback })}
              </h3>
              <ul className="space-y-1">
                {group.rows.map((row, i) => (
                  <li
                    key={`${group.id}-${i}`}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="text-muted-foreground">
                      {t(row.labelKey, { defaultValue: row.fallback })}
                    </span>
                    <kbd className="font-mono text-xs px-1.5 py-0.5 rounded border bg-muted text-foreground whitespace-nowrap">
                      {row.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}