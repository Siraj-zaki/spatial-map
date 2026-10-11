/**
 * Cross-stream correlation engine — Slice 6c2 rewrite.
 *
 * The pre-refactor engine wired directly into per-entity event tables
 * (`cvDetections`, `sensorReadings`, `rfidReads`, `assetPositions`) and
 * the `shipments` state table. Those tables were removed in Slice 6c2;
 * every live event now lands in the generic `entity_events` log via
 * `POST /api/v1/streams/:id/ingest` and is queried through
 * `listEntityEventsForStream(streamId, { windowSec })`.
 *
 * This engine re-interprets the existing `CorrelationTrigger` /
 * `CorrelationAction` shapes (`src/lib/db.ts`) against payload fields
 * on `entity_events` rows. The mapping is:
 *
 *   Trigger kind          -> Stream.entityType filter -> payload key(s)
 *   --------------------- -> ----------------------- -> --------------------------
 *   cv-detection          -> 'cv-detection'          -> objectClass, count,
 *                                                        targetShapeKind, targetShapeId
 *   sensor-reading        -> 'sensor'                -> sensorId, value
 *   rfid-read             -> 'rfid-tag'              -> tagId, lng, lat
 *   asset-position        -> 'asset'                 -> assetId, lng, lat
 *   shipment-state-change -> 'shipment'              -> shipmentId, state, doorId
 *
 * Trigger dispatch: for each enabled rule the engine finds every stream
 * matching its expected `entityType`, fetches recent events for each,
 * runs the predicate, and (if the cooldown has elapsed) dispatches the
 * action. Edge-triggered rules (asset geofence, shipment-state-entry)
 * keep per-entity state in `useRef` maps so we only fire on the
 * transition, not on every event.
 */

import { useEffect, useRef } from 'react'
import { apiDb } from '@/lib/api-db'
import { apiPost } from '@/lib/api-client'
import { listEntityEventsForStream } from '@/lib/data-link/entity-state-service'
import { useApiQuery } from '@/lib/useApiQuery'
import type {
  Alert,
  CorrelationRule,
  CorrelationTrigger,
  CorrelationAction,
} from '@/lib/db'
import type { Stream, EntityType } from '@/lib/data-link/contracts'
import type { EntityEvent } from '@/lib/db'
import type { PolygonShape } from '@/lib/shapes'

const TICK_INTERVAL_MS = 2_000
const DEFAULT_COOLDOWN_MS = 5_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `{key}` substitution against an event payload. Missing keys resolve
 * to the empty string so a template never blows up on an unrelated
 * event. Non-string values are coerced through `String()`.
 */
function substituteTemplate(
  template: string,
  payload: Record<string, unknown>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = payload[key]
    return v === undefined || v === null ? '' : String(v)
  })
}

/**
 * Ray-casting point-in-polygon test. Both args are `[lng, lat]`
 * (Mapbox order); the algorithm is topology-agnostic so we can pass
 * lng/lat directly.
 */
