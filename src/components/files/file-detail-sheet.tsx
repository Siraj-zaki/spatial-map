/**
 * Detail panel for one stored file (`/files?file=<key>`, non-modal so the
 * gallery stays scrollable behind it): a large preview — interactive for
 * 3D models — the facts, every place the file is used with a link to
 * that facility, and the one decision this screen exists for: can it be
 * deleted, and if not, where to go instead.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Box, Check, Copy, Download, ExternalLink, Image as ImageIcon, Layers, Link2, Map as MapIcon, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { facilityEditorHref } from '@/components/facility-card'
import type { FileCard, FileReference } from '@/lib/files-client'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import {
  canDelete,
  displayFileName,
  facilitiesOf,
  fileType,
  fileTypeLabel,
  formatBytes,
  referenceKindLabel,
  statusExplainer,
  statusLabel,
  statusVariant,
} from './file-helpers'
import { FilePreview } from './file-preview'
import { copyFileLink } from './file-card'

function RefIcon({ kind }: { kind: FileReference['kind'] }) {
  const Icon = kind === 'image' ? MapIcon : kind === 'image_plane' ? Layers : Box
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, value, title, mono, copy }: { label: string; value: string; title?: string; mono?: boolean; copy?: boolean }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-3 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <span className={cn('min-w-0 flex-1 truncate', mono && 'font-mono text-xs')} dir={mono ? 'ltr' : undefined} title={title ?? value}>
          {value}
        </span>
        {copy && (
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              } catch {
                /* clipboard blocked — the value is still selectable */
              }
            }}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={copied ? t('common.copied', { defaultValue: 'Copied' }) : t('common.copy', { defaultValue: 'Copy' })}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        )}
      </dd>
    </div>
  )
}

export function FileDetailSheet({
  file,
  open,
  onOpenChange,
  onDelete,
}: {
  file: FileCard | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDelete: (file: FileCard) => void
}) {
  const { t, i18n } = useTranslation()
  // Dimensions are reported by the preview's onLoad, keyed to the file so
  // switching files never shows the previous image's size.
  const [dims, setDims] = useState<{ key: string; w: number; h: number } | null>(null)
  if (!file) return null

  const name = displayFileName(file.key)
  const refs = file.referencedBy ?? []
  const facilities = facilitiesOf(file)
  const deletable = canDelete(file)
  const size = dims?.key === file.key ? dims : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent side="end" className="w-[min(520px,100vw)] rounded-none sm:rounded-s-xl" onFocusOutside={(e) => e.preventDefault()}>
        <div className="space-y-3 border-b px-5 py-4 pe-12">
          <div className="min-w-0">
            <SheetTitle className="truncate text-base rtl:text-right" title={file.key} dir="ltr">
              {name}
            </SheetTitle>
            <SheetDescription className="sr-only">{statusExplainer(file.category, t)}</SheetDescription>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant={statusVariant(file.category)}>{statusLabel(file.category, t)}</Badge>
              <Badge variant="muted">{fileTypeLabel(fileType(file), t)}</Badge>
            </div>
          </div>
          {file.category !== 'missing' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" asChild>
                <a href={file.url} download={name} target="_blank" rel="noreferrer">
                  <Download className="h-4 w-4" />
                  {t('files.download', { defaultValue: 'Download' })}
                </a>
              </Button>
              <Button size="sm" variant="outline" onClick={() => void copyFileLink(file, t)}>
                <Link2 className="h-4 w-4" />
                {t('files.copyLink', { defaultValue: 'Copy link' })}
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={file.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t('files.openInTab', { defaultValue: 'Open in new tab' })}
                </a>
              </Button>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-5 py-5">
          <FilePreview key={file.key} file={file} onDimensions={(w, h) => setDims({ key: file.key, w, h })} />

          <Section title={t('files.detail.details', { defaultValue: 'Details' })}>
            <dl className="divide-y rounded-lg border text-sm">
              <Row label={t('files.col.type', { defaultValue: 'Type' })} value={`${fileTypeLabel(fileType(file), t)} · ${file.contentType}`} />
              <Row label={t('files.col.size', { defaultValue: 'Size' })} value={formatBytes(file.size, i18n.language)} />
              {size && (
                <Row
                  label={t('files.detail.dimensions', { defaultValue: 'Dimensions' })}
                  value={t('files.detail.pixels', { defaultValue: '{{w}} × {{h}} px', w: size.w.toLocaleString(i18n.language), h: size.h.toLocaleString(i18n.language) })}
                />
              )}
              <Row
                label={t('files.col.uploaded', { defaultValue: 'Uploaded' })}
                value={file.uploadedAt ? relativeTime(file.uploadedAt, i18n.language) : '—'}
                title={fullTime(file.uploadedAt, i18n.language)}
              />
              <Row label={t('files.detail.storedAs', { defaultValue: 'Stored as' })} value={file.key} mono copy />
            </dl>
          </Section>

          <Section title={t('files.detail.whereUsed', { defaultValue: 'Where it’s used' })}>
            {refs.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
                {t('files.detail.notUsed', { defaultValue: 'Nothing in this workspace points to this file.' })}
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {refs.map((r) => {
                  const zones = r.zoneId != null ? [{ id: r.zoneId, name: r.zoneName || `#${r.zoneId}` }] : (r.usedInZones ?? [])
                  return (
                    <li key={`${r.kind}-${r.id}`} className="flex items-start gap-3 px-3 py-2.5">
                      <RefIcon kind={r.kind} />
                      <div className="min-w-0 flex-1">
                        <p className="flex min-w-0 items-center gap-2 text-sm">
                          <span className="truncate font-medium" title={r.name}>{r.name}</span>
                          {r.isGhost && <Badge variant="warning">{t('files.status.leftover', { defaultValue: 'Leftover' })}</Badge>}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {referenceKindLabel(r.kind, t)}
                          {zones.length === 0 &&
                            ` · ${r.isGhost
                              ? t('files.detail.notOnFacility', { defaultValue: 'not on any facility' })
                              : t('files.usage.catalog', { defaultValue: 'In the 3D model catalog' })}`}
                        </p>
                        {zones.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {zones.map((z) => (
                              <Link
                                key={z.id}
                                to={facilityEditorHref(z.id)}
                                className="inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <ImageIcon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                                <span className="truncate">{z.name}</span>
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>

          <Section title={deletable ? t('files.detail.cleanup', { defaultValue: 'Clean up' }) : t('files.detail.status', { defaultValue: 'Status' })}>
            <div
              className={cn(
                'space-y-3 rounded-lg border px-4 py-3 text-sm',
                file.category === 'missing' ? 'border-danger/30 bg-danger/5' : deletable ? 'border-warning/30 bg-warning/5' : 'bg-muted/30',
              )}
            >
              <p className="text-muted-foreground">{statusExplainer(file.category, t)}</p>
              {deletable ? (
                <Button size="sm" variant="destructive" onClick={() => onDelete(file)}>
                  <Trash2 className="h-4 w-4" />
                  {t('files.deleteFile', { defaultValue: 'Delete file' })}
                </Button>
              ) : (
                facilities.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {facilities.slice(0, 3).map((f) => (
                      <Button key={f.id} size="sm" variant="outline" asChild>
                        <Link to={facilityEditorHref(f.id)}>
                          {t('files.detail.openFacility', { defaultValue: 'Open {{name}}', name: f.name })}
                        </Link>
                      </Button>
                    ))}
                  </div>
                )
              )}
            </div>
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
