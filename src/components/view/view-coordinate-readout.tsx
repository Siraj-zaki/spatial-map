import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface ViewCoordinateReadoutProps {
  /** Map center as `[lng, lat]`. `null` while the map is initializing. */
  center: [number, number] | null
  zoom: number
  pitch: number
  bearing: number
}

/**
 * Bottom-left readout of the camera position. Click to copy the
 * lng,lat,zoom triple to the clipboard so the user can hand a deep-link
 * to a teammate without futzing with the URL bar.
 */
export function ViewCoordinateReadout({
  center,
  zoom,
  pitch,
  bearing,
}: ViewCoordinateReadoutProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  if (!center) return null

  const text = `${center[1].toFixed(5)}, ${center[0].toFixed(5)} · z${zoom.toFixed(2)}`

  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={t('view.coords.copy', { defaultValue: 'Copy coordinates' })}
      aria-label={t('view.coords.copy', { defaultValue: 'Copy coordinates' })}
      className="fixed bottom-3 left-[245px] z-20 flex items-center gap-1.5 h-7 px-2.5 rounded-md border bg-card/95 backdrop-blur shadow-sm text-[10px] font-mono tabular-nums text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
    >
      <span>{text}</span>
      {(pitch > 0 || bearing !== 0) && (
        <span className="opacity-70">
          · {pitch.toFixed(0)}° / {bearing.toFixed(0)}°
        </span>
      )}
      {copied ? (
        <Check className="w-3 h-3 text-green-500" />
      ) : (
        <Copy className="w-3 h-3 opacity-60" />
      )}
    </button>
  )
}
