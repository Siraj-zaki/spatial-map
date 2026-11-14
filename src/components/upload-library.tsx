/**
 * Shared pieces of the editor's upload library pickers (floor plan, image
 * plane, 3D model): the "This facility · Whole workspace" switch, search,
 * the image grid and the upload drop zone. Data comes from
 * `lib/upload-library.ts`; every list is the active workspace only.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, Check, ImageOff, Layers, Loader2, Search, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { useSpatialZones } from '@/hooks/useSpatialShapes'
import { rewriteFilesUrlSameOrigin, uploadImage } from '@/lib/binary-store'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { inFacility, invalidateUploadLibrary, useImageLibrary, usedInZones, type LibraryImage, type LibraryScope, type LibraryUse } from '@/lib/upload-library'

// ---- Scope + search ---------------------------------------------------------

export function LibraryScopeTabs({
  scope,
  onScopeChange,
  facilityCount,
  workspaceCount,
  extra,
}: {
  scope: string
  onScopeChange: (scope: string) => void
  facilityCount: number
  workspaceCount: number
  /** Extra tabs after the two scopes (the model dialog's Built-in). */
  extra?: { id: string; label: string; count: number; icon?: ReactNode }[]
}) {
  const { t } = useTranslation()
  const tabs = [
    { id: 'facility', label: t('library.thisFacility', { defaultValue: 'This facility' }), count: facilityCount, icon: <Building2 className="h-3.5 w-3.5" aria-hidden /> },
    { id: 'workspace', label: t('library.wholeWorkspace', { defaultValue: 'Whole workspace' }), count: workspaceCount, icon: <Layers className="h-3.5 w-3.5" aria-hidden /> },
    ...(extra ?? []),
  ]
  return (
    <div role="tablist" aria-label={t('library.scope', { defaultValue: 'Show uploads from' })} className="flex gap-1 rounded-lg bg-muted p-1">
      {tabs.map((tab) => {
        const active = scope === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onScopeChange(tab.id)}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.icon}
            <span className="truncate">{tab.label}</span>
            <span className={cn('tabular-nums', active ? 'text-muted-foreground' : 'opacity-70')}>{tab.count}</span>
          </button>
        )
      })}
    </div>
  )
}

export function LibrarySearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const { t } = useTranslation()
  return (
    <label className="relative block">
      <Search className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t('library.search', { defaultValue: 'Search uploads…' })}
        aria-label={placeholder ?? t('library.search', { defaultValue: 'Search uploads…' })}
        className="h-8 w-full rounded-md border bg-card ps-8 pe-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  )
}

/**
 * Splits a library into the facility / workspace views and applies search.
 * `scope` null = not chosen yet: open on "This facility" when it has
 * anything, otherwise on "Whole workspace" (a new facility starts empty).
 */
export function useScopedLibrary<T extends { name: string; uploadedZoneId: number | null; uses: LibraryUse[] }>(
  items: T[] | undefined,
  zoneId: number | null | undefined,
  scope: LibraryScope | null,
  query: string,
) {
  return useMemo(() => {
    const all = items ?? []
    const facility = all.filter((i) => inFacility(i, zoneId))
    const resolved: LibraryScope = scope ?? (facility.length > 0 ? 'facility' : 'workspace')
    const base = resolved === 'facility' ? facility : all
    const q = query.trim().toLowerCase()
    const shown = q ? base.filter((i) => i.name.toLowerCase().includes(q)) : base
    return { scope: resolved, facilityCount: facility.length, workspaceCount: all.length, shown }
  }, [items, zoneId, scope, query])
}

