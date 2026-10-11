import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * `useState` that hydrates from localStorage on mount and writes back
 * on every change. Used to persist draw-tool config (color, width,
 * label, elevation, etc.) so a user's tool tuning survives a page
 * reload.
 *
 * The stored value is merged into the current default via a shallow
 * spread — so config shapes can grow new fields over time without
 * older persisted rows breaking (new fields inherit defaults).
 *
 * Read/write failures (quota exceeded, disabled storage, JSON parse
 * error) are swallowed silently: the tool falls back to defaults and
 * still works.
 */
export function usePersistedState<T extends object>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    const base = typeof initial === 'function' ? (initial as () => T)() : initial
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return base
      const parsed = JSON.parse(raw) as Partial<T>
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...base, ...parsed }
      }
      return base
    } catch {
      return base
    }
  })

  // Skip the first write (state === initial-from-storage) so we don't
  // needlessly re-serialise the same bytes we just read.
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    try {
      localStorage.setItem(key, JSON.stringify(state))
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [key, state])

  return [state, setState]
}
