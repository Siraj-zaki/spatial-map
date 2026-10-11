import { MAP_STYLE_IDS, defaultStyleLabel, type MapStyleId } from '@/components/mapbox-map'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useRailTooltip } from '@/components/rail-tooltip'
import {
  Box,
  BoxSelect,
  Check,
  Circle as CircleIcon,
  Database,
  DoorOpen,
  Download,
  Eye,
  FileImage,
  FileJson,
  FileUp,
  Grid3x3,
  Hand,
  Image as ImageIcon,
  Keyboard,
  Layers,
  Link2,
  Map as MapIcon,
  MapPin,
  Pencil,
  Pentagon,
  Spline,
  Footprints,
  Frame,
  ListChecks,
  MousePointer2,
  Navigation,
  Pin,
  Route as RouteIcon,
  RotateCw,
  Sparkles,
  Type,
  Wand2,
  Warehouse,
} from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { type Tool, preferredKeyForTool } from '@/lib/keyboard-shortcuts'

export type MapToolbarTool = Tool

/**
 * Per-layer visibility map. One switch per kind in the toolbar's
 * Layers dropdown. `zones` is included even though it isn't a map
 * geometry — it gates the "Warehouses" workspace-tree section so a
 * single dropdown surfaces every "show / hide" knob the user has.
 */
export type LayerVisibilityKind =
  | 'grid'
  | 'marker'
  | 'circle'
  | 'polygon'
  | 'line'
  | 'route'
  | 'image'
  | 'model'
  | 'imagePlane'
  | 'text'
  | 'stair'
  | 'door'
  | 'zones'

export type LayerVisibility = Record<LayerVisibilityKind, boolean>

interface MapToolbarProps {
  onZoomIn?: () => void
  onZoomOut?: () => void
  mapStyle?: MapStyleId
  onMapStyleChange?: (style: MapStyleId) => void
  /** Active tool. Two-way binding — toolbar shows the active one highlighted. */
  activeTool: Tool
  onActiveToolChange?: (tool: Tool) => void
  /**
   * Per-layer visibility — drives the new Layers dropdown. The two
   * legacy single-purpose toggles (grid + zones) were collapsed into
   * one dropdown so the toolbar shows every show/hide knob in a
   * single, discoverable place.
   */
  layerVisibility: LayerVisibility
  onLayerVisibilityChange?: (kind: LayerVisibilityKind, visible: boolean) => void
  /** Click handlers for the formerly-dead buttons. */
  onImport?: (file: File) => void
  onExportGeoJSON?: () => void
  onExportPNG?: () => void
  /**
   * Opens the comprehensive Export dialog (scope + kind picker + format
   * picker). Preferred over `onExportGeoJSON` which stays as a legacy
   * one-click fallback for callers that haven't migrated yet.
   */
  onOpenExportDialog?: () => void
  onFocusZones?: () => void
  /** Opens the Data-Link import wizard (CSV → bins). */
  onOpenDataLink?: () => void
  /**
   * Opens the bulk-assign dialog (warehouse + floor plan) for the
   * current multi-selection. The button is disabled when no items
   * are selected — the host passes a falsy `selectedCount` in that
   * case to render the disabled state without spawning the dialog.
   */
  onOpenBulkAssign?: () => void
  /** Total selected shapes across all kinds. 0 disables the button. */
  selectedCount?: number
  /** When true, shows a "Preview" button that navigates to the live view. */
  showPreviewButton?: boolean
  /** Called when the user clicks the Preview button. */
  onPreview?: () => void
  /** Opens the rich share-link dialog (see components/share-link-dialog.tsx).
   *  Only rendered when a warehouse is active. */
  onOpenShare?: () => void
  /** When true, the toolbar is in live-preview mode: creation tools are hidden. */
  preview?: boolean
  /** Opens the keyboard shortcuts cheatsheet (`?` overlay). */
  onOpenCheatsheet?: () => void
  /**
   * Opens the Schema Builder dialog. Lets the user define which custom
   * fields each shape kind exposes (sku, qty, image, status, etc.) —
   * those fields then appear in the linked-data editor and become
   * pickable in style-rule conditions.
   */
  onOpenSchemaBuilder?: () => void
  /**
   * Default floor plan for newly-drawn shapes. When set, every
   * create-* tool auto-stamps this id onto the new shape's
   * `floorPlanId`, so the user doesn't have to bulk-assign afterward.
   * `null` = no default (shape floats free until manually assigned).
   * The picker below lists every visible floor-plan image so the user
   * can pick one, clear it, or leave it unset.
   */
  defaultFloorPlanId?: number | null
  onDefaultFloorPlanChange?: (id: number | null) => void
  /** Floor-plan candidates the picker shows. Already scoped by the host. */
  floorPlans?: ReadonlyArray<{ id: number; name: string }>
  /**
   * Slow auto-rotate of the map camera around the current centre.
   * Toggles a rAF-driven bearing sweep in the host route; the toolbar
   * only owns the button + visual pressed state. Available in both
   * editor and preview modes — presentation displays are the main
   * consumer, but the editor benefits too when demoing.
   */
  isAutoRotating?: boolean
  onToggleAutoRotate?: () => void
}

// Picker options for the editor toolbar — generated from
// `/map-styles.json` via `MAP_STYLE_IDS`. Each entry carries an i18n
// key (`toolbar.style.<id>`) plus a friendly fallback so the picker
// renders sensibly even before translations land.
const STYLE_OPTIONS: { id: MapStyleId; key: string; fallback: string }[] = MAP_STYLE_IDS.map((id) => ({
  id,
  key: `toolbar.style.${id}`,
  fallback: defaultStyleLabel(id),
}))

/**
 * Rows shown in the Layers dropdown — one per toggleable visibility
 * surface. Order mirrors the toolbar's create-* tool sequence
 * (grid → marker → circle → polygon → line → image → model → text)
 * so the dropdown reads as a visibility checklist of the same set
 * the user just drew with. `zones` is appended last because it
 * controls the workspace section rather than a map layer.
 */
