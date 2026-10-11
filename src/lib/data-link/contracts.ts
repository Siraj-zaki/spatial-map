/**
 * Phase 0 of the Data Plane reshape.
 *
 * Today the data-link layer only knows about one noun (`DataSource`) and
 * one verb (`bin-upsert`). To support assets, sensors, RFID, shipments,
 * cameras, and CV detections in later phases without warping the schema
 * each time, we introduce three contracts here:
 *
 *   Connection  — auth + transport. "How do I reach this system?"
 *   Stream      — a typed feed off a Connection. "What's flowing in?"
 *   Binding     — how each record lands on the map. "What do I do with it?"
 *
 * In Phase 0 every Connection+Stream pair mirrors an existing DataSource
 * 1:1 and the `bin-upsert` binding is the only one wired through the
 * commit pipeline. Phase 1+ adds non-bin entity types and richer
 * bindings (point-live for moving assets, gauge-on-shape for sensors,
 * heatmap for RFID density, …) by *adding* new variants here — no
 * breaking changes to existing rows.
 *
 * This file is type-only on purpose. Dexie wiring lives in `db.ts`; the
 * CRUD service that keeps DataSource ↔ (Connection, Stream) in sync
 * lives in `source-service.ts`.
 */

import type { BindingKind } from '@/lib/db'
import type { DataSourceMapping, DataSourceKind, WebhookSourceConfig } from '@/lib/db'
import type { RestSourceConfig } from './rest-fetcher'

// ============================================================ Connection

/**
 * Transport identifies the protocol family. Phase 0 ships `rest`,
 * `webhook`, and `file` — those mirror the existing DataSource kinds.
 * The other variants are reserved so Phase 1+ can land MQTT/WS/SFTP/DB
 * connectors as additive enum values without breaking persisted rows.
 */
export type ConnectionTransport =
  | 'rest'
  | 'webhook'
  | 'file'
  | 'mqtt'
  | 'ws'
  | 'sftp'
  | 'db'

/**
 * Auth modes the Connection itself owns. A Stream off this Connection
 * inherits the auth unless it overrides at the endpoint level (today no
 * stream overrides — kept simple for Phase 0).
 *
 * The shape mirrors what's already persisted on `DataSource.config` for
 * REST sources so the projection helpers below are lossless.
 */
export type ConnectionAuth =
  | { mode: 'none' }
  | { mode: 'apiKey'; value: string; headerName?: string }
  | { mode: 'bearer'; token: string }
  | { mode: 'hmac'; secret: string }
  | { mode: 'custom'; headers: Record<string, string> }

/**
 * Transport-specific config bag. Stored as an unknown record on disk;
 * the discriminated union below is the *typed* read-view callers should
 * use after narrowing on `transport`.
 *
 * Phase 0 only persists `rest`, `webhook`, `file` shapes — others are
 * declared so Phase 1+ schemas slot in additively.
 */
export type ConnectionConfig =
  | { transport: 'rest'; baseUrl?: string }
  | { transport: 'webhook'; workerBaseUrl: string; drainApiKey: string }
  | { transport: 'file' }
  | { transport: 'mqtt'; brokerUrl: string; clientIdPrefix?: string }
  | { transport: 'ws'; url: string }
  | { transport: 'sftp'; host: string; port?: number; rootPath?: string }
  | { transport: 'db'; dsn: string }

export interface Connection {
  id?: number
  name: string
  transport: ConnectionTransport
  auth: ConnectionAuth
  /** Transport-specific config — match against `transport` for the typed shape. */
  config: Record<string, unknown>
  /** Phase 7d — owning tenant. Undefined means "all tenants" (rare; legacy rows). */
  tenantId?: number
  createdAt: Date
  updatedAt: Date
}

// ================================================================ Stream

/**
 * Which domain entity the stream carries. Phase 0 only emits `'bin'`.
 * Later phases land the rest:
 *   Phase 1 → 'asset'
 *   Phase 2 → 'sensor', 'sensor-reading'
 *   Phase 3 → 'rfid-tag'
 *   Phase 4 → 'shipment'
 *   Phase 5 → 'camera', 'cv-detection'
 */
export type EntityType =
  | 'bin'
  | 'asset'
  | 'sensor'
  | 'sensor-reading'
  | 'rfid-tag'
  | 'shipment'
  | 'camera'
  | 'cv-detection'

/**
 * State streams upsert into a state table (Bin, Asset.currentPosition,
 * Shipment status). Event streams append to a time-indexed log (sensor
 * readings, RFID reads, CV detections). The commit pipeline picks the
 * verb from this discriminator, not from the entity type — `asset` can
 * be either a `state` stream (current position) or an `event` stream
 * (full trajectory log).
 */
