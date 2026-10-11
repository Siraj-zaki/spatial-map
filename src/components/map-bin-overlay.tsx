import { useEffect, useMemo, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import mapboxgl, {
  type Map as MapboxMapInstance,
  type GeoJSONSource,
} from 'mapbox-gl'
import type { Feature, FeatureCollection, Polygon } from 'geojson'
import { buildGridFromLine } from '@/lib/grid-generators'
import type { CommittedLine } from '@/components/map-grid-overlay'
import type { Bin, BinStatus } from '@/lib/db'
import { BinPopupContent } from '@/components/bin-popup-content'
import { whenStyleLoaded } from '@/lib/mapbox-style-ready'

const SOURCE_ID = 'bin-status-source'
const LAYER_ID = 'bin-status-layer'

// Dedicated source/layer for the hover-highlight outline. Owned by this
// overlay so we don't have to mutate the grid overlay's paint expressions
// or feature ids. The source carries 0 or 1 feature — the cell currently
// under the cursor; the line layer paints a cyan stroke at the cell's
// altitude so the highlight follows 3D extrusions.
const HOVER_SOURCE = 'data-link-hover-source'
const HOVER_LAYER = 'data-link-hover-line-layer'

// Solid hex colors. `fill-extrusion-color` strips alpha so we set
// translucency via `fill-extrusion-opacity` on the layer instead.
const STATUS_COLORS: Record<BinStatus, string> = {
  empty: '#94a3b8',     // unused — empty bins are filtered out before render
  occupied: '#3b82f6',  // blue-500
  reserved: '#f59e0b',  // amber-500
}
/** Layer-wide opacity for the status tint. Matches the prior 0.55 visual. */
const STATUS_TINT_OPACITY = 0.55

interface MapBinOverlayProps {
  map: MapboxMapInstance | null
  /** Same shape array the grid overlay renders — we re-build the cells so we can stamp per-cell binStatus. */
  committedLines: CommittedLine[]
  /** All bin rows for the warehouses on the map. Filtered down per grid below. */
  bins: ReadonlyArray<Bin>
  /** Master visibility toggle (matches the racks-visible toolbar toggle). */
  visible: boolean
}

/**
 * Paints a translucent status tint on top of saved rack cells that have
 * a bin row attached. Cells without a row are not drawn (the underlying
 * rack styling shows through). Renders as a 3D fill-extrusion so the
 * tint sits at the correct altitude on multi-level pallet racks:
 * `fill-extrusion-base = baseElevation + level * levelHeight`. For
 * single-level grids (legacy behaviour, `levels === 1`), the extrusion
 * collapses to height 0 and is invisible — clicks fall through to the
 * regular grid overlay either way.
 *
 * Click handling is intentionally not added here — clicks fall through
 * to the grid overlay's click handler, which already knows how to pick
 * (gridId, row, col, level) and open the bin editor.
 */
/**
 * A rack's cells, rebuilt only when the rack's config object or corners
 * change — the store keeps an unchanged rack's config the same object, so
 * dragging one rack's slider no longer re-tessellates every rack here.
 */
const cellCache = new WeakMap<object, { id: number; start: unknown; current: unknown; cells: ReturnType<typeof buildGridFromLine>['cells'] }>()
function rackCells(cl: CommittedLine) {
  const hit = cellCache.get(cl.config)
  if (hit && hit.id === cl.id && hit.start === cl.start && hit.current === cl.current) return hit.cells
  const cells = buildGridFromLine(cl.start, cl.current, cl.config, { committed: true, gridId: cl.id }).cells
  cellCache.set(cl.config, { id: cl.id, start: cl.start, current: cl.current, cells })
  return cells
}

export function MapBinOverlay({
  map,
  committedLines,
  bins,
  visible,
}: MapBinOverlayProps) {
  // Build cell features for every saved bin. We have to re-run the
  // grid builder because the bin row only carries the (gridId, row,
  // col, level) key — the geometry lives on the parent grid.
  const data = useMemo<FeatureCollection<Polygon> | null>(() => {
    if (!visible || bins.length === 0 || committedLines.length === 0) return null
    // Group bins by `gridId` then by `"row-col-level"` for cheap
    // lookup when iterating the rebuilt cells. A flat Map keyed on the
    // triplet would also work but the two-level structure lets us skip
    // grids whose bins are all empty without rebuilding their cells.
    const byGrid = new Map<number, Map<string, Bin>>()
    for (const b of bins) {
      // v7+: bins may also target non-grid shapes; this overlay paints
      // grid-cell status tints only, so skip anything else.
      if (b.targetKind !== 'grid-cell' || b.gridId === undefined) continue
      let inner = byGrid.get(b.gridId)
      if (!inner) {
        inner = new Map()
        byGrid.set(b.gridId, inner)
      }
      inner.set(`${b.row}-${b.col}-${b.level ?? 0}`, b)
    }

    const features: Feature<Polygon>[] = []
    for (const cl of committedLines) {
      // Hidden rack → hide its bins too, so the layer toggle actually
      // clears everything the user associates with the rack.
      if (cl.visible === false) continue
      const binsForGrid = byGrid.get(cl.id)
      if (!binsForGrid) continue
      let cells
      try {
        cells = rackCells(cl)
      } catch (err) {
        console.warn('[MapBinOverlay] grid build failed', err, cl)
        continue
      }
      const totalLevels = Math.max(1, Math.floor(cl.config.levels ?? 1))
      const levelHeight = Math.max(0, cl.config.levelHeight ?? 0)
      const levelGap = Math.max(0, cl.config.levelGap ?? 0)
      for (const c of cells) {
        const level = c.properties.level ?? 0
        const key = `${c.properties.row}-${c.properties.col}-${level}`
        const bin = binsForGrid.get(key)
        if (!bin) continue
        // Skip empty bins — they're indistinguishable from "no bin row"
        // visually and we don't want to repaint over the rack color.
        if (bin.status === 'empty') continue
        // Compute the tint band's base + height. For single-level
        // grids we collapse to a thin band on top of the cell so the
        // tint is visible without ballooning into the air. For
        // multi-level racks each level's band hugs its own shelf.
        // The pitch is `levelHeight + levelGap` to match
        // `buildSquareGrid`'s altitude formula — otherwise tints land
        // in the wrong shelf when `levelGap > 0`.
        const base =
          totalLevels > 1
            ? (cl.config.elevation ?? 0) + level * (levelHeight + levelGap)
            : (cl.config.elevation ?? 0) + (cl.config.height ?? 0)
        const top =
          totalLevels > 1 ? base + levelHeight : base + 0.01
        features.push({
          type: 'Feature',
          properties: {
            gridId: cl.id,
            row: c.properties.row,
            col: c.properties.col,
            level,
            binStatus: bin.status,
            base,
            top,
          },
          geometry: c.geometry,
        })
      }
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [committedLines, bins, visible])

  useEffect(() => {
    if (!map) return
    const apply = () => {
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getLayer(LAYER_ID)) {
        // We use fill-extrusion (not flat fill) so multi-level racks
        // can have each level's tint sit at its own altitude. For
        // legacy single-level grids the base equals the grid's
        // elevation+height and the band is 0.01 m thick — visually
        // identical to a flat fill but renders in 3D, which keeps the
        // paint expression uniform.
        map.addLayer({
          id: LAYER_ID,
          type: 'fill-extrusion',
          source: SOURCE_ID,
          paint: {
            'fill-extrusion-color': [
              'match',
              ['get', 'binStatus'],
              'occupied', STATUS_COLORS.occupied,
              'reserved', STATUS_COLORS.reserved,
              // Fallthrough: status the layer can't tint. Won't be visible
              // because `fill-extrusion-opacity` below + the upstream filter
              // (empty bins are skipped at the source level) keep it hidden.
              '#000000',
            ],
            'fill-extrusion-base': ['coalesce', ['get', 'base'], 0],
            'fill-extrusion-height': ['coalesce', ['get', 'top'], 0],
            // `fill-extrusion-color` strips alpha — drive translucency
            // through the dedicated opacity property instead. Constant
            // for now; data-driven per-status pulse / heatmap is Phase 2.
            'fill-extrusion-opacity': STATUS_TINT_OPACITY,
            'fill-extrusion-vertical-gradient': false,
          },
        })
      }
      const src = map.getSource(SOURCE_ID) as GeoJSONSource | undefined
      if (src) src.setData(data ?? { type: 'FeatureCollection', features: [] })

      // Hover-highlight scaffolding. Source starts empty; the mousemove
      // handler below populates it with the cell currently under the
      // cursor. Line layer sits on top of everything (added last) so the
      // highlight is never occluded by other overlays.
      if (!map.getSource(HOVER_SOURCE)) {
        map.addSource(HOVER_SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
      if (!map.getLayer(HOVER_LAYER)) {
        map.addLayer({
          id: HOVER_LAYER,
          type: 'line',
          source: HOVER_SOURCE,
          paint: {
            // Cyan — distinct from the yellow selection outline and the
            // blue/amber status tints, so all three can coexist visually.
            'line-color': '#22d3ee',
            'line-width': 3,
            'line-opacity': 0.95,
            // We deliberately leave `line-occlusion-opacity` at its
            // spec default of 0 so a 3D model / building in front of
            // the rack hides the hover outline it occludes (otherwise
            // the cyan line ghosts through every occluder). The 2 cm
            // epsilon in `line-z-offset` below already wins the depth
            // test against the rack's own roof.
            // Keep the highlight fully bright over lit 3D extrusions in
            // the Mapbox Standard style (v3 lighting model).
            'line-emissive-strength': 1,
          },
          layout: {
            // Sit the outline just above the cell's top surface in 3D so
            // it's visible on extruded racks. Falls back to ground level
            // when elevation/height aren't present in the feature.
            'line-elevation-reference': 'sea',
            'line-z-offset': [
              '+',
              ['coalesce', ['get', 'elevation'], 0],
              ['coalesce', ['get', 'height'], 0],
              0.02,
            ],
          },
        })
      }
    }
    if (map.isStyleLoaded()) apply()
    else map.once('style.load', apply)
    return () => {
      // Don't remove the source/layer on every re-render; only on full
      // unmount. We detect "real" unmount by checking the map instance
      // is still valid and removing safely.
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
        if (map.getLayer(HOVER_LAYER)) map.removeLayer(HOVER_LAYER)
        if (map.getSource(HOVER_SOURCE)) map.removeSource(HOVER_SOURCE)
      } catch {
        // Map already torn down — ignore.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  useEffect(() => {
    if (!map) return
    // A data update can land while Mapbox is mid-style-change (common
    // when the toolbar layer toggle re-orders sibling overlays' layers,
    // which triggers a synchronous style rebuild). Silently returning on
    // `!isStyleLoaded()` — the pre-fix behaviour — leaves stale features
    // in the source until the next data reference change; for the hide
    // path (`data === null` twice in a row) that "next change" never
    // comes and the racks stayed visible after the toggle.
    //
    // `whenStyleLoaded` uses both a `style.load` listener AND a poll —
    // the poll is critical because `style.load` only fires on a fresh
    // `setStyle()`, not on a transient `isStyleLoaded()===false` during
    // layer churn (which is exactly the case that regressed here).
    return whenStyleLoaded(map, () => {
      const src = map.getSource(SOURCE_ID) as GeoJSONSource | undefined
      if (src) src.setData(data ?? { type: 'FeatureCollection', features: [] })
    }, '[MapBinOverlay:setData]')
  }, [map, data])

  // ---- Hover popup ------------------------------------------------------
  // Originally bound to `bin-status-layer`, but that layer filters out
  // bins with status='empty' (the default for imports without a status
  // column), so freshly-imported bins had no hit target. We now listen
  // on the grid overlay's own cell layers — those always exist for any
  // saved grid — and look the bin up by (gridId, row, col, level). The
  // popup only renders when the bin actually carries some data, so
  // hovering empty cells stays clean.
  const binsRef = useRef(bins)
  useEffect(() => {
    binsRef.current = bins
  }, [bins])
  const popupRef = useRef<mapboxgl.Popup | null>(null)
  const popupRootRef = useRef<Root | null>(null)
  const popupNodeRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!map) return
    // Layer IDs owned by `map-grid-overlay.tsx`. Hardcoded on purpose —
    // these are part of the public layer contract that overlay exports.
    // The 3D extrusion is split across 11 opacity-bucket layers
    // (`grid-extrude-layer-op0` … `-op100`) since Mapbox doesn't support
    // data-driven `fill-extrusion-opacity`. Without enumerating them
    // here the hover popup silently dies over 3D-extruded racks.
    const GRID_FILL = 'grid-fill-layer'
    const GRID_EXTRUDE_LAYERS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(
      (b) => `grid-extrude-layer-op${b}`,
    )

    const setHoverFeature = (f: mapboxgl.MapboxGeoJSONFeature | null) => {
      const src = map.getSource(HOVER_SOURCE) as GeoJSONSource | undefined
      if (!src) return
      if (!f) {
        src.setData({ type: 'FeatureCollection', features: [] })
        return
      }
      src.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            // Forward elevation/height so the line layer's z-offset
            // expression places the outline at the cell's top in 3D.
            properties: {
              elevation: (f.properties as { elevation?: number } | null)?.elevation ?? 0,
              height: (f.properties as { height?: number } | null)?.height ?? 0,
            },
            geometry: f.geometry as Polygon,
          },
        ],
      })
    }

    // Track which cell is currently rendered inside the popup. Calling
    // `mapboxgl.Popup.addTo()` on an already-attached popup destructively
    // re-attaches the DOM (replaying the CSS entry animation) and
    // re-renders React with the same bin reconciles cheaply but
    // unnecessarily — so we short-circuit both when nothing changed.
    let renderedCellKey: string | null = null

    const onMove = (e: mapboxgl.MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return clearHover()
      const props = f.properties as
        | { gridId?: number; row?: number; col?: number; level?: number }
        | undefined
      if (
        !props ||
        typeof props.gridId !== 'number' ||
        typeof props.row !== 'number' ||
        typeof props.col !== 'number'
      ) {
        return clearHover()
      }
      // Highlight outline always paints — even on cells without linked
      // data — so the user gets a clear "this cell is under your cursor"
      // affordance. The popup below is gated on bin content.
      setHoverFeature(f)
      map.getCanvas().style.cursor = 'pointer'

      const level = typeof props.level === 'number' ? props.level : 0
      const bin = binsRef.current.find(
        (b) =>
          b.targetKind === 'grid-cell' &&
          b.gridId === props.gridId &&
          b.row === props.row &&
          b.col === props.col &&
          (b.level ?? 0) === level,
      )
      if (!bin || !hasMeaningfulData(bin)) {
        if (popupRef.current?.isOpen()) popupRef.current.remove()
        renderedCellKey = null
        return
      }
      if (!popupRef.current) {
        popupRef.current = new mapboxgl.Popup({
          closeButton: false,
          closeOnClick: false,
          // 12px lift so the popup tail sits just above the cursor instead
          // of obscuring the hovered cell.
          offset: 12,
          className: 'bin-hover-popup',
          maxWidth: '340px',
        })
      }
      if (!popupNodeRef.current) {
        popupNodeRef.current = document.createElement('div')
        popupRootRef.current = createRoot(popupNodeRef.current)
        popupRef.current.setDOMContent(popupNodeRef.current)
      }
      const cellKey = `${props.gridId}:${props.row}:${props.col}:${level}`
      if (renderedCellKey !== cellKey) {
        popupRootRef.current?.render(<BinPopupContent bin={bin} />)
        renderedCellKey = cellKey
      }
      popupRef.current.setLngLat(e.lngLat)
      if (!popupRef.current.isOpen()) popupRef.current.addTo(map)
    }
    const clearHover = () => {
      if (popupRef.current?.isOpen()) popupRef.current.remove()
      renderedCellKey = null
      setHoverFeature(null)
      // Reset cursor only when we set it — the grid overlay sets its own
      // cursors for click-to-select / draw modes, so we don't want to
      // stomp those.
      if (map.getCanvas().style.cursor === 'pointer') {
        map.getCanvas().style.cursor = ''
      }
    }
    const hidePopup = clearHover
    map.on('mousemove', GRID_FILL, onMove)
    map.on('mouseleave', GRID_FILL, hidePopup)
    for (const id of GRID_EXTRUDE_LAYERS) {
      map.on('mousemove', id, onMove)
      map.on('mouseleave', id, hidePopup)
    }
    return () => {
      map.off('mousemove', GRID_FILL, onMove)
      map.off('mouseleave', GRID_FILL, hidePopup)
      for (const id of GRID_EXTRUDE_LAYERS) {
        map.off('mousemove', id, onMove)
        map.off('mouseleave', id, hidePopup)
      }
      // After `map.remove()` runs (e.g. on unmount or route change —
      // the sibling `MapboxMap` cleanup tears down the map before this
      // one fires), the map's internal `style` is undefined, so
      // `hidePopup -> setHoverFeature -> map.getSource` crashes with
      // "Cannot read properties of undefined (reading 'getOwnSource')".
      // Skip the hover-state cleanup in that case — the popup and
      // hover source are gone with the map anyway.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((map as any).style) hidePopup()
      else if (popupRef.current?.isOpen()) popupRef.current.remove()
      // Defer unmount past the current render commit — unmounting a
      // root synchronously inside an effect cleanup triggers a React
      // warning. Re-mount happens on the next effect run.
      if (popupRootRef.current) {
        const root = popupRootRef.current
        popupRootRef.current = null
        popupNodeRef.current = null
        queueMicrotask(() => root.unmount())
      }
    }
  }, [map])

  return null
}