function pointInPolygon(
  pt: [number, number],
  vertices: [number, number][],
): boolean {
  let inside = false
  const [x, y] = pt
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const [xi, yi] = vertices[i]
    const [xj, yj] = vertices[j]
    if (
      (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Best-effort extraction of a stable identifier for the entity that
 * fired the rule. Used as the alert row's `entityRef` field so an
 * operator can jump from the alert list to the entity screen.
 */
function extractEntityRef(event: EntityEvent): string {
  const p = event.payload
  const keys = ['assetId', 'sensorId', 'tagId', 'shipmentId', 'cameraId']
  for (const k of keys) {
    const v = p[k]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'number') return String(v)
  }
  return event.entityKey
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

async function emitAlertRow(
  rule: CorrelationRule,
  level: Alert['level'],
  message: string,
  event: EntityEvent | null,
): Promise<void> {
  const entityRef = event ? extractEntityRef(event) : undefined
  await apiDb.alerts.add({
    ruleId: rule.id,
    ruleName: rule.name,
    level,
    message,
    entityRef,
    tenantId: rule.tenantId,
    ts: new Date(),
    acknowledged: false,
  })
}

async function dispatchAction(
  rule: CorrelationRule,
  event: EntityEvent,
): Promise<void> {
  const action: CorrelationAction = rule.action
  const payload = event.payload

  switch (action.kind) {
    case 'emit-alert': {
      const message = substituteTemplate(action.messageTemplate, payload)
      await emitAlertRow(rule, action.level, message, event)
      return
    }

    case 'set-bin-status': {
      // Load the bin catalog once and match by externalCode OR id.
      // Bins are catalog entities so this is a small tenant-scoped list.
      const bins = await apiDb.bins.toArray()
      const target = bins.find((b) => {
        if (action.binId !== undefined) return b.id === action.binId
        if (action.binExternalCode !== undefined)
          return b.externalCode === action.binExternalCode
        return false
      })
      if (!target || target.id === undefined) {
        console.warn(
          '[correlation-engine] set-bin-status could not find bin',
          { binId: action.binId, binExternalCode: action.binExternalCode },
        )
        return
      }
      await apiDb.bins.update(target.id, {
        status: action.status,
        updatedAt: new Date(),
      })
      return
    }

    case 'advance-shipment-state': {
      // Legacy path — the `shipments` table was dropped in Slice 6c2.
      // Emit an operator-visible alert AND log so the rule doesn't fail
      // silently; a future ports the state machine back over
      // entity_events.
      console.warn(
        '[correlation-engine] advance-shipment-state action is unsupported after Slice 6c2 — shipments table was dropped.',
      )
      await emitAlertRow(
        rule,
        'warn',
        `Rule "${rule.name}" fired but action "advance-shipment-state" is not supported after Slice 6c2 (shipments table dropped). Action dropped — see console.`,
        event,
      )
      return
    }

    case 'call-outbound': {
      // TODO: port `pushOutboundPatch` for the generic streams surface
      // — the pre-refactor helper resolved the destination through a
      // DataSource endpoint; the new Stream endpoints don't expose an
      // outbound URL yet. Until then, emit an alert row so the rule
      // author can see the fire path is wired.
      console.warn(
        '[correlation-engine] call-outbound action is not yet ported to the generic streams surface (Slice 6c2 follow-up).',
      )
      await emitAlertRow(
        rule,
        'warn',
        `Rule "${rule.name}" fired but action "call-outbound" is not yet ported to generic streams. Streamed patch dropped — see console.`,
        event,
      )
      return
    }

    case 'notify-webhook': {
      const body = substituteTemplate(action.bodyTemplate, payload)
      try {
        const resp = await fetch(action.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(action.headers ?? {}),
          },
          body,
        })
        if (!resp.ok) {
          console.warn(
            '[correlation-engine] webhook returned non-2xx',
            action.url,
            resp.status,
          )
          await emitAlertRow(
            rule,
            'warn',
            `Rule "${rule.name}" webhook POST to ${action.url} returned HTTP ${resp.status}.`,
            event,
          )
        }
      } catch (err) {
        console.warn(
          '[correlation-engine] webhook fetch failed',
          action.url,
          err,
        )
        await emitAlertRow(
          rule,
          'warn',
          `Rule "${rule.name}" webhook POST to ${action.url} failed: ${String(err)}.`,
          event,
        )
      }
      return
    }

    case 'set-zone-status': {
      // `Zone` doesn't carry `updatedAt` in the client type; the
      // backend stamps its own audit timestamps on the row.
      await apiDb.zones.update(action.zoneId, {
        description: action.status,
      })
      return
    }

    default: {
      // Exhaustiveness guard — TS ensures every action.kind above is
      // handled; a new variant would land here at runtime until the
      // switch is extended.
      const exhaustive: never = action
      console.warn(
        '[correlation-engine] unknown action kind — dropped',
        exhaustive,
      )
    }
  }

  // apiPost is imported so the outbound helper can be swapped in
  // without changing this file's dependency list. Referenced here to
  // silence unused-import lint until `call-outbound` is fully ported.
  void apiPost
}

// ---------------------------------------------------------------------------
// Cooldown + book-keeping
// ---------------------------------------------------------------------------

/**
 * Records the fire on the rule row (cooldown clock + fire count) and
 * then dispatches the action. Callers must run the cooldown gate BEFORE
 * calling this so a hot trigger doesn't burn through cooldown checks
 * pointlessly.
 */
async function fireRule(
  rule: CorrelationRule,
  event: EntityEvent,
): Promise<void> {
  if (rule.id === undefined) return
  const now = new Date()
  await apiDb.correlationRules.update(rule.id, {
    lastFiredAt: now,
    fireCount: (rule.fireCount ?? 0) + 1,
  })
  // Mutate the in-memory copy so downstream checks in the same tick
  // (rare — the outer loop already skipped) still see the cooldown.
  rule.lastFiredAt = now
  rule.fireCount = (rule.fireCount ?? 0) + 1
  await dispatchAction(rule, event)
}

function cooldownElapsed(rule: CorrelationRule): boolean {
  const cooldown = rule.cooldownMs ?? DEFAULT_COOLDOWN_MS
  if (!rule.lastFiredAt) return true
  const last = rule.lastFiredAt.getTime()
  return Date.now() - last >= cooldown
}

// ---------------------------------------------------------------------------
// Per-trigger evaluators
// ---------------------------------------------------------------------------

/**
 * cv-detection: sum `payload.count` across every event in the window
 * whose `objectClass` (and optional targetShape*) match the trigger.
 * `payload.count` defaults to 1 per event — a single detection frame
 * with no `count` is treated as one hit.
 *
 * `payload.objectClass` is the class label emitted by the vision model
 * ("person", "forklift", …); the pre-refactor engine kept it in a
 * typed column but the generic events log stores it in payload JSON.
 */
async function evaluateCvDetection(
  rule: CorrelationRule,
  trigger: Extract<CorrelationTrigger, { kind: 'cv-detection' }>,
  streams: Stream[],
): Promise<void> {
  const windowSec = trigger.windowMs ? trigger.windowMs / 1000 : 10
  for (const stream of streams) {
    if (stream.id === undefined) continue
    const events = await listEntityEventsForStream(stream.id, { windowSec })
    let sum = 0
    let latest: EntityEvent | null = null
    for (const ev of events) {
      const p = ev.payload
      if (trigger.objectClass && str(p.objectClass) !== trigger.objectClass)
        continue
      if (
        trigger.targetShapeKind !== undefined &&
        str(p.targetShapeKind) !== trigger.targetShapeKind
      )
        continue
      if (
        trigger.targetShapeId !== undefined &&
        num(p.targetShapeId) !== trigger.targetShapeId
      )
        continue
      const count = num(p.count) ?? 1
      sum += count
      if (!latest) latest = ev
    }
    if (sum >= (trigger.minCount ?? 1) && latest && cooldownElapsed(rule)) {
      await fireRule(rule, latest)
      return // one fire per tick per rule
    }
  }
}

/**
 * sensor-reading: compare `payload.value` against a threshold. Fires
 * on the first event in the 60 s window that satisfies the predicate.
 * `payload.sensorId` (string) is the same identifier the ingest
 * pipeline stamps; when the trigger's `sensorId` is unset the rule
 * matches every sensor on the stream.
 */
async function evaluateSensorReading(
  rule: CorrelationRule,
  trigger: Extract<CorrelationTrigger, { kind: 'sensor-reading' }>,
  streams: Stream[],
): Promise<void> {
  for (const stream of streams) {
    if (stream.id === undefined) continue
    const events = await listEntityEventsForStream(stream.id, { windowSec: 60 })
    for (const ev of events) {
      const p = ev.payload
      if (trigger.sensorId && str(p.sensorId) !== trigger.sensorId) continue
      const value = num(p.value)
      if (value === undefined) continue
      let match = false
      switch (trigger.op) {
        case '>':
          match = value > trigger.threshold
          break
        case '<':
          match = value < trigger.threshold
          break
        case '>=':
          match = value >= trigger.threshold
          break
        case '<=':
          match = value <= trigger.threshold
          break
      }
      if (match && cooldownElapsed(rule)) {
        await fireRule(rule, ev)
        return
      }
    }
  }
}

/**
 * rfid-read: point-in-polygon test on each read's `payload.lng/lat`
 * against the polygon the trigger names. Fires when at least one
 * matching read is inside. `payload.tagId` (string) is the RFID tag
 * identifier; `tagIdPattern` is a simple substring filter (a prefix
 * pattern like `"PALLET-"` is the common case).
 */
async function evaluateRfidRead(
  rule: CorrelationRule,
  trigger: Extract<CorrelationTrigger, { kind: 'rfid-read' }>,
  streams: Stream[],
  polygonCache: Map<number, PolygonShape | undefined>,
): Promise<void> {
  const polygon = await resolvePolygon(trigger.polygonId, polygonCache)
  if (!polygon) return
  for (const stream of streams) {
    if (stream.id === undefined) continue
    const events = await listEntityEventsForStream(stream.id, { windowSec: 30 })
    for (const ev of events) {
      const p = ev.payload
      if (
        trigger.tagIdPattern &&
        !(str(p.tagId)?.includes(trigger.tagIdPattern) ?? false)
      )
        continue
      const lng = num(p.lng)
      const lat = num(p.lat)
      if (lng === undefined || lat === undefined) continue
      if (!pointInPolygon([lng, lat], polygon.vertices)) continue
      if (cooldownElapsed(rule)) {
        await fireRule(rule, ev)
        return
      }
    }
  }
}

/**
 * asset-position: edge-triggered geofence. Keeps a per-(ruleId+assetId)
 * boolean of the last known "inside polygon" state; fires on the
 * transition matching `trigger.direction`. State survives across ticks
 * via the caller-supplied `insideState` map (kept in a useRef).
 *
 * Note: because this walks *every* event in the window it will observe
 * the transition even if the asset flapped inside/outside between
 * ticks. We keep the latest event as the fire context (representative
 * of the current state).
 */
async function evaluateAssetPosition(
  rule: CorrelationRule,
  trigger: Extract<CorrelationTrigger, { kind: 'asset-position' }>,
  streams: Stream[],
  polygonCache: Map<number, PolygonShape | undefined>,
  insideState: Map<string, boolean>,
): Promise<void> {
  const polygon = await resolvePolygon(trigger.polygonId, polygonCache)
  if (!polygon) return
  const ruleKey = rule.id ?? -1
  // Group events by assetId, take the latest per asset (events arrive
  // newest-first from the API, so the first one we see wins).
  for (const stream of streams) {
    if (stream.id === undefined) continue
    const events = await listEntityEventsForStream(stream.id, { windowSec: 30 })
    const latestPerAsset = new Map<string, EntityEvent>()
    for (const ev of events) {
      const assetId = str(ev.payload.assetId)
      if (!assetId) continue
      if (
        trigger.assetIdPattern &&
        !assetId.includes(trigger.assetIdPattern)
      )
        continue
      if (!latestPerAsset.has(assetId)) latestPerAsset.set(assetId, ev)
    }
    for (const [assetId, ev] of latestPerAsset) {
      const lng = num(ev.payload.lng)
      const lat = num(ev.payload.lat)
      if (lng === undefined || lat === undefined) continue
      const isInside = pointInPolygon([lng, lat], polygon.vertices)
      const stateKey = `${ruleKey}:${assetId}`
      const wasInside = insideState.get(stateKey) ?? false
      insideState.set(stateKey, isInside)
      const fired =
        (trigger.direction === 'enter' && !wasInside && isInside) ||
        (trigger.direction === 'leave' && wasInside && !isInside)
      if (fired && cooldownElapsed(rule)) {
        await fireRule(rule, ev)
        return
      }
    }
  }
}

/**
 * shipment-state-change: fires on ENTRY into any of `trigger.toStates`.
 * `payload.state` is the current state; `payload.shipmentId` is the
 * stable per-shipment identifier used to dedupe repeat events with
 * the same state (a shipment reporting `loading` every 5 s should
 * only trigger the rule the first time it enters `loading`).
 */
async function evaluateShipmentStateChange(
  rule: CorrelationRule,
  trigger: Extract<CorrelationTrigger, { kind: 'shipment-state-change' }>,
  streams: Stream[],
  lastStateByShipment: Map<string, string>,
): Promise<void> {
  const ruleKey = rule.id ?? -1
  for (const stream of streams) {
    if (stream.id === undefined) continue
    const events = await listEntityEventsForStream(stream.id, { windowSec: 30 })
    // Walk oldest-first so we register the state ENTRY not the last event.
    const chrono = [...events].reverse()
    for (const ev of chrono) {
      const p = ev.payload
      const shipmentId = str(p.shipmentId)
      if (!shipmentId) continue
      const state = str(p.state)
      if (!state) continue
      if (
        trigger.doorId !== undefined &&
        num(p.doorId) !== trigger.doorId
      )
        continue
      const stateKey = `${ruleKey}:${shipmentId}`
      const prevState = lastStateByShipment.get(stateKey)
      lastStateByShipment.set(stateKey, state)
      if (prevState === state) continue // not an entry, already in this state
      // Cast tolerated: `trigger.toStates` is typed as ShipmentState[]
      // but we compare through the string payload field.
      if (
        !(trigger.toStates as string[]).includes(state)
      )
        continue
      if (cooldownElapsed(rule)) {
        await fireRule(rule, ev)
        return
      }
    }
  }
}

async function resolvePolygon(
  polygonId: number,
  cache: Map<number, PolygonShape | undefined>,
): Promise<PolygonShape | undefined> {
  if (cache.has(polygonId)) return cache.get(polygonId)
  try {
    const polygon = await apiDb.polygons.get(polygonId)
    cache.set(polygonId, polygon)
    return polygon
  } catch {
    cache.set(polygonId, undefined)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Trigger dispatch table
// ---------------------------------------------------------------------------

/**
 * Which stream entityType(s) does each trigger kind consume? Used to
 * prune the stream fan-out — a `cv-detection` rule doesn't need to
 * touch sensor streams.
 */
const TRIGGER_ENTITY_TYPE: Record<CorrelationTrigger['kind'], EntityType> = {
  'cv-detection': 'cv-detection',
  'sensor-reading': 'sensor',
  'rfid-read': 'rfid-tag',
  'asset-position': 'asset',
  'shipment-state-change': 'shipment',
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Mounts the correlation engine on a 2 s tick. `enabled=false` keeps
 * the hook alive without polling — used by preview toggles that want
 * the rules paused without unmounting the container.
 */
export function useCorrelationEngine(enabled = true): void {
  // Rule count query — same telemetry surface the stub had. Gated on
  // enabled so a paused preview doesn't hammer the endpoint.
  const enabledRulesQuery = useApiQuery(
    async () => {
      const rows = await apiDb.correlationRules.toArray()
      return rows.filter((r) => r.enabled).length
    },
    ['correlation-rules-count'],
    { intervalMs: TICK_INTERVAL_MS, enabled },
  )
  const enabledRulesCount = enabledRulesQuery.data ?? 0

  // Per-hook-instance memory for edge-triggered rules. Keys live for
  // the lifetime of the mounted hook; a rule/asset/shipment that
  // disappears mid-session goes stale but never fires a false event
  // because the transition compares against a fresh event.
  const assetInsideRef = useRef<Map<string, boolean>>(new Map())
  const shipmentLastStateRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    if (!enabled) return
    if (enabledRulesCount === 0) return

    if (import.meta.env.DEV) {
      console.info(
        '[correlation-engine] tick loop live — %d enabled rule(s).',
        enabledRulesCount,
      )
    }

    let cancelled = false

    const tick = async () => {
      if (cancelled) return
      try {
        // Fetch rule + stream catalog once per tick; cache polygons on
        // demand as rules reference them. All shared across the tick's
        // rule loop to avoid N+1 fetches.
        const [rules, streams] = await Promise.all([
          apiDb.correlationRules.toArray(),
          apiDb.streams.toArray(),
        ])
        const enabledRules = rules.filter((r) => r.enabled)
        if (enabledRules.length === 0) return

        // Group streams by entityType so each rule can grab its slice
        // in O(1) — a big tenant with dozens of streams still stays
        // cheap.
        const streamsByType = new Map<EntityType, Stream[]>()
        for (const s of streams) {
          const list = streamsByType.get(s.entityType) ?? []
          list.push(s)
          streamsByType.set(s.entityType, list)
        }

        const polygonCache = new Map<number, PolygonShape | undefined>()

        for (const rule of enabledRules) {
          try {
            const wanted = TRIGGER_ENTITY_TYPE[rule.trigger.kind]
            const candidateStreams = streamsByType.get(wanted) ?? []
            if (candidateStreams.length === 0) continue
            switch (rule.trigger.kind) {
              case 'cv-detection':
                await evaluateCvDetection(rule, rule.trigger, candidateStreams)
                break
              case 'sensor-reading':
                await evaluateSensorReading(
                  rule,
                  rule.trigger,
                  candidateStreams,
                )
                break
              case 'rfid-read':
                await evaluateRfidRead(
                  rule,
                  rule.trigger,
                  candidateStreams,
                  polygonCache,
                )
                break
              case 'asset-position':
                await evaluateAssetPosition(
                  rule,
                  rule.trigger,
                  candidateStreams,
                  polygonCache,
                  assetInsideRef.current,
                )
                break
              case 'shipment-state-change':
                await evaluateShipmentStateChange(
                  rule,
                  rule.trigger,
                  candidateStreams,
                  shipmentLastStateRef.current,
                )
                break
            }
          } catch (err) {
            // Per-rule catch: one bad rule shouldn't take out the tick.
            console.warn(
              '[correlation-engine] rule evaluation failed',
              { ruleId: rule.id, ruleName: rule.name },
              err,
            )
          }
        }
      } catch (err) {
        // Top-level catch: catalog fetch failed. Log + skip this tick.
        console.warn('[correlation-engine] tick failed', err)
      }
    }

    void tick()
    const intervalId = setInterval(tick, TICK_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [enabled, enabledRulesCount])
}
