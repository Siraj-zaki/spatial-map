/**
 * "Following <item>" — the status pill of a map whose camera tracks a moving
 * record (useFollowEntity): a pulse while following, "Follow" to resume after
 * the viewer dragged the map away. Shared by the viewer and report maps.
 */

import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Crosshair } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function FollowChip({ label, paused, onResume, style }: { label: string; paused: boolean; onResume: () => void; style?: CSSProperties }) {
  const { t } = useTranslation()
  return (
    <div className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4" style={style}>
      <div className="sgv-glass pointer-events-auto flex max-w-full items-center gap-2 rounded-full border bg-card/90 py-1 pe-1 ps-3 text-xs shadow-sm" role="status" aria-live="polite">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', paused ? 'bg-muted-foreground' : 'animate-pulse bg-primary')} aria-hidden />
        <span className="min-w-0 truncate py-0.5 font-medium">
          {paused
            ? t('view.follow.paused', { name: label, defaultValue: 'Follow paused · {{name}}' })
            : t('view.follow.following', { name: label, defaultValue: 'Following {{name}}' })}
        </span>
        {paused && (
          <Button size="sm" variant="secondary" className="h-6 rounded-full px-2.5 text-[11px]" onClick={onResume}>
            <Crosshair className="h-3 w-3" />
            {t('view.follow.resume', { defaultValue: 'Follow' })}
          </Button>
        )}
      </div>
    </div>
  )
}
