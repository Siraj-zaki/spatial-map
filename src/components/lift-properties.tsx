/**
 * Side-panel fields for lifts drawn by the stair tool — escalators and
 * elevators. side-panel.tsx wraps these in its own `Section`s (this file
 * stays free of side-panel imports to avoid a module cycle).
 */

import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NumberInput } from '@/components/ui/number-input'
import { SliderRow } from '@/components/ui/slider-row'
import { Switch } from '@/components/ui/switch'
import { LIMIT_ELEVATION_M } from '@/lib/input-limits'
import { LIFT_TYPE_DEFAULTS, type StairShapeConfig, type StairType } from '@/lib/shapes'
import { formatLength, type LengthUnit } from '@/lib/units'
import { cn } from '@/lib/utils'
import {
  DEFAULT_LIFT_RISE_M,
  ESCALATOR_LANDING_M,
  ESCALATOR_STANDARD_ANGLE,
  escalatorGeometry,
  escalatorInclineIssue,
  liftScaleOf,
  resolveLiftLevels,
} from '@/lib/vertical-transport-generators'

function escalatorLandingOf(config: StairShapeConfig): number {
  return Math.min(5, Math.max(0.6, config.landingLength ?? ESCALATOR_LANDING_M))
}

/** A floor plan a lift can link to. */
export interface LiftFloorOption {
  id: number
  name: string
  elevation: number
}

/** Upper bound for manual elevator stops. */
const LIMIT_STOPS = 200

function elevationsOf(floors: readonly LiftFloorOption[]): Map<number, number> {
  return new Map(floors.map((f) => [f.id, f.elevation]))
}

/**
 * Config for switching the stair tool to another type. Lifts get their
 * starting values (LIFT_TYPE_DEFAULTS) plus floor links guessed from the
 * facility: an escalator from the floor at its base elevation (or the
 * lowest) to the next floor up; an elevator serving every floor.
 * Anything the user already linked is kept.
 */
export function configForStairType(
  config: StairShapeConfig,
  next: StairType,
  floors: readonly LiftFloorOption[],
): StairShapeConfig {
  if (next !== 'escalator' && next !== 'elevator') return { ...config, stairType: next }
  const out: StairShapeConfig = { ...config, ...(config.stairType === next ? {} : LIFT_TYPE_DEFAULTS[next]), stairType: next }
  const sorted = [...floors].sort((a, b) => a.elevation - b.elevation)
  if (next === 'escalator' && out.fromFloorPlanId === undefined && sorted.length >= 2) {
    const fromIdx = Math.max(
      0,
      sorted.findIndex((f) => Math.abs(f.elevation - config.baseElevation) < 0.05),
    )
    const from = sorted[Math.min(fromIdx, sorted.length - 2)]
    const to = sorted.find((f) => f.elevation > from.elevation + 0.05)
    if (to) {
      out.fromFloorPlanId = from.id
      out.toFloorPlanId = to.id
    }
  }
  if (next === 'elevator' && (out.servedFloorPlanIds ?? []).length === 0 && sorted.length >= 2) {
    out.servedFloorPlanIds = sorted.map((f) => f.id)
  }
  return withStoredLevels(out, floors)
}

/**
 * Keep the stored base / rise / stops equal to what the links resolve to,
 * so consumers without floor elevations (marker occlusion, exports) see
 * the same heights the overlay draws.
 */
export function withStoredLevels(config: StairShapeConfig, floors: readonly LiftFloorOption[]): StairShapeConfig {
  const levels = resolveLiftLevels(config, elevationsOf(floors))
  if (config.stairType === 'elevator') {
    const linked = (config.servedFloorPlanIds ?? []).length > 0
    return linked ? { ...config, baseElevation: levels.base, stops: levels.stops } : config
  }
  if (config.fromFloorPlanId !== undefined && config.toFloorPlanId !== undefined) {
    return { ...config, baseElevation: levels.base, rise: levels.rise }
  }
  return config
}

