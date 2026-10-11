#!/usr/bin/env node
// Pre-renders a preview for every built-in 3D model (BUNDLED_MODELS in
// src/lib/model-catalog.ts) into public/models/thumbs/<id>.webp, using the
// same in-browser renderer the app uses for uploads
// (renderModelThumbnail in src/lib/upload-library.ts).
//
// Needs the Vite dev server running (npm run dev). Re-run after adding a
// bundled model:
//   node scripts/generate-model-thumbnails.mjs [http://localhost:5173] [--force]
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'public/models/thumbs')
const origin = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5173'
const force = process.argv.includes('--force')
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu'] })
const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
await page.goto(origin)
const models = await page.evaluate(async () => {
  const { BUNDLED_MODELS } = await import('/src/lib/model-catalog.ts')
  return BUNDLED_MODELS.map((m) => ({ id: m.id, url: m.url, orientation: m.previewOrientation }))
})

let made = 0
let failed = 0
for (const m of models) {
  const file = path.join(outDir, `${m.id}.webp`)
  if (!force && fs.existsSync(file)) continue
  const dataUrl = await page.evaluate(async ([url, orientation]) => {
    const { renderModelThumbnail } = await import('/src/lib/upload-library.ts')
    return renderModelThumbnail(url, orientation)
  }, [m.url, m.orientation])
  if (!dataUrl) {
    failed++
    console.warn(`✗ ${m.id} (${m.url})`)
    continue
  }
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))
  made++
  console.log(`✓ ${m.id}`)
}
console.log(`${made} rendered, ${failed} failed, ${models.length} built-in models`)
await browser.close()
