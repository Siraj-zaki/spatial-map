import { useTranslation } from 'react-i18next'

import type { DataLinkConfig } from '@/lib/db'

/**
 * Data-Link launcher pill (DESIGN-data-link.md Slice 2). Sits next
 * to the warehouse pill so it's discoverable but doesn't fight the
 * toolbar for space. Shows the count of data-link configs bound to
 * the active warehouse; click opens the editor for a fresh binding.
 *
 * Only rendered when a warehouse is active — a data link with no
 * `zoneId` scope isn't reachable from this route, and mounting the
 * pill without a warehouse would produce a `(0)` count that misleads
 * users into thinking they've forgotten to configure anything.
 */
export function DataLinkPill({
  activeWarehouseId,
  savedDataLinks,
  onOpenEditor,
}: {
  activeWarehouseId: number | null
  savedDataLinks: DataLinkConfig[]
  onOpenEditor: () => void
}) {
  const { t } = useTranslation()
  if (activeWarehouseId === null) return null
  return (
    <button
        type="button"
        onClick={onOpenEditor}
        className="flex shrink-0 items-center gap-2 rounded-lg border bg-card/90 backdrop-blur px-3 py-1.5 shadow-sm hover:bg-accent transition-colors text-xs"
        title={t('dataLink.openEditor', { defaultValue: 'Add / edit data links' })}
        aria-label={t('dataLink.openEditor', { defaultValue: 'Add / edit data links' })}
      >
        <span aria-hidden="true">🔗</span>
        <span className="font-medium">
          {t('dataLink.dataLinks', { defaultValue: 'Data links' })}
        </span>
        <span className="text-muted-foreground">
          ({savedDataLinks.filter((d) => d.zoneId === activeWarehouseId).length})
        </span>
    </button>
  )
}
