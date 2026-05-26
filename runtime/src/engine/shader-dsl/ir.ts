// ═══ Shader DSL — IR core + authoring API ═══
//
// In-house, zero-dep, TSL-inspired TypeScript shader DSL. A shader is
// authored as a typed node graph (expression chaining + an imperative
// statement-list builder for control flow). The graph IS the IR; two
// backends lower it:
//   - backend-wgsl.ts  → WGSL string for createShaderModule (real-time GPU)
//   - backend-cpu.ts   → f64 tree-walk interpreter (replaces the hand-
//                         maintained projection-wgsl-mirror.ts; same numbers)
//
// Design (locked in the deep-interview + consensus plan):
//   - Imperative statement-list IR (NOT a pure value-DAG): control flow is
//     first-class ($let/$var/$assign/$if/$for/$switch/$return/$break/$discard)
//     because the line/SDF shaders are imperative. TSL chaining is for
//     EXPRESSIONS only.
//   - Every expression node carries a ShaderType; type inference makes a
//     WGSL type error a TS error (vec3+vec2 etc.) — the AC4 gate.
//   - Module-level consts carry a per-backend value. PI/DEG2RAD differ
//     between WGSL (truncated 3.14159265 / 0.01745329, matching the current
//     shader) and CPU (full-precision Math.PI / Math.PI/180, matching the
//     mirror). This encodes the two-tolerance f32/f64 reality structurally:
//     cpu-f64 reproduces the mirror @≤1mm; cpu-f64↔WGSL stays @100m.
//
// See ralplan-wgsl-tsl-shader-dsl.md (Phase 0) + the deep-interview spec.

// ── Types ──

export type Scalar = 'f32' | 'i32' | 'u32' | 'bool'

export type ShaderType =
  | { readonly kind: 'scalar'; readonly scalar: Scalar }
  | { readonly kind: 'vec'; readonly n: 2 | 3 | 4; readonly elem: 'f32' | 'i32' | 'u32' }
  | { readonly kind: 'mat'; readonly n: 2 | 3 | 4; readonly elem: 'f32' }
  | { readonly kind: 'struct'; readonly name: string }
  | { readonly kind: 'array'; readonly elem: ShaderType; readonly size?: number }
  | { readonly kind: 'texture'; readonly dim: '2d'; readonly elem: 'f32' }
  | { readonly kind: 'sampler' }
  | { readonly kind: 'void' }

// `as const satisfies` keeps each constant's LITERAL type (so KeyOf<typeof f32T>
// resolves to the precise key 'f32' / 'vec2<f32>' …) while still checking it is
// a valid ShaderType — the basis for the compile-time type-safety gate (AC4).
export const f32T = { kind: 'scalar', scalar: 'f32' } as const satisfies ShaderType
export const i32T = { kind: 'scalar', scalar: 'i32' } as const satisfies ShaderType
export const u32T = { kind: 'scalar', scalar: 'u32' } as const satisfies ShaderType
export const boolT = { kind: 'scalar', scalar: 'bool' } as const satisfies ShaderType
export const vec2fT = { kind: 'vec', n: 2, elem: 'f32' } as const satisfies ShaderType
export const vec3fT = { kind: 'vec', n: 3, elem: 'f32' } as const satisfies ShaderType
export const vec4fT = { kind: 'vec', n: 4, elem: 'f32' } as const satisfies ShaderType
export const vec2uT = { kind: 'vec', n: 2, elem: 'u32' } as const satisfies ShaderType
export const vec3uT = { kind: 'vec', n: 3, elem: 'u32' } as const satisfies ShaderType
export const vec4uT = { kind: 'vec', n: 4, elem: 'u32' } as const satisfies ShaderType
export const vec4iT = { kind: 'vec', n: 4, elem: 'i32' } as const satisfies ShaderType
export const mat4x4fT = { kind: 'mat', n: 4, elem: 'f32' } as const satisfies ShaderType
export const texture2dfT = { kind: 'texture', dim: '2d', elem: 'f32' } as const satisfies ShaderType
export const samplerT = { kind: 'sampler' } as const satisfies ShaderType
export const voidT = { kind: 'void' } as const satisfies ShaderType
export const structT = (name: string): ShaderType => ({ kind: 'struct', name })
/** Array type; pass `size` for a fixed-length WGSL array (`array<T, N>`). */
export const arrayT = (elem: ShaderType, size?: number): ShaderType => ({ kind: 'array', elem, size })

