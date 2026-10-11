/**
 * Counts a number up from 0 the first time it appears (ease-out, ~700 ms),
 * then shows later values as they are — background refreshes must not
 * re-animate (decorative motion on every poll is noise). Static under
 * prefers-reduced-motion. Digits follow the app language, not the
 * browser's locale (German shows 1.547, matching the rest of the page).
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMediaQuery } from '@/hooks/useMediaQuery'

export function CountUp({ value, format }: { value: number; format?: (n: number) => string }) {
  const { i18n } = useTranslation()
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  // In-flight animated value; null once the intro has finished.
  const [frame, setFrame] = useState<number | null>(reduced || value === 0 ? null : 0)
  const [target] = useState(value)

  useEffect(() => {
    if (reduced || target === 0) return
    const start = performance.now()
    let raf = requestAnimationFrame(function tick(now) {
      const p = Math.min(1, (now - start) / 700)
      const eased = 1 - Math.pow(1 - p, 3)
      setFrame(p < 1 ? target * eased : null)
      if (p < 1) raf = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(raf)
  }, [target, reduced])

  const n = frame ?? value
  return <>{format ? format(n) : Math.round(n).toLocaleString(i18n.language)}</>
}
