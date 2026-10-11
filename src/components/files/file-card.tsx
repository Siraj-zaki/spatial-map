/**
 * One file, two layouts: `FileGridCard` (gallery) and `FileListRow`
 * (dense list for cleanup). Both open the detail panel on click, carry a
 * selection checkbox when the file can be deleted, and share the ⋯ menu.
 *
 * Status badges appear only when they ask for a decision (Leftover,
 * Unused, Missing) — "In use" is the normal case and would be noise on
 * every card.
 */

import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Check, Download, Eye, Link2, MapPin, MoreHorizontal, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { FileCard } from '@/lib/files-client'
import { fullTime, relativeTime } from '@/lib/relative-time'
import { toast } from '@/lib/toast-store'
import { cn } from '@/lib/utils'
import {
  canDelete,
  displayFileName,
  fileType,
  fileTypeLabel,
  formatBytes,
  statusLabel,
  statusVariant,
  usageLine,
} from './file-helpers'
import { FileThumb } from './file-preview'

interface FileItemProps {
  file: FileCard
  /** Cleanup view or an active selection: checkboxes stay visible. */
  selectMode?: boolean
  selected: boolean
  onToggleSelect: () => void
  onOpen: () => void
  onDelete: () => void
}

export async function copyFileLink(file: FileCard, t: TFunction) {
  try {
    await navigator.clipboard.writeText(new URL(file.url, window.location.origin).href)
    toast.success(t('files.linkCopied', { defaultValue: 'Link copied' }))
  } catch {
    toast.error(t('files.linkCopyFailed', { defaultValue: 'Couldn’t copy the link' }))
  }
}

function SelectBox({ file, selected, onToggle, className }: { file: FileCard; selected: boolean; onToggle: () => void; className?: string }) {
  const { t } = useTranslation()
  const name = displayFileName(file.key)
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={t('files.selectFile', { defaultValue: 'Select {{name}}', name })}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        'relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 bg-background text-transparent hover:border-primary',
        className,
      )}
    >
      <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
    </button>
  )
}

