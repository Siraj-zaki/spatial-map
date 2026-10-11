/**
 * Dependency graph over a v2 spec — which queries depend on which
 * params (and which other queries). The runtime store uses this to
 * decide which queries to re-run when a param changes; the builder
 * shows it in the "Depends on: …" hint under each query.
 *
 * The scanner walks each query's filter tree + extraFilter template
 * for `{{param.<id>}}` markers. Explicit `paramRefs` on a query
 * short-circuit the scan (matches the backend's contract).
 */
import type { FilterNode } from '@/lib/reports-client'
import type { ReportQueryV2, ReportSpecV2 } from './v2-types'

/** One query's set of dependencies. */
export interface QueryDependencies {
  params: string[]
  queries: string[]
}

/** Full dependency graph, keyed by query name. */
export interface DependencyGraph {
  /** For each query name: which params + queries it references. */
  perQuery: Map<string, QueryDependencies>
  /** Inverse index: for a param id, which queries need re-run when it changes. */
  paramToQueries: Map<string, string[]>
  /** Inverse index: for a query name, which queries need re-run when it changes. */
  queryToQueries: Map<string, string[]>
  /** Cycles detected across queries. Empty when the graph is a DAG. */
  cycles: string[][]
}

/** Build the dependency graph for the given spec. */
export function buildDependencyGraph(spec: ReportSpecV2): DependencyGraph {
  const perQuery = new Map<string, QueryDependencies>()
  const paramToQueries = new Map<string, string[]>()
  const queryToQueries = new Map<string, string[]>()

  const queries = spec.queries ?? []
  for (const q of queries) {
    const deps = collectDependencies(q)
    perQuery.set(q.name, deps)
    for (const p of deps.params) {
      const list = paramToQueries.get(p) ?? []
      list.push(q.name)
      paramToQueries.set(p, list)
    }
    for (const other of deps.queries) {
      const list = queryToQueries.get(other) ?? []
      list.push(q.name)
      queryToQueries.set(other, list)
    }
  }

  return {
    perQuery,
    paramToQueries,
    queryToQueries,
    cycles: detectCycles(queries, perQuery),
  }
}

/** Collect the params + queries one query depends on. */
export function collectDependencies(query: ReportQueryV2): QueryDependencies {
  if (query.paramRefs && query.paramRefs.length > 0) {
    return { params: [...new Set(query.paramRefs)], queries: [] }
  }
  const paramIds = new Set<string>()
  const queryNames = new Set<string>()

  scanNodeForRefs(query.filters, paramIds, queryNames)
  scanTextForRefs(query.extraFilter ?? '', paramIds, queryNames)

  return {
    params: [...paramIds],
    queries: [...queryNames],
  }
}

function scanNodeForRefs(
  node: FilterNode | undefined,
  params: Set<string>,
  queries: Set<string>,
): void {
  if (!node) return
  if (node.and) for (const child of node.and) scanNodeForRefs(child, params, queries)
  if (node.or) for (const child of node.or) scanNodeForRefs(child, params, queries)
  if (node.cond && typeof node.cond.value === 'string') {
    scanTextForRefs(node.cond.value, params, queries)
  }
}

// Matches `{{ … }}` where the inside is a param / query reference. We
// stay lenient — the runtime and the backend split names further; the
// graph just wants the identifier prefix.
const markerRe = /\{\{\s*([^{}]+?)\s*\}\}/g

function scanTextForRefs(text: string, params: Set<string>, queries: Set<string>): void {
  if (!text) return
  const seen = new Set<string>()
  for (const match of text.matchAll(markerRe)) {
    const inner = match[1].trim()
    if (seen.has(inner)) continue
    seen.add(inner)
    if (inner.startsWith('param.')) {
      // param.<name>[.sub]
      const rest = inner.slice('param.'.length)
      const dot = rest.indexOf('.')
      params.add(dot < 0 ? rest : rest.slice(0, dot))
      continue
    }
    // Bare `{{name}}` is Evidence's query-chain form; recorded so the
    // builder can warn the user, even though the backend rejects it
    // in phase 1.
    const dot = inner.indexOf('.')
    queries.add(dot < 0 ? inner : inner.slice(0, dot))
  }
}

/**
 * Simple cycle detection via depth-first search over the queryToQueries
 * inverse. Returns the cycle vertices in the order they were visited.
 */
function detectCycles(
  queries: ReportQueryV2[],
  perQuery: Map<string, QueryDependencies>,
): string[][] {
  const cycles: string[][] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const dfs = (name: string) => {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      const start = stack.indexOf(name)
      if (start >= 0) cycles.push([...stack.slice(start), name])
      return
    }
    visiting.add(name)
    stack.push(name)
    const deps = perQuery.get(name)?.queries ?? []
    for (const dep of deps) dfs(dep)
    stack.pop()
    visiting.delete(name)
    visited.add(name)
  }

  for (const q of queries) dfs(q.name)
  return cycles
}

/** Given a changed param id, list the queries that need to re-run. */
export function queriesDependingOnParam(graph: DependencyGraph, paramId: string): string[] {
  return graph.paramToQueries.get(paramId) ?? []
}

/** Given a changed query name, list the downstream queries that need to re-run. */
export function queriesDependingOnQuery(graph: DependencyGraph, queryName: string): string[] {
  return graph.queryToQueries.get(queryName) ?? []
}
