/**
 * Predicate — the typed WHERE-fragment structure DimensionGrid emits.
 * Wire-compatible with the backend's `queryx.Predicate` (see
 * `backend/internal/queryx/predicate.go`). Values ride as JSON-encoded
 * strings so the server can decode them exactly like any other filter
 * value.
 */
export interface Predicate {
  combine?: 'AND' | 'OR'
  columns?: PredicateColumn[]
}

export interface PredicateColumn {
  field: string
  op?: string
  /** JSON-encoded scalar values (e.g. `"\"active\""`, `"5"`). The
   *  backend decodes each entry with ScalarArg semantics. */
  values?: string[]
}
