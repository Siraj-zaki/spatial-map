/**
 * Wayfinding icons for lifts (escalator up / down, elevator), painted on
 * a canvas in the palette's primary colours and registered as map
 * images — the same approach as the transform handles
 * (map-transform-handles.ts), so they follow light/dark and palettes.
 *
 * Out-of-service variants are greyed with a diagonal strike.
 */

import type { Map as MapboxMapInstance } from 'mapbox-gl'

export type LiftIconKind = 'escalator-up' | 'escalator-down' | 'elevator'

export const LIFT_ICON_KINDS: readonly LiftIconKind[] = ['escalator-up', 'escalator-down', 'elevator']

/** Map image id for an icon. */
export function liftIconId(kind: LiftIconKind, outOfService: boolean): string {
  return `sgv-lift-${kind}${outOfService ? '-oos' : ''}`
}

const SIZE = 30 // CSS px
const RATIO = 2

function paint(kind: LiftIconKind, outOfService: boolean, bg: string, fg: string): ImageData | null {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE * RATIO
  canvas.height = SIZE * RATIO
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(RATIO, RATIO)
  ctx.globalAlpha = outOfService ? 0.5 : 1
  // Rounded badge.
  const r = 6
  ctx.fillStyle = bg
  ctx.beginPath()
  ctx.moveTo(r + 1, 1)
  ctx.arcTo(SIZE - 1, 1, SIZE - 1, SIZE - 1, r)
  ctx.arcTo(SIZE - 1, SIZE - 1, 1, SIZE - 1, r)
  ctx.arcTo(1, SIZE - 1, 1, 1, r)
  ctx.arcTo(1, 1, SIZE - 1, 1, r)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = fg
  ctx.fillStyle = fg
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (kind === 'elevator') {
    // Classic lift symbol: ▲ over ▼.
    ctx.beginPath()
    ctx.moveTo(15, 6)
    ctx.lineTo(21, 13)
    ctx.lineTo(9, 13)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(15, 24)
    ctx.lineTo(21, 17)
    ctx.lineTo(9, 17)
    ctx.closePath()
    ctx.fill()
  } else {
    // Escalator profile: flat, incline, flat — rising left to right.
    ctx.beginPath()
    ctx.moveTo(5, 22)
    ctx.lineTo(10, 22)
    ctx.lineTo(19, 11)
    ctx.lineTo(25, 11)
    ctx.stroke()
    // Direction arrow along the incline.
    const up = kind === 'escalator-up'
    const [tx, ty] = up ? [19, 15] : [10, 18]
    const dx = up ? 1 : -1
    ctx.beginPath()
    ctx.moveTo(tx + dx * 2, ty - dx * 2.4)
    ctx.lineTo(tx - dx * 2.6, ty - dx * 0.2)
    ctx.lineTo(tx + dx * 0.6, ty + dx * 2.6)
    ctx.closePath()
    ctx.fill()
  }
  if (outOfService) {
    ctx.globalAlpha = 1
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(5, 25)
    ctx.lineTo(25, 5)
    ctx.stroke()
  }
  return ctx.getImageData(0, 0, SIZE * RATIO, SIZE * RATIO)
}

/** Register (or repaint) every lift icon in the given colours. */
export function registerLiftIcons(map: MapboxMapInstance, bg: string, fg: string): void {
  for (const kind of LIFT_ICON_KINDS) {
    for (const oos of [false, true]) {
      const data = paint(kind, oos, bg, fg)
      if (!data) continue
      const id = liftIconId(kind, oos)
      try {
        if (map.hasImage(id)) map.updateImage(id, data)
        else map.addImage(id, data, { pixelRatio: RATIO })
      } catch {
        // style mid-swap; the next style.load re-registers
      }
    }
  }
}
