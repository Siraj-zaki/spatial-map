#!/usr/bin/env node
/**
 * Live-stream simulator. Emits HMAC-signed events to the Worker's
 * `/streams/:streamToken/publish` endpoint at a fixed rate. The SPA's
 * `useLiveStreamScheduler` picks the events up via WebSocket and
 * renders them on the map.
 *
 * Five modes:
 *
 *   --mode asset  (default) — N forklifts orbiting `center` at `radius`m
 *   --mode sensor          — N stationary temp sensors near `center`,
 *                            value = baseline + noise + slow drift
 *   --mode rfid            — N pallet tags doing random walks inside
 *                            `radius`, each pinged by one of `antennas`
 *   --mode shipment        — N trucks approaching `center` along a
 *                            route polyline, cycling through
 *                            scheduled → arrived → docked → loading
 *                            → departed
 *   --mode camera          — N cameras placed around the perimeter
 *                            with FOV pointing inward. Each tick emits
 *                            random cv-detection events
 *                            (person/vehicle/pallet) with confidence.
 *
 * Wire-format match: signature header is `X-Webhook-Signature:
 * t=<unix-sec>,v1=<hex-hmac>` over `${t}.${rawBody}` — the same shape
 * `worker/src/lib/auth-hmac.ts` verifies for webhook receive.
 *
 * Usage:
 *
 *   node scripts/publish-live-stream.mjs \
 *     --url http://localhost:8787 \
 *     --token <streamToken> \
 *     --secret <hmac-secret-≥16-chars> \
 *     [--api-key <Worker API_KEY>]   # required only on first run, registers the secret
 *     [--mode asset|sensor|rfid]     # default 'asset'
 *     [--assets 5]                   # how many synthetic entities (default 3)
 *     [--hz 1]                       # publish rate per second (default 1)
 *     [--center 73.847,18.516]       # center lng,lat
 *     [--radius 25]                  # meters from center (asset orbit / sensor jitter / rfid walk box)
 *     [--baseline 4]                 # sensor baseline value (default 4 °C)
 *     [--amplitude 2]                # sensor swing amplitude (default 2 °C)
 *     [--unit °C]                    # sensor unit (default °C)
 *     [--kind temperature]           # sensor kind tag (default 'temperature')
 *     [--antennas 3]                 # rfid antenna count (default 3)
 *     [--reads-per-tick 1]           # rfid reads per tag per tick (default 1)
 *
 * Tip: copy the publish URL + the HMAC secret straight from the
 * "Add * stream" dialog. Each dialog generates a token + secret for
 * you.
 */

import { createHmac, randomUUID } from 'node:crypto'

// =================================================================== args

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

const args = parseArgs(process.argv)
const url = args.url
const token = args.token
const secret = args.secret
const apiKey = args['api-key']
const mode = (args.mode ?? 'asset').toLowerCase()
if (
  mode !== 'asset' &&
  mode !== 'sensor' &&
  mode !== 'rfid' &&
  mode !== 'shipment' &&
  mode !== 'camera'
) {
  console.error(
    `--mode must be 'asset', 'sensor', 'rfid', 'shipment', or 'camera' (got '${mode}')`,
  )
  process.exit(1)
}
const assetCount = Math.max(1, Number.parseInt(args.assets ?? '3', 10))
const hz = Math.max(0.1, Number.parseFloat(args.hz ?? '1'))
const radius = Math.max(1, Number.parseFloat(args.radius ?? '25'))
const baseline = Number.parseFloat(args.baseline ?? '4')
const amplitude = Math.max(0, Number.parseFloat(args.amplitude ?? '2'))
const sensorUnit = args.unit ?? '°C'
const sensorKind = args.kind ?? 'temperature'
const antennaCount = Math.max(1, Number.parseInt(args.antennas ?? '3', 10))
const readsPerTick = Math.max(1, Number.parseInt(args['reads-per-tick'] ?? '1', 10))
// Optional CV-detection ROI binding. When both are set every detection
// event is stamped with these — the map's MapCvDetectionOverlay then
// renders a pulsing ring on the bound shape.
const detectionShapeIdRaw = args['detection-shape-id']
const detectionShapeId =
  detectionShapeIdRaw === undefined
    ? undefined
    : Number.parseInt(detectionShapeIdRaw, 10)
