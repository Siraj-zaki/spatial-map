/**
 * Dashboard analytics section.
 *
 * Four cards: status breakdown (donut), ABC classification (Pareto),
 * dead-stock list, capacity-by-warehouse bars. Self-contained — reads
 * what it needs via Dexie live queries and renders nothing until at
 * least one warehouse exists.
 */

import {
  abcColor,
  capacitySummary,
  classifyAbc,
  findDeadStock,
  formatAge,
  rollupByWarehouse,
  statusBreakdown,
  statusColor,
  valueExtractorFor,
} from '@/lib/analytics'
import { apiDb } from '@/lib/api-db'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { useApiQuery } from '@/lib/useApiQuery'
import {
  AlertTriangle,
  BarChart3,
  Building2,
  Layers,
  PieChart,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Donut, HorizontalBars, ParetoChart } from './charts'

export function AnalyticsSection() {
  const tenantId = useCurrentTenantId()
  const zonesQuery = useApiQuery(() => apiDb.zones.toArray(), ['zones', tenantId], { intervalMs: 30000 })
  const gridsQuery = useApiQuery(() => apiDb.grids.toArray(), ['grids', tenantId], { intervalMs: 30000 })
  const binsQuery = useApiQuery(() => apiDb.bins.toArray(), ['bins', tenantId], { intervalMs: 30000 })
  // Custom attributes defined by imports — fed into the ABC value picker.
  const attrDefsQuery = useApiQuery(
    () => apiDb.attributeDefinitions.toArray(),
    ['attributeDefinitions', tenantId],
    { intervalMs: 30000 },
  )

  const zones = zonesQuery.data ?? []
  const grids = gridsQuery.data ?? []
  const bins = binsQuery.data ?? []
  const attrDefs = attrDefsQuery.data ?? []

  // User-tunable knobs. Kept in component state because they're cheap to
  // re-render and don't need to survive a reload.
  const [abcAttribute, setAbcAttribute] = useState<string>('capacity')
  const [deadStockDays, setDeadStockDays] = useState<number>(30)

  const status = useMemo(() => statusBreakdown(bins), [bins])
  const cap = useMemo(() => capacitySummary(bins), [bins])
  const rollups = useMemo(
    () => rollupByWarehouse(zones, grids, bins),
    [zones, grids, bins],
  )
  const abc = useMemo(
    () => classifyAbc(bins, { extract: valueExtractorFor(abcAttribute) }),
    [bins, abcAttribute],
  )
  const deadStock = useMemo(
    () => findDeadStock(bins, { staleMs: deadStockDays * 24 * 60 * 60 * 1000 }),
    [bins, deadStockDays],
  )

  if (zones.length === 0 && grids.length === 0) {
    // Nothing to chart yet — caller already has an empty-state for the
    // dashboard. Skip silently to avoid noise.
    return null
  }

  return (
    <div className="space-y-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <BarChart3 className="w-5 h-5 text-primary" />
        Analytics
      </h2>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <StatusBreakdownCard status={status} />
        <AbcCard
          abc={abc}
          totalBinsWithValue={status.total}
          attribute={abcAttribute}
          onAttributeChange={setAbcAttribute}
          attrDefs={attrDefs}
        />
        <WarehouseRollupCard rollups={rollups} cap={cap} />
        <DeadStockCard
          entries={deadStock}
          thresholdDays={deadStockDays}
          onThresholdChange={setDeadStockDays}
        />
      </div>
    </div>
  )
}

// ============================================================ status

