/**
 * A solution's icon + colour tile — the same treatment as a report's
 * `ReportIcon`, so a solution looks like the same thing in the sidebar, the
 * scope bar, the overview hero and the pickers.
 */

import { createElement } from 'react'
import { cn } from '@/lib/utils'
import { solutionIcon } from '@/lib/solution-templates'

export function SolutionIcon({
  icon,
  color,
  size = 'md',
  className,
}: {
  icon: string
  color: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}) {
  const box = { xs: 'h-5 w-5 rounded', sm: 'h-7 w-7 rounded-md', md: 'h-9 w-9 rounded-lg', lg: 'h-12 w-12 rounded-xl', xl: 'h-14 w-14 rounded-2xl' }[size]
  const glyph = { xs: 'h-3 w-3', sm: 'h-3.5 w-3.5', md: 'h-4 w-4', lg: 'h-6 w-6', xl: 'h-7 w-7' }[size]
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center border', box, !color && 'bg-muted/50 text-muted-foreground', className)}
      style={color ? { color, background: `${color}14`, borderColor: `${color}33` } : undefined}
      aria-hidden
    >
      {createElement(solutionIcon(icon), { className: glyph })}
    </div>
  )
}
