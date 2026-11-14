/**
 * Live camera view for a stream URL — shared by the viewer's data drawer, the
 * report explorer's detail panel and report table cells (in a dialog).
 *
 * What plays where:
 *  - HLS (`.m3u8`): the browser's own player (Safari; Chrome 14x+). No hls.js —
 *    a browser without native HLS gets the "can't play" state.
 *  - Video files (mp4 / webm / mov): muted, looping, no seek bar — how an NVR's
 *    recorded or relayed feed is shown as a live tile.
 *  - MJPEG (`.mjpg`, `/mjpeg`, `action=stream`): an <img>, which every browser
 *    streams natively.
 *  - RTSP / RTMP / SRT / UDP: no browser plays these; we say so and offer the URL.
 *
 * The overlay (LIVE badge, camera name, a running clock) is drawn here, so any
 * source looks like the same camera tile.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, ExternalLink, Loader2, Maximize2, Minimize2, RotateCw, VideoOff } from 'lucide-react'
import { cn } from '@/lib/utils'

export type StreamKind = 'hls' | 'video' | 'mjpeg' | 'native-only' | 'unknown'

const HLS_RE = /\.m3u8(\?|#|$)/i
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i
const MJPEG_RE = /(\.mjpe?g(\?|#|$))|\/mjpe?g(\/|\?|$)|action=stream/i
const NATIVE_ONLY_RE = /^(rtsp|rtsps|rtmp|rtmps|srt|udp|mms):\/\//i
const WEB_RE = /^(https?:\/\/|\/(?!\/))/i

export function streamKind(src: string): StreamKind {
  const s = src.trim()
  if (NATIVE_ONLY_RE.test(s)) return 'native-only'
  if (!WEB_RE.test(s)) return 'unknown'
  if (HLS_RE.test(s)) return 'hls'
  if (MJPEG_RE.test(s)) return 'mjpeg'
  if (VIDEO_RE.test(s)) return 'video'
  return 'unknown'
}

/** Can the browser show this URL as a picture at all (RTSP and bare links can't)? */
export function isWatchableStream(src: unknown): boolean {
  if (typeof src !== 'string') return false
  const k = streamKind(src)
  return k === 'hls' || k === 'video' || k === 'mjpeg'
}

function canPlayHls(): boolean {
  if (typeof document === 'undefined') return false
  const v = document.createElement('video')
  return v.canPlayType('application/vnd.apple.mpegurl') !== '' || v.canPlayType('application/x-mpegURL') !== ''
}

