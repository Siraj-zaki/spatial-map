import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

const read = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light')

/**
 * The light/dark mode actually applied right now. `useTheme().theme` can be
 * 'system'; this reads the `.dark` class ThemeProvider puts on <html>, so it
 * resolves 'system' and follows OS changes and toggles live.
 */
export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, read, () => 'light' as const)
}