export type StreamKind = 'state' | 'event'

/**
 * How a record lands on the map. Phase 0 only emits `bin-upsert`;
 * subsequent kinds are placeholders to keep the union closed and let
 * the Binding-dispatcher switch be exhaustive from day one.
 */
export type Binding =
  | {
      /** Existing behaviour: write rows to the `bins` table per saved mapping. */
      kind: 'bin-upsert'
      /** Column-to-target mapping (same shape as `DataSource.mapping`). */
      mapping: DataSourceMapping
    }
  | {
      /** Phase 1 — moving marker. One entity = one record at a time. */
      kind: 'point-live'
      entityIdField: string
      latField: string
      lngField: string
      headingField?: string
      speedField?: string
      labelField?: string
    }
  | {
      /** Phase 1 — moving marker with breadcrumb. */
      kind: 'point-trail'
      entityIdField: string
      latField: string
      lngField: string
      trailSeconds: number
    }
  | {
      /** Phase 2 — paints a bound shape from the latest event value. */
      kind: 'region-overlay'
      shapeIdField: string
      valueField: string
    }
  | {
      /** Phase 3 — density / dwell-time tile painted from many events. */
      kind: 'heatmap'
      latField: string
      lngField: string
      weightField?: string
    }
  | {
      /** Phase 5 — pulse / count on a bound region of interest. */
      kind: 'roi'
      shapeIdField: string
      valueField?: string
    }
  | {
      /**
       * Phase 4 — shipment / truck. The wire format carries any subset
       * of {state, position, route, door}; the service stamps the
       * non-null fields onto the row. Field names are mostly fixed at
       * Phase 4a — Phase 4b can add per-stream remapping if a customer
       * publisher uses different names.
       */
      kind: 'shipment-track'
      shipmentIdField: string
      stateField?: string
      latField?: string
      lngField?: string
      doorIdField?: string
    }
  | {
      /**
       * Phase 5 — camera + CV detections. One binding covers both
       * envelopes the stream might emit; the service tries the camera
       * coercer first, then the cv-detection coercer.
       *
       * Field-name mapping is intentionally absent — the camera and
       * detection wire formats are narrow enough that we standardise
       * on fixed names at Phase 5a. Phase 5b can add overrides if a
       * customer ships a different ML pipeline output.
       */
      kind: 'camera-fov'
    }
  | {
      /**
       * Phase 6 — opts a REST stream into outbound writes back to its
       * source endpoint. The base bin-upsert pipeline still ingests
       * forward; this variant flags that SPA mutations should also
       * flow as POST/PATCH back to the URL on the stream's endpoint.
       */
      kind: 'bin-write-back'
      mapping: import('@/lib/db').DataSourceMapping
      method?: 'POST' | 'PATCH' | 'PUT'
    }

/**
 * Per-stream addressing within a Connection. A REST Connection might
 * back N streams, each hitting a different sub-path; a webhook
 * Connection's streams differ by sourceToken; a file Connection's
 * stream is the one-shot import history.
 *
 * The persisted shape is `Record<string, unknown>` so adding a new
 * transport doesn't require a migration; consumers narrow on
 * `transport` to read the typed fields.
 */
export type StreamEndpoint =
  | {
      transport: 'rest'
      url: string
      method?: 'GET' | 'POST'
      body?: string
      rootPath?: string
      responseFormat?: 'json' | 'csv' | 'geojson'
    }
  | {
      transport: 'webhook'
      sourceToken: string
      hmacSecret: string
      pollIntervalSec?: number
      lastEventAt?: Date
    }
  | {
      transport: 'file'
      fileName?: string
      fileSize?: number
      featureCount?: number
      sheetName?: string
      sheetNames?: string[]
    }
  | { transport: 'mqtt'; topic: string; qos?: 0 | 1 | 2 }
  | { transport: 'ws'; path?: string }

export interface Stream {
  id?: number
  connectionId: number
  /** Mirrors the original `DataSource.id` so callers can correlate during Phase 0. */
  dataSourceId?: number
  name: string
  entityType: EntityType
  kind: StreamKind
  binding: Binding
  endpoint: Record<string, unknown>
  /** Optional warehouse scope — same semantics as DataSource.zoneId today. */
  zoneId?: number
  /** Phase 7d — owning tenant. */
  tenantId?: number
  schedule?: 'manual' | 'on-load' | 'interval'
  intervalSeconds?: number
  lastRunAt?: Date
  lastResult?: 'ok' | 'error' | 'partial' | 'empty'
  createdAt: Date
  updatedAt: Date
}

