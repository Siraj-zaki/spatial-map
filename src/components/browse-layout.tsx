/**
 * Master–detail page frame used by /data: the page header,
 * then one card holding a browse sidebar (md+; a start-side Sheet below
 * md) beside the main pane. Fills the app shell's <main> and scrolls
 * internally — only the sidebar and the content pane scroll, so toolbars
 * and table headers stay put.
 */

import type { ComponentType, ReactNode } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

export function BrowseLayout({
  header,
  sidebar,
  sidebarTitle,
  mobileSidebarOpen,
  onMobileSidebarOpenChange,
  children,
}: {
  header: ReactNode
  sidebar: ReactNode
  sidebarTitle: string
  mobileSidebarOpen: boolean
  onMobileSidebarOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-4 pt-6 sm:px-6 lg:px-8 lg:pt-8">{header}</div>
      <div className="mx-auto flex min-h-0 w-full max-w-[1400px] flex-1 px-4 pb-6 sm:px-6 lg:px-8">
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm">
          <aside className="hidden w-60 shrink-0 overflow-y-auto overscroll-contain border-e bg-muted/30 py-2 md:block">
            {sidebar}
          </aside>
          <Sheet open={mobileSidebarOpen} onOpenChange={onMobileSidebarOpenChange}>
            <SheetContent side="start" className="p-0">
              <SheetHeader className="border-b px-4 py-3">
                <SheetTitle className="text-base">{sidebarTitle}</SheetTitle>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto overscroll-contain bg-muted/30 py-2">{sidebar}</div>
            </SheetContent>
          </Sheet>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
        </div>
      </div>
    </div>
  )
}

export function BrowseSidebarSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-2 py-2">
      <p className="px-2.5 pb-1.5 text-[11px] font-medium text-muted-foreground">{label}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

export function BrowseSidebarItem({
  active,
  icon: Icon,
  label,
  count,
  tone,
  onClick,
}: {
  active: boolean
  icon: ComponentType<{ className?: string }>
  label: string
  count?: number | string
  /** Colours the count: warning (e.g. ghost rows) or danger (orphans). */
  tone?: 'warning' | 'danger'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        active ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', active && 'text-primary')} />
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span
          className={cn(
            'text-xs tabular-nums',
            tone === 'warning' ? 'font-medium text-warning' : tone === 'danger' ? 'font-medium text-danger' : 'text-muted-foreground',
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}