const detectionShapeKind = args['detection-shape-kind'] // 'polygon' | 'circle' | 'marker'
const detectionsPerTick = Math.max(
  0,
  Number.parseInt(args['detections-per-tick'] ?? '2', 10),
)

const center = (() => {
  const raw = args.center ?? '73.847,18.516'
  const [lng, lat] = raw.split(',').map(Number)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new Error(`--center must be "lng,lat" (got "${raw}")`)
  }
  return [lng, lat]
})()

if (!url || !token || !secret) {
  console.error('Missing required flags. Usage:')
  console.error(
    '  node scripts/publish-live-stream.mjs --url http://localhost:8787 --token <streamToken> --secret <hmac-secret>',
  )
  process.exit(1)
}
if (secret.length < 16) {
  console.error('--secret must be ≥16 characters (HMAC requirement on the Worker).')
  process.exit(1)
}

const base = url.replace(/\/+$/, '')
const publishUrl = `${base}/streams/${encodeURIComponent(token)}/publish`
const registerUrl = `${base}/streams/${encodeURIComponent(token)}/register`

// =============================================================== register

async function registerSecret() {
  if (!apiKey) return // assumes the stream is already registered from the SPA
  process.stdout.write('Registering secret on Worker … ')
  const res = await fetch(registerUrl, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ secret }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error(`failed: ${res.status} ${res.statusText} ${text}`)
    process.exit(1)
  }
  console.log('ok')
}

// =============================================================== signing

function sign(rawBody) {
  const t = Math.floor(Date.now() / 1000)
  const mac = createHmac('sha256', secret)
  mac.update(`${t}.${rawBody}`)
  const v1 = mac.digest('hex')
  return `t=${t},v1=${v1}`
}

// ============================================================== simulator

const METERS_PER_DEG_LAT = 111_320
const startTs = Date.now()
const LAP_MS = 60_000 // one lap per minute

const assets =
  mode === 'asset'
    ? Array.from({ length: assetCount }, (_, idx) => ({
        assetId: `SIM-FL-${String(idx + 1).padStart(3, '0')}`,
        assetType: 'forklift',
        label: `Forklift ${idx + 1}`,
        phase: (idx / assetCount) * Math.PI * 2,
        ringMeters: radius * (0.6 + 0.4 * (idx % 4) / 3),
        status: idx % 7 === 0 ? 'idle' : 'moving',
        runId: randomUUID(),
      }))
    : null

const sensors =
  mode === 'sensor'
    ? Array.from({ length: assetCount }, (_, idx) => {
        // Lay sensors on a ring around `center` so multiple markers don't
        // overlap. Position is stable across ticks (sensors don't move).
        const theta = (idx / assetCount) * Math.PI * 2
        const dxMeters = Math.cos(theta) * radius
        const dyMeters = Math.sin(theta) * radius
        const dLat = dyMeters / METERS_PER_DEG_LAT
        const dLng =
          dxMeters / (METERS_PER_DEG_LAT * Math.cos((center[1] * Math.PI) / 180))
        return {
          sensorId: `SIM-TEMP-${String(idx + 1).padStart(3, '0')}`,
          kind: sensorKind,
          unit: sensorUnit,
          label: `${capitalize(sensorKind)} ${idx + 1}`,
          lng: center[0] + dLng,
          lat: center[1] + dLat,
          // Each sensor gets its own slow drift phase so the graph isn't
          // identical across the fleet.
          phase: (idx * 1.7) % (Math.PI * 2),
          // Per-sensor jitter / noise scale.
          noise: 0.4 + 0.3 * (idx % 3),
        }
      })
    : null