// Type-level key of a ShaderType literal — the phantom carried by Node<K>.
export type KeyOf<T> =
  T extends { kind: 'scalar'; scalar: infer S extends string } ? S :
  T extends { kind: 'vec'; n: infer N extends number; elem: infer E extends string } ? `vec${N}<${E}>` :
  T extends { kind: 'mat'; n: infer N extends number } ? `mat${N}x${N}<f32>` :
  string
/** Element key of a vector key (`vec3<u32>` → `u32`); identity for scalars. */
export type ElemKey<K extends string> = K extends `vec${number}<${infer E}>` ? E : K
type ScalarKey = 'f32' | 'i32' | 'u32'
/** Operand a binary arithmetic op accepts: a matching vector or any scalar
 *  (WGSL vec∘scalar broadcast) for a vector LHS; any scalar for a scalar LHS.
 *  A `vec2`+`vec3` mismatch is therefore a TS error. */
type ArithArg<K extends string> =
  K extends `vec${string}` ? Node<K> | Node<ScalarKey> | number : Node<ScalarKey> | number

export function typeKey(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar': return t.scalar
    case 'vec': return `vec${t.n}<${t.elem}>`
    case 'mat': return `mat${t.n}x${t.n}<${t.elem}>`
    case 'struct': return `struct:${t.name}`
    case 'array': return t.size !== undefined ? `array<${typeKey(t.elem)},${t.size}>` : `array<${typeKey(t.elem)}>`
    case 'texture': return `texture_${t.dim}<${t.elem}>`
    case 'sampler': return 'sampler'
    case 'void': return 'void'
  }
}

export function typeEq(a: ShaderType, b: ShaderType): boolean {
  return typeKey(a) === typeKey(b)
}

const isVec = (t: ShaderType): t is Extract<ShaderType, { kind: 'vec' }> => t.kind === 'vec'
const isScalar = (t: ShaderType): t is Extract<ShaderType, { kind: 'scalar' }> => t.kind === 'scalar'
const isMat = (t: ShaderType): t is Extract<ShaderType, { kind: 'mat' }> => t.kind === 'mat'

// ── Expression nodes ──

export type BinOp = '+' | '-' | '*' | '/' | '%'
export type CmpOp = '<' | '>' | '<=' | '>=' | '==' | '!='
export type LogOp = '&&' | '||'

export type Expr =
  | { readonly op: 'lit'; readonly type: ShaderType; readonly value: number | boolean }
  | { readonly op: 'constref'; readonly type: ShaderType; readonly name: string }
  | { readonly op: 'param'; readonly type: ShaderType; readonly name: string }
  | { readonly op: 'varref'; readonly type: ShaderType; readonly name: string }
  | { readonly op: 'binop'; readonly type: ShaderType; readonly bop: BinOp; readonly a: Expr; readonly b: Expr }
  | { readonly op: 'unop'; readonly type: ShaderType; readonly a: Expr }
  | { readonly op: 'compare'; readonly type: ShaderType; readonly cop: CmpOp; readonly a: Expr; readonly b: Expr }
  | { readonly op: 'logical'; readonly type: ShaderType; readonly lop: LogOp; readonly a: Expr; readonly b: Expr }
  | { readonly op: 'call'; readonly type: ShaderType; readonly fn: string; readonly args: readonly Expr[] }
  | { readonly op: 'member'; readonly type: ShaderType; readonly base: Expr; readonly field: string }
  | { readonly op: 'construct'; readonly type: ShaderType; readonly args: readonly Expr[] }
  | { readonly op: 'select'; readonly type: ShaderType; readonly cond: Expr; readonly ifTrue: Expr; readonly ifFalse: Expr }
  | { readonly op: 'index'; readonly type: ShaderType; readonly base: Expr; readonly idx: Expr }

// ── Statement nodes ──

