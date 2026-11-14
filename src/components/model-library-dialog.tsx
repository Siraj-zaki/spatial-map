/**
 * 3D model library — reuse a model this workspace uploaded (this facility
 * first), pick a built-in one, or upload a new .glb / .gltf.
 *
 * Left: "This facility · Whole workspace · Built-in" tabs, search and a
 * grid of real thumbnails (pre-rendered for built-ins, rendered in the
 * browser at upload time for uploads). Right: a live, rotatable preview of
 * the selected model with its details, so nothing has to be placed on the
 * map just to see what it is. Double-click / Enter places directly.
 *
 * Uploads are workspace-scoped and remember their facility
 * (`lib/upload-library.ts`); identical uploads appear once.
 */

import '@google/model-viewer'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Box, Check, Loader2, Pencil, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { formatBytes } from '@/components/files/file-helpers'
import {
  LibraryEmpty,
  LibraryScopeTabs,
  LibrarySearch,
  LibrarySkeletonGrid,
  UploadDropzone,
  useScopedLibrary,
  useUsageLabel,
} from '@/components/upload-library'
import { rewriteFilesUrlSameOrigin } from '@/lib/binary-store'
import { addUploadedModel, deleteLibraryModel, ensureModelThumbnail, renameLibraryModel } from '@/lib/model-assets'
import { BUNDLED_MODELS } from '@/lib/model-catalog'
import { invalidateUploadLibrary, useModelLibrary, type LibraryModel, type LibraryScope } from '@/lib/upload-library'
import { cn } from '@/lib/utils'

interface ModelLibraryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the user picks an asset — the parent places or swaps. */
  onSelect: (assetId: string) => void
  /** Active facility — "This facility" = uploaded or used here. */
  zoneId?: number | null
  /** `swap` replaces the selected model's asset instead of placing one. */
  mode?: 'place' | 'swap'
  /** In swap mode, the asset the selected model uses now. */
  currentAssetId?: string
}

type Tab = LibraryScope | 'builtin'

interface Entry {
  assetId: string
  name: string
  url: string
  thumbnail?: string
  orientation?: string
  uploaded?: LibraryModel
}

const ALLOWED_EXTS = ['.glb', '.gltf']

