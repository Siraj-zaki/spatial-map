package dwg

// The three container layouts have nothing in common internally, but
// everything above them wants the same two things: what sections exist,
// and give me one by name. That is the whole seam — object decoding is
// version-dependent in its own right, but it is not container-dependent,
// so it should never learn which layout it came from.
type sectionSource interface {
	// Section returns the fully decoded (decompressed, error-corrected)
	// bytes of a named section.
	Section(name string) ([]byte, error)
	sectionNames() []string
}

// file is a DWG opened far enough to read sections from. Sections are
// decoded on demand rather than up front: AcDb:AcDbObjects alone runs to
// several megabytes on a real drawing, and a caller that only wants the
// units should not pay for it.
type file struct {
	Version  Version
	sections sectionSource
}

// open identifies the release and selects a container reader.
func open(data []byte) (*file, error) {
	v, err := DetectVersion(data)
	if err != nil {
		return nil, err
	}
	kind, ok := v.container()
	if !ok {
		return nil, &ErrUnsupportedVersion{Version: v}
	}

	var s sectionSource
	switch kind {
	case containerR18:
		s, err = openR18(data)
	case containerR21:
		s, err = openR21(data)
	default:
		// Unreachable while container names only these two, and kept so
		// that a third added there without an arm here is refused rather
		// than returning a file with a nil section source.
		return nil, &ErrUnsupportedVersion{Version: v}
	}
	if err != nil {
		return nil, err
	}
	return &file{Version: v, sections: s}, nil
}
