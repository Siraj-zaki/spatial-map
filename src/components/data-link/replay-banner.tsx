/**
 * Phase 7b — banner the editor route mounts so the user can't miss
 * that they're looking at historical data while a replay is running.
 *
 * Shows the stream label, fraction done, elapsed clock, and a stop
 * button. Hidden when no replay is active.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { History, X } from 'lucide-react'
import { replayController, useReplayState } from '@/lib/data-link'
import { cn } from '@/lib/utils'

export function ReplayBanner() {
  const { t } = useTranslation()
  const state = useReplayState()
  const [nowMs, setNowMs] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (state.activeStreamId === null) return null
  const pct =
    state.totalEvents === 0 ? 0 : Math.min(100, (state.doneEvents / state.totalEvents) * 100)
  const elapsedSec = state.startedAt ? Math.floor((nowMs - state.startedAt) / 1000) : 0
  return (
    <div
      className={cn(
        'pointer-events-none fixed top-3 left-1/2 -translate-x-1/2 z-50',
        'px-3 py-2 rounded-xl border shadow-lg backdrop-blur-md',
        'bg-amber-500/15 border-amber-500/40 text-amber-900 dark:text-amber-100',
        'flex items-center gap-3 max-w-[90vw]',
      )}
      role="status"
    >
      <History className="w-4 h-4 flex-shrink-0 animate-pulse" />
      <div className="flex flex-col min-w-0">
        <div className="flex items-center gap-2 flex-wrap text-[11px] font-semibold uppercase tracking-wider">
          <span>Replay mode</span>
          <span className="font-mono text-[10px] opacity-80">× {state.speed}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="truncate max-w-[40vw]">{state.label}</span>
          <span className="opacity-75 font-mono">
            {state.doneEvents}/{state.totalEvents} · {pct.toFixed(0)}% · {elapsedSec}s
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => replayController.requestStop()}
        className={cn(
          'pointer-events-auto inline-flex items-center justify-center',
          'w-6 h-6 rounded-md flex-shrink-0',
          'bg-amber-600/20 hover:bg-amber-600/30 text-amber-900 dark:text-amber-100',
          'transition-colors',
        )}
        title={t('dataLink.replay.stop', { defaultValue: 'Stop replay' })}
        aria-label={t('dataLink.replay.stop', { defaultValue: 'Stop replay' })}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