export function ModelLibraryDialog({
  open,
  onOpenChange,
  onSelect,
  zoneId,
  mode = 'place',
  currentAssetId,
}: ModelLibraryDialogProps) {
  const { t, i18n } = useTranslation()
  const library = useModelLibrary(open)
  const [tab, setTab] = useState<Tab | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(currentAssetId ?? null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<LibraryModel | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Thumbnails rendered in this session for uploads that predate them.
  const [rendered, setRendered] = useState<Record<string, string>>({})

  const scopeTab: LibraryScope | null = tab === 'builtin' ? 'workspace' : tab
  const scoped = useScopedLibrary(library.data, zoneId, scopeTab, query)
  // First open: this facility when it has uploads, else the workspace,
  // else the built-in catalog.
  const resolvedTab: Tab =
    tab ?? (scoped.facilityCount > 0 ? 'facility' : scoped.workspaceCount > 0 ? 'workspace' : library.isLoading ? 'facility' : 'builtin')

  const builtin = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase()
    return BUNDLED_MODELS.filter((m) => !q || m.label.toLowerCase().includes(q)).map((m) => ({
      assetId: m.id,
      name: m.label,
      url: m.url,
      thumbnail: m.thumbnail,
      orientation: m.previewOrientation,
    }))
  }, [query])

  const uploadedEntries = useMemo<Entry[]>(() => {
    const list = resolvedTab === 'facility' ? scoped.shown : resolvedTab === 'workspace' ? scoped.shown : []
    return list.map((m) => ({
      assetId: `user_${m.id}`,
      name: m.name,
      url: m.modelUrl,
      thumbnail: m.thumbnail || rendered[m.modelUrl],
      uploaded: m,
    }))
  }, [resolvedTab, scoped.shown, rendered])

  const entries = resolvedTab === 'builtin' ? builtin : uploadedEntries
  const allEntries = useMemo(() => {
    const map = new Map<string, Entry>()
    for (const m of library.data ?? []) {
      const e: Entry = { assetId: `user_${m.id}`, name: m.name, url: m.modelUrl, thumbnail: m.thumbnail || rendered[m.modelUrl], uploaded: m }
      map.set(e.assetId, e)
      // A placement may reference any duplicate row of the same file.
      for (const id of m.ids) map.set(`user_${id}`, e)
    }
    for (const m of BUNDLED_MODELS) map.set(m.id, { assetId: m.id, name: m.label, url: m.url, thumbnail: m.thumbnail, orientation: m.previewOrientation })
    return map
  }, [library.data, rendered])
  const selected = (selectedId && allEntries.get(selectedId)) || null

  // Give uploads from before thumbnails existed their preview, one at a time.
  const missing = useMemo(
    () => (library.data ?? []).filter((m) => !m.thumbnail && !rendered[m.modelUrl]),
    [library.data, rendered],
  )
  useEffect(() => {
    if (!open || missing.length === 0) return
    let cancelled = false
    void (async () => {
      for (const m of missing) {
        const thumb = await ensureModelThumbnail(m.ids, m.modelUrl)
        if (cancelled) return
        if (thumb) setRendered((prev) => ({ ...prev, [m.modelUrl]: thumb }))
      }
      if (!cancelled) invalidateUploadLibrary()
    })()
    return () => {
      cancelled = true
    }
  }, [open, missing])

  const choose = (assetId: string) => {
    onSelect(assetId)
    onOpenChange(false)
  }

  const handleFile = async (file: File) => {
    setUploadError(null)
    const lower = file.name.toLowerCase()
    if (!ALLOWED_EXTS.some((ext) => lower.endsWith(ext))) {
      setUploadError(t('modelLibrary.unsupported', { defaultValue: 'Choose a .glb or .gltf file.' }))
      return
    }
    setUploading(true)
    try {
      const id = await addUploadedModel(file, { zoneId: zoneId ?? null })
      setTab(zoneId != null ? 'facility' : 'workspace')
      setQuery('')
      setSelectedId(`user_${id}`)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  const placements = pendingDelete ? pendingDelete.uses.reduce((n, u) => n + u.count, 0) : 0
  const confirmLabel =
    mode === 'swap'
      ? t('modelLibrary.useModel', { defaultValue: 'Use this model' })
      : t('modelLibrary.place', { defaultValue: 'Place on map' })

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-[50%] top-[50%] z-50 grid translate-x-[-50%] translate-y-[-50%] grid-rows-[auto_minmax(0,1fr)]',
            'h-[min(88dvh,720px)] w-[min(980px,calc(100vw-1rem))]',
            'overflow-hidden rounded-xl border bg-card shadow-2xl',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          )}
        >
          <div className="flex items-center gap-3 border-b bg-muted/30 px-5 py-3.5">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Box className="h-4 w-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-sm font-semibold leading-tight">
                {mode === 'swap'
                  ? t('modelLibrary.swapTitle', { defaultValue: 'Change 3D model' })
                  : t('modelLibrary.title', { defaultValue: 'Add 3D model' })}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                {t('modelLibrary.subtitle', { defaultValue: 'Reuse a model from this workspace, pick a built-in one, or upload a .glb / .gltf.' })}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 flex-shrink-0" aria-label={t('common.close', { defaultValue: 'Close' })}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </DialogPrimitive.Close>
          </div>

          <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_320px] md:grid-rows-1">
            {/* Browse */}
            <div className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 p-4">
              <LibraryScopeTabs
                scope={resolvedTab}
                onScopeChange={(s) => setTab(s as Tab)}
                facilityCount={scoped.facilityCount}
                workspaceCount={scoped.workspaceCount}
                extra={[
                  {
                    id: 'builtin',
                    label: t('modelLibrary.builtin', { defaultValue: 'Built-in' }),
                    count: BUNDLED_MODELS.length,
                    icon: <Sparkles className="h-3.5 w-3.5" aria-hidden />,
                  },
                ]}
              />
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <LibrarySearch
                  value={query}
                  onChange={setQuery}
                  placeholder={t('modelLibrary.search', { defaultValue: 'Search models…' })}
                />
                {resolvedTab !== 'builtin' && (
                  <UploadButton busy={uploading} onFile={(f) => void handleFile(f)} />
                )}
              </div>
              <div className="min-h-0 overflow-y-auto overscroll-contain pe-1">
                {uploadError && (
                  <p className="mb-2 text-xs text-destructive" role="alert">
                    {uploadError}
                  </p>
                )}
                {resolvedTab !== 'builtin' && library.isLoading && !library.data ? (
                  <LibrarySkeletonGrid count={6} className="sm:grid-cols-3 lg:grid-cols-4" />
                ) : entries.length > 0 ? (
                  <ul role="listbox" aria-label={t('modelLibrary.title', { defaultValue: 'Add 3D model' })} className="sgv-fade grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {entries.map((e) => (
                      <ModelTile
                        key={e.assetId}
                        entry={e}
                        zoneId={zoneId}
                        selected={selected?.assetId === e.assetId}
                        current={currentAssetId === e.assetId}
                        onSelect={() => setSelectedId(e.assetId)}
                        onConfirm={() => choose(e.assetId)}
                      />
                    ))}
                  </ul>
                ) : query.trim() ? (
                  <LibraryEmpty title={t('library.noMatch', { query: query.trim(), defaultValue: 'Nothing matches “{{query}}”' })} />
                ) : resolvedTab === 'facility' ? (
                  <LibraryEmpty
                    title={t('modelLibrary.emptyFacility', { defaultValue: 'No models uploaded or used in this facility yet' })}
                    action={
                      scoped.workspaceCount > 0 ? (
                        <button type="button" onClick={() => setTab('workspace')} className="text-xs font-medium text-primary hover:underline">
                          {t('library.showWorkspace', { count: scoped.workspaceCount, defaultValue: 'Show the whole workspace ({{count}})' })}
                        </button>
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="space-y-3">
                    <UploadDropzone
                      accept=".glb,.gltf"
                      onFile={(f) => void handleFile(f)}
                      busy={uploading}
                      title={t('modelLibrary.emptyWorkspace', { defaultValue: 'No models uploaded in this workspace yet' })}
                      hint={t('modelLibrary.dropHint', { defaultValue: 'Drop a .glb (binary glTF with embedded textures) — it’s saved to this workspace for reuse.' })}
                    />
                    <button type="button" onClick={() => setTab('builtin')} className="text-xs font-medium text-primary hover:underline">
                      {t('modelLibrary.browseBuiltin', { defaultValue: 'Browse built-in models' })}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Preview */}
            <aside className="flex min-h-0 gap-3 border-t bg-muted/20 p-3 md:flex-col md:gap-4 md:border-s md:border-t-0 md:p-4">
              {selected ? (
                <PreviewPanel
                  key={selected.assetId}
                  entry={selected}
                  zoneId={zoneId}
                  locale={i18n.language}
                  confirmLabel={confirmLabel}
                  isCurrent={currentAssetId === selected.assetId}
                  onConfirm={() => choose(selected.assetId)}
                  onDelete={selected.uploaded ? () => setPendingDelete(selected.uploaded!) : undefined}
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 py-4 text-center text-muted-foreground">
                  <Box className="h-8 w-8 opacity-40" aria-hidden />
                  <p className="text-xs">{t('modelLibrary.pickToPreview', { defaultValue: 'Select a model to preview it in 3D' })}</p>
                </div>
              )}
            </aside>
          </div>

          <ConfirmDialog
            open={pendingDelete !== null}
            onOpenChange={(o) => {
              if (!o) {
                setPendingDelete(null)
                setDeleteError(null)
              }
            }}
            title={t('modelLibrary.deleteTitle', { name: pendingDelete?.name ?? '', defaultValue: 'Remove “{{name}}” from the library?' })}
            description={
              placements > 0
                ? t('modelLibrary.deleteBodyPlaced', { count: placements, defaultValue: '{{count}} placements in this workspace use it and will be removed too. This can’t be undone.' })
                : t('modelLibrary.deleteBody', { defaultValue: 'The file is deleted from this workspace. This can’t be undone.' })
            }
            confirmLabel={t('modelLibrary.deleteConfirm', { defaultValue: 'Remove' })}
            busy={deleting}
            error={deleteError ?? undefined}
            onConfirm={async () => {
              if (!pendingDelete) return
              setDeleting(true)
              setDeleteError(null)
              try {
                await deleteLibraryModel(pendingDelete.ids, placements > 0)
                if (selected?.uploaded?.id === pendingDelete.id) setSelectedId(null)
                setPendingDelete(null)
              } catch (err) {
                setDeleteError(err instanceof Error ? err.message : String(err))
              } finally {
                setDeleting(false)
              }
            }}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function UploadButton({ busy, onFile }: { busy: boolean; onFile: (f: File) => void }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".glb,.gltf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
      <Button type="button" size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
        {busy ? t('library.uploading', { defaultValue: 'Uploading…' }) : t('modelLibrary.upload', { defaultValue: 'Upload model' })}
      </Button>
    </>
  )
}

function ModelThumb({ src, className }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden rounded-md bg-gradient-to-b from-muted/40 to-muted', className)}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-contain p-1 transition-transform duration-300 group-hover:scale-[1.05] motion-reduce:transition-none" />
      ) : (
        <Box className="h-7 w-7 text-muted-foreground/60" aria-hidden />
      )}
    </div>
  )
}

