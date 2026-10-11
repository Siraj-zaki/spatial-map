/**
 * WizardShell — 2-pane layout inside the report builder:
 *   ┌────────────┬─────────────────────────────┐
 *   │ Step nav   │ Step title · hint           │
 *   │            │ [this step's issues]        │
 *   │ 1 Basics   │ Current step content        │
 *   │ 2 Source ● │                             │
 *   │ …          ├─────────────────────────────┤
 *   │            │ Back              Next / Save│
 *   └────────────┴─────────────────────────────┘
 *
 * The rail mirrors `stepsForType()`. It shows honest status: the current
 * step, and a dot on steps with validation issues (red = blocks saving,
 * amber = warning) — no "done" ticks, since visiting a step says
 * nothing about whether it's right. Below `lg` the rail becomes a step
 * picker at the top of the pane. Save itself lives in the page header
 * (always available); the footer's last step repeats it.
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleAlert, Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useWizard, type WizardStepId } from './wizard-state'
import { STEP_LABELS } from './wizard-steps'
import type { DraftIssue } from './wizard-validation'
import { BasicsStep } from './steps/basics-step'
import { SourceStep } from './steps/source-step'
import { ColumnsStep } from './steps/columns-step'
import { ViewerFiltersStep } from './steps/viewer-filters-step'
import { FiltersStep } from './steps/filters-step'
import { SortStep } from './steps/sort-step'
import { ConditionsStep } from './steps/conditions-step'
import { CustomColumnsStep } from './steps/custom-columns-step'
import { AggregationsStep } from './steps/aggregations-step'
import { EditFormStep } from './steps/edit-form-step'
import { HistoryConfigStep } from './steps/history-config-step'
import { ParamsStep } from './steps/params-step'
import { QueriesStep } from './steps/queries-step'
import { WidgetsStep } from './steps/widgets-step'
import { LayoutStep } from './steps/layout-step'
import { ReviewStep } from './steps/review-step'

export interface WizardShellProps {
  saving: boolean
  saveError: string | null
  onSave: () => void
  issues: DraftIssue[]
  saveLabel: string
  /** Nothing to save (editing, no changes) — mirrors the header's Save. */
  saveDisabled?: boolean
}

type StepStatus = 'blocking' | 'warning' | 'ok'

