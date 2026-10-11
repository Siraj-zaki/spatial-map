/**
 * ReportBuilder — thin shell around the multi-step wizard.
 *
 * Responsibilities:
 *   1. Load the report on `/reports/:id/edit`, migrate its spec to v2,
 *      flatten into wizard draft state. Skeleton while loading;
 *      not-found for a bad id / 404; `QueryError` otherwise.
 *   2. Provide the WizardProvider context so every step can read +
 *      mutate the draft without prop drilling.
 *   3. Own saving (2026-09 redesign):
 *      - Save is in the page header on every step (and ⌘/Ctrl+S), not
 *        only on the last one — editing one column shouldn't mean
 *        clicking through twelve steps.
 *      - Only *blocking* issues (`wizard-validation.ts`) stop a save;
 *        Save then jumps to the first step that needs fixing.
 *      - Dirty tracking against the loaded spec: the header says
 *        "Unsaved changes" / "All changes saved", closing the tab warns
 *        (beforeunload), and Back/Cancel ask before discarding.
 *      - Success → toast and on to the viewer.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Check, ChevronLeft, FileSearch, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { QueryError } from '@/components/feedback/query-error'
import { ApiError } from '@/lib/api-client'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'
import { createReport, getReport, updateReport, type Report, type ReportSpec } from '@/lib/reports-client'
import { addSolutionItems } from '@/lib/solutions-client'
import { REPORT_SPEC_VERSION } from '@/lib/reports/v2-types'
import { useSpatialStore } from '@/lib/spatial-store'
import { WizardProvider, emptyDraft, useWizard, type WizardDraft } from './builder/wizard/wizard-state'
import { WizardShell } from './builder/wizard/wizard-shell'
import { loadDraft, toV2Spec } from './builder/wizard/wizard-serialisation'
import { validateDraft } from './builder/wizard/wizard-validation'

export function ReportBuilder() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation()
  const isEdit = Boolean(id)
  const reportId = Number(id)
  const validId = !isEdit || (Number.isInteger(reportId) && reportId > 0)

  // Default facility for NEW reports = the warehouse the user is
  // currently viewing (from spatial-store). Existing reports override
  // this in loadDraft(). null means "cross-facility" — the user can
  // switch via the Basics-step dropdown.
  const activeZoneId = useSpatialStore((s) => s.activeZoneId)
  const [newDraft] = useState<WizardDraft>(() => ({ ...emptyDraft(), zoneId: activeZoneId ?? null }))

  const [reloadToken, setReloadToken] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; report: Report | null; draft: WizardDraft | null; error: unknown } | null>(null)
  const queryKey = `${id}:${reloadToken}`

  // Load the existing report once and hand a hydrated draft to the
  // wizard. Fresh reports skip the fetch entirely.
  useEffect(() => {
    if (!isEdit || !validId) return
    let cancelled = false
    getReport(reportId)
      .then((r) => {
        if (!cancelled) setLoaded({ key: queryKey, report: r, draft: loadDraft(r), error: null })
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoaded({ key: queryKey, report: null, draft: null, error })
      })
    return () => {
      cancelled = true
    }
  }, [isEdit, validId, reportId, queryKey])

  const current = loaded?.key === queryKey ? loaded : null
  const back = (
    <Link
      to="/reports"
      className="inline-flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
      {t('reports.backToDirectory', { defaultValue: 'All reports' })}
    </Link>
  )

  if (!isEdit) {
    return (
      <WizardProvider initialDraft={newDraft}>
        <BuilderChrome existing={null} initialDraft={newDraft} />
      </WizardProvider>
    )
  }

  if (!validId || (current?.error instanceof ApiError && current.error.status === 404)) {
    return (
      <Frame>
        {back}
        <EmptyState
          icon={FileSearch}
          title={t('reports.viewer.notFoundTitle', { defaultValue: 'Report not found' })}
          description={t('reports.viewer.notFoundBody', { defaultValue: 'It may have been archived, or it belongs to another workspace.' })}
        />
      </Frame>
    )
  }
  if (current?.error) {
    return (
      <Frame>
        {back}
        <QueryError error={current.error} onRetry={() => setReloadToken((n) => n + 1)} what={t('reports.viewer.what', { defaultValue: 'this report' })} />
      </Frame>
    )
  }
  if (!current?.report || !current.draft) {
    return (
      <Frame>
        {back}
        <BuilderSkeleton />
      </Frame>
    )
  }

  return (
    <WizardProvider key={current.key} initialDraft={current.draft}>
      <BuilderChrome existing={current.report} initialDraft={current.draft} />
    </WizardProvider>
  )
}

/** What a save would persist — compared against the loaded version to
 *  tell whether there's anything unsaved. The current step isn't part
 *  of it: moving between steps changes nothing. */
function snapshot(d: WizardDraft): string {
  return JSON.stringify({
    spec: toV2Spec(d),
    name: d.name.trim(),
    description: d.description.trim(),
    icon: d.icon,
    color: d.color,
    zoneId: d.zoneId,
    permissions: d.permissions,
  })
}

