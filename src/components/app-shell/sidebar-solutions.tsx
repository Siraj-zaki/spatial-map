/**
 * The sidebar's "Solutions" section: one entry per solution in the
 * workspace (its icon, colour and name), the active one expanded into its
 * pages — Overview, Facilities, Reports, Tables, Data, Integrations — and
 * "New solution" for people who can edit. Collapsed rail: icon tiles with
 * tooltips.
 */

import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Database, FileBarChart, LayoutDashboard, Plug, Plus, Table as TableIcon, Warehouse } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { SolutionIcon } from '@/components/solutions/solution-identity'
import { SolutionDialog } from '@/components/solutions/solution-dialog'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { solutionPath, useSolutions, type Solution } from '@/lib/solutions-client'
import { cn } from '@/lib/utils'

type SolutionTab = '' | 'facilities' | 'reports' | 'tables' | 'data' | 'integrations'

const PAGES: { tab: SolutionTab; path: string; key: string; fallback: string; icon: typeof Warehouse }[] = [
  { tab: '', path: '/solutions', key: 'solutions.overview', fallback: 'Overview', icon: LayoutDashboard },
  { tab: 'facilities', path: '/warehouses', key: 'nav.warehouses', fallback: 'Facilities', icon: Warehouse },
  { tab: 'reports', path: '/reports', key: 'nav.reports', fallback: 'Reports', icon: FileBarChart },
  { tab: 'tables', path: '/tables', key: 'nav.tables', fallback: 'Tables', icon: TableIcon },
  { tab: 'data', path: '/data', key: 'nav.data', fallback: 'Data', icon: Database },
  { tab: 'integrations', path: '/integrations', key: 'nav.integrations', fallback: 'Integrations', icon: Plug },
]

// Per-solution expand/collapse the user chose. Absent = automatic (open
// while you're inside that solution). Persisted so the choice survives
// navigation and the mobile sheet remounting.
const OPEN_KEY = 'sgv-solution-open'
function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}
function useSolutionOpen(id: number, active: boolean): [boolean, () => void] {
  const [choice, setChoice] = useState<boolean | undefined>(() => readOpen()[id])
  const open = choice ?? active
  const toggle = () => {
    const next = !open
    setChoice(next)
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify({ ...readOpen(), [id]: next }))
    } catch {
      // storage unavailable — the choice lasts until reload
    }
  }
  return [open, toggle]
}

/** Which solution (and page of it) the URL is on, if any. */
export function useSolutionLocation(): { id: number | null; tab: SolutionTab | null } {
  const { pathname, search } = useLocation()
  const m = pathname.match(/^\/solutions\/(\d+)/)
  if (m) return { id: Number(m[1]), tab: '' }
  const raw = new URLSearchParams(search).get('solution')
  if (!raw || !/^\d+$/.test(raw)) return { id: null, tab: null }
  const page = PAGES.find((p) => p.tab && (pathname === p.path || pathname.startsWith(p.path + '/')))
  return { id: Number(raw), tab: page ? page.tab : null }
}

