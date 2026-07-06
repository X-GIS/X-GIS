// @xgis/rhi-webgpu — the WebGPU RHI backend + the engine's former WebGPU
// zone (#833 M3). The ONLY workspace package that sees @webgpu/types: the
// WebGpuDevice adapter, the GPUContext boot (initGPU / initGPUForcedWebGL2,
// the composition root until the #833 M4 provider-injection inversion), and
// the WebGPU-typed machinery (compute, frame arena, staging pool, palette,
// render targets, reflection-to-WebGPU, bundle cache, bind tiers).
export * from './rhi-webgpu'
export * from './gpu'
export * from './gpu-shared'
export * from './gpu-timer'
export * from './compute'
export * from './frame-arena'
export * from './staging-buffer-pool'
export * from './palette-texture'
export * from './bind-tiers'
// #783 — `frame-uniform` stays UN-exported (dormant scaffolding, zero
// consumers outside its test); re-add when the shared-uniform consolidation
// actually lands.
export * from './render-targets'
export * from './frame-context'
export * from './reflection-to-webgpu'
export * from './vertex-buffer-layout'
export * from './bundle-cache'
export * from './compute-bind-layout'