const LAYER_ROWS: ReadonlyArray<{
  id: LayerVisibilityKind
  icon: typeof Hand
  labelKey: string
  fallback: string
}> = [
  { id: 'grid', icon: Grid3x3, labelKey: 'toolbar.layerGrid', fallback: 'Racks / grids' },
  { id: 'marker', icon: MapPin, labelKey: 'toolbar.layerMarker', fallback: 'Markers' },
  { id: 'circle', icon: CircleIcon, labelKey: 'toolbar.layerCircle', fallback: 'Circles' },
  { id: 'polygon', icon: Pentagon, labelKey: 'toolbar.layerPolygon', fallback: 'Polygons' },
  { id: 'line', icon: Spline, labelKey: 'toolbar.layerLine', fallback: 'Aisles / lines' },
  { id: 'route', icon: RouteIcon, labelKey: 'toolbar.layerRoute', fallback: 'Routes / paths' },
  { id: 'image', icon: ImageIcon, labelKey: 'toolbar.layerImage', fallback: 'Floor plans' },
  { id: 'model', icon: Box, labelKey: 'toolbar.layerModel', fallback: '3D models' },
  { id: 'imagePlane', icon: Frame, labelKey: 'toolbar.layerImagePlane', fallback: 'Image planes' },
  { id: 'text', icon: Type, labelKey: 'toolbar.layerText', fallback: 'Text labels' },
  { id: 'stair', icon: Footprints, labelKey: 'toolbar.layerStair', fallback: 'Stairs' },
  { id: 'door', icon: DoorOpen, labelKey: 'toolbar.layerDoor', fallback: 'Doors' },
  { id: 'zones', icon: Warehouse, labelKey: 'toolbar.layerZones', fallback: 'Facilities' },
]

/**
 * Portals a dropdown to `document.body` so it escapes the toolbar's
 * `overflow-y-auto` clip. Positioned with `position: fixed` at the
 * anchor button's inline-end edge (right in LTR, left in RTL). The
 * portal is needed because the toolbar container is a scroll container
 * — per CSS spec, `overflow-y: auto` clips on BOTH axes, so a child
 * `absolute start-full` popover would be hidden.
 */
function FloatingMenu({
  anchorRef,
  open,
  gap = 8,
  className,
  children,
  onMouseEnter,
  onMouseLeave,
  role,
  ariaLabel,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  open: boolean
  gap?: number
  className?: string
  children: React.ReactNode
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  role?: string
  ariaLabel?: string
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Track direction so we anchor on the correct side. Read at open time
  // (and re-check on layout) so a mid-session language switch is handled.
  const isRTL =
    typeof document !== 'undefined' && document.documentElement.dir === 'rtl'

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const update = () => {
      const el = anchorRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      // In LTR: anchor to the right edge. In RTL: anchor to the left
      // edge, offset by content width so the menu grows leftward. We
      // measure the portaled content once it's in the DOM to get its
      // width; until then, position on the LTR side as a first paint.
      if (isRTL && contentRef.current) {
        const cw = contentRef.current.getBoundingClientRect().width
        setPos({ top: rect.top, left: rect.left - gap - cw })
      } else {
        setPos({ top: rect.top, left: rect.right + gap })
      }
    }
    update()
    // Re-measure after paint so RTL width-based positioning stabilises.
    const raf = requestAnimationFrame(update)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchorRef, gap, isRTL])

  if (!open) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={contentRef}
      className={className}
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        zIndex: 50,
        // Invisible until we have a real position so the first frame
        // doesn't flash at the top-left corner of the viewport.
        visibility: pos ? 'visible' : 'hidden',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role={role}
      aria-label={ariaLabel}
    >
      {children}
    </div>,
    document.body,
  )
}

