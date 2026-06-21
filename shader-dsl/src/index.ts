// ═══ Shader DSL — public API barrel ═══
//
// The single import surface for consumers OUTSIDE shader-dsl/. Renderers and
// parity tests import the emitted-WGSL strings and the cpu-f64 dispatch from
// here (`from '../shader-dsl'`), never from the individual shader modules — so
// the internal split into core/ (ir + backends + schema) and shaders/ stays a
// private implementation detail.
//
// Re-exports the shader graphs only; the IR authoring layer (core/ir, backends,
// schema) is internal and not part of the public surface.

export * from './shaders/projections'
export * from './shaders/cpu-projections'
export * from './shaders/sdf'
export * from './shaders/log-depth'
export * from './shaders/icon'
export * from './shaders/text'
export * from './shaders/raster'
export * from './shaders/point'
export * from './shaders/line'
export * from './shaders/compute-match'
export * from './shaders/heatmap-accum'
export * from './shaders/heatmap-blur'
export * from './shaders/heatmap-compose'
