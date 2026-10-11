/**
 * TableApiReferenceDialog — the auto-configured public REST endpoints of
 * one table, each with a copyable curl example, plus the base URL and
 * auth header to copy. Renders inline (the "API & access" tab of
 * /tables/:id) or as a dialog. Field names come from the table in
 * memory — no extra round trip.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, ChevronDown, Code, Copy } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { type TableResponse } from '@/lib/tables-client'
import { sampleFieldValue } from '@/lib/table-field-types'

// TableApiReferenceDialog lists every auto-configured REST endpoint for
// a thing-type table with copy-paste curl examples. The dialog pulls
// the field schema from the table object already in memory — no extra
// round trip. The bearer token hint is `sgv_tbl_…` (the user copies
// the real plaintext from the MintedTokenCard or their secret store).
export function TableApiReferenceDialog({
  table,
  open,
  onOpenChange,
  inline = false,
}: {
  table: TableResponse
  open: boolean
  onOpenChange: (o: boolean) => void
  inline?: boolean
}) {
  const { t } = useTranslation()
  const baseUrl = `${import.meta.env.VITE_API_BASE_URL ?? ''}/api/v1/public/tables`
  const fields = table.fields
  // Typed examples (numbers as numbers…) from the first three fields.
  const samplePayload = fields.length > 0
    ? JSON.stringify(Object.fromEntries(fields.slice(0, 3).map((f) => [f.fieldKey, sampleFieldValue(f.dataType)])))
    : `{"status": "online"}`
  const sampleKey = 'ITEM-001'

  const endpoints: Array<{ method: string; path: string; desc: string; curl: string }> = [
    {
      method: 'POST',
      path: '/rows',
      desc: t('integrations.apiReference.insertSingle', { defaultValue: 'Insert or update a single row (upsert by entityKey).' }),
      curl: `curl -X POST ${baseUrl}/rows \\
  -H "Authorization: Bearer sgv_tbl_..." \\
  -H "Content-Type: application/json" \\
  -d '{"entityKey":"${sampleKey}","payload":${samplePayload}}'`,
    },
    {
      method: 'POST',
      path: '/rows/bulk',
      desc: t('integrations.apiReference.insertBulk', { defaultValue: 'Upsert up to 1000 rows in one transaction. Partial-success: invalid rows are reported in errors[], valid rows still commit.' }),
      curl: `curl -X POST ${baseUrl}/rows/bulk \\
  -H "Authorization: Bearer sgv_tbl_..." \\
  -H "Content-Type: application/json" \\
  -d '{"rows":[{"entityKey":"${sampleKey}","payload":${samplePayload}}]}'`,
    },
    {
      method: 'GET',
      path: '/rows',
      desc: t('integrations.apiReference.listPaged', { defaultValue: 'List rows, paginated. Query: page, pageSize (max 500), sortBy (entity_key|ts|updated_at), sortDir (asc|desc).' }),
      curl: `curl "${baseUrl}/rows?page=1&pageSize=100&sortBy=ts&sortDir=desc" \\
  -H "Authorization: Bearer sgv_tbl_..."`,
    },
    {
      method: 'POST',
      path: '/rows/query',
      desc: t('integrations.apiReference.queryFilter', { defaultValue: 'Filter + paginate via the filter DSL. Same tree shape as /data-sources/:id/query. includeCount returns totalCount.' }),
      curl: `curl -X POST ${baseUrl}/rows/query \\
  -H "Authorization: Bearer sgv_tbl_..." \\
  -H "Content-Type: application/json" \\
  -d '{"filter":{"kind":"condition","field":"status","op":"eq","value":"online"},"page":1,"pageSize":50,"includeCount":true}'`,
    },
    {
      method: 'GET',
      path: '/rows/{key}',
      desc: t('integrations.apiReference.getOne', { defaultValue: 'Get a single row by entityKey.' }),
      curl: `curl "${baseUrl}/rows/${sampleKey}" \\
  -H "Authorization: Bearer sgv_tbl_..."`,
    },
    {
      method: 'PATCH',
      path: '/rows/{key}',
      desc: t('integrations.apiReference.patchOne', { defaultValue: 'Partial update — only the keys you send are merged onto the existing payload.' }),
      curl: `curl -X PATCH ${baseUrl}/rows/${sampleKey} \\
  -H "Authorization: Bearer sgv_tbl_..." \\
  -H "Content-Type: application/json" \\
  -d '{"status":"idle"}'`,
    },
    {
      method: 'DELETE',
      path: '/rows/{key}',
      desc: t('integrations.apiReference.deleteOne', { defaultValue: 'Delete a single row by entityKey.' }),
      curl: `curl -X DELETE ${baseUrl}/rows/${sampleKey} \\
  -H "Authorization: Bearer sgv_tbl_..."`,
    },
    {
      method: 'PATCH',
      path: '/rows/bulk',
      desc: t('integrations.apiReference.patchBulk', { defaultValue: 'Patch up to 1000 rows by key list. Single transaction, partial-success.' }),
      curl: `curl -X PATCH ${baseUrl}/rows/bulk \\
  -H "Authorization: Bearer sgv_tbl_..." \\
  -H "Content-Type: application/json" \\
  -d '{"rows":[{"entityKey":"${sampleKey}","patch":{"status":"offline"}}]}'`,
    },
    {
      method: 'PATCH',
      path: '/rows/by-filter',
      desc: t('integrations.apiReference.patchByFilter', { defaultValue: 'Patch every row matching a filter. Cap 5000 rows per call (413 if exceeded).' }),
      curl: `curl -X PATCH ${baseUrl}/rows/by-filter \\
  -H "Authorization: Bearer sgv_tbl_..." \\
  -H "Content-Type: application/json" \\
  -d '{"filter":{"kind":"condition","field":"status","op":"eq","value":"online"},"patch":{"status":"idle"}}'`,
    },
    {
      method: 'DELETE',
      path: '/rows/bulk',
      desc: t('integrations.apiReference.deleteBulk', { defaultValue: 'Delete up to 1000 rows by key list.' }),
      curl: `curl -X DELETE ${baseUrl}/rows/bulk \\
  -H "Authorization: Bearer sgv_tbl_..." \\
  -H "Content-Type: application/json" \\
  -d '{"entityKeys":["${sampleKey}","${sampleKey}-2"]}'`,
    },
    {
      method: 'DELETE',
      path: '/rows/by-filter',
      desc: t('integrations.apiReference.deleteByFilter', { defaultValue: 'Delete every row matching a filter. Cap 5000 rows per call (413 if exceeded).' }),
      curl: `curl -X DELETE ${baseUrl}/rows/by-filter \\
  -H "Authorization: Bearer sgv_tbl_..." \\
  -H "Content-Type: application/json" \\
  -d '{"filter":{"kind":"condition","field":"status","op":"eq","value":"idle"}}'`,
    },
    {
      method: 'GET',
      path: '/rows/schema',
      desc: t('integrations.apiReference.schema', { defaultValue: 'Return the table’s field definitions + total row count.' }),
      curl: `curl "${baseUrl}/rows/schema" \\
  -H "Authorization: Bearer sgv_tbl_..."`,
    },
  ]

  const body = (
    // min-w-0: DialogContent is a grid; without it the widest curl
    // sample sets the track width and the dialog overflows sideways.
    <div className="min-w-0 space-y-4">
      <dl className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-x-4">
        <dt className="text-xs font-medium text-muted-foreground">
          {t('tables.api.baseUrl', { defaultValue: 'Base URL' })}
        </dt>
        <dd className="min-w-0"><CopyValue value={baseUrl} /></dd>
        <dt className="text-xs font-medium text-muted-foreground">
          {t('tables.api.authHeader', { defaultValue: 'Auth header' })}
        </dt>
        <dd className="min-w-0"><CopyValue value="Authorization: Bearer sgv_tbl_…" copyValue="Authorization: Bearer " /></dd>
      </dl>

      <div className="divide-y overflow-hidden rounded-lg border">
        {endpoints.map((ep, i) => (
          <EndpointRow key={`${ep.method} ${ep.path}`} method={ep.method} path={ep.path} desc={ep.desc} curl={ep.curl} defaultOpen={i === 0} />
        ))}
      </div>
    </div>
  )

  if (inline) {
    return body
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Code className="w-4 h-4" />
            {t('integrations.apiReference.title', { defaultValue: 'API reference' })}
            <span className="text-muted-foreground font-normal">·</span>
            <span className="font-mono text-xs font-normal">{table.dataSource.name}</span>
          </DialogTitle>
          <DialogDescription>
            {t('integrations.apiReference.description', {
              defaultValue: 'Every table gets these 12 endpoints automatically. Authenticate with the table’s bearer token — one token, one table. Rate-limited per token (default 60 req/min, burst 30).',
            })}
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  )
}

const METHOD_STYLE: Record<string, string> = {
  GET: 'bg-success/10 text-success',
  POST: 'bg-info/10 text-info',
  PATCH: 'bg-warning/10 text-warning',
  DELETE: 'bg-danger/10 text-danger',
}

/** One endpoint: method + path + what it does; expands to a copyable curl. */
function EndpointRow({
  method,
  path,
  desc,
  curl,
  defaultOpen = false,
}: {
  method: string
  path: string
  desc: string
  curl: string
  defaultOpen?: boolean
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <details className="group/ep" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className={`w-16 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold ${METHOD_STYLE[method] ?? 'bg-muted'}`}>
          {method}
        </span>
        <code className="shrink-0 font-mono text-sm" dir="ltr">{path}</code>
        <span className="hidden min-w-0 flex-1 truncate text-sm text-muted-foreground md:block">{desc}</span>
        <ChevronDown className="ms-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open/ep:rotate-180 motion-reduce:transition-none" aria-hidden />
      </summary>
      <div className="space-y-2 px-4 pb-4">
        <p className="text-sm text-muted-foreground md:hidden">{desc}</p>
        <div className="relative">
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 pe-12 font-mono text-xs leading-relaxed" dir="ltr">{curl}</pre>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(curl)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              } catch {
                /* clipboard blocked */
              }
            }}
            className="absolute end-2 top-2 flex h-7 w-7 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={t('tables.api.copyCurl', { defaultValue: 'Copy curl' })}
            aria-label={t('tables.api.copyCurl', { defaultValue: 'Copy curl' })}
          >
            {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </details>
  )
}

/** A monospace value with a copy button (base URL, auth header). */
function CopyValue({ value, copyValue }: { value: string; copyValue?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" dir="ltr" title={value}>{value}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(copyValue ?? value)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          } catch {
            /* clipboard blocked */
          }
        }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={t('common.copy', { defaultValue: 'Copy' })}
        aria-label={t('common.copy', { defaultValue: 'Copy' })}
      >
        {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}