/** Segmented single choice (2–3 buttons). */
export function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (v: T) => void
}) {
  return (
    <div className={cn('grid gap-1.5', options.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
      {options.map(([id, label]) => (
        <Button key={id} type="button" size="sm" variant={value === id ? 'default' : 'outline'} onClick={() => onChange(id)} aria-pressed={value === id}>
          {label}
        </Button>
      ))}
    </div>
  )
}

function FloorSelect({
  label,
  value,
  floors,
  unit,
  onChange,
}: {
  label: string
  value: number | undefined
  floors: readonly LiftFloorOption[]
  unit: LengthUnit
  onChange: (id: number | undefined) => void
}) {
  const { t } = useTranslation()
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0">{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
        className="min-w-0 flex-1 h-8 px-2 text-xs rounded border bg-background"
      >
        <option value="">{t('sidePanel.lift.floorNone', { defaultValue: '— Not linked —' })}</option>
        {floors.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} · {formatLength(f.elevation, unit)}
          </option>
        ))}
      </select>
    </label>
  )
}

function StatusField({ config, onChange }: { config: StairShapeConfig; onChange: (next: StairShapeConfig) => void }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{t('sidePanel.lift.status', { defaultValue: 'Status' })}</Label>
      <Choice
        value={config.status ?? 'operational'}
        options={[
          ['operational', t('sidePanel.lift.statusOperational', { defaultValue: 'In service' })],
          ['out-of-service', t('sidePanel.lift.statusOutOfService', { defaultValue: 'Out of service' })],
        ]}
        onChange={(status) => onChange({ ...config, status })}
      />
    </div>
  )
}

