// @xgis/rhi-webgpu — the WebGPU RHI backend + the engine's former WebGPU
// zone (#833 M3). The ONLY workspace package that sees @webgpu/types: the
// WebGpuDevice adapter, the GPUContext boot (initGPU / initGPUForcedWebGL2,
// the composition root until the #833 M4 provider-injection inversion), and
// the WebGPU-typed machinery (compute, frame arena, staging pool, palette,
// render targets, reflection-to-WebGPU, bundle cache, bind tiers).
export * from './rhi-webgpu'
export * from './gpu'
export * from './backend-providers'
export * from './gpu-shared'
export * from './gpu-timer'
export * from './compute'
// FrameArena moved to @xgis/engine (backend-neutral CPU allocator, #834
// map→engine-only). Re-exported here so this package's barrel consumers
// (runtime tests, etc.) resolve the SAME class without an import churn.
export { FrameArena, type FrameArenaStats } from '@xgis/engine'
export * from './staging-buffer-pool'
export * from './palette-texture'
export * from './bind-tiers'
export * from './render-targets'
// FrameContext + FrameUniform moved to @xgis/map (#781 — per-frame render-loop
// state carrying the geo `Camera`; not RHI-backend machinery, so it does not
// belong in this WebGPU package). Map owns them now.
export * from './reflection-to-webgpu'
export * from './vertex-buffer-layout'
export * from './bundle-cache'
export * from './compute-bind-layout'