function tickAssets() {
  const now = Date.now()
  const elapsed = now - startTs
  const events = assets.map((a) => {
    const theta = a.phase + (elapsed / LAP_MS) * Math.PI * 2
    const dxMeters = Math.cos(theta) * a.ringMeters
    const dyMeters = Math.sin(theta) * a.ringMeters
    const dLat = dyMeters / METERS_PER_DEG_LAT
    const dLng = dxMeters / (METERS_PER_DEG_LAT * Math.cos((center[1] * Math.PI) / 180))
    // Tangent heading (compass degrees, 0 = North CW).
    const tangent = theta + Math.PI / 2
    const heading = ((-tangent * 180) / Math.PI + 360 + 90) % 360
    return {
      type: 'position',
      assetId: a.assetId,
      assetType: a.assetType,
      label: a.label,
      lng: center[0] + dLng,
      lat: center[1] + dLat,
      heading,
      speed: (a.ringMeters * Math.PI * 2) / (LAP_MS / 1000), // m/s, mean
      status: a.status,
      ts: now,
    }
  })
  return JSON.stringify({ type: 'batch', events })
}

function tickSensors() {
  const now = Date.now()
  const elapsed = now - startTs
  const events = sensors.map((s) => {
    // Slow sinusoidal drift (full cycle ~ 5 min) + Gaussian-ish noise.
    const driftFrac = (elapsed / (5 * 60_000)) * Math.PI * 2 + s.phase
    const noise = (Math.random() - 0.5) * s.noise
    const value = baseline + Math.sin(driftFrac) * amplitude + noise
    return {
      type: 'reading',
      sensorId: s.sensorId,
      kind: s.kind,
      unit: s.unit,
      label: s.label,
      value: Math.round(value * 100) / 100,
      lng: s.lng,
      lat: s.lat,
      ts: now,
    }
  })
  return JSON.stringify({ type: 'batch', events })
}

// ============================================================== rfid

/**
 * RFID tags do a small random walk inside the radius box. Each tick
 * we emit `--reads-per-tick` reads per tag, each tagged to a random
 * antenna with a noisy RSSI that decays with distance from the
 * antenna. The wire format `{ type: 'tag-read', ... }` matches what
 * `rfid-service.coerceRfidMessage` expects.
 */
const antennas =
  mode === 'rfid'
    ? Array.from({ length: antennaCount }, (_, idx) => {
        const theta = (idx / antennaCount) * Math.PI * 2
        const r = radius * 1.1 // antennas slightly outside the walk box
        const dLat = (Math.sin(theta) * r) / METERS_PER_DEG_LAT
        const dLng =
          (Math.cos(theta) * r) /
          (METERS_PER_DEG_LAT * Math.cos((center[1] * Math.PI) / 180))
        return {
          antennaId: `ANT-${String(idx + 1).padStart(2, '0')}`,
          lng: center[0] + dLng,
          lat: center[1] + dLat,
        }
      })
    : null

const rfidTags =
  mode === 'rfid'
    ? Array.from({ length: assetCount }, (_, idx) => ({
        tagId: `RFID-${String(idx + 1).padStart(4, '0').padStart(8, '0').slice(-8)}`,
        label: `Pallet ${idx + 1}`,
        // Initial position: jitter around `center` inside the walk box.
        lng: center[0] + (Math.random() - 0.5) * 2 * randomMetersToLng(radius),
        lat: center[1] + (Math.random() - 0.5) * 2 * (radius / METERS_PER_DEG_LAT),
      }))
    : null

function randomMetersToLng(m) {
  return m / (METERS_PER_DEG_LAT * Math.cos((center[1] * Math.PI) / 180))
}

function distMeters(a, b) {
  const dx = (a.lng - b.lng) * METERS_PER_DEG_LAT * Math.cos((center[1] * Math.PI) / 180)
  const dy = (a.lat - b.lat) * METERS_PER_DEG_LAT
  return Math.sqrt(dx * dx + dy * dy)
}

