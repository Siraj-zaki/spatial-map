/**
 * Turn-by-turn directions panel.
 *
 * A floating card that renders the summary + the ordered instruction
 * list for the current route. Used in both the editor and the public
 * viewer — the props are intentionally minimal (start/end + status +
 * waypoints) so the same component drops into either surface without
 * pulling map- or store-specific dependencies.
 *
 * Failure states surface as a red status card with a short reason
 * ("No path — the destination is behind a wall") instead of an empty
 * or misleading instruction list. This is the fix for the "no
 * waypoints when unreachable" requirement.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  ArrowUpLeft,
  ArrowUpRight,
  ArrowUp,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  MapPin,
  Navigation,
  RotateCcw,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  cardinalFromBearing,
  estimateWalkingMinutes,
  formatDistanceMeters,
  generateInstructions,
  type Instruction,
  type TurnKind,
} from '@/lib/routing/directions'
import type { RouteStatus } from '@/lib/routing'

interface Props {
  /** Route status from the pathfinder. */
  status: RouteStatus | null
  /** Emitted route waypoints (may be [start, end] for failure statuses). */
  waypoints: [number, number][] | null
  /** Total path length in metres — comes from computeRoute. */
  distanceMeters: number | null
  /** Called when the user clicks the ✕ button to dismiss the current route. */
  onClear?: () => void
  /**
   * Alignment: `right` docks to the right of the map (editor); `left`
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

export function RouteDirectionsPanel({
  status,
  waypoints,
  distanceMeters,
  onClear,
  side = 'right',
}: Props) {
  const { t } = useTranslation()

  const instructions = useMemo<Instruction[]>(() => {
    if (status !== 'ok' || !waypoints || waypoints.length < 2) return []
    return generateInstructions(waypoints)
  }, [status, waypoints])

  // Nothing to render when the tool is idle or only the start point is placed.
  if (!status || !waypoints || waypoints.length < 2) return null

  // The editor's toolbar rail sits at left-4 with width w-14 (56 px)
  // + padding, so 96 px of left-inset keeps the panel clear of the
  // rail. The viewer has no left rail; 16 px is enough there.
  const positionClass =
    side === 'left'
      ? 'left-4 sm:left-6'
      : 'left-24 sm:left-28'

  const isError =
    status === 'unreachable' || status === 'start-blocked' || status === 'end-blocked'

  return (
    <div
      className={cn(
        'absolute top-16 z-20 w-[min(360px,calc(100vw-2rem))]',
        'bg-card/95 border border-border/60 rounded-2xl shadow-xl ring-1 ring-black/[0.04] backdrop-blur-md',
        'flex flex-col max-h-[calc(100dvh-6rem)] overflow-hidden',
        positionClass,
      )}
      role="region"
      aria-label={t('routePanel.title', { defaultValue: 'Directions' })}
    >
      {/* Header — summary or error */}
      {isError ? (
        <ErrorHeader status={status} onClear={onClear} />
      ) : (
        <OkHeader
          distanceMeters={distanceMeters ?? 0}
          stopCount={instructions.length - 2}
          onClear={onClear}
        />
      )}

      {/* Instruction list */}
      {status === 'ok' && instructions.length > 0 && (
        <ol className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {instructions.map((step, i) => (
            <li key={i}>
              <StepRow
                instruction={step}
                isFirst={i === 0}
                isLast={i === instructions.length - 1}
                t={t as unknown as TranslateFn}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function OkHeader({
  distanceMeters,
  stopCount,
  onClear,
}: {
  distanceMeters: number
  stopCount: number
  onClear?: () => void
}) {
  const { t } = useTranslation()
  const minutes = estimateWalkingMinutes(distanceMeters)
  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-border/60">
      <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/25 flex items-center justify-center">
        <Navigation className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {t('routePanel.title', { defaultValue: 'Directions' })}
        </div>
        <div className="text-lg font-bold tabular-nums leading-tight">
          {formatDistanceMeters(distanceMeters)}
          <span className="ms-2 text-sm font-medium text-muted-foreground">
            · {t('routePanel.walkingMinutes', { defaultValue: '{{min}} min walk', min: minutes })}
          </span>
        </div>
        {stopCount > 0 && (
          <div className="text-[11px] text-muted-foreground">
            {t('routePanel.stopCount', {
              defaultValue: '{{count}} turn',
              defaultValue_plural: '{{count}} turns',
              count: stopCount,
            })}
          </div>
        )}
      </div>
      {onClear && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          className="w-8 h-8 flex-shrink-0"
          aria-label={t('routePanel.clear', { defaultValue: 'Clear route' })}
          title={t('routePanel.clear', { defaultValue: 'Clear route' })}
        >
          <X className="w-4 h-4" />
        </Button>
      )}
    </div>
  )
}

function ErrorHeader({
  status,
  onClear,
}: {
  status: RouteStatus
  onClear?: () => void
}) {
  const { t } = useTranslation()
  const title =
    status === 'unreachable'
      ? t('routePanel.errorUnreachable', {
          defaultValue: 'No path found',
        })
      : status === 'start-blocked'
        ? t('routePanel.errorStartBlocked', {
            defaultValue: 'Start point is blocked',
          })
        : t('routePanel.errorEndBlocked', {
            defaultValue: 'Destination is blocked',
          })
  const subtitle =
    status === 'unreachable'
      ? t('routePanel.errorUnreachableSub', {
          defaultValue: 'Try a different destination — there is no walkable path from here.',
        })
      : status === 'start-blocked'
        ? t('routePanel.errorStartBlockedSub', {
            defaultValue: 'Click again on an open area, not inside a rack or wall.',
          })
        : t('routePanel.errorEndBlockedSub', {
            defaultValue: 'Click again on an open area, not inside a rack or wall.',
          })
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-red-500/15 ring-1 ring-red-500/25 flex items-center justify-center">
        <X className="w-5 h-5 text-red-600 dark:text-red-400" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-red-700 dark:text-red-300 leading-tight">
          {title}
        </div>
        <div className="text-[12px] text-muted-foreground leading-snug mt-0.5">
          {subtitle}
        </div>
      </div>
      {onClear && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onClear}
          className="w-8 h-8 flex-shrink-0"
          aria-label={t('routePanel.clear', { defaultValue: 'Clear route' })}
          title={t('routePanel.clear', { defaultValue: 'Clear route' })}
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

// react-i18next's TFunction has an over-strict generic that trips up
// pure helper functions like verbFor. Widen to a plain callable shape
// — every consumer here passes options as `{ defaultValue, ...vars }`,
// so a loose signature is safe and keeps the helper testable in
// isolation without needing an i18next provider.
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/**
 * Render a turn instruction into a short readable sentence.
 * i18n-friendly: every kind resolves through `t()` so translations
 * can override the copy without touching this file.
 */
function verbFor(inst: Instruction, t: TranslateFn): string {
  if (inst.kind === 'start') {
    const cardinal = inst.outgoingBearingDeg !== undefined
      ? cardinalFromBearing(inst.outgoingBearingDeg)
      : ''
    return t('routePanel.stepStart', {
      defaultValue: 'Head {{direction}}',
      direction: cardinal,
    })
  }
  if (inst.kind === 'arrive') {
    return t('routePanel.stepArrive', { defaultValue: 'Arrive at destination' })
  }
  const distText = formatDistanceMeters(inst.distanceMeters)
  const key =
    inst.kind === 'slight-left'
      ? 'routePanel.stepSlightLeft'
      : inst.kind === 'left'
        ? 'routePanel.stepLeft'
        : inst.kind === 'sharp-left'
          ? 'routePanel.stepSharpLeft'
          : inst.kind === 'slight-right'
            ? 'routePanel.stepSlightRight'
            : inst.kind === 'right'
              ? 'routePanel.stepRight'
              : inst.kind === 'sharp-right'
                ? 'routePanel.stepSharpRight'
                : inst.kind === 'u-turn'
                  ? 'routePanel.stepUturn'
                  : 'routePanel.stepStraight'
  const defaults: Record<string, string> = {
    'routePanel.stepSlightLeft': 'In {{d}}, bear left',
    'routePanel.stepLeft': 'In {{d}}, turn left',
    'routePanel.stepSharpLeft': 'In {{d}}, sharp left',
    'routePanel.stepSlightRight': 'In {{d}}, bear right',
    'routePanel.stepRight': 'In {{d}}, turn right',
    'routePanel.stepSharpRight': 'In {{d}}, sharp right',
    'routePanel.stepUturn': 'In {{d}}, make a U-turn',
    'routePanel.stepStraight': 'In {{d}}, continue straight',
  }
  return t(key, { defaultValue: defaults[key], d: distText })
}

// Suppress the `MapPin` unused warning — kept as export candidate for a
// future "current location" pin overlay. Explicit void keeps eslint quiet
// without gutting the import for future work.
void MapPin
