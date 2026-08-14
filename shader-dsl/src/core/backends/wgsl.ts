// ═══ Shader DSL — WGSL backend ═══
//
// Lowers a ModuleDecl to a WGSL string for device.createShaderModule. The
// statement/expression walk is the SHARED neutral emitter (core/emit.ts); this
// file provides the WGSL Backend (type/literal/intrinsic spelling + the divergent
// declaration fragments) and the WGSL module assembly (struct/binding/func/const
// + the matchExpr lowering pass). WGSL output is byte-identical to the pre-refactor
// emit — the wgslBackend fragments reproduce the exact former strings.

import type {
  ShaderType,
  Expr,
  ConstDecl,
  StructDecl,
  BindingDecl,
  FuncDecl,
  ModuleDecl,
} from '../ir'
import { UnsupportedFeatureError, type Backend, type CapProfile } from '../backend'
import {
  emitExpr as emitExprNeutral,
  emitBody,
  emitModule as emitModuleDriver,
  emitModuleAt as emitModuleAtDriver,
  lowerForBackend,
  type EmitOptions,
} from '../emit'
import { lowerModule } from '../passes/match-lower'
import { fixpoint, autoVars, type OptLevel } from '../passes/opt'
import { spellIntrinsic } from '../intrinsics'
import { fp64Lower } from '../passes/fp64-lower'
import { dslError } from '../diagnostics/error'

/** Spell a {@link ShaderType} as WGSL type syntax (`f32`, `vec2<f32>`, `array<u32, 4>`, …).
 *
 *  @internal Reachable from the package entry only because `index.ts` star-re-exports this
 *  backend module; it was never chosen as public API and has no consumer outside the
 *  backend. Type spelling is a backend's private business — the neutral surface is
 *  {@link emitModule}. Whether it should stay exported at all is #1697.
 *
 *  @throws if `t` is an `f64`/`vec64` kind. Those are PRE-LOWERING types: `fp64Lower` (run
 *  inside `lowerForBackend`) rewrites them to `vec2<f32>` / `DF64VecN` before any backend
 *  spells a type, so reaching them here means the pass was bypassed. Failing loud beats
 *  emitting a shader whose double-precision silently became single. */
export function wgslType(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar':
      return t.scalar
    // f64/vec64 are PRE-LOWERING types only: fp64Lower (run inside
    // lowerForBackend) rewrites them to vec2<f32> / DF64VecN structs before any
    // backend spells a type. Reaching these arms means the pass was bypassed —
    // fail loud, never emit.
    case 'f64':
      throw dslError('SD0040', 'wgslType(f64)')
    case 'vec64':
      throw dslError('SD0040', `wgslType(vec${t.n}<f64>)`)
    case 'vec':
      return `vec${t.n}<${t.elem}>`
    case 'mat':
      // matNxN<f64> is a PRE-LOWERING type too (→ DF64MatN); reaching here means
      // fp64Lower was bypassed — fail loud, never spell an invalid mat<f64>.
      if (t.elem === 'f64') throw dslError('SD0040', `wgslType(mat${t.n}x${t.n}<f64>)`)
      return `mat${t.n}x${t.n}<${t.elem}>`
    case 'struct':
      return t.name
    case 'array':
      return t.size !== undefined
        ? `array<${wgslType(t.elem)}, ${t.size}>`
        : `array<${wgslType(t.elem)}>`
    case 'texture':
      // Spelled per dim, never templated: '2d-array' is `texture_2d_array<f32>` in
      // WGSL (a `texture_${t.dim}` template would emit `texture_2d-array<f32>`).
      // Exhaustive: a new dim must fail compilation, not fall open to the 2d spelling.
      switch (t.dim) {
        case '2d-ms':
          return `texture_multisampled_2d<${t.elem}>`
        case '2d-array':
          return `texture_2d_array<${t.elem}>`
        case '2d':
          return `texture_2d<${t.elem}>`
        default:
          return t.dim satisfies never
      }
    case 'sampler':
      return 'sampler'
    case 'void':
      return 'void'
  }
}

/** A WGSL/GLSL-shared f32 literal: append `.0` to an integer-looking value so a
 *  float context never sees an int literal. Reused by the GLSL writer. */
export function f32Lit(v: number): string {
  const s = String(v)
  return /[.eE]/.test(s) ? s : `${s}.0`
}

