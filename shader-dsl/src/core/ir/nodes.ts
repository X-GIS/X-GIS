// ═══ Shader DSL — IR node + declaration interfaces ═══
//
// The pure data shapes of the IR: expression nodes (Expr), statement nodes
// (Stmt), and module-level declarations. No Node class, no runtime helpers —
// just the structural types the authoring layer (node.ts/builder.ts) builds and
// the backends consume. Imports only types.ts.

import type { ShaderType } from './types'

// ── Expression nodes ──

/** The operator tag on `Expr.binop` — arithmetic (`+ - * /`), remainder (`%`), and
 *  bitwise (`& | ^ << >>`), spelled identically on WGSL/GLSL and interpreted
 *  identically by the CPU oracle (`scalarBin` in cpu-runtime.ts). `%` is float
 *  TRUNC-mod on WGSL and rejects floats outright on GLSL ES 3.00 — it is NOT the
 *  portable modulo. Reach for {@link mod} instead whenever a negative operand is
 *  possible; it lowers to floor-mod on both targets and is what the `.mod()` Node
 *  method should not be confused for (that method emits this same trunc-mod `%`).
 *  `<<`/`>>` are u32 logical shift unless the operand is known `i32`, in which case
 *  `>>` is sign-preserving arithmetic shift — see `scalarBin`'s `isI32` branch.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type BinOp = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>'
/** The operator tag on `Expr.compare` — the six relational operators, always
 *  producing a `bool` (or `vecN<bool>` for a vector comparison; scalar-only
 *  comparisons on `Node` are enforced at authoring by `Node.cmp`, not by this
 *  type). Shared by `unroll.ts`'s static loop-bound analysis (`flipCmp`,
 *  `cmpHolds`) to reason about compile-time-provable loop trip counts, and by the
 *  WGSL/GLSL/CPU backends to spell or evaluate the comparison identically.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type CmpOp = '<' | '>' | '<=' | '>=' | '==' | '!='
/** The operator tag on `Expr.logical` — short-circuiting boolean `&&`/`||`, always
 *  `bool`-typed on both operands and the result. Kept as its own `Expr.op` rather
 *  than folded into `binop`/`compare` because WGSL and GLSL both give `&&`/`||`
 *  short-circuit evaluation semantics that a plain binary operator does not carry.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type LogOp = '&&' | '||'

/** Every expression shape the IR can hold — the closed set `Node`/`ReadonlyNode`
 *  (node.ts) build fluently and the three backends (WGSL, GLSL, the CPU oracle)
 *  walk to emit or evaluate. A discriminated union on `op`, never a class: no
 *  method lives on an `Expr`, so a pass can pattern-match exhaustively (tsc flags
 *  a missing `case` on every backend's switch) and structurally-share subtrees
 *  without an identity concern. Every variant carries its own `type: ShaderType` —
 *  the IR is fully typed at construction, so a backend never re-infers a type
 *  while emitting. Authors do not build these object literals by hand; go through
 *  `Node`'s fluent methods (`.add()`, `.mul()`, …) or the free functions in
 *  node.ts (`vec4()`, `mod()`, …), which fill in `type` correctly and validate
 *  the operands before this shape is ever constructed.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type Expr =
  | { readonly op: 'lit'; readonly type: ShaderType; readonly value: number | boolean }
  | { readonly op: 'constref'; readonly type: ShaderType; readonly name: string }
  // A read of a pipeline SPECIALIZATION CONSTANT (#923) — a `ModuleDecl.overrides`
  // entry. Structurally a named leaf like `constref`, but SEMANTICALLY OPAQUE to the
  // authoring-time optimizer: its value is fixed at PIPELINE CREATION (WGSL `constants:
  // {}` / a GLSL `#define` per permutation), NOT module build, so const-fold /
  // const-prop / dead-branch must treat it as symbolic and preserve every branch it
  // guards for the DRIVER to eliminate (same opacity discipline as the df64 `one`
  // guard). Its own `op` — not reused `constref` — precisely so no pass ever folds it
  // (a future "inline a known-value const" pass could legally fold a real constref;
  // it can never fold an overrideref). Emits as the bare name on both backends
  // (WGSL: the `override` identifier; GLSL: the `#define` macro).
  | { readonly op: 'overrideref'; readonly type: ShaderType; readonly name: string }
  // A read of a HOST-PROVIDED global (#1713) — a `ModuleDecl.externs` entry. The variable
  // twin of `externFn`: the host's prelude (MapLibre's injected GLSL globals, a host-owned
  // WGSL bind group) declares it, we only reference it, and the module emits NO
  // declaration for it. Its own `op` — not a reused `varref` — for three reasons that a
  // shared node cannot serve: `varref` names are function-SCOPED for mangling and would be
  // renamed; the GLSL stage scope intersects `RefSet.vars` against `m.bindings` to decide
  // which bindings a stage keeps, and a host global is in neither set; and `reflect()` has
  // to report it under `requires` rather than as a binding. Emits as the bare name, or as
  // the per-target spelling when the host spells it differently on each backend.
  | { readonly op: 'externref'; readonly type: ShaderType; readonly name: string }
  | { readonly op: 'param'; readonly type: ShaderType; readonly name: string }
  | { readonly op: 'varref'; readonly type: ShaderType; readonly name: string }
  | {
      readonly op: 'binop'
      readonly type: ShaderType
      readonly bop: BinOp
      readonly a: Expr
      readonly b: Expr
    }
  | { readonly op: 'unop'; readonly type: ShaderType; readonly a: Expr }
  | {
      readonly op: 'compare'
      readonly type: ShaderType
      readonly cop: CmpOp
      readonly a: Expr
      readonly b: Expr
    }
  | {
      readonly op: 'logical'
      readonly type: ShaderType
      readonly lop: LogOp
      readonly a: Expr
      readonly b: Expr
    }
  // `declRef` (present only on calls made through a real FnHandle — absent on externFn /
  // raw callFn string calls) points at the callee's FuncDecl so module() can auto-collect
  // transitively-called fns and key-naming can rewrite call spellings. NEVER read by the
  // emit path (the spelling stays `fn`), never serialized, dropped freely by pass rewrites
  // (collection runs at assembly time, before any pass).
  | {
      readonly op: 'call'
      readonly type: ShaderType
      readonly fn: string
      readonly args: readonly Expr[]
      readonly declRef?: FuncDecl
    }
  | {
      readonly op: 'member'
      readonly type: ShaderType
      readonly base: Expr
      readonly field: string
    }
  | { readonly op: 'construct'; readonly type: ShaderType; readonly args: readonly Expr[] }
  | {
      readonly op: 'select'
      readonly type: ShaderType
      readonly cond: Expr
      readonly ifTrue: Expr
      readonly ifFalse: Expr
    }
  | { readonly op: 'index'; readonly type: ShaderType; readonly base: Expr; readonly idx: Expr }
  // `match (scrutinee) { case v0: e0; ...; default: dflt }`. The WGSL backend
  // pre-emit pass (core/passes/match-lower.ts) lowers every matchExpr inside
  // an fn body into a hoisted `{ Stmt.var slot, Stmt.switch }` pair + a
  // varref to the slot; emitExpr never sees a `matchExpr` Expr post-lowering.
  // The CPU backend evaluates the scrutinee then returns the matched case's
  // value or the default. Phase 2.5 (US-001).
  | {
      readonly op: 'matchExpr'
      readonly type: ShaderType
      readonly scrutinee: Expr
      readonly cases: ReadonlyArray<readonly [number, Expr]>
      readonly default: Expr
    }

// ── Statement nodes ──

/** Every statement shape the IR can hold — the ordered `readonly Stmt[]` that
 *  makes up a `FuncDecl.body`. A discriminated union on `s`, mirroring {@link Expr}'s
 *  design: no class, so a backend's emit switch is tsc-checked exhaustive, and a
 *  pass (e.g. match-lower.ts, unroll.ts) can rebuild a body by mapping over plain
 *  data. Authors do not build these object literals directly; `Builder`
 *  (builder.ts) — reached inside an `fn()` body as its second callback argument —
 *  pushes them one at a time (`b.let(...)`, `b.var(...)`, `b.if(...)`, `b.ret(...)`,
 *  …), so the body array is always assembled in source order.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type Stmt =
  | { readonly s: 'let'; readonly name: string; readonly expr: Expr }
  | { readonly s: 'var'; readonly name: string; readonly type: ShaderType; readonly init?: Expr }
  | { readonly s: 'assign'; readonly target: Expr; readonly expr: Expr }
  | { readonly s: 'assignOp'; readonly target: Expr; readonly bop: BinOp; readonly expr: Expr }
  | {
      readonly s: 'if'
      readonly arms: ReadonlyArray<{ readonly cond: Expr; readonly body: readonly Stmt[] }>
      readonly elseBody?: readonly Stmt[]
    }
  | { readonly s: 'return'; readonly expr?: Expr }
  | {
      readonly s: 'for'
      readonly init: Stmt
      readonly cond: Expr
      readonly update: Stmt
      readonly body: readonly Stmt[]
    }
  | {
      readonly s: 'switch'
      readonly scrut: Expr
      readonly cases: ReadonlyArray<{ readonly value: number; readonly body: readonly Stmt[] }>
      readonly defaultBody?: readonly Stmt[]
    }
  | { readonly s: 'break' }
  | { readonly s: 'continue' }
  | { readonly s: 'discard' }
  // Phase 2.5 US-007 — composer-swap marker. The polygon DSL module
  // (shaders/polygon.ts) lays down a placeholder Stmt at each
  // variant-injection site (`fill-return` / `stroke-return`); the
  // composer (emitPolygonWgsl) walks the cloned module and replaces
  // each placeholder with the variant's fill-/stroke- return expr.
  // emitStmt emits a defensive `// __placeholder: ${tag}` comment if
  // a placeholder leaks past the composer; the CPU backend throws
  // (the comment would silently no-op a missing return). The
  // lowerModule pre-emit pass treats placeholder as a leaf — no
  // matchExpr lowering descends into it.
  | { readonly s: 'placeholder'; readonly tag: string }
  // Phase 2 PR 2e.B.2 — raw passthrough. Carries a pre-built target
  // fragment emitted verbatim (at the enclosing body indent) before the
  // surrounding statements. Used by the polygon composer's fill/stroke
  // preamble slot to inject the compiler-emitted match `_mcSS` chain
  // string directly, retiring the renderer's former post-emit string
  // splice (+ the compiler-side nodeToWgslString copy). GPU-only: the
  // CPU backend throws (raw text has no CPU evaluation), and the
  // lowerModule pass treats it as a leaf (no sub-Expr to lower).
  //
  // #1671 — PAIRED PER-TARGET PAYLOADS. One node carries the SAME statement
  // spelled for each backend; the MEANING is fixed ("splice verbatim here")
  // and only the SPELLING is per-target — the same per-target-spelling pattern
  // `INTRINSICS`' `Spelling` record already uses (intrinsics.ts:15-19). Unlike
  // `Spelling` (which requires BOTH sides), ONE side may be omitted here — a
  // deliberate "this module does not build for that target" — but AT LEAST ONE
  // side is required at the type level, which is why this is spelled as two
  // members: a raw with NO payload is unrepresentable.
  // Each backend emits ITS side and fails closed (SD0030) when its side is
  // absent — SYMMETRICALLY: a wgsl-only raw throws on the GLSL backend and a
  // glsl-only raw throws on the WGSL one. A one-sided raw is therefore still
  // a hard "this module does not build for that target", never a silent
  // mis-emit.
  | { readonly s: 'raw'; readonly wgsl: string; readonly glsl?: string }
  | { readonly s: 'raw'; readonly wgsl?: string; readonly glsl: string }

/** The `raw` statement node (#1671) — the per-target verbatim-splice escape
 *  hatch. Named so the Backend contract can take the NODE (`rawStmt(s: RawStmt)`)
 *  and pick its own payload, keeping the shared emit walk target-blind.
 *  `Extract` unions BOTH raw members, so this is the whole at-least-one shape. */
