import { Boxes, Building2, Layers, MapPin, Play, Search as SearchIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface ViewOnboardingProps {
  /** Warehouse id — used as a localStorage key so each warehouse
   * re-prompts the first time someone visits it. */
  warehouseId: string | undefined
  warehouseName: string
  floorCount: number
  rackCount: number
  markerCount: number
  modelCount: number
  /** Open the search overlay. */
  onOpenSearch: () => void
  /** Open the summary card on the Racks drill. */
  onBrowseRacks: () => void
  /** Start the tour. */
  onStartTour: () => void
}

const LS_PREFIX = 'viewerOnboarded:'

/**
 * First-load welcome card. Mappedin / MapIndoors lead with a "digital
 * directory" framing on first visit — a centered card naming the
 * building and offering 2–3 quick paths in. We mirror that here.
 * Dismissal is persisted per warehouse so returning visitors aren't
 * pestered.
 */
export function ViewOnboarding({
  warehouseId,
  warehouseName,
  floorCount,
  rackCount,
  markerCount,
  modelCount,
  onOpenSearch,
  onBrowseRacks,
  onStartTour,
}: ViewOnboardingProps) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !warehouseId) return false
    try {
      return window.localStorage.getItem(LS_PREFIX + warehouseId) !== '1'
    } catch {
      return true
    }
  })

  // Re-evaluate when the warehouse changes — a route-level navigation
  // to another warehouse should be able to re-prompt.
  useEffect(() => {
    if (!warehouseId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisible(false)
      return
    }
    try {
      setVisible(window.localStorage.getItem(LS_PREFIX + warehouseId) !== '1')
    } catch {
      setVisible(true)
    }
  }, [warehouseId])

  const dismiss = () => {
    setVisible(false)
    try {
      if (warehouseId) window.localStorage.setItem(LS_PREFIX + warehouseId, '1')
    } catch {
      /* private-mode storage block — ignore */
    }
  }

  const handle = (cb: () => void) => () => {
    dismiss()
    cb()
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-card border rounded-xl shadow-2xl max-w-md w-full overflow-hidden">
        <div className="flex items-start justify-between gap-2 px-5 pt-4 pb-2">
          <div className="flex items-start gap-2 min-w-0">
            <Building2 className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-base font-bold leading-tight truncate">{warehouseName}</div>
              <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                {t('view.onboarding.subtitle', {
                  floors: floorCount,
                  racks: rackCount,
                  markers: markerCount,
                  models: modelCount,
                  defaultValue: `${floorCount} floor${floorCount === 1 ? '' : 's'} · ${rackCount} rack${rackCount === 1 ? '' : 's'} · ${markerCount} marker${markerCount === 1 ? '' : 's'} · ${modelCount} model${modelCount === 1 ? '' : 's'}`,
                })}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label={t('view.onboarding.dismiss', { defaultValue: 'Dismiss' })}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 p-3">
          <Tile
            icon={<Layers className="w-5 h-5" />}
            label={t('view.onboarding.tileRacks', { defaultValue: 'Browse racks' })}
            sublabel={String(rackCount)}
            onClick={handle(onBrowseRacks)}
          />
          <Tile
            icon={<SearchIcon className="w-5 h-5" />}
            label={t('view.onboarding.tileSearch', { defaultValue: 'Find a bin' })}
            sublabel={t('view.onboarding.tileSearchHint', { defaultValue: 'Search' })}
            onClick={handle(onOpenSearch)}
          />
          <Tile
            icon={<Play className="w-5 h-5" />}
            label={t('view.onboarding.tileTour', { defaultValue: 'Start tour' })}
            sublabel={t('view.onboarding.tileTourHint', { defaultValue: 'Auto' })}
            onClick={handle(onStartTour)}
          />
        </div>

        <div className="flex items-center justify-between px-5 py-2.5 border-t bg-muted/40 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <MapPin className="w-3 h-3" />
            {t('view.onboarding.hint', { defaultValue: 'Tap any rack, marker, or model on the map for details.' })}
          </span>
          <Boxes className="w-3 h-3 opacity-60" />
        </div>
      </div>
    </div>
  )
}

function Tile({
  icon,
  label,
  sublabel,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  sublabel?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-1 py-3 px-2 rounded-lg border bg-card hover:bg-muted/60 hover:border-primary/50 transition-colors text-center"
    >
      <span className="text-primary">{icon}</span>
      <span className="text-xs font-semibold leading-tight">{label}</span>
      {sublabel && (
        <span className="text-[10px] text-muted-foreground tabular-nums leading-tight">
          {sublabel}
        </span>
      )}
    </button>
  )
}
