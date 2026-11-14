import { useEffect, useRef, useState } from 'react'
import { Check, Crosshair, MoveHorizontal, RotateCcw, RotateCw, Ruler, Square, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  combinedFactor,
  sampleErrorAfter,
  sampleMeasured,
  type CalibrationSample,
  type ImageFrame,
} from '@/lib/measure/calibration'
import type { LngLat } from '@/lib/measure/geometry'
import {
  AREA_SUFFIX,
  AREA_UNITS,
  areaUnitFor,
  formatMeasureArea,
  formatMeasureLength,
  parseLengthInput,
  toSquareMeters,
  type AreaUnit,
  type MeasureUnit,
} from '@/lib/measure/units'
import { cn } from '@/lib/utils'
import type { CalibrationMode, PendingCalibrationMark } from '@/routes/create-grids/state/useMeasureEditorState'

/** Error colour bands: within 3 % reads as good, within 10 % as rough. */
function errorTone(err: number | null): string {
  if (err === null) return 'text-muted-foreground'
  const a = Math.abs(err)
  if (a <= 0.03) return 'text-success'
  if (a <= 0.1) return 'text-warning'
  return 'text-destructive'
}

function formatPct(err: number): string {
  const pct = err * 100
  const sign = pct > 0.05 ? '+' : pct < -0.05 ? '−' : '±'
  return `${sign}${Math.abs(pct).toFixed(1)}%`
}

function parseArea(text: string): number | null {
  const s = text.trim().replace(',', '.')
  if (!/^\d*\.?\d+$/.test(s)) return null
  const n = Number(s)
  return n > 0 ? n : null
}

/**
 * Centre lat / lng editor — the one fact many floor plans come with.
 * Accepts a pasted "lat, lng" pair in the latitude box too.
 */
export function ImageCenterInputs({
  center,
  onChange,
}: {
  center: LngLat
  onChange: (center: LngLat) => void
}) {
  const { t } = useTranslation()
  const [lat, setLat] = useState(center[1].toFixed(7))
  const [lng, setLng] = useState(center[0].toFixed(7))
  // Follow outside changes (move tool, another tab) when not mid-edit.
  const editing = useRef(false)
  useEffect(() => {
    if (editing.current) return
    setLat(center[1].toFixed(7))
    setLng(center[0].toFixed(7))
  }, [center])

  const apply = () => {
    editing.current = false
    const pair = lat.split(/[,\s]+/).filter(Boolean)
    const la = Number(pair.length === 2 ? pair[0] : lat)
    const ln = Number(pair.length === 2 ? pair[1] : lng)
    if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
      setLat(center[1].toFixed(7))
      setLng(center[0].toFixed(7))
      return
    }
    onChange([ln, la])
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      apply()
    }
  }

  return (
    <div className="grid grid-cols-2 gap-2" dir="ltr">
      <label className="space-y-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('measure.centerLat')}</span>
        <Input
          value={lat}
          inputMode="decimal"
          onFocus={() => { editing.current = true }}
          onChange={(e) => setLat(e.target.value)}
          onBlur={apply}
          onKeyDown={onKeyDown}
          className="h-8 font-mono text-xs"
        />
      </label>
      <label className="space-y-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('measure.centerLng')}</span>
        <Input
          value={lng}
          inputMode="decimal"
          onFocus={() => { editing.current = true }}
          onChange={(e) => setLng(e.target.value)}
          onBlur={apply}
          onKeyDown={onKeyDown}
          className="h-8 font-mono text-xs"
        />
      </label>
    </div>
  )
}

interface CalibratePanelProps {
  imageName: string
  frame: ImageFrame
  unit: MeasureUnit
  mode: CalibrationMode
  onModeChange: (mode: CalibrationMode) => void
  hasFirstPick: boolean
  pending: PendingCalibrationMark | null
  onAddSample: (real: number) => void
  onCancelPending: () => void
  samples: CalibrationSample[]
  onToggleSample: (id: string) => void
  onDeleteSample: (id: string) => void
  onApplyScale: (factor: number) => void
  onRotate: (rotation: number) => void
  onCenterChange: (center: LngLat) => void
  onDone: () => void
}

const MODES: Array<{ id: CalibrationMode; icon: typeof Ruler }> = [
  { id: 'area', icon: Square },
  { id: 'length', icon: MoveHorizontal },
  { id: 'straighten', icon: RotateCw },
]

