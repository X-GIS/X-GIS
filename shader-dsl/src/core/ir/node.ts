// ═══ Shader DSL — Node<K> authoring wrapper + builtins ═══
//
// The TSL-style chaining wrapper over an Expr (Node<K>, phantom-typed for the
// compile-time gate), the literal/ref constructors, and the free-function
// builtins. Imports types.ts + nodes.ts.

import {
  type ShaderType,
  type Scalar,
  type KeyOf,
  type ElemKey,
  type ScalarKey,
  typeKey,
  typeEq,
  isVec,
  isScalar,
  isMat,
  isMat64,
  isF64,
  isVec64,
  f32T,
  f64T,
  vec2f64T,
  vec3f64T,
  vec4f64T,
  mat2f64T,
  mat3f64T,
  mat4f64T,
  i32T,
  u32T,
  boolT,
  vec2fT,
  vec3fT,
  vec4fT,
  vec2uT,
  vec2iT,
  arrayT,
} from './types'
import type { Expr, BinOp, CmpOp } from './nodes'
import { dslError } from '../diagnostics/error'

// Re-export ScalarKey so consumers importing the matchExpr signature can refer
// to its generic bound without a separate types import (mirrors the existing
// `KeyOf` / `ElemKey` re-export pattern in the barrel).
export type { ScalarKey } from './types'

/** Anything acceptable where a Node is READ — any node (mutable or read-only), or a
 *  number that is auto-lifted to an f32 literal (the projection math is f32-dominant).
 *  Reading takes the `ReadonlyNode` supertype, so a `Let()`/param/const operand is
 *  accepted everywhere a value is consumed; only `.assign` needs the mutable subtype. */
export type NodeLike = ReadonlyNode<any> | number

/** Operand a binary arithmetic op accepts: a matching vector or any scalar
 *  (WGSL vec∘scalar broadcast) for a vector LHS; any scalar for a scalar LHS.
 *  A `vec2`+`vec3` mismatch is therefore a TS error. An f64 LHS accepts f64 /
 *  f32 (implicit exact widen) / number — never int/bool (SD0004 at runtime,
 *  rejected here at tsc). */
export type ArithArg<K extends string> = K extends `vec${string}`
  ? ReadonlyNode<K> | ReadonlyNode<ScalarKey | 'f64'> | number
  : K extends 'f64'
    ? ReadonlyNode<'f64'> | ReadonlyNode<ScalarKey> | number
    : ReadonlyNode<ScalarKey> | number

/** Operand a comparison accepts — the scalar set, plus f64 for an f64 LHS
 *  (compared lexicographically after lowering). NB: like the vec branch above,
 *  the f64 branch must stay a SUPERSET of the generic ScalarKey form so
 *  `Node<'f64'>` remains assignable to `ReadonlyNode<string>` (method
 *  bivariance); mixing f64 with an int therefore rejects at AUTHOR-RUN time
 *  (SD0004 from binResultType), not at tsc. */
export type CmpArg<K extends string> = K extends 'f64'
  ? ReadonlyNode<'f64'> | ReadonlyNode<ScalarKey> | number
  : ReadonlyNode<ScalarKey> | number

/** Rejects COMPOSITE keys (vec/mat) as a `this:` bound while keeping scalar AND
 *  widened `ReadonlyNode<string>` receivers usable (#763 X8) — `string` is not a
 *  union, so the conditional does not distribute and passes it through. */
export type NonComposite<K extends string> = K extends `vec${string}` | `mat${string}` ? never : K

// Returns ReadonlyNode<string>, not <any> (#763 X12): `<any>` was assignable to
// EVERY ReadonlyNode<K>, so `const b: ReadonlyNode<'bool'> = lift(3)` type-checked.
export function lift(x: NodeLike): ReadonlyNode<string> {
  return typeof x === 'number' ? new Node({ op: 'lit', type: f32T, value: x }) : x
}

/** Cross-instance node brand (#763 D1). `Symbol.for` resolves through the GLOBAL
 *  symbol registry, so when a bundler loads TWO copies of this package, a node
 *  built by copy B still carries the brand copy A checks for — unlike
 *  `instanceof Node`, whose prototype identity splits per copy (the R1
 *  dup-func incident class: a cross-instance arg fell through the instanceof
 *  check and was misparsed as a named-args bag). Installed on the PROTOTYPE
 *  (one slot, not per-instance — nodes are hot-path allocations). */
export const NODE_BRAND: unique symbol = Symbol.for('xgis.shader-dsl.node') as never
export const isNodeValue = (v: unknown): v is ReadonlyNode =>
  v !== null && typeof v === 'object' && (v as Record<symbol, unknown>)[NODE_BRAND] === true

/** Statement sink — the builder installs how `node.assign(v)` pushes its Stmt to the
 *  current scope. Injected (not imported) so the Node lvalue methods can route to the builder without a
 *  node ↔ builder import cycle. (Reads only `.expr`, so a ReadonlyNode value is fine.) */
type StmtSink = { assign(target: ReadonlyNode<any>, value: ReadonlyNode<any>): void }
let _stmtSink: StmtSink | undefined
export const installStmtSink = (s: StmtSink): void => {
  _stmtSink = s
}
const stmtSink = (): StmtSink => {
  if (!_stmtSink) throw dslError('SD0012')
  return _stmtSink
}

/** Result type of a binary arithmetic op given operand types. vec op scalar
 *  (or vec op same-vec) → vec; scalar op scalar → f32>i32>u32 promotion. A
 *  vec op a different vec is a type error (returned as a poisoned mismatch
 *  that the WGSL/CPU backend never sees because typecheck fails first). */
function binResultType(a: ShaderType, b: ShaderType, ctx: string): ShaderType {
  // mat64 (emulated-double matrices): the ONLY binary op is `*` — M*v → vecN<f64>
  // (matvec) and M*M → matNxN<f64> (matmul). Decided before the native mat arms
  // since `isMat` also matches mat64. A left mat64 with any other op / operand is
  // rejected here at author time (no df64 mat add/sub helpers exist).
  if (isMat64(a)) {
    if (ctx !== '*') throw dslError('SD0041', `${ctx}: '${ctx}' on ${typeKey(a)}`)
    if (isMat64(b)) {
      if (a.n !== b.n) throw dslError('SD0002', `${ctx}: ${typeKey(a)} vs ${typeKey(b)}`)
      return a
    }
    if (isVec64(b)) {
      if (a.n !== b.n) throw dslError('SD0001', `${ctx}: mat${a.n} * vec${b.n}`)
      return b
    }
    throw dslError('SD0004', `${ctx}: ${typeKey(a)} / ${typeKey(b)}`)
  }
  // mat * vec → vec (matN x vecN); mat * mat → mat.
  if (isMat(a) && isVec(b)) {
    if (a.n !== b.n) throw dslError('SD0001', `${ctx}: mat${a.n} * vec${b.n}`)
    return b
  }
  if (isMat(a) && isMat(b)) return a
  if (isVec(a) && isVec(b)) {
    if (!typeEq(a, b)) throw dslError('SD0002', `${ctx}: ${typeKey(a)} vs ${typeKey(b)}`)
    return a
  }
  if (isVec(a) && isScalar(b)) return a
  if (isScalar(a) && isVec(b)) return b
  // vec64 (emulated-double vectors): vec64∘same-vec64 → vec64; vec64∘(f64|f32)
  // scalar broadcasts. Everything else (ints, mixed widths, f32 vecs) rejects.
  // `%` has no emulation; `/` lowers to the vectorized NR division.
  if (isVec64(a) || isVec64(b)) {
    if (ctx === '%') throw dslError('SD0041', `binary op '%' on ${typeKey(a)} / ${typeKey(b)}`)
    if (isVec64(a) && isVec64(b)) {
      if (a.n !== b.n) throw dslError('SD0002', `${ctx}: ${typeKey(a)} vs ${typeKey(b)}`)
      return a
    }
    const [v, other] = isVec64(a) ? [a, b] : [b, a]
    if (isF64(other) || (isScalar(other) && other.scalar === 'f32')) return v
    throw dslError('SD0004', `${ctx}: ${typeKey(a)} / ${typeKey(b)}`)
  }
  // f64 (emulated double): f64∘f64 → f64; f64∘f32 → f64 (implicit EXACT widen —
  // the fp64-lower pass wraps the f32 side as vec2<f32>(x, 0.0)). Anything else
  // (int/bool/vec/mat) is rejected — no implicit narrowing, no int promotion.
  // `%` has no df64 emulation; fail at author time, not at lowering.
  if (isF64(a) || isF64(b)) {
    const other = isF64(a) ? b : a
    if (isF64(other) || (isScalar(other) && other.scalar === 'f32')) {
      if (ctx === '%') throw dslError('SD0041', `binary op '%' on ${typeKey(a)} / ${typeKey(b)}`)
      return f64T
    }
    throw dslError('SD0004', `${ctx}: ${typeKey(a)} / ${typeKey(b)}`)
  }
  if (isScalar(a) && isScalar(b)) {
    const order: Scalar[] = ['f32', 'i32', 'u32']
    const as = a.scalar,
      bs = b.scalar
    if (as === 'bool' || bs === 'bool') throw dslError('SD0003', ctx)
    return order.indexOf(as) <= order.indexOf(bs) ? a : b
  }
  throw dslError('SD0004', `${ctx}: ${typeKey(a)} / ${typeKey(b)}`)
}

