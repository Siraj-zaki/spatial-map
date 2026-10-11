/**
 * Persistent strip under the top bar while the browser is offline (a toast
 * would vanish while the problem persists). Edits made offline are queued
 * by api-client and sent on reconnect, so the copy says so.
 */

import { useTranslation } from 'react-i18next'
import { CloudOff } from 'lucide-react'
import { useOnline } from './query-error'

export function OfflineBanner() {
  const { t } = useTranslation()
  const online = useOnline()
  if (online) return null
  return (
    <div role="status" className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-foreground">
      <CloudOff className="h-4 w-4 shrink-0 text-warning" aria-hidden />
      <span>
        {t('errors.offlineBanner', {
          defaultValue: 'You’re offline. Changes are saved on this device and sync when you reconnect.',
        })}
      </span>
    </div>
  )
}
