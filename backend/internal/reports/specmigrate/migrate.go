// Package specmigrate holds the pure v1 → v2 spec converter used by
// the one-shot `cmd/migrate-reports-to-v2` tool. Handlers assume every
// stored row is already v2 — this package is only invoked at migration
// time and in tests.
//
// v1 was a "single implicit query with widgets on top" shape; v2 has
// named queries + typed params + a grid layout + widgets that
// reference a query by name. The conversion is deterministic and
// idempotent (feeding v2 → v2 is a no-op that returns the input
// verbatim).
package specmigrate

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/queryx"
	v2 "github.com/Siraj-zaki/spatial-map/backend/internal/reports/v2"
)

// Result carries the migration outcome.
type Result struct {
	Spec          v2.Spec
	SourceVersion int
	Migrated      bool // true when a real v1→v2 conversion happened
}

// v1Spec mirrors the pre-v2 report spec shape. Only the fields the
// migrator needs to read are declared; extra fields (presentation)
// are copied verbatim via the passthrough map.
type v1Spec struct {
	Sources      []v2.SourceRef  `json:"sources"`
	Filters      *queryx.Node    `json:"filters,omitempty"`
	GroupBy      []string        `json:"groupBy,omitempty"`
	Metrics      []v2.Metric     `json:"metrics,omitempty"`
	Sort         []v2.SortKey    `json:"sort,omitempty"`
	Limit        int             `json:"limit,omitempty"`
	Offset       int             `json:"offset,omitempty"`
	Widgets      []v1Widget      `json:"widgets,omitempty"`
	Presentation json.RawMessage `json:"presentation,omitempty"`
}

// v1Widget is the pre-v2 widget shape. v1 widgets had no position and
// no query reference — every widget implicitly used the single
// top-level filter/groupBy/metrics as its data source.
type v1Widget struct {
	ID       string          `json:"id"`
	Kind     string          `json:"kind"`
	Title    string          `json:"title,omitempty"`
	Bindings json.RawMessage `json:"bindings,omitempty"`
	Icon     string          `json:"icon,omitempty"`
	Color    string          `json:"color,omitempty"`
}

// mainQueryName is what the migrator names the single query it
// synthesises for a v1 spec — matches the FE migrator so the two
// agree without further coordination.
const mainQueryName = "main"

// defaultCols is the layout track count v2 defaults to. Anything
// larger than 12 exceeds the Bootstrap-family idiom; smaller crowds
// widgets. 12 is the sweet spot for both the desktop grid and the
// mobile-stack fallback.
const defaultCols = 12

// FromRaw takes the raw JSONB blob (plus the stored spec_version
// column) and returns a v2 Spec. Idempotent — a v2 blob feeds
// through unchanged.
func FromRaw(raw json.RawMessage, storedVersion int32) (Result, error) {
	// v2 detection: either the parent row's spec_version says so, or
	// the JSON carries `"v":2`.
	if storedVersion >= v2.SpecVersion {
		var spec v2.Spec
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &spec); err != nil {
				return Result{}, fmt.Errorf("parse v2 spec: %w", err)
			}
		}
		if spec.V == 0 {
			spec.V = v2.SpecVersion
		}
		return Result{Spec: spec, SourceVersion: int(storedVersion), Migrated: false}, nil
	}
	// Some pre-v2 rows may still declare `v:2` inside the JSON if a
	// caller wrote them ahead of the migration; honour that.
	var probe struct {
		V int `json:"v"`
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &probe)
	}
	if probe.V >= v2.SpecVersion {
		var spec v2.Spec
		if err := json.Unmarshal(raw, &spec); err != nil {
			return Result{}, fmt.Errorf("parse v2-shaped spec: %w", err)
		}
		return Result{Spec: spec, SourceVersion: int(storedVersion), Migrated: false}, nil
	}

	// v1 — do the migration.
	var v1 v1Spec
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &v1); err != nil {
			return Result{}, fmt.Errorf("parse v1 spec: %w", err)
		}
	}
	spec := migrateV1ToV2(v1)
	return Result{Spec: spec, SourceVersion: int(storedVersion), Migrated: true}, nil
}