const VEC_FIELD_INDEX: Record<string, number> = { x: 0, y: 1, z: 2, w: 3 }
// Colour-alias components map onto the same lanes (WGSL allows either set).
const SWIZZLE_ALIAS: Record<string, string> = { r: 'x', g: 'y', b: 'z', a: 'w' }

// ── Swizzle result-key inference (#740 R9) ──
type StrLen<S extends string, A extends readonly unknown[] = []> = S extends `${string}${infer R}`
  ? StrLen<R, [...A, 1]>
  : A['length']
/** The Node key of `vecK.swizzle(S)` — scalar for one component, vecN<elem> else. */
export type SwizzleKey<K extends string, S extends string> =
  StrLen<S> extends 1 ? ElemKey<K> : `vec${StrLen<S> & number}<${ElemKey<K>}>`

export class ReadonlyNode<K extends string = string> {
  /** Phantom type key. Optional + never assigned, so it carries K covariantly
   *  at the type level (a Node<'vec3<f32>'> is NOT assignable where
   *  Node<'vec2<f32>'> is wanted — the vec3+vec2 compile-error mechanism)
   *  with no real runtime cost. NOTE: must NOT be a `declare` field — the e2e
   *  babel transform (@babel/plugin-transform-typescript) rejects `declare`
   *  class fields, which broke the playwright render-gate build. */
  readonly __k?: K
  constructor(readonly expr: Expr) {}
  get type(): ShaderType {
    return this.expr.type
  }

  /** Typed lift of a bare-number operand against THIS node's scalar context: a number against a
   *  u32/i32 scalar LHS lifts to that scalar (`u32node.add(1)` → `+ 1u`, not naga-invalid `+ 1.0`);
   *  a vec LHS (or any f32-dominant geometry/projection math) keeps the f32 lift (WGSL broadcasts
   *  `vec + scalar`). So the author drops the `f32()`/`u32()`/`i32()` wrapper in every arithmetic,
   *  comparison, and bitwise op — the context types the literal. */
  protected liftArg(o: NodeLike): ReadonlyNode {
    const t = this.type
    if (
      typeof o === 'number' &&
      t.kind === 'scalar' &&
      (t.scalar === 'u32' || t.scalar === 'i32')
    ) {
      return t.scalar === 'u32' ? u32(o) : i32(o)
    }
    // An f64 context lifts a bare number to an f64 LITERAL carrying the full
    // JS-double value — the fp64-lower pass splits it into (hi, lo) f32 halves
    // at build time, so `x.add(0.1)` on an f64 x loses nothing.
    if (typeof o === 'number' && (isF64(t) || isVec64(t))) return f64(o)
    return lift(o)
  }

  private bin(bop: BinOp, o: NodeLike): Node {
    const b = this.liftArg(o)
    return new Node({
      op: 'binop',
      type: binResultType(this.type, b.type, bop),
      bop,
      a: this.expr,
      b: b.expr,
    })
  }
  // Scalar-node × vec-node BROADCASTS (#740 R9): `t.add(phases)` where t is f32
  // and phases vec3<f32> types as vec3<f32> — the runtime (binResultType) always
  // supported it; only the signature forced authors to unroll per component.
  // The `vec${number}<${K}>` constraint self-limits these overloads to a SCALAR
  // LHS (for K = 'vec3<f32>' no vec key can contain it), so vec LHS keeps its
  // exact-K arithmetic unchanged.
  // The `this:` bound (#763 X8) removes these overloads from a VECTOR LHS's
  // candidate set entirely — a vec2+vec3 mismatch now rejects with the readable
  // ArithArg diagnostic instead of leaking a self-nested `vec${n}<vec3<f32>>`
  // template-literal key from a dead broadcast candidate. NonComposite keeps
  // widened `ReadonlyNode<string>` (unparameterised helper params) working.
  add<K2 extends `vec${number}<${K}>`>(
    this: ReadonlyNode<NonComposite<K>>,
    o: ReadonlyNode<K2>,
  ): Node<K2>
  // f32 LHS ∘ f64 RHS widens to f64 (binResultType is symmetric; without this
  // overload only the f64-LHS order type-checked, and the phantom key must be
  // truthful — the runtime result IS f64). The `this:` bound keeps it out of
  // every other receiver's candidate set.
  add(this: ReadonlyNode<'f32'>, o: ReadonlyNode<'f64'>): Node<'f64'>
  add(o: ArithArg<K>): Node<K>
  add(o: NodeLike): Node {
    return this.bin('+', o)
  }
  sub<K2 extends `vec${number}<${K}>`>(
    this: ReadonlyNode<NonComposite<K>>,
    o: ReadonlyNode<K2>,
  ): Node<K2>
  // f32 LHS ∘ f64 RHS widens to f64 (binResultType is symmetric; without this
  // overload only the f64-LHS order type-checked, and the phantom key must be
  // truthful — the runtime result IS f64). The `this:` bound keeps it out of
  // every other receiver's candidate set.
  sub(this: ReadonlyNode<'f32'>, o: ReadonlyNode<'f64'>): Node<'f64'>
  sub(o: ArithArg<K>): Node<K>
  sub(o: NodeLike): Node {
    return this.bin('-', o)
  }
  mul<K2 extends `vec${number}<${K}>`>(
    this: ReadonlyNode<NonComposite<K>>,
    o: ReadonlyNode<K2>,
  ): Node<K2>
  // f32 LHS ∘ f64 RHS widens to f64 (binResultType is symmetric; without this
  // overload only the f64-LHS order type-checked, and the phantom key must be
  // truthful — the runtime result IS f64). The `this:` bound keeps it out of
  // every other receiver's candidate set.
  mul(this: ReadonlyNode<'f32'>, o: ReadonlyNode<'f64'>): Node<'f64'>
  mul(o: ArithArg<K>): Node<K>
  mul(o: NodeLike): Node {
    return this.bin('*', o)
  }
  div<K2 extends `vec${number}<${K}>`>(
    this: ReadonlyNode<NonComposite<K>>,
    o: ReadonlyNode<K2>,
  ): Node<K2>
  // f32 LHS ∘ f64 RHS widens to f64 (binResultType is symmetric; without this
  // overload only the f64-LHS order type-checked, and the phantom key must be
  // truthful — the runtime result IS f64). The `this:` bound keeps it out of
  // every other receiver's candidate set.
  div(this: ReadonlyNode<'f32'>, o: ReadonlyNode<'f64'>): Node<'f64'>
  div(o: ArithArg<K>): Node<K>
  div(o: NodeLike): Node {
    return this.bin('/', o)
  }
  // mod joins the broadcast family (#763 X5) — the runtime (binResultType)
  // always supported scalar%vec; only the signature forced an unroll.
  mod<K2 extends `vec${number}<${K}>`>(
    this: ReadonlyNode<NonComposite<K>>,
    o: ReadonlyNode<K2>,
  ): Node<K2>
  mod(o: ArithArg<K>): Node<K>
  mod(o: NodeLike): Node {
    return this.bin('%', o)
  }
  neg(): Node<K> {
    return new Node<K>({ op: 'unop', type: this.type, a: this.expr })
  }

