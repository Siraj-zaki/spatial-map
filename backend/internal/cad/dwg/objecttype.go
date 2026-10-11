package dwg

import "fmt"

// Every object carries a numeric type. Below firstClassType the number
// is fixed by the format and means the same thing in every file; at or
// above it the number is assigned per file by the class section, so the
// same value can mean different things in two drawings. That split is
// why a reader cannot treat the type as a global enum.
const firstClassType = 500

// The built-in types. Only a fraction of these will ever be drawn — a
// warehouse plan is lines, polylines, arcs, circles, text and blocks —
// but the full list is what makes an unhandled object legible in a log
// or an error, and knowing that an ignored object is a TOLERANCE rather
// than "type 46" is the difference between a diagnosis and a shrug.
var objectTypeNames = map[uint16]string{
	0x01:  "TEXT",
	0x02:  "ATTRIB",
	0x03:  "ATTDEF",
	0x04:  "BLOCK",
	0x05:  "ENDBLK",
	0x06:  "SEQEND",
	0x07:  "INSERT",
	0x08:  "MINSERT",
	0x0A:  "VERTEX_2D",
	0x0B:  "VERTEX_3D",
	0x0C:  "VERTEX_MESH",
	0x0D:  "VERTEX_PFACE",
	0x0E:  "VERTEX_PFACE_FACE",
	0x0F:  "POLYLINE_2D",
	0x10:  "POLYLINE_3D",
	0x11:  "ARC",
	0x12:  "CIRCLE",
	0x13:  "LINE",
	0x14:  "DIMENSION_ORDINATE",
	0x15:  "DIMENSION_LINEAR",
	0x16:  "DIMENSION_ALIGNED",
	0x17:  "DIMENSION_ANG_3PT",
	0x18:  "DIMENSION_ANG_LN2",
	0x19:  "DIMENSION_RADIUS",
	0x1A:  "DIMENSION_DIAMETER",
	0x1B:  "POINT",
	0x1C:  "3DFACE",
	0x1D:  "POLYLINE_PFACE",
	0x1E:  "POLYLINE_MESH",
	0x1F:  "SOLID",
	0x20:  "TRACE",
	0x21:  "SHAPE",
	0x22:  "VIEWPORT",
	0x23:  "ELLIPSE",
	0x24:  "SPLINE",
	0x25:  "REGION",
	0x26:  "3DSOLID",
	0x27:  "BODY",
	0x28:  "RAY",
	0x29:  "XLINE",
	0x2A:  "DICTIONARY",
	0x2B:  "OLEFRAME",
	0x2C:  "MTEXT",
	0x2D:  "LEADER",
	0x2E:  "TOLERANCE",
	0x2F:  "MLINE",
	0x30:  "BLOCK_CONTROL",
	0x31:  "BLOCK_HEADER",
	0x32:  "LAYER_CONTROL",
	0x33:  "LAYER",
	0x34:  "STYLE_CONTROL",
	0x35:  "STYLE",
	0x38:  "LTYPE_CONTROL",
	0x39:  "LTYPE",
	0x3C:  "VIEW_CONTROL",
	0x3D:  "VIEW",
	0x3E:  "UCS_CONTROL",
	0x3F:  "UCS",
	0x40:  "VPORT_CONTROL",
	0x41:  "VPORT",
	0x42:  "APPID_CONTROL",
	0x43:  "APPID",
	0x44:  "DIMSTYLE_CONTROL",
	0x45:  "DIMSTYLE",
	0x46:  "VP_ENT_HDR_CTRL",
	0x47:  "VP_ENT_HDR",
	0x48:  "GROUP",
	0x49:  "MLINESTYLE",
	0x4A:  "OLE2FRAME",
	0x4B:  "DUMMY",
	0x4C:  "LONG_TRANSACTION",
	0x4D:  "LWPOLYLINE",
	0x4E:  "HATCH",
	0x4F:  "XRECORD",
	0x50:  "ACDBPLACEHOLDER",
	0x51:  "VBA_PROJECT",
	0x52:  "LAYOUT",
	0x1F2: "PROXY_ENTITY",
	0x1F3: "PROXY_OBJECT",
}

// typeName describes a type code for humans. Class-numbered types are
// reported as such rather than guessed at, because resolving one needs
// the file's own class table.
func typeName(t uint16) string {
	if n, ok := objectTypeNames[t]; ok {
		return n
	}
	if t >= firstClassType {
		return fmt.Sprintf("class:%d", t)
	}
	return fmt.Sprintf("type:%d", t)
}