export type RawStmt = Extract<Stmt, { s: 'raw' }>

/** The at-least-one authoring payload behind `rawStmt(payload)` — a raw with NO
 *  payload is unrepresentable (`rawStmt({})` does not compile). */
export type RawPayload =
  | { readonly wgsl: string; readonly glsl?: string }
  | { readonly wgsl?: string; readonly glsl: string }

// ── Module-level declarations ──

/** A `ModuleDecl.consts` entry — a module-scope constant. Authored either as a
 *  plain object literal for the common dual-precision scalar case —
 *  `{ name: 'PI', type: f32T, wgslValue: 3.14159265, cpuValue: Math.PI }`
 *  (projections.ts) truncates on the GPU targets while the CPU oracle keeps full
 *  `Math.PI` precision, so the two stay within the codebase's documented f32/f64
 *  tolerance — or via {@link constExpr} for a vector/array/struct literal, which
 *  routes through `valueExpr` instead. See that field's doc for which form wins
 *  when both are present.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export interface ConstDecl {
  readonly name: string
  readonly type: ShaderType
  /** Scalar value emitted by the WGSL/GLSL backends (the truncated shader
   *  constant). Used when `valueExpr` is absent; ignored otherwise. */
  readonly wgslValue: number
  /** Scalar value used by the CPU backend (full-precision, matching the
   *  mirror). Used when `valueExpr` is absent; ignored otherwise. */
  readonly cpuValue: number
  /** OPTIONAL general constant value as an IR literal expression — e.g.
   *  `vec4<f32>(…)` colour, `array<vec4<f32>, N>(…)` palette, or a struct
   *  literal. When present it SUPERSEDES `wgslValue`/`cpuValue` on every backend
   *  (WGSL + GLSL emit it, the CPU oracle evaluates it), making vector / array /
   *  struct module constants first-class rather than scalar-only. Must be a
   *  constant-foldable literal expression (`lit` / `construct` / `unop` /
   *  `binop` over those, or `constref` to an earlier const) — it may not read a
   *  binding, parameter, or runtime input. The scalar dual-precision path stays
   *  the default for ordinary `f32` consts (e.g. truncated `PI` vs `Math.PI`). */
  readonly valueExpr?: Expr
}

