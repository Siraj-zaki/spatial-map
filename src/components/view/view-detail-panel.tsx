import {
  Activity,
  ArrowUpRight,
  Boxes,
  Circle as CircleIcon,
  Copy,
  Image as ImageIcon,
  Layers,
  MapPin,
  Minus,
  Navigation,
  Pentagon,
  Share2,
  Tag,
  Truck,
  TrendingUp,
  Video,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Bin, DataSource, Grid, Stream } from '@/lib/db'
// Slice 6c2 of the data-link refactor: live entity records are all one
// shape now — an `entity_states` row joined with its parent stream.
import type { EntityStateWithStream } from '@/lib/data-link/entity-state-service'
import type {
  CircleShape,
  ImageShape,
  LineShape,
  MarkerShape,
  ModelShape,
  PolygonShape,
  StairShape,
  TextLabelShape,
} from '@/lib/shapes'
import type { DoorShape } from '@/lib/door/types'
import { BinPopupContent } from '@/components/bin-popup-content'
import { hasAnyContent } from '@/lib/rich-data'
import { useSpatialBins } from '@/hooks/useSpatialShapes'

export type DetailSelection =
  | { kind: 'grid-cell'; grid: Grid; row: number; col: number; level: number; bin?: Bin }
  | { kind: 'marker'; marker: MarkerShape }
  | { kind: 'model'; model: ModelShape }
  | { kind: 'polygon'; polygon: PolygonShape }
  | { kind: 'circle'; circle: CircleShape }
  | { kind: 'line'; line: LineShape }
  | { kind: 'image'; image: ImageShape }
  | { kind: 'stair'; stair: StairShape }
  | { kind: 'text'; label: TextLabelShape }
  | { kind: 'door'; door: DoorShape }
  // Slice 6c2 — unified live-record shape. `entityType` on each row
  // discriminates which of the four DetailBody branches renders.
  | { kind: 'asset'; asset: EntityStateWithStream }
  | { kind: 'sensor'; sensor: EntityStateWithStream }
  | { kind: 'camera'; camera: EntityStateWithStream }
  | { kind: 'shipment'; shipment: EntityStateWithStream }
  // Integration definitions — configured sources + active streams
  | { kind: 'source'; source: DataSource }
  | { kind: 'stream'; stream: Stream }

interface ViewDetailPanelProps {
  selection: DetailSelection | null
  onClose: () => void
  /** Re-frame the map on the current selection. */
  onFlyTo?: () => void
  /**
   * Indoor navigation hooks. When provided, the panel renders
   * "Directions from here" / "Directions to here" buttons on
   * selections that the nav graph supports (polygon, door, stair,
   * marker). Selections without graph nodes (bins, sensors, assets)
   * skip the buttons.
   */
  onDirectionsFromHere?: (kind: 'polygon' | 'door' | 'stair' | 'marker', shapeId: number) => void
  onDirectionsToHere?: (kind: 'polygon' | 'door' | 'stair' | 'marker', shapeId: number) => void
}

type SheetStop = 'peek' | 'half' | 'full'

/**
 * Read `(max-width: 639px)` once and subscribe to media-query changes
 * so we can rebuild the panel as a bottom sheet under the sm
 * breakpoint. Uses `addEventListener('change', ...)` for hot rotation.
 */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(max-width: 639px)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia('(max-width: 639px)')
    const update = () => setIsMobile(mql.matches)
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [])
  return isMobile
}

/** Map each sheet stop to a viewport-relative height. Peek shows just
 * the header strip; half is a comfortable preview; full all but a sliver
 * of map. The user can drag-cycle by tapping the handle. */
const SHEET_HEIGHTS: Record<SheetStop, string> = {
  peek: '88px',
  half: '50dvh',
  full: '90dvh',
}

const NEXT_STOP: Record<SheetStop, SheetStop> = {
  peek: 'half',
  half: 'full',
  full: 'peek',
}

/**
 * Slice 6c2 helper — safe reader for entity_states `payload` fields.
 * Returns undefined when the value isn't a non-empty string so callers
 * can `??`-fall-back to a stable default.
 */
