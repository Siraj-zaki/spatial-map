import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { apiDb } from '@/lib/api-db'
import { siteUrl } from '@/lib/site'
import {
  type RoleVocabulary,
  type RoleVocabularyEntry,
  type Zone,
  DEFAULT_ROLE_VOCABULARY,
} from '@/lib/db'
import { isValidRoleKey } from '@/lib/role-vocabulary'
import { queryCache } from '@/lib/useApiQuery'
import { cn } from '@/lib/utils'
import {
  AlertCircle,
  Building2,
  Check,
  Copy,
  Globe2,
  Loader2,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Tab = 'warehouse' | 'global'

interface DefaultView {
  lng: number
  lat: number
  zoom: number
  pitch?: number
  bearing?: number
  floorId?: number | null
}

const COLOR_PRESETS = [
  '#6366f1',
  '#3b82f6',
  '#06b6d4',
  '#10b981',
  '#84cc16',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
] as const

const MAP_STYLES = ['standard', 'satellite', 'dark'] as const
const TOOLS = ['pan', 'select', 'create-grid'] as const
const UNITS = ['metric', 'imperial'] as const

const GLOBAL_SETTING_KEYS = {
  unit: 'display.unit',
  mapStyle: 'map.style.default',
  tool: 'tool.default',
  layers: 'layers.default',
} as const

const TABS: { id: Tab; icon: typeof Building2; labelKey: string }[] = [
  { id: 'warehouse', icon: Building2, labelKey: 'settingsDialog.tabWarehouse' },
  { id: 'global', icon: Globe2, labelKey: 'settingsDialog.tabGlobal' },
]

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: Tab
  /** Warehouse to edit in the Warehouse tab. When omitted, the Warehouse
   * tab is disabled and only the Global tab is usable. */
  warehouse?: Zone
  /** Optional ref to the live map instance so the user can capture the
   * current viewport as the default view. The function should return
   * `{ lng, lat, zoom, pitch, bearing }` or null when no map is mounted. */
  captureCurrentView?: () => DefaultView | null
}

