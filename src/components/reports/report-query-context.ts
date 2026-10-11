/**
 * Every query result of the open report, for widgets that read more
 * than their own `queryRef` (the facility explorer shows one tab per
 * query). Provided by the report viewer around the canvas; widgets that
 * only need their own result keep using the `result` prop.
 */
import { createContext, useContext } from 'react'
import type { QueryRunResult } from '@/lib/reports-client'

export interface ReportQueryContextValue {
  results: Record<string, QueryRunResult | undefined>
  phases: Record<string, string | undefined>
  /** Re-run every query (after an edit made from inside a widget). */
  refresh: () => void
}

export const ReportQueryContext = createContext<ReportQueryContextValue | null>(null)

export function useReportQueries(): ReportQueryContextValue | null {
  return useContext(ReportQueryContext)
}