function payloadString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function HeaderIcon({ selection }: { selection: DetailSelection }) {
  const cls = 'w-4 h-4 flex-shrink-0'
  switch (selection.kind) {
    case 'grid-cell': return <Layers className={`${cls} text-sky-500`} />
    case 'marker':    return <MapPin className={`${cls} text-red-500`} />
    case 'model':     return <Boxes className={`${cls} text-indigo-500`} />
    case 'polygon':   return <Pentagon className={`${cls} text-green-500`} />
    case 'circle':    return <CircleIcon className={`${cls} text-purple-500`} />
    case 'line':      return <Minus className={`${cls} text-yellow-500`} />
    case 'image':     return <ImageIcon className={`${cls} text-slate-500`} />
    case 'stair':     return <TrendingUp className={`${cls} text-orange-500`} />
    case 'text':      return <Tag className={`${cls} text-slate-900 dark:text-slate-100`} />
    case 'door':      return <ArrowUpRight className={`${cls} text-blue-500`} />

    case 'asset':     return <Zap className={`${cls} text-emerald-500`} />
    case 'sensor':    return <Activity className={`${cls} text-teal-500`} />
    case 'camera':    return <Video className={`${cls} text-indigo-500`} />
    case 'shipment':  return <Truck className={`${cls} text-amber-500`} />
    case 'source':    return <Boxes className={`${cls} text-indigo-500`} />
    case 'stream':    return <Activity className={`${cls} text-emerald-500`} />
  }
}

function selectionTitle(selection: DetailSelection, t: ReturnType<typeof useTranslation>['t']): string {
  switch (selection.kind) {
    case 'grid-cell':
      return selection.grid.name || t('view.detail.unnamedRack', { defaultValue: 'Unnamed rack' })
    case 'marker': return selection.marker.name || t('view.detail.unnamedMarker', { defaultValue: 'Marker' })
    case 'model':  return selection.model.name || t('view.detail.unnamedModel', { defaultValue: '3D model' })
    case 'polygon':return selection.polygon.name || t('view.detail.unnamedPolygon', { defaultValue: 'Polygon' })
    case 'circle': return selection.circle.name || t('view.detail.unnamedCircle', { defaultValue: 'Circle' })
    case 'line':   return selection.line.name || t('view.detail.unnamedLine', { defaultValue: 'Line' })
    case 'image':  return selection.image.name || t('view.detail.unnamedImage', { defaultValue: 'Floor plan' })
    case 'stair':  return selection.stair.name || t('view.detail.unnamedStair', { defaultValue: 'Stair' })
    case 'text':   return selection.label.config?.text || selection.label.name || t('view.detail.unnamedLabel', { defaultValue: 'Text label' })
    case 'door':   return selection.door.name || t('view.detail.unnamedDoor', { defaultValue: 'Door' })
    // Slice 6c2: live-record titles pull `label` from the payload
    // (publisher-stamped display name) and fall back to entityKey.
    case 'asset':  return payloadString(selection.asset.payload.label) ?? selection.asset.entityKey
    case 'sensor': return payloadString(selection.sensor.payload.label) ?? selection.sensor.entityKey
    case 'camera': return payloadString(selection.camera.payload.label) ?? selection.camera.entityKey
    case 'shipment': return payloadString(selection.shipment.payload.label) ?? selection.shipment.entityKey
    case 'source': return selection.source.name
    case 'stream': return selection.stream.name || selection.stream.entityType || `Stream #${selection.stream.id}`
  }
}

function selectionSubtitle(selection: DetailSelection, t: ReturnType<typeof useTranslation>['t']): string {
  switch (selection.kind) {
    case 'grid-cell': return t('view.detail.cellSubtitle', { row: selection.row, col: selection.col, level: selection.level, defaultValue: `Cell ${selection.row},${selection.col} · Level ${selection.level}` })
    case 'marker':    return t('view.detail.markerSubtitle', { defaultValue: 'Marker' })
    case 'model':     return t('view.detail.modelSubtitle', { defaultValue: '3D model' })
    case 'polygon':   return t('view.detail.polygonSubtitle', { defaultValue: 'Polygon' })
    case 'circle':    return t('view.detail.circleSubtitle', { defaultValue: 'Circle' })
    case 'line':      return t('view.detail.lineSubtitle', { defaultValue: 'Line' })
    case 'image':     return t('view.detail.imageSubtitle', { defaultValue: 'Floor plan' })
    case 'stair':     return t('view.detail.stairSubtitle', { defaultValue: 'Stair' })
    case 'text':      return t('view.detail.textSubtitle', { defaultValue: 'Text label' })
    case 'door':      return t('view.detail.doorSubtitle', { defaultValue: 'Door' })
    // Slice 6c2: subtitle text pulls from the generic payload.
    case 'asset':     return payloadString(selection.asset.payload.type) ?? t('view.detail.assetSubtitle', { defaultValue: 'Asset' })
    case 'sensor':    return payloadString(selection.sensor.payload.kind) ?? t('view.detail.sensorSubtitle', { defaultValue: 'Sensor' })
    case 'camera':    return payloadString(selection.camera.payload.kind) ?? t('view.detail.cameraSubtitle', { defaultValue: 'Camera' })
    case 'shipment':  return payloadString(selection.shipment.payload.state) ?? t('view.detail.shipmentSubtitle', { defaultValue: 'Shipment' })
    case 'source':    return `${selection.source.kind} · ${selection.source.schedule ?? 'manual'}`
    case 'stream':    return selection.stream.entityType ?? t('view.detail.streamSubtitle', { defaultValue: 'Stream' })
  }
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-right break-words">{value}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t pt-2 mt-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{title}</div>
      <div className="flex flex-col">{children}</div>
    </div>
  )
}

