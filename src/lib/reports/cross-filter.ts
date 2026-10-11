/**
 * Cross-filter helpers — turn a widget click into a param write on
 * the runtime store. Every widget kind that supports interaction
 * (charts, tables, map features) calls into `emitCrossFilter` with
 * the click's payload; the helper reads the widget's `onClick`
 * binding and routes to `setParam(id, value, 'user')`.
 *
 * Toggle semantics: if the current param value already equals the
 * clicked value AND `toggle` is true, the param is cleared.
 */
import type { CrossFilterAction } from './v2-types'
import type { ReportRuntimeStore } from './report-runtime-store'

/** Extract the emit target from a widget's bindings. */
export interface WithOnClick {
  onClick?: CrossFilterAction
}

/**
 * Emit a cross-filter action. `payload` is a shape the widget picked
 * from the click event — for Recharts that's `data.payload`; for a
 * table row it's the row object keyed by column name; for Mapbox
 * it's the clicked feature's `properties`.
 */
export function emitCrossFilter(
  store: ReportRuntimeStore,
  action: CrossFilterAction | undefined,
  payload: Record<string, unknown> | undefined,
): void {
  if (!action || !payload) return
  const value = payload[action.from]
  if (value === undefined || value === null) return
  const existing = store.getState().params[action.setParam]
  const stringified = String(value)
  if (action.toggle && existing?.userSet && String(existing.value) === stringified) {
    store.getState().resetParam(action.setParam)
    return
  }
  store.getState().setParam(action.setParam, value, 'user')
}

/** True when the current param state matches `value` — used by widget
 *  renderers to style the selected cell / bar / feature. */
export function isCrossFilterSelected(
  store: ReportRuntimeStore,
  action: CrossFilterAction | undefined,
  value: unknown,
): boolean {
  if (!action) return false
  const state = store.getState().params[action.setParam]
  if (!state?.userSet) return false
  return String(state.value) === String(value)
}