/** "Used in Warehouse A +2" / "Uploaded here · not used yet". */
export function useUsageLabel() {
  const { t } = useTranslation()
  const { data: zones } = useSpatialZones()
  const names = useMemo(() => new Map((zones ?? []).map((z) => [z.id, z.name])), [zones])
  return (item: { uploadedZoneId: number | null; uses: LibraryUse[] }, zoneId: number | null | undefined): string => {
    const used = usedInZones(item)
    if (used.length === 0) {
      return item.uploadedZoneId === zoneId && zoneId != null
        ? t('library.uploadedHereUnused', { defaultValue: 'Uploaded here · not used yet' })
        : t('library.notUsed', { defaultValue: 'Not used yet' })
    }
    const ordered = zoneId != null && used.includes(zoneId) ? [zoneId, ...used.filter((z) => z !== zoneId)] : used
    const more = ordered.length - 1
    if (ordered[0] === zoneId) {
      return more > 0
        ? t('library.usedHereMore', { count: more, defaultValue: 'Used here +{{count}}' })
        : t('library.usedHere', { defaultValue: 'Used here' })
    }
    const name = names.get(ordered[0]) ?? t('library.otherFacility', { defaultValue: 'another facility' })
    return more > 0
      ? t('library.usedInMore', { name, count: more, defaultValue: 'Used in {{name}} +{{count}}' })
      : t('library.usedIn', { name, defaultValue: 'Used in {{name}}' })
  }
}

// ---- States ------------------------------------------------------------------

export function LibrarySkeletonGrid({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3', className)} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-1.5 rounded-lg border p-1.5">
          <Skeleton className="aspect-[4/3] w-full rounded-md" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  )
}

export function LibraryEmpty({
  title,
  body,
  action,
}: {
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <div className="sgv-fade flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ImageOff className="h-4 w-4" aria-hidden />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {body && <p className="max-w-xs text-xs text-muted-foreground">{body}</p>}
      {action}
    </div>
  )
}

// ---- Image grid --------------------------------------------------------------