/** True when the bin carries at least one user-visible field. */
export function hasMeaningfulData(bin: Bin): boolean {
  if (bin.externalCode) return true
  if (bin.sku) return true
  if (typeof bin.capacity === 'number') return true
  if (bin.notes) return true
  if (bin.status && bin.status !== 'empty') return true
  if (bin.customProperties && Object.keys(bin.customProperties).length > 0) return true
  return false
}

/**
 * Build the popup HTML body. Plain string instead of React because
 * mapboxgl.Popup wants a DOM string and round-tripping through React
 * portals for a hover tooltip is more machinery than the surface
 * deserves. We HTML-escape user-supplied strings (externalCode, custom
 * property values) since they can come from imported CSVs.
 */
export function renderPopupHtml(bin: Bin): string {
  const esc = (s: unknown) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  const lines: string[] = []
  if (bin.externalCode) {
    lines.push(
      `<div class="bin-popup-code">${esc(bin.externalCode)}</div>`,
    )
  }
  if (bin.sku) {
    lines.push(`<div class="bin-popup-row"><span>SKU</span><span>${esc(bin.sku)}</span></div>`)
  }
  if (typeof bin.capacity === 'number') {
    lines.push(
      `<div class="bin-popup-row"><span>Capacity</span><span>${esc(bin.capacity.toLocaleString())}</span></div>`,
    )
  }
  if (bin.status && bin.status !== 'empty') {
    lines.push(
      `<div class="bin-popup-row"><span>Status</span><span class="bin-popup-status bin-popup-status-${esc(bin.status)}">${esc(bin.status)}</span></div>`,
    )
  }
  // Top 4 custom properties — keep the popup compact.
  const entries = Object.entries(bin.customProperties ?? {}).slice(0, 4)
  for (const [k, v] of entries) {
    lines.push(`<div class="bin-popup-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
  }
  if (lines.length === 0) {
    lines.push(`<div class="bin-popup-empty">No linked data</div>`)
  }
  return `<div class="bin-popup">${lines.join('')}</div>`
}
