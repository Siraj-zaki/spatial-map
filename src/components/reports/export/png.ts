/**
 * PNG export for a chart or KPI widget, drawn at 2× (or 3×) on a canvas.
 *
 * Charts: the widget's Recharts <svg> is cloned with every computed
 * colour, font and opacity written onto the element (the live SVG uses
 * `hsl(var(--chart-1))`-style values that mean nothing outside the page),
 * serialised and drawn under the widget title. KPIs are drawn as text.
 * Light or dark background, independent of the app's current mode.
 */

const STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity', 'stop-color', 'stop-opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline'] as const

export interface PngOptions {
  scale: 2 | 3
  background: 'light' | 'dark'
}

function inlineStyles(source: SVGElement, clone: SVGElement) {
  const src = [source, ...source.querySelectorAll('*')] as Element[]
  const dst = [clone, ...clone.querySelectorAll('*')] as Element[]
  src.forEach((el, i) => {
    const target = dst[i]
    if (!target) return
    const cs = getComputedStyle(el)
    for (const p of STYLE_PROPS) {
      const v = cs.getPropertyValue(p)
      if (v && v !== 'normal' && v !== 'auto') target.setAttribute(p, v)
    }
    target.removeAttribute('class')
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image failed'))
    img.src = src
  })
}

function colors(bg: PngOptions['background']) {
  return bg === 'dark'
    ? { bg: '#09090b', fg: '#fafafa', muted: '#a1a1aa', border: '#27272a' }
    : { bg: '#ffffff', fg: '#09090b', muted: '#71717a', border: '#e4e4e7' }
}

function canvasFor(w: number, h: number, scale: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.scale(scale, scale)
  return { canvas, ctx }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'))
}

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", "Noto Sans SC", sans-serif'

/** The widget's chart as a PNG. `root` is the widget's container element. */
export async function chartToPng(root: HTMLElement, title: string, opts: PngOptions): Promise<Blob> {
  const svg = [...root.querySelectorAll('svg')].sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
  if (!svg) throw new Error('no chart')
  const rect = svg.getBoundingClientRect()
  const clone = svg.cloneNode(true) as SVGSVGElement
  inlineStyles(svg, clone)
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(rect.width))
  clone.setAttribute('height', String(rect.height))
  const c = colors(opts.background)
  // Axis/legend text drawn in the page's foreground colour would vanish on
  // the other background; recolour neutral text for the chosen one.
  clone.querySelectorAll('text, tspan').forEach((n) => n.setAttribute('fill', c.muted))
  clone.querySelectorAll('.recharts-cartesian-grid line, line[stroke-dasharray]').forEach((n) => n.setAttribute('stroke', c.border))
  const data = new XMLSerializer().serializeToString(clone)
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`)
  const pad = 24
  const titleH = title ? 34 : 0
  const w = rect.width + pad * 2
  const h = rect.height + pad * 2 + titleH
  const { canvas, ctx } = canvasFor(w, h, opts.scale)
  ctx.fillStyle = c.bg
  ctx.fillRect(0, 0, w, h)
  if (title) {
    ctx.fillStyle = c.fg
    ctx.font = `600 16px ${FONT}`
    ctx.textBaseline = 'top'
    ctx.fillText(title, pad, pad, w - pad * 2)
  }
  ctx.drawImage(img, pad, pad + titleH, rect.width, rect.height)
  return toBlob(canvas)
}

/** A KPI card as a PNG. */
export async function kpiToPng(title: string, value: string, delta: string | undefined, opts: PngOptions): Promise<Blob> {
  const c = colors(opts.background)
  const w = 360
  const h = delta ? 168 : 140
  const { canvas, ctx } = canvasFor(w, h, opts.scale)
  ctx.fillStyle = c.bg
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = c.border
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
  ctx.textBaseline = 'top'
  ctx.fillStyle = c.muted
  ctx.font = `500 14px ${FONT}`
  ctx.fillText(title, 24, 24, w - 48)
  ctx.fillStyle = c.fg
  ctx.font = `700 40px ${FONT}`
  ctx.fillText(value || '—', 24, 54, w - 48)
  if (delta) {
    ctx.fillStyle = delta.startsWith('-') ? '#dc2626' : '#16a34a'
    ctx.font = `600 14px ${FONT}`
    ctx.fillText(delta, 24, 116, w - 48)
  }
  return toBlob(canvas)
}
