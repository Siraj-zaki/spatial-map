import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * A string filter kept in the URL query (`?q=…&view=grid`) so refresh,
 * back/forward and shared links preserve what the user was looking at.
 * Setting the default value removes the param to keep URLs clean.
 * Uses `replace` — typing in a search box shouldn't flood history.
 *
 * The setter builds on the LIVE URL (`window.location.search`), not the
 * params this render saw: React Router's functional `setSearchParams`
 * hands every call the render-time params, so two setters in one handler
 * (source + page, or a "Clear filters" resetting three params) clobbered
 * each other and only the last one stuck. `navigate` updates history
 * synchronously, so each call sees the previous one's result.
 */
export function useUrlState<T extends string>(key: string, defaultValue: T): [T, (v: T) => void] {
  const [params, setParams] = useSearchParams()
  const value = (params.get(key) as T | null) ?? defaultValue
  const set = useCallback(
    (v: T) => {
      const next = new URLSearchParams(window.location.search)
      if (v === defaultValue || v === '') next.delete(key)
      else next.set(key, v)
      setParams(next, { replace: true })
    },
    [key, defaultValue, setParams],
  )
  return [value, set]
}