function tickRfid() {
  const now = Date.now()
  const events = []
  // Step every tag once per tick, then emit `readsPerTick` reads.
  // The step is small (~0.5m) so a 1Hz tick produces 0.5m/s drift —
  // realistic for a forklift-borne pallet on a slow loop.
  for (const t of rfidTags) {
    const stepM = (Math.random() - 0.5) * 1.0
    const stepLng = randomMetersToLng(stepM)
    const stepLat = stepM / METERS_PER_DEG_LAT
    t.lng += stepLng
    t.lat += stepLat
    // Clamp to walk box around center.
    const maxLng = randomMetersToLng(radius)
    const maxLat = radius / METERS_PER_DEG_LAT
    if (Math.abs(t.lng - center[0]) > maxLng) {
      t.lng = center[0] + Math.sign(t.lng - center[0]) * maxLng
    }
    if (Math.abs(t.lat - center[1]) > maxLat) {
      t.lat = center[1] + Math.sign(t.lat - center[1]) * maxLat
    }
    for (let r = 0; r < readsPerTick; r++) {
      // Each read picks a random antenna; weight RSSI by distance.
      const ant = antennas[Math.floor(Math.random() * antennas.length)]
      const d = distMeters(t, ant)
      const rssi = Math.round(-40 - d * 0.6 - Math.random() * 4)
      events.push({
        type: 'tag-read',
        tagId: t.tagId,
        antennaId: ant.antennaId,
        label: t.label,
        lng: t.lng,
        lat: t.lat,
        rssi,
        ts: now,
      })
    }
  }
  return JSON.stringify({ type: 'batch', events })
}

// ========================================================== shipment

/**
 * Shipment trucks. Each truck has a fixed route from an off-map
 * staging point to `center`, then sits idle for the loading window,
 * then departs back along the inverse route. State transitions are
 * driven by elapsed time:
 *
 *   t < approachMs                              → scheduled
 *   approachMs ≤ t < approachMs + 5s            → arrived (one event)
 *   approachMs + 5s ≤ t < approach + dock       → docked (one event)
 *   docked + 5s ≤ t < approach + load           → loading (one event)
 *   approach + load + 5s ≤ t                    → departed (then loops)
 *
 * Concretely: a full cycle takes about 90 seconds with default knobs.
 */
const APPROACH_MS = 25_000
const DOCK_MS = 8_000
const LOAD_MS = 30_000
const CYCLE_MS = APPROACH_MS + DOCK_MS + LOAD_MS

const shipments =
  mode === 'shipment'
    ? Array.from({ length: assetCount }, (_, idx) => {
        const phaseOffsetMs = (idx / assetCount) * CYCLE_MS
        // Approach bearing: spread trucks around the compass so they
        // don't all stack on the same line.
        const bearing = (idx / assetCount) * Math.PI * 2
        const staging = offsetMeters(center, radius * 6, bearing)
        // Three-segment route with a couple of waypoints so the
        // polyline shows something more interesting than a straight line.
        const route = [
          staging,
          offsetMeters(center, radius * 3, bearing + 0.15),
          offsetMeters(center, radius * 1.2, bearing - 0.1),
          center,
        ]
        return {
          shipmentId: `SHIP-${String(idx + 1).padStart(4, '0')}`,
          carrier: ['ACME', 'Pioneer', 'Maersk', 'DHL'][idx % 4],
          label: `Load ${idx + 1}`,
          phaseOffsetMs,
          route,
          stateEmitted: { scheduled: false, arrived: false, docked: false, loading: false, departed: false },
          routeEmitted: false,
        }
      })
    : null

function offsetMeters([lng, lat], meters, bearingRad) {
  const dLat = (Math.sin(bearingRad) * meters) / METERS_PER_DEG_LAT
  const dLng =
    (Math.cos(bearingRad) * meters) /
    (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))
  return [lng + dLng, lat + dLat]
}

function interpRoute(route, t01) {
  // t01 ∈ [0, 1] over the whole route. Segment lengths assumed equal
  // (good enough for an evenly-spaced 4-vertex route).
  const segs = route.length - 1
  const k = Math.min(segs - 1, Math.max(0, Math.floor(t01 * segs)))
  const local = t01 * segs - k
  const a = route[k]
  const b = route[k + 1]
  return [a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local]
}

