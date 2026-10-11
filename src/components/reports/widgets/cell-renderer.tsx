/**
 * Shared cell renderer for the data-table widgets. Detects URLs,
 * images, videos, booleans, numbers, JSON, arrays, and ISO date
 * strings so raw data source rows always show something sensible.
 *
 * Cells never wrap — every renderer returns a single-line element
 * that truncates with ellipsis and shows the full value on hover.
 * Images and JSON open a modal preview so users can inspect without
 * leaving the report viewer.
 */
import { useEffect, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import {
  formatReportValue,
  type ReportFieldType,
  type TableColumnConfig,
} from '@/lib/reports-client'

/** Renderer kinds a column can request explicitly. `auto` = detect
 *  from the value (URL/image/video/JSON/etc.). */
export type CellKind =
  | 'auto'
  | 'text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'image'
  | 'video'
  | 'link'
  | 'badge'
  | 'boolean'
  | 'json'

/** Extended column config understood by the cell renderer. */
export interface CellColumnConfig extends TableColumnConfig {
  /** Explicit renderer kind. When unset the renderer auto-detects. */
  cellType?: CellKind
  /** Max width for the cell — narrows the truncation window without
   *  affecting the column header. Falls back to a sensible default. */
  maxWidthPx?: number
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?|#|$)/i
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogg)(\?|#|$)/i
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Guess how a value should render when no explicit cellType is set.
 *  Runs on every cell — keep the checks lean. Object / array values
 *  short-circuit to `json` since `String(value)` would produce
 *  `[object Object]`. */
export function detectCellKind(
  value: unknown,
  fieldType: ReportFieldType,
): CellKind {
  if (value === null || value === undefined) return 'text'
  if (typeof value === 'object') return 'json'
  if (fieldType === 'boolean' || typeof value === 'boolean') return 'boolean'
  if (fieldType === 'number' || typeof value === 'number') return 'number'
  if (fieldType === 'date') return 'date'
  if (fieldType === 'datetime') return 'datetime'
  if (typeof value !== 'string') return 'text'
  const trimmed = value.trim()
  if (!trimmed) return 'text'
  // Sniff for URL / media before dates so a URL that starts with
  // "http" is never mistaken for a text.
  if (/^https?:\/\//i.test(trimmed)) {
    if (IMAGE_EXT_RE.test(trimmed)) return 'image'
    if (VIDEO_EXT_RE.test(trimmed)) return 'video'
    return 'link'
  }
  // ISO date / datetime strings even when the backend typed the
  // column as 'text' (common when the source is JSONB and the
  // executor doesn't have type metadata for the field).
  if (ISO_DATETIME_RE.test(trimmed)) return 'datetime'
  if (ISO_DATE_RE.test(trimmed)) return 'date'
  return 'text'
}

/** Render one cell. Every path returns a single-line element so the
 *  outer <td> stays row-height-consistent. */
/** Character threshold above which plain-text cells become
 *  click-to-expand — matches roughly the char width of the default
 *  240px column at 11px font. */
const TEXT_EXPAND_THRESHOLD = 40

export function CellRenderer({
  value,
  fieldType,
  config,
  locale,
}: {
  value: unknown
  fieldType: ReportFieldType
  config?: CellColumnConfig
  locale: string
}) {
  const [preview, setPreview] = useState<
    | { kind: 'image'; value: unknown }
    | { kind: 'json'; value: unknown }
    | { kind: 'text'; value: unknown; label: string }
    | null
  >(null)
  const explicit = config?.cellType
  const kind = explicit && explicit !== 'auto' ? explicit : detectCellKind(value, fieldType)

  const rawString = safeStringify(value)

  const closePreview = () => setPreview(null)

  return (
    <>
      {renderCell({
        kind,
        value,
        fieldType,
        config,
        locale,
        rawString,
        onOpenImage: (v) => setPreview({ kind: 'image', value: v }),
        onOpenJson: (v) => setPreview({ kind: 'json', value: v }),
        onOpenText: (v, label) => setPreview({ kind: 'text', value: v, label }),
      })}
      {preview && (
        <PreviewModal
          kind={preview.kind}
          value={preview.value}
          label={preview.kind === 'text' ? preview.label : undefined}
          onClose={closePreview}
        />
      )}
    </>
  )
}

function renderCell({
  kind,
  value,
  fieldType,
  config,
  locale,
  rawString,
  onOpenImage,
  onOpenJson,
  onOpenText,
}: {
  kind: CellKind
  value: unknown
  fieldType: ReportFieldType
  config?: CellColumnConfig
  locale: string
  rawString: string
  onOpenImage: (v: string) => void
  onOpenJson: (v: unknown) => void
  onOpenText: (v: unknown, label: string) => void
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground/60">—</span>
  }

  if (kind === 'image' && typeof value === 'string') {
    return (
      <button
        type="button"
        title={value}
        onClick={(e) => {
          e.stopPropagation()
          onOpenImage(value)
        }}
        className="inline-flex items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <img
          src={value}
          alt=""
          loading="lazy"
          className="h-8 w-14 object-cover rounded border border-border/60 bg-muted"
          onError={(e) => {
            const img = e.currentTarget
            img.style.display = 'none'
            const fallback = img.nextElementSibling as HTMLElement | null
            if (fallback) fallback.style.display = 'inline-flex'
          }}
        />
        <span
          className="hidden items-center gap-1 text-xs text-primary underline"
          style={{ display: 'none' }}
        >
          <ExternalLink className="w-3 h-3" />
          {shortenUrl(value)}
        </span>
      </button>
    )
  }

  if (kind === 'video' && typeof value === 'string') {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        title={value}
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        <span aria-hidden>▶</span>
        <span className="truncate max-w-40">{shortenUrl(value)}</span>
      </a>
    )
  }

  if (kind === 'link' && typeof value === 'string') {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        title={value}
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline truncate max-w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate">{shortenUrl(value)}</span>
        <ExternalLink className="w-3 h-3 opacity-60 shrink-0" />
      </a>
    )
  }

  if (kind === 'boolean') {
    const on = value === true || value === 'true' || value === 1 || value === '1'
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
          on
            ? 'bg-success/10 text-success'
            : 'bg-muted text-muted-foreground',
        )}
      >
        {on ? 'yes' : 'no'}
      </span>
    )
  }

  if (kind === 'badge' && typeof value === 'string') {
    return (
      <span
        title={value}
        className="inline-flex items-center rounded-full bg-primary/10 text-primary text-[10px] font-medium px-2 py-0.5 truncate max-w-full"
      >
        {value}
      </span>
    )
  }

  if (kind === 'json') {
    // Arrays get a "N items" summary; plain objects list a couple of
    // keys — both open a formatted preview on click.
    const label = summarizeJson(value)
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpenJson(value)
        }}
        title={rawString}
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline max-w-full"
      >
        <span aria-hidden className="opacity-70">{'{}'}</span>
        <span className="truncate">{label}</span>
      </button>
    )
  }

  if (kind === 'date' || kind === 'datetime') {
    // formatReportValue handles the locale formatting; we just pass
    // the requested format so an ISO string turns into "8/24/2026".
    const fmt = kind === 'datetime' ? 'datetime' : 'date'
    return (
      <span title={rawString} className="block truncate">
        {formatReportValue(value, fieldType, fmt, locale)}
      </span>
    )
  }

  // number / text fallback — delegate to the standard formatter.
  // If the resulting string overflows the cell's truncation window,
  // wrap it in a click-to-expand button so the user can read the
  // full value in a modal (title tooltip stays as a fast preview).
  const formatted = formatReportValue(value, fieldType, config?.format, locale)
  const expandable = kind === 'text' && formatted.length > TEXT_EXPAND_THRESHOLD
  if (expandable) {
    return (
      <button
        type="button"
        title={rawString}
        onClick={(e) => {
          e.stopPropagation()
          onOpenText(value, formatted)
        }}
        className="block w-full truncate text-start text-xs hover:text-primary hover:underline underline-offset-2 decoration-dotted"
      >
        {formatted}
      </button>
    )
  }
  return (
    <span title={rawString} className="block truncate">
      {formatted}
    </span>
  )
}

