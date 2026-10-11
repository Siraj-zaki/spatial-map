/**
 * Shared page primitives for every workspace screen (/dashboard,
 * /warehouses, /integrations, /files, /tables, /data, /reports, /admin).
 *
 *   - `PageContainer` — fills the app shell's <main>, owns the scroll, and
 *     centres content at one max width with one set of gutters.
 *   - `PageHero` — the page header: title, one-line description, actions.
 *     Compact on purpose (2026-09 redesign): the old 48px marketing hero +
 *     uppercase eyebrow pushed real content below the fold. `eyebrow` is
 *     still accepted for API compatibility but no longer rendered — the top
 *     bar's breadcrumb already says where you are.
 *   - `PageChapter` — a titled section within a page (same compatibility
 *     note for `eyebrow`).
 *
 * Keep this file thin — no domain knowledge, no data fetching, no
 * routing. Just the outer chrome and typography.
 */

import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { CSSProperties } from 'react'

interface PageContainerProps {
  children: React.ReactNode
  className?: string
  /** @deprecated No visual effect since the 2026-09 redesign; kept so call sites compile. */
  grid?: boolean
}

/**
 * The page's scroll container. Fills the shell's <main> (which is
 * viewport-locked), scrolls internally, and centres content at
 * max-w-[1400px] with responsive gutters.
 */
export function PageContainer({ children, className }: PageContainerProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(
          'mx-auto flex w-full max-w-[1400px] flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}

interface PageHeroProps {
  /** @deprecated Not rendered since the 2026-09 redesign (breadcrumb covers it). */
  eyebrow?: string
  title: React.ReactNode
  description?: React.ReactNode
  /** Right-hand actions (buttons, badges). Stacks under the title on mobile. */
  actions?: React.ReactNode
  /** Convenience for a single primary CTA link with an arrow. */
  primaryAction?: {
    to: string
    label: string
  }
}

/** The page header: title, muted one-line description, actions on the end side. */
export function PageHero({ title, description, actions, primaryAction }: PageHeroProps) {
  const trailing = primaryAction ? (
    <Button asChild className="shrink-0">
      <Link to={primaryAction.to}>
        {primaryAction.label}
        <ArrowRight className="h-4 w-4 rtl:rotate-180" />
      </Link>
    </Button>
  ) : (
    actions
  )

  return (
    // Wraps rather than squeezes: the title keeps at least 22rem, and when
    // that plus the actions don't fit, the actions drop to their own line.
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 flex-1 basis-[22rem] space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-[28px] sm:leading-9">{title}</h1>
        {description && (
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {trailing && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{trailing}</div>}
    </header>
  )
}

interface PageChapterProps {
  /** @deprecated Not rendered since the 2026-09 redesign. */
  eyebrow?: string
  title: string
  description?: string
  /** End-side header content (filter chips, tab bar, secondary CTA). */
  actions?: React.ReactNode
  children: React.ReactNode
  /** Extra classes on the outer <section>. */
  className?: string
}

/** A titled section within a page. */
export function PageChapter({ title, description, actions, children, className }: PageChapterProps) {
  return (
    <section className={cn('space-y-3', className)}>
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  )
}

/** Staggered entry for page sections: `<section {...rise(2)}>` (see .sgv-rise). */
export function rise(i: number, className?: string): { className: string; style: CSSProperties } {
  return { className: cn('sgv-rise', className), style: { '--sgv-i': i } as CSSProperties }
}
