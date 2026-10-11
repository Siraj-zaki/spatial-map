import {
  Box,
  Camera,
  Compass,
  Download,
  Fullscreen,
  Layers as LayersIcon,
  Map as MapIcon,
  MapPin,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Printer,
  QrCode,
  Ruler,
  Share2,
  Square,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MAP_STYLE_IDS, defaultStyleLabel, type MapStyleId } from '@/components/mapbox-map'
import type { ImageShape } from '@/lib/shapes'
import type { LayerKind, LayerVisibility } from '@/components/view/view-controls'
import { LanguageSwitcher } from '@/components/language-switcher'
import { ModeToggle } from '@/components/mode-toggle'

interface ViewTopStripProps {
  warehouseName: string
  warehouseAddress?: string
  // Floor selector
  floorPlans: ReadonlyArray<ImageShape & { id: number }>
  selectedFloorPlanId: number | null
  onSelectFloorPlan: (id: number | null) => void
  // Camera + sharing actions
  mapStyle: MapStyleId
  onMapStyleChange: (s: MapStyleId) => void
  layers: LayerVisibility
  onLayerToggle: (k: LayerKind) => void
  scaleUnit: 'metric' | 'imperial'
  onToggleScaleUnit: () => void
  is3D: boolean
  onToggle3D: () => void
  bearing: number
  onResetNorth: () => void
  isFullscreen: boolean
  onToggleFullscreen: () => void
  measuring: boolean
  onToggleMeasure: () => void
  onFit: () => void
  onScreenshot: () => void
  onPrint: () => void
  onShare: () => void
  onGeoJSONExport: () => void
  onOpenQrShare: () => void
}

// Map style picker — populated from `/map-styles.json` via
// `MAP_STYLE_IDS` so adding a new entry to the JSON automatically
// surfaces it in the UI. Per-style i18n keys follow a stable pattern
// (`view.controls.style.<id>`) so translators can override labels
// without touching code.
const STYLE_OPTIONS: { id: MapStyleId; key: string; fallback: string }[] = MAP_STYLE_IDS.map((id) => ({
  id,
  key: `view.controls.style.${id}`,
  fallback: defaultStyleLabel(id),
}))

const GEOMETRY_LAYERS: { kind: LayerKind; key: string; fallback: string }[] = [
  { kind: 'racks', key: 'view.controls.layerRacks', fallback: 'Racks' },
  { kind: 'bins', key: 'view.controls.layerBins', fallback: 'Bins' },
  { kind: 'markers', key: 'view.controls.layerMarkers', fallback: 'Markers' },
  { kind: 'models', key: 'view.controls.layerModels', fallback: '3D models' },
  { kind: 'images', key: 'view.controls.layerImages', fallback: 'Floor plans' },
  { kind: 'text', key: 'view.controls.layerText', fallback: 'Text labels' },
  { kind: 'stairs', key: 'view.controls.layerStairs', fallback: 'Stairs' },
  { kind: 'polygons', key: 'view.controls.layerPolygons', fallback: 'Polygons' },
  { kind: 'circles', key: 'view.controls.layerCircles', fallback: 'Circles' },
  { kind: 'lines', key: 'view.controls.layerLines', fallback: 'Lines' },
]

const LIVE_LAYERS: { kind: LayerKind; key: string; fallback: string }[] = [
  { kind: 'assets', key: 'view.controls.layerAssets', fallback: 'Assets' },
  { kind: 'sensors', key: 'view.controls.layerSensors', fallback: 'Sensors' },
  { kind: 'sensorTint', key: 'view.controls.layerSensorTint', fallback: 'Sensor tint' },
  { kind: 'rfid', key: 'view.controls.layerRfid', fallback: 'RFID heatmap' },
  { kind: 'cvDetection', key: 'view.controls.layerCvDetection', fallback: 'CV detection' },
  { kind: 'shipments', key: 'view.controls.layerShipments', fallback: 'Shipments' },
  { kind: 'cameras', key: 'view.controls.layerCameras', fallback: 'Cameras' },
  { kind: 'rules', key: 'view.controls.layerRules', fallback: 'Style rules' },
]

