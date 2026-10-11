/**
 * DataGrid — spreadsheet-like records view for a thing-type table.
 *
 * Wraps `TableRecordsDialog` in inline mode (no Dialog chrome) so it
 * can be embedded directly into the Records tab of `/tables/:id`.
 *
 * Capabilities inherited from TableRecordsDialog:
 *   - Server-paginated row list (page / pageSize / sort)
 *   - Inline cell edit (writes through the bearer-token API)
 *   - Add row / delete row
 *   - Per-row history viewer (data_source_row_events audit trail)
 *
 * Page + sort live in the URL (?page=&sort=&dir=). `onTotalChange`
 * reports the row count for the page header; `onShowApi` powers the
 * empty state's "View API" shortcut.
 */

import { TableRecordsDialog } from '@/components/data-link/table-records-dialog'
import { type TableResponse } from '@/lib/tables-client'

export function DataGrid({
  table,
  onShowApi,
  onTotalChange,
}: {
  table: TableResponse
  onShowApi?: () => void
  onTotalChange?: (total: number) => void
}) {
  return (
    <TableRecordsDialog
      table={table}
      open
      inline
      onOpenChange={() => {}}
      onShowApi={onShowApi}
      onTotalChange={onTotalChange}
    />
  )
}
