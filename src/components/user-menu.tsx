import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Boxes,
  Check,
  ChevronsUpDown,
  Globe,
  LogOut,
  Palette,
  SunMoon,
  User,
  Users,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LANGUAGES } from '@/components/language-switcher'
import { THEMES } from '@/components/mode-toggle'
import { PaletteGrid } from '@/components/theme-picker'
import { useTheme } from '@/components/theme-provider'
import { useAuthStore, type AuthRole } from '@/lib/auth-store'
import { logout } from '@/lib/auth-client'
import { getCurrentTenantIdSync } from '@/lib/tenant-store'
import { rewriteFilesUrlSameOrigin } from '@/lib/binary-store'
import { cn } from '@/lib/utils'

/**
 * Account menu at the foot of the app sidebar: who's signed in, account
 * pages, and the personal preferences (language, palette, light/dark) that
 * used to crowd the header. Collapsed sidebar → avatar only.
 *
 * Members management is gated to owner/admin roles on the current tenant.
 */
export function UserMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const user = useAuthStore((s) => s.user)
  const tenants = useAuthStore((s) => s.tenants)

  if (!user) return null

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const currentTenantId = getCurrentTenantIdSync()
  const myRole: AuthRole | null = tenants.find((t) => t.id === currentTenantId)?.role ?? null
  const canManageMembers = myRole === 'owner' || myRole === 'admin'
  const displayLabel = user.displayName || user.email
  const currentLang = i18n.resolvedLanguage || i18n.language || 'en'

  const avatar = (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-semibold ring-1 ring-border">
      {user.avatarUrl ? (
        <img src={rewriteFilesUrlSameOrigin(user.avatarUrl)} alt="" className="h-full w-full object-cover" />
      ) : (
        displayLabel.charAt(0).toUpperCase()
      )}
    </span>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg text-start transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent',
            collapsed ? 'h-10 w-10 justify-center' : 'h-12 px-2',
          )}
          aria-label={t('auth.userMenu')}
          title={collapsed ? displayLabel : undefined}
        >
          {avatar}
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium leading-tight">{displayLabel}</span>
                {user.displayName && (
                  <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                    {user.email}
                  </span>
                )}
              </span>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={collapsed ? 'right' : 'top'} align="start" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium">{displayLabel}</p>
          {user.displayName && <p className="truncate text-xs text-muted-foreground">{user.email}</p>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/profile')} className="cursor-pointer">
          <User className="me-2 h-4 w-4" />
          {t('profile.menuItem')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/workspaces')} className="cursor-pointer">
          <Boxes className="me-2 h-4 w-4" />
          {t('workspace.manage')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => navigate('/members')}
          disabled={!canManageMembers}
          className={canManageMembers ? 'cursor-pointer' : 'cursor-not-allowed text-muted-foreground'}
        >
          <Users className="me-2 h-4 w-4" />
          {t('auth.manageMembers')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="cursor-pointer">
            <Globe className="me-2 h-4 w-4" />
            <span className="flex-1">{t('userMenu.language', { defaultValue: 'Language' })}</span>
            <span className="ms-2 text-[10px] font-medium uppercase text-muted-foreground">{currentLang}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-[180px]">
            {LANGUAGES.map((lang) => (
              <DropdownMenuItem
                key={lang.code}
                onSelect={() => i18n.changeLanguage(lang.code)}
                className="cursor-pointer"
              >
                <span className="flex-1">{lang.name}</span>
                {currentLang === lang.code && <Check className="h-3.5 w-3.5 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="cursor-pointer">
            <SunMoon className="me-2 h-4 w-4" />
            {t('userMenu.appearance', { defaultValue: 'Appearance' })}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-[160px]">
            {THEMES.map((item) => (
              <DropdownMenuItem key={item.value} onSelect={() => setTheme(item.value)} className="cursor-pointer">
                <span className="flex-1">{t(item.labelKey)}</span>
                {theme === item.value && <Check className="h-3.5 w-3.5 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="cursor-pointer">
            <Palette className="me-2 h-4 w-4" />
            {t('theme.pickerHeading', { defaultValue: 'Palette' })}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60 p-2">
            <PaletteGrid />
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleLogout} className="cursor-pointer">
          <LogOut className="me-2 h-4 w-4" />
          {t('auth.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
