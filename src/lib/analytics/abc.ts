/**
 * ABC / Pareto classification.
 *
 * Sort bins by a "value" (default: capacity), accumulate share, then
 * tier into A / B / C cohorts at 80% / 95% / 100% of the total.
 *
 * The caller picks the value extractor — capacity is the obvious one
 * for warehouse inventory, but ABC works equally well on a `custom.qty`
 * column or an externalCode lookup. We keep that flexible by taking a
 * function rather than hardcoding the field.
 */

import type { Bin } from '@/lib/db'

export type AbcClass = 'A' | 'B' | 'C'

export interface AbcEntry {
  bin: Bin
  /** The value the classifier used — usually capacity, but caller-extracted. */
  value: number
  /** Cumulative share of the total value up to and including this bin (0..1). */
  cumulativeShare: number
  class: AbcClass
}

export interface AbcResult {
  entries: AbcEntry[]
  /** Stats per class — for headline summaries. */
  classes: Record<AbcClass, AbcClassStats>
  /** Total value across every contributing bin. */
  totalValue: number
}

export interface AbcClassStats {
  count: number
  shareOfBins: number
  shareOfValue: number
  totalValue: number
}

/** Default extractor — uses `bin.capacity` when present, else 0. */
export function capacityValue(bin: Bin): number {
  if (typeof bin.capacity !== 'number') return 0
  if (!Number.isFinite(bin.capacity)) return 0
  return Math.max(0, bin.capacity)
}

/**
 * Build an extractor for an attribute path. Same path syntax as the
 * style-rules engine: `capacity`, `custom.<key>`. Strings are coerced
 * to numbers; anything else returns 0 so the bin sinks into Class C.
 */
export function valueExtractorFor(
  attribute: string,
): (bin: Bin) => number {
  if (attribute === 'capacity') return capacityValue
  if (attribute.startsWith('custom.')) {
    const key = attribute.slice('custom.'.length)
    return (bin) => coerceNumber(bin.customProperties?.[key])
  }
  // Other built-ins (status, sku, notes) aren't numeric — return 0 so
  // the chart stays sensible if the user picks a non-numeric column.
  return () => 0
}

function coerceNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(0, v) : 0
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, n) : 0
  }
  return 0
}

/**
 * Classify bins into A / B / C cohorts.
 *
 * Default thresholds match the most common Pareto split:
 *   A = top 80% of total value
 *   B = next 15%
 *   C = bottom 5%
 *
 * Bins with `value === 0` collapse into C — they hold no inventory, so
 * they're informational only.
 */
export function classifyAbc(
  bins: ReadonlyArray<Bin>,
  opts: {
    extract?: (bin: Bin) => number
    thresholds?: [number, number] // [A cutoff, B cutoff]; defaults [0.8, 0.95]
  } = {},
): AbcResult {
  const extract = opts.extract ?? capacityValue
  const [aCutoff, bCutoff] = opts.thresholds ?? [0.8, 0.95]

  // Rank bins by descending value.
  const ranked = bins
    .map((bin) => ({ bin, value: extract(bin) }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)

  const totalValue = ranked.reduce((acc, r) => acc + r.value, 0)
  const entries: AbcEntry[] = []
  let runningShare = 0

  for (const row of ranked) {
    runningShare += row.value
    const cumulativeShare = totalValue > 0 ? runningShare / totalValue : 0
    const cls: AbcClass =
      cumulativeShare <= aCutoff ? 'A'
        : cumulativeShare <= bCutoff ? 'B'
          : 'C'
    entries.push({
      bin: row.bin,
      value: row.value,
      cumulativeShare,
      class: cls,
    })
  }

  // Compute per-class stats.
  const classes: Record<AbcClass, AbcClassStats> = {
    A: { count: 0, shareOfBins: 0, shareOfValue: 0, totalValue: 0 },
    B: { count: 0, shareOfBins: 0, shareOfValue: 0, totalValue: 0 },
    C: { count: 0, shareOfBins: 0, shareOfValue: 0, totalValue: 0 },
  }
  for (const e of entries) {
    classes[e.class].count++
    classes[e.class].totalValue += e.value
  }
  for (const cls of ['A', 'B', 'C'] as AbcClass[]) {
    classes[cls].shareOfBins = entries.length > 0 ? classes[cls].count / entries.length : 0
    classes[cls].shareOfValue = totalValue > 0 ? classes[cls].totalValue / totalValue : 0
  }

  return { entries, classes, totalValue }
}

export function abcColor(cls: AbcClass): string {
  switch (cls) {
    case 'A': return '#10b981' // emerald-500 — high value
    case 'B': return '#3b82f6' // blue-500    — mid value
    case 'C': return '#94a3b8' // slate-400   — low value
  }
}
