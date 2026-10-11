import {
  Box,
  Camera,
  Compass,
  Download,
  Fullscreen,
  Layers as LayersIcon,
  Maximize2,
  Minimize2,
  Minus,
  Pencil,
  Plus,
  Printer,
  QrCode,
  Ruler,
  Share2,
  Square,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { MAP_STYLE_IDS, defaultStyleLabel, type MapStyleId } from '@/components/mapbox-map'

export type LayerKind =
  | 'racks'
  | 'bins'
  | 'markers'
  | 'models'
  | 'images'
  | 'imagePlanes'
  | 'text'
  | 'stairs'
  | 'polygons'
  | 'circles'
  | 'lines'
  | 'doors'
  // ---- Live data layers (Phase 6) ----
  | 'assets'
  | 'sensors'
  | 'sensorTint'
  | 'rfid'
  | 'cvDetection'
  | 'shipments'
  | 'cameras'
  | 'rules'

export interface LayerVisibility {
  racks: boolean
  bins: boolean
  markers: boolean
  models: boolean
  images: boolean
  imagePlanes: boolean
  text: boolean
  stairs: boolean
  polygons: boolean
  circles: boolean
  lines: boolean
  doors: boolean
  assets: boolean
  sensors: boolean
  sensorTint: boolean
  rfid: boolean
  cvDetection: boolean
  shipments: boolean
  cameras: boolean
  rules: boolean
}

// Sourced from `/map-styles.json` via `MAP_STYLE_IDS` so the picker
// in this popover, the top-strip picker, and the editor toolbar all
// render the same options without any drift.
const STYLE_OPTIONS: { id: MapStyleId; key: string; fallback: string }[] = MAP_STYLE_IDS.map((id) => ({
  id,
  key: `view.controls.style.${id}`,
  fallback: defaultStyleLabel(id),
}))

const GEOMETRY_LAYER_KEYS: { kind: LayerKind; key: string; fallback: string }[] = [
  { kind: 'racks', key: 'view.controls.layerRacks', fallback: 'Racks' },
  { kind: 'bins', key: 'view.controls.layerBins', fallback: 'Bins' },
  { kind: 'markers', key: 'view.controls.layerMarkers', fallback: 'Markers' },
  { kind: 'models', key: 'view.controls.layerModels', fallback: '3D models' },
  { kind: 'images', key: 'view.controls.layerImages', fallback: 'Floor plans' },
  { kind: 'imagePlanes', key: 'view.controls.layerImagePlanes', fallback: 'Image planes' },
  { kind: 'text', key: 'view.controls.layerText', fallback: 'Text labels' },
  { kind: 'stairs', key: 'view.controls.layerStairs', fallback: 'Stairs' },
  { kind: 'polygons', key: 'view.controls.layerPolygons', fallback: 'Polygons' },
  { kind: 'circles', key: 'view.controls.layerCircles', fallback: 'Circles' },
  { kind: 'lines', key: 'view.controls.layerLines', fallback: 'Lines' },
  { kind: 'doors', key: 'view.controls.layerDoors', fallback: 'Doors' },
]

/** Same shape, but separated so the popover can render a "Live data"
 * section under a divider. These overlays pull their data from the
 * same auth-scoped endpoints the editor hits, so they automatically
 * inherit whatever the user's tenant context allows. */
const LIVE_LAYER_KEYS: { kind: LayerKind; key: string; fallback: string }[] = [
  { kind: 'assets', key: 'view.controls.layerAssets', fallback: 'Assets' },
  { kind: 'sensors', key: 'view.controls.layerSensors', fallback: 'Sensors' },
  { kind: 'sensorTint', key: 'view.controls.layerSensorTint', fallback: 'Sensor tint' },
  { kind: 'rfid', key: 'view.controls.layerRfid', fallback: 'RFID heatmap' },
  { kind: 'cvDetection', key: 'view.controls.layerCvDetection', fallback: 'CV detection' },
  { kind: 'shipments', key: 'view.controls.layerShipments', fallback: 'Shipments' },
  { kind: 'cameras', key: 'view.controls.layerCameras', fallback: 'Cameras' },
  { kind: 'rules', key: 'view.controls.layerRules', fallback: 'Style rules' },
]

interface ViewControlsProps {
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  isFullscreen: boolean
  onToggleFullscreen: () => void
  mapStyle: MapStyleId
  onMapStyleChange: (s: MapStyleId) => void
  layers: LayerVisibility
  onLayerToggle: (k: LayerKind) => void
  onScreenshot: () => void
  onPrint: () => void
  onShare: () => void
  /** Current map bearing in degrees. Drives the compass needle rotation. */
  bearing: number
  /** Reset bearing + pitch to 0 (north-up, flat). */
  onResetNorth: () => void
  /** True when the camera is pitched enough to count as "3D mode". */
  is3D: boolean
  /** Flip between flat 2D and 3D pitched view. */
  onToggle3D: () => void
  /** Current scale-bar unit (metric / imperial). */
  scaleUnit: 'metric' | 'imperial'
  /** Flip the scale bar between metric and imperial. */
  onToggleScaleUnit: () => void
  /** Download the visible layout as a GeoJSON FeatureCollection. */
  onGeoJSONExport: () => void
  /** True when the viewer is in kiosk mode. Drops chrome that doesn't
   * make sense on a fixed touchscreen (share/screenshot/fullscreen/
   * print/geojson) and bumps every button to a 44x44 touch target. */
  kioskMode?: boolean
  /** Measurement tool active state + toggle. */
  measuring: boolean
  onToggleMeasure: () => void
  /** Open the QR-code "continue on phone" dialog. */
  onOpenQrShare: () => void
}

export function ViewControls({
  onZoomIn,
  onZoomOut,
  onFit,
  isFullscreen,
  onToggleFullscreen,
  mapStyle,
  onMapStyleChange,
  layers,
  onLayerToggle,
  onScreenshot,
  onPrint,
  onShare,
  bearing,
  onResetNorth,
  is3D,
  onToggle3D,
  scaleUnit,
  onToggleScaleUnit,
  onGeoJSONExport,
  kioskMode = false,
  measuring,
  onToggleMeasure,
  onOpenQrShare,
}: ViewControlsProps) {
  const { t } = useTranslation()
  const [layersOpen, setLayersOpen] = useState(false)
  // Single source of truth for the touch-target size. Kiosk mode bumps
  // every button to 44x44 (Apple HIG min); default stays compact.
  const btnSize = kioskMode ? 'h-11 w-11' : 'h-9 w-9'

  return (
    <div className="fixed top-12 end-3 z-20 flex flex-col gap-1.5">
      <Button variant="outline" size="icon" className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`} onClick={onZoomIn} aria-label={t('view.controls.zoomIn', { defaultValue: 'Zoom in' })}>
        <Plus className="w-4 h-4" />
      </Button>
      <Button variant="outline" size="icon" className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`} onClick={onZoomOut} aria-label={t('view.controls.zoomOut', { defaultValue: 'Zoom out' })}>
        <Minus className="w-4 h-4" />
      </Button>
      <Button variant="outline" size="icon" className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`} onClick={onFit} aria-label={t('view.controls.fit', { defaultValue: 'Fit to layout' })}>
        <Maximize2 className="w-4 h-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`}
        onClick={onResetNorth}
        aria-label={t('view.controls.resetNorth', { defaultValue: 'Reset bearing (north up)' })}
        title={t('view.controls.resetNorth', { defaultValue: 'Reset bearing (north up)' })}
      >
        <Compass
          className="w-4 h-4 transition-transform duration-100"
          style={{ transform: `rotate(${-bearing}deg)` }}
        />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className={`${btnSize} bg-card/95 backdrop-blur shadow-sm ${is3D ? 'ring-1 ring-primary' : ''}`}
        onClick={onToggle3D}
        aria-label={
          is3D
            ? t('view.controls.flatten', { defaultValue: 'Switch to 2D' })
            : t('view.controls.tilt', { defaultValue: 'Switch to 3D' })
        }
        title={
          is3D
            ? t('view.controls.flatten', { defaultValue: 'Switch to 2D' })
            : t('view.controls.tilt', { defaultValue: 'Switch to 3D' })
        }
      >
        {is3D ? <Box className="w-4 h-4" /> : <Square className="w-4 h-4" />}
      </Button>
      <Button
        variant="outline"
        size="icon"
        className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`}
        onClick={onToggleScaleUnit}
        aria-label={
          scaleUnit === 'metric'
            ? t('view.controls.switchImperial', { defaultValue: 'Switch scale to imperial' })
            : t('view.controls.switchMetric', { defaultValue: 'Switch scale to metric' })
        }
        title={
          scaleUnit === 'metric'
            ? t('view.controls.unitMetric', { defaultValue: 'Scale: metric (m / km)' })
            : t('view.controls.unitImperial', { defaultValue: 'Scale: imperial (ft / mi)' })
        }
      >
        <span className="relative">
          <Ruler className="w-4 h-4" />
          <span className="absolute -bottom-2 -end-2 text-[7px] font-bold leading-none">
            {scaleUnit === 'metric' ? 'm' : 'ft'}
          </span>
        </span>
      </Button>
      <Button
        variant="outline"
        size="icon"
        className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`}
        onClick={onOpenQrShare}
        aria-label={t('view.controls.qrShare', { defaultValue: 'Share via QR code' })}
        title={t('view.controls.qrShare', { defaultValue: 'Continue on phone' })}
      >
        <QrCode className="w-4 h-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className={`${btnSize} bg-card/95 backdrop-blur shadow-sm ${measuring ? 'ring-1 ring-primary' : ''}`}
        onClick={onToggleMeasure}
        aria-label={
          measuring
            ? t('view.controls.measureExit', { defaultValue: 'Exit measure tool' })
            : t('view.controls.measure', { defaultValue: 'Measure distance' })
        }
        aria-pressed={measuring}
        title={t('view.controls.measure', { defaultValue: 'Measure distance' })}
      >
        <Pencil className="w-4 h-4" />
      </Button>
      {!kioskMode && (
        <Button variant="outline" size="icon" className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`} onClick={onToggleFullscreen} aria-label={isFullscreen ? t('view.controls.fullscreenExit', { defaultValue: 'Exit fullscreen' }) : t('view.controls.fullscreen', { defaultValue: 'Fullscreen' })}>
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Fullscreen className="w-4 h-4" />}
        </Button>
      )}

      {/* Map style dropdown */}
      <div className="relative">
        <select
          value={mapStyle}
          onChange={(e) => onMapStyleChange(e.target.value as MapStyleId)}
          aria-label={t('view.controls.style', { defaultValue: 'Map style' })}
          className={`${btnSize} appearance-none bg-card/95 backdrop-blur shadow-sm border border-input rounded-md text-xs pl-1.5 pr-6 cursor-pointer flex items-center justify-center`}
          title={t('view.controls.style', { defaultValue: 'Map style' })}
        >
          {STYLE_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {t(opt.key, { defaultValue: opt.fallback })}
            </option>
          ))}
        </select>
      </div>

      {/* Layers popover */}
      <div className="relative">
        <Button variant="outline" size="icon" className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`} onClick={() => setLayersOpen((v) => !v)} aria-label={t('view.controls.layers', { defaultValue: 'Layers' })} aria-expanded={layersOpen}>
          <LayersIcon className="w-4 h-4" />
        </Button>
        {layersOpen && (
          <div className="absolute top-0 end-11 bg-card border rounded-md shadow-md p-2 min-w-[170px] max-h-[70dvh] overflow-y-auto">
            <div className="text-xs font-semibold mb-1 text-muted-foreground">
              {t('view.controls.layers', { defaultValue: 'Layers' })}
            </div>
            {GEOMETRY_LAYER_KEYS.map(({ kind, key, fallback }) => (
              <label key={kind} className="flex items-center gap-2 py-1 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={layers[kind]}
                  onChange={() => onLayerToggle(kind)}
                  className="h-3 w-3"
                />
                {t(key, { defaultValue: fallback })}
              </label>
            ))}

            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-2 pt-2 border-t mb-1">
              {t('view.controls.liveData', { defaultValue: 'Live data' })}
            </div>
            {LIVE_LAYER_KEYS.map(({ kind, key, fallback }) => (
              <label key={kind} className="flex items-center gap-2 py-1 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={layers[kind]}
                  onChange={() => onLayerToggle(kind)}
                  className="h-3 w-3"
                />
                {t(key, { defaultValue: fallback })}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Sharing / export tools don't make sense on a kiosk — the
          screen isn't owned by a person, it's owned by the venue. */}
      {!kioskMode && (
        <>
          <Button variant="outline" size="icon" className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`} onClick={onScreenshot} aria-label={t('view.controls.screenshot', { defaultValue: 'Screenshot (PNG)' })}>
            <Camera className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`}
            onClick={onGeoJSONExport}
            aria-label={t('view.controls.geojson', { defaultValue: 'Download GeoJSON' })}
            title={t('view.controls.geojson', { defaultValue: 'Download GeoJSON' })}
          >
            <Download className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="icon" className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`} onClick={onPrint} aria-label={t('view.controls.print', { defaultValue: 'Print' })}>
            <Printer className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="icon" className={`${btnSize} bg-card/95 backdrop-blur shadow-sm`} onClick={onShare} aria-label={t('view.controls.share', { defaultValue: 'Copy share link' })}>
            <Share2 className="w-4 h-4" />
          </Button>
        </>
      )}
    </div>
  )
}