export type Stmt =
  | { readonly s: 'let'; readonly name: string; readonly expr: Expr }
  | { readonly s: 'var'; readonly name: string; readonly type: ShaderType; readonly init?: Expr }
  | { readonly s: 'assign'; readonly target: Expr; readonly expr: Expr }
  | { readonly s: 'assignOp'; readonly target: Expr; readonly bop: BinOp; readonly expr: Expr }
  | { readonly s: 'if'; readonly arms: ReadonlyArray<{ readonly cond: Expr; readonly body: readonly Stmt[] }>; readonly elseBody?: readonly Stmt[] }
  | { readonly s: 'return'; readonly expr?: Expr }
  | { readonly s: 'for'; readonly init: Stmt; readonly cond: Expr; readonly update: Stmt; readonly body: readonly Stmt[] }
  | { readonly s: 'switch'; readonly scrut: Expr; readonly cases: ReadonlyArray<{ readonly value: number; readonly body: readonly Stmt[] }>; readonly defaultBody?: readonly Stmt[] }
  | { readonly s: 'break' }
  | { readonly s: 'discard' }

// ── Module-level declarations ──

export interface ConstDecl {
  readonly name: string
  readonly type: ShaderType
  /** Value emitted by the WGSL backend (the truncated shader constant). */
  readonly wgslValue: number
  /** Value used by the CPU backend (full-precision, matching the mirror). */
  readonly cpuValue: number
}

export interface StructField {
  readonly name: string
  readonly type: ShaderType
  /** Optional WGSL field attribute(s) for I/O structs, e.g.
   *  `@builtin(position)`, `@location(0)`, `@location(0) @interpolate(flat)`. */
  readonly attr?: string
}
export interface StructDecl { readonly name: string; readonly fields: readonly StructField[] }

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

export interface FuncDecl {
  readonly name: string
  readonly params: readonly { name: string; type: ShaderType; builtin?: string; location?: number }[]
  readonly ret: ShaderType
  readonly body: readonly Stmt[]
  /** Stage / pipeline attributes emitted before `fn` (e.g. `@compute`,
   *  `@workgroup_size(64)`). Empty for ordinary helper functions. */
  readonly attrs?: readonly string[]
  /** Return-value attribute for a bare (non-struct) stage output, e.g. a
   *  fragment `-> @location(0) vec4<f32>`. */
  readonly retAttr?: string
}

export interface ModuleDecl {
  readonly consts: readonly ConstDecl[]
  readonly structs: readonly StructDecl[]
  readonly bindings: readonly BindingDecl[]
  readonly funcs: readonly FuncDecl[]
}

// ── Authoring: the Node wrapper (TSL-style chaining over an Expr) ──

/** Anything acceptable where a Node is expected — a Node, or a number that
 *  is auto-lifted to an f32 literal (the projection math is f32-dominant). */
export type NodeLike = Node | number

function lift(x: NodeLike): Node {
  return typeof x === 'number' ? new Node({ op: 'lit', type: f32T, value: x }) : x
}

/** Result type of a binary arithmetic op given operand types. vec op scalar
 *  (or vec op same-vec) → vec; scalar op scalar → f32>i32>u32 promotion. A
 *  vec op a different vec is a type error (returned as a poisoned mismatch
 *  that the WGSL/CPU backend never sees because typecheck fails first). */
function binResultType(a: ShaderType, b: ShaderType, ctx: string): ShaderType {
  // mat * vec → vec (matN x vecN); mat * mat → mat.
  if (isMat(a) && isVec(b)) {
    if (a.n !== b.n) throw new Error(`shader-dsl: ${ctx} mat${a.n} * vec${b.n} size mismatch`)
    return b
  }
  if (isMat(a) && isMat(b)) return a
  if (isVec(a) && isVec(b)) {
    if (!typeEq(a, b)) throw new Error(`shader-dsl: ${ctx} on mismatched vectors ${typeKey(a)} vs ${typeKey(b)}`)
    return a
  }
  if (isVec(a) && isScalar(b)) return a
  if (isScalar(a) && isVec(b)) return b
  if (isScalar(a) && isScalar(b)) {
    const order: Scalar[] = ['f32', 'i32', 'u32']
    const as = a.scalar, bs = b.scalar
    if (as === 'bool' || bs === 'bool') throw new Error(`shader-dsl: ${ctx} on bool`)
    return order.indexOf(as) <= order.indexOf(bs) ? a : b
  }
  throw new Error(`shader-dsl: ${ctx} on ${typeKey(a)} / ${typeKey(b)}`)
}

