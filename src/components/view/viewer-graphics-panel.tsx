/**
 * ViewerGraphicsPanel — the same graphics-quality toggles the editor's
 * side-panel exposes (`GraphicsSection` in `side-panel.tsx`), surfaced
 * as a glassy pill in the viewer's top-right stack. Reads and writes
 * the shared `useGraphicsSettings` Zustand store, so a preference set
 * in one place applies to both editor and viewer — and the
 * `persist` middleware carries it across reloads via localStorage.
 *
 * Deliberately doesn't re-implement the toggles' behaviour — every
 * downstream effect (shadow pass, AO, marker/text-label occlusion)
 * already reads the same store. This component is UI-only.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useGraphicsSettings } from '@/lib/graphics-settings'

export function ViewerGraphicsPanel() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const shadows = useGraphicsSettings((s) => s.shadows)
  const ambientOcclusion = useGraphicsSettings((s) => s.ambientOcclusion)
  const markerOcclusion = useGraphicsSettings((s) => s.markerOcclusion)
  const setShadows = useGraphicsSettings((s) => s.setShadows)
  const setAmbientOcclusion = useGraphicsSettings((s) => s.setAmbientOcclusion)
  const setMarkerOcclusion = useGraphicsSettings((s) => s.setMarkerOcclusion)

  const enabledCount = [shadows, ambientOcclusion, markerOcclusion].filter(Boolean).length

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title={
          t('view.graphicsTitle', { defaultValue: 'Graphics quality' }) as string
        }
        className="h-9 gap-2 rounded-full border-border/60 bg-background/70 pl-3 pr-3 shadow-lg shadow-black/5 backdrop-blur-xl hover:bg-background/90"
      >
        <Sparkles
          className={
            'h-3.5 w-3.5 ' +
            (enabledCount > 0 ? 'text-primary' : 'text-muted-foreground')
          }
        />
        <span className="text-xs font-medium">
          {t('view.graphicsButton', { defaultValue: 'Quality' })}
        </span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[92vw] max-w-md p-0 gap-0 overflow-hidden flex flex-col" aria-describedby={undefined}>
          <div className="border-b px-5 py-4 shrink-0">
            <DialogTitle className="text-sm font-semibold flex items-center gap-2">
              <Sparkles size={14} className="text-primary" />
              {t('view.graphicsTitle', { defaultValue: 'Graphics quality' })}
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {t('view.graphicsSubtitle', {
                defaultValue:
                  'Toggles that trade GPU cost for visual richness. Saved to this browser.',
              })}
            </p>
          </div>

          <div className="px-5 py-4 grid gap-4">
            <ToggleRow
              label={t('view.graphicsShadows', { defaultValue: '3D shadows' })}
              hint={t('view.graphicsShadowsHint', {
                defaultValue: 'Realistic wall & rack shadows. Higher GPU cost.',
              })}
              checked={shadows}
              onChange={setShadows}
            />
            <ToggleRow
              label={t('view.graphicsAO', { defaultValue: 'Ambient occlusion' })}
              hint={t('view.graphicsAOHint', {
                defaultValue: 'Soft shading in corners. Screen-space GPU pass.',
              })}
              checked={ambientOcclusion}
              onChange={setAmbientOcclusion}
            />
            <ToggleRow
              label={t('view.graphicsMarkerOcclusion', {
                defaultValue: 'Hide items under floors',
              })}
              hint={t('view.graphicsMarkerOcclusionHint', {
                defaultValue:
                  'Markers, sensors and labels behind a floor plan are hidden, matching real 3D geometry.',
              })}
              checked={markerOcclusion}
              onChange={setMarkerOcclusion}
            />
          </div>

          <div className="border-t px-5 py-2.5 shrink-0 flex items-center justify-end gap-2 bg-background">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
            >
              {t('view.graphicsClose', { defaultValue: 'Done' })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium">{label}</div>
        <div className="text-[10px] text-muted-foreground leading-tight">
          {hint}
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}
