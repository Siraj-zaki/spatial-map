/**
 * Modern, semantic tooltip body used by both `map-bin-overlay.tsx`
 * (grid cells) and `map-shape-tooltip.tsx` (every non-grid shape).
 *
 * Three layers of intelligence:
 *
 *   1. `classifyBin()` (rich-data.ts) splits media + links out from the
 *      bin's customProperties so they render as a gallery / video / tile
 *      instead of a raw URL string.
 *
 *   2. `classifyKeyValue()` (value-classifier.ts) inspects every
 *      remaining field — primary or custom — and returns a typed
 *      descriptor (`status`, `temperature`, `battery`, `epc`, `mac`,
 *      `coordinate`, `duration`, ...). The renderer maps that to an
 *      icon + color variant, so 30 unrelated domains (Logistics, WMS,
 *      Inventory, Assets, IoT, RFID, Camera, Sensor) all get the same
 *      polished output without per-field configuration.
 *
 *   3. Visual layer: header strip with external code + status chip,
 *      media carousel with thumbnails, link tiles with copy/open
 *      affordances, dense field grid, expandable JSON / array blocks.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  // structure
  ChevronLeft, ChevronRight, ChevronDown, Copy, ExternalLink,
  // status / general
  Activity, CheckCircle2, AlertTriangle, XCircle, Info, Circle,
  Shield, ShieldAlert, ShieldCheck, Flag, Badge,
  // sensors
  Thermometer, Droplets, Gauge, Battery, BatteryLow, Signal,
  Wind, Sun, Moon, Snowflake, Flame, CloudFog,
  Leaf, Lightbulb, Volume2, Waves, ActivitySquare,
  // power / electrical
  Zap, Plug, PlugZap, Power, Bolt,
  // measurement
  Percent, DollarSign, Ruler, Weight, Box, Scale,
  Compass, Navigation,
  // location / geo
  MapPin, Globe, Route, Pin,
  // identifiers
  QrCode, ScanLine, Scan, Hash, Fingerprint,
  // hardware
  Cpu, Wifi, Network, Server, Router, HardDrive,
  Antenna,
  // comm
  Mail, Phone, Link as LinkIcon, MessageSquare, Send,
  // visual / data
  Palette, Image as ImageIcon, Eye, EyeOff,
  Braces, List as ListIcon, Database, Table, FileText,
  // tag / type / label
  Tag, Type, Bookmark, Sticker,
  // time
  Calendar, Clock, Timer, AlarmClock, Hourglass,
  // toggle / bool
  ToggleLeft, ToggleRight, Check, X,
  // people
  User, Users, Briefcase, HardHat,
  // logistics / transport
  Package, PackageOpen, Truck, Ship,
  Plane, Train, Car, Forklift, Warehouse, Container,
  // camera / media
  Camera, Radio, Video, Monitor,
  // security
  Lock, Unlock, Key, DoorOpen, DoorClosed,
  // hazard
  FlameKindling, Biohazard, Radiation, Skull,
  // manufacturing
  Factory, Wrench, Cog, CircuitBoard,
  // navigation / arrows
  ArrowUp, ArrowDown, ArrowUpRight, ArrowDownRight,
  TrendingUp, TrendingDown,
} from 'lucide-react'
import { apiDb } from '@/lib/api-db'
import { useApiQuery } from '@/lib/useApiQuery'
import type { Bin, Reference } from '@/lib/db'
import { classifyBin, type MediaItem } from '@/lib/rich-data'
import {
  classifyKeyValue,
  labelFromKey,
  type ClassifiedValue,
  type IconName,
  type ValueVariant,
} from '@/lib/value-classifier'
import { cn } from '@/lib/utils'

interface Props {
  bin: Bin
  /**
   * When true (default), the popup fetches `/references` for this bin
   * and appends a "Linked" section. Setting to `false` disables that
   * network call — used by /view in shape-only mode. See message
   * thread 2026-07-02 ("why references api getting called if i hover
   * on the polygon").
   */
  withReferences?: boolean
  /**
   * Explicit title override. When set, wins over the built-in fallback
   * chain (`externalCode → sku → customProperties.name → 'Untitled'`).
   * Data-link tooltips pass the layer's configured `labelField` value
   * here so the header always shows the identifier the user chose
   * instead of the confusing 'Untitled' default when the synthesised
   * bin has no external code or SKU.
   */
  title?: string
  /**
   * When true, suppresses the small "Zone Polygon" / "Marker" / etc.
   * kind pill at the top of the header. Data-link tooltips set this
   * because the shape kind of the SYNTHESISED bin (always polygon) is
   * meaningless UX-facing information — the popup shows live data,
   * not a shape.
   */
  hideKind?: boolean
  /**
   * Hover-mode preview. When true, the body is capped at
   * `previewFieldCount` fields (default 5), videos + links + references
   * are hidden, and a "View more" button appears at the bottom that
   * calls `onViewMore`. Click-mode popups leave this false so they
   * render the full body. The design decision comes from the
   * 2026-07-22 review of the popup — 15+ configured fields overflowed
   * the viewport, and the user asked for a compact peek that expands
   * into the drawer on demand.
   */
  compact?: boolean
  /** Fields shown before the "View more" fold in compact mode. Default 5. */
  previewFieldCount?: number
  /**
   * Called when the user clicks "View more" in compact mode. Wired at
   * the mount site to open the full drawer for this shape / entity.
   * When unset in compact mode, the button is not rendered — the
   * popup just truncates to `previewFieldCount` fields.
   */
  onViewMore?: () => void
}