/**
 * Calibrate-scale panel. The user marks rooms (area) or known
 * dimensions (length) on the placed floor plan, types their real values,
 * and applies the averaged scale; straighten turns the plan so a picked
 * wall runs exactly across or up. Each mark shows how far off it is at
 * the suggested scale so inconsistent labels can be unticked.
 */
export function CalibratePanel({
  imageName,
  frame,
  unit,
  mode,
  onModeChange,
  hasFirstPick,
  pending,
  onAddSample,
  onCancelPending,
  samples,
  onToggleSample,
  onDeleteSample,
  onApplyScale,
  onRotate,
  onCenterChange,
  onDone,
}: CalibratePanelProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [areaUnit, setAreaUnit] = useState<AreaUnit>(() => areaUnitFor(unit))
  const valueRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!pending) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue('')
    // Focus after paint so the click that finished the mark doesn't steal it back.
    const id = requestAnimationFrame(() => valueRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [pending])

  const parsed = pending
    ? pending.kind === 'area'
      ? (() => {
          const n = parseArea(value)
          return n === null ? null : toSquareMeters(n, areaUnit)
        })()
      : parseLengthInput(value, unit)
    : null

  const submit = () => {
    if (parsed === null) return
    onAddSample(parsed)
    setValue('')
  }

  const factor = combinedFactor(frame, samples)
  const enabledCount = samples.filter((s) => s.enabled).length
  const matches = factor !== null && Math.abs(factor - 1) < 0.0005
  const fmtValue = (s: Pick<CalibrationSample, 'kind'>, v: number) =>
    s.kind === 'area' ? formatMeasureArea(v, areaUnit) : formatMeasureLength(v, unit)

  const instruction =
    mode === 'area'
      ? hasFirstPick ? t('measure.cal.areaSecond') : t('measure.cal.areaFirst')
      : mode === 'length'
        ? hasFirstPick ? t('measure.cal.lengthSecond') : t('measure.cal.lengthFirst')
        : hasFirstPick ? t('measure.cal.straightenSecond') : t('measure.cal.straightenFirst')

  return (
    <div
      className={cn(
        'absolute top-16 start-24 z-20 w-[min(360px,calc(100vw-7rem))] sm:start-28',
        'flex max-h-[calc(100dvh-6rem)] flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/95 shadow-xl ring-1 ring-black/[0.04] backdrop-blur-md',
      )}
      role="region"
      aria-label={t('measure.cal.title')}
    >
      <div className="flex items-start gap-2 border-b border-border/60 px-4 py-3">
        <Crosshair className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{t('measure.cal.title')}</div>
          <div className="truncate text-xs text-muted-foreground" title={imageName}>{imageName}</div>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onDone} aria-label={t('measure.cal.done')} title={t('measure.cal.done')}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {/* Mode */}
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label={t('measure.cal.modeLabel')}>
          {MODES.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => onModeChange(id)}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                mode === id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(`measure.cal.mode.${id}`)}
            </button>
          ))}
        </div>

        {/* Pending mark → real value */}
        {pending ? (
          <div className="space-y-2 rounded-lg border border-success/50 bg-success/5 p-3">
            <div className="text-xs font-medium">
              {pending.kind === 'area' ? t('measure.cal.enterArea') : t('measure.cal.enterLength')}
            </div>
            <div className="text-[11px] text-muted-foreground" dir="ltr">
              {t('measure.cal.onImageNow')}{' '}
              {fmtValue(pending, sampleMeasured(frame, pending))}
            </div>
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
              <Input
                ref={valueRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                inputMode="decimal"
                placeholder={pending.kind === 'area' ? '9.3' : t('measure.cal.lengthPlaceholder')}
                className="h-8 flex-1 font-mono text-sm"
                dir="ltr"
                aria-invalid={value !== '' && parsed === null}
              />
              {pending.kind === 'area' && (
                <select
                  value={areaUnit}
                  onChange={(e) => setAreaUnit(e.target.value as AreaUnit)}
                  className="h-8 rounded-md border border-input bg-background px-1.5 text-xs"
                  aria-label={t('measure.cal.areaUnit')}
                >
                  {AREA_UNITS.map((u) => (
                    <option key={u} value={u}>{AREA_SUFFIX[u]}</option>
                  ))}
                </select>
              )}
              <Button type="submit" size="sm" disabled={parsed === null}>
                <Check className="me-1 h-3.5 w-3.5" />
                {t('measure.cal.add')}
              </Button>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={onCancelPending} aria-label={t('measure.cal.cancelMark')} title={t('measure.cal.cancelMark')}>
                <X className="h-4 w-4" />
              </Button>
            </form>
            {pending.kind === 'length' && (
              <div className="text-[10px] text-muted-foreground">{t('measure.cal.lengthFormats')}</div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{instruction}</p>
        )}

        {/* Rotation */}
        {mode === 'straighten' && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 p-2">
            <span className="text-xs text-muted-foreground">
              {t('measure.cal.rotation')}{' '}
              <span className="font-mono text-foreground" dir="ltr">{frame.rotation.toFixed(1).replace(/\.0$/, '')}°</span>
            </span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => onRotate(norm(frame.rotation - 90))} title={t('measure.cal.rotateLeft')} aria-label={t('measure.cal.rotateLeft')}>
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => onRotate(norm(frame.rotation + 90))} title={t('measure.cal.rotateRight')} aria-label={t('measure.cal.rotateRight')}>
                <RotateCw className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onRotate(0)}>
                {t('measure.cal.rotationReset')}
              </Button>
            </div>
          </div>
        )}

        {/* Marks */}
        {samples.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>{t('measure.cal.marks')}</span>
              <span>{t('measure.cal.errorAtSuggested')}</span>
            </div>
            <ul className="space-y-1">
              {samples.map((s, i) => {
                const err = factor === null ? null : sampleErrorAfter(frame, s, factor)
                const Icon = s.kind === 'area' ? Square : MoveHorizontal
                return (
                  <li key={s.id} className={cn('flex items-center gap-2 rounded-md px-1.5 py-1 text-xs', !s.enabled && 'opacity-55')}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={() => onToggleSample(s.id)}
                      className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                      aria-label={t('measure.cal.useMark', { n: i + 1 })}
                    />
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate" dir="ltr">
                      <span className="font-medium">{fmtValue(s, s.real)}</span>
                      <span className="text-muted-foreground"> · {t('measure.cal.now')} {fmtValue(s, sampleMeasured(frame, s))}</span>
                    </span>
                    <span className={cn('font-mono tabular-nums', s.enabled ? errorTone(err) : 'text-muted-foreground')} dir="ltr">
                      {err === null ? '—' : formatPct(err)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onDeleteSample(s.id)}
                      className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={t('measure.cal.deleteMark')}
                      title={t('measure.cal.deleteMark')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                )
              })}
            </ul>
            <p className="text-[10px] text-muted-foreground">{t('measure.cal.marksHint')}</p>
          </div>
        )}

        {/* Result */}
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">{t('measure.cal.currentSize')}</span>
            <span className="font-mono" dir="ltr">
              {formatMeasureLength(frame.width, unit)} × {formatMeasureLength(frame.height, unit)}
            </span>
          </div>
          {factor !== null && !matches && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{t('measure.cal.suggestedSize')}</span>
              <span className="font-mono font-semibold" dir="ltr">
                {formatMeasureLength(frame.width * factor, unit)} × {formatMeasureLength(frame.height * factor, unit)}
              </span>
            </div>
          )}
          {enabledCount === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t('measure.cal.noMarks')}</p>
          ) : matches ? (
            <p className="flex items-center gap-1.5 text-[11px] text-success">
              <Check className="h-3.5 w-3.5" />
              {t('measure.cal.matches')}
            </p>
          ) : (
            <Button className="w-full" size="sm" onClick={() => factor !== null && onApplyScale(factor)}>
              {t('measure.cal.apply', { pct: ((factor ?? 1) * 100).toFixed(1) })}
            </Button>
          )}
        </div>

        {/* Centre */}
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('measure.cal.center')}</div>
          <ImageCenterInputs center={frame.center} onChange={onCenterChange} />
          <p className="text-[10px] text-muted-foreground">{t('measure.cal.centerHint')}</p>
        </div>
      </div>

      <div className="flex justify-end border-t border-border/60 px-4 py-2.5">
        <Button size="sm" variant="secondary" onClick={onDone}>{t('measure.cal.done')}</Button>
      </div>
    </div>
  )
}

function norm(deg: number): number {
  let d = ((deg % 360) + 360) % 360
  if (d > 180) d -= 360
  return d
}