function formatCoord(c: [number, number] | undefined): string {
  if (!c) return '—'
  return `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`
}

/**
 * Editor-parity rich-content block. The editor's `MapShapeTooltip`
 * resolves a hovered shape to its linked `Bin` row (matched by
 * `targetKind` + `shapeId`) and renders the full `BinPopupContent` —
 * status chip, media carousel, link tiles, primary fields (SKU,
 * external code, capacity, notes), and every custom attribute the
 * Schema Builder defined for this shape kind. The viewer now does the
 * same so clicking a polygon / circle / marker / line / image / model
 * surfaces the same body of information the editor shows on hover.
 *
 * Returns `null` when no linked bin exists OR when the linked bin has
 * no content worth showing — keeps the panel from rendering a hollow
 * "Linked data" header for shapes with no custom data attached.
 */
function LinkedBinContent({
  kind,
  shapeId,
  bins,
}: {
  kind: 'polygon' | 'circle' | 'line' | 'marker' | 'image' | 'model'
  shapeId: number | undefined
  bins: ReadonlyArray<Bin>
}) {
  if (shapeId === undefined) return null
  const bin = bins.find(
    (b) => b.targetKind === kind && b.shapeId === shapeId,
  )
  if (!bin) return null
  if (!hasAnyContent(bin)) return null
  return (
    <div className="border-t pt-2 mt-2">
      <BinPopupContent bin={bin} />
    </div>
  )
}

function BinDetail({ bin, t }: { bin: Bin; t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <Section title={t('view.detail.bin', { defaultValue: 'Bin' })}>
      {bin.status && <Field label={t('view.detail.status', { defaultValue: 'Status' })} value={bin.status} />}
      {bin.sku && <Field label={t('view.detail.sku', { defaultValue: 'SKU' })} value={bin.sku} />}
      {bin.externalCode && <Field label={t('view.detail.externalCode', { defaultValue: 'Code' })} value={bin.externalCode} />}
      {bin.capacity !== undefined && <Field label={t('view.detail.capacity', { defaultValue: 'Capacity' })} value={bin.capacity} />}
      {bin.notes && <Field label={t('view.detail.notes', { defaultValue: 'Notes' })} value={bin.notes} />}
      {bin.lastSyncedAt && (
        <Field
          label={t('view.detail.lastSynced', { defaultValue: 'Last synced' })}
          value={new Date(bin.lastSyncedAt).toLocaleString()}
        />
      )}
    </Section>
  )
}

