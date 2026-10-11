import { Building2, Layers3 } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { ImageShape } from '@/lib/shapes'

interface ViewFloorSwitcherProps {
  floorPlans: ReadonlyArray<ImageShape & { id: number }>
  selectedFloorPlanId: number | null
  /** null = "All Floors". */
  onSelect: (id: number | null) => void
}

/**
 * Try to extract a "signage-style" abbreviation from a floor plan's
 * name — `Level 2` → `L2`, `Ground Floor` → `GL`, `Basement 1` → `B1`.
 * Falls back to the first two characters when the name doesn't match
 * a known pattern. Keeps the pill compact and reads like real building
 * wayfinding.
 */
function signageLabel(name: string): string {
  if (!name) return '?'
  const trimmed = name.trim()
  if (!trimmed) return '?'
  // Common patterns first.
  const groundMatch = /^(ground|gnd|main)/i.exec(trimmed)
  if (groundMatch) return 'GL'
  const levelMatch = /^(?:level|floor|fl|l|story)\s*(\d+)/i.exec(trimmed)
  if (levelMatch) return `L${levelMatch[1]}`
  const basementMatch = /^(?:basement|b|sub)\s*(\d+)?/i.exec(trimmed)
  if (basementMatch) return `B${basementMatch[1] ?? '1'}`
  // Numeric-only — assume level number.
  if (/^\d+$/.test(trimmed)) return `L${trimmed}`
  // Fallback: first letter (or first two if short).
  return trimmed.slice(0, 2).toUpperCase()
}

export function ViewFloorSwitcher({
  floorPlans,
  selectedFloorPlanId,
  onSelect,
}: ViewFloorSwitcherProps) {
  const { t } = useTranslation()

  // Pre-compute labels so every render shares the same memoised view of
  // the floor list (ordered, with signage labels attached).
  const ordered = useMemo(
    () =>
      floorPlans
        .slice()
        .sort((a, b) => a.id - b.id)
        .map((fp) => ({ ...fp, label: signageLabel(fp.name || `Floor #${fp.id}`) })),
    [floorPlans],
  )

  // PageUp / PageDown to step floors. Skip when an input owns focus so we
  // don't hijack the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== 'PageUp' && e.key !== 'PageDown') return
      if (ordered.length === 0) return
      e.preventDefault()
      const currentIdx = selectedFloorPlanId === null
        ? -1
        : ordered.findIndex((fp) => fp.id === selectedFloorPlanId)
      const step = e.key === 'PageUp' ? 1 : -1
      const nextIdx = Math.max(0, Math.min(ordered.length - 1, currentIdx + step))
      onSelect(ordered[nextIdx].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ordered, selectedFloorPlanId, onSelect])

  if (ordered.length === 0) return null

  return (
    <div
      className="fixed start-3 top-1/2 -translate-y-1/2 z-20 flex flex-col items-stretch gap-1 p-1 rounded-xl bg-card/95 backdrop-blur border shadow-sm"
      role="toolbar"
      aria-label={t('view.floor.label', { defaultValue: 'Floor' })}
    >
      <FloorButton
        label={t('view.floor.allShort', { defaultValue: 'All' })}
        icon={<Layers3 className="w-3 h-3" />}
        title={t('view.floor.all', { defaultValue: 'All Floors' })}
        active={selectedFloorPlanId === null}
        onClick={() => onSelect(null)}
      />
      <div className="h-px bg-border mx-1" />
      <div className="flex flex-col-reverse gap-1 max-h-[60dvh] overflow-y-auto">
        {ordered.map((fp) => (
          <FloorButton
            key={fp.id}
            label={fp.label}
            title={fp.name || `Floor #${fp.id}`}
            icon={<Building2 className="w-3 h-3 opacity-60" />}
            active={selectedFloorPlanId === fp.id}
            onClick={() => onSelect(fp.id)}
          />
        ))}
      </div>
    </div>
  )
}

function FloorButton({
  label,
  title,
  icon,
  active,
  onClick,
}: {
  label: string
  title: string
  icon?: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`flex flex-col items-center justify-center w-9 h-9 rounded-md text-[11px] font-semibold transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-card hover:bg-muted text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon && <span className="leading-none">{icon}</span>}
      <span className="leading-none mt-0.5">{label}</span>
    </button>
  )
}
