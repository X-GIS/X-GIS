// ═══ Shader DSL — Node<K> authoring wrapper + builtins ═══
//
// The TSL-style chaining wrapper over an Expr (Node<K>, phantom-typed for the
// compile-time gate), the literal/ref constructors, and the free-function
// builtins. Imports types.ts + nodes.ts.

import {
  type ShaderType, type Scalar, type KeyOf, type ElemKey, type ScalarKey,
  typeKey, typeEq, isVec, isScalar, isMat,
  f32T, i32T, u32T, boolT, vec2fT, vec3fT, vec4fT, vec2uT, vec2iT, arrayT,
} from './types'
import type { Expr, BinOp, CmpOp } from './nodes'

// Re-export ScalarKey so consumers importing the matchExpr signature can refer
// to its generic bound without a separate types import (mirrors the existing
// `KeyOf` / `ElemKey` re-export pattern in the barrel).
export type { ScalarKey } from './types'

/** Anything acceptable where a Node is expected — a Node, or a number that
 *  is auto-lifted to an f32 literal (the projection math is f32-dominant). */
export type NodeLike = Node | number

/** Operand a binary arithmetic op accepts: a matching vector or any scalar
 *  (WGSL vec∘scalar broadcast) for a vector LHS; any scalar for a scalar LHS.
 *  A `vec2`+`vec3` mismatch is therefore a TS error. */
export type ArithArg<K extends string> =
  K extends `vec${string}` ? Node<K> | Node<ScalarKey> | number : Node<ScalarKey> | number

export function lift(x: NodeLike): Node {
  return typeof x === 'number' ? new Node({ op: 'lit', type: f32T, value: x }) : x
}

/** Statement sink — the builder installs how `node.set(v)` / `node.addAssign(v)` push their Stmt to the
 *  current scope. Injected (not imported) so the Node lvalue methods can route to the builder without a
 *  node ↔ builder import cycle. */
