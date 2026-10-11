/**
 * Race-safe "when this map's style is ready, install my sources/layers"
 * helper. Replaces the boilerplate that every live-data overlay in this
 * repo had been duplicating: register a `style.load` listener, then
 * synchronously call `install()` if `isStyleLoaded()` is already true.
 *
 * That pattern misses a real race: if `style.load` fires BEFORE our
 * listener attaches (fast cold start, cached style, basemap whose
 * sprites preload), `isStyleLoaded()` can still return `false` for a
 * tick or two while the sprite/glyph download finishes. In that
 * window neither path runs — the listener catches the post-install
 * "idle" rather than `style.load`, and the synchronous check fails.
 * The overlay sits there forever showing nothing while its data is
 * happily polling in the background.
 *
 * This helper closes the race with a short poll fallback (every 100 ms
 * up to 5 s) that triggers install the moment `isStyleLoaded()` flips
 * true, regardless of which event the runtime emitted to get there.
 *
 * Usage:
 * ```
 * useEffect(() => {
 *   if (!map) return
 *   return whenStyleLoaded(map, () => {
 *     installSourcesAndLayers(map)
 *     pushFeatures(map, ...)
 *   }, '[map-asset]')
 * }, [map])
 * ```
 */

import type { Map as MapboxMapInstance } from 'mapbox-gl'

const POLL_INTERVAL_MS = 100
const POLL_TIMEOUT_MS = 5_000

/**
 * Run `install` as soon as the map's style is loaded, AND every time
 * the style is swapped (via `setStyle`) thereafter. Returns a cleanup
 * function that detaches the listener and stops any in-flight poll.
 *
 * The `tag` parameter is prepended to console diagnostics so a session
 * with several live overlays mounted can be triaged in one console
 * scrub (`[map-asset] …` vs `[map-sensor] …`).
 */
export function whenStyleLoaded(
  map: MapboxMapInstance,
  install: () => void,
  tag: string,
): () => void {
  let pollId: number | null = null
  let cancelled = false

  const safeInstall = (reason: string) => {
    if (cancelled) return
    console.log(`${tag} installing (${reason})`)
    try {
      install()
    } catch (err) {
      console.error(`${tag} install threw`, err)
    }
  }

  if (map.isStyleLoaded()) {
    safeInstall('style already loaded')
  } else {
    // Listener catches the normal case; poll catches the race where the
    // style finished loading before this listener attached.
    let attempts = 0
    pollId = window.setInterval(() => {
      attempts++
      if (cancelled) return
      if (map.isStyleLoaded()) {
        console.log(`${tag} style ready via poll`, { attempts })
        if (pollId !== null) {
          window.clearInterval(pollId)
          pollId = null
        }
        safeInstall('poll caught style load')
      } else if (attempts * POLL_INTERVAL_MS >= POLL_TIMEOUT_MS) {
        console.warn(`${tag} gave up polling for style load after ${POLL_TIMEOUT_MS / 1000}s`)
        if (pollId !== null) {
          window.clearInterval(pollId)
          pollId = null
        }
      }
    }, POLL_INTERVAL_MS)
  }

  const onStyleLoad = () => {
    if (cancelled) return
    safeInstall('style.load event')
  }
  map.on('style.load', onStyleLoad)

  return () => {
    cancelled = true
    map.off('style.load', onStyleLoad)
    if (pollId !== null) {
      window.clearInterval(pollId)
      pollId = null
    }
  }
}
