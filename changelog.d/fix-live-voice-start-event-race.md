### Fixed

- Handle host Live Voice startup errors only after the start request settles. This avoids a premature stop request leaving a refused Android or desktop call active in the interface.
