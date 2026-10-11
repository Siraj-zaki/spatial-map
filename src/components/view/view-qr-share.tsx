import { QrCode, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'

interface ViewQrShareProps {
  /** True when the QR dialog is open. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Optional URL to encode; defaults to `window.location.href` so the
   * caller can pass a forced deep link if needed. */
  url?: string
}

/**
 * Renders a QR code of the current URL so a kiosk → phone hand-off
 * works: the visitor scans the on-screen QR to continue the same view
 * on their device. Both `MapsIndoors` and `ArcGIS Indoor Viewer`
 * surface this as a first-class kiosk feature.
 */
export function ViewQrShare({ open, onOpenChange, url }: ViewQrShareProps) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [encoded, setEncoded] = useState<string | null>(null)

  // Recompute the QR whenever the dialog opens. We render into both a
  // canvas (crisp for any DPR) and a data URL fallback so the dialog
  // never blanks during the initial paint.
  useEffect(() => {
    if (!open) return
    const text = url ?? window.location.href
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEncoded(text)
    const canvas = canvasRef.current
    if (!canvas) return
    void QRCode.toCanvas(canvas, text, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
    }).catch((err) => {
      console.warn('[ViewQrShare] failed to render QR', err)
    })
  }, [open, url])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
      role="presentation"
    >
      <div
        className="bg-card border rounded-xl shadow-2xl p-5 max-w-xs w-full flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-1.5">
            <QrCode className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold">
              {t('view.qr.title', { defaultValue: 'Continue on your phone' })}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={t('view.qr.close', { defaultValue: 'Close' })}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-2 bg-white rounded-lg">
          <canvas ref={canvasRef} className="block" />
        </div>
        {encoded && (
          <code className="text-[10px] text-muted-foreground break-all text-center max-w-full">
            {encoded.length > 70 ? `${encoded.slice(0, 70)}…` : encoded}
          </code>
        )}
        <span className="text-[11px] text-muted-foreground text-center">
          {t('view.qr.hint', {
            defaultValue: 'Scan with your phone camera to open this exact view.',
          })}
        </span>
      </div>
    </div>
  )
}