/** HH:MM:SS that ticks every second, like a recorder's burnt-in clock. */
function useClock(): string {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

type PlayState = 'connecting' | 'playing' | 'reconnecting' | 'error'

export function LiveStreamPlayer({
  src,
  title,
  subtitle,
  offline = false,
  autoFocus = false,
  className,
}: {
  src: string
  /** Camera name in the overlay. */
  title?: string
  /** Area / floor under the name. */
  subtitle?: string
  /** The camera reports itself offline — show that instead of trying to play. */
  offline?: boolean
  autoFocus?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const kind = streamKind(src)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  // The play state belongs to one source + attempt; a new one starts at "connecting".
  const playKey = `${attempt}|${src}`
  const [play, setPlay] = useState<{ key: string; state: PlayState }>({ key: playKey, state: 'connecting' })
  const state: PlayState = play.key === playKey ? play.state : 'connecting'
  const setState = (next: PlayState | ((s: PlayState) => PlayState)) =>
    setPlay((p) => {
      const cur = p.key === playKey ? p.state : 'connecting'
      return { key: playKey, state: typeof next === 'function' ? next(cur) : next }
    })
  const [full, setFull] = useState(false)
  const [copied, setCopied] = useState(false)
  const clock = useClock()
  const hlsBlocked = kind === 'hls' && !canPlayHls()

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  useEffect(() => { if (autoFocus) wrapRef.current?.focus() }, [autoFocus])

  const toggleFull = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }, [])
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(src)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch { /* clipboard blocked — the URL is still shown */ }
  }, [src])

  // RTSP and friends: say plainly why there is no picture.
  if (kind === 'native-only' || kind === 'unknown' || hlsBlocked || offline) {
    const body = offline
      ? t('liveStream.offlineBody', { defaultValue: 'The camera is not sending video right now. The last recording is kept on the recorder.' })
      : hlsBlocked
        ? t('liveStream.hlsBody', { defaultValue: 'This browser can’t play this live stream. Open it in Safari or a recent Chrome.' })
        : t('liveStream.rtspBody', { defaultValue: 'This camera streams over RTSP, which browsers can’t show directly. Route it through the video gateway (HLS or WebRTC) to watch it here.' })
    return (
      <div className={cn('flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-lg border bg-muted/40 p-4 text-center', className)}>
        <VideoOff className="h-6 w-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">
          {offline ? t('liveStream.offline', { defaultValue: 'Camera offline' }) : t('liveStream.cantPlay', { defaultValue: 'Can’t play here' })}
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">{body}</p>
        {!offline && (
          <button type="button" onClick={copy} className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
            <Copy className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate font-mono">{copied ? t('liveStream.copied', { defaultValue: 'Copied' }) : src}</span>
          </button>
        )}
      </div>
    )
  }

  const onPlaying = () => setState('playing')
  const onWaiting = () => setState((s) => (s === 'playing' ? 'reconnecting' : s))
  const onError = () => setState('error')

  return (
    <div
      ref={wrapRef}
      tabIndex={-1}
      className={cn('group relative aspect-video w-full overflow-hidden rounded-lg bg-black outline-none', full && 'rounded-none', className)}
      aria-label={title ? t('liveStream.ariaLabel', { name: title, defaultValue: 'Live view — {{name}}' }) : t('liveStream.live', { defaultValue: 'Live' })}
    >
      {kind === 'mjpeg' ? (
        <img key={attempt} src={src} alt="" className="h-full w-full object-cover" onLoad={onPlaying} onError={onError} />
      ) : (
        <video
          key={attempt}
          src={src}
          className="h-full w-full object-cover"
          autoPlay
          muted
          loop={kind === 'video'}
          playsInline
          preload="auto"
          onPlaying={onPlaying}
          onLoadedData={onPlaying}
          onWaiting={onWaiting}
          onStalled={onWaiting}
          onError={onError}
        />
      )}

      {/* Overlay: camera name, LIVE, the clock. Light text on a dark scrim — the picture underneath is always video. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/65 to-transparent p-2.5 text-white">
        <div className="min-w-0">
          {title && <div className="truncate text-xs font-semibold drop-shadow">{title}</div>}
          {subtitle && <div className="truncate text-[10px] text-white/75">{subtitle}</div>}
        </div>
        {state === 'playing' && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-danger px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden />
            {t('liveStream.live', { defaultValue: 'Live' })}
          </span>
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/60 to-transparent p-2.5 text-white">
        <span className="font-mono text-[11px] tabular-nums text-white/85 drop-shadow">{clock}</span>
        <div className="flex items-center gap-1 opacity-80 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded p-1 hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            aria-label={t('liveStream.openInNewTab', { defaultValue: 'Open in a new tab' })}
            title={t('liveStream.openInNewTab', { defaultValue: 'Open in a new tab' })}
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleFull() }}
            className="rounded p-1 hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            aria-label={full ? t('liveStream.exitFullscreen', { defaultValue: 'Exit full screen' }) : t('liveStream.fullscreen', { defaultValue: 'Full screen' })}
            title={full ? t('liveStream.exitFullscreen', { defaultValue: 'Exit full screen' }) : t('liveStream.fullscreen', { defaultValue: 'Full screen' })}
          >
            {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {(state === 'connecting' || state === 'reconnecting') && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-white/85">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {state === 'connecting' ? t('liveStream.connecting', { defaultValue: 'Connecting to camera…' }) : t('liveStream.reconnecting', { defaultValue: 'Reconnecting…' })}
        </div>
      )}
      {state === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center text-white">
          <VideoOff className="h-5 w-5" aria-hidden />
          <p className="text-xs">{t('liveStream.error', { defaultValue: 'The video stopped. The camera or the network may be down.' })}</p>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setAttempt((n) => n + 1) }}
            className="inline-flex items-center gap-1.5 rounded-md bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25"
          >
            <RotateCw className="h-3 w-3" aria-hidden />
            {t('liveStream.retry', { defaultValue: 'Try again' })}
          </button>
        </div>
      )}
    </div>
  )
}