function DetailBody({
  selection,
  bins,
  t,
}: {
  selection: DetailSelection
  bins: ReadonlyArray<Bin>
  t: ReturnType<typeof useTranslation>['t']
}) {
  switch (selection.kind) {
    case 'grid-cell': {
      const { grid, row, col, level, bin } = selection
      return (
        <>
          <Section title={t('view.detail.rack', { defaultValue: 'Rack' })}>
            {grid.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${grid.id}`} />}
            <Field label={t('view.detail.row', { defaultValue: 'Row' })} value={row} />
            <Field label={t('view.detail.col', { defaultValue: 'Col' })} value={col} />
            <Field label={t('view.detail.level', { defaultValue: 'Level' })} value={level} />
          </Section>
          {bin && <BinDetail bin={bin} t={t} />}
        </>
      )
    }
    case 'marker': {
      const m = selection.marker
      return (
        <>
          <Section title={t('view.detail.marker', { defaultValue: 'Marker' })}>
            {m.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${m.id}`} />}
            <Field label={t('view.detail.position', { defaultValue: 'Position' })} value={<code className="text-[10px]">{formatCoord(m.position)}</code>} />
            {m.bearing !== 0 && <Field label={t('view.detail.bearing', { defaultValue: 'Bearing' })} value={`${m.bearing}°`} />}
            {m.config?.label && <Field label={t('view.detail.label', { defaultValue: 'Label' })} value={m.config.label} />}
          </Section>
          <LinkedBinContent kind="marker" shapeId={m.id} bins={bins} />
        </>
      )
    }
    case 'model': {
      const m = selection.model
      return (
        <>
          <Section title={t('view.detail.model', { defaultValue: 'Model' })}>
            {m.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${m.id}`} />}
            <Field label={t('view.detail.position', { defaultValue: 'Position' })} value={<code className="text-[10px]">{formatCoord(m.position)}</code>} />
            <Field label={t('view.detail.elevation', { defaultValue: 'Elevation' })} value={`${m.config.elevation} m`} />
            {m.config.modelAssetId && <Field label={t('view.detail.asset', { defaultValue: 'Asset' })} value={m.config.modelAssetId} />}
          </Section>
          <LinkedBinContent kind="model" shapeId={m.id} bins={bins} />
        </>
      )
    }
    case 'polygon': {
      const p = selection.polygon
      return (
        <>
          <Section title={t('view.detail.polygon', { defaultValue: 'Polygon' })}>
            {p.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${p.id}`} />}
            <Field label={t('view.detail.vertices', { defaultValue: 'Vertices' })} value={p.vertices.length} />
            {p.role && <Field label={t('view.detail.role', { defaultValue: 'Role' })} value={p.role} />}
            {p.config?.label && <Field label={t('view.detail.label', { defaultValue: 'Label' })} value={p.config.label} />}
          </Section>
          <LinkedBinContent kind="polygon" shapeId={p.id} bins={bins} />
        </>
      )
    }
    case 'circle': {
      const c = selection.circle
      return (
        <>
          <Section title={t('view.detail.circle', { defaultValue: 'Circle' })}>
            {c.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${c.id}`} />}
            <Field label={t('view.detail.mode', { defaultValue: 'Mode' })} value={c.mode} />
            {c.radius !== undefined && <Field label={t('view.detail.radius', { defaultValue: 'Radius' })} value={`${c.radius.toFixed(2)} m`} />}
            {c.role && <Field label={t('view.detail.role', { defaultValue: 'Role' })} value={c.role} />}
            {c.config?.label && <Field label={t('view.detail.label', { defaultValue: 'Label' })} value={c.config.label} />}
          </Section>
          <LinkedBinContent kind="circle" shapeId={c.id} bins={bins} />
        </>
      )
    }
    case 'line': {
      const l = selection.line
      return (
        <>
          <Section title={t('view.detail.line', { defaultValue: 'Line' })}>
            {l.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${l.id}`} />}
            <Field label={t('view.detail.vertices', { defaultValue: 'Vertices' })} value={l.vertices.length} />
            {l.config?.label && <Field label={t('view.detail.label', { defaultValue: 'Label' })} value={l.config.label} />}
          </Section>
          <LinkedBinContent kind="line" shapeId={l.id} bins={bins} />
        </>
      )
    }
    case 'image': {
      const img = selection.image
      return (
        <>
          <Section title={t('view.detail.image', { defaultValue: 'Floor plan' })}>
            {img.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${img.id}`} />}
            <Field label={t('view.detail.size', { defaultValue: 'Size' })} value={`${img.naturalWidth}×${img.naturalHeight}`} />
          </Section>
          <LinkedBinContent kind="image" shapeId={img.id} bins={bins} />
        </>
      )
    }
    case 'stair': {
      const s = selection.stair
      return (
        <Section title={t('view.detail.stair', { defaultValue: 'Stair' })}>
          {s.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${s.id}`} />}
        </Section>
      )
    }
    case 'text': {
      const lbl = selection.label
      return (
        <Section title={t('view.detail.text', { defaultValue: 'Text label' })}>
          {lbl.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${lbl.id}`} />}
          <Field label={t('view.detail.content', { defaultValue: 'Content' })} value={lbl.config?.text ?? ''} />
        </Section>
      )
    }
    case 'door': {
      const d = selection.door
      const v0 = d.vertices[0]
      const v1 = d.vertices[1]
      // Opening width: planar distance between jamb anchors. Using a
      // small-angle approximation so this is one line; ≤ 0.5% error
      // up to ~10 m which is fine for an info card.
      const meanLat = (v0[1] + v1[1]) / 2
      const dxM = (v1[0] - v0[0]) * 111_320 * Math.cos((meanLat * Math.PI) / 180)
      const dyM = (v1[1] - v0[1]) * 111_320
      const width = Math.sqrt(dxM * dxM + dyM * dyM)
      return (
        <Section title={t('view.detail.door', { defaultValue: 'Door' })}>
          {d.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${d.id}`} />}
          <Field label={t('view.detail.type', { defaultValue: 'Type' })} value={d.config.kind} />
          <Field label={t('view.detail.state', { defaultValue: 'State' })} value={d.config.state} />
          <Field label={t('view.detail.width', { defaultValue: 'Width' })} value={`${width.toFixed(2)} m`} />
          <Field label={t('view.detail.height', { defaultValue: 'Height' })} value={`${d.config.doorHeight.toFixed(2)} m`} />
        </Section>
      )
    }
    // Slice 6c2 — the four live-record kinds share the generic
    // `EntityStateWithStream` shape. Field reads pull from `payload.*`
    // via the narrowing helpers; unknown fields degrade to skipped
    // rows so a partial publisher payload still renders a readable
    // panel. Position is the PostGIS point unpacked to [lng, lat] and
    // is served identically for all four kinds.
    case 'asset': {
      const a = selection.asset
      // eslint-disable-next-line react-hooks/purity -- staleness is recomputed on every render by design
      const stale = Date.now() - a.lastSeenAt.getTime() > 30_000
      const type = payloadString(a.payload.type)
      const status = payloadString(a.payload.status)
      const heading = typeof a.payload.heading === 'number' ? a.payload.heading : undefined
      const speed = typeof a.payload.speed === 'number' ? a.payload.speed : undefined
      return (
        <Section title={t('view.detail.asset', { defaultValue: 'Asset' })}>
          <Field label={t('view.detail.assetId', { defaultValue: 'ID' })} value={<code className="text-[10px]">{a.entityKey}</code>} />
          {type && <Field label={t('view.detail.assetType', { defaultValue: 'Type' })} value={type} />}
          {status && <Field label={t('view.detail.status', { defaultValue: 'Status' })} value={status} />}
          {a.position && (
            <Field label={t('view.detail.position', { defaultValue: 'Position' })} value={<code className="text-[10px]">{formatCoord(a.position)}</code>} />
          )}
          {heading !== undefined && <Field label={t('view.detail.bearing', { defaultValue: 'Bearing' })} value={`${heading.toFixed(0)}°`} />}
          {speed !== undefined && <Field label={t('view.detail.speed', { defaultValue: 'Speed' })} value={`${speed.toFixed(1)} m/s`} />}
          <Field
            label={t('view.detail.lastSeen', { defaultValue: 'Last seen' })}
            value={
              <span className={stale ? 'text-amber-500' : undefined}>
                {a.lastSeenAt.toLocaleTimeString()}
                {stale ? ` · ${t('view.detail.stale', { defaultValue: 'stale' })}` : ''}
              </span>
            }
          />
        </Section>
      )
    }
    case 'sensor': {
      const s = selection.sensor
      // eslint-disable-next-line react-hooks/purity -- staleness is recomputed on every render by design
      const stale = Date.now() - s.lastSeenAt.getTime() > 5 * 60 * 1000
      const kind = payloadString(s.payload.kind)
      const lastValue = typeof s.payload.value === 'number' ? s.payload.value : undefined
      const unit = payloadString(s.payload.unit) ?? ''
      return (
        <Section title={t('view.detail.sensor', { defaultValue: 'Sensor' })}>
          <Field label={t('view.detail.sensorId', { defaultValue: 'ID' })} value={<code className="text-[10px]">{s.entityKey}</code>} />
          {kind && <Field label={t('view.detail.kind', { defaultValue: 'Kind' })} value={kind} />}
          {lastValue !== undefined && (
            <Field
              label={t('view.detail.value', { defaultValue: 'Value' })}
              value={
                <span className="font-semibold">
                  {lastValue.toFixed(2)}
                  {unit ? ` ${unit}` : ''}
                </span>
              }
            />
          )}
          {s.position && (
            <Field label={t('view.detail.position', { defaultValue: 'Position' })} value={<code className="text-[10px]">{formatCoord(s.position)}</code>} />
          )}
          <Field
            label={t('view.detail.lastUpdate', { defaultValue: 'Last update' })}
            value={
              <span className={stale ? 'text-amber-500' : undefined}>
                {s.lastSeenAt.toLocaleTimeString()}
                {stale ? ` · ${t('view.detail.stale', { defaultValue: 'stale' })}` : ''}
              </span>
            }
          />
        </Section>
      )
    }
    case 'camera': {
      const c = selection.camera
      const kind = payloadString(c.payload.kind)
      const yaw = typeof c.payload.yaw === 'number' ? c.payload.yaw : undefined
      const fovDeg = typeof c.payload.fovDeg === 'number' ? c.payload.fovDeg : undefined
      const viewDistanceM = typeof c.payload.viewDistanceM === 'number' ? c.payload.viewDistanceM : undefined
      const streamUrl = payloadString(c.payload.streamUrl)
      return (
        <Section title={t('view.detail.camera', { defaultValue: 'Camera' })}>
          <Field label={t('view.detail.cameraId', { defaultValue: 'ID' })} value={<code className="text-[10px]">{c.entityKey}</code>} />
          {kind && <Field label={t('view.detail.kind', { defaultValue: 'Kind' })} value={kind} />}
          {c.position && (
            <Field label={t('view.detail.position', { defaultValue: 'Position' })} value={<code className="text-[10px]">{formatCoord(c.position)}</code>} />
          )}
          {yaw !== undefined && <Field label={t('view.detail.yaw', { defaultValue: 'Yaw' })} value={`${yaw.toFixed(0)}°`} />}
          {fovDeg !== undefined && <Field label={t('view.detail.fov', { defaultValue: 'FOV' })} value={`${fovDeg.toFixed(0)}°`} />}
          {viewDistanceM !== undefined && (
            <Field label={t('view.detail.range', { defaultValue: 'Range' })} value={`${viewDistanceM.toFixed(0)} m`} />
          )}
          {streamUrl && (
            <Field label={t('view.detail.stream', { defaultValue: 'Stream' })} value={<code className="text-[10px] break-all">{streamUrl}</code>} />
          )}
        </Section>
      )
    }
    case 'shipment': {
      const s = selection.shipment
      const state = payloadString(s.payload.state) ?? '—'
      const kind = payloadString(s.payload.kind)
      const carrier = payloadString(s.payload.carrier)
      const etaAtStr = payloadString(s.payload.etaAt)
      return (
        <Section title={t('view.detail.shipment', { defaultValue: 'Shipment' })}>
          <Field label={t('view.detail.shipmentId', { defaultValue: 'ID' })} value={<code className="text-[10px]">{s.entityKey}</code>} />
          <Field label={t('view.detail.state', { defaultValue: 'State' })} value={state} />
          {kind && <Field label={t('view.detail.direction', { defaultValue: 'Direction' })} value={kind} />}
          {carrier && <Field label={t('view.detail.carrier', { defaultValue: 'Carrier' })} value={carrier} />}
          {s.position && (
            <Field label={t('view.detail.position', { defaultValue: 'Position' })} value={<code className="text-[10px]">{formatCoord(s.position)}</code>} />
          )}
          {etaAtStr && (
            <Field label={t('view.detail.eta', { defaultValue: 'ETA' })} value={new Date(etaAtStr).toLocaleString()} />
          )}
          <Field label={t('view.detail.lastSeen', { defaultValue: 'Last seen' })} value={s.lastSeenAt.toLocaleTimeString()} />
        </Section>
      )
    }
    case 'source': {
      const ds = selection.source
      return (
        <Section title={t('view.detail.source', { defaultValue: 'Integration source' })}>
          {ds.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${ds.id}`} />}
          <Field label={t('view.detail.sourceKind', { defaultValue: 'Kind' })} value={ds.kind} />
          {ds.schedule && <Field label={t('view.detail.schedule', { defaultValue: 'Schedule' })} value={ds.schedule} />}
          {ds.intervalSeconds !== undefined && (
            <Field label={t('view.detail.interval', { defaultValue: 'Interval' })} value={`${ds.intervalSeconds}s`} />
          )}
          {ds.lastResult && (
            <Field label={t('view.detail.lastResult', { defaultValue: 'Last result' })} value={ds.lastResult} />
          )}
          {ds.lastRunAt && (
            <Field label={t('view.detail.lastRun', { defaultValue: 'Last run' })} value={new Date(ds.lastRunAt).toLocaleString()} />
          )}
          <Field label={t('view.detail.created', { defaultValue: 'Created' })} value={new Date(ds.createdAt).toLocaleDateString()} />
        </Section>
      )
    }
    case 'stream': {
      const s = selection.stream
      return (
        <Section title={t('view.detail.stream', { defaultValue: 'Stream' })}>
          {s.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${s.id}`} />}
          {s.entityType && <Field label={t('view.detail.entityType', { defaultValue: 'Entity type' })} value={s.entityType} />}
          {s.kind && <Field label={t('view.detail.streamKind', { defaultValue: 'Kind' })} value={s.kind} />}
          {s.connectionId !== undefined && (
            <Field label={t('view.detail.connection', { defaultValue: 'Connection' })} value={`#${s.connectionId}`} />
          )}
        </Section>
      )
    }
  }
}

