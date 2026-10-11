import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Instant, styled tooltips for an icon rail. Attach `useRailTooltip()`'s
 * handlers to the rail container: hovering or focusing any button inside
 * shows its `aria-label` beside it (on the inline-end side, so RTL works),
 * with a trailing "(X)" rendered as a key cap. The button's native `title`
 * is removed on first hover — it showed after a second's delay and would
 * double up with this one.
 */
export function useRailTooltip() {
  const [tip, setTip] = useState<{ label: string; key?: string; x: number; y: number; end: boolean } | null>(null)
  const current = useRef<HTMLElement | null>(null)

  const show = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest?.('button,[role="button"]') as HTMLElement | null
    if (!el || el === current.current) return
    current.current = el
    if (el.hasAttribute('title')) {
      el.dataset.railTitle = el.getAttribute('title') ?? ''
      el.removeAttribute('title')
    }
    // Open flyouts/menus own that space.
    if (el.getAttribute('aria-expanded') === 'true') return setTip(null)
    const text = el.getAttribute('aria-label') || el.dataset.railTitle || ''
    if (!text) return setTip(null)
    const m = /^(.*?)\s*\(([^()]{1,12})\)$/.exec(text)
    const r = el.getBoundingClientRect()
    const rtl = getComputedStyle(el).direction === 'rtl'
    setTip({ label: m ? m[1] : text, key: m ? m[2] : undefined, x: rtl ? r.left - 8 : r.right + 8, y: r.top + r.height / 2, end: rtl })
  }
  const hide = () => {
    current.current = null
    setTip(null)
  }

  useEffect(() => {
    if (!tip) return
    const onScroll = () => hide()
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [tip])

  const handlers = {
    onPointerOver: (e: React.PointerEvent) => show(e.target),
    onPointerLeave: hide,
    onFocus: (e: React.FocusEvent) => show(e.target),
    onBlur: hide,
    onPointerDown: hide,
  }
  const node = tip
    ? createPortal(
        <div
          role="tooltip"
          className="sgv-fade pointer-events-none fixed z-50 flex -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={tip.end ? { top: tip.y, right: window.innerWidth - tip.x } : { top: tip.y, left: tip.x }}
        >
          <span>{tip.label}</span>
          {tip.key && (
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px] leading-4 text-muted-foreground">{tip.key}</kbd>
          )}
        </div>,
        document.body,
      )
    : null
  return { handlers, node }
}