const VEC_FIELD_INDEX: Record<string, number> = { x: 0, y: 1, z: 2, w: 3 }

export class Node<K extends string = string> {
  /** Phantom type key. Optional + never assigned, so it carries K covariantly
   *  at the type level (a Node<'vec3<f32>'> is NOT assignable where
   *  Node<'vec2<f32>'> is wanted — the vec3+vec2 compile-error mechanism)
   *  with no real runtime cost. NOTE: must NOT be a `declare` field — the e2e
   *  babel transform (@babel/plugin-transform-typescript) rejects `declare`
   *  class fields, which broke the playwright render-gate build. */
  readonly __k?: K
  constructor(readonly expr: Expr) {}
  get type(): ShaderType { return this.expr.type }

  private bin(bop: BinOp, o: NodeLike): Node {
    const b = lift(o)
    return new Node({ op: 'binop', type: binResultType(this.type, b.type, bop), bop, a: this.expr, b: b.expr })
  }
  add(o: ArithArg<K>): Node<K> { return this.bin('+', o) as Node<K> }
  sub(o: ArithArg<K>): Node<K> { return this.bin('-', o) as Node<K> }
  mul(o: ArithArg<K>): Node<K> { return this.bin('*', o) as Node<K> }
  div(o: ArithArg<K>): Node<K> { return this.bin('/', o) as Node<K> }
  mod(o: ArithArg<K>): Node<K> { return this.bin('%', o) as Node<K> }
  neg(): Node<K> { return new Node<K>({ op: 'unop', type: this.type, a: this.expr }) }

  private cmp(cop: CmpOp, o: NodeLike): Node<'bool'> {
    return new Node<'bool'>({ op: 'compare', type: boolT, cop, a: this.expr, b: lift(o).expr })
  }
  lt(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('<', o) }
  gt(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('>', o) }
  le(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('<=', o) }
  ge(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('>=', o) }
  eq(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('==', o) }
  ne(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('!=', o) }

  and(o: Node<'bool'>): Node<'bool'> { return new Node<'bool'>({ op: 'logical', type: boolT, lop: '&&', a: this.expr, b: o.expr }) }
  or(o: Node<'bool'>): Node<'bool'> { return new Node<'bool'>({ op: 'logical', type: boolT, lop: '||', a: this.expr, b: o.expr }) }

  /** Vector component access — `.x`/`.y`/`.z`/`.w` → elem scalar. */
  comp(field: 'x' | 'y' | 'z' | 'w'): Node<ElemKey<K>> {
    const t = this.type
    if (!isVec(t)) throw new Error(`shader-dsl: .${field} on non-vector ${typeKey(t)}`)
    if (VEC_FIELD_INDEX[field] >= t.n) throw new Error(`shader-dsl: .${field} out of range on ${typeKey(t)}`)
    return new Node<ElemKey<K>>({ op: 'member', type: { kind: 'scalar', scalar: t.elem }, base: this.expr, field })
  }
  get x(): Node<ElemKey<K>> { return this.comp('x') }
  get y(): Node<ElemKey<K>> { return this.comp('y') }
  get z(): Node<ElemKey<K>> { return this.comp('z') }
  get w(): Node<ElemKey<K>> { return this.comp('w') }

  /** Vector swizzle — `.rgb`, `.xy`, `.a`, … A length-1 swizzle → scalar;
   *  length-N → vecN of the same element type. */
  swizzle(comps: string): Node {
    const t = this.type
    if (!isVec(t)) throw new Error(`shader-dsl: swizzle .${comps} on non-vector ${typeKey(t)}`)
    const n = comps.length
    const type: ShaderType = n === 1 ? { kind: 'scalar', scalar: t.elem } : { kind: 'vec', n: n as 2 | 3 | 4, elem: t.elem }
    return new Node({ op: 'member', type, base: this.expr, field: comps })
  }
  get r(): Node<ElemKey<K>> { return this.comp('x') }
  get g(): Node<ElemKey<K>> { return this.comp('y') }
  get b(): Node<ElemKey<K>> { return this.comp('z') }
  get a(): Node<ElemKey<K>> { return this.comp('w') }
  get rgb(): Node<'vec3<f32>'> { return this.swizzle('rgb') as Node<'vec3<f32>'> }

