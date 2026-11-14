/**
 * TableHistoryPlayer — bottom-of-map, video-player-style scrubber for
 * layers that use render mode `'history-movement'`. Glassy panel,
 * play/pause + rewind + speed + timeline scrubber + timestamps, all
 * inline so the viewer sees "current time" the way a video player
 * shows it — no dialog, no hunt for a menu.
 *
 * Auto-activation: as soon as at least one visible `history-movement`
 * layer mounts, this component fetches its history and hands it to
 * `table-playback-store`. The overlay's sub-renderers already know how
 * to swap in playback-reconstructed entities when the store's
 * `activeSourceId` matches, so no per-layer wiring is needed. Switching
 * active layers (dropdown at the far left of the bar) reloads.
 *
 * Renders nothing when no visible layer uses this mode — a viewer of
 * an ordinary live map should not see a dead playback bar.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Clock,
  Loader2,
  Pause,
  Play,
  Rewind,
  Square,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { HistoryRangePicker, rangeBounds, type PlayerRange } from '@/components/view/history-range-picker'
import { listTableEvents } from '@/lib/data-link/table-events-client'
import {
  tablePlayback,
  useTablePlaybackState,
} from '@/lib/data-link/table-playback-store'
import type { DataLinkConfig } from '@/lib/db'
import { cn } from '@/lib/utils'

export interface TableHistoryPlayerProps {
  configs: ReadonlyArray<DataLinkConfig>
  /** Position override for the bar's wrapper (a report map keeps it clear
   *  of its floating panels); default: centred 16 px above the bottom. */
  style?: CSSProperties
}

const SPEED_OPTIONS = [1, 5, 15, 60, 300, 1800] as const
/** The server returns at most this many events per load. */
const EVENT_LIMIT = 5000

/** A speed that plays the whole range in about two minutes. */
function speedFor(spanMs: number): number {
  const ideal = spanMs / 1000 / 120
  return SPEED_OPTIONS.reduce((best, s) => (Math.abs(Math.log(s / ideal)) < Math.abs(Math.log(best / ideal)) ? s : best))
}

