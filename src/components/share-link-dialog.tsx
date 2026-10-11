import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Copy,
  ExternalLink,
  Link2,
  Layers as LayersIcon,
  Paintbrush,
  Plus,
  Settings2,
  Shield,
  Trash2,
  Undo2,
  Check as CheckIcon,
  Loader2,
  Info,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  MAP_STYLE_IDS,
  DEFAULT_MAP_STYLE,
  defaultStyleLabel,
  type MapStyleId,
} from '@/components/mapbox-map'
import { PALETTES, type ThemeMode, type ThemePalette } from '@/components/theme-provider'
import {
  createShareLink,
  deleteShareLink,
  listShareLinks,
  revokeShareLink,
  shareLinkUrl,
  updateShareLink,
  EXPIRY_PRESETS,
  type ExpiryPresetKey,
  type ShareChromeFlags,
  type ShareLayerKind,
  type ShareLink,
  type ShareLinkSettings,
} from '@/lib/share-link-client'
import type { DataLinkConfig, Zone } from '@/lib/db'
import type { ImageShape } from '@/lib/shapes'

/**
 * Share-link dialog — the production surface users hit to issue,
 * customise, and manage share links for a warehouse. Six tabs:
 *
 *   1. General      — label, expiry (preset OR absolute date), view cap
 *   2. Appearance   — map style, palette, theme mode, watermark
 *   3. Layout       — default floor plan, per-kind layer visibility
 *   4. Data links   — per-config on/off + filter overrides
 *   5. Chrome       — which viewer UI panels to render
 *   6. Manage       — existing links list w/ per-row revoke / edit / delete
 *
 * The bottom of every editor tab shows a live URL preview + copy button so
 * the user can generate + share without clicking Create Link. The Save
 * button in edit mode PATCHes the existing row; in create mode it POSTs
 * a new one and switches into the Manage tab so the user sees their link
 * in the list.
 *
 * This dialog is intentionally FAT — the whole configuration surface
 * lives here so we can iterate on presentation options without touching
 * five files. Everything above the fold is driven by ShareLinkSettings
 * (see share-link-client.ts); adding a new field is a matter of adding
 * it to the type + a control here + a consumer in view.tsx.
 */

// ---- Types ---------------------------------------------------------

interface ShareLinkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Warehouse this dialog operates on. Required — no cross-warehouse share
   *  links. `id` is required (a Zone always has one server-side, but the
   *  frontend Zone type marks it optional to match the pre-save state). */
  zone: Pick<Zone, 'name'> & { id: number }
  /** Every floor plan in the warehouse — populates the default-floor picker. */
  floorPlans: ReadonlyArray<ImageShape & { id: number }>
  /** Every data-link config in the warehouse — populates the data-link tab. */
  dataLinkConfigs: ReadonlyArray<DataLinkConfig>
  /**
   * Tab to open on. Defaults to `general` (the create flow). The facilities
   * table passes `manage` so clicking a warehouse's share chip lands on the
   * list of links rather than a blank create form.
   */
  initialTab?: TabId
  /**
   * When set, the dialog loads this link into the editor on open so the
   * caller can deep-link into "edit THIS link". Ignored if the id isn't in
   * the warehouse's links (e.g. it was deleted between render and open).
   */
  initialEditLinkId?: number | null
  /**
   * Fired after every create / update / revoke / delete. Lets a caller that
   * renders its own copy of the link list (the facilities table) refresh it
   * without polling.
   */
  onLinksChanged?: () => void
}

type TabId = 'general' | 'appearance' | 'layout' | 'dataLinks' | 'chrome' | 'manage'

/** Public alias so callers can type their own `initialTab` state. */
export type ShareLinkDialogTab = TabId

const TAB_META: Array<{ id: TabId; icon: typeof Settings2; labelKey: string; fallback: string }> = [
  { id: 'general',    icon: Settings2,  labelKey: 'shareLink.tabs.general',    fallback: 'General' },
  { id: 'appearance', icon: Paintbrush, labelKey: 'shareLink.tabs.appearance', fallback: 'Appearance' },
  { id: 'layout',     icon: LayersIcon, labelKey: 'shareLink.tabs.layout',     fallback: 'Layout' },
  { id: 'dataLinks',  icon: Link2,      labelKey: 'shareLink.tabs.dataLinks',  fallback: 'Data links' },
  { id: 'chrome',     icon: Shield,     labelKey: 'shareLink.tabs.chrome',     fallback: 'Chrome' },
  { id: 'manage',     icon: LayersIcon, labelKey: 'shareLink.tabs.manage',     fallback: 'Manage links' },
]

