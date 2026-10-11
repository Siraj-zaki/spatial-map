/**
 * DataLinkEditorDialog — the create/edit surface for a `DataLinkConfig`
 * row. See DESIGN-data-link.md for the underlying model.
 *
 * Slice 2 scope: `point-at-coord` render mode ONLY. The dialog exposes
 * every field the mode consumes today:
 *   - Stream picker (an existing Stream this link renders from)
 *   - Name (human label the sidebar shows)
 *   - Field mapping — which payload keys drive lng/lat/label/tooltip
 *   - Style — default marker icon (Lucide), default color, cluster on/off
 *   - Tooltip — hover vs click trigger, which payload keys to render
 *
 * Additional render modes (gauge, heatmap, track, …) land in Slice 3
 * and will extend the mode picker below.
 *
 * Save flow:
 *   - Create: `useSpatialStore.getState().createLocal('data-link-configs', ...)`
 *   - Update: `updateLocal('data-link-configs', id, patch)`
 *   - Delete: `deleteLocal('data-link-configs', id)`
 * All three go through the optimistic spatial-store path — the UI
 * reflects the change immediately, then the batched flush persists it
 * via the `/api/v1/data-links` backend route.
 */

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useApiQuery } from '@/lib/useApiQuery'
import { apiDb } from '@/lib/api-db'
import { useCurrentTenantId } from '@/lib/data-link/tenant-service'
import { useSpatialStore } from '@/lib/spatial-store'
import {
  useSpatialCircles,
  useSpatialLines,
  useSpatialMarkers,
  useSpatialModels,
  useSpatialPolygons,
} from '@/hooks/useSpatialShapes'
import type {
  DataLinkConfig,
  DataLinkFieldMapping,
  DataLinkMatch,
  DataLinkMatchMode,
  DataLinkRenderMode,
  DataLinkStyle,
  DataLinkTooltip,
} from '@/lib/db'
import { MarkerIconAndColors } from '@/components/data-link/lucide-icon-picker'

/**
 * All render modes shipped by `MapDataLinkedOverlay`. Each entry
 * flags whether the mode is anchored to a specific map shape
 * (`needsShape=true`) so the dialog can conditionally reveal the
 * shape picker + hide the coord-fields inputs.
 */
const AVAILABLE_MODES: {
  mode: DataLinkRenderMode
  label: string
  hint: string
  needsShape: boolean
}[] = [
  {
    mode: 'point-at-coord',
    label: 'Point at coordinate',
    hint: 'Renders each entity as a marker at the lng/lat from its payload.',
    needsShape: false,
  },
  {
    mode: 'point-on-shape',
    label: 'Point on shape',
    hint: 'Renders each entity as a marker at the bound shape\'s centroid.',
    needsShape: true,
  },
  {
    mode: 'gauge-on-shape',
    label: 'Gauge on shape',
    hint: 'Renders a value badge at the bound shape\'s centroid (temp, occupancy, RSSI, …).',
    needsShape: true,
  },
  {
    mode: 'shape-tint',
    label: 'Shape tint (polygon/circle fill)',
    hint: 'Overrides the bound polygon or circle\'s fill with the config color.',
    needsShape: true,
  },
  {
    mode: 'heatmap',
    label: 'Heatmap of recent events',
    hint: 'Density map from the stream\'s events over the last 5 minutes. No shape needed.',
    needsShape: false,
  },
  {
    mode: 'track',
    label: 'Track (per-entity trails)',
    hint: 'Draws each entity\'s recent path as a LineString + head marker.',
    needsShape: false,
  },
  {
    mode: 'fov-cone',
    label: 'FOV cone (camera coverage)',
    hint: 'Triangle from yaw / fov / view distance fields on the payload. Anchored to a shape.',
    needsShape: true,
  },
  {
    mode: 'roi-pulse',
    label: 'ROI pulse',
    hint: 'Animated ring + count badge at the bound shape\'s centroid.',
    needsShape: true,
  },
]

/** Shape kinds a data-link can anchor to. Grid + text-label + door
 *  can be added later once the overlay picks up centroid lookups for
 *  them; for now the sub-renderers only support the five below. */
const SHAPE_TARGET_KINDS: DataLinkConfig['targetKind'][] = [
  'polygon',
  'circle',
  'marker',
  'line',
  'model',
]

/** Slice-2 tooltip triggers. Matches the shape-tooltip semantics. */
const TOOLTIP_TRIGGERS: DataLinkTooltip['trigger'][] = ['hover', 'click']

