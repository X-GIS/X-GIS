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