/**
 * Right-side detail panel for the viewer. Opens on POI click, never as a
 * tiny floating popup. Persistent until the user closes it or clicks
 * another POI.
 */
/** Pull a stable id from any selection for the per-POI reset effect. */
function getSelectionKey(selection: DetailSelection | null): string {
  if (!selection) return ''
  switch (selection.kind) {
    case 'grid-cell': return `rack:${selection.grid.id}:${selection.row}:${selection.col}:${selection.level}`
    case 'marker':    return `marker:${selection.marker.id}`
    case 'model':     return `model:${selection.model.id}`
    case 'polygon':   return `polygon:${selection.polygon.id}`
    case 'circle':    return `circle:${selection.circle.id}`
    case 'line':      return `line:${selection.line.id}`
    case 'image':     return `image:${selection.image.id}`
    case 'stair':     return `stair:${selection.stair.id}`
    case 'text':      return `text:${selection.label.id}`
    case 'door':      return `door:${selection.door.id}`
    // Slice 6c2: stable key per row is `entityKey` for every live kind.
    case 'asset':     return `asset:${selection.asset.entityKey}`
    case 'sensor':    return `sensor:${selection.sensor.entityKey}`
    case 'camera':    return `camera:${selection.camera.entityKey}`
    case 'shipment':  return `shipment:${selection.shipment.entityKey}`
    case 'source':    return `source:${selection.source.id}`
    case 'stream':    return `stream:${selection.stream.id}`
  }
}

