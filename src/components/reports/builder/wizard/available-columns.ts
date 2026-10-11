/**
 * Query-aware column resolution for the wizard's binding pickers.
 *
 * Different queries expose different columns to widgets. The rules:
 *
 *   - Detail / Editable / History `primary`
 *       user-picked columns + computed columns
 *   - Summary `primary` (grouped)
 *       groupBy columns + metric aliases + computed columns
 *   - Summary `totals` (ungrouped)
 *       metric aliases only
 *
 * Widget renderers, param option pickers, and validation all need
 * this per-query view. Centralising it here keeps the wizard from
 * accidentally offering "email" as an x-axis on a bar chart bound to
 * a totals query.
 */
import type { WizardDraft } from './wizard-state'
import { PRIMARY_QUERY_NAME, TOTALS_QUERY_NAME } from './wizard-serialisation'

/** Every query the wizard emits by name, plus the list of columns
 *  each one exposes. Kept as a plain map so callers can pick by name. */
export function availableQueries(draft: WizardDraft): string[] {
  const out: string[] = [PRIMARY_QUERY_NAME]
  if (draft.reportType === 'summary') out.push(TOTALS_QUERY_NAME)
  for (const q of draft.extraQueries) {
    if (q.name && q.name !== PRIMARY_QUERY_NAME && q.name !== TOTALS_QUERY_NAME) {
      out.push(q.name)
    }
  }
  return out
}

/** Columns a widget or option picker gets when bound to `queryName`.
 *  Falls back to draft.columns for unknown query names (safe default
 *  — user-picked columns are always sensible for Detail-like reports). */
export function columnsForQuery(draft: WizardDraft, queryName: string): string[] {
  const computed = draft.computedColumns.map((c) => c.name)

  if (draft.reportType === 'summary') {
    if (queryName === TOTALS_QUERY_NAME) {
      // Totals query has no groupBy; only metric aliases are present.
      return dedupe(draft.metrics.map((m) => m.as))
    }
    if (queryName === PRIMARY_QUERY_NAME) {
      return dedupe([
        ...draft.groupBy,
        ...draft.metrics.map((m) => m.as),
        ...computed,
      ])
    }
  }

  // User-declared extra queries — if the query has its own groupBy +
  // metrics we surface those column names; otherwise the query
  // returns the same shape as primary would (raw rows over the shared
  // source), so fall back to draft.columns + computed.
  const extra = draft.extraQueries.find((q) => q.name === queryName)
  if (extra) {
    if (extra.groupBy?.length || extra.metrics?.length) {
      return dedupe([
        ...(extra.groupBy ?? []),
        ...(extra.metrics ?? []).map((m) => m.as),
      ])
    }
    // Fall through to the default source-columns shape below.
  }

  // Detail / Editable / History all expose user-picked columns
  // (rows are returned raw with no aggregation) plus any computed
  // columns folded in by the runtime store.
  return dedupe([...draft.columns, ...computed.filter((n) => !draft.columns.includes(n))])
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    if (n && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}