function lit(value: number | boolean, t: ShaderType): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (t.kind === 'scalar' && t.scalar === 'u32') return `${value}u`
  if (t.kind === 'scalar' && t.scalar === 'i32') return `${value}`
  return f32Lit(value)
}

function paramAttr(p: { builtin?: string; location?: number; attr?: string }): string {
  if (p.attr) return `${p.attr} `
  if (p.builtin) return `@builtin(${p.builtin}) `
  if (p.location !== undefined) return `@location(${p.location}) `
  return ''
}

/** THE WGSL capability table (#1670) — what this target supports, what each cap costs
 *  in the emitted source (`directive`), and what the host must request of the adapter
 *  (`hostFeature`). Coverage derives from these KEYS (`Capabilities.fromProfile`),
 *  `modulePreamble` from these `directive`s, and the host list from these
 *  `hostFeature`s (`hostFeaturesFor`), so none of the three can disagree; it replaced
 *  the hand-synced `caps`-set + `WGSL_ENABLE`-map pair (CLAUDE.md §12 second-ratchet).
 *
 *  The WGSL writer can SPELL every row here; whether a given adapter HAS an optional
 *  feature is a runtime probe the RHI owns — it opts a module in via `enables` only
 *  after confirming the device feature (#628).
 *
 *  NO `multiview` row, deliberately: WebGPU has no OVR_multiview2 equivalent, so a
 *  module declaring it must fail closed here (SD0030 naming 'multiview') rather than
 *  emit a module the device cannot honour. That fail-closed half is half of what makes
 *  the GLSL `#extension` path meaningful — pinned by extension-profile.test.ts, so the
 *  absence is an asserted invariant rather than this comment's word for it.
 *
 *  `satisfies` (not a `: CapProfile` annotation): the annotation would widen every row
 *  to `CapSupport` and lose the literal `hostFeature` strings, which is exactly what a
 *  reader — and the profile-pin test — needs to see. It still type-checks the KEYS
 *  against `Capability`, so a renamed cap id cannot leave a stale row behind. */
const WGSL_CAP_PROFILE = {
  // Derived resource caps — core WGSL, nothing to declare or request.
  storageBuffer: {},
  compute: {},
  msaaTextureLoad: {},
  // Opt-in LANGUAGE features — a WGSL `enable` directive AND a device feature.
  f16: { directive: 'f16', hostFeature: 'shader-f16' },
  subgroups: { directive: 'subgroups', hostFeature: 'subgroups' },
  // Opt-in DEVICE features (#1670) — no WGSL directive exists for any of these; the
  // host activates them at requestDevice time (or they are core).
  floatRenderTarget: {}, // core in WebGPU: an rgba32float render target needs no feature
  float32Blend: { hostFeature: 'float32-blendable' },
  float32Filterable: { hostFeature: 'float32-filterable' },
} satisfies CapProfile

/** `@builtin(<id>)` ids that do NOT exist in WGSL (#1672), each mapped to the message
 *  tail the shared pre-pass prints after `wgsl: @builtin(<id>)`. Every one of them is a
 *  GLSL-ism an author can reach for — `point_size`/`point_coord` are the gl_PointSize /
 *  gl_PointCoord pair, and `frag_coord` is the GLSL spelling this repo's own GLSL writer
 *  accepts (backends/glsl.ts BUILTIN_IN) while WGSL spells it `position` on a fragment
 *  entry. Each used to be emitted VERBATIM into the module string (struct field attr /
 *  param attr) and rejected by naga with no line back to the authoring site. The set is a
 *  DENYLIST, not a WGSL allowlist: a builtin the DSL has not met yet must keep emitting,
 *  so a new WGSL builtin never needs a table edit here to be usable. */
const WGSL_ABSENT_BUILTINS: ReadonlyMap<string, string> = new Map([
  [
    'point_size',
    'does not exist in WGSL — WebGPU point-list primitives are always 1px. Expand an instanced quad in the vertex stage instead (see map/src/shaders/dsl/point.ts).',
  ],
  [
    'point_coord',
    'does not exist in WGSL — there is no point-sprite coordinate. Interpolate a @location(n) corner uv from the expanded quad instead (see map/src/shaders/dsl/point.ts).',
  ],
  [
    'frag_coord',
    'does not exist in WGSL — the fragment-stage framebuffer coordinate (GLSL gl_FragCoord) is @builtin(position) on a fragment entry parameter.',
  ],
])

