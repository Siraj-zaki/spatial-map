import { useCallback, useSyncExternalStore } from 'react'

/**
 * Live `matchMedia(query).matches`. For behaviour CSS can't express — e.g.
 * not mounting a <video> at all on small screens (a `display:none` parent
 * doesn't stop the download), or showing a still instead of playback for
 * `(prefers-reduced-motion: reduce)`.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}
