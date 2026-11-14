package handlers

import "testing"

// The expected counts come from src/lib/grid-path.ts (`pathGridDimensions`,
// via `estimateGridDimensions`) for the same paths — the Go copy must agree,
// or an imported bin label lands on a different cell than the map shows.
func TestPathGridDimensionsMatchesFrontend(t *testing.T) {
	cases := []struct {
		name           string
		start, current [2]float64
		cfg            gridConfigShape
		rows, cols     int
	}{
		{
			name:  "L straight",
			start: [2]float64{-88.3000101450887, 41.179992310475846}, current: [2]float64{-88.29987050097593, 41.18006196851818},
			cfg: gridConfigShape{Type: "square", Layout: "path", XSize: 1, YSize: 0.8, CellGap: 0.1, Levels: 1,
				PathRows: 2, PathSmooth: false, Path: [][2]float64{{0.07264959837432154, 0.11038961038298672}, {0.9273504016256785, 0.11038961038298672}, {0.9273504016256785, 0.8896103896170132}}},
			rows: 2, cols: 14,
		},
		{
			name:  "L smooth",
			start: [2]float64{-88.30000596769924, 41.1799954767505}, current: [2]float64{-88.2998746783654, 41.18005880224353},
			cfg: gridConfigShape{Type: "square", Layout: "path", XSize: 1, YSize: 0.8, CellGap: 0.1, Levels: 1,
				PathRows: 1, PathSmooth: true, Path: [][2]float64{{0.04545456255658246, 0.07142857141254216}, {0.9545454374434176, 0.07142857141254216}, {0.9545454374434176, 0.9285714285874578}}},
			rows: 1, cols: 15,
		},
		{
			name:  "U seats",
			start: [2]float64{-88.3000152176173, 41.17990704722273}, current: [2]float64{-88.29988929923441, 41.18001153428623},
			cfg: gridConfigShape{Type: "square", Layout: "path", XSize: 0.55, YSize: 0.6, CellGap: 0.05, Levels: 1,
				PathRows: 4, PathSmooth: true, Path: [][2]float64{{0.1208530236304236, 0.8896103896170132}, {0.1208530236304236, 0.37012987012766224}, {0.5000000000564289, 0.11038961038298672}, {0.8791469763695764, 0.37012987012766224}, {0.8791469763695764, 0.8896103896170132}}},
			rows: 4, cols: 37,
		},
	}
	for _, c := range cases {
		got := estimateGridDimensions(c.start[0], c.start[1], c.current[0], c.current[1], c.cfg)
		if got == nil || got.Rows != c.rows || got.Cols != c.cols {
			t.Errorf("%s: got %+v, want rows %d cols %d", c.name, got, c.rows, c.cols)
		}
	}
	// A rectangle grid keeps the old bbox maths.
	rect := gridConfigShape{Type: "square", XSize: 1, YSize: 1, Levels: 1}
	if got := estimateGridDimensions(0, 0, 0.0001, 0.0001, rect); got == nil || got.Cols != 11 || got.Rows != 11 {
		t.Errorf("rectangle grid: got %+v, want 11 x 11", got)
	}
}