// ----------------------------------------------------------------- icon map

const ICONS: Record<IconName, React.ComponentType<{ className?: string }>> = {
  // status / general
  activity: Activity,
  'check-circle': CheckCircle2,
  'alert-triangle': AlertTriangle,
  'x-circle': XCircle,
  info: Info,
  circle: Circle,
  shield: Shield,
  'shield-alert': ShieldAlert,
  'shield-check': ShieldCheck,
  flag: Flag,
  badge: Badge,
  // sensors
  thermometer: Thermometer,
  droplets: Droplets,
  gauge: Gauge,
  battery: Battery,
  'battery-low': BatteryLow,
  signal: Signal,
  wind: Wind,
  sun: Sun,
  moon: Moon,
  snowflake: Snowflake,
  flame: Flame,
  'cloud-fog': CloudFog,
  leaf: Leaf,
  lightbulb: Lightbulb,
  'volume-2': Volume2,
  waves: Waves,
  'activity-square': ActivitySquare,
  // power / electrical
  zap: Zap,
  plug: Plug,
  'plug-zap': PlugZap,
  power: Power,
  bolt: Bolt,
  // measurement
  percent: Percent,
  'dollar-sign': DollarSign,
  ruler: Ruler,
  weight: Weight,
  box: Box,
  scale: Scale,
  compass: Compass,
  navigation: Navigation,
  // location / geo
  'map-pin': MapPin,
  globe: Globe,
  route: Route,
  pin: Pin,
  // identifiers
  'qr-code': QrCode,
  barcode: ScanLine,
  scan: Scan,
  hash: Hash,
  fingerprint: Fingerprint,
  // hardware
  cpu: Cpu,
  wifi: Wifi,
  network: Network,
  server: Server,
  router: Router,
  'hard-drive': HardDrive,
  satellite: Antenna,
  antenna: Antenna,
  // comm
  mail: Mail,
  phone: Phone,
  link: LinkIcon,
  'message-square': MessageSquare,
  send: Send,
  // visual / data
  palette: Palette,
  image: ImageIcon,
  eye: Eye,
  'eye-off': EyeOff,
  braces: Braces,
  list: ListIcon,
  database: Database,
  table: Table,
  'file-text': FileText,
  // tag / type / label
  tag: Tag,
  type: Type,
  bookmark: Bookmark,
  sticker: Sticker,
  // time
  calendar: Calendar,
  clock: Clock,
  timer: Timer,
  'alarm-clock': AlarmClock,
  hourglass: Hourglass,
  // toggle / bool
  'toggle-left': ToggleLeft,
  'toggle-right': ToggleRight,
  check: Check,
  x: X,
  // people
  user: User,
  users: Users,
  briefcase: Briefcase,
  'hard-hat': HardHat,
  // logistics / transport
  package: Package,
  'package-2': Package,
  'package-open': PackageOpen,
  truck: Truck,
  ship: Ship,
  plane: Plane,
  train: Train,
  car: Car,
  forklift: Forklift,
  warehouse: Warehouse,
  container: Container,
  pallet: Package,
  // camera / media
  camera: Camera,
  radio: Radio,
  video: Video,
  monitor: Monitor,
  // security
  lock: Lock,
  unlock: Unlock,
  key: Key,
  'door-open': DoorOpen,
  'door-closed': DoorClosed,
  // hazard
  'flame-kindling': FlameKindling,
  biohazard: Biohazard,
  radiation: Radiation,
  skull: Skull,
  // manufacturing
  factory: Factory,
  wrench: Wrench,
  cog: Cog,
  'circuit-board': CircuitBoard,
  // navigation / arrows
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  'arrow-up-right': ArrowUpRight,
  'arrow-down-right': ArrowDownRight,
  'trending-up': TrendingUp,
  'trending-down': TrendingDown,
}

