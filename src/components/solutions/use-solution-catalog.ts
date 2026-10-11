/**
 * Everything a solution can hold, for the item picker and the overview:
 * facilities (zones), reports, and data sources split into user tables
 * and integrations (REST / file feeds; webhooks count as integrations).
 */

import { useMemo } from 'react'
import { apiDb } from '@/lib/api-db'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { listReports } from '@/lib/reports-client'
import { useApiQuery } from '@/lib/useApiQuery'
import type { DataSource, Zone } from '@/lib/db'
import type { Report } from '@/lib/reports-client'

export interface SolutionCatalog {
  zones: Zone[]
  reports: Report[]
  tables: DataSource[]
  integrations: DataSource[]
  isLoading: boolean
  error: Error | null
}

export function useSolutionCatalog(enabled = true): SolutionCatalog {
  const tenantId = useCurrentTenantId()
  const zones = useApiQuery(() => apiDb.zones.toArray(), ['zones', tenantId, 'solution-catalog'], { intervalMs: 0, enabled })
  const reports = useApiQuery(() => listReports(), ['reports', tenantId, 'solution-catalog'], { intervalMs: 0, enabled })
  const sources = useApiQuery(() => apiDb.dataSources.toArray(), ['dataSources', tenantId], { intervalMs: 0, enabled })
  return useMemo(() => {
    const all = sources.data ?? []
    return {
      zones: [...(zones.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
      reports: (reports.data ?? []).filter((r) => !r.isArchived).sort((a, b) => a.name.localeCompare(b.name)),
      tables: all.filter((s) => s.kind === 'table').sort((a, b) => a.name.localeCompare(b.name)),
      integrations: all.filter((s) => s.kind !== 'table').sort((a, b) => a.name.localeCompare(b.name)),
      isLoading: (zones.isLoading && !zones.data) || (reports.isLoading && !reports.data) || (sources.isLoading && !sources.data),
      error: zones.error ?? reports.error ?? sources.error,
    }
  }, [zones.data, zones.isLoading, zones.error, reports.data, reports.isLoading, reports.error, sources.data, sources.isLoading, sources.error])
}