// Layer kinds the toggle grid renders. Mirrors the viewer's layer panel.
const LAYER_KINDS: Array<{ kind: ShareLayerKind; labelKey: string; fallback: string }> = [
  { kind: 'racks',       labelKey: 'shareLink.layers.racks',       fallback: 'Racks / grids' },
  { kind: 'bins',        labelKey: 'shareLink.layers.bins',        fallback: 'Bins' },
  { kind: 'markers',     labelKey: 'shareLink.layers.markers',     fallback: 'Markers' },
  { kind: 'models',      labelKey: 'shareLink.layers.models',      fallback: '3D models' },
  { kind: 'images',      labelKey: 'shareLink.layers.images',      fallback: 'Floor plans' },
  { kind: 'text',        labelKey: 'shareLink.layers.text',        fallback: 'Text labels' },
  { kind: 'stairs',      labelKey: 'shareLink.layers.stairs',      fallback: 'Stairs' },
  { kind: 'polygons',    labelKey: 'shareLink.layers.polygons',    fallback: 'Polygons' },
  { kind: 'circles',     labelKey: 'shareLink.layers.circles',     fallback: 'Circles' },
  { kind: 'lines',       labelKey: 'shareLink.layers.lines',       fallback: 'Lines' },
  { kind: 'doors',       labelKey: 'shareLink.layers.doors',       fallback: 'Doors' },
  { kind: 'imagePlanes', labelKey: 'shareLink.layers.imagePlanes', fallback: 'Image planes' },
  { kind: 'dataLinks',   labelKey: 'shareLink.layers.dataLinks',   fallback: 'Live data' },
]

const CHROME_FIELDS: Array<{ key: keyof ShareChromeFlags; labelKey: string; fallback: string }> = [
  { key: 'showFloorPlanFilter',   labelKey: 'shareLink.chrome.showFloorPlanFilter',   fallback: 'Floor plan picker' },
  { key: 'showLayersPanel',       labelKey: 'shareLink.chrome.showLayersPanel',       fallback: 'Layers panel' },
  { key: 'showDataLinkFilter',    labelKey: 'shareLink.chrome.showDataLinkFilter',    fallback: 'Data link filter' },
  { key: 'showLegend',            labelKey: 'shareLink.chrome.showLegend',            fallback: 'Legend' },
  { key: 'showStyleSwitcher',     labelKey: 'shareLink.chrome.showStyleSwitcher',     fallback: 'Map style switcher' },
  { key: 'showGraphicsSettings',  labelKey: 'shareLink.chrome.showGraphicsSettings',  fallback: 'Graphics quality' },
  { key: 'showLanguageSwitcher',  labelKey: 'shareLink.chrome.showLanguageSwitcher',  fallback: 'Language switcher' },
  { key: 'showThemePicker',       labelKey: 'shareLink.chrome.showThemePicker',       fallback: 'Theme palette picker' },
  { key: 'showModeToggle',        labelKey: 'shareLink.chrome.showModeToggle',        fallback: 'Light / dark toggle' },
  { key: 'showShareBadge',        labelKey: 'shareLink.chrome.showShareBadge',        fallback: '"Shared view" badge' },
  { key: 'allowInteraction',      labelKey: 'shareLink.chrome.allowInteraction',      fallback: 'Allow pan / zoom' },
]

const EXPIRY_OPTIONS: Array<{ key: ExpiryPresetKey; labelKey: string; fallback: string }> = [
  { key: 'ONE_HOUR',   labelKey: 'shareLink.expiry.oneHour',   fallback: '1 hour' },
  { key: 'ONE_DAY',    labelKey: 'shareLink.expiry.oneDay',    fallback: '1 day' },
  { key: 'SEVEN_DAYS', labelKey: 'shareLink.expiry.sevenDays', fallback: '7 days' },
  { key: 'THIRTY_DAYS',labelKey: 'shareLink.expiry.thirtyDays',fallback: '30 days' },
  { key: 'NINETY_DAYS',labelKey: 'shareLink.expiry.ninetyDays',fallback: '90 days' },
  { key: 'ONE_YEAR',   labelKey: 'shareLink.expiry.oneYear',   fallback: '1 year' },
  { key: 'NEVER',      labelKey: 'shareLink.expiry.never',     fallback: 'Never expires' },
  { key: 'CUSTOM',     labelKey: 'shareLink.expiry.custom',    fallback: 'Custom date…' },
]