// ========================================================== Projections

/**
 * Helper applied during the v15 migration and inside the service layer.
 * Decomposes a legacy `DataSource` row into the Connection + Stream
 * pair that represents the same thing in the new contracts.
 *
 * The Connection name is "Source - <name>" when shared with the
 * Stream name, so users still see a single label in the existing UI.
 * Phase 0 emits one Connection per DataSource (no sharing); Phase 1+
 * may de-dupe Connections by `{ transport, auth, baseUrl }`.
 */
export function pairFromDataSource(source: {
  id?: number
  name: string
  kind: DataSourceKind
  config: Record<string, unknown>
  mapping: DataSourceMapping
  zoneId?: number
  schedule?: 'manual' | 'on-load' | 'interval'
  intervalSeconds?: number
  lastRunAt?: Date
  lastResult?: 'ok' | 'error' | 'partial' | 'empty'
  createdAt: Date
  updatedAt: Date
}): { connection: Omit<Connection, 'id'>; stream: Omit<Stream, 'id' | 'connectionId'> } {
  const transport = transportFromKind(source.kind)
  const auth = authFromConfig(source.kind, source.config)
  const connectionConfig = connectionConfigFromSource(source.kind, source.config)
  const endpoint = endpointFromSource(source.kind, source.config)

  return {
    connection: {
      name: source.name,
      transport,
      auth,
      config: connectionConfig,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    },
    stream: {
      dataSourceId: source.id,
      name: source.name,
      entityType: 'bin',
      kind: 'state',
      binding: { kind: 'bin-upsert', mapping: source.mapping },
      endpoint,
      zoneId: source.zoneId,
      schedule: source.schedule,
      intervalSeconds: source.intervalSeconds,
      lastRunAt: source.lastRunAt,
      lastResult: source.lastResult,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    },
  }
}

/**
 * Reverse projection used by the service layer when only a Stream is in
 * hand and a DataSource patch needs to be written. Phase 0 always
 * round-trips through this helper to keep the legacy table in sync.
 */
export function dataSourceFromPair(connection: Connection, stream: Stream): {
  name: string
  kind: DataSourceKind
  config: Record<string, unknown>
  mapping: DataSourceMapping
  zoneId?: number
  schedule?: 'manual' | 'on-load' | 'interval'
  intervalSeconds?: number
  lastRunAt?: Date
  lastResult?: 'ok' | 'error' | 'partial' | 'empty'
  createdAt: Date
  updatedAt: Date
} {
  const kind = kindFromTransport(connection.transport)
  const config = legacyConfigFromPair(connection, stream)
  const mapping =
    stream.binding.kind === 'bin-upsert'
      ? stream.binding.mapping
      : { fields: {} } // non-bin streams don't round-trip into DataSource
  return {
    name: stream.name,
    kind,
    config,
    mapping,
    zoneId: stream.zoneId,
    schedule: stream.schedule,
    intervalSeconds: stream.intervalSeconds,
    lastRunAt: stream.lastRunAt,
    lastResult: stream.lastResult,
    createdAt: stream.createdAt,
    updatedAt: stream.updatedAt,
  }
}

// =============================================== private projection bits

function transportFromKind(kind: DataSourceKind): ConnectionTransport {
  if (kind === 'rest') return 'rest'
  if (kind === 'webhook') return 'webhook'
  return 'file'
}

function kindFromTransport(transport: ConnectionTransport): DataSourceKind {
  // Phase 0 only persists 'rest' | 'webhook' | 'file' transports.
  // Non-bin transports (mqtt/ws/sftp/db) won't have a DataSource
  // mirror — callers are responsible for not invoking this projection
  // for those (they're for Phase 1+ entity types that bypass the
  // legacy table entirely).
  if (transport === 'rest') return 'rest'
  if (transport === 'webhook') return 'webhook'
  // Best-effort default — file streams keep their original kind via
  // the legacy DataSource row, so the service layer never reaches here
  // for an existing file source. Anything else is a Phase 1+ stream
  // and won't be written back to dataSources.
  return 'csv'
}

