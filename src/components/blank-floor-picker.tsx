/**
 * "Blank" source of the floor-plan tool: a plain sheet instead of an
 * uploaded drawing, for a floor that has no plan (a new level, a
 * mezzanine you draw yourself). It is a real floor plan afterwards — it
 * shows in the Floor plans list and the "Default floor plan" picker, new
 * shapes link to it, stairs / lifts / escalators can serve it — because
 * it goes through the same upload + drag-to-place path as any picture.
 *
 * The sheet is a small PNG made here (transparent, white, light grey,
 * black or a custom colour); the map stretches it to whatever rectangle
 * the user drags. A transparent sheet stays clickable — the floor-plan
 * hit area is the placed rectangle, not the pixels.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Pipette } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Sheet colours. These are the picture's own pixels (chosen by the user),
 *  not interface styling — hence plain values rather than theme tokens. */
const PRESETS = [
  { id: 'transparent', color: null },
  { id: 'white', color: '#ffffff' },
  { id: 'grey', color: '#e5e7eb' },
  { id: 'black', color: '#111111' },
] as const

type PresetId = (typeof PRESETS)[number]['id'] | 'custom'

const SHEET_PX = 256

/** A SHEET_PX square PNG: one colour, or fully transparent. */
async function sheetFile(color: string | null, name: string): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = SHEET_PX
  canvas.height = SHEET_PX
  const ctx = canvas.getContext('2d')
  if (ctx && color) {
    ctx.fillStyle = color
    ctx.fillRect(0, 0, SHEET_PX, SHEET_PX)
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('could not create the sheet')
  return new File([blob], `${name}.png`, { type: 'image/png' })
}

/** Checkerboard that reads as "transparent", drawn with theme tokens. */
const CHECKER: React.CSSProperties = {
  backgroundColor: 'hsl(var(--background))',
  backgroundImage:
    'linear-gradient(45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--muted)) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--muted)) 75%)',
  backgroundSize: '10px 10px',
  backgroundPosition: '0 0, 0 5px, 5px -5px, -5px 0',
}

export function BlankFloorPicker({ onPick }: { onPick?: (file: File) => void }) {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<PresetId>('white')
  const [custom, setCustom] = useState('#dbeafe')
  const [busy, setBusy] = useState(false)

  const color = choice === 'custom' ? custom : (PRESETS.find((p) => p.id === choice)?.color ?? null)

  const use = async () => {
    if (!onPick) return
    setBusy(true)
    try {
      onPick(await sheetFile(color, t('blankFloor.fileName')))
    } finally {
      setBusy(false)
    }
  }

  const swatch = (id: PresetId, style: React.CSSProperties, label: string) => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={choice === id}
      onClick={() => setChoice(id)}
      className={cn(
        'flex flex-col items-center gap-1 rounded-md border p-1.5 text-[11px] transition-colors',
        choice === id ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:bg-muted/50',
      )}
    >
      <span className="relative h-9 w-full rounded-sm border border-border" style={style}>
        {choice === id && (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-2.5 w-2.5" />
          </span>
        )}
      </span>
      <span className="truncate">{label}</span>
    </button>
  )

  return (
    <div className="space-y-2.5">
      <p className="text-[11px] leading-snug text-muted-foreground">{t('blankFloor.hint')}</p>
      <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t('blankFloor.colour')}>
        {PRESETS.map((p) =>
          swatch(p.id, p.color ? { backgroundColor: p.color } : CHECKER, t(`blankFloor.${p.id}`)),
        )}
        {swatch('custom', { backgroundColor: custom }, t('blankFloor.custom'))}
      </div>
      {choice === 'custom' && (
        <label className="flex items-center gap-2 text-xs">
          <Pipette className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="flex-1 text-muted-foreground">{t('blankFloor.pickColour')}</span>
          <input
            type="color"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="h-7 w-10 cursor-pointer rounded border border-border bg-background p-0.5"
            aria-label={t('blankFloor.pickColour')}
          />
        </label>
      )}
      <Button size="sm" className="w-full" disabled={busy || !onPick} onClick={() => void use()}>
        {t('blankFloor.use')}
      </Button>
    </div>
  )
}
