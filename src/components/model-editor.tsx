/**
 * Side-panel editor for a selected ModelShape.
 *
 * Two halves:
 *   1. **Static controls** (Position, Rotation, Scale, Tint, Opacity,
 *      Label) — the same set the editor has always shown, driven by
 *      fixed fields on `ModelShapeConfig`.
 *   2. **Dynamic controls** (Materials, Nodes, Animations, Extras) —
 *      generated at render time from the asset's `ModelInspector`
 *      schema (see `glb-bounds.ts`). One card per material / node /
 *      animation found in the GLB, with controls wired into
 *      `cfg.materialOverrides[name]`, `cfg.nodeOverrides[name]`, and
 *      `cfg.animationClip` respectively. Empty schema (or schema not
 *      yet loaded) → those sections render nothing, keeping the UX
 *      identical to the pre-v11 editor.
 *
 * Stays state-less; the parent (side-panel.tsx) owns the shape and
 * forwards patches via `onChange` which the route handler persists to
 * Dexie + refreshes the overlay.
 *
 * All edits go through `onChange(patch)` with a config patch — the
 * route handler merges `patch` into the current config and writes the
 * row.
 */

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NumberInput } from '@/components/ui/number-input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import type {
  ModelMaterialOverride,
  ModelNodeOverride,
  ModelShape,
  ModelShapeConfig,
  TooltipTrigger,
} from '@/lib/shapes'
import type {
  ModelMaterialInfo,
  ModelNodeInfo,
} from '@/lib/glb-bounds'
import { useModelAssets, useModelInspectorMap } from '@/lib/model-assets'
import { ModelPreview } from './model-preview'
import { cn } from '@/lib/utils'
import {
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Layers,
  MapPin,
  MousePointerClick,
  Move,
  Palette,
  Play,
  Replace,
  RotateCw,
  Scale,
  Trash2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface ModelEditorProps {
  shape: ModelShape
  onChange: (patch: { config?: Partial<ModelShapeConfig>; name?: string; visible?: boolean }) => void
  onDelete?: () => void
  /** Clone the model — parent writes a new row with a small lng/lat offset. */
  onDuplicate?: () => void
  /** Activates the move tool (parent attaches a draggable handle to the map). */
  onMoveMode?: () => void
  /** True while the move handle is up on the map. */
  moveActive?: boolean
  /** Cancel an in-flight move (e.g. user clicked the Move button again). */
  onCancelMove?: () => void
  /** Open the library dialog to swap the asset. */
  onSwapAsset?: () => void
}

export function ModelEditor({
  shape,
  onChange,
  onDelete,
  onDuplicate,
  onMoveMode,
  moveActive = false,
  onCancelMove,
  onSwapAsset,
}: ModelEditorProps) {
  const { t } = useTranslation()
  const cfg = shape.config
  const assets = useModelAssets()
  const asset = cfg.modelAssetId ? assets.find((a) => a.id === cfg.modelAssetId) : undefined
  // Only fetch the inspector for the currently-selected asset. Passing
  // an all-assets-fetch used to spawn ~40 requests every time the model
  // editor opened just to fill dropdowns nobody was looking at yet.
  const inspectorRestrict = useMemo(
    () => (cfg.modelAssetId ? [cfg.modelAssetId] : []),
    [cfg.modelAssetId],
  )
  const inspectorMap = useModelInspectorMap(inspectorRestrict)
  const inspector = cfg.modelAssetId ? inspectorMap.get(cfg.modelAssetId) : undefined

  const [uniformScale, setUniformScale] = useState(
    cfg.scale[0] === cfg.scale[1] && cfg.scale[1] === cfg.scale[2]
  )

  const updateCfg = (patch: Partial<ModelShapeConfig>) => onChange({ config: patch })

  // --- Override helpers ----------------------------------------------------
  //
  // Both override dictionaries are sparse: the renderer only honours
  // keys with at least one defined property. So a "clear" gesture maps
  // to deleting the key entirely; a partial update writes only the
  // touched property.

  const patchMaterial = (name: string, patch: Partial<ModelMaterialOverride> | null) => {
    const current = { ...(cfg.materialOverrides ?? {}) }
    if (patch === null) {
      delete current[name]
    } else {
      const merged = { ...(current[name] ?? {}), ...patch }
      // Drop the entry if every field is undefined after merge.
      const hasAny = Object.values(merged).some((v) => v !== undefined)
      if (hasAny) current[name] = merged
      else delete current[name]
    }
    updateCfg({ materialOverrides: Object.keys(current).length ? current : undefined })
  }

  const patchNode = (name: string, patch: Partial<ModelNodeOverride> | null) => {
    const current = { ...(cfg.nodeOverrides ?? {}) }
    if (patch === null) {
      delete current[name]
    } else {
      const merged = { ...(current[name] ?? {}), ...patch }
      const hasAny = Object.values(merged).some((v) => v !== undefined)
      if (hasAny) current[name] = merged
      else delete current[name]
    }
    updateCfg({ nodeOverrides: Object.keys(current).length ? current : undefined })
  }

  return (
    <div className="space-y-3 px-3 py-3">
      {/* Header — name + duplicate + delete */}
      <div className="space-y-1.5">
        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Name</Label>
        <div className="flex items-center gap-1.5">
          <Input
            value={shape.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="h-8 text-xs"
          />
          {onDuplicate && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onDuplicate}
              title={t('modelEditor.duplicate', { defaultValue: 'Duplicate model' })}
              aria-label={t('modelEditor.duplicate', { defaultValue: 'Duplicate model' })}
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
          )}
          {onDelete && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-rose-600 hover:bg-rose-500/10"
              onClick={onDelete}
              aria-label="Delete model"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Asset */}
      <Section title="Asset" defaultOpen>
        <div className="space-y-2">
          <div className="rounded-md border bg-muted/20 px-3 py-2 flex items-center gap-2.5">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{asset?.label ?? '(no asset)'}</p>
              <p className="text-[10px] text-muted-foreground">
                {asset ? `${asset.source} · ${asset.category}` : 'Pick from library'}
              </p>
              {inspector && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {summariseInspector(inspector.materials.length, inspector.nodes.length, inspector.animations.length)}
                </p>
              )}
            </div>
            {onSwapAsset && (
              <Button type="button" variant="ghost" size="sm" onClick={onSwapAsset} className="h-7 px-2">
                <Replace className="w-3 h-3" />
                Swap
              </Button>
            )}
          </div>
          {/* 3D preview — helps confirm the GLB is valid + reachable
              even when the on-map render is misbehaving. Compact so it
              doesn't push the rest of the editor below the fold. */}
          <ModelPreview url={asset?.url} heightPx={140} orientation={asset?.previewOrientation} />
        </div>
      </Section>

      {/* Position */}
      <Section title="Position" icon={<MapPin className="w-3 h-3" />} defaultOpen>
        <div className="grid grid-cols-2 gap-2">
          <NumberInput
            label={<span className="text-[10px]">Longitude</span>}
            value={shape.position[0]}
            onChange={() => {
              /* Read-only display. Position changes flow through the Move tool. */
            }}
            decimals={5}
            ariaLabel="Longitude"
            hideSpinner
            disabled
          />
          <NumberInput
            label={<span className="text-[10px]">Latitude</span>}
            value={shape.position[1]}
            onChange={() => {
              /* Read-only display. Position changes flow through the Move tool. */
            }}
            decimals={5}
            ariaLabel="Latitude"
            hideSpinner
            disabled
          />
        </div>
        {onMoveMode && (
          <Button
            type="button"
            variant={moveActive ? 'default' : 'outline'}
            size="sm"
            onClick={moveActive ? onCancelMove : onMoveMode}
            className={cn(
              'w-full mt-2 h-7 text-xs',
              moveActive && 'bg-amber-500 text-white hover:bg-amber-500/90'
            )}
          >
            <Move className="w-3 h-3" />
            {moveActive ? 'Drag the orange dot — click to finish' : 'Move on map'}
          </Button>
        )}
        <NumberInput
          label={<span className="text-[11px]">Elevation</span>}
          value={cfg.elevation}
          unit={shape.unit}
          onChange={(v) => updateCfg({ elevation: v })}
          min={0}
          max={500}
          className="mt-2"
        />
      </Section>

      {/* Rotation */}
      <Section title="Rotation" icon={<RotateCw className="w-3 h-3" />} defaultOpen>
        <div className="space-y-2">
          <AxisSlider
            label="Pitch (X)"
            value={cfg.rotation[0]}
            min={-180}
            max={180}
            onChange={(v) => updateCfg({ rotation: [v, cfg.rotation[1], cfg.rotation[2]] })}
          />
          <AxisSlider
            label="Yaw (Y)"
            value={cfg.rotation[1]}
            min={-180}
            max={180}
            onChange={(v) => updateCfg({ rotation: [cfg.rotation[0], v, cfg.rotation[2]] })}
          />
          <AxisSlider
            label="Roll (Z)"
            value={cfg.rotation[2]}
            min={-180}
            max={180}
            onChange={(v) => updateCfg({ rotation: [cfg.rotation[0], cfg.rotation[1], v] })}
          />
        </div>
      </Section>

      {/* Scale */}
      <Section title="Scale" icon={<Scale className="w-3 h-3" />}>
        <div className="flex items-center justify-between mb-2">
          <Label className="text-[11px]">Uniform</Label>
          <Switch
            checked={uniformScale}
            onCheckedChange={(v) => {
              setUniformScale(v)
              if (v) {
                // Snap all axes to the X axis value when re-enabling uniform.
                updateCfg({ scale: [cfg.scale[0], cfg.scale[0], cfg.scale[0]] })
              }
            }}
          />
        </div>
        {uniformScale ? (
          <AxisSlider
            label="Scale"
            value={cfg.scale[0]}
            min={0.01}
            max={20}
            step={0.01}
            decimals={2}
            onChange={(v) => updateCfg({ scale: [v, v, v] })}
          />
        ) : (
          <div className="space-y-2">
            <AxisSlider
              label="X"
              value={cfg.scale[0]}
              min={0.01}
              max={20}
              step={0.01}
              decimals={2}
              onChange={(v) => updateCfg({ scale: [v, cfg.scale[1], cfg.scale[2]] })}
            />
            <AxisSlider
              label="Y"
              value={cfg.scale[1]}
              min={0.01}
              max={20}
              step={0.01}
              decimals={2}
              onChange={(v) => updateCfg({ scale: [cfg.scale[0], v, cfg.scale[2]] })}
            />
            <AxisSlider
              label="Z"
              value={cfg.scale[2]}
              min={0.01}
              max={20}
              step={0.01}
              decimals={2}
              onChange={(v) => updateCfg({ scale: [cfg.scale[0], cfg.scale[1], v] })}
            />
          </div>
        )}
      </Section>

      {/* Appearance — the legacy whole-model tint controls. Kept
          alongside the per-material section because users still want a
          "make this model glow" shortcut without picking a material. */}
      <Section title="Appearance" defaultOpen>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-[11px]">Active</Label>
            <Switch
              checked={cfg.active}
              onCheckedChange={(v) => updateCfg({ active: v })}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px]">Global tint</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={cfg.color}
                onChange={(e) => updateCfg({ color: e.target.value })}
                className="h-7 w-10 rounded border border-input bg-transparent cursor-pointer"
              />
              <Input
                value={cfg.color}
                onChange={(e) => updateCfg({ color: e.target.value })}
                className="h-7 text-xs font-mono"
              />
            </div>
            <SliderRow
              label="Mix"
              value={cfg.colorMix}
              min={0}
              max={1}
              step={0.01}
              decimals={2}
              onChange={(v) => updateCfg({ colorMix: v })}
            />
          </div>

          <SliderRow
            label="Emissive"
            value={cfg.emissive}
            min={0}
            max={5}
            step={0.1}
            decimals={1}
            onChange={(v) => updateCfg({ emissive: v })}
          />

          <SliderRow
            label="Opacity"
            value={cfg.opacity}
            min={0}
            max={100}
            step={1}
            decimals={0}
            suffix="%"
            onChange={(v) => updateCfg({ opacity: v })}
          />
        </div>
      </Section>

      {/* v5.5 — Facility shell. Marks this model as the zone's outer
          building volume so the /view overlay auto-fades it out as the
          user zooms in on the interior. A chip in the floor switcher
          also lets viewers force it fully on / fully off. Reuses every
          other model editor knob above (upload, transform, materials
          etc.) — the flag is the only thing this section owns. */}
      <Section title="Facility shell" icon={<Layers className="w-3 h-3" />}>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={cfg.facilityShell?.enabled === true}
              onChange={(e) => {
                const on = e.target.checked
                const prev = cfg.facilityShell ?? {
                  enabled: false,
                  fadeStartZoom: 16,
                  fadeEndZoom: 19,
                }
                updateCfg({
                  facilityShell: { ...prev, enabled: on },
                })
              }}
            />
            <span>Treat as building shell (auto-fade on zoom)</span>
          </label>
          {cfg.facilityShell?.enabled === true && (
            <>
              <SliderRow
                label="Opaque below zoom"
                value={cfg.facilityShell.fadeStartZoom ?? 16}
                min={10}
                max={22}
                step={0.5}
                decimals={1}
                onChange={(v) =>
                  updateCfg({
                    facilityShell: {
                      ...cfg.facilityShell!,
                      fadeStartZoom: v,
                    },
                  })
                }
              />
              <SliderRow
                label="Vanish by zoom"
                value={cfg.facilityShell.fadeEndZoom ?? 19}
                min={10}
                max={22}
                step={0.5}
                decimals={1}
                onChange={(v) =>
                  updateCfg({
                    facilityShell: {
                      ...cfg.facilityShell!,
                      fadeEndZoom: v,
                    },
                  })
                }
              />
              <p className="text-[10px] text-muted-foreground leading-snug">
                The shell paints opaque at map zooms up to the first
                slider, linearly fades between the two, and is fully
                gone at the second. Viewers can override with the
                "Shell only / Interior only" chip in the floor
                switcher.
              </p>
            </>
          )}
        </div>
      </Section>

      {/* Materials — dynamic, one card per material in the GLB. */}
      {inspector && inspector.materials.length > 0 && (
        <Section
          title={`Materials (${inspector.materials.length})`}
          icon={<Palette className="w-3 h-3" />}
        >
          <div className="space-y-2">
            {inspector.materials.map((m) => (
              <MaterialCard
                key={m.index}
                info={m}
                override={cfg.materialOverrides?.[m.name]}
                onPatch={(patch) => patchMaterial(m.name, patch)}
              />
            ))}
          </div>
        </Section>
      )}

      {/* Nodes — dynamic, one card per named node in the GLB. */}
      {inspector && inspector.nodes.length > 0 && (
        <Section
          title={`Nodes (${inspector.nodes.length})`}
          icon={<Layers className="w-3 h-3" />}
        >
          <div className="space-y-2">
            {inspector.nodes.map((n) => (
              <NodeCard
                key={n.index}
                info={n}
                override={cfg.nodeOverrides?.[n.name]}
                onPatch={(patch) => patchNode(n.name, patch)}
              />
            ))}
          </div>
        </Section>
      )}

      {/* Animation — when the GLB declares clips, pick from a dropdown
          instead of free text. We still keep the old free-text field
          available for assets that haven't been inspected yet. */}
      <Section title="Animation" icon={<Play className="w-3 h-3" />}>
        {inspector && inspector.animations.length > 0 ? (
          <div className="space-y-1.5">
            <Label className="text-[11px]">Clip</Label>
            <select
              value={cfg.animationClip ?? ''}
              onChange={(e) =>
                updateCfg({ animationClip: e.target.value || undefined })
              }
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="">(none)</option>
              {inspector.animations.map((a) => (
                <option key={a.index} value={a.name}>
                  {a.name}
                  {typeof a.duration === 'number'
                    ? `  —  ${a.duration.toFixed(1)} s`
                    : ''}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-muted-foreground leading-snug">
              Stored on the shape. Playback support depends on the Mapbox
              build — older runtimes treat this as metadata only.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label className="text-[11px]">Clip name</Label>
            <Input
              placeholder="e.g. door_open"
              value={cfg.animation ?? ''}
              onChange={(e) => updateCfg({ animation: e.target.value || undefined })}
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground leading-snug">
              No clips detected in this GLB. Type a name manually if you
              know one and the runtime will look it up at play time.
            </p>
          </div>
        )}
      </Section>

      {/* Extras — read-only display of glTF asset/material/mesh extras.
          Useful for the user to see what custom metadata an exporter
          baked in (provenance, design tokens, etc). */}
      {inspector && Object.keys(inspector.extras).length > 0 && (
        <Section title="Extras">
          <dl className="text-[11px] grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
            {Object.entries(inspector.extras).map(([k, v]) => (
              <FragmentRow key={k} label={k} value={v} />
            ))}
          </dl>
        </Section>
      )}

      {/* Tooltip trigger — choose hover vs click for this model. */}
      <Section title="Tooltip" icon={<MousePointerClick className="w-3 h-3" />}>
        <TooltipTriggerToggle
          value={cfg.tooltipTrigger}
          onChange={(v) => updateCfg({ tooltipTrigger: v })}
        />
      </Section>

      {/* Labels */}
      <Section title="Label">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-[11px]">Show label</Label>
            <Switch
              checked={cfg.showLabels}
              onCheckedChange={(v) => updateCfg({ showLabels: v })}
            />
          </div>
          {cfg.showLabels && (
            <>
              <Input
                placeholder="Label text"
                value={cfg.label}
                onChange={(e) => updateCfg({ label: e.target.value })}
                className="h-7 text-xs"
              />
              <SliderRow
                label="Size"
                value={cfg.labelSize}
                min={8}
                max={32}
                step={1}
                decimals={0}
                onChange={(v) => updateCfg({ labelSize: v })}
              />
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={cfg.labelColor}
                  onChange={(e) => updateCfg({ labelColor: e.target.value })}
                  className="h-7 w-10 rounded border border-input bg-transparent cursor-pointer"
                />
                <Input
                  value={cfg.labelColor}
                  onChange={(e) => updateCfg({ labelColor: e.target.value })}
                  className="h-7 text-xs font-mono"
                />
              </div>
            </>
          )}
        </div>
      </Section>
    </div>
  )
}

// ---- Material card -------------------------------------------------------

interface MaterialCardProps {
  info: ModelMaterialInfo
  override: ModelMaterialOverride | undefined
  onPatch: (patch: Partial<ModelMaterialOverride> | null) => void
}

function MaterialCard({ info, override, onPatch }: MaterialCardProps) {
  const effectiveBase = override?.baseColor ?? info.baseColor ?? '#ffffff'
  const effectiveEmissive = override?.emissive ?? info.emissive ?? '#000000'
  const effectiveMetallic = override?.metallic ?? info.metallic ?? 0
  const effectiveRoughness = override?.roughness ?? info.roughness ?? 0.5
  const effectiveOpacity = override?.opacity ?? info.alpha ?? 1
  const hasOverride = !!override && Object.values(override).some((v) => v !== undefined)
  return (
    <div className="rounded-md border bg-muted/10 px-2.5 py-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-medium truncate">{info.name}</p>
          <p className="text-[10px] text-muted-foreground">material #{info.index}</p>
        </div>
        {hasOverride && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={() => onPatch(null)}
          >
            Reset
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <Label className="text-[10px]">Base colour</Label>
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={effectiveBase}
              onChange={(e) => onPatch({ baseColor: e.target.value })}
              className="h-6 w-8 rounded border border-input bg-transparent cursor-pointer"
            />
            <Input
              value={effectiveBase}
              onChange={(e) => onPatch({ baseColor: e.target.value })}
              className="h-6 text-[10px] font-mono"
            />
          </div>
        </div>
        <div className="space-y-0.5">
          <Label className="text-[10px]">Emissive</Label>
          <div className="flex items-center gap-1.5">
            <input
              type="color"
              value={effectiveEmissive}
              onChange={(e) => onPatch({ emissive: e.target.value })}
              className="h-6 w-8 rounded border border-input bg-transparent cursor-pointer"
            />
            <Input
              value={effectiveEmissive}
              onChange={(e) => onPatch({ emissive: e.target.value })}
              className="h-6 text-[10px] font-mono"
            />
          </div>
        </div>
      </div>
      <SliderRow
        label="Metallic"
        value={effectiveMetallic}
        min={0}
        max={1}
        step={0.01}
        decimals={2}
        onChange={(v) => onPatch({ metallic: v })}
      />
      <SliderRow
        label="Roughness"
        value={effectiveRoughness}
        min={0}
        max={1}
        step={0.01}
        decimals={2}
        onChange={(v) => onPatch({ roughness: v })}
      />
      <SliderRow
        label="Opacity"
        value={effectiveOpacity}
        min={0}
        max={1}
        step={0.01}
        decimals={2}
        onChange={(v) => onPatch({ opacity: v })}
      />
    </div>
  )
}

// ---- Node card -----------------------------------------------------------

interface NodeCardProps {
  info: ModelNodeInfo
  override: ModelNodeOverride | undefined
  onPatch: (patch: Partial<ModelNodeOverride> | null) => void
}

function NodeCard({ info, override, onPatch }: NodeCardProps) {
  const rot = override?.rotation ?? [0, 0, 0]
  const visible = override?.visible ?? true
  const hasOverride = !!override && Object.values(override).some((v) => v !== undefined)
  return (
    <div className="rounded-md border bg-muted/10 px-2.5 py-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-medium truncate">{info.name}</p>
          <p className="text-[10px] text-muted-foreground">
            node #{info.index}
            {info.hasMesh ? ' · mesh' : ''}
            {info.animated ? ' · animated' : ''}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onPatch({ visible: !visible })}
            title={visible ? 'Hide this node' : 'Show this node'}
            aria-label={visible ? 'Hide this node' : 'Show this node'}
          >
            {visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          </Button>
          {hasOverride && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => onPatch(null)}
            >
              Reset
            </Button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <NumberInput
          label={<span className="text-[10px]">Pitch</span>}
          value={rot[0]}
          min={-180}
          max={180}
          onChange={(v) => onPatch({ rotation: [v, rot[1], rot[2]] })}
          hideSpinner
        />
        <NumberInput
          label={<span className="text-[10px]">Yaw</span>}
          value={rot[1]}
          min={-180}
          max={180}
          onChange={(v) => onPatch({ rotation: [rot[0], v, rot[2]] })}
          hideSpinner
        />
        <NumberInput
          label={<span className="text-[10px]">Roll</span>}
          value={rot[2]}
          min={-180}
          max={180}
          onChange={(v) => onPatch({ rotation: [rot[0], rot[1], v] })}
          hideSpinner
        />
      </div>
    </div>
  )
}

// ---- Section -------------------------------------------------------------

interface SectionProps {
  title: string
  defaultOpen?: boolean
  icon?: React.ReactNode
  children: React.ReactNode
}

function Section({ title, defaultOpen = false, icon, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-md border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center justify-between w-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent transition-colors',
          open && 'border-b'
        )}
      >
        <span className="flex items-center gap-1.5">
          {icon}
          {title}
        </span>
        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="px-3 py-2.5">{children}</div>}
    </div>
  )
}