function authFromConfig(
  kind: DataSourceKind,
  config: Record<string, unknown>,
): ConnectionAuth {
  if (kind === 'rest') {
    const cfg = config as Partial<RestSourceConfig>
    const mode = cfg.authMode ?? 'custom'
    if (mode === 'none') return { mode: 'none' }
    if (mode === 'apiKey') return { mode: 'apiKey', value: cfg.apiKey ?? '' }
    if (mode === 'bearer') return { mode: 'bearer', token: cfg.bearerToken ?? '' }
    return { mode: 'custom', headers: { ...(cfg.headers ?? {}) } }
  }
  if (kind === 'webhook') {
    const cfg = config as Partial<WebhookSourceConfig>
    return { mode: 'hmac', secret: cfg.hmacSecret ?? '' }
  }
  return { mode: 'none' }
}

function connectionConfigFromSource(
  kind: DataSourceKind,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === 'webhook') {
    const cfg = config as Partial<WebhookSourceConfig>
    return {
      transport: 'webhook' as const,
      workerBaseUrl: cfg.workerBaseUrl ?? '',
      drainApiKey: cfg.drainApiKey ?? '',
    }
  }
  if (kind === 'rest') {
    // No baseUrl extraction — each stream carries the full URL today.
    return { transport: 'rest' as const }
  }
  return { transport: 'file' as const }
}

function endpointFromSource(
  kind: DataSourceKind,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === 'rest') {
    const cfg = config as Partial<RestSourceConfig>
    return {
      transport: 'rest' as const,
      url: cfg.url ?? '',
      method: cfg.method,
      body: cfg.body,
      rootPath: cfg.rootPath,
      responseFormat: cfg.responseFormat,
    }
  }
  if (kind === 'webhook') {
    const cfg = config as Partial<WebhookSourceConfig>
    return {
      transport: 'webhook' as const,
      sourceToken: cfg.sourceToken ?? '',
      hmacSecret: cfg.hmacSecret ?? '',
      pollIntervalSec: cfg.pollIntervalSec,
      lastEventAt: cfg.lastEventAt,
    }
  }
  // File-backed: preserve the metadata the import wizard wrote.
  return {
    transport: 'file' as const,
    ...config,
  }
}

/**
 * Rebuild the legacy `DataSource.config` shape from a Connection+Stream
 * pair so the dual-write keeps the old table semantically valid.
 */
function legacyConfigFromPair(
  connection: Connection,
  stream: Stream,
): Record<string, unknown> {
  const endpoint = stream.endpoint as { transport?: string }
  if (connection.transport === 'rest' && endpoint.transport === 'rest') {
    const ep = stream.endpoint as Extract<StreamEndpoint, { transport: 'rest' }>
    const cfg: Partial<RestSourceConfig> = {
      url: ep.url,
      method: ep.method,
      body: ep.body,
      rootPath: ep.rootPath,
      responseFormat: ep.responseFormat,
      authMode:
        connection.auth.mode === 'none'
          ? 'none'
          : connection.auth.mode === 'apiKey'
            ? 'apiKey'
            : connection.auth.mode === 'bearer'
              ? 'bearer'
              : 'custom',
      apiKey: connection.auth.mode === 'apiKey' ? connection.auth.value : undefined,
      bearerToken:
        connection.auth.mode === 'bearer' ? connection.auth.token : undefined,
      headers:
        connection.auth.mode === 'custom' ? { ...connection.auth.headers } : undefined,
    }
    return cfg as Record<string, unknown>
  }
  if (connection.transport === 'webhook' && endpoint.transport === 'webhook') {
    const conn = connection.config as Extract<ConnectionConfig, { transport: 'webhook' }>
    const ep = stream.endpoint as Extract<StreamEndpoint, { transport: 'webhook' }>
    const cfg: WebhookSourceConfig = {
      workerBaseUrl: conn.workerBaseUrl,
      drainApiKey: conn.drainApiKey,
      sourceToken: ep.sourceToken,
      hmacSecret: ep.hmacSecret,
      pollIntervalSec: ep.pollIntervalSec,
      lastEventAt: ep.lastEventAt,
    }
    return cfg as unknown as Record<string, unknown>
  }
  // File-backed: the endpoint already holds the original config blob.
  const { transport: _t, ...rest } = stream.endpoint as Record<string, unknown> & {
    transport?: string
  }
  return rest
}

// =================================================================== misc

/**
 * Phase 1+ scope check — narrows whether a `targetKind` from the bin
 * model is something the new Binding union should still accept. Kept
 * here (not in `db.ts`) so the contracts file owns the entity-type
 * surface independent of the persistence layer.
 */
export function isBinTargetKind(value: BindingKind): boolean {
  return (
    value === 'grid-cell' ||
    value === 'polygon' ||
    value === 'circle' ||
    value === 'line' ||
    value === 'marker' ||
    value === 'image' ||
    value === 'model'
  )
}
