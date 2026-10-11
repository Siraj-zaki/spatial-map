import { useTranslation } from 'react-i18next'
import { Layers, Redo2, Undo2 } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useHistoryAvailability } from '@/lib/grid-history'
import { modKeyLabel } from '@/lib/keyboard-shortcuts'

export interface StatusBarCounts {
  racks: number
  areas: number
  walls: number
  aisles: number
  doors: number
  stairs: number
  models: number
  floorPlans: number
  markers: number
  circles: number
  textLabels: number
  imagePlanes: number
}

/**
 * Bottom map status bar, one line: live viewport (lat / lng / zoom) at the
 * start, the contextual keyboard hint in the middle, and a "N shapes"
 * button at the end whose popover lists the per-kind counts. (The counts
 * used to be listed inline and wrapped onto a second line, and the hint
 * floated in its own pill on top of the bar.) Inset by the side panel's
 * width when it's open so nothing slides underneath.
 */
export function StatusBar({
  viewport,
  counts,
  panelOpen,
  hint,
  onUndo,
  onRedo,
}: {
  viewport: { lng: number; lat: number; zoom: number }
  counts: StatusBarCounts
  panelOpen: boolean
  hint?: React.ReactNode
  onUndo?: () => void
  onRedo?: () => void
}) {
  const { t, i18n } = useTranslation()
  const { canUndo, canRedo } = useHistoryAvailability()
  const mod = modKeyLabel()
  const nf = new Intl.NumberFormat(i18n.language)
  const rows: Array<[string, number]> = [
    [t('statusBar.grids'), counts.racks],
    [t('statusBar.areas', { defaultValue: 'Areas' }), counts.areas],
    [t('statusBar.walls', { defaultValue: 'Walls' }), counts.walls],
    [t('statusBar.aisles', { defaultValue: 'Aisles' }), counts.aisles],
    [t('statusBar.doors', { defaultValue: 'Doors' }), counts.doors],
    [t('statusBar.stairs', { defaultValue: 'Stairs' }), counts.stairs],
    [t('statusBar.models', { defaultValue: 'Models' }), counts.models],
    [t('statusBar.markers', { defaultValue: 'Assets' }), counts.markers],
    [t('statusBar.circles', { defaultValue: 'Circles' }), counts.circles],
    [t('statusBar.textLabels', { defaultValue: 'Text labels' }), counts.textLabels],
    [t('statusBar.imagePlanes', { defaultValue: 'Image planes' }), counts.imagePlanes],
    [t('statusBar.floorPlans', { defaultValue: 'Floor plans' }), counts.floorPlans],
  ]
  const shown = rows.filter(([, n]) => n > 0)
  const total = shown.reduce((sum, [, n]) => sum + n, 0)
  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-4 start-44 end-4 z-10 transition-[inset] duration-300 ease-in-out',
        panelOpen && 'sm:end-[416px]',
      )}
    >
      <div className="pointer-events-auto flex h-9 items-center gap-3 rounded-lg border bg-card/90 px-3 text-xs text-muted-foreground shadow-lg backdrop-blur">
        <div className="hidden shrink-0 items-center gap-3 xl:flex" dir="ltr">
          <span className="whitespace-nowrap">
            {t('statusBar.lat')} <span className="font-mono text-foreground">{viewport.lat.toFixed(4)}</span>
          </span>
          <span className="whitespace-nowrap">
            {t('statusBar.lng')} <span className="font-mono text-foreground">{viewport.lng.toFixed(4)}</span>
          </span>
          <span className="whitespace-nowrap">
            {t('statusBar.zoom')} <span className="font-mono text-foreground">{viewport.zoom.toFixed(1)}</span>
          </span>
        </div>
        <div className="min-w-0 flex-1">{hint}</div>
        {(onUndo || onRedo) && (
          <div className="flex shrink-0 items-center gap-0.5 border-e pe-2">
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              className="rounded-md p-1.5 text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
              aria-label={t('editor.undo', { defaultValue: 'Undo' })}
              title={`${t('editor.undo', { defaultValue: 'Undo' })} (${mod} Z)`}
            >
              <Undo2 className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
            </button>
            <button
              type="button"
              onClick={onRedo}
              disabled={!canRedo}
              className="rounded-md p-1.5 text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
              aria-label={t('editor.redo', { defaultValue: 'Redo' })}
              title={`${t('editor.redo', { defaultValue: 'Redo' })} (${mod} ⇧ Z)`}
            >
              <Redo2 className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
            </button>
          </div>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('statusBar.shapesLabel', { defaultValue: 'Shapes in this facility' })}
            >
              <Layers className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span className="tabular-nums">{t('statusBar.shapesTotal', { count: total, defaultValue: '{{formatted}} shapes', formatted: nf.format(total) })}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-56 p-2">
            <p className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('statusBar.shapesLabel', { defaultValue: 'Shapes in this facility' })}
            </p>
            {shown.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">{t('statusBar.noShapes', { defaultValue: 'Nothing drawn yet' })}</p>
            ) : (
              <ul className="space-y-0.5 text-xs">
                {shown.map(([label, n]) => (
                  <li key={label} className="flex items-center justify-between rounded px-1 py-1 hover:bg-muted/60">
                    <span>{label}</span>
                    <span className="tabular-nums text-foreground">{nf.format(n)}</span>
                  </li>
                ))}
              </ul>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
