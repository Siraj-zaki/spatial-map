/**
 * Compact 3D GLB preview using Google's `<model-viewer>` web component.
 *
 * Rendered in the model-editor side panel so users can see the model
 * even when the on-map render fails or is out-of-view. Also a critical
 * diagnostic tool: a preview that loads means the GLB is valid and
 * reachable; a preview that fails to load points squarely at either
 * the URL (rewrite / proxy) or the file itself.
 *
 * `<model-viewer>` is a custom element — it renders on any browser that
 * supports Custom Elements v1 (all evergreen browsers). Registering
 * the element is a side effect of importing the package, so the
 * `import` below is intentionally not-tree-shaken (side-effect import).
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import '@google/model-viewer'

import { useEffect, useRef, useState } from 'react'
import { rewriteFilesUrlSameOrigin } from '@/lib/binary-store'

interface ModelPreviewProps {
  /** Absolute or `/files/`-relative GLB URL. */
  url: string | undefined | null
  /** Optional heading — shown above the canvas. */
  label?: string
  /** CSS height; defaults to 160 px. */
  heightPx?: number
  /** `<model-viewer>` orientation (see `ModelAsset.previewOrientation`). */
  orientation?: string
}

// TypeScript doesn't know about the custom element by default. Declare
// the JSX intrinsic so `<model-viewer …>` type-checks. Kept minimal
// (we only use a handful of attributes here); extend as needed.
// eslint-disable-next-line @typescript-eslint/no-namespace
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'model-viewer': any
    }
  }
}

export function ModelPreview({ url, label, heightPx = 160, orientation }: ModelPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Rewrite `http://<some-host>/files/...` legacy URLs to `/files/...`
  // so the browser fetches through the SPA's origin. The overlay does
  // this too — mirror the pattern here so a broken map render and a
  // successful preview don't diverge because of URL differences.
  const src = url ? rewriteFilesUrlSameOrigin(url) : null

  // Reset load/error state when the URL changes. The eslint rule
  // `react-hooks/set-state-in-effect` normally flags this as it can
  // cause cascading renders, but here it's exactly the intended
  // pattern — reset external-derived UI state when the input URL
  // changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoaded(false)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null)
  }, [src])

  // Wire load / error listeners on the underlying custom element.
  useEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current.querySelector('model-viewer')
    if (!el) return
    const onLoad = () => setLoaded(true)
    const onError = (e: Event) => {
      const detail = (e as CustomEvent<{ type: string; sourceError?: unknown }>).detail
      setError(
        detail?.type
          ? `${detail.type}: failed to load model`
          : 'failed to load model',
      )
    }
    el.addEventListener('load', onLoad)
    el.addEventListener('error', onError)
    return () => {
      el.removeEventListener('load', onLoad)
      el.removeEventListener('error', onError)
    }
  }, [src])

  if (!src) {
    return (
      <div
        className="rounded-md border bg-muted/20 flex items-center justify-center text-[10px] text-muted-foreground"
        style={{ height: heightPx }}
      >
        no asset selected
      </div>
    )
  }

  return (
    <div className="space-y-1.5" ref={containerRef}>
      {label && (
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
      )}
      <div
        className="relative rounded-md border bg-muted/10 overflow-hidden"
        style={{ height: heightPx }}
      >
        {/* Custom element registered by the module-level import above. */}
        <model-viewer
          src={src}
          orientation={orientation}
          alt="3D model preview"
          camera-controls
          auto-rotate
          rotation-per-second="20deg"
          exposure="0.9"
          shadow-intensity="0.35"
          style={{
            width: '100%',
            height: '100%',
            backgroundColor: 'transparent',
          }}
        />
        {!loaded && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground pointer-events-none">
            loading…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-destructive/10 text-[10px] text-destructive px-2 text-center">
            {error}
          </div>
        )}
      </div>
      <div className="text-[9px] text-muted-foreground truncate" title={src}>
        {src}
      </div>
    </div>
  )
}