export function SettingsDialog({
  open,
  onOpenChange,
  initialTab = 'global',
  warehouse,
  captureCurrentView,
}: SettingsDialogProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>(warehouse ? initialTab : 'global')

  // Reset to the requested tab whenever the dialog re-opens so a card
  // click always lands on the warehouse tab and the header button lands
  // on global. The dialog stays mounted for close animations, so we
  // can't rely on the useState initializer alone — re-running on each
  // open is the simplest correct option.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) setTab(warehouse ? initialTab : 'global')
  }, [open, initialTab, warehouse])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <SettingsIcon className="w-4 h-4 text-primary" />
            <span>{t('settingsDialog.title')}</span>
          </DialogTitle>
          <DialogDescription>
            {t('settingsDialog.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 p-1 mb-4 rounded-lg bg-muted/60">
          {TABS.map((tabDef) => {
            const disabled = tabDef.id === 'warehouse' && !warehouse
            return (
              <button
                key={tabDef.id}
                type="button"
                disabled={disabled}
                onClick={() => setTab(tabDef.id)}
                className={cn(
                  'flex-1 inline-flex items-center justify-center gap-1.5 px-3 h-8 rounded-md text-xs font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  tab === tabDef.id
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <tabDef.icon className="w-3.5 h-3.5" />
                {t(tabDef.labelKey)}
              </button>
            )
          })}
        </div>

        {tab === 'warehouse' && warehouse ? (
          <WarehouseSettings
            key={warehouse.id ?? 'new'}
            warehouse={warehouse}
            captureCurrentView={captureCurrentView}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <GlobalSettings onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// Warehouse tab
// =============================================================================

function WarehouseSettings({
  warehouse,
  captureCurrentView,
  onDone,
}: {
  warehouse: Zone
  captureCurrentView?: () => DefaultView | null
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(warehouse.name)
  const [address, setAddress] = useState(warehouse.address ?? '')
  const [color, setColor] = useState(warehouse.color)
  const [isPublic, setIsPublic] = useState<boolean>(warehouse.isPublic ?? true)
  const [shareToken, setShareToken] = useState<string>(warehouse.shareToken ?? '')
  const [defaultView, setDefaultView] = useState<DefaultView | null>(
    warehouse.defaultView ?? null,
  )
  // Per-warehouse role vocabulary. Initialised from the stored value
  // when present, otherwise from the default starter set so the editor
  // always opens with something to edit instead of an empty list.
  const [roleVocabulary, setRoleVocabulary] = useState<RoleVocabulary>(() => ({
    polygon:
      warehouse.roleVocabulary?.polygon ??
      DEFAULT_ROLE_VOCABULARY.polygon ??
      [],
    circle:
      warehouse.roleVocabulary?.circle ??
      DEFAULT_ROLE_VOCABULARY.circle ??
      [],
  }))
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0 && !saving

  const submit = async () => {
    if (!canSubmit || warehouse.id === undefined) return
    setSaving(true)
    setError(null)
    try {
      await apiDb.zones.update(warehouse.id, {
        name: trimmedName,
        color,
        description: warehouse.description ?? '',
        address: address.trim() || undefined,
        center: warehouse.center,
        defaultView: defaultView ?? undefined,
        shareToken,
        isPublic,
        roleVocabulary,
      })
      queryCache.invalidate('zones')
      onDone()
    } catch (err) {
      console.error('[settings] failed to save warehouse', err)
      setError(t('settingsDialog.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const regenerateToken = () => {
    // 16 bytes of hex = 32 chars, unguessable. Generated client-side and
    // persisted through the standard update endpoint; the backend's
    // unique partial index enforces no collisions, and a retry on
    // conflict would be the recovery path (rare enough to ignore here).
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    setShareToken(hex)
    setRegenerating(true)
  }

  const copyShareLink = async () => {
    if (!shareToken) return
    const url = siteUrl(`/share/${shareToken}`)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch (err) {
      console.warn('[settings] clipboard write failed', err)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label={t('settingsDialog.warehouseName')} htmlFor="wh-name" required>
        <Input
          id="wh-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={saving}
        />
      </Field>

      <Field label={t('settingsDialog.warehouseAddress')} htmlFor="wh-address">
        <Input
          id="wh-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          disabled={saving}
        />
      </Field>

      <Field label={t('settingsDialog.color')}>
        <div className="flex flex-wrap items-center gap-2">
          {COLOR_PRESETS.map((c) => {
            const selected = c.toLowerCase() === color.toLowerCase()
            return (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                disabled={saving}
                aria-label={c}
                aria-checked={selected}
                role="radio"
                className={cn(
                  'relative w-7 h-7 rounded-full transition-all hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'ring-2 ring-foreground/80 scale-105' : '',
                )}
                style={{ backgroundColor: c }}
              >
                {selected && (
                  <Check className="absolute inset-0 w-3 h-3 m-auto text-white" />
                )}
              </button>
            )
          })}
        </div>
      </Field>

      {/* Sharing row */}
      <div className="flex flex-col gap-3 p-3 border rounded-lg bg-muted/30">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {t('settingsDialog.isPublic')}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settingsDialog.isPublicHint')}
            </p>
          </div>
          <Switch
            checked={isPublic}
            onCheckedChange={setIsPublic}
            disabled={saving}
            aria-label={t('settingsDialog.isPublic')}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t('settingsDialog.shareToken')}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] font-mono bg-background border rounded px-2 py-1.5 truncate">
              {shareToken || t('settingsDialog.noToken')}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={copyShareLink}
              disabled={!shareToken || saving}
              className="h-8"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span className="text-xs">
                {copied
                  ? t('settingsDialog.copied')
                  : t('settingsDialog.copyLink')}
              </span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={regenerateToken}
              disabled={saving}
              className="h-8"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="text-xs">
                {t('settingsDialog.regenerateToken')}
              </span>
            </Button>
          </div>
          {regenerating && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              {t('settingsDialog.tokenPending')}
            </p>
          )}
        </div>
      </div>

      {/* Default view — three buttons (only the relevant ones for the
          current state render):
            • "Set manually" seeds a fresh DefaultView from the
              warehouse centre (or zeros when the centre isn't pinned)
              so the user can type lng/lat/zoom by hand. This is the
              only way to set a view from the dashboard, where there's
              no live map to capture from.
            • "Use current view" appears when the host wired
              `captureCurrentView` (editor / viewer side panels) and
              copies the live camera state into the form.
            • "Clear" wipes the view back to null. */}
      <div className="flex flex-col gap-2 p-3 border rounded-lg bg-muted/30">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {t('settingsDialog.defaultView')}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settingsDialog.defaultViewHint')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!defaultView && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  // Seed from the warehouse's pinned centre so the
                  // form starts somewhere recognisable. Falls back to
                  // 0,0 / zoom 14 / flat / north-up when nothing's
                  // saved — the user can refine from there.
                  const [lng, lat] = warehouse.center ?? [0, 0]
                  setDefaultView({
                    lng,
                    lat,
                    zoom: 14,
                    pitch: 0,
                    bearing: 0,
                  })
                }}
                disabled={saving}
                className="h-8"
              >
                {t('settingsDialog.setDefaultView', { defaultValue: 'Set view' })}
              </Button>
            )}
            {captureCurrentView && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const v = captureCurrentView()
                  if (v) setDefaultView(v)
                }}
                disabled={saving}
                className="h-8"
              >
                {t('settingsDialog.captureCurrent')}
              </Button>
            )}
            {defaultView && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDefaultView(null)}
                disabled={saving}
                className="h-8"
              >
                {t('settingsDialog.clearDefaultView')}
              </Button>
            )}
          </div>
        </div>
        {defaultView ? (
          <div className="grid grid-cols-5 gap-2 mt-1">
            <NumberField
              label={t('settingsDialog.lng')}
              value={defaultView.lng}
              onChange={(v) => setDefaultView({ ...defaultView, lng: v })}
              step={0.0001}
            />
            <NumberField
              label={t('settingsDialog.lat')}
              value={defaultView.lat}
              onChange={(v) => setDefaultView({ ...defaultView, lat: v })}
              step={0.0001}
            />
            <NumberField
              label={t('settingsDialog.zoom')}
              value={defaultView.zoom}
              onChange={(v) => setDefaultView({ ...defaultView, zoom: v })}
              step={0.5}
            />
            <NumberField
              label={t('settingsDialog.pitch')}
              value={defaultView.pitch ?? 0}
              onChange={(v) => setDefaultView({ ...defaultView, pitch: v })}
              step={5}
            />
            <NumberField
              label={t('settingsDialog.bearing')}
              value={defaultView.bearing ?? 0}
              onChange={(v) => setDefaultView({ ...defaultView, bearing: v })}
              step={5}
            />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground italic">
            {t('settingsDialog.noDefaultView')}
          </p>
        )}
      </div>

      {/* Role vocabulary — per-shape lists the user can edit so this
          warehouse's polygons and circles speak the right vocabulary
          (Office / Storage / Loading bay, etc.). Sister warehouses
          inside the same tenant can use entirely different terms. */}
      <RoleVocabularySection
        vocabulary={roleVocabulary}
        onChange={setRoleVocabulary}
        disabled={saving}
      />

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 px-3 py-2 text-xs border rounded-md text-destructive bg-destructive/10 border-destructive/20"
        >
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <DialogFooter className="gap-2 sm:gap-2">
        <Button variant="outline" onClick={onDone} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving ? t('common.saving') : t('settingsDialog.save')}
        </Button>
      </DialogFooter>
    </div>
  )
}