/** A pipeline SPECIALIZATION CONSTANT (#923) — the authored declarator behind
 *  `overrideConst(name, type, default)`. Lowers to a WGSL module-scope `override
 *  name: type = default;` (the host specializes it via `createRenderPipeline({
 *  constants: { name } })`) and to a GLSL `#define name default` permutation seam
 *  (the host specializes by re-emitting with `emitGlslModule(m, stage, { overrideValues })`
 *  — a prepended `#define` is invalid GLSL, so the emitter places it after `#version`).
 *  The value is chosen at
 *  PIPELINE CREATION, not module build — so a single authored module yields N
 *  driver-specialized variants whose dead branches the DRIVER eliminates.
 *  WGSL scalars ONLY (`bool`/`i32`/`u32`/`f32`; `f16` once it joins the Scalar
 *  union, gated by the #957 f16 enable) — vec/matrix/array/struct are rejected at
 *  authoring (SD0014). */
export interface OverrideDecl {
  readonly name: string
  readonly type: ShaderType
  /** The default value emitted into the `override` declaration / `#define` — the
   *  value a pipeline gets when the host injects nothing for this constant. */
  readonly default: number | boolean
}

/** One field of a {@link StructDecl} — a plain data member (uniform/storage struct)
 *  or, for a vertex/fragment I/O struct, a member carrying an `@builtin`/`@location`
 *  attribute. Authors build these via `sot.ts`'s {@link builtin}/{@link location}
 *  helpers (which fill both `attr` and its structured twin) rather than by hand;
 *  the GLSL backend ignores `attr` entirely and reads `location`/`builtin` directly
 *  — GLSL ES 3.00 has no struct-field attribute syntax, so I/O structs are
 *  flattened to individual `in`/`out` globals keyed off those structured fields.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export interface StructField {
  readonly name: string
  readonly type: ShaderType
  /** Optional WGSL field attribute(s) for I/O structs, e.g.
   *  `@builtin(position)`, `@location(0)`, `@location(0) @interpolate(flat)`.
   *  This is the EMIT SPELLING; the structured fields below are the semantic
   *  source (#740 R3) — backends read those, never re-parse this string. */
  readonly attr?: string
  /** Structured IO attribute (#740 R3): `@location(n)`. Set by sot's location(). */
  readonly location?: number
  /** Structured IO attribute (#740 R3): `@builtin(name)`. Set by sot's builtin(). */
  readonly builtin?: string
  /** Structured `@interpolate(mode)` (set alongside `location`). */
  readonly interpolate?: string
}
/** A `ModuleDecl.structs` entry — a WGSL `struct` declaration, doubling as a
 *  GLSL plain struct or a flattened I/O `in`/`out` block depending on how its
 *  fields' `location`/`builtin` are read (see {@link StructField}). Authors
 *  reach for the `sot.ts` helpers ({@link uniformStruct}, {@link ioStruct}) to
 *  derive one alongside its binding and typed field access rather than writing
 *  this shape by hand.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export interface StructDecl {
  readonly name: string
  readonly fields: readonly StructField[]
}

/** The `BindingDecl.space` a resource binding lives in — WGSL's `var<uniform>` vs
 *  `var<storage, ...>`. Drives the WGSL backend's declaration spelling directly
 *  (`emitBinding` in wgsl.ts) and the GLSL backend's choice between a `uniform`
 *  block and an emulated storage-buffer path (WebGL2 GLSL ES 3.00 has no native
 *  SSBO) — see {@link BindingDecl.access}, which only applies when this is
 *  `'storage'`.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type AddressSpace = 'uniform' | 'storage'
/** A `ModuleDecl.bindings` entry — a resource bound at a `(group, binding)` slot:
 *  a uniform buffer, a storage buffer, a texture, or a sampler, keyed by `type`
 *  (a `structT`/scalar/array type means a buffer; a `texture`/`sampler`
 *  `ShaderType.kind` means a handle resource with no address space). WGSL emits
 *  both `group` and `binding`; GLSL ES 3.00 has a single binding namespace, so
 *  its backend reads `binding` only and `group` is WGSL-only bookkeeping (still
 *  used by `reflect()` to group resources per WGSL bind-group-layout convention).
 *  Authors derive this via `sot.ts`'s {@link uniformStruct} / {@link resource} /
 *  {@link storageBuffer} rather than constructing it directly.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export interface BindingDecl {
  readonly group: number
  readonly binding: number
  readonly name: string
  readonly space: AddressSpace
  /** storage access — read | read_write (ignored for uniform). */
  readonly access?: 'read' | 'read_write'
  readonly type: ShaderType
  /** WHO OWNS this resource (#1710). `'module'` (the default) is ours: we declare it, we
   *  describe its layout, and a host builds its bind group from `reflect()`. `'host'` says
   *  the resource belongs to the surrounding renderer — MapLibre's injected globals, or a
   *  bind group a host-integrated WebGPU renderer hands us — so the HOST's layout is the
   *  authority and `reflect()` reports it under `hostResources` rather than as ours to
   *  create. Ownership is orthogonal to spelling: a host-owned binding is still DECLARED
   *  in our source (that is what makes it type-checkable), it is just not ours to
   *  allocate. A symbol the host's prelude ALREADY declares is a different thing —
   *  `externVar` (#1713), which emits nothing at all. */
  readonly owner?: 'module' | 'host'
  /** GLSL ES 3.00 precision qualifier for this declaration (#1710). GLSL-only; WGSL has no
   *  such concept and ignores it. Without it the declaration takes the stage default from
   *  the precision preamble, which is right for a module that owns its own header and
   *  wrong for a FRAGMENT composed into a host program whose preamble we do not control —
   *  the case that made a consumer re-add precision with a second post-process. */
  readonly precision?: 'highp' | 'mediump' | 'lowp'
}