function Icon({ name, className }: { name?: IconName; className?: string }) {
  if (!name) return null
  const C = ICONS[name]
  if (!C) return null
  return <C className={className ?? 'sgv-tt-ico'} />
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string

// ------------------------------------------------------------------ root

export function BinPopupContent({
  bin,
  withReferences = true,
  title: titleOverride,
  hideKind = false,
  compact = false,
  previewFieldCount = 5,
  onViewMore,
}: Props) {
  const { t } = useTranslation()
  const data = classifyBin(bin)
  const images = data.media.filter((m: MediaItem) => m.kind === 'image')
  const videos = data.media.filter((m: MediaItem) => m.kind === 'video')

  // Build the unified field list (primary + custom) with semantic types.
  const fields = buildFields(bin, data, t)

  // Header: caller-supplied override wins (data-link tooltips pass the
  // labelField's value). Otherwise fall through to the built-in chain:
  // external code → SKU → customProperties.name → nothing (empty).
  const derivedTitle =
    bin.externalCode ||
    bin.sku ||
    (typeof bin.customProperties?.['name'] === 'string'
      ? (bin.customProperties['name'] as string)
      : '')
  const title = titleOverride?.trim() || derivedTitle

  // Status chip in the header — pulled from primary list so it's not
  // double-rendered in the field grid.
  const statusField = fields.find((f) => f.kind === 'status' && f.label === 'Status')
  const restFields = fields.filter((f) => f !== statusField)

  // Compact hover mode: cap fields, drop videos + link tiles +
  // references, keep only the hero image. Feels like a peek — the full
  // list stays reachable via "View more" opening the drawer.
  const shownFields = compact
    ? restFields.slice(0, Math.max(0, previewFieldCount))
    : restFields
  const hiddenFieldCount = compact ? Math.max(0, restFields.length - shownFields.length) : 0
  const shownImages = compact ? images.slice(0, 1) : images
  const shownVideos = compact ? [] : videos
  const shownLinks = compact ? [] : data.links
  const includeReferences = withReferences && !compact
  const totalHidden =
    hiddenFieldCount +
    (compact ? videos.length + data.links.length : 0)

  const isEmpty =
    fields.length === 0 &&
    data.media.length === 0 &&
    data.links.length === 0

  return (
    <div className="sgv-tt w-[320px] text-xs text-popover-foreground">
      <Header title={title} status={statusField} bin={bin} hideKind={hideKind} t={t} />

      {(shownImages.length > 0 || shownVideos.length > 0) && (
        <div className="border-b border-border/60">
          {shownImages.length > 0 && <MediaGallery items={shownImages} t={t} />}
          {shownVideos.map((v: MediaItem, i: number) => (
            <VideoEmbed key={`${v.sourceKey}-${i}`} item={v} t={t} />
          ))}
        </div>
      )}

      <div className="p-3 space-y-3">
        {shownLinks.length > 0 && (
          <PopupSection title={t('binPopup.section.links')} icon={LinkIcon}>
            <div className="p-1 space-y-1 border rounded-lg border-border/60 bg-card/50 backdrop-blur-sm shadow-sm">
              {shownLinks.map((l: MediaItem, i: number) => (
                <LinkTile key={`${l.sourceKey}-${l.src}-${i}`} item={l} t={t} />
              ))}
            </div>
          </PopupSection>
        )}

        {shownFields.length > 0 && (
          <PopupSection title={t('binPopup.section.details')} icon={Info}>
            <div className="overflow-hidden border rounded-lg border-border/60 bg-card/50 backdrop-blur-sm shadow-sm divide-y divide-border/50">
              {shownFields.map((f) => (
                <FieldRow key={f.label} field={f} t={t} />
              ))}
            </div>
          </PopupSection>
        )}

        {compact && onViewMore && (totalHidden > 0 || restFields.length > 0) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onViewMore()
            }}
            className="w-full inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-border/60 bg-background/60 hover:bg-accent hover:border-border text-[11px] font-medium text-foreground transition-colors shadow-sm"
          >
            <span>{totalHidden > 0 ? t('binPopup.viewMoreWithCount', { count: totalHidden }) : t('binPopup.viewMore')}</span>
            <ChevronRight className="w-3 h-3" />
          </button>
        )}

        {includeReferences && <ReferencesPanel bin={bin} t={t} />}

        {isEmpty && (
          <div className="px-3 py-5 text-center text-muted-foreground border border-dashed rounded-lg border-border/60 bg-card/30">
            {t('binPopup.noLinkedData')}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Section wrapper used inside the popup body. Mirrors the visual
 * language of `Section` in `src/components/side-panel.tsx` and
 * `DrawerSection` in `src/routes/view.tsx` — a tinted primary chip
 * badge holds a lucide icon and the title is uppercase small caps in
 * `text-muted-foreground`. Renders inline (no card wrapper), so the
 * caller places the body block itself.
 */
function PopupSection({
  title,
  icon: SecIcon,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        <span
          className="flex items-center justify-center flex-shrink-0 w-4 h-4 rounded bg-primary/10 text-primary ring-1 ring-primary/15"
          aria-hidden
        >
          <SecIcon className="w-2.5 h-2.5" />
        </span>
        <span className="min-w-0 truncate">{title}</span>
      </div>
      {children}
    </section>
  )
}

// =============================================================== references

/**
 * Phase 6b — render any cross-entity references that point at this
 * bin. We probe a few likely source-key columns (externalCode, sku,
 * customProperties.batch / .lot / .epc) and pull every `Reference`
 * whose `sourceKey` matches, deduped.
 *
 * Each reference renders with its type tag, label (falling back to
 * targetKey), and an optional one-line summary of any `payload`
 * fields. Compact — designed to drop into the popup body without
 * dominating it.
 */
function ReferencesPanel({ bin, t }: { bin: Bin; t: TFunc }) {
  // Collect candidate source keys from the bin row. Stable references
  // tend to live on `externalCode` (WMS bin id) or `sku`; the catch-all
  // `customProperties` covers domain-specific ids (batch, lot, EPC).
  const candidates = collectSourceKeys(bin)

  const { data: refs = [] } = useApiQuery(
    async (): Promise<Reference[]> => {
      if (candidates.length === 0) return []
      return apiDb.references.where('sourceKey').anyOf(candidates).toArray()
    },
    ['references-by-source', candidates.join('|')],
    // Tooltips only need references once per hover; no polling.
    { intervalMs: 0 },
  )

  if (refs.length === 0) return null

  return (
    <PopupSection title={t('binPopup.section.linked')} icon={LinkIcon}>
      <div className="overflow-hidden border rounded-lg border-border/60 bg-card/50 backdrop-blur-sm shadow-sm divide-y divide-border/50">
        {refs.map((r: Reference) => (
          <ReferenceRow key={r.id} reference={r} t={t} />
        ))}
      </div>
    </PopupSection>
  )
}

function ReferenceRow({ reference, t }: { reference: Reference; t: TFunc }) {
  const display = reference.label ?? reference.targetKey
  return (
    <div className="grid grid-cols-[minmax(70px,90px)_1fr] gap-2 items-baseline px-2.5 py-1.5">
      <span
        className="text-[9.5px] font-mono font-semibold uppercase tracking-[0.05em] text-muted-foreground truncate"
        title={t('binPopup.referenceTypeTitle', { type: reference.type })}
      >
        {reference.type}
      </span>
      <span className="text-[11px] text-foreground min-w-0 break-words">
        <span className="font-medium">{display}</span>
        {reference.payload && Object.keys(reference.payload).length > 0 && (
          <span className="ms-1 font-mono text-[10px] text-muted-foreground">
            {summarisePayload(reference.payload)}
          </span>
        )}
      </span>
    </div>
  )
}

function collectSourceKeys(bin: Bin): string[] {
  const out: string[] = []
  if (bin.externalCode) out.push(bin.externalCode)
  if (bin.sku) out.push(bin.sku)
  const cp = bin.customProperties
  if (cp && typeof cp === 'object') {
    for (const key of ['batch', 'lot', 'epc', 'serial', 'tagId', 'assetId']) {
      const v = (cp as Record<string, unknown>)[key]
      if (typeof v === 'string' && v.length > 0) out.push(v)
      else if (typeof v === 'number') out.push(String(v))
    }
  }
  // Dedupe while preserving insertion order so the common-case lookup
  // (externalCode first) hits the index range fastest.
  return [...new Set(out)]
}

function summarisePayload(payload: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(payload)) {
    if (parts.length >= 2) break
    if (typeof v === 'string' || typeof v === 'number') {
      parts.push(`${k}: ${v}`)
    }
  }
  return parts.length > 0 ? `(${parts.join(', ')})` : ''
}

// ----------------------------------------------------------------- header

function Header({
  title,
  status,
  bin,
  hideKind,
  t,
}: {
  title: string
  status?: Field
  bin: Bin
  hideKind?: boolean
  t: TFunc
}) {
  const [copied, setCopied] = useState(false)
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(String(title))
      setCopied(true)
      setTimeout(() => setCopied(false), 900)
    } catch {
      /* ignore */
    }
  }
  // Suppress the empty-title case entirely — showing a blank title
  // slot with just a copy button is worse than showing nothing.
  const hasTitle = title.trim().length > 0
  return (
    <div className="relative flex items-start gap-2.5 px-3 pt-3 pb-2.5 border-b border-border/60 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent overflow-hidden">
      {/* Decorative dot pattern in the far corner — same treatment as
          side-panel.tsx's hero header, scaled down for the popup. */}
      <div
        className="pointer-events-none absolute -top-6 -end-6 w-24 h-24 opacity-40 dark:opacity-30"
        style={{
          backgroundImage:
            'radial-gradient(hsl(var(--primary) / 0.35) 1px, transparent 1px)',
          backgroundSize: '10px 10px',
          maskImage: 'radial-gradient(circle at 100% 0%, black 20%, transparent 60%)',
          WebkitMaskImage: 'radial-gradient(circle at 100% 0%, black 20%, transparent 60%)',
        }}
        aria-hidden
      />
      <span
        className="relative flex items-center justify-center flex-shrink-0 w-8 h-8 rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20 shadow-sm"
        aria-hidden
      >
        <Icon name={kindIcon(bin.targetKind)} className="w-3.5 h-3.5" />
      </span>
      <div className="relative flex flex-col flex-1 min-w-0 gap-1">
        {!hideKind && (
          <div className="text-[9.5px] uppercase tracking-[0.1em] font-semibold text-muted-foreground">
            {kindLabel(bin.targetKind, t)}
          </div>
        )}
        {hasTitle && (
          <div
            className="text-[13px] font-semibold leading-tight text-foreground truncate font-mono"
            title={title}
          >
            {title}
          </div>
        )}
      </div>
      <div className="relative flex items-center flex-shrink-0 gap-1">
        {status && (
          <Chip variant={status.value.variant ?? 'neutral'} icon={status.value.icon}>
            {status.value.display}
          </Chip>
        )}
        <button
          type="button"
          className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-border/60 bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shadow-sm"
          onClick={copy}
          title={copied ? t('binPopup.copied') : t('binPopup.copy')}
          aria-label={t('binPopup.copyIdentifier')}
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
    </div>
  )
}

