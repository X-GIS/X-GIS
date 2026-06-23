// ═══ Shader DSL — public API barrel ═══
//
// @xgis/shader-dsl is a CONTENT-FREE shader-DSL FRAMEWORK. This barrel exposes
// the framework's authoring + emit API (everything under core/): the IR authoring
// layer, the SoT layout declarators, the backend contract + WGSL/GLSL writers,
// the intrinsic registry, the CPU f64 oracle, and the pre-emit passes.
//
// The X-GIS-specific shader GRAPHS that used to live here moved to the runtime
// (`runtime/src/engine/shaders/dsl/`); they author/emit through this surface
// (`from '@xgis/shader-dsl'`) like any other consumer.
//
// Collision note: `core/emit` and `core/backends/wgsl` both export `emitModule`
// and `emitExpr`. The WGSL backend's versions are the canonical public ones
// (they run the full validate → caps → autoVars → lower → cse pipeline), so they
// win the bare names; `core/emit`'s neutral tree-walk is re-exported under its
// remaining, non-colliding members only.

// IR authoring layer (types, nodes, node wrapper, builder/assemblers).
export * from './core/ir'

// Single-source-of-truth IO struct / bound-resource declarators.
export * from './core/sot'

// Backend plugin contract + capability model.
export * from './core/backend'

// WGSL backend + module assembly (canonical emitModule / emitExpr / emit*).
export * from './core/backends/wgsl'

// GLSL ES 3.00 backend (target-neutrality writer).
export * from './core/backends/glsl'

// Neutral intrinsic-spelling registry.
export * from './core/intrinsics'

// CPU f64 oracle (compileModule + CpuModule types).
export * from './core/oracle'

// Pipeline reflection (additive, read-only over the IR — never on the emit path):
// reflect(module) → target-neutral bind-group / std140-std430 layout / entry metadata,
// plus the standalone wgslLayout(struct, kind) offset engine.
export * from './core/reflect'

// Neutral emit tree-walk — non-colliding members only (emitModule / emitExpr
// are owned by the WGSL backend above).
export { emitStmt, emitBody, forHeader, lowerForBackend } from './core/emit'

// Pre-emit passes used by authors / consumers.
export { lowerModule } from './core/passes/match-lower'
export { cse } from './core/passes/opt/cse'
export { autoVars } from './core/passes/opt/auto-vars'
export { validate, lintModule } from './core/passes/validate'
export { requiredCaps, assertCaps } from './core/passes/required-caps'
export { checkSingleExit } from './core/passes/single-exit'