  /** Struct field access (key inferred from the field's ShaderType literal). */
  field<T extends ShaderType>(name: string, type: T): Node<KeyOf<T>> {
    return new Node<KeyOf<T>>({ op: 'member', type, base: this.expr, field: name })
  }

  /** Array index — base[idx]. Key inferred from the element ShaderType. */
  at<T extends ShaderType>(idx: Node<ScalarKey> | number, elem: T): Node<KeyOf<T>> {
    return new Node<KeyOf<T>>({ op: 'index', type: elem, base: this.expr, idx: lift(idx).expr })
  }

  /** `this ? a : b` (only valid on a bool node — enforced via `this:`).
   *  Both branches must share a key. Mirrors WGSL select(b, a, this). */
  select<R extends string = 'f32'>(this: Node<'bool'>, a: Node<R> | number, b: Node<R> | number): Node<R> {
    if (!typeEq(this.type, boolT)) throw new Error('shader-dsl: .select on non-bool condition')
    const ta = lift(a), tb = lift(b)
    if (!typeEq(ta.type, tb.type)) throw new Error(`shader-dsl: select branches differ ${typeKey(ta.type)} vs ${typeKey(tb.type)}`)
    return new Node<R>({ op: 'select', type: ta.type, cond: this.expr, ifTrue: ta.expr, ifFalse: tb.expr })
  }
}

// ── Literal / ref constructors ──

export const f32 = (v: number): Node<'f32'> => new Node<'f32'>({ op: 'lit', type: f32T, value: v })
export const i32 = (v: number): Node<'i32'> => new Node<'i32'>({ op: 'lit', type: i32T, value: v })
export const u32 = (v: number): Node<'u32'> => new Node<'u32'>({ op: 'lit', type: u32T, value: v })
export const bool = (v: boolean): Node<'bool'> => new Node<'bool'>({ op: 'lit', type: boolT, value: v })

/** A reference to a module-level const (PI, DEG2RAD, EARTH_R, …). Defaults to
 *  an f32 const (every projection const is f32). */
export function constRef<T extends ShaderType = typeof f32T>(name: string, type?: T): Node<KeyOf<T>> {
  return new Node<KeyOf<T>>({ op: 'constref', type: type ?? f32T, name })
}

/** A function parameter reference (key inferred from the ShaderType literal). */
export function param<T extends ShaderType>(name: string, type: T): Node<KeyOf<T>> {
  return new Node<KeyOf<T>>({ op: 'param', type, name })
}

/** A module-level binding reference (storage/uniform). */
export function bindingRef<T extends ShaderType>(name: string, type: T): Node<KeyOf<T>> {
  return new Node<KeyOf<T>>({ op: 'varref', type, name })
}

// ── Builtins (free functions) ──

const elemScalarType = (t: ShaderType): ShaderType => (isVec(t) ? { kind: 'scalar', scalar: t.elem } : t)

const call = (fn: string, type: ShaderType, ...args: NodeLike[]): Node =>
  new Node({ op: 'call', type, fn, args: args.map((a) => lift(a).expr) })

// genType1: component-wise unary builtin — preserves the operand key.
const genType1 = (fn: string) => <K extends string>(x: Node<K>): Node<K> => call(fn, x.type, x) as Node<K>

export const sin = genType1('sin')
export const cos = genType1('cos')
export const tan = genType1('tan')
export const asin = genType1('asin')
export const acos = genType1('acos')
export const atan = genType1('atan')
export const exp = genType1('exp')
export const log = genType1('log')
export const log2 = genType1('log2')
export const floor = genType1('floor')
export const ceil = genType1('ceil')
export const abs = genType1('abs')
export const sqrt = genType1('sqrt')