/** The WGSL target writer. Every method reproduces the exact pre-refactor
 *  spelling, so any emit driven by wgslBackend is byte-identical. */
export const wgslBackend: Backend = {
  id: 'wgsl',
  capProfile: WGSL_CAP_PROFILE,
  absentBuiltins: WGSL_ABSENT_BUILTINS,
  typeName: wgslType,
  literal: lit,
  // WGSL spells every intrinsic / user call as `name(args)`; the reserved
  // `'select'` id is WGSL select(falseVal, trueVal, cond).
  intrinsic: (name, args) => spellIntrinsic('wgsl', name, args),
  localLet: (name, _type, init) => `let ${name} = ${init}`,
  localVar: (name, type, init) =>
    init !== undefined
      ? `var ${name}: ${wgslType(type)} = ${init}`
      : `var ${name}: ${wgslType(type)}`,
  constDecl: (name, type, value) => `const ${name}: ${wgslType(type)} = ${value};`,
  caseLabel: (value, scrutType) =>
    scrutType.kind === 'scalar' && scrutType.scalar === 'u32' ? `${value}u` : `${value}`,
  switchHead: (scrut) => `switch ${scrut} {`,
  // #1671 — emit THIS target's payload; a raw carrying only the GLSL spelling is
  // a hard build failure here, not a stringified `undefined` in the module body.
  rawStmt: (s) => {
    if (s.wgsl !== undefined) return s.wgsl
    // Mirrors the GLSL side: the at-least-one union guarantees a `glsl` side
    // here, but tsc cannot discriminate the union on a non-unit-typed property —
    // so narrow the PROPERTY locally instead of asserting; `''` is unreachable.
    const glsl = s.glsl ?? ''
    throw new UnsupportedFeatureError(
      `wgsl: raw Stmt carries no wgsl payload (glsl-only raw: '${glsl.slice(0, 40)}') — supply a wgsl spelling for this statement`,
    )
  },
  placeholderStmt: (tag) => `// __placeholder: ${tag}`,
  // ── Module-decl surface (the WGSL spellings, lifted from the former free fns) ──
  emitConst: (c) =>
    wgslBackend.constDecl(
      c.name,
      c.type,
      c.valueExpr ? emitExprNeutral(c.valueExpr, wgslBackend) : f32Lit(c.wgslValue),
    ),
  // #923 — a pipeline specialization constant: a module-scope `override` the host
  // specializes via createRenderPipeline({ constants: { name } }). The default value
  // uses the same scalar spelling as any literal (1.0 / 2u / true), so the module
  // compiles standalone and a branch guarded by the override is dead-code-eliminated
  // by the DRIVER once specialized.
  emitOverride: (o) => `override ${o.name}: ${wgslType(o.type)} = ${lit(o.default, o.type)};`,
  emitStruct: (s) => {
    const fields = s.fields
      .map((f) => `  ${f.attr ? `${f.attr} ` : ''}${f.name}: ${wgslType(f.type)},`)
      .join('\n')
    return `struct ${s.name} {\n${fields}\n}`
  },
  emitBinding: (b) => {
    // texture / sampler are handle types — no address space (`var x: T;`).
    if (b.type.kind === 'texture' || b.type.kind === 'sampler') {
      return `@group(${b.group}) @binding(${b.binding}) var ${b.name}: ${wgslType(b.type)};`
    }
    const space = b.space === 'storage' ? `storage, ${b.access ?? 'read'}` : 'uniform'
    return `@group(${b.group}) @binding(${b.binding}) var<${space}> ${b.name}: ${wgslType(b.type)};`
  },
  emitFunc: (f, parens) => {
    const params = f.params.map((p) => `${paramAttr(p)}${p.name}: ${wgslType(p.type)}`).join(', ')
    const ret =
      f.ret.kind === 'void' ? '' : ` -> ${f.retAttr ? `${f.retAttr} ` : ''}${wgslType(f.ret)}`
    const attrs = f.attrs && f.attrs.length ? `${f.attrs.join(' ')}\n` : ''
    return `${attrs}fn ${f.name}(${params})${ret} {\n${emitBody(f.body, 1, wgslBackend, parens)}\n}`
  },
  // WGSL's emit-time optimizer: the full pipeline run to a fixed point — const/copy
  // propagation, const-fold (incl. literal compare/logical/select), algebraic
  // identities, dead-branch elim, cse auto-cache, licm, dce. Authors write plain
  // inline exprs; the optimizer folds constants, drops dead code, and binds reuse for
  // them. Correctness: oracle value-equality (unit) + the real-GPU optimizer-parity
  // gate (_optimizer-gpu-parity). Every pass skips a fn containing a raw Stmt (the
  // polygon composer's _mcSS fill/stroke), so those precision-critical paths are
  // emitted verbatim, untouched.
  optimize: (m) => fixpoint(m),
  // The WGSL `enable`-directive header (#628): one `enable <ext>;` per declared cap
  // whose PROFILE ROW carries a directive (#1670 — the host-side rows contribute
  // nothing), deduped + sorted for a deterministic byte order. Bare lines, NO trailing
  // separator — the one contract every backend's preamble keeps (backend.ts); the blank
  // line before the first declaration is added by emit.ts's `directiveHeader`, which
  // owns this target's slot. Empty when the module opts into nothing (or into host-side
  // caps only), so enables-free emit stays byte-identical. assertCaps (run in
  // lowerForBackend, before this string is used) has already guaranteed this backend
  // covers every declared cap.
  modulePreamble: (m) => {
    // Read through `wgslBackend.capProfile` (the emitConst/constDecl self-reference
    // idiom above), not the narrow `satisfies`-typed literal: the literal's type has no
    // key for a cap this target does not support, so indexing it by an arbitrary
    // `Capability` would not typecheck. It is the same object either way.
    const dirs = (m.enables ?? [])
      .map((c) => wgslBackend.capProfile[c]?.directive)
      .filter((d): d is string => d !== undefined)
    if (dirs.length === 0) return ''
    return [...new Set(dirs)]
      .sort()
      .map((d) => `enable ${d};`)
      .join('\n')
  },
}