/** A HOST-PROVIDED global (#1713) — the authored declarator behind `externVar(name, type)`,
 *  and the variable twin of `externFn`.
 *
 *  Emits NOTHING on either backend: the host's prelude declares it, and this exists so the
 *  reference type-checks, survives `mangle`, and appears in `reflect().requires` where a
 *  composer can check it against what the prelude actually provides. `externFn` cannot
 *  serve as the template here — it carries no declaration at all, only a call factory, so
 *  there is nothing for reflection or mangling to see. `OverrideDecl` is the shape this
 *  follows instead: a named module-scope symbol with its own leaf op.
 *
 *  `spelling` maps the logical name onto what each target actually writes, so a migration
 *  to a host that exposes the same value differently (a WGSL struct member or bound
 *  uniform instead of a GLSL prelude global) is a spelling-map change and not a source
 *  rewrite — the whole reason to declare these abstractly now. */
export interface ExternVarDecl {
  readonly name: string
  readonly type: ShaderType
  /** Per-target spelling. A missing side falls back to `name`. */
  readonly spelling?: { readonly wgsl?: string; readonly glsl?: string }
  /** Restrict the symbol to one stage, for a host global only that stage's prelude
   *  provides. Advisory metadata for `reflect().requires`; nothing gates on it yet. */
  readonly stage?: 'vertex' | 'fragment' | 'compute'
}

