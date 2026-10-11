/**
 * The strip under the top bar on every page of a solution: which solution
 * you're in, its pages as tabs (Overview · Facilities · Reports · Tables ·
 * Data · Integrations), "Manage contents", and a way out to the whole
 * workspace. Pages filter themselves from `?solution=`; this only shows
 * and switches the scope.
 */

import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ListChecks, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { useSolutionLocation } from '@/components/app-shell/sidebar-solutions'
import { solutionPath, useSolutions } from '@/lib/solutions-client'
import { SolutionIcon } from './solution-identity'
import { SolutionDialog } from './solution-dialog'

const TABS = [
  { tab: '', key: 'solutions.overview', fallback: 'Overview' },
  { tab: 'facilities', key: 'nav.warehouses', fallback: 'Facilities' },
  { tab: 'reports', key: 'nav.reports', fallback: 'Reports' },
  { tab: 'tables', key: 'nav.tables', fallback: 'Tables' },
  { tab: 'data', key: 'nav.data', fallback: 'Data' },
  { tab: 'integrations', key: 'nav.integrations', fallback: 'Integrations' },
] as const

const PLAIN_PATH: Record<string, string> = { facilities: '/warehouses', reports: '/reports', tables: '/tables', data: '/data', integrations: '/integrations' }

export function SolutionScopeBar() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { canEdit } = useWorkspaceRole()
  const here = useSolutionLocation()
  const { data, isLoading } = useSolutions()
  const [managing, setManaging] = useState(false)
  if (here.id == null) return null
  // Detail routes (/reports/12?solution=…) keep the scope in the URL but
  // don't need the strip.
  if (here.tab == null && !pathname.startsWith('/solutions/')) return null
  const solution = (data ?? []).find((s) => s.id === here.id) ?? null

  if (!solution) {
    if (isLoading) return <div className="h-11 shrink-0 border-b bg-background/60" aria-hidden />
    // Deleted or another workspace's solution: say so and offer the way out.
    return (
      <div className="flex h-11 shrink-0 items-center gap-3 border-b bg-muted/40 px-4 text-sm" role="status">
        <span className="text-muted-foreground">{t('solutions.notFoundBar', { defaultValue: 'This solution no longer exists.' })}</span>
        {here.tab && (
          <Link to={PLAIN_PATH[here.tab] ?? '/dashboard'} className="font-medium text-primary hover:underline">
            {t('solutions.showAll', { defaultValue: 'Show the whole workspace' })}
          </Link>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex h-11 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur sm:px-4"
      style={{ boxShadow: solution.color ? `inset 0 -2px 0 ${solution.color}33` : undefined }}
    >
      <Link
        to={solutionPath(solution.id)}
        className="flex min-w-0 max-w-[40%] shrink-0 items-center gap-2 rounded-md pe-1 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[14rem]"
      >
        <SolutionIcon icon={solution.icon} color={solution.color} size="sm" />
        <span dir="auto" className="truncate">{solution.name}</span>
      </Link>
      <nav aria-label={t('solutions.pages', { defaultValue: 'Solution pages' })} className="sgv-scroll-hide flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [mask-image:linear-gradient(to_right,#000_82%,transparent)] rtl:[mask-image:linear-gradient(to_left,#000_82%,transparent)] lg:[mask-image:none]">
        {TABS.map((tb) => {
          const on = here.tab === tb.tab
          return (
            <Link
              key={tb.key}
              to={solutionPath(solution.id, tb.tab)}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'relative shrink-0 rounded-md px-2.5 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                on ? 'font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {t(tb.key, { defaultValue: tb.fallback })}
              {on && (
                <span className="absolute inset-x-2 -bottom-[7px] h-0.5 rounded-full" style={{ background: solution.color || 'hsl(var(--primary))' }} aria-hidden />
              )}
            </Link>
          )
        })}
      </nav>
      {/* The overview has its own "Manage contents" in the page header. */}
      {canEdit && here.tab !== '' && (
        <button
          type="button"
          onClick={() => setManaging(true)}
          className="hidden shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex"
        >
          <ListChecks className="h-3.5 w-3.5" aria-hidden />
          {t('solutions.manage', { defaultValue: 'Manage contents' })}
        </button>
      )}
      <button
        type="button"
        onClick={() => navigate(here.tab ? (PLAIN_PATH[here.tab] ?? '/dashboard') : '/dashboard')}
        aria-label={t('solutions.exit', { defaultValue: 'Leave solution — show the whole workspace' })}
        title={t('solutions.exit', { defaultValue: 'Leave solution — show the whole workspace' })}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
      {managing && <SolutionDialog open={managing} onOpenChange={setManaging} mode="items" solution={solution} />}
    </div>
  )
}
