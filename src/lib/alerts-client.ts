/**
 * Alerts client — rules over table rows and the alerts the server-side
 * engine raises from them (backend/internal/handlers/alerts.go,
 * alert_engine.go; migration 0048). Not the legacy correlation engine's
 * `apiDb.alerts` (`/alerts`).
 */

import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api-client'
import type { DataLinkFilterGroup } from '@/lib/db'

export type AlertRuleKind = 'condition' | 'duration' | 'stale' | 'count'
export type AlertSeverity = 'info' | 'warning' | 'critical'
export type AlertComparison = 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
export type AlertStatus = 'open' | 'acknowledged' | 'resolved'

export interface AlertRuleInput {
  zoneId: number | null
  sourceId: number
  name: string
  description: string
  kind: AlertRuleKind
  /** The data-link filter tree; an empty group matches every row. */
  condition: DataLinkFilterGroup
  /** duration: how long a row must match; stale: how long it may stay silent. */
  durationSec: number
  /** stale: the payload's timestamp field ('' = when the row last changed). */
  staleField: string
  comparison: AlertComparison
  threshold: number
  severity: AlertSeverity
  /** `{{field}}` from the row, plus {{item}}, {{rule}}, {{count}}. */
  message: string
  /** Row field that names the item. */
  labelField: string
  /** Who is notified; none = everyone. */
  recipientRoles: string[]
  recipientUserIds: number[]
  cooldownSec: number
  enabled: boolean
}

export interface AlertRule extends AlertRuleInput {
  id: number
  createdAt: string
  updatedAt: string
  lastEvaluatedAt?: string
  lastError?: string
}

export interface AlertEvent {
  id: number
  ruleId: number
  ruleName: string
  ruleKind: AlertRuleKind
  zoneId?: number
  zoneName: string
  sourceId: number
  /** A data link that draws the item, for "Show on map" (0 = none). */
  dataLinkId?: number
  entityKey: string
  itemLabel: string
  severity: AlertSeverity
  message: string
  status: AlertStatus
  snapshot: Record<string, unknown>
  openedAt: string
  acknowledgedAt?: string
  resolvedAt?: string
  autoResolved: boolean
  note?: string
  /** The caller is one of the rule's recipients. */
  forMe: boolean
}

export interface AlertSummary {
  active: number
  critical: number
  unread: number
}

export interface AlertRulePreview {
  matching: number
  samples: Array<{ key: string; label: string; message: string }>
  count?: number
}

export const listAlertRules = (zoneId?: number | null) =>
  apiGet<AlertRule[]>(`/alert-rules${zoneId ? `?zoneId=${zoneId}` : ''}`)
export const createAlertRule = (rule: AlertRuleInput) => apiPost<AlertRule>('/alert-rules', rule)
export const updateAlertRule = (id: number, rule: AlertRuleInput) => apiPut<AlertRule>(`/alert-rules/${id}`, rule)
export const deleteAlertRule = (id: number) => apiDelete<void>(`/alert-rules/${id}`)
export const previewAlertRule = (rule: AlertRuleInput) => apiPost<AlertRulePreview>('/alert-rules/preview', rule)

export function listAlerts(opts: { status?: 'active' | 'resolved' | ''; zoneId?: number | null; severity?: AlertSeverity | ''; limit?: number } = {}) {
  const qs = new URLSearchParams()
  if (opts.status) qs.set('status', opts.status)
  if (opts.zoneId) qs.set('zoneId', String(opts.zoneId))
  if (opts.severity) qs.set('severity', opts.severity)
  if (opts.limit) qs.set('limit', String(opts.limit))
  return apiGet<AlertEvent[]>(`/alert-events${qs.size ? `?${qs}` : ''}`)
}
export const getAlertSummary = () => apiGet<AlertSummary>('/alert-events/summary')
export const markAlertsSeen = () => apiPost<void>('/alert-events/seen', {})
export const acknowledgeAlert = (id: number) => apiPost<void>(`/alert-events/${id}/acknowledge`, {})
export const resolveAlert = (id: number, note = '') => apiPost<void>(`/alert-events/${id}/resolve`, { note })

/** Theme token per severity (dots, badges, borders). */
export const SEVERITY_TONE: Record<AlertSeverity, { dot: string; badge: string }> = {
  critical: { dot: 'bg-danger', badge: 'bg-danger/10 text-danger' },
  warning: { dot: 'bg-warning', badge: 'bg-warning/10 text-warning' },
  info: { dot: 'bg-info', badge: 'bg-info/10 text-info' },
}