/** Single-arg WGSL-bound expr emit. The compiler keeps a structural copy
 *  (compiler/src/codegen/node-to-wgsl.ts) pinned against this; match-expr.test
 *  uses it for the defensive-throw probe. */
export const emitExpr = (e: Expr): string => emitExprNeutral(e, wgslBackend)

// The module-decl emit functions live as wgslBackend methods; these thin wrappers keep the
// existing export names + signatures. Only two of the four have a consumer through the
// package entry — see each doc comment, and #1697 for the surface question.

/** Emit one {@link ConstDecl} as a WGSL `const` line, without the surrounding module.
 *
 *  For composing a shader out of separately-authored fragments: emit the consts once, cache
 *  the string, and concatenate. `map/src/shaders/dsl/ecef.ts` and `projections.ts` both use
 *  it this way to publish their constant blocks as module-scope strings.
 *
 *  Byte-identical to the same decl's line inside {@link emitModule}, so a fragment emitted
 *  here and a module emitted there agree — that is the property that makes concatenation
 *  safe. Takes an ALREADY-LOWERED decl: no `override`/spec-constant resolution happens here
 *  (see {@link emitFuncs} for the pipeline caveat, which applies equally). */
export const emitConst = (c: ConstDecl): string => wgslBackend.emitConst(c)

/** Emit one {@link StructDecl} as a WGSL `struct` block.
 *
 *  @internal Reachable only through `index.ts`'s star re-export of this backend module, and
 *  imported by nothing outside it. Unlike {@link emitConst}, no consumer composes structs as
 *  standalone fragments — a struct is meaningful only alongside the bindings and functions
 *  that use it, which is what {@link emitModule} emits. Un-export is tracked by #1697. */
export const emitStruct = (s: StructDecl): string => wgslBackend.emitStruct(s)

/** Emit one {@link BindingDecl} as a WGSL `@group(…) @binding(…) var` line.
 *
 *  @internal Same story as {@link emitStruct}: star-re-exported, imported by nothing outside
 *  this backend. A binding emitted alone is especially misleading — group/binding indices are
 *  assigned across the whole module, so a line taken out of context can disagree with the
 *  layout `reflect()` reports. Un-export is tracked by #1697. */
