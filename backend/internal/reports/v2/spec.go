// Package v2 holds the v2 report spec — the schema every persisted
// report row will hold after the v1→v2 one-shot migration lands. v2
// factors the old single-implicit-query shape into named queries,
// typed parameters, a layout grid, and widgets that reference queries
// by name — the Evidence-inspired model.
//
// The types here are intentionally permissive at the JSON layer;
// validation and safety happen at compile time in
// [github.com/Siraj-zaki/spatial-map/backend/internal/reports/executor.go]
// and the shared [github.com/Siraj-zaki/spatial-map/backend/internal/queryx]
// kernel.
package v2

import (
	"encoding/json"

	"github.com/Siraj-zaki/spatial-map/backend/internal/queryx"
)

// SpecVersion is the version stored in `reports.spec_version` for
// every v2 row. Older rows are converted by
// [github.com/Siraj-zaki/spatial-map/backend/internal/reports/specmigrate]
// during the one-shot migration cmd.
const SpecVersion = 2

// Spec is the top-level v2 report/dashboard document. Persisted as
// JSONB inside `reports.spec`.
type Spec struct {
	// V is redundantly present at the JSON layer so a consumer can
	// discriminate v1 from v2 without inspecting the parent row's
	// spec_version column.
	V int `json:"v"`

	Sources []SourceRef `json:"sources,omitempty"`
	Params  []Param     `json:"params,omitempty"`
	Queries []Query     `json:"queries,omitempty"`
	Layout  Layout      `json:"layout,omitempty"`
	Widgets []Widget    `json:"widgets,omitempty"`

	// Presentation is optional cosmetic settings kept for parity with
	// v1 (`presentation` was unused by the executor; the builder can
	// still write here for the viewer chrome).
	Presentation json.RawMessage `json:"presentation,omitempty"`
}

// SourceRef points at a `data_sources` row. Kept structurally identical
// to the v1 shape so migration is a no-op for the sources list.
type SourceRef struct {
	Kind string `json:"kind"` // "table" | "dataSource"
	ID   int64  `json:"id"`
}

// Param is a typed runtime input the viewer surfaces (dropdown,
// dateRange, slider, dimensionGrid, ...). Its resolved value flows
// into queries via `{{param.<id>}}` interpolation.
type Param struct {
	// ID is the stable key used in URLs (`?<id>=value`) and in
	// `{{param.<id>}}` references. Must be a valid identifier.
	ID string `json:"id"`

	// Label is the user-facing string (i18n key resolved on the
	// frontend; the backend echoes it verbatim).
	Label string `json:"label,omitempty"`

	Input ParamInput `json:"input"`

	// DefaultValue is used when the URL doesn't carry a value AND
	// DefaultFromQuery didn't fire. Shape depends on the input kind.
	DefaultValue json.RawMessage `json:"defaultValue,omitempty"`

	// DefaultFromQuery lets the viewer compute a default from a query
	// result (e.g. "pick the first status"). Runs after the query
	// completes; overrides DefaultValue only when the viewer hasn't
	// interacted with the param and the URL doesn't carry it either.
	DefaultFromQuery *DefaultFromQuery `json:"defaultFromQuery,omitempty"`

	// URLPersist controls whether the viewer syncs this param to the
	// browser URL. Defaults to true (nil = true) — set to false for
	// throwaway UI-only inputs.
	URLPersist *bool `json:"urlPersist,omitempty"`
}

// ParamInput carries the per-input-kind configuration. The `Kind`
// discriminator drives which of the remaining fields are meaningful.
type ParamInput struct {
	Kind string `json:"kind"` // dropdown|buttonGroup|dateRange|dateInput|slider|textInput|dimensionGrid|checkbox

	// Options is populated for dropdown / buttonGroup / dimensionGrid.
	Options *OptionSource `json:"options,omitempty"`

	// Multi enables multi-select for dropdown. Ignored on other kinds.
	Multi bool `json:"multi,omitempty"`

	// Presets is populated for dateRange to expose canned windows
	// ("last 7 days" etc.). Values are string identifiers the viewer
	// interprets locally.
	Presets []string `json:"presets,omitempty"`

	// Granularity is populated for dateInput ("day" | "month" | "year").
	Granularity string `json:"granularity,omitempty"`

	// Min / Max / Step are populated for slider.
	Min  *float64 `json:"min,omitempty"`
	Max  *float64 `json:"max,omitempty"`
	Step *float64 `json:"step,omitempty"`

	// Placeholder is used by textInput.
	Placeholder string `json:"placeholder,omitempty"`

	// Columns lists the fields dimensionGrid pivots on. Each column
	// becomes one tile of the grid.
	Columns []string `json:"columns,omitempty"`

	// SourceRef optionally binds the input to a data source (used by
	// dimensionGrid when the option universe comes directly from
	// a source's distinct payload values, bypassing a named query).
	SourceRef *SourceRef `json:"sourceRef,omitempty"`
}