// ---- Slider helpers ------------------------------------------------------

interface AxisSliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  decimals?: number
  onChange: (value: number) => void
}

function AxisSlider({
  label,
  value,
  min,
  max,
  step = 1,
  decimals = 0,
  onChange,
}: AxisSliderProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[11px]">{label}</Label>
        <NumberInput
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          decimals={decimals}
          hideSpinner
          className="w-20"
          inputClassName="text-[11px]"
        />
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  )
}

interface SliderRowProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  decimals?: number
  suffix?: string
  onChange: (value: number) => void
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  decimals = 0,
  suffix,
  onChange,
}: SliderRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[11px]">{label}</Label>
        <NumberInput
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          decimals={decimals}
          suffix={suffix}
          hideSpinner
          className="w-20"
          inputClassName="text-[11px]"
        />
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  )
}

// ---- Tooltip-trigger toggle ----------------------------------------------
//
// Same control as the non-model shape editors (TooltipTriggerSection in
// side-panel.tsx) but inlined to stay self-contained: this editor is
// rendered standalone (not as part of the side-panel function tree) so
// sharing the React component would require a circular dependency.
// The two states are equally weighted — a 2-button group reads better
// than a Switch when neither option is "off".

interface TooltipTriggerToggleProps {
  value: TooltipTrigger | undefined
  onChange: (v: TooltipTrigger) => void
}

