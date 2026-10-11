import type { Map as MapboxMapInstance, LngLatLike } from 'mapbox-gl'

/**
 * Sidebar-list "select" handlers face a UX gap: setting the selection
 * updates the sidebar mode, but the user is often looking at a different
 * location or is zoomed out — so the sidebar switches to an editor for a
 * shape they can't see. Every per-kind handler (marker, circle, line,
 * polygon, image, grid, model, stair, text-label, door, image-plane) has
 * the same shape of bug.
 *
 * This helper takes the shape's axis-aligned bbox in lng/lat and:
 *   • skips the fit entirely if the shape has no bbox (e.g. an empty
 *     polyline) or the caller passed `additive=true` (shift-multi-select
 *     shouldn't yank the camera per click).
 *   • skips the fit if any bbox corner is already inside the map's
 *     viewport — the user is already looking at the shape.
 *   • otherwise calls `fitBounds` with a small padding so the shape lands
 *     roughly centered with breathing room.
 *
 * Point-shaped shapes (marker, model, text-label) collapse the bbox to a
 * single lng/lat; callers should pass the point as `[lng, lat, lng, lat]`
 * — the "any corner visible" test still fires as an inside-viewport check.
 */
export function fitBoundsIfOffscreen(
  map: MapboxMapInstance | null,
  bbox: readonly [number, number, number, number] | null,
  options?: { additive?: boolean; padding?: number; targetZoom?: number },
): void {
  if (!map || !bbox) return
  if (options?.additive) return
  const [w, s, e, n] = bbox
  if (
    !Number.isFinite(w) ||
    !Number.isFinite(s) ||
    !Number.isFinite(e) ||
    !Number.isFinite(n)
  )
    return
  const bounds = map.getBounds()
  if (bounds) {
    const bw = bounds.getWest()
    const bs = bounds.getSouth()
    const be = bounds.getEast()
    const bn = bounds.getNorth()
    const cornerVisible = (lng: number, lat: number) =>
      lng >= bw && lng <= be && lat >= bs && lat <= bn
    const anyCornerVisible =
      cornerVisible(w, s) ||
      cornerVisible(w, n) ||
      cornerVisible(e, s) ||
      cornerVisible(e, n)
    // At globe-level zoom the whole warehouse bbox may sit inside the
    // viewport but project to a sub-pixel dot, so "corner visible" is
    // technically true while the shape is invisible on screen. Force a
    // re-fit when the projected bbox is smaller than a hand target.
    const MIN_ON_SCREEN_PX = 40
    const sw = map.project([w, s])
    const ne = map.project([e, n])
    const onScreenPx = Math.max(Math.abs(ne.x - sw.x), Math.abs(sw.y - ne.y))
    if (anyCornerVisible && onScreenPx >= MIN_ON_SCREEN_PX) return
  }
  // A zero-size bbox is a point — flyTo instead of fitBounds since Mapbox
  // refuses to fit a zero-area rectangle. Use targetZoom so we don't zoom
  // into a marker at zoom 22 when the current zoom would work.
  const isPoint = w === e && s === n
  if (isPoint) {
    map.flyTo({
      center: [w, s] as LngLatLike,
      zoom: options?.targetZoom ?? Math.max(map.getZoom(), 16),
      essential: true,
    })
  } else {
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: options?.padding ?? 60, essential: true },
    )
  }
}
