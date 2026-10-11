/**
 * Runtime store for a single open report. One instance per report id
 * — switching reports creates a fresh store so nothing leaks across.
 *
 * Owns:
 *   - Resolved param values (with priority: URL > user > dataDefault > default)
 *   - Query results keyed by name
 *   - Pending flags (which queries are currently in flight)
 *   - Optional client-side cache keyed by resolved-param hash
 *
 * Reactivity contract:
 *   * `setParam(id, value, 'user')` writes to the URL and marks every
 *     dependent query stale.
 *   * `setParam(id, value, 'dataDefault' | 'default')` updates state
 *     WITHOUT touching the URL.
 *   * Stale queries re-run on a 500ms debounce (matches Evidence's
 *     `Query.svelte.ts` default). Distinguishes "refreshing" from
 *     "loading" so a chart doesn't blink to a spinner on every
 *     runtime change.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { runReportV2, type QueryRunResult } from '@/lib/reports-client'
import { buildDependencyGraph, queriesDependingOnParam, type DependencyGraph } from './dependency-graph'
import { createDebouncedWriter, readParamsFromURL } from './url-params'
import { evaluateComputedColumns, type ComputedColumn } from './computed-columns'
import type { ReportParam, ReportSpecV2 } from './v2-types'

/** Where a param's current value came from. Drives URL persistence. */
export type ParamSource = 'unset' | 'default' | 'dataDefault' | 'user' | 'url'

/** One param's current resolved state. */
export interface ParamState {
  value: unknown
  userSet: boolean
  source: ParamSource
}

/** Per-query pending phase. `loading` = first-ever fetch (show spinner);
 *  `refreshing` = subsequent fetch (charts keep prior data visible). */
export type QueryPhase = 'idle' | 'loading' | 'refreshing'

export interface RuntimeState {
  reportId: number
  spec: ReportSpecV2
  graph: DependencyGraph
  params: Record<string, ParamState>
  queryResults: Record<string, QueryRunResult | undefined>
  queryPhase: Record<string, QueryPhase>
  queryErrors: Record<string, string | undefined>
  msElapsed: number
  runId: number | undefined

  // actions
  setParam: (id: string, value: unknown, source?: ParamSource) => void
  resetParam: (id: string) => void
  resetAll: () => void
  runAll: () => Promise<void>
  runQueries: (names: string[], opts?: { force?: boolean }) => Promise<void>
  applySpec: (spec: ReportSpecV2) => void
  setDataDefault: (id: string, value: unknown) => void
}

/** Bound Zustand store for one open report. */
export type ReportRuntimeStore = UseBoundStore<StoreApi<RuntimeState>>

/**
 * Build a fresh runtime store for a given report. Call once per
 * open — the returned store carries all state for that report and is
 * disposed when the viewer unmounts.
 */