export function ViewDetailPanel({ selection, onClose, onFlyTo, onDirectionsFromHere, onDirectionsToHere }: ViewDetailPanelProps) {
  // Pull bins from the spatial store so a shape's linked rich content
  // (status chip, media, link tiles, primary fields, custom attributes)
  // surfaces in the panel — same data the editor's hover tooltip uses.
  // In token-mode the store isn't hydrated, so this returns an empty
  // array and the panel quietly falls back to the basic shape facts.
  const { data: storeBins } = useSpatialBins()
  const bins = storeBins ?? []
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const [actionFeedback, setActionFeedback] = useState<string | null>(null)
  // Bottom-sheet stop. Starts at "half" because the panel opens in
  // response to a tap so the user expects an immediate informative
  // surface — not a peek they have to grow themselves.
  const [sheetStop, setSheetStop] = useState<SheetStop>('half')
  // Touch drag — track the start Y and the pixel offset so the sheet
  // follows the finger before snapping to the nearest stop on release.
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  // Reset stop each time a new POI is selected.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSheetStop('half')
    setDragOffset(0)
  }, [getSelectionKey(selection)])

  if (!selection) return null

  const title = selectionTitle(selection, t)
  const subtitle = selectionSubtitle(selection, t)

  const flashFeedback = (msg: string) => {
    setActionFeedback(msg)
    window.setTimeout(() => setActionFeedback(null), 1400)
  }

  const handleCopyId = () => {
    let id: string | number | undefined
    switch (selection.kind) {
      case 'grid-cell': id = selection.grid.id; break
      case 'marker':    id = selection.marker.id; break
      case 'model':     id = selection.model.id; break
      case 'polygon':   id = selection.polygon.id; break
      case 'circle':    id = selection.circle.id; break
      case 'line':      id = selection.line.id; break
      case 'image':     id = selection.image.id; break
      case 'stair':     id = selection.stair.id; break
      case 'text':      id = selection.label.id; break
      case 'door':      id = selection.door.id; break
      // Slice 6c2: copy the publisher-stable entityKey.
      case 'asset':     id = selection.asset.entityKey; break
      case 'sensor':    id = selection.sensor.entityKey; break
      case 'camera':    id = selection.camera.entityKey; break
      case 'shipment':  id = selection.shipment.entityKey; break
      case 'source':    id = selection.source.id; break
      case 'stream':    id = selection.stream.id; break
    }
    if (id !== undefined) {
      void navigator.clipboard.writeText(String(id))
      flashFeedback(t('view.detail.idCopied', { defaultValue: 'ID copied' }))
    }
  }

  const handleShare = () => {
    void navigator.clipboard.writeText(window.location.href)
    flashFeedback(t('view.detail.linkCopied', { defaultValue: 'Deep link copied' }))
  }

  // Project a selection into a `(kind, shapeId)` pair the indoor nav
  // graph can resolve. Bins / live entities don't have stable nav nodes
  // yet — they return null and the routing buttons are suppressed.
  const navAnchor = ((): { kind: 'polygon' | 'door' | 'stair' | 'marker'; shapeId: number } | null => {
    if (!selection) return null
    switch (selection.kind) {
      case 'polygon': return selection.polygon.id !== undefined ? { kind: 'polygon', shapeId: selection.polygon.id } : null
      case 'door':    return selection.door.id !== undefined ? { kind: 'door', shapeId: selection.door.id } : null
      case 'stair':   return selection.stair.id !== undefined ? { kind: 'stair', shapeId: selection.stair.id } : null
      case 'marker':  return selection.marker.id !== undefined ? { kind: 'marker', shapeId: selection.marker.id } : null
      default: return null
    }
  })()

  const handleDirections = () => {
    // Treat the primary "Directions to here" CTA as the most common
    // routing intent: set this POI as the destination. The detail
    // panel doesn't know where the user currently is, so picking the
    // source is delegated to the parent's flow (it'll prompt or seed
    // a default in `onDirectionsToHere`).
    if (navAnchor && onDirectionsToHere) {
      onDirectionsToHere(navAnchor.kind, navAnchor.shapeId)
      flashFeedback(t('view.detail.directionsSet', { defaultValue: 'Destination set' }))
      return
    }
    // Fallback for selections without a nav node — copy a deep link.
    void navigator.clipboard.writeText(window.location.href)
    flashFeedback(t('view.detail.directionsCopied', { defaultValue: 'Directions link copied' }))
  }

  const handleDirectionsFrom = () => {
    if (!navAnchor || !onDirectionsFromHere) return
    onDirectionsFromHere(navAnchor.kind, navAnchor.shapeId)
    flashFeedback(t('view.detail.directionsFromSet', { defaultValue: 'Origin set' }))
  }

  // Mobile bottom-sheet height honours the active stop minus any
  // in-flight drag offset (positive = dragged down → shorter sheet).
  const sheetHeight = isMobile
    ? `calc(${SHEET_HEIGHTS[sheetStop]} - ${dragOffset}px)`
    : undefined

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isMobile) return
    dragRef.current = {
      startY: e.touches[0].clientY,
      startHeight: window.innerHeight, // we measure delta only
    }
  }
  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isMobile || !dragRef.current) return
    setDragOffset(e.touches[0].clientY - dragRef.current.startY)
  }
  const handleTouchEnd = () => {
    if (!isMobile || !dragRef.current) return
    const delta = dragOffset
    dragRef.current = null
    setDragOffset(0)
    // 60px threshold per direction matches iOS bottom-sheet feel.
    if (delta > 60) setSheetStop((s) => (s === 'full' ? 'half' : s === 'half' ? 'peek' : 'peek'))
    else if (delta < -60) setSheetStop((s) => (s === 'peek' ? 'half' : s === 'half' ? 'full' : 'full'))
  }

  return (
    <aside
      className={
        isMobile
          ? 'fixed inset-x-0 bottom-0 z-30 flex flex-col bg-card/95 backdrop-blur border-t shadow-2xl rounded-t-xl transition-[height] duration-200 ease-out'
          : 'fixed top-12 end-3 bottom-3 z-30 w-80 max-w-[calc(100vw-1.5rem)] flex flex-col bg-card/95 backdrop-blur border rounded-md shadow-lg'
      }
      style={sheetHeight ? { height: sheetHeight } : undefined}
      aria-label={t('view.detail.title', { defaultValue: 'Details' })}
    >
      {isMobile && (
        <button
          type="button"
          onClick={() => setSheetStop(NEXT_STOP[sheetStop])}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          aria-label={t('view.detail.expandSheet', { defaultValue: 'Adjust panel height' })}
          className="flex items-center justify-center h-6 -mt-0.5 group cursor-grab active:cursor-grabbing"
        >
          <span className="w-10 h-1 rounded-full bg-muted-foreground/30 group-hover:bg-muted-foreground/60 transition-colors" />
        </button>
      )}
      <div className="flex items-start justify-between gap-2 px-3 py-2.5 border-b">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <HeaderIcon selection={selection} />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold leading-tight truncate">{title}</span>
            <span className="text-[11px] text-muted-foreground leading-tight truncate">{subtitle}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('view.detail.close', { defaultValue: 'Close details' })}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-2">
        <DetailBody selection={selection} bins={bins} t={t} />
      </div>

      <div className="flex flex-col gap-1.5 px-2.5 py-2 border-t">
        <button
          type="button"
          onClick={handleDirections}
          className="flex items-center justify-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Navigation className="w-3.5 h-3.5" />
          {t('view.detail.directions', { defaultValue: 'Directions to here' })}
        </button>
        {navAnchor && onDirectionsFromHere && (
          <button
            type="button"
            onClick={handleDirectionsFrom}
            className="flex items-center justify-center gap-1.5 h-7 px-3 text-xs rounded-md border bg-card hover:bg-muted/60"
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
            {t('view.detail.directionsFrom', { defaultValue: 'Directions from here' })}
          </button>
        )}
        <div className="flex items-center gap-1.5">
          {onFlyTo && (
            <button
              type="button"
              onClick={onFlyTo}
              className="flex-1 flex items-center justify-center gap-1 h-7 px-2 text-xs rounded-md border bg-card hover:bg-muted/60"
            >
              <ArrowUpRight className="w-3 h-3" />
              {t('view.detail.flyTo', { defaultValue: 'Fly to' })}
            </button>
          )}
          <button
            type="button"
            onClick={handleCopyId}
            className="flex-1 flex items-center justify-center gap-1 h-7 px-2 text-xs rounded-md border bg-card hover:bg-muted/60"
          >
            <Copy className="w-3 h-3" />
            {t('view.detail.copyId', { defaultValue: 'Copy ID' })}
          </button>
          <button
            type="button"
            onClick={handleShare}
            className="flex-1 flex items-center justify-center gap-1 h-7 px-2 text-xs rounded-md border bg-card hover:bg-muted/60"
          >
            <Share2 className="w-3 h-3" />
            {t('view.detail.share', { defaultValue: 'Share' })}
          </button>
        </div>
        {actionFeedback && (
          <div className="text-[10px] text-muted-foreground text-center pt-0.5">
            {actionFeedback}
          </div>
        )}
      </div>
    </aside>
  )
}