  private cmp(cop: CmpOp, o: NodeLike): Node<'bool'> {
    // Runtime backstop (#763 X8): these comparisons return Node<'bool'> — a
    // VECTOR comparison in WGSL yields vecN<bool>, so a vec LHS here would emit
    // invalid-typed WGSL with no earlier check (mixed-scalar lint reads binops
    // only). The `this:` bounds below reject it at tsc; hand-built calls land here.
    // An f64 LHS is a legal scalar comparison (lowered lexicographically).
    if (this.type.kind !== 'scalar' && !isF64(this.type))
      throw dslError('SD0002', `compare '${cop}' needs scalar operands, got ${typeKey(this.type)}`)
    const b = this.liftArg(o)
    // f64 operand-compatibility gate (the arithmetic methods get this from
    // binResultType inside bin(); comparisons build their Expr directly).
    if (isF64(this.type) || isF64(b.type)) binResultType(this.type, b.type, cop)
    return new Node<'bool'>({
      op: 'compare',
      type: boolT,
      cop,
      a: this.expr,
      b: b.expr,
    })
  }
  lt(this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>): Node<'bool'> {
    return this.cmp('<', o)
  }
  gt(this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>): Node<'bool'> {
    return this.cmp('>', o)
  }
  le(this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>): Node<'bool'> {
    return this.cmp('<=', o)
  }
  ge(this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>): Node<'bool'> {
    return this.cmp('>=', o)
  }
  eq(this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>): Node<'bool'> {
    return this.cmp('==', o)
  }
  ne(this: ReadonlyNode<NonComposite<K>>, o: CmpArg<K>): Node<'bool'> {
    return this.cmp('!=', o)
  }

  and(o: ReadonlyNode<'bool'>): Node<'bool'> {
    return new Node<'bool'>({ op: 'logical', type: boolT, lop: '&&', a: this.expr, b: o.expr })
  }
  or(o: ReadonlyNode<'bool'>): Node<'bool'> {
    return new Node<'bool'>({ op: 'logical', type: boolT, lop: '||', a: this.expr, b: o.expr })
  }

  /** Bitwise ops on u32 / i32. Number literals auto-lift to the LHS's scalar
   *  type so `flags.bitAnd(1)` emits `flags & 1u` for a u32 flags (the WGSL
   *  rejects mixed-scalar bitwise — typed lifting keeps emit correct). */
  private bitBin(bop: BinOp, o: NodeLike): Node {
    const t = this.type
    if (t.kind !== 'scalar' || (t.scalar !== 'u32' && t.scalar !== 'i32')) {
      throw dslError('SD0005', `${bop}, got ${typeKey(t)}`)
    }
    const bn: ReadonlyNode = typeof o === 'number' ? (t.scalar === 'u32' ? u32(o) : i32(o)) : o
    return new Node({ op: 'binop', type: t, bop, a: this.expr, b: bn.expr })
  }
  bitAnd(o: ReadonlyNode<ScalarKey> | number): Node<K> {
    return this.bitBin('&', o) as Node<K>
  }
  bitOr(o: ReadonlyNode<ScalarKey> | number): Node<K> {
    return this.bitBin('|', o) as Node<K>
  }
  bitXor(o: ReadonlyNode<ScalarKey> | number): Node<K> {
    return this.bitBin('^', o) as Node<K>
  }
  shl(o: ReadonlyNode<ScalarKey> | number): Node<K> {
    return this.bitBin('<<', o) as Node<K>
  }
  shr(o: ReadonlyNode<ScalarKey> | number): Node<K> {
    return this.bitBin('>>', o) as Node<K>
  }

  /** Vector component access — `.x`/`.y`/`.z`/`.w` → elem scalar. */
  comp(field: 'x' | 'y' | 'z' | 'w'): Node<ElemKey<K>> {
    const t = this.type
    // A vec64 component is an f64 scalar (fp64-lower reassembles the lane's
    // hi/lo pair from the struct planes).
    if (isVec64(t)) {
      if (VEC_FIELD_INDEX[field] >= t.n) throw dslError('SD0007', `.${field} on ${typeKey(t)}`)
      return new Node<ElemKey<K>>({ op: 'member', type: f64T, base: this.expr, field })
    }
    if (!isVec(t)) throw dslError('SD0006', `.${field} on ${typeKey(t)}`)
    if (VEC_FIELD_INDEX[field] >= t.n) throw dslError('SD0007', `.${field} on ${typeKey(t)}`)
    return new Node<ElemKey<K>>({
      op: 'member',
      type: { kind: 'scalar', scalar: t.elem },
      base: this.expr,
      field,
    })
  }
  get x(): Node<ElemKey<K>> {
    return this.comp('x')
  }
  get y(): Node<ElemKey<K>> {
    return this.comp('y')
  }
  get z(): Node<ElemKey<K>> {
    return this.comp('z')
  }
  get w(): Node<ElemKey<K>> {
    return this.comp('w')
  }

