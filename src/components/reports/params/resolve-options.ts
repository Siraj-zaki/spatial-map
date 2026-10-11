/**
 * Resolve a param's option universe into the {value, label} pairs
 * dropdown / buttonGroup / dimensionGrid consume.
 *
 * Two sources supported:
 *   - Static:     `input.options.static` — used as-is.
 *   - fromQuery:  read the referenced query's result from the runtime
 *                 store, dedupe by valueColumn, use labelColumn (or
 *                 fall back to the value) for display.
 *
 * The resolver is pure — it takes the query result snapshot the store
 * already holds and produces options synchronously. `optionsLoading`
 * is inferred by the caller from the query's phase.
 */
import type { QueryRunResult } from '@/lib/reports-client'
import type { ReportParam } from '@/lib/reports/v2-types'
import type { ResolvedOption } from './types'

export interface ResolvedParamOptions {
  options: ResolvedOption[]
  loading: boolean
  error: string | undefined
}

/**
 * Return the option universe for a single param.
 *
 * `results` / `phases` / `errors` are the same maps the runtime store
 * exposes — passing them in keeps this pure and unit-testable.
 */
export function resolveParamOptions(
  param: ReportParam,
  results: Record<string, QueryRunResult | undefined>,
  phases: Record<string, 'idle' | 'loading' | 'refreshing'>,
  errors: Record<string, string | undefined>,
): ResolvedParamOptions {
  // dimensionGrid takes a special path — one option per (column,
  // distinct value) pair, with the label pre-prefixed `column::value`
  // so the widget's parser buckets it correctly. Uses the same
  // `input.options.fromQuery` as the source query.
  if (param.input.kind === 'dimensionGrid') {
    return resolveDimensionGridOptions(param, results, phases, errors)
  }

  const opts = param.input.options
  if (!opts) return { options: [], loading: false, error: undefined }

  if (opts.static && opts.static.length > 0) {
    return {
      options: opts.static.map((o: { value: unknown; label: string }) => ({
        value: o.value,
        label: o.label,
      })),
      loading: false,
      error: undefined,
    }
  }

  if (opts.fromQuery) {
    const r = results[opts.fromQuery]
    const phase = phases[opts.fromQuery] ?? 'idle'
    const err = errors[opts.fromQuery]
    if (err) return { options: [], loading: false, error: err }
    if (!r) return { options: [], loading: phase !== 'idle', error: undefined }

    const valueCol = opts.valueColumn
    if (!valueCol) return { options: [], loading: false, error: 'Missing valueColumn' }

    const valueIdx = r.columns.findIndex((c) => c.name === valueCol)
    if (valueIdx < 0) {
      return {
        options: [],
        loading: false,
        error: `Column "${valueCol}" not in "${opts.fromQuery}" result`,
      }
    }
    const labelCol = opts.labelColumn ?? valueCol
    const labelIdx = r.columns.findIndex((c) => c.name === labelCol)
    // Fall back to the value column if the requested label column is
    // missing rather than erroring — the dropdown still works, just
    // less friendly.
    const effectiveLabelIdx = labelIdx >= 0 ? labelIdx : valueIdx

    const seen = new Set<string>()
    const out: ResolvedOption[] = []
    for (const row of r.rows) {
      const raw = row[valueIdx]
      if (raw === null || raw === undefined) continue
      const key = String(raw)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ value: raw, label: String(row[effectiveLabelIdx] ?? raw) })
    }
    return { options: out, loading: phase === 'refreshing', error: undefined }
  }

  return { options: [], loading: false, error: undefined }
}

/** Resolve options for a dimensionGrid param. Walks the target query
 *  result once per configured pivot column, deduplicates values, and
 *  emits one option per (column, distinct value) pair. The widget
 *  parses the `column::value` prefix in the label to bucket options
 *  into per-column tile groups. */
function resolveDimensionGridOptions(
  param: ReportParam,
  results: Record<string, QueryRunResult | undefined>,
  phases: Record<string, 'idle' | 'loading' | 'refreshing'>,
  errors: Record<string, string | undefined>,
): ResolvedParamOptions {
  const opts = param.input.options
  const cols = param.input.columns ?? []
  if (cols.length === 0) return { options: [], loading: false, error: undefined }
  if (!opts?.fromQuery) return { options: [], loading: false, error: undefined }

  const r = results[opts.fromQuery]
  const phase = phases[opts.fromQuery] ?? 'idle'
  const err = errors[opts.fromQuery]
  if (err) return { options: [], loading: false, error: err }
  if (!r) return { options: [], loading: phase !== 'idle', error: undefined }

  const out: ResolvedOption[] = []
  for (const col of cols) {
    const idx = r.columns.findIndex((c) => c.name === col)
    if (idx < 0) continue
    const seen = new Set<string>()
    for (const row of r.rows) {
      const raw = row[idx]
      if (raw === null || raw === undefined) continue
      const key = String(raw)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ value: raw, label: `${col}::${key}` })
    }
  }
  return { options: out, loading: phase === 'refreshing', error: undefined }
}