/** Non-enumerable marker: the name a decl was LAST assembled under (#763 D4).
 *  Symbol.for — survives dual-instance loads like the node brand. Declared here
 *  (not builder.ts) so FuncDecl can name it as a computed key with no
 *  builder→nodes import cycle. */
export const ASSEMBLED_AS = Symbol.for('xgis.shader-dsl.assembledAs')

/** A `ModuleDecl.funcs` entry — a WGSL/GLSL function, ordinary or a pipeline
 *  entry point (`stage` set). This is the object the fluent authoring layer
 *  ({@link fn}) BUILDS: a `FnHandle` returned by `fn()` mixes this shape's
 *  fields onto itself so it is simultaneously a typed callable in other
 *  functions' bodies AND, unwrapped, the plain `FuncDecl` a `module({ funcs })`
 *  collects. Every backend (WGSL, GLSL, the CPU codegen/oracle) walks `body`
 *  directly — there is no separate typed-AST layer between authoring and emit.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export interface FuncDecl {
  readonly name: string
  readonly params: readonly {
    name: string
    type: ShaderType
    builtin?: string
    location?: number
    interpolate?: string
    attr?: string
  }[]
  readonly ret: ShaderType
  readonly body: readonly Stmt[]
  /** Stage / pipeline attributes emitted before `fn` (e.g. `@compute`,
   *  `@workgroup_size(64)`). Empty for ordinary helper functions. This is the
   *  EMIT SPELLING; `stage`/`workgroupSize` below are the semantic source
   *  (#740 R3) — reflect/backends read those first (string fallback only for
   *  hand-built FuncDecl literals). */
  readonly attrs?: readonly string[]
  /** Structured pipeline stage (#740 R3). Set by fn()'s opts.stage. */
  readonly stage?: 'vertex' | 'fragment' | 'compute'
  /** Structured workgroup size for a compute stage (#740 R3). */
  readonly workgroupSize?: number
  /** Return-value attribute for a bare (non-struct) stage output, e.g. a
   *  fragment `-> @location(0) vec4<f32>`. */
  readonly retAttr?: string
  /** Structured builtin id when `retAttr` came from a `builtin(name, type)` FieldSpec
   *  (#740 R3 twin of `retAttr` — the spelling stays in retAttr, the SEMANTIC id lives
   *  here so target-vocabulary gates like assertBuiltins (#1672) can read it without
   *  re-parsing the attr string). */
  readonly retBuiltin?: string
  /** Documented MISRA single-exit DEVIATION — when true the single-exit static
   *  rule skips this fn (it has an intentional early return, e.g. a guard that
   *  skips an expensive loop). Use sparingly, with a comment stating why. */
  readonly allowEarlyReturn?: boolean
  /** Documented lint DEVIATIONS — rule ids whose diagnostics are suppressed for this
   *  fn (the general form of allowEarlyReturn; the engine drops matching diagnostics).
   *  Use sparingly, with a comment stating why. */
  readonly lintDisable?: readonly string[]
  /** The name this decl was LAST assembled under (#763 D4) — a non-enumerable
   *  Symbol marker installed at assembly via Object.defineProperty (normalizeFuncs
   *  in builder.ts). Declared type-level ONLY so the read typechecks without a cast;
   *  never part of an authored FuncDecl literal. */
  readonly [ASSEMBLED_AS]?: string
}

