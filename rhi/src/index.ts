// @xgis/rhi — the backend-neutral Render Hardware Interface (#833 M3).
// Interfaces ONLY, zero dependencies: this package never names a native GPU
// type (no @webgpu/types, no WebGL2 lib types beyond TS DOM lib), so any
// package that depends on it alone is backend-neutral by construction.
export * from './rhi'
export * from './rhi-provider'
