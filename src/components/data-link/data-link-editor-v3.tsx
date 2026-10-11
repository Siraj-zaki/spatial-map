/**
 * DataLinkEditorV3Dialog — guided create/edit surface for a
 * `DataLinkConfig`. Ships alongside `data-link-editor.tsx` so the
 * legacy dialog stays intact; `create-grids.tsx` and the manager mount
 * this file instead.
 *
 * Design goals vs v1/v2 editor:
 *   1. Human-first render mode names. No `point-at-coord` in the UI —
 *      the user sees "Live location marker" and picks from cards.
 *   2. Every field input is a picker over the source's SAMPLE record.
 *      We fetch one row via `listRowsForSource(sourceId)` the moment
 *      the source is selected, flatten it into `{ path, value, type }`,
 *      and surface those as suggestions. A "type a custom path" mode
 *      is always available as an escape hatch.
 *   3. Sections are conditional on renderMode. A shape-tint layer
 *      never sees icon / cluster; a heatmap layer never sees icon /
 *      label / tooltip fields. See `MODE_CAPS` below.
 *   4. Every label has an info-icon tooltip explaining what the field
 *      does, with an example.
 *   5. The tooltip template is a real `{field}` template (matching the
 *      runtime `resolveLabelTemplate`), NOT the misleading
 *      `{{payload.field}}` the legacy editor advertised. A live
 *      preview renders the current template against the sample row so
 *      users see what the tooltip will actually show.
 *
 * Persistence is identical to v1: `useSpatialStore.createLocal` /
 * `updateLocal` / `deleteLocal` for `data-link-configs`. No new
 * migration, no new API surface. The whole redesign is UI-only.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  ExternalLink,
  Eye,
  Filter,
  Flame,
  Gauge,
  GripVertical,
  Info,
  Layers,
  Layers3,
  Link2,
  Loader2,
  MapPin,
  MessageSquare,
  PaintBucket,
  Palette,
  Pin,
  Plus,
  Route,
  Search,
  Sparkles,
  Tag,
  Target,
  Trash2,
  Video,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NumberInput } from '@/components/ui/number-input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { apiDb } from '@/lib/api-db'
import { useApiQuery, queryCache } from '@/lib/useApiQuery'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { listRowsForSource } from '@/lib/data-link/data-source-rows'
import { rerunDataSource, RerunError } from '@/lib/data-link/rerun'
import { resolveLabelTemplate } from '@/lib/data-link/style-rule-evaluator'
import { useSpatialStore } from '@/lib/spatial-store'
import {
  useSpatialCircles,
  useSpatialImages,
  useSpatialLines,
  useSpatialMarkers,
  useSpatialModels,
  useSpatialPolygons,
  useSpatialStyleRules,
} from '@/hooks/useSpatialShapes'
import type {
  DataLinkConfig,
  DataLinkFieldMapping,
  DataLinkFilterPreset,
  DataLinkMatch,
  DataLinkMatchMode,
  DataLinkRenderMode,
  DataLinkStyle,
  DataLinkTooltip,
  ElevationSpec,
} from '@/lib/db'
import { ElevationInput } from '@/components/data-link/elevation-input'
import {
  MarkerIconAndColors as RawMarkerIconAndColors,
  iconComponentForId,
} from '@/components/data-link/lucide-icon-picker'
import { FilterPresetsSection } from '@/components/data-link/filter-presets-section'

/**
 * MarkerIconAndColors is heavy — it renders the full ~1700-icon Lucide
 * picker plus two color rows. Wrapping the import in `React.memo`
 * shim means the picker only re-renders when its own props change,
 * NOT on every keystroke in the parent dialog's Name field. Massive
 * frame-time win: the parent re-renders ~30x per second on typing
 * without this, and each of those re-runs the icon grid's render
 * function.
 *
 * The parent passes `useState` setters directly (already stable
 * function references), so the shallow prop check in memo actually
 * holds and skips the re-render.
 */
const MarkerIconAndColors = memo(RawMarkerIconAndColors)

// ---------------------------------------------------------------- modes

interface RenderModeSpec {
  mode: DataLinkRenderMode
  /** Short human name (button label). */
  label: string
  /** One-line "when to use this" summary. */
  description: string
  /** Lucide icon component for the mode card. */
  Icon: React.ComponentType<{ size?: number; className?: string }>
}

/**
 * The 8 modes the overlay actually renders (see map-data-linked-overlay.tsx).
 * Labels are user-facing — no `point-at-coord` in the UI. Order is picked
 * so the most-common modes appear first.
 */
const RENDER_MODES: readonly RenderModeSpec[] = [
  {
    mode: 'point-at-coord',
    label: 'Live location marker',
    description: 'Show each record as a marker at its own lng/lat.',
    Icon: MapPin,
  },
  {
    mode: 'point-on-shape',
    label: 'Info marker on shape',
    description: 'Attach a marker to a specific shape\'s center.',
    Icon: Pin,
  },
  {
    mode: 'gauge-on-shape',
    label: 'Value badge on shape',
    description: 'Show a number (temperature, count, %, …) on a shape.',
    Icon: Gauge,
  },
  {
    mode: 'shape-tint',
    label: 'Color a shape',
    description: 'Tint a polygon or circle to reflect state.',
    Icon: PaintBucket,
  },
  {
    mode: 'heatmap',
    label: 'Heatmap of activity',
    description: 'Density map from recent events. No shape needed.',
    Icon: Flame,
  },
  {
    mode: 'track',
    label: 'Movement trails',
    description: 'Draw each entity\'s path over time.',
    Icon: Route,
  },
  {
    mode: 'fov-cone',
    label: 'Camera field of view',
    description: 'Triangle cone from yaw + FOV + view-distance.',
    Icon: Video,
  },
  {
    mode: 'roi-pulse',
    label: 'Pulsing zone activity',
    description: 'Animated ring + count badge at a shape\'s center.',
    Icon: Activity,
  },
  {
    mode: 'history-movement',
    label: 'Historical movement',
    description:
      'Scrub through the table\'s change log with a bottom-of-map player. Only for table sources.',
    Icon: Clock,
  },
]

/**
 * Per-mode capability matrix — drives which sections the editor shows.
 * The overlay is the source of truth for what each mode actually reads
 * at render time; this table is a UI mirror of that. See §4 of the
 * audit for the runtime evidence.
 */
interface ModeCaps {
  /** Does this mode anchor to a specific shape (match section shown)? */
  needsShape: boolean
  /** Does this mode read lng/lat from the payload? */
  needsCoords: boolean
  /** Does the mode carry a per-marker label? */
  usesLabel: boolean
  /** Gauge / label modes read a numeric value field. */
  usesValue: boolean
  /** Renders a Lucide icon inside a marker badge? */
  usesIcon: boolean
  /** Cluster toggle relevant? Only point-at-coord clusters. */
  usesCluster: boolean
  /** Per-record elevation lift (only point-at-coord path today). */
  usesElevation: boolean
  /** Cluster-group scoping (only point-at-coord). */
  usesClusterGroup: boolean
  /** Tooltip block relevant at all? */
  usesTooltip: boolean
  /** FOV cone reads yaw / fov / distance fields. */
  usesFovFields: boolean
  /** Track / heatmap group by entity — expose the group field. */
  usesEntityGroup: boolean
  /** Human label for the "marker color" slot ("Fill" / "Line" / "Ring"). */
  colorLabel: string
  // ---- v4 style knobs. Each flag turns on a slider in Section 6.
  /** Icon-size slider (Mapbox 0–1 scale) — point modes with icons. */
  usesIconSize: boolean
  /** Marker disc / circle radius — point modes. */
  usesMarkerSize: boolean
  /** Gauge badge radius. */
  usesBadgeSize: boolean
  /** Line-width slider — track. */
  usesLineWidth: boolean
  /** Fill-opacity slider — shape-tint, fov-cone. */
  usesFillOpacity: boolean
  /** Outline width slider — fov-cone. */
  usesOutlineWidth: boolean
  /** Heatmap radius + intensity sliders. */
  usesHeatmapKnobs: boolean
}

/**
 * Modes whose sub-renderer reads `entity_states`/`entity_events` directly
 * instead of going through `fetchLayerRows`, so they cannot render without a
 * stream. `track` builds breadcrumbs from `listEntityEventsForStream`; a
 * `kind='table'` source has no stream and keeps its history in
 * `data_source_row_events` instead.
 */
const STREAM_ONLY_MODES: readonly DataLinkRenderMode[] = ['track']

/** History player reads `/tables/{id}/events` — needs a table source. */
const TABLE_ONLY_MODES: readonly DataLinkRenderMode[] = ['history-movement']

/** Stable identity so the memoized RenderModeGrid isn't re-rendered. */
const NO_DISABLED_MODES: readonly DataLinkRenderMode[] = []
const DISABLED_MODES_NO_TABLE: readonly DataLinkRenderMode[] = TABLE_ONLY_MODES
const DISABLED_MODES_NO_STREAM_OR_TABLE: readonly DataLinkRenderMode[] = [
  ...STREAM_ONLY_MODES,
  ...TABLE_ONLY_MODES,
]

const MODE_CAPS: Record<DataLinkRenderMode, ModeCaps> = {
  'point-at-coord': {
    needsShape: false,
    needsCoords: true,
    usesLabel: true,
    usesValue: false,
    usesIcon: true,
    usesCluster: true,
    usesElevation: true,
    usesClusterGroup: true,
    usesTooltip: true,
    usesFovFields: false,
    usesEntityGroup: false,
    colorLabel: 'Marker color',
    usesIconSize: true,
    usesMarkerSize: true,
    usesBadgeSize: false,
    usesLineWidth: false,
    usesFillOpacity: false,
    usesOutlineWidth: false,
    usesHeatmapKnobs: false,
  },
  'point-on-shape': {
    needsShape: true,
    needsCoords: false,
    usesLabel: true,
    usesValue: false,
    usesIcon: true,
    usesCluster: false,
    usesElevation: false,
    usesClusterGroup: false,
    usesTooltip: true,
    usesFovFields: false,
    usesEntityGroup: false,
    colorLabel: 'Marker color',
    usesIconSize: true,
    usesMarkerSize: true,
    usesBadgeSize: false,
    usesLineWidth: false,
    usesFillOpacity: false,
    usesOutlineWidth: false,
    usesHeatmapKnobs: false,
  },
  'gauge-on-shape': {
    needsShape: true,
    needsCoords: false,
    usesLabel: true,
    usesValue: true,
    usesIcon: false,
    usesCluster: false,
    usesElevation: false,
    usesClusterGroup: false,
    usesTooltip: true,
    usesFovFields: false,
    usesEntityGroup: false,
    colorLabel: 'Badge color',
    usesIconSize: false,
    usesMarkerSize: false,
    usesBadgeSize: true,
    usesLineWidth: false,
    usesFillOpacity: false,
    usesOutlineWidth: false,
    usesHeatmapKnobs: false,
  },
  'shape-tint': {
    needsShape: true,
    needsCoords: false,
    usesLabel: false,
    usesValue: false,
    usesIcon: false,
    usesCluster: false,
    usesElevation: false,
    usesClusterGroup: false,
    usesTooltip: true,
    usesFovFields: false,
    usesEntityGroup: false,
    colorLabel: 'Fill color',
    usesIconSize: false,
    usesMarkerSize: false,
    usesBadgeSize: false,
    usesLineWidth: false,
    usesFillOpacity: true,
    usesOutlineWidth: false,
    usesHeatmapKnobs: false,
  },
  heatmap: {
    needsShape: false,
    needsCoords: true,
    usesLabel: false,
    usesValue: false,
    usesIcon: false,
    usesCluster: false,
    usesElevation: false,
    usesClusterGroup: false,
    usesTooltip: false,
    usesFovFields: false,
    usesEntityGroup: false,
    colorLabel: 'Base color',
    usesIconSize: false,
    usesMarkerSize: false,
    usesBadgeSize: false,
    usesLineWidth: false,
    usesFillOpacity: false,
    usesOutlineWidth: false,
    usesHeatmapKnobs: true,
  },
  track: {
    needsShape: false,
    needsCoords: true,
    usesLabel: true,
    usesValue: false,
    usesIcon: false,
    usesCluster: false,
    usesElevation: false,
    usesClusterGroup: false,
    usesTooltip: true,
    usesFovFields: false,
    usesEntityGroup: true,
    colorLabel: 'Line color',
    usesIconSize: false,
    usesMarkerSize: false,
    usesBadgeSize: false,
    usesLineWidth: true,
    usesFillOpacity: false,
    usesOutlineWidth: false,
    usesHeatmapKnobs: false,
  },
  'fov-cone': {
    needsShape: true,
    needsCoords: false,
    usesLabel: true,
    usesValue: false,
    usesIcon: false,
    usesCluster: false,
    usesElevation: false,
    usesClusterGroup: false,
    usesTooltip: true,
    usesFovFields: true,
    usesEntityGroup: false,
    colorLabel: 'Cone color',
    usesIconSize: false,
    usesMarkerSize: false,
    usesBadgeSize: false,
    usesLineWidth: false,
    usesFillOpacity: true,
    usesOutlineWidth: true,
    usesHeatmapKnobs: false,
  },
  'roi-pulse': {
    needsShape: true,
    needsCoords: false,
    usesLabel: true,
    usesValue: false,
    usesIcon: false,
    usesCluster: false,
    usesElevation: false,
    usesClusterGroup: false,
    usesTooltip: true,
    usesFovFields: false,
    usesEntityGroup: false,
    colorLabel: 'Ring color',
    usesIconSize: false,
    usesMarkerSize: false,
    usesBadgeSize: false,
    usesLineWidth: false,
    usesFillOpacity: false,
    usesOutlineWidth: false,
    usesHeatmapKnobs: false,
  },
  // v5.4 — same capabilities as point-at-coord: coord-driven, no shape
  // anchor, uses label / icon / cluster / elevation. The only render
  // difference is what feeds the entities (playback store vs live query),
  // and that's handled entirely by `useEffectiveEntities` in the overlay.
  'history-movement': {
    needsShape: false,
    needsCoords: true,
    usesLabel: true,
    usesValue: false,
    usesIcon: true,
    usesCluster: false,
    usesElevation: true,
    usesClusterGroup: true,
    usesTooltip: true,
    usesFovFields: false,
    usesEntityGroup: false,
    colorLabel: 'Marker color',
    usesIconSize: true,
    usesMarkerSize: true,
    usesBadgeSize: false,
    usesLineWidth: false,
    usesFillOpacity: false,
    usesOutlineWidth: false,
    usesHeatmapKnobs: false,
  },
}

/** DOM ids the left-rail TOC scrolls to. Kept in one place so the
 *  nav items and the sections themselves can't drift out of sync. */
const SECTION_IDS = {
  name: 'dl-sec-name',
  source: 'dl-sec-source',
  mode: 'dl-sec-mode',
  target: 'dl-sec-target',
  floors: 'dl-sec-floors',
  filters: 'dl-sec-filters',
  fields: 'dl-sec-fields',
  style: 'dl-sec-style',
  styleRules: 'dl-sec-style-rules',
  tooltip: 'dl-sec-tooltip',
  panel: 'dl-sec-panel',
} as const

