import { AuthGuard, GuestOnly } from '@/components/auth-guard'
import { CommandPalette } from '@/components/command-palette'
import { ScrollToTop } from '@/components/scroll-to-top'
import { AppSidebar, MobileSidebar, useSidebarCollapsed } from '@/components/app-shell/app-sidebar'
import { AppTopbar } from '@/components/app-shell/app-topbar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/feedback/toaster'
import { OfflineBanner } from '@/components/feedback/offline-banner'
import { TopLoadingBar } from '@/components/feedback/top-loading-bar'
import { useDataSourceScheduler } from '@/lib/data-link'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import AdminPage from '@/routes/admin'
import CreateGrids from '@/routes/create-grids'
import Dashboard from '@/routes/dashboard'
import DataPage from '@/routes/data'
import FilesPage from '@/routes/files'
import ForgotPasswordPage from '@/routes/forgot-password'
import IntegrationsPage from '@/routes/integrations'
import LoginPage from '@/routes/login'
import MembersPage from '@/routes/members'
import ProfilePage from '@/routes/profile'
import ReportBuilderPage from '@/routes/report-builder'
import ReportDetailPage from '@/routes/report-detail'
import ReportsPage from '@/routes/reports'
import SharedReportPage from '@/routes/shared-report'
import SignupPage from '@/routes/signup'
import SolutionPage from '@/routes/solution'
import { SolutionScopeBar } from '@/components/solutions/solution-scope-bar'
import TableDetailPage from '@/routes/table-detail'
import TableNewPage from '@/routes/table-new'
import TablesPage from '@/routes/tables'
import View from '@/routes/view'
import Warehouses from '@/routes/warehouses'
import WorkspacesPage from '@/routes/workspaces'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom'

