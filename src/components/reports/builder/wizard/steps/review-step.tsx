import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, CheckCircle2, CircleAlert, Download, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  listReportMemberCandidates,
  listReportSources,
  type ReportMemberCandidate,
  type ReportSourceHint,
} from '@/lib/reports-client'
import { useWizard } from '../wizard-state'
import { toV2Spec } from '../wizard-serialisation'
import { validateDraft } from '../wizard-validation'
import { REPORT_TYPES as TYPES, STEP_LABELS } from '../wizard-steps'

/** Review step — summary + access-control panel + JSON preview for
 *  the curious. The Save button lives in the wizard shell footer;
 *  this step is a read-check before pressing it. */
export function ReviewStep() {
  const { t } = useTranslation()
  const { draft, update, goTo } = useWizard()
  const [members, setMembers] = useState<ReportMemberCandidate[]>([])
  const [membersLoaded, setMembersLoaded] = useState(false)
  const [sources, setSources] = useState<ReportSourceHint[]>([])

  useEffect(() => {
    let cancelled = false
    listReportSources()
      .then((r) => {
        if (!cancelled) setSources(r)
      })
      .catch(() => {
        /* summary falls back to the id */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    listReportMemberCandidates()
      .then((m) => {
        if (!cancelled) setMembers(m)
      })
      .catch(() => {
        if (!cancelled) setMembers([])
      })
      .finally(() => {
        if (!cancelled) setMembersLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const issues = validateDraft(draft, t)
  const blocking = issues.filter((i) => i.blocking)
  const typeMeta = TYPES.find((x) => x.id === draft.reportType)
  const sourceName = draft.sourceRef
    ? (sources.find((x) => x.id === draft.sourceRef!.id)?.name ??
      t('reports.wizard.review.sourceId', { defaultValue: 'Source #{{id}}', id: draft.sourceRef.id }))
    : '—'
  const spec = toV2Spec(draft)

  const permissionMode = (userId: number): 'none' | 'view' | 'edit' => {
    const p = draft.permissions.find((x) => x.userId === userId)
    if (!p) return 'none'
    return p.canEdit ? 'edit' : 'view'
  }
  const setPermission = (userId: number, mode: 'none' | 'view' | 'edit') => {
    const others = draft.permissions.filter((x) => x.userId !== userId)
    if (mode === 'none') update({ permissions: others })
    else update({ permissions: [...others, { userId, canEdit: mode === 'edit' }] })
  }

  return (
    <div className="max-w-3xl space-y-5">
      {/* Readiness first — it's what decides whether Save works. */}
      {issues.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-sm">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
          {t('reports.wizard.review.readyToSave', { defaultValue: 'Ready to save.' })}
        </div>
      ) : (
        <div
          className={cn(
            'overflow-hidden rounded-lg border',
            blocking.length > 0 ? 'border-danger/30 bg-danger/5' : 'border-warning/30 bg-warning/5',
          )}
        >
          <div className="flex items-center gap-2 px-4 pt-3 text-sm font-medium">
            {blocking.length > 0 ? (
              <CircleAlert className="h-4 w-4 shrink-0 text-danger" aria-hidden />
            ) : (
              <TriangleAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden />
            )}
            {blocking.length > 0
              ? t('reports.wizard.review.blocking', { defaultValue: 'Fix these before saving' })
              : t('reports.wizard.review.warnings', { defaultValue: 'Before you save' })}
          </div>
          {blocking.length === 0 && (
            <p className="px-4 pt-1 text-xs text-muted-foreground">
              {t('reports.wizard.review.warningsHint', {
                defaultValue: 'You can save anyway — the parts below will show empty until they’re fixed.',
              })}
            </p>
          )}
          <ul className="mt-2 divide-y border-t border-current/10">
            {issues.map((issue, i) => {
              const step = STEP_LABELS[issue.step]
              return (
                <li key={i} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', issue.blocking ? 'bg-danger' : 'bg-warning')} aria-hidden />
                  <span className="min-w-0 flex-1">{issue.message}</span>
                  <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => goTo(issue.step)}>
                    {t(step.key, { defaultValue: step.fallback })}
                    <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Summary */}
      <div className="overflow-hidden rounded-lg border">
        <div className="border-b bg-muted/40 px-4 py-2 text-xs font-medium">
          {t('reports.wizard.review.summary', { defaultValue: 'Summary' })}
        </div>
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2 p-4 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)]">
          <Row label={t('reports.wizard.review.name', { defaultValue: 'Name' })} value={draft.name || '—'} />
          <Row
            label={t('reports.wizard.review.type', { defaultValue: 'Type' })}
            value={typeMeta ? t(typeMeta.labelKey, { defaultValue: typeMeta.fallback }) : draft.reportType}
          />
          <Row label={t('reports.wizard.review.source', { defaultValue: 'Source' })} value={sourceName} />
          <Row label={t('reports.wizard.review.columns', { defaultValue: 'Columns' })} value={String(draft.columns.length)} />
          <Row label={t('reports.wizard.review.filters', { defaultValue: 'Filters' })} value={String(draft.filters?.and?.length ?? 0)} />
          <Row label={t('reports.wizard.review.widgets', { defaultValue: 'Widgets' })} value={String(1 + draft.extraWidgets.length)} />
          <Row label={t('reports.wizard.review.params', { defaultValue: 'Parameters' })} value={String(draft.params.length)} />
          <Row label={t('reports.wizard.review.extraQueries', { defaultValue: 'Extra queries' })} value={String(draft.extraQueries.length)} />
        </dl>
      </div>

      {/* Access */}
      <div className="overflow-hidden rounded-lg border">
        <div className="border-b bg-muted/40 px-4 py-2 text-xs font-medium">
          {t('reports.wizard.review.access', { defaultValue: 'Access' })}
        </div>
        <div className="space-y-2 p-4 text-sm">
          <p className="text-muted-foreground">
            {t('reports.wizard.review.accessHint', {
              defaultValue: 'Tenant owners and admins always see this report. Add other members below to extend view or edit access.',
            })}
          </p>
          {!membersLoaded && (
            <div className="text-muted-foreground">
              {t('reports.wizard.review.loadingMembers', { defaultValue: 'Loading members…' })}
            </div>
          )}
          {membersLoaded && members.length === 0 && (
            <div className="text-muted-foreground">
              {t('reports.wizard.review.noMembers', { defaultValue: 'No other members in this workspace.' })}
            </div>
          )}
          <ul className="divide-y divide-border">
            {members.map((m) => {
              const mode = permissionMode(m.userId)
              return (
                <li key={m.userId} className="flex items-center gap-2 py-1.5">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{m.userEmail}</div>
                    <div className="text-xs text-muted-foreground">{t(`members.role.${m.role}`, { defaultValue: m.role })}</div>
                  </div>
                  {/* Owners and admins see every report; a toggle would be a lie. */}
                  {m.role === 'owner' || m.role === 'admin' ? (
                    <span className="text-xs text-muted-foreground">{t('reports.wizard.review.alwaysAccess', { defaultValue: 'Always has access' })}</span>
                  ) : (
                  <div className="inline-flex rounded-md border border-border overflow-hidden" role="group" aria-label={t('reports.wizard.review.accessFor', { defaultValue: 'Access for {{email}}', email: m.userEmail })}>
                    {(['none', 'view', 'edit'] as const).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setPermission(m.userId, opt)}
                        aria-pressed={mode === opt}
                        className={cn(
                          'border-e px-2.5 py-1 text-xs capitalize transition-colors last:border-e-0',
                          mode === opt
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-background text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {t(`reports.wizard.review.accessMode.${opt}`, { defaultValue: opt })}
                      </button>
                    ))}
                  </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>

      {/* JSON debug (collapsed) + download button */}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          {t('reports.wizard.review.specDebug', { defaultValue: 'View generated spec (advanced)' })}
        </summary>
        <div className="mt-2 space-y-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => downloadSpec(draft.name || 'report', spec)}
          >
            <Download className="w-3 h-3 me-1.5" />
            {t('reports.wizard.review.downloadSpec', { defaultValue: 'Download spec JSON' })}
          </Button>
          <pre className="p-3 bg-muted/40 rounded overflow-x-auto text-[10px] leading-tight">
            {JSON.stringify(spec, null, 2)}
          </pre>
        </div>
      </details>
    </div>
  )
}

/** Trigger a browser download of the current spec as JSON. Filename
 *  is a slugged version of the report name so exports are diffable
 *  across the tenant without renaming. */
function downloadSpec(name: string, spec: object) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'report'
  const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug}.report.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium" title={value}>{value}</dd>
    </>
  )
}
