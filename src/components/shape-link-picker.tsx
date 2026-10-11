/**
 * Pick a data-source shape for the current viewer.
 *
 * Opens a dialog listing every saved shape (and grid cell, when the
 * source is a rack), filtered by a search box. Selecting a row writes
 * a `ShapeLink` back to the caller — the caller persists it onto the
 * viewer's `dataSourceShape` field.
 *
 * Used from any per-shape sidebar that wants to wire cross-shape rules.
 * The resolver follows the link in its second pass so style rules see
 * the source's bin when evaluating against the viewer.
 */

import { useMemo, useState } from 'react'
import {
  Boxes,
  Box,
  Circle as CircleIcon,
  Grid3x3,
  Image as ImageIcon,
  Link2,
  MapPin,
  Pentagon,
  Search,
  Spline,
  Unlink,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  useSpatialCircles,
  useSpatialGrids,
  useSpatialImages,
  useSpatialLines,
  useSpatialMarkers,
  useSpatialModels,
  useSpatialPolygons,
} from '@/hooks/useSpatialShapes'
import type { BindingKind } from '@/lib/db'
import type { ShapeLink } from '@/lib/shape-link'
import { linkId } from '@/lib/shape-link'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Currently linked source (if any). Highlighted in the list. */
  current?: ShapeLink
  /** Save the new link. Pass `null` to clear. */
  onSelect: (next: ShapeLink | null) => void
  /**
   * Optional descriptor for the viewer (the shape doing the linking).
   * Used to label the dialog header so the user knows what they're
   * configuring.
   */
  viewerLabel?: string
}

type SourceRow = {
  id: string
  link: ShapeLink
  label: string
  kindLabel: string
  Icon: typeof Box
}

const KIND_META: Record<
  Exclude<BindingKind, 'grid-cell'>,
  { label: string; Icon: typeof Box }
> = {
  polygon: { label: 'Polygon', Icon: Pentagon },
  circle:  { label: 'Circle',  Icon: CircleIcon },
  line:    { label: 'Line',    Icon: Spline },
  marker:  { label: 'Marker',  Icon: MapPin },
  image:   { label: 'Image',   Icon: ImageIcon },
  model:   { label: '3D model', Icon: Box },
}

export function ShapeLinkPicker({
  open,
  onOpenChange,
  current,
  onSelect,
  viewerLabel,
}: Props) {
  const [query, setQuery] = useState('')

  const { data: polygons = [] } = useSpatialPolygons()
  const { data: circles = [] } = useSpatialCircles()
  const { data: lines = [] } = useSpatialLines()
  const { data: markers = [] } = useSpatialMarkers()
  const { data: images = [] } = useSpatialImages()
  const { data: models = [] } = useSpatialModels()
  const { data: grids = [] } = useSpatialGrids()

  const rows = useMemo<SourceRow[]>(() => {
    const out: SourceRow[] = []
    const pushShape = (
      kind: Exclude<BindingKind, 'grid-cell'>,
      shapes: ReadonlyArray<{ id?: number; name?: string }>,
    ) => {
      const meta = KIND_META[kind]
      for (const s of shapes) {
        if (s.id === undefined) continue
        const link: ShapeLink = { kind, shapeId: s.id }
        out.push({
          id: linkId(link),
          link,
          label: s.name && s.name.trim() ? s.name : `${meta.label} #${s.id}`,
          kindLabel: meta.label,
          Icon: meta.Icon,
        })
      }
    }
    pushShape('polygon', polygons)
    pushShape('circle', circles)
    pushShape('line', lines)
    pushShape('marker', markers)
    pushShape('image', images)
    pushShape('model', models)

    // Grids show up at the rack level — individual cells are addressed
    // by their `(row,col,level)` keys but typing those out by hand here
    // would be a UX trap. For v1 we expose the grid as a whole; pickers
    // wanting a specific cell can extend this to drill in. Rack-level
    // link still resolves cleanly when the source bin keys to the rack.
    for (const g of grids) {
      if (g.id === undefined) continue
      // A grid-as-source link addresses cell (0,0,0) by default — the
      // user picks the rack here and refines the cell coordinates via
      // the small fields below the selected row when needed.
      const link: ShapeLink = { kind: 'grid-cell', gridId: g.id, row: 0, col: 0, level: 0 }
      out.push({
        id: `grid:${g.id}`,
        link,
        label: g.name && g.name.trim() ? g.name : `Rack #${g.id}`,
        kindLabel: 'Rack cell',
        Icon: Grid3x3,
      })
    }

    return out
  }, [polygons, circles, lines, markers, images, models, grids])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return rows
    return rows.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.kindLabel.toLowerCase().includes(q),
    )
  }, [rows, query])

  const currentId = current ? linkId(current) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden" aria-describedby={undefined}>
        <DialogHeader className="flex flex-row items-center gap-2 px-4 py-3 border-b space-y-0">
          <Link2 className="w-4 h-4 text-primary flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <DialogTitle className="font-semibold text-sm leading-tight">
              Link data source
            </DialogTitle>
            <p className="text-[11px] text-muted-foreground truncate">
              {viewerLabel
                ? `Style rules for ${viewerLabel} will use the picked shape's data.`
                : 'Style rules for this shape will use the picked shape\'s data.'}
            </p>
          </div>
        </DialogHeader>

        <div className="px-4 py-2 border-b">
          <div className="relative">
            <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shapes by name…"
              className="h-8 text-sm ps-8"
              autoFocus
            />
          </div>
        </div>

        {current && (
          <div className="px-4 py-2 border-b bg-muted/30 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              Currently linked to{' '}
              <span className="font-mono">{currentId}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10"
              onClick={() => {
                onSelect(null)
                onOpenChange(false)
              }}
            >
              <Unlink className="w-3 h-3 me-1" />
              Unlink
            </Button>
          </div>
        )}

        <div className="max-h-[400px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-[11px] text-muted-foreground text-center">
              {rows.length === 0
                ? 'No shapes yet. Draw something on the map first.'
                : 'No matches.'}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((row) => {
                const isCurrent = row.id === currentId
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(row.link)
                        onOpenChange(false)
                      }}
                      className={
                        'w-full flex items-center gap-2 px-2 py-1.5 rounded text-start transition-colors ' +
                        (isCurrent
                          ? 'bg-primary/10 ring-1 ring-primary/40'
                          : 'hover:bg-accent')
                      }
                    >
                      <row.Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate">{row.label}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {row.kindLabel} · {row.id}
                        </div>
                      </div>
                      {isCurrent && (
                        <Boxes className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="px-4 py-3 border-t flex items-center justify-end bg-background flex-shrink-0">
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