  /** Vector swizzle — `.rgb`, `.xy`, `.a`, … A length-1 swizzle → scalar;
   *  length-N → vecN of the same element type. The result key is INFERRED from
   *  the components string (#740 R9): `v4.swizzle('yxz')` is `Node<'vec3<f32>'>`
   *  for an f32 source, elem-typed for u32/i32 vectors too — no hand-written
   *  result-type parameter. Components are validated (xyzw/rgba, each within
   *  the source's lane count). */
  swizzle<S extends string>(comps: S): Node<SwizzleKey<K, S>>
  /** @deprecated The explicit-result-type form — the key is inferred from the
   *  components string now; a hand-written key can silently lie. */
  swizzle<R extends string>(comps: string): Node<R>
  swizzle(comps: string): Node {
    const t = this.type
    if (!isVec(t) && !isVec64(t)) throw dslError('SD0008', `.${comps} on ${typeKey(t)}`)
    const n = comps.length
    if (n < 1 || n > 4) throw dslError('SD0008', `.${comps} — a swizzle takes 1-4 components`)
    let family: 'xyzw' | 'rgba' | undefined
    for (const c of comps) {
      const fam: 'xyzw' | 'rgba' = SWIZZLE_ALIAS[c] !== undefined ? 'rgba' : 'xyzw'
      // WGSL forbids mixing the xyzw and rgba component sets in one swizzle
      // ('xg' is invalid) — reject at author time (#763 X15).
      if (family !== undefined && fam !== family)
        throw dslError('SD0008', `.${comps} — mixes xyzw and rgba component sets (WGSL forbids)`)
      family = fam
      const idx = VEC_FIELD_INDEX[(SWIZZLE_ALIAS[c] ?? c) as 'x' | 'y' | 'z' | 'w']
      if (idx === undefined)
        throw dslError('SD0008', `.${comps} — '${c}' is not a component (xyzw/rgba)`)
      if (idx >= t.n) throw dslError('SD0007', `.${comps} on ${typeKey(t)}`)
    }
    const type: ShaderType = isVec64(t)
      ? n === 1
        ? f64T
        : { kind: 'vec64', n: n as 2 | 3 | 4 }
      : n === 1
        ? { kind: 'scalar', scalar: t.elem }
        : { kind: 'vec', n: n as 2 | 3 | 4, elem: t.elem }
    return new Node({ op: 'member', type, base: this.expr, field: comps })
  }
  get r(): Node<ElemKey<K>> {
    return this.comp('x')
  }
  get g(): Node<ElemKey<K>> {
    return this.comp('y')
  }
  get b(): Node<ElemKey<K>> {
    return this.comp('z')
  }
  get a(): Node<ElemKey<K>> {
    return this.comp('w')
  }

  get rgb(): Node<SwizzleKey<K, 'rgb'>> {
    return this.swizzle('rgb')
  }

  // Common multi-component swizzle getters — `w.zxy` instead of vec3(w.z, w.x, w.y).
  // For any other component order (u32/i32 vectors included) use the inferred
  // `.swizzle('...')` — the result key derives from the components string (#740 R9).
  get xy(): Node<SwizzleKey<K, 'xy'>> {
    return this.swizzle('xy')
  }
  get xyz(): Node<SwizzleKey<K, 'xyz'>> {
    return this.swizzle('xyz')
  }
  get zyx(): Node<SwizzleKey<K, 'zyx'>> {
    return this.swizzle('zyx')
  }
  get zxy(): Node<SwizzleKey<K, 'zxy'>> {
    return this.swizzle('zxy')
  }
  get yzx(): Node<SwizzleKey<K, 'yzx'>> {
    return this.swizzle('yzx')
  }
  get bgr(): Node<SwizzleKey<K, 'bgr'>> {
    return this.swizzle('bgr')
  }
  get bgra(): Node<SwizzleKey<K, 'bgra'>> {
    return this.swizzle('bgra')
  }

  /** Array index — base[idx]. Key inferred from the element ShaderType.
   *  A number index lifts to a U32 literal (#763 X11 fallout) — the default
   *  f32 lift emitted `arr[1.0]`, which WGSL rejects (indices are i32/u32);
   *  latent until arrayOf gave plain arrays a literal-index read path. */
  at<T extends ShaderType>(idx: ReadonlyNode<ScalarKey> | number, elem: T): Node<KeyOf<T>> {
    const idxNode = typeof idx === 'number' ? u32(idx) : idx
    return new Node<KeyOf<T>>({ op: 'index', type: elem, base: this.expr, idx: idxNode.expr })
  }

  /** `this ? a : b` (only valid on a bool node — enforced via `this:`).
   *  Both branches must share a key. Mirrors WGSL select(b, a, this). */
  // Number-number branches PIN R to 'f32' (the runtime lift). Without this
  // overload the unconstrained R is open to CONTEXTUAL inference: an inline
  // `x.sub(cond.select(0.0, 1.0))` lets the scalar×vec broadcast overload of
  // `sub` infer R = `vec${'${number}'}<f32>` and mistype the whole chain.
  select(this: ReadonlyNode<'bool'>, a: number, b: number): Node<'f32'>
  select<R extends string>(
    this: ReadonlyNode<'bool'>,
    a: ReadonlyNode<R> | number,
    b: ReadonlyNode<R> | number,
  ): Node<R>
  select<R extends string = 'f32'>(
    this: ReadonlyNode<'bool'>,
    a: ReadonlyNode<R> | number,
    b: ReadonlyNode<R> | number,
  ): Node<R> {
    if (!typeEq(this.type, boolT)) throw dslError('SD0009')
    const ta = lift(a),
      tb = lift(b)
    if (!typeEq(ta.type, tb.type))
      throw dslError('SD0010', `${typeKey(ta.type)} vs ${typeKey(tb.type)}`)
    return new Node<R>({
      op: 'select',
      type: ta.type,
      cond: this.expr,
      ifTrue: ta.expr,
      ifFalse: tb.expr,
    })
  }
}

/** A node that also carries the WRITE capability. `Var()` and the auto-var value bindings
 *  (`const x = <expr>` later `.assign`-ed) are `Node`; `Let()` / a function param / a module
 *  const are the read-only `ReadonlyNode` SUPERTYPE — so `someLet.assign(…)` is a compile error
 *  (the no-assign-to-let footgun, caught by `tsc` instead of only by the lint rule). Every
 *  value-producing method/builtin returns `Node`, so the auto-var sugar keeps working for any
 *  produced value; only named immutable bindings are narrowed to `ReadonlyNode`.
 *
 *  This is a TYPE-LEVEL distinction only — the runtime is one class, so emitted WGSL/GLSL is
 *  byte-identical. (Mirrors RxJS `Observable` (read) vs `Subject` (read+write).) */
// One prototype slot — every ReadonlyNode/Node instance (any package copy)
// answers the cross-instance brand probe (#763 D1).
Object.defineProperty(ReadonlyNode.prototype, NODE_BRAND, { value: true })

export class Node<K extends string = string> extends ReadonlyNode<K> {
  /** `this = value;` — the ONE lvalue-mutation method (matches three.js TSL's `.assign()`). JS can't
   *  overload `=` (`x = v` would just rebind the JS variable, not emit a store), so mutation is a method.
   *  There is no compound `addAssign`: `add` is the pure expression, so `x += v` is `x.assign(x.add(v))`.
   *  The value lifts to this lvalue's scalar context. */
  assign(value: ArithArg<K>): void {
    stmtSink().assign(this, this.liftArg(value))
  }
}

// ── Literal / ref constructors ──

// A scalar-literal ctor takes a JS NUMBER/BOOLEAN. Passing a Node (a common slip when you
// mean to CAST — `f32(intNode)`) would silently bake the object into the lit (emitting
// `[object Object]`), so guard it with a message that points at the cast helpers.
const litNum = (v: number, fn: string): number => {
  if (typeof v !== 'number') {
    throw new TypeError(
      `shader-dsl: ${fn}() takes a numeric literal, got ${typeof v} — to CONVERT a Node use a cast (toF32/toI32/toU32), not ${fn}(node)`,
    )
  }
  return v
}
export const f32 = (v: number): Node<'f32'> =>
  new Node<'f32'>({ op: 'lit', type: f32T, value: litNum(v, 'f32') })
export const i32 = (v: number): Node<'i32'> =>
  new Node<'i32'>({ op: 'lit', type: i32T, value: litNum(v, 'i32') })
export const u32 = (v: number): Node<'u32'> =>
  new Node<'u32'>({ op: 'lit', type: u32T, value: litNum(v, 'u32') })
/** An f64 (emulated double) literal. The lit carries the FULL JS-double value —
 *  the fp64-lower pass splits it into (hi, lo) f32 halves at build time, so the
 *  authored constant round-trips losslessly (JS numbers ARE f64). */
