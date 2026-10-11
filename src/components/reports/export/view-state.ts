/**
 * What each table widget currently shows — sort, search, hidden columns —
 * so "Export what's on screen" matches the table the user is looking at.
 * Table widgets publish here from an effect; the exporter reads it.
 * Plain module state: it's per page view and nothing re-renders from it.
 */

export interface WidgetViewState {
  sortColumn: string | null
  sortDir: 'asc' | 'desc'
  search: string
  hiddenColumns: string[]
}

const views = new Map<string, WidgetViewState>()

export function publishWidgetView(widgetId: string, state: WidgetViewState): void {
  views.set(widgetId, state)
}

export function widgetView(widgetId: string): WidgetViewState | undefined {
  return views.get(widgetId)
}

export function forgetWidgetView(widgetId: string): void {
  views.delete(widgetId)
}