/** A GPU / language feature a target backend may or may not support (#9, #628, #1670).
 *  Emit of an unsupported feature is a typed error (UnsupportedFeatureError), never a
 *  silent mis-emit: a cap absent from the target's `capProfile` (core/backend.ts) fails
 *  closed at assertCaps, naming it.
 *
 *  Ids are NEUTRAL (#1650 convention) — never a raw `EXT_*` / `OVR_*` string in a
 *  module. Each backend's `capProfile` row translates the id into that target's
 *  `hostFeature` (what the host activates: `gl.getExtension(...)` on WebGL2, a
 *  `requiredFeatures` entry on WebGPU) and its `directive` (what the emitted source
 *  says), so the same module ports across targets whose extension names do not.
 *
 *  THREE provenance classes:
 *  - DERIVED resource caps — `storageBuffer`, `compute`, `msaaTextureLoad`: inferred
 *    from a module's SHAPE (a storage binding, a `@compute` entry, an MSAA texture
 *    load), never declared.
 *  - OPT-IN LANGUAGE caps — `f16`, `subgroups`: declared via `ModuleDecl.enables`; each
 *    is a WGSL `enable`-directive extension and has no GLSL ES 3.00 counterpart, so
 *    both stay OUT of the GLSL profile and a module using them fails closed there.
 *  - OPT-IN DEVICE/EXTENSION caps (#1670) — declared via `ModuleDecl.enables`, and NOT
 *    language features: they change what the DEVICE can do, not what the source may
 *    spell. `floatRenderTarget` (WebGL2 EXT_color_buffer_float / WebGPU core),
 *    `float32Blend` (EXT_float_blend / WebGPU 'float32-blendable') and
 *    `float32Filterable` (OES_texture_float_linear / WebGPU 'float32-filterable') are
 *    the HOST-side trio: on WebGL2 they are activated by `gl.getExtension` before
 *    pipeline creation and there is NO shader-source token for them, so declaring one
 *    must not move a single emitted byte on either target. `multiview` is the one
 *    SOURCE-DIRECTIVE cap — GLSL ES 3.00 needs `#extension GL_OVR_multiview2 : require`
 *    in the shader itself — which is what proves the `#extension` emission path end to
 *    end; WebGPU has no OVR_multiview2, so it is absent from the WGSL profile and a
 *    multiview module fails closed there. CAVEAT: `multiview` buys the DIRECTIVE only.
 *    The DSL cannot yet spell `layout(num_views = N) in;` or read `gl_ViewID_OVR`, so a
 *    module declaring it emits the `#extension` line and still renders SINGLE-VIEW; the
 *    cap exists to prove the `#extension` mechanism, and real multiview authoring is a
 *    follow-up.
 *
 *  BITWIDTH IN THE NAME, only where the feature is bitwidth-specific: `float32Blend` and
 *  `float32Filterable` carry the `32` because both underlying features are 32F-only
 *  (EXT_float_blend, WebGPU 'float32-blendable' / 'float32-filterable').
 *  `floatRenderTarget` deliberately carries none — EXT_color_buffer_float makes 16F AND
 *  32F attachments renderable, so a bitwidth in that id would be a lie.
 *
 *  Motivating consumers: #1661 (rgba16float sampling / float render targets in the
 *  WebGL2 RHI). The host reads what to activate off `reflect().requiredFeatures`. */
