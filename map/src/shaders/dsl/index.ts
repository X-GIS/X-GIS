// ═══ X-GIS shader graphs — public API barrel ═══
//
// The single import surface for runtime + parity consumers OUTSIDE this dsl/
// directory. Renderers and parity tests import the emitted-WGSL strings and the
// cpu-f64 dispatch from here (`from '.../shaders/dsl'`), never from the
// individual shader modules — so the internal split stays a private detail.
//
// These are the X-GIS shader GRAPHS authored on top of the @xgis/shader-dsl
// framework (which provides the IR / backends / emit / passes). The graphs moved
// here from the shader-dsl package so that package stays content-free.

export * from './projections'
export * from './cpu-projections'
export * from './sdf'
export * from './log-depth'
export * from './icon'
export * from './icon-retained'
export * from './arrow-retained'
export * from './circle-retained'
export * from './particle-retained'
export * from './text'
export * from './raster'
export * from './hillshade'
export * from './coverage-ramp'
export * from './point'
export * from './line'
export * from './line-composite'
export * from './heatmap-accum'
export * from './heatmap-blur'
export * from './heatmap-compose'