function StatusBreakdownCard({ status }: { status: ReturnType<typeof statusBreakdown> }) {
  const slices = [
    { label: 'Occupied', value: status.occupied, color: statusColor('occupied') },
    { label: 'Reserved', value: status.reserved, color: statusColor('reserved') },
    { label: 'Empty', value: status.empty, color: statusColor('empty') },
    { label: 'Unset', value: status.unset, color: statusColor('unset') },
  ]
  return (
    <Card title="Bin status" icon={PieChart}>
      <div className="flex items-center gap-5">
        <Donut slices={slices} size={120} thickness={20} />
        <div className="flex-1 min-w-0 space-y-1.5">
          {slices.map((s) => (
            <div key={s.label} className="flex items-center gap-2 text-xs">
              <span
                className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ backgroundColor: s.color }}
                aria-hidden
              />
              <span className="flex-1 truncate">{s.label}</span>
              <span className="font-mono text-muted-foreground">
                {s.value.toLocaleString()}
                {status.total > 0 && (
                  <span className="ms-1 text-muted-foreground/70">
                    ({Math.round((s.value / status.total) * 100)}%)
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground border-t pt-2 mt-3">
        {status.total.toLocaleString()} bins tracked
      </div>
    </Card>
  )
}

// ============================================================ ABC

function AbcCard({
  abc,
  totalBinsWithValue,
  attribute,
  onAttributeChange,
  attrDefs,
}: {
  abc: ReturnType<typeof classifyAbc>
  totalBinsWithValue: number
  attribute: string
  onAttributeChange: (attr: string) => void
  attrDefs: ReadonlyArray<{ key: string; label: string; type: string }>
}) {
  const entries = abc.entries.map((e) => ({
    label: e.bin.sku ?? `Bin ${e.bin.id ?? ''}`.trim(),
    value: e.value,
    cumulativeShare: e.cumulativeShare,
    color: abcColor(e.class),
  }))
  // Only number-typed custom attributes make sense as Pareto values.
  const numericCustom = attrDefs.filter((d) => d.type === 'number')
  return (
    <Card title="ABC classification" icon={BarChart3}>
      <div className="flex items-center justify-end mb-1 -mt-1">
        <select
          value={attribute}
          onChange={(e) => onAttributeChange(e.target.value)}
          className="h-7 text-[11px] font-mono rounded border border-input bg-background px-1.5"
          title="Rank bins by this attribute"
        >
          <option value="capacity">capacity</option>
          {numericCustom.map((d) => (
            <option key={d.key} value={`custom.${d.key}`}>
              custom.{d.key}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-start gap-4">
        <ParetoChart entries={entries} width={240} height={120} />
        <div className="flex-1 min-w-0 space-y-1.5 text-xs">
          {(['A', 'B', 'C'] as const).map((cls) => {
            const stats = abc.classes[cls]
            return (
              <div key={cls} className="flex items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: abcColor(cls) }}
                  aria-hidden
                />
                <span className="font-medium">Class {cls}</span>
                <span className="flex-1 font-mono text-right text-muted-foreground">
                  {stats.count} bins · {Math.round(stats.shareOfValue * 100)}%
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground border-t pt-2 mt-3">
        {abc.entries.length.toLocaleString()} of {totalBinsWithValue.toLocaleString()} bins
        contribute · ranked by{' '}
        <span className="font-mono">{attribute}</span> · total{' '}
        {abc.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </div>
    </Card>
  )
}

// ============================================================ warehouses

function WarehouseRollupCard({
  rollups,
  cap,
}: {
  rollups: ReturnType<typeof rollupByWarehouse>
  cap: ReturnType<typeof capacitySummary>
}) {
  const rows = rollups.map((r) => ({
    label: r.zone.name,
    value: r.occupiedPct,
    color: r.zone.color ?? '#6366f1',
    caption: `${Math.round(r.occupiedPct * 100)}% · ${r.binCount} bins`,
  }))
  return (
    <Card title="Facility occupancy" icon={Building2}>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No facilities with bins yet.</p>
      ) : (
        <HorizontalBars rows={rows} />
      )}
      <div className="text-[11px] text-muted-foreground border-t pt-2 mt-3">
        Total declared capacity:{' '}
        {cap.totalCapacity.toLocaleString(undefined, { maximumFractionDigits: 0 })}{' '}
        across {cap.withCapacityCount.toLocaleString()} bins
      </div>
    </Card>
  )
}

// ============================================================ dead stock

function DeadStockCard({
  entries,
  thresholdDays,
  onThresholdChange,
}: {
  entries: ReturnType<typeof findDeadStock>
  thresholdDays: number
  onThresholdChange: (days: number) => void
}) {
  return (
    <Card title="Dead stock" icon={AlertTriangle}>
      <div className="flex items-center justify-end mb-1 -mt-1">
        <select
          value={thresholdDays}
          onChange={(e) => onThresholdChange(Number(e.target.value))}
          className="h-7 text-[11px] font-mono rounded border border-input bg-background px-1.5"
          title="Staleness threshold"
        >
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
          <option value={60}>60 days</option>
          <option value={90}>90 days</option>
        </select>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No bins are stale at the {thresholdDays}-day threshold.
        </p>
      ) : (
        <ul className="space-y-1.5 max-h-[200px] overflow-y-auto">
          {entries.slice(0, 50).map((entry) => (
            <li
              key={entry.bin.id}
              className="flex items-center gap-2 text-xs px-2 py-1.5 rounded border bg-amber-500/5 border-amber-500/20"
            >
              <Layers className="flex-shrink-0 w-3 h-3 text-amber-600 dark:text-amber-400" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">
                  {entry.bin.sku ?? entry.bin.externalCode ?? `Bin ${entry.bin.id ?? ''}`}
                </div>
                <div className="text-[10px] text-muted-foreground font-mono truncate">
                  {entry.bin.targetKind} · age {formatAge(entry.ageMs)}
                </div>
              </div>
              {typeof entry.bin.capacity === 'number' && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  cap {entry.bin.capacity.toLocaleString()}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="text-[11px] text-muted-foreground border-t pt-2 mt-3">
        {entries.length.toLocaleString()} bins haven't synced in {thresholdDays}+ days
      </div>
    </Card>
  )
}

// ============================================================ shared

function Card({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: typeof BarChart3
  children: React.ReactNode
}) {
  return (
    <div className="border rounded-xl bg-card p-4 space-y-3 shadow-sm max-h-[400px] overflow-auto">
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-primary" />
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      </div>
      {children}
    </div>
  )
}