export function createReportRuntimeStore(reportId: number, spec: ReportSpecV2): ReportRuntimeStore {
  const graph = buildDependencyGraph(spec)
  const params = initialParams(spec, graph)
  const write = createDebouncedWriter()

  // In-flight run ids let us discard a stale run's result if a newer
  // one landed first (fast typing in a text input).
  let runCursor = 0

  const store = create<RuntimeState>((set, get) => ({
    reportId,
    spec,
    graph,
    params,
    queryResults: {},
    queryPhase: emptyPhases(spec),
    queryErrors: {},
    msElapsed: 0,
    runId: undefined,

    setParam(id, value, source = 'user') {
      const existing = get().params[id]
      const userSet = source === 'user' || source === 'url'
      const next: ParamState = { value, userSet, source }
      const nextParams = { ...get().params, [id]: next }
      set({ params: nextParams })
      // URL persistence — only user-set values ever write.
      write(get().spec.params ?? [], nextParams)
      // Re-run dependent queries. Programmatic defaults trigger the
      // same re-run because the query has genuinely different inputs
      // even if the URL didn't change.
      if (!existing || existing.value !== value) {
        const affected = queriesDependingOnParam(get().graph, id)
        if (affected.length > 0) {
          scheduleRun(get, () => get().runQueries(affected))
        }
      }
    },

    resetParam(id) {
      const spec = get().spec
      const declared = (spec.params ?? []).find((p) => p.id === id)
      if (!declared) return
      const cleared: ParamState = { value: declared.defaultValue, userSet: false, source: 'default' }
      const next = { ...get().params, [id]: cleared }
      set({ params: next })
      write(spec.params ?? [], next)
      const affected = queriesDependingOnParam(get().graph, id)
      if (affected.length > 0) {
        scheduleRun(get, () => get().runQueries(affected))
      }
    },

    resetAll() {
      const spec = get().spec
      const next = initialParams(spec, get().graph)
      // Wipe userSet flags so URL clears too.
      for (const key of Object.keys(next)) {
        next[key] = { ...next[key], userSet: false, source: next[key].source === 'url' ? 'default' : next[key].source }
      }
      set({ params: next })
      write(spec.params ?? [], next)
      void get().runAll()
    },

    async runAll() {
      const spec = get().spec
      const names = (spec.queries ?? []).map((q) => q.name)
      await get().runQueries(names, { force: true })
    },

    async runQueries(names, opts) {
      if (names.length === 0) return
      const cursor = ++runCursor
      const beforePhases = { ...get().queryPhase }
      for (const n of names) {
        beforePhases[n] = beforePhases[n] === 'idle' ? 'loading' : 'refreshing'
      }
      set({ queryPhase: beforePhases })

      const params = serialiseParams(get().params, get().spec.params ?? [])
      try {
        const resp = await runReportV2(get().reportId, {
          params,
          queryNames: opts?.force ? undefined : names,
        })
        if (cursor !== runCursor) return // a newer run landed first
        // Fold client-side computed columns into each query result
        // BEFORE storing, so widget renderers see them as normal
        // columns and don't need special-case code.
        const spec = get().spec
        const withComputed: Record<string, QueryRunResult> = {}
        for (const [name, r] of Object.entries(resp.queries)) {
          const q = spec.queries?.find((x) => x.name === name)
          const cc = (q?.computedColumns ?? []) as ComputedColumn[]
          if (cc.length === 0 || r.error) {
            withComputed[name] = r
            continue
          }
          const evaluated = evaluateComputedColumns(
            { columns: r.columns, rows: r.rows },
            cc,
          )
          withComputed[name] = {
            ...r,
            columns: evaluated.columns,
            rows: evaluated.rows,
            rowCount: evaluated.rows.length,
          }
        }
        const results = { ...get().queryResults, ...withComputed }
        const errors = { ...get().queryErrors }
        const phases = { ...get().queryPhase }
        for (const [name, r] of Object.entries(withComputed)) {
          errors[name] = r.error || undefined
          phases[name] = 'idle'
        }
        set({
          queryResults: results,
          queryErrors: errors,
          queryPhase: phases,
          msElapsed: resp.msElapsed,
          runId: resp.runId,
        })
        // Apply data-driven defaults — for every param with
        // `defaultFromQuery` whose target query just landed, extract
        // the reduced value and push it to `setDataDefault`. Skips
        // params the user has already set (setDataDefault guards it).
        applyDataDefaults(get().spec.params ?? [], withComputed, (id, value) => {
          get().setDataDefault(id, value)
        })
      } catch (err) {
        if (cursor !== runCursor) return
        const msg = err instanceof Error ? err.message : String(err)
        const errors = { ...get().queryErrors }
        const phases = { ...get().queryPhase }
        for (const n of names) {
          errors[n] = msg
          phases[n] = 'idle'
        }
        set({ queryErrors: errors, queryPhase: phases })
      }
    },

    applySpec(newSpec) {
      const newGraph = buildDependencyGraph(newSpec)
      // Preserve existing param values where the ids still exist.
      const preserved: Record<string, ParamState> = {}
      const current = get().params
      for (const p of newSpec.params ?? []) {
        if (current[p.id]) {
          preserved[p.id] = current[p.id]
        }
      }
      const merged = { ...initialParams(newSpec, newGraph), ...preserved }
      set({
        spec: newSpec,
        graph: newGraph,
        params: merged,
        queryPhase: emptyPhases(newSpec),
      })
    },

    setDataDefault(id, value) {
      const existing = get().params[id]
      // Only overwrite if the user hasn't touched the param.
      if (existing && existing.userSet) return
      const next: ParamState = { value, userSet: false, source: 'dataDefault' }
      set({ params: { ...get().params, [id]: next } })
      const affected = queriesDependingOnParam(get().graph, id)
      if (affected.length > 0) {
        scheduleRun(get, () => get().runQueries(affected))
      }
    },
  }))

  return store as ReportRuntimeStore
}