export const MapToolbar = memo(function MapToolbar({
  onZoomIn: _onZoomIn,
  onZoomOut: _onZoomOut,
  mapStyle,
  onMapStyleChange,
  activeTool,
  onActiveToolChange,
  layerVisibility,
  onLayerVisibilityChange,
  onImport,
  onExportGeoJSON,
  onExportPNG,
  onOpenExportDialog,
  onFocusZones,
  onOpenDataLink,
  onOpenBulkAssign,
  selectedCount = 0,
  showPreviewButton,
  onPreview,
  onOpenShare,
  preview = false,
  onOpenCheatsheet,
  onOpenSchemaBuilder,
  defaultFloorPlanId,
  onDefaultFloorPlanChange,
  floorPlans,
  isAutoRotating = false,
  onToggleAutoRotate,
}: MapToolbarProps) {
  const railTip = useRailTooltip()
  const { t } = useTranslation()
  const [styleMenuOpen, setStyleMenuOpen] = useState(false)
  const [layersMenuOpen, setLayersMenuOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [drawFlyoutOpen, setDrawFlyoutOpen] = useState(false)
  const [dataFlyoutOpen, setDataFlyoutOpen] = useState(false)
  const [defaultFloorMenuOpen, setDefaultFloorMenuOpen] = useState(false)
  const [aiComingSoonOpen, setAIComingSoonOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const exportRef = useRef<HTMLDivElement>(null)
  // Open-on-hover delays so the user can cross the gap between the
  // parent button and the flyout without it snapping shut.
  const drawFlyoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dataFlyoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Anchor refs for portaled dropdowns. Each menu is rendered to
  // document.body (see FloatingMenu) so it escapes the toolbar's
  // overflow clip; we position it via each trigger's bounding rect.
  const drawTriggerRef = useRef<HTMLButtonElement>(null)
  const defaultFloorTriggerRef = useRef<HTMLButtonElement>(null)
  const layersTriggerRef = useRef<HTMLButtonElement>(null)
  const styleTriggerRef = useRef<HTMLButtonElement>(null)
  const dataTriggerRef = useRef<HTMLButtonElement>(null)

  // Global click-outside for the click-based popovers. The old code
  // used per-popover full-viewport overlay divs, but those don't work
  // once popovers are portaled AND can trap clicks on other UI. This
  // effect closes any open click-based menu when the user clicks
  // outside both the trigger button and the menu itself.
  useEffect(() => {
    if (!layersMenuOpen && !styleMenuOpen && !defaultFloorMenuOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      const insideAnchor = (ref: React.RefObject<HTMLElement | null>) =>
        ref.current?.contains(target)
      // Menu contents live in document.body via portal, tagged with
      // data-toolbar-menu so we can identify them without holding a
      // ref to every portal instance.
      const menuEl = (target as Element).closest?.('[data-toolbar-menu]')
      if (menuEl) return
      if (layersMenuOpen && insideAnchor(layersTriggerRef)) return
      if (styleMenuOpen && insideAnchor(styleTriggerRef)) return
      if (defaultFloorMenuOpen && insideAnchor(defaultFloorTriggerRef)) return
      setLayersMenuOpen(false)
      setStyleMenuOpen(false)
      setDefaultFloorMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [layersMenuOpen, styleMenuOpen, defaultFloorMenuOpen])
  // `onZoomIn / onZoomOut` were moved to the header but stay on the
  // props interface so call sites don't break — silence the lint.
  void _onZoomIn
  void _onZoomOut

  // Click-outside to close popovers is implemented per-popover with a
  // full-screen overlay `div` (so the popovers close on any click outside
  // without coordinating across multiple states). No global effect needed.

  // Primary modes — always direct-click so they don't pay a flyout
  // delay (these get hit dozens of times per session).
  const modeTools: { id: Tool; icon: typeof Hand; labelKey: string }[] = [
    { id: 'pan', icon: Hand, labelKey: 'toolbar.toolPan' },
    { id: 'select', icon: MousePointer2, labelKey: 'toolbar.toolSelect' },
    { id: 'marquee', icon: BoxSelect, labelKey: 'toolbar.toolMarquee' },
    // Wayfinding — click point A then point B and the router draws
    // a wall-avoiding, door-passing path between them. Sits in the
    // mode row (not the draw flyout) because it's a viewing / query
    // tool, not a shape-creating one.
    { id: 'route-preview', icon: Navigation, labelKey: 'toolbar.toolRoutePreview' },
  ]

  // Creation tools — collapsed into a single Draw flyout button when
  // not in preview mode. The flyout's PARENT button shows whichever
  // creation tool is currently active so the user can always see which
  // sub-tool is live without having to expand. Falls back to a generic
  // pencil icon when no creation tool is selected.
  const drawTools: { id: Tool; icon: typeof Hand; labelKey: string }[] = [
    { id: 'create-grid', icon: Grid3x3, labelKey: 'toolbar.toolCreateGrid' },
    { id: 'create-marker', icon: MapPin, labelKey: 'toolbar.toolCreateMarker' },
    { id: 'create-circle', icon: CircleIcon, labelKey: 'toolbar.toolCreateCircle' },
    { id: 'create-polygon', icon: Pentagon, labelKey: 'toolbar.toolCreatePolygon' },
    { id: 'create-line', icon: Spline, labelKey: 'toolbar.toolCreateLine' },
    { id: 'create-route', icon: RouteIcon, labelKey: 'toolbar.toolCreateRoute' },
    { id: 'create-image', icon: ImageIcon, labelKey: 'toolbar.toolCreateImage' },
    { id: 'create-model', icon: Box, labelKey: 'toolbar.toolCreateModel' },
    { id: 'create-image-plane', icon: Frame, labelKey: 'toolbar.toolCreateImagePlane' },
    { id: 'create-text', icon: Type, labelKey: 'toolbar.toolCreateText' },
    { id: 'create-stair', icon: Footprints, labelKey: 'toolbar.toolCreateStair' },
    { id: 'create-door', icon: DoorOpen, labelKey: 'toolbar.toolCreateDoor' },
    { id: 'magic-wall', icon: Wand2, labelKey: 'toolbar.toolMagicWall' },
    { id: 'ai-map', icon: Sparkles, labelKey: 'toolbar.toolAIMap' },
  ]
  const activeDrawTool = drawTools.find((d) => d.id === activeTool)
  const DrawParentIcon = activeDrawTool?.icon ?? Pencil

  const handleToolClick = (tool: Tool, onClick?: () => void) => {
    onActiveToolChange?.(tool)
    onClick?.()
  }

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onImport?.(file)
    // Reset so the same file can be re-selected later.
    e.target.value = ''
  }

  return (
    /* Rail container — glassy floating card matching the dashboard
       language, tinted with a VERTICAL primary gradient that covers
       almost the full rail height. Two CSS properties layer on the
       same element (no pseudo needed):
         - background-color: bg-card/85 in light, bg-card/95 in dark.
           The dark mode is nearly opaque because the underlying map
           can be a light-coloured floor plan; letting a bright bitmap
           bleed through a semi-transparent DARK card washes the icon
           colour out into low-contrast mush. Light mode can stay a
           bit glassy because the map + rail contrast holds.
         - background-image: linear-gradient via `bg-gradient-to-b
           from-primary/25 via-primary/15 to-primary/5` — the primary-
           tinted wash. Ends at /5 (not transparent) so the tint is
           still visible at the very bottom, delivering the full-
           height coverage requested. Alphas match the page-mesh
           bumped ~2× so the tint reads clearly on the narrow rail.

       Shadow stack + inner ring for depth against the map canvas. */
    /*
     * Background: the previous attempt used `bg-card` + a Tailwind
     * `bg-gradient-to-b` on the same element, but the gradient's
     * `background-image` was somehow shadowing the `background-color`,
     * leaving the rail see-through. Fixed by using a single
     * `background` inline style that stacks the linear-gradient over
     * an OPAQUE `hsl(var(--card))` layer — same technique used for
     * the sgv-mesh-bg utility. Guarantees the base card colour is
     * always painted; the gradient stops still supply the palette tint.
     */
    <div
      {...railTip.handlers}
      className={cn(
        'sgv-scroll-hide absolute z-10 flex flex-col items-center w-14 gap-0.5 p-1.5 -translate-y-1/2 start-4 top-1/2',
        'max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain',
        'border border-border/60 rounded-2xl',
        'shadow-xl',
      )}
      style={{
        // Stacked backgrounds: the gradient is painted first (on top),
        // then the solid card colour beneath. Where the gradient is
        // transparent (bottom), the card colour shows through.
        background:
          'linear-gradient(to bottom, hsl(var(--primary) / 0.15), hsl(var(--primary) / 0.08), transparent), hsl(var(--card))',
      }}
    >
      {railTip.node}
      {/* Hidden file input for Import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        onChange={handleFile}
        className="hidden"
        aria-hidden="true"
      />

      {/*
       * Auto-rotate — slow, continuous CW rotation of the map camera
       * around the current centre for hands-off presentation displays.
       * Placed at the top (above Preview) so it's the first view
       * control the user reaches, and NOT gated on `showPreviewButton`
       * so the presenter's read-only view can toggle it too. Its own
       * divider only renders when Preview / Share below aren't going
       * to add one for us.
       */}
      {onToggleAutoRotate && (
        <>
          <Button
            variant={isAutoRotating ? 'default' : 'secondary'}
            size="icon"
            onClick={onToggleAutoRotate}
            className={cn(
              'w-9 h-9 rounded-lg relative transition-all',
              isAutoRotating
                ? 'ring-2 ring-primary/60 shadow-md scale-105'
                : 'hover:bg-primary/5 hover:text-primary',
            )}
            title={
              isAutoRotating
                ? t('toolbar.autoRotateStop', {
                    defaultValue: 'Stop auto-rotate',
                  })
                : t('toolbar.autoRotateStart', {
                    defaultValue: 'Auto-rotate map view',
                  })
            }
            aria-label={
              isAutoRotating
                ? t('toolbar.autoRotateStop', {
                    defaultValue: 'Stop auto-rotate',
                  })
                : t('toolbar.autoRotateStart', {
                    defaultValue: 'Auto-rotate map view',
                  })
            }
            aria-pressed={isAutoRotating}
          >
            <RotateCw
              className={cn('w-[18px] h-[18px]', isAutoRotating && 'animate-spin')}
              // Slow ~4s spin — the default `animate-spin` at 1s is
              // frantic on a static icon. This gives at-a-glance "on"
              // feedback without becoming the star of the toolbar; the
              // map itself is the primary rotation cue.
              style={isAutoRotating ? { animationDuration: '4s' } : undefined}
            />
          </Button>
          {!showPreviewButton && (
            <div className="h-px w-6 bg-border/60 my-1" aria-hidden="true" />
          )}
        </>
      )}

      {/* Preview — opens the live operations view for the current warehouse. */}
      {showPreviewButton && (
        <>
          <Button
            variant="secondary"
            size="icon"
            onClick={onPreview}
            disabled={!onPreview}
            className="w-9 h-9 rounded-lg"
            title={t('toolbar.preview', { defaultValue: 'Preview live view' })}
            aria-label={t('toolbar.preview', { defaultValue: 'Preview live view' })}
          >
            <Eye className="w-[18px] h-[18px]" />
          </Button>
          {/* Share — opens the rich share-link dialog. Grouped with Preview
              so users find it in the same visual cluster. Only present when
              a warehouse is active (parent gates the callback prop). */}
          {onOpenShare && (
            <Button
              variant="secondary"
              size="icon"
              onClick={onOpenShare}
              className="w-9 h-9 rounded-lg"
              title={t('toolbar.share', { defaultValue: 'Create share link' })}
              aria-label={t('toolbar.share', { defaultValue: 'Create share link' })}
            >
              <Link2 className="w-[18px] h-[18px]" />
            </Button>
          )}
          <div className="h-px w-6 bg-border/60 my-1" aria-hidden="true" />
        </>
      )}

      {/* Main Tools */}
      <div
        className="flex flex-col"
        role="group"
        aria-label={t('toolbar.toolsGroup')}
      >
        {modeTools.map((tool) => {
          const hint = preferredKeyForTool(tool.id)
          const label = t(tool.labelKey)
          const labelWithHint = hint ? `${label} (${hint})` : label
          return (
            <Button
              key={tool.id}
              variant={activeTool === tool.id ? 'default' : 'ghost'}
              size="icon"
              onClick={() => handleToolClick(tool.id)}
              className={cn(
                'h-9 w-9 rounded-lg relative transition-all',
                activeTool === tool.id
                  ? 'ring-2 ring-primary/60 shadow-md scale-105'
                  : 'hover:bg-primary/5 hover:text-primary'
              )}
              title={labelWithHint}
              aria-label={labelWithHint}
              aria-pressed={activeTool === tool.id}
            >
              <tool.icon className="w-[18px] h-[18px]" />
              {activeTool === tool.id && (
                <div className="absolute -bottom-0.5 start-1/2 -translate-x-1/2 w-0.5 h-0.5 bg-primary-foreground rounded-full" />
              )}
            </Button>
          )
        })}

        {/*
         * Draw flyout — collapses the 10 creation tools into a single
         * button. The parent shows whichever creation tool is currently
         * active (so the user can always see which sub-tool is live);
         * if no creation tool is active it falls back to a pencil. The
         * flyout opens on hover (delayed close on leave so the user can
         * cross the gap) and on click. Keyboard shortcuts still pick
         * each child tool directly without opening the flyout.
         */}
        {!preview && (
          <div
            className="relative"
            onMouseEnter={() => {
              if (drawFlyoutTimerRef.current) clearTimeout(drawFlyoutTimerRef.current)
              setDrawFlyoutOpen(true)
            }}
            onMouseLeave={() => {
              if (drawFlyoutTimerRef.current) clearTimeout(drawFlyoutTimerRef.current)
              drawFlyoutTimerRef.current = setTimeout(() => setDrawFlyoutOpen(false), 180)
            }}
          >
            <Button
              ref={drawTriggerRef}
              variant={activeDrawTool ? 'default' : 'ghost'}
              size="icon"
              onClick={() => setDrawFlyoutOpen((v) => !v)}
              className={cn(
                'h-9 w-9 rounded-lg relative transition-all',
                activeDrawTool
                  ? 'ring-2 ring-primary/60 shadow-md scale-105'
                  : 'hover:bg-primary/5 hover:text-primary',
              )}
              title={
                activeDrawTool
                  ? t(activeDrawTool.labelKey)
                  : t('toolbar.toolDraw', { defaultValue: 'Draw' })
              }
              aria-label={t('toolbar.toolDraw', { defaultValue: 'Draw' })}
              aria-expanded={drawFlyoutOpen}
              aria-haspopup="true"
            >
              <DrawParentIcon className="w-[18px] h-[18px]" />
              {/* Small chevron cue so the user knows there's more. */}
              <span
                className="absolute bottom-0 end-0 w-1.5 h-1.5 rounded-tl-sm bg-primary/60"
                aria-hidden="true"
              />
              {activeDrawTool && (
                <div className="absolute -bottom-0.5 start-1/2 -translate-x-1/2 w-0.5 h-0.5 bg-primary-foreground rounded-full" />
              )}
            </Button>
            <FloatingMenu
              anchorRef={drawTriggerRef}
              open={drawFlyoutOpen}
              role="group"
              ariaLabel={t('toolbar.toolDraw', { defaultValue: 'Draw' })}
              className="flex flex-row gap-0.5 p-1.5 bg-card/95 border border-border/60 rounded-2xl shadow-xl ring-1 ring-foreground/[0.04] backdrop-blur-md"
              onMouseEnter={() => {
                if (drawFlyoutTimerRef.current) clearTimeout(drawFlyoutTimerRef.current)
                setDrawFlyoutOpen(true)
              }}
              onMouseLeave={() => {
                if (drawFlyoutTimerRef.current) clearTimeout(drawFlyoutTimerRef.current)
                drawFlyoutTimerRef.current = setTimeout(() => setDrawFlyoutOpen(false), 180)
              }}
            >
              <div data-toolbar-menu className="flex flex-row gap-0.5">
                {drawTools.map((tool) => {
                  const hint = preferredKeyForTool(tool.id)
                  const label = t(tool.labelKey)
                  const labelWithHint = hint ? `${label} (${hint})` : label
                  // AI Map is under construction — render it as visually
                  // disabled and open a "coming soon" dialog on click
                  // instead of activating the tool.
                  if (tool.id === 'ai-map') {
                    const soonLabel = t('toolbar.aiMapComingSoonTitle', {
                      defaultValue: 'AI Map — coming soon',
                    })
                    return (
                      <Button
                        key={tool.id}
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setAIComingSoonOpen(true)
                          setDrawFlyoutOpen(false)
                        }}
                        className={cn(
                          'h-9 w-9 rounded-lg relative flex-shrink-0 transition-all',
                          'opacity-60 hover:opacity-80 text-muted-foreground',
                          'hover:bg-primary/5',
                        )}
                        title={soonLabel}
                        aria-label={soonLabel}
                        aria-disabled="true"
                      >
                        <tool.icon className="w-[18px] h-[18px]" />
                        <span
                          className="absolute -top-1 -end-1 px-1 rounded-sm bg-primary text-primary-foreground text-[8px] font-bold leading-[12px] tracking-wide"
                          aria-hidden="true"
                        >
                          {t('toolbar.aiMapSoonBadge', { defaultValue: 'SOON' })}
                        </span>
                      </Button>
                    )
                  }
                  return (
                    <Button
                      key={tool.id}
                      variant={activeTool === tool.id ? 'default' : 'ghost'}
                      size="icon"
                      onClick={() => {
                        handleToolClick(tool.id)
                        setDrawFlyoutOpen(false)
                      }}
                      className={cn(
                        'h-9 w-9 rounded-lg relative flex-shrink-0 transition-all',
                        activeTool === tool.id
                          ? 'ring-2 ring-primary/60 shadow-md scale-105'
                          : 'hover:bg-primary/5 hover:text-primary',
                      )}
                      title={labelWithHint}
                      aria-label={labelWithHint}
                      aria-pressed={activeTool === tool.id}
                    >
                      <tool.icon className="w-[18px] h-[18px]" />
                    </Button>
                  )
                })}
              </div>
            </FloatingMenu>
          </div>
        )}
      </div>

      <div className="h-px w-6 bg-border/60 my-1" aria-hidden="true" />

      {/*
       * Default floor plan picker — sits between the draw tools and
       * the bulk-assign / schema / layers group so it reads as a
       * "creation preference" alongside the tools it affects. Sets
       * the `floorPlanId` that every newly-drawn shape (polygon /
       * circle / line / marker / model / stair / text label / grid /
       * image plane / door) inherits automatically, so the user
       * doesn't have to bulk-assign after every draw. Persists
       * per-warehouse via localStorage in the host. The badge shows
       * the current default's initial (or "•") for at-a-glance state.
       */}
      {!preview && onDefaultFloorPlanChange && (
        <>
          <div className="relative">
            <Button
              ref={defaultFloorTriggerRef}
              variant={defaultFloorMenuOpen ? 'secondary' : 'ghost'}
              size="icon"
              onClick={() => setDefaultFloorMenuOpen((v) => !v)}
              className={cn(
                'h-9 w-9 rounded-lg relative transition-all',
                defaultFloorMenuOpen
                  ? 'ring-2 ring-primary/60 shadow-md'
                  : 'hover:bg-primary/5 hover:text-primary',
                (defaultFloorPlanId ?? null) !== null && 'text-primary',
              )}
              title={t('toolbar.defaultFloorPlan', {
                defaultValue: 'Default floor plan for new shapes',
              })}
              aria-label={t('toolbar.defaultFloorPlan', {
                defaultValue: 'Default floor plan for new shapes',
              })}
              aria-expanded={defaultFloorMenuOpen}
            >
              <Pin className="w-[18px] h-[18px]" />
              {(defaultFloorPlanId ?? null) !== null && (
                <span
                  className="absolute -top-0.5 -end-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-bold leading-[14px] text-center"
                  aria-hidden
                >
                  {(() => {
                    const match = (floorPlans ?? []).find(
                      (fp) => fp.id === defaultFloorPlanId,
                    )
                    const name = match?.name?.trim() ?? ''
                    return name ? name.slice(0, 1).toUpperCase() : '•'
                  })()}
                </span>
              )}
            </Button>
            <FloatingMenu
              anchorRef={defaultFloorTriggerRef}
              open={defaultFloorMenuOpen}
              className="min-w-[260px] max-w-[calc(100vw-6rem)] max-h-[320px] overflow-y-auto bg-popover border border-border/60 rounded-xl shadow-xl ring-1 ring-foreground/[0.04] backdrop-blur-md p-2 text-sm"
            >
              <div data-toolbar-menu>
                <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('toolbar.defaultFloorPlanTitle', {
                    defaultValue: 'Default floor plan',
                  })}
                </div>
                  <p className="px-2 pb-2 text-[11px] text-muted-foreground leading-snug">
                    {t('toolbar.defaultFloorPlanHint', {
                      defaultValue:
                        'New shapes drawn from now on will be pinned to this floor plan.',
                    })}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      onDefaultFloorPlanChange(null)
                      setDefaultFloorMenuOpen(false)
                    }}
                    className={cn(
                      'w-full text-start px-2 py-1.5 rounded hover:bg-accent transition-colors text-xs',
                      (defaultFloorPlanId ?? null) === null &&
                        'bg-accent font-medium',
                    )}
                  >
                    {t('toolbar.defaultFloorPlanNone', {
                      defaultValue: 'No default (leave unassigned)',
                    })}
                  </button>
                  {(floorPlans ?? []).length > 0 && (
                    <div className="h-px bg-border my-1" aria-hidden="true" />
                  )}
                  {(floorPlans ?? []).length === 0 ? (
                    <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                      {t('toolbar.defaultFloorPlanEmpty', {
                        defaultValue:
                          'Draw a floor plan first to pick one here.',
                      })}
                    </div>
                  ) : (
                    (floorPlans ?? []).map((fp) => (
                      <button
                        key={fp.id}
                        type="button"
                        onClick={() => {
                          onDefaultFloorPlanChange(fp.id)
                          setDefaultFloorMenuOpen(false)
                        }}
                        className={cn(
                          'w-full text-start px-2 py-1.5 rounded hover:bg-accent transition-colors text-xs truncate',
                          defaultFloorPlanId === fp.id &&
                            'bg-accent font-medium text-primary',
                        )}
                        title={fp.name}
                      >
                        {fp.name}
                      </button>
                    ))
                  )}
              </div>
            </FloatingMenu>
          </div>
          <div className="h-px w-6 bg-border/60 my-1" aria-hidden="true" />
        </>
      )}

      {/*
       * Bulk-assign — opens the dialog that lets the user move the
       * current selection of shapes / 3D models onto a different
       * warehouse + floor plan. Always enabled so the user can
       * discover and open the dialog even with no selection — the
       * dialog itself shows a helpful empty state when there's
       * nothing to assign yet. The badge shows the selection count
       * so the user can see at a glance how many items will be
       * reassigned.
       */}
      {!preview && (
        <div className="relative flex flex-col" role="group">
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenBulkAssign}
            disabled={!onOpenBulkAssign}
            className={cn(
              'w-9 h-9 rounded-lg',
              selectedCount > 0 && 'text-primary',
            )}
            title={
              selectedCount === 0
                ? t('toolbar.bulkAssignEmpty', {
                    defaultValue:
                      'Assign selection (select items in the sidebar first)',
                  })
                : t('toolbar.bulkAssign', {
                    defaultValue: 'Assign to facility / floor plan',
                  })
            }
            aria-label={t('toolbar.bulkAssign', {
              defaultValue: 'Assign to facility / floor plan',
            })}
          >
            <Warehouse className="w-[18px] h-[18px]" />
            {selectedCount > 0 && (
              <span
                className="absolute -top-0.5 -end-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-bold leading-[14px] text-center tabular-nums"
                aria-hidden
              >
                {selectedCount > 99 ? '99+' : selectedCount}
              </span>
            )}
          </Button>
        </div>
      )}

      {/*
       * Schema Builder — author the custom-field schema each shape
       * kind exposes. Opens a dialog with a per-kind tab strip so
       * the user defines what data a rack cell / polygon / 3D model
       * can carry. Those fields then show up in the linked-data
       * editor and become pickable in style-rule conditions.
       */}
      {!preview && (
        <div className="flex flex-col" role="group">
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenSchemaBuilder}
            disabled={!onOpenSchemaBuilder}
            className="w-9 h-9 rounded-lg"
            title={t('toolbar.schemaBuilder', {
              defaultValue: 'Configure properties (schema)',
            })}
            aria-label={t('toolbar.schemaBuilder', {
              defaultValue: 'Configure properties (schema)',
            })}
          >
            <ListChecks className="w-[18px] h-[18px]" />
          </Button>
        </div>
      )}

      {!preview && <div className="h-px w-6 bg-border/60 my-1" aria-hidden="true" />}

      {/*
       * Layers dropdown — replaces the two single-purpose visibility
       * toggles that used to live here (grid + zones). One stack icon
       * opens a popover listing every kind of overlay with its own
       * switch. Order mirrors the toolbar's create-* sequence so the
       * user can visually match each tool to its visibility row.
       */}
      <div className="relative">
        <Button
          ref={layersTriggerRef}
          variant={layersMenuOpen ? 'secondary' : 'ghost'}
          size="icon"
          onClick={() => setLayersMenuOpen((v) => !v)}
          className={cn(
            'h-9 w-9 rounded-lg relative transition-all',
            layersMenuOpen
              ? 'ring-2 ring-primary/60 shadow-md'
              : 'hover:bg-primary/5 hover:text-primary',
          )}
          title={t('toolbar.layers', { defaultValue: 'Layers' })}
          aria-label={t('toolbar.layers', { defaultValue: 'Layers' })}
          aria-expanded={layersMenuOpen}
        >
          <Layers className="w-[18px] h-[18px]" />
        </Button>
        <FloatingMenu
          anchorRef={layersTriggerRef}
          open={layersMenuOpen}
          className="min-w-[240px] max-w-[calc(100vw-6rem)] bg-popover border border-border/60 rounded-xl shadow-xl ring-1 ring-foreground/[0.04] backdrop-blur-md p-2 text-sm"
        >
          <div data-toolbar-menu>
            <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('toolbar.layers', { defaultValue: 'Layers' })}
            </div>
            <ul className="space-y-0.5">
                {LAYER_ROWS.map((row) => {
                  const checked = layerVisibility[row.id]
                  const Icon = row.icon
                  // Zones row absorbs the old standalone "Zones" tool
                  // button — clicking the row body (left of the
                  // switch) scrolls the side-panel to the workspaces
                  // section, the switch still toggles visibility.
                  const isZones = row.id === 'zones'
                  return (
                    <li key={row.id} className="flex items-center">
                      {isZones ? (
                        <button
                          type="button"
                          onClick={() => {
                            onFocusZones?.()
                            setLayersMenuOpen(false)
                          }}
                          className="flex items-center w-full gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer transition-colors text-start"
                        >
                          <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <span className="flex-1 text-xs font-medium select-none">
                            {t(row.labelKey, { defaultValue: row.fallback })}
                          </span>
                        </button>
                      ) : (
                        <label className="flex items-center w-full gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer transition-colors">
                          <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <span className="flex-1 text-xs font-medium select-none">
                            {t(row.labelKey, { defaultValue: row.fallback })}
                          </span>
                          <Switch
                            checked={checked}
                            onCheckedChange={(v) =>
                              onLayerVisibilityChange?.(row.id, v)
                            }
                            aria-label={t(row.labelKey, {
                              defaultValue: row.fallback,
                            })}
                          />
                        </label>
                      )}
                      {isZones && (
                        <Switch
                          checked={checked}
                          onCheckedChange={(v) =>
                            onLayerVisibilityChange?.(row.id, v)
                          }
                          aria-label={t(row.labelKey, {
                            defaultValue: row.fallback,
                          })}
                          className="me-2"
                        />
                      )}
                    </li>
                  )
                })}
            </ul>
          </div>
        </FloatingMenu>
      </div>

      <div className="h-px w-6 bg-border/60 my-1" aria-hidden="true" />

      {/* Map Style Picker */}
      {onMapStyleChange && mapStyle && (
        <div className="relative">
          <Button
            ref={styleTriggerRef}
            variant="ghost"
            size="icon"
            onClick={() => setStyleMenuOpen((v) => !v)}
            className="w-9 h-9 rounded-lg"
            title={t('toolbar.stylePicker')}
            aria-label={t('toolbar.stylePicker')}
            aria-expanded={styleMenuOpen}
            data-toolbar-style-trigger
          >
            <MapIcon className="w-[18px] h-[18px]" />
          </Button>
          <FloatingMenu
            anchorRef={styleTriggerRef}
            open={styleMenuOpen}
            className="min-w-[160px] max-w-[calc(100vw-6rem)] bg-popover border border-border/60 rounded-xl shadow-xl ring-1 ring-foreground/[0.04] backdrop-blur-md p-1 text-sm"
          >
            <div data-toolbar-menu>
              {STYLE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    onMapStyleChange(opt.id)
                    setStyleMenuOpen(false)
                  }}
                  className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-accent text-start"
                >
                  <span>{t(opt.key, { defaultValue: opt.fallback })}</span>
                  {mapStyle === opt.id && <Check className="h-3.5 w-3.5 text-primary" />}
                </button>
              ))}
            </div>
          </FloatingMenu>
        </div>
      )}

      <div className="h-px w-6 bg-border/60 my-1" aria-hidden="true" />

      {/*
       * Data flyout — Import / Link external data / Export, collapsed
       * into a single button. Mirrors the Draw flyout's hover-open
       * pattern: a horizontal row of action icons expands to the
       * right. Export's "GeoJSON / PNG" sub-menu stays inline inside
       * the flyout so the user never has to chase a nested popover.
       */}
      <div
        className="relative"
        onMouseEnter={() => {
          if (dataFlyoutTimerRef.current) clearTimeout(dataFlyoutTimerRef.current)
          setDataFlyoutOpen(true)
        }}
        onMouseLeave={() => {
          if (dataFlyoutTimerRef.current) clearTimeout(dataFlyoutTimerRef.current)
          dataFlyoutTimerRef.current = setTimeout(() => {
            setDataFlyoutOpen(false)
            setExportMenuOpen(false)
          }, 180)
        }}
      >
        <Button
          ref={dataTriggerRef}
          variant="ghost"
          size="icon"
          onClick={() => setDataFlyoutOpen((v) => !v)}
          disabled={!onImport && !onOpenDataLink && !onOpenExportDialog && !onExportGeoJSON && !onExportPNG}
          className="w-9 h-9 rounded-lg relative transition-all hover:bg-primary/5 hover:text-primary"
          title={t('toolbar.toolData', { defaultValue: 'Data' })}
          aria-label={t('toolbar.toolData', { defaultValue: 'Data' })}
          aria-expanded={dataFlyoutOpen}
          aria-haspopup="true"
        >
          <Database className="w-[18px] h-[18px]" />
          <span
            className="absolute bottom-0 end-0 w-1.5 h-1.5 rounded-tl-sm bg-primary/60"
            aria-hidden="true"
          />
        </Button>
        <FloatingMenu
          anchorRef={dataTriggerRef}
          open={dataFlyoutOpen}
          role="group"
          ariaLabel={t('toolbar.toolData', { defaultValue: 'Data' })}
          className="flex flex-row gap-0.5 p-1.5 bg-card/95 border border-border/60 rounded-2xl shadow-xl ring-1 ring-foreground/[0.04] backdrop-blur-md"
          onMouseEnter={() => {
            if (dataFlyoutTimerRef.current) clearTimeout(dataFlyoutTimerRef.current)
            setDataFlyoutOpen(true)
          }}
          onMouseLeave={() => {
            if (dataFlyoutTimerRef.current) clearTimeout(dataFlyoutTimerRef.current)
            dataFlyoutTimerRef.current = setTimeout(() => {
              setDataFlyoutOpen(false)
              setExportMenuOpen(false)
            }, 180)
          }}
        >
          <div data-toolbar-menu className="flex flex-row gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                fileInputRef.current?.click()
                setDataFlyoutOpen(false)
              }}
              disabled={!onImport}
              className="w-9 h-9 rounded-lg flex-shrink-0 transition-all hover:bg-primary/5 hover:text-primary"
              title={t('toolbar.import')}
              aria-label={t('toolbar.import')}
            >
              <FileUp className="w-[18px] h-[18px]" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                onOpenDataLink?.()
                setDataFlyoutOpen(false)
              }}
              disabled={!onOpenDataLink}
              className="w-9 h-9 rounded-lg flex-shrink-0 transition-all hover:bg-primary/5 hover:text-primary"
              title={t('toolbar.dataLink', { defaultValue: 'Manage data links' })}
              aria-label={t('toolbar.dataLink', { defaultValue: 'Manage data links' })}
            >
              <Link2 className="w-[18px] h-[18px]" />
            </Button>
            <div ref={exportRef} className="relative">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setExportMenuOpen((v) => !v)}
                disabled={!onOpenExportDialog && !onExportGeoJSON && !onExportPNG}
                className="w-9 h-9 rounded-lg"
                title={t('toolbar.export')}
                aria-label={t('toolbar.export')}
                aria-expanded={exportMenuOpen}
              >
                <Download className="w-[18px] h-[18px]" />
              </Button>
              {exportMenuOpen && (
                <div className="absolute top-full mt-1 end-0 z-30 min-w-[220px] bg-popover border rounded-md shadow-lg p-1 text-sm">
                  <button
                    type="button"
                    onClick={() => {
                      onOpenExportDialog?.()
                      setExportMenuOpen(false)
                      setDataFlyoutOpen(false)
                    }}
                    disabled={!onOpenExportDialog}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent text-start disabled:opacity-50"
                  >
                    <FileJson className="h-3.5 w-3.5" />
                    <span className="flex-1">
                      {t('toolbar.exportShapes', { defaultValue: 'Export shapes…' })}
                    </span>
                  </button>
                  {/* Legacy one-click GeoJSON. Kept when the host still
                      wires the old handler and doesn't want the dialog. */}
                  {!onOpenExportDialog && onExportGeoJSON && (
                    <button
                      type="button"
                      onClick={() => {
                        onExportGeoJSON()
                        setExportMenuOpen(false)
                        setDataFlyoutOpen(false)
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent text-start"
                    >
                      <FileJson className="h-3.5 w-3.5" />
                      <span className="flex-1">{t('toolbar.exportGeoJSON')}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onExportPNG?.()
                      setExportMenuOpen(false)
                      setDataFlyoutOpen(false)
                    }}
                    disabled={!onExportPNG}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent text-start disabled:opacity-50"
                  >
                    <FileImage className="h-3.5 w-3.5" />
                    <span className="flex-1">{t('toolbar.exportPNG')}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </FloatingMenu>
      </div>

      <div className="h-px w-6 bg-border/60 my-1" aria-hidden="true" />

      {/* Cheatsheet — keyboard shortcuts overlay. Settings / language /
          fullscreen / zoom moved to the app header. */}
      <div className="flex flex-col" role="group">
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenCheatsheet}
          disabled={!onOpenCheatsheet}
          className="w-9 h-9 rounded-lg transition-all hover:bg-primary/5 hover:text-primary"
          title={t('kb.cheatsheet', { defaultValue: 'Keyboard shortcuts (?)' })}
          aria-label={t('kb.cheatsheet', { defaultValue: 'Keyboard shortcuts (?)' })}
        >
          <Keyboard className="w-[18px] h-[18px]" />
        </Button>
      </div>

      <Dialog open={aiComingSoonOpen} onOpenChange={setAIComingSoonOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <div className="mx-auto sm:mx-0 mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-primary/25 to-primary/5 ring-1 ring-primary/30">
              <Sparkles className="h-6 w-6 text-primary" />
            </div>
            <DialogTitle>
              {t('toolbar.aiMapComingSoonTitle', {
                defaultValue: 'AI Map — coming soon',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('toolbar.aiMapComingSoonBody', {
                defaultValue:
                  "We're actively building AI Map. It will auto-detect racks, aisles, and zones from your floor plan. Stay tuned — it'll land in a future release.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setAIComingSoonOpen(false)}>
              {t('toolbar.aiMapClose', { defaultValue: 'Got it' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
