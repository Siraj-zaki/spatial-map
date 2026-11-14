import { useState } from 'react'
import { Eye, EyeOff, Image as ImageIcon, Lock, LockOpen, Ruler, Tag, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { MEASURE_UNITS, type MeasureUnit } from '@/lib/measure/units'
import { cn } from '@/lib/utils'
import { ANGLE_STEPS, type MeasureSettings } from '@/routes/create-grids/state/useMeasureEditorState'

interface DraftingBarProps {
  settings: MeasureSettings
  onSettingsChange: (patch: Partial<MeasureSettings>) => void
  guideCount: number
  guidesVisible: boolean
  onGuidesVisibleChange: (visible: boolean) => void
  onClearGuides: () => void
  planVisible: boolean
  onPlanVisibleChange: (visible: boolean) => void
}

const btn =
  'flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const selectCls =
  'h-7 rounded-md border border-input bg-background px-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * Floating drafting controls shown while a vertex tool (wall, polygon,
 * Measure) is active: measurement unit, angle lock + step, dimension
 * labels, and show / hide for guides and the floor plan so the user can
 * compare their drawing against the plan underneath.
 */
export function DraftingBar({
  settings,
  onSettingsChange,
  guideCount,
  guidesVisible,
  onGuidesVisibleChange,
  onClearGuides,
  planVisible,
  onPlanVisibleChange,
}: DraftingBarProps) {
  const { t } = useTranslation()
  const [confirmClear, setConfirmClear] = useState(false)
  const unitLabel = (u: MeasureUnit) => t(`measure.unit.${u}`)

  return (
    <div
      className="pointer-events-auto absolute bottom-16 start-1/2 z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-2xl border border-border/60 bg-card/95 p-1.5 shadow-lg backdrop-blur-md rtl:translate-x-1/2"
      role="toolbar"
      aria-label={t('measure.barLabel')}
      data-shortcut-ignore
    >
      <label className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
        <Ruler className="h-3.5 w-3.5" aria-hidden />
        <span className="sr-only">{t('measure.unitLabel')}</span>
        <select
          value={settings.unit}
          onChange={(e) => onSettingsChange({ unit: e.target.value as MeasureUnit })}
          className={selectCls}
          title={t('measure.unitLabel')}
        >
          {MEASURE_UNITS.map((u) => (
            <option key={u} value={u}>{unitLabel(u)}</option>
          ))}
        </select>
      </label>

      <div className="h-5 w-px bg-border/60" aria-hidden />

      <button
        type="button"
        onClick={() => onSettingsChange({ angleLock: !settings.angleLock })}
        className={cn(btn, settings.angleLock && 'bg-primary/10 text-primary')}
        aria-pressed={settings.angleLock}
        title={t('measure.angleLockTitle')}
      >
        {settings.angleLock ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
        {t('measure.angleLock')}
      </button>
      <select
        value={settings.angleStep}
        onChange={(e) => onSettingsChange({ angleStep: Number(e.target.value) })}
        className={selectCls}
        title={t('measure.angleStepTitle')}
        aria-label={t('measure.angleStepTitle')}
        dir="ltr"
      >
        {ANGLE_STEPS.map((s) => (
          <option key={s} value={s}>{s}°</option>
        ))}
      </select>

      <div className="h-5 w-px bg-border/60" aria-hidden />

      <button
        type="button"
        onClick={() => onSettingsChange({ showLabels: !settings.showLabels })}
        className={cn(btn, settings.showLabels && 'bg-primary/10 text-primary')}
        aria-pressed={settings.showLabels}
        title={t('measure.labelsTitle')}
      >
        <Tag className="h-3.5 w-3.5" />
        {t('measure.labels')}
      </button>
      <button
        type="button"
        onClick={() => onGuidesVisibleChange(!guidesVisible)}
        className={cn(btn, guidesVisible && 'bg-primary/10 text-primary')}
        aria-pressed={guidesVisible}
        title={guidesVisible ? t('measure.hideGuides') : t('measure.showGuides')}
      >
        {guidesVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        {t('measure.guides')}
        <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{guideCount}</span>
      </button>
      {guideCount > 0 && (
        <button
          type="button"
          onClick={() => {
            if (confirmClear) {
              onClearGuides()
              setConfirmClear(false)
            } else {
              setConfirmClear(true)
            }
          }}
          onBlur={() => setConfirmClear(false)}
          className={cn(btn, 'text-destructive hover:bg-destructive/10 hover:text-destructive')}
          title={t('measure.clearGuidesTitle')}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {confirmClear ? t('measure.clearGuidesConfirm') : t('measure.clearGuides')}
        </button>
      )}
      <button
        type="button"
        onClick={() => onPlanVisibleChange(!planVisible)}
        className={cn(btn, planVisible && 'bg-primary/10 text-primary')}
        aria-pressed={planVisible}
        title={planVisible ? t('measure.hidePlan') : t('measure.showPlan')}
      >
        <ImageIcon className="h-3.5 w-3.5" />
        {t('measure.plan')}
      </button>

      <div className="hidden w-full px-1.5 pt-0.5 text-center text-[10px] text-muted-foreground sm:block">
        {t('measure.barHint')}
      </div>
    </div>
  )
}
