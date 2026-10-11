import { Globe, Check, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'zh', name: '中文' },
  { code: 'ar', name: 'العربية' },
]

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation()
  const currentCode = i18n.resolvedLanguage || i18n.language || 'en'
  const currentLang = LANGUAGES.find((l) => l.code === currentCode) ?? LANGUAGES[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 px-2.5 font-medium"
          aria-label={t('language.toggle')}
        >
          <Globe className="h-4 w-4" />
          <span className="text-xs font-semibold uppercase tracking-wide">
            {currentLang.code}
          </span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('language.toggle')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {LANGUAGES.map((lang) => {
          const isActive = currentCode === lang.code
          return (
            <DropdownMenuItem
              key={lang.code}
              onClick={() => i18n.changeLanguage(lang.code)}
              className={cn(
                'flex items-center gap-3 cursor-pointer',
                isActive && 'bg-accent'
              )}
            >
              <span className="flex-1 text-sm">{lang.name}</span>
              <span className="text-[10px] text-muted-foreground uppercase font-mono tracking-wider">
                {lang.code}
              </span>
              {isActive && <Check className="h-3.5 w-3.5 text-primary" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
