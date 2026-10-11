import { ChevronLeft, ChevronRight, Map as MapIcon, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import type { Grid } from '@/lib/db'
import { gridBbox } from '@/lib/export'
import { polygonCentroid } from '@/lib/polygon-generators'
import type {
  CircleShape,
  LineShape,
  MarkerShape,
  ModelShape,
  PolygonShape,
  StairShape,
  TextLabelShape,
} from '@/lib/shapes'
import type { DoorShape } from '@/lib/door/types'

type TourStop =
  | { kind: 'rack'; key: string; name: string; bbox: [number, number, number, number] }
  | {
      kind: 'marker' | 'model' | 'polygon' | 'circle' | 'line' | 'stair' | 'door' | 'text'
      key: string
      name: string
      position: [number, number]
    }

interface ViewTourProps {
  grids: Grid[]
  markers: MarkerShape[]
  models: ModelShape[]
  /** v2 extended catalog — every shape kind eligible to host a tour stop. */
  polygons?: PolygonShape[]
  circles?: CircleShape[]
  lines?: LineShape[]
  stairs?: StairShape[]
  doors?: DoorShape[]
  textLabels?: TextLabelShape[]
  active: boolean
  onActiveChange: (v: boolean) => void
  /** Fit the given bbox into view with proper padding + pitch. */
  flyToBounds?: (bbox: [number, number, number, number], pitch?: number) => void
  /** Fly to a point at a fixed close zoom + pitch (markers / models / others). */
  flyToPoint?: (center: [number, number], pitch?: number) => void
}

function sortByLatThenLng<T extends { position: [number, number] }>(
  a: T,
  b: T,
): number {
  if (Math.abs(a.position[1] - b.position[1]) > 1e-7) return a.position[1] - b.position[1]
  return a.position[0] - b.position[0]
}

function midpoint(v0: [number, number], v1: [number, number]): [number, number] {
  return [(v0[0] + v1[0]) / 2, (v0[1] + v1[1]) / 2]
}

function lineMidpoint(vertices: ReadonlyArray<[number, number]>): [number, number] | null {
  if (vertices.length < 2) return null
  // Use the midpoint of the polyline's bounding chord (first/last vertex).
  // Cheap and stable; for tour navigation we want the camera roughly on
  // the line, not weighted by per-segment length.
  return midpoint(vertices[0], vertices[vertices.length - 1])
}

export function ViewTour({
  grids,
  markers,
  models,
  polygons = [],
  circles = [],
  lines = [],
  stairs = [],
  doors = [],
  textLabels = [],
  active,
  onActiveChange,
  flyToBounds,
  flyToPoint,
}: ViewTourProps) {
  const { t } = useTranslation()

  // Build the stop list once per data identity. Racks come first
  // (largest, set the scene), then polygons (rooms / zones), then
  // markers, models, stairs, doors, circles, lines, text labels.
  // Sorted within each kind by latitude then longitude so the camera
  // moves in a roughly readable south-to-north sweep.
  const stops = useMemo<TourStop[]>(() => {
    const racks: TourStop[] = grids
      .filter((g): g is Grid & { id: number } => g.id !== undefined)
      .sort((a, b) => {
        const [ax, ay] = a.start
        const [bx, by] = b.start
        if (Math.abs(ay - by) > 1e-7) return ay - by
        return ax - bx
      })
      .map((g) => ({
        kind: 'rack' as const,
        key: `rack:${g.id}`,
        name: g.name || `Rack #${g.id}`,
        bbox: gridBbox(g),
      }))

    const polyStops: TourStop[] = polygons
      .filter((p): p is PolygonShape & { id: number } => p.id !== undefined)
      .map((p) => {
        const c = polygonCentroid(p.vertices)
        return c
          ? {
              kind: 'polygon' as const,
              key: `polygon:${p.id}`,
              name: p.name || `Polygon #${p.id}`,
              position: c,
            }
          : null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort(sortByLatThenLng)

    const markerStops: TourStop[] = markers
      .filter((m): m is MarkerShape & { id: number } => m.id !== undefined)
      .map((m) => ({
        kind: 'marker' as const,
        key: `marker:${m.id}`,
        name: m.name || `Marker #${m.id}`,
        position: m.position,
      }))
      .sort(sortByLatThenLng)

    const modelStops: TourStop[] = models
      .filter((m): m is ModelShape & { id: number } => m.id !== undefined)
      .map((m) => ({
        kind: 'model' as const,
        key: `model:${m.id}`,
        name: m.name || `Model #${m.id}`,
        position: m.position,
      }))
      .sort(sortByLatThenLng)

    const stairStops: TourStop[] = stairs
      .filter((s): s is StairShape & { id: number } => s.id !== undefined && s.vertices.length >= 2)
      .map((s) => ({
        kind: 'stair' as const,
        key: `stair:${s.id}`,
        name: s.name || `Stair #${s.id}`,
        position: midpoint(s.vertices[0] as [number, number], s.vertices[1] as [number, number]),
      }))
      .sort(sortByLatThenLng)

    const doorStops: TourStop[] = doors
      .filter((d): d is DoorShape & { id: number } => d.id !== undefined)
      .map((d) => ({
        kind: 'door' as const,
        key: `door:${d.id}`,
        name: d.name || `Door #${d.id}`,
        position: midpoint(d.vertices[0], d.vertices[1]),
      }))
      .sort(sortByLatThenLng)

    const circleStops: TourStop[] = circles
      .filter((c): c is CircleShape & { id: number } => c.id !== undefined)
      .map((c) => {
        const pos = c.center ?? c.start
        if (!pos) return null
        return {
          kind: 'circle' as const,
          key: `circle:${c.id}`,
          name: c.name || `Circle #${c.id}`,
          position: pos,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort(sortByLatThenLng)

    const lineStops: TourStop[] = lines
      .filter((l): l is LineShape & { id: number } => l.id !== undefined)
      .map((l) => {
        const pos = lineMidpoint(l.vertices)
        if (!pos) return null
        return {
          kind: 'line' as const,
          key: `line:${l.id}`,
          name: l.name || `Line #${l.id}`,
          position: pos,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort(sortByLatThenLng)

    const textStops: TourStop[] = textLabels
      .filter((tl): tl is TextLabelShape & { id: number } => tl.id !== undefined)
      .map((tl) => ({
        kind: 'text' as const,
        key: `text:${tl.id}`,
        name: tl.config?.text || tl.name || `Label #${tl.id}`,
        position: tl.position,
      }))
      .sort(sortByLatThenLng)

    return [
      ...racks,
      ...polyStops,
      ...markerStops,
      ...modelStops,
      ...stairStops,
      ...doorStops,
      ...circleStops,
      ...lineStops,
      ...textStops,
    ]
  }, [grids, polygons, markers, models, stairs, doors, circles, lines, textLabels])

  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (!active || stops.length === 0) return
    const stop = stops[Math.min(index, stops.length - 1)]
    if (!stop) return
    if (stop.kind === 'rack') flyToBounds?.(stop.bbox, 45)
    else flyToPoint?.(stop.position, 50)
  }, [active, index, stops, flyToBounds, flyToPoint])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onActiveChange(false)
      else if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, stops.length - 1))
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, stops.length, onActiveChange])

  const currentStop = stops[Math.min(index, stops.length - 1)]

  if (!active) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="fixed bottom-3 left-1/2 -translate-x-1/2 z-20 h-8 bg-card/95 backdrop-blur shadow-sm text-xs gap-1.5"
        onClick={() => {
          if (stops.length === 0) return
          setIndex(0)
          onActiveChange(true)
        }}
        disabled={stops.length === 0}
        title={
          stops.length === 0
            ? t('view.tour.empty', { defaultValue: 'No shapes on this floor — try switching floors.' })
            : t('view.tour.startHint', { defaultValue: `Tour ${stops.length} stops` })
        }
      >
        <MapIcon className="w-3.5 h-3.5" />
        {t('view.tour.start', { defaultValue: 'Tour' })}
      </Button>
    )
  }

  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-20 bg-card/95 backdrop-blur border rounded-md shadow-sm p-1.5 flex items-center gap-2 min-w-[260px]">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 flex-shrink-0"
        onClick={() => setIndex((i) => Math.max(i - 1, 0))}
        disabled={index === 0}
        aria-label={t('view.tour.prev', { defaultValue: 'Previous' })}
      >
        <ChevronLeft className="w-4 h-4" />
      </Button>
      <div className="flex flex-col items-center flex-1 min-w-0">
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {t('view.tour.progress', {
            i: Math.min(index + 1, stops.length),
            n: stops.length,
            defaultValue: `${Math.min(index + 1, stops.length)} / ${stops.length}`,
          })}
        </span>
        <span className="text-xs font-medium truncate max-w-[180px]">
          {currentStop?.name ?? ''}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 flex-shrink-0"
        onClick={() => setIndex((i) => Math.min(i + 1, stops.length - 1))}
        disabled={index >= stops.length - 1}
        aria-label={t('view.tour.next', { defaultValue: 'Next' })}
      >
        <ChevronRight className="w-4 h-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 flex-shrink-0"
        onClick={() => onActiveChange(false)}
        aria-label={t('view.tour.exit', { defaultValue: 'Exit tour' })}
      >
        <X className="w-4 h-4" />
      </Button>
    </div>
  )
}