const SHAPE_TARGET_KINDS: DataLinkConfig['targetKind'][] = [
  'polygon',
  'circle',
  'marker',
  'line',
  'model',
]

// ------------------------------------------------------ sample flatten

/**
 * A single leaf in the flattened sample record.
 *
 * `path` is the exact string the field-mapping resolver understands
 * (`match-resolver.readPayloadPath`). We build these so the user
 * never has to guess the syntax.
 */
export interface SampleField {
  /** e.g. `lng`, `currentPosition[0]`, `custom.temp`. */
  path: string
  /** Runtime value — shown as a preview beside the option. */
  value: unknown
  /** JS type — used to filter suggestions per purpose (numeric vs string). */
  type: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object'
}

/**
 * Depth-first walk over the payload. Emits leaves + one entry per
 * nested object/array node (so the user can pick `currentPosition`
 * as a whole if they want to). Arrays are unwrapped by index; we cap
 * at first 4 elements to keep the picker readable.
 */
function flattenPayload(value: unknown, prefix = ''): SampleField[] {
  const out: SampleField[] = []
  if (value === null) {
    out.push({ path: prefix, value: null, type: 'null' })
    return out
  }
  if (Array.isArray(value)) {
    // Emit the array itself so users can pick e.g. `tags` as a whole.
    out.push({ path: prefix, value, type: 'array' })
    for (let i = 0; i < Math.min(value.length, 4); i++) {
      const childPath = `${prefix}[${i}]`
      out.push(...flattenPayload(value[i], childPath))
    }
    return out
  }
  if (typeof value === 'object') {
    if (prefix !== '') {
      out.push({ path: prefix, value, type: 'object' })
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = prefix === '' ? k : `${prefix}.${k}`
      out.push(...flattenPayload(v, childPath))
    }
    return out
  }
  const type: SampleField['type'] =
    typeof value === 'number'
      ? 'number'
      : typeof value === 'boolean'
        ? 'boolean'
        : 'string'
  out.push({ path: prefix, value, type })
  return out
}

/** Heuristic auto-suggestions — the first match wins per purpose. */
function suggestField(
  fields: SampleField[],
  patterns: RegExp[],
  preferNumeric = false,
): string | undefined {
  const pool = preferNumeric
    ? fields.filter((f) => f.type === 'number')
    : fields
  for (const rx of patterns) {
    const hit = pool.find((f) => rx.test(f.path))
    if (hit) return hit.path
  }
  return undefined
}

// -------------------------------------------------------- InfoTip

/**
 * Info icon that reveals a short explanation on hover / focus. Uses
 * the native `title` attribute for accessibility + a small popover
 * for pointer users. Rendered inline next to every field label.
 */
const InfoTip = memo(function InfoTip({ text }: { text: string }) {
  return (
    <span className="relative inline-flex items-center group">
      <Info
        size={12}
        className="text-muted-foreground/70 hover:text-foreground cursor-help"
        aria-label={text}
      />
      <span
        role="tooltip"
        className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 z-50 hidden group-hover:block group-focus-within:block bg-popover border border-border rounded-md px-2 py-1 text-[11px] leading-tight text-popover-foreground shadow-md w-56"
      >
        {text}
      </span>
    </span>
  )
})

// --------------------------------------------------- LabelWithInfo

const LabelWithInfo = memo(function LabelWithInfo({
  htmlFor,
  children,
  info,
  className,
}: {
  htmlFor?: string
  children: React.ReactNode
  info?: string
  className?: string
}) {
  return (
    <div className={`flex items-center gap-1.5 ${className ?? ''}`}>
      <Label htmlFor={htmlFor} className="text-[12px] font-medium">
        {children}
      </Label>
      {info && <InfoTip text={info} />}
    </div>
  )
})

// ---------------------------------------------------- StyleSlider

/**
 * Label + Radix Slider + live value readout in one row. Used for every
 * numeric style knob in Section 6. `format` lets each caller decide how
 * to render the value (px, ×, ratio) without recomputing the range or
 * step math.
 */
const StyleSlider = memo(function StyleSlider({
  id,
  label,
  info,
  value,
  onChange,
  min,
  max,
  step,
  format = (v) => v.toFixed(step && step < 1 ? 2 : 0),
  suffix,
}: {
  id: string
  label: string
  info?: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step: number
  format?: (v: number) => string
  suffix?: string
}) {
  // NumberInput lets the user type an exact value (small steps like 0.05
  // are painful to hit by drag). `format` is retained on the type surface
  // for callers but no longer drives a visible readout — NumberInput
  // renders its own value based on `decimals` inferred from the step.
  void format
  const decimals = step && step < 1 ? (step < 0.1 ? 2 : 1) : 0
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <LabelWithInfo htmlFor={id} info={info}>
          {label}
        </LabelWithInfo>
        <NumberInput
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          decimals={decimals}
          suffix={suffix}
          hideSpinner
          className="w-[76px] flex-shrink-0"
        />
      </div>
      <Slider
        id={id}
        value={[value]}
        onValueChange={(vs) => onChange(vs[0] ?? value)}
        min={min}
        max={max}
        step={step}
      />
    </div>
  )
})

// ---------------------------------------------------- StylePreview

/**
 * Live SVG/CSS preview of what the current render mode will look like on
 * the map, given the operator's colour + size settings. Every prop is
 * re-read on every render so dragging a slider shows the change instantly
 * — memoized around the prop set so unrelated state changes (Name field
 * typing, etc.) don't force a repaint.
 *
 * The preview is deliberately approximate — a full Mapbox re-render inside
 * a dialog is overkill and would fight the parent layout. The goal is
 * "close enough that the user knows if 22 px is too big or 0.7 icon-size
 * looks right" before they close the dialog and check the map.
 */
const StylePreview = memo(function StylePreview({
  renderMode,
  defaultColor,
  iconColor,
  defaultIcon,
  iconSize,
  markerSize,
  badgeSize,
  lineWidth,
  fillOpacity,
  outlineWidth,
  heatmapRadius,
}: {
  renderMode: DataLinkRenderMode
  defaultColor: string
  iconColor: string
  defaultIcon: string
  iconSize: number
  markerSize: number
  badgeSize: number
  lineWidth: number
  fillOpacity: number
  outlineWidth: number
  heatmapRadius: number
}) {
  const Icon = iconComponentForId(defaultIcon) ?? null
  const glyphPx = Math.max(6, iconSize * 24)

  const previewBody = (() => {
    switch (renderMode) {
      case 'point-at-coord':
      case 'point-on-shape': {
        // Coloured disc + icon on top — mirrors the actual overlay.
        const size = markerSize * 2
        return (
          <div
            className="rounded-full shadow-sm flex items-center justify-center"
            style={{
              width: size,
              height: size,
              background: defaultColor,
              border: '2px solid white',
              boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
            }}
          >
            {Icon && (
              // eslint-disable-next-line react-hooks/static-components -- icon component is looked up from a static registry, not created
              <Icon
                size={glyphPx}
                color={iconColor || '#ffffff'}
                strokeWidth={2.25}
              />
            )}
          </div>
        )
      }
      case 'gauge-on-shape': {
        const size = badgeSize * 2
        return (
          <div
            className="rounded-full flex items-center justify-center font-semibold"
            style={{
              width: size,
              height: size,
              background: defaultColor,
              border: '2px solid white',
              color: '#ffffff',
              fontSize: Math.max(10, size * 0.32),
              boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
            }}
          >
            23°
          </div>
        )
      }
      case 'shape-tint':
        return (
          <svg width={200} height={110} viewBox="0 0 200 110">
            <polygon
              points="30,15 175,25 180,95 20,85"
              fill={defaultColor}
              fillOpacity={fillOpacity}
              stroke={defaultColor}
              strokeWidth={1.5}
            />
          </svg>
        )
      case 'heatmap': {
        const previewRadius = Math.min(65, Math.max(15, heatmapRadius * 0.9))
        return (
          <svg width={200} height={110} viewBox="0 0 200 110">
            <defs>
              <radialGradient id="dl-heatmap-preview" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#ef4444" stopOpacity={1} />
                <stop offset="30%" stopColor="#ef4444" stopOpacity={0.7} />
                <stop offset="60%" stopColor="#8b5cf6" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
              </radialGradient>
            </defs>
            <circle
              cx="100"
              cy="55"
              r={previewRadius}
              fill="url(#dl-heatmap-preview)"
            />
            <circle
              cx="60"
              cy="72"
              r={previewRadius * 0.6}
              fill="url(#dl-heatmap-preview)"
              opacity={0.7}
            />
            <circle
              cx="150"
              cy="45"
              r={previewRadius * 0.5}
              fill="url(#dl-heatmap-preview)"
              opacity={0.6}
            />
          </svg>
        )
      }
      case 'track':
        return (
          <svg width={200} height={110} viewBox="0 0 200 110">
            <path
              d="M 15 90 Q 55 15, 100 60 T 185 30"
              stroke={defaultColor}
              strokeWidth={lineWidth}
              strokeOpacity={0.7}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle
              cx="185"
              cy="30"
              r={Math.max(4, lineWidth * 1.8)}
              fill={defaultColor}
              stroke="white"
              strokeWidth={2}
            />
          </svg>
        )
      case 'fov-cone':
        return (
          <svg width={200} height={110} viewBox="0 0 200 110">
            <polygon
              points="60,55 180,15 180,95"
              fill={defaultColor}
              fillOpacity={fillOpacity}
              stroke={defaultColor}
              strokeWidth={outlineWidth}
              strokeOpacity={0.8}
            />
            <circle cx="60" cy="55" r={5} fill={defaultColor} stroke="white" strokeWidth={1.5} />
          </svg>
        )
      case 'roi-pulse':
        return (
          <div
            className="relative flex items-center justify-center"
            style={{ width: 96, height: 96 }}
          >
            <div
              className="absolute rounded-full animate-ping"
              style={{
                width: 72,
                height: 72,
                background: defaultColor,
                opacity: 0.35,
              }}
            />
            <div
              className="absolute rounded-full"
              style={{
                width: 60,
                height: 60,
                border: `3px solid ${defaultColor}`,
                opacity: 0.7,
              }}
            />
            <div
              className="relative rounded-full flex items-center justify-center font-semibold"
              style={{
                width: 34,
                height: 34,
                background: defaultColor,
                border: '2px solid white',
                color: '#ffffff',
                fontSize: 12,
              }}
            >
              3
            </div>
          </div>
        )
      default:
        return null
    }
  })()

  return (
    <div className="border border-border rounded-lg bg-[linear-gradient(45deg,#f3f4f6_25%,transparent_25%,transparent_75%,#f3f4f6_75%,#f3f4f6),linear-gradient(45deg,#f3f4f6_25%,transparent_25%,transparent_75%,#f3f4f6_75%,#f3f4f6)] [background-position:0_0,8px_8px] [background-size:16px_16px] dark:bg-[linear-gradient(45deg,#1e293b_25%,transparent_25%,transparent_75%,#1e293b_75%,#1e293b),linear-gradient(45deg,#1e293b_25%,transparent_25%,transparent_75%,#1e293b_75%,#1e293b)] dark:bg-slate-900 relative overflow-hidden">
      <div className="absolute top-2 start-2 z-10 flex items-center gap-1 px-2 py-0.5 rounded-full bg-background/80 backdrop-blur border border-border/60 text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
        <Eye size={11} className="text-primary" />
        Live preview
      </div>
      <div className="flex items-center justify-center min-h-[140px] p-4">
        {previewBody}
      </div>
    </div>
  )
})

// ---------------------------------------------------- FieldPicker

/**
 * Combobox that lists fields detected in the sample record. The user
 * either picks a suggestion (dropdown) or clicks "custom" to type a
 * raw path (`currentPosition[0]`, `nested.field`). We keep both
 * views because power users still want the raw path.
 */