function signageLabel(name: string): string {
  if (!name) return '?'
  const trimmed = name.trim()
  if (!trimmed) return '?'
  if (/^(ground|gnd|main)/i.test(trimmed)) return 'GL'
  const level = /^(?:level|floor|fl|l|story)\s*(\d+)/i.exec(trimmed)
  if (level) return `L${level[1]}`
  const basement = /^(?:basement|b|sub)\s*(\d+)?/i.exec(trimmed)
  if (basement) return `B${basement[1] ?? '1'}`
  if (/^\d+$/.test(trimmed)) return `L${trimmed}`
  return trimmed.slice(0, 2).toUpperCase()
}

/**
 * Slim top strip — the only persistent chrome above the map. Holds the
 * warehouse identity on the left, the floor selector in the centre,
 * and an actions popover on the right (style / layers / measure /
 * camera state / sharing). Replaces the editor-style vertical button
 * stack that previously lived top-right.
 */
export function ViewTopStrip({
  warehouseName,
  warehouseAddress,
  floorPlans,
  selectedFloorPlanId,
  onSelectFloorPlan,
  mapStyle,
  onMapStyleChange,
  layers,
  onLayerToggle,
  scaleUnit,
  onToggleScaleUnit,
  is3D,
  onToggle3D,
  bearing,
  onResetNorth,
  isFullscreen,
  onToggleFullscreen,
  measuring,
  onToggleMeasure,
  onFit,
  onScreenshot,
  onPrint,
  onShare,
  onGeoJSONExport,
  onOpenQrShare,
}: ViewTopStripProps) {
  const { t } = useTranslation()
  const [actionsOpen, setActionsOpen] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [floorsOpen, setFloorsOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const layersPopoverRef = useRef<HTMLDivElement | null>(null)
  const floorsPopoverRef = useRef<HTMLDivElement | null>(null)

  // Close popovers on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popoverRef.current && !popoverRef.current.contains(t)) setActionsOpen(false)
      if (layersPopoverRef.current && !layersPopoverRef.current.contains(t)) setLayersOpen(false)
      if (floorsPopoverRef.current && !floorsPopoverRef.current.contains(t)) setFloorsOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  const orderedFloors = useMemo(
    () =>
      floorPlans
        .slice()
        .sort((a, b) => a.id - b.id)
        .map((fp) => ({ ...fp, label: signageLabel(fp.name || `Floor #${fp.id}`) })),
    [floorPlans],
  )

  const selectedFloor = useMemo(
    () => orderedFloors.find((fp) => fp.id === selectedFloorPlanId),
    [orderedFloors, selectedFloorPlanId],
  )

  return (
    <header className="flex items-center gap-3 h-12 px-3 border-b bg-card/95 backdrop-blur-md shadow-sm z-30 flex-shrink-0">
      {/* Left — identity */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="h-7 w-7 rounded-md bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
          <MapPin className="w-3.5 h-3.5" />
        </span>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-bold leading-tight truncate">{warehouseName}</span>
          {warehouseAddress && (
            <span className="text-[10px] text-muted-foreground leading-tight truncate">{warehouseAddress}</span>
          )}
        </div>
      </div>

      {/* Center — floor selector */}
      {orderedFloors.length > 0 && (
        <div className="relative flex-shrink-0" ref={floorsPopoverRef}>
          <button
            type="button"
            onClick={() => setFloorsOpen((v) => !v)}
            aria-expanded={floorsOpen}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border bg-card hover:bg-muted/60 transition-colors text-xs font-medium"
          >
            <MapIcon className="w-3.5 h-3.5 text-primary" />
            <span>
              {selectedFloorPlanId === null
                ? t('view.floor.all', { defaultValue: 'All Floors' })
                : selectedFloor?.name || `Floor #${selectedFloorPlanId}`}
            </span>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {selectedFloorPlanId === null
                ? `(${orderedFloors.length})`
                : selectedFloor?.label}
            </span>
          </button>
          {floorsOpen && (
            <div className="absolute top-10 start-1/2 -translate-x-1/2 z-40 bg-card border rounded-md shadow-md min-w-[180px] py-1">
              <button
                type="button"
                onClick={() => { onSelectFloorPlan(null); setFloorsOpen(false) }}
                className={`w-full text-start px-3 py-1.5 text-xs hover:bg-muted/60 ${selectedFloorPlanId === null ? 'font-semibold text-primary' : ''}`}
              >
                {t('view.floor.all', { defaultValue: 'All Floors' })}
              </button>
              <div className="border-t my-1" />
              {orderedFloors.map((fp) => (
                <button
                  key={fp.id}
                  type="button"
                  onClick={() => { onSelectFloorPlan(fp.id); setFloorsOpen(false) }}
                  className={`w-full text-start px-3 py-1.5 text-xs hover:bg-muted/60 flex items-center justify-between gap-2 ${selectedFloorPlanId === fp.id ? 'font-semibold text-primary' : ''}`}
                >
                  <span className="truncate">{fp.name || `Floor #${fp.id}`}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">{fp.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Right — actions */}
      <div className="flex items-center gap-1 flex-1 justify-end">
        <button
          type="button"
          onClick={onResetNorth}
          aria-label={t('view.controls.resetNorth', { defaultValue: 'Reset bearing' })}
          title={t('view.controls.resetNorth', { defaultValue: 'Reset bearing' })}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          <Compass
            className="w-4 h-4 transition-transform duration-100"
            style={{ transform: `rotate(${-bearing}deg)` }}
          />
        </button>
        <button
          type="button"
          onClick={onToggle3D}
          aria-label={is3D ? t('view.controls.flatten', { defaultValue: 'Switch to 2D' }) : t('view.controls.tilt', { defaultValue: 'Switch to 3D' })}
          title={is3D ? '2D' : '3D'}
          className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground ${is3D ? 'text-primary' : ''}`}
        >
          {is3D ? <Box className="w-4 h-4" /> : <Square className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={onToggleMeasure}
          aria-label={t('view.controls.measure', { defaultValue: 'Measure' })}
          title={t('view.controls.measure', { defaultValue: 'Measure' })}
          aria-pressed={measuring}
          className={`h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground ${measuring ? 'text-primary' : ''}`}
        >
          <Pencil className="w-4 h-4" />
        </button>

        {/* Layers popover */}
        <div className="relative" ref={layersPopoverRef}>
          <button
            type="button"
            onClick={() => setLayersOpen((v) => !v)}
            aria-label={t('view.controls.layers', { defaultValue: 'Layers' })}
            title={t('view.controls.layers', { defaultValue: 'Layers' })}
            aria-expanded={layersOpen}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <LayersIcon className="w-4 h-4" />
          </button>
          {layersOpen && (
            <div className="absolute top-10 end-0 z-40 bg-card border rounded-md shadow-md p-2 min-w-[200px] max-h-[70dvh] overflow-y-auto">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 px-1">
                {t('view.controls.layers', { defaultValue: 'Layers' })}
              </div>
              {GEOMETRY_LAYERS.map(({ kind, key, fallback }) => (
                <label key={kind} className="flex items-center gap-2 py-1 px-1 cursor-pointer text-xs rounded hover:bg-muted/60">
                  <input type="checkbox" checked={layers[kind]} onChange={() => onLayerToggle(kind)} className="h-3 w-3" />
                  {t(key, { defaultValue: fallback })}
                </label>
              ))}
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-2 pt-2 border-t mb-1 px-1">
                {t('view.controls.liveData', { defaultValue: 'Live data' })}
              </div>
              {LIVE_LAYERS.map(({ kind, key, fallback }) => (
                <label key={kind} className="flex items-center gap-2 py-1 px-1 cursor-pointer text-xs rounded hover:bg-muted/60">
                  <input type="checkbox" checked={layers[kind]} onChange={() => onLayerToggle(kind)} className="h-3 w-3" />
                  {t(key, { defaultValue: fallback })}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Visual divider before the cross-app utilities. */}
        <div className="hidden sm:block w-px h-5 bg-border mx-1" />

        {/* App-wide utilities — mirrored from the main App header so a
            visitor can change locale / theme without ever leaving the
            viewer. */}
        <LanguageSwitcher />
        <ModeToggle />

        {/* Actions popover */}
        <div className="relative" ref={popoverRef}>
          <button
            type="button"
            onClick={() => setActionsOpen((v) => !v)}
            aria-label={t('view.controls.actions', { defaultValue: 'More actions' })}
            aria-expanded={actionsOpen}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {actionsOpen && (
            <div className="absolute top-10 end-0 z-40 bg-card border rounded-md shadow-md py-1 min-w-[210px]">
              <ActionRow
                icon={<Maximize2 className="w-3.5 h-3.5" />}
                label={t('view.controls.fit', { defaultValue: 'Fit to layout' })}
                onClick={() => { onFit(); setActionsOpen(false) }}
              />
              <ActionRow
                icon={isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Fullscreen className="w-3.5 h-3.5" />}
                label={isFullscreen ? t('view.controls.fullscreenExit', { defaultValue: 'Exit fullscreen' }) : t('view.controls.fullscreen', { defaultValue: 'Fullscreen' })}
                onClick={() => { onToggleFullscreen(); setActionsOpen(false) }}
              />
              <div className="border-t my-1" />

              {/* Style picker */}
              <div className="px-3 py-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                  {t('view.controls.style', { defaultValue: 'Map style' })}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {STYLE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => { onMapStyleChange(opt.id); setActionsOpen(false) }}
                      className={`px-2 py-1 text-[11px] rounded border ${
                        mapStyle === opt.id
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'hover:bg-muted/60'
                      }`}
                    >
                      {t(opt.key, { defaultValue: opt.fallback })}
                    </button>
                  ))}
                </div>
              </div>

              {/* Scale unit */}
              <div className="px-3 py-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                  {t('view.controls.scale', { defaultValue: 'Scale' })}
                </div>
                <button
                  type="button"
                  onClick={() => { onToggleScaleUnit(); setActionsOpen(false) }}
                  className="inline-flex items-center gap-2 h-7 px-2 text-[11px] rounded border hover:bg-muted/60 w-full justify-between"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Ruler className="w-3 h-3" />
                    {scaleUnit === 'metric'
                      ? t('view.controls.unitMetric', { defaultValue: 'Metric (m / km)' })
                      : t('view.controls.unitImperial', { defaultValue: 'Imperial (ft / mi)' })}
                  </span>
                  <span className="text-muted-foreground">⇄</span>
                </button>
              </div>

              <div className="border-t my-1" />
              <ActionRow
                icon={<QrCode className="w-3.5 h-3.5" />}
                label={t('view.controls.qrShare', { defaultValue: 'Continue on phone' })}
                onClick={() => { onOpenQrShare(); setActionsOpen(false) }}
              />
              <ActionRow
                icon={<Share2 className="w-3.5 h-3.5" />}
                label={t('view.controls.share', { defaultValue: 'Copy share link' })}
                onClick={() => { onShare(); setActionsOpen(false) }}
              />
              <ActionRow
                icon={<Camera className="w-3.5 h-3.5" />}
                label={t('view.controls.screenshot', { defaultValue: 'Screenshot (PNG)' })}
                onClick={() => { onScreenshot(); setActionsOpen(false) }}
              />
              <ActionRow
                icon={<Download className="w-3.5 h-3.5" />}
                label={t('view.controls.geojson', { defaultValue: 'Download GeoJSON' })}
                onClick={() => { onGeoJSONExport(); setActionsOpen(false) }}
              />
              <ActionRow
                icon={<Printer className="w-3.5 h-3.5" />}
                label={t('view.controls.print', { defaultValue: 'Print' })}
                onClick={() => { onPrint(); setActionsOpen(false) }}
              />
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

function ActionRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors text-start"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span>{label}</span>
    </button>
  )
}
