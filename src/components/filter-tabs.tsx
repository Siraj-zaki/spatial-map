/**
 * Segmented filter bar with counts — the one "All · REST · Files · …"
 * control used across the workspace pages (tables by kind, integrations by
 * transport, files by type, reports by facility). Scrolls horizontally on
 * narrow screens instead of wrapping.
 */

import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface FilterTabItem<V extends string> {
  value: V
  label: string
  count?: number
  icon?: LucideIcon
  /** Render the label in monospace (identifiers like `rack-cell`). */
  mono?: boolean
}

export function FilterTabs<V extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  items: ReadonlyArray<FilterTabItem<V>>
  value: V
  onChange: (v: V) => void
  ariaLabel: string
  className?: string
}) {
  const { i18n } = useTranslation()
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'sgv-scroll-hide inline-flex h-9 max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted p-1',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value
        const Icon = item.icon
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" aria-hidden />}
            <span className={item.mono ? 'font-mono text-[13px]' : undefined} dir={item.mono ? 'ltr' : undefined}>
              {item.label}
            </span>
            {item.count !== undefined && (
              <span
                className={cn(
                  'min-w-[1.25rem] rounded-full px-1.5 text-center text-[11px] tabular-nums',
                  active ? 'bg-muted text-foreground' : 'text-muted-foreground',
                )}
              >
                {item.count.toLocaleString(i18n.language)}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