export function ImageLibraryGrid({
  items,
  zoneId,
  selectedKey,
  onSelect,
  onConfirm,
  columnsClassName = 'grid-cols-2 sm:grid-cols-3',
}: {
  items: LibraryImage[]
  zoneId: number | null | undefined
  selectedKey: string | null
  onSelect: (item: LibraryImage) => void
  /** Double-click / Enter on a tile — pick and continue. */
  onConfirm?: (item: LibraryImage) => void
  columnsClassName?: string
}) {
  const usage = useUsageLabel()
  return (
    <ul className={cn('sgv-fade grid gap-2', columnsClassName)} role="listbox" aria-orientation="horizontal">
      {items.map((item) => {
        const selected = item.key === selectedKey
        return (
          <li key={item.key} role="option" aria-selected={selected}>
            <button
              type="button"
              onClick={() => onSelect(item)}
              onDoubleClick={() => onConfirm?.(item)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && onConfirm) {
                  e.preventDefault()
                  onConfirm(item)
                }
              }}
              title={item.name}
              className={cn(
                'group relative block w-full rounded-lg border bg-card p-1.5 text-start transition-all',
                'hover:border-primary/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected && 'border-primary ring-2 ring-primary/30',
              )}
            >
              <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-muted">
                <img
                  src={rewriteFilesUrlSameOrigin(item.url)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                />
                {selected && (
                  <span className="absolute end-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
                    <Check className="h-3 w-3" aria-hidden />
                  </span>
                )}
              </div>
              <p dir="auto" className="mt-1.5 truncate px-0.5 text-start text-xs font-medium">{item.name}</p>
              <p className="truncate px-0.5 text-[11px] text-muted-foreground">{usage(item, zoneId)}</p>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// ---- Upload drop zone --------------------------------------------------------

export function UploadDropzone({
  accept,
  onFile,
  busy,
  title,
  hint,
  compact,
}: {
  accept: string
  onFile: (file: File) => void
  busy?: boolean
  title: string
  hint?: string
  compact?: boolean
}) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer.files?.[0]
        if (f && !busy) onFile(f)
      }}
      className={cn(
        'flex items-center gap-3 rounded-lg border border-dashed transition-colors',
        compact ? 'px-3 py-2.5' : 'flex-col px-4 py-6 text-center',
        over ? 'border-primary bg-primary/5' : 'bg-muted/30',
      )}
    >
      <div className={cn('flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary', compact ? 'h-8 w-8' : 'h-10 w-10')}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
      </div>
      <div className={cn('min-w-0', compact ? 'flex-1' : '')}>
        <p className="text-sm font-medium">{busy ? t('library.uploading', { defaultValue: 'Uploading…' }) : title}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="shrink-0 rounded-md border bg-card px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {t('library.chooseFile', { defaultValue: 'Choose file' })}
      </button>
    </div>
  )
}

/** Library ↔ Upload switch used where both live in one narrow panel. */
type LibrarySource = 'library' | 'upload' | 'blank'

/** Source switch. `blank` (a plain sheet, see blank-floor-picker) is only
 *  offered where a caller lists it — the floor-plan tool does. */
export function LibrarySourceTabs<S extends LibrarySource>({
  value,
  onChange,
  tabs = ['library', 'upload'] as S[],
}: {
  value: S
  onChange: (v: S) => void
  tabs?: readonly S[]
}) {
  const { t } = useTranslation()
  const label = (id: LibrarySource) =>
    id === 'library'
      ? t('library.fromLibrary', { defaultValue: 'From library' })
      : id === 'upload'
        ? t('library.uploadNew', { defaultValue: 'Upload new' })
        : t('library.blank', { defaultValue: 'Blank' })
  return (
    <div role="tablist" className={cn('grid gap-1 rounded-lg bg-muted p-1', tabs.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
      {tabs.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          onClick={() => onChange(id)}
          className={cn(
            'rounded-md px-2 py-1.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label(id)}
        </button>
      ))}
    </div>
  )
}

/**
 * The whole image picker: scope switch, search, grid, and the loading /
 * error / empty states. Used by the floor-plan panel, "Replace image" and
 * the image-plane tool.
 */
export function ImageLibraryPicker({
  zoneId,
  selectedKey,
  onSelect,
  onConfirm,
  onUploadInstead,
  columnsClassName,
}: {
  zoneId: number | null | undefined
  selectedKey: string | null
  onSelect: (item: LibraryImage) => void
  onConfirm?: (item: LibraryImage) => void
  /** Empty-state action that switches the caller to its upload view. */
  onUploadInstead?: () => void
  columnsClassName?: string
}) {
  const { t } = useTranslation()
  const library = useImageLibrary()
  const [scope, setScope] = useState<LibraryScope | null>(null)
  const [query, setQuery] = useState('')
  const view = useScopedLibrary(library.data, zoneId, scope, query)
  const uploadAction = onUploadInstead && (
    <button type="button" onClick={onUploadInstead} className="text-xs font-medium text-primary hover:underline">
      {t('library.uploadInstead', { defaultValue: 'Upload a new file' })}
    </button>
  )

  if (library.isLoading && !library.data) return <LibrarySkeletonGrid count={4} className={columnsClassName} />
  if (library.error && !library.data) {
    return (
      <LibraryEmpty
        title={t('library.loadError', { defaultValue: 'Couldn’t load your uploads' })}
        action={
          <button type="button" onClick={() => library.mutate()} className="text-xs font-medium text-primary hover:underline">
            {t('library.retry', { defaultValue: 'Try again' })}
          </button>
        }
      />
    )
  }
  if (view.workspaceCount === 0) {
    return (
      <LibraryEmpty
        title={t('library.emptyWorkspace', { defaultValue: 'No images uploaded in this workspace yet' })}
        body={t('library.emptyWorkspaceBody', { defaultValue: 'Upload one once and reuse it in any facility of this workspace.' })}
        action={uploadAction}
      />
    )
  }
  return (
    <div className="space-y-2">
      <LibraryScopeTabs
        scope={view.scope}
        onScopeChange={(s) => setScope(s as LibraryScope)}
        facilityCount={view.facilityCount}
        workspaceCount={view.workspaceCount}
      />
      {view.workspaceCount > 6 && <LibrarySearch value={query} onChange={setQuery} />}
      {view.shown.length === 0 ? (
        query.trim() ? (
          <LibraryEmpty title={t('library.noMatch', { query: query.trim(), defaultValue: 'Nothing matches “{{query}}”' })} />
        ) : (
          <LibraryEmpty
            title={t('library.emptyFacility', { defaultValue: 'Nothing uploaded in this facility yet' })}
            action={
              <button type="button" onClick={() => setScope('workspace')} className="text-xs font-medium text-primary hover:underline">
                {t('library.showWorkspace', { count: view.workspaceCount, defaultValue: 'Show the whole workspace ({{count}})' })}
              </button>
            }
          />
        )
      ) : (
        <ImageLibraryGrid
          items={view.shown}
          zoneId={zoneId}
          selectedKey={selectedKey}
          onSelect={onSelect}
          onConfirm={onConfirm}
          columnsClassName={columnsClassName}
        />
      )}
    </div>
  )
}

/**
 * Modal image picker: reuse a workspace upload or upload a new file, then
 * confirm. Used by "Replace image" on a floor plan and by the image-plane
 * tool (which used to jump straight to the OS file dialog).
 */
export function ImageLibraryDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  zoneId,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  zoneId: number | null | undefined
  /** Resolve to close the dialog; throw to keep it open. */
  onPick: (item: LibraryImage) => void | Promise<void>
}) {
  const { t } = useTranslation()
  const library = useImageLibrary()
  const [source, setSource] = useState<'library' | 'upload' | null>(null)
  const resolvedSource = source ?? ((library.data?.length ?? 0) > 0 ? 'library' : 'upload')
  const [selected, setSelected] = useState<LibraryImage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = async (item: LibraryImage) => {
    setBusy(true)
    setError(null)
    try {
      await onPick(item)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const upload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError(t('library.notAnImage', { defaultValue: 'Choose a PNG, JPEG, GIF or WebP image.' }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await uploadImage(file, zoneId)
      invalidateUploadLibrary()
      const item: LibraryImage = {
        key: res.url.replace(/^\/files\//, ''),
        url: res.url,
        name: file.name.replace(/\.[^.]+$/, ''),
        size: res.bytes,
        mimeType: res.mimeType || file.type,
        naturalWidth: res.naturalWidth,
        naturalHeight: res.naturalHeight,
        uploadedZoneId: zoneId ?? null,
        uses: [],
      }
      await onPick(item)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('library.uploadFailed', { defaultValue: 'Upload failed. Check your connection and try again.' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="grid max-h-[min(86dvh,760px)] max-w-2xl grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3 overflow-hidden p-5">
        <DialogHeader className="space-y-1 text-start">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <LibrarySourceTabs value={resolvedSource} onChange={setSource} />
        <div className="min-h-[12rem] overflow-y-auto overscroll-contain pe-1">
          {resolvedSource === 'library' ? (
            <ImageLibraryPicker
              zoneId={zoneId}
              selectedKey={selected?.key ?? null}
              onSelect={setSelected}
              onConfirm={(item) => void pick(item)}
              onUploadInstead={() => setSource('upload')}
              columnsClassName="grid-cols-2 sm:grid-cols-3 md:grid-cols-4"
            />
          ) : (
            <UploadDropzone
              accept="image/png,image/jpeg,image/gif,image/webp"
              onFile={(f) => void upload(f)}
              busy={busy}
              title={t('library.dropImage', { defaultValue: 'Drop an image here' })}
              hint={t('library.uploadHint', { defaultValue: 'PNG, JPEG, GIF or WebP. Saved to this workspace for reuse.' })}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
          {error && <p className="me-auto text-xs text-destructive" role="alert">{error}</p>}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </button>
          {resolvedSource === 'library' && (
            <button
              type="button"
              onClick={() => selected && void pick(selected)}
              disabled={!selected || busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
              {confirmLabel}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
