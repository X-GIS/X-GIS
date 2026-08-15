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

// Module FRAGMENTS (#1711) — a header-less emit for a host that owns the program and
// composes our declarations into it, with the directive/precision lines it must hoist
// returned as structured `preamble` data rather than concatenated into source the
// consumer would have to strip. `emitFragment` (WGSL) is star-re-exported from the
// backend above; `emitGlslFragment` from the GLSL one. The shared shapes live here.
export { type EmitFragment, type FragmentDeclares } from './core/fragment'

// Per-variant compile + link gate (#1715) — emit EVERY point of a variant family and put
// each one through a real WebGL2 driver. The GL context is a structural PARAMETER, so the
// package needs no DOM lib and a test can drive the aggregation with a recorder while the
// real run goes through a real driver.
export { linkVariants, type GlLinker, type VariantLinkResult } from './core/variant-link'

// Emit IDENTITY (#1715) — the emit mode as a stable one-line stamp, so a committed
// artifact can say which mode produced it. A pure function, deliberately not injected
// into emitted source: the reported failure was a production build rewriting a committed
// registry that the dev-mode goldens then disagreed with, and the registry banner (see
// `buildRegistry`'s `stamp`) is where that difference needs to be visible.
export { emitIdentity, type EmitTarget, type EmitIdentityInput } from './core/emit-identity'

// Registry generation (#1716) — the reusable half: validate a DISCOVERED module set
// against a CURATED id order and render a keyed registry module from it. Pure (no
// filesystem), because the scan convention belongs to the caller; what everyone would
// otherwise re-invent differently is the two-way drift check.
export {
  buildRegistry,
  type RegistryEntry,
  type BuildRegistryOptions,
  type BuiltRegistry,
} from './core/registry'

// Variant FAMILIES (#1712) — the typed matrix for feature axes a HOST decides at runtime,
// the case AUTHORING.md §11's build-time specialisation deliberately does not cover.
// Per-variant modules + reflections + a derived key, emitted either preprocessor-free (the
// only shape WGSL can have) or, opt-in on GLSL, as one source with a GENERATED #if ladder.
export {
  variantFamily,
  selectGuardedArm,
  type VariantFamily,
  type VariantFamilySpec,
  type Variant,
  type AxisValues,
  type GuardDefines,
} from './core/variant-family'

// Semantic comparison of two modules (#1714) — IR + reflection, not text, so the
// optimizer's temporaries / declaration order / generated names do not drown the
// diff. Main barrel rather than '/dev': the "prod is dev, optimized" assertion it
// makes possible is a production claim a consumer ships, not an authoring aid.
export {
  semanticDiff,
  isSemanticallyEqual,
  type SemanticDiff,
  type SemanticDiffOptions,
  type SemanticAspect,
} from './core/semantic-diff'

// The optimization-level TYPE for emitModuleAt(m, level). (The optimizeAt entry +
// LEVEL_PASSES table are internal — emit.ts drives them; no consumer ever imported
// them through this barrel.)
export { type OptLevel } from './core/passes/opt'

// Public error surface: the coded base class + the EMIT-time validation gate.
// (`Diagnostic` is the type of ValidationError.diagnostics.) Everything else on
// the diagnostics/lint/measure axis is exported from '@xgis/shader-dsl/dev'
// (#740 R2b): lintModule / summarize / formatDiagnostics / checkSingleExit /
// requiredCaps / assertCaps / diagnose / formatReport / CODES / dslError /
// formatLoc / setSourceTracing / emitSize / countOps / optimizerReport /
// lowerForBackend / emitModuleWithReflection.
//
// That split is about the AUTHORING SURFACE, not about which code runs in
// production: passes/required-caps is squarely on the production path — assertCaps
// gates every emit from lowerForBackend, and `reflect()` (main barrel) derives
// `requiredFeatures` from requiredCaps (#1670). Only its named export lives on the
// dev entry, because an author writing a shader never calls it directly.
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