export const f64 = (v: number): Node<'f64'> =>
  new Node<'f64'>({ op: 'lit', type: f64T, value: litNum(v, 'f64') })
export const bool = (v: boolean): Node<'bool'> => {
  if (typeof v !== 'boolean')
    throw new TypeError(`shader-dsl: bool() takes a boolean literal, got ${typeof v}`)
  return new Node<'bool'>({ op: 'lit', type: boolT, value: v })
}

/** A reference to a module-level const (PI, DEG2RAD, EARTH_R, …). Defaults to
 *  an f32 const (every projection const is f32). */
export function constRef<T extends ShaderType = typeof f32T>(
  name: string,
  type?: T,
): ReadonlyNode<KeyOf<T>> {
  return new Node<KeyOf<T>>({ op: 'constref', type: type ?? f32T, name })
}

/** A read of a pipeline specialization constant (#923) — the READ side of an
 *  `overrideConst(...)` declarator. Read-only (a `ReadonlyNode`), and OPAQUE to the
 *  optimizer by its own `op` (see the `overrideref` node in ir/nodes.ts): the value
 *  is symbolic until pipeline creation, so no fold/prop/dead-branch pass may collapse
 *  a branch guarded by it. The authoring surface is `overrideConst` (ir/builder.ts). */
export function overrideRef<T extends ShaderType>(name: string, type: T): ReadonlyNode<KeyOf<T>> {
  return new Node<KeyOf<T>>({ op: 'overrideref', type, name })
}

/** A function parameter reference (key inferred from the ShaderType literal). Read-only — a
 *  param cannot be assigned (so `p.x.assign(...)` on a param is a compile error). */
export function param<T extends ShaderType>(name: string, type: T): ReadonlyNode<KeyOf<T>> {
  return new Node<KeyOf<T>>({ op: 'param', type, name })
}

/** A module-level binding reference (storage/uniform). */
export function bindingRef<T extends ShaderType>(name: string, type: T): Node<KeyOf<T>> {
  return new Node<KeyOf<T>>({ op: 'varref', type, name })
}

// ── Builtins (free functions) ──

const elemScalarType = (t: ShaderType): ShaderType =>
  isVec(t) ? { kind: 'scalar', scalar: t.elem } : t

const call = (fn: string, type: ShaderType, ...args: NodeLike[]): Node =>
  new Node({ op: 'call', type, fn, args: args.map((a) => lift(a).expr) })

// genType1: component-wise unary builtin — preserves the operand key.
const genType1 =
  (fn: string) =>
  <K extends string>(x: ReadonlyNode<K>): Node<K> =>
    call(fn, x.type, x) as Node<K>

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
/** `radians(deg)` / `degrees(rad)` — WGSL built-ins (exact π/180), replacing a `*`/`/` by a rounded
 *  DEG2RAD constant. `x.mul(DEG2RAD)` → `radians(x)`, `x.div(DEG2RAD)` → `degrees(x)`. */
export const radians = genType1('radians')
export const degrees = genType1('degrees')
export const sign = genType1('sign')
/** `exp2(x)` — 2ˣ, component-wise (the base-2 partner of the existing `log2`). */
export const exp2 = genType1('exp2')
/** `trunc(x)` — round toward zero, component-wise. */
export const trunc = genType1('trunc')
/** `round(x)` — nearest integer, ties to even (WGSL / GLSL-ES `round` semantics —
 *  NOT JS `Math.round`, which rounds halves toward +∞). */
export const round = genType1('round')
/** `inverseSqrt(x)` — 1/√x, component-wise. Neutral id: GLSL spells it
 *  `inversesqrt` (see core/intrinsics.ts); WGSL keeps `inverseSqrt`. */
export const inverseSqrt = genType1('inverseSqrt')

export const atan2 = <K extends string>(y: ReadonlyNode<K>, x: NoInfer<ArithArg<K>>): Node<K> =>
  call('atan2', y.type, y, x) as Node<K>
export const min = <K extends string>(a: ReadonlyNode<K>, b: NoInfer<ArithArg<K>>): Node<K> =>
  call('min', binResultType(a.type, lift(b).type, 'min'), a, b) as Node<K>
export const max = <K extends string>(a: ReadonlyNode<K>, b: NoInfer<ArithArg<K>>): Node<K> =>
  call('max', binResultType(a.type, lift(b).type, 'max'), a, b) as Node<K>
/** `pow(a, b)` — same-type binary; second operand promotes via ArithArg so
 *  `pow(z, 4)` emits `pow(z, 4.0)` for an f32 base. WGSL pow only accepts
 *  matching scalar/vec floats, so a vec*scalar broadcast is structurally
 *  rejected by WGSL even when the type system would allow it — we keep
 *  binResultType for parity with `min` / `max`. */
export const pow = <K extends string>(a: ReadonlyNode<K>, b: NoInfer<ArithArg<K>>): Node<K> =>
  call('pow', binResultType(a.type, lift(b).type, 'pow'), a, b) as Node<K>
/** `mod(x, y)` — FLOOR-mod (x − y·⌊x/y⌋) with identical semantics on both
 *  targets, matching GLSL/TSL `mod()` (#839). Float `%` (the `.mod` METHOD) is
 *  TRUNC-mod on WGSL and integer-only in GLSL ES 3.00, so this free fn is THE
 *  portable float modulo — reach for it wherever a negative operand is possible
 *  (domain repetition, angle folds). Deliberately not named `fmod`: C/HLSL
 *  `fmod` is TRUNC-mod, the opposite semantics. Component-wise; `y` may be a
 *  scalar broadcast over a vector `x`. */
export const mod = <K extends string>(x: ReadonlyNode<K>, y: NoInfer<ArithArg<K>>): Node<K> =>
  call('mod', binResultType(x.type, lift(y).type, 'mod'), x, y) as Node<K>
export const clamp = <K extends string>(
  x: ReadonlyNode<K>,
  lo: NoInfer<ArithArg<K>>,
  hi: NoInfer<ArithArg<K>>,
): Node<K> => call('clamp', x.type, x, lo, hi) as Node<K>
/** `fma(a, b, c)` — fused multiply-add a·b+c. WGSL emits the hardware `fma` (a
 *  SINGLE rounding, ATOMIC — a driver's fast-math cannot distribute/reassociate
 *  it, unlike `a.mul(b).add(c)`). GLSL ES 3.00 has no `fma`, so the GLSL target
 *  emits the NON-fused `(a*b+c)` fallback (see core/intrinsics.ts). Reach for
 *  this only where the fused single-rounding is the point — df64 twoProd error
 *  terms (`fma(a, b, -a*b)`) that Apple/Metal folds away when built from split
 *  products. */
export const fma = <K extends string>(
  a: ReadonlyNode<K>,
  b: NoInfer<ArithArg<K>>,
  c: NoInfer<ArithArg<K>>,
): Node<K> => call('fma', a.type, a, b, c) as Node<K>
export const mix = <K extends string>(
  a: ReadonlyNode<K>,
  b: NoInfer<ArithArg<K>>,
  t: ReadonlyNode<ScalarKey> | number,
): Node<K> => call('mix', a.type, a, b, t) as Node<K>
/** `smoothstep(e0, e1, x)` — WGSL takes MATCHING scalar/vec floats. The vector
 *  overload preserves x's key (#763 X15) — the old scalar-only signature was a
 *  capability gap, and its `elemScalarType` result would have mistyped a vector
 *  result as scalar had one slipped through. */