function tickShipments() {
  const now = Date.now()
  const events = []
  for (const s of shipments) {
    // Cycle each truck independently using its phase offset.
    const phaseMs = (now - startTs + s.phaseOffsetMs) % CYCLE_MS
    let state
    let lng
    let lat
    if (phaseMs < APPROACH_MS) {
      state = 'scheduled'
      // Move along the route toward center as we approach.
      const t = phaseMs / APPROACH_MS
      ;[lng, lat] = interpRoute(s.route, t)
      // Flip to "arrived" once we're close enough to the destination.
      if (t > 0.92) state = 'arrived'
    } else if (phaseMs < APPROACH_MS + DOCK_MS) {
      state = 'docked'
      ;[lng, lat] = s.route[s.route.length - 1]
    } else if (phaseMs < APPROACH_MS + DOCK_MS + LOAD_MS - 5_000) {
      state = 'loading'
      ;[lng, lat] = s.route[s.route.length - 1]
    } else if (phaseMs < CYCLE_MS) {
      state = 'departed'
      // Move along the route back to staging for the last few seconds.
      const t = (phaseMs - (APPROACH_MS + DOCK_MS + LOAD_MS - 5_000)) / 5_000
      ;[lng, lat] = interpRoute([...s.route].reverse(), t)
    }
    if (state === undefined) continue

    // Emit a `create` envelope with route on the first scheduled event.
    if (!s.routeEmitted) {
      events.push({
        type: 'shipment-event',
        shipmentId: s.shipmentId,
        kind: 'inbound',
        carrier: s.carrier,
        label: s.label,
        state: 'scheduled',
        route: s.route,
        scheduledAt: now,
        ts: now,
      })
      s.routeEmitted = true
      s.stateEmitted.scheduled = true
      continue
    }
    // Emit a state-transition envelope the first time we cross into
    // a new state in this cycle.
    if (!s.stateEmitted[state]) {
      events.push({
        type: 'shipment-event',
        shipmentId: s.shipmentId,
        state,
        lng,
        lat,
        ts: now,
      })
      // Reset per-cycle latches so the next loop fires again.
      if (state === 'departed') {
        s.stateEmitted = { scheduled: false, arrived: false, docked: false, loading: false, departed: true }
      } else {
        s.stateEmitted[state] = true
      }
      continue
    }
    // Otherwise just a position update.
    events.push({
      type: 'shipment-event',
      shipmentId: s.shipmentId,
      lng,
      lat,
      ts: now,
    })
  }
  return JSON.stringify({ type: 'batch', events })
}

// ========================================================== camera

const OBJECT_CLASSES = ['person', 'forklift', 'pallet', 'box']

const cameras =
  mode === 'camera'
    ? Array.from({ length: assetCount }, (_, idx) => {
        const theta = (idx / assetCount) * Math.PI * 2
        // Place each camera at radius * 1.4, pointing inward.
        const r = radius * 1.4
        const dLat = (Math.sin(theta) * r) / METERS_PER_DEG_LAT
        const dLng =
          (Math.cos(theta) * r) /
          (METERS_PER_DEG_LAT * Math.cos((center[1] * Math.PI) / 180))
        const lng = center[0] + dLng
        const lat = center[1] + dLat
        // Compute yaw so the cone faces back toward center. Compass:
        // yaw_deg = atan2(dx_east, dy_north) where east=center.lng-lng,
        // north=center.lat-lat.
        const dxE = center[0] - lng
        const dyN = center[1] - lat
        const yawDeg =
          (((Math.atan2(dxE, dyN) * 180) / Math.PI) + 360) % 360
        return {
          cameraId: `CAM-${String(idx + 1).padStart(3, '0')}`,
          label: `Camera ${idx + 1}`,
          kind: idx % 3 === 0 ? 'overview' : 'dock',
          lng,
          lat,
          heightM: 4 + (idx % 3),
          yaw: Math.round(yawDeg),
          pitch: 25,
          fovDeg: 60 + (idx % 3) * 10,
          viewDistanceM: radius * 1.6,
          poseEmitted: false,
        }
      })
    : null

