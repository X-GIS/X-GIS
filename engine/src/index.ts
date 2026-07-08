// @xgis/engine — content-blind, backend-NEUTRAL engine core (#833 M3).
// Compiles with `types: []` and depends only on @xgis/rhi among the RHI
// packages, so a WebGPU identifier anywhere in this package is a COMPILE
// ERROR. The WebGPU adapter + former WebGPU zone live in @xgis/rhi-webgpu;
// the WebGL2 backend in @xgis/rhi-webgl2.

// ── RHI (render hardware interface) ──────────────────────────────────
export * from '@xgis/rhi'

// ── GPU layer (backend-blind) ─────────────────────────────────────────
export * from './gpu/gpu-arena'
export * from './gpu/quality'
export * from './gpu/world-scale'

// ── Geo primitives (projection leaves) ───────────────────────────────
// The map-only camera cluster (camera, view-matrix, globe-anchor, unproject,
// camera-world-copies, camera-helpers) moved to @xgis/map in #781 (3b). These
// remaining leaves become @xgis/geo in 3c; the engine holds no projection then.
export * from './projection/projection'
export * from './projection/projections-table'
export * from './projection/ecef'
export * from './projection/globe'

// ── Frame / render core machinery ─────────────────────────────────────
export * from './render/projection-token'
// Reflect-derived typed std140 pack target (#733): write() full-struct pack with
// compile-time completeness + set.* zero-alloc per-field setters.
export * from './render/uniform-block'
// Pure-CPU bump allocator (per-frame scratch, no GPU coupling). Relocated
// from @xgis/rhi-webgpu (#834 map→engine-only): @webgpu/types-free, so it
// belongs in the backend-neutral core; rhi-webgpu re-exports it for its own
// barrel consumers.
export * from './render/frame-arena'
// Backend-neutral render context (RenderContext) + its family (RhiDeviceLostInfo,
// BackendChoice), relocated from @xgis/rhi (#834 map→engine): a render HARDWARE
// interface names GPU resources, not a host canvas / frame-loop state.
export * from './render/render-context'

// ── Shader machinery: CPU log-depth + content-blind shader-DSL leaves ─
export * from './shaders/log-depth'
export * from './shaders/dsl/overdraw-compose'
// The DSL-authored frame-uniform WGSL emitter (consumed by @xgis/rhi-webgpu's
// dormant FrameUniform scaffolding — see #783 note there).
export * from './shaders/dsl/frame-uniform'