function ModelTile({
  entry,
  zoneId,
  selected,
  current,
  onSelect,
  onConfirm,
}: {
  entry: Entry
  zoneId?: number | null
  selected: boolean
  current: boolean
  onSelect: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const usage = useUsageLabel()
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onConfirm}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onConfirm()
          }
        }}
        title={entry.name}
        className={cn(
          'group relative block w-full rounded-lg border bg-card p-1.5 text-start transition-all',
          'hover:border-primary/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected && 'border-primary ring-2 ring-primary/30',
        )}
      >
        <ModelThumb src={entry.thumbnail} className="aspect-square w-full" />
        {(selected || current) && (
          <span className="absolute end-2.5 top-2.5 flex items-center gap-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground shadow">
            <Check className="h-3 w-3" aria-hidden />
            {current && t('modelLibrary.current', { defaultValue: 'Current' })}
          </span>
        )}
        <p dir="auto" className="mt-1.5 truncate px-0.5 text-start text-xs font-medium">{entry.name}</p>
        <p className="truncate px-0.5 text-[11px] text-muted-foreground">
          {entry.uploaded ? usage(entry.uploaded, zoneId) : t('modelLibrary.builtinShort', { defaultValue: 'Built-in' })}
        </p>
      </button>
    </li>
  )
}

