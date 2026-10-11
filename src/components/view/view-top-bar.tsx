import { ChevronDown, ChevronUp, MapPin } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

interface ViewTopBarProps {
  name: string
  address?: string
  updatedAt?: Date
}

export function ViewTopBar({ name, address, updatedAt }: ViewTopBarProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)
  const updated = updatedAt
    ? t('view.topBar.updated', {
        date: updatedAt.toLocaleString(),
        defaultValue: `Updated ${updatedAt.toLocaleString()}`,
      })
    : null

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="fixed top-0 start-0 end-0 z-30 h-3 w-full bg-black/60 hover:bg-black/70 transition-colors"
        aria-label={t('view.topBar.expand', { defaultValue: 'Expand top bar' })}
      >
        <ChevronDown className="w-3 h-3 absolute left-1/2 -translate-x-1/2 top-0 text-white" />
      </button>
    )
  }

  return (
    <div className="fixed top-0 start-0 end-0 z-30 bg-card/95 backdrop-blur-md border-b shadow-sm">
      <div className="flex items-center justify-between px-4 py-2 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <MapPin className="w-4 h-4 text-primary flex-shrink-0" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-bold leading-tight truncate">{name}</span>
            {address && (
              <span className="text-[11px] text-muted-foreground leading-tight truncate">
                {address}
              </span>
            )}
            {updated && (
              <span className="text-[10px] text-muted-foreground leading-tight truncate">
                {updated}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 flex-shrink-0"
          onClick={() => setCollapsed(true)}
          aria-label={t('view.topBar.collapse', { defaultValue: 'Collapse top bar' })}
        >
          <ChevronUp className="w-4 h-4" />
        </Button>
      </div>
    </div>
  )
}