/** Compute the initial per-param state from URL + defaults. */
function initialParams(spec: ReportSpecV2, _graph: DependencyGraph): Record<string, ParamState> {
  const url = readParamsFromURL(spec.params ?? [])
  const out: Record<string, ParamState> = {}
  for (const p of spec.params ?? []) {
    if (p.id in url) {
      out[p.id] = { value: url[p.id], userSet: true, source: 'url' }
      continue
    }
    if (p.defaultValue !== undefined) {
      out[p.id] = { value: p.defaultValue, userSet: false, source: 'default' }
      continue
    }
    out[p.id] = { value: undefined, userSet: false, source: 'unset' }
  }
  return out
}

/** Fresh phase map with every query "idle". */
function emptyPhases(spec: ReportSpecV2): Record<string, QueryPhase> {
  const out: Record<string, QueryPhase> = {}
  for (const q of spec.queries ?? []) out[q.name] = 'idle'
  return out
}

/** JSON-encodable snapshot of params for the run request body. */
export function serialiseParams(
  paramState: Record<string, ParamState>,
  declared: ReportParam[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of declared) {
    const s = paramState[p.id]
    if (!s || s.value === undefined || s.value === null) continue
    if (typeof s.value === 'string' && s.value === '') continue
    out[p.id] = s.value
  }
  return out
}

/**
 * Coalesce burst re-runs into a single scheduled tick. Matches
 * Evidence's default query debounce (500ms) — long enough that a
 * fast-typing text input doesn't spam the API, short enough that a
 * dropdown selection feels instant.
 */
const runDebounceMs = 500
const runTimers = new WeakMap<() => RuntimeState, ReturnType<typeof setTimeout>>()

function scheduleRun(getFn: () => RuntimeState, run: () => Promise<void>): void {
  const existing = runTimers.get(getFn)
  if (existing) clearTimeout(existing)
  const t = setTimeout(() => {
    runTimers.delete(getFn)
    void run()
  }, runDebounceMs)
  runTimers.set(getFn, t)
}

/**
 * Walk every param with a `defaultFromQuery` binding, and if the
 * targeted query just landed in `resultsByName`, extract the reduced
 * value and hand it to `apply`. The apply function is expected to
 * call `setDataDefault`, which handles the "don't overwrite user
 * input" guard itself — so this helper doesn't need to know the
 * current param state.
 *
 * The `reduce` mode maps directly to Evidence's `select_first` /
 * `select_min` / `select_max` — first row wins by default (matches
 * the query's declared sort), min/max scan the column and pick the
 * extremum, coercing to Number for the comparison.
 */
function applyDataDefaults(
  params: ReportParam[],
  resultsByName: Record<string, QueryRunResult>,
  apply: (paramId: string, value: unknown) => void,
): void {
  for (const p of params) {
    const dfq = p.defaultFromQuery
    if (!dfq) continue
    const r = resultsByName[dfq.query]
    if (!r || r.error || r.rows.length === 0) continue
    const colIdx = r.columns.findIndex((c) => c.name === dfq.column)
    if (colIdx < 0) continue
    const reduce = dfq.reduce ?? 'first'
    let value: unknown
    if (reduce === 'first') {
      value = r.rows[0][colIdx]
    } else {
      // min / max: scan the column, coerce for the comparison but
      // return the original value so downstream code sees the raw
      // type (Date-ish strings, numbers, etc).
      let bestIdx = 0
      let bestNum = toNumber(r.rows[0][colIdx])
      for (let i = 1; i < r.rows.length; i++) {
        const n = toNumber(r.rows[i][colIdx])
        if (Number.isNaN(n)) continue
        if (reduce === 'min' ? n < bestNum : n > bestNum) {
          bestNum = n
          bestIdx = i
        }
      }
      value = r.rows[bestIdx][colIdx]
    }
    if (value !== undefined && value !== null) apply(p.id, value)
  }
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' || typeof v === 'boolean') return Number(v)
  return NaN
}
