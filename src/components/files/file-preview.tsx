/**
 * What a stored file looks like: an <img> for images, Google's
 * <model-viewer> for GLB/GLTF, an icon otherwise. `FileThumb` fills a
 * positioned box on cards and list rows; `FilePreview` is the large,
 * interactive version in the detail panel.
 *
 * Images use `object-contain` (never cover): logos and portrait plans
 * must show intact — cropping turned "COSTA COFFEE" into "COSTA".
 */

import '@google/model-viewer'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Box, File as FileIcon, ImageOff, TriangleAlert } from 'lucide-react'
import type { FileCard } from '@/lib/files-client'
import { cn } from '@/lib/utils'
import { isImage, isModel } from './file-helpers'

/** Checkerboard behind images so transparent PNGs read as transparent. */
const CHECKER: React.CSSProperties = {
  backgroundImage: 'repeating-conic-gradient(hsl(var(--muted)) 0% 25%, hsl(var(--background)) 0% 50%)',
  backgroundSize: '16px 16px',
}

function Placeholder({ icon: Icon, label, className }: { icon: typeof Box; label?: string; className?: string }) {
  return (
    <div className={cn('absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground', className)}>
      <Icon className="h-7 w-7 opacity-60" aria-hidden />
      {label && <span className="px-4 text-center text-xs">{label}</span>}
    </div>
  )
}

/**
 * <model-viewer> with a placeholder underneath that steps aside once the
 * model has painted (the canvas is transparent, so a label behind it
 * would otherwise show through), and an error state if the GLB fails.
 */
function ModelView({ src, alt, interactive, className, loadingLabel, errorLabel }: { src: string; alt: string; interactive?: boolean; className?: string; loadingLabel?: string; errorLabel?: string }) {
  const ref = useRef<HTMLElement>(null)
  const [state, setState] = useState<{ src: string; status: 'loaded' | 'error' } | null>(null)
  const status = state?.src === src ? state.status : 'loading'
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onLoad = () => setState({ src, status: 'loaded' })
    const onError = () => setState({ src, status: 'error' })
    el.addEventListener('load', onLoad)
    el.addEventListener('error', onError)
    return () => {
      el.removeEventListener('load', onLoad)
      el.removeEventListener('error', onError)
    }
  }, [src])
  return (
    <>
      {status === 'loading' && <Placeholder icon={Box} label={loadingLabel} className={className} />}
      {status === 'error' && <Placeholder icon={ImageOff} label={errorLabel} className={className} />}
      <model-viewer
        ref={ref}
        src={src}
        alt={alt}
        reveal="auto"
        loading={interactive ? 'eager' : 'lazy'}
        interaction-prompt="none"
        {...(interactive ? { 'camera-controls': true, 'auto-rotate': true, 'shadow-intensity': '0.6', exposure: '0.9' } : { 'disable-zoom': true })}
        class={cn('absolute inset-0 h-full w-full', status === 'error' && 'invisible', className)}
        style={{ backgroundColor: 'transparent', pointerEvents: interactive ? undefined : 'none', ['--poster-color' as string]: 'transparent' }}
      >
        {/* Empty slot hides model-viewer's built-in loading bar. */}
        <div slot="progress-bar" />
      </model-viewer>
    </>
  )
}

export function FileThumb({ file, className }: { file: FileCard; className?: string }) {
  const [broken, setBroken] = useState(false)
  if (file.category === 'missing') return <Placeholder icon={TriangleAlert} className={cn('text-danger', className)} />
  if (isImage(file)) {
    if (broken) return <Placeholder icon={ImageOff} className={className} />
    return (
      <img
        src={file.url}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className={cn('absolute inset-0 h-full w-full object-contain p-2', className)}
      />
    )
  }
  if (isModel(file)) return <ModelView src={file.url} alt="" className={className} />
  return <Placeholder icon={FileIcon} className={className} />
}

export function FilePreview({
  file,
  onDimensions,
}: {
  file: FileCard
  onDimensions?: (w: number, h: number) => void
}) {
  const { t } = useTranslation()
  const [broken, setBroken] = useState(false)

  let body: React.ReactNode
  if (file.category === 'missing') {
    body = (
      <Placeholder
        icon={TriangleAlert}
        className="text-danger"
        label={t('files.viewer.missing', { defaultValue: 'This file is no longer in storage.' })}
      />
    )
  } else if (isImage(file)) {
    body = broken ? (
      <Placeholder icon={ImageOff} label={t('files.viewer.broken', { defaultValue: 'The image couldn’t be loaded.' })} />
    ) : (
      <img
        src={file.url}
        alt={t('files.viewer.alt', { defaultValue: 'Preview of {{name}}', name: file.key })}
        onLoad={(e) => onDimensions?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
        onError={() => setBroken(true)}
        className="absolute inset-0 h-full w-full object-contain p-3"
      />
    )
  } else if (isModel(file)) {
    body = (
      <ModelView
        interactive
        src={file.url}
        alt={t('files.viewer.alt', { defaultValue: 'Preview of {{name}}', name: file.key })}
        loadingLabel={t('files.viewer.loadingModel', { defaultValue: 'Loading 3D model…' })}
        errorLabel={t('files.viewer.brokenModel', { defaultValue: 'The 3D model couldn’t be loaded.' })}
      />
    )
  } else {
    body = <Placeholder icon={FileIcon} label={t('files.viewer.none', { defaultValue: 'No preview for this file type.' })} />
  }

  return (
    <div
      className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border"
      style={isImage(file) && file.category !== 'missing' ? CHECKER : undefined}
    >
      {!isImage(file) && <div className="absolute inset-0 bg-muted/40" aria-hidden />}
      {body}
    </div>
  )
}
