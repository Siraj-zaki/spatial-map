/**
 * Miniature of a report's actual layout, for the gallery card thumbnail.
 *
 * Draws each widget at its saved grid position (12 columns; `position`
 * from the builder) as a tiny, kind-specific glyph — a number for KPIs,
 * bars for bar charts, a ring for pie/donut, rows for tables, lines for
 * text — in the report's own colour. Widgets without a saved position are
 * flowed left-to-right at a sensible default width. Purely decorative
 * (aria-hidden); nothing is fetched.
 */

import type { ReportWidget } from '@/lib/reports-client'
import { cn } from '@/lib/utils'

interface Pos {
  x: number
  y: number
  w: number
  h: number
}

const COLS = 12

function defaultSize(kind: ReportWidget['kind']): { w: number; h: number } {
  switch (kind) {
    case 'kpi':
    case 'bigValue':
      return { w: 3, h: 2 }
    case 'table':
    case 'dataTable':
    case 'editableTable':
    case 'map':
    case 'facilityExplorer':
    case 'markdown':
    case 'note':
    case 'divider':
      return { w: 12, h: kind === 'divider' ? 1 : 3 }
    default:
      return { w: 6, h: 4 }
  }
}

/** Saved positions, or a simple left-to-right flow for widgets without one. */
function layout(widgets: ReportWidget[]): Array<{ widget: ReportWidget; pos: Pos }> {
  let cx = 0
  let cy = 0
  let rowH = 0
  return widgets.map((widget) => {
    const saved = (widget as ReportWidget & { position?: Partial<Pos> }).position
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number' && saved.w && saved.h) {
      return { widget, pos: { x: saved.x, y: saved.y, w: saved.w, h: saved.h } }
    }
    const { w, h } = defaultSize(widget.kind)
    if (cx + w > COLS) {
      cx = 0
      cy += rowH
      rowH = 0
    }
    const pos = { x: cx, y: cy, w, h }
    cx += w
    rowH = Math.max(rowH, h)
    return { widget, pos }
  })
}

function Glyph({ kind }: { kind: ReportWidget['kind'] }) {
  const fg = 'bg-[var(--rp)]'
  switch (kind) {
    case 'kpi':
    case 'bigValue':
      return (
        <div className="flex h-full flex-col justify-center gap-1 px-2">
          <div className="h-[3px] w-2/5 rounded-full bg-muted-foreground/30" />
          <div className="h-[8px] w-3/5 rounded-sm bg-foreground/70" />
        </div>
      )
    case 'bar':
    case 'history':
    case 'area':
    case 'line':
    case 'heatmap':
      return (
        <div className="flex h-full items-end gap-[3px] px-2 pb-1.5 pt-3">
          {[0.45, 0.7, 0.55, 0.9, 0.65].map((v, i) => (
            <div key={i} className={cn('flex-1 rounded-t-[2px] opacity-75', fg)} style={{ height: `${v * 100}%` }} />
          ))}
        </div>
      )
    case 'pie':
    case 'donut':
      return (
        <div className="flex h-full items-center justify-center">
          <div
            className="aspect-square h-[60%] rounded-full opacity-80 [mask-image:radial-gradient(circle,transparent_38%,black_40%)]"
            style={{ background: 'conic-gradient(var(--rp) 0 62%, hsl(var(--muted-foreground) / 0.25) 62% 100%)' }}
          />
        </div>
      )
    case 'table':
    case 'dataTable':
    case 'editableTable':
    case 'dimensionGrid':
      return (
        <div className="flex h-full flex-col gap-[5px] px-2 pt-2">
          <div className={cn('h-[4px] w-full rounded-full opacity-50', fg)} />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-[2px] w-full rounded-full bg-muted-foreground/20" />
          ))}
        </div>
      )
    case 'facilityExplorer':
    case 'map':
      return <div className="h-full w-full rounded-[2px] bg-[radial-gradient(var(--rp)_1px,transparent_1px)] opacity-50 [background-size:6px_6px]" />
    case 'divider':
      return <div className="mx-1.5 mt-[45%] h-px bg-muted-foreground/30" />
    default:
      return (
        <div className="flex h-full flex-col justify-center gap-[3px] px-1.5">
          <div className="h-[4px] w-2/5 rounded-full bg-muted-foreground/40" />
          <div className="h-[2px] w-4/5 rounded-full bg-muted-foreground/25" />
        </div>
      )
  }
}

/** The viewer's grid metrics (DEFAULT_LAYOUT in lib/reports/v2-types.ts). */
const ROW_PX = 48
const PAGE_PX = 1200

export function ReportLayoutPreview({
  widgets,
  color,
  className,
  style,
}: {
  widgets: ReportWidget[]
  color?: string
  className?: string
  style?: React.CSSProperties
}) {
  const placed = layout(widgets.slice(0, 24))
  const rows = Math.max(4, ...placed.map(({ pos }) => pos.y + pos.h))
  return (
    <div
      aria-hidden
      className={cn('relative overflow-hidden', className)}
      style={{ ['--rp' as string]: color || 'hsl(var(--primary))', ...style }}
    >
      {/* The report drawn as a page at its TRUE proportions (12 columns ×
          48px rows on a ~1200px page), scaled to the card width and cropped
          at the top with a fade — like a document thumbnail. Squeezing every
          row into the box height is what made previews look stretched. */}
      <div
        className="absolute inset-x-4 top-4 grid gap-[4px] [mask-image:linear-gradient(to_bottom,black_75%,transparent)]"
        style={{
          aspectRatio: `${PAGE_PX} / ${rows * ROW_PX}`,
          gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
        {placed.map(({ widget, pos }) => (
          <div
            key={widget.id}
            className="overflow-hidden rounded-[4px] border border-foreground/[0.06] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
            style={{ gridColumn: `${pos.x + 1} / span ${Math.min(pos.w, COLS - pos.x)}`, gridRow: `${pos.y + 1} / span ${pos.h}` }}
          >
            <Glyph kind={widget.kind} />
          </div>
        ))}
      </div>
    </div>
  )
}