// ---- Draft state ---------------------------------------------------

// Local editor state. `settings` is what will be sent; the top-level
// fields are the general-tab bits (label / expiry / max_views) that don't
// live inside the settings blob.
interface Draft {
  label: string
  expiryPreset: ExpiryPresetKey
  customExpiresAt: string // YYYY-MM-DDTHH:mm — <input type="datetime-local">
  maxViews: string        // raw input, parsed on submit
  settings: ShareLinkSettings
}

const EMPTY_DRAFT: Draft = {
  label: '',
  expiryPreset: 'SEVEN_DAYS',
  customExpiresAt: '',
  maxViews: '',
  settings: {},
}

// Recover a draft from an existing link so the Manage tab's Edit path
// can re-open the editor tabs with pre-filled values. When the link has
// a `settings.expiresAt` we treat the preset as CUSTOM and populate the
// custom field so the user can tweak. When there's no expiry we snap to
// NEVER.
function draftFromLink(link: ShareLink): Draft {
  const iso = link.expiresAt
  let customExpiresAt = ''
  let preset: ExpiryPresetKey = 'NEVER'
  if (iso) {
    preset = 'CUSTOM'
    // Slice to `YYYY-MM-DDTHH:mm` so `datetime-local` accepts it.
    customExpiresAt = iso.slice(0, 16)
  }
  return {
    label: link.label ?? '',
    expiryPreset: preset,
    customExpiresAt,
    maxViews: link.maxViews != null ? String(link.maxViews) : '',
    settings: link.settings ?? {},
  }
}

// ---- Dialog --------------------------------------------------------