export function TableHistoryPlayer({ configs, style }: TableHistoryPlayerProps) {
  const { t, i18n } = useTranslation()
  const playback = useTablePlaybackState()

  // Only history-movement layers matter here — ordinary point-at-coord
  // layers stay on their live query. Filter also drops layers whose
  // source isn't set (defensive: the editor gates on it too).
  const historyLayers = useMemo(
    () =>
      configs.filter(
        (c) =>
          c.id !== undefined &&
          c.sourceId !== undefined &&
          c.renderMode === 'history-movement',
      ),
    [configs],
  )

  // User's explicit pick, if any. Derived `pickedSourceId` below falls
  // back to the first eligible layer so the bar just works on first
  // mount without the viewer touching the picker.
  const [chosenSourceId, setChosenSourceId] = useState<number | null>(null)
  const [range, setRange] = useState<PlayerRange>({ kind: 'last', sec: 86_400 })
  const [loading, setLoading] = useState(false)

  const pickedSourceId: number | null =
    chosenSourceId !== null &&
    historyLayers.some((c) => c.sourceId === chosenSourceId)
      ? chosenSourceId
      : historyLayers[0]?.sourceId ?? null

  // Auto-load whenever the picked layer / range changes AND the store
  // isn't already loaded for that (source, range). Aborts in flight
  // if the picker moves before the fetch resolves.
  useEffect(() => {
    if (pickedSourceId === null) return
    const want = rangeBounds(range)
    if (
      playback.activeSourceId === pickedSourceId &&
      // Same range. A "last N" range slides with the clock, so it is
      // stale once its ends drift past one poll cycle (~30s).
      Math.abs(playback.endMs - want.endMs) < 30_000 &&
      Math.abs(playback.startMs - want.startMs) < 30_000
    ) {
      return
    }
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    const query =
      range.kind === 'last'
        ? { windowSec: range.sec, limit: EVENT_LIMIT }
        : { from: range.from, to: range.to, limit: EVENT_LIMIT }
    listTableEvents(pickedSourceId, query)
      .then((events) => {
        if (cancelled) return
        const { startMs, endMs } = rangeBounds(range)
        tablePlayback.start({
          sourceId: pickedSourceId,
          events,
          startMs,
          endMs,
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        tablePlayback.setError(
          err instanceof Error ? err.message : 'Failed to load history',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // playback.activeSourceId is intentionally read but not a dep — we
    // only want a reload on user-driven changes, not on every store tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedSourceId, range])

  const changeRange = (next: PlayerRange) => {
    const { startMs, endMs } = rangeBounds(next)
    tablePlayback.setSpeed(speedFor(endMs - startMs))
    setRange(next)
  }

  // Stop playback when the last history-movement layer is removed
  // (e.g. the viewer hid it via the layers panel). Keeps the map
  // from displaying stale reconstructed dots for a layer that is no
  // longer in the config list.
  useEffect(() => {
    if (historyLayers.length === 0 && playback.activeSourceId !== null) {
      tablePlayback.stop()
    }
  }, [historyLayers.length, playback.activeSourceId])

  // The playback store is app-wide: leaving the page (the viewer, a report)
  // must not leave its reconstructed rows playing on the next map.
  useEffect(() => () => tablePlayback.stop(), [])

  if (historyLayers.length === 0) return null

  const scrubberMax = Math.max(1, playback.endMs - playback.startMs)
  const scrubberValue = Math.max(0, playback.currentMs - playback.startMs)
  const fmtTs = (ms: number) =>
    ms > 0
      ? new Date(ms).toLocaleString(i18n.language, {
          dateStyle: 'short',
          timeStyle: 'medium',
        })
      : '—'

  const percent = Math.round((scrubberValue / scrubberMax) * 100)
  const capped = playback.events.length >= EVENT_LIMIT

  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex justify-center" style={style}>
      <div
        className="
          pointer-events-auto w-full max-w-4xl
          rounded-2xl border border-border/60
          bg-background/60 backdrop-blur-2xl
          shadow-[0_10px_40px_-12px_rgba(0,0,0,0.35)]
          ring-1 ring-black/5 dark:ring-white/10
          px-4 py-3
          grid gap-2
        "
      >
        {/* Top row: title + layer picker + window + count + loading */}
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground shrink-0"
            title={t('view.playerTitle', { defaultValue: 'History player' }) as string}
          >
            <Clock size={13} className="text-primary" />
            {/* Phones keep the room for the layer and range pickers. */}
            <span className="hidden sm:inline">{t('view.playerTitle', { defaultValue: 'History player' })}</span>
          </span>

          <select
            value={pickedSourceId ?? ''}
            onChange={(e) => setChosenSourceId(Number(e.target.value))}
            aria-label={t('view.playerLayer', { defaultValue: 'Layer' }) as string}
            className="h-7 rounded-md border bg-background/70 px-2 text-[11px] min-w-0 max-w-[14rem] truncate"
          >
            {historyLayers.map((c) => (
              <option key={c.id} value={c.sourceId}>
                {c.name || `Layer #${c.id}`}
              </option>
            ))}
          </select>

          <HistoryRangePicker value={range} onChange={changeRange} />

          <div className="flex-1" />

          {loading && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          <span
            className={cn('text-[10px] tabular-nums shrink-0', capped ? 'text-warning' : 'text-muted-foreground')}
            title={capped ? (t('view.playerCapped', { count: EVENT_LIMIT, defaultValue: 'Showing the first {{count}} events — pick a shorter range to see the rest.' }) as string) : undefined}
          >
            {!loading && playback.activeSourceId !== null && playback.events.length === 0 ? (
              t('view.playerNoEvents', { defaultValue: 'No events in this range' })
            ) : (
              <>
                {playback.events.length.toLocaleString(i18n.language)}{capped ? '+' : ''}{' '}
                {t('view.playerEvents', { defaultValue: 'evts' })}
              </>
            )}
          </span>
          {playback.error && (
            <span
              className="text-[10px] text-destructive shrink-0 truncate max-w-[10rem]"
              title={playback.error}
            >
              {playback.error}
            </span>
          )}
        </div>

        {/* Scrubber row: play/pause + rewind + big timeline + speed + stop */}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 shrink-0"
            onClick={() => tablePlayback.seek(playback.startMs)}
            disabled={playback.activeSourceId === null}
            title={
              t('view.playerRewind', {
                defaultValue: 'Rewind to start',
              }) as string
            }
          >
            <Rewind className="h-3.5 w-3.5" />
          </Button>

          <Button
            type="button"
            size="sm"
            className="h-8 w-8 p-0 shrink-0"
            onClick={() =>
              playback.playing ? tablePlayback.pause() : tablePlayback.play()
            }
            disabled={playback.activeSourceId === null}
          >
            {playback.playing ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </Button>

          <div className="relative flex-1 min-w-0">
            <input
              type="range"
              min={0}
              max={scrubberMax}
              value={scrubberValue}
              onChange={(e) =>
                tablePlayback.seek(playback.startMs + Number(e.target.value))
              }
              disabled={playback.activeSourceId === null}
              className="w-full accent-primary"
              aria-label={
                t('view.playerScrubber', {
                  defaultValue: 'Playback position',
                }) as string
              }
            />
          </div>

          <select
            value={playback.speed}
            onChange={(e) => tablePlayback.setSpeed(Number(e.target.value))}
            className="h-7 rounded-md border bg-background/70 px-2 text-[11px] shrink-0"
            title={
              t('view.playerSpeedTitle', {
                defaultValue: 'History seconds per playback second',
              }) as string
            }
          >
            {SPEED_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s < 60
                  ? `${s}s/s`
                  : s < 3600
                  ? `${(s / 60).toFixed(0)}m/s`
                  : `${(s / 3600).toFixed(0)}h/s`}
              </option>
            ))}
          </select>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 shrink-0"
            onClick={() => tablePlayback.stop()}
            disabled={playback.activeSourceId === null}
            title={t('view.playerStop', { defaultValue: 'Stop' }) as string}
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Bottom row: start / current / end timestamps */}
        <div className="grid grid-cols-3 items-center text-[10px] font-mono text-muted-foreground">
          <span className="truncate">{fmtTs(playback.startMs)}</span>
          <span className="text-center tabular-nums text-foreground">
            {fmtTs(playback.currentMs)}
            <span className="ms-1 text-muted-foreground">({percent}%)</span>
          </span>
          <span className="truncate text-end">{fmtTs(playback.endMs)}</span>
        </div>
      </div>
    </div>
  )
}