export function FileActionsMenu({ file, onOpen, onDelete, align = 'end', className }: Pick<FileItemProps, 'file' | 'onOpen' | 'onDelete'> & { align?: 'start' | 'end'; className?: string }) {
  const { t } = useTranslation()
  const name = displayFileName(file.key)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('relative z-10 h-8 w-8 shrink-0 text-muted-foreground', className)}
          aria-label={t('files.actionsFor', { defaultValue: 'Actions for {{name}}', name })}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-48" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={onOpen}>
          <Eye className="h-4 w-4" />
          {t('files.openDetails', { defaultValue: 'Open details' })}
        </DropdownMenuItem>
        {file.category !== 'missing' && (
          <>
            <DropdownMenuItem asChild>
              <a href={file.url} download={displayFileName(file.key)} target="_blank" rel="noreferrer">
                <Download className="h-4 w-4" />
                {t('files.download', { defaultValue: 'Download' })}
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyFileLink(file, t)}>
              <Link2 className="h-4 w-4" />
              {t('files.copyLink', { defaultValue: 'Copy link' })}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onDelete} className="text-danger focus:bg-danger/10 focus:text-danger">
          <Trash2 className="h-4 w-4" />
          {canDelete(file) ? t('files.delete', { defaultValue: 'Delete' }) : t('files.whyCantDelete', { defaultValue: 'Why can’t I delete this?' })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function FileGridCard({ file, selectMode, selected, onToggleSelect, onOpen, onDelete }: FileItemProps) {
  const { t, i18n } = useTranslation()
  const name = displayFileName(file.key)
  const deletable = canDelete(file)
  return (
    <article
      className={cn(
        'group relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition-[border-color,box-shadow] duration-200 hover:border-foreground/20 hover:shadow-md motion-reduce:transition-none',
        selected && 'border-primary ring-1 ring-primary hover:border-primary',
      )}
    >
      <div className="relative aspect-[4/3] overflow-hidden border-b bg-muted/40">
        <FileThumb file={file} className="transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100" />
        {deletable && (
          <SelectBox
            file={file}
            selected={selected}
            onToggle={onToggleSelect}
            className={cn(
              'absolute start-2 top-2',
              !selected && !selectMode && 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
            )}
          />
        )}
        {file.category !== 'attached' && (
          <Badge variant={statusVariant(file.category)} className="absolute end-2 top-2 border-border/60 bg-background/90 shadow-sm backdrop-blur">
            {statusLabel(file.category, t)}
          </Badge>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-1 p-3 pe-1.5">
        <div className="min-w-0 flex-1">
          {/* The name button stretches over the whole card (after:inset-0)
              so the card is one click target; checkbox + menu sit above it. */}
          <button
            type="button"
            onClick={onOpen}
            title={file.key}
            dir="ltr"
            className="block w-full truncate text-start text-sm font-medium after:absolute rtl:text-right after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {name}
          </button>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {fileTypeLabel(fileType(file), t)} · {formatBytes(file.size, i18n.language)}
            {file.uploadedAt && (
              <span className="hidden sm:inline">
                {' · '}
                <time dateTime={file.uploadedAt} title={fullTime(file.uploadedAt, i18n.language)}>
                  {relativeTime(file.uploadedAt, i18n.language)}
                </time>
              </span>
            )}
          </p>
          <p className={cn('mt-1.5 flex min-w-0 items-center gap-1 text-xs', file.category === 'attached' ? 'text-foreground/80' : 'text-muted-foreground')}>
            <MapPin className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
            <span className="truncate">{usageLine(file, t)}</span>
          </p>
        </div>
        <FileActionsMenu file={file} onOpen={onOpen} onDelete={onDelete} />
      </div>
    </article>
  )
}

export function FileListRow({ file, selected, onToggleSelect, onOpen, onDelete }: FileItemProps) {
  const { t, i18n } = useTranslation()
  const name = displayFileName(file.key)
  return (
    <li className={cn('group relative flex items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/40 sm:px-4', selected && 'bg-primary/5 hover:bg-primary/5')}>
      <div className="flex w-5 shrink-0 justify-center">
        {canDelete(file) && <SelectBox file={file} selected={selected} onToggle={onToggleSelect} />}
      </div>
      <div className="relative h-10 w-12 shrink-0 overflow-hidden rounded-md border bg-muted/40">
        <FileThumb file={file} className="p-0.5" />
      </div>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          title={file.key}
          dir="ltr"
          className="block w-full truncate text-start text-sm font-medium after:absolute rtl:text-right after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
        >
          {name}
        </button>
        <p className="truncate text-xs text-muted-foreground">
          <span className="sm:hidden">{fileTypeLabel(fileType(file), t)} · {formatBytes(file.size, i18n.language)} · </span>
          {usageLine(file, t)}
        </p>
      </div>
      <span className="hidden w-28 shrink-0 truncate text-sm text-muted-foreground md:block">{fileTypeLabel(fileType(file), t)}</span>
      <div className="hidden w-24 shrink-0 sm:block">
        <Badge variant={statusVariant(file.category)}>{statusLabel(file.category, t)}</Badge>
      </div>
      <span className="hidden w-20 shrink-0 text-end text-sm tabular-nums text-muted-foreground sm:block">{formatBytes(file.size, i18n.language)}</span>
      <span className="hidden w-28 shrink-0 text-end text-sm text-muted-foreground lg:block" title={fullTime(file.uploadedAt, i18n.language)}>
        {relativeTime(file.uploadedAt, i18n.language)}
      </span>
      <FileActionsMenu file={file} onOpen={onOpen} onDelete={onDelete} />
    </li>
  )
}

/** Column headings for the list view — mirrors FileListRow's widths. */
export function FileListHeader({ allSelected, someSelected, onToggleAll, selectable }: { allSelected: boolean; someSelected: boolean; onToggleAll: () => void; selectable: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground sm:px-4">
      <div className="flex w-5 shrink-0 justify-center">
        {selectable && (
          <button
            type="button"
            role="checkbox"
            aria-checked={allSelected ? true : someSelected ? 'mixed' : false}
            aria-label={t('files.selectAllVisible', { defaultValue: 'Select all files that can be deleted' })}
            onClick={onToggleAll}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              allSelected || someSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 bg-background hover:border-primary',
            )}
          >
            {allSelected ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : someSelected ? <span className="h-0.5 w-2.5 rounded bg-current" /> : null}
          </button>
        )}
      </div>
      <span className="w-12 shrink-0" aria-hidden />
      <span className="flex-1">{t('files.col.name', { defaultValue: 'Name' })}</span>
      <span className="hidden w-28 shrink-0 md:block">{t('files.col.type', { defaultValue: 'Type' })}</span>
      <span className="hidden w-24 shrink-0 sm:block">{t('files.col.status', { defaultValue: 'Status' })}</span>
      <span className="hidden w-20 shrink-0 text-end sm:block">{t('files.col.size', { defaultValue: 'Size' })}</span>
      <span className="hidden w-28 shrink-0 text-end lg:block">{t('files.col.uploaded', { defaultValue: 'Uploaded' })}</span>
      <span className="w-8 shrink-0" aria-hidden />
    </div>
  )
}