export type Capability =
  | 'storageBuffer'
  | 'compute'
  | 'msaaTextureLoad'
  | 'f16'
  | 'subgroups'
  | 'floatRenderTarget'
  | 'float32Blend'
  | 'float32Filterable'
  | 'multiview'

/** Every {@link Capability}, as a runtime value (#1717) — the enumeration a
 *  capability-matrix renderer, a doc generator or a coverage gate iterates.
 *
 *  Hand-listed because a union type has no runtime form, and kept honest by the
 *  `satisfies` below plus `capability-matrix.test.ts`'s round trip: a new union member that
 *  is not added here fails the exhaustiveness check rather than quietly shrinking every
 *  consumer's view of the vocabulary. */
export const ALL_CAPABILITIES = [
  'storageBuffer',
  'compute',
  'msaaTextureLoad',
  'f16',
  'subgroups',
  'floatRenderTarget',
  'float32Blend',
  'float32Filterable',
  'multiview',
] as const satisfies readonly Capability[]

/** The caps an AUTHOR may name in `ModuleDecl.enables` (#1681 A2) — `Capability` minus
 *  the three DERIVED resource caps. Those three are inferred from the module's SHAPE by
 *  `requiredCaps` (a storage binding ⇒ `storageBuffer`, a `@compute` entry ⇒ `compute`,
 *  an MSAA texture ⇒ `msaaTextureLoad`), so declaring one is at best a no-op restatement
 *  of the shape and at worst a LIE the emit then gates on — the doc above always said
 *  "never declared here", and this is that sentence made unrepresentable rather than
 *  merely written down.
 *
 *  Only the AUTHORING surface narrows: `requiredCaps` / `Capabilities` / `CapProfile`
 *  keep reading the full `Capability`, because the derived caps are exactly what they
 *  must be able to express. */
export type DeclarableCapability = Exclude<
  Capability,
  'storageBuffer' | 'compute' | 'msaaTextureLoad'
