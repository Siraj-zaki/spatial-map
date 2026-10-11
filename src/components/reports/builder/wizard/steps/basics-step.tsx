import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, Check, Globe2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useWizard } from '../wizard-state'
import { REPORT_TYPES as TYPES } from '../wizard-steps'
import { apiDb } from '@/lib/api-db'
import type { Zone } from '@/lib/db'

export function BasicsStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()

  // Zones for the facility dropdown. Loaded once; the report Directory
  // has its own zones fetch, but the wizard is mounted lazily and needs
  // its own copy. Small — one round-trip per open, no cache needed.
  const [zones, setZones] = useState<Zone[]>([])
  useEffect(() => {
    let cancelled = false
    apiDb.zones.toArray()
      .then((list) => { if (!cancelled) setZones(list.filter((z) => z.id !== undefined)) })
      .catch((err: unknown) => console.warn('[reports.wizard] zones load failed', err))
    return () => { cancelled = true }
  }, [])

  return (
    <div className="space-y-5 max-w-xl">
      <div className="space-y-1.5">
        <Label htmlFor="wiz-name" className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
          {t('reports.wizard.basics.name', { defaultValue: 'Name' })}
          <span className="text-destructive ms-1">*</span>
        </Label>
        <Input
          id="wiz-name"
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder={t('reports.wizard.basics.namePlaceholder', { defaultValue: 'e.g. Weekly warehouse throughput' })}
          maxLength={128}
          className="h-9"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wiz-desc" className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
          {t('reports.wizard.basics.description', { defaultValue: 'Description' })}
        </Label>
        <textarea
          id="wiz-desc"
          value={draft.description}
          onChange={(e) => update({ description: e.target.value })}
          placeholder={t('reports.wizard.basics.descriptionPlaceholder', { defaultValue: 'Optional — what this report is for' })}
          maxLength={1024}
          rows={2}
          className="block w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wiz-facility" className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
          {t('reports.wizard.basics.facility', { defaultValue: 'Facility' })}
        </Label>
        <select
          id="wiz-facility"
          value={draft.zoneId ?? ''}
          onChange={(e) => update({ zoneId: e.target.value === '' ? null : Number(e.target.value) })}
          className="block w-full rounded-md border border-input bg-background h-9 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">
            {t('reports.wizard.basics.facilityCross', { defaultValue: 'Cross-facility (shared)' })}
          </option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          {draft.zoneId == null ? (
            <>
              <Globe2 className="w-3 h-3" aria-hidden />
              {t('reports.wizard.basics.facilityHintCross', {
                defaultValue: 'Appears under every facility filter as "Shared".',
              })}
            </>
          ) : (
            <>
              <Building2 className="w-3 h-3" aria-hidden />
              {t('reports.wizard.basics.facilityHintScoped', {
                defaultValue: 'Only appears under this facility’s tab. You can change this later.',
              })}
            </>
          )}
        </p>
      </div>

      <div className="space-y-2 pt-2 border-t border-border">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
            {t('reports.wizard.basics.type', { defaultValue: 'Report type' })}
            <span className="text-destructive ms-1">*</span>
          </Label>
          <p className="text-xs text-muted-foreground mt-1">
            {t('reports.wizard.basics.typeHint', {
              defaultValue: 'The type sets which steps appear next — you can switch it later at any time.',
            })}
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 pt-2">
          {TYPES.map((type) => {
            const active = draft.reportType === type.id
            const Icon = type.icon
            return (
              <button
                key={type.id}
                type="button"
                onClick={() => update({ reportType: type.id })}
                className={cn(
                  'group relative flex items-start gap-3 rounded-lg border p-3 text-left transition-all',
                  active
                    ? 'border-primary bg-primary/10 ring-2 ring-primary/40 shadow-sm'
                    : 'border-border hover:border-primary/50 hover:bg-accent/50',
                )}
                aria-pressed={active}
              >
                {active && (
                  <div className="absolute top-2 end-2 h-4 w-4 rounded-full bg-primary flex items-center justify-center">
                    <Check className="h-2.5 w-2.5 text-primary-foreground" strokeWidth={3} />
                  </div>
                )}
                <div
                  className={cn(
                    'w-9 h-9 rounded-md flex items-center justify-center shrink-0',
                    active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1 pe-5">
                  <div className={cn('text-sm font-medium', active && 'text-primary')}>
                    {t(type.labelKey, { defaultValue: type.fallback })}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 leading-snug">
                    {t(type.hintKey, { defaultValue: type.hintFallback })}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
