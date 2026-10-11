/**
 * Create a solution (template → name, look and contents), edit its name /
 * description / look, or change what it holds. One component, three modes,
 * so every path shares the same identity fields and item picker.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  BLANK_TEMPLATE,
  SOLUTION_COLORS,
  SOLUTION_ICONS,
  SOLUTION_TEMPLATES,
  matchesKeywords,
  type SolutionTemplate,
} from '@/lib/solution-templates'
import {
  createSolution,
  replaceSolutionItems,
  solutionPath,
  updateSolution,
  type Solution,
  type SolutionItems,
} from '@/lib/solutions-client'
import { SolutionIcon } from './solution-identity'
import { SolutionItemPicker } from './solution-item-picker'
import { useSolutionCatalog, type SolutionCatalog } from './use-solution-catalog'

type Mode = 'create' | 'edit' | 'items'

const EMPTY: Required<SolutionItems> = { zoneIds: [], reportIds: [], dataSourceIds: [] }

function suggestedItems(catalog: SolutionCatalog, keywords: string[]): Required<SolutionItems> {
  if (keywords.length === 0) return EMPTY
  const zoneNames = new Map(catalog.zones.map((z) => [z.id!, z.name]))
  return {
    zoneIds: catalog.zones.filter((z) => matchesKeywords(`${z.name} ${z.address ?? ''}`, keywords)).map((z) => z.id!),
    reportIds: catalog.reports.filter((r) => matchesKeywords(`${r.name} ${r.zoneId ? zoneNames.get(r.zoneId) ?? '' : ''}`, keywords)).map((r) => r.id),
    dataSourceIds: [...catalog.tables, ...catalog.integrations]
      .filter((s) => matchesKeywords(`${s.name} ${s.zoneId ? zoneNames.get(s.zoneId) ?? '' : ''}`, keywords))
      .map((s) => s.id!),
  }
}

export function SolutionDialog({
  open,
  onOpenChange,
  mode,
  solution,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: Mode
  /** Required for `edit` / `items`. */
  solution?: Solution | null
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const catalog = useSolutionCatalog(open && mode !== 'edit')
  const [step, setStep] = useState<'template' | 'details'>(mode === 'create' ? 'template' : 'details')
  const [template, setTemplate] = useState<SolutionTemplate>(BLANK_TEMPLATE)
  const [name, setName] = useState(solution?.name ?? '')
  const [description, setDescription] = useState(solution?.description ?? '')
  const [icon, setIcon] = useState(solution?.icon || 'folder')
  const [color, setColor] = useState(solution?.color || BLANK_TEMPLATE.color)
  const [items, setItems] = useState<Required<SolutionItems>>(
    solution ? { zoneIds: solution.zoneIds, reportIds: solution.reportIds, dataSourceIds: solution.dataSourceIds } : EMPTY,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const total = items.zoneIds.length + items.reportIds.length + items.dataSourceIds.length
  const templateName = (tp: SolutionTemplate) => t(`solutions.template.${tp.key}.name`, { defaultValue: tp.fallbackName })

  const pickTemplate = (tp: SolutionTemplate) => {
    setTemplate(tp)
    setName(tp.id ? templateName(tp) : '')
    setDescription(tp.id ? t(`solutions.template.${tp.key}.description`, { defaultValue: tp.fallbackDescription }) : '')
    setIcon(tp.icon)
    setColor(tp.color)
    // Pre-tick what the template's keywords match; the user confirms.
    setItems(suggestedItems(catalog, tp.keywords))
    setStep('details')
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'create') {
        const created = await createSolution({ name: name.trim(), description: description.trim(), icon, color, template: template.id, ...items })
        onOpenChange(false)
        navigate(solutionPath(created.id))
      } else if (mode === 'edit' && solution) {
        await updateSolution(solution.id, { name: name.trim(), description: description.trim(), icon, color })
        onOpenChange(false)
      } else if (mode === 'items' && solution) {
        await replaceSolutionItems(solution.id, items)
        onOpenChange(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const title =
    mode === 'create'
      ? t('solutions.createTitle', { defaultValue: 'New solution' })
      : mode === 'edit'
        ? t('solutions.editTitle', { defaultValue: 'Edit solution' })
        : t('solutions.itemsTitle', { name: solution?.name ?? '', defaultValue: 'What’s in {{name}}' })
  const description_ =
    mode === 'create' && step === 'template'
      ? t('solutions.createBody', { defaultValue: 'Group the facilities, reports, tables and integrations for one use case. Nothing is moved or copied — an item can be in several solutions.' })
      : mode === 'items'
        ? t('solutions.itemsBody', { defaultValue: 'Tick what belongs here. Removing an item only takes it out of this solution.' })
        : t('solutions.detailsBody', { defaultValue: 'Give it a name and a look your team will recognise in the sidebar.' })

  const showIdentity = mode !== 'items' && step === 'details'
  const showItems = (mode === 'create' && step === 'details') || mode === 'items'

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="grid max-h-[min(90dvh,820px)] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden p-0">
        <DialogHeader className="space-y-1 border-b px-5 pb-4 pt-5 text-start">
          <DialogTitle className="flex items-center gap-2">
            {mode === 'create' && step === 'details' && (
              <button
                type="button"
                onClick={() => setStep('template')}
                aria-label={t('solutions.back', { defaultValue: 'Back' })}
                className="-ms-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
              </button>
            )}
            {title}
          </DialogTitle>
          <DialogDescription>{description_}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain px-5">
          {mode === 'create' && step === 'template' && (
            <ul className="sgv-fade grid grid-cols-1 gap-2 sm:grid-cols-2">
              {[...SOLUTION_TEMPLATES, BLANK_TEMPLATE].map((tp) => (
                <li key={tp.key}>
                  <button
                    type="button"
                    onClick={() => pickTemplate(tp)}
                    className="group flex w-full items-start gap-3 rounded-xl border bg-card p-3 text-start transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                  >
                    <SolutionIcon icon={tp.icon} color={tp.color} size="md" />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{templateName(tp)}</span>
                      <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                        {t(`solutions.template.${tp.key}.description`, { defaultValue: tp.fallbackDescription })}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {showIdentity && (
            <section className="sgv-fade space-y-4">
              <div className="flex items-start gap-3">
                <SolutionIcon icon={icon} color={color} size="lg" />
                <div className="min-w-0 flex-1 space-y-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium">{t('solutions.name', { defaultValue: 'Name' })}</span>
                    <input
                      autoFocus
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={80}
                      placeholder={t('solutions.namePlaceholder', { defaultValue: 'e.g. Hospital, Anti-theft' })}
                      className="h-9 w-full rounded-md border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium">{t('solutions.description', { defaultValue: 'Description' })}</span>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      maxLength={500}
                      rows={2}
                      placeholder={t('solutions.descriptionPlaceholder', { defaultValue: 'Optional — what this solution is for' })}
                      className="w-full resize-none rounded-md border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </label>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <fieldset>
                  <legend className="mb-1.5 text-xs font-medium">{t('solutions.icon', { defaultValue: 'Icon' })}</legend>
                  <div className="grid grid-cols-8 gap-1">
                    {Object.entries(SOLUTION_ICONS).map(([id, Icon]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setIcon(id)}
                        aria-pressed={icon === id}
                        aria-label={id}
                        title={id}
                        className={cn(
                          'flex aspect-square items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          icon === id ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )}
                      >
                        <Icon className="h-4 w-4" aria-hidden />
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="mb-1.5 text-xs font-medium">{t('solutions.color', { defaultValue: 'Colour' })}</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {SOLUTION_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setColor(c)}
                        aria-pressed={color === c}
                        aria-label={c}
                        className="flex h-7 w-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                        style={{ background: c, boxShadow: color === c ? `0 0 0 2px hsl(var(--background)), 0 0 0 4px ${c}` : undefined }}
                      >
                        {color === c && <Check className="h-3.5 w-3.5 text-white" aria-hidden />}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
            </section>
          )}

          {showItems && (
            <section className="sgv-fade space-y-2 pb-1">
              {mode === 'create' && (
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold">{t('solutions.contents', { defaultValue: 'Contents' })}</h3>
                  {template.keywords.length > 0 && (
                    <p className="text-xs text-muted-foreground">{t('solutions.preTicked', { defaultValue: 'Matching items are pre-ticked — adjust as you like.' })}</p>
                  )}
                </div>
              )}
              <SolutionItemPicker catalog={catalog} value={items} onChange={setItems} keywords={template.keywords} />
            </section>
          )}
        </div>

        {step === 'details' || mode !== 'create' ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3">
            {error && (
              <p className="me-auto text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
            {showItems && !error && (
              <p className="me-auto text-xs text-muted-foreground">
                {t('solutions.selectedCount', { count: total, defaultValue: '{{count}} items selected' })}
              </p>
            )}
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={busy || (showIdentity && !name.trim())}>
              {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
              {mode === 'create'
                ? t('solutions.create', { defaultValue: 'Create solution' })
                : t('solutions.save', { defaultValue: 'Save' })}
            </Button>
          </div>
        ) : (
          <div className="border-t px-5 py-3 text-end">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The member count per kind, for badges and summaries. */
export function useSolutionCounts(solution: Solution | null, catalog: SolutionCatalog) {
  return useMemo(() => {
    if (!solution) return { facilities: 0, reports: 0, tables: 0, integrations: 0 }
    const src = new Set(solution.dataSourceIds)
    return {
      facilities: solution.zoneIds.length,
      reports: solution.reportIds.length,
      tables: catalog.tables.filter((s) => src.has(s.id!)).length,
      integrations: catalog.integrations.filter((s) => src.has(s.id!)).length,
    }
  }, [solution, catalog])
}
