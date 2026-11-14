import { Shapes, SquareDashed } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Tells the user why shapes are missing from the map, so a reference view
 * never reads as lost data:
 *
 *  - alignment view (placing / moving / rotating / scaling a floor plan):
 *    every shape is hidden and the other floor plans are dimmed — it ends
 *    on its own when the transform or the Add floor plan tool ends;
 *  - "Show shapes" switched off on some floors (Floor plans list): a count
 *    plus "Show all", so a hidden floor is never forgotten.
 */
export function FloorReferencePill({
  aligning,
  hiddenFloorCount,
  onShowAll,
}: {
  aligning: boolean
  hiddenFloorCount: number
  onShowAll: () => void
}) {
  const { t } = useTranslation()
  if (aligning) {
    return (
      <div
        role="status"
        className="flex shrink-0 items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 backdrop-blur px-3 py-1.5 shadow-sm text-xs text-primary"
      >
        <SquareDashed className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="font-medium">
          {t('floorReference.aligning', { defaultValue: 'Alignment view — shapes hidden, other floor plans dimmed' })}
        </span>
      </div>
    )
  }
  if (hiddenFloorCount === 0) return null
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-lg border bg-card/90 backdrop-blur px-3 py-1.5 shadow-sm text-xs">
      <SquareDashed className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      <span className="font-medium">
        {t('floorReference.hiddenFloors', {
          count: hiddenFloorCount,
          defaultValue: 'Shapes hidden on {{count}} floor',
          defaultValue_other: 'Shapes hidden on {{count}} floors',
        })}
      </span>
      <button
        type="button"
        onClick={onShowAll}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10 transition-colors"
      >
        <Shapes className="h-3 w-3" aria-hidden="true" />
        {t('floorReference.showAll', { defaultValue: 'Show all' })}
      </button>
    </div>
  )
}