export const atan2 = <K extends string>(y: Node<K>, x: ArithArg<K>): Node<K> => call('atan2', y.type, y, x) as Node<K>
export const min = <K extends string>(a: Node<K>, b: ArithArg<K>): Node<K> => call('min', binResultType(a.type, lift(b).type, 'min'), a, b) as Node<K>
export const max = <K extends string>(a: Node<K>, b: ArithArg<K>): Node<K> => call('max', binResultType(a.type, lift(b).type, 'max'), a, b) as Node<K>
export const clamp = <K extends string>(x: Node<K>, lo: ArithArg<K>, hi: ArithArg<K>): Node<K> => call('clamp', x.type, x, lo, hi) as Node<K>
export const mix = <K extends string>(a: Node<K>, b: ArithArg<K>, t: Node<ScalarKey> | number): Node<K> => call('mix', a.type, a, b, t) as Node<K>
export const smoothstep = (e0: Node<ScalarKey> | number, e1: Node<ScalarKey> | number, x: Node<ScalarKey> | number): Node<'f32'> => { const n = lift(x); return call('smoothstep', elemScalarType(n.type), e0, e1, n) as Node<'f32'> }
export const length = (v: Node<string>): Node<'f32'> => call('length', f32T, v) as Node<'f32'>
export const dot = (a: Node<string>, b: Node<string>): Node<'f32'> => call('dot', f32T, a, b) as Node<'f32'>
/** Pack a vec4<f32> (each component in [0,1]) into a u32 RGBA8. */
export const pack4x8unorm = (v: Node<'vec4<f32>'>): Node<'u32'> => call('pack4x8unorm', u32T, v) as Node<'u32'>
/** Sample a 2D texture → vec4<f32>. (CPU eval: nearest-texel stub.) */
export const textureSample = (tex: Node, smp: Node, uv: NodeLike): Node<'vec4<f32>'> =>
  call('textureSample', vec4fT, tex, smp, uv) as Node<'vec4<f32>'>
/** Screen-space derivative magnitude — GPU-only (uncomputable per-invocation
 *  on the CPU; the interpreter stubs it to 0). */
export const fwidth = genType1('fwidth')

/** select(cond, ifTrue, ifFalse) — free-function form of Node.select. */
export const select = <R extends string>(cond: Node<'bool'>, ifTrue: Node<R> | number, ifFalse: Node<R> | number): Node<R> => cond.select(ifTrue, ifFalse)

// Casts
export const toF32 = (x: Node<string> | number): Node<'f32'> => call('f32', f32T, x) as Node<'f32'>
export const toI32 = (x: Node<string> | number): Node<'i32'> => call('i32', i32T, x) as Node<'i32'>
export const toU32 = (x: Node<string> | number): Node<'u32'> => call('u32', u32T, x) as Node<'u32'>

/** Call a user-defined (authored) function by name. The WGSL backend emits
 *  `name(args)`; the CPU backend dispatches through the compiled fn table. */
export function callFn<T extends ShaderType>(name: string, ret: T, ...args: NodeLike[]): Node<KeyOf<T>> {
  return new Node<KeyOf<T>>({ op: 'call', type: ret, fn: name, args: args.map((a) => lift(a).expr) })
}

// Vector constructors
const construct = (type: ShaderType, args: NodeLike[]): Node =>
  new Node({ op: 'construct', type, args: args.map((a) => lift(a).expr) })
export const vec2 = (...a: NodeLike[]): Node<'vec2<f32>'> => construct(vec2fT, a) as Node<'vec2<f32>'>
export const vec3 = (...a: NodeLike[]): Node<'vec3<f32>'> => construct(vec3fT, a) as Node<'vec3<f32>'>
export const vec4 = (...a: NodeLike[]): Node<'vec4<f32>'> => construct(vec4fT, a) as Node<'vec4<f32>'>
export const vec2u = (...a: NodeLike[]): Node<'vec2<u32>'> => construct(vec2uT, a) as Node<'vec2<u32>'>

/** mat4x4 × vec4 → vec4 (the generic `.mul` correctly rejects mat×vec since a
 *  matrix is not a scalar/matching-vector operand — this is the explicit MVP
 *  transform path). */
export const transformMat4 = (m: Node<'mat4x4<f32>'>, v: Node<'vec4<f32>'>): Node<'vec4<f32>'> =>
  new Node<'vec4<f32>'>({ op: 'binop', type: vec4fT, bop: '*', a: m.expr, b: v.expr })