export function WizardShell({ saving, saveError, onSave, issues, saveLabel, saveDisabled = false }: WizardShellProps) {
  const { t } = useTranslation()
  const { draft, stepOrder, goTo, next, back } = useWizard()
  const currentIdx = stepOrder.indexOf(draft.currentStepId)
  const isLast = currentIdx === stepOrder.length - 1
  const isFirst = currentIdx === 0
  const current = STEP_LABELS[draft.currentStepId]
  const stepIssues = issues.filter((i) => i.step === draft.currentStepId)

  const statusOf = (id: WizardStepId): StepStatus =>
    issues.some((i) => i.step === id && i.blocking) ? 'blocking' : issues.some((i) => i.step === id) ? 'warning' : 'ok'

  // New step → start at its top.
  const paneRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    paneRef.current?.scrollTo({ top: 0 })
  }, [draft.currentStepId])

  const label = (id: WizardStepId) => t(STEP_LABELS[id].key, { defaultValue: STEP_LABELS[id].fallback })

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[232px_minmax(0,1fr)]">
      {/* Rail (lg+) */}
      <aside className="hidden min-h-0 flex-col overflow-hidden rounded-xl border bg-card lg:flex">
        <div className="border-b px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">
            {t('reports.wizard.stepEyebrow', { step: currentIdx + 1, total: stepOrder.length, defaultValue: 'Step {{step}} of {{total}}' })}
          </p>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${((currentIdx + 1) / stepOrder.length) * 100}%` }}
            />
          </div>
        </div>
        <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {stepOrder.map((id, idx) => {
            const isCurrent = idx === currentIdx
            const status = statusOf(id)
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => goTo(id)}
                  aria-current={isCurrent ? 'step' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isCurrent ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums',
                      isCurrent ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                    )}
                    aria-hidden
                  >
                    {idx + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{label(id)}</span>
                  {status !== 'ok' && (
                    <span
                      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', status === 'blocking' ? 'bg-danger' : 'bg-warning')}
                      title={
                        status === 'blocking'
                          ? t('reports.wizard.statusBlocking', { defaultValue: 'Needs fixing before you can save' })
                          : t('reports.wizard.statusWarning', { defaultValue: 'Needs attention' })
                      }
                    />
                  )}
                </button>
              </li>
            )
          })}
        </ol>
      </aside>

      {/* Pane */}
      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
        <header className="border-b px-5 py-4 sm:px-6">
          {/* Step picker below lg */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="mb-2 inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
              >
                {t('reports.wizard.stepEyebrow', { step: currentIdx + 1, total: stepOrder.length, defaultValue: 'Step {{step}} of {{total}}' })}
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {stepOrder.map((id, idx) => {
                const status = statusOf(id)
                return (
                  <DropdownMenuItem key={id} onSelect={() => goTo(id)}>
                    <span className="me-2 w-5 text-xs tabular-nums text-muted-foreground">{idx + 1}</span>
                    <span className="flex-1">{label(id)}</span>
                    {id === draft.currentStepId && <Check className="h-3.5 w-3.5" />}
                    {status !== 'ok' && id !== draft.currentStepId && (
                      <span className={cn('h-1.5 w-1.5 rounded-full', status === 'blocking' ? 'bg-danger' : 'bg-warning')} aria-hidden />
                    )}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <h2 className="text-lg font-semibold tracking-tight">{t(current.key, { defaultValue: current.fallback })}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t(`reports.wizard.stepHint.${draft.currentStepId}`, { defaultValue: current.hint })}
          </p>
        </header>

        <div ref={paneRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
          {stepIssues.length > 0 && draft.currentStepId !== 'review' && (
            <div
              className={cn(
                'mb-5 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm',
                stepIssues.some((i) => i.blocking) ? 'border-danger/30 bg-danger/5' : 'border-warning/30 bg-warning/5',
              )}
            >
              {stepIssues.some((i) => i.blocking) ? (
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
              ) : (
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              )}
              <ul className="space-y-0.5">
                {stepIssues.map((i, k) => (
                  <li key={k}>{i.message}</li>
                ))}
              </ul>
            </div>
          )}
          <div key={draft.currentStepId} className="sgv-fade">
            <StepContent id={draft.currentStepId} />
          </div>
        </div>

        {saveError && (
          <div role="alert" className="flex items-start gap-2 border-t border-danger/30 bg-danger/5 px-5 py-2.5 text-sm text-danger sm:px-6">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 whitespace-pre-line break-words">{saveError}</span>
          </div>
        )}

        <footer className="flex items-center gap-2 border-t bg-muted/20 px-4 py-3">
          <Button variant="outline" onClick={back} disabled={isFirst}>
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
            {t('reports.wizard.back', { defaultValue: 'Back' })}
          </Button>
          <div className="flex-1" />
          {isLast ? (
            <Button onClick={onSave} disabled={saving || saveDisabled}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Check className="h-4 w-4" />}
              {saveLabel}
            </Button>
          ) : (
            <Button onClick={next}>
              {t('reports.wizard.nextStep', { defaultValue: 'Next: {{step}}', step: label(stepOrder[currentIdx + 1]) })}
              <ArrowRight className="h-4 w-4 rtl:rotate-180" />
            </Button>
          )}
        </footer>
      </section>
    </div>
  )
}

/** Dispatcher — one lookup keeps the shell decoupled from step
 *  imports and makes new steps trivial to plug in. */
function StepContent({ id }: { id: WizardStepId }) {
  switch (id) {
    case 'basics':
      return <BasicsStep />
    case 'source':
      return <SourceStep />
    case 'columns':
      return <ColumnsStep />
    case 'filters':
      return <FiltersStep />
    case 'viewerFilters':
      return <ViewerFiltersStep />
    case 'sort':
      return <SortStep />
    case 'conditions':
      return <ConditionsStep />
    case 'customColumns':
      return <CustomColumnsStep />
    case 'aggregations':
      return <AggregationsStep />
    case 'editForm':
      return <EditFormStep />
    case 'historyConfig':
      return <HistoryConfigStep />
    case 'params':
      return <ParamsStep />
    case 'queries':
      return <QueriesStep />
    case 'widgets':
      return <WidgetsStep />
    case 'layout':
      return <LayoutStep />
    case 'review':
      return <ReviewStep />
    default:
      return null
  }
}