export function smoothstep<K extends `vec${number}<f32>`>(
  e0: ReadonlyNode<K>,
  e1: ReadonlyNode<K>,
  x: ReadonlyNode<K>,
): Node<K>
export function smoothstep(
  e0: ReadonlyNode<ScalarKey> | number,
  e1: ReadonlyNode<ScalarKey> | number,
  x: ReadonlyNode<ScalarKey> | number,
): Node<'f32'>
export function smoothstep(
  e0: ReadonlyNode<string> | number,
  e1: ReadonlyNode<string> | number,
  x: ReadonlyNode<string> | number,
): Node<string> {
  const n = lift(x)
  return call('smoothstep', n.type.kind === 'vec' ? n.type : elemScalarType(n.type), e0, e1, n)
}
/** `step(edge, x)` — 0 where x < edge, else 1, component-wise. Result is keyed
 *  by `x` (the genType operand); WGSL needs `edge` and `x` the same type. */
export const step = <K extends string>(edge: NoInfer<ArithArg<K>>, x: ReadonlyNode<K>): Node<K> =>
  call('step', x.type, edge, x) as Node<K>
// K-constrained like `cross` (#763 X7) — dot(v2, v3) used to COMPILE and die at
// naga; the shared K pins both operands to one float-vector key.
export function length<K extends `vec${number}<f64>`>(v: ReadonlyNode<K>): Node<'f64'>
export function length<K extends `vec${number}<f32>`>(v: ReadonlyNode<K>): Node<'f32'>
export function length(v: ReadonlyNode<string>): Node<string> {
  return call('length', isVec64(v.type) ? f64T : f32T, v)
}
export function dot<K extends `vec${number}<f64>`>(
  a: ReadonlyNode<K>,
  b: NoInfer<ReadonlyNode<K>>,
): Node<'f64'>
export function dot<K extends `vec${number}<f32>`>(
  a: ReadonlyNode<K>,
  b: NoInfer<ReadonlyNode<K>>,
): Node<'f32'>
export function dot(a: ReadonlyNode<string>, b: ReadonlyNode<string>): Node<string> {
  return call('dot', isVec64(a.type) ? f64T : f32T, a, b)
}
/** `normalize(v)` — v/|v|; preserves the vector key (vec2/3/4). */
export const normalize = genType1('normalize')
/** `distance(a, b)` — |a − b| (vector → scalar), the built-in spelling of the
 *  hand-rolled `length(a.sub(b))`. */
export function distance<K extends `vec${number}<f64>`>(
  a: ReadonlyNode<K>,
  b: NoInfer<ReadonlyNode<K>>,
): Node<'f64'>
export function distance<K extends `vec${number}<f32>`>(
  a: ReadonlyNode<K>,
  b: NoInfer<ReadonlyNode<K>>,
): Node<'f32'>
export function distance(a: ReadonlyNode<string>, b: ReadonlyNode<string>): Node<string> {
  return call('distance', isVec64(a.type) ? f64T : f32T, a, b)
}
/** `cross(a, b)` — 3-D cross product (vec3 only). */
export const cross = (
  a: ReadonlyNode<'vec3<f32>'>,
  b: ReadonlyNode<'vec3<f32>'>,
): Node<'vec3<f32>'> => call('cross', vec3fT, a, b) as Node<'vec3<f32>'>
// NOTE: the GLSL/WGSL builtin `reflect(i, n)` is intentionally NOT added — the
// name is already taken by the std140 reflection engine (core/reflect.ts), and no
// shader currently needs vector reflection. Add it under a non-colliding name only
// when a real call site appears.
/** Pack a vec4<f32> (each component in [0,1]) into a u32 RGBA8. */
export const pack4x8unorm = (v: ReadonlyNode<'vec4<f32>'>): Node<'u32'> =>
  call('pack4x8unorm', u32T, v) as Node<'u32'>
/** Unpack a u32 RGBA8 into a vec4<f32> (each component in [0,1]). */
export const unpack4x8unorm = (v: ReadonlyNode<'u32'>): Node<'vec4<f32>'> =>
  call('unpack4x8unorm', vec4fT, v) as Node<'vec4<f32>'>
/** Reinterpret an f32's bit pattern as u32. Carries the NEUTRAL intrinsic id
 *  `bitcastU32`; the registry (core/intrinsics.ts) spells it `bitcast<u32>(x)` on
 *  WGSL and `floatBitsToUint(x)` on GLSL — no WGSL generic syntax in the IR. */
export const bitcastU32 = (v: ReadonlyNode<'f32'>): Node<'u32'> =>
  call('bitcastU32', u32T, v) as Node<'u32'>
/** Reinterpret a u32's bit pattern as f32 — the inverse of {@link bitcastU32}.
 *  The registry spells it `bitcast<f32>(x)` on WGSL and `uintBitsToFloat(x)` on
 *  GLSL. An f32→u32→f32 round-trip is a fast-math optimization barrier (the
 *  integer domain is not subject to float reassociation/contraction). */
export const bitcastF32 = (v: ReadonlyNode<'u32'>): Node<'f32'> =>
  call('bitcastF32', f32T, v) as Node<'f32'>
/** Sample a 2D texture → vec4<f32>. (CPU eval: opt-in stub.) First-arg
 *  constraints (#763 X6): a texture/sampler swap used to type-check and die
 *  at naga — KeyOf now carries specific texture/sampler keys. */
export const textureSample = (
  tex: ReadonlyNode<'texture_2d<f32>'>,
  smp: ReadonlyNode<'sampler'>,
  uv: ReadonlyNode<'vec2<f32>'>,
): Node<'vec4<f32>'> => call('textureSample', vec4fT, tex, smp, uv) as Node<'vec4<f32>'>
/** Load a texel from a 2D texture at integer coords → vec4<f32>. The mip
 *  level argument is required by WGSL; pass `0` for the base level.
 *  Coord is typically `vec2<i32>`; the runtime accepts any vec2 / scalar
 *  NodeLike and lets WGSL's textureLoad signature check. (CPU stub.) */
export const textureLoad = (
  tex: ReadonlyNode<'texture_2d<f32>' | 'texture_multisampled_2d<f32>'>,
  coord: NodeLike,
  level: NodeLike,
): Node<'vec4<f32>'> => call('textureLoad', vec4fT, tex, coord, level) as Node<'vec4<f32>'>
/** INTERNAL (core/fp64/df64-lib.ts): the fp64 anti-fast-math guard value — a
 *  runtime-opaque 1.0. Spelled per target as a texel fetch from the injected
 *  `_fp64` texture (intrinsics.ts `f64Guard`); the CPU oracle evaluates it as
 *  exactly 1. Not part of the authoring surface. */
export const f64GuardOne = (): Node<'f32'> =>
  call('f64Guard', { kind: 'scalar', scalar: 'f32' }) as Node<'f32'>
/** Texture extent in texels → vec2<u32>. Cost: one query per fragment in
 *  fullscreen-triangle compose passes; cached in a `let` by the caller. */
export const textureDimensions = (
  tex: ReadonlyNode<'texture_2d<f32>' | 'texture_multisampled_2d<f32>'>,
): Node<'vec2<u32>'> => call('textureDimensions', vec2uT, tex) as Node<'vec2<u32>'>
/** Screen-space derivative magnitude — GPU-only (uncomputable per-invocation
 *  on the CPU; the interpreter stubs it to 0). */
export const fwidth = genType1('fwidth')
/** Screen-space partial derivatives (#846) — GPU-only like `fwidth` (the
 *  interpreter stubs them to 0). Divergent spelling handled by the intrinsic
 *  registry: WGSL `dpdx`/`dpdy`, GLSL ES 3.00 `dFdx`/`dFdy`. */
export const dpdx = genType1('dpdx')
export const dpdy = genType1('dpdy')

