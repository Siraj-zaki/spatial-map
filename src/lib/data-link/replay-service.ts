/**
 * Phase 7b — historical event replay.
 *
 * Fetches a window of past events from the Worker's `/events`
 * endpoint, then re-feeds each event through the same dispatch
 * handler the live channel uses. Playback respects the original
 * inter-event gaps scaled by a speed multiplier (1× / 4× / 16× /
 * 64×) so the visual feels like watching the day at fast-forward.
 *
 * While replay is active, the target stream's live WebSocket is
 * paused via `replayController.isStreamPaused`. Other streams stay
 * live so the rest of the map keeps updating.
 */

import type { Stream } from '@/lib/db'
import {
  getStreamMessageHandler,
  resolveStreamApiKey,
} from './live-stream-client'
import { replayController } from './replay-controller'

export class ReplayError extends Error {}

interface HistoricalEvent {
  ts: number
  payload: string
}

interface HistoricalRange {
  events: HistoricalEvent[]
  oldestTs: number | null
  newestTs: number | null
}

/** Resolve the `/events` URL from a stream's endpoint. */
function eventsUrl(stream: Stream): string | null {
  const ep = stream.endpoint as { url?: unknown }
  if (typeof ep.url === 'string' && ep.url.length > 0) {
    return ep.url.replace(/\/ws(\?.*)?$/, '/events')
  }
  return null
}

export async function fetchHistoricalEvents(
  stream: Stream,
  fromMs: number,
  toMs: number,
  limit = 2000,
): Promise<HistoricalRange> {
  const base = eventsUrl(stream)
  if (!base) throw new ReplayError('stream has no Worker URL on its endpoint')
  const apiKey = await resolveStreamApiKey(stream)
  if (!apiKey) throw new ReplayError('stream has no API key on its parent connection')
  const u = new URL(base)
  u.searchParams.set('from', String(fromMs))
  u.searchParams.set('to', String(toMs))
  u.searchParams.set('limit', String(limit))
  const res = await fetch(u.toString(), {
    method: 'GET',
    headers: { 'X-Api-Key': apiKey },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ReplayError(`fetch events failed: ${res.status} ${res.statusText} ${text}`)
  }
  return (await res.json()) as HistoricalRange
}

/**
 * Drive a replay session end-to-end. Resolves once the loop hits the
 * last event, or when `replayController.requestStop()` was called.
 *
 * Caller responsibilities:
 *   - Pass a stream with a configured `/events` URL + api key.
 *   - Make sure the speed is one of the UI presets (any positive
 *     finite number works, but the banner buttons stamp 1/4/16/64).
 *
 * The controller fires `begin` → `tick(0..n)` → `end()` so the UI
 * banner stays in sync.
 */
export async function runReplay(input: {
  stream: Stream
  fromMs: number
  toMs: number
  speed: number
  /** Cap on events pulled in one shot. Defaults to 2000 (Worker's default too). */
  limit?: number
}): Promise<{ played: number }> {
  const { stream, fromMs, toMs, speed } = input
  if (stream.id === undefined) throw new ReplayError('stream has no id')
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new ReplayError(`invalid speed: ${speed}`)
  }
  const handler = getStreamMessageHandler(stream)
  if (!handler) {
    throw new ReplayError(
      'stream is not a recognised live entity — replay only supports asset/sensor/rfid/shipment/camera',
    )
  }

  let range: HistoricalRange
  try {
    range = await fetchHistoricalEvents(stream, fromMs, toMs, input.limit ?? 2000)
  } catch (err) {
    replayController.end((err as Error).message)
    throw err
  }

  if (range.events.length === 0) {
    replayController.end('no events in the selected window')
    return { played: 0 }
  }

  replayController.begin({
    streamId: stream.id,
    label: stream.name,
    speed,
    totalEvents: range.events.length,
  })

  let played = 0
  let prevTs: number | null = null
  for (const ev of range.events) {
    if (replayController.shouldStop()) break
    // Honor the original inter-event gap, scaled by `speed`. The
    // very first event fires immediately so the user sees motion
    // without delay.
    if (prevTs !== null) {
      const gapMs = ev.ts - prevTs
      const waitMs = gapMs / speed
      if (waitMs > 0) {
        await sleep(waitMs)
        if (replayController.shouldStop()) break
      }
    }
    prevTs = ev.ts
    try {
      const parsed = JSON.parse(ev.payload) as unknown
      await handler(parsed)
    } catch (err) {
      // A single malformed historical row shouldn't tear the loop down.
      console.warn('[replay] event handler failed', err)
    }
    played++
    replayController.tick(played)
  }
  replayController.end()
  return { played }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
