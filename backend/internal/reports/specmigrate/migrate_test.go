package specmigrate

import (
	"encoding/json"
	"testing"

	v2 "github.com/Siraj-zaki/spatial-map/backend/internal/reports/v2"
)

func TestFromRaw_V1_Basic(t *testing.T) {
	raw := json.RawMessage(`{
		"sources": [{"kind":"dataSource","id":42}],
		"groupBy": ["status"],
		"metrics": [{"fn":"count","as":"total"}],
		"widgets": [
			{"id":"w1","kind":"kpi","title":"Total","bindings":{"value":"total"}},
			{"id":"w2","kind":"table"}
		]
	}`)
	res, err := FromRaw(raw, 1)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !res.Migrated {
		t.Errorf("expected Migrated=true for v1 input")
	}
	if res.Spec.V != v2.SpecVersion {
		t.Errorf("V = %d, want %d", res.Spec.V, v2.SpecVersion)
	}
	if len(res.Spec.Queries) != 1 || res.Spec.Queries[0].Name != mainQueryName {
		t.Errorf("expected single 'main' query, got %#v", res.Spec.Queries)
	}
	if res.Spec.Queries[0].SourceRef.ID != 42 {
		t.Errorf("source id lost: %d", res.Spec.Queries[0].SourceRef.ID)
	}
	if len(res.Spec.Widgets) != 2 {
		t.Fatalf("expected 2 widgets, got %d", len(res.Spec.Widgets))
	}
	if res.Spec.Widgets[0].QueryRef != mainQueryName {
		t.Errorf("kpi widget should reference main query, got %q", res.Spec.Widgets[0].QueryRef)
	}
	if res.Spec.Widgets[0].Position.W != defaultCols {
		t.Errorf("v1 widgets should span the full width, got W=%d", res.Spec.Widgets[0].Position.W)
	}
	if res.Spec.Widgets[1].Position.Y == 0 {
		t.Errorf("second widget should stack below first, got Y=0")
	}
	if res.Spec.Layout.Cols != defaultCols {
		t.Errorf("layout cols = %d, want %d", res.Spec.Layout.Cols, defaultCols)
	}
}

func TestFromRaw_V1_PresentationOnlyWidgetsHaveNoQueryRef(t *testing.T) {
	raw := json.RawMessage(`{
		"sources": [{"kind":"dataSource","id":1}],
		"widgets": [{"id":"md","kind":"markdown","bindings":{"content":"hi"}}]
	}`)
	res, err := FromRaw(raw, 1)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Spec.Widgets[0].QueryRef != "" {
		t.Errorf("markdown widget should not have a queryRef, got %q", res.Spec.Widgets[0].QueryRef)
	}
}

func TestFromRaw_V1_PromptFiltersPromoteToParams(t *testing.T) {
	raw := json.RawMessage(`{
		"sources": [{"kind":"dataSource","id":1}],
		"filters": {"and":[
			{"cond":{"field":"status","op":"eq","value":""}},
			{"cond":{"field":"region","op":"eq","value":""}}
		]}
	}`)
	res, err := FromRaw(raw, 1)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(res.Spec.Params) != 2 {
		t.Fatalf("expected 2 params promoted, got %d: %#v", len(res.Spec.Params), res.Spec.Params)
	}
	ids := map[string]bool{}
	for _, p := range res.Spec.Params {
		ids[p.ID] = true
		if p.Input.Kind != "textInput" {
			t.Errorf("promoted param should be textInput, got %q", p.Input.Kind)
		}
	}
	if !ids["status"] || !ids["region"] {
		t.Errorf("expected status+region params, got %#v", ids)
	}
	// Value slots should now reference the params.
	q := res.Spec.Queries[0]
	found := 0
	for _, arm := range q.Filters.And {
		if arm.Cond != nil {
			if v := string(arm.Cond.Value); v == `"{{param.status}}"` || v == `"{{param.region}}"` {
				found++
			}
		}
	}
	if found != 2 {
		t.Errorf("expected 2 value slots rewritten to markers, found %d", found)
	}
}

func TestFromRaw_V2_PassThrough(t *testing.T) {
	raw := json.RawMessage(`{
		"v": 2,
		"sources": [{"kind":"dataSource","id":7}],
		"queries": [{"name":"m","sourceRef":{"kind":"dataSource","id":7}}],
		"widgets": []
	}`)
	res, err := FromRaw(raw, 2)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Migrated {
		t.Error("Migrated should be false for a v2 input")
	}
	if len(res.Spec.Queries) != 1 || res.Spec.Queries[0].Name != "m" {
		t.Errorf("v2 pass-through lost data: %#v", res.Spec.Queries)
	}
}

func TestFromRaw_V2_Idempotent(t *testing.T) {
	// v1 → v2 → v2 should equal one-shot v1 → v2
	v1raw := json.RawMessage(`{
		"sources": [{"kind":"dataSource","id":9}],
		"metrics": [{"fn":"count","as":"n"}]
	}`)
	first, err := FromRaw(v1raw, 1)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	roundBytes, err := json.Marshal(first.Spec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	second, err := FromRaw(roundBytes, 2)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if second.Migrated {
		t.Error("second pass should not migrate")
	}
	if !specsEqual(first.Spec, second.Spec) {
		t.Errorf("idempotency broken\n first:  %+v\n second: %+v", first.Spec, second.Spec)
	}
}

func TestFromRaw_EmptyBlobIsEmptyV2(t *testing.T) {
	res, err := FromRaw(nil, 1)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.Spec.V != v2.SpecVersion {
		t.Errorf("V = %d, want %d", res.Spec.V, v2.SpecVersion)
	}
	if len(res.Spec.Queries) != 0 || len(res.Spec.Widgets) != 0 {
		t.Errorf("empty v1 should produce empty v2, got %+v", res.Spec)
	}
}

// specsEqual is a shallow byte-compare via JSON round-trip.
func specsEqual(a, b v2.Spec) bool {
	ba, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ba) == string(bb)
}