function tickCameras() {
  const now = Date.now()
  const events = []
  for (const c of cameras) {
    // First time we see this camera, send its pose so the overlay can
    // draw the FOV cone.
    if (!c.poseEmitted) {
      const cameraEv = {
        type: 'camera',
        cameraId: c.cameraId,
        label: c.label,
        kind: c.kind,
        lng: c.lng,
        lat: c.lat,
        heightM: c.heightM,
        yaw: c.yaw,
        pitch: c.pitch,
        fovDeg: c.fovDeg,
        viewDistanceM: c.viewDistanceM,
        ts: now,
      }
      if (detectionShapeId !== undefined && detectionShapeKind) {
        cameraEv.mountedOn = {
          targetKind: detectionShapeKind,
          shapeId: detectionShapeId,
        }
      }
      events.push(cameraEv)
      c.poseEmitted = true
    }
    // Random CV detections per tick.
    for (let i = 0; i < detectionsPerTick; i++) {
      const cls = OBJECT_CLASSES[Math.floor(Math.random() * OBJECT_CLASSES.length)]
      const det = {
        type: 'cv-detection',
        cameraId: c.cameraId,
        objectClass: cls,
        count: 1 + Math.floor(Math.random() * 4),
        confidence: Math.round((0.75 + Math.random() * 0.24) * 100) / 100,
        ts: now,
      }
      if (detectionShapeId !== undefined && detectionShapeKind) {
        det.targetShapeKind = detectionShapeKind
        det.targetShapeId = detectionShapeId
      }
      events.push(det)
    }
  }
  return JSON.stringify({ type: 'batch', events })
}

function tick() {
  if (mode === 'asset') return tickAssets()
  if (mode === 'sensor') return tickSensors()
  if (mode === 'rfid') return tickRfid()
  if (mode === 'shipment') return tickShipments()
  return tickCameras()
}

function capitalize(s) {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}

// ================================================================ loop

let inflight = 0
let publishedFrames = 0
let lastSummaryAt = Date.now()

async function publishOne() {
  const payload = tick()
  const headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Signature': sign(payload),
  }
  inflight++
  try {
    const res = await fetch(publishUrl, {
      method: 'POST',
      headers,
      body: payload,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`publish ${res.status} ${res.statusText} ${text}`)
      return
    }
    publishedFrames++
  } catch (err) {
    console.warn(`publish failed: ${err.message}`)
  } finally {
    inflight--
  }
}

function logSummary() {
  const now = Date.now()
  const elapsedSec = (now - lastSummaryAt) / 1000
  const rate = publishedFrames / Math.max(elapsedSec, 0.001)
  console.log(
    `[publish-live-stream] ${publishedFrames} frames in ${elapsedSec.toFixed(1)}s (${rate.toFixed(1)} Hz, ${inflight} in flight)`,
  )
  publishedFrames = 0
  lastSummaryAt = now
}

async function main() {
  await registerSecret()
  const noun =
    mode === 'asset'
      ? 'forklifts'
      : mode === 'sensor'
        ? `${sensorKind} sensors`
        : mode === 'rfid'
          ? `RFID tags (${antennaCount} antennas × ${readsPerTick} reads/tick)`
          : mode === 'shipment'
            ? `shipments (${(CYCLE_MS / 1000) | 0}s cycle: approach → docked → loading → departed)`
            : `cameras (${detectionsPerTick} detections/tick × camera${
                detectionShapeId !== undefined ? `, bound to ${detectionShapeKind ?? 'shape'} #${detectionShapeId}` : ''
              })`
  console.log(
    `Publishing ${assetCount} simulated ${noun} to ${publishUrl} at ${hz} Hz around [${center.join(', ')}] (radius ${radius}m).`,
  )
  console.log('Press Ctrl-C to stop.')
  const intervalMs = 1000 / hz
  const timer = setInterval(() => {
    void publishOne()
  }, intervalMs)
  const summaryTimer = setInterval(logSummary, 10_000)
  process.on('SIGINT', () => {
    clearInterval(timer)
    clearInterval(summaryTimer)
    logSummary()
    console.log('bye.')
    process.exit(0)
  })
}

await main()
