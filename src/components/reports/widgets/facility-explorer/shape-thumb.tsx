/**
 * Preview of one facility item, drawn from its real geometry: area /
 * rack / wall / door / stair outlines as SVG in the shape's own colour,
 * the marker's icon, the floor-plan image, the 3D model's thumbnail.
 *
 * Shape colours are data (the item's material), not UI chrome — the
 * frame and fallbacks use theme tokens.
 */

import { useState } from 'react'
import { ArrowDownUp, Box, Layers, MoveVertical, Type } from 'lucide-react'
import { cn } from '@/lib/utils'
import { urlForImage } from '@/lib/binary-store'
import { MarkerIconGlyph } from '@/lib/marker-icons'
import { findAssetInList, useModelAssets } from '@/lib/model-assets'
import { fitToBox, gridCellCounts, shapePoints, toMetres, type ExplorerShape } from './explorer-geometry'

const FALLBACK = 'hsl(var(--primary))'

function colourOf(s: ExplorerShape): string {
  const c = (s.shape.config as { color?: string } | undefined)?.color
  return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : FALLBACK
}

/** Near-white colours need a dark backdrop to be seen. */
function isLight(hex: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return false
  const n = parseInt(m[1], 16)
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return lum > 0.82
}

export function ShapeThumb({
  item,
  entity,
  size = 'sm',
  className,
}: {
  item: ExplorerShape | null
  /** Facility entity key, for the fallback glyph while shapes load. */
  entity: string
  size?: 'sm' | 'lg'
  className?: string
}) {
  const frame = cn(
    'relative flex shrink-0 items-center justify-center overflow-hidden bg-muted/60',
    size === 'sm' ? 'h-11 w-11 rounded-lg' : 'aspect-[16/9] w-full rounded-xl',
    className,
  )
  if (!item) return <div className={cn(frame, 'animate-pulse')} aria-hidden />
  return (
    <div className={frame} aria-hidden>
      <ThumbBody item={item} entity={entity} size={size} />
    </div>
  )
}

function ThumbBody({ item, entity, size }: { item: ExplorerShape; entity: string; size: 'sm' | 'lg' }) {
  const icon = size === 'sm' ? 'h-5 w-5' : 'h-12 w-12'
  switch (item.kind) {
    case 'images':
      return <FloorImage shape={item.shape} iconClass={icon} />
    case 'markers': {
      const c = item.shape.config.iconColor ?? '#ffffff'
      const light = isLight(c)
      return (
        <span
          className={cn('flex items-center justify-center rounded-full', size === 'sm' ? 'h-8 w-8' : 'h-24 w-24')}
          style={{ background: light ? 'hsl(var(--foreground) / 0.85)' : 'hsl(var(--background))', color: c }}
        >
          <MarkerIconGlyph icon={item.shape.config.icon} className={size === 'sm' ? 'h-4 w-4' : 'h-12 w-12'} />
        </span>
      )
    }
    case 'models':
      return <ModelThumb assetId={item.shape.config.modelAssetId} iconClass={icon} />
    case 'text-labels': {
      const c = colourOf(item)
      return (
        <span
          className={cn('flex max-w-full items-center gap-1 truncate px-1 font-semibold', size === 'sm' ? 'text-[10px]' : 'text-2xl')}
          style={{ color: c === FALLBACK ? undefined : c }}
        >
          {size === 'lg' && <Type className="h-6 w-6 shrink-0 text-muted-foreground" />}
          <span className="truncate">{item.shape.config.text || item.shape.name}</span>
        </span>
      )
    }
    case 'stairs':
      if (item.shape.config.stairType === 'elevator') {
        return <ArrowDownUp className={cn(icon, 'text-muted-foreground')} />
      }
      return <Outline item={item} entity={entity} size={size} />
    default:
      return <Outline item={item} entity={entity} size={size} />
  }
}

function Outline({ item, entity, size }: { item: ExplorerShape; entity: string; size: 'sm' | 'lg' }) {
  const W = size === 'sm' ? 44 : 320
  const H = size === 'sm' ? 44 : 180
  const pad = size === 'sm' ? 5 : 18
  const metres = toMetres(shapePoints(item))
  if (metres.length < 2) return <Layers className="h-5 w-5 text-muted-foreground" data-entity={entity} />
  const { pts } = fitToBox(metres, W, H, pad)
  const fill = colourOf(item)
  // A near-white shape (stairs, light walls) would vanish on the muted
  // frame: keep its fill, outline it in the foreground colour.
  const c = isLight(fill) ? 'hsl(var(--foreground) / 0.55)' : fill
  const path = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const sw = size === 'sm' ? 1.5 : 2.5
  const filled = item.kind === 'polygons' || item.kind === 'grids' || item.kind === 'stairs'
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
      {filled ? (
        <path d={`${path} Z`} fill={fill} fillOpacity={isLight(fill) ? 0.9 : 0.45} stroke={c} strokeWidth={sw} strokeLinejoin="round" />
      ) : (
        <path d={path} fill="none" stroke={c} strokeWidth={item.kind === 'lines' ? sw * 2 : sw * 1.5} strokeLinecap="round" />
      )}
      {item.kind === 'grids' && <GridLines pts={pts} counts={gridCellCounts(item.shape)} colour={c} />}
      {item.kind === 'stairs' && pts.length === 4 && <StairLines pts={pts} steps={item.shape.config.stepCount ?? 10} colour={c} />}
      {item.kind === 'doors' && pts.length === 2 && <DoorSwing pts={pts} colour={c} />}
      {item.kind === 'stairs' && item.shape.config.stairType === 'escalator' && size === 'lg' && (
        <foreignObject x={W - 40} y={8} width={32} height={32}>
          <MoveVertical className="h-8 w-8 text-muted-foreground" />
        </foreignObject>
      )}
    </svg>
  )
}