/** Inner chrome — has access to the wizard context and owns saving. */
function BuilderChrome({ existing, initialDraft }: { existing: Report | null; initialDraft: WizardDraft }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { draft, goTo } = useWizard()
  const isEdit = existing !== null

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [baseline, setBaseline] = useState(() => snapshot(initialDraft))
  const [confirmLeave, setConfirmLeave] = useState(false)
  // A new report starts empty — flagging "needs a name" before anyone
  // has typed is noise. Its issues surface after the first save attempt;
  // an existing report's show at once (they describe what's saved).
  const [attempted, setAttempted] = useState(false)

  const current = useMemo(() => snapshot(draft), [draft])
  const dirty = current !== baseline
  const issues = useMemo(() => validateDraft(draft, t), [draft, t])
  const blocking = issues.filter((i) => i.blocking)
  // A "can't save yet" message goes stale the moment its causes are fixed.
  const [prevBlocking, setPrevBlocking] = useState(blocking.length)
  if (prevBlocking !== blocking.length) {
    setPrevBlocking(blocking.length)
    if (blocking.length === 0 && saveError) setSaveError(null)
  }

  // Closing / reloading the tab with unsaved work → the browser's prompt.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const leaveTo = isEdit ? `/reports/${existing.id}` : '/reports'
  const leave = () => (dirty ? setConfirmLeave(true) : navigate(leaveTo))

  const save = useCallback(async () => {
    if (saving) return
    setAttempted(true)
    if (blocking.length > 0) {
      goTo(blocking[0].step)
      setSaveError(
        t('reports.wizard.saveBlocked', {
          defaultValue: 'Can’t save yet: {{list}}',
          list: blocking.map((i) => i.message).join(' '),
        }),
      )
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const spec = toV2Spec(draft) as unknown as ReportSpec
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        spec,
        specVersion: REPORT_SPEC_VERSION,
        zoneId: draft.zoneId,
        permissions: draft.permissions,
      }
      let savedId: number
      if (existing) {
        await updateReport(existing.id, { ...body, icon: draft.icon, color: draft.color })
        savedId = existing.id
      } else {
        const created = await createReport({ ...body, icon: draft.icon || undefined, color: draft.color || undefined })
        savedId = created.id
        // Built from inside a solution (/reports/new?solution=…) → it joins it.
        const solutionId = Number(new URLSearchParams(window.location.search).get('solution'))
        if (Number.isInteger(solutionId) && solutionId > 0) {
          await addSolutionItems(solutionId, { reportIds: [created.id] }).catch(() => undefined)
        }
      }
      setBaseline(snapshot(draft))
      toast.success(
        existing
          ? t('reports.wizard.saved', { defaultValue: '“{{name}}” saved', name: body.name })
          : t('reports.wizard.created', { defaultValue: '“{{name}}” created', name: body.name }),
      )
      navigate(`/reports/${savedId}`)
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, blocking, goTo, t, draft, existing, navigate])

  // ⌘S / Ctrl+S saves from anywhere in the builder.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  const saveLabel = isEdit
    ? t('reports.wizard.saveChanges', { defaultValue: 'Save changes' })
    : t('reports.wizard.createReport', { defaultValue: 'Create report' })

  return (
    <Frame>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 space-y-1">
          <button
            type="button"
            onClick={leave}
            className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
            {isEdit
              ? t('reports.wizard.backToReport', { defaultValue: 'Back to report' })
              : t('reports.backToDirectory', { defaultValue: 'All reports' })}
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
              {draft.name.trim() || t('reports.wizard.untitled', { defaultValue: 'Untitled report' })}
            </h1>
            <Badge variant="muted" className="shrink-0">
              {isEdit ? t('reports.wizard.badgeEditing', { defaultValue: 'Editing' }) : t('reports.wizard.badgeNew', { defaultValue: 'New' })}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-1.5 text-sm text-muted-foreground sm:inline-flex" aria-live="polite">
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                {t('common.saving', { defaultValue: 'Saving…' })}
              </>
            ) : dirty ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
                {t('reports.wizard.unsaved', { defaultValue: 'Unsaved changes' })}
              </>
            ) : isEdit ? (
              <>
                <Check className="h-3.5 w-3.5 text-success" aria-hidden />
                {t('reports.wizard.allSaved', { defaultValue: 'All changes saved' })}
              </>
            ) : null}
          </span>
          <Button variant="ghost" onClick={leave} disabled={saving}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || (isEdit && !dirty)}
            title={t('reports.wizard.saveShortcut', { defaultValue: 'Save (⌘S)' })}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Check className="h-4 w-4" />}
            {saveLabel}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <WizardShell
          saving={saving}
          saveError={saveError}
          onSave={() => void save()}
          issues={isEdit || attempted ? issues : []}
          saveLabel={saveLabel}
          saveDisabled={isEdit && !dirty}
        />
      </div>

      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title={t('reports.wizard.discardTitle', { defaultValue: 'Discard unsaved changes?' })}
        description={t('reports.wizard.discardBody', { defaultValue: 'Your edits to this report will be lost.' })}
        confirmLabel={t('reports.wizard.discard', { defaultValue: 'Discard changes' })}
        onConfirm={() => {
          setConfirmLeave(false)
          setBaseline(current)
          navigate(leaveTo)
        }}
      />
    </Frame>
  )
}

/** Viewport-locked page frame: the wizard's panes scroll internally,
 *  so there's exactly one scroll region per pane (no page scroll
 *  competing with them). Same width + gutters as `PageContainer`. */
function Frame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="h-full overflow-hidden">
      <div className={cn('mx-auto flex h-full w-full max-w-[1400px] flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8 lg:py-6', className)}>
        {children}
      </div>
    </div>
  )
}

function BuilderSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5" aria-busy>
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-64" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[232px_minmax(0,1fr)]">
        <div className="hidden space-y-2 rounded-xl border bg-card p-3 lg:block">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-7" />
          ))}
        </div>
        <div className="space-y-4 rounded-xl border bg-card p-6">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-10 w-full max-w-md" />
          <Skeleton className="h-20 w-full max-w-md" />
          <Skeleton className="h-10 w-full max-w-md" />
        </div>
      </div>
    </div>
  )
}
