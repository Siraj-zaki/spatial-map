import {
  Bell,
  Database,
  FileBarChart,
  FolderOpen,
  LayoutDashboard,
  Plug,
  ShieldCheck,
  Table as TableIcon,
  Warehouse,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  path: string
  /** i18n key under `nav.*`. */
  key: string
  fallback: string
  icon: LucideIcon
}

// Layout Editor (`/create-grids`) is intentionally NOT in the nav — it
// needs a warehouse id (`?warehouseId=<id>`) to render anything useful.
// Users reach it from a facility's "Edit layout" action.
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/dashboard', key: 'nav.dashboard', fallback: 'Dashboard', icon: LayoutDashboard },
  { path: '/warehouses', key: 'nav.warehouses', fallback: 'Facilities', icon: Warehouse },
  { path: '/integrations', key: 'nav.integrations', fallback: 'Integrations', icon: Plug },
  { path: '/files', key: 'nav.files', fallback: 'Files', icon: FolderOpen },
  { path: '/tables', key: 'nav.tables', fallback: 'Tables', icon: TableIcon },
  { path: '/data', key: 'nav.data', fallback: 'Data', icon: Database },
  { path: '/reports', key: 'nav.reports', fallback: 'Reports', icon: FileBarChart },
  { path: '/alerts', key: 'nav.alerts', fallback: 'Alerts', icon: Bell },
]

/** Platform-admin only (users with `isPlatformAdmin`). */
export const ADMIN_NAV_ITEM: NavItem = {
  path: '/admin',
  key: 'nav.admin',
  fallback: 'Admin',
  icon: ShieldCheck,
}

/** The nav item a pathname belongs to (sub-routes like /tables/12 included). */
export function activeNavItem(pathname: string): NavItem | null {
  if (pathname === '/') return NAV_ITEMS[0]
  return (
    [...NAV_ITEMS, ADMIN_NAV_ITEM].find(
      (item) => pathname === item.path || pathname.startsWith(item.path + '/'),
    ) ?? null
  )
}