export function ShareLinkDialog({
  open,
  onOpenChange,
  zone,
  floorPlans,
  dataLinkConfigs,
  initialTab,
  initialEditLinkId,
  onLinksChanged,
}: ShareLinkDialogProps) {
  const { t } = useTranslation()

  // Seeded from the prop rather than synced in an effect: both call sites
  // mount this dialog only while it is open, so every open is a fresh mount
  // — and a fresh mount can't carry a draft over from another warehouse.
  const [tab, setTab] = useState<TabId>(initialTab ?? 'general')
  const [links, setLinks] = useState<ShareLink[]>([])
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedFor, setCopiedFor] = useState<number | null>(null)

  // Load existing links every time the dialog opens against a warehouse.
  // Cheap — a few rows per warehouse in the common case; the endpoint is
  // tenant-scoped and fully server-authoritative. When the caller asked to
  // deep-link into one link's editor we hydrate the draft from the loaded
  // row, so `initialEditLinkId` can't act on a link that no longer exists.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBusy(true)
    setError(null)
    listShareLinks(zone.id)
      .then((rows) => {
        if (cancelled) return
        setLinks(rows)
        const target = initialEditLinkId != null
          ? rows.find((l) => l.id === initialEditLinkId)
          : undefined
        if (target) {
          setEditingId(target.id)
          setDraft(draftFromLink(target))
        }
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message ?? 'Failed to load share links')
      })
      .finally(() => {
        if (cancelled) return
        setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, zone.id, initialEditLinkId])

  const resetDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT)
    setEditingId(null)
  }, [])

  const patchSettings = useCallback((patch: Partial<ShareLinkSettings>) => {
    setDraft((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }))
  }, [])

  const patchChrome = useCallback((patch: Partial<ShareChromeFlags>) => {
    setDraft((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        chrome: { ...(prev.settings.chrome ?? {}), ...patch },
      },
    }))
  }, [])

  const patchLayer = useCallback((kind: ShareLayerKind, visible: boolean) => {
    setDraft((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        layerVisibility: { ...(prev.settings.layerVisibility ?? {}), [kind]: visible },
      },
    }))
  }, [])

  const toggleHiddenDataLink = useCallback((configId: number, hidden: boolean) => {
    setDraft((prev) => {
      const cur = new Set(prev.settings.hiddenDataLinkConfigIds ?? [])
      if (hidden) cur.add(configId)
      else cur.delete(configId)
      return {
        ...prev,
        settings: {
          ...prev.settings,
          hiddenDataLinkConfigIds: Array.from(cur),
        },
      }
    })
  }, [])

  const dropDraftExpiry = useCallback(() => {
    setDraft((prev) => ({ ...prev, expiryPreset: 'NEVER', customExpiresAt: '' }))
  }, [])

  const request = useMemo(() => {
    const req: {
      label: string
      settings: ShareLinkSettings
      expiresAt?: string | null
      expirySeconds?: number | null
      maxViews?: number | null
    } = {
      label: draft.label.trim(),
      settings: draft.settings,
    }
    if (draft.expiryPreset === 'NEVER') {
      req.expiresAt = null
      req.expirySeconds = null
    } else if (draft.expiryPreset === 'CUSTOM') {
      if (draft.customExpiresAt) {
        // `datetime-local` gives us a value in local time WITHOUT a
        // timezone suffix. new Date() interprets it as local and
        // toISOString() emits UTC — exactly what the backend wants.
        const d = new Date(draft.customExpiresAt)
        if (!Number.isNaN(d.getTime())) req.expiresAt = d.toISOString()
      }
    } else {
      req.expirySeconds = EXPIRY_PRESETS[draft.expiryPreset]
    }
    const parsedMax = Number.parseInt(draft.maxViews, 10)
    if (Number.isFinite(parsedMax) && parsedMax > 0) req.maxViews = parsedMax
    else req.maxViews = null
    return req
  }, [draft])

  const saveDraft = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      if (editingId != null) {
        const updated = await updateShareLink(editingId, request)
        setLinks((prev) => prev.map((l) => (l.id === updated.id ? updated : l)))
      } else {
        const created = await createShareLink(zone.id, request)
        setLinks((prev) => [created, ...prev])
        setTab('manage')
      }
      resetDraft()
      onLinksChanged?.()
    } catch (err) {
      setError((err as Error)?.message ?? 'Save failed')
    } finally {
      setBusy(false)
    }
  }, [editingId, request, resetDraft, zone.id, onLinksChanged])

  const handleRevoke = useCallback(async (id: number) => {
    setBusy(true)
    setError(null)
    try {
      const revoked = await revokeShareLink(id)
      setLinks((prev) => prev.map((l) => (l.id === revoked.id ? revoked : l)))
      onLinksChanged?.()
    } catch (err) {
      setError((err as Error)?.message ?? 'Revoke failed')
    } finally {
      setBusy(false)
    }
  }, [onLinksChanged])

  const handleDelete = useCallback(async (id: number) => {
    setBusy(true)
    setError(null)
    try {
      await deleteShareLink(id)
      setLinks((prev) => prev.filter((l) => l.id !== id))
      onLinksChanged?.()
    } catch (err) {
      setError((err as Error)?.message ?? 'Delete failed')
    } finally {
      setBusy(false)
    }
  }, [onLinksChanged])

  const copyToClipboard = useCallback(async (token: string, id: number) => {
    try {
      await navigator.clipboard.writeText(shareLinkUrl(token))
      setCopiedFor(id)
      setTimeout(() => setCopiedFor((prev) => (prev === id ? null : prev)), 1800)
    } catch {
      /* clipboard denied — user can select + copy from the input */
    }
  }, [])

  const startEditing = useCallback((link: ShareLink) => {
    setEditingId(link.id)
    setDraft(draftFromLink(link))
    setTab('general')
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[85dvh] p-0 gap-0 flex flex-col overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Link2 className="w-5 h-5" />
            {t('shareLink.title', { defaultValue: 'Share facility' })}
            <span className="text-sm text-muted-foreground font-normal">— {zone.name}</span>
          </DialogTitle>
          <DialogDescription>
            {t('shareLink.description', {
              defaultValue:
                'Create branded, expiring, view-capped share links. Each link opens the read-only viewer with the settings you configure below.',
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col sm:flex-row flex-1 min-h-0">
          {/* Tab rail — horizontal scroll strip on phones, vertical rail on sm+ */}
          <nav className="flex flex-row sm:flex-col overflow-x-auto sm:overflow-x-visible sm:overflow-y-auto border-b sm:border-b-0 sm:border-r bg-muted/30 py-2 flex-shrink-0">
            {TAB_META.map(({ id, icon: Icon, labelKey, fallback }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 text-sm text-start transition-colors whitespace-nowrap sm:w-full',
                  tab === id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent',
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {t(labelKey, { defaultValue: fallback })}
              </button>
            ))}
          </nav>

          {/* Body */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {tab === 'general' && (
                <GeneralTab
                  draft={draft}
                  onDraft={setDraft}
                  onClearExpiry={dropDraftExpiry}
                />
              )}
              {tab === 'appearance' && (
                <AppearanceTab
                  settings={draft.settings}
                  onPatch={patchSettings}
                />
              )}
              {tab === 'layout' && (
                <LayoutTab
                  settings={draft.settings}
                  floorPlans={floorPlans}
                  onPatch={patchSettings}
                  onLayerPatch={patchLayer}
                />
              )}
              {tab === 'dataLinks' && (
                <DataLinksTab
                  settings={draft.settings}
                  configs={dataLinkConfigs}
                  onToggle={toggleHiddenDataLink}
                />
              )}
              {tab === 'chrome' && (
                <ChromeTab
                  settings={draft.settings}
                  onPatch={patchChrome}
                />
              )}
              {tab === 'manage' && (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                      {t('shareLink.manage.header', {
                        defaultValue:
                          'Existing links for this facility. Edit to change settings, or start a new one.',
                      })}
                    </p>
                    <Button
                      size="sm"
                      onClick={() => {
                        resetDraft()
                        setTab('general')
                      }}
                      disabled={busy}
                    >
                      <Plus className="w-4 h-4 me-1.5" />
                      {t('shareLink.manage.new', { defaultValue: 'New link' })}
                    </Button>
                  </div>
                  <ManageTab
                    links={links}
                    busy={busy}
                    copiedFor={copiedFor}
                    onCopy={copyToClipboard}
                    onEdit={startEditing}
                    onRevoke={handleRevoke}
                    onDelete={handleDelete}
                  />
                </>
              )}
            </div>

            {/* Footer: error message + action bar */}
            {error && (
              <div className="border-t px-6 py-2 bg-destructive/10 text-destructive text-sm">
                {error}
              </div>
            )}
            {tab !== 'manage' && (
              <div className="border-t px-6 py-4 flex items-center gap-2 justify-between bg-background flex-shrink-0">
                <div className="text-xs text-muted-foreground">
                  {editingId != null
                    ? t('shareLink.editingNotice', { defaultValue: 'Editing existing link — Save updates it in place.' })
                    : t('shareLink.creatingNotice', { defaultValue: 'Configure below, then Create link. Nothing is shared until you copy the URL.' })}
                </div>
                <div className="flex items-center gap-2">
                  {editingId != null && (
                    <Button variant="ghost" size="sm" onClick={resetDraft} disabled={busy}>
                      <Undo2 className="w-4 h-4 me-1.5" />
                      {t('shareLink.cancelEdit', { defaultValue: 'Cancel' })}
                    </Button>
                  )}
                  <Button onClick={saveDraft} disabled={busy}>
                    {busy ? <Loader2 className="w-4 h-4 me-1.5 animate-spin" /> : <Plus className="w-4 h-4 me-1.5" />}
                    {editingId != null
                      ? t('shareLink.saveChanges', { defaultValue: 'Save changes' })
                      : t('shareLink.createLink', { defaultValue: 'Create link' })}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---- Tab: General --------------------------------------------------

function GeneralTab({
  draft,
  onDraft,
  onClearExpiry,
}: {
  draft: Draft
  onDraft: (patch: Draft | ((prev: Draft) => Draft)) => void
  onClearExpiry: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <Section title={t('shareLink.section.identity', { defaultValue: 'Identity' })}>
        <FieldRow
          label={t('shareLink.field.label', { defaultValue: 'Label' })}
          hint={t('shareLink.field.labelHint', { defaultValue: 'Shown in the Manage tab so you can tell links apart. Optional.' })}
        >
          <Input
            value={draft.label}
            onChange={(e) => onDraft((prev) => ({ ...prev, label: e.target.value }))}
            placeholder={t('shareLink.field.labelPlaceholder', { defaultValue: 'e.g. Sales demo, Customer #42, Kiosk' }) as string}
            maxLength={120}
          />
        </FieldRow>
      </Section>

      <Section title={t('shareLink.section.expiry', { defaultValue: 'Expiry' })}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {EXPIRY_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => onDraft((prev) => ({ ...prev, expiryPreset: opt.key }))}
              className={cn(
                'px-3 py-2 rounded-md border text-sm text-start transition-colors',
                draft.expiryPreset === opt.key
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:bg-accent',
              )}
            >
              {t(opt.labelKey, { defaultValue: opt.fallback })}
            </button>
          ))}
        </div>
        {draft.expiryPreset === 'CUSTOM' && (
          <div className="mt-3 flex items-center gap-2">
            <Input
              type="datetime-local"
              value={draft.customExpiresAt}
              onChange={(e) => onDraft((prev) => ({ ...prev, customExpiresAt: e.target.value }))}
              className="max-w-xs"
            />
            <Button variant="ghost" size="sm" onClick={onClearExpiry}>
              {t('shareLink.expiry.clear', { defaultValue: 'Clear' })}
            </Button>
          </div>
        )}
      </Section>

      <Section title={t('shareLink.section.viewCap', { defaultValue: 'View cap' })}>
        <FieldRow
          label={t('shareLink.field.maxViews', { defaultValue: 'Maximum views' })}
          hint={t('shareLink.field.maxViewsHint', { defaultValue: 'Kill the link automatically after this many opens. Leave blank for unlimited.' })}
        >
          <Input
            type="number"
            min={1}
            step={1}
            value={draft.maxViews}
            onChange={(e) => onDraft((prev) => ({ ...prev, maxViews: e.target.value }))}
            placeholder={t('shareLink.field.maxViewsPlaceholder', { defaultValue: 'Unlimited' }) as string}
            className="max-w-xs"
          />
        </FieldRow>
      </Section>

      <Section title={t('shareLink.section.notes', { defaultValue: 'Operator notes' })}>
        <FieldRow
          label={t('shareLink.field.notes', { defaultValue: 'Notes' })}
          hint={t('shareLink.field.notesHint', { defaultValue: 'Private to admins. Reminders like "Sales demo — expires end of quarter".' })}
        >
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px]"
            value={draft.settings.notes ?? ''}
            onChange={(e) =>
              onDraft((prev) => ({ ...prev, settings: { ...prev.settings, notes: e.target.value } }))
            }
            maxLength={500}
          />
        </FieldRow>
      </Section>
    </div>
  )
}

// ---- Tab: Appearance -----------------------------------------------

function AppearanceTab({
  settings,
  onPatch,
}: {
  settings: ShareLinkSettings
  onPatch: (patch: Partial<ShareLinkSettings>) => void
}) {
  const { t } = useTranslation()
  const currentStyle = settings.mapStyle ?? DEFAULT_MAP_STYLE
  const currentPalette = settings.palette ?? 'default'
  const currentMode: ThemeMode = settings.themeMode ?? 'system'
  return (
    <div className="space-y-6">
      <Section title={t('shareLink.section.mapStyle', { defaultValue: 'Basemap style' })}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {MAP_STYLE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onPatch({ mapStyle: id as MapStyleId })}
              className={cn(
                'px-3 py-2 rounded-md border text-sm text-start transition-colors',
                currentStyle === id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:bg-accent',
              )}
            >
              {defaultStyleLabel(id)}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('shareLink.section.mode', { defaultValue: 'Light / dark mode' })}>
        <div className="flex gap-2">
          {(['light', 'dark', 'system'] as ThemeMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onPatch({ themeMode: mode })}
              className={cn(
                'px-4 py-2 rounded-md border text-sm capitalize transition-colors',
                currentMode === mode
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:bg-accent',
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('shareLink.section.palette', { defaultValue: 'Accent palette' })}>
        <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPatch({ palette: p.id as ThemePalette })}
              className={cn(
                'aspect-square rounded-md border-2 relative transition-transform hover:scale-105',
                currentPalette === p.id ? 'border-foreground' : 'border-transparent',
              )}
              style={{ backgroundColor: p.swatch }}
              title={p.fallback}
            >
              {currentPalette === p.id && (
                <CheckIcon className="absolute inset-0 m-auto w-4 h-4 text-white drop-shadow" />
              )}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('shareLink.section.watermark', { defaultValue: 'Watermark text' })}>
        <FieldRow
          label={t('shareLink.field.watermark', { defaultValue: 'Watermark' })}
          hint={t('shareLink.field.watermarkHint', { defaultValue: 'Small text drawn over the viewer. Useful for "CONFIDENTIAL" or a customer name.' })}
        >
          <Input
            value={settings.watermark ?? ''}
            onChange={(e) => onPatch({ watermark: e.target.value })}
            placeholder="e.g. CONFIDENTIAL — Do not distribute"
            maxLength={80}
          />
        </FieldRow>
      </Section>
    </div>
  )
}

// ---- Tab: Layout ---------------------------------------------------

function LayoutTab({
  settings,
  floorPlans,
  onPatch,
  onLayerPatch,
}: {
  settings: ShareLinkSettings
  floorPlans: ReadonlyArray<ImageShape & { id: number }>
  onPatch: (patch: Partial<ShareLinkSettings>) => void
  onLayerPatch: (kind: ShareLayerKind, visible: boolean) => void
}) {
  const { t } = useTranslation()
  const currentFloor = settings.defaultFloorPlanId ?? null
  const layers = settings.layerVisibility ?? {}
  return (
    <div className="space-y-6">
      <Section title={t('shareLink.section.defaultFloor', { defaultValue: 'Floor plan restriction' })}>
        <p className="text-xs text-muted-foreground pb-3">
          {t('shareLink.section.defaultFloorHint', {
            defaultValue:
              'Pick "All floors" to let viewers switch between floors. Pick a specific floor to LOCK the viewer to that floor only — the picker will show just that floor as the current selection.',
          })}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto pe-2">
          <button
            type="button"
            onClick={() => onPatch({ defaultFloorPlanId: null })}
            className={cn(
              'px-3 py-2 rounded-md border text-sm text-start transition-colors',
              currentFloor === null
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border hover:bg-accent',
            )}
          >
            {t('shareLink.floor.allFloors', { defaultValue: 'All floors — viewer can switch' })}
          </button>
          {floorPlans.map((fp) => (
            <button
              key={fp.id}
              type="button"
              onClick={() => onPatch({ defaultFloorPlanId: fp.id })}
              className={cn(
                'px-3 py-2 rounded-md border text-sm text-start transition-colors',
                currentFloor === fp.id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:bg-accent',
              )}
            >
              {t('shareLink.floor.lockTo', { defaultValue: 'Lock to' })} {fp.name || `Floor ${fp.id}`}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('shareLink.section.layers', { defaultValue: 'Layer visibility' })}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
          {LAYER_KINDS.map(({ kind, labelKey, fallback }) => {
            const visible = layers[kind] !== false // default true
            return (
              <div key={kind} className="flex items-center justify-between py-1.5 border-b border-dashed">
                <Label className="text-sm cursor-pointer">
                  {t(labelKey, { defaultValue: fallback })}
                </Label>
                <Switch
                  checked={visible}
                  onCheckedChange={(v) => onLayerPatch(kind, v)}
                />
              </div>
            )
          })}
        </div>
      </Section>
    </div>
  )
}

// ---- Tab: Data links -----------------------------------------------

function DataLinksTab({
  settings,
  configs,
  onToggle,
}: {
  settings: ShareLinkSettings
  configs: ReadonlyArray<DataLinkConfig>
  onToggle: (configId: number, hidden: boolean) => void
}) {
  const { t } = useTranslation()
  const hidden = new Set(settings.hiddenDataLinkConfigIds ?? [])
  if (configs.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-8 border rounded-md">
        <Info className="w-4 h-4" />
        {t('shareLink.dataLinks.empty', {
          defaultValue: 'No data-link configurations for this facility yet. Set some up in the Data Links dialog first.',
        })}
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('shareLink.dataLinks.hint', {
          defaultValue: 'Toggle a config off to hide it entirely for viewers of this link. Filters can still be set by the viewer at runtime.',
        })}
      </p>
      <div className="space-y-2">
        {configs.map((cfg) => {
          const visible = !hidden.has(cfg.id!)
          return (
            <div
              key={cfg.id}
              className="flex items-center justify-between px-3 py-2 border rounded-md"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{cfg.name ?? `Config #${cfg.id}`}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {cfg.targetKind} · {cfg.renderMode}
                </div>
              </div>
              <Switch checked={visible} onCheckedChange={(v) => onToggle(cfg.id!, !v)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---- Tab: Chrome ---------------------------------------------------

function ChromeTab({
  settings,
  onPatch,
}: {
  settings: ShareLinkSettings
  onPatch: (patch: Partial<ShareChromeFlags>) => void
}) {
  const { t } = useTranslation()
  const chrome = settings.chrome ?? {}
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground pb-4">
        {t('shareLink.chrome.hint', {
          defaultValue: 'Choose which viewer UI elements appear for anyone opening this link. All ON by default.',
        })}
      </p>
      {CHROME_FIELDS.map(({ key, labelKey, fallback }) => (
        <div key={key} className="flex items-center justify-between py-2 border-b">
          <Label className="text-sm cursor-pointer">
            {t(labelKey, { defaultValue: fallback })}
          </Label>
          <Switch
            checked={chrome[key] !== false}
            onCheckedChange={(v) => onPatch({ [key]: v } as Partial<ShareChromeFlags>)}
          />
        </div>
      ))}
    </div>
  )
}

// ---- Tab: Manage ---------------------------------------------------

function ManageTab({
  links,
  busy,
  copiedFor,
  onCopy,
  onEdit,
  onRevoke,
  onDelete,
}: {
  links: ShareLink[]
  busy: boolean
  copiedFor: number | null
  onCopy: (token: string, id: number) => void
  onEdit: (link: ShareLink) => void
  onRevoke: (id: number) => void
  onDelete: (id: number) => void
}) {
  const { t } = useTranslation()
  if (links.length === 0 && !busy) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-16">
        <Link2 className="w-8 h-8 text-muted-foreground" />
        <div className="text-sm text-muted-foreground">
          {t('shareLink.manage.empty', {
            defaultValue: 'No share links yet. Click “New link” to configure one.',
          })}
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {links.map((link) => {
        const url = shareLinkUrl(link.token)
        const badgeTone = link.status === 'active'
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
          : link.status === 'revoked'
            ? 'bg-destructive/10 text-destructive'
            : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
        return (
          <div key={link.id} className="border rounded-lg p-4 space-y-3 bg-card">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="font-medium truncate">
                    {link.label || t('shareLink.manage.untitled', { defaultValue: 'Untitled link' })}
                  </div>
                  <span className={cn('px-2 py-0.5 rounded text-xs font-medium capitalize', badgeTone)}>
                    {link.status}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
                  <span>{t('shareLink.manage.viewCount', {
                    defaultValue: '{{count}} views',
                    count: link.viewCount,
                  })}</span>
                  {link.maxViews != null && (
                    <span>{t('shareLink.manage.viewCap', { defaultValue: 'Cap {{cap}}', cap: link.maxViews })}</span>
                  )}
                  {link.expiresAt && (
                    <span>{t('shareLink.manage.expiresAt', {
                      defaultValue: 'Expires {{when}}',
                      when: new Date(link.expiresAt).toLocaleString(),
                    })}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onEdit(link)}
                  disabled={busy}
                >
                  {t('shareLink.manage.edit', { defaultValue: 'Edit' })}
                </Button>
                {link.status !== 'revoked' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRevoke(link.id)}
                    disabled={busy}
                  >
                    {t('shareLink.manage.revoke', { defaultValue: 'Revoke' })}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onDelete(link.id)}
                    disabled={busy}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Input readOnly value={url} className="text-xs font-mono" onFocus={(e) => e.currentTarget.select()} />
              <Button
                size="sm"
                variant="outline"
                onClick={() => onCopy(link.token, link.id)}
                title={t('shareLink.manage.copy', { defaultValue: 'Copy URL' }) as string}
              >
                {copiedFor === link.id ? <CheckIcon className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                title={t('shareLink.manage.open', { defaultValue: 'Open in new tab' }) as string}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---- Shared primitives ---------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-semibold pb-2 border-b mb-3">{title}</div>
      {children}
    </div>
  )
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
