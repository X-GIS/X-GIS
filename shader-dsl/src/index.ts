// ═══ Shader DSL — public API barrel ═══
//
// @xgis/shader-dsl is a CONTENT-FREE shader-DSL FRAMEWORK. This barrel exposes
// the framework's authoring + emit API (everything under core/): the IR authoring
// layer, the SoT layout declarators, the backend contract + WGSL/GLSL writers,
// the intrinsic registry, the CPU f64 oracle, and the pre-emit passes.
//
// The X-GIS-specific shader GRAPHS that used to live here moved to the map package
// (`map/src/shaders/dsl/` — #763 A3; earlier docs said runtime/, itself since split);
// they author/emit through this surface (`from '@xgis/shader-dsl'`) like any other
// consumer.
//
// Naming note (#763 H6): the canonical `emitModule` / `emitExpr` here are the WGSL
// backend's (`core/backends/wgsl` — the full validate → caps → autoVars → lower →
// fixpoint-optimize pipeline). `core/emit`'s neutral tree-walk emitters are NOT
// re-exported from this barrel at all since #748 — they live on the `/dev` subpath
// (`@xgis/shader-dsl/dev`) with the rest of the introspection/pass surface.

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

// The emit PLUGIN seam accepted by BOTH emitModule (WGSL) and emitGlslModule:
// `EmitOptions = { plugins?: EmitPlugin[] }`, composed the Vite/Webpack way.
// Types only — the production plugin implementations (mangle / minify /
// obfuscate) live on the `@xgis/shader-dsl/emit-prod` subpath so runtime-emit
// consumers that never import them bundle zero bytes of them.
export { type EmitPlugin, type EmitOptions } from './core/emit'

// CPU f64 oracle (compileModule + CpuModule types).
export * from './core/oracle'

// CPU f64 js-source backend (compileModuleJs) — the perf-critical `new Function`
// twin of compileModule, bit-identical over the same IR (#1162). Same CpuModule
// shape; the interpreter stays the reference / CSP fallback.
export { compileModuleJs } from './core/cpu-codegen'

// Pipeline reflection (additive, read-only over the IR — never on the emit path):
// reflect(module) → target-neutral bind-group / std140-std430 layout / entry metadata,
// plus the standalone wgslLayout(struct, kind) offset engine.
export * from './core/reflect'

// The optimization-level TYPE for emitModuleAt(m, level). (The optimizeAt entry +
// LEVEL_PASSES table are internal — emit.ts drives them; no consumer ever imported
// them through this barrel.)
export { type OptLevel } from './core/passes/opt'

// Public error surface: the coded base class + the EMIT-time validation gate.
// (`Diagnostic` is the type of ValidationError.diagnostics.) Everything else on
// the diagnostics/lint/measure axis is DEV tooling — import it from
// '@xgis/shader-dsl/dev' (#740 R2b): lintModule / summarize / formatDiagnostics /
// checkSingleExit / requiredCaps / assertCaps / diagnose / formatReport / CODES /
// dslError / formatLoc / setSourceTracing / emitSize / countOps / optimizerReport /
// lowerForBackend / emitModuleWithReflection.
export { ShaderDslError } from './core/diagnostics/error'
export { validate, ValidationError } from './core/passes/validate'
export { type Diagnostic } from './core/passes/lint/engine'

// Pre-emit passes used by authors / consumers.
export { composeModule, type ComposeOptions } from './core/passes/compose'
export { lowerModule } from './core/passes/match-lower'
export { cse } from './core/passes/opt/cse'
export { autoVars } from './core/passes/opt/auto-vars'

// fp64 (emulated double precision): the host-side split, the anti-fast-math
// guard declarator (REQUIRED by f64-using modules — see SD0042), and the
// lowering pass itself (runs automatically inside every emit; exported for
// tests / direct IR consumers).
export { splitF64, fp64Guard, FP64_GUARD_NAME, type Fp64GuardHandle } from './core/fp64/df64-lib'
export { fp64Lower, type Fp64Flavor, type Fp64LowerOptions } from './core/passes/fp64-lower'
// Device → flavor recommendation ('integer' on Apple/Metal, 'float' elsewhere).
export { recommendFp64Flavor, isAppleGpu, type Fp64FlavorSignals } from './core/fp64/flavor-select'
