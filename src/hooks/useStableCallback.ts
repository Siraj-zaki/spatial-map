import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A callback whose identity never changes but always runs the latest
 * `fn`. For handlers passed to memoised components (the editor toolbar)
 * that depend on fast-changing data — e.g. "export everything" reads every
 * shape list, so a normal useCallback is a new function on every edit and
 * the memo never holds.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}
