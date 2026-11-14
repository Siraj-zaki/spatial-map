/**
 * Turn-by-turn directions panel, for one floor or several.
 *
 * A floating card with the chosen route's summary (distance, time, turns,
 * floor changes), the route options when there are several (Fastest /
 * Step-free / Other route), and the ordered steps: walking instructions
 * grouped under the floor they are on, and a "Take Stairs 1 up to First
 * Floor" row at every floor change. Used in the editor and the viewer.
 *
 * Failure states surface as a red status card with a short reason
 * instead of an empty or misleading instruction list — including floors
 * that no stairs, lift or escalator connects.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpLeft,
  ArrowUpRight,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  Footprints,
  Layers,
  Navigation,
  RotateCcw,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  cardinalFromBearing,
  formatDistanceMeters,
  type Instruction,
  type TurnKind,
} from '@/lib/routing/directions'
import { stepsOf, type Floor, type RouteOption, type Step } from '@/lib/routing/floors'
import type { RoutePlanStatus } from '@/routes/create-grids/hooks/useRoutePreviewTool'

interface Props {
  /** Planner status; null while no route has been asked for. */
  status: RoutePlanStatus | null
  /** Route options (fastest first); empty unless status is ok. */
  options: RouteOption[]
  selected: number
  onSelect?: (i: number) => void
  floors: Floor[]
  /** Called when the user clicks the ✕ button to dismiss the current route. */
  onClear?: () => void
  /**
   * Alignment: `right` docks next to the editor's tool rail; `left`
   * docks to the left (viewer, so it doesn't collide with the search
   * pill). Both use `top-16` so the app header doesn't obscure them.
   */
  side?: 'left' | 'right'
}

/** Map turn kind → lucide icon component. Keep this the ONLY per-kind icon table. */
const TURN_ICON: Record<TurnKind, typeof ArrowRight> = {
  start: Navigation,
  straight: ArrowUp,
  'slight-left': ArrowUpLeft,
  left: CornerUpLeft,
  'sharp-left': CornerUpLeft,
  'slight-right': ArrowUpRight,
  right: CornerUpRight,
  'sharp-right': CornerUpRight,
  'u-turn': RotateCcw,
  arrive: Flag,
}