/** A fixed-length array literal — `array<elemKey, N>(...)`. */
export const arrayLit = (elem: ShaderType, ...items: Node[]): Node =>
  new Node({ op: 'construct', type: arrayT(elem, items.length), args: items.map((n) => n.expr) })

// ── Function builder ──

export type ParamSpec = Record<string, ShaderType>
type ParamNodes<P extends ParamSpec> = { [K in keyof P]: Node<KeyOf<P[K]>> }

export class Builder {
  readonly stmts: Stmt[] = []

  private push(s: Stmt): void { this.stmts.push(s) }

  /** Immutable binding — `let name = expr;`. Returns a varref Node of the
   *  bound value's key. */
  let<K extends string>(name: string, value: Node<K>): Node<K> {
    this.push({ s: 'let', name, expr: value.expr })
    return new Node<K>({ op: 'varref', type: value.type, name })
  }

  /** Mutable binding — `var name: T = init?;`. Returns a varref Node. */
  var<T extends ShaderType>(name: string, type: T, init?: Node<KeyOf<T>>): Node<KeyOf<T>> {
    this.push({ s: 'var', name, type, init: init?.expr })
    return new Node<KeyOf<T>>({ op: 'varref', type, name })
  }

  assign<K extends string>(target: Node<K>, value: Node<K>): void {
    this.push({ s: 'assign', target: target.expr, expr: value.expr })
  }
  assignOp<K extends string>(target: Node<K>, bop: BinOp, value: ArithArg<K>): void {
    this.push({ s: 'assignOp', target: target.expr, bop, expr: lift(value).expr })
  }
  addAssign<K extends string>(target: Node<K>, value: ArithArg<K>): void { this.assignOp(target, '+', value) }

  ret(value?: Node): void { this.push({ s: 'return', expr: value?.expr }) }
  break(): void { this.push({ s: 'break' }) }
  discard(): void { this.push({ s: 'discard' }) }

  /** if / else-if / else chain. Returns a chainer so `.elif().else()` reads
   *  top-to-bottom. The If stmt is pushed on the first call and mutated in
   *  place by subsequent .elif/.else. */
  if(cond: Node<'bool'>, body: (b: Builder) => void): IfChain {
    const arms: Array<{ cond: Expr; body: Stmt[] }> = [{ cond: cond.expr, body: subBody(body) }]
    const stmt = { s: 'if' as const, arms, elseBody: undefined as Stmt[] | undefined }
    // Push a mutable-shaped object; the readonly Stmt typing is a compile-time
    // view only — the builder owns construction.
    this.push(stmt as unknown as Stmt)
    return new IfChain(arms, (e) => { stmt.elseBody = e })
  }

  /** C-style for: `for (var name = init; name <cond>; name = name+step)`.
   *  A numeric / omitted step is typed to the loop var's scalar so a u32/i32
   *  counter emits `i + 1u` / `i + 1` (not `i + 1.0`, which naga/tint reject). */
  forRange<K extends string>(
    name: string,
    init: Node<K>,
    cond: (i: Node<K>) => Node<'bool'>,
    body: (b: Builder, i: Node<K>) => void,
    step?: Node<ScalarKey> | number,
  ): void {
    const i = new Node<K>({ op: 'varref', type: init.type, name })
    const litOf = (v: number): Node => {
      if (init.type.kind === 'scalar' && init.type.scalar === 'u32') return u32(v)
      if (init.type.kind === 'scalar' && init.type.scalar === 'i32') return i32(v)
      return f32(v)
    }
    const stepNode = step === undefined ? litOf(1) : typeof step === 'number' ? litOf(step) : step
    const initStmt: Stmt = { s: 'var', name, type: init.type, init: init.expr }
    const updateStmt: Stmt = { s: 'assign', target: i.expr, expr: i.add(stepNode as ArithArg<K>).expr }
    this.push({ s: 'for', init: initStmt, cond: cond(i).expr, update: updateStmt, body: subBody((b) => body(b, i)) })
  }