function PreviewPanel({
  entry,
  zoneId,
  locale,
  confirmLabel,
  isCurrent,
  onConfirm,
  onDelete,
}: {
  entry: Entry
  zoneId?: number | null
  locale: string
  confirmLabel: string
  isCurrent: boolean
  onConfirm: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const usage = useUsageLabel()
  const viewerRef = useRef<HTMLElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(entry.name)
  const src = rewriteFilesUrlSameOrigin(entry.url)

  useEffect(() => {
    const el = viewerRef.current
    if (!el) return
    const onLoad = () => setState('ready')
    const onError = () => setState('error')
    el.addEventListener('load', onLoad)
    el.addEventListener('error', onError)
    return () => {
      el.removeEventListener('load', onLoad)
      el.removeEventListener('error', onError)
    }
  }, [])

  const saveName = async () => {
    setEditing(false)
    const next = name.trim()
    if (!entry.uploaded || !next || next === entry.name) {
      setName(entry.name)
      return
    }
    await renameLibraryModel(entry.uploaded.ids, next)
  }

  return (
    <>
      <div className="relative aspect-square w-28 flex-shrink-0 overflow-hidden rounded-lg border bg-gradient-to-b from-card to-muted/60 md:w-full">
        <model-viewer
          ref={viewerRef}
          src={src}
          alt={entry.name}
          orientation={entry.orientation}
          camera-controls
          auto-rotate
          rotation-per-second="24deg"
          interaction-prompt="none"
          environment-image="neutral"
          exposure="1"
          shadow-intensity="0.6"
          style={{ width: '100%', height: '100%', backgroundColor: 'transparent' }}
        />
        {state !== 'ready' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {state === 'loading' ? (
              <>
                {entry.thumbnail && <img src={entry.thumbnail} alt="" className="absolute inset-0 h-full w-full object-contain p-2 opacity-60" />}
                <Loader2 className="relative h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
              </>
            ) : (
              <p className="px-3 text-center text-xs text-destructive">{t('modelLibrary.previewFailed', { defaultValue: 'This model couldn’t be loaded.' })}</p>
            )}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-none">
        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveName()
              if (e.key === 'Escape') {
                setName(entry.name)
                setEditing(false)
              }
            }}
            aria-label={t('modelLibrary.rename', { defaultValue: 'Rename' })}
            className="h-8 w-full rounded-md border bg-card px-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-ring"
          />
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <h3 dir="auto" className="min-w-0 truncate text-sm font-semibold" title={name}>{name}</h3>
            {entry.uploaded && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label={t('modelLibrary.rename', { defaultValue: 'Rename' })}
                title={t('modelLibrary.rename', { defaultValue: 'Rename' })}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Pencil className="h-3 w-3" aria-hidden />
              </button>
            )}
          </div>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {entry.uploaded ? (
            <>
              <dt className="text-muted-foreground">{t('modelLibrary.size', { defaultValue: 'Size' })}</dt>
              <dd className="truncate tabular-nums">{formatBytes(entry.uploaded.bytes, locale)}</dd>
              <dt className="text-muted-foreground">{t('modelLibrary.uploaded', { defaultValue: 'Uploaded' })}</dt>
              <dd className="truncate">{new Date(entry.uploaded.uploadedAt).toLocaleDateString(locale, { dateStyle: 'medium' })}</dd>
              <dt className="text-muted-foreground">{t('modelLibrary.usage', { defaultValue: 'Usage' })}</dt>
              <dd className="truncate">{usage(entry.uploaded, zoneId)}</dd>
            </>
          ) : (
            <>
              <dt className="text-muted-foreground">{t('modelLibrary.source', { defaultValue: 'Source' })}</dt>
              <dd className="truncate">{t('modelLibrary.builtinLong', { defaultValue: 'Built-in library' })}</dd>
            </>
          )}
        </dl>
        <div className="mt-auto flex flex-wrap gap-2 md:mt-1">
          <Button type="button" size="sm" className="flex-1" onClick={onConfirm} disabled={isCurrent || state === 'error'}>
            {isCurrent ? t('modelLibrary.inUse', { defaultValue: 'In use' }) : confirmLabel}
          </Button>
          {onDelete && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onDelete}
              aria-label={t('modelLibrary.delete', { defaultValue: 'Remove from library' })}
              title={t('modelLibrary.delete', { defaultValue: 'Remove from library' })}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </>
  )
}
