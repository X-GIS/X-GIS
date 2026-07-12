// @xgis/rhi — the backend-neutral Render Hardware Interface (#833 M3).
// Interfaces ONLY, zero dependencies: this package never names a native GPU
// type (no @webgpu/types, no WebGL2 lib types beyond TS DOM lib), so any
// package that depends on it alone is backend-neutral by construction.
export * from './rhi'
export * from './rhi-provider'
// Neutral GPU contracts the compiler PRODUCES and backend adapters CONSUME
// (#929 B3): the single-source vertex-format machinery + the compute kernel /
// output-binding surface. Homed here (the []-root) so a backend types against
// them without importing @xgis/compiler.
export * from './vertex-format'
export * from './compute-contract'
