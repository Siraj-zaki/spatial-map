package handlers

import "math"

// Path-layout grids (config.layout == "path"): cells laid along a drawn
// polyline instead of filling the start/current rectangle. This is the Go
// copy of the counting rules in src/lib/grid-path.ts (`pathGridDimensions`),
// used by the bin-label resolver so an imported label lands on the same cell
// the map draws. Keep the two in step:
//   - the path is stored normalised to the grid's box: [u, v], u east of the
//     west edge and v north of the south edge, both 0…1;
//   - box width / height are measured along start's latitude / longitude;
//   - with pathSmooth the length is taken along a Catmull-Rom curve through
//     the points, 12 samples per segment;
//   - cols = max(1, floor((length + gap) / (xSize + gap))), rows = pathRows,
//     total cells capped at pathGridMaxCells.

const pathGridMaxCells = 20_000

func isPathGrid(cfg gridConfigShape) bool {
	return cfg.Layout == "path" && len(cfg.Path) >= 2
}

// pathPolylineMetres maps the normalised path into local metres (and smooths
// it when asked).
func pathPolylineMetres(startLng, startLat, currentLng, currentLat float64, path [][2]float64, smooth bool) [][2]float64 {
	minLng, maxLng := math.Min(startLng, currentLng), math.Max(startLng, currentLng)
	minLat, maxLat := math.Min(startLat, currentLat), math.Max(startLat, currentLat)
	widthM := distanceMeters([2]float64{minLng, startLat}, [2]float64{maxLng, startLat})
	heightM := distanceMeters([2]float64{startLng, minLat}, [2]float64{startLng, maxLat})
	pts := make([][2]float64, len(path))
	for i, p := range path {
		pts[i] = [2]float64{p[0] * widthM, p[1] * heightM}
	}
	if !smooth || len(pts) < 3 {
		return pts
	}
	const steps = 12
	out := make([][2]float64, 0, (len(pts)-1)*steps+1)
	for i := 0; i < len(pts)-1; i++ {
		p0 := pts[int(math.Max(0, float64(i-1)))]
		p1 := pts[i]
		p2 := pts[i+1]
		p3 := pts[int(math.Min(float64(len(pts)-1), float64(i+2)))]
		for k := 0; k < steps; k++ {
			t := float64(k) / steps
			t2, t3 := t*t, t*t*t
			c := func(a, b, cc, d float64) float64 {
				return 0.5 * (2*b + (-a+cc)*t + (2*a-5*b+4*cc-d)*t2 + (-a+3*b-3*cc+d)*t3)
			}
			out = append(out, [2]float64{c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])})
		}
	}
	return append(out, pts[len(pts)-1])
}

// pathGridDimensions returns rows across × columns along a path grid.
func pathGridDimensions(startLng, startLat, currentLng, currentLat float64, cfg gridConfigShape) *gridDims {
	pts := pathPolylineMetres(startLng, startLat, currentLng, currentLat, cfg.Path, cfg.PathSmooth)
	length := 0.0
	for i := 1; i < len(pts); i++ {
		length += math.Hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1])
	}
	rows := int(math.Max(1, math.Floor(cfg.PathRows)))
	levels := int(math.Max(1, math.Floor(cfg.Levels)))
	gap := math.Max(0, cfg.CellGap)
	pitch := math.Max(1e-6, cfg.XSize+gap)
	cols := int(math.Max(1, math.Floor((length+gap)/pitch+1e-9)))
	if limit := int(math.Max(1, math.Floor(float64(pathGridMaxCells)/float64(rows*levels)))); cols > limit {
		cols = limit
	}
	return &gridDims{Rows: rows, Cols: cols}
}
