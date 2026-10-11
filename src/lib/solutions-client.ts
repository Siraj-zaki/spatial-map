/**
 * Solutions — named groups inside a workspace ("Hospital", "Anti-theft")
 * that collect the facilities, reports and data sources (user tables,
 * integrations, files) for one use case. Backend: `/api/v1/solutions`
 * (`handlers/solutions.go`, migration 0045).
 *
 * A solution only points at items — an item can be in several, and
 * deleting a solution never deletes data. Inside one, the regular screens
 * (Facilities, Reports, Tables, Data, Integrations) filter themselves via
 * `?solution=<id>` in the URL (`useActiveSolution`).
 */

import { useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from './api-client'
import { useCurrentTenantId } from './data-link/tenant-service'
import { queryCache, useApiQuery } from './useApiQuery'
import { subscribeExternalSSE } from './useSSE'

export interface Solution {
  id: number
  name: string
  description: string
  /** Lucide icon id (`iconComponentForId`). */
  icon: string
  /** Hex identity colour, like a report's. */
  color: string
  /** Template it was started from (`solution-templates.ts`), '' for blank. */
  template: string
  position: number
  zoneIds: number[]
  reportIds: number[]
  dataSourceIds: number[]
  createdAt: string
  updatedAt: string
}

export interface SolutionItems {
  zoneIds?: number[]
  reportIds?: number[]
  dataSourceIds?: number[]
}

export interface SolutionInput extends SolutionItems {
  name: string
  description?: string
  icon?: string
  color?: string
  template?: string
  position?: number
}

export interface SolutionRun {
  id: number
  sourceId: number
  sourceName: string
  status: string
  startedAt?: string
  finishedAt?: string
  createdAt: string
}

export interface SolutionOverview {
  totalRows: number
  updated24h: number
  lastUpdate?: string
  recentRuns: SolutionRun[]
}

const KEY = 'solutions'

let sseHooked = false
function hookSSE() {
  if (sseHooked) return
  sseHooked = true
  subscribeExternalSSE((kind) => {
    if (kind === KEY) queryCache.invalidate(KEY)
    // Members cascade away with the item on the server.
    if (kind === 'data-sources' || kind === 'zones') queryCache.invalidate(KEY)
  })
}

/** Every solution in the current workspace, with member ids. */
export function useSolutions() {
  const tenantId = useCurrentTenantId()
  useEffect(hookSSE, [])
  return useApiQuery<Solution[]>(() => apiGet<Solution[]>('/solutions'), [KEY, tenantId], { intervalMs: 0 })
}

/**
 * The solution the current page is scoped to (`?solution=<id>`), or null.
 * `id` is set as soon as the URL has one, even before the list loads, so
 * pages can pass it to the API straight away.
 */
export function useActiveSolution(): { id: number | null; solution: Solution | null; isLoading: boolean } {
  const [params] = useSearchParams()
  const raw = params.get('solution')
  const id = raw && /^\d+$/.test(raw) ? Number(raw) : null
  const { data, isLoading } = useSolutions()
  const solution = useMemo(() => (id == null ? null : (data ?? []).find((s) => s.id === id) ?? null), [data, id])
  return { id, solution, isLoading: id != null && isLoading && !data }
}

/** Member-id sets for fast filtering. */
export function solutionSets(s: Solution | null) {
  return {
    zones: new Set(s?.zoneIds ?? []),
    reports: new Set(s?.reportIds ?? []),
    sources: new Set(s?.dataSourceIds ?? []),
  }
}

function done<T>(p: Promise<T>): Promise<T> {
  return p.then((v) => {
    queryCache.invalidate(KEY)
    return v
  })
}

export const createSolution = (input: SolutionInput) => done(apiPost<Solution>('/solutions', input))
export const updateSolution = (id: number, patch: Partial<SolutionInput>) => done(apiPatch<Solution>(`/solutions/${id}`, patch))
export const deleteSolution = (id: number) => done(apiDelete<void>(`/solutions/${id}`))
export const addSolutionItems = (id: number, items: SolutionItems) => done(apiPost<Solution>(`/solutions/${id}/items`, items))
export const replaceSolutionItems = (id: number, items: SolutionItems) => done(apiPut<Solution>(`/solutions/${id}/items`, items))
export const removeSolutionItems = (id: number, items: SolutionItems) => done(apiDelete<Solution>(`/solutions/${id}/items`, { body: items }))
export const getSolutionOverview = (id: number) => apiGet<SolutionOverview>(`/solutions/${id}/overview`)

/** Path of a solution page — `tab` '' is its overview. */
export function solutionPath(id: number, tab: '' | 'facilities' | 'reports' | 'tables' | 'data' | 'integrations' = ''): string {
  switch (tab) {
    case 'facilities':
      return `/warehouses?solution=${id}`
    case 'reports':
      return `/reports?solution=${id}`
    case 'tables':
      return `/tables?solution=${id}`
    case 'data':
      return `/data?solution=${id}`
    case 'integrations':
      return `/integrations?solution=${id}`
    default:
      return `/solutions/${id}`
  }
}