// =============================================================================
// Global tab
// =============================================================================

function GlobalSettings({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const [unit, setUnit] = useState<'metric' | 'imperial'>('metric')
  const [mapStyle, setMapStyle] = useState<string>(MAP_STYLES[0])
  const [tool, setTool] = useState<string>(TOOLS[0])
  const [layers, setLayers] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load all known keys once on mount. Missing keys fall back to defaults.
  useEffect(() => {
    let cancelled = false
      ; (async () => {
        setLoading(true)
        try {
          const all = await apiDb.settings.toArray()
          if (cancelled) return
          const map = new Map<string, unknown>()
          for (const s of all) map.set(s.key, s.value)
          const readStr = (key: string, fallback: string) => {
            const v = map.get(key)
            return typeof v === 'string' ? v : fallback
          }
          setUnit(readStr(GLOBAL_SETTING_KEYS.unit, 'metric') as 'metric' | 'imperial')
          setMapStyle(readStr(GLOBAL_SETTING_KEYS.mapStyle, MAP_STYLES[0]))
          setTool(readStr(GLOBAL_SETTING_KEYS.tool, TOOLS[0]))
          const layersVal = map.get(GLOBAL_SETTING_KEYS.layers)
          setLayers(
            layersVal && typeof layersVal === 'object'
              ? (layersVal as Record<string, boolean>)
              : {},
          )
        } catch (err) {
          console.warn('[settings] failed to load global settings', err)
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await Promise.all([
        apiDb.settings.put({ key: GLOBAL_SETTING_KEYS.unit, value: unit }),
        apiDb.settings.put({ key: GLOBAL_SETTING_KEYS.mapStyle, value: mapStyle }),
        apiDb.settings.put({ key: GLOBAL_SETTING_KEYS.tool, value: tool }),
        apiDb.settings.put({ key: GLOBAL_SETTING_KEYS.layers, value: layers }),
      ])
      onDone()
    } catch (err) {
      console.error('[settings] failed to save global settings', err)
      setError(t('settingsDialog.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin me-2" />
        {t('common.loading')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label={t('settingsDialog.displayUnit')}>
        <SegmentedControl
          value={unit}
          onChange={(v) => setUnit(v as 'metric' | 'imperial')}
          options={UNITS.map((u) => ({
            value: u,
            label: t(`settingsDialog.unit_${u}`),
          }))}
        />
      </Field>

      <Field label={t('settingsDialog.defaultMapStyle')}>
        <SegmentedControl
          value={mapStyle}
          onChange={setMapStyle}
          options={MAP_STYLES.map((s) => ({
            value: s,
            label: t(`settingsDialog.mapStyle_${s}`),
          }))}
        />
      </Field>

      <Field label={t('settingsDialog.defaultTool')}>
        <SegmentedControl
          value={tool}
          onChange={setTool}
          options={TOOLS.map((tt) => ({
            value: tt,
            label: t(`settingsDialog.tool_${tt}`),
          }))}
        />
      </Field>

      <Field label={t('settingsDialog.defaultLayers')}>
        <div className="grid grid-cols-2 gap-2">
          {['grid', 'marker', 'circle', 'polygon', 'line', 'image', 'model', 'text', 'stair'].map(
            (layer) => (
              <label
                key={layer}
                className="flex items-center gap-2 text-sm rounded-md border bg-background px-2.5 py-1.5 cursor-pointer hover:bg-muted/40"
              >
                <Switch
                  checked={!!layers[layer]}
                  onCheckedChange={(v) =>
                    setLayers((prev) => ({ ...prev, [layer]: v }))
                  }
                />
                <span className="capitalize">{layer}</span>
              </label>
            ),
          )}
        </div>
      </Field>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 px-3 py-2 text-xs border rounded-md text-destructive bg-destructive/10 border-destructive/20"
        >
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <DialogFooter className="gap-2 sm:gap-2">
        <Button variant="outline" onClick={onDone} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving ? t('common.saving') : t('settingsDialog.save')}
        </Button>
      </DialogFooter>
    </div>
  )
}

// =============================================================================
// Primitives
// =============================================================================

function Field({
  label,
  htmlFor,
  required,
  children,
}: {
  label: string
  htmlFor?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-xs font-medium text-muted-foreground flex items-baseline gap-1.5"
      >
        <span>{label}</span>
        {required && <span className="text-destructive">*</span>}
      </label>
      {children}
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  step,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          onChange(Number.isFinite(v) ? v : 0)
        }}
        className="h-8 text-xs"
      />
    </label>
  )
}

function SegmentedControl({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="flex gap-1 p-1 rounded-lg bg-muted/60">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex-1 inline-flex items-center justify-center px-3 h-8 rounded-md text-xs font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === opt.value
              ? 'bg-background shadow-sm text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// Expose the shape for callers (the editor side panel) that want to build
// a default-view payload from their live map instance.
export type { DefaultView }

// =============================================================================
// Per-warehouse role vocabulary editor
// =============================================================================
// Two stacked lists — one for polygons, one for circles. Each entry can
// have its label, role-key, and colour edited inline. Entries can be
// added with the "+" button at the bottom of the list and removed with
// the trash icon. The role-key is the stable id stored on each shape;
// the label is what the user sees in the panel.
//
// Validation is intentionally light: empty / duplicate keys are blocked
// at save time by the host route (apiDb.zones.update). The editor just
// nudges the user via a warning indicator on invalid rows.

function RoleVocabularySection({
  vocabulary,
  onChange,
  disabled,
}: {
  vocabulary: RoleVocabulary
  onChange: (next: RoleVocabulary) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const update = (kind: 'polygon' | 'circle', list: RoleVocabularyEntry[]) => {
    onChange({ ...vocabulary, [kind]: list })
  }
  return (
    <div className="flex flex-col gap-3 p-3 border rounded-lg bg-muted/30">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {t('settingsDialog.roleVocabulary', { defaultValue: 'Role vocabulary' })}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t('settingsDialog.roleVocabularyHint', {
            defaultValue:
              'Name the kinds of areas and points this facility uses (Office, Storage, Loading bay, …). Used for the role picker on polygons and circles.',
          })}
        </p>
      </div>

      <RoleListEditor
        title={t('settingsDialog.rolesPolygon', { defaultValue: 'Areas (polygons)' })}
        list={vocabulary.polygon ?? []}
        onChange={(list) => update('polygon', list)}
        disabled={disabled}
      />
      <RoleListEditor
        title={t('settingsDialog.rolesCircle', { defaultValue: 'Points (circles)' })}
        list={vocabulary.circle ?? []}
        onChange={(list) => update('circle', list)}
        disabled={disabled}
      />
    </div>
  )
}

const ROLE_COLOR_PALETTE = [
  '#6366f1', '#8b5cf6', '#3b82f6', '#06b6d4',
  '#10b981', '#84cc16', '#f59e0b', '#ef4444',
  '#ec4899', '#a16207',
] as const

function RoleListEditor({
  title,
  list,
  onChange,
  disabled,
}: {
  title: string
  list: RoleVocabularyEntry[]
  onChange: (next: RoleVocabularyEntry[]) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()

  const setEntry = (idx: number, patch: Partial<RoleVocabularyEntry>) => {
    const next = list.map((e, i) => (i === idx ? { ...e, ...patch } : e))
    onChange(next)
  }
  const removeEntry = (idx: number) => {
    onChange(list.filter((_, i) => i !== idx))
  }
  const addEntry = () => {
    // Synthesise a fresh key the user can rename. Append a small
    // counter so adding several in a row doesn't collide.
    let suffix = 1
    while (list.some((e) => e.key === `role-${suffix}`)) suffix += 1
    onChange([
      ...list,
      {
        key: `role-${suffix}`,
        label: t('settingsDialog.newRoleLabel', { defaultValue: 'New role' }),
        color: ROLE_COLOR_PALETTE[(list.length) % ROLE_COLOR_PALETTE.length],
      },
    ])
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="flex flex-col gap-1.5">
        {list.map((entry, idx) => {
          const keyInvalid = !isValidRoleKey(entry.key)
          const duplicate =
            list.findIndex((e, i) => i !== idx && e.key === entry.key) !== -1
          return (
            <li
              key={idx}
              className="flex items-center gap-2 rounded border bg-background px-2 py-1.5"
            >
              <input
                type="color"
                value={entry.color ?? '#6366f1'}
                onChange={(e) => setEntry(idx, { color: e.target.value })}
                disabled={disabled}
                aria-label={t('settingsDialog.roleColor', { defaultValue: 'Role colour' })}
                className="w-6 h-6 bg-transparent border rounded cursor-pointer"
              />
              <Input
                value={entry.label}
                onChange={(e) => setEntry(idx, { label: e.target.value })}
                placeholder={t('settingsDialog.roleLabel', { defaultValue: 'Label' })}
                disabled={disabled}
                className="flex-1 min-w-0 text-xs h-7"
              />
              <Input
                value={entry.key}
                onChange={(e) =>
                  setEntry(idx, { key: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })
                }
                placeholder={t('settingsDialog.roleKey', { defaultValue: 'key' })}
                disabled={disabled}
                className={cn(
                  'h-7 text-[11px] font-mono w-24',
                  (keyInvalid || duplicate) && 'border-amber-500',
                )}
                title={
                  duplicate
                    ? t('settingsDialog.roleKeyDuplicate', {
                      defaultValue: 'Duplicate key',
                    })
                    : keyInvalid
                      ? t('settingsDialog.roleKeyInvalid', {
                        defaultValue:
                          'Use lowercase letters, digits, and dashes only',
                      })
                      : undefined
                }
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeEntry(idx)}
                disabled={disabled}
                className="w-7 h-7 text-muted-foreground hover:text-destructive"
                aria-label={t('common.delete', { defaultValue: 'Delete' })}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </li>
          )
        })}
      </ul>
      <Button
        variant="outline"
        size="sm"
        onClick={addEntry}
        disabled={disabled}
        className="self-start text-xs h-7"
      >
        <Plus className="w-3.5 h-3.5 me-1" />
        {t('settingsDialog.roleAdd', { defaultValue: 'Add role' })}
      </Button>
    </div>
  )
}