const FieldPicker = memo(function FieldPicker({
  id,
  value,
  onChange,
  fields,
  placeholder,
  filterType,
  loading,
  emptyMessage,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  fields: SampleField[]
  placeholder?: string
  /** Only show fields of this type in the dropdown (all still typeable). */
  filterType?: SampleField['type'] | SampleField['type'][]
  loading?: boolean
  emptyMessage?: string
}) {
  const [manual, setManual] = useState(() => {
    // Default to manual if the current value isn't among the sample
    // fields — likely a legacy config the sample doesn't know about.
    if (!value) return false
    return !fields.some((f) => f.path === value)
  })

  const typeFilter = filterType
    ? Array.isArray(filterType)
      ? filterType
      : [filterType]
    : null
  const filtered = typeFilter
    ? fields.filter((f) => typeFilter.includes(f.type))
    : fields

  if (manual) {
    return (
      <div className="flex gap-1.5 items-center min-w-0">
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? 'e.g. currentPosition[0]'}
          className="h-8 text-xs font-mono flex-1 min-w-0"
        />
        {fields.length > 0 && (
          <button
            type="button"
            onClick={() => setManual(false)}
            className="text-[11px] text-muted-foreground hover:text-foreground underline whitespace-nowrap shrink-0"
          >
            pick
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex gap-1.5 items-center">
      <select
        id={id}
        value={value}
        onChange={(e) => {
          if (e.target.value === '__custom__') {
            setManual(true)
            return
          }
          onChange(e.target.value)
        }}
        className="h-8 flex-1 min-w-0 rounded-md border bg-background px-2 text-xs"
        disabled={loading}
      >
        <option value="">
          {loading
            ? 'Loading fields…'
            : filtered.length === 0
              ? emptyMessage ?? 'No matching fields in sample'
              : '— pick a field —'}
        </option>
        {filtered.map((f) => (
          <option key={f.path} value={f.path}>
            {f.path}
            {previewValue(f) ? `  ·  ${previewValue(f)}` : ''}
          </option>
        ))}
        {value && !filtered.some((f) => f.path === value) && (
          // Preserve an existing value even if it's not in the sample.
          <option value={value}>{value} (not in sample)</option>
        )}
        <option value="__custom__">✏  type a custom path…</option>
      </select>
    </div>
  )
})

/** Render a compact one-line preview of a sample value for the dropdown. */
function previewValue(f: SampleField): string {
  if (f.value === null || f.value === undefined) return ''
  if (f.type === 'object') return '{…}'
  if (f.type === 'array') return `[${(f.value as unknown[]).length}]`
  const s = String(f.value)
  return s.length > 24 ? s.slice(0, 22) + '…' : s
}

// ------------------------------------------------------- Section

const Section = memo(function Section({
  step,
  title,
  hint,
  children,
  sectionId,
}: {
  step: number
  title: React.ReactNode
  hint?: string
  children: React.ReactNode
  /** DOM id used by the left-rail TOC to scroll here + track "active"
   *  via IntersectionObserver. Must be stable across renders. */
  sectionId?: string
}) {
  return (
    <section
      id={sectionId}
      // `scroll-mt-4` gives the sticky header a little breathing room
      // when `scrollIntoView` lands on this section.
      className="border-t pt-4 mt-2 scroll-mt-4"
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-[12px] font-semibold">
          {step}
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {hint && <p className="text-xs text-muted-foreground mb-2">{hint}</p>}
      <div className="grid gap-2">{children}</div>
    </section>
  )
})

// --------------------------------------------------------- SectionNav

/**
 * A single item in the left-rail table of contents.
 */
interface NavItem {
  id: string
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
}

/**
 * Left-rail TOC. Renders one clickable pill per section. Clicking a
 * pill smooth-scrolls its target into view. The `active` id (tracked
 * externally by `useActiveSection`) gets a filled primary tile so
 * users always know where they are in a long form.
 *
 * Deliberately NOT a wizard/stepper — clicks never gate progress or
 * change state. Editing an existing config is the common case; users
 * want to jump directly to the field they need to change.
 */
const SectionNav = memo(function SectionNav({
  items,
  activeId,
  scrollRoot,
}: {
  items: readonly NavItem[]
  activeId: string | null
  /** The scroll container whose scrollTop we adjust on click. */
  scrollRoot: HTMLElement | null
}) {
  const jumpTo = (id: string) => {
    if (!scrollRoot) return
    const el = scrollRoot.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
    if (!el) return
    // Manual math instead of `scrollIntoView` — that call is often
    // capped by the browser to the nearest scroll container, and the
    // Dialog portal's stacking sometimes prevents it from finding the
    // right ancestor. `scrollTop` on the ref we own is unambiguous.
    const rootRect = scrollRoot.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    scrollRoot.scrollTo({
      top: scrollRoot.scrollTop + (elRect.top - rootRect.top) - 12,
      behavior: 'smooth',
    })
  }
  return (
    <nav className="grid gap-1 p-3">
      {items.map((item, i) => {
        const Icon = item.icon
        const isActive = item.id === activeId
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => jumpTo(item.id)}
            className={
              'flex items-center gap-2.5 px-2.5 py-2 rounded-md text-start transition-colors ' +
              (isActive
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/40')
            }
          >
            <span
              className={
                'flex items-center justify-center w-7 h-7 rounded-md shrink-0 ' +
                (isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground')
              }
            >
              <Icon size={14} />
            </span>
            <span className="flex-1 min-w-0 truncate text-sm">
              <span className="text-muted-foreground/70 me-1 tabular-nums text-xs">
                {i + 1}.
              </span>
              {item.label}
            </span>
          </button>
        )
      })}
    </nav>
  )
})

/**
 * Watches every registered section and returns the id of whichever
 * one has the largest visible portion in `scrollRoot`. Falls back to
 * the first item when nothing is visible (i.e. before mount).
 *
 * Uses IntersectionObserver so we don't paint on every scroll event.
 * `rootMargin: '-40% 0px -40% 0px'` narrows the "active zone" to the
 * middle band of the viewport — matches user intuition better than a
 * top-of-viewport rule.
 */
function useActiveSection(
  ids: readonly string[],
  scrollRoot: HTMLElement | null,
): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null)
  useEffect(() => {
    if (!scrollRoot || ids.length === 0) return
    const visibility = new Map<string, number>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          visibility.set(e.target.id, e.intersectionRatio)
        }
        let bestId: string | null = null
        let bestRatio = 0
        for (const [id, ratio] of visibility) {
          if (ratio > bestRatio) {
            bestRatio = ratio
            bestId = id
          }
        }
        if (bestId && bestRatio > 0) setActive(bestId)
      },
      {
        root: scrollRoot,
        rootMargin: '-40% 0px -40% 0px',
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    )
    for (const id of ids) {
      const el = scrollRoot.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
      if (el) io.observe(el)
    }
    return () => io.disconnect()
  }, [ids, scrollRoot])
  return active
}

// --------------------------------------------------- SamplePreview

/**
 * Collapsible card showing the first row we fetched from the source.
 * Users glance at this to verify they picked the right source AND to
 * see which field paths are available.
 */