function TooltipTriggerToggle({ value, onChange }: TooltipTriggerToggleProps) {
  // Undefined treated as 'hover' so legacy shapes saved before this
  // field existed keep their original behaviour until the user edits.
  const current = value ?? 'hover'
  const options: TooltipTrigger[] = ['hover', 'click']
  return (
    <div className="space-y-2">
      <Label className="text-[11px]">Show on</Label>
      <div className="grid grid-cols-2 gap-1.5">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              'py-1.5 rounded-md border text-xs capitalize transition-colors',
              current === opt
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border hover:bg-accent',
            )}
          >
            {opt === 'hover' ? 'Hover' : 'Click'}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground">
        {current === 'click'
          ? 'Tooltip opens when the model is clicked.'
          : 'Tooltip opens when the cursor enters the model.'}
      </p>
    </div>
  )
}

// ---- Extras row ----------------------------------------------------------

function FragmentRow({ label, value }: { label: string; value: unknown }) {
  const display =
    typeof value === 'object' ? JSON.stringify(value) : String(value)
  return (
    <>
      <dt className="text-muted-foreground font-mono truncate">{label}</dt>
      <dd className="font-mono truncate" title={display}>
        {display}
      </dd>
    </>
  )
}

function summariseInspector(mat: number, nod: number, anim: number): string {
  const bits: string[] = []
  if (mat > 0) bits.push(`${mat} material${mat === 1 ? '' : 's'}`)
  if (nod > 0) bits.push(`${nod} node${nod === 1 ? '' : 's'}`)
  if (anim > 0) bits.push(`${anim} clip${anim === 1 ? '' : 's'}`)
  return bits.length > 0 ? bits.join(' · ') : 'no overrides discovered'
}
