import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Boxes,
  Circle as CircleIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Database,
  Layers,
  MapPin,
  Minus,
  Navigation,
  Package,
  Pentagon,
  Radio,
  Search as SearchIcon,
  Share2,
  Truck,
  TrendingUp,
  Video,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Bin, DataSource, Grid, Stream } from '@/lib/db'
// Slice 6c2 of the data-link refactor collapsed Asset / Sensor / Camera /
// Shipment into one generic `entity_states` row shape stamped with the
// parent stream's `entityType`. The sidebar filters by that field for
// grouping instead of keeping four separately-typed props.
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
import type { DetailSelection } from '@/components/view/view-detail-panel'
import { hasAnyContent } from '@/lib/rich-data'
import { BinPopupContent } from '@/components/bin-popup-content'
import { useSpatialBins } from '@/hooks/useSpatialShapes'

type CategoryFilter =
  | 'all'
  // Integration data — the user explicitly asked for these to be the
  // primary surface in Browse mode.
  | 'linked'
  | 'asset'
  | 'sensor'
  | 'camera'
  | 'shipment'
  | 'source'
  | 'stream'
  // Geometry shapes — kept as opt-in filters but no longer flood the
  // default "All" view because warehouses with hundreds of rooms (each
  // a polygon) buried the actual integration data.
  | 'rack'
  | 'bin'
  | 'marker'
  | 'model'
  | 'polygon'
  | 'circle'
  | 'line'
  | 'stair'
  | 'door'
  | 'text'
  | 'image'
type Tab = 'browse' | 'details'

export interface ViewSidebarPick {
  kind:
    | 'rack'
    | 'bin'
    | 'marker'
    | 'model'
    | 'polygon'
    | 'circle'
    | 'line'
    | 'stair'
    | 'door'
    | 'text'
    | 'image'
    | 'asset'
    | 'sensor'
    | 'camera'
    | 'shipment'
    | 'source'
    | 'stream'
  grid?: Grid
  bin?: Bin
  parentGrid?: Grid
  marker?: MarkerShape
  model?: ModelShape
  polygon?: PolygonShape
  circle?: CircleShape
  line?: LineShape
  stair?: StairShape
  door?: DoorShape
  text?: TextLabelShape
  image?: ImageShape
  // Slice 6c2: unified live-record shape. `entityType` on each row
  // discriminates which grouping the row belongs to.
  asset?: EntityStateWithStream
  sensor?: EntityStateWithStream
  camera?: EntityStateWithStream
  shipment?: EntityStateWithStream
  source?: DataSource
  stream?: Stream
}

/**
 * Per-data-integration roll-up surfaced at the top of Browse mode.
 * Each count comes from the same live-data feed the corresponding
 * overlay renders (asset stream / sensor stream / RFID / shipment /
 * camera / rules). The viewer lifts these into one summary so a user
 * can see at a glance how much data is flowing into the map — and
 * how many shapes are linked to bin rows (Upload file / REST source /
 * Webhook → bin-attached custom properties). `null` on any field
 * hides that pill (lets us add or remove integrations without forcing
 * the host to wire empty counts).
 */
export interface IntegrationCounts {
  /** Bins with non-trivial linked data — covers Upload file / REST / Webhook fed shapes. */
  linkedShapes?: number | null
  assets?: number | null
  sensors?: number | null
  cameras?: number | null
  shipments?: number | null
  rules?: number | null
}

interface ViewSidebarProps {
  collapsed: boolean
  onToggleCollapsed: () => void
  grids: Grid[]
  bins: Bin[]
  markers: MarkerShape[]
  models: ModelShape[]
  /** v2: extended catalog — every shape kind from the editor. */
  polygons?: PolygonShape[]
  circles?: CircleShape[]
  lines?: LineShape[]
  stairs?: StairShape[]
  doors?: DoorShape[]
  textLabels?: TextLabelShape[]
  images?: ImageShape[]
  /**
   * Live integration data — same arrays the live overlays render from.
   * Surfacing them here lets the sidebar list the actual integration
   * records (forklift A123, sensor temp-04, camera cam-12, shipment
   * SH-9081) as the primary content of Browse mode, instead of forcing
   * the user to wade through hundreds of rooms (polygons) and doors.
   * Clicking a row flies to the record + opens it in the detail panel.
   */
  // Slice 6c2: same-shape row for every live-record kind. Consumers
  // filter by `entityType` to build per-kind groupings.
  assets?: EntityStateWithStream[]
  sensors?: EntityStateWithStream[]
  cameras?: EntityStateWithStream[]
  shipments?: EntityStateWithStream[]
  /**
   * Configured integration sources (the things the user wired up in
   * /integrations — Upload file, REST source, Webhook, asset stream,
   * sensor stream, RFID stream, shipment stream, camera stream). The
   * sidebar lists each one as its own row so the user can see "yes
   * the warehouse has an X integration and it last ran at Y" without
   * leaving the viewer.
   */
  dataSources?: DataSource[]
  /**
   * Active stream subscriptions, scoped to a connection. Surfaces
   * which feeds are actually pushing right now alongside the static
   * source definitions above.
   */
  streams?: Stream[]
  /**
   * Live-data + linked-data counts that drive the integration summary
   * pills at the top of Browse mode. Optional so older callers (and
   * token-mode visitors with no live feed) collapse to a no-op.
   */
  integrationCounts?: IntegrationCounts
  selection: DetailSelection | null
  onCloseSelection: () => void
  onPick: (pick: ViewSidebarPick) => void
  onFlyToSelection: () => void
  /** Used to namespace recents in localStorage. */
  warehouseId?: string
  /** Indoor-navigation hooks. When supplied, the sidebar surfaces
   *  "Directions from here" / "Directions to here" CTAs on nav-graph-
   *  eligible selections (polygon, door, stair, marker). */
  onDirectionsFromHere?: (kind: 'polygon' | 'door' | 'stair' | 'marker', shapeId: number) => void
  onDirectionsToHere?: (kind: 'polygon' | 'door' | 'stair' | 'marker', shapeId: number) => void
}

const RECENT_LIMIT = 6
const RECENT_LS_PREFIX = 'viewerSearchRecents:'

interface RecentEntry {
  kind: ViewSidebarPick['kind']
  ref: string
  name: string
  subtitle?: string
  ts: number
}

/**
 * Slice 6c2 — safe reader for entity_states `payload` fields. The
 * publisher's raw JSON lands in `payload` typed as
 * `Record<string, unknown>`, so accessing a display field goes through
 * a narrowing helper. Returns undefined for anything non-string so the
 * caller can `??`-fall-back to a stable default (usually `entityKey`).
 */
function payloadString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function scoreMatch(haystack: string | undefined, q: string): number {
  if (!haystack) return 0
  const h = haystack.toLowerCase()
  const idx = h.indexOf(q)
  if (idx < 0) return 0
  if (h === q) return 1
  if (idx === 0) return 0.85
  const prev = h[idx - 1]
  if (prev === ' ' || prev === '-' || prev === '_' || prev === '/') return 0.7
  return 0.5
}

function loadRecents(warehouseId: string | undefined): RecentEntry[] {
  if (!warehouseId || typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENT_LS_PREFIX + warehouseId)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

function saveRecents(warehouseId: string | undefined, entries: RecentEntry[]): void {
  if (!warehouseId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      RECENT_LS_PREFIX + warehouseId,
      JSON.stringify(entries.slice(0, RECENT_LIMIT)),
    )
  } catch {
    /* private-mode storage block — ignore */
  }
}

/**
 * Aisles are infrastructure, not navigable POIs — they pad out the
 * sidebar list without offering any useful click destination (the user
 * doesn't want to "go to the aisle", they want to walk through it).
 * The discriminator is loose because imports come from a few different
 * paths: a polygon can carry an explicit `role` field, while imported
 * GeoJSON aisles land with `name` containing "aisle". Either signal
 * suppresses the row.
 */
function isAisleShape(s: { name?: string; role?: string }): boolean {
  if (s.role && s.role.toLowerCase() === 'aisle') return true
  if (s.name && /\baisle\b/i.test(s.name)) return true
  return false
}

/**
 * Project a viewer selection into a `(kind, shapeId)` pair the indoor
 * navigation graph can resolve. Used by the directions CTAs in the
 * detail view. Selections that don't have a corresponding nav node
 * (bin, sensor, asset, …) return null and the buttons are suppressed.
 */
function navAnchorFor(
  s: DetailSelection | null,
): { kind: 'polygon' | 'door' | 'stair' | 'marker'; shapeId: number } | null {
  if (!s) return null
  switch (s.kind) {
    case 'polygon': return s.polygon.id !== undefined ? { kind: 'polygon', shapeId: s.polygon.id } : null
    case 'door':    return s.door.id !== undefined ? { kind: 'door', shapeId: s.door.id } : null
    case 'stair':   return s.stair.id !== undefined ? { kind: 'stair', shapeId: s.stair.id } : null
    case 'marker':  return s.marker.id !== undefined ? { kind: 'marker', shapeId: s.marker.id } : null
    default: return null
  }
}