const SamplePreview = memo(function SamplePreview({
  loading,
  error,
  fields,
  empty,
  emptyHint,
  sourceSelected,
  onIngestNow,
  ingesting,
  ingestError,
  ingestResult,
}: {
  loading: boolean
  error: string | null
  fields: SampleField[]
  empty: boolean
  /** Overrides the default "no records yet" copy for push-based sources. */
  emptyHint?: string
  sourceSelected: boolean
  onIngestNow?: () => void
  ingesting?: boolean
  ingestError?: string | null
  ingestResult?: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  if (!sourceSelected) return null
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-1">
        <Loader2 size={12} className="animate-spin" /> Fetching a sample record…
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 text-[11px] text-destructive border border-destructive/40 rounded-md p-2 mt-1">
        <AlertCircle size={12} className="mt-0.5 shrink-0" />
        <span>Couldn't fetch sample: {error}</span>
      </div>
    )
  }
  if (empty) {
    return (
      <div className="border border-dashed border-border rounded-md p-2 mt-1 grid gap-1.5">
        <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>
            {emptyHint ??
              'This source has no records yet. Ingest them now to see fields — or type field paths by hand and the data will flow in later.'}
          </span>
        </div>
        {onIngestNow && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onIngestNow}
            disabled={ingesting}
            className="h-7 text-[12px] self-start"
          >
            {ingesting ? (
              <Loader2 className="w-3 h-3 me-1 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3 me-1" />
            )}
            {ingesting ? 'Ingesting…' : 'Ingest records now'}
          </Button>
        )}
        {ingestResult && (
          <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
            {ingestResult}
          </div>
        )}
        {ingestError && (
          <div className="flex items-start gap-2 text-[11px] text-destructive">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{ingestError}</span>
          </div>
        )}
      </div>
    )
  }
  const leaves = fields.filter(
    (f) => f.type !== 'object' && f.type !== 'array',
  )
  return (
    <div className="border border-emerald-500/25 bg-emerald-500/5 rounded-lg mt-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-emerald-500/10 rounded-t-lg"
      >
        <div className="flex items-center gap-2 text-xs font-medium">
          <Sparkles size={13} className="text-emerald-600 dark:text-emerald-400" />
          <span>
            Sample record ready · <span className="font-semibold">{leaves.length}</span>{' '}
            field{leaves.length === 1 ? '' : 's'} detected
          </span>
        </div>
        <ChevronDown
          size={13}
          className={`text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {expanded && (
        <div className="max-h-48 overflow-y-auto border-t border-emerald-500/20 p-2 grid gap-0.5 text-[11px] font-mono">
          {leaves.map((f) => (
            <div
              key={f.path}
              className="flex items-baseline gap-2 px-1.5 py-1 rounded hover:bg-emerald-500/10"
            >
              <span className="text-foreground shrink-0">{f.path}</span>
              <span className="text-muted-foreground/60 shrink-0">·</span>
              <span className="text-muted-foreground truncate">
                {previewValue(f) || '—'}
              </span>
              <span className="ms-auto text-[10px] uppercase tracking-wider text-muted-foreground/50 shrink-0">
                {f.type}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

// ------------------------------------------------ RenderModeGrid

const RenderModeGrid = memo(function RenderModeGrid({
  value,
  onChange,
  disabledModes,
  disabledHint,
}: {
  value: DataLinkRenderMode
  onChange: (mode: DataLinkRenderMode) => void
  disabledModes: readonly DataLinkRenderMode[]
  /** Tooltip explaining why the disabled cards can't be picked. */
  disabledHint: string
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
      {RENDER_MODES.map((spec) => {
        const selected = spec.mode === value
        const disabled = disabledModes.includes(spec.mode)
        const Icon = spec.Icon
        return (
          <button
            key={spec.mode}
            type="button"
            onClick={() => onChange(spec.mode)}
            disabled={disabled}
            title={disabled ? disabledHint : undefined}
            className={
              'flex items-start gap-2.5 p-3 rounded-lg border text-start transition-all ' +
              (disabled
                ? 'border-border opacity-50 cursor-not-allowed'
                : selected
                  ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20'
                  : 'border-border hover:bg-accent/40 hover:border-border/80')
            }
          >
            <span
              className={
                'flex items-center justify-center w-8 h-8 rounded-md shrink-0 ' +
                (selected && !disabled
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted text-muted-foreground')
              }
            >
              <Icon size={16} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium leading-tight">
                {spec.label}
              </div>
              <div className="text-[11px] text-muted-foreground leading-snug mt-1">
                {disabled ? disabledHint : spec.description}
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
})

// -------------------------------------------- useSourceSample hook

/**
 * Fetches the first row from a data source and flattens it into
 * pick-able fields. Reruns whenever `sourceId` changes; caches via
 * `useApiQuery` so re-opening the dialog is instant.
 *
 * `refetch` re-invalidates the cache and pulls fresh rows — used by
 * the "Ingest now" button after `rerunDataSource` fills the source.
 */
function useSourceSample(sourceId: number | null): {
  fields: SampleField[]
  sample: Record<string, unknown> | null
  loading: boolean
  error: string | null
  empty: boolean
  refetch: () => void
} {
  const q = useApiQuery(
    async () => {
      if (sourceId === null) return { rows: [] }
      const rows = await listRowsForSource(sourceId)
      return { rows }
    },
    ['data-source-sample', sourceId],
    { intervalMs: 0, enabled: sourceId !== null },
  )
  const rows = q.data?.rows ?? []
  const sample = rows[0]?.payload ?? null
  const fields = useMemo(
    () => (sample ? flattenPayload(sample) : []),
    [sample],
  )
  return {
    fields,
    sample,
    loading: q.isLoading,
    error: q.error?.message ?? null,
    empty: sourceId !== null && !q.isLoading && !q.error && rows.length === 0,
    refetch: () => queryCache.invalidate('data-source-sample'),
  }
}

// -------------------------------------------------- SourcePickerRow

const SourcePickerRow = memo(function SourcePickerRow({
  value,
  onChange,
  sources,
}: {
  value: number | null
  onChange: (id: number | null) => void
  /** Provided by the parent so we don't double-fetch (parent needs the
   * same list to resolve `sourceObj` for the ingest-now button). */
  sources: readonly { id?: number; name: string; kind: string; entityKind?: string }[]
}) {
  return (
    <div className="grid gap-1">
      <select
        value={value ?? ''}
        onChange={(e) =>
          onChange(e.target.value ? Number(e.target.value) : null)
        }
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
      >
        <option value="">— pick a data source —</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id ?? ''}>
            {s.name} · {s.entityKind ?? 'marker'} · {s.kind}
          </option>
        ))}
      </select>
      {sources.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No data sources yet. Add one from{' '}
          <a href="/integrations" className="underline">
            Integrations
          </a>
          .
        </p>
      )}
    </div>
  )
})

// ------------------------------------------------- MatchModeCards

const MATCH_MODE_OPTIONS: {
  mode: Exclude<DataLinkMatchMode, 'coord'>
  label: string
  hint: string
}[] = [
  {
    mode: 'explicit-shape',
    label: 'One specific shape',
    hint: 'You pick the shape from a dropdown. Simplest option.',
  },
  {
    mode: 'attribute-join',
    label: 'Match by attribute',
    hint: 'Match payload field ↔ shape name/role/custom-property. Records can land on multiple shapes.',
  },
  {
    mode: 'external-code',
    label: 'Match by external code',
    hint: 'Shortcut: payload field ↔ bin.externalCode. What CSV imports use.',
  },
]

const MatchModeCards = memo(function MatchModeCards({
  value,
  onChange,
}: {
  value: DataLinkMatchMode
  onChange: (v: DataLinkMatchMode) => void
}) {
  return (
    <div role="radiogroup" className="grid gap-1.5">
      {MATCH_MODE_OPTIONS.map((opt) => {
        const selected = opt.mode === value
        return (
          <label
            key={opt.mode}
            className={
              'flex items-start gap-2 p-2 rounded-md border cursor-pointer transition-colors ' +
              (selected
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-accent/40')
            }
          >
            <input
              type="radio"
              name="dl-match-mode-v3"
              value={opt.mode}
              checked={selected}
              onChange={() => onChange(opt.mode)}
              className="mt-0.5 accent-primary"
            />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium">{opt.label}</div>
              <div className="text-[11px] text-muted-foreground">
                {opt.hint}
              </div>
            </div>
          </label>
        )
      })}
    </div>
  )
})

// ------------------------------------------ TooltipFieldsChecklist

/**
 * Two-pane orderer for a list of field paths:
 *  - LEFT: "In your view" — selected fields in explicit order.
 *          Rows can be reordered by drag-and-drop OR by the ↑ / ↓
 *          keyboard buttons on each row (works with screen readers).
 *          Remove with the × button. Optional custom paths (typed
 *          by hand) sit alongside detected ones and carry an "!"
 *          badge so users know the sample doesn't validate them.
 *  - RIGHT: "Available fields" — palette of un-selected sample
 *          fields with a search box. Click ⊕ to append to the left
 *          pane at the end of the current order.
 *
 * `sample` is passed in only for the per-row value preview. All
 * other logic works from the ordered `selected` array + the palette
 * `fields`.
 */
const FieldOrderer = memo(function FieldOrderer({
  fields,
  selected,
  onChange,
  emptyHint,
}: {
  fields: SampleField[]
  selected: string[]
  onChange: (next: string[]) => void
  emptyHint?: string
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [customPath, setCustomPath] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const leafFields = useMemo(
    () => fields.filter((f) => f.type !== 'object' && f.type !== 'array'),
    [fields],
  )
  const fieldByPath = useMemo(() => {
    const m = new Map<string, SampleField>()
    for (const f of leafFields) m.set(f.path, f)
    return m
  }, [leafFields])

  const availableFiltered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return leafFields
      .filter((f) => !selected.includes(f.path))
      .filter((f) => !q || f.path.toLowerCase().includes(q))
  }, [leafFields, selected, query])

  const add = (path: string) => {
    if (!path || selected.includes(path)) return
    onChange([...selected, path])
  }
  const remove = (index: number) => {
    const next = selected.slice()
    next.splice(index, 1)
    onChange(next)
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= selected.length || from === to) return
    const next = selected.slice()
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onChange(next)
  }
  const clearAll = () => onChange([])
  const selectAll = () => onChange(leafFields.map((f) => f.path))
  const commitCustom = () => {
    const p = customPath.trim()
    if (!p) return
    add(p)
    setCustomPath('')
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {/* LEFT — selected + order */}
      <div className="border border-border rounded-md flex flex-col min-h-[260px]">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border/60 bg-muted/30 rounded-t-md">
          <div className="text-[11px] font-semibold uppercase tracking-wider">
            In your view
            <span className="ms-1 font-normal text-muted-foreground">
              ({selected.length})
            </span>
          </div>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="text-[11px] text-muted-foreground hover:text-destructive underline"
            >
              clear
            </button>
          )}
        </div>
        <div className="flex-1 max-h-72 overflow-y-auto p-1.5 grid gap-0.5">
          {selected.length === 0 ? (
            <p className="text-[11px] text-muted-foreground text-center py-4 px-2">
              {emptyHint ??
                'Add fields from the right, or leave empty to show every field.'}
            </p>
          ) : (
            selected.map((path, i) => {
              const meta = fieldByPath.get(path)
              const isCustom = !meta
              return (
                <div
                  key={path}
                  draggable
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => {
                    e.preventDefault()
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragIndex === null) return
                    move(dragIndex, i)
                    setDragIndex(null)
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  className={
                    'group flex items-center gap-1.5 px-1.5 py-1 rounded-md border cursor-grab active:cursor-grabbing bg-background hover:bg-accent/40 ' +
                    (dragIndex === i ? 'opacity-40 ring-1 ring-primary' : 'border-transparent')
                  }
                  title={t('dataLink.dragToReorder', { defaultValue: 'Drag to reorder' })}
                >
                  <GripVertical
                    size={14}
                    className="text-muted-foreground/60 shrink-0"
                    aria-hidden
                  />
                  <span className="text-[10px] text-muted-foreground/70 tabular-nums w-4 text-end shrink-0">
                    {i + 1}
                  </span>
                  {/* Path column caps at ~45% so long paths don't push
                      the value off; short paths hug their content and
                      let the value fill the remainder. */}
                  <span className="text-[12px] font-mono truncate max-w-[45%] shrink-0">
                    {path}
                  </span>
                  {isCustom && (
                    <span
                      className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 shrink-0"
                      title="Custom path — not detected in sample"
                    >
                      !
                    </span>
                  )}
                  {meta && (
                    <span className="text-[11px] text-muted-foreground flex-1 min-w-0 truncate text-end hidden sm:inline">
                      {previewValue(meta)}
                    </span>
                  )}
                  {!meta && <span className="flex-1" />}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                    <button
                      type="button"
                      onClick={() => move(i, i - 1)}
                      disabled={i === 0}
                      className="w-6 h-6 flex items-center justify-center rounded hover:bg-accent disabled:opacity-30"
                      aria-label={t('dataLink.moveUp', { defaultValue: 'Move up' })}
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, i + 1)}
                      disabled={i === selected.length - 1}
                      className="w-6 h-6 flex items-center justify-center rounded hover:bg-accent disabled:opacity-30"
                      aria-label={t('dataLink.moveDown', { defaultValue: 'Move down' })}
                    >
                      <ChevronDown size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                      aria-label="Remove"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* RIGHT — palette + custom */}
      <div className="border border-border rounded-md flex flex-col min-h-[260px]">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border/60 bg-muted/30 rounded-t-md">
          <div className="text-[11px] font-semibold uppercase tracking-wider">
            Available fields
            <span className="ms-1 font-normal text-muted-foreground">
              ({availableFiltered.length})
            </span>
          </div>
          {leafFields.length > 0 && (
            <button
              type="button"
              onClick={selectAll}
              className="text-[11px] text-muted-foreground hover:text-primary underline"
            >
              add all
            </button>
          )}
        </div>
        <div className="p-1.5 border-b border-border/60">
          <div className="relative">
            <Search
              size={11}
              className="absolute start-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search fields…"
              className="h-8 w-full rounded-md border bg-background ps-6 pe-2 text-sm"
            />
          </div>
        </div>
        <div className="flex-1 max-h-56 overflow-y-auto p-1.5 grid gap-0.5">
          {leafFields.length === 0 ? (
            <p className="text-[11px] text-muted-foreground text-center py-4 px-2">
              No sample fields detected. Add a custom path below.
            </p>
          ) : availableFiltered.length === 0 ? (
            <p className="text-[11px] text-muted-foreground text-center py-4 px-2">
              {query
                ? 'No matches.'
                : 'Every detected field is already in your view.'}
            </p>
          ) : (
            availableFiltered.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => add(f.path)}
                className="flex items-center gap-1.5 px-1.5 py-1 rounded-md hover:bg-accent/40 text-start"
              >
                <Plus size={12} className="text-primary shrink-0" />
                <span className="text-[12px] font-mono truncate max-w-[45%] shrink-0">
                  {f.path}
                </span>
                <span className="text-[11px] text-muted-foreground flex-1 min-w-0 truncate text-end">
                  {previewValue(f)}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 shrink-0 ms-1">
                  {f.type}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="p-1.5 border-t border-border/60 flex gap-1.5">
          <input
            type="text"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitCustom()
              }
            }}
            placeholder="custom path (e.g. custom.temp)"
            className="h-8 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm font-mono"
          />
          <button
            type="button"
            onClick={commitCustom}
            disabled={!customPath.trim()}
            className="h-8 px-3 rounded-md border text-xs hover:bg-accent disabled:opacity-40"
          >
            add
          </button>
        </div>
      </div>
    </div>
  )
})

// -------------------------------------------- TooltipTemplatePreview

const TooltipTemplatePreview = memo(function TooltipTemplatePreview({
  template,
  sample,
}: {
  template: string
  sample: Record<string, unknown> | null
}) {
  if (!template.trim()) return null
  const rendered = sample
    ? resolveLabelTemplate(template, sample)
    : template
  return (
    <div className="mt-1 border border-border rounded-md bg-muted/30 p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        Preview {sample ? '(from sample)' : '(no sample)'}
      </div>
      <pre className="text-[12px] whitespace-pre-wrap font-sans">
        {rendered || <span className="text-muted-foreground">(empty)</span>}
      </pre>
    </div>
  )
})

// ================================================================
// Main dialog
// ================================================================

export interface DataLinkEditorV3DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  zoneId: number
  existing?: DataLinkConfig | null
  onSaved?: () => void
}

export function DataLinkEditorV3Dialog({
  open,
  onOpenChange,
  zoneId,
  existing,
  onSaved,
}: DataLinkEditorV3DialogProps) {
  const { t } = useTranslation()

  // ---- identity + source
  const [name, setName] = useState(existing?.name ?? '')
  const [sourceId, setSourceId] = useState<number | null>(
    existing?.sourceId ?? null,
  )
  // Preserve the legacy stream id from `existing` — old configs bind to
  // a Stream directly. v3-created configs bind to a DataSource; the
  // effective streamId is looked up below from the mirror Stream
  // (created automatically when the source was set up).
  const [legacyStreamId] = useState<number | null>(
    existing?.streamId && existing.streamId > 0 ? existing.streamId : null,
  )

  // Sources + Streams — used both for the picker labels AND to resolve
  // the mirror stream id for the picked source. Every data source that
  // was created through /integrations has an accompanying Stream row
  // whose `dataSourceId` points back at the source. The backend
  // requires `streamId` on data_link_configs (FK NOT NULL) so we must
  // resolve one before saving.
  const tenantIdForCache = useCurrentTenantId()
  const sourcesQuery = useApiQuery(
    () => apiDb.dataSources.toArray(),
    ['data-sources', tenantIdForCache, 'data-link-editor-v3'],
    { intervalMs: 0 },
  )
  // Only offer sources bound to this warehouse (plus unscoped
  // tenant-global sources). Without this filter, the picker showed
  // every source in the tenant — a user editing Airport would see
  // Hospital's sources and could accidentally link warehouse-crossing
  // data. Same scoping rule as `DataSourcesSection` for consistency.
  const scopedSources = useMemo(
    () =>
      (sourcesQuery.data ?? []).filter((s) => {
        if (s.zoneId === undefined || s.zoneId === null) return true
        return s.zoneId === zoneId
      }),
    [sourcesQuery.data, zoneId],
  )
  const streamsQuery = useApiQuery(
    () => apiDb.streams.toArray(),
    ['streams', tenantIdForCache, 'data-link-editor-v3'],
    { intervalMs: 0 },
  )
  const sourceObj = useMemo(
    () =>
      sourceId === null
        ? null
        : (sourcesQuery.data ?? []).find((s) => s.id === sourceId) ?? null,
    [sourceId, sourcesQuery.data],
  )
  const resolvedStreamId = useMemo(() => {
    if (sourceId !== null) {
      const s = (streamsQuery.data ?? []).find(
        (x) => x.dataSourceId === sourceId,
      )
      if (s?.id) return s.id
    }
    return legacyStreamId
  }, [sourceId, streamsQuery.data, legacyStreamId])

  // Tables are created inside the platform and push rows straight into
  // `data_source_rows`, so they never get a mirror stream — a missing
  // `resolvedStreamId` is expected here, not a misconfiguration.
  const sourceIsTable = sourceObj?.kind === 'table'
  const streamMissing = resolvedStreamId === null

  // ---- render mode
  const [renderMode, setRenderMode] = useState<DataLinkRenderMode>(
    existing?.renderMode ?? 'point-at-coord',
  )
  const caps = MODE_CAPS[renderMode]

  // ---- match
  const initialMatch: DataLinkMatch =
    existing?.fieldMapping.match ??
    (existing?.targetShapeId
      ? { mode: 'explicit-shape' }
      : { mode: 'coord' })
  const [matchMode, setMatchMode] = useState<DataLinkMatchMode>(
    initialMatch.mode === 'coord' && caps.needsShape
      ? 'explicit-shape'
      : initialMatch.mode,
  )
  const [targetKind, setTargetKind] = useState<DataLinkConfig['targetKind']>(
    existing?.targetKind ?? 'polygon',
  )
  const [targetShapeId, setTargetShapeId] = useState<number | null>(
    existing?.targetShapeId ?? null,
  )
  const [joinPayloadField, setJoinPayloadField] = useState<string>(
    initialMatch.join?.payloadField ??
      (initialMatch.mode === 'external-code' ? 'external_code' : ''),
  )
  const [joinShapeFieldSource, setJoinShapeFieldSource] = useState<
    NonNullable<DataLinkMatch['join']>['shapeFieldSource']
  >(initialMatch.join?.shapeFieldSource ?? 'name')
  const [joinShapeField, setJoinShapeField] = useState<string>(
    initialMatch.join?.shapeField ?? '',
  )

  // ---- field mapping
  const [lngField, setLngField] = useState(
    existing?.fieldMapping.coordFields?.lng ?? 'lng',
  )
  const [latField, setLatField] = useState(
    existing?.fieldMapping.coordFields?.lat ?? 'lat',
  )
  const [labelField, setLabelField] = useState(
    existing?.fieldMapping.labelField ?? '',
  )
  const [tooltipFields, setTooltipFields] = useState<string[]>(
    existing?.tooltip.fields ?? existing?.fieldMapping.tooltipFields ?? [],
  )
  // v5.3 — elevation is a discriminated spec (field / static / rules).
  // Configs written before v5.3 only had `elevationField` (string) —
  // we hydrate that here as an equivalent Field-mode spec so the
  // editor never shows an empty control for a config that had one.
  const [elevation, setElevation] = useState<
    ElevationSpec | undefined
  >(() => {
    if (existing?.fieldMapping.elevation) return existing.fieldMapping.elevation
    if (existing?.fieldMapping.elevationField) {
      return { kind: 'field', field: existing.fieldMapping.elevationField }
    }
    return undefined
  })
  const [clusterGroupField, setClusterGroupField] = useState(
    existing?.fieldMapping.clusterGroupField ?? '',
  )

  // ---- floor scope
  // Which floor plan(s) the config renders on. `auto` (default) keeps
  // the legacy behaviour — floor is read from the payload
  // (`floorPlanId | floorId | floor`) or the matched shape's own floor.
  // `specific` pins the config to a user-picked set of floor plans and
  // ignores the payload floor entirely — useful when the data source
  // carries stale ids (e.g. a floor plan that was deleted + re-added).
  // `all` disables the floor gate so the entities render on every
  // floor. See `passesFloorScope` in `filter-evaluator.ts` for the
  // runtime.
  const [floorScopeMode, setFloorScopeMode] = useState<
    'auto' | 'all' | 'specific'
  >(existing?.fieldMapping.floorScope?.mode ?? 'auto')
  const [floorScopeIds, setFloorScopeIds] = useState<number[]>(
    existing?.fieldMapping.floorScope?.floorPlanIds ?? [],
  )
  // v5.5 — optional "From record" mapping. `floorScopeField` picks the
  // payload path to read; `floorScopeMap` maps its text values to real
  // floor plan ids. Empty state is the classic "read a numeric
  // floorPlanId / floorId / floor" path so old configs stay unchanged.
  const [floorScopeField, setFloorScopeField] = useState<string>(
    existing?.fieldMapping.floorScope?.field ?? '',
  )
  const [floorScopeMap, setFloorScopeMap] = useState<
    Array<{ value: string; floorPlanId: number | null }>
  >(
    (existing?.fieldMapping.floorScope?.valueMap ?? []).map((row) => ({
      value: row.value ?? '',
      floorPlanId: row.floorPlanId ?? null,
    })),
  )

  // v5.5 — style-rule bindings. The overlay evaluates rules per entity
  // via `evaluateEntityRules(styleRules, config.styleRuleIds, payload)`
  // so a rule stays inert until its id is on the layer. Previously the
  // editor persisted the array as `existing?.styleRuleIds ?? []` with
  // no UI to change it — new configs always shipped with an empty list,
  // meaning even freshly-seeded rules paint nothing.
  const [styleRuleIds, setStyleRuleIds] = useState<number[]>(
    existing?.styleRuleIds ?? [],
  )

  // ---- saved report filters. Authored here, consumed as chips in the
  // viewer — see `filter-presets-section.tsx` for why the viewer can no
  // longer build its own trees.
  const [filterPresets, setFilterPresets] = useState<DataLinkFilterPreset[]>(
    existing?.fieldMapping.filters ?? [],
  )

  // ---- style
  const [defaultIcon, setDefaultIcon] = useState(
    existing?.style.defaultIcon ?? 'map-pin',
  )
  const [defaultColor, setDefaultColor] = useState(
    existing?.style.defaultColor ?? '#3b82f6',
  )
  const [iconColor, setIconColor] = useState(
    existing?.style.iconColor ?? '#ffffff',
  )
  const [cluster, setCluster] = useState(existing?.style.cluster ?? true)
  const [clusterRadius, setClusterRadius] = useState<number>(
    existing?.style.clusterRadius ?? 22,
  )
  // v4 — per-mode style knobs. Init from the config; the default of
  // `undefined` (rather than a fallback number) means "not persisted"
  // and lets the overlay use its own fallback. The state uses number
  // with a sensible starting value so the slider always has something
  // to render, and buildPayload persists only when the user actually
  // moved it — see `resetKnobIfDefault` guards below.
  const [iconSize, setIconSize] = useState<number>(
    existing?.style.iconSize ?? 0.7,
  )
  const [markerSize, setMarkerSize] = useState<number>(
    existing?.style.markerSize ?? (renderMode === 'point-on-shape' ? 11 : 22),
  )
  const [badgeSize, setBadgeSize] = useState<number>(
    existing?.style.badgeSize ?? 18,
  )
  const [lineWidth, setLineWidth] = useState<number>(
    existing?.style.lineWidth ?? 3,
  )
  const [fillOpacity, setFillOpacity] = useState<number>(
    existing?.style.fillOpacity ?? (renderMode === 'fov-cone' ? 0.3 : 0.5),
  )
  const [outlineWidth, setOutlineWidth] = useState<number>(
    existing?.style.outlineWidth ?? 1.5,
  )
  const [heatmapRadius, setHeatmapRadius] = useState<number>(
    existing?.style.heatmapRadius ?? 40,
  )
  const [heatmapIntensity, setHeatmapIntensity] = useState<number>(
    existing?.style.heatmapIntensity ?? 1,
  )
  const [heatmapSource, setHeatmapSource] = useState<'live' | 'history'>(
    existing?.style.heatmapSource ?? 'live',
  )
  const [heatmapWindowSec, setHeatmapWindowSec] = useState<number>(
    existing?.style.heatmapWindowSec ?? 86_400,
  )

  // ---- tooltip (map hover / click popup)
  const [tooltipTrigger, setTooltipTrigger] = useState<
    DataLinkTooltip['trigger']
  >(existing?.tooltip.trigger ?? 'hover')
  const [tooltipTemplate, setTooltipTemplate] = useState<string>(
    existing?.tooltip.template ?? '',
  )
  const [onClickKind, setOnClickKind] = useState<
    NonNullable<DataLinkTooltip['onClick']>['kind']
  >(existing?.tooltip.onClick?.kind ?? 'open-panel')
  const [onClickUrl, setOnClickUrl] = useState<string>(
    existing?.tooltip.onClick?.url ?? '',
  )
  const [onClickEvent, setOnClickEvent] = useState<string>(
    existing?.tooltip.onClick?.event ?? 'dl:click',
  )
  // ---- content viewer (sidebar drawer)
  const [panelFields, setPanelFields] = useState<string[]>(
    existing?.tooltip.panel?.fields ?? [],
  )
  const [panelTemplate, setPanelTemplate] = useState<string>(
    existing?.tooltip.panel?.template ?? '',
  )

  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ---- sample
  const {
    fields,
    sample,
    loading,
    error: sampleError,
    empty,
    refetch: refetchSample,
  } = useSourceSample(sourceId)

  // ---- ingest-now (kicks off a source rerun when the sample is empty)
  const [ingesting, setIngesting] = useState(false)
  const [ingestError, setIngestError] = useState<string | null>(null)
  const [ingestResult, setIngestResult] = useState<string | null>(null)
  const handleIngestNow = useCallback(async () => {
    if (!sourceObj) {
      setIngestError('Source not loaded yet — please retry in a moment.')
      return
    }
    setIngesting(true)
    setIngestError(null)
    setIngestResult(null)
    try {
      const summary = await rerunDataSource(sourceObj)
      setIngestResult(
        `Ingested ${summary.rowsImported} of ${summary.rowsRead} record${
          summary.rowsRead === 1 ? '' : 's'
        }.`,
      )
      refetchSample()
    } catch (err) {
      const msg =
        err instanceof RerunError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      setIngestError(msg)
    } finally {
      setIngesting(false)
    }
  }, [sourceObj, refetchSample])

  // ---- shape catalog (for explicit-shape picker)
  const { data: polygons } = useSpatialPolygons()
  const { data: circles } = useSpatialCircles()
  const { data: markers } = useSpatialMarkers()
  const { data: lines } = useSpatialLines()
  const { data: models } = useSpatialModels()
  const { data: images } = useSpatialImages()
  const { data: allStyleRules } = useSpatialStyleRules()
  // Rules scoped to the active zone (matches how the /view overlay
  // filters — only zone-scoped rules can affect this warehouse's map).
  // Sorted by priority so the checklist reads in the same order rules
  // fire in.
  const zoneStyleRules = useMemo(
    () =>
      (allStyleRules ?? [])
        .filter((r) => (r.zoneId ?? null) === (zoneId ?? null))
        .sort((a, b) => a.priority - b.priority),
    [allStyleRules, zoneId],
  )
  // Floor plans in this warehouse — the checkbox list for the Floor
  // scope section. Sorted by id (same order as the /view floor
  // switcher) so users see a stable list.
  const floorPlanOptions = useMemo(
    () =>
      (images ?? [])
        .filter(
          (img): img is typeof img & { id: number } => img.id !== undefined,
        )
        .filter((img) => img.zoneId === zoneId)
        .sort((a, b) => a.id - b.id)
        .map((img) => ({ id: img.id, name: img.name })),
    [images, zoneId],
  )
  // Drop any picked ids that no longer resolve to a live floor plan
  // (e.g. the user picked floor 6, then the warehouse admin deleted
  // floor 6). Keeps the payload from carrying dead ids into save.
  useEffect(() => {
    if (floorScopeIds.length === 0) return
    const live = new Set(floorPlanOptions.map((f) => f.id))
    const filtered = floorScopeIds.filter((id) => live.has(id))
    if (filtered.length !== floorScopeIds.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFloorScopeIds(filtered)
    }
  }, [floorPlanOptions, floorScopeIds])
  const shapeOptions = useMemo(() => {
    const scoped = <T extends { id?: number; zoneId?: number; name: string }>(
      arr: readonly T[] | undefined,
    ): T[] =>
      (arr ?? []).filter((s) => s.zoneId === zoneId && s.id !== undefined)
    switch (targetKind) {
      case 'polygon':
        return scoped(polygons).map((s) => ({ id: s.id!, name: s.name }))
      case 'circle':
        return scoped(circles).map((s) => ({ id: s.id!, name: s.name }))
      case 'marker':
        return scoped(markers).map((s) => ({ id: s.id!, name: s.name }))
      case 'line':
        return scoped(lines).map((s) => ({ id: s.id!, name: s.name }))
      case 'model':
        return scoped(models).map((s) => ({ id: s.id!, name: s.name }))
      default:
        return []
    }
  }, [targetKind, zoneId, polygons, circles, markers, lines, models])

  // ---- auto-suggest coord + label when the sample loads and the user
  // hasn't typed anything meaningful yet. Runs once per sample change.
  useEffect(() => {
    if (fields.length === 0) return
    if (caps.needsCoords) {
      if (lngField === 'lng' || lngField === '') {
        const guess = suggestField(
          fields,
          [/^lng$/i, /^longitude$/i, /^lon$/i, /position\[0\]/i, /coord.*\[0\]/i],
          true,
        )
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (guess) setLngField(guess)
      }
      if (latField === 'lat' || latField === '') {
        const guess = suggestField(
          fields,
          [/^lat$/i, /^latitude$/i, /position\[1\]/i, /coord.*\[1\]/i],
          true,
        )
        if (guess) setLatField(guess)
      }
    }
    if (caps.usesLabel && !labelField) {
      const guess = suggestField(fields, [
        /^label$/i,
        /^name$/i,
        /^title$/i,
        /^id$/i,
      ])
      if (guess) setLabelField(guess)
    }
    // Intentionally do NOT auto-set values the user might have typed
    // manually; the empty-string check above guards that.

  }, [fields, caps.needsCoords, caps.usesLabel])

  // ---- adjust match mode when render mode changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!caps.needsShape && matchMode !== 'coord') setMatchMode('coord')
    if (caps.needsShape && matchMode === 'coord') setMatchMode('explicit-shape')

  }, [renderMode])

  const matchComplete = (() => {
    if (!caps.needsShape) {
      if (!caps.needsCoords) return true
      return lngField.trim().length > 0 && latField.trim().length > 0
    }
    switch (matchMode) {
      case 'explicit-shape':
        return targetShapeId !== null
      case 'attribute-join':
        if (!joinPayloadField.trim()) return false
        if (joinShapeFieldSource === 'bin.customProp' && !joinShapeField.trim())
          return false
        return true
      case 'external-code':
        return joinPayloadField.trim().length > 0
      case 'coord':
        return lngField.trim().length > 0 && latField.trim().length > 0
      default:
        return false
    }
  })()

  // Save gate. `streamId` used to be required, but v3 flipped the source of
  // truth from Stream → DataSource: a layer with `sourceId` set renders
  // entirely from `data_source_rows` (see fetchLayerRows), and migration 0034
  // made `data_link_configs.stream_id` nullable to match. Only require ONE of
  // the two so table-kind sources — which never have a stream — can be saved.
  // The exception is STREAM_ONLY_MODES, whose sub-renderer reads events.
  const canSave =
    name.trim().length > 0 &&
    (sourceId !== null || resolvedStreamId !== null) &&
    !(STREAM_ONLY_MODES.includes(renderMode) && streamMissing) &&
    matchComplete

  // Surfaced as the Save button's tooltip. A silently disabled Save is how the
  // stream-required regression above went unnoticed for so long.
  const saveBlockedReason = (() => {
    if (canSave) return undefined
    if (name.trim().length === 0)
      return t('dataLink.needName', { defaultValue: 'Give this layer a name.' })
    if (sourceId === null && resolvedStreamId === null)
      return t('dataLink.needSource', { defaultValue: 'Pick a data source.' })
    if (STREAM_ONLY_MODES.includes(renderMode) && streamMissing)
      return t('dataLink.modeNeedsStream', {
        defaultValue:
          'Needs an integration stream for its event history — not available for table sources.',
      })
    return t('dataLink.needMatch', {
      defaultValue:
        'Finish the matching step so each record knows where to land on the map.',
    })
  })()

  // ---- persist
  //
  // Strips no-op elevation specs — an empty rules list or a Field
  // mode with a blank path would otherwise persist and force the
  // resolver through a lookup for nothing. Returns undefined so the
  // saved config omits `elevation` entirely, matching the shape of
  // a config the user never touched.
  const normaliseElevation = (
    spec: ElevationSpec | undefined,
  ): ElevationSpec | undefined => {
    if (!spec) return undefined
    if (spec.kind === 'field') {
      const field = spec.field.trim()
      return field ? { kind: 'field', field } : undefined
    }
    if (spec.kind === 'static') {
      return Number.isFinite(spec.value) ? spec : undefined
    }
    // rules
    const rules = spec.rules.filter(
      (r) => r.field.trim() && Number.isFinite(r.value),
    )
    if (rules.length === 0 && spec.fallback === undefined) return undefined
    return {
      kind: 'rules',
      rules: rules.map((r) => ({
        field: r.field.trim(),
        op: r.op,
        match: r.match,
        value: r.value,
      })),
      fallback: spec.fallback,
    }
  }

  const buildPayload = useCallback((): Omit<DataLinkConfig, 'id'> => {
    const effectiveMatchMode: DataLinkMatchMode = caps.needsShape
      ? matchMode
      : 'coord'
    const match: DataLinkMatch = (() => {
      switch (effectiveMatchMode) {
        case 'coord':
          return { mode: 'coord' }
        case 'explicit-shape':
          return { mode: 'explicit-shape' }
        case 'attribute-join':
          return {
            mode: 'attribute-join',
            join: {
              payloadField: joinPayloadField.trim(),
              shapeFieldSource: joinShapeFieldSource,
              shapeField:
                joinShapeFieldSource === 'bin.customProp'
                  ? joinShapeField.trim() || undefined
                  : undefined,
            },
          }
        case 'external-code':
          return {
            mode: 'external-code',
            join: {
              payloadField: joinPayloadField.trim() || 'external_code',
              shapeFieldSource: 'bin.externalCode',
            },
          }
      }
    })()
    const usesPayloadCoords = effectiveMatchMode === 'coord'
    const fieldMapping: DataLinkFieldMapping = {
      labelField: labelField.trim() || undefined,
      coordFields:
        usesPayloadCoords && caps.needsCoords
          ? { lng: lngField.trim() || 'lng', lat: latField.trim() || 'lat' }
          : undefined,
      // v5.3 — the elevation spec supersedes the legacy path string.
      // On save we always emit the new key and drop the legacy one, so
      // pre-v5.3 configs migrate transparently the first time they're
      // opened + saved.
      elevation: caps.usesElevation ? normaliseElevation(elevation) : undefined,
      elevationField: undefined,
      clusterGroupField:
        caps.usesClusterGroup && clusterGroupField.trim()
          ? clusterGroupField.trim()
          : undefined,
      tooltipFields: tooltipFields.length > 0 ? tooltipFields : undefined,
      match,
      floorScope: (() => {
        // Persist only when the user opted out of the default so old
        // configs stay identical on the wire. `auto` still writes a
        // payload when the user configured the v5.5 field → floor map;
        // otherwise it returns undefined (classic default path).
        if (floorScopeMode === 'auto') {
          const field = floorScopeField.trim()
          const rows = floorScopeMap
            .map((r) => ({
              value: (r.value ?? '').trim(),
              floorPlanId: r.floorPlanId,
            }))
            .filter(
              (r): r is { value: string; floorPlanId: number } =>
                r.value.length > 0 &&
                typeof r.floorPlanId === 'number' &&
                Number.isFinite(r.floorPlanId),
            )
          if (!field || rows.length === 0) return undefined
          return {
            mode: 'auto' as const,
            field,
            valueMap: rows,
          }
        }
        if (floorScopeMode === 'specific') {
          return {
            mode: 'specific' as const,
            floorPlanIds: [...floorScopeIds].sort((a, b) => a - b),
          }
        }
        return { mode: 'all' as const }
      })(),
      filters: filterPresets.length > 0 ? filterPresets : undefined,
    }
    const style: DataLinkStyle = {
      defaultIcon: caps.usesIcon ? defaultIcon || 'map-pin' : existing?.style.defaultIcon,
      defaultColor,
      iconColor: caps.usesIcon ? iconColor : existing?.style.iconColor,
      cluster: caps.usesCluster ? cluster : existing?.style.cluster,
      clusterRadius: caps.usesCluster && cluster ? clusterRadius : existing?.style.clusterRadius,
      iconLibrary: 'lucide',
      // v4 — persist only knobs the current mode actually consumes so
      // legacy configs don't accumulate stale sliders that don't match
      // their render mode.
      iconSize: caps.usesIconSize ? iconSize : existing?.style.iconSize,
      markerSize: caps.usesMarkerSize ? markerSize : existing?.style.markerSize,
      badgeSize: caps.usesBadgeSize ? badgeSize : existing?.style.badgeSize,
      lineWidth: caps.usesLineWidth ? lineWidth : existing?.style.lineWidth,
      fillOpacity: caps.usesFillOpacity ? fillOpacity : existing?.style.fillOpacity,
      outlineWidth: caps.usesOutlineWidth ? outlineWidth : existing?.style.outlineWidth,
      heatmapRadius: caps.usesHeatmapKnobs ? heatmapRadius : existing?.style.heatmapRadius,
      heatmapIntensity: caps.usesHeatmapKnobs ? heatmapIntensity : existing?.style.heatmapIntensity,
      heatmapSource:
        caps.usesHeatmapKnobs && sourceId !== null
          ? heatmapSource
          : existing?.style.heatmapSource,
      heatmapWindowSec:
        caps.usesHeatmapKnobs &&
        sourceId !== null &&
        heatmapSource === 'history'
          ? heatmapWindowSec
          : existing?.style.heatmapWindowSec,
    }
    const tooltip: DataLinkTooltip = {
      trigger: tooltipTrigger,
      fields: tooltipFields.length > 0 ? tooltipFields : undefined,
      template: tooltipTemplate.trim() || undefined,
      panel:
        panelFields.length > 0 || panelTemplate.trim()
          ? {
              fields: panelFields.length > 0 ? panelFields : undefined,
              template: panelTemplate.trim() || undefined,
            }
          : undefined,
      onClick: (() => {
        if (onClickKind === 'open-panel') return { kind: 'open-panel' }
        if (onClickKind === 'open-url')
          return {
            kind: 'open-url',
            url: onClickUrl.trim() || undefined,
          }
        return {
          kind: 'custom-event',
          event: onClickEvent.trim() || 'dl:click',
        }
      })(),
    }
    const now = new Date()
    return {
      zoneId,
      // 0 means "no stream", which the handler maps to NULL (migration 0034).
      // A DataSource created via /integrations has a mirror Stream we stamp
      // here; a table-kind source has none. Legacy configs (pre-v3) keep
      // their original stream id via `legacyStreamId`.
      streamId: resolvedStreamId ?? 0,
      sourceId: sourceId ?? undefined,
      name: name.trim(),
      // targetKind is `validate:"required"` on the backend — an empty
      // string here trips a 400 on save. Defensively: use the state
      // value if set; else fall back to the existing row's value; else
      // default to a valid kind based on the render mode's shape needs.
      targetKind: (() => {
        if (!caps.needsShape) return 'marker'
        const t = (targetKind ?? '').trim()
        if (t) return targetKind
        const prior = (existing?.targetKind ?? '').trim()
        if (prior) return existing!.targetKind
        return 'polygon'
      })(),
      targetShapeId:
        caps.needsShape &&
        matchMode === 'explicit-shape' &&
        targetShapeId !== null
          ? targetShapeId
          : undefined,
      renderMode,
      fieldMapping,
      style,
      tooltip,
      styleRuleIds: [...styleRuleIds].sort((a, b) => a - b),
      enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
  }, [
    zoneId,
    resolvedStreamId,
    sourceId,
    name,
    renderMode,
    caps,
    targetKind,
    targetShapeId,
    matchMode,
    joinPayloadField,
    joinShapeFieldSource,
    joinShapeField,
    lngField,
    latField,
    labelField,
    tooltipFields,
    elevation,
    clusterGroupField,
    floorScopeMode,
    floorScopeIds,
    floorScopeField,
    floorScopeMap,
    styleRuleIds,
    filterPresets,
    defaultIcon,
    defaultColor,
    iconColor,
    cluster,
    clusterRadius,
    iconSize,
    markerSize,
    badgeSize,
    lineWidth,
    fillOpacity,
    outlineWidth,
    heatmapRadius,
    heatmapIntensity,
    heatmapSource,
    heatmapWindowSec,
    tooltipTrigger,
    tooltipTemplate,
    panelFields,
    panelTemplate,
    onClickKind,
    onClickUrl,
    onClickEvent,
    enabled,
    existing,
  ])

  const handleSave = useCallback(async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      const payload = buildPayload()
      const store = useSpatialStore.getState()
      if (existing?.id !== undefined) {
        store.updateLocal('data-link-configs', existing.id, payload)
        // `commit(kind, id)` — the id is REQUIRED. `commit(kind)` bails
        // with an immediately-resolved promise (see spatial-store.ts:367),
        // which means we'd close the dialog before the debounced flush
        // actually fires the PATCH — and if the PATCH 400s the user
        // never sees the error. Always pass the id so we await the
        // real HTTP round-trip.
        await store.commit('data-link-configs', existing.id)
      } else {
        // createLocal returns a promise that only resolves after the
        // POST completes, so we do NOT also need to call commit — the
        // await here IS the network wait.
        await store.createLocal('data-link-configs', payload)
      }
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [buildPayload, canSave, existing, onOpenChange, onSaved])

  const handleDelete = useCallback(async () => {
    if (existing?.id === undefined) return
    if (
      !window.confirm(
        t('dataLink.confirmDelete', { defaultValue: 'Delete this data link?' }),
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const store = useSpatialStore.getState()
      store.deleteLocal('data-link-configs', existing.id)
      // Same commit-with-id contract as handleSave — see comment there.
      await store.commit('data-link-configs', existing.id)
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [existing, onOpenChange, onSaved, t])

  const stepCounter = { n: 0 }
  const nextStep = () => ++stepCounter.n

  // ---- left-rail TOC. The list is dynamic — Target only appears
  // when the render mode anchors to a shape; Tooltip + Content viewer
  // only when the mode surfaces on interaction. Keeping the list here
  // means the rail always mirrors what the form actually renders.
  const navItems = useMemo<NavItem[]>(() => {
    const items: NavItem[] = [
      { id: SECTION_IDS.name, label: 'Name', icon: Tag },
      { id: SECTION_IDS.source, label: 'Data source', icon: Database },
      { id: SECTION_IDS.mode, label: 'Display mode', icon: Layers },
    ]
    if (caps.needsShape) {
      items.push({ id: SECTION_IDS.target, label: 'Attach to shapes', icon: Target })
    }
    items.push({ id: SECTION_IDS.floors, label: 'Floor scope', icon: Layers3 })
    items.push({ id: SECTION_IDS.filters, label: 'Saved filters', icon: Filter })
    items.push({ id: SECTION_IDS.fields, label: 'Connect fields', icon: Link2 })
    items.push({ id: SECTION_IDS.style, label: 'Style', icon: Palette })
    items.push({ id: SECTION_IDS.styleRules, label: 'Style rules', icon: Palette })
    if (caps.usesTooltip) {
      items.push({ id: SECTION_IDS.tooltip, label: 'Map tooltip', icon: MessageSquare })
      items.push({ id: SECTION_IDS.panel, label: 'Content viewer', icon: Eye })
    }
    return items
  }, [caps.needsShape, caps.usesTooltip])
  const navIds = useMemo(() => navItems.map((i) => i.id), [navItems])

  // The scroll container ref — set by the middle body div. Passed to
  // both `useActiveSection` (observes children within this root) and
  // `SectionNav` (adjusts scrollTop on click).
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const activeId = useActiveSection(navIds, scrollRoot)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[90vw] max-w-none sm:max-w-none max-h-[92dvh] flex flex-col p-0 gap-0" aria-describedby={undefined}>
        {/* Sticky header — the fixed title/description strip. */}
        <div className="border-b px-6 py-4 shrink-0">
          <DialogTitle className="text-base font-semibold">
            {existing
              ? t('dataLink.editorEditTitle', { defaultValue: 'Edit data link' })
              : t('dataLink.editorAddTitle', { defaultValue: 'New data link' })}
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Bring records from a data source onto the map. Pick where the
            data comes from, how it should look, and which fields feed the
            visuals.
          </p>
        </div>

        {/* Body: [left rail | scrollable main]. The rail is a table of
            contents, NOT a wizard — clicking an item scrolls but never
            gates progress. The scrollable main is what
            `useActiveSection` observes to highlight the current rail
            item as the user scrolls. Actions live in the sticky footer
            below the whole body. */}
        <div className="flex-1 flex min-h-0">
          <aside className="hidden md:block w-56 shrink-0 border-e bg-muted/20 overflow-y-auto">
            <SectionNav
              items={navItems}
              activeId={activeId}
              scrollRoot={scrollRoot}
            />
          </aside>
          <div
            ref={setScrollRoot}
            className="flex-1 overflow-y-auto"
          >
        <div className="mx-auto w-full max-w-6xl px-6 py-4 grid gap-2">
          {/* 1 — Name */}
          <Section
            sectionId={SECTION_IDS.name}
            step={nextStep()}
            title={t('dataLink.step.nameTitle', { defaultValue: 'Name this link' })}
            hint={t('dataLink.step.nameHint', { defaultValue: 'Just a label for your team — appears in the manager and side panel.' })}
          >
            <div className="grid gap-1">
              <Input
                id="dl3-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Forklifts on ground floor"
              />
            </div>
          </Section>

          {/* 2 — Data source */}
          <Section
            sectionId={SECTION_IDS.source}
            step={nextStep()}
            title={t('dataLink.step.sourceTitle', { defaultValue: 'Pick a data source' })}
            hint={t('dataLink.step.sourceHint', { defaultValue: 'Where the records come from (CSV, REST, webhook, stream).' })}
          >
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <SourcePickerRow
                  value={sourceId}
                  onChange={setSourceId}
                  sources={scopedSources}
                />
              </div>
              <a
                href="/integrations"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-background hover:bg-accent/40 text-xs font-medium shrink-0 mt-[0px]"
                title="Open the Integrations screen in a new tab to add or edit data sources"
              >
                <Database size={13} />
                Manage sources
                <ExternalLink size={11} className="text-muted-foreground" />
              </a>
            </div>
            <SamplePreview
              loading={loading}
              error={sampleError}
              fields={fields}
              empty={empty}
              emptyHint={
                sourceIsTable
                  ? t('dataLink.tableEmptyHint', {
                      defaultValue:
                        'This table has no rows yet. Add rows from the Tables screen or push them via its API token — or type field paths by hand and the data will flow in later.',
                    })
                  : undefined
              }
              sourceSelected={sourceId !== null}
              // Re-running an ingest is meaningless for a table: rows are
              // pushed in, never pulled from an upstream endpoint.
              onIngestNow={
                sourceObj && !sourceIsTable ? handleIngestNow : undefined
              }
              ingesting={ingesting}
              ingestError={ingestError}
              ingestResult={ingestResult}
            />
            {sourceIsTable && (
              <div className="flex items-start gap-2 text-[11px] text-muted-foreground mt-1">
                <Database size={12} className="mt-0.5 shrink-0" />
                <span>
                  {t('dataLink.tableSourceNote', {
                    defaultValue:
                      'Rows are read straight from this table — no integration stream needed.',
                  })}
                </span>
              </div>
            )}
            {sourceId !== null && streamMissing && !sourceIsTable && (
              <div className="flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-400 border border-amber-500/30 rounded-md p-2 mt-1">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <span>
                  {t('dataLink.missingStream', {
                    defaultValue:
                      "Couldn't find the mirror stream for this source. Reload the page, or recreate the source from Integrations — it should create a Stream row automatically.",
                  })}
                </span>
              </div>
            )}
          </Section>

          {/* 3 — Render mode */}
          <Section
            sectionId={SECTION_IDS.mode}
            step={nextStep()}
            title="Choose how it looks on the map"
            hint="Different modes need different fields — the sections below adapt."
          >
            <RenderModeGrid
              value={renderMode}
              onChange={setRenderMode}
              disabledModes={
                sourceIsTable
                  ? NO_DISABLED_MODES
                  : streamMissing
                  ? DISABLED_MODES_NO_STREAM_OR_TABLE
                  : DISABLED_MODES_NO_TABLE
              }
              disabledHint={
                streamMissing
                  ? (t('dataLink.modeNeedsStreamOrTable', {
                      defaultValue:
                        'Track needs a stream; History player needs a table source.',
                    }) as string)
                  : (t('dataLink.modeNeedsTable', {
                      defaultValue:
                        'History player only works on table sources (they carry the change log).',
                    }) as string)
              }
            />
          </Section>

          {/* 4 — Bind to shapes (only for shape-anchored modes) */}
          {caps.needsShape && (
            <Section
              sectionId={SECTION_IDS.target}
              step={nextStep()}
              title="Attach to which shapes?"
              hint="How each record finds the shape it should render on."
            >
              <div className="grid gap-1">
                <LabelWithInfo
                  htmlFor="dl3-kind"
                  info="Restricts the match to shapes of this kind. Attribute-join scans all shapes of the chosen kind."
                >
                  Shape kind
                </LabelWithInfo>
                <select
                  id="dl3-kind"
                  value={targetKind}
                  onChange={(e) => {
                    setTargetKind(
                      e.target.value as DataLinkConfig['targetKind'],
                    )
                    setTargetShapeId(null)
                  }}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {SHAPE_TARGET_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-2">
                <MatchModeCards value={matchMode} onChange={setMatchMode} />
              </div>

              {matchMode === 'explicit-shape' && (
                <div className="grid gap-1 mt-2">
                  <LabelWithInfo
                    htmlFor="dl3-shape"
                    info="Every record from this source renders on this one shape."
                  >
                    Shape
                  </LabelWithInfo>
                  <select
                    id="dl3-shape"
                    value={targetShapeId ?? ''}
                    onChange={(e) =>
                      setTargetShapeId(
                        e.target.value ? Number(e.target.value) : null,
                      )
                    }
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="">— select a shape —</option>
                    {shapeOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  {shapeOptions.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      No {targetKind}s in this warehouse yet.
                    </p>
                  )}
                </div>
              )}

              {matchMode === 'attribute-join' && (
                <div className="grid gap-2 mt-2">
                  <div className="grid gap-1">
                    <LabelWithInfo
                      htmlFor="dl3-join-payload"
                      info="Payload field whose value we compare (e.g. 'room' → 'Room-A12')."
                    >
                      Payload field
                    </LabelWithInfo>
                    <FieldPicker
                      id="dl3-join-payload"
                      value={joinPayloadField}
                      onChange={setJoinPayloadField}
                      fields={fields}
                      loading={loading}
                      placeholder="e.g. room"
                    />
                  </div>
                  <div className="grid gap-1">
                    <LabelWithInfo
                      htmlFor="dl3-join-source"
                      info="Which piece of the shape/bin we compare against."
                    >
                      Compare against
                    </LabelWithInfo>
                    <select
                      id="dl3-join-source"
                      value={joinShapeFieldSource}
                      onChange={(e) =>
                        setJoinShapeFieldSource(
                          e.target.value as typeof joinShapeFieldSource,
                        )
                      }
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="name">Shape name</option>
                      <option value="role">Shape role (polygon / circle)</option>
                      <option value="bin.externalCode">Bin external code</option>
                      <option value="bin.customProp">Bin custom property</option>
                    </select>
                  </div>
                  {joinShapeFieldSource === 'bin.customProp' && (
                    <div className="grid gap-1">
                      <LabelWithInfo
                        htmlFor="dl3-join-key"
                        info="Custom-property key on the bin. Both sides normalise to alphanumeric-lowercase before matching."
                      >
                        Custom key
                      </LabelWithInfo>
                      <Input
                        id="dl3-join-key"
                        value={joinShapeField}
                        onChange={(e) => setJoinShapeField(e.target.value)}
                        placeholder="e.g. room_name"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Records that match multiple shapes render on all of
                    them.
                  </p>
                </div>
              )}

              {matchMode === 'external-code' && (
                <div className="grid gap-1 mt-2">
                  <LabelWithInfo
                    htmlFor="dl3-ec-field"
                    info="Payload field carrying the external code. Compared to bin.externalCode."
                  >
                    Payload field
                  </LabelWithInfo>
                  <FieldPicker
                    id="dl3-ec-field"
                    value={joinPayloadField}
                    onChange={setJoinPayloadField}
                    fields={fields}
                    loading={loading}
                    placeholder="external_code"
                  />
                </div>
              )}
            </Section>
          )}

          {/* Floor scope — which floor(s) the layer renders on.
              Sits between the shape target and field mapping since it's
              a *where does this go* decision, not a *what fields feed
              it* one. Universal to every render mode: even shape-tint
              can benefit from pinning to specific floors when the shape
              itself lives on multiple. */}
          <Section
            sectionId={SECTION_IDS.floors}
            step={nextStep()}
            title="Which floors?"
            hint="Pick where this layer shows up. Defaults to reading the floor from each record; override when the data is missing or wrong."
          >
            <div
              role="radiogroup"
              aria-label="Floor scope mode"
              className="grid gap-2 sm:grid-cols-3"
            >
              {(
                [
                  {
                    id: 'auto',
                    label: 'From record',
                    hint: 'Read the floor from each record. Records with unknown or deleted floors still render on every floor.',
                  },
                  {
                    id: 'specific',
                    label: 'Specific floors',
                    hint: 'Show this layer only on the floors you pick — ignores whatever floor the record claims.',
                  },
                  {
                    id: 'all',
                    label: 'All floors',
                    hint: 'Always render regardless of the active floor.',
                  },
                ] as const
              ).map((opt) => {
                const selected = floorScopeMode === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setFloorScopeMode(opt.id)}
                    className={
                      'text-left rounded-md border px-3 py-2 transition-colors ' +
                      (selected
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-background hover:bg-accent/40')
                    }
                  >
                    <div className="text-sm font-medium">{opt.label}</div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {opt.hint}
                    </p>
                  </button>
                )
              })}
            </div>

            {floorScopeMode === 'auto' && (
              <div className="mt-3 grid gap-2">
                <LabelWithInfo
                  htmlFor="dl3-floor-scope-field"
                  info="Optional. Pick a payload field to read the floor from (e.g. floor_name). If the value is a text label like 'F1', map each value to a real floor plan below. Leave empty to use the classic floorPlanId / floorId / floor chain."
                >
                  Field to read the floor from
                </LabelWithInfo>
                <FieldPicker
                  id="dl3-floor-scope-field"
                  value={floorScopeField}
                  onChange={setFloorScopeField}
                  fields={fields}
                  loading={loading}
                  placeholder="floor_name"
                />
                {floorScopeField.trim().length > 0 && (
                  <div className="grid gap-2">
                    <LabelWithInfo
                      htmlFor="dl3-floor-scope-map"
                      info="Map each value your records carry to a real floor plan. Case-insensitive text match; unmapped values fall through to the classic floor chain and then to 'unknown' (renders on every floor)."
                    >
                      Value → floor
                    </LabelWithInfo>
                    {floorPlanOptions.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground border border-dashed rounded-md p-2">
                        No floor plans in this warehouse yet. Add one from the
                        editor's Images tool first.
                      </p>
                    ) : (
                      <div id="dl3-floor-scope-map" className="grid gap-1">
                        {floorScopeMap.length === 0 && (
                          <p className="text-[11px] text-muted-foreground italic">
                            No mappings yet — click "Add row" to bind a value.
                          </p>
                        )}
                        {floorScopeMap.map((row, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-1.5"
                          >
                            <Input
                              value={row.value}
                              onChange={(e) => {
                                const v = e.target.value
                                setFloorScopeMap((prev) => {
                                  const next = [...prev]
                                  next[i] = { ...next[i], value: v }
                                  return next
                                })
                              }}
                              placeholder="F1"
                              className="h-8 text-xs flex-1 min-w-0"
                            />
                            <span className="text-[11px] text-muted-foreground shrink-0">→</span>
                            <select
                              value={row.floorPlanId ?? ''}
                              onChange={(e) => {
                                const raw = e.target.value
                                const id = raw === '' ? null : Number(raw)
                                setFloorScopeMap((prev) => {
                                  const next = [...prev]
                                  next[i] = { ...next[i], floorPlanId: id }
                                  return next
                                })
                              }}
                              className="h-8 text-xs rounded-md border border-input bg-background px-2 flex-1 min-w-0"
                            >
                              <option value="">Pick floor…</option>
                              {floorPlanOptions.map((fp) => (
                                <option key={fp.id} value={fp.id}>
                                  {fp.name} · #{fp.id}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() =>
                                setFloorScopeMap((prev) =>
                                  prev.filter((_, j) => j !== i),
                                )
                              }
                              className="h-8 w-8 shrink-0 rounded-md border border-input text-muted-foreground hover:text-foreground hover:bg-accent/40"
                              aria-label="Remove mapping row"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() =>
                            setFloorScopeMap((prev) => [
                              ...prev,
                              { value: '', floorPlanId: null },
                            ])
                          }
                          className="mt-1 self-start text-[11px] rounded-md border border-input px-2 py-1 hover:bg-accent/40"
                        >
                          + Add row
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {floorScopeMode === 'specific' && (
              <div className="mt-3 grid gap-2">
                <LabelWithInfo
                  htmlFor="dl3-floor-scope-list"
                  info="Records show up only when the viewer's active floor is one of these. Leave empty to hide the layer everywhere."
                >
                  Floors this layer belongs to
                </LabelWithInfo>
                {floorPlanOptions.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground border border-dashed rounded-md p-2">
                    No floor plans in this warehouse yet. Add one from the
                    editor's Images tool first.
                  </p>
                ) : (
                  <div
                    id="dl3-floor-scope-list"
                    className="grid gap-1 border rounded-md p-2 max-h-56 overflow-y-auto"
                  >
                    {floorPlanOptions.map((fp) => {
                      const checked = floorScopeIds.includes(fp.id)
                      return (
                        <label
                          key={fp.id}
                          className="flex items-center gap-2 text-sm px-1 py-0.5 rounded hover:bg-accent/40 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setFloorScopeIds((prev) => {
                                if (e.target.checked) {
                                  return prev.includes(fp.id)
                                    ? prev
                                    : [...prev, fp.id]
                                }
                                return prev.filter((x) => x !== fp.id)
                              })
                            }}
                          />
                          <span className="flex-1">{fp.name}</span>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            #{fp.id}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Elevation still comes from the record's{' '}
                  <code>elevation</code> field (mapped in the next section) when
                  set — otherwise the layer sits at ground level.
                </p>
              </div>
            )}
          </Section>

          {/* Saved report filters. Authored here rather than in the
              viewer so a shared link that says "Overdue" always means
              the same rule for everyone who opens it. */}
          <Section
            sectionId={SECTION_IDS.filters}
            step={nextStep()}
            title="Saved filters"
            hint="Publish named slices of this data — viewers pick one with a click instead of building their own conditions."
          >
            <FilterPresetsSection
              sourceId={sourceId}
              value={filterPresets}
              onChange={setFilterPresets}
            />
          </Section>

          {/* 5 — Field mapping (per render mode) */}
          <Section
            sectionId={SECTION_IDS.fields}
            step={nextStep()}
            title="Connect fields"
            hint="Tell the map which values in the record power each visual."
          >
            {/* Every visible field renders as one cell in a 3-col grid.
                Previously each field stacked full-width, which — at
                90vw — meant the input alone was 1200 px wide with the
                "pick" link stranded at the right edge. The grid now
                keeps each control at a sensible working width. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {caps.needsCoords && (
                <>
                  <div className="grid gap-1">
                    <LabelWithInfo
                      htmlFor="dl3-lng"
                      info="Field with the longitude. Auto-detected as `lng`, `longitude`, or `position[0]`."
                    >
                      Longitude
                    </LabelWithInfo>
                    <FieldPicker
                      id="dl3-lng"
                      value={lngField}
                      onChange={setLngField}
                      fields={fields}
                      filterType="number"
                      loading={loading}
                      placeholder="lng"
                    />
                  </div>
                  <div className="grid gap-1">
                    <LabelWithInfo
                      htmlFor="dl3-lat"
                      info="Field with the latitude. Auto-detected as `lat`, `latitude`, or `position[1]`."
                    >
                      Latitude
                    </LabelWithInfo>
                    <FieldPicker
                      id="dl3-lat"
                      value={latField}
                      onChange={setLatField}
                      fields={fields}
                      filterType="number"
                      loading={loading}
                      placeholder="lat"
                    />
                  </div>
                </>
              )}

              {caps.usesElevation && (
                <div className="grid gap-1.5">
                  <LabelWithInfo
                    info="Metres above ground — lifts markers onto the right floor plan. Pick a numeric field, hard-code a constant, or drive it from a per-record condition like ‘floor_name equals F2 → 12m’."
                  >
                    Elevation (optional)
                  </LabelWithInfo>
                  <ElevationInput
                    value={elevation}
                    onChange={setElevation}
                    fields={fields}
                    legacyField={existing?.fieldMapping.elevationField}
                  />
                </div>
              )}

              {caps.usesClusterGroup && (
                <div className="grid gap-1">
                  <LabelWithInfo
                    htmlFor="dl3-cgroup"
                    info="Only cluster points that share this value. Set to `currentRoomId` so bubbles never merge across rooms. Empty = plain distance clustering."
                  >
                    Cluster group (optional)
                  </LabelWithInfo>
                  <FieldPicker
                    id="dl3-cgroup"
                    value={clusterGroupField}
                    onChange={setClusterGroupField}
                    fields={fields}
                    loading={loading}
                    placeholder="currentRoomId"
                  />
                </div>
              )}

              {caps.usesValue && (
                <div className="grid gap-1">
                  <LabelWithInfo
                    htmlFor="dl3-value"
                    info="Numeric field shown as the badge value. Falls back to a field called `value` if empty."
                  >
                    Value field
                  </LabelWithInfo>
                  <FieldPicker
                    id="dl3-value"
                    value={labelField}
                    onChange={setLabelField}
                    fields={fields}
                    filterType={['number', 'string']}
                    loading={loading}
                    placeholder="lastValue"
                  />
                </div>
              )}

              {caps.usesLabel && !caps.usesValue && (
                <div className="grid gap-1">
                  <LabelWithInfo
                    htmlFor="dl3-label"
                    info="Field displayed as the marker / entity label."
                  >
                    Label field
                  </LabelWithInfo>
                  <FieldPicker
                    id="dl3-label"
                    value={labelField}
                    onChange={setLabelField}
                    fields={fields}
                    loading={loading}
                    placeholder="name"
                  />
                </div>
              )}

              {caps.usesEntityGroup && (
                <div className="grid gap-1">
                  <LabelWithInfo
                    htmlFor="dl3-egroup"
                    info="Field that uniquely identifies each moving entity — the track builder groups events by this."
                  >
                    Entity ID field
                  </LabelWithInfo>
                  <FieldPicker
                    id="dl3-egroup"
                    value={clusterGroupField}
                    onChange={setClusterGroupField}
                    fields={fields}
                    loading={loading}
                    placeholder="assetId"
                  />
                </div>
              )}
            </div>

            {caps.usesFovFields && (
              <p className="text-xs text-muted-foreground mt-2">
                FOV cones read <code className="text-xs">yaw</code>,{' '}
                <code className="text-xs">fovDeg</code>, and{' '}
                <code className="text-xs">viewDistanceM</code> from the
                payload today. Configurable field paths land in a later
                slice.
              </p>
            )}
          </Section>

          {/* 6 — Style (per render mode) */}
          <Section
            sectionId={SECTION_IDS.style}
            step={nextStep()}
            title={t('dataLink.step.styleTitle', { defaultValue: 'Style' })}
            hint={t('dataLink.step.styleHint', {
              defaultValue: 'How the {{mode}} appears.',
              mode: RENDER_MODES.find((m) => m.mode === renderMode)?.label.toLowerCase() ?? '',
            })}
          >
            {/* v4 — live preview of the current style settings. Sits
                above the controls so users see every slider drag reflect
                in real time. */}
            <StylePreview
              renderMode={renderMode}
              defaultColor={defaultColor}
              iconColor={iconColor}
              defaultIcon={defaultIcon}
              iconSize={iconSize}
              markerSize={markerSize}
              badgeSize={badgeSize}
              lineWidth={lineWidth}
              fillOpacity={fillOpacity}
              outlineWidth={outlineWidth}
              heatmapRadius={heatmapRadius}
            />
            {caps.usesIcon ? (
              // The Lucide icon picker + colours block ships with its own
              // search + 6-column icon grid. At 90 vw the grid explodes
              // into a 12-column × 5-row wall. Cap it to ~640 px so it
              // reads as a control, not a canvas — the search still finds
              // any icon fast.
              <div className="max-w-2xl">
                <MarkerIconAndColors
                  iconId={defaultIcon}
                  onIconChange={setDefaultIcon}
                  iconColor={iconColor}
                  onIconColorChange={setIconColor}
                  markerColor={defaultColor}
                  onMarkerColorChange={setDefaultColor}
                />
              </div>
            ) : (
              <div className="grid gap-1 max-w-sm">
                <LabelWithInfo
                  htmlFor="dl3-color"
                  info={`Base ${caps.colorLabel.toLowerCase()} for this layer. Style rules can override per record.`}
                >
                  {caps.colorLabel}
                </LabelWithInfo>
                <div className="flex items-center gap-2">
                  <input
                    id="dl3-color"
                    type="color"
                    value={defaultColor}
                    onChange={(e) => setDefaultColor(e.target.value)}
                    className="h-9 w-12 rounded border bg-background cursor-pointer shrink-0"
                  />
                  <Input
                    value={defaultColor}
                    onChange={(e) => setDefaultColor(e.target.value)}
                    className="h-9 text-xs font-mono flex-1 min-w-0"
                    placeholder="#3b82f6"
                  />
                </div>
              </div>
            )}
            {caps.usesCluster && (
              <>
                <div className="flex items-center justify-between mt-3 max-w-md">
                  <LabelWithInfo
                    htmlFor="dl3-cluster"
                    info="Groups close-together markers into a bubble with a count. Ideal for dense feeds."
                  >
                    Cluster nearby markers
                  </LabelWithInfo>
                  <Switch
                    id="dl3-cluster"
                    checked={cluster}
                    onCheckedChange={setCluster}
                  />
                </div>
                {cluster && (
                  <StyleSlider
                    id="dl3-cluster-radius"
                    label="Cluster radius"
                    info="Pixel radius for grouping nearby markers. Larger = more aggressive clustering. A hospital room is ~40-80 px at zoom 19."
                    value={clusterRadius}
                    onChange={setClusterRadius}
                    min={5}
                    max={100}
                    step={1}
                    suffix="px"
                  />
                )}
              </>
            )}

            {/* v4 — per-mode size / opacity / width sliders. Each is
                gated by a MODE_CAPS flag so only the knobs the chosen
                render mode actually consumes appear. Laid out as a
                2-column grid so tall lists don't dominate. */}
            {(caps.usesIconSize ||
              caps.usesMarkerSize ||
              caps.usesBadgeSize ||
              caps.usesLineWidth ||
              caps.usesFillOpacity ||
              caps.usesOutlineWidth ||
              caps.usesHeatmapKnobs) && (
              <div className="mt-4 border-t pt-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 max-w-3xl">
                {caps.usesIconSize && (
                  <StyleSlider
                    id="dl3-icon-size"
                    label="Icon size"
                    info="Scale of the Lucide glyph on top of the marker disc. 1.0 = SVG's natural size. Default 0.7."
                    value={iconSize}
                    onChange={setIconSize}
                    min={0.2}
                    max={1.5}
                    step={0.05}
                    format={(v) => v.toFixed(2)}
                    suffix="×"
                  />
                )}
                {caps.usesMarkerSize && (
                  <StyleSlider
                    id="dl3-marker-size"
                    label="Marker size"
                    info="Radius of the coloured disc / circle behind the icon."
                    value={markerSize}
                    onChange={setMarkerSize}
                    min={8}
                    max={40}
                    step={1}
                    suffix="px"
                  />
                )}
                {caps.usesBadgeSize && (
                  <StyleSlider
                    id="dl3-badge-size"
                    label="Badge size"
                    info="Radius of the gauge value badge."
                    value={badgeSize}
                    onChange={setBadgeSize}
                    min={10}
                    max={36}
                    step={1}
                    suffix="px"
                  />
                )}
                {caps.usesLineWidth && (
                  <StyleSlider
                    id="dl3-line-width"
                    label="Line width"
                    info="Thickness of each entity's movement trail."
                    value={lineWidth}
                    onChange={setLineWidth}
                    min={1}
                    max={8}
                    step={0.5}
                    format={(v) => v.toFixed(1)}
                    suffix="px"
                  />
                )}
                {caps.usesFillOpacity && (
                  <StyleSlider
                    id="dl3-fill-opacity"
                    label="Fill opacity"
                    info="How transparent the fill / cone is over the base map."
                    value={fillOpacity}
                    onChange={setFillOpacity}
                    min={0}
                    max={1}
                    step={0.05}
                    format={(v) => v.toFixed(2)}
                  />
                )}
                {caps.usesOutlineWidth && (
                  <StyleSlider
                    id="dl3-outline-width"
                    label="Outline width"
                    info="Thickness of the outline stroke."
                    value={outlineWidth}
                    onChange={setOutlineWidth}
                    min={0}
                    max={4}
                    step={0.5}
                    format={(v) => v.toFixed(1)}
                    suffix="px"
                  />
                )}
                {caps.usesHeatmapKnobs && (
                  <>
                    <StyleSlider
                      id="dl3-heatmap-radius"
                      label="Heatmap radius"
                      info="Radius each event spreads over at max zoom. Larger = smoother, softer output."
                      value={heatmapRadius}
                      onChange={setHeatmapRadius}
                      min={10}
                      max={80}
                      step={1}
                      suffix="px"
                    />
                    <StyleSlider
                      id="dl3-heatmap-intensity"
                      label="Heatmap intensity"
                      info="Weight multiplier per event. Higher = each event contributes more to the density."
                      value={heatmapIntensity}
                      onChange={setHeatmapIntensity}
                      min={0.5}
                      max={3}
                      step={0.1}
                      format={(v) => v.toFixed(1)}
                      suffix="×"
                    />
                    {sourceId !== null && (
                      <div className="grid gap-1.5">
                        <LabelWithInfo
                          htmlFor="dl3-heatmap-source"
                          info="Live sums current rows (one dot per record). History uses every insert/update/delete over the window, so a row that changed 200 times contributes 200× the weight."
                        >
                          Density source
                        </LabelWithInfo>
                        <div className="flex gap-1.5">
                          <select
                            id="dl3-heatmap-source"
                            value={heatmapSource}
                            onChange={(e) =>
                              setHeatmapSource(
                                e.target.value as 'live' | 'history',
                              )
                            }
                            className="h-8 flex-1 min-w-0 rounded-md border bg-background px-2 text-xs"
                          >
                            <option value="live">Live rows (one per record)</option>
                            <option value="history">Change history (weighted by events)</option>
                          </select>
                          {heatmapSource === 'history' && (
                            <select
                              value={heatmapWindowSec}
                              onChange={(e) =>
                                setHeatmapWindowSec(Number(e.target.value))
                              }
                              className="h-8 rounded-md border bg-background px-2 text-xs w-32"
                              title="Look-back window"
                            >
                              <option value={3600}>Last hour</option>
                              <option value={86_400}>Last 24h</option>
                              <option value={7 * 86_400}>Last 7 days</option>
                              <option value={30 * 86_400}>Last 30 days</option>
                            </select>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </Section>

          {/* 6b — Style rules. Rule bodies (conditions + fill colour +
              opacity + label override) are authored in the sidebar's
              Style Rules manager and stored per-zone. This section
              picks WHICH of those rules apply to this specific layer —
              the overlay evaluates the picked ids against each entity's
              payload and lets the first match override the default
              colour / opacity / label. Order shown is priority-ascending
              (same order the runtime fires them). */}
          <Section
            sectionId={SECTION_IDS.styleRules}
            step={nextStep()}
            title={t('dataLink.step.styleRulesTitle', { defaultValue: 'Style rules' })}
            hint={t('dataLink.step.styleRulesHint', {
              defaultValue:
                "Pick which zone-level style rules can override this layer's default colour / label. Rules fire top-down; first match wins. Manage rule bodies (conditions, colours) from the sidebar's Style Rules panel.",
            })}
          >
            {zoneStyleRules.length === 0 ? (
              <p className="text-[11px] text-muted-foreground border border-dashed rounded-md p-2">
                No rules defined for this warehouse yet. Add one from the
                sidebar's <span className="font-medium">Style rules</span> panel,
                then come back here to tick which apply.
              </p>
            ) : (
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground">
                    {styleRuleIds.length === 0
                      ? 'No rules picked — layer paints with defaults only.'
                      : `${styleRuleIds.length} of ${zoneStyleRules.length} picked`}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setStyleRuleIds(
                          zoneStyleRules
                            .map((r) => r.id)
                            .filter(
                              (id): id is number => typeof id === 'number',
                            ),
                        )
                      }
                      className="text-[11px] rounded-md border border-input px-2 py-1 hover:bg-accent/40"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setStyleRuleIds([])}
                      className="text-[11px] rounded-md border border-input px-2 py-1 hover:bg-accent/40"
                    >
                      None
                    </button>
                  </div>
                </div>
                <div className="grid gap-1 border rounded-md p-2 max-h-72 overflow-y-auto">
                  {zoneStyleRules.map((rule) => {
                    if (rule.id === undefined) return null
                    const checked = styleRuleIds.includes(rule.id)
                    const swatch = rule.style?.fillColor ?? '#94a3b8'
                    return (
                      <label
                        key={rule.id}
                        className="flex items-center gap-2 text-sm px-1 py-0.5 rounded hover:bg-accent/40 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const on = e.target.checked
                            setStyleRuleIds((prev) => {
                              if (on) {
                                return prev.includes(rule.id!)
                                  ? prev
                                  : [...prev, rule.id!]
                              }
                              return prev.filter((x) => x !== rule.id)
                            })
                          }}
                        />
                        <span
                          aria-hidden
                          className="inline-block w-3 h-3 rounded-sm border border-border shrink-0"
                          style={{ background: swatch }}
                        />
                        <span className="flex-1 truncate">{rule.name}</span>
                        <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                          p{rule.priority}
                        </span>
                        {rule.enabled === false && (
                          <span
                            className="text-[10px] text-amber-600 shrink-0"
                            title="Rule is disabled zone-wide — the checklist ignores it at runtime"
                          >
                            off
                          </span>
                        )}
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </Section>

          {/* 7 — Map tooltip. Full width — pairing this side-by-side
              with §8 sounds appealing but each section already contains
              its own 2-pane FieldOrderer, so stacking horizontally
              collapses the design into 4 tiny columns that nobody can
              read. Vertical stacking gives each pane the breathing
              room its content needs. */}
          {caps.usesTooltip && (
            <>
          <Section
              sectionId={SECTION_IDS.tooltip}
              step={nextStep()}
              title={
                <span className="flex items-center gap-1.5">
                  <MessageSquare size={13} className="text-primary/80" />
                  Map tooltip
                </span>
              }
              hint="The small popup that appears when a user hovers or clicks a rendered feature on the map."
            >
              <div className="grid sm:grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <LabelWithInfo
                    htmlFor="dl3-trigger"
                    info="Hover = shows on mouse-over. Click = only on click."
                  >
                    Trigger
                  </LabelWithInfo>
                  <select
                    id="dl3-trigger"
                    value={tooltipTrigger}
                    onChange={(e) =>
                      setTooltipTrigger(
                        e.target.value as DataLinkTooltip['trigger'],
                      )
                    }
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="hover">Hover</option>
                    <option value="click">Click</option>
                  </select>
                </div>
                <div className="grid gap-1">
                  <LabelWithInfo
                    htmlFor="dl3-onclick"
                    info="What happens on click. Custom event lets other UI code react via subscribeDataLinkClicks()."
                  >
                    On click
                  </LabelWithInfo>
                  <select
                    id="dl3-onclick"
                    value={onClickKind}
                    onChange={(e) =>
                      setOnClickKind(
                        e.target.value as NonNullable<
                          DataLinkTooltip['onClick']
                        >['kind'],
                      )
                    }
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="open-panel">Open tooltip / content panel</option>
                    <option value="open-url">Open URL in new tab</option>
                    <option value="custom-event">Fire custom event</option>
                  </select>
                </div>
              </div>

              <div className="grid gap-1 mt-3">
                <LabelWithInfo
                  info="Pick which fields the tooltip shows, and in what order. Drag rows to reorder. Empty = show every field."
                >
                  Fields shown in tooltip
                </LabelWithInfo>
                <FieldOrderer
                  fields={fields}
                  selected={tooltipFields}
                  onChange={setTooltipFields}
                  emptyHint="Empty — the tooltip will show every payload field."
                />
              </div>

              <div className="grid gap-1 mt-3">
                <LabelWithInfo
                  htmlFor="dl3-template"
                  info="Optional free-form message. Wrap a field name in single braces, e.g. {status} or {custom.temp}. Overrides the field list above when set."
                >
                  Custom template (optional)
                </LabelWithInfo>
                <textarea
                  id="dl3-template"
                  value={tooltipTemplate}
                  onChange={(e) => setTooltipTemplate(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border bg-background p-2 text-xs font-mono"
                  placeholder={'{label}\n{value} {unit}'}
                />
                <TooltipTemplatePreview
                  template={tooltipTemplate}
                  sample={sample}
                />
              </div>

              {onClickKind === 'open-url' && (
                <div className="grid gap-1 mt-2">
                  <LabelWithInfo
                    htmlFor="dl3-url"
                    info="URL to open. Same {field} substitution as the template above."
                  >
                    URL template
                  </LabelWithInfo>
                  <Input
                    id="dl3-url"
                    value={onClickUrl}
                    onChange={(e) => setOnClickUrl(e.target.value)}
                    placeholder="https://example.com/asset/{id}"
                    className="h-8 text-xs font-mono"
                  />
                </div>
              )}

              {onClickKind === 'custom-event' && (
                <div className="grid gap-1 mt-2">
                  <LabelWithInfo
                    htmlFor="dl3-event"
                    info="Event name emitted on click. Subscribe with subscribeDataLinkClicks(fn) from @/lib/data-link/data-link-events."
                  >
                    Event name
                  </LabelWithInfo>
                  <Input
                    id="dl3-event"
                    value={onClickEvent}
                    onChange={(e) => setOnClickEvent(e.target.value)}
                    placeholder="dl:click"
                    className="h-8 text-xs font-mono"
                  />
                </div>
              )}
            </Section>

          {/* 8 — Content viewer (sidebar drawer) — sibling of §7 in
              the xl:grid-cols-2 wrapper above. */}
          <Section
              sectionId={SECTION_IDS.panel}
              step={nextStep()}
              title={
                <span className="flex items-center gap-1.5">
                  <Eye size={13} className="text-primary/80" />
                  Content viewer (sidebar)
                </span>
              }
              hint="The right-side detail drawer that opens when a user clicks a linked feature. Independent from the map tooltip so you can keep the popup compact and the drawer rich."
            >
              <div className="grid gap-1">
                <LabelWithInfo
                  info="Pick which fields the drawer shows, and in what order. Drag rows to reorder. Empty = show every field the record has."
                >
                  Fields shown in sidebar
                </LabelWithInfo>
                <FieldOrderer
                  fields={fields}
                  selected={panelFields}
                  onChange={setPanelFields}
                  emptyHint="Empty — the sidebar will show every payload field."
                />
              </div>

              <div className="grid gap-1 mt-3">
                <LabelWithInfo
                  htmlFor="dl3-panel-template"
                  info="Optional prose block that renders above the fields in the sidebar. Same {field} substitution as the tooltip template."
                >
                  Sidebar header template (optional)
                </LabelWithInfo>
                <textarea
                  id="dl3-panel-template"
                  value={panelTemplate}
                  onChange={(e) => setPanelTemplate(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border bg-background p-2 text-xs font-mono"
                  placeholder={'{name} — {status}\nLast seen: {lastSeenAt}'}
                />
                <TooltipTemplatePreview
                  template={panelTemplate}
                  sample={sample}
                />
              </div>
            </Section>
            </>
          )}

          {/* Enabled toggle now lives in the sticky footer — see the
              action bar below. Kept out of the scrollable content so
              users can flick it from anywhere. */}

          {error && (
            <div className="text-xs text-destructive border border-destructive/50 rounded-md p-2">
              {error}
            </div>
          )}
        </div>
          </div>
        </div>

        {/* Sticky footer — Cancel / Save / Delete are always in view
            no matter how far the user has scrolled. The Enabled toggle
            lives here too so the operator can flip a link off without
            scrolling. */}
        <div className="border-t bg-background shrink-0">
          <div className="mx-auto w-full max-w-6xl px-6 py-3 flex items-center justify-between gap-3">
            {existing?.id !== undefined ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={busy}
              >
                <Trash2 className="w-3.5 h-3.5 me-1" />
                {t('dataLink.delete', { defaultValue: 'Delete' })}
              </Button>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-4 ms-auto">
              <label
                htmlFor="dl3-enabled"
                className="flex items-center gap-2 cursor-pointer select-none"
                title="Turn off to hide this link from the map without deleting it."
              >
                <span className="text-xs font-medium">Enabled</span>
                <Switch
                  id="dl3-enabled"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                />
              </label>
              <div className="h-6 w-px bg-border" />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  {t('common.cancel', { defaultValue: 'Cancel' })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSave}
                  disabled={!canSave || busy}
                  title={saveBlockedReason}
                >
                  {busy && <Loader2 className="w-3.5 h-3.5 me-1 animate-spin" />}
                  {existing
                    ? t('dataLink.save', { defaultValue: 'Save' })
                    : t('dataLink.create', { defaultValue: 'Create' })}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
