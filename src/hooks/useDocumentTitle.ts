import { useEffect } from 'react'

/**
 * Sets `document.title` while the calling screen is mounted and restores
 * the previous title on unmount. Pass `errorPrefix` while the screen shows
 * a validation / server error: it's prepended ("Error: Sign in · …") so
 * screen-reader users hear the failure on the title announcement too
 * (GOV.UK error-summary pattern).
 */
export function useDocumentTitle(title: string, errorPrefix?: string | null) {
  useEffect(() => {
    const previous = document.title
    return () => {
      document.title = previous
    }
  }, [])

  useEffect(() => {
    document.title = errorPrefix ? `${errorPrefix} ${title}` : title
  }, [title, errorPrefix])
}