type StmtSink = { assign(target: Node, value: Node): void }
let _stmtSink: StmtSink | undefined
export const installStmtSink = (s: StmtSink): void => { _stmtSink = s }
const stmtSink = (): StmtSink => {
  if (!_stmtSink) throw new Error('shader-dsl: statement sink not installed — import @xgis/shader-dsl from its entry, not a deep path')
  return _stmtSink
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

  /** Typed lift of a bare-number operand against THIS node's scalar context: a number against a
   *  u32/i32 scalar LHS lifts to that scalar (`u32node.add(1)` → `+ 1u`, not naga-invalid `+ 1.0`);
   *  a vec LHS (or any f32-dominant geometry/projection math) keeps the f32 lift (WGSL broadcasts
   *  `vec + scalar`). So the author drops the `f32()`/`u32()`/`i32()` wrapper in every arithmetic,
   *  comparison, and bitwise op — the context types the literal. */
  private liftArg(o: NodeLike): Node {
    const t = this.type
    if (typeof o === 'number' && t.kind === 'scalar' && (t.scalar === 'u32' || t.scalar === 'i32')) {
      return t.scalar === 'u32' ? u32(o) : i32(o)
    }
    return lift(o)
  }

  private bin(bop: BinOp, o: NodeLike): Node {
    const b = this.liftArg(o)
    return new Node({ op: 'binop', type: binResultType(this.type, b.type, bop), bop, a: this.expr, b: b.expr })
  }
  add(o: ArithArg<K>): Node<K> { return this.bin('+', o) as Node<K> }
  sub(o: ArithArg<K>): Node<K> { return this.bin('-', o) as Node<K> }
  mul(o: ArithArg<K>): Node<K> { return this.bin('*', o) as Node<K> }
  div(o: ArithArg<K>): Node<K> { return this.bin('/', o) as Node<K> }
  mod(o: ArithArg<K>): Node<K> { return this.bin('%', o) as Node<K> }
  neg(): Node<K> { return new Node<K>({ op: 'unop', type: this.type, a: this.expr }) }

  private cmp(cop: CmpOp, o: NodeLike): Node<'bool'> {
    return new Node<'bool'>({ op: 'compare', type: boolT, cop, a: this.expr, b: this.liftArg(o).expr })
  }
  lt(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('<', o) }
  gt(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('>', o) }
  le(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('<=', o) }
  ge(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('>=', o) }
  eq(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('==', o) }
  ne(o: Node<ScalarKey> | number): Node<'bool'> { return this.cmp('!=', o) }

  and(o: Node<'bool'>): Node<'bool'> { return new Node<'bool'>({ op: 'logical', type: boolT, lop: '&&', a: this.expr, b: o.expr }) }
  or(o: Node<'bool'>): Node<'bool'> { return new Node<'bool'>({ op: 'logical', type: boolT, lop: '||', a: this.expr, b: o.expr }) }

  /** Bitwise ops on u32 / i32. Number literals auto-lift to the LHS's scalar
   *  type so `flags.bitAnd(1)` emits `flags & 1u` for a u32 flags (the WGSL
   *  rejects mixed-scalar bitwise — typed lifting keeps emit correct). */
  private bitBin(bop: BinOp, o: NodeLike): Node {
    const t = this.type
    if (t.kind !== 'scalar' || (t.scalar !== 'u32' && t.scalar !== 'i32')) {
      throw new Error(`shader-dsl: bitwise ${bop} requires u32/i32 LHS, got ${typeKey(t)}`)
    }
    const bn: Node = typeof o === 'number' ? (t.scalar === 'u32' ? u32(o) : i32(o)) : o
    return new Node({ op: 'binop', type: t, bop, a: this.expr, b: bn.expr })
  }
  bitAnd(o: Node<ScalarKey> | number): Node<K> { return this.bitBin('&', o) as Node<K> }
  bitOr(o: Node<ScalarKey> | number): Node<K> { return this.bitBin('|', o) as Node<K> }
  bitXor(o: Node<ScalarKey> | number): Node<K> { return this.bitBin('^', o) as Node<K> }
  shl(o: Node<ScalarKey> | number): Node<K> { return this.bitBin('<<', o) as Node<K> }
  shr(o: Node<ScalarKey> | number): Node<K> { return this.bitBin('>>', o) as Node<K> }

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
   *  length-N → vecN of the same element type. The result key cannot be
   *  inferred from the runtime `comps` string, so callers that know the
   *  swizzle shape statically pass it explicitly (e.g. `swizzle<'vec3<f32>'>('xyz')`);
   *  the default `string` preserves the historical untyped result. */
  swizzle<R extends string = string>(comps: string): Node<R> {
    const t = this.type
    if (!isVec(t)) throw new Error(`shader-dsl: swizzle .${comps} on non-vector ${typeKey(t)}`)
    const n = comps.length
    const type: ShaderType = n === 1 ? { kind: 'scalar', scalar: t.elem } : { kind: 'vec', n: n as 2 | 3 | 4, elem: t.elem }
    return new Node<R>({ op: 'member', type, base: this.expr, field: comps })
  }
  get r(): Node<ElemKey<K>> { return this.comp('x') }
  get g(): Node<ElemKey<K>> { return this.comp('y') }
  get b(): Node<ElemKey<K>> { return this.comp('z') }
  get a(): Node<ElemKey<K>> { return this.comp('w') }

  get rgb(): Node<'vec3<f32>'> { return this.swizzle('rgb') as Node<'vec3<f32>'> }

  // Common multi-component swizzle getters — `w.zxy` instead of vec3(w.z, w.x, w.y) or
  // the untyped swizzle<'vec3<f32>'>('zxy'). Like .rgb, these assume an f32 source (the
  // dominant case for position/colour vectors); for u32/i32 vectors use .swizzle<R>('...').
  get xy(): Node<'vec2<f32>'> { return this.swizzle('xy') as Node<'vec2<f32>'> }
  get xyz(): Node<'vec3<f32>'> { return this.swizzle('xyz') as Node<'vec3<f32>'> }
  get zyx(): Node<'vec3<f32>'> { return this.swizzle('zyx') as Node<'vec3<f32>'> }
  get zxy(): Node<'vec3<f32>'> { return this.swizzle('zxy') as Node<'vec3<f32>'> }
  get yzx(): Node<'vec3<f32>'> { return this.swizzle('yzx') as Node<'vec3<f32>'> }
  get bgr(): Node<'vec3<f32>'> { return this.swizzle('bgr') as Node<'vec3<f32>'> }
  get bgra(): Node<'vec4<f32>'> { return this.swizzle('bgra') as Node<'vec4<f32>'> }

  /** Array index — base[idx]. Key inferred from the element ShaderType. */
  at<T extends ShaderType>(idx: Node<ScalarKey> | number, elem: T): Node<KeyOf<T>> {
    return new Node<KeyOf<T>>({ op: 'index', type: elem, base: this.expr, idx: lift(idx).expr })
  }

  /** `this = value;` — the ONE lvalue-mutation method (matches three.js TSL's `.assign()`). JS can't
   *  overload `=` (`x = v` would just rebind the JS variable, not emit a store), so mutation is a method.
   *  There is no compound `addAssign`: `add` is the pure expression, so `x += v` is `x.assign(x.add(v))`.
   *  The value lifts to this lvalue's scalar context. */
  assign(value: ArithArg<K>): void { stmtSink().assign(this, this.liftArg(value)) }

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
export const fract = genType1('fract')
export const sign = genType1('sign')

export const atan2 = <K extends string>(y: Node<K>, x: ArithArg<K>): Node<K> => call('atan2', y.type, y, x) as Node<K>
export const min = <K extends string>(a: Node<K>, b: ArithArg<K>): Node<K> => call('min', binResultType(a.type, lift(b).type, 'min'), a, b) as Node<K>
export const max = <K extends string>(a: Node<K>, b: ArithArg<K>): Node<K> => call('max', binResultType(a.type, lift(b).type, 'max'), a, b) as Node<K>
/** `pow(a, b)` — same-type binary; second operand promotes via ArithArg so
 *  `pow(z, 4)` emits `pow(z, 4.0)` for an f32 base. WGSL pow only accepts
 *  matching scalar/vec floats, so a vec*scalar broadcast is structurally
 *  rejected by WGSL even when the type system would allow it — we keep
 *  binResultType for parity with `min` / `max`. */
export const pow = <K extends string>(a: Node<K>, b: ArithArg<K>): Node<K> => call('pow', binResultType(a.type, lift(b).type, 'pow'), a, b) as Node<K>
export const clamp = <K extends string>(x: Node<K>, lo: ArithArg<K>, hi: ArithArg<K>): Node<K> => call('clamp', x.type, x, lo, hi) as Node<K>
export const mix = <K extends string>(a: Node<K>, b: ArithArg<K>, t: Node<ScalarKey> | number): Node<K> => call('mix', a.type, a, b, t) as Node<K>
export const smoothstep = (e0: Node<ScalarKey> | number, e1: Node<ScalarKey> | number, x: Node<ScalarKey> | number): Node<'f32'> => { const n = lift(x); return call('smoothstep', elemScalarType(n.type), e0, e1, n) as Node<'f32'> }
export const length = (v: Node<string>): Node<'f32'> => call('length', f32T, v) as Node<'f32'>
export const dot = (a: Node<string>, b: Node<string>): Node<'f32'> => call('dot', f32T, a, b) as Node<'f32'>
/** Pack a vec4<f32> (each component in [0,1]) into a u32 RGBA8. */
export const pack4x8unorm = (v: Node<'vec4<f32>'>): Node<'u32'> => call('pack4x8unorm', u32T, v) as Node<'u32'>
/** Unpack a u32 RGBA8 into a vec4<f32> (each component in [0,1]). */
export const unpack4x8unorm = (v: Node<'u32'>): Node<'vec4<f32>'> => call('unpack4x8unorm', vec4fT, v) as Node<'vec4<f32>'>
/** Reinterpret an f32's bit pattern as u32. Carries the NEUTRAL intrinsic id
 *  `bitcastU32`; the registry (core/intrinsics.ts) spells it `bitcast<u32>(x)` on
 *  WGSL and `floatBitsToUint(x)` on GLSL — no WGSL generic syntax in the IR. */
export const bitcastU32 = (v: Node<'f32'>): Node<'u32'> => call('bitcastU32', u32T, v) as Node<'u32'>
/** Sample a 2D texture → vec4<f32>. (CPU eval: nearest-texel stub.) */
export const textureSample = (tex: Node, smp: Node, uv: NodeLike): Node<'vec4<f32>'> =>
  call('textureSample', vec4fT, tex, smp, uv) as Node<'vec4<f32>'>
/** Load a texel from a 2D texture at integer coords → vec4<f32>. The mip
 *  level argument is required by WGSL; pass `0` for the base level.
 *  Coord is typically `vec2<i32>`; the runtime accepts any vec2 / scalar
 *  NodeLike and lets WGSL's textureLoad signature check. (CPU stub.) */
export const textureLoad = (tex: Node, coord: NodeLike, level: NodeLike): Node<'vec4<f32>'> =>
  call('textureLoad', vec4fT, tex, coord, level) as Node<'vec4<f32>'>
/** Texture extent in texels → vec2<u32>. Cost: one query per fragment in
 *  fullscreen-triangle compose passes; cached in a `let` by the caller. */
export const textureDimensions = (tex: Node): Node<'vec2<u32>'> =>
  call('textureDimensions', vec2uT, tex) as Node<'vec2<u32>'>
/** Screen-space derivative magnitude — GPU-only (uncomputable per-invocation
 *  on the CPU; the interpreter stubs it to 0). */
export const fwidth = genType1('fwidth')

/** select(cond, ifTrue, ifFalse) — free-function form of Node.select. */
export const select = <R extends string>(cond: Node<'bool'>, ifTrue: Node<R> | number, ifFalse: Node<R> | number): Node<R> => cond.select(ifTrue, ifFalse)

/**
 * `match (scrutinee) { case v0: r0; ...; default: dflt }` — a typed multi-arm
 * dispatch over an integer/scalar scrutinee. The wgsl pre-emit pass
 * (core/passes/match-lower.ts) lowers every matchExpr inside an fn body into
 * a hoisted `var _mr_N: <R>` slot + `Stmt.switch` writing each case's value
 * into the slot, and rewrites the matchExpr position into a varref. This
 * matches the production compiler's existing `var _mcSS = ...; if (...) { ... }`
 * shape and minimises diff-test noise. For >=10-arm matches the lowering
 * additionally casts non-integer scrutinees to i32 (WGSL switch is
 * integer-only); this is the matchExpr perf gate from the ralplan AC2.
 *
 * Type-safety: all case values' Node types must match the default's. A
 * mismatched case Node triggers a runtime throw — tsc rejects most cases at
 * compile time via the shared `R extends string` bound (covered by the
 * `@ts-expect-error` probe in match-expr.test.ts).
 *
 * Phase 2.5 US-001 — the single new EXPRESSION primitive of the polygon
 * shader DSL migration.
 */
export function matchExpr<S extends ScalarKey, R extends string>(
  scrutinee: Node<S>,
  cases: ReadonlyArray<readonly [caseValue: number, value: Node<R>]>,
  default_: Node<R>,
): Node<R> {
  for (const [, v] of cases) {
    if (!typeEq(v.type, default_.type)) {
      throw new Error(`shader-dsl: matchExpr case Node type ${typeKey(v.type)} does not match default ${typeKey(default_.type)}`)
    }
  }
  return new Node<R>({
    op: 'matchExpr',
    type: default_.type,
    scrutinee: scrutinee.expr,
    cases: cases.map(([n, v]) => [n, v.expr] as const),
    default: default_.expr,
  })
}

// Casts
export const toF32 = (x: Node<string> | number): Node<'f32'> => call('f32', f32T, x) as Node<'f32'>
export const toI32 = (x: Node<string> | number): Node<'i32'> => call('i32', i32T, x) as Node<'i32'>
export const toU32 = (x: Node<string> | number): Node<'u32'> => call('u32', u32T, x) as Node<'u32'>

/** Call a user-defined (authored) function by name. The WGSL backend emits
 *  `name(args)`; the CPU backend dispatches through the compiled fn table. */
export function callFn<T extends ShaderType>(name: string, ret: T, ...args: NodeLike[]): Node<KeyOf<T>> {
  return new Node<KeyOf<T>>({ op: 'call', type: ret, fn: name, args: args.map((a) => lift(a).expr) })
}

// Vector / struct constructors — `TypeName(arg0, arg1, …)`.
export const construct = (type: ShaderType, args: NodeLike[]): Node =>
  new Node({ op: 'construct', type, args: args.map((a) => lift(a).expr) })

/** Low-level struct member access — `base.name`. NOT for authoring: shaders read fields through the
 *  SoT getters (`Handle.of(node).name`, `U.field.name`); this is the primitive those getters build on. */
export const member = <T extends ShaderType>(base: Node, name: string, type: T): Node<KeyOf<T>> =>
  new Node<KeyOf<T>>({ op: 'member', type, base: base.expr, field: name })
export const vec2 = (...a: NodeLike[]): Node<'vec2<f32>'> => construct(vec2fT, a) as Node<'vec2<f32>'>
export const vec3 = (...a: NodeLike[]): Node<'vec3<f32>'> => construct(vec3fT, a) as Node<'vec3<f32>'>
export const vec4 = (...a: NodeLike[]): Node<'vec4<f32>'> => construct(vec4fT, a) as Node<'vec4<f32>'>
export const vec2u = (...a: NodeLike[]): Node<'vec2<u32>'> => construct(vec2uT, a) as Node<'vec2<u32>'>
export const vec2i = (...a: NodeLike[]): Node<'vec2<i32>'> => construct(vec2iT, a) as Node<'vec2<i32>'>

/** mat4x4 × vec4 → vec4 (the generic `.mul` correctly rejects mat×vec since a
 *  matrix is not a scalar/matching-vector operand — this is the explicit MVP
 *  transform path). */
export const transformMat4 = (m: Node<'mat4x4<f32>'>, v: Node<'vec4<f32>'>): Node<'vec4<f32>'> =>
  new Node<'vec4<f32>'>({ op: 'binop', type: vec4fT, bop: '*', a: m.expr, b: v.expr })

/** A fixed-length array literal — `array<elemKey, N>(...)`. */
export const arrayLit = (elem: ShaderType, ...items: Node[]): Node =>
  new Node({ op: 'construct', type: arrayT(elem, items.length), args: items.map((n) => n.expr) })

// ── Composite arithmetic sugar (readability killer #2) ──
// JS has no infix operators, so plain math reads as `.mul().add()` chains. These
// helpers NAME the common painful patterns. Each is a pure Node-method composition,
// so it emits BYTE-IDENTICALLY to the manual chain — readability only, zero IR change.

/** Fused multiply-add — `a*b + c`. */
export const madd = <K extends string>(a: Node<K>, b: ArithArg<K>, c: ArithArg<K>): Node<K> => a.mul(b).add(c)
/** Out-of-range predicate — `x < lo || x > hi`. */
export const outsideRange = (x: Node<ScalarKey>, lo: Node<ScalarKey> | number, hi: Node<ScalarKey> | number): Node<'bool'> => x.lt(lo).or(x.gt(hi))
/** In-range predicate — `x >= lo && x <= hi`. */
export const insideRange = (x: Node<ScalarKey>, lo: Node<ScalarKey> | number, hi: Node<ScalarKey> | number): Node<'bool'> => x.ge(lo).and(x.le(hi))
