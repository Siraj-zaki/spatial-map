/**
 * Notification sounds, synthesized with the Web Audio API (no audio files):
 * `chime('message')` — a soft two-note chime for an arriving message;
 * `chime('send')` — a short tick when the user's own message goes out.
 * Browsers only allow audio after a user gesture, so the AudioContext is
 * created/resumed on the first pointer or key press; before that a chime is
 * silently skipped. Muting is a per-browser preference (localStorage).
 */

import { useSyncExternalStore } from 'react'

const MUTE_KEY = 'sgv-sound-muted'
const listeners = new Set<() => void>()

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

let muted = readMuted()

export function setSoundMuted(next: boolean) {
  muted = next
  try {
    if (next) localStorage.setItem(MUTE_KEY, '1')
    else localStorage.removeItem(MUTE_KEY)
  } catch {
    /* the toggle still works for this session */
  }
  listeners.forEach((l) => l())
}

export function useSoundMuted(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => muted,
  )
}

let ctx: AudioContext | null = null

function unlock() {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
  } catch {
    /* no Web Audio — chimes stay silent */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlock, { passive: true })
  window.addEventListener('keydown', unlock)
}

function tone(ac: AudioContext, freq: number, start: number, length: number, peak: number, type: OscillatorType = 'sine') {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length)
  osc.connect(gain).connect(ac.destination)
  osc.start(start)
  osc.stop(start + length + 0.02)
}

// Two pollers can notice the same message (unread count + open thread);
// one chime is enough.
let lastMessageChime = 0

export function chime(kind: 'message' | 'send') {
  if (muted || !ctx || ctx.state !== 'running') return
  const now = ctx.currentTime
  if (kind === 'message') {
    if (now - lastMessageChime < 1.5) return
    lastMessageChime = now
    tone(ctx, 880, now, 0.35, 0.14)
    tone(ctx, 1318.5, now + 0.11, 0.5, 0.12)
    tone(ctx, 2637, now + 0.11, 0.25, 0.015, 'triangle')
  } else {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.setValueAtTime(520, now)
    osc.frequency.exponentialRampToValueAtTime(1040, now + 0.09)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.16)
  }
}