function KindIcon({ kind, size = 14 }: { kind: ViewSidebarPick['kind'] | DetailSelection['kind']; size?: number }) {
  const px = `${size}px`
  const style = { width: px, height: px } as const
  const cls = 'flex-shrink-0'
  switch (kind) {
    case 'rack':
    case 'grid-cell': return <Layers className={cls} style={style} />
    case 'bin':       return <Package className={cls} style={style} />
    case 'marker':    return <MapPin className={cls} style={style} />
    case 'model':     return <Boxes className={cls} style={style} />
    case 'polygon':   return <Pentagon className={cls} style={style} />
    case 'circle':    return <CircleIcon className={cls} style={style} />
    case 'line':      return <Minus className={cls} style={style} />
    case 'stair':     return <TrendingUp className={cls} style={style} />
    case 'door':      return <ArrowUpRight className={cls} style={style} />
    case 'text':      return <Layers className={cls} style={style} />
    case 'image':     return <Layers className={cls} style={style} />
    case 'asset':     return <Package className={cls + ' text-orange-500'} style={style} />
    case 'sensor':    return <Activity className={cls + ' text-emerald-500'} style={style} />
    case 'camera':    return <Video className={cls + ' text-blue-500'} style={style} />
    case 'shipment':  return <Truck className={cls + ' text-amber-500'} style={style} />
    case 'source':    return <Database className={cls + ' text-indigo-500'} style={style} />
    case 'stream':    return <Radio className={cls + ' text-emerald-500'} style={style} />
    default:          return <MapPin className={cls} style={style} />
  }
}

function selectionTitle(s: DetailSelection, t: ReturnType<typeof useTranslation>['t']): string {
  switch (s.kind) {
    case 'grid-cell': return s.grid.name || t('view.detail.unnamedRack', { defaultValue: 'Unnamed rack' })
    case 'marker':    return s.marker.name || t('view.detail.unnamedMarker', { defaultValue: 'Marker' })
    case 'model':     return s.model.name || t('view.detail.unnamedModel', { defaultValue: '3D model' })
    case 'polygon':   return s.polygon.name || t('view.detail.unnamedPolygon', { defaultValue: 'Polygon' })
    case 'circle':    return s.circle.name || t('view.detail.unnamedCircle', { defaultValue: 'Circle' })
    case 'line':      return s.line.name || t('view.detail.unnamedLine', { defaultValue: 'Line' })
    case 'image':     return s.image.name || t('view.detail.unnamedImage', { defaultValue: 'Floor plan' })
    case 'stair':     return s.stair.name || t('view.detail.unnamedStair', { defaultValue: 'Stair' })
    case 'text':      return s.label.config?.text || s.label.name || t('view.detail.unnamedLabel', { defaultValue: 'Text label' })
    case 'door':      return s.door.name || t('view.detail.unnamedDoor', { defaultValue: 'Door' })
    // Slice 6c2: live records now key off `payload.label` (publisher-
    // stamped display name) with `entityKey` as the last-resort ID.
    case 'asset':     return payloadString(s.asset.payload.label) ?? s.asset.entityKey
    case 'sensor':    return payloadString(s.sensor.payload.label) ?? s.sensor.entityKey
    case 'camera':    return payloadString(s.camera.payload.label) ?? s.camera.entityKey
    case 'shipment':  return payloadString(s.shipment.payload.label) ?? s.shipment.entityKey
    case 'source':    return s.source.name
    case 'stream':    return s.stream.name || s.stream.entityType || `Stream #${s.stream.id}`
  }
}

function selectionSubtitle(s: DetailSelection, t: ReturnType<typeof useTranslation>['t']): string {
  switch (s.kind) {
    case 'grid-cell': return t('view.detail.cellSubtitle', { row: s.row, col: s.col, level: s.level, defaultValue: `Cell ${s.row},${s.col} · Level ${s.level}` })
    case 'marker':    return t('view.detail.markerSubtitle', { defaultValue: 'Marker' })
    case 'model':     return t('view.detail.modelSubtitle', { defaultValue: '3D model' })
    case 'polygon':   return t('view.detail.polygonSubtitle', { defaultValue: 'Polygon' })
    case 'circle':    return t('view.detail.circleSubtitle', { defaultValue: 'Circle' })
    case 'line':      return t('view.detail.lineSubtitle', { defaultValue: 'Line' })
    case 'image':     return t('view.detail.imageSubtitle', { defaultValue: 'Floor plan' })
    case 'stair':     return t('view.detail.stairSubtitle', { defaultValue: 'Stair' })
    case 'text':      return t('view.detail.textSubtitle', { defaultValue: 'Text label' })
    case 'door':      return t('view.detail.doorSubtitle', { defaultValue: 'Door' })
    // Slice 6c2: subtitle text pulls from the generic payload with a
    // per-kind fallback string.
    case 'asset':     return payloadString(s.asset.payload.type) ?? t('view.detail.assetSubtitle', { defaultValue: 'Asset' })
    case 'sensor':    return payloadString(s.sensor.payload.kind) ?? t('view.detail.sensorSubtitle', { defaultValue: 'Sensor' })
    case 'camera':    return payloadString(s.camera.payload.kind) ?? t('view.detail.cameraSubtitle', { defaultValue: 'Camera' })
    case 'shipment':  return payloadString(s.shipment.payload.state) ?? t('view.detail.shipmentSubtitle', { defaultValue: 'Shipment' })
    case 'source':    return `${s.source.kind} · ${s.source.schedule ?? 'manual'}`
    case 'stream':    return s.stream.entityType ?? t('view.detail.streamSubtitle', { defaultValue: 'Stream' })
  }
}

/**
 * The viewer's single information surface. Sits on the right edge of
 * the screen as a fixed-width panel and shifts state between Browse,
 * Search results, and Detail views. Mappedin / MapsIndoors keep this
 * panel persistent because that's where guests discover what's around.
 */
