/**
 * One status vocabulary for a thing-type table, shared by /tables and
 * /tables/:id. It answers "is data getting in?" from what the table holds
 * (`stats`), not from whether an API key exists: the app's own grid and
 * the REST pull both write without a key, so "no key" was never the same
 * as "can't receive data" — the old rule flagged every table.
 *
 *   needsFields  no columns yet — nothing meaningful can be stored
 *   empty        has columns, no records
 *   receiving    a write landed in the last 24 h
 *   idle         has records, nothing new for a day (normal for
 *                reference tables like a product list — not a problem)
 */

import type { TFunction } from 'i18next'
import type { TableResponse } from '@/lib/tables-client'

export type TableStatus = 'needsFields' | 'empty' | 'receiving' | 'idle'

export const RECENT_WRITE_MS = 24 * 60 * 60 * 1000

export function activeKeyCount(table: TableResponse): number {
  if (table.stats) return table.stats.activeKeys
  return (table.tokens ?? []).filter((tk) => !tk.revokedAt).length
}

export function tableStatus(table: TableResponse, now = Date.now()): TableStatus {
  if (table.fields.length === 0) return 'needsFields'
  const rows = table.stats?.rows ?? 0
  if (rows === 0) return 'empty'
  const last = table.stats?.lastWriteAt ? Date.parse(table.stats.lastWriteAt) : NaN
  return !Number.isNaN(last) && now - last < RECENT_WRITE_MS ? 'receiving' : 'idle'
}

export function tableStatusLabel(status: TableStatus, t: TFunction): string {
  switch (status) {
    case 'needsFields':
      return t('tables.status.needsFields', { defaultValue: 'Needs fields' })
    case 'empty':
      return t('tables.status.empty', { defaultValue: 'No records yet' })
    case 'receiving':
      return t('tables.status.receiving', { defaultValue: 'Receiving data' })
    case 'idle':
      return t('tables.status.idle', { defaultValue: 'No recent writes' })
  }
}

export function tableStatusVariant(status: TableStatus): 'warning' | 'info' | 'success' | 'muted' {
  switch (status) {
    case 'needsFields':
      return 'warning'
    case 'empty':
      return 'info'
    case 'receiving':
      return 'success'
    case 'idle':
      return 'muted'
  }
}

/** Human label for an entity kind ("asset" → "Asset (mobile)"). */
export function entityKindLabel(kind: string | undefined, t: TFunction): string {
  if (!kind) return t('tables.kindNone', { defaultValue: 'Unspecified' })
  return t(`integrations.entityKind_${kind.replace(/-/g, '_')}`, { defaultValue: kind })
}