// migrateV1ToV2 is the pure conversion. Exposed only to tests via a
// wrapper so the surface stays intentional.
func migrateV1ToV2(v1 v1Spec) v2.Spec {
	spec := v2.Spec{
		V:            v2.SpecVersion,
		Sources:      v1.Sources,
		Layout:       defaultLayout(),
		Presentation: v1.Presentation,
	}

	// Only synthesise a query when the v1 spec actually referenced a
	// source or had aggregation logic; an empty v1 spec (no source,
	// no widgets) becomes an empty v2 spec.
	needsQuery := len(v1.Sources) > 0 || v1.Filters != nil || len(v1.GroupBy) > 0 || len(v1.Metrics) > 0
	if needsQuery {
		q := v2.Query{
			Name:    mainQueryName,
			Filters: v1.Filters,
			GroupBy: v1.GroupBy,
			Metrics: v1.Metrics,
			Sort:    v1.Sort,
			Limit:   v1.Limit,
			Offset:  v1.Offset,
		}
		if len(v1.Sources) > 0 {
			q.SourceRef = v1.Sources[0]
		}
		spec.Queries = append(spec.Queries, q)

		// Promote prompt-filter placeholders (empty-valued conds) into
		// typed textInput params. Each becomes `param.<field>` and its
		// value slot is rewritten to `"{{param.<field>}}"` so the
		// interpolation engine resolves at run time.
		if v1.Filters != nil {
			paramDedup := map[string]bool{}
			promotePromptFilters(spec.Queries[0].Filters, &spec, paramDedup)
		}
	}

	// Migrate widgets. Every v1 widget references the synthesised
	// query; positions stack single-column top-to-bottom with a
	// generous default height so the imported layout is legible
	// before the user touches it.
	if len(v1.Widgets) > 0 {
		spec.Widgets = make([]v2.Widget, 0, len(v1.Widgets))
		nextY := 0
		for i, w := range v1.Widgets {
			h := defaultWidgetHeight(w.Kind)
			widget := v2.Widget{
				ID:       w.ID,
				Kind:     w.Kind,
				Title:    w.Title,
				Bindings: w.Bindings,
				Icon:     w.Icon,
				Color:    w.Color,
				Position: v2.Position{X: 0, Y: nextY, W: defaultCols, H: h},
			}
			if needsQuery && !isPresentationOnly(w.Kind) {
				widget.QueryRef = mainQueryName
			}
			if widget.ID == "" {
				widget.ID = fmt.Sprintf("w_%d", i+1)
			}
			spec.Widgets = append(spec.Widgets, widget)
			nextY += h
		}
	}

	return spec
}

// defaultLayout returns the 12-col grid the FE renders by default.
func defaultLayout() v2.Layout {
	return v2.Layout{
		Kind:               "grid",
		Cols:               defaultCols,
		RowHeightPx:        48,
		GapPx:              12,
		MobileBreakpointPx: 640,
	}
}

// defaultWidgetHeight is the row-span a fresh v1 widget lands on.
// Tuned so KPIs read at a glance and charts have breathing room.
func defaultWidgetHeight(kind string) int {
	switch kind {
	case "kpi", "bigValue", "divider":
		return 2
	case "markdown", "note", "alert":
		return 3
	case "history":
		return 8
	default:
		return 6
	}
}

// isPresentationOnly reports whether a widget kind renders without
// data (no queryRef needed).
func isPresentationOnly(kind string) bool {
	switch kind {
	case "markdown", "note", "divider", "alert":
		return true
	}
	return false
}

// promotePromptFilters walks the filter tree; for every leaf that
// looks like a "prompt filter" (value-required op with an empty
// value), it declares a matching textInput param and rewrites the
// leaf's value to the interpolation marker. Existing markers are
// left alone.
func promotePromptFilters(n *queryx.Node, spec *v2.Spec, seen map[string]bool) {
	if n == nil {
		return
	}
	for i := range n.And {
		promotePromptFilters(&n.And[i], spec, seen)
	}
	for i := range n.Or {
		promotePromptFilters(&n.Or[i], spec, seen)
	}
	if n.Cond == nil {
		return
	}
	c := n.Cond
	if !queryx.CondIsInactive(*c) {
		return
	}
	op, ok := queryx.ResolveOp(c.Op)
	if !ok {
		return
	}
	if def, ok := queryx.Registry[op]; ok && def.Arity == queryx.ArityNone {
		// isnull / notnull don't need a value — no prompt to promote.
		return
	}
	paramID := paramIDFromField(c.Field)
	if seen[paramID] {
		// Rewrite this leaf to reference the existing param.
		n.Cond.Value = json.RawMessage(`"{{param.` + paramID + `}}"`)
		return
	}
	seen[paramID] = true
	spec.Params = append(spec.Params, v2.Param{
		ID:    paramID,
		Label: c.Field,
		Input: v2.ParamInput{Kind: "textInput"},
	})
	n.Cond.Value = json.RawMessage(`"{{param.` + paramID + `}}"`)
}

// paramIDFromField turns a field key into a legal param id. Dots and
// dashes become underscores so the id stays a single dotless token
// (the interpolation engine treats dots as sub-field selectors).
func paramIDFromField(field string) string {
	var b strings.Builder
	for _, r := range field {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "prompt"
	}
	return b.String()
}
