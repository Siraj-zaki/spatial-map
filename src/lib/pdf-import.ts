import { apiPost } from './api-client'

/**
 * Client for the backend PDF floor-plan import endpoints.
 *
 * The flow is two calls against the same File object the browser is
 * already holding:
 *
 *   1. `inspectPdf(file)`  — page inventory, previews and scale hints.
 *   2. `renderPdfPage(...)` — the chosen page as a stored PNG.
 *
 * The source PDF is deliberately never persisted server-side (it would
 * become an orphan file with no DB row referencing it), so the second
 * call re-sends the bytes. That costs upload bandwidth and buys a
 * completely unchanged file-lifecycle story on the backend.
 */

/** A drawing scale expressed as a 1:N ratio. */
export interface PlotScale {
  /** What a title block would call it, e.g. `1:100` or `1/8" = 1'-0"`. */
  label: string
  /** N in 1:N. */
  denominator: number
  system: 'metric' | 'imperial'
}

export interface PdfPage {
  index: number
  widthPoints: number
  heightPoints: number
  widthMm: number
  heightMm: number
  /** Recognised standard sheet (`ARCH D`, `A1`, …), absent if non-standard. */
  sheet?: string
  orientation: 'portrait' | 'landscape' | 'square'
  /** Inline preview data URL. Absent for documents above the page cap. */
  thumbnail?: string
  /** Real-world width at the highest-ranked plot scale for this page. */
  suggestedWidthMeters?: number
}

export interface PdfInspectResult {
  pageCount: number
  pages: PdfPage[]
  suggestedScales: PlotScale[]
  suggestedDpi: number
  maxDimensionPx: number
  hasThumbnails: boolean
  thumbnailPageCap: number
}

export interface PdfRenderResult {
  /** Relative `/files/<key>` URL of the stored PNG. */
  url: string
  mimeType: string
  naturalWidth: number
  naturalHeight: number
  bytes: number
  page: PdfPage
  requestedDpi: number
  /**
   * What was actually rendered. Large sheets get clamped down to fit the
   * GPU texture limit, so this is frequently below `requestedDpi` and
   * must be shown rather than assumed.
   */
  effectiveDpi: number
}

export function isPdfFile(file: File): boolean {
  return (
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  )
}

export async function inspectPdf(
  file: File,
  password?: string,
): Promise<PdfInspectResult> {
  const form = new FormData()
  form.append('file', file, file.name)
  if (password) form.append('password', password)
  return apiPost<PdfInspectResult>('/pdf/inspect', form)
}

export async function renderPdfPage(
  file: File,
  page: number,
  dpi?: number,
  password?: string,
): Promise<PdfRenderResult> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('page', String(page))
  if (dpi) form.append('dpi', String(dpi))
  if (password) form.append('password', password)
  return apiPost<PdfRenderResult>('/pdf/render', form)
}

/**
 * Real-world extent a page covers when plotted at the given scale.
 *
 * A PDF page is a physical sheet, so this is exact arithmetic rather
 * than a guess: millimetres on paper × the plot denominator = metres on
 * the ground. It's what lets the editor place a floor plan at its true
 * size instead of asking the user to drag until it looks right.
 */
export function realWorldSize(
  page: PdfPage,
  denominator: number,
): { widthMeters: number; heightMeters: number } {
  if (denominator <= 0) return { widthMeters: 0, heightMeters: 0 }
  return {
    widthMeters: (page.widthMm / 1000) * denominator,
    heightMeters: (page.heightMm / 1000) * denominator,
  }
}

/**
 * Inverse of {@link realWorldSize}: the plot scale implied by a known
 * real-world width. Backs the "I know this building is 45 m wide"
 * calibration path, for drawings whose title block is missing or wrong.
 */
export function scaleForRealWorldWidth(
  page: PdfPage,
  widthMeters: number,
): number {
  if (page.widthMm <= 0 || widthMeters <= 0) return 0
  return (widthMeters * 1000) / page.widthMm
}

/** Human-readable sheet summary, e.g. `ARCH D · 914 × 610 mm`. */
export function describeSheet(page: PdfPage): string {
  const dims = `${Math.round(page.widthMm)} × ${Math.round(page.heightMm)} mm`
  return page.sheet ? `${page.sheet} · ${dims}` : dims
}