/** Cell lines across a rack outline (capped so small thumbs stay legible). */
function GridLines({ pts, counts, colour }: { pts: [number, number][]; counts: { cols: number; rows: number }; colour: string }) {
  if (pts.length !== 4) return null
  const [a, b, c, d] = pts
  const lerp = (p: [number, number], q: [number, number], t: number): [number, number] => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
  const cols = Math.min(counts.cols, 24)
  const rows = Math.min(counts.rows, 12)
  const lines: string[] = []
  for (let i = 1; i < cols; i++) {
    const p = lerp(a, b, i / cols)
    const q = lerp(d, c, i / cols)
    lines.push(`M${p[0]} ${p[1]} L${q[0]} ${q[1]}`)
  }
  for (let j = 1; j < rows; j++) {
    const p = lerp(a, d, j / rows)
    const q = lerp(b, c, j / rows)
    lines.push(`M${p[0]} ${p[1]} L${q[0]} ${q[1]}`)
  }
  return <path d={lines.join(' ')} stroke={colour} strokeOpacity={0.7} strokeWidth={0.75} fill="none" />
}

/** Treads across a stair run (footprint corners: a0 b0 b1 a1). */
function StairLines({ pts, steps, colour }: { pts: [number, number][]; steps: number; colour: string }) {
  const [a0, b0, b1, a1] = pts
  const n = Math.max(2, Math.min(steps, 20))
  const lines: string[] = []
  for (let i = 1; i < n; i++) {
    const t = i / n
    const p = [a0[0] + (b0[0] - a0[0]) * t, a0[1] + (b0[1] - a0[1]) * t]
    const q = [a1[0] + (b1[0] - a1[0]) * t, a1[1] + (b1[1] - a1[1]) * t]
    lines.push(`M${p[0]} ${p[1]} L${q[0]} ${q[1]}`)
  }
  return <path d={lines.join(' ')} stroke={colour} strokeOpacity={0.8} strokeWidth={0.75} fill="none" />
}

/** Quarter-circle swing from the hinge end of a door opening. */
function DoorSwing({ pts, colour }: { pts: [number, number][]; colour: string }) {
  const [[x0, y0], [x1, y1]] = pts
  const r = Math.hypot(x1 - x0, y1 - y0)
  const ang = Math.atan2(y1 - y0, x1 - x0) - Math.PI / 2
  const ex = x0 + r * Math.cos(ang)
  const ey = y0 + r * Math.sin(ang)
  return (
    <path
      d={`M${x0} ${y0} L${ex} ${ey} M${x1} ${y1} A${r} ${r} 0 0 0 ${ex} ${ey}`}
      fill="none"
      stroke={colour}
      strokeOpacity={0.75}
      strokeWidth={1}
      strokeDasharray="3 2"
    />
  )
}

function FloorImage({ shape, iconClass }: { shape: import('@/lib/shapes').ImageShape; iconClass: string }) {
  const [failed, setFailed] = useState(false)
  const src = urlForImage(shape)
  if (!src || failed) return <Layers className={cn(iconClass, 'text-muted-foreground')} />
  return <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
}

function ModelThumb({ assetId, iconClass }: { assetId?: string; iconClass: string }) {
  const assets = useModelAssets()
  const [failed, setFailed] = useState(false)
  const thumb = assetId ? findAssetInList(assets, assetId)?.thumbnail : undefined
  if (!thumb || failed) return <Box className={cn(iconClass, 'text-muted-foreground')} />
  return <img src={thumb} alt="" loading="lazy" className="h-full w-full object-contain p-1" onError={() => setFailed(true)} />
}

/** A data row placed by coordinates: the link's icon in the row's colour
 *  (colour field, then style rule, then the link's default). */
export function DataPointThumb({ icon, color, size = 'sm' }: { icon?: string; color?: string; size?: 'sm' | 'lg' }) {
  const c = color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : FALLBACK
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden bg-muted/60',
        size === 'sm' ? 'h-11 w-11 rounded-lg' : 'aspect-[16/9] w-full rounded-xl',
      )}
      aria-hidden
    >
      <span
        className={cn('flex items-center justify-center rounded-full text-white', size === 'sm' ? 'h-8 w-8' : 'h-24 w-24')}
        style={{ background: c }}
      >
        <MarkerIconGlyph icon={icon || 'map-pin'} className={size === 'sm' ? 'h-4 w-4' : 'h-12 w-12'} />
      </span>
    </div>
  )
}