export interface DataLinkEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Warehouse the config belongs to. Required — configs are per-zone. */
  zoneId: number
  /** When editing, the existing config is preloaded into the form. */
  existing?: DataLinkConfig | null
  /** Fires after a successful save/delete so the host can toast + close. */
  onSaved?: () => void
}

export function DataLinkEditorDialog({
  open,
  onOpenChange,
  zoneId,
  existing,
  onSaved,
}: DataLinkEditorDialogProps) {
  const { t } = useTranslation()

  // Form state — hydrated from `existing` in edit mode, empty defaults
  // in create mode. We deliberately don't reset when `existing` flips
  // (the caller should key the dialog on config id to force a remount).
  const [name, setName] = useState(existing?.name ?? '')
  // Preserved from `existing` for backwards-compat with legacy
  // stream-bound configs — the picker was removed in the file/REST-only
  // rework, so new configs never touch this. Existing configs with a
  // streamId + no sourceId still render via `fetchLayerRows`'s
  // fallback path.
  const [streamId] = useState<number | null>(
    existing?.streamId ?? null,
  )
  // v3 — the layer's canonical data source. When set, sub-renderers
  // read rows via `listRowsForSource(sourceId)` instead of streams.
  // Legacy configs (streamId only) still work via the fallback path.
  const [sourceId, setSourceId] = useState<number | null>(
    existing?.sourceId ?? null,
  )
  const [renderMode, setRenderMode] = useState<DataLinkRenderMode>(
    existing?.renderMode ?? 'point-at-coord',
  )
  // Shape anchor for `point-on-shape` / `gauge-on-shape` / `shape-tint`
  // / `fov-cone` / `roi-pulse`. `targetKind` also filters the shape
  // picker below.
  const [targetKind, setTargetKind] = useState<DataLinkConfig['targetKind']>(
    existing?.targetKind ?? 'polygon',
  )
  const [targetShapeId, setTargetShapeId] = useState<number | null>(
    existing?.targetShapeId ?? null,
  )
  // Match spec — v2 addition. Defaults infer the same behaviour as v1
  // so re-saving an existing config without touching this section is a
  // no-op semantically. See DESIGN-data-link-v2.md §2.
  const initialMatch: DataLinkMatch =
    existing?.fieldMapping.match ??
    (existing?.targetShapeId ? { mode: 'explicit-shape' } : { mode: 'coord' })
  const [matchMode, setMatchMode] = useState<DataLinkMatchMode>(initialMatch.mode)
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
  // Field mapping — most publishers use `lng`/`lat`; we default there
  // so a fresh REST source with the standard shape works with zero
  // config beyond picking a stream.
  const [lngField, setLngField] = useState(
    existing?.fieldMapping.coordFields?.lng ?? 'lng',
  )
  const [latField, setLatField] = useState(
    existing?.fieldMapping.coordFields?.lat ?? 'lat',
  )
  const [labelField, setLabelField] = useState(
    existing?.fieldMapping.labelField ?? 'label',
  )
  const [tooltipFieldsRaw, setTooltipFieldsRaw] = useState(
    (existing?.fieldMapping.tooltipFields ?? []).join(', '),
  )
  const [elevationField, setElevationField] = useState(
    existing?.fieldMapping.elevationField ?? '',
  )
  const [clusterGroupField, setClusterGroupField] = useState(
    existing?.fieldMapping.clusterGroupField ?? '',
  )

  // Shape catalog for the target-shape picker. Only pulled from the
  // store — no auth call — so the picker is cheap.
  const { data: polygons } = useSpatialPolygons()
  const { data: circles } = useSpatialCircles()
  const { data: markers } = useSpatialMarkers()
  const { data: lines } = useSpatialLines()
  const { data: models } = useSpatialModels()
  const shapeOptions = useMemo(() => {
    const scoped = <T extends { id?: number; zoneId?: number; name: string }>(
      arr: readonly T[] | undefined,
    ): T[] => (arr ?? []).filter((s) => s.zoneId === zoneId && s.id !== undefined)
    switch (targetKind) {
      case 'polygon': return scoped(polygons).map((s) => ({ id: s.id!, name: s.name }))
      case 'circle':  return scoped(circles).map((s) => ({ id: s.id!, name: s.name }))
      case 'marker':  return scoped(markers).map((s) => ({ id: s.id!, name: s.name }))
      case 'line':    return scoped(lines).map((s) => ({ id: s.id!, name: s.name }))
      case 'model':   return scoped(models).map((s) => ({ id: s.id!, name: s.name }))
      default:        return []
    }
  }, [targetKind, zoneId, polygons, circles, markers, lines, models])

  const modeMeta = AVAILABLE_MODES.find((m) => m.mode === renderMode)
  const needsShape = modeMeta?.needsShape ?? false
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
  const [tooltipTrigger, setTooltipTrigger] = useState<DataLinkTooltip['trigger']>(
    existing?.tooltip.trigger ?? 'hover',
  )
  // v2: freeform template + on-click behavior for the tooltip.
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
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Match-config completeness — depends on the render mode's expectations
  // (needsShape) AND the chosen match mode. Coord + heatmap + track modes
  // want coordFields; shape-anchored modes want a valid target resolver.
  const matchComplete = (() => {
    if (!needsShape) {
      // Coord-only path (point-at-coord / heatmap / track). We always
      // require lng+lat field names to be non-empty; the resolver will
      // read them from the payload.
      return lngField.trim().length > 0 && latField.trim().length > 0
    }
    switch (matchMode) {
      case 'coord':
        return lngField.trim().length > 0 && latField.trim().length > 0
      case 'explicit-shape':
        return targetShapeId !== null
      case 'attribute-join':
        if (!joinPayloadField.trim()) return false
        if (joinShapeFieldSource === 'bin.customProp' && !joinShapeField.trim()) return false
        return true
      case 'external-code':
        return joinPayloadField.trim().length > 0
      default:
        return false
    }
  })()

  // Save gate. `streamId` used to be required, but v3 flipped the source
  // of truth from Stream → DataSource. A layer with `sourceId` set is
  // fully valid on its own, so only require ONE of the two to be set.
  // Backwards-compat: legacy configs with a streamId + no sourceId
  // still pass. Modern configs bind to a REST / file source and never
  // touch streamId.
  const canSave =
    name.trim().length > 0 &&
    (sourceId !== null || streamId !== null) &&
    matchComplete

  const buildPayload = useCallback((): Omit<DataLinkConfig, 'id'> => {
    const tooltipFields = tooltipFieldsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    // Effective match spec — for coord-based render modes we always
    // stamp `mode: 'coord'` so the resolver takes the coord path even
    // if the user tweaked the radio to something else on a mode change.
    const effectiveMatchMode: DataLinkMatchMode = needsShape ? matchMode : 'coord'
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
      coordFields: usesPayloadCoords
        ? { lng: lngField.trim() || 'lng', lat: latField.trim() || 'lat' }
        : undefined,
      elevationField: elevationField.trim() || undefined,
      clusterGroupField: clusterGroupField.trim() || undefined,
      tooltipFields: tooltipFields.length > 0 ? tooltipFields : undefined,
      match,
    }
    const style: DataLinkStyle = {
      defaultIcon: defaultIcon.trim() || 'map-pin',
      defaultColor: defaultColor,
      iconColor: iconColor,
      cluster,
      clusterRadius: cluster ? clusterRadius : undefined,
      iconLibrary: 'lucide',
    }
    const tooltip: DataLinkTooltip = {
      trigger: tooltipTrigger,
      fields: tooltipFields.length > 0 ? tooltipFields : undefined,
      template: tooltipTemplate.trim() || undefined,
      onClick: (() => {
        if (onClickKind === 'open-panel') return { kind: 'open-panel' }
        if (onClickKind === 'open-url')
          return { kind: 'open-url', url: onClickUrl.trim() || undefined }
        return {
          kind: 'custom-event',
          event: onClickEvent.trim() || 'dl:click',
        }
      })(),
    }
    const now = new Date()
    return {
      zoneId,
      streamId: streamId ?? 0,
      sourceId: sourceId ?? undefined,
      name: name.trim(),
      // Always stamp the target kind. Attribute-join and external-code
      // resolvers use it to know WHICH shape table to scan. For coord
      // modes on non-shape kinds we still stamp 'marker' so the sidebar
      // "data links on this shape" query has something consistent.
      targetKind: needsShape ? targetKind : 'marker',
      // Only carry targetShapeId when the match mode explicitly binds
      // to one shape. Attribute-join / external-code / coord leave it
      // undefined so the resolver takes its per-mode path.
      targetShapeId:
        needsShape && matchMode === 'explicit-shape' && targetShapeId !== null
          ? targetShapeId
          : undefined,
      renderMode,
      fieldMapping,
      style,
      tooltip,
      styleRuleIds: existing?.styleRuleIds ?? [],
      enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
  }, [
    zoneId,
    streamId,
    sourceId,
    name,
    renderMode,
    needsShape,
    targetKind,
    targetShapeId,
    matchMode,
    joinPayloadField,
    joinShapeFieldSource,
    joinShapeField,
    lngField,
    latField,
    labelField,
    tooltipFieldsRaw,
    defaultIcon,
    defaultColor,
    iconColor,
    cluster,
    clusterRadius,
    tooltipTrigger,
    tooltipTemplate,
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
      } else {
        await store.createLocal('data-link-configs', payload)
      }
      // Force an immediate flush so the overlay picks the change up
      // now — the batched flush would delay by ~400 ms otherwise.
      await store.commit('data-link-configs')
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
    if (!window.confirm(t('dataLink.confirmDelete', { defaultValue: 'Delete this data link?' }))) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const store = useSpatialStore.getState()
      store.deleteLocal('data-link-configs', existing.id)
      await store.commit('data-link-configs')
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [existing, onOpenChange, onSaved, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85dvh] overflow-y-auto" aria-describedby={undefined}>
        <DialogTitle className="text-sm font-semibold">
          {existing
            ? t('dataLink.editorEditTitle', { defaultValue: 'Edit data link' })
            : t('dataLink.editorAddTitle', { defaultValue: 'Add data link' })}
        </DialogTitle>
        <p className="text-[11px] text-muted-foreground mb-3">
          {t('dataLink.editorHelp', {
            defaultValue:
              'Bind a stream to the map. Pick a stream, tell the overlay which payload fields carry the coordinates + label, and configure the marker.',
          })}
        </p>

        {/* Basic identity */}
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="dl-name">
              {t('dataLink.name', { defaultValue: 'Name' })}
            </Label>
            <Input
              id="dl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('dataLink.namePlaceholder', {
                defaultValue: 'Forklifts on ground floor',
              })}
            />
          </div>

          {/* DataSource picker — the ONLY binding surface now.
              Slice-v3 flipped source-of-truth from Stream → DataSource;
              every layer reads its rows from `data_source_rows` via
              `source_id`. The legacy Stream dropdown that sat below
              this used to be required for save, blocking new users
              from creating layers without first setting up a stream
              they didn't need. Ripped out entirely. Existing configs
              with a `streamId` and no `sourceId` still render via the
              fallback in `fetchLayerRows` — the DB rows aren't
              touched. */}
          <SourcePickerRow value={sourceId} onChange={setSourceId} />

          <div className="grid gap-1.5">
            <Label htmlFor="dl-mode">
              {t('dataLink.renderMode', { defaultValue: 'Render mode' })}
            </Label>
            <select
              id="dl-mode"
              value={renderMode}
              onChange={(e) => setRenderMode(e.target.value as DataLinkRenderMode)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {AVAILABLE_MODES.map((m) => (
                <option key={m.mode} value={m.mode}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-muted-foreground">
              {AVAILABLE_MODES.find((m) => m.mode === renderMode)?.hint}
            </p>
          </div>

          {/* Target + Match — merged. For shape-anchored render modes
              this exposes the target-kind dropdown + the v2 match-mode
              radio (explicit-shape / attribute-join / external-code)
              plus per-mode fields. Coord-only render modes skip
              this block entirely — coord fields land in the Field
              mapping section below. See DESIGN-data-link-v2.md §2. */}
          {needsShape && (
            <div className="border-t pt-3 mt-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                {t('dataLink.target', { defaultValue: 'Target' })}
              </div>
              <div className="grid gap-1 mb-2">
                <Label htmlFor="dl-target-kind" className="text-[11px]">
                  {t('dataLink.kind', { defaultValue: 'Shape kind' })}
                </Label>
                <select
                  id="dl-target-kind"
                  value={targetKind}
                  onChange={(e) => {
                    setTargetKind(e.target.value as DataLinkConfig['targetKind'])
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

              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 mt-3">
                {t('dataLink.matchMode', { defaultValue: 'Match by' })}
              </div>
              <MatchModeRadio value={matchMode} onChange={setMatchMode} t={t} />

              {matchMode === 'explicit-shape' && (
                <div className="grid gap-1 mt-3">
                  <Label htmlFor="dl-target-shape" className="text-[11px]">
                    {t('dataLink.shape', { defaultValue: 'Shape' })}
                  </Label>
                  <select
                    id="dl-target-shape"
                    value={targetShapeId ?? ''}
                    onChange={(e) =>
                      setTargetShapeId(e.target.value ? Number(e.target.value) : null)
                    }
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="">
                      {t('dataLink.shapePlaceholder', { defaultValue: '— select —' })}
                    </option>
                    {shapeOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  {shapeOptions.length === 0 && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {t('dataLink.noShapes', {
                        defaultValue:
                          'No shapes of this kind in the current facility yet.',
                      })}
                    </p>
                  )}
                </div>
              )}

              {matchMode === 'attribute-join' && (
                <div className="grid gap-2 mt-3">
                  <div className="grid gap-1">
                    <Label htmlFor="dl-join-payload" className="text-[11px]">
                      {t('dataLink.joinPayloadField', {
                        defaultValue: 'Payload field',
                      })}
                    </Label>
                    <Input
                      id="dl-join-payload"
                      value={joinPayloadField}
                      onChange={(e) => setJoinPayloadField(e.target.value)}
                      placeholder="e.g. room"
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="dl-join-source" className="text-[11px]">
                      {t('dataLink.joinShapeSource', {
                        defaultValue: 'Compared against',
                      })}
                    </Label>
                    <select
                      id="dl-join-source"
                      value={joinShapeFieldSource}
                      onChange={(e) =>
                        setJoinShapeFieldSource(
                          e.target.value as typeof joinShapeFieldSource,
                        )
                      }
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="name">shape.name</option>
                      <option value="role">shape.role (polygon / circle)</option>
                      <option value="bin.externalCode">bin.externalCode</option>
                      <option value="bin.customProp">bin.customProperties[key]</option>
                    </select>
                  </div>
                  {joinShapeFieldSource === 'bin.customProp' && (
                    <div className="grid gap-1">
                      <Label htmlFor="dl-join-key" className="text-[11px]">
                        {t('dataLink.joinCustomKey', {
                          defaultValue: 'Custom-attribute key',
                        })}
                      </Label>
                      <Input
                        id="dl-join-key"
                        value={joinShapeField}
                        onChange={(e) => setJoinShapeField(e.target.value)}
                        placeholder="e.g. room_name"
                      />
                      <p className="text-[10px] text-muted-foreground">
                        {t('dataLink.joinCustomKeyHint', {
                          defaultValue:
                            'Raw key you use in imports (e.g. room_name). Both sides normalise to alphanumeric lowercase before matching, so room_name matches roomname.',
                        })}
                      </p>
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    {t('dataLink.joinMultihitHint', {
                      defaultValue:
                        'If multiple shapes match the same payload value, the render appears on ALL of them.',
                    })}
                  </p>
                </div>
              )}

              {matchMode === 'external-code' && (
                <div className="grid gap-1 mt-3">
                  <Label htmlFor="dl-join-ec-payload" className="text-[11px]">
                    {t('dataLink.externalCodeField', {
                      defaultValue: 'Payload field',
                    })}
                  </Label>
                  <Input
                    id="dl-join-ec-payload"
                    value={joinPayloadField}
                    onChange={(e) => setJoinPayloadField(e.target.value)}
                    placeholder="external_code"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {t('dataLink.externalCodeHint', {
                      defaultValue:
                        'Shortcut for attribute-join → bin.externalCode. Defaults to `external_code`.',
                    })}
                  </p>
                </div>
              )}

              {matchMode === 'coord' && (
                <p className="text-[10px] text-muted-foreground mt-2">
                  {t('dataLink.coordOnShapeHint', {
                    defaultValue:
                      'Coord mode ignores the shape kind — the payload’s lng/lat are used directly. Set the lng/lat fields in Field mapping below.',
                  })}
                </p>
              )}
            </div>
          )}

          {/* Field mapping — the whole reason for the refactor. Each
              input references a key in the stream's payload JSON. */}
          <div className="border-t pt-3 mt-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              {t('dataLink.fieldMapping', { defaultValue: 'Field mapping' })}
            </div>
            {(renderMode === 'point-at-coord' ||
              renderMode === 'heatmap' ||
              renderMode === 'track') && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1">
                    <Label htmlFor="dl-lng" className="text-[11px]">
                      {t('dataLink.lngField', { defaultValue: 'Longitude field' })}
                    </Label>
                    <Input
                      id="dl-lng"
                      value={lngField}
                      onChange={(e) => setLngField(e.target.value)}
                      placeholder="lng"
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="dl-lat" className="text-[11px]">
                      {t('dataLink.latField', { defaultValue: 'Latitude field' })}
                    </Label>
                    <Input
                      id="dl-lat"
                      value={latField}
                      onChange={(e) => setLatField(e.target.value)}
                      placeholder="lat"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1.5">
                  {t('dataLink.coordFieldsHint', {
                    defaultValue:
                      'Path syntax: flat field (`lng`), nested (`location.lng`), or array index (`currentPosition[0]` for lng, `[1]` for lat).',
                  })}
                </p>
                <div className="grid gap-1 mt-2">
                  <Label htmlFor="dl-elev" className="text-[11px]">
                    {t('dataLink.elevationField', { defaultValue: 'Elevation field (optional)' })}
                  </Label>
                  <Input
                    id="dl-elev"
                    value={elevationField}
                    onChange={(e) => setElevationField(e.target.value)}
                    placeholder="elevation"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {t('dataLink.elevationFieldHint', {
                      defaultValue:
                        'Metres above ground. Lifts markers onto the correct floor plan — set to `elevation` for our multi-floor mock. Same path syntax as above.',
                    })}
                  </p>
                </div>
                <div className="grid gap-1 mt-2">
                  <Label htmlFor="dl-groupfield" className="text-[11px]">
                    {t('dataLink.clusterGroupField', { defaultValue: 'Cluster group field (optional)' })}
                  </Label>
                  <Input
                    id="dl-groupfield"
                    value={clusterGroupField}
                    onChange={(e) => setClusterGroupField(e.target.value)}
                    placeholder="currentRoomId"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {t('dataLink.clusterGroupFieldHint', {
                      defaultValue:
                        'Only cluster points that share this field. Set to `currentRoomId` so cluster bubbles never merge across rooms / walls. Leave empty for standard geographic clustering.',
                    })}
                  </p>
                </div>
              </>
            )}
            {renderMode === 'gauge-on-shape' && (
              <p className="text-[10px] text-muted-foreground mb-2">
                {t('dataLink.gaugeHint', {
                  defaultValue:
                    'Value field: uses the label field below. Set it to your sensor\'s value key (e.g. `lastValue`, `temp`).',
                })}
              </p>
            )}
            {renderMode === 'fov-cone' && (
              <p className="text-[10px] text-muted-foreground mb-2">
                {t('dataLink.fovHint', {
                  defaultValue:
                    'FOV cone reads `yaw`, `fovDeg`, `viewDistanceM` from each payload. Configurable per-field mapping lands in a later slice.',
                })}
              </p>
            )}
            {renderMode === 'shape-tint' && (
              <p className="text-[10px] text-muted-foreground mb-2">
                {t('dataLink.tintHint', {
                  defaultValue:
                    'Shape tint overrides the target shape\'s fill with the config color. Data-driven color (from a payload field) lands with style rules in Slice 4.',
                })}
              </p>
            )}
            <div className="grid gap-1 mt-2">
              <Label htmlFor="dl-label-field" className="text-[11px]">
                {t('dataLink.labelField', { defaultValue: 'Label field' })}
              </Label>
              <Input
                id="dl-label-field"
                value={labelField}
                onChange={(e) => setLabelField(e.target.value)}
                placeholder="label"
              />
              <p className="text-[10px] text-muted-foreground">
                {t('dataLink.labelFieldHelp', {
                  defaultValue:
                    "Which payload key drives the marker's text label.",
                })}
              </p>
            </div>
            <div className="grid gap-1 mt-2">
              <Label htmlFor="dl-tooltip-fields" className="text-[11px]">
                {t('dataLink.tooltipFields', { defaultValue: 'Tooltip fields' })}
              </Label>
              <Input
                id="dl-tooltip-fields"
                value={tooltipFieldsRaw}
                onChange={(e) => setTooltipFieldsRaw(e.target.value)}
                placeholder="id, status, battery, temp"
              />
              <p className="text-[10px] text-muted-foreground">
                {t('dataLink.tooltipFieldsHelp', {
                  defaultValue:
                    'Comma-separated payload keys shown in the tooltip. Leave empty to show all fields.',
                })}
              </p>
            </div>
          </div>

          {/* Style — Lucide icon picker + icon-color + marker-color +
              clustering. See DESIGN-data-link-v2.md §3. Replaces the
              legacy 18-icon dropdown with the full ~1714-icon search. */}
          <div className="border-t pt-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              {t('dataLink.style', { defaultValue: 'Style' })}
            </div>
            <MarkerIconAndColors
              iconId={defaultIcon}
              onIconChange={setDefaultIcon}
              iconColor={iconColor}
              onIconColorChange={setIconColor}
              markerColor={defaultColor}
              onMarkerColorChange={setDefaultColor}
            />
            <div className="flex items-center justify-between mt-3">
              <Label htmlFor="dl-cluster" className="text-[11px] cursor-pointer">
                {t('dataLink.cluster', { defaultValue: 'Cluster nearby markers' })}
              </Label>
              <Switch
                id="dl-cluster"
                checked={cluster}
                onCheckedChange={setCluster}
              />
            </div>
            {cluster && (
              <div className="flex items-center gap-2 mt-2">
                <Label htmlFor="dl-cluster-radius" className="text-[11px] cursor-pointer whitespace-nowrap">
                  {t('dataLink.clusterRadius', { defaultValue: 'Cluster radius' })}
                </Label>
                <Input
                  id="dl-cluster-radius"
                  type="number"
                  min={5}
                  max={100}
                  step={1}
                  value={clusterRadius}
                  onChange={(e) => setClusterRadius(Number(e.target.value) || 22)}
                  className="h-7 w-20 text-[11px] tabular-nums"
                />
                <span className="text-[10px] text-muted-foreground">px</span>
              </div>
            )}
          </div>

          {/* Tooltip + on-click. v2: adds template (Handlebars-style
              `{{payload.foo}}`) and per-config click behaviour. See
              DESIGN-data-link-v2.md §3 (Common options). */}
          <div className="border-t pt-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              {t('dataLink.tooltip', { defaultValue: 'Tooltip & interaction' })}
            </div>
            <div className="grid gap-1">
              <Label htmlFor="dl-tooltip-trigger" className="text-[11px]">
                {t('dataLink.trigger', { defaultValue: 'Trigger' })}
              </Label>
              <select
                id="dl-tooltip-trigger"
                value={tooltipTrigger}
                onChange={(e) => setTooltipTrigger(e.target.value as DataLinkTooltip['trigger'])}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                {TOOLTIP_TRIGGERS.map((tr) => (
                  <option key={tr} value={tr}>
                    {tr}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-1 mt-2">
              <Label htmlFor="dl-tooltip-template" className="text-[11px]">
                {t('dataLink.tooltipTemplate', { defaultValue: 'Template (optional)' })}
              </Label>
              <textarea
                id="dl-tooltip-template"
                value={tooltipTemplate}
                onChange={(e) => setTooltipTemplate(e.target.value)}
                rows={3}
                className="w-full rounded-md border bg-background p-2 text-xs font-mono"
                placeholder={'{{payload.label}}\n{{payload.value}} {{payload.unit}}'}
              />
              <p className="text-[10px] text-muted-foreground">
                {t('dataLink.tooltipTemplateHint', {
                  defaultValue:
                    'Handlebars-style. `{{payload.field}}` reads from the runtime payload. Leave empty to show the tooltip fields list.',
                })}
              </p>
            </div>

            <div className="grid gap-1 mt-2">
              <Label htmlFor="dl-onclick" className="text-[11px]">
                {t('dataLink.onClick', { defaultValue: 'On click' })}
              </Label>
              <select
                id="dl-onclick"
                value={onClickKind}
                onChange={(e) =>
                  setOnClickKind(
                    e.target.value as NonNullable<DataLinkTooltip['onClick']>['kind'],
                  )
                }
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="open-panel">
                  {t('dataLink.onClickPanel', { defaultValue: 'Open tooltip panel (default)' })}
                </option>
                <option value="open-url">
                  {t('dataLink.onClickUrl', { defaultValue: 'Open URL in new tab' })}
                </option>
                <option value="custom-event">
                  {t('dataLink.onClickEvent', { defaultValue: 'Fire custom event' })}
                </option>
              </select>
            </div>

            {onClickKind === 'open-url' && (
              <div className="grid gap-1 mt-2">
                <Label htmlFor="dl-onclick-url" className="text-[11px]">
                  {t('dataLink.onClickUrlField', { defaultValue: 'URL template' })}
                </Label>
                <Input
                  id="dl-onclick-url"
                  value={onClickUrl}
                  onChange={(e) => setOnClickUrl(e.target.value)}
                  placeholder="https://example.com/asset/{{payload.assetId}}"
                />
                <p className="text-[10px] text-muted-foreground">
                  {t('dataLink.onClickUrlHint', {
                    defaultValue:
                      'Same `{{payload.field}}` substitution as the tooltip template.',
                  })}
                </p>
              </div>
            )}

            {onClickKind === 'custom-event' && (
              <div className="grid gap-1 mt-2">
                <Label htmlFor="dl-onclick-event" className="text-[11px]">
                  {t('dataLink.onClickEventField', { defaultValue: 'Event name' })}
                </Label>
                <Input
                  id="dl-onclick-event"
                  value={onClickEvent}
                  onChange={(e) => setOnClickEvent(e.target.value)}
                  placeholder="dl:click"
                />
                <p className="text-[10px] text-muted-foreground">
                  {t('dataLink.onClickEventHint', {
                    defaultValue:
                      'Subscribe with `subscribeDataLinkClicks(fn)` from `@/lib/data-link/data-link-events` to react in code.',
                  })}
                </p>
              </div>
            )}
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between border-t pt-3">
            <Label htmlFor="dl-enabled" className="text-[11px] cursor-pointer">
              {t('dataLink.enabled', { defaultValue: 'Enabled' })}
            </Label>
            <Switch
              id="dl-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>

          {error && (
            <div className="text-xs text-destructive border border-destructive/50 rounded-md p-2">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between gap-2 pt-2">
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
              >
                {busy && <Loader2 className="w-3.5 h-3.5 me-1 animate-spin" />}
                {existing
                  ? t('dataLink.save', { defaultValue: 'Save' })
                  : t('dataLink.create', { defaultValue: 'Create' })}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// -------------------------------------------------- MatchModeRadio

/**
 * 4-way radio for the match mode. Coord is only reachable here when the
 * host renders it for shape-anchored render modes; coord-only render
 * modes bypass this radio entirely (auto-coord). See §2 of the design
 * doc.
 */
function MatchModeRadio({
  value,
  onChange,
  t,
}: {
  value: DataLinkMatchMode
  onChange: (v: DataLinkMatchMode) => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const OPTIONS: {
    mode: DataLinkMatchMode
    label: string
    hint: string
  }[] = [
    {
      mode: 'explicit-shape',
      label: t('dataLink.matchExplicitLabel', { defaultValue: 'One specific shape' }),
      hint: t('dataLink.matchExplicitHint', {
        defaultValue: 'Pick a single shape by name. Simplest case.',
      }),
    },
    {
      mode: 'attribute-join',
      label: t('dataLink.matchJoinLabel', { defaultValue: 'Attribute join' }),
      hint: t('dataLink.matchJoinHint', {
        defaultValue:
          'Match payload.field against shape.name / role / bin.externalCode / bin.customProperties. Multi-hit.',
      }),
    },
    {
      mode: 'external-code',
      label: t('dataLink.matchExternalLabel', { defaultValue: 'External code' }),
      hint: t('dataLink.matchExternalHint', {
        defaultValue:
          'Shortcut for attribute-join → bin.externalCode. What CSV / webhook imports use.',
      }),
    },
    {
      mode: 'coord',
      label: t('dataLink.matchCoordLabel', { defaultValue: 'Payload coordinates' }),
      hint: t('dataLink.matchCoordHint', {
        defaultValue:
          'Render at payload lng/lat directly. Existing shapes are ignored.',
      }),
    },
  ]
  return (
    <div role="radiogroup" className="grid gap-1.5">
      {OPTIONS.map((opt) => {
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
              name="dl-match-mode"
              value={opt.mode}
              checked={selected}
              onChange={() => onChange(opt.mode)}
              className="mt-0.5 accent-primary"
            />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-medium">{opt.label}</div>
              <div className="text-[10px] text-muted-foreground">{opt.hint}</div>
            </div>
          </label>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------- SourcePickerRow

/**
 * v3 — pick a DataSource (file/rest/webhook/stream) as the layer's
 * canonical data pool. Loads all sources for the current tenant and
 * groups them by entity_kind so the user sees at-a-glance which ones
 * fit their target kind. Optional — leaving unset falls through to
 * the legacy stream-only read path.
 */
function SourcePickerRow({
  value,
  onChange,
}: {
  value: number | null
  onChange: (id: number | null) => void
}) {
  const { t } = useTranslation()
  const tenantId = useCurrentTenantId()
  const sourcesQuery = useApiQuery(
    () => apiDb.dataSources.toArray(),
    ['data-sources', tenantId, 'data-link-editor'],
    { intervalMs: 0 },
  )
  const sources = sourcesQuery.data ?? []

  return (
    <div className="grid gap-1.5">
      <Label htmlFor="dl-source">
        {t('dataLink.source', { defaultValue: 'Data source (v3)' })}
      </Label>
      <select
        id="dl-source"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
      >
        <option value="">
          {t('dataLink.sourcePlaceholder', {
            defaultValue: '— none (use legacy stream picker below) —',
          })}
        </option>
        {sources.map((s) => (
          <option key={s.id} value={s.id ?? ''}>
            {s.name} · {s.entityKind ?? 'marker'} · {s.kind}
          </option>
        ))}
      </select>
      {sources.length === 0 && (
        <p className="text-[10px] text-muted-foreground">
          {t('dataLink.noSources', {
            defaultValue:
              'No data sources yet. Go to /integrations to add one.',
          })}
        </p>
      )}
    </div>
  )
}
