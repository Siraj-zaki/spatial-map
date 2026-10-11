/**
 * Slim top bar above the page (h-12 — pages that size against the old
 * header's `100dvh-3rem` keep working). Left: mobile menu + "Workspace /
 * Page" breadcrumb. Right: search (command palette) and, on map routes,
 * the zoom / fullscreen controls the active map publishes through
 * `useHeaderControls`.
 */

import { useSyncExternalStore } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Maximize2, Menu, Minimize2, Search, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/lib/auth-store'
import { useHeaderControls } from '@/lib/header-controls'
import { getCurrentTenantIdSync, subscribeTenantChanges } from '@/lib/tenant-store'
import { activeNavItem } from './nav-items'
import { useSolutionLocation } from './sidebar-solutions'
import { SolutionIcon } from '@/components/solutions/solution-identity'
import { solutionPath, useSolutions } from '@/lib/solutions-client'

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

export function AppTopbar({
  onOpenMenu,
  onOpenSearch,
  isMapRoute,
}: {
  onOpenMenu: () => void
  onOpenSearch: () => void
  isMapRoute: boolean
}) {
  const { t } = useTranslation()
  const location = useLocation()
  const tenantId = useSyncExternalStore(subscribeTenantChanges, getCurrentTenantIdSync, () => null)
  const tenants = useAuthStore((s) => s.tenants)
  const workspace = tenants.find((x) => x.id === tenantId) ?? tenants[0] ?? null
  const section = activeNavItem(location.pathname)
  // Inside a solution: Workspace › Hospital › Facilities.
  const here = useSolutionLocation()
  const { data: solutions } = useSolutions()
  const solution = here.id != null ? (solutions ?? []).find((s) => s.id === here.id) ?? null : null

  const onZoomIn = useHeaderControls((s) => s.onZoomIn)
  const onZoomOut = useHeaderControls((s) => s.onZoomOut)
  const onToggleFullscreen = useHeaderControls((s) => s.onToggleFullscreen)
  const isFullscreen = useHeaderControls((s) => s.isFullscreen)

  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur-md sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="-ms-1 h-8 w-8 md:hidden"
        onClick={onOpenMenu}
        aria-label={t('header.openMenu')}
      >
        <Menu className="h-5 w-5" />
      </Button>
      <img src="/logo.png" alt="" className="h-6 w-auto md:hidden" />

      {/* Breadcrumb — where am I, in which workspace. */}
      <nav aria-label={t('header.breadcrumb', { defaultValue: 'Breadcrumb' })} className="hidden min-w-0 items-center gap-1.5 text-sm sm:flex">
        {workspace && (
          <>
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: workspace.color }} aria-hidden />
              <span className="truncate">{workspace.name}</span>
            </span>
            {(section || solution) && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 rtl:rotate-180" aria-hidden />}
          </>
        )}
        {solution && (
          <>
            {here.tab ? (
              <Link to={solutionPath(solution.id)} className="flex min-w-0 items-center gap-1.5 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <SolutionIcon icon={solution.icon} color={solution.color} size="xs" />
                <span dir="auto" className="truncate">{solution.name}</span>
              </Link>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground" aria-current="page">
                <SolutionIcon icon={solution.icon} color={solution.color} size="xs" />
                <span dir="auto" className="truncate">{solution.name}</span>
              </span>
            )}
            {here.tab && section && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 rtl:rotate-180" aria-hidden />}
          </>
        )}
        {section && (!solution || here.tab) && (
          <span className="truncate font-medium text-foreground" aria-current="page">
            {t(section.key, { defaultValue: section.fallback })}
          </span>
        )}
      </nav>

      <div className="ms-auto flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenSearch}
          className="h-8 w-8 justify-center gap-2 px-0 font-normal text-muted-foreground sm:w-56 sm:justify-start sm:px-2.5 lg:w-64"
          aria-label={t('header.search')}
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="hidden truncate text-sm sm:inline">{t('header.searchPlaceholder', { defaultValue: 'Search…' })}</span>
          <kbd className="pointer-events-none ms-auto hidden h-5 select-none items-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:inline-flex">
            {isMac ? '⌘' : 'Ctrl '}K
          </kbd>
        </Button>

        {isMapRoute && (
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onZoomOut?.()}
              disabled={!onZoomOut}
              className="h-8 w-8"
              aria-label={t('toolbar.zoomOut', { defaultValue: 'Zoom out' })}
              title={t('toolbar.zoomOut', { defaultValue: 'Zoom out' })}
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onZoomIn?.()}
              disabled={!onZoomIn}
              className="h-8 w-8"
              aria-label={t('toolbar.zoomIn', { defaultValue: 'Zoom in' })}
              title={t('toolbar.zoomIn', { defaultValue: 'Zoom in' })}
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onToggleFullscreen?.()}
              disabled={!onToggleFullscreen}
              className="h-8 w-8"
              aria-label={t('toolbar.fullscreen', { defaultValue: 'Fullscreen' })}
              title={t('toolbar.fullscreen', { defaultValue: 'Fullscreen' })}
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          </div>
        )}
      </div>
    </header>
  )
}