export function RouteDirectionsPanel({ status, options, selected, onSelect, floors, onClear, side = 'right' }: Props) {
  const { t } = useTranslation()
  const option = status === 'ok' ? options[selected] ?? options[0] : undefined
  const steps = useMemo<Step[]>(() => (option ? stepsOf(option) : []), [option])
  const multiFloor = !!option && option.transitions.length > 0

  if (!status) return null

  // The editor's toolbar rail sits at left-4 with width w-14 (56 px)
  // + padding, so 96 px of left-inset keeps the panel clear of the
  // rail. The viewer has no left rail; 16 px is enough there.
  const positionClass = side === 'left' ? 'left-4 sm:left-6' : 'left-24 sm:left-28'
  const floorName = (id: number | null) => floors.find((f) => f.id === id)?.name ?? ''
  const turns = steps.filter((s) => s.kind === 'walk' && s.instruction.kind !== 'start' && s.instruction.kind !== 'arrive').length

  return (
    <div
      className={cn(
        'absolute top-16 z-20 w-[min(360px,calc(100vw-2rem))]',
        'bg-card/95 border border-border/60 rounded-2xl shadow-xl ring-1 ring-black/[0.04] backdrop-blur-md',
        'flex flex-col max-h-[calc(100dvh-6rem)] overflow-hidden',
        positionClass,
      )}
      role="region"
      aria-label={t('routePanel.title')}
    >
      {!option ? (
        <ErrorHeader status={status} onClear={onClear} />
      ) : (
        <OkHeader
          distanceMeters={option.meters}
          seconds={option.seconds}
          stopCount={turns}
          floorChanges={option.transitions.length}
          onClear={onClear}
        />
      )}

      {option && options.length > 1 && (
        <div className="flex gap-1 px-3 pt-2" role="radiogroup" aria-label={t('routePanel.options')}>
          {options.map((o, i) => (
            <button
              key={o.id + i}
              type="button"
              role="radio"
              aria-checked={i === selected}
              onClick={() => onSelect?.(i)}
              className={cn(
                'flex-1 rounded-lg border px-2 py-1.5 text-left text-[11px] transition-colors',
                i === selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50',
              )}
            >
              <div className="font-medium">{t(`routePanel.option.${o.id}`)}</div>
              <div className="tabular-nums text-muted-foreground">
                {t('routePanel.walkingMinutes', { min: Math.max(1, Math.round(o.seconds / 60)) })}
              </div>
            </button>
          ))}
        </div>
      )}

      {option && steps.length > 0 && (
        <ol className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {steps.map((step, i) => {
            const prev = steps[i - 1]
            // On a multi-floor route, say which floor each walk is on.
            const floorHeader =
              multiFloor && step.kind === 'walk' && (i === 0 || prev?.kind === 'change') ? floorName(step.floorId) : ''
            return (
              <li key={i}>
                {floorHeader && (
                  <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <Layers className="h-3 w-3" />
                    {t('routePanel.onFloor', { floor: floorHeader })}
                  </div>
                )}
                {step.kind === 'walk' ? (
                  <StepRow
                    instruction={step.instruction}
                    isFirst={i === 0}
                    isLast={i === steps.length - 1}
                    t={t as unknown as TranslateFn}
                  />
                ) : (
                  <ChangeRow step={step} t={t as unknown as TranslateFn} />
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function OkHeader({
  distanceMeters,
  seconds,
  stopCount,
  floorChanges,
  onClear,
}: {
  distanceMeters: number
  seconds: number
  stopCount: number
  floorChanges: number
  onClear?: () => void
}) {
  const { t } = useTranslation()
  const minutes = Math.max(1, Math.round(seconds / 60))
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-border/60">
      <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/25 flex items-center justify-center">
        <Navigation className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {t('routePanel.title')}
        </div>
        <div className="text-lg font-bold tabular-nums leading-tight">
          {formatDistanceMeters(distanceMeters)}
          <span className="ms-2 text-sm font-medium text-muted-foreground">
            · {t('routePanel.walkingMinutes', { min: minutes })}
          </span>
        </div>
        {(stopCount > 0 || floorChanges > 0) && (
          <div className="text-[11px] text-muted-foreground">
            {[
              stopCount > 0 ? t('routePanel.stopCount', { count: stopCount }) : '',
              floorChanges > 0 ? t('routePanel.floorChanges', { count: floorChanges }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}
      </div>
      {onClear && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          className="w-8 h-8 flex-shrink-0"
          aria-label={t('routePanel.clear')}
          title={t('routePanel.clear')}
        >
          <X className="w-4 h-4" />
        </Button>
      )}
    </div>
  )
}

function ErrorHeader({ status, onClear }: { status: RoutePlanStatus; onClear?: () => void }) {
  const { t } = useTranslation()
  const key =
    status === 'start-blocked' ? 'StartBlocked' : status === 'end-blocked' ? 'EndBlocked' : status === 'no-connection' ? 'NoConnection' : 'Unreachable'
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-red-500/15 ring-1 ring-red-500/25 flex items-center justify-center">
        <X className="w-5 h-5 text-red-600 dark:text-red-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-red-700 dark:text-red-300 leading-tight">{t(`routePanel.error${key}`)}</div>
        <div className="text-[12px] text-muted-foreground leading-snug mt-0.5">{t(`routePanel.error${key}Sub`)}</div>
      </div>
      {onClear && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          className="w-8 h-8 flex-shrink-0"
          aria-label={t('routePanel.clear')}
          title={t('routePanel.clear')}
        >
          <X className="w-4 h-4" />
        </Button>
      )}
    </div>
  )
}

function StepRow({
  instruction,
  isFirst,
  isLast,
  t,
}: {
  instruction: Instruction
  isFirst: boolean
  isLast: boolean
  t: TranslateFn
}) {
  const Icon = TURN_ICON[instruction.kind]
  const verb = verbFor(instruction, t)
  const dist = instruction.distanceMeters
  return (
    <div
      className={cn(
        'group flex items-start gap-3 px-3 py-2 rounded-lg transition-colors',
        'hover:bg-primary/5',
        isFirst && 'bg-emerald-500/5',
        isLast && 'bg-red-500/5',
      )}
    >
      <div
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center ring-1',
          isFirst
            ? 'bg-emerald-500/15 ring-emerald-500/25 text-emerald-600 dark:text-emerald-400'
            : isLast
              ? 'bg-red-500/15 ring-red-500/25 text-red-600 dark:text-red-400'
              : 'bg-muted ring-border/60 text-foreground',
        )}
        aria-hidden
      >
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm leading-snug">{verb}</div>
        {!isFirst && dist > 0 && (
          <div className="text-[11px] text-muted-foreground tabular-nums leading-tight">
            {formatDistanceMeters(dist)}
          </div>
        )}
      </div>
    </div>
  )
}

/** "Take Stairs 1 up to First Floor" — one row per floor change. */
function ChangeRow({ step, t }: { step: Extract<Step, { kind: 'change' }>; t: TranslateFn }) {
  const { portal, toFloor } = step.transition
  const Icon = portal.kind === 'lift' ? ArrowUpDown : portal.kind === 'stairs' ? Footprints : step.up ? ArrowUp : ArrowDown
  const name = portal.name || t(`routePanel.portal.${portal.kind}`)
  const key = portal.kind === 'lift' ? 'routePanel.takeLift' : step.up ? 'routePanel.takeUp' : 'routePanel.takeDown'
  return (
    <div className="flex items-start gap-3 px-3 py-2 rounded-lg bg-primary/5">
      <div className="flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center ring-1 bg-primary/15 ring-primary/25 text-primary" aria-hidden>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0 text-sm leading-snug font-medium">{t(key, { name, floor: toFloor.name })}</div>
    </div>
  )
}

// react-i18next's TFunction has an over-strict generic that trips up
// pure helper functions like verbFor. Widen to a plain callable shape.
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/** Render a turn instruction into a short readable sentence. */
function verbFor(inst: Instruction, t: TranslateFn): string {
  if (inst.kind === 'start') {
    const cardinal = inst.outgoingBearingDeg !== undefined ? cardinalFromBearing(inst.outgoingBearingDeg) : ''
    return t('routePanel.stepStart', { direction: cardinal })
  }
  if (inst.kind === 'arrive') return t('routePanel.stepArrive')
  const key: Record<Exclude<TurnKind, 'start' | 'arrive'>, string> = {
    'slight-left': 'routePanel.stepSlightLeft',
    left: 'routePanel.stepLeft',
    'sharp-left': 'routePanel.stepSharpLeft',
    'slight-right': 'routePanel.stepSlightRight',
    right: 'routePanel.stepRight',
    'sharp-right': 'routePanel.stepSharpRight',
    'u-turn': 'routePanel.stepUturn',
    straight: 'routePanel.stepStraight',
  }
  return t(key[inst.kind], { d: formatDistanceMeters(inst.distanceMeters) })
}