  switch(scrut: Node<ScalarKey>, cases: Array<[number, (b: Builder) => void]>, defaultBody?: (b: Builder) => void): void {
    this.push({
      s: 'switch',
      scrut: scrut.expr,
      cases: cases.map(([value, fn]) => ({ value, body: subBody(fn) })),
      defaultBody: defaultBody ? subBody(defaultBody) : undefined,
    })
  }
}

export class IfChain {
  constructor(
    private readonly arms: Array<{ cond: Expr; body: Stmt[] }>,
    private readonly setElse: (body: Stmt[]) => void,
  ) {}
  elif(cond: Node<'bool'>, body: (b: Builder) => void): IfChain {
    this.arms.push({ cond: cond.expr, body: subBody(body) })
    return this
  }
  else(body: (b: Builder) => void): void {
    this.setElse(subBody(body))
  }
}

function subBody(fn: (b: Builder) => void): Stmt[] {
  const b = new Builder()
  fn(b)
  return b.stmts
}

/** Author a function. The body callback receives the builder + typed param
 *  Nodes (each keyed by its ShaderType). Returns a FuncDecl for the module. */
export function fn<P extends ParamSpec>(
  name: string,
  params: P,
  ret: ShaderType,
  body: (b: Builder, p: ParamNodes<P>) => void,
): FuncDecl {
  const paramList = Object.entries(params).map(([n, type]) => ({ name: n, type }))
  const paramNodes = Object.fromEntries(
    paramList.map((p) => [p.name, new Node({ op: 'param', type: p.type, name: p.name })]),
  ) as ParamNodes<P>
  const b = new Builder()
  body(b, paramNodes)
  return { name, params: paramList, ret, body: b.stmts }
}

/** Author a `@compute @workgroup_size(N)` entry point. The body callback
 *  receives the builder + the `@builtin(global_invocation_id)` Node (vec3<u32>).
 *  Compute entries return void; output is via storage bindings. */
export function computeFn(
  name: string,
  workgroupSize: number,
  gidName: string,
  body: (b: Builder, gid: Node<'vec3<u32>'>) => void,
): FuncDecl {
  const gid = new Node<'vec3<u32>'>({ op: 'param', type: vec3uT, name: gidName })
  const b = new Builder()
  body(b, gid)
  return {
    name,
    params: [{ name: gidName, type: vec3uT, builtin: 'global_invocation_id' }],
    ret: voidT,
    body: b.stmts,
    attrs: ['@compute', `@workgroup_size(${workgroupSize})`],
  }
}

export interface EntryParam { readonly name: string; readonly type: ShaderType; readonly builtin?: string; readonly location?: number }

/** Maps an entry's param tuple to a name→keyed-Node record, so a `@builtin`
 *  scalar param (e.g. vertex_index: u32) is `Node<'u32'>`, usable as an index. */
type EntryParamNodes<P extends readonly EntryParam[]> = {
  [K in P[number]['name']]: Node<KeyOf<Extract<P[number], { name: K }>['type']>>
}

/** Author a `@vertex` / `@fragment` entry point. Params may carry a `@builtin`
 *  (vertex_index, etc.) or be an I/O struct (the interpolated vertex output);
 *  the body returns the stage's output struct. */
export function entryFn<const P extends readonly EntryParam[]>(
  name: string,
  stage: 'vertex' | 'fragment',
  params: P,
  ret: ShaderType,
  body: (b: Builder, p: EntryParamNodes<P>) => void,
  retAttr?: string,
): FuncDecl {
  const paramNodes: Record<string, Node> = {}
  for (const p of params) paramNodes[p.name] = new Node({ op: 'param', type: p.type, name: p.name })
  const b = new Builder()
  body(b, paramNodes as EntryParamNodes<P>)
  return {
    name,
    params: params.map((p) => ({ name: p.name, type: p.type, builtin: p.builtin, location: p.location })),
    ret,
    body: b.stmts,
    attrs: [`@${stage}`],
    retAttr,
  }
}

/** Assemble a module from its declarations. */
export function module(parts: Partial<ModuleDecl>): ModuleDecl {
  return {
    consts: parts.consts ?? [],
    structs: parts.structs ?? [],
    bindings: parts.bindings ?? [],
    funcs: parts.funcs ?? [],
  }
}
