import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import type { Zone } from '@/lib/db'
import { cn } from '@/lib/utils'
import { ArrowLeft, Warehouse as WarehouseIcon } from 'lucide-react'

/**
 * Active-warehouse pill — first item in the editor's top-left pill row.
 * Shows which warehouse the current edits are scoped to, with a
 * back-link to the warehouses dashboard. When no warehouse is active
 * a subtle "no warehouse" hint is shown instead so the user knows
 * that saves won't be tagged.
 */
export function WarehousePill({
  activeWarehouse,
}: {
  activeWarehouse: Zone | null
}) {
  const { t } = useTranslation()
  return (
    <Link
        to="/warehouses"
        className={cn(
          'group flex min-w-0 items-center gap-2 rounded-lg border bg-card/90 backdrop-blur px-3 py-1.5 shadow-sm hover:bg-accent transition-colors text-xs',
          activeWarehouse ? 'border-primary/30' : 'border-dashed',
        )}
        title={t('createGrids.changeWarehouse')}
      >
        <ArrowLeft className="w-3.5 h-3.5 shrink-0 opacity-50 transition-transform group-hover:-translate-x-0.5 rtl:rotate-180 rtl:group-hover:translate-x-0.5" />
        {activeWarehouse ? (
          <>
            <span
              className="w-2.5 h-2.5 shrink-0 rounded"
              style={{ backgroundColor: activeWarehouse.color }}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate font-medium text-foreground" title={activeWarehouse.name}>
              {activeWarehouse.name}
            </span>
          </>
        ) : (
          <>
            <WarehouseIcon className="w-3.5 h-3.5 opacity-70" />
            <span className="text-muted-foreground">
              {t('createGrids.noWarehouse')}
            </span>
          </>
        )}
    </Link>
  )
}
