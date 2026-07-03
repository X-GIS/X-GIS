// @xgis/engine — content-blind GPU/RHI machinery (P3 Step 2: RHI + GPU leaf).
// Physical relocation of runtime/src/engine/{render/rhi,gpu}. Pure source move —
// no logic changes. Consumers import these symbols via `@xgis/engine`.

// ── RHI (render hardware interface) ──────────────────────────────────
export * from './render/rhi/rhi'
export * from './render/rhi/rhi-webgpu'
export * from './render/rhi/rhi-webgl2'

// ── GPU layer ────────────────────────────────────────────────────────
export * from './gpu/gpu'
export * from './gpu/gpu-arena'
export * from './gpu/gpu-timer'
export * from './gpu/compute'
export * from './gpu/frame-arena'
export * from './gpu/staging-buffer-pool'
export * from './gpu/palette-texture'
export * from './gpu/quality'
export * from './gpu/bind-tiers'
// P3 Step 3: GPU machinery deferred at Step 2 (imported projection / shaders-dsl).
export * from './gpu/gpu-shared'
// #783 — `gpu/frame-uniform` (the FrameUniform class + WGSL_FRAME_UNIFORM +
// FRAME_UNIFORM_SIZE_BYTES) is DORMANT scaffolding (every renderer packs its own
// Uniforms struct; its 128-byte layout doesn't match the live 192-byte structs) and
// has ZERO consumers outside its own test. Kept internal — NOT re-exported — so a
// consumer can't wire to a dead path from autocomplete. Re-add when the shared-uniform
// consolidation actually lands.
export * from './gpu/compute-webgl2'

// ── Projection / camera math (P3 Step 3) ─────────────────────────────
export * from './projection/projection'
export * from './projection/projections-table'
export * from './projection/ecef'
export * from './projection/globe'
export * from './projection/globe-anchor'
export * from './projection/camera-helpers'
export * from './projection/camera-world-copies'
export * from './projection/view-matrix'
export * from './projection/unproject'
export * from './projection/earth-surface-fill'
export * from './projection/camera'

// ── Frame / render core machinery (P3 Step 4) ────────────────────────
export * from './render/render-targets'
export * from './render/projection-token'
export * from './render/frame-context'

// ── Pipeline/bind/upload/compute machinery (P3 Step 5, content-blind only) ─
export * from './render/reflection-to-webgpu'
export * from './render/vertex-buffer-layout'
export * from './render/bundle-cache'
export * from './render/compute-bind-layout'
// Reflect-derived typed std140 pack target (#733): write() full-struct pack with
// compile-time completeness + set.* zero-alloc per-field setters.
export * from './render/uniform-block'

// ── Shader machinery: CPU log-depth + content-blind shader-DSL leaves ─
export * from './shaders/log-depth'
export * from './shaders/dsl/overdraw-compose'