/** select(cond, ifTrue, ifFalse) — free-function form of Node.select. The
 *  number-number overload pins R to 'f32' (see Node.select — keeps contextual
 *  inference from widening R to a vec key inside a broadcast-overload arg). */
export function select(cond: ReadonlyNode<'bool'>, ifTrue: number, ifFalse: number): Node<'f32'>
export function select<R extends string>(
  cond: ReadonlyNode<'bool'>,
  ifTrue: ReadonlyNode<R> | number,
  ifFalse: ReadonlyNode<R> | number,
): Node<R>
export function select<R extends string>(
  cond: ReadonlyNode<'bool'>,
  ifTrue: ReadonlyNode<R> | number,
  ifFalse: ReadonlyNode<R> | number,
): Node<R> {
  return cond.select(ifTrue, ifFalse)
}

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
  scrutinee: ReadonlyNode<S>,
  // Thunk-or-node arms (#763 X17): when/matchEnum arms are thunks while
  // matchExpr's were eager nodes — migrating between the dispatch forms
  // silently moved value construction (and any inner Let) in or out of the
  // arm. Accepting both normalises the family; eager nodes stay supported.
  cases: ReadonlyArray<
    readonly [caseValue: number, value: ReadonlyNode<R> | (() => ReadonlyNode<R>)]
  >,
  default_: ReadonlyNode<R> | (() => ReadonlyNode<R>),
): Node<R> {
  const resolve = (v: ReadonlyNode<R> | (() => ReadonlyNode<R>)): ReadonlyNode<R> =>
    typeof v === 'function' ? v() : v
  const resolvedCases = cases.map(([n, v]) => [n, resolve(v)] as const)
  const resolvedDefault = resolve(default_)
  for (const [, v] of resolvedCases) {
    if (!typeEq(v.type, resolvedDefault.type)) {
      throw dslError('SD0011', `${typeKey(v.type)} vs default ${typeKey(resolvedDefault.type)}`)
    }
  }
  return new Node<R>({
    op: 'matchExpr',
    type: resolvedDefault.type,
    scrutinee: scrutinee.expr,
    cases: resolvedCases.map(([n, v]) => [n, v.expr] as const),
    default: resolvedDefault.expr,
  })
}

// ── Exhaustive integer dispatch (enumU32 + matchEnum) ──

/** A typed u32 "enum" — a name→value map whose members are `Node<'u32'>` literals, plus the raw
 *  value map. Pair with `matchEnum` for EXHAUSTIVE integer dispatch: the arms object must cover
 *  every member (a missing or unknown key is a `tsc` error), so a forgotten case is caught at
 *  compile time instead of silently falling through the WGSL `switch` default. */
export interface EnumU32<M extends Record<string, number>> {
  /** Typed member literals — `Kind.members.Fill` is a `Node<'u32'>` of that member's value. */
  readonly members: { readonly [K in keyof M]: Node<'u32'> }
  /** The raw name→value map (the integer case labels `matchEnum` dispatches on). */
  readonly values: M
}

/** Declare a u32 enum from a name→value map — `const Kind = enumU32({ Line: 0, Fill: 1, Stroke: 2 })`.
 *  The `const` type parameter preserves the literal keys, so `matchEnum` can require one arm per
 *  member. Values are the integer case labels emitted in the switch. */
export function enumU32<const M extends Record<string, number>>(values: M): EnumU32<M> {
  const members = {} as { [K in keyof M]: Node<'u32'> }
  for (const k of Object.keys(values) as (keyof M)[]) members[k] = u32(values[k])
  return { members, values }
}

/** Exhaustive integer dispatch over an `enumU32` — `matchEnum(kind, Kind, { Line: () => …, Fill: () => …, … })`.
 *  EVERY member must have an arm: omit one and `tsc` errors (the arms type is a mapped type over the
 *  enum's keys), so adding an enum member immediately surfaces every un-handled dispatch site. Lowers to
 *  the SAME `matchExpr` the hand-written form emits — the last-declared member becomes the switch
 *  `default`, so the emitted WGSL is a standard exhaustive switch (byte-identical to the manual form).
 *  Arms are zero-arg thunks; their values are built in declared order. */
export function matchEnum<M extends Record<string, number>, R extends string>(
  scrutinee: ReadonlyNode<ScalarKey>,
  e: EnumU32<M>,
  arms: { readonly [K in keyof M]: () => ReadonlyNode<R> },
): Node<R> {
  const keys = Object.keys(e.values) as (keyof M & string)[]
  if (keys.length === 0) throw new Error('shader-dsl: matchEnum needs at least one member')
  const last = keys[keys.length - 1]!
  const cases = keys.slice(0, -1).map((k) => [e.values[k], arms[k]()] as const)
  return matchExpr(scrutinee, cases, arms[last]())
}

// Casts
/** Narrow to f32. On an f64 argument this is the EXPLICIT precision-losing
 *  narrow (lowered to hi + lo); f64 never narrows implicitly. */
export const toF32 = (x: ReadonlyNode<string> | number): Node<'f32'> =>
  call('f32', f32T, x) as Node<'f32'>
/** Widen f32 → f64 — exact (lowered to vec2<f32>(x, 0.0)). The explicit
 *  spelling of the widen the arithmetic methods apply implicitly. */
export const toF64 = (x: ReadonlyNode<'f32'> | number): Node<'f64'> =>
  call('f64', f64T, x) as Node<'f64'>
/** Assemble an f64 from its (hi, lo) f32 halves — the shader-side twin of
 *  `splitF64` for values arriving as two f32 lanes (a DSFUN hi/lo vertex
 *  attribute pair, a packed buffer). Lowered to `vec2<f32>(hi, lo)` — free.
 *  The halves must be a NORMALIZED split (lo = x − hi as produced by
 *  splitF64); un-normalized pairs weaken the arithmetic's error bounds. */
export const f64FromParts = (
  hi: ReadonlyNode<'f32'> | number,
  lo: ReadonlyNode<'f32'> | number,
): Node<'f64'> => call('f64FromParts', f64T, hi, lo) as Node<'f64'>
/** The (hi, lo) pair of an f64 as a plain vec2<f32> — for STORING an f64 into
 *  a vec2 buffer field / IO slot. Lowered to the identity (an f64 already IS
 *  its pair post-lowering); `f64FromParts(v.x, v.y)` round-trips it. */
export const f64Parts = (x: ReadonlyNode<'f64'>): Node<'vec2<f32>'> =>
  call('f64Parts', vec2fT, x) as Node<'vec2<f32>'>
export const toI32 = (x: ReadonlyNode<string> | number): Node<'i32'> =>
  call('i32', i32T, x) as Node<'i32'>
export const toU32 = (x: ReadonlyNode<string> | number): Node<'u32'> =>
  call('u32', u32T, x) as Node<'u32'>

/** Call a user-defined (authored) function by name. The WGSL backend emits
 *  `name(args)`; the CPU backend dispatches through the compiled fn table.
 *  @deprecated The string-call form checks NOTHING — even less than the
 *  deprecated positional handle call (#763 X16). Call the FnHandle returned by
 *  `fn()` (typed object-param form), or `externFn()` for a not-yet-built
 *  signature. Kept for the call factories' internal use. */
export function callFn<T extends ShaderType>(
  name: string,
  ret: T,
  ...args: NodeLike[]
): Node<KeyOf<T>> {
  return new Node<KeyOf<T>>({
    op: 'call',
    type: ret,
    fn: name,
    args: args.map((a) => lift(a).expr),
  })
}

