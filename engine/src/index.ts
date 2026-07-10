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

// ── Frame / render core machinery ─────────────────────────────────────
// NOTE: no ECEF re-export. The `./projection/` subtree is gone — the ellipsoid
// math lives in @xgis/shared and the projection library in @xgis/geo (#781 3c/3d).
// Consumers import ECEF from @xgis/shared directly; the engine is projection-free.
export * from './render/projection-token'
// Reflect-derived typed std140 pack target (#733): write() full-struct pack with
// compile-time completeness + set.* zero-alloc per-field setters.
export * from './render/uniform-block'
// Pure-CPU bump allocator (per-frame scratch, no GPU coupling). Relocated
// from @xgis/rhi-webgpu (#834 map→engine-only): @webgpu/types-free, so it
// belongs in the backend-neutral core. Consumers import it from HERE — the
// rhi-webgpu compat re-export was removed (#929 B).
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
