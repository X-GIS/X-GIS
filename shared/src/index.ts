// @xgis/shared — cross-package pure helpers imported by both @xgis/runtime
// (engine) and @xgis/compiler (tiler). Keep everything here DEPENDENCY-FREE.
export * from './ecef'
export * from './quantize'
// Cross-cutting content/data utils extracted from runtime/src/engine (P3): logging,
// debug flags, and the safety guards — dependency-free, used by @xgis/map + @xgis/data.
export * from './log'
export * from './safety'