>

/** THE whole-shader unit: everything a backend needs to emit a complete WGSL or
 *  GLSL ES 3.00 module (or evaluate one on the CPU oracle) — consts, structs,
 *  bindings, functions, and the two opt-in seams (`overrides`, `enables`).
 *  Authors assemble one via {@link module}, which dedupes/merges `uses:`-derived
 *  decls rather than requiring every struct/binding to be restated by hand; a
 *  hand-built `ModuleDecl` object literal works too (backends only ever read
 *  this shape) but loses that convenience. This is the argument every backend
 *  entry point takes — {@link emitModule} (WGSL), {@link emitGlslModule}, the CPU
 *  oracle's {@link compileModule} — so it is the seam where authoring ends and
 *  backend-neutral emit begins.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export interface ModuleDecl {
  readonly consts: readonly ConstDecl[]
  readonly structs: readonly StructDecl[]
  readonly bindings: readonly BindingDecl[]
  readonly funcs: readonly FuncDecl[]
  /** HOST-PROVIDED globals (#1713) — `externVar(...)` declarators. Each emits NOTHING and
   *  appears in `reflect().requires`, so a composer can check the module's expectations
   *  against what the host prelude supplies. Absent/empty ⇒ byte-identical emit. */
  readonly externs?: readonly ExternVarDecl[]
  /** Pipeline SPECIALIZATION CONSTANTS (#923) — `overrideConst(...)` declarators.
   *  Each emits a WGSL module-scope `override` + a GLSL `#define` permutation seam,
   *  is reported by `reflect()` (so the host knows the WGSL `constants` dict / GLSL
   *  define header), and reads OPAQUELY in bodies (`overrideref`) so the optimizer
   *  preserves the branches they guard for the driver to eliminate. Absent/empty ⇒
   *  no override declaration, byte-identical emit. */
  readonly overrides?: readonly OverrideDecl[]
  /** OPT-IN capabilities this module turns on (#628, #1670) — e.g. `['f16']`,
   *  `['floatRenderTarget']`. Each folds into requiredCaps, so a backend whose
   *  `capProfile` lacks it fails closed (UnsupportedFeatureError naming the cap), and a
   *  backend whose row carries a `directive` emits it (WGSL `enable f16;`, GLSL
   *  `#extension GL_OVR_multiview2 : require`). A row with NO directive is HOST-side
   *  only — the host activates it off `reflect().requiredFeatures` and the emit stays
   *  byte-identical. Absent/empty ⇒ no directive, byte-identical emit. Resource caps
   *  (storageBuffer/compute/msaaTextureLoad) are DERIVED from the module shape, never
   *  declared here — `DeclarableCapability` (#1681 A2) makes that unrepresentable, so
   *  naming one is a COMPILE error rather than a comment an author can miss. */
  readonly enables?: readonly DeclarableCapability[]
}

/** THE stage predicate (#763 S1) — structured `stage` first, attr-string fallback
 *  only for hand-built FuncDecl literals (#740 R3 contract). Every stage/entry
 *  decision (reflect, capability gate, GLSL entry classification, fn-DCE roots)
 *  goes through this one helper so the predicates cannot drift apart again. */
export const stageOf = (
  f: Pick<FuncDecl, 'stage' | 'attrs'>,
): 'vertex' | 'fragment' | 'compute' | undefined =>
  f.stage ??
  (f.attrs?.some((a) => a.startsWith('@vertex'))
    ? 'vertex'
    : f.attrs?.some((a) => a.startsWith('@fragment'))
      ? 'fragment'
      : f.attrs?.some((a) => a.startsWith('@compute'))
        ? 'compute'
        : undefined)

/** Workgroup size of a compute entry — structured field first, attr fallback (#763 S1). */
export const workgroupSizeOf = (
  f: Pick<FuncDecl, 'workgroupSize' | 'attrs'>,
): number | undefined => {
  if (f.workgroupSize !== undefined) return f.workgroupSize
  const m = f.attrs?.map((a) => a.match(/@workgroup_size\((\d+)/)).find(Boolean)
  return m ? Number(m[1]) : undefined
}

/** An entry-point parameter — carries a `@builtin(...)` or a `@location(n)`. */
export interface EntryParam {
  readonly name: string
  readonly type: ShaderType
  readonly builtin?: string
  readonly location?: number
}