// ─────────────────────────────────────────────── modal

function PreviewModal({
  kind,
  value,
  label,
  onClose,
}: {
  kind: 'image' | 'json' | 'text'
  value: unknown
  label?: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // Prevent body scroll while the lightbox is open.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-4 right-4 rounded-full bg-white/10 hover:bg-white/20 text-white p-1.5"
      >
        <X className="w-4 h-4" />
      </button>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-w-[95vw] max-h-[90vh] flex flex-col items-center"
      >
        {kind === 'image' && typeof value === 'string' && (
          <>
            <img
              src={value}
              alt=""
              className="max-w-full max-h-[85vh] object-contain rounded shadow-2xl"
            />
            <a
              href={value}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 text-xs text-white/80 hover:text-white underline truncate max-w-full"
            >
              {value}
            </a>
          </>
        )}
        {kind === 'json' && (
          <pre className="max-w-[80vw] max-h-[85vh] overflow-auto rounded bg-card border border-border p-4 text-xs text-foreground shadow-2xl">
            {safeStringify(value, 2)}
          </pre>
        )}
        {kind === 'text' && (
          <div className="max-w-[80vw] max-h-[85vh] w-[min(80vw,48rem)] overflow-auto rounded bg-card border border-border shadow-2xl">
            <div className="border-b border-border px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              {label ? shortLabel(label) : 'Full text'}
            </div>
            <div className="p-4 text-sm text-foreground whitespace-pre-wrap break-words">
              {typeof value === 'string' ? value : safeStringify(value)}
            </div>
          </div>
        )}
      </div>
    </div>
  )

  return createPortal(node, document.body)
}

/** Header label for the text preview modal — keep it short so
 *  long labels don't force the header to scroll. */
function shortLabel(s: string): string {
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

// ─────────────────────────────────────────────── helpers

/** Safe JSON.stringify — never throws. Objects with circular refs
 *  fall back to a marker rather than crashing the whole widget. */
function safeStringify(value: unknown, indent?: number): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, indent)
  } catch {
    return String(value)
  }
}

/** Short inline label for a JSON value. Kept terse so it fits the
 *  cell's truncation window; the full value is in the tooltip and
 *  the modal. */
function summarizeJson(value: unknown): string {
  if (Array.isArray(value)) {
    const n = value.length
    if (n === 0) return '[] empty'
    const first = value[0]
    if (typeof first === 'object' && first !== null) return `${n} objects`
    return `${n} items`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    if (keys.length === 0) return '{} empty'
    return keys.slice(0, 3).join(', ') + (keys.length > 3 ? '…' : '')
  }
  return String(value)
}

/** Human-friendlier truncation for URLs used as link labels. */
function shortenUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname.split('/').filter(Boolean).slice(-1).join('/')
    return path ? `${u.hostname}/…/${path}` : u.hostname
  } catch {
    return url.length > 40 ? url.slice(0, 40) + '…' : url
  }
}
