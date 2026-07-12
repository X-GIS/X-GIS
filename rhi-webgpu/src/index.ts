// @xgis/rhi-webgpu — the WebGPU RHI backend + the engine's former WebGPU
// zone (#833 M3). The ONLY workspace package that sees @webgpu/types: the
// WebGpuDevice adapter, the GPUContext boot (initGPU / initGPUForcedWebGL2,
// the composition root until the #833 M4 provider-injection inversion), and
// the WebGPU-typed machinery (compute, frame arena, staging pool, generic
// data-texture upload, render targets, reflection-to-WebGPU, bundle cache,
// bind tiers).
export * from './rhi-webgpu'
export * from './gpu'
export * from './backend-providers'
export * from './gpu-shared'
export * from './gpu-timer'
export * from './compute'
// FrameArena moved to @xgis/engine (backend-neutral CPU allocator, #834
// map→engine-only) and is imported from there directly — the compat
// re-export this barrel used to carry was a VALUE-level @xgis/engine
// import in the adapter (#929 B).
export * from './staging-buffer-pool'
// Generic 2D data-texture upload (create + write packed texels). The palette
// data-viz SCHEMA that used to live here relocated UP to @xgis/map (#1000);
// this leaves only a content-blind texture-upload primitive.
export * from './data-texture'
// Generic offscreen render-target primitive (create colour attachment + view).
// The heatmap density-target data-viz SCHEMA that used to live on RenderTargets
// relocated UP to @xgis/map (#1000); this leaves a content-blind primitive map
// drives with a size/format.
export * from './render-target'
export * from './bind-tiers'
export * from './render-targets'
// FrameContext + FrameUniform moved to @xgis/map (#781 — per-frame render-loop
// state carrying the geo `Camera`; not RHI-backend machinery, so it does not
// belong in this WebGPU package). Map owns them now.
export * from './reflection-to-webgpu'
export * from './vertex-buffer-layout'
export * from './bundle-cache'
export * from './compute-bind-layout'
