import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  Box,
  BrickWall,
  Building2,
  Database,
  DoorOpen,
  Footprints,
  Globe,
  Grid3x3,
  Layers,
  Loader2,
  MapPin,
  MoveVertical,
  Shapes,
  Type,
  Upload,
  Webhook,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { listReportSources, type ReportSourceHint } from '@/lib/reports-client'
import { useWizard } from '../wizard-state'

const KIND_ICON: Record<string, typeof Database> = {
  table: Database,
  rest: Globe,
  webhook: Webhook,
  file: Upload,
  facility: Building2,
}

const FACILITY_ICON: Record<string, typeof Database> = {
  floors: Layers,
  areas: Shapes,
  racks: Grid3x3,
  markers: MapPin,
  walls: BrickWall,
  doors: DoorOpen,
  stairs: Footprints,
  lifts: MoveVertical,
  escalators: MoveVertical,
  'text-labels': Type,
  models: Box,
}

export function SourceStep() {
  const { t } = useTranslation()
  const { draft, update } = useWizard()
  const [sources, setSources] = useState<ReportSourceHint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Mount-only fetch — `loading` starts true and `error` null, so
  // there's nothing to reset before the request goes out.
  useEffect(() => {
    let cancelled = false
    listReportSources()
      .then((r) => {
        if (!cancelled) setSources(r)
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const activeId = draft.sourceRef?.id ?? null

  // Your data (tables, integrations, files) first, then the facility's
  // own shapes — built in, always there.
  const groups = [
    {
      key: 'data',
      title: t('reports.facility.groupData', { defaultValue: 'Your data' }),
      hint: null as string | null,
      items: sources.filter((s) => s.kind !== 'facility'),
    },
    {
      key: 'facility',
      title: t('reports.facility.groupFacility', { defaultValue: 'Facility' }),
      hint: t('reports.facility.groupFacilityHint', {
        defaultValue: 'Everything drawn on the map, read live. Filter by Facility to report on one site.',
      }),
      items: sources.filter((s) => s.kind === 'facility'),
    },
  ]

  // Editable reports need a writable source: a table (row PATCH) or a
  // built-in facility source (shape PATCH). The rest are shown but
  // disabled with a hint.
  const editableOnly = draft.reportType === 'editable'

  return (
    <div className="space-y-4 max-w-2xl">
      {editableOnly && (
        <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            {t('reports.wizard.source.editableHint', {
              defaultValue: 'Editable reports work with tables and the built-in facility sources — REST, webhook, and file imports are read-only.',
            })}
          </span>
        </div>
      )}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('reports.wizard.source.loading', { defaultValue: 'Loading sources…' })}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {!loading && !error && sources.length === 0 && (
        <div className="text-sm text-muted-foreground italic py-6 text-center border-2 border-dashed border-border rounded-md">
          {t('reports.wizard.source.empty', {
            defaultValue: 'No data sources yet — create a table, integration, or webhook first.',
          })}
        </div>
      )}
      {groups.map((g) =>
        g.items.length === 0 ? null : (
          <section key={g.key} className="space-y-2">
            {(g.key === 'facility' || groups.filter((x) => x.items.length > 0).length > 1) && (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{g.title}</h3>
                {g.hint && <p className="mt-0.5 text-xs text-muted-foreground">{g.hint}</p>}
              </div>
            )}
            <div className={cn('grid gap-2', g.key === 'facility' && 'sm:grid-cols-2')}>
              {g.items.map((s) => {
                const active = s.id === activeId
                const Icon = (s.facilityEntity && FACILITY_ICON[s.facilityEntity]) || KIND_ICON[s.kind] || Database
                const disabled = editableOnly && s.kind !== 'table' && s.kind !== 'facility'
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => update({ sourceRef: { kind: 'dataSource', id: s.id } })}
                    className={cn(
                      'group flex items-center gap-3 rounded-md border p-3 text-left transition-colors',
                      active && !disabled && 'border-primary bg-primary/5',
                      !active && !disabled && 'border-border hover:border-primary/50 hover:bg-accent/50',
                      disabled && 'opacity-50 cursor-not-allowed border-border',
                    )}
                    aria-pressed={active}
                  >
                    <div
                      className={cn(
                        'w-8 h-8 rounded-md flex items-center justify-center shrink-0',
                        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{s.name}</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">
                        {s.kind === 'facility'
                          ? t('reports.facility.builtIn', { defaultValue: 'Built-in' })
                          : <>{s.kind}{s.entityKind && ` · ${s.entityKind}`}</>}
                      </div>
                    </div>
                    {disabled && (
                      <span className="text-[10px] text-warning">
                        {t('reports.wizard.source.notEditable', { defaultValue: 'not editable' })}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        ),
      )}
    </div>
  )
}
