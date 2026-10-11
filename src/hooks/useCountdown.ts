import { useCallback, useEffect, useState } from 'react'

/**
 * Whole-second countdown toward a deadline. Returns the seconds left (0
 * once elapsed) and a `start(seconds)` that (re)arms it. Deadline-based
 * rather than decrement-per-tick, so a throttled background tab can't make
 * it drift — it reads the true remaining time on every tick.
 *
 * Used by the auth screens for the OTP resend cooldown and the 429
 * "try again in 0:42" lockout.
 */
export function useCountdown(): [number, (seconds: number) => void] {
  const [deadline, setDeadline] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (deadline <= Date.now()) return
    const id = window.setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= deadline) window.clearInterval(id)
    }, 250)
    return () => window.clearInterval(id)
  }, [deadline])

  const start = useCallback((seconds: number) => {
    const t = Date.now()
    setNow(t)
    setDeadline(seconds > 0 ? t + seconds * 1000 : 0)
  }, [])

  return [Math.max(0, Math.ceil((deadline - now) / 1000)), start]
}