export const emitBinding = (b: BindingDecl): string => wgslBackend.emitBinding(b)

/** Emit one ALREADY-LOWERED {@link FuncDecl} as a WGSL function.
 *
 *  Prefer {@link emitFuncs} for authored functions. This wrapper spells the decl exactly as
 *  given and runs NONE of the pipeline — no `autoVars`, no match lowering, no `fp64Lower`,
 *  no optimizer — so an authored func that still contains a `match` construct or an `f64`
 *  type will either throw ({@link wgslType} fails loud on the pre-lowering types) or emit
 *  something the optimizer would have folded. It is the right call only when the caller
 *  knows the decl needs no lowering, as `map/src/shaders/dsl/polygon.ts` does for its
 *  hand-written dequantiser.
 *
 *  It also fixes the paren mode. {@link emitModule} threads its `ParenMode` down to the
 *  backend, so under minification it spells the same func with `'minimal'` parens; this
 *  wrapper always takes the `'full'` default. A fragment emitted here therefore matches its
 *  line inside a NON-minified module byte for byte, and may differ inside a minified one. */
export const emitFunc = (f: FuncDecl): string => wgslBackend.emitFunc(f)

/** Emit a bare list of funcs through the SAME lower+optimize pipeline emitModule uses, so the
 *  parity-harness emitted-WGSL accessors (getProjectionWgslFns / ECEF_WGSL_FNS / LOG_DEPTH_WGSL_FNS / …)
 *  stay byte-consistent with the decl-merged module emit — the optimizer applies on BOTH paths, so
 *  folding / dead-code / reuse-binding happen uniformly regardless of which emit path a consumer takes.
 *  (Skips the validate/assertCaps preamble on purpose — a bare func list is not a complete authored
 *  module — so it runs only the lower+optimize the spelling needs; it mirrors `wgslBackend.optimize`
 *  (fixpoint) so this stays byte-identical to the func section of emitModule.) */
export function emitFuncs(funcs: readonly FuncDecl[]): string {
  const lowered = fixpoint(
    fp64Lower(lowerModule(autoVars({ consts: [], structs: [], bindings: [], funcs: [...funcs] }))),
  )
  return lowered.funcs.map((f) => wgslBackend.emitFunc(f)).join('\n\n')
}

/** Legacy alias of {@link emitFuncs}, kept so an existing import keeps resolving.
 *
 *  @internal Star-re-exported, and imported through the package entry by nothing. The one
 *  in-repo reference (`playground/e2e/_absorbed-fn-parity.spec.ts`) reaches it by deep source
 *  path, which does not go through `exports` at all. Being a bare alias, dropping it costs a
 *  caller one rename and never a reimplementation — #1697.
 *
 *  @deprecated Renamed `emitFuncs` — the "Csed" suffix described a pipeline that was
 *  once cse-only and has been the full fixpoint optimizer for a long time. */
export const emitFuncsCsed = emitFuncs

/** Emit a ModuleDecl as a WGSL string. Thin wrapper over the shared backend-parameterised
 *  driver (core/emit.ts) bound to wgslBackend — the module assembly lives once. `opts` is
 *  the optional `{ plugins }` bag (production tooling: `@xgis/shader-dsl/emit-prod`). */
export const emitModule = (m: ModuleDecl, opts?: EmitOptions): string =>
  emitModuleDriver(m, wgslBackend, opts)

/** Emit WGSL at an explicit optimization level (O0/O1/O2). `emitModuleAt(m, 'O2')` is
 *  byte-identical to `emitModule(m)`; O0 is the naive (un-optimized) emit. Drives the
 *  emit-size measurement (core/measure.ts) and debug builds. */
export const emitModuleAt = (m: ModuleDecl, level: OptLevel): string =>
  emitModuleAtDriver(m, wgslBackend, level)

/** The lowered+optimized WGSL ModuleDecl at a level — the SAME pre-emit pipeline `emitModule`
 *  runs (validate → assertCaps → autoVars → lowerModule → optimizeAt), returned as IR rather
 *  than a string. Single source of the lowering recipe so an IR consumer (core/measure.ts's
 *  op-count) and the string emit cannot describe different modules. */
export const lowerWgsl = (m: ModuleDecl, level: OptLevel): ModuleDecl =>
  lowerForBackend(m, wgslBackend, level)
