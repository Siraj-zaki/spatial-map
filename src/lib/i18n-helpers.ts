import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Lightweight wrapper around `useTranslation` that exposes the current
 * language and a typed setter. Used by the toolbar's settings popover.
 */
export function useLanguage(): {
  currentLanguage: string
  setLanguage: (code: string) => Promise<void>
} {
  const { i18n } = useTranslation()
  const currentLanguage = i18n.resolvedLanguage ?? i18n.language ?? 'en'
  const setLanguage = useCallback(
    async (code: string) => {
      await i18n.changeLanguage(code)
      // Persist the choice so the app boots in the user's locale.
      try {
        localStorage.setItem('i18nextLng', code)
      } catch {
        // Ignore — non-browser environment or storage disabled.
      }
    },
    [i18n]
  )
  return { currentLanguage, setLanguage }
}
