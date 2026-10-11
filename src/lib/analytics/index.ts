/**
 * Public surface for the analytics module — pure compute over the bin /
 * grid / zone tables. No Dexie reads here; the caller does the
 * `useLiveQuery` and passes arrays in.
 */

export {
  statusBreakdown,
  capacitySummary,
  rollupByWarehouse,
  statusLabel,
  statusColor,
  type StatusBreakdown,
  type CapacitySummary,
  type WarehouseRollup,
} from './metrics'

export {
  classifyAbc,
  capacityValue,
  valueExtractorFor,
  abcColor,
  type AbcClass,
  type AbcClassStats,
  type AbcEntry,
  type AbcResult,
} from './abc'

export {
  findDeadStock,
  formatAge,
  type DeadStockEntry,
  type DeadStockOptions,
} from './dead-stock'
