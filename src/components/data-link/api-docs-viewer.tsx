/**
 * ApiDocsViewer — the "API & access" tab of `/tables/:id`.
 *
 * Three cards, in the order people need them:
 *   1. API keys — `TableTokensPanel` (create / revoke; the plaintext is
 *      shown once on create).
 *   2. Endpoints — `TableApiReferenceDialog inline`: base URL + auth
 *      header to copy, then the 12 auto-configured endpoints as a
 *      collapsible list with copy-paste curl (first one open).
 *   3. Pull from a REST API — `TableExternalSourcePanel` (the polling
 *      worker fetches an external URL on a schedule and upserts rows).
 *
 * The parent passes the full `table`, so the docs render with no extra
 * round trip; `onChanged` lets it refetch after a key is created/revoked.
 */

import { useTranslation } from 'react-i18next'
import { ChevronRight, Code, KeyRound, RefreshCcw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { TableApiReferenceDialog } from '@/components/data-link/table-api-reference'
import { TableTokensPanel } from '@/components/data-link/table-api-keys'
import { TableExternalSourcePanel } from '@/components/data-link/table-external-source-panel'
import { rise } from '@/components/page-shell'
import { type TableResponse } from '@/lib/tables-client'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { activeKeyCount } from '@/lib/table-status'
import { cn } from '@/lib/utils'

export function ApiDocsViewer({ table, onChanged }: { table: TableResponse; onChanged?: () => void }) {
  const { t, i18n } = useTranslation()
  const tableId = table.dataSource.id
  const keys = activeKeyCount(table)
  const keyUsed = table.stats?.keyLastUsedAt
  const polling = !!table.stats?.polling
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <div className="space-y-6">
      {/* How data gets in, at a glance — each tile jumps to its section. */}
      <nav aria-label={t('tables.api.summaryLabel', { defaultValue: 'Ways to send data' })} className="grid gap-3 sm:grid-cols-3">
        <SummaryTile
          icon={KeyRound}
          title={t('tables.api.keysTitle', { defaultValue: 'API keys' })}
          value={t('tables.keyCount', { defaultValue: '{{count}} API keys', count: keys })}
          hint={
            keyUsed
              ? t('tables.api.keyUsedAgo', { defaultValue: 'Last used {{when}}', when: relativeTime(keyUsed, i18n.language) })
              : keys > 0
                ? t('tables.api.keyNeverUsed', { defaultValue: 'Never used yet' })
                : t('tables.api.noKeysHint', { defaultValue: 'Create one for each system that sends data' })
          }
          hintTitle={keyUsed ? fullTime(keyUsed, i18n.language) : undefined}
          onClick={() => jump('table-api-keys')}
        />
        <SummaryTile
          icon={Code}
          title={t('tables.api.endpointsTitle', { defaultValue: 'Endpoints' })}
          value={t('tables.api.endpointCount', { defaultValue: '12 endpoints' })}
          hint={t('tables.api.endpointHint', { defaultValue: 'Read, write, bulk and filter' })}
          onClick={() => jump('table-api-endpoints')}
        />
        <SummaryTile
          icon={RefreshCcw}
          title={t('tables.api.pollTitle', { defaultValue: 'Pull from a REST API' })}
          value={polling ? t('tables.api.pollOn', { defaultValue: 'On' }) : t('tables.api.pollOff', { defaultValue: 'Off' })}
          hint={polling ? t('tables.api.pollOnHint', { defaultValue: 'We fetch your URL on a schedule' }) : t('tables.api.pollOffHint', { defaultValue: 'Optional — fetch rows from your URL' })}
          tone={polling ? 'success' : undefined}
          onClick={() => jump('table-api-poll')}
        />
      </nav>
      {tableId !== undefined && (
        <Section
          id="table-api-keys"
          i={0}
          icon={KeyRound}
          title={t('tables.api.keysTitle', { defaultValue: 'API keys' })}
          description={t('tables.api.keysBody', {
            defaultValue: 'Each key can write to this table only. Give every system its own key so you can revoke one without breaking the rest.',
          })}
        >
          <TableTokensPanel tableId={tableId} tokens={table.tokens ?? []} onChanged={onChanged} />
        </Section>
      )}
      <Section
        id="table-api-endpoints"
        i={1}
        icon={Code}
        title={t('tables.api.endpointsTitle', { defaultValue: 'Endpoints' })}
        description={t('tables.api.endpointsBody', {
          defaultValue: 'Every table gets these endpoints automatically. Send the key as a bearer token; each key is rate-limited to 60 requests a minute.',
        })}
      >
        <TableApiReferenceDialog table={table} open inline onOpenChange={() => {}} />
      </Section>
      {tableId !== undefined && (
        <Section
          id="table-api-poll"
          i={2}
          icon={RefreshCcw}
          title={t('tables.api.pollTitle', { defaultValue: 'Pull from a REST API' })}
          description={t('tables.api.pollBody', {
            defaultValue: 'Rather than pushing rows, let us fetch them: we call your URL on a schedule and upsert every item it returns.',
          })}
        >
          <TableExternalSourcePanel tableId={tableId} bare fields={table.fields} />
        </Section>
      )}
    </div>
  )
}

function SummaryTile({
  icon: Icon,
  title,
  value,
  hint,
  hintTitle,
  tone,
  onClick,
}: {
  icon: LucideIcon
  title: string
  value: string
  hint: string
  hintTitle?: string
  tone?: 'success'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-start gap-3 rounded-xl border bg-card p-4 text-start shadow-sm transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-muted-foreground">{title}</span>
        <span className={cn('block text-sm font-semibold', tone === 'success' && 'text-success')}>{value}</span>
        <span className="block truncate text-xs text-muted-foreground" title={hintTitle}>
          {hint}
        </span>
      </span>
      <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 rtl:rotate-180" aria-hidden />
    </button>
  )
}

function Section({
  id,
  i,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string
  i: number
  icon: LucideIcon
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section id={id} {...rise(i, 'scroll-mt-4 rounded-xl border bg-card')}>
      <header className="flex items-start gap-3 border-b px-5 py-4">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{description}</p>
        </div>
      </header>
      <div className="p-5">{children}</div>
    </section>
  )
}
