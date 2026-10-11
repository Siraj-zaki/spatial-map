/**
 * Small "Mixed" label shown next to a bulk-editor control when the
 * property has different values across the selected shapes. Extracted
 * from side-panel.tsx so slider-row.tsx can consume it without
 * importing from a giant component file.
 */

import { useTranslation } from 'react-i18next'

export function MixedBadge() {
  const { t } = useTranslation()
  return (
    <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
      {t('sidePanel.bulkMixed', { defaultValue: 'Mixed' })}
    </span>
  )
}
