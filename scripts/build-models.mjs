#!/usr/bin/env node
/**
 * Bundled-asset build pipeline: convert every `public/models/<slug>/scene.gltf`
 * (multi-file Sketchfab-style pack with `scene.bin` + `textures/`) into a
 * single self-contained `public/models/<slug>/scene.glb`.
 *
 * Why we need this — Mapbox's native `model` layer only reliably loads
 * single-file `.glb` assets (embedded buffer + textures). It does *not*
 * resolve external `.bin` / `textures/*` URIs from a multi-file `.gltf`
 * pack consistently across styles, and even when it does, its strict
 * runtime asserts trip on the cruft (dangling accessors / over-sized
 * buffer views) that authoring tools commonly leave behind.
 *
 * Why `gltf-pipeline` (not `@gltf-transform`):
 *   We first tried `@gltf-transform/core` + prune/dedup/weld. That
 *   produces a structurally valid GLB but Mapbox's loader still
 *   rejected every output with "offset is out of bounds". The cause is
 *   subtle: @gltf-transform deduplicates and re-shares buffer views in
 *   ways that, while spec-compliant, lay out the BIN chunk differently
 *   from what Mapbox's strict offset arithmetic expects.
 *   `gltf-pipeline` (CesiumGS) is the same library used by Cesium's
 *   3D Tiles and is known-good against both Cesium and Mapbox model
 *   loaders. It produces a flat, conservatively-laid-out BIN chunk
 *   with strict 4-byte alignment per buffer view — which is what
 *   Mapbox actually parses.
 *
 * The script:
 *   - Walks `public/models/*`
 *   - For each directory with `scene.gltf`, hands the JSON + the
 *     directory (as `resourceDirectory`) to `gltf-pipeline.gltfToGlb`
 *     so it can resolve `scene.bin` + `textures/*` references off disk
 *   - Writes `scene.glb` next to the source
 *   - Skips when `scene.glb` is newer than `scene.gltf` (idempotent) —
 *     pass `--force` to ignore the timestamp check
 *
 * Run with `npm run models:build`. Wired into `npm run build`.
 *
 * Safe to delete the resulting `.glb` and re-run; safe to commit them.
 */

import gltfPipeline from 'gltf-pipeline'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { gltfToGlb } = gltfPipeline

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const MODELS_DIR = join(PROJECT_ROOT, 'public', 'models')

const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force') || args.has('-f')

/** Format bytes as a short human-readable string. */
function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** Is `a` strictly newer than `b` on disk? Both must exist. */
function isNewer(a, b) {
  try {
    return statSync(a).mtimeMs > statSync(b).mtimeMs
  } catch {
    return false
  }
}

let dirs
try {
  dirs = readdirSync(MODELS_DIR)
} catch {
  console.warn(`[build-models] ${MODELS_DIR} not found — nothing to do.`)
  process.exit(0)
}

let converted = 0
let skipped = 0
let failed = 0

for (const name of dirs) {
  const dirPath = join(MODELS_DIR, name)
  let stat
  try {
    stat = statSync(dirPath)
  } catch {
    continue
  }
  if (!stat.isDirectory()) continue

  const gltfPath = join(dirPath, 'scene.gltf')
  const glbPath = join(dirPath, 'scene.glb')

  let gltfStat
  try {
    gltfStat = statSync(gltfPath)
  } catch {
    continue // no source pack here
  }

  let glbStat
  try {
    glbStat = statSync(glbPath)
  } catch {
    glbStat = null
  }

  if (!FORCE && glbStat && !isNewer(gltfPath, glbPath)) {
    console.log(`· ${name}/scene.glb is up to date (${fmtBytes(glbStat.size)})`)
    skipped++
    continue
  }

  try {
    const gltfJson = JSON.parse(readFileSync(gltfPath, 'utf8'))
    // `resourceDirectory` lets gltf-pipeline resolve relative URIs like
    // "scene.bin" and "textures/*.jpeg" against the model's folder.
    // Without it, the tool would only handle data-URI-embedded resources
    // and would fail to embed anything from disk.
    const { glb } = await gltfToGlb(gltfJson, {
      resourceDirectory: dirPath,
    })
    writeFileSync(glbPath, glb)
    const out = statSync(glbPath)
    console.log(
      `✓ ${name}/scene.glb  ${fmtBytes(gltfStat.size)} (gltf) → ${fmtBytes(out.size)} (glb)`,
    )
    converted++
  } catch (err) {
    console.error(`✗ ${name}: ${err.message ?? err}`)
    failed++
  }
}

console.log(
  `\nbuild-models: ${converted} converted, ${skipped} up to date, ${failed} failed`,
)
process.exit(failed > 0 ? 1 : 0)