// OptionSource describes where the option universe for
// dropdown/buttonGroup/dimensionGrid comes from.
type OptionSource struct {
	// Static is a fixed list of {value, label} pairs.
	Static []Option `json:"static,omitempty"`

	// FromQuery references a named query whose result rows supply the
	// options. ValueColumn and LabelColumn are column names in that
	// query's result.
	FromQuery   string `json:"fromQuery,omitempty"`
	ValueColumn string `json:"valueColumn,omitempty"`
	LabelColumn string `json:"labelColumn,omitempty"`
}

// Option is a single {value, label} pair for a static option source.
type Option struct {
	Value json.RawMessage `json:"value"`
	Label string          `json:"label"`
}

// DefaultFromQuery is the "compute a default from data" descriptor.
type DefaultFromQuery struct {
	Query  string `json:"query"`
	Column string `json:"column"`
	Reduce string `json:"reduce,omitempty"` // "first" | "min" | "max"
}

// Query is one named query in the dashboard. Every widget references
// a query by name; queries reference params via
// `{{param.<id>}}` inside filter values (bound as `$N`) or inside
// [Query.ExtraFilter] (rendered inline via the interpolate engine).
type Query struct {
	// Name is the stable key widgets reference. Must be a valid
	// identifier.
	Name string `json:"name"`

	// SourceRef binds this query to one data source. v2 supports one
	// source per query (matching the v1 executor's constraint).
	SourceRef SourceRef `json:"sourceRef"`

	// Filters / GroupBy / Metrics / Sort / Limit reuse the v1 shape
	// via the shared queryx kernel — no changes required for these
	// core primitives.
	Filters *queryx.Node `json:"filters,omitempty"`
	GroupBy []string     `json:"groupBy,omitempty"`
	Metrics []Metric     `json:"metrics,omitempty"`
	Sort    []SortKey    `json:"sort,omitempty"`
	Limit   int          `json:"limit,omitempty"`
	Offset  int          `json:"offset,omitempty"`

	// ExtraFilter is an optional SQL fragment template — the ONLY place
	// a caller can embed a WHERE fragment that isn't fully composed
	// from typed conds. It's the DimensionGrid predicate slot:
	// `[[ {{param.selection}} ]]`. Anything else is rejected by the
	// interpolation engine.
	ExtraFilter string `json:"extraFilter,omitempty"`

	// ParamRefs (optional) is an explicit listing of the params this
	// query depends on. When present the runtime skips the template
	// scan and trusts this list. When absent the runtime scans
	// Filters + ExtraFilter for `{{param.x}}` markers.
	ParamRefs []string `json:"paramRefs,omitempty"`
}

// Metric is one aggregation column — identical to the v1 shape.
type Metric struct {
	Fn    string `json:"fn"`
	Field string `json:"field,omitempty"`
	As    string `json:"as"`
}

// SortKey is one ORDER BY entry — identical to the v1 shape.
type SortKey struct {
	Field string `json:"field"`
	Dir   string `json:"dir"`
}

// Layout describes the grid canvas the widgets sit on.
type Layout struct {
	// Kind is currently always "grid" — leaving the discriminator open
	// for a future "print" or "story" layout.
	Kind string `json:"kind,omitempty"`

	// Cols is the grid track count. Defaults to 12 (Bootstrap-style).
	Cols int `json:"cols,omitempty"`

	// RowHeightPx and GapPx tune the canvas metrics.
	RowHeightPx int `json:"rowHeightPx,omitempty"`
	GapPx       int `json:"gapPx,omitempty"`

	// MobileBreakpointPx is the viewport width below which widgets
	// stack full-width (auto-stack). Defaults to 640 (Tailwind sm).
	MobileBreakpointPx int `json:"mobileBreakpointPx,omitempty"`
}

// Widget is one placed cell on the canvas. Widgets pick their data by
// referencing a query name; presentation-only widgets (markdown, note,
// divider, alert) have no QueryRef.
type Widget struct {
	// ID is stable within the dashboard — used for key stability in
	// the frontend list and for cross-filter targeting.
	ID string `json:"id"`

	// Kind is the widget flavour (kpi | bigValue | table | dataTable |
	// line | bar | area | pie | donut | scatter | heatmap | sankey |
	// history | map | markdown | note | alert | divider | tabs |
	// accordion | dimensionGrid).
	Kind string `json:"kind"`

	// Title is the widget header (empty = no header rendered).
	Title string `json:"title,omitempty"`

	// QueryRef is the name of the query supplying data. Omitted for
	// presentation-only widget kinds.
	QueryRef string `json:"queryRef,omitempty"`

	// Position places the widget on the grid canvas.
	Position Position `json:"position"`

	// Bindings is the per-widget-kind configuration bag: which columns
	// map to which visual channels, formatting overrides, and (via
	// `onClick`) cross-filter emit rules.
	Bindings json.RawMessage `json:"bindings,omitempty"`

	// Icon / Color are optional visual overrides.
	Icon  string `json:"icon,omitempty"`
	Color string `json:"color,omitempty"`
}

// Position is one widget's rectangle on the grid.
type Position struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}
