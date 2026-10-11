import { Minus, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ViewZoomClusterProps {
  onZoomIn: () => void
  onZoomOut: () => void
}

/**
 * Compact zoom cluster floated bottom-right inside the map area. The
 * compass / 3D / pitch controls live in the top strip so this stays a
 * pure two-button stack — the most common gesture, the most accessible
 * affordance. Mirrors Google Maps / Apple Maps placement.
 */
export function ViewZoomCluster({ onZoomIn, onZoomOut }: ViewZoomClusterProps) {
  const { t } = useTranslation()
  return (
    <div className="absolute bottom-3 end-3 z-20 flex flex-col rounded-md border bg-card/95 backdrop-blur shadow-md overflow-hidden">
      <button
        type="button"
        onClick={onZoomIn}
        aria-label={t('view.controls.zoomIn', { defaultValue: 'Zoom in' })}
        className="h-9 w-9 flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground"
      >
        <Plus className="w-4 h-4" />
      </button>
      <div className="h-px bg-border" />
      <button
        type="button"
        onClick={onZoomOut}
        aria-label={t('view.controls.zoomOut', { defaultValue: 'Zoom out' })}
        className="h-9 w-9 flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground"
      >
        <Minus className="w-4 h-4" />
      </button>
    </div>
  )
}
