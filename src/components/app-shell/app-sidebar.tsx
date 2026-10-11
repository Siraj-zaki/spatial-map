/**
 * App sidebar — primary navigation for every authenticated screen.
 *
 * Top to bottom: brand + collapse toggle, workspace switcher, the seven
 * product areas, the workspace's Solutions (`sidebar-solutions.tsx`),
 * Admin (platform admins only), and the account menu, which
 * also holds language / palette / light-dark (moved out of the header).
 *
 * Two widths: expanded (w-60) and a collapsed icon rail (w-[60px]) with
 * tooltips. The choice persists per browser (localStorage). Map routes
 * (layout editor, preview) always use the rail so the map gets the room.
 *
 * <md the sidebar isn't rendered inline; `MobileSidebar` shows the same
 * content in a slide-over sheet opened from the top bar.
 */

import { useCallback, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UserMenu } from '@/components/user-menu'
import { WorkspaceSwitcher } from '@/components/workspace-switcher'
import { useAuthStore } from '@/lib/auth-store'
import { cn } from '@/lib/utils'
import { ADMIN_NAV_ITEM, NAV_ITEMS, activeNavItem, type NavItem } from './nav-items'
import { SidebarSolutions, useSolutionLocation } from './sidebar-solutions'

const STORAGE_KEY = 'sgv-sidebar-collapsed'

/** Persisted expanded/collapsed preference. */
export function useSidebarCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const set = useCallback((v: boolean) => {
    setCollapsed(v)
    try {
      localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
    } catch {
      // storage unavailable — preference lasts for this session only
    }
  }, [])
  return [collapsed, set]
}

function NavLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  collapsed: boolean
  onNavigate?: () => void
}) {
  const { t } = useTranslation()
  const label = t(item.key, { defaultValue: item.fallback })
  const link = (
    <Link
      to={item.path}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      className={cn(
        'group relative flex items-center gap-3 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        collapsed ? 'h-9 w-9 justify-center' : 'h-9 px-2.5',
        active
          ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <item.icon className={cn('h-4 w-4 shrink-0', active && 'text-primary')} />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  )
  if (!collapsed) return link
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function SidebarContent({
  collapsed,
  onToggle,
  onNavigate,
  showToggle,
}: {
  collapsed: boolean
  onToggle?: () => void
  onNavigate?: () => void
  showToggle: boolean
}) {
  const { t } = useTranslation()
  const location = useLocation()
  const isAdmin = useAuthStore((s) => Boolean(s.user?.isPlatformAdmin))
  // Inside a solution its own entry is the active one, not the plain page.
  const inSolution = useSolutionLocation().id != null
  const active = inSolution ? null : activeNavItem(location.pathname)
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className={cn('flex h-14 shrink-0 items-center', collapsed ? 'justify-center' : 'justify-between px-3')}>
        <Link
          to="/dashboard"
          onClick={onNavigate}
          className="flex min-w-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Spatial Map"
        >
          <img src="/logo.png" alt="" className="h-7 w-auto shrink-0" />
          {!collapsed && <span className="truncate text-[15px] font-semibold tracking-tight">Spatial Map</span>}
        </Link>
        {showToggle && !collapsed && (
          <button
            type="button"
            onClick={onToggle}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('sidebar.collapse', { defaultValue: 'Collapse sidebar' })}
            title={t('sidebar.collapse', { defaultValue: 'Collapse sidebar' })}
          >
            <ToggleIcon className="h-4 w-4 rtl:-scale-x-100" />
          </button>
        )}
      </div>

      {/* Workspace */}
      <div className={cn('shrink-0 pb-2', collapsed ? 'flex justify-center' : 'px-2')}>
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>

      {/* Primary nav */}
      <nav
        aria-label={t('sidebar.mainNav', { defaultValue: 'Main' })}
        className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain py-2', collapsed ? 'px-0' : 'px-2')}
      >
        {!collapsed && (
          <p className="px-2.5 pb-1.5 text-[11px] font-medium text-muted-foreground">
            {t('sidebar.workspaceSection', { defaultValue: 'Workspace' })}
          </p>
        )}
        <ul className={cn('space-y-0.5', collapsed && 'flex flex-col items-center')}>
          {NAV_ITEMS.map((item) => (
            <li key={item.path}>
              <NavLink item={item} active={active === item} collapsed={collapsed} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
        <SidebarSolutions collapsed={collapsed} onNavigate={onNavigate} />
        {isAdmin && (
          <>
            {!collapsed ? (
              <p className="mt-5 px-2.5 pb-1.5 text-[11px] font-medium text-muted-foreground">
                {t('sidebar.platformSection', { defaultValue: 'Platform' })}
              </p>
            ) : (
              <div className="mx-auto my-3 h-px w-6 bg-border" />
            )}
            <ul className={cn(collapsed && 'flex flex-col items-center')}>
              <li>
                <NavLink
                  item={ADMIN_NAV_ITEM}
                  active={active === ADMIN_NAV_ITEM}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                />
              </li>
            </ul>
          </>
        )}
      </nav>

      {/* Footer: expand toggle (rail) + account */}
      <div className={cn('shrink-0 space-y-1 border-t py-2', collapsed ? 'flex flex-col items-center' : 'px-2')}>
        {showToggle && collapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggle}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('sidebar.expand', { defaultValue: 'Expand sidebar' })}
              >
                <ToggleIcon className="h-4 w-4 rtl:-scale-x-100" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{t('sidebar.expand', { defaultValue: 'Expand sidebar' })}</TooltipContent>
          </Tooltip>
        )}
        <UserMenu collapsed={collapsed} />
      </div>
    </div>
  )
}

export function AppSidebar({
  collapsed,
  onCollapsedChange,
  forceRail,
}: {
  collapsed: boolean
  onCollapsedChange: (v: boolean) => void
  /** Map routes: always the icon rail, no toggle. */
  forceRail: boolean
}) {
  const rail = forceRail || collapsed
  return (
    <aside
      className={cn(
        'hidden shrink-0 border-e bg-muted/40 transition-[width] duration-200 ease-out motion-reduce:transition-none md:block',
        rail ? 'w-[60px]' : 'w-60',
      )}
    >
      <SidebarContent collapsed={rail} showToggle={!forceRail} onToggle={() => onCollapsedChange(!collapsed)} />
    </aside>
  )
}

/** <md: the same sidebar in a slide-over sheet (anchored to the start side, RTL-aware). */
export function MobileSidebar({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="start" hideDefaultClose className="w-72 max-w-[85vw] rounded-none bg-muted">
        <SheetTitle className="sr-only">{t('header.menu')}</SheetTitle>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute end-3 top-3.5 z-10 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('header.closeMenu')}
        >
          <X className="h-4 w-4" />
        </button>
        <SidebarContent collapsed={false} showToggle={false} onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  )
}
