/**
 * Reset document scroll on route change. Without this, navigating
 * from a long page (e.g. /profile) to a shorter one keeps the new
 * page scrolled down — the browser preserves `window.scrollY` across
 * client-side route changes.
 *
 * Only the document needs this. Routes that own their scroll
 * container (PageContainer, /data, /files) remount on pathname change,
 * so their inner scroll resets naturally.
 *
 * We listen to `pathname` only — not `search` — so changing filters
 * or tabs within a page preserves scroll position.
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

export function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}