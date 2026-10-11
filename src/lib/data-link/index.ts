/**
 * Public surface for the Data-Link Layer.
 *
 * Phase 1 ships:
 *   - CSV parsing (PapaParse main-thread)
 *   - 3 match strategies (externalCode, gridCellAddress, shapeName)
 *   - Preview + transactional commit
 *   - Attribute auto-definition
 *
 * Phase 2 adds:
 *   - XLSX parsing (SheetJS) — first non-empty sheet by default
 *   - `parseFile()` dispatcher — pipeline is format-agnostic from here
 *
 * Upcoming phases will add json / geojson adapters and a worker-relay
 * for incoming webhooks; the public API here is shaped so those land
 * as additive exports.
 */

export { parseCsvFile, suggestFieldTarget, CsvParseError } from './csv-parser'
export type { SuggestedTarget } from './csv-parser'
export { parseXlsxFile, XlsxParseError } from './xlsx-parser'
export type { XlsxParseOptions } from './xlsx-parser'
export { parseJsonFile, JsonParseError } from './json-parser'
export type { JsonParseOptions } from './json-parser'
export { parseGeoJsonFile, GeoJsonParseError } from './geojson-parser'
export type {
  ParsedGeoJson,
  ProcessedGeoJsonFeature,
  GeoJsonShapeKind,
} from './geojson-parser'
export { previewShapeImport, commitShapeImport } from './geojson-importer'
export type {
  ShapeImportPlan,
  ShapeImportPreview,
  ShapeImportPreviewEntry,
  ShapeImportSummary,
} from './geojson-importer'
export { parseFile, detectFileKind, UnsupportedFormatError } from './parse-file'
export { fetchRestSource, RestFetchError } from './rest-fetcher'
export type { RestSourceConfig } from './rest-fetcher'
export {
  drainWebhookSource,
  registerWebhookSource,
  WebhookFetchError,
} from './webhook-fetcher'
export type { DrainSummary } from './webhook-fetcher'
export { rerunDataSource, RerunError, resultOf } from './rerun'
export { useDataSourceScheduler } from './scheduler'
export {
  createBinSource,
  updateBinSource,
  deleteBinSource,
  stampSourceRun,
  updateSourceMapping,
  getMergeMode,
  setMergeMode,
  IntegrationLinkedError,
  isIntegrationLinkedError,
  formatIntegrationLinkedMessage,
} from './source-service'
export type { MergeMode, LinkedDataLinkConfigRef } from './source-service'
// Slice 6c2 of the data-link refactor removed the five per-entity
// service files (asset / sensor / camera / rfid / shipment). The
// generic entity_states + entity_events tables and their ingest
// endpoint replace them. Consumers that need to list live records
// tenant-wide call `listAllEntityStatesForTenant()`; per-stream views
// use `listEntityStatesForStream()` / `listEntityEventsForStream()`
// from `entity-state-service`.
export {
  listEntityStatesForStream,
  listEntityEventsForStream,
  listAllEntityStatesForTenant,
} from './entity-state-service'
export type { EntityStateWithStream } from './entity-state-service'
export {
  addReference,
  upsertReference,
  deleteReference,
  deleteReferencesForStream,
  listReferences,
  referencesFrom,
  referencesTo,
  resolveReference,
  resolveReferenceChain,
  resolveReferenceLabels,
} from './reference-service'
export {
  pushOutboundPatch,
  recentAudit,
  deleteAuditForStream,
  editBinWithOutbound,
  OutboundError,
} from './outbound-service'
export type { OutboundPatchInput, OutboundResult } from './outbound-service'
export { useLiveStreamHealth } from './live-stream-health'
export type { StreamHealth, StreamHealthSample } from './live-stream-health'
export {
  replayController,
  useReplayState,
} from './replay-controller'
export type { ReplayState } from './replay-controller'
export { runReplay, fetchHistoricalEvents, ReplayError } from './replay-service'
export { getStreamMessageHandler } from './live-stream-client'
export { useCorrelationEngine } from './correlation-engine'
// Tenant CRUD helpers (createTenant/renameTenant/setTenantColor/
// deleteTenant/listTenants) and the composite `useCurrentTenant()` hook
// were retired alongside the Integrations page's legacy "Tenants" tab —
// workspace mutations now flow through `@/lib/workspace-client`, and
// callers that need the full projection read `useAuthStore.tenants`.
// The remaining re-exports are the read-side helpers still used by
// data-link scheduling + live-stream health.
export {
  getCurrentTenantId,
  setCurrentTenantId,
  useCurrentTenantId,
} from './tenant-service'
export {
  LiveStreamClient,
  LiveStreamRegisterError,
  useLiveStreamScheduler,
  resolveStreamApiKey,
  registerLiveStream,
} from './live-stream-client'
export type { LiveStreamClientOptions } from './live-stream-client'
export {
  pairFromDataSource,
  dataSourceFromPair,
  isBinTargetKind,
} from './contracts'
export type {
  Connection,
  ConnectionAuth,
  ConnectionConfig,
  ConnectionTransport,
  Stream,
  StreamEndpoint,
  StreamKind,
  EntityType,
  Binding,
} from './contracts'
export type { FileKind } from './parse-file'
export { resolveTarget } from './target-resolver'
export { previewImport, previewImportCsv, commitImport } from './importer'
export type {
  CsvRow,
  ParsedFile,
  ParsedFileMeta,
  MatchStrategy,
  FieldTarget,
  ImportPlan,
  ResolvedTarget,
  PreviewRow,
  PreviewResult,
  ImportSummary,
} from './types'
export { coerceBinStatus } from './types'
export { formatAttributeValue } from './attribute-defs'
export {
  resolveMatchTargets,
  resolvePayloadCoord,
  effectiveMatch,
  normalizeKey,
  readPayloadPath,
} from './match-resolver'
export type {
  MatchResult,
  MatchStoreSnapshot,
  MatchableShape,
} from './match-resolver'
export {
  subscribeDataLinkClicks,
  emitDataLinkClick,
} from './data-link-events'
export type { DataLinkClickEvent } from './data-link-events'
export {
  listRowsForSource,
  getRowForSource,
  clearRowsForSource,
} from './data-source-rows'
export type { DataSourceRow } from './data-source-rows'
export { fetchLayerRows } from './layer-rows'
