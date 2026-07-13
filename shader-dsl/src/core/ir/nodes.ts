// ═══ Shader DSL — IR node + declaration interfaces ═══
//
// The pure data shapes of the IR: expression nodes (Expr), statement nodes
// (Stmt), and module-level declarations. No Node class, no runtime helpers —
// just the structural types the authoring layer (node.ts/builder.ts) builds and
// the backends consume. Imports only types.ts.

import type { ShaderType } from './types'

// ── Expression nodes ──

export type BinOp = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>'
export type CmpOp = '<' | '>' | '<=' | '>=' | '==' | '!='
export type LogOp = '&&' | '||'

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
  // Phase 2 PR 2e.B.2 — raw WGSL passthrough. Carries a pre-built WGSL
  // fragment emitted verbatim (at the enclosing body indent) before the
  // surrounding statements. Used by the polygon composer's fill/stroke
  // preamble slot to inject the compiler-emitted match `_mcSS` chain
  // string directly, retiring the renderer's former post-emit string
  // splice (+ the compiler-side nodeToWgslString copy). GPU-only: the
  // CPU backend throws (raw WGSL has no CPU evaluation), and the
  // lowerModule pass treats it as a leaf (no sub-Expr to lower).
  | { readonly s: 'raw'; readonly wgsl: string }

// ── Module-level declarations ──

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
export interface StructDecl {
  readonly name: string
  readonly fields: readonly StructField[]
}

export type AddressSpace = 'uniform' | 'storage'
export interface BindingDecl {
  readonly group: number
  readonly binding: number
  readonly name: string
  readonly space: AddressSpace
  /** storage access — read | read_write (ignored for uniform). */
  readonly access?: 'read' | 'read_write'
  readonly type: ShaderType
}

/** Non-enumerable marker: the name a decl was LAST assembled under (#763 D4).
 *  Symbol.for — survives dual-instance loads like the node brand. Declared here
 *  (not builder.ts) so FuncDecl can name it as a computed key with no
 *  builder→nodes import cycle. */
export const ASSEMBLED_AS = Symbol.for('xgis.shader-dsl.assembledAs')

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

/** A GPU / language feature a target backend may or may not support (#9, #628).
 *  Resource caps (`storageBuffer`, `compute`, `msaaTextureLoad`) are DERIVED from a
 *  module's shape (a storage binding, a `@compute` entry, an MSAA texture load);
 *  language-feature caps (`f16`, `subgroups`) are OPT-IN via `ModuleDecl.enables`.
 *  Emit of an unsupported feature is a typed error (UnsupportedFeatureError), never a
 *  silent mis-emit — the WGSL writer covers every cap here, the GLSL ES 3.00 writer
 *  covers none, so any cap fails closed on GLSL. */
export type Capability = 'storageBuffer' | 'compute' | 'msaaTextureLoad' | 'f16' | 'subgroups'

export interface ModuleDecl {
  readonly consts: readonly ConstDecl[]
  readonly structs: readonly StructDecl[]
  readonly bindings: readonly BindingDecl[]
  readonly funcs: readonly FuncDecl[]
  /** Pipeline SPECIALIZATION CONSTANTS (#923) — `overrideConst(...)` declarators.
   *  Each emits a WGSL module-scope `override` + a GLSL `#define` permutation seam,
   *  is reported by `reflect()` (so the host knows the WGSL `constants` dict / GLSL
   *  define header), and reads OPAQUELY in bodies (`overrideref`) so the optimizer
   *  preserves the branches they guard for the driver to eliminate. Absent/empty ⇒
   *  no override declaration, byte-identical emit. */
  readonly overrides?: readonly OverrideDecl[]
  /** OPT-IN language-feature capabilities this module turns on (#628) — e.g.
   *  `['f16']`. Each folds into requiredCaps, so a backend lacking it fails closed
   *  (GLSL ES 3.00 → UnsupportedFeatureError) while the WGSL backend emits the
   *  matching `enable <ext>;` directive at the top of the module. Absent/empty ⇒ no
   *  directive, byte-identical emit. Resource caps (storageBuffer/compute/
   *  msaaTextureLoad) are DERIVED from the module shape, never declared here. */
  readonly enables?: readonly Capability[]
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