function kindIcon(k: Bin['targetKind']): IconName {
  switch (k) {
    case 'grid-cell': return 'box'
    case 'polygon': return 'hash'
    case 'circle': return 'circle'
    case 'line': return 'ruler'
    case 'marker': return 'map-pin'
    case 'image': return 'image'
    case 'model': return 'package'
    default: return 'tag'
  }
}
function kindLabel(k: Bin['targetKind'], t: TFunc): string {
  switch (k) {
    case 'grid-cell': return t('binPopup.kind.binCell')
    case 'polygon': return t('binPopup.kind.polygon')
    case 'circle': return t('binPopup.kind.circle')
    case 'line': return t('binPopup.kind.line')
    case 'marker': return t('binPopup.kind.marker')
    case 'image': return t('binPopup.kind.image')
    case 'model': return t('binPopup.kind.model')
    default: return t('binPopup.kind.asset')
  }
}

// ----------------------------------------------------------------- gallery

function MediaGallery({ items, t }: { items: MediaItem[]; t: TFunc }) {
  const [index, setIndex] = useState(0)
  const safe = Math.max(0, Math.min(items.length - 1, index))
  const current = items[safe]
  const many = items.length > 1
  return (
    <div className="sgv-tt-gallery">
      <div className="sgv-tt-gallery-stage">
        <img
          src={current.src}
          alt={current.label ?? current.sourceKey}
          className="sgv-tt-gallery-img"
          onError={(e) => {
            ;(e.currentTarget as HTMLImageElement).style.display = 'none'
          }}
        />
        {many && (
          <>
            <button
              type="button"
              className="sgv-tt-gallery-nav sgv-tt-gallery-prev"
              onClick={(e) => {
                e.stopPropagation()
                setIndex((i) => (i - 1 + items.length) % items.length)
              }}
              aria-label={t('binPopup.previous')}
            >
              <ChevronLeft className="sgv-tt-ico-sm" />
            </button>
            <button
              type="button"
              className="sgv-tt-gallery-nav sgv-tt-gallery-next"
              onClick={(e) => {
                e.stopPropagation()
                setIndex((i) => (i + 1) % items.length)
              }}
              aria-label={t('binPopup.next')}
            >
              <ChevronRight className="sgv-tt-ico-sm" />
            </button>
            <div className="sgv-tt-gallery-counter">
              {safe + 1} / {items.length}
            </div>
          </>
        )}
      </div>
      {many && (
        <div className="sgv-tt-gallery-strip">
          {items.map((it, i) => (
            <button
              key={`${it.src}-${i}`}
              type="button"
              className={`sgv-tt-gallery-thumb${i === safe ? ' is-active' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                setIndex(i)
              }}
              aria-label={t('binPopup.imageN', { count: i + 1 })}
            >
              <img
                src={it.src}
                alt=""
                onError={(e) => {
                  ;(e.currentTarget as HTMLImageElement).style.opacity = '0.2'
                }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ video

function VideoEmbed({ item, t }: { item: MediaItem; t: TFunc }) {
  return (
    <div className="sgv-tt-video-wrap">
      <video
        src={item.src}
        controls
        preload="metadata"
        className="sgv-tt-video"
        onError={(e) => {
          const parent = (e.currentTarget as HTMLVideoElement).parentElement
          if (!parent) return
          const fallback = document.createElement('div')
          fallback.className = 'sgv-tt-video-fallback'
          fallback.textContent = t('binPopup.videoCouldNotBeDecoded')
          parent.replaceChild(fallback, e.currentTarget)
        }}
      />
    </div>
  )
}

// ----------------------------------------------------------------- tiles

function LinkTile({ item, t }: { item: MediaItem; t: TFunc }) {
  const isStream = item.kind === 'stream'
  const Icn = isStream ? Radio : item.kind === 'video' ? Video : ExternalLink
  const label = isStream
    ? t('binPopup.linkTile.cameraStream')
    : item.kind === 'video'
      ? t('binPopup.linkTile.video')
      : displayDomain(item.src)
  const [copied, setCopied] = useState(false)
  const copyHref = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(item.src)
      setCopied(true)
      setTimeout(() => setCopied(false), 900)
    } catch {
      /* ignore */
    }
  }
  const chipTone = isStream
    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/25'
    : 'bg-primary/10 text-primary ring-primary/15'
  return (
    <div className="group flex items-center gap-2 px-2 py-1.5 rounded-md border border-transparent hover:bg-accent hover:border-border/60 transition-colors">
      <span
        className={cn(
          'flex items-center justify-center flex-shrink-0 w-7 h-7 rounded-md ring-1',
          chipTone,
        )}
        aria-hidden
      >
        <Icn className="w-3.5 h-3.5" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {label}
        </div>
        <div
          className="text-[11px] font-mono text-foreground truncate"
          title={item.src}
        >
          {item.src}
        </div>
      </div>
      <div className="flex items-center flex-shrink-0 gap-1">
        {isStream ? (
          <button
            type="button"
            className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-border/60 bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            onClick={copyHref}
            title={copied ? t('binPopup.copied') : t('binPopup.copyUrl')}
            aria-label={t('binPopup.copyUrl')}
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          </button>
        ) : (
          <a
            href={item.src}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-border/60 bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            onClick={(e) => e.stopPropagation()}
            title={t('binPopup.open')}
            aria-label={t('binPopup.open')}
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  )
}

function displayDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// ----------------------------------------------------------------- fields

export interface Field {
  label: string
  kind: ClassifiedValue['kind']
  value: ClassifiedValue
}

function buildFields(bin: Bin, data: ReturnType<typeof classifyBin>, t: TFunc): Field[] {
  const out: Field[] = []

  // Primary fields, classified through the same lens as custom ones so
  // status / capacity get the same chip treatment.
  if (bin.externalCode) {
    out.push({
      label: t('binPopup.field.externalCode'),
      kind: 'identifier',
      value: classifyKeyValue('externalCode', bin.externalCode),
    })
  }
  if (bin.sku) {
    out.push({
      label: t('binPopup.field.sku'),
      kind: 'identifier',
      value: classifyKeyValue('sku', bin.sku),
    })
  }
  if (typeof bin.capacity === 'number') {
    out.push({
      label: t('binPopup.field.capacity'),
      kind: 'number',
      value: classifyKeyValue('quantity', bin.capacity),
    })
  }
  if (bin.status && bin.status !== 'empty') {
    out.push({
      label: t('binPopup.field.status'),
      kind: 'status',
      value: classifyKeyValue('status', bin.status),
    })
  }
  if (bin.notes) {
    out.push({
      label: t('binPopup.field.notes'),
      kind: 'text',
      value: classifyKeyValue('notes', bin.notes),
    })
  }
  if (bin.lastSyncedAt) {
    out.push({
      label: t('binPopup.field.lastSynced'),
      kind: 'datetime',
      value: classifyKeyValue('lastSyncedAt', bin.lastSyncedAt.toISOString()),
    })
  }

  // Custom attributes (non-media — `classifyBin` already peeled those off).
  for (const { key, value } of data.custom) {
    out.push({
      label: labelFromKey(key),
      kind: 'text',
      value: classifyKeyValue(key, value),
    })
  }

  return out
}

export function FieldRow({ field, t }: { field: Field; t?: TFunc }) {
  const v = field.value
  if (v.kind === 'json') return <JsonRow field={field} t={t} />
  if (v.kind === 'array') return <ArrayRow field={field} />
  return (
    <div className="grid grid-cols-[minmax(90px,130px)_1fr] gap-2 items-center px-2.5 py-1.5 min-h-[28px]">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground truncate">
        <Icon name={v.icon} className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
        <span className="truncate">{field.label}</span>
      </div>
      <div className="flex items-center justify-end gap-1.5 min-w-0 flex-wrap text-right">
        <ValuePill value={v} />
        {v.hint && (
          <span className="text-[9.5px] italic text-muted-foreground whitespace-nowrap">
            {v.hint}
          </span>
        )}
      </div>
    </div>
  )
}

function ValuePill({ value }: { value: ClassifiedValue }) {
  // status / boolean / battery / signal / percentage / currency / temperature
  // → render as a chip. Everything else is plain mono text so the row
  // stays scannable.
  const asChip =
    // states
    value.kind === 'status' ||
    value.kind === 'priority' ||
    value.kind === 'severity' ||
    value.kind === 'grade' ||
    value.kind === 'boolean' ||
    value.kind === 'door' ||
    value.kind === 'motion' ||
    value.kind === 'gas' ||
    value.kind === 'smoke' ||
    value.kind === 'lock' ||
    value.kind === 'valve' ||
    value.kind === 'power-state' ||
    value.kind === 'connection' ||
    // sensor / measurement chips
    value.kind === 'battery' ||
    value.kind === 'signal' ||
    value.kind === 'percentage' ||
    value.kind === 'temperature' ||
    value.kind === 'humidity' ||
    value.kind === 'pressure' ||
    value.kind === 'light' ||
    value.kind === 'sound' ||
    value.kind === 'vibration' ||
    value.kind === 'tilt' ||
    value.kind === 'flow' ||
    value.kind === 'speed' ||
    value.kind === 'air-quality' ||
    value.kind === 'power' ||
    value.kind === 'energy' ||
    value.kind === 'voltage' ||
    value.kind === 'current' ||
    value.kind === 'frequency' ||
    value.kind === 'altitude' ||
    // logistics / compliance / reference codes
    value.kind === 'hazmat' ||
    value.kind === 'incoterm' ||
    value.kind === 'country-code' ||
    value.kind === 'currency-code' ||
    value.kind === 'direction' ||
    value.kind === 'protocol' ||
    value.kind === 'tag'

  if (value.kind === 'color') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span
          className="w-3.5 h-3.5 rounded border border-border shadow-inner"
          style={{ background: value.css }}
          aria-hidden="true"
        />
        <span className="font-mono text-[11px] text-foreground break-all">
          {value.display}
        </span>
      </span>
    )
  }

  if (value.kind === 'url') {
    return (
      <a
        href={String(value.raw)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-mono text-[11px] text-primary hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
        title={String(value.raw)}
      >
        <span>{shortenUrl(value.display)}</span>
        <ExternalLink className="w-2.5 h-2.5" />
      </a>
    )
  }

  if (value.kind === 'email') {
    return (
      <a
        href={`mailto:${value.raw}`}
        className="text-[11px] text-primary hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {value.display}
      </a>
    )
  }

  if (value.kind === 'phone') {
    return (
      <a
        href={`tel:${String(value.raw).replace(/[^\d+]/g, '')}`}
        className="text-[11px] text-primary hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {value.display}
      </a>
    )
  }

  if (asChip) {
    return (
      <Chip variant={value.variant ?? 'neutral'}>
        {value.display}
      </Chip>
    )
  }

  // Identifiers / coordinates / mac / ip / epc / numbers / dates → mono
  return (
    <span className="font-mono text-[11px] text-foreground break-all">
      {value.display}
    </span>
  )
}

function Chip({
  variant,
  icon,
  children,
}: {
  variant: ValueVariant
  icon?: IconName
  children: React.ReactNode
}) {
  return (
    <span className={`sgv-tt-chip sgv-tt-variant-${variant}`}>
      {icon && <Icon name={icon} className="sgv-tt-ico-xs" />}
      <span>{children}</span>
    </span>
  )
}

function shortenUrl(url: string): string {
  if (url.length <= 36) return url
  try {
    const u = new URL(url)
    const tail = u.pathname.length > 14 ? `…${u.pathname.slice(-12)}` : u.pathname
    return `${u.hostname}${tail}`
  } catch {
    return `${url.slice(0, 24)}…${url.slice(-8)}`
  }
}

// ---------------------------------------------------- expandable JSON row

function JsonRow({ field, t }: { field: Field; t?: TFunc }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="px-2.5 py-1.5 space-y-1.5">
      <button
        type="button"
        className="flex items-center w-full gap-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground hover:text-foreground transition-colors"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        aria-expanded={open}
      >
        <ChevronDown
          className={cn(
            'w-3 h-3 flex-shrink-0 transition-transform duration-150',
            open ? 'rotate-0' : '-rotate-90',
          )}
        />
        <Icon name="braces" className="w-3 h-3 flex-shrink-0" />
        <span className="flex-1 text-start truncate">{field.label}</span>
        <span className="text-[9px] font-mono text-muted-foreground">{t ? t('binPopup.jsonBadge') : 'JSON'}</span>
      </button>
      {open && (
        <pre className="p-2 overflow-x-auto text-[10px] font-mono leading-relaxed rounded-md border border-border/60 bg-muted/40 text-foreground">
          {field.value.json}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------- expandable array row

function ArrayRow({ field }: { field: Field }) {
  const [open, setOpen] = useState(false)
  const items = field.value.items ?? []
  const preview = items.slice(0, 3)
  return (
    <div className="px-2.5 py-1.5 space-y-1.5">
      <button
        type="button"
        className="flex items-center w-full gap-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground hover:text-foreground transition-colors"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        aria-expanded={open}
      >
        <ChevronDown
          className={cn(
            'w-3 h-3 flex-shrink-0 transition-transform duration-150',
            open ? 'rotate-0' : '-rotate-90',
          )}
        />
        <Icon name="list" className="w-3 h-3 flex-shrink-0" />
        <span className="flex-1 text-start truncate">{field.label}</span>
        <span className="text-[9px] font-mono text-muted-foreground">
          {items.length}
        </span>
      </button>
      {!open && items.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {preview.map((it: ClassifiedValue, i: number) => (
            <span
              key={i}
              className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded border border-border/60 bg-muted/40 text-foreground max-w-[140px] truncate"
            >
              {it.display}
            </span>
          ))}
          {items.length > preview.length && (
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded border border-border/60 bg-primary/10 text-primary">
              +{items.length - preview.length}
            </span>
          )}
        </div>
      )}
      {open && (
        <ul className="space-y-1">
          {items.map((it: ClassifiedValue, i: number) => (
            <li
              key={i}
              className="flex items-center gap-2 px-1.5 py-1 rounded-md border border-border/60 bg-muted/30"
            >
              <span className="text-[9px] font-mono text-muted-foreground min-w-[16px]">
                {i + 1}
              </span>
              <ValuePill value={it} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