// Vector / struct constructors — `TypeName(arg0, arg1, …)`.
export const construct = (type: ShaderType, args: NodeLike[]): Node => {
  // A bare-number component lifts to the constructed type's ELEMENT scalar — so `vec4(pos, 0, 1)` emits
  // f32 components and `vec2u(0, 1)` emits u32 ones, dropping the f32()/u32() wrapper. Non-vec (struct)
  // args are typed field Nodes already, so the f32 fallback never lifts a stray number.
  const elem =
    type.kind === 'vec'
      ? type.elem
      : type.kind === 'vec64'
        ? 'f64'
        : type.kind === 'array' && type.elem.kind === 'scalar'
          ? type.elem.scalar
          : 'f32'
  const elemT = elem === 'u32' ? u32T : elem === 'i32' ? i32T : elem === 'f64' ? f64T : f32T
  return new Node({
    op: 'construct',
    type,
    args: args.map(
      (a) => (typeof a === 'number' ? new Node({ op: 'lit', type: elemT, value: a }) : a).expr,
    ),
  })
}

/** Low-level struct member access — `base.name`. NOT for authoring: shaders read fields through the
 *  SoT getters (`Handle.of(node).name`, `U.field.name`); this is the primitive those getters build on. */
export const member = <T extends ShaderType>(
  base: ReadonlyNode,
  name: string,
  type: T,
): Node<KeyOf<T>> => new Node<KeyOf<T>>({ op: 'member', type, base: base.expr, field: name })
export const vec2 = (...a: NodeLike[]): Node<'vec2<f32>'> =>
  construct(vec2fT, a) as Node<'vec2<f32>'>
export const vec3 = (...a: NodeLike[]): Node<'vec3<f32>'> =>
  construct(vec3fT, a) as Node<'vec3<f32>'>
export const vec4 = (...a: NodeLike[]): Node<'vec4<f32>'> =>
  construct(vec4fT, a) as Node<'vec4<f32>'>
export const vec2u = (...a: NodeLike[]): Node<'vec2<u32>'> =>
  construct(vec2uT, a) as Node<'vec2<u32>'>
export const vec2i = (...a: NodeLike[]): Node<'vec2<i32>'> =>
  construct(vec2iT, a) as Node<'vec2<i32>'>
// Emulated-double vector constructors. Components are f64 nodes (or bare
// numbers, split losslessly at build time); an f32 component widens exactly
// during lowering. A single argument splats, WGSL-style.
type Vec64Arg = ReadonlyNode<'f64' | 'f32'> | number
export const vec2f64 = (...a: Vec64Arg[]): Node<'vec2<f64>'> =>
  construct(vec2f64T, a) as Node<'vec2<f64>'>
export const vec3f64 = (...a: Vec64Arg[]): Node<'vec3<f64>'> =>
  construct(vec3f64T, a) as Node<'vec3<f64>'>
export const vec4f64 = (...a: Vec64Arg[]): Node<'vec4<f64>'> =>
  construct(vec4f64T, a) as Node<'vec4<f64>'>

// Emulated-double matrix constructors — column-major, one vecN<f64> per column
// (the same convention as WGSL `matNxN(col0, …)`). They lower to a DF64MatN
// column struct; matmul / mat·vec / transpose compose the SCALAR df64 EFTs.
type Mat64Col<N extends 2 | 3 | 4> = ReadonlyNode<`vec${N}<f64>`>
export const mat2f64 = (...cols: [Mat64Col<2>, Mat64Col<2>]): Node<'mat2x2<f64>'> =>
  construct(mat2f64T, cols) as Node<'mat2x2<f64>'>
export const mat3f64 = (...cols: [Mat64Col<3>, Mat64Col<3>, Mat64Col<3>]): Node<'mat3x3<f64>'> =>
  construct(mat3f64T, cols) as Node<'mat3x3<f64>'>
export const mat4f64 = (
  ...cols: [Mat64Col<4>, Mat64Col<4>, Mat64Col<4>, Mat64Col<4>]
): Node<'mat4x4<f64>'> => construct(mat4f64T, cols) as Node<'mat4x4<f64>'>

/** matNxN<f64> × vecN<f64> → vecN<f64> — the emulated-double MVP transform (the
 *  generic `.mul` rejects mat×vec, exactly as `transformMat4` covers f32). */
export const transformMat64 = <N extends 2 | 3 | 4>(
  m: ReadonlyNode<`mat${N}x${N}<f64>`>,
  v: ReadonlyNode<`vec${N}<f64>`>,
): Node<`vec${N}<f64>`> =>
  new Node({
    op: 'binop',
    type: binResultType(m.type, v.type, '*'),
    bop: '*',
    a: m.expr,
    b: v.expr,
  }) as Node<`vec${N}<f64>`>
/** matNxN<f64> × matNxN<f64> → matNxN<f64> — emulated-double matrix product. */
export const mulMat64 = <N extends 2 | 3 | 4>(
  a: ReadonlyNode<`mat${N}x${N}<f64>`>,
  b: ReadonlyNode<`mat${N}x${N}<f64>`>,
): Node<`mat${N}x${N}<f64>`> =>
  new Node({
    op: 'binop',
    type: binResultType(a.type, b.type, '*'),
    bop: '*',
    a: a.expr,
    b: b.expr,
  }) as Node<`mat${N}x${N}<f64>`>
/** Transpose of an emulated-double matrix (new column i = lane i of every old column). */
export const transpose64 = <N extends 2 | 3 | 4>(
  m: ReadonlyNode<`mat${N}x${N}<f64>`>,
): Node<`mat${N}x${N}<f64>`> => call('transpose', m.type, m) as Node<`mat${N}x${N}<f64>`>

/** mat4x4 × vec4 → vec4 (the generic `.mul` correctly rejects mat×vec since a
 *  matrix is not a scalar/matching-vector operand — this is the explicit MVP
 *  transform path). */
export const transformMat4 = (
  m: ReadonlyNode<'mat4x4<f32>'>,
  v: ReadonlyNode<'vec4<f32>'>,
): Node<'vec4<f32>'> =>
  new Node<'vec4<f32>'>({ op: 'binop', type: vec4fT, bop: '*', a: m.expr, b: v.expr })

/** A fixed-length array literal — `array<elemKey, N>(...)`. */
export const arrayLit = (elem: ShaderType, ...items: ReadonlyNode[]): Node =>
  new Node({ op: 'construct', type: arrayT(elem, items.length), args: items.map((n) => n.expr) })

// ── Composite arithmetic sugar (readability killer #2) ──
// JS has no infix operators, so plain math reads as `.mul().add()` chains. These
// helpers NAME the common painful patterns. Each is a pure Node-method composition,
// so it emits BYTE-IDENTICALLY to the manual chain — readability only, zero IR change.

/** Fused multiply-add — `a*b + c`. */
export const madd = <K extends string>(
  a: ReadonlyNode<K>,
  b: NoInfer<ArithArg<K>>,
  c: NoInfer<ArithArg<K>>,
): Node<K> => a.mul(b).add(c)
/** Out-of-range predicate — `x < lo || x > hi`. */
export const outsideRange = (
  x: ReadonlyNode<ScalarKey>,
  lo: ReadonlyNode<ScalarKey> | number,
  hi: ReadonlyNode<ScalarKey> | number,
): Node<'bool'> => x.lt(lo).or(x.gt(hi))
/** In-range predicate — `x >= lo && x <= hi`. */
export const insideRange = (
  x: ReadonlyNode<ScalarKey>,
  lo: ReadonlyNode<ScalarKey> | number,
  hi: ReadonlyNode<ScalarKey> | number,
): Node<'bool'> => x.ge(lo).and(x.le(hi))