function AppContent() {
  const { i18n } = useTranslation()
  const location = useLocation()

  // App-level data-source scheduler. Keeps REST/webhook interval pulls
  // running regardless of which route is open — the integrations page
  // in particular relies on this so configured sources keep refreshing
  // even when the editor isn't mounted. The hook is idempotent and
  // backoff-aware; see `src/lib/data-link/scheduler.ts`.
  //
  // Gated OFF on the `/view` and `/share` viewer routes so shape-only
  // viewing doesn't fire background REST polls, webhook drains, or
  // reference lookups. Those routes now behave like a read-only map
  // renderer. Re-enable per-route when the linked-data tooltip
  // integration lands.
  const isViewerRoute =
    location.pathname.startsWith('/view') || location.pathname.startsWith('/share')

  // Scope the scheduler to the currently-viewed warehouse (via the
  // `?warehouseId=` query param the editor route uses) so background
  // REST polls only run for sources bound to THIS warehouse. Without
  // this, opening Airport would keep firing Hospital's REST feeds in
  // the background, showing up as constant HTTP traffic + noisy sidebar
  // rows. Falls back to null (schedule every source) when no warehouse
  // is active — that's the correct behaviour on the Integrations page
  // and other global screens.
  const schedulerZoneId = useMemo(() => {
    const p = new URLSearchParams(location.search).get('warehouseId')
    if (p !== null && /^\d+$/.test(p)) return Number(p)
    return null
  }, [location.search])
  // Scheduled syncs write (and replace-all purges) data, so they run only
  // in the tabs of members who may edit — never a viewer's (the API
  // refuses their deletes/purges).
  const { canEdit } = useWorkspaceRole()
  useDataSourceScheduler(!isViewerRoute && canEdit, schedulerZoneId)

  // Keep <html lang> and <html dir> in sync with the active i18n
  // language so the browser flips spell-check, voice-input language,
  // and RTL behaviour correctly. The hardcoded `lang="en"` in
  // index.html is only correct on first paint; this effect owns the
  // value past that point.
  useEffect(() => {
    const apply = () => {
      document.documentElement.lang = i18n.language
      document.documentElement.dir = i18n.dir()
    }
    apply()
    i18n.on('languageChanged', apply)
    return () => {
      i18n.off('languageChanged', apply)
    }
  }, [i18n])
  const isCreateGrids = location.pathname === '/create-grids' || location.pathname === '/preview'
  // Preview mode (`/view/:warehouseId`) mounts through the AuthGuard
  // so the standard header (theme picker, workspace switcher, nav) is
  // available — users hit Preview from the editor and expect to keep
  // the same chrome they had there. Share-link mode (`/share/:token`)
  // stays outside the AuthGuard entirely (see the App component's
  // route table) so external viewers still get a chrome-less surface.
  const isPreviewView = location.pathname.startsWith('/view/')
  const isMapRoute = isCreateGrids || isPreviewView
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  // Below md the editor panel is a drawer over the map; starting it open
  // hid the whole map on a phone. Selecting a shape still opens it.
  const [sidePanelOpen, setSidePanelOpen] = useState(() => typeof window === 'undefined' || window.matchMedia('(min-width: 768px)').matches)
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed()

  // The page scrolls inside <main> (the shell is viewport-locked), so the
  // window-level ScrollToTop no longer reaches it — reset it here.
  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0)
  }, [location.pathname])

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <AppSidebar
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        forceRail={isMapRoute}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar
          onOpenMenu={() => setMobileMenuOpen(true)}
          onOpenSearch={() => setPaletteOpen(true)}
          isMapRoute={isMapRoute}
        />

        <OfflineBanner />
        {!isMapRoute && <SolutionScopeBar />}

        {/* Map routes lock the viewport; every other route scrolls inside
            <main> (PageContainer fills it and owns its own scroll). */}
        <main
          ref={mainRef}
          className={isMapRoute ? 'relative min-h-0 flex-1 overflow-hidden' : 'relative min-h-0 flex-1 overflow-y-auto'}
        >
          {isCreateGrids ? (
            <CreateGrids
              panelOpen={sidePanelOpen}
              onPanelOpenChange={setSidePanelOpen}
              preview={location.pathname === '/preview'}
            />
          ) : (
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/warehouses" element={<Warehouses />} />
              <Route path="/integrations" element={<IntegrationsPage />} />
              <Route path="/tables" element={<TablesPage />} />
              <Route path="/tables/new" element={<TableNewPage />} />
              <Route path="/tables/:id" element={<TableDetailPage />} />
              <Route path="/files" element={<FilesPage />} />
              <Route path="/data" element={<DataPage />} />
              <Route path="/solutions/:id" element={<SolutionPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="/reports/new" element={<ReportBuilderPage />} />
              <Route path="/reports/:id" element={<ReportDetailPage />} />
              <Route path="/reports/:id/edit" element={<ReportBuilderPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/members" element={<MembersPage />} />
              <Route path="/workspaces" element={<WorkspacesPage />} />
              {/* Preview view — matched here (inside AuthGuard) rather
                  than at the top-level router so the app shell renders
                  around it. The public share-link variant (`/share/:token`)
                  stays at the top-level router so it remains chrome-less. */}
              <Route path="/view/:warehouseId" element={<View />} />
            </Routes>
          )}
        </main>
      </div>

      {/* Overlays */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        showPanelAction={isCreateGrids}
        onTogglePanel={() => setSidePanelOpen((v) => !v)}
      />
      <MobileSidebar open={mobileMenuOpen} onOpenChange={setMobileMenuOpen} />
      <Toaster />
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <TooltipProvider delayDuration={250}>
      <ScrollToTop />
      <TopLoadingBar />
      <Routes>
        {/* Token-based share link — public, chrome-less presentation
            view for external viewers who don't have (and shouldn't
            need) an account. Kept OUTSIDE the AuthGuard on purpose so
            it renders even without a session. The auth-mode preview
            variant (`/view/:warehouseId`) is now matched INSIDE
            AppContent's Routes so it inherits the standard header
            (theme picker, workspace switcher, nav) — users hit
            Preview from the editor and expect the same chrome. */}
        <Route path="/share/:token" element={<View mode="token" />} />
        {/* A public link to one report — same idea as /share/:token, for
            a report (its widgets, live map and history), no account. */}
        <Route path="/r/:token" element={<SharedReportPage />} />
        {/* Auth screens. Public; AuthGuard does not wrap these. GuestOnly
            sends an already-signed-in user on to the app; the reset flow
            stays reachable signed-in (it's also how you change a password). */}
        <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
        <Route path="/signup" element={<GuestOnly><SignupPage /></GuestOnly>} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        {/* Everything else requires a session. */}
        <Route
          path="*"
          element={
            <AuthGuard>
              <AppContent />
            </AuthGuard>
          }
        />
      </Routes>
      </TooltipProvider>
    </BrowserRouter>
  )
}

export default App