export function SidebarSolutions({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation()
  const { canEdit } = useWorkspaceRole()
  const { data, isLoading } = useSolutions()
  const here = useSolutionLocation()
  const [creating, setCreating] = useState(false)
  const solutions = data ?? []

  const newButton = canEdit && (
    <button
      type="button"
      onClick={() => setCreating(true)}
      aria-label={t('solutions.new', { defaultValue: 'New solution' })}
      title={t('solutions.new', { defaultValue: 'New solution' })}
      className={cn(
        'flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        collapsed ? 'h-9 w-9 rounded-lg border border-dashed' : 'h-6 w-6',
      )}
    >
      <Plus className={collapsed ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden />
    </button>
  )

  return (
    <section aria-label={t('solutions.section', { defaultValue: 'Solutions' })}>
      {collapsed ? (
        <div className="mx-auto my-3 h-px w-6 bg-border" />
      ) : (
        <div className="mt-5 flex items-center justify-between px-2.5 pb-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">{t('solutions.section', { defaultValue: 'Solutions' })}</p>
          {newButton}
        </div>
      )}

      {isLoading && !data ? (
        <div className={cn('space-y-1', collapsed ? 'flex flex-col items-center' : 'px-1')} aria-hidden>
          {[0, 1].map((i) => (
            <Skeleton key={i} className={collapsed ? 'h-9 w-9 rounded-lg' : 'h-8 w-full rounded-lg'} />
          ))}
        </div>
      ) : solutions.length === 0 ? (
        collapsed ? (
          canEdit && <div className="flex justify-center">{newButton}</div>
        ) : (
          <div className="mx-1 rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
            <p>{t('solutions.sidebarEmpty', { defaultValue: 'Group facilities, reports and data for one use case — Hospital, Anti-theft…' })}</p>
            {canEdit && (
              <button type="button" onClick={() => setCreating(true)} className="mt-1.5 font-medium text-primary hover:underline">
                {t('solutions.createFirst', { defaultValue: 'Create a solution' })}
              </button>
            )}
          </div>
        )
      ) : (
        <ul className={cn('space-y-0.5', collapsed && 'flex flex-col items-center')}>
          {solutions.map((s) => (
            <li key={s.id}>
              <SolutionEntry solution={s} collapsed={collapsed} active={here.id === s.id} activeTab={here.id === s.id ? here.tab : null} onNavigate={onNavigate} />
            </li>
          ))}
          {collapsed && canEdit && <li>{newButton}</li>}
        </ul>
      )}

      {creating && <SolutionDialog open={creating} onOpenChange={setCreating} mode="create" />}
    </section>
  )
}

function SolutionEntry({
  solution,
  collapsed,
  active,
  activeTab,
  onNavigate,
}: {
  solution: Solution
  collapsed: boolean
  active: boolean
  activeTab: SolutionTab | null
  onNavigate?: () => void
}) {
  const { t } = useTranslation()
  const [open, toggle] = useSolutionOpen(solution.id, active)
  const link = (
    <Link
      to={solutionPath(solution.id)}
      onClick={onNavigate}
      aria-current={active && activeTab === '' ? 'page' : undefined}
      aria-label={collapsed ? solution.name : undefined}
      className={cn(
        'flex min-w-0 items-center gap-2.5 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        collapsed ? 'h-9 w-9 justify-center' : 'h-9 flex-1 px-2',
        active
          ? collapsed
            ? 'bg-background shadow-sm ring-1 ring-border'
            : 'text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <SolutionIcon icon={solution.icon} color={solution.color} size={collapsed ? 'sm' : 'xs'} />
      {!collapsed && <span dir="auto" className="min-w-0 flex-1 truncate">{solution.name}</span>}
    </Link>
  )

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{solution.name}</TooltipContent>
      </Tooltip>
    )
  }
  const pagesId = `solution-pages-${solution.id}`
  return (
    <div>
      <div className="group flex items-center gap-0.5">
        {link}
        {/* Separate from the link: the name opens the solution, the
            chevron only shows / hides its pages. */}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={pagesId}
          aria-label={
            open
              ? t('solutions.collapse', { name: solution.name, defaultValue: 'Hide {{name}} pages' })
              : t('solutions.expand', { name: solution.name, defaultValue: 'Show {{name}} pages' })
          }
          title={
            open
              ? t('solutions.collapse', { name: solution.name, defaultValue: 'Hide {{name}} pages' })
              : t('solutions.expand', { name: solution.name, defaultValue: 'Show {{name}} pages' })
          }
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            open || active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
          )}
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform motion-reduce:transition-none', open && '-rotate-180')} aria-hidden />
        </button>
      </div>
      {open && (
        <ul id={pagesId} className="sgv-fade relative mb-1 ms-[1.15rem] space-y-0.5 border-s ps-2.5 pt-0.5" style={{ borderColor: solution.color ? `${solution.color}55` : undefined }}>
          {PAGES.map((p) => {
            const on = activeTab === p.tab
            return (
              <li key={p.key}>
                <Link
                  to={solutionPath(solution.id, p.tab)}
                  onClick={onNavigate}
                  aria-current={on ? 'page' : undefined}
                  className={cn(
                    'flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    on ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <p.icon className="h-3.5 w-3.5 shrink-0" style={on && solution.color ? { color: solution.color } : undefined} aria-hidden />
                  <span className="truncate">{t(p.key, { defaultValue: p.fallback })}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
