/**
 * A facility at a glance: its floor-plan thumbnail (or a tinted placeholder
 * in the facility's colour), name, rack / bin / asset counts and an
 * occupancy bar. The whole card opens the layout editor; "Preview" opens
 * the read-only viewer. Shared by /dashboard and /warehouses.
 */

import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Eye, Warehouse } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { rewriteFilesUrlSameOrigin } from '@/lib/binary-store'
import type { WarehouseSummaryRow } from '@/lib/warehouses-client'
import { cn } from '@/lib/utils'

export function facilityEditorHref(id: number) {
  return `/create-grids?warehouseId=${id}`
}

function Thumbnail({ row }: { row: WarehouseSummaryRow }) {
  const [failed, setFailed] = useState(false)
  if (row.thumbnailUrl && !failed) {
    return (
      <img
        src={rewriteFilesUrlSameOrigin(row.thumbnailUrl)}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none dark:opacity-90"
      />
    )
  }
  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{ background: `linear-gradient(135deg, ${row.color}26, ${row.color}0d)` }}
    >
      <Warehouse className="h-8 w-8" style={{ color: row.color }} aria-hidden />
    </div>
  )
}

export function FacilityCard({
  row,
  menu,
  selected,
  onToggleSelect,
}: {
  row: WarehouseSummaryRow
  /** Optional overflow menu (rendered above the stretched link). */
  menu?: ReactNode
  selected?: boolean
  /** When set, a checkbox appears (on hover, or always once selected). */
  onToggleSelect?: () => void
}) {
  const { t } = useTranslation()
  const hasBins = row.binCount > 0
  const pct = Math.round(row.occupiedPct * 100)
  return (
    <div className={cn('group relative flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-colors hover:border-foreground/20', selected && 'ring-2 ring-primary')}>
      <div className="relative aspect-[16/9] overflow-hidden border-b bg-muted">
        <Thumbnail row={row} />
        {onToggleSelect && (
          <label
            className={cn(
              'absolute start-2 top-2 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border bg-background/90 shadow-sm backdrop-blur transition-opacity focus-within:opacity-100',
              selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          >
            <input
              type="checkbox"
              checked={Boolean(selected)}
              onChange={onToggleSelect}
              className="rounded border-input"
              aria-label={t('facilityCard.select', { defaultValue: 'Select {{name}}', name: row.name })}
            />
          </label>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-1">
          <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: row.color }} aria-hidden />
            {/* Stretched link: the whole card opens the editor. */}
            <Link
              to={facilityEditorHref(row.id)}
              className="truncate after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
            >
              {row.name}
            </Link>
          </h3>
          <Link
            to={`/view/${row.id}`}
            className="relative z-10 ms-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden />
            {t('facilityCard.preview', { defaultValue: 'Preview' })}
          </Link>
          {menu && <div className="relative z-10 -me-1.5 -mt-0.5">{menu}</div>}
        </div>
        <dl className="grid grid-cols-3 gap-2 text-xs">
          {[
            [t('facilityCard.racks', { defaultValue: 'Racks' }), row.rackCount],
            [t('facilityCard.bins', { defaultValue: 'Bins' }), row.binCount],
            [t('facilityCard.assets', { defaultValue: 'Assets' }), row.assetCount],
          ].map(([label, value]) => (
            <div key={label as string}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 text-sm font-medium tabular-nums">{(value as number).toLocaleString()}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-auto">
          {hasBins ? (
            <>
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{t('facilityCard.occupancy', { defaultValue: 'Occupancy' })}</span>
                <span className="font-medium tabular-nums">{pct}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full', pct >= 95 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-primary')}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {row.rackCount > 0
                ? t('facilityCard.noBinsYet', { defaultValue: 'Racks placed — no bins configured yet.' })
                : t('facilityCard.noRacks', { defaultValue: 'No racks yet. Open the editor to add some.' })}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export function FacilityCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <Skeleton className="aspect-[16/9] rounded-none" />
      <div className="space-y-3 p-4">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-1.5 w-full" />
      </div>
    </div>
  )
}
