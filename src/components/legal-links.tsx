/**
 * Public footer strip on the auth screens (login, signup, reset).
 *
 * Self-hosted deployments can point at their own Terms / Privacy pages
 * via the optional `VITE_TERMS_URL` / `VITE_PRIVACY_URL` build-time env
 * vars (see `src/config/legal.ts`). Each link is hidden when its var is unset, and the whole footer
 * renders nothing when neither is configured.
 */

import { useTranslation } from 'react-i18next'
import { PRIVACY_URL, TERMS_URL } from '@/config/legal'

const LEGAL_LINKS: ReadonlyArray<{ href: string; key: string }> = [
  { href: TERMS_URL, key: 'legal.terms' },
  { href: PRIVACY_URL, key: 'legal.privacy' },
].filter((link) => link.href !== '')

export function LegalLinks({ className }: { className?: string }) {
  const { t } = useTranslation()
  if (LEGAL_LINKS.length === 0) return null
  return (
    <footer
      className={
        'mt-8 flex flex-col items-center gap-2 text-[11px] text-muted-foreground ' +
        (className ?? '')
      }
    >
      <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        {LEGAL_LINKS.map((link, i) => (
          <span key={link.href} className="flex items-center gap-3">
            <a
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-sm hover:text-foreground hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t(link.key)}
            </a>
            {i < LEGAL_LINKS.length - 1 && (
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
            )}
          </span>
        ))}
      </nav>
    </footer>
  )
}