function LengthField({
  label,
  value,
  unit,
  min,
  max,
  onChange,
  hint,
}: {
  label: string
  value: number
  unit: LengthUnit
  min: number
  max?: number
  onChange: (meters: number) => void
  hint?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center justify-between text-xs">
        <span>{label}</span>
        <span className="font-mono text-muted-foreground">{formatLength(value, unit)}</span>
      </Label>
      <NumberInput value={value} unit={unit} min={min} max={max} onChange={(m) => onChange(Math.max(min, m))} ariaLabel={label} />
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * Escalator fields. `drawnLength` is the clicked run (m), when known.
 * `onLengthChange` (placed escalators only) stretches the run to a new
 * length — it moves the end point and switches "fit to incline" off.
 */
export function EscalatorFields({
  config,
  onChange,
  floors,
  unit,
  drawnLength,
  onLengthChange,
}: {
  config: StairShapeConfig
  onChange: (next: StairShapeConfig) => void
  floors: readonly LiftFloorOption[]
  unit: LengthUnit
  drawnLength?: number
  onLengthChange?: (meters: number) => void
}) {
  const { t } = useTranslation()
  const set = (patch: Partial<StairShapeConfig>) => onChange(withStoredLevels({ ...config, ...patch }, floors))
  const linked = config.fromFloorPlanId !== undefined && config.toFloorPlanId !== undefined
  const levels = resolveLiftLevels(config, elevationsOf(floors))
  const geo = escalatorGeometry(config, levels.rise, drawnLength ?? 0)
  const fit = config.inclineFit !== false
  const issue = escalatorInclineIssue(geo.angle, levels.rise)
  const badge =
    issue === 'ok'
      ? 'border-success/40 bg-success/10 text-success'
      : issue === 'too-steep'
        ? 'border-danger/40 bg-danger/10 text-danger'
        : 'border-warning/40 bg-warning/10 text-warning'
  const issueText =
    issue === 'ok'
      ? t('sidePanel.lift.inclineOk', { defaultValue: 'Incline within EN 115 / ASME A17.1.' })
      : issue === 'too-steep'
        ? t('sidePanel.lift.inclineTooSteep', { defaultValue: 'Steeper than 35° — not allowed for escalators. Lengthen the run.' })
        : issue === 'steep'
          ? t('sidePanel.lift.inclineSteep', { defaultValue: 'Over 30° is only allowed up to 6 m rise. Lengthen the run or lower the angle.' })
          : t('sidePanel.lift.inclineShallow', { defaultValue: 'Unusually shallow (under 27°). Standard escalators run at 30°.' })
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">{t('sidePanel.lift.direction', { defaultValue: 'Direction' })}</Label>
        <Choice
          value={config.direction ?? 'up'}
          options={[
            ['up', t('sidePanel.lift.directionUp', { defaultValue: 'Up' })],
            ['down', t('sidePanel.lift.directionDown', { defaultValue: 'Down' })],
          ]}
          onChange={(direction) => set({ direction })}
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">{t('sidePanel.lift.layout', { defaultValue: 'Layout' })}</Label>
        <Choice
          value={config.escalatorLayout ?? 'single'}
          options={[
            ['single', t('sidePanel.lift.layoutSingle', { defaultValue: 'Single' })],
            ['pair', t('sidePanel.lift.layoutPair', { defaultValue: 'Up + down pair' })],
          ]}
          onChange={(escalatorLayout) => set({ escalatorLayout })}
        />
        {(config.escalatorLayout ?? 'single') === 'pair' && (
          <p className="text-[10px] text-muted-foreground">
            {t('sidePanel.lift.layoutPairHint', { defaultValue: 'The second unit sits to the right and runs the other way.' })}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <FloorSelect
          label={t('sidePanel.lift.fromFloor', { defaultValue: 'From floor' })}
          value={config.fromFloorPlanId}
          floors={floors}
          unit={unit}
          onChange={(fromFloorPlanId) => set({ fromFloorPlanId })}
        />
        <FloorSelect
          label={t('sidePanel.lift.toFloor', { defaultValue: 'To floor' })}
          value={config.toFloorPlanId}
          floors={floors}
          unit={unit}
          onChange={(toFloorPlanId) => set({ toFloorPlanId })}
        />
        <p className="text-[10px] text-muted-foreground">
          {linked
            ? t('sidePanel.lift.linkedHint', {
                defaultValue: 'Heights follow the linked floors — moving a floor plan up or down moves the escalator with it.',
              })
            : floors.length < 2
              ? t('sidePanel.lift.noFloorsHint', {
                  defaultValue: 'Add a floor plan for each level to link them. Until then, set the heights below.',
                })
              : t('sidePanel.lift.unlinkedHint', { defaultValue: 'Pick both floors to link the heights, or set them below.' })}
        </p>
      </div>
      {!linked && (
        <>
          <LengthField
            label={t('sidePanel.stairBaseElevation', { defaultValue: 'Base elevation' })}
            value={config.baseElevation}
            unit={unit}
            min={0}
            max={LIMIT_ELEVATION_M}
            onChange={(baseElevation) => set({ baseElevation })}
          />
          <LengthField
            label={t('sidePanel.lift.rise', { defaultValue: 'Rise (floor to floor)' })}
            value={config.rise ?? DEFAULT_LIFT_RISE_M}
            unit={unit}
            min={0.3}
            max={LIMIT_ELEVATION_M}
            onChange={(rise) => set({ rise })}
          />
        </>
      )}
      <LengthField
        label={t('sidePanel.lift.stepWidth', { defaultValue: 'Step width' })}
        value={config.width}
        unit={unit}
        min={0.4}
        max={2}
        onChange={(width) => set({ width })}
        hint={t('sidePanel.lift.stepWidthHint', { defaultValue: 'Standard sizes: 0.6, 0.8 or 1.0 m.' })}
      />
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-xs font-medium">{t('sidePanel.lift.inclineFit', { defaultValue: 'Fit length to incline' })}</div>
            <div className="text-[10px] text-muted-foreground leading-relaxed">
              {t('sidePanel.lift.inclineFitHint', {
                defaultValue: 'On: the drawn line sets the direction and the length follows the rise. Off: the drawn length is used.',
              })}
            </div>
          </div>
          <Switch
            checked={fit}
            onCheckedChange={(v) => set({ inclineFit: v })}
            aria-label={t('sidePanel.lift.inclineFit', { defaultValue: 'Fit length to incline' })}
          />
        </div>
        {onLengthChange && (
          <LengthField
            label={t('sidePanel.lift.length', { defaultValue: 'Length' })}
            value={geo.length}
            unit={unit}
            min={2 * escalatorLandingOf(config) + 0.5}
            max={500}
            onChange={onLengthChange}
            hint={t('sidePanel.lift.lengthHint', {
              defaultValue: 'Total footprint, landings included. Changing it uses this length and lets the incline follow.',
            })}
          />
        )}
        <LengthField
          label={t('sidePanel.lift.landingLength', { defaultValue: 'Flat landing' })}
          value={escalatorLandingOf(config)}
          unit={unit}
          min={0.6}
          max={5}
          onChange={(landingLength) => set({ landingLength })}
          hint={t('sidePanel.lift.landingLengthHint', { defaultValue: 'Flat run at each end before the incline (typically 1–2.5 m).' })}
        />
        {fit && (
          <SliderRow
            label={t('sidePanel.lift.inclineAngle', { defaultValue: 'Incline' })}
            value={config.inclineAngle ?? ESCALATOR_STANDARD_ANGLE}
            onChange={(inclineAngle) => set({ inclineAngle })}
            min={25}
            max={35}
            step={0.5}
            suffix="°"
          />
        )}
        <div className={cn('p-2 text-[11px] border rounded leading-relaxed space-y-0.5', badge)}>
          <div>
            {t('sidePanel.lift.geometrySummary', {
              defaultValue: '{{angle}}° incline · {{length}} long · rise {{rise}}',
              angle: geo.angle.toFixed(1),
              length: formatLength(geo.length, unit),
              rise: formatLength(levels.rise, unit),
            })}
          </div>
          <div>{issueText}</div>
        </div>
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-xs font-medium">{t('sidePanel.lift.animated', { defaultValue: 'Moving steps' })}</div>
          <div className="text-[10px] text-muted-foreground leading-relaxed">
            {t('sidePanel.lift.animatedHint', {
              defaultValue: 'Animates the treads in the travel direction. Keeps the map redrawing while visible; off when your system asks for reduced motion.',
            })}
          </div>
        </div>
        <Switch
          checked={config.animated === true}
          onCheckedChange={(animated) => set({ animated })}
          aria-label={t('sidePanel.lift.animated', { defaultValue: 'Moving steps' })}
        />
      </div>
      <StatusField config={config} onChange={(next) => set(next)} />
    </div>
  )
}

/** Elevator fields. */
export function ElevatorFields({
  config,
  onChange,
  floors,
  unit,
}: {
  config: StairShapeConfig
  onChange: (next: StairShapeConfig) => void
  floors: readonly LiftFloorOption[]
  unit: LengthUnit
}) {
  const { t } = useTranslation()
  const set = (patch: Partial<StairShapeConfig>) => onChange(withStoredLevels({ ...config, ...patch }, floors))
  const served = new Set(config.servedFloorPlanIds ?? [])
  const linked = served.size > 0
  const levels = resolveLiftLevels(config, elevationsOf(floors))
  const sortedServed = floors.filter((f) => served.has(f.id)).sort((a, b) => a.elevation - b.elevation)
  const stopLabel = (i: number) =>
    linked && sortedServed[i]
      ? sortedServed[i].name
      : t('sidePanel.lift.stopN', { defaultValue: 'Stop {{n}}', n: i + 1 })
  const toggleFloor = (id: number, on: boolean) => {
    const next = new Set(served)
    if (on) next.add(id)
    else next.delete(id)
    set({ servedFloorPlanIds: [...next], carStop: 0, stops: next.size > 0 ? undefined : config.stops })
  }
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">{t('sidePanel.lift.servedFloors', { defaultValue: 'Floors served' })}</Label>
        {floors.length > 0 ? (
          <div className="space-y-1 rounded-md border border-border/60 p-2">
            {[...floors]
              .sort((a, b) => b.elevation - a.elevation)
              .map((f) => (
                <label key={f.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={served.has(f.id)}
                    onChange={(e) => toggleFloor(f.id, e.target.checked)}
                  />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="font-mono text-muted-foreground">{formatLength(f.elevation, unit)}</span>
                </label>
              ))}
          </div>
        ) : null}
        <p className="text-[10px] text-muted-foreground">
          {linked
            ? t('sidePanel.lift.servedHint', {
                defaultValue: 'Doors open on each ticked floor and the shaft runs from the lowest to above the highest.',
              })
            : t('sidePanel.lift.servedNoneHint', {
                defaultValue: 'Tick the floors this lift serves, or set the stops by hand below.',
              })}
        </p>
      </div>
      {!linked && (
        <>
          <SliderRow
            label={t('sidePanel.lift.stopCount', { defaultValue: 'Stops' })}
            value={Math.max(2, Math.floor(config.stopCount ?? 2))}
            onChange={(v) => set({ stopCount: Math.max(2, Math.min(LIMIT_STOPS, Math.floor(v))), stops: undefined, carStop: 0 })}
            min={2}
            max={10}
            limitMax={LIMIT_STOPS}
            step={1}
          />
          <LengthField
            label={t('sidePanel.lift.floorHeight', { defaultValue: 'Floor to floor' })}
            value={config.floorHeight ?? DEFAULT_LIFT_RISE_M}
            unit={unit}
            min={0.5}
            max={LIMIT_ELEVATION_M}
            onChange={(floorHeight) => set({ floorHeight, stops: undefined })}
          />
          <LengthField
            label={t('sidePanel.stairBaseElevation', { defaultValue: 'Base elevation' })}
            value={config.baseElevation}
            unit={unit}
            min={0}
            max={LIMIT_ELEVATION_M}
            onChange={(baseElevation) => set({ baseElevation, stops: undefined })}
          />
        </>
      )}
      <label className="flex items-center gap-2 text-xs">
        <span className="w-20 shrink-0">{t('sidePanel.lift.carAt', { defaultValue: 'Car at' })}</span>
        <select
          value={Math.min(levels.stops.length - 1, Math.max(0, Math.floor(config.carStop ?? 0)))}
          onChange={(e) => set({ carStop: Number(e.target.value) })}
          className="min-w-0 flex-1 h-8 px-2 text-xs rounded border bg-background"
        >
          {levels.stops.map((z, i) => (
            <option key={i} value={i}>
              {stopLabel(i)} · {formatLength(z, unit)}
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-1.5">
        <Label className="text-xs">{t('sidePanel.lift.shaft', { defaultValue: 'Shaft' })}</Label>
        <Choice
          value={config.shaftStyle ?? 'glass'}
          options={[
            ['glass', t('sidePanel.lift.shaftGlass', { defaultValue: 'Glass' })],
            ['solid', t('sidePanel.lift.shaftSolid', { defaultValue: 'Solid' })],
          ]}
          onChange={(shaftStyle) => set({ shaftStyle })}
        />
      </div>
      <LengthField
        label={t('sidePanel.lift.depth', { defaultValue: 'Shaft depth' })}
        value={config.depth ?? 2.2}
        unit={unit}
        min={1.2}
        max={20}
        onChange={(depth) => set({ depth })}
        hint={t('sidePanel.lift.depthHint', { defaultValue: 'Measured back from the door side you drew.' })}
      />
      <LengthField
        label={t('sidePanel.lift.doorWidth', { defaultValue: 'Door width' })}
        value={config.doorWidth ?? 1.1}
        unit={unit}
        min={0.6}
        max={6}
        onChange={(doorWidth) => set({ doorWidth })}
      />
      <div className="space-y-1">
        <SliderRow
          label={t('sidePanel.lift.size')}
          value={Math.round(liftScaleOf(config) * 100)}
          onChange={(v) => set({ liftScale: Math.max(40, Math.min(100, v)) / 100 })}
          min={40}
          max={100}
          step={5}
          suffix="%"
        />
        <p className="text-[10px] text-muted-foreground">{t('sidePanel.lift.sizeHint')}</p>
      </div>
      <StatusField config={config} onChange={(next) => set(next)} />
    </div>
  )
}
