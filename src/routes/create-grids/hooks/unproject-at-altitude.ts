import mapboxgl, { type Map as MapboxMapInstance } from 'mapbox-gl'

/**
 * Ray-cast the click's screen point against a horizontal plane at
 * `altitudeMeters` (world-relative) and return the lng/lat where the
 * intersection lands. Mapbox's built-in `map.unproject` / the
 * `MapMouseEvent.lngLat` always hit the ground plane (z = 0), so
 * clicking on top of an elevated floor plan gives back the lng/lat of
 * the ground point *under* the raster — which then drifts visibly from
 * the click when we render the vertex dot lifted to `elevation`
 * (parallax at pitch). Casting against the elevated plane instead
 * makes the click land on the point of the raster the user was
 * actually pointing at, and the rendered dot ends up exactly under
 * the cursor.
 *
 * Falls back to the ground unproject when altitude is 0 or the free
 * camera isn't available (very old GL runtimes) — that path is the
 * pre-fix behaviour and keeps normal ground-level drawing untouched.
 */
export function unprojectAtAltitude(
  map: MapboxMapInstance,
  point: { x: number; y: number },
  altitudeMeters: number,
): { lng: number; lat: number } {
  if (!(altitudeMeters > 0)) {
    const ll = map.unproject(point as mapboxgl.PointLike)
    return { lng: ll.lng, lat: ll.lat }
  }
  const groundLL = map.unproject(point as mapboxgl.PointLike)
  const cameraOpts = (
    map as unknown as {
      getFreeCameraOptions?: () => { position?: mapboxgl.MercatorCoordinate }
    }
  ).getFreeCameraOptions?.()
  const camera = cameraOpts?.position
  if (!camera) return { lng: groundLL.lng, lat: groundLL.lat }
  const ground = mapboxgl.MercatorCoordinate.fromLngLat(
    { lng: groundLL.lng, lat: groundLL.lat },
    0,
  )
  // Ray direction from camera to the ground-hit point in Mercator
  // space. Mapbox scales altitude into the same units as x/y here, so
  // linear interpolation along the ray is straight in world 3D.
  const dx = ground.x - camera.x
  const dy = ground.y - camera.y
  const dz = ground.z - camera.z
  if (Math.abs(dz) < 1e-15) return { lng: groundLL.lng, lat: groundLL.lat }
  // Target altitude expressed in Mercator z. Uses the ground point's
  // latitude for the meter→merc scale (it's what `fromLngLat` would
  // use for a coord at the same latitude).
  const metersPerMerc = ground.meterInMercatorCoordinateUnits()
  const zTarget = altitudeMeters * metersPerMerc
  const tRay = (zTarget - camera.z) / dz
  const x = camera.x + tRay * dx
  const y = camera.y + tRay * dy
  const hit = new mapboxgl.MercatorCoordinate(x, y, zTarget)
  const ll = hit.toLngLat()
  return { lng: ll.lng, lat: ll.lat }
}
