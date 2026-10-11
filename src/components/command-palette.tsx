import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Command } from 'cmdk'
import {
  Search,
  LayoutDashboard,
  Grid3X3,
  Sun,
  Moon,
  Monitor,
  Languages,
  PanelRight,
  ArrowRight,
} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useTheme } from '@/components/theme-provider'
import { cn } from '@/lib/utils'

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'zh', name: '中文' },
  { code: 'ar', name: 'العربية' },
] as const

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onTogglePanel?: () => void
  showPanelAction?: boolean
}

export function CommandPalette({
  open,
  onOpenChange,
  onTogglePanel,
  showPanelAction = false,
}: CommandPaletteProps) {
  const { t, i18n } = useTranslation()
  const { setTheme } = useTheme()
  const navigate = useNavigate()

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      } else if (e.key === 'Escape' && open) {
        onOpenChange(false)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [open, onOpenChange])

  const runCommand = (callback: () => void) => {
    onOpenChange(false)
    callback()
  }

  const isMac = useMemo(
    () => typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform),
    []
  )
  const modKey = isMac ? '⌘' : 'Ctrl'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl gap-0 p-0 overflow-hidden sm:rounded-xl"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{t('header.search')}</DialogTitle>
        <Command
          label={t('header.search')}
          className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
        >
          <div className="flex items-center border-b px-3">
            <Search className="me-2 h-4 w-4 shrink-0 opacity-50" />
            <Command.Input
              placeholder={t('command.placeholder')}
              className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
            <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
              <span className="text-xs">{modKey}</span>K
            </kbd>
          </div>
          <Command.List className="max-h-[400px] overflow-y-auto overscroll-contain overflow-x-hidden p-2">
            <Command.Empty className="py-8 text-center text-sm text-muted-foreground">
              {t('command.noResults')}
            </Command.Empty>

            <Command.Group heading={t('command.groupNavigation')}>
              <Command.Item
                value="dashboard"
                onSelect={() => runCommand(() => navigate('/dashboard'))}
                className="relative flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              >
                <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1">{t('command.openDashboard')}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground rtl:rotate-180" />
              </Command.Item>
              <Command.Item
                value="create-grids"
                onSelect={() => runCommand(() => navigate('/create-grids'))}
                className="relative flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              >
                <Grid3X3 className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1">{t('command.openCreateGrids')}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground rtl:rotate-180" />
              </Command.Item>
            </Command.Group>

            {showPanelAction && (
              <Command.Group heading={t('command.groupActions')}>
                <Command.Item
                  value="toggle-panel"
                  onSelect={() => runCommand(() => onTogglePanel?.())}
                  className="relative flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <PanelRight className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1">{t('command.openPanel')}</span>
                </Command.Item>
              </Command.Group>
            )}

            <Command.Group heading={t('command.groupTheme')}>
              <Command.Item
                value="theme light"
                onSelect={() => runCommand(() => setTheme('light'))}
                className="relative flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              >
                <Sun className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1">{t('command.themeLight')}</span>
              </Command.Item>
              <Command.Item
                value="theme dark"
                onSelect={() => runCommand(() => setTheme('dark'))}
                className="relative flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              >
                <Moon className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1">{t('command.themeDark')}</span>
              </Command.Item>
              <Command.Item
                value="theme system"
                onSelect={() => runCommand(() => setTheme('system'))}
                className="relative flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              >
                <Monitor className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1">{t('command.themeSystem')}</span>
              </Command.Item>
            </Command.Group>

            <Command.Group heading={t('command.groupLanguage')}>
              {LANGUAGES.map((lang) => (
                <Command.Item
                  key={lang.code}
                  value={`lang ${lang.code} ${lang.name}`}
                  onSelect={() =>
                    runCommand(() => i18n.changeLanguage(lang.code))
                  }
                  className="relative flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <Languages className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1">{lang.name}</span>
                  <span
                    className={cn(
                      'text-[10px] font-mono uppercase tracking-wider',
                      i18n.resolvedLanguage === lang.code
                        ? 'text-primary'
                        : 'text-muted-foreground'
                    )}
                  >
                    {lang.code}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>

          <div className="flex items-center justify-between border-t px-3 py-2 text-[10px] text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted px-1 font-mono">↑↓</kbd>
                {t('command.hintNavigate')}
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted px-1 font-mono">↵</kbd>
                {t('command.hintSelect')}
              </span>
            </div>
            <span className="flex items-center gap-1">
              <kbd className="rounded border bg-muted px-1 font-mono">Esc</kbd>
              {t('command.hintClose')}
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