export function ViewSidebar({
  collapsed,
  onToggleCollapsed,
  grids,
  bins,
  markers,
  models,
  polygons = [],
  circles = [],
  lines = [],
  stairs = [],
  doors = [],
  textLabels = [],
  images = [],
  assets = [],
  sensors = [],
  cameras = [],
  shipments = [],
  dataSources = [],
  streams = [],
  integrationCounts,
  selection,
  onCloseSelection,
  onPick,
  onFlyToSelection,
  warehouseId,
  onDirectionsFromHere,
  onDirectionsToHere,
}: ViewSidebarProps) {
  const { t } = useTranslation()
  // Pull bins from the spatial store so the Detail tab can resolve a
  // selected shape (polygon / circle / line / marker / image / model)
  // to its linked Bin row and render the SAME rich BinPopupContent
  // the editor's MapShapeTooltip renders on hover. The bins prop
  // above is the floor-filtered list used for the bin browse mode —
  // store bins are unfiltered so a polygon's data shows up even when
  // viewed from a different floor.
  const { data: storeBinsAll } = useSpatialBins()
  const storeBins = storeBinsAll ?? []
  const [tab, setTab] = useState<Tab>('browse')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [recents, setRecents] = useState<RecentEntry[]>(() => loadRecents(warehouseId))
  const [actionFeedback, setActionFeedback] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecents(loadRecents(warehouseId))
  }, [warehouseId])

  // When a POI gets selected externally (map click), switch to details.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selection) setTab('details')
  }, [selection])

  // Cmd/Ctrl+K and `/` focus search and ensure sidebar is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        if (collapsed) onToggleCollapsed()
        setTab('browse')
        queueMicrotask(() => inputRef.current?.focus())
        return
      }
      if (!inField && e.key === '/') {
        e.preventDefault()
        if (collapsed) onToggleCollapsed()
        setTab('browse')
        queueMicrotask(() => inputRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [collapsed, onToggleCollapsed])

  const gridById = useMemo(() => {
    const m = new Map<number, Grid>()
    for (const g of grids) if (g.id !== undefined) m.set(g.id, g)
    return m
  }, [grids])

  interface ResultRow {
    key: string
    kind: ViewSidebarPick['kind']
    name: string
    subtitle?: string
    score: number
    pick: ViewSidebarPick
  }

  // Lookup: shapeId → polygon name + role. Used to attach a "where"
  // subtitle to bin / asset / sensor rows so the user can tell which
  // room a record lives in. Cheap (one pass over polygons per data
  // change) so we don't need to gate it on filter mode.
  const polygonById = useMemo(() => {
    const m = new Map<number, PolygonShape>()
    for (const p of polygons) if (p.id !== undefined) m.set(p.id, p)
    return m
  }, [polygons])

  const q = query.trim().toLowerCase()

  /**
   * Bins with linked content from Upload / REST / Webhook sources.
   * These are the "real data" shapes the user wants to see first —
   * everything else (raw rooms with no data, doors, text labels)
   * goes behind explicit category filters now.
   */
  const linkedShapeRows = useMemo<ResultRow[]>(() => {
    const out: ResultRow[] = []
    for (const b of bins) {
      if (b.targetKind === 'grid-cell') continue
      if (b.shapeId === undefined) continue
      if (!hasAnyContent(b)) continue
      const shapeName =
        b.targetKind === 'polygon' ? polygonById.get(b.shapeId)?.name
        : undefined
      const baseName = b.sku || b.externalCode || shapeName || `${b.targetKind} #${b.shapeId}`
      const haystack = `${baseName} ${b.notes ?? ''} ${b.sku ?? ''} ${b.externalCode ?? ''}`
      const score = q.length > 0 ? scoreMatch(haystack, q) : 0.95
      if (q.length > 0 && score === 0) continue
      // Build the pick — route to the underlying shape so the existing
      // detail panel + map-fly machinery handles it.
      let pick: ViewSidebarPick | null = null
      if (b.targetKind === 'polygon') {
        const p = polygonById.get(b.shapeId)
        if (!p) continue
        pick = { kind: 'polygon', polygon: p }
      } else if (b.targetKind === 'marker') {
        const mk = markers.find((x) => x.id === b.shapeId)
        if (!mk) continue
        pick = { kind: 'marker', marker: mk }
      } else if (b.targetKind === 'circle') {
        const c = circles.find((x) => x.id === b.shapeId)
        if (!c) continue
        pick = { kind: 'circle', circle: c }
      } else if (b.targetKind === 'line') {
        const ln = lines.find((x) => x.id === b.shapeId)
        if (!ln) continue
        pick = { kind: 'line', line: ln }
      } else if (b.targetKind === 'model') {
        const mo = models.find((x) => x.id === b.shapeId)
        if (!mo) continue
        pick = { kind: 'model', model: mo }
      } else if (b.targetKind === 'image') {
        const ig = images.find((x) => x.id === b.shapeId)
        if (!ig) continue
        pick = { kind: 'image', image: ig }
      }
      if (!pick) continue
      const subtitle = [
        b.status,
        shapeName && b.targetKind === 'polygon' ? null : shapeName,
        b.lastSyncedAt ? `synced ${new Date(b.lastSyncedAt).toLocaleTimeString()}` : null,
      ].filter(Boolean).join(' · ') || t('view.search.linkedSubtitle', { defaultValue: 'Linked data' })
      out.push({
        key: `linked:${b.targetKind}:${b.shapeId}:${b.id}`,
        kind: pick.kind,
        name: baseName,
        subtitle,
        score,
        pick,
      })
    }
    return out
  }, [bins, polygonById, markers, circles, lines, models, images, q, t])

  const results = useMemo<ResultRow[]>(() => {
    const out: ResultRow[] = []
    // ---- Integration data — surfaced first because the user wants the
    // sidebar to be a window onto LIVE INTEGRATION RECORDS, not the
    // raw geometric scaffolding (polygons, doors, labels). Each section
    // honours the active filter so picking a chip narrows the list.
    if (filter === 'all' || filter === 'linked') {
      for (const row of linkedShapeRows) out.push(row)
    }
    // Slice 6c2: the four live-record groupings share a single row
    // shape. The search haystack + subtitle pull from
    // `payload.<field>` with narrowing helpers so bad payloads collapse
    // cleanly instead of throwing at render time.
    if (filter === 'all' || filter === 'asset') {
      for (const a of assets) {
        const label = payloadString(a.payload.label)
        const type = payloadString(a.payload.type)
        const status = payloadString(a.payload.status)
        const haystack = `${label ?? ''} ${a.entityKey} ${type ?? ''} ${status ?? ''}`
        const score = q.length > 0 ? scoreMatch(haystack, q) : 0.9
        if (q.length > 0 && score === 0) continue
        // eslint-disable-next-line react-hooks/purity -- staleness is recomputed on every render by design
        const stale = Date.now() - a.lastSeenAt.getTime() > 30_000
        const subtitle = [
          type,
          status,
          stale
            ? t('view.search.assetStale', { defaultValue: 'stale' })
            : t('view.search.assetLive', { defaultValue: 'live' }),
        ].filter(Boolean).join(' · ')
        out.push({
          key: `asset:${a.entityKey}`,
          kind: 'asset',
          name: label || a.entityKey,
          subtitle,
          score,
          pick: { kind: 'asset', asset: a },
        })
      }
    }
    if (filter === 'all' || filter === 'sensor') {
      for (const s of sensors) {
        const label = payloadString(s.payload.label)
        const kind = payloadString(s.payload.kind)
        const lastValue = typeof s.payload.value === 'number' ? s.payload.value : undefined
        const unit = payloadString(s.payload.unit) ?? ''
        const haystack = `${label ?? ''} ${s.entityKey} ${kind ?? ''}`
        const score = q.length > 0 ? scoreMatch(haystack, q) : 0.85
        if (q.length > 0 && score === 0) continue
        const value = lastValue !== undefined
          ? `${lastValue.toFixed(2)}${unit ? ` ${unit}` : ''}`
          : t('view.search.sensorNoReading', { defaultValue: 'No reading' })
        const subtitle = [kind, value].filter(Boolean).join(' · ')
        out.push({
          key: `sensor:${s.entityKey}`,
          kind: 'sensor',
          name: label || s.entityKey,
          subtitle,
          score,
          pick: { kind: 'sensor', sensor: s },
        })
      }
    }
    if (filter === 'all' || filter === 'camera') {
      for (const c of cameras) {
        const label = payloadString(c.payload.label)
        const kind = payloadString(c.payload.kind)
        const haystack = `${label ?? ''} ${c.entityKey} ${kind ?? ''}`
        const score = q.length > 0 ? scoreMatch(haystack, q) : 0.8
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `camera:${c.entityKey}`,
          kind: 'camera',
          name: label || c.entityKey,
          subtitle: kind || t('view.search.cameraSubtitle', { defaultValue: 'Camera' }),
          score,
          pick: { kind: 'camera', camera: c },
        })
      }
    }
    if (filter === 'all' || filter === 'shipment') {
      for (const sh of shipments) {
        const label = payloadString(sh.payload.label)
        const state = payloadString(sh.payload.state) ?? ''
        const carrier = payloadString(sh.payload.carrier)
        const haystack = `${label ?? ''} ${sh.entityKey} ${carrier ?? ''} ${state}`
        const score = q.length > 0 ? scoreMatch(haystack, q) : 0.75
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `shipment:${sh.entityKey}`,
          kind: 'shipment',
          name: label || sh.entityKey,
          subtitle: [state, carrier].filter(Boolean).join(' · '),
          score,
          pick: { kind: 'shipment', shipment: sh },
        })
      }
    }
    // Configured integration sources — Upload file / REST source /
    // Webhook entries the user wired up in /integrations. These are
    // the integrations THEMSELVES (the "where the data comes from"
    // rows), distinct from the assets / sensors / etc. those sources
    // feed. Clicking one doesn't fly the map (sources have no spatial
    // anchor) — it opens a detail panel summarising the source's
    // status, last run, and schedule.
    if (filter === 'all' || filter === 'source') {
      for (const ds of dataSources) {
        const haystack = `${ds.name} ${ds.kind}`
        const score = q.length > 0 ? scoreMatch(haystack, q) : 0.7
        if (q.length > 0 && score === 0) continue
        const subtitle = [
          ds.kind,
          ds.schedule,
          ds.lastResult,
          ds.lastRunAt
            ? `ran ${new Date(ds.lastRunAt).toLocaleTimeString()}`
            : null,
        ].filter(Boolean).join(' · ')
        out.push({
          key: `source:${ds.id}`,
          kind: 'source',
          name: ds.name,
          subtitle,
          score,
          pick: { kind: 'source', source: ds },
        })
      }
    }
    // Active stream subscriptions — asset / sensor / RFID / shipment /
    // camera streams. Each row is one feed currently pushing data into
    // the warehouse. Click to drill into the stream's status.
    if (filter === 'all' || filter === 'stream') {
      for (const s of streams) {
        const haystack = `${s.name ?? ''} ${s.entityType ?? ''} ${s.kind ?? ''}`
        const score = q.length > 0 ? scoreMatch(haystack, q) : 0.65
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `stream:${s.id}`,
          kind: 'stream',
          name: s.name || s.entityType || `Stream #${s.id}`,
          subtitle: [s.entityType, s.kind].filter(Boolean).join(' · '),
          score,
          pick: { kind: 'stream', stream: s },
        })
      }
    }
    // ---- Geometric shapes — only listed when the user explicitly asks
    // for that kind. Skipped from the default "all" view so the live
    // integration data above gets the spotlight and the sidebar isn't
    // 300 rows of "Door 1, Door 2, …" before any real data shows.
    if (filter === 'rack') {
      for (const g of grids) {
        const score = q.length > 0 ? scoreMatch(g.name, q) : 1
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `rack:${g.id}`,
          kind: 'rack',
          name: g.name || t('view.search.unnamedRack', { defaultValue: 'Unnamed rack' }),
          subtitle: t('view.search.rackSubtitle', { defaultValue: 'Rack' }),
          score,
          pick: { kind: 'rack', grid: g },
        })
      }
    }
    if (filter === 'bin') {
      for (const b of bins) {
        const score = q.length > 0
          ? Math.max(scoreMatch(b.sku, q), scoreMatch(b.externalCode, q), scoreMatch(b.notes, q))
          : 0.8
        if (q.length > 0 && score === 0) continue
        const parent = b.gridId !== undefined ? gridById.get(b.gridId) : undefined
        const where = parent
          ? `${parent.name || 'Rack'} · ${b.row},${b.col}`
          : t('view.search.binSubtitle', { defaultValue: 'Bin' })
        out.push({
          key: `bin:${b.id}`,
          kind: 'bin',
          name: b.sku || b.externalCode || t('view.search.unnamedBin', { defaultValue: 'Bin' }),
          subtitle: where,
          score,
          pick: { kind: 'bin', bin: b, parentGrid: parent },
        })
      }
    }
    if (filter === 'marker') {
      for (const m of markers) {
        const score = q.length > 0 ? scoreMatch(m.name, q) : 1
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `marker:${m.id}`,
          kind: 'marker',
          name: m.name || t('view.search.unnamedMarker', { defaultValue: 'Marker' }),
          subtitle: t('view.search.markerSubtitle', { defaultValue: 'Marker' }),
          score,
          pick: { kind: 'marker', marker: m },
        })
      }
    }
    if (filter === 'model') {
      for (const m of models) {
        const score = q.length > 0 ? scoreMatch(m.name, q) : 1
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `model:${m.id}`,
          kind: 'model',
          name: m.name || t('view.search.unnamedModel', { defaultValue: '3D model' }),
          subtitle: t('view.search.modelSubtitle', { defaultValue: '3D model' }),
          score,
          pick: { kind: 'model', model: m },
        })
      }
    }
    if (filter === 'polygon') {
      for (const p of polygons) {
        if (isAisleShape(p)) continue
        const score = q.length > 0 ? scoreMatch(p.name, q) : 1
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `polygon:${p.id}`,
          kind: 'polygon',
          name: p.name || t('view.search.unnamedPolygon', { defaultValue: 'Polygon' }),
          subtitle: p.role || t('view.search.polygonSubtitle', { defaultValue: 'Polygon' }),
          score,
          pick: { kind: 'polygon', polygon: p },
        })
      }
    }
    if (filter === 'circle') {
      for (const c of circles) {
        const score = q.length > 0 ? scoreMatch(c.name, q) : 1
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `circle:${c.id}`,
          kind: 'circle',
          name: c.name || t('view.search.unnamedCircle', { defaultValue: 'Circle' }),
          subtitle: t('view.search.circleSubtitle', { defaultValue: 'Circle' }),
          score,
          pick: { kind: 'circle', circle: c },
        })
      }
    }
    if (filter === 'line') {
      for (const l of lines) {
        if (isAisleShape(l)) continue
        const score = q.length > 0 ? scoreMatch(l.name, q) : 1
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `line:${l.id}`,
          kind: 'line',
          name: l.name || t('view.search.unnamedLine', { defaultValue: 'Line' }),
          subtitle: t('view.search.lineSubtitle', { defaultValue: 'Line' }),
          score,
          pick: { kind: 'line', line: l },
        })
      }
    }
    if (filter === 'stair') {
      for (const s of stairs) {
        const score = q.length > 0 ? scoreMatch(s.name, q) : 1
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `stair:${s.id}`,
          kind: 'stair',
          name: s.name || t('view.search.unnamedStair', { defaultValue: 'Stair' }),
          subtitle: t('view.search.stairSubtitle', { defaultValue: 'Stair' }),
          score,
          pick: { kind: 'stair', stair: s },
        })
      }
    }
    if (filter === 'door') {
      for (const d of doors) {
        const score = q.length > 0 ? scoreMatch(d.name, q) : 1
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `door:${d.id}`,
          kind: 'door',
          name: d.name || t('view.search.unnamedDoor', { defaultValue: 'Door' }),
          subtitle: t('view.search.doorSubtitle', { defaultValue: 'Door' }),
          score,
          pick: { kind: 'door', door: d },
        })
      }
    }
    if (filter === 'text') {
      for (const tl of textLabels) {
        const haystack = tl.config?.text || tl.name
        const score = q.length > 0 ? scoreMatch(haystack, q) : 1
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `text:${tl.id}`,
          kind: 'text',
          name: haystack || t('view.search.unnamedLabel', { defaultValue: 'Text label' }),
          subtitle: t('view.search.textSubtitle', { defaultValue: 'Text label' }),
          score,
          pick: { kind: 'text', text: tl },
        })
      }
    }
    if (filter === 'image') {
      for (const img of images) {
        const score = q.length > 0 ? scoreMatch(img.name, q) : 1
        if (q.length > 0 && score === 0) continue
        out.push({
          key: `image:${img.id}`,
          kind: 'image',
          name: img.name || t('view.search.unnamedImage', { defaultValue: 'Floor plan' }),
          subtitle: t('view.search.imageSubtitle', { defaultValue: 'Floor plan' }),
          score,
          pick: { kind: 'image', image: img },
        })
      }
    }
    // ---- Generic search across geometric shapes when the user typed
    // anything and filter is 'all'. This lets a search for "AUDITORIUM"
    // still find the polygon even though we don't list polygons in the
    // default "all" feed.
    if (filter === 'all' && q.length > 0) {
      for (const p of polygons) {
        if (isAisleShape(p)) continue
        const score = scoreMatch(p.name, q)
        if (score === 0) continue
        out.push({
          key: `polygon:${p.id}`,
          kind: 'polygon',
          name: p.name || t('view.search.unnamedPolygon', { defaultValue: 'Polygon' }),
          subtitle: p.role || t('view.search.polygonSubtitle', { defaultValue: 'Polygon' }),
          score: score * 0.6, // de-prioritise vs integration matches
          pick: { kind: 'polygon', polygon: p },
        })
      }
      for (const g of grids) {
        const score = scoreMatch(g.name, q)
        if (score === 0) continue
        out.push({
          key: `rack:${g.id}`,
          kind: 'rack',
          name: g.name || t('view.search.unnamedRack', { defaultValue: 'Unnamed rack' }),
          subtitle: t('view.search.rackSubtitle', { defaultValue: 'Rack' }),
          score: score * 0.6,
          pick: { kind: 'rack', grid: g },
        })
      }
      for (const m of markers) {
        const score = scoreMatch(m.name, q)
        if (score === 0) continue
        out.push({
          key: `marker:${m.id}`,
          kind: 'marker',
          name: m.name || t('view.search.unnamedMarker', { defaultValue: 'Marker' }),
          subtitle: t('view.search.markerSubtitle', { defaultValue: 'Marker' }),
          score: score * 0.6,
          pick: { kind: 'marker', marker: m },
        })
      }
    }
    out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    return out
  }, [grids, bins, markers, models, polygons, circles, lines, stairs, doors, textLabels, images, assets, sensors, cameras, shipments, dataSources, streams, linkedShapeRows, filter, q, gridById, t])

  const counts = useMemo(() => {
    let rack = 0, bin = 0, marker = 0, model = 0
    let polygon = 0, circle = 0, line = 0, stair = 0, door = 0, text = 0, image = 0
    let linked: number
    let asset = 0, sensor = 0, camera = 0, shipment = 0
    let source = 0, stream = 0
    // Aisles are filtered out of the visible lists, so don't include
    // them in chip counts either — otherwise the user sees "Polygons (8)"
    // but only 3 rows once aisles drop out.
    const polyNonAisle = polygons.filter((p) => !isAisleShape(p))
    const lineNonAisle = lines.filter((l) => !isAisleShape(l))
    if (q.length === 0) {
      linked = linkedShapeRows.length
      asset = assets.length
      sensor = sensors.length
      camera = cameras.length
      shipment = shipments.length
      source = dataSources.length
      stream = streams.length
      rack = grids.length
      bin = bins.length
      marker = markers.length
      model = models.length
      polygon = polyNonAisle.length
      circle = circles.length
      line = lineNonAisle.length
      stair = stairs.length
      door = doors.length
      text = textLabels.length
      image = images.length
    } else {
      linked = linkedShapeRows.length
      // Slice 6c2: search count against `entityKey` + `payload.label`
      // for each live-record kind.
      for (const a of assets) if (scoreMatch(`${payloadString(a.payload.label) ?? ''} ${a.entityKey}`, q) > 0) asset++
      for (const s of sensors) if (scoreMatch(`${payloadString(s.payload.label) ?? ''} ${s.entityKey}`, q) > 0) sensor++
      for (const c of cameras) if (scoreMatch(`${payloadString(c.payload.label) ?? ''} ${c.entityKey}`, q) > 0) camera++
      for (const sh of shipments) if (scoreMatch(`${payloadString(sh.payload.label) ?? ''} ${sh.entityKey}`, q) > 0) shipment++
      for (const ds of dataSources) if (scoreMatch(`${ds.name} ${ds.kind}`, q) > 0) source++
      for (const s of streams) if (scoreMatch(`${s.name ?? ''} ${s.entityType ?? ''}`, q) > 0) stream++
      for (const g of grids) if (scoreMatch(g.name, q) > 0) rack++
      for (const b of bins) if (
        scoreMatch(b.sku, q) > 0 || scoreMatch(b.externalCode, q) > 0 || scoreMatch(b.notes, q) > 0
      ) bin++
      for (const m of markers) if (scoreMatch(m.name, q) > 0) marker++
      for (const m of models) if (scoreMatch(m.name, q) > 0) model++
      for (const p of polyNonAisle) if (scoreMatch(p.name, q) > 0) polygon++
      for (const c of circles) if (scoreMatch(c.name, q) > 0) circle++
      for (const l of lineNonAisle) if (scoreMatch(l.name, q) > 0) line++
      for (const s of stairs) if (scoreMatch(s.name, q) > 0) stair++
      for (const d of doors) if (scoreMatch(d.name, q) > 0) door++
      for (const tl of textLabels) if (scoreMatch(tl.config?.text || tl.name, q) > 0) text++
      for (const img of images) if (scoreMatch(img.name, q) > 0) image++
    }
    // The "all" count reflects the default-view content (integration
    // data + linked shapes) since that's what the All chip shows now.
    const all = linked + asset + sensor + camera + shipment + source + stream
    return { linked, asset, sensor, camera, shipment, source, stream, rack, bin, marker, model, polygon, circle, line, stair, door, text, image, all }
  }, [grids, bins, markers, models, polygons, circles, lines, stairs, doors, textLabels, images, assets, sensors, cameras, shipments, dataSources, streams, linkedShapeRows, q])

  const handlePickRow = (row: ResultRow) => {
    // Persist into recents.
    let ref = ''
    if (row.kind === 'rack') ref = String(row.pick.grid?.id ?? '')
    else if (row.kind === 'bin') ref = String(row.pick.bin?.id ?? '')
    else if (row.kind === 'marker') ref = String(row.pick.marker?.id ?? '')
    else if (row.kind === 'model') ref = String(row.pick.model?.id ?? '')
    else if (row.kind === 'polygon') ref = String(row.pick.polygon?.id ?? '')
    else if (row.kind === 'circle') ref = String(row.pick.circle?.id ?? '')
    else if (row.kind === 'line') ref = String(row.pick.line?.id ?? '')
    else if (row.kind === 'stair') ref = String(row.pick.stair?.id ?? '')
    else if (row.kind === 'door') ref = String(row.pick.door?.id ?? '')
    else if (row.kind === 'text') ref = String(row.pick.text?.id ?? '')
    else if (row.kind === 'image') ref = String(row.pick.image?.id ?? '')
    // Slice 6c2: recents key off `entityKey` for every live-record kind.
    else if (row.kind === 'asset') ref = row.pick.asset?.entityKey ?? ''
    else if (row.kind === 'sensor') ref = row.pick.sensor?.entityKey ?? ''
    else if (row.kind === 'camera') ref = row.pick.camera?.entityKey ?? ''
    else if (row.kind === 'shipment') ref = row.pick.shipment?.entityKey ?? ''
    else if (row.kind === 'source') ref = String(row.pick.source?.id ?? '')
    else if (row.kind === 'stream') ref = String(row.pick.stream?.id ?? '')
    if (ref) {
      const entry: RecentEntry = {
        kind: row.kind,
        ref,
        name: row.name,
        subtitle: row.subtitle,
        // eslint-disable-next-line react-hooks/purity -- staleness is recomputed on every render by design
        ts: Date.now(),
      }
      const dedup = recents.filter((x) => !(x.kind === entry.kind && x.ref === entry.ref))
      const next = [entry, ...dedup].slice(0, RECENT_LIMIT)
      setRecents(next)
      saveRecents(warehouseId, next)
    }
    onPick(row.pick)
    setQuery('')
  }

  const flashFeedback = (msg: string) => {
    setActionFeedback(msg)
    window.setTimeout(() => setActionFeedback(null), 1400)
  }

  const handleCopyId = () => {
    if (!selection) return
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
      // Slice 6c2: "Copy ID" copies the publisher's stable entity_key.
      case 'asset':     id = selection.asset.entityKey; break
      case 'sensor':    id = selection.sensor.entityKey; break
      case 'camera':    id = selection.camera.entityKey; break
      case 'shipment':  id = selection.shipment.entityKey; break
      case 'source':    id = selection.source.id; break
      case 'stream':    id = selection.stream.id; break
      case 'door':      id = selection.door.id; break
    }
    if (id !== undefined) {
      void navigator.clipboard.writeText(String(id))
      flashFeedback(t('view.detail.idCopied', { defaultValue: 'ID copied' }))
    }
  }

  const handleShare = () => {
    void navigator.clipboard.writeText(window.location.href)
    flashFeedback(t('view.detail.linkCopied', { defaultValue: 'Link copied' }))
  }

  // Collapsed: render a thin vertical rail with just the expand button.
  if (collapsed) {
    return (
      <aside className="hidden md:flex flex-col items-center w-10 border-s bg-card shadow-sm py-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={t('view.sidebar.expand', { defaultValue: 'Expand sidebar' })}
          className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            onToggleCollapsed()
            queueMicrotask(() => inputRef.current?.focus())
          }}
          aria-label={t('view.sidebar.openSearch', { defaultValue: 'Open search' })}
          className="mt-2 h-8 w-8 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          <SearchIcon className="w-4 h-4" />
        </button>
      </aside>
    )
  }

  return (
    <aside className="hidden md:flex flex-col w-[340px] border-s bg-card shadow-sm">
      {/* Top bar — tabs + collapse */}
      <div className="flex items-center justify-between border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { setTab('browse'); onCloseSelection() }}
            className={`px-2.5 h-7 text-xs rounded-md font-medium transition-colors ${
              tab === 'browse'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {t('view.sidebar.browse', { defaultValue: 'Browse' })}
          </button>
          {selection && (
            <button
              type="button"
              onClick={() => setTab('details')}
              className={`px-2.5 h-7 text-xs rounded-md font-medium transition-colors ${
                tab === 'details'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {t('view.sidebar.details', { defaultValue: 'Details' })}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={t('view.sidebar.collapse', { defaultValue: 'Collapse sidebar' })}
          className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {tab === 'browse' && (
        <>
          {/* Integration summary — at-a-glance counts of every live data
              integration feeding the map plus the count of shapes linked
              to bin rows (Upload file / REST source / Webhook all flow
              through bins). Hidden when every count is zero / null so
              warehouses with no integrations don't see an empty row. */}
          {integrationCounts && (
            (integrationCounts.linkedShapes ?? 0) +
              (integrationCounts.assets ?? 0) +
              (integrationCounts.sensors ?? 0) +
              (integrationCounts.cameras ?? 0) +
              (integrationCounts.shipments ?? 0) +
              (integrationCounts.rules ?? 0) >
              0
          ) ? (
            <div className="flex items-center gap-1.5 px-3 py-2 border-b overflow-x-auto bg-muted/30">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex-shrink-0 me-1">
                {t('view.sidebar.integrations', { defaultValue: 'Integrations' })}
              </span>
              {integrationCounts.linkedShapes !== undefined &&
                integrationCounts.linkedShapes !== null &&
                integrationCounts.linkedShapes > 0 && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 h-5 rounded-md border bg-card text-[10px] flex-shrink-0"
                    title={t('view.sidebar.linkedShapesHelp', {
                      defaultValue:
                        'Shapes carrying data from Upload / REST / Webhook sources',
                    })}
                  >
                    <Database className="w-3 h-3 text-indigo-500" />
                    <span className="font-medium tabular-nums">
                      {integrationCounts.linkedShapes}
                    </span>
                    <span className="text-muted-foreground">
                      {t('view.sidebar.linkedShapes', { defaultValue: 'linked' })}
                    </span>
                  </span>
                )}
              {integrationCounts.assets !== undefined &&
                integrationCounts.assets !== null &&
                integrationCounts.assets > 0 && (
                  <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-md border bg-card text-[10px] flex-shrink-0">
                    <Package className="w-3 h-3 text-orange-500" />
                    <span className="font-medium tabular-nums">{integrationCounts.assets}</span>
                    <span className="text-muted-foreground">
                      {t('view.sidebar.assets', { defaultValue: 'assets' })}
                    </span>
                  </span>
                )}
              {integrationCounts.sensors !== undefined &&
                integrationCounts.sensors !== null &&
                integrationCounts.sensors > 0 && (
                  <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-md border bg-card text-[10px] flex-shrink-0">
                    <Activity className="w-3 h-3 text-emerald-500" />
                    <span className="font-medium tabular-nums">{integrationCounts.sensors}</span>
                    <span className="text-muted-foreground">
                      {t('view.sidebar.sensors', { defaultValue: 'sensors' })}
                    </span>
                  </span>
                )}
              {integrationCounts.cameras !== undefined &&
                integrationCounts.cameras !== null &&
                integrationCounts.cameras > 0 && (
                  <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-md border bg-card text-[10px] flex-shrink-0">
                    <Video className="w-3 h-3 text-blue-500" />
                    <span className="font-medium tabular-nums">{integrationCounts.cameras}</span>
                    <span className="text-muted-foreground">
                      {t('view.sidebar.cameras', { defaultValue: 'cameras' })}
                    </span>
                  </span>
                )}
              {integrationCounts.shipments !== undefined &&
                integrationCounts.shipments !== null &&
                integrationCounts.shipments > 0 && (
                  <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-md border bg-card text-[10px] flex-shrink-0">
                    <Truck className="w-3 h-3 text-amber-500" />
                    <span className="font-medium tabular-nums">{integrationCounts.shipments}</span>
                    <span className="text-muted-foreground">
                      {t('view.sidebar.shipments', { defaultValue: 'shipments' })}
                    </span>
                  </span>
                )}
              {integrationCounts.rules !== undefined &&
                integrationCounts.rules !== null &&
                integrationCounts.rules > 0 && (
                  <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-md border bg-card text-[10px] flex-shrink-0">
                    <Zap className="w-3 h-3 text-yellow-500" />
                    <span className="font-medium tabular-nums">{integrationCounts.rules}</span>
                    <span className="text-muted-foreground">
                      {t('view.sidebar.rules', { defaultValue: 'rules' })}
                    </span>
                  </span>
                )}
              <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-md text-[10px] text-muted-foreground flex-shrink-0">
                <Radio className="w-2.5 h-2.5 text-emerald-500 animate-pulse" />
                <span>{t('view.sidebar.live', { defaultValue: 'live' })}</span>
              </span>
            </div>
          ) : null}

          {/* Search input */}
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <SearchIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('view.sidebar.searchPlaceholder', { defaultValue: 'Search racks, bins, markers…' })}
              className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('view.sidebar.clear', { defaultValue: 'Clear search' })}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            {!query && (
              <kbd className="hidden sm:inline-flex font-mono text-[9px] px-1.5 py-0.5 rounded border bg-muted">⌘K</kbd>
            )}
          </div>

          {/* Category chips — integration data first, then shape kinds
              behind explicit filters. The default 'all' view shows only
              integration data + linked shapes so the user lands on the
              real records (forklifts, sensors, cameras, shipments)
              instead of a wall of room polygons. */}
          <div className="flex items-center gap-1 px-3 py-1.5 border-b overflow-x-auto">
            <ChipButton label={t('view.search.all', { defaultValue: 'All' })} active={filter === 'all'} count={counts.all} onClick={() => setFilter('all')} />
            {counts.linked > 0 && <ChipButton label={t('view.search.linked', { defaultValue: 'Linked' })} active={filter === 'linked'} count={counts.linked} onClick={() => setFilter('linked')} />}
            {counts.asset > 0 && <ChipButton label={t('view.search.assets', { defaultValue: 'Assets' })} active={filter === 'asset'} count={counts.asset} onClick={() => setFilter('asset')} />}
            {counts.sensor > 0 && <ChipButton label={t('view.search.sensors', { defaultValue: 'Sensors' })} active={filter === 'sensor'} count={counts.sensor} onClick={() => setFilter('sensor')} />}
            {counts.camera > 0 && <ChipButton label={t('view.search.cameras', { defaultValue: 'Cameras' })} active={filter === 'camera'} count={counts.camera} onClick={() => setFilter('camera')} />}
            {counts.shipment > 0 && <ChipButton label={t('view.search.shipments', { defaultValue: 'Shipments' })} active={filter === 'shipment'} count={counts.shipment} onClick={() => setFilter('shipment')} />}
            {counts.source > 0 && <ChipButton label={t('view.search.sources', { defaultValue: 'Sources' })} active={filter === 'source'} count={counts.source} onClick={() => setFilter('source')} />}
            {counts.stream > 0 && <ChipButton label={t('view.search.streams', { defaultValue: 'Streams' })} active={filter === 'stream'} count={counts.stream} onClick={() => setFilter('stream')} />}
            {/* Shape kinds — only surface as chips when the user has
                opted in by clicking one (or has typed a query, which
                bubbles up shape matches in the All view anyway). Keeps
                the bar from getting overwhelmed when both integration
                and geometry data are dense. */}
            {(filter === 'rack' || (counts.rack > 0 && q.length === 0)) && (
              <ChipButton label={t('view.search.racks', { defaultValue: 'Racks' })} active={filter === 'rack'} count={counts.rack} onClick={() => setFilter('rack')} />
            )}
            {(filter === 'polygon' || (counts.polygon > 0 && q.length === 0)) && (
              <ChipButton label={t('view.search.polygons', { defaultValue: 'Rooms' })} active={filter === 'polygon'} count={counts.polygon} onClick={() => setFilter('polygon')} />
            )}
            {(filter === 'marker' || counts.marker > 0) && q.length > 0 && (
              <ChipButton label={t('view.search.markers', { defaultValue: 'Markers' })} active={filter === 'marker'} count={counts.marker} onClick={() => setFilter('marker')} />
            )}
            {(filter === 'model' || counts.model > 0) && q.length > 0 && (
              <ChipButton label={t('view.search.models', { defaultValue: 'Models' })} active={filter === 'model'} count={counts.model} onClick={() => setFilter('model')} />
            )}
            {filter === 'bin' && <ChipButton label={t('view.search.bins', { defaultValue: 'Bins' })} active count={counts.bin} onClick={() => setFilter('bin')} />}
            {filter === 'circle' && <ChipButton label={t('view.search.circles', { defaultValue: 'Circles' })} active count={counts.circle} onClick={() => setFilter('circle')} />}
            {filter === 'line' && <ChipButton label={t('view.search.lines', { defaultValue: 'Lines' })} active count={counts.line} onClick={() => setFilter('line')} />}
            {filter === 'stair' && <ChipButton label={t('view.search.stairs', { defaultValue: 'Stairs' })} active count={counts.stair} onClick={() => setFilter('stair')} />}
            {filter === 'door' && <ChipButton label={t('view.search.doors', { defaultValue: 'Doors' })} active count={counts.door} onClick={() => setFilter('door')} />}
            {filter === 'text' && <ChipButton label={t('view.search.texts', { defaultValue: 'Labels' })} active count={counts.text} onClick={() => setFilter('text')} />}
            {filter === 'image' && <ChipButton label={t('view.search.images', { defaultValue: 'Floor plans' })} active count={counts.image} onClick={() => setFilter('image')} />}
          </div>

          {/* Recents — only when input is empty and recents exist */}
          {q.length === 0 && recents.length > 0 && (
            <div className="border-b">
              <div className="flex items-center justify-between px-3 pt-2 pb-1">
                <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Clock className="w-3 h-3" />
                  {t('view.search.recent', { defaultValue: 'Recent' })}
                </span>
                <button
                  type="button"
                  onClick={() => { setRecents([]); saveRecents(warehouseId, []) }}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {t('view.search.clear', { defaultValue: 'Clear' })}
                </button>
              </div>
              <ul className="px-1 pb-1">
                {recents.map((r) => {
                  // Resolve against current data so renamed/deleted entries
                  // do the right thing.
                  let row: ResultRow | null = null
                  if (r.kind === 'rack') {
                    const g = grids.find((x) => String(x.id) === r.ref)
                    if (g) row = { key: `rack:${g.id}`, kind: 'rack', name: g.name || r.name, subtitle: r.subtitle, score: 1, pick: { kind: 'rack', grid: g } }
                  } else if (r.kind === 'marker') {
                    const m = markers.find((x) => String(x.id) === r.ref)
                    if (m) row = { key: `marker:${m.id}`, kind: 'marker', name: m.name || r.name, subtitle: r.subtitle, score: 1, pick: { kind: 'marker', marker: m } }
                  } else if (r.kind === 'model') {
                    const m = models.find((x) => String(x.id) === r.ref)
                    if (m) row = { key: `model:${m.id}`, kind: 'model', name: m.name || r.name, subtitle: r.subtitle, score: 1, pick: { kind: 'model', model: m } }
                  } else if (r.kind === 'bin') {
                    const b = bins.find((x) => String(x.id) === r.ref)
                    if (b) row = { key: `bin:${b.id}`, kind: 'bin', name: b.sku || b.externalCode || r.name, subtitle: r.subtitle, score: 1, pick: { kind: 'bin', bin: b, parentGrid: b.gridId !== undefined ? gridById.get(b.gridId) : undefined } }
                  } else if (r.kind === 'polygon') {
                    const p = polygons.find((x) => String(x.id) === r.ref)
                    if (p) row = { key: `polygon:${p.id}`, kind: 'polygon', name: p.name || r.name, subtitle: r.subtitle, score: 1, pick: { kind: 'polygon', polygon: p } }
                  } else if (r.kind === 'circle') {
                    const c = circles.find((x) => String(x.id) === r.ref)
                    if (c) row = { key: `circle:${c.id}`, kind: 'circle', name: c.name || r.name, subtitle: r.subtitle, score: 1, pick: { kind: 'circle', circle: c } }
                  } else if (r.kind === 'line') {
                    const l = lines.find((x) => String(x.id) === r.ref)
                    if (l) row = { key: `line:${l.id}`, kind: 'line', name: l.name || r.name, subtitle: r.subtitle, score: 1, pick: { kind: 'line', line: l } }
                  } else if (r.kind === 'stair') {
                    const s = stairs.find((x) => String(x.id) === r.ref)
                    if (s) row = { key: `stair:${s.id}`, kind: 'stair', name: s.name || r.name, subtitle: r.subtitle, score: 1, pick: { kind: 'stair', stair: s } }
                  } else if (r.kind === 'door') {
                    const d = doors.find((x) => String(x.id) === r.ref)
                    if (d) row = { key: `door:${d.id}`, kind: 'door', name: d.name || r.name, subtitle: r.subtitle, score: 1, pick: { kind: 'door', door: d } }
                  } else if (r.kind === 'text') {
                    const tl = textLabels.find((x) => String(x.id) === r.ref)
                    if (tl) row = { key: `text:${tl.id}`, kind: 'text', name: tl.config?.text || tl.name || r.name, subtitle: r.subtitle, score: 1, pick: { kind: 'text', text: tl } }
                  } else if (r.kind === 'image') {
                    const img = images.find((x) => String(x.id) === r.ref)
                    if (img) row = { key: `image:${img.id}`, kind: 'image', name: img.name || r.name, subtitle: r.subtitle, score: 1, pick: { kind: 'image', image: img } }
                  }
                  if (!row) return null
                  return <RowItem key={row.key} row={row} onClick={() => handlePickRow(row!)} />
                })}
              </ul>
            </div>
          )}

          {/* Results list */}
          <ul className="flex-1 overflow-y-auto py-1">
            {results.length === 0 && (
              <li className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                {q.length > 0
                  ? t('view.sidebar.noResults', { defaultValue: 'No matches.' })
                  : filter === 'all'
                    ? t('view.sidebar.emptyHint', { defaultValue: 'Pick a category or start typing.' })
                    : t('view.sidebar.emptyCategory', { defaultValue: 'Nothing here on this floor.' })}
              </li>
            )}
            {results.map((row) => (
              <RowItem key={row.key} row={row} onClick={() => handlePickRow(row)} />
            ))}
          </ul>
        </>
      )}

      {tab === 'details' && selection && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Header with back */}
          <div className="border-b px-3 py-2.5 flex items-start gap-2">
            <button
              type="button"
              onClick={() => setTab('browse')}
              aria-label={t('view.sidebar.back', { defaultValue: 'Back' })}
              className="h-6 w-6 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground flex-shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                <KindIcon kind={selection.kind} size={12} />
                {selectionSubtitle(selection, t)}
              </div>
              <div className="text-sm font-bold leading-tight truncate mt-0.5">
                {selectionTitle(selection, t)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => { onCloseSelection(); setTab('browse') }}
              aria-label={t('view.detail.close', { defaultValue: 'Close' })}
              className="h-6 w-6 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground flex-shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Primary actions */}
          <div className="border-b px-3 py-2 flex flex-col gap-1.5">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  // Route the primary CTA through the nav graph when the
                  // selection has a graph anchor; otherwise fall back to
                  // a fly-to so older selection kinds still feel useful.
                  const anchor = navAnchorFor(selection)
                  if (anchor && onDirectionsToHere) {
                    onDirectionsToHere(anchor.kind, anchor.shapeId)
                  } else {
                    onFlyToSelection()
                  }
                }}
                className="flex-1 inline-flex items-center justify-center gap-1.5 h-8 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <Navigation className="w-3.5 h-3.5" />
                {t('view.detail.directions', { defaultValue: 'Directions' })}
              </button>
              <button
                type="button"
                onClick={onFlyToSelection}
                aria-label={t('view.detail.flyTo', { defaultValue: 'Fly to' })}
                title={t('view.detail.flyTo', { defaultValue: 'Fly to' })}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border hover:bg-muted"
              >
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleCopyId}
                aria-label={t('view.detail.copyId', { defaultValue: 'Copy ID' })}
                title={t('view.detail.copyId', { defaultValue: 'Copy ID' })}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border hover:bg-muted"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleShare}
                aria-label={t('view.detail.share', { defaultValue: 'Share' })}
                title={t('view.detail.share', { defaultValue: 'Share' })}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border hover:bg-muted"
              >
                <Share2 className="w-3.5 h-3.5" />
              </button>
            </div>
            {navAnchorFor(selection) && onDirectionsFromHere && (
              <button
                type="button"
                onClick={() => {
                  const anchor = navAnchorFor(selection)
                  if (anchor) onDirectionsFromHere(anchor.kind, anchor.shapeId)
                }}
                className="inline-flex items-center justify-center gap-1.5 h-7 text-xs rounded-md border bg-card hover:bg-muted/60"
              >
                <ArrowUpRight className="w-3 h-3" />
                {t('view.detail.directionsFrom', { defaultValue: 'Directions from here' })}
              </button>
            )}
          </div>

          {/* Detail body */}
          <div className="flex-1 overflow-y-auto px-3 py-2">
            <DetailBody selection={selection} storeBins={storeBins} t={t} />
          </div>

          {actionFeedback && (
            <div className="px-3 pb-2 text-[10px] text-muted-foreground text-center">
              {actionFeedback}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

function RowItem({ row, onClick }: { row: { key: string; kind: ViewSidebarPick['kind']; name: string; subtitle?: string }; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/60 transition-colors"
      >
        <span className="w-8 h-8 rounded-md bg-muted flex items-center justify-center text-muted-foreground flex-shrink-0">
          <KindIcon kind={row.kind} size={14} />
        </span>
        <span className="flex flex-col min-w-0">
          <span className="text-sm font-medium truncate">{row.name}</span>
          {row.subtitle && (
            <span className="text-[10px] text-muted-foreground truncate">{row.subtitle}</span>
          )}
        </span>
        <ArrowUpRight className="w-3 h-3 text-muted-foreground/60 flex-shrink-0 ms-auto" />
      </button>
    </li>
  )
}

function ChipButton({ label, active, count, onClick }: { label: string; active: boolean; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium border whitespace-nowrap transition-colors ${
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-card text-muted-foreground hover:bg-muted border-border'
      }`}
    >
      {label}
      <span className="tabular-nums opacity-80">{count}</span>
    </button>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-end break-words">{value}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t pt-2 mt-2 first:border-0 first:pt-0 first:mt-0">
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
 * Schema Builder defined for this shape kind. The viewer's Detail
 * tab now does the same so clicking a polygon / circle / marker /
 * line / image / model surfaces the EXACT same body of information
 * the editor tooltip shows on hover — that's what the user means by
 * "show same data as the tooltip".
 *
 * Returns `null` when no linked bin exists OR when the linked bin has
 * no content worth showing, so shapes without integration data keep a
 * clean panel instead of an empty "Linked data" header.
 */
function LinkedBinBlock({
  kind,
  shapeId,
  storeBins,
}: {
  kind: 'polygon' | 'circle' | 'line' | 'marker' | 'image' | 'model'
  shapeId: number | undefined
  storeBins: ReadonlyArray<Bin>
}) {
  if (shapeId === undefined) return null
  const bin = storeBins.find(
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

function DetailBody({
  selection,
  storeBins,
  t,
}: {
  selection: DetailSelection
  storeBins: ReadonlyArray<Bin>
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
          {bin && (
            <Section title={t('view.detail.bin', { defaultValue: 'Bin' })}>
              {bin.status && <Field label={t('view.detail.status', { defaultValue: 'Status' })} value={bin.status} />}
              {bin.sku && <Field label={t('view.detail.sku', { defaultValue: 'SKU' })} value={bin.sku} />}
              {bin.externalCode && <Field label={t('view.detail.externalCode', { defaultValue: 'Code' })} value={bin.externalCode} />}
              {bin.capacity !== undefined && <Field label={t('view.detail.capacity', { defaultValue: 'Capacity' })} value={bin.capacity} />}
              {bin.notes && <Field label={t('view.detail.notes', { defaultValue: 'Notes' })} value={bin.notes} />}
            </Section>
          )}
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
          <LinkedBinBlock kind="marker" shapeId={m.id} storeBins={storeBins} />
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
          </Section>
          <LinkedBinBlock kind="model" shapeId={m.id} storeBins={storeBins} />
        </>
      )
    }
    case 'polygon':
      return (
        <>
          <Section title={t('view.detail.polygon', { defaultValue: 'Polygon' })}>
            {selection.polygon.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${selection.polygon.id}`} />}
            <Field label={t('view.detail.vertices', { defaultValue: 'Vertices' })} value={selection.polygon.vertices.length} />
            {selection.polygon.role && <Field label={t('view.detail.role', { defaultValue: 'Role' })} value={selection.polygon.role} />}
            {selection.polygon.config?.label && <Field label={t('view.detail.label', { defaultValue: 'Label' })} value={selection.polygon.config.label} />}
          </Section>
          <LinkedBinBlock kind="polygon" shapeId={selection.polygon.id} storeBins={storeBins} />
        </>
      )
    case 'circle':
      return (
        <>
          <Section title={t('view.detail.circle', { defaultValue: 'Circle' })}>
            {selection.circle.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${selection.circle.id}`} />}
            <Field label={t('view.detail.mode', { defaultValue: 'Mode' })} value={selection.circle.mode} />
            {selection.circle.radius !== undefined && <Field label={t('view.detail.radius', { defaultValue: 'Radius' })} value={`${selection.circle.radius.toFixed(2)} m`} />}
            {selection.circle.role && <Field label={t('view.detail.role', { defaultValue: 'Role' })} value={selection.circle.role} />}
            {selection.circle.config?.label && <Field label={t('view.detail.label', { defaultValue: 'Label' })} value={selection.circle.config.label} />}
          </Section>
          <LinkedBinBlock kind="circle" shapeId={selection.circle.id} storeBins={storeBins} />
        </>
      )
    case 'line':
      return (
        <>
          <Section title={t('view.detail.line', { defaultValue: 'Line' })}>
            {selection.line.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${selection.line.id}`} />}
            <Field label={t('view.detail.vertices', { defaultValue: 'Vertices' })} value={selection.line.vertices.length} />
            {selection.line.config?.label && <Field label={t('view.detail.label', { defaultValue: 'Label' })} value={selection.line.config.label} />}
          </Section>
          <LinkedBinBlock kind="line" shapeId={selection.line.id} storeBins={storeBins} />
        </>
      )
    case 'image':
      return (
        <>
          <Section title={t('view.detail.image', { defaultValue: 'Floor plan' })}>
            {selection.image.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${selection.image.id}`} />}
            <Field label={t('view.detail.size', { defaultValue: 'Size' })} value={`${selection.image.naturalWidth}×${selection.image.naturalHeight}`} />
          </Section>
          <LinkedBinBlock kind="image" shapeId={selection.image.id} storeBins={storeBins} />
        </>
      )
    case 'stair':
      return (
        <Section title={t('view.detail.stair', { defaultValue: 'Stair' })}>
          {selection.stair.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${selection.stair.id}`} />}
          <Field label={t('view.detail.steps', { defaultValue: 'Steps' })} value={selection.stair.config.stepCount} />
        </Section>
      )
    case 'text':
      return (
        <Section title={t('view.detail.text', { defaultValue: 'Text label' })}>
          {selection.label.id !== undefined && <Field label={t('view.detail.id', { defaultValue: 'ID' })} value={`#${selection.label.id}`} />}
          <Field label={t('view.detail.content', { defaultValue: 'Content' })} value={selection.label.config?.text ?? ''} />
        </Section>
      )
    // Slice 6c2 — same rewrite as view-detail-panel: read from
    // `payload.*` via the narrowing helper; ID field is `entityKey`.
    case 'asset': {
      const a = selection.asset
      // eslint-disable-next-line react-hooks/purity -- staleness is recomputed on every render by design
      const stale = Date.now() - a.lastSeenAt.getTime() > 30_000
      const type = payloadString(a.payload.type)
      const status = payloadString(a.payload.status)
      return (
        <Section title={t('view.detail.asset', { defaultValue: 'Asset' })}>
          <Field label={t('view.detail.assetId', { defaultValue: 'ID' })} value={<code className="text-[10px]">{a.entityKey}</code>} />
          {type && <Field label={t('view.detail.assetType', { defaultValue: 'Type' })} value={type} />}
          {status && <Field label={t('view.detail.status', { defaultValue: 'Status' })} value={status} />}
          {a.position && <Field label={t('view.detail.position', { defaultValue: 'Position' })} value={<code className="text-[10px]">{formatCoord(a.position)}</code>} />}
          <Field
            label={t('view.detail.lastSeen', { defaultValue: 'Last seen' })}
            value={<span className={stale ? 'text-amber-500' : undefined}>{a.lastSeenAt.toLocaleTimeString()}{stale ? ' · stale' : ''}</span>}
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
            <Field label={t('view.detail.value', { defaultValue: 'Value' })} value={<span className="font-semibold">{lastValue.toFixed(2)}{unit ? ` ${unit}` : ''}</span>} />
          )}
          {s.position && <Field label={t('view.detail.position', { defaultValue: 'Position' })} value={<code className="text-[10px]">{formatCoord(s.position)}</code>} />}
          <Field
            label={t('view.detail.lastUpdate', { defaultValue: 'Last update' })}
            value={<span className={stale ? 'text-amber-500' : undefined}>{s.lastSeenAt.toLocaleTimeString()}{stale ? ' · stale' : ''}</span>}
          />
        </Section>
      )
    }
    case 'camera': {
      const c = selection.camera
      const kind = payloadString(c.payload.kind)
      const yaw = typeof c.payload.yaw === 'number' ? c.payload.yaw : undefined
      const fovDeg = typeof c.payload.fovDeg === 'number' ? c.payload.fovDeg : undefined
      return (
        <Section title={t('view.detail.camera', { defaultValue: 'Camera' })}>
          <Field label={t('view.detail.cameraId', { defaultValue: 'ID' })} value={<code className="text-[10px]">{c.entityKey}</code>} />
          {kind && <Field label={t('view.detail.kind', { defaultValue: 'Kind' })} value={kind} />}
          {c.position && <Field label={t('view.detail.position', { defaultValue: 'Position' })} value={<code className="text-[10px]">{formatCoord(c.position)}</code>} />}
          {yaw !== undefined && <Field label={t('view.detail.yaw', { defaultValue: 'Yaw' })} value={`${yaw.toFixed(0)}°`} />}
          {fovDeg !== undefined && <Field label={t('view.detail.fov', { defaultValue: 'FOV' })} value={`${fovDeg.toFixed(0)}°`} />}
        </Section>
      )
    }
    case 'shipment': {
      const s = selection.shipment
      const state = payloadString(s.payload.state) ?? '—'
      const carrier = payloadString(s.payload.carrier)
      const etaAtStr = payloadString(s.payload.etaAt)
      return (
        <Section title={t('view.detail.shipment', { defaultValue: 'Shipment' })}>
          <Field label={t('view.detail.shipmentId', { defaultValue: 'ID' })} value={<code className="text-[10px]">{s.entityKey}</code>} />
          <Field label={t('view.detail.state', { defaultValue: 'State' })} value={state} />
          {carrier && <Field label={t('view.detail.carrier', { defaultValue: 'Carrier' })} value={carrier} />}
          {etaAtStr && <Field label={t('view.detail.eta', { defaultValue: 'ETA' })} value={new Date(etaAtStr).toLocaleString()} />}
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
          {ds.lastResult && <Field label={t('view.detail.lastResult', { defaultValue: 'Last result' })} value={ds.lastResult} />}
          {ds.lastRunAt && <Field label={t('view.detail.lastRun', { defaultValue: 'Last run' })} value={new Date(ds.lastRunAt).toLocaleString()} />}
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
        </Section>
      )
    }
  }
}
