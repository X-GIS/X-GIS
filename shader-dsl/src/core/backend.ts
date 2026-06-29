// ═══ Shader DSL — the Backend plugin contract ═══
//
// A Backend is a target writer (WGSL, GLSL ES 3.00, later SPIR-V/MSL). The emit
// driver is generic; it calls into the backend for every target-specific
// decision. The IR carries no target lexemes — all spelling lives here.
//
// S1 scope: the type + literal spelling surface + a capability model. The
// intrinsic-spelling surface (`intrinsic`) and the IO/resource lowering are
// threaded in later steps; until then the WGSL writer keeps its inline spelling
// and remains byte-identical.

import type {
  ShaderType, ConstDecl, StructDecl, BindingDecl, FuncDecl, ModuleDecl,
} from './ir'
import { ShaderDslError } from './diagnostics/error'

/** GPU features a target may or may not support; emit of an unsupported feature
 *  must be a typed error, never silent mis-emit. */
export type Capability = 'storageBuffer' | 'compute' | 'msaaTextureLoad'

export class Capabilities {
  constructor(private readonly set: ReadonlySet<Capability>) {}
  has(c: Capability): boolean { return this.set.has(c) }
  /** True iff this target supports everything `reqs` needs. */
  covers(reqs: Iterable<Capability>): boolean {
    for (const c of reqs) if (!this.set.has(c)) return false
    return true
  }
  missing(reqs: Iterable<Capability>): Capability[] {
    const m: Capability[] = []
    for (const c of reqs) if (!this.set.has(c)) m.push(c)
    return m
  }
}

export interface Backend {
  readonly id: string
  readonly caps: Capabilities
  /** Spell a type for this target (e.g. WGSL `vec3<f32>` vs GLSL `vec3`). */
  typeName(t: ShaderType): string
  /** Spell a scalar literal for this target (e.g. WGSL `1u` vs GLSL `1`). */
  literal(value: number | boolean, t: ShaderType): string
  /** Spell an intrinsic / builtin call with already-emitted arg strings.
   *  `name` is the WGSL-canonical id (today's `call.fn`, plus the reserved
   *  `'select'`). The WGSL writer reproduces `name(args)` byte-identically;
   *  a GLSL writer remaps the divergent ones (textureSample→texture,
   *  unpack4x8unorm→unpackUnorm4x8, bitcast<u32>→floatBitsToUint,
   *  select(f,t,c)→ternary) and passes the rest through. User-defined function
   *  calls also flow through here and pass through unchanged. */
  intrinsic(name: string, args: string[]): string

  // ── Divergent statement/declaration fragments ──
  // The control-flow walk (if/for/switch/return/assign/…) is shared in
  // core/emit.ts; only these fragments differ between targets. Each returns the
  // fragment WITHOUT leading indentation or trailing `;` (the walk adds those),
  // except constDecl which is a full line.
  /** `let n = init` (WGSL, type inferred) vs `T n = init` (GLSL). */
  localLet(name: string, type: ShaderType, init: string): string
  /** `var n: T[= init]` (WGSL) vs `T n[= init]` (GLSL). */
  localVar(name: string, type: ShaderType, init?: string): string
  /** A module-level const declaration line, incl. trailing `;`:
   *  `const n: T = v;` (WGSL) vs `const T n = v;` (GLSL). */
  constDecl(name: string, type: ShaderType, value: string): string
  /** A `switch` case label: `${v}u` for a u32 scrutinee on WGSL; `${v}` on GLSL. */
  caseLabel(value: number, scrutType: ShaderType): string
  /** The `switch` head: `switch ${scrut} {` (WGSL) vs `switch (${scrut}) {` (GLSL). */
  switchHead(scrut: string): string
  /** A `raw` Stmt (raw WGSL string). WGSL returns it; non-WGSL fails closed. */
  rawStmt(wgsl: string): string
  /** An un-swapped `placeholder` Stmt. WGSL emits a defensive comment; non-WGSL fails closed. */
  placeholderStmt(tag: string): string

  // ── Module-level declaration surface ──
  // The module assembly walk (validate → assertCaps → autoVars → lowerModule →
  // optimize → assemble) is shared in core/emit.ts (`emitModule`); only these
  // per-declaration spellings differ between targets. A backend that does not
  // support a declaration (e.g. GLSL ES bindings/structs) fails closed here.
  /** A module-level const declaration line, incl. trailing `;`. */
  emitConst(c: ConstDecl): string
  /** A struct declaration block. */
  emitStruct(s: StructDecl): string
  /** A resource binding declaration line. */
  emitBinding(b: BindingDecl): string
  /** A function declaration block (signature + emitted body). */
  emitFunc(f: FuncDecl): string
  /** The backend's emit-time optimization of the lowered module (WGSL = `cse`,
   *  GLSL = identity). Kept per-backend so cse stays WGSL-only and byte-identity
   *  holds. Runs after lowerModule(autoVars(m)), before assembly. */
  optimize(lowered: ModuleDecl): ModuleDecl
}

/** Emitting a feature a target does not support is a typed error, never a silent
 *  mis-emit. Thrown by the capability gate (assertCaps) and by individual backend
 *  fragments that hit an unsupported construct. */
export class UnsupportedFeatureError extends ShaderDslError {
  constructor(message: string) { super({ code: 'SD0030', message }); this.name = 'UnsupportedFeatureError' }
}
