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
  vec4uT,
  vec4iT,
  arrayT,
} from './types.js'
import type { Expr, BinOp, CmpOp } from './nodes.js'
import { dslError } from '../diagnostics/error.js'

// Re-export ScalarKey so consumers importing the matchExpr signature can refer
// to its generic bound without a separate types import (mirrors the existing
// `KeyOf` / `ElemKey` re-export pattern in the barrel).
export type { ScalarKey } from './types.js'

/** Anything acceptable where a Node is READ — any node (mutable or read-only), or a
 *  number that is auto-lifted to an f32 literal (the projection math is f32-dominant).
 *  Reading takes the `ReadonlyNode` supertype, so a `Let()`/param/const operand is
 *  accepted everywhere a value is consumed; only `.assign` needs the mutable subtype. */
export type NodeLike = ReadonlyNode<any> | number

/** The scalar keys a binary op may pair with element kind `E` — the SAME kind only,
 *  except f64's blessed exact widen from f32. This is `binResultType`'s law made static:
 *  WGSL and GLSL ES 3.00 have NO implicit scalar conversions, so a mixed pair
 *  (f32∘i32, i32∘u32, vec<f32>∘i32-scalar) emits code neither target compiles — and for
 *  non-f64 pairs `binResultType`'s C-like promotion ranking never rejected it, so the
 *  first diagnostic used to be the emit-time `mixed-scalar` lint (or the GPU compiler,
 *  on a raw-IR path). For the WIDENED `K = string` (unparameterised helper params) both
 *  aliases below fall back to `ReadonlyNode<string>`, which every kind-matched branch is
 *  a SUBSET of — that ⊆ direction is what keeps `Node<'f64'>` (and every other specific
 *  key) assignable to `ReadonlyNode<string>` under method bivariance. (The previous
 *  design got the same assignability from the OPPOSITE direction — every branch a
 *  SUPERSET of a `ScalarKey` fallback — which is exactly what admitted the mixed-kind
 *  operands this replaces.) */
type KindScalar<E extends string> = E extends 'f64' ? 'f64' | 'f32' : E

/** Operand a binary arithmetic op accepts: the SAME vector key, or a scalar of the
 *  vector's own element kind (WGSL vec∘scalar broadcast), for a vector LHS; the same
 *  scalar kind for a scalar LHS. A `vec2`+`vec3` mismatch, and any int↔float /
 *  i32↔u32 mix, is therefore a TS error. An f64 LHS (and a vec64's scalar broadcast)
 *  additionally accepts f32 — the implicit EXACT widen — and `number` lifts to the
 *  receiver's own scalar kind everywhere. */
export type ArithArg<K extends string> = K extends `vec${number}<${infer E}>`
  ? ReadonlyNode<K> | ReadonlyNode<KindScalar<E>> | number
  : ReadonlyNode<KindScalar<K>> | number

/** Operand a comparison accepts — the LHS's own scalar kind (both targets type
 *  comparisons over matching operands), plus f32 for an f64 LHS (widened, then
 *  compared lexicographically after lowering). Mixed kinds (f32 vs i32, f64 vs int)
 *  now reject at tsc; the emit-time `mixed-scalar` lint stays the raw-IR backstop. */
export type CmpArg<K extends string> = ReadonlyNode<KindScalar<K>> | number

/** Rejects COMPOSITE keys (vec/mat) as a `this:` bound while keeping scalar AND
 *  widened `ReadonlyNode<string>` receivers usable (#763 X8) — `string` is not a
 *  union, so the conditional does not distribute and passes it through. */
export type NonComposite<K extends string> = K extends `vec${string}` | `mat${string}` ? never : K

// NB — the `.and`/`.or` RECEIVER is deliberately NOT `this:`-bounded. A
// `this: ReadonlyNode<K extends 'bool' ? K : never>`-style bound was tried and
// broke `Node<'vec4<f32>'> → ReadonlyNode<string>` / `Node<'u32'> →
// ReadonlyNode<ScalarKey>` assignability ACROSS the d.ts boundary (the compiler
// package went red while shader-dsl's own build stayed green) — the same
// never-`this` shape the comparisons' NonComposite bound survives, tipped over
// by one more such member. The receiver is guarded at AUTHOR-RUN time instead
// (SD0004 below, the bitwise SD0005 precedent), which still fails long before a
// GPU compiler would.

// Returns ReadonlyNode<string>, not <any> (#763 X12): `<any>` was assignable to
// EVERY ReadonlyNode<K>, so `const b: ReadonlyNode<'bool'> = lift(3)` type-checked.
/** Normalizes a `NodeLike` operand to a `ReadonlyNode` — a bare JS number auto-lifts to an f32
 *  literal, an existing node passes through untouched. Every free-function builtin (`sin`,
 *  `min`, `construct`, …) funnels its operands through this, which is why `sin(1)` works without
 *  an explicit `f32(1)` wrapper. Call it directly only when authoring a NEW builtin wrapper that
 *  needs a plain `ReadonlyNode` from a `NodeLike` arg — method operands go through the type-aware
 *  variant on `ReadonlyNode` instead, which lifts a bare number to the RECEIVER's scalar kind
 *  (u32/i32/f64) rather than always defaulting to f32.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { lift, f32 } from '@xgis/shader-dsl'
 *
 *  lift(2)       // Node<'f32'> — 2 lifted to an f32 literal
 *  lift(f32(2))  // the same node, passed through unchanged
 *  ```
 */
export function lift(x: NodeLike): ReadonlyNode<string> {
  return typeof x === 'number' ? new Node({ op: 'lit', type: f32T, value: litNum(x, 'lift') }) : x
}

/** Cross-instance node brand (#763 D1). `Symbol.for` resolves through the GLOBAL
 *  symbol registry, so when a bundler loads TWO copies of this package, a node
 *  built by copy B still carries the brand copy A checks for — unlike
 *  `instanceof Node`, whose prototype identity splits per copy (the R1
 *  dup-func incident class: a cross-instance arg fell through the instanceof
 *  check and was misparsed as a named-args bag). Installed on the PROTOTYPE
 *  (one slot, not per-instance — nodes are hot-path allocations). */
export const NODE_BRAND: unique symbol = Symbol.for('xgis.shader-dsl.node') as never
/** Runtime type guard for "is this value a node" — reads the {@link NODE_BRAND} slot instead of
 *  `instanceof Node`, so it still recognizes a node built by a DIFFERENT loaded copy of this
 *  package (a dual-loaded dependency splits prototype identity, so `instanceof` alone would miss
 *  it and misroute the value into a named-args parse — see NODE_BRAND's own doc, #763 D1). Reach
 *  for this over `instanceof` anywhere a value's origin package isn't guaranteed to be this one.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { isNodeValue, f32 } from '@xgis/shader-dsl'
 *
 *  isNodeValue(f32(1))  // true
 *  isNodeValue(42)      // false — a bare number, not a node
 *  ```
 */
export const isNodeValue = (v: unknown): v is ReadonlyNode =>
  v !== null && typeof v === 'object' && (v as Record<symbol, unknown>)[NODE_BRAND] === true

/** Statement sink — the builder installs how `node.assign(v)` pushes its Stmt to the
 *  current scope. Injected (not imported) so the Node lvalue methods can route to the builder without a
 *  node ↔ builder import cycle. (Reads only `.expr`, so a ReadonlyNode value is fine.) */
type StmtSink = { assign(target: ReadonlyNode<any>, value: ReadonlyNode<any>): void }
let _stmtSink: StmtSink | undefined
/** Wires `Node.assign()` to a statement sink — the ONE seam node.ts uses to reach the builder
 *  without importing it (importing builder.ts here would create a node↔builder cycle). The
 *  builder module calls this exactly once, at load, with its own `{ assign }` implementation;
 *  authoring code calls `.assign()` on a node and never touches this directly.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { installStmtSink } from '@xgis/shader-dsl'
 *
 *  // The one real call site (core/ir/builder.ts), routing assign to the active scope:
 *  installStmtSink({
 *    assign: (target, value) => currentBuilder().assign(target, value),
 *  })
 *  ```
 */
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

/** The read-only base of the value-node surface: every literal, param, `constRef`, and `Let()`
 *  binding is (or stays) a `ReadonlyNode`. It carries the full chainable API — arithmetic
 *  (`.add`/`.sub`/…), comparison, swizzles, `.at()`, `.select()` — but withholds `.assign()`,
 *  which lives only on the mutable {@link Node} subtype. Write a helper's operand type as
 *  `ReadonlyNode<K>` (not `Node<K>`) whenever the value only needs to be READ — it accepts
 *  BOTH a `Let`/param AND a `Var`, since `Node` is a subtype of this class.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @throws {ShaderDslError} `SD0004` from an arithmetic/comparison method whose two operands
 *    have incompatible types (`vec3<f32>` against `vec2<f32>`, say). The `Node<K>` phantom key
 *    catches most of these at `tsc` time; this is the runtime backstop for the cases that
 *    reach it through a `string`-keyed or dynamically-built operand.
 */
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

  // `&&`/`||` are bool-only on BOTH targets. The receiver check is a runtime
  // guard (author-run, like the bitwise SD0005) rather than a `this:` bound —
  // see the note beside NonComposite for why the type-level form is off the
  // table. The operand side is typed `ReadonlyNode<'bool'>` as before.
  private logical(lop: '&&' | '||', o: ReadonlyNode<'bool'>): Node<'bool'> {
    if (this.type.kind !== 'scalar' || this.type.scalar !== 'bool') {
      throw dslError('SD0004', `logical '${lop}' needs bool operands, got ${typeKey(this.type)}`)
    }
    return new Node<'bool'>({ op: 'logical', type: boolT, lop, a: this.expr, b: o.expr })
  }
  and(o: ReadonlyNode<'bool'>): Node<'bool'> {
    return this.logical('&&', o)
  }
  or(o: ReadonlyNode<'bool'>): Node<'bool'> {
    return this.logical('||', o)
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
  // `& | ^` need BOTH sides the same int kind on both targets, so the node operand
  // is kind-matched to the receiver (`K & ('i32'|'u32')` is `never` for a float LHS
  // — the SD0005 author-run throw already owns that case, numbers aside). Shifts are
  // the deliberate exception, mirroring the mixed-scalar lint's SHIFT_OPS carve-out:
  // WGSL types EVERY shift amount as u32 regardless of the LHS's kind.
  bitAnd(o: ReadonlyNode<K & ('i32' | 'u32')> | number): Node<K> {
    return this.bitBin('&', o) as Node<K>
  }
  bitOr(o: ReadonlyNode<K & ('i32' | 'u32')> | number): Node<K> {
    return this.bitBin('|', o) as Node<K>
  }
  bitXor(o: ReadonlyNode<K & ('i32' | 'u32')> | number): Node<K> {
    return this.bitBin('^', o) as Node<K>
  }
  shl(o: ReadonlyNode<'u32'> | number): Node<K> {
    return this.bitBin('<<', o) as Node<K>
  }
  shr(o: ReadonlyNode<'u32'> | number): Node<K> {
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

/** The write-capable node: every value-producing method/builtin and `Var()`'s auto-var value
 *  bindings return this subtype, which adds the one lvalue-mutation method `.assign()` over the
 *  read-only {@link ReadonlyNode} base. See the design note directly above for why the read/write
 *  split exists and how it turns "assigning to a `Let`" into a `tsc` error instead of a runtime one.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 */
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
  // Neither WGSL nor GLSL has an Infinity/NaN literal, so a non-finite value here
  // (a host-side 1/0, an uninitialised NaN) would bake the JS spelling verbatim
  // into the module and die at the GPU compiler with no line back to the
  // authoring site — fail loud at construction instead.
  if (!Number.isFinite(v)) {
    throw new TypeError(
      `shader-dsl: ${fn}(${v}) — a shader literal must be finite (no Infinity/NaN spelling exists on either target); clamp or guard the host-side value first`,
    )
  }
  return v
}
/** An f32 literal node — the type most bare-number operands auto-lift to (`x.add(1)` emits
 *  `+ 1.0` for an f32 `x`), so reach for this explicitly only where a standalone f32 value is
 *  needed outside an operand position (a module-level `const`, a default argument).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @throws {TypeError} `v` is not a JS number — a common slip is passing a Node when you meant
 *    to CONVERT one; use {@link toF32} for that instead.
 *
 *  @example
 *  ```ts
 *  import { f32 } from '@xgis/shader-dsl'
 *
 *  const half = f32(0.5)  // Node<'f32'>
 *  ```
 */
export const f32 = (v: number): Node<'f32'> =>
  new Node<'f32'>({ op: 'lit', type: f32T, value: litNum(v, 'f32') })
/** An i32 literal node. Prefer this over the f32 default wherever a value must type-check as a
 *  signed integer — array/loop indices, `matchExpr`/`matchEnum` scrutinees, texture layer args.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @throws {TypeError} `v` is not a JS number — a common slip is passing a Node when you meant
 *    to CONVERT one; use {@link toI32} for that instead.
 *
 *  @example
 *  ```ts
 *  import { i32 } from '@xgis/shader-dsl'
 *
 *  const zero = i32(0)  // Node<'i32'>
 *  ```
 */
export const i32 = (v: number): Node<'i32'> =>
  new Node<'i32'>({ op: 'lit', type: i32T, value: litNum(v, 'i32') })
/** A u32 literal node. Prefer this over the f32 default wherever WGSL demands an unsigned
 *  scalar — buffer strides, vertex/instance indices, bit-flag masks used with `.bitAnd`/`.bitOr`.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @throws {TypeError} `v` is not a JS number — a common slip is passing a Node when you meant
 *    to CONVERT one; use {@link toU32} for that instead.
 *
 *  @example
 *  ```ts
 *  import { u32 } from '@xgis/shader-dsl'
 *
 *  const flags = u32(4)  // Node<'u32'>
 *  ```
 */
export const u32 = (v: number): Node<'u32'> =>
  new Node<'u32'>({ op: 'lit', type: u32T, value: litNum(v, 'u32') })
/** An f64 (emulated double) literal. The lit carries the FULL JS-double value —
 *  the fp64-lower pass splits it into (hi, lo) f32 halves at build time, so the
 *  authored constant round-trips losslessly (JS numbers ARE f64). */
export const f64 = (v: number): Node<'f64'> =>
  new Node<'f64'>({ op: 'lit', type: f64T, value: litNum(v, 'f64') })
/** A bool literal node — the scrutinee/condition type for `.select()`, `select()`, and
 *  control-flow guards (`If`/`While`). Only a JS boolean is accepted; the guard makes a stray
 *  `bool(someNode)` fail loudly at the call site instead of coercing to a truthy `true`.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @throws {TypeError} `v` is not a JS boolean.
 *
 *  @example
 *  ```ts
 *  import { bool } from '@xgis/shader-dsl'
 *
 *  const flag = bool(true)  // Node<'bool'>
 *  ```
 */
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

/** A read of a HOST-PROVIDED global (#1713) — the READ side of an `externVar(...)`
 *  declarator, and the variable twin of an `externFn` call. Read-only: the host owns the
 *  value, so assigning to it from here would be a lie about who writes it. Opaque to the
 *  optimizer by its own `op`, same discipline as `overrideRef` — its value is not known at
 *  module-build time, so no fold or dead-branch pass may collapse a branch it guards.
 *  The authoring surface is `externVar` (ir/builder.ts). */
export function externRef<T extends ShaderType>(name: string, type: T): ReadonlyNode<KeyOf<T>> {
  return new Node<KeyOf<T>>({ op: 'externref', type, name })
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

// ── Builtin key DOMAINS ──
//
// Every builtin's key parameter is bounded to the keys its WGSL/GLSL spec
// domain (and, for f64, the df64 whitelist) actually admits — `K extends
// string` used to admit bool/texture/struct keys, so `sinh(someBool)`
// type-checked and died at naga (#763 X6/X7's key-class discipline, applied
// to the free-function builtins).

/** The f32-family keys — `'f32'` and the f32 vectors: the argument domain of the
 *  FLOAT-ONLY component-wise builtins (`sin`, `exp`, `saturate`, the hyperbolics, …).
 *  WGSL and GLSL ES 3.00 type those builtins over floats only, so an i32/u32/bool-keyed
 *  node is rejected at `tsc` instead of compiling here and dying at the GPU compiler.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type FloatKey = 'f32' | `vec${number}<f32>`
/** The emulated-double keys — `'f64'` and the f64 vectors. Only the df64-WHITELISTED
 *  builtins accept them (`abs`/`floor`/`fract`/`sin`/`cos`/`min`/`max`/`mix`, vector
 *  `normalize`, scalar `sqrt` — the set `fp64Lower` can lower); every other builtin
 *  bounds its key to {@link FloatKey}, turning what used to be the emit-time SD0041
 *  into a `tsc` error at the authoring site.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type Float64Key = 'f64' | `vec${number}<f64>`
/** The integer keys — i32/u32 scalars and vectors — for the builtins whose WGSL/GLSL
 *  domain genuinely includes integers: `abs`, `min`/`max`, `clamp` (and `sign`, which
 *  both specs type over floats and SIGNED ints only — no u32).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type IntKey = 'i32' | 'u32' | `vec${number}<i32>` | `vec${number}<u32>`

const elemScalarType = (t: ShaderType): ShaderType =>
  isVec(t) ? { kind: 'scalar', scalar: t.elem } : t

const call = (fn: string, type: ShaderType, ...args: NodeLike[]): Node =>
  new Node({ op: 'call', type, fn, args: args.map((a) => lift(a).expr) })

// genType1: component-wise unary builtin — preserves the operand key. `A` is the
// fn's key DOMAIN (see the aliases above): float-only by default, widened per fn
// where the spec (ints) or the df64 whitelist (f64) admits more.
const genType1 =
  <A extends string = FloatKey>(fn: string) =>
  <K extends A>(x: ReadonlyNode<K>): Node<K> =>
    call(fn, x.type, x) as Node<K>

/** `sin(x)` — sine of `x` (radians), component-wise. Identical spelling on WGSL and GLSL ES 3.00,
 *  so it passes straight through the intrinsic registry unchanged.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, sin, f32T } from '@xgis/shader-dsl'
 *
 *  const wave = fn('wave', { t: f32T }, ({ t }) => sin(t))
 *  ```
 */
export const sin = genType1<FloatKey | Float64Key>('sin')
/** `cos(x)` — cosine of `x` (radians), component-wise. Identical spelling on WGSL and GLSL ES 3.00.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, cos, f32T } from '@xgis/shader-dsl'
 *
 *  const wave = fn('wave', { t: f32T }, ({ t }) => cos(t))
 *  ```
 */
export const cos = genType1<FloatKey | Float64Key>('cos')
/** `tan(x)` — tangent of `x` (radians), component-wise. Identical spelling on WGSL and GLSL ES 3.00.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, tan, f32T } from '@xgis/shader-dsl'
 *
 *  const slope = fn('slope', { angle: f32T }, ({ angle }) => tan(angle))
 *  ```
 */
export const tan = genType1('tan')
/** `asin(x)` — arcsine of `x`, returning radians in `[-π/2, π/2]`, component-wise. `x` outside
 *  `[-1, 1]` is undefined per the WGSL/GLSL spec (NaN on most drivers) — clamp upstream if the
 *  input can drift outside that domain by rounding (as e.g. `unproject-dsl.ts` does before this call).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, asin, clamp, f32T } from '@xgis/shader-dsl'
 *
 *  const lat = fn('lat', { sinLat: f32T }, ({ sinLat }) => asin(clamp(sinLat, -1, 1)))
 *  ```
 */
export const asin = genType1('asin')
/** `acos(x)` — arccosine of `x`, returning radians in `[0, π]`, component-wise. Like {@link asin},
 *  undefined outside `x ∈ [-1, 1]` — the codebase's own call sites `clamp` the argument first
 *  (e.g. great-circle distance in `projections.ts`, where float error can push `cos_c` a hair past ±1).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, acos, clamp, f32T } from '@xgis/shader-dsl'
 *
 *  const angle = fn('angle', { cosTheta: f32T }, ({ cosTheta }) => acos(clamp(cosTheta, -1, 1)))
 *  ```
 */
export const acos = genType1('acos')
/** `atan(x)` — single-argument arctangent, returning radians in `(-π/2, π/2)`, component-wise.
 *  Only covers two quadrants; use {@link atan2} for the full-quadrant two-argument form (e.g.
 *  recovering an angle from a `(y, x)` pair without losing the sign information a plain ratio drops).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, atan, exp, f32T } from '@xgis/shader-dsl'
 *
 *  // Web-Mercator inverse latitude uses atan(exp(y)) — see raster.ts's tile-edge unprojection.
 *  const gudermannian = fn('gud', { y: f32T }, ({ y }) => atan(exp(y)))
 *  ```
 */
export const atan = genType1('atan')
/** `exp(x)` — eˣ, component-wise (the natural-base partner of {@link exp2}, which is base-2).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, exp, f32T } from '@xgis/shader-dsl'
 *
 *  const decay = fn('decay', { t: f32T }, ({ t }) => exp(t.mul(-1)))
 *  ```
 */
export const exp = genType1('exp')
/** `log(x)` — natural logarithm, component-wise (the natural-base partner of {@link log2}).
 *  `x <= 0` is undefined per spec; the codebase's own call sites guard the argument with a `max`
 *  floor (e.g. `log(EARTH_R.div(max(tileExtentM, f32(1))))` in `line.ts`'s LOD-depth factor).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, log, max, f32, f32T } from '@xgis/shader-dsl'
 *
 *  const decayRate = fn('decayRate', { x: f32T }, ({ x }) => log(max(x, f32(1e-6))))
 *  ```
 */
export const log = genType1('log')
/** `log2(x)` — base-2 logarithm, component-wise (the base-2 partner of {@link exp2}; `log` is
 *  the natural-base sibling). Used e.g. for the log-depth factor `1 / log2(cam_far + 1)`.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, log2, f32T } from '@xgis/shader-dsl'
 *
 *  const bits = fn('bits', { x: f32T }, ({ x }) => log2(x))
 *  ```
 */
export const log2 = genType1('log2')
/** `floor(x)` — round toward −∞, component-wise (the partner of {@link ceil}; see {@link trunc}
 *  and {@link round} for the other two rounding directions). `x.sub(floor(x))` is exactly what
 *  {@link fract} computes in one call.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, floor, f32T } from '@xgis/shader-dsl'
 *
 *  const cell = fn('cell', { x: f32T }, ({ x }) => floor(x))
 *  ```
 */
export const floor = genType1<FloatKey | Float64Key>('floor')
/** `ceil(x)` — round toward +∞, component-wise (the partner of {@link floor}).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, ceil, f32T } from '@xgis/shader-dsl'
 *
 *  const steps = fn('steps', { x: f32T }, ({ x }) => ceil(x))
 *  ```
 */
export const ceil = genType1('ceil')
/** `abs(x)` — absolute value, component-wise.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, abs, f32T } from '@xgis/shader-dsl'
 *
 *  const magnitude = fn('magnitude', { x: f32T }, ({ x }) => abs(x))
 *  ```
 */
export const abs = genType1<FloatKey | Float64Key | IntKey>('abs')
/** `sqrt(x)` — square root, component-wise. `x < 0` is undefined per spec. Prefer
 *  {@link inverseSqrt} over `f32(1).div(sqrt(x))` when only 1/√x is needed — one call
 *  instead of a sqrt-then-divide.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, sqrt, f32T } from '@xgis/shader-dsl'
 *
 *  const dist = fn('dist', { sq: f32T }, ({ sq }) => sqrt(sq))
 *  ```
 */
export const sqrt = genType1<FloatKey | 'f64'>('sqrt')
/** `fract(x)` — fractional part, `x − floor(x)`, component-wise. The building block for
 *  domain-repeat (tiling a coordinate into `[0,1)`) and hash-style noise — e.g. `flow-advect.ts`'s
 *  `fract(dot(p3, p3.yzx + 33.33))` pseudo-random field.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, fract, f32T } from '@xgis/shader-dsl'
 *
 *  const tile = fn('tile', { x: f32T }, ({ x }) => fract(x))
 *  ```
 */
export const fract = genType1<FloatKey | Float64Key>('fract')
/** `radians(deg)` / `degrees(rad)` — WGSL built-ins (exact π/180), replacing a `*`/`/` by a rounded
 *  DEG2RAD constant. `x.mul(DEG2RAD)` → `radians(x)`, `x.div(DEG2RAD)` → `degrees(x)`. */
export const radians = genType1('radians')
/** `degrees(rad)` — radians→degrees, component-wise; the built-in inverse of {@link radians}
 *  (see that entry for the exact-π/180 rationale over a hand-rolled `.mul(RAD2DEG)`).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, degrees, f32T } from '@xgis/shader-dsl'
 *
 *  const latDeg = fn('latDeg', { latRad: f32T }, ({ latRad }) => degrees(latRad))
 *  ```
 */
export const degrees = genType1('degrees')
/** `sign(x)` — `-1`/`0`/`1` per component, according to the sign of `x`.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, sign, f32T } from '@xgis/shader-dsl'
 *
 *  const dir = fn('dir', { x: f32T }, ({ x }) => sign(x))
 *  ```
 */
export const sign = genType1<FloatKey | 'i32' | `vec${number}<i32>`>('sign')
/** `exp2(x)` — 2ˣ, component-wise (the base-2 partner of the existing `log2`). */
export const exp2 = genType1('exp2')
/** `trunc(x)` — round toward zero, component-wise. */
export const trunc = genType1('trunc')
/** `round(x)` — nearest integer, ties to even on BOTH targets (NOT JS `Math.round`,
 *  which rounds halves toward +∞). WGSL `round` guarantees ties-to-even; GLSL ES
 *  3.00's own `round` leaves exact halves implementation-chosen, so the registry
 *  spells the GLSL side `roundEven` (see core/intrinsics.ts) to pin the same
 *  semantics there. */
export const round = genType1('round')
/** `inverseSqrt(x)` — 1/√x, component-wise. Neutral id: GLSL spells it
 *  `inversesqrt` (see core/intrinsics.ts); WGSL keeps `inverseSqrt`. */
export const inverseSqrt = genType1('inverseSqrt')
/** `sinh(x)` — hyperbolic sine, component-wise. Identical spelling on WGSL and GLSL ES 3.00.
 *  The inverse-Mercator latitude is `atan(sinh(y))` — one transcendental fewer, and better
 *  conditioned near y = 0, than the `2·atan(exp(y)) − π/2` Gudermannian it replaces.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, atan, sinh, f32T } from '@xgis/shader-dsl'
 *
 *  const invMercLat = fn('invMercLat', { y: f32T }, ({ y }) => atan(sinh(y)))
 *  ```
 */
export const sinh = genType1('sinh')
/** `cosh(x)` — hyperbolic cosine, component-wise; the even partner of {@link sinh}
 *  (`cosh²x − sinh²x = 1`). Identical spelling on WGSL and GLSL ES 3.00. */
export const cosh = genType1('cosh')
/** `tanh(x)` — hyperbolic tangent, component-wise; `sinh(x)/cosh(x)`, saturating to ±1 as
 *  `x → ±∞` (the classic smooth soft-clamp). Identical spelling on WGSL and GLSL ES 3.00. */
export const tanh = genType1('tanh')
/** `asinh(x)` — inverse hyperbolic sine, component-wise; defined over all reals.
 *  The forward-Mercator latitude term IS this function: `asinh(tan(φ))` is exactly
 *  `log(tan(π/4 + φ/2))` with one transcendental fewer and no π/4 constant to truncate.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, asinh, tan, f32T } from '@xgis/shader-dsl'
 *
 *  const mercY = fn('mercY', { latRad: f32T }, ({ latRad }) => asinh(tan(latRad)))
 *  ```
 */
export const asinh = genType1('asinh')
/** `acosh(x)` — inverse hyperbolic cosine, component-wise. `x < 1` is undefined per the
 *  WGSL/GLSL spec (NaN on most drivers) — guard with `max(x, f32(1))` when rounding can
 *  push an in-domain operand under 1, the same discipline as {@link asin}/{@link acos}. */
export const acosh = genType1('acosh')
/** `atanh(x)` — inverse hyperbolic tangent, component-wise. `|x| >= 1` is undefined per
 *  the WGSL/GLSL spec (±∞/NaN) — clamp strictly inside `(-1, 1)` when the operand can
 *  reach the boundary by rounding, the same discipline as {@link asin}/{@link acos}. */
export const atanh = genType1('atanh')
/** `saturate(x)` — `clamp(x, 0, 1)`, component-wise: the standard normalized-range clamp
 *  (colour channels, interpolation factors, coverage). WGSL emits its dedicated `saturate`
 *  builtin; GLSL ES 3.00 has none, so the registry inlines the defining `clamp(x, 0.0, 1.0)`
 *  there (see core/intrinsics.ts) — identical semantics per both specs.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, saturate, f32T } from '@xgis/shader-dsl'
 *
 *  const alpha = fn('alpha', { fade: f32T }, ({ fade }) => saturate(fade))
 *  ```
 */
export const saturate = genType1('saturate')

/** `atan2(y, x)` — two-argument arctangent, resolving the FULL angle `[-π, π]` from a `(y, x)`
 *  pair — the form to reach for over single-argument {@link atan} whenever `x`'s sign carries
 *  quadrant information (recovering a bearing/heading from a 2-D offset, polar unprojection).
 *  Spelled `atan2` on WGSL; the GLSL registry entry maps it to GLSL's two-argument `atan(y, x)`.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, atan2, f32T } from '@xgis/shader-dsl'
 *
 *  const heading = fn('heading', { dy: f32T, dx: f32T }, ({ dy, dx }) => atan2(dy, dx))
 *  ```
 */
export const atan2 = <K extends FloatKey>(y: ReadonlyNode<K>, x: NoInfer<ArithArg<K>>): Node<K> =>
  call('atan2', y.type, y, x) as Node<K>
/** `min(a, b)` — component-wise minimum. `b` may be a scalar broadcast against a vector `a`
 *  (same vec∘scalar rule as the arithmetic methods), so `min(color, 1)` clamps every channel
 *  against one literal without unrolling per component.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, min, f32T } from '@xgis/shader-dsl'
 *
 *  const capped = fn('capped', { x: f32T }, ({ x }) => min(x, 1))
 *  ```
 */
export const min = <K extends FloatKey | Float64Key | IntKey>(
  a: ReadonlyNode<K>,
  b: NoInfer<ArithArg<K>>,
): Node<K> => call('min', binResultType(a.type, lift(b).type, 'min'), a, b) as Node<K>
/** `max(a, b)` — component-wise maximum, the partner of {@link min}. `b` may be a scalar
 *  broadcast against a vector `a`. A common floor-guard idiom: `max(x, f32(1e-6))` to keep a
 *  divisor or `sqrt`/`log` argument off zero without an explicit branch.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, max, f32, f32T } from '@xgis/shader-dsl'
 *
 *  const safe = fn('safe', { x: f32T }, ({ x }) => max(x, f32(1e-6)))
 *  ```
 */
export const max = <K extends FloatKey | Float64Key | IntKey>(
  a: ReadonlyNode<K>,
  b: NoInfer<ArithArg<K>>,
): Node<K> => call('max', binResultType(a.type, lift(b).type, 'max'), a, b) as Node<K>
/** `pow(a, b)` — same-type binary; second operand promotes via ArithArg so
 *  `pow(z, 4)` emits `pow(z, 4.0)` for an f32 base. WGSL pow only accepts
 *  matching scalar/vec floats, so a vec*scalar broadcast is structurally
 *  rejected by WGSL even when the type system would allow it — we keep
 *  binResultType for parity with `min` / `max`. */
export const pow = <K extends FloatKey>(a: ReadonlyNode<K>, b: NoInfer<ArithArg<K>>): Node<K> =>
  call('pow', binResultType(a.type, lift(b).type, 'pow'), a, b) as Node<K>
/** `mod(x, y)` — FLOOR-mod (x − y·⌊x/y⌋) with identical semantics on both
 *  targets, matching GLSL/TSL `mod()` (#839). Float `%` (the `.mod` METHOD) is
 *  TRUNC-mod on WGSL and integer-only in GLSL ES 3.00, so this free fn is THE
 *  portable float modulo — reach for it wherever a negative operand is possible
 *  (domain repetition, angle folds). Deliberately not named `fmod`: C/HLSL
 *  `fmod` is TRUNC-mod, the opposite semantics. Component-wise; `y` may be a
 *  scalar broadcast over a vector `x`. */
export const mod = <K extends FloatKey>(x: ReadonlyNode<K>, y: NoInfer<ArithArg<K>>): Node<K> =>
  call('mod', binResultType(x.type, lift(y).type, 'mod'), x, y) as Node<K>
/** `clamp(x, lo, hi)` — restricts `x` to `[lo, hi]`, component-wise. `lo`/`hi` may be scalar
 *  broadcasts against a vector `x`. The standard guard before {@link asin}/{@link acos} (whose
 *  domain is `[-1, 1]`) and before {@link smoothstep} edges, keeping float rounding from pushing
 *  an in-range value a hair past its bound.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, clamp, f32T } from '@xgis/shader-dsl'
 *
 *  const norm = fn('norm', { x: f32T }, ({ x }) => clamp(x, 0, 1))
 *  ```
 */
export const clamp = <K extends FloatKey | IntKey>(
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
export const fma = <K extends FloatKey>(
  a: ReadonlyNode<K>,
  b: NoInfer<ArithArg<K>>,
  c: NoInfer<ArithArg<K>>,
): Node<K> => call('fma', a.type, a, b, c) as Node<K>
/** `mix(a, b, t)` — linear interpolation `a + t·(b − a)`, component-wise, keyed by `a`. `t`
 *  outside `[0, 1]` extrapolates rather than clamping — pair with {@link clamp} or
 *  {@link smoothstep} on `t` when the caller must stay within the `a..b` range.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, mix, vec3, f32T } from '@xgis/shader-dsl'
 *
 *  const blend = fn('blend', { t: f32T }, ({ t }) => mix(vec3(0, 0, 0), vec3(1, 1, 1), t))
 *  ```
 */
export const mix = <K extends FloatKey | Float64Key>(
  a: ReadonlyNode<K>,
  b: NoInfer<ArithArg<K>>,
  t: ReadonlyNode<'f32'> | number,
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
  e0: ReadonlyNode<'f32'> | number,
  e1: ReadonlyNode<'f32'> | number,
  x: ReadonlyNode<'f32'> | number,
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
export const step = <K extends FloatKey>(edge: NoInfer<ArithArg<K>>, x: ReadonlyNode<K>): Node<K> =>
  call('step', x.type, edge, x) as Node<K>
// K-constrained like `cross` (#763 X7) — dot(v2, v3) used to COMPILE and die at
// naga; the shared K pins both operands to one float-vector key.
/** `length(v)` — Euclidean vector magnitude, `|v|`. The return precision tracks the operand: an
 *  f32 vector (vec2/3/4) returns f32, and an emulated-double `vec${N}<f64>` returns f64 — the
 *  overload picks the right key so `length(deepZoomOffset)` stays f64 without an explicit cast.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *
 *  @example
 *  ```ts
 *  import { fn, length, vec2, f32T } from '@xgis/shader-dsl'
 *
 *  const mag = fn('mag', { x: f32T, y: f32T }, ({ x, y }) => length(vec2(x, y)))
 *  ```
 */
export function length<K extends `vec${number}<f64>`>(v: ReadonlyNode<K>): Node<'f64'>
export function length<K extends `vec${number}<f32>`>(v: ReadonlyNode<K>): Node<'f32'>
export function length(v: ReadonlyNode<string>): Node<string> {
  return call('length', isVec64(v.type) ? f64T : f32T, v)
}
/** `dot(a, b)` — dot product, vector → scalar. Like {@link length}, the return precision tracks
 *  the operand key: f32 vectors return f32, emulated-double `vec${N}<f64>` vectors return f64.
 *  `K` is SHARED between `a` and `b` (unlike the generic `.mul`), so `dot(v2, v3)` is a `tsc`
 *  error instead of compiling and dying at the backend (#763 X7).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *
 *  @example
 *  ```ts
 *  import { fn, dot, vec3, f32T } from '@xgis/shader-dsl'
 *
 *  const luma = fn('luma', { x: f32T }, ({ x }) => dot(vec3(x, x, x), vec3(0.2, 0.7, 0.1)))
 *  ```
 */
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
/** `normalize(v)` — v/|v|; preserves the vector key (vec2/3/4). VECTOR keys only —
 *  WGSL/GLSL define normalize over vectors, so a scalar operand is a `tsc` error. */
export const normalize = genType1<`vec${number}<f32>` | `vec${number}<f64>`>('normalize')
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
/** Pack a vec2<f32> into a u32 as two IEEE-754 binary16 (half) values — component 0 in the
 *  16 LOW bits. NATIVE on both targets (WGSL `pack2x16float`, GLSL ES 3.00 `packHalf2x16`);
 *  values outside binary16's finite range (|x| > 65504) overflow to ±∞ per IEEE conversion.
 *  The compact carrier for height/offset pairs where 8-bit unorm quantisation is too coarse
 *  but full f32 lanes are too wide; {@link unpack2x16float} restores the (rounded) pair.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, pack2x16float, vec2fT } from '@xgis/shader-dsl'
 *
 *  const packed = fn('packed', { hv: vec2fT }, ({ hv }) => pack2x16float(hv))
 *  ```
 */
export const pack2x16float = (v: ReadonlyNode<'vec2<f32>'>): Node<'u32'> =>
  call('pack2x16float', u32T, v) as Node<'u32'>
/** Unpack a u32 into a vec2<f32> of two binary16 (half) values — the exact inverse of
 *  {@link pack2x16float} (every binary16 value is exactly representable in f32). Component 0
 *  comes from the 16 LOW bits. Spelled `unpackHalf2x16` on GLSL ES 3.00. */
export const unpack2x16float = (v: ReadonlyNode<'u32'>): Node<'vec2<f32>'> =>
  call('unpack2x16float', vec2fT, v) as Node<'vec2<f32>'>
/** Pack a vec2<f32> (each component in [0,1]) into a u32 as two 16-bit unorm lanes —
 *  `⌊0.5 + 65535·clamp(x, 0, 1)⌋` per component, component 0 in the 16 LOW bits. The
 *  16-bit precision step up from {@link pack4x8unorm}'s 8-bit channels (ramp coordinates,
 *  normalized heights). Spelled `packUnorm2x16` on GLSL ES 3.00. */
export const pack2x16unorm = (v: ReadonlyNode<'vec2<f32>'>): Node<'u32'> =>
  call('pack2x16unorm', u32T, v) as Node<'u32'>
/** Unpack a u32 of two 16-bit unorm lanes into a vec2<f32> in [0,1] (`v/65535` per lane) —
 *  the inverse of {@link pack2x16unorm}. Spelled `unpackUnorm2x16` on GLSL ES 3.00. */
export const unpack2x16unorm = (v: ReadonlyNode<'u32'>): Node<'vec2<f32>'> =>
  call('unpack2x16unorm', vec2fT, v) as Node<'vec2<f32>'>
/** Pack a vec2<f32> (each component in [-1,1]) into a u32 as two 16-bit snorm lanes —
 *  `⌊0.5 + 32767·clamp(x, -1, 1)⌋` per component in two's complement, component 0 in the
 *  16 LOW bits (signed normals, direction fields). Spelled `packSnorm2x16` on GLSL ES 3.00. */
export const pack2x16snorm = (v: ReadonlyNode<'vec2<f32>'>): Node<'u32'> =>
  call('pack2x16snorm', u32T, v) as Node<'u32'>
/** Unpack a u32 of two 16-bit snorm lanes into a vec2<f32> in [-1,1] (`max(v/32767, -1)`
 *  per lane) — the inverse of {@link pack2x16snorm}. Spelled `unpackSnorm2x16` on GLSL ES 3.00. */
export const unpack2x16snorm = (v: ReadonlyNode<'u32'>): Node<'vec2<f32>'> =>
  call('unpack2x16snorm', vec2fT, v) as Node<'vec2<f32>'>
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
/** An array-layer argument (#1651). A `number` becomes an i32 LITERAL, not the f32
 *  one `lift()` defaults to: WGSL's array_index takes i32/u32, and `0.0` there is a
 *  type error (GLSL wraps the value in float() either way). A FRACTIONAL number is
 *  rejected here (SD0015): `i32(1.5)` would emit `1.5` as an i32 literal — a naga
 *  compile error on WGSL but a silent round-to-nearest on GLSL (1.5 reads layer 2)
 *  — so the guard keeps the two backends from diverging. */
const layerArg = (l: ReadonlyNode<'i32' | 'u32'> | number): NodeLike => {
  if (typeof l === 'number') {
    if (!Number.isInteger(l)) throw dslError('SD0015', `layer ${l}`)
    return i32(l)
  }
  return l
}
/** A textureLoad MIP-LEVEL (or MSAA sample-index) argument — layerArg's twin, and for
 *  the same reason (#1703). WGSL's `textureLoad` takes an INTEGER level, but `lift()`
 *  defaults a bare number to f32, so the `textureLoad(t, c, 0)` this function's own doc
 *  recommends emitted `textureLoad(t, c, 0.0)` — which naga REJECTS. It went unnoticed
 *  because every in-repo caller writes `u32(0)` by hand and because GLSL's spelling
 *  wraps the argument in `int(…)`, which quietly absorbed the float. An integer texture
 *  has no sampling form at all, so textureLoad is its ONLY read and every author of one
 *  would have hit this on their first line.
 *
 *  NOT the same as textureSampleLevel's level, which really is an f32 in WGSL and
 *  keeps the default lift. A fractional number is rejected for layerArg's reason: the
 *  targets would not agree on how to round it. */
const levelArg = (l: NodeLike): NodeLike => {
  if (typeof l === 'number') {
    if (!Number.isInteger(l)) throw dslError('SD0015', `mip level ${l}`)
    return u32(l)
  }
  return l
}
/** Sample a 2D texture → vec4<f32>. (CPU eval: opt-in stub.) First-arg
 *  constraints (#763 X6): a texture/sampler swap used to type-check and die
 *  at naga — KeyOf now carries specific texture/sampler keys.
 *
 *  FRAGMENT-ONLY in WGSL: the implicit LOD comes from screen-space derivatives,
 *  which exist only in a fragment invocation. Enforced by the
 *  `fragment-only-builtin` lint rule (a CORE rule — it fires at every emit); use
 *  {@link textureSampleLevel} in a vertex or compute stage. */
export function textureSample(
  tex: ReadonlyNode<'texture_2d<f32>'>,
  smp: ReadonlyNode<'sampler'>,
  uv: ReadonlyNode<'vec2<f32>'>,
): Node<'vec4<f32>'>
/** Sample one LAYER of a 2D ARRAY texture → vec4<f32> (#1651). The layer is an
 *  ARGUMENT, not a binding, so an N-layer atlas costs one binding slot; a `number`
 *  layer lifts to an i32 literal. Carries the DISTINCT neutral id
 *  `textureSampleArray` — WGSL appends the layer to `textureSample`, GLSL folds it
 *  into the coordinate (`texture(t, vec3(uv, float(layer)))`), so the two targets
 *  RESTRUCTURE the arguments rather than merely adding one.
 *
 *  FRAGMENT-ONLY in WGSL, like its non-array twin (the implicit LOD comes from
 *  screen-space derivatives) — enforced by the `fragment-only-builtin` lint rule;
 *  use {@link textureSampleLevel}'s array form in a vertex or compute stage. */
export function textureSample(
  tex: ReadonlyNode<'texture_2d_array<f32>'>,
  smp: ReadonlyNode<'sampler'>,
  uv: ReadonlyNode<'vec2<f32>'>,
  layer: ReadonlyNode<'i32' | 'u32'> | number,
): Node<'vec4<f32>'>
export function textureSample(
  tex: ReadonlyNode<'texture_2d<f32>'> | ReadonlyNode<'texture_2d_array<f32>'>,
  smp: ReadonlyNode<'sampler'>,
  uv: ReadonlyNode<'vec2<f32>'>,
  layer?: ReadonlyNode<'i32' | 'u32'> | number,
): Node<'vec4<f32>'> {
  return (
    layer === undefined
      ? call('textureSample', vec4fT, tex, smp, uv)
      : call('textureSampleArray', vec4fT, tex, smp, uv, layerArg(layer))
  ) as Node<'vec4<f32>'>
}
/** Sample a 2D texture at an EXPLICIT mip level → vec4<f32>. Legal in ALL stages
 *  (it needs no derivatives), so it is the vertex/compute-stage alternative to
 *  {@link textureSample} — e.g. a displacement map read in a vertex shader. A
 *  number `level` lifts to an f32 literal. Spelled `textureSampleLevel(t,s,uv,l)`
 *  on WGSL and `textureLod(t, uv, l)` on GLSL (the sampler fuses away).
 *  (CPU eval: opt-in stub.) */
export function textureSampleLevel(
  tex: ReadonlyNode<'texture_2d<f32>'>,
  smp: ReadonlyNode<'sampler'>,
  uv: ReadonlyNode<'vec2<f32>'>,
  level: ReadonlyNode<'f32'> | number,
): Node<'vec4<f32>'>
/** Explicit-LOD read of one LAYER of a 2D ARRAY texture → vec4<f32> (#1651).
 *  Legal in ALL stages — the any-stage alternative to the fragment-only array
 *  {@link textureSample}. Neutral id `textureSampleLevelArray`. */
export function textureSampleLevel(
  tex: ReadonlyNode<'texture_2d_array<f32>'>,
  smp: ReadonlyNode<'sampler'>,
  uv: ReadonlyNode<'vec2<f32>'>,
  layer: ReadonlyNode<'i32' | 'u32'> | number,
  level: ReadonlyNode<'f32'> | number,
): Node<'vec4<f32>'>
export function textureSampleLevel(
  tex: ReadonlyNode<'texture_2d<f32>'> | ReadonlyNode<'texture_2d_array<f32>'>,
  smp: ReadonlyNode<'sampler'>,
  uv: ReadonlyNode<'vec2<f32>'>,
  levelOrLayer: ReadonlyNode<'f32'> | ReadonlyNode<'i32' | 'u32'> | number,
  level?: ReadonlyNode<'f32'> | number,
): Node<'vec4<f32>'> {
  return (
    level === undefined
      ? call('textureSampleLevel', vec4fT, tex, smp, uv, levelOrLayer as NodeLike)
      : call(
          'textureSampleLevelArray',
          vec4fT,
          tex,
          smp,
          uv,
          layerArg(levelOrLayer as ReadonlyNode<'i32' | 'u32'> | number),
          level,
        )
  ) as Node<'vec4<f32>'>
}
/** Every NON-array texture key a texel load accepts — the three sampled elements
 *  (#1703) plus the multisampled f32 one. */
export type TextureLoad2dKey =
  'texture_2d<f32>' | 'texture_2d<u32>' | 'texture_2d<i32>' | 'texture_multisampled_2d<f32>'
/** Every 2D-ARRAY texture key a texel load accepts (#1651, #1703). */
export type TextureLoadArrayKey =
  'texture_2d_array<f32>' | 'texture_2d_array<u32>' | 'texture_2d_array<i32>'
/** The `vec4<…>` a texel load off texture key `K` yields (#1703). The loaded element
 *  IS the element in the key, so ONE conditional covers all seven texture keys and the
 *  overload set does not multiply along the element axis. Deriving it from the key also
 *  makes the two halves impossible to desync: a `vec4<f32>` result on a `usampler2D`
 *  load is rejected by naga AND by the GLSL compiler, and there is no spelling of
 *  textureLoad here that can produce that pair. */
export type TexelKey<K extends string> = K extends `${string}<${infer E}>` ? `vec4<${E}>` : never
// The IR type behind TexelKey — read off the TEXTURE NODE, never a second table, for
// the same reason. Falls through to vec4fT for a non-texture node, which the typed
// overloads make unreachable and which is byte-identical to the pre-#1703 hardcode.
const texelType = (t: ShaderType): ShaderType =>
  t.kind !== 'texture' ? vec4fT : t.elem === 'u32' ? vec4uT : t.elem === 'i32' ? vec4iT : vec4fT
/** Load a texel from a 2D texture at integer coords → `vec4<f32>` / `vec4<u32>` /
 *  `vec4<i32>`, matching the texture's own element (#1703). The mip level argument is
 *  required by WGSL; pass `0` for the base level — a bare number lifts to a u32 literal
 *  (see `levelArg`), so `0` really does emit a valid integer level on both targets.
 *  Coord is typically `vec2<i32>`; the runtime accepts any vec2 / scalar NodeLike and
 *  lets WGSL's textureLoad signature check. (CPU stub.)
 *
 *  This is the ONLY read form an INTEGER texture has — integer texels are unfilterable,
 *  so {@link textureSample}/{@link textureSampleLevel} reject those keys at tsc (see
 *  `TextureElem`). */
export function textureLoad<K extends TextureLoad2dKey>(
  tex: ReadonlyNode<K>,
  coord: NodeLike,
  level: NodeLike,
): Node<TexelKey<K>>
/** Load a texel from one LAYER of a 2D ARRAY texture (#1651) — unfiltered, so the
 *  layer/level are exact. GLSL folds the layer into an `ivec3` coordinate; WGSL keeps
 *  it as its own argument. Neutral id `textureLoadArray`. Integer elements (#1703)
 *  ride the same id — only the result type differs. */
export function textureLoad<K extends TextureLoadArrayKey>(
  tex: ReadonlyNode<K>,
  coord: NodeLike,
  layer: ReadonlyNode<'i32' | 'u32'> | number,
  level: NodeLike,
): Node<TexelKey<K>>
export function textureLoad(
  tex: ReadonlyNode<TextureLoad2dKey> | ReadonlyNode<TextureLoadArrayKey>,
  coord: NodeLike,
  layerOrLevel: ReadonlyNode<'i32' | 'u32'> | NodeLike,
  level?: NodeLike,
): Node<string> {
  const ret = texelType(tex.type)
  return (
    level === undefined
      ? call('textureLoad', ret, tex, coord, levelArg(layerOrLevel as NodeLike))
      : call(
          'textureLoadArray',
          ret,
          tex,
          coord,
          layerArg(layerOrLevel as ReadonlyNode<'i32' | 'u32'> | number),
          levelArg(level),
        )
  ) as Node<string>
}
/** INTERNAL (core/fp64/df64-lib.ts): the fp64 anti-fast-math guard value — a
 *  runtime-opaque 1.0. Spelled per target as a texel fetch from the injected
 *  `_fp64` texture (intrinsics.ts `f64Guard`); the CPU oracle evaluates it as
 *  exactly 1. Not part of the authoring surface. */
export const f64GuardOne = (): Node<'f32'> =>
  call('f64Guard', { kind: 'scalar', scalar: 'f32' }) as Node<'f32'>
/** Texture extent in texels → vec2<u32>. Cost: one query per fragment in
 *  fullscreen-triangle compose passes; cached in a `let` by the caller.
 *  A 2d-array texture (#1651) uses the SAME id: WGSL returns vec2<u32> for arrays
 *  too (the layer count is a separate query), and GLSL's ivec3 textureSize truncates
 *  into the emitted uvec2() — see the registry entry. An INTEGER texture (#1703) is
 *  the same again: the extent of a `usampler2D` is still an extent, so the id, the
 *  spelling, and the `vec2<u32>` result are all unchanged — only the accepted keys
 *  widen. */
export const textureDimensions = (
  tex: ReadonlyNode<TextureLoad2dKey | TextureLoadArrayKey>,
): Node<'vec2<u32>'> => call('textureDimensions', vec2uT, tex) as Node<'vec2<u32>'>
/** Layer COUNT of a 2D ARRAY texture → u32 (#1658) — the one extent
 *  {@link textureDimensions} cannot report (it returns vec2<u32> for an array texture
 *  too). ARRAY-key only: a plain 2d / multisampled texture has no layer count, so
 *  passing one is a tsc error. Carries its OWN neutral id, never an overload of
 *  textureDimensions: the targets spell it structurally differently — WGSL has the
 *  dedicated `textureNumLayers(t)`, GLSL ES 3.00 has no such function at all and reads
 *  the THIRD component of its `ivec3 textureSize(sampler2DArray, lod)` (exactly the
 *  component textureDimensions' `uvec2()` constructor drops). u32 is WGSL's return
 *  type; wrap in {@link toF32} for float arithmetic. (CPU stub.)
 *
 *  Accepts an INTEGER array texture too (#1703) — the layer COUNT is a property of the
 *  view, not of the texel element, so `usampler2DArray` reads it through the identical
 *  `uint(textureSize(t, 0).z)`. */
export const textureNumLayers = (tex: ReadonlyNode<TextureLoadArrayKey>): Node<'u32'> =>
  call('textureNumLayers', u32T, tex) as Node<'u32'>
/** Screen-space derivative magnitude — GPU-only (uncomputable per-invocation
 *  on the CPU; the interpreter stubs it to 0). FRAGMENT-ONLY in WGSL: enforced by
 *  the `fragment-only-builtin` lint rule (a CORE rule — it fires at every emit;
 *  SD0109, #1654); in a vertex or compute stage, precompute the quantity and
 *  pass it in. */
export const fwidth = genType1('fwidth')
/** Screen-space partial derivatives (#846) — GPU-only like `fwidth` (the
 *  interpreter stubs them to 0), and FRAGMENT-ONLY like it too (the same
 *  `fragment-only-builtin` CORE rule; SD0109, #1654). Divergent spelling handled
 *  by the intrinsic registry: WGSL `dpdx`/`dpdy`, GLSL ES 3.00 `dFdx`/`dFdy`. */
export const dpdx = genType1('dpdx')
/** The Y-axis partner of {@link dpdx} — same GPU-only (interpreter stubs it to 0) and
 *  FRAGMENT-ONLY constraints (see that entry). Spelled `dpdy` on WGSL, `dFdy` on GLSL ES 3.00.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, dpdy, f32T } from '@xgis/shader-dsl'
 *
 *  const dv = fn('dv', { v: f32T }, ({ v }) => dpdy(v))
 *  ```
 */
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
/** Narrow/convert to i32 — the explicit numeric CAST, as opposed to {@link i32} which builds a
 *  literal from a raw JS number. Emits `i32(x)` on WGSL and `int(x)` on GLSL (see the intrinsic
 *  registry); use this to turn a computed f32/u32 node into an integer index or scrutinee.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, toI32, f32T } from '@xgis/shader-dsl'
 *
 *  const idx = fn('idx', { u: f32T }, ({ u }) => toI32(u.mul(16)))
 *  ```
 */
export const toI32 = (x: ReadonlyNode<string> | number): Node<'i32'> =>
  call('i32', i32T, x) as Node<'i32'>
/** Narrow/convert to u32 — the explicit numeric CAST, as opposed to {@link u32} which builds a
 *  literal from a raw JS number. Emits `u32(x)` on WGSL and `uint(x)` on GLSL. Reach for this
 *  over `toI32` whenever the target context is unsigned-only (a texture layer, a buffer stride).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, toU32, f32T } from '@xgis/shader-dsl'
 *
 *  const idx = fn('idx', { anchorMode: f32T }, ({ anchorMode }) => toU32(anchorMode))
 *  ```
 */
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
/** Low-level `TypeName(args)` constructor call — the primitive {@link vec2}/{@link vec3}/…/{@link vec2f64}
 *  and a struct's `.construct({...})` all build on. Reach for this directly only when
 *  constructing a `ShaderType` those named helpers don't cover (a struct value, an emulated-double
 *  matrix column list); ordinary authoring should use the typed wrapper instead.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { construct, vec3fT } from '@xgis/shader-dsl'
 *
 *  const v = construct(vec3fT, [1, 0, 0])  // same result as vec3(1, 0, 0)
 *  ```
 */
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
      (a) =>
        (typeof a === 'number'
          ? new Node({ op: 'lit', type: elemT, value: litNum(a, 'construct') })
          : a
        ).expr,
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
/** A `vec2<f32>` constructor, WGSL-style: `vec2(x, y)`. A bare number component lifts to f32
 *  (`vec2(pos.x, 0)` emits an f32 zero, no `f32()` wrapper needed) — see {@link construct} for
 *  the untyped primitive this and every other vector/struct constructor is built on.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { vec2 } from '@xgis/shader-dsl'
 *
 *  const uv = vec2(0, 1)  // Node<'vec2<f32>'>
 *  ```
 */
export const vec2 = (...a: NodeLike[]): Node<'vec2<f32>'> =>
  construct(vec2fT, a) as Node<'vec2<f32>'>
/** A `vec3<f32>` constructor, WGSL-style: `vec3(x, y, z)`. Bare number components lift to f32.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { vec3 } from '@xgis/shader-dsl'
 *
 *  const rgb = vec3(1, 0, 0)  // Node<'vec3<f32>'>
 *  ```
 */
export const vec3 = (...a: NodeLike[]): Node<'vec3<f32>'> =>
  construct(vec3fT, a) as Node<'vec3<f32>'>
/** A `vec4<f32>` constructor, WGSL-style: `vec4(x, y, z, w)`. Bare number components lift to
 *  f32 — the common `vec4(pos, 0, 1)` clip-space pattern needs no `f32()` wrapper on the tail args.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { fn, vec2, vec4, f32T } from '@xgis/shader-dsl'
 *
 *  const clip = fn('clip', { pos: f32T }, ({ pos }) => vec4(vec2(pos, pos), 0, 1))
 *  ```
 */
export const vec4 = (...a: NodeLike[]): Node<'vec4<f32>'> =>
  construct(vec4fT, a) as Node<'vec4<f32>'>
/** A `vec2<u32>` constructor, WGSL-style: `vec2u(x, y)`. Bare number components lift to u32
 *  (not the {@link vec2} default of f32) — for unsigned pairs like a pick-buffer coordinate.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { vec2u } from '@xgis/shader-dsl'
 *
 *  const pick = vec2u(0, 0)  // Node<'vec2<u32>'>
 *  ```
 */
export const vec2u = (...a: NodeLike[]): Node<'vec2<u32>'> =>
  construct(vec2uT, a) as Node<'vec2<u32>'>
/** A `vec2<i32>` constructor, WGSL-style: `vec2i(x, y)`. Bare number components lift to i32 —
 *  the type `textureLoad`'s integer texel coordinate needs (`vec2i(toI32(...), toI32(...))`).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { vec2i, toI32, f32T, fn } from '@xgis/shader-dsl'
 *
 *  const coord = fn('coord', { u: f32T, v: f32T }, ({ u, v }) => vec2i(toI32(u), toI32(v)))
 *  ```
 */
export const vec2i = (...a: NodeLike[]): Node<'vec2<i32>'> =>
  construct(vec2iT, a) as Node<'vec2<i32>'>
// Emulated-double vector constructors. Components are f64 nodes (or bare
// numbers, split losslessly at build time); an f32 component widens exactly
// during lowering. A single argument splats, WGSL-style.
type Vec64Arg = ReadonlyNode<'f64' | 'f32'> | number
/** An emulated-double `vec2<f64>` constructor. A bare number component splits losslessly into
 *  its (hi, lo) f32 pair at BUILD time (a JS number already IS an f64), and an f32 node component
 *  widens exactly during lowering — so mixed `vec2f64(x64, 0)` args are fine. One argument splats
 *  to both lanes, WGSL-style. Use this over plain {@link vec2} wherever the value needs f64
 *  precision (deep-zoom camera-relative offsets, projection math past f32's ~7-digit precision).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { vec2f64 } from '@xgis/shader-dsl'
 *
 *  const p = vec2f64(1e8 + 0.5, 2)  // Node<'vec2<f64>'> — exact, unlike an f32 vec2
 *  ```
 */
export const vec2f64 = (...a: Vec64Arg[]): Node<'vec2<f64>'> =>
  construct(vec2f64T, a) as Node<'vec2<f64>'>
/** An emulated-double `vec3<f64>` constructor — the 3-lane sibling of {@link vec2f64}; see that
 *  entry for the splat/split/widen rules shared by every `vecNf64` constructor.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { vec3f64 } from '@xgis/shader-dsl'
 *
 *  const p = vec3f64(1e8 + 0.5, 2, 3)  // Node<'vec3<f64>'>
 *  ```
 */
export const vec3f64 = (...a: Vec64Arg[]): Node<'vec3<f64>'> =>
  construct(vec3f64T, a) as Node<'vec3<f64>'>
/** An emulated-double `vec4<f64>` constructor — the 4-lane sibling of {@link vec2f64}; see that
 *  entry for the splat/split/widen rules shared by every `vecNf64` constructor.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { vec4f64 } from '@xgis/shader-dsl'
 *
 *  const p = vec4f64(1e8 + 0.5, 2, 3, 4)  // Node<'vec4<f64>'>
 *  ```
 */
export const vec4f64 = (...a: Vec64Arg[]): Node<'vec4<f64>'> =>
  construct(vec4f64T, a) as Node<'vec4<f64>'>

// Emulated-double matrix constructors — column-major, one vecN<f64> per column
// (the same convention as WGSL `matNxN(col0, …)`). They lower to a DF64MatN
// column struct; matmul / mat·vec / transpose compose the SCALAR df64 EFTs.
type Mat64Col<N extends 2 | 3 | 4> = ReadonlyNode<`vec${N}<f64>`>
/** An emulated-double `mat2x2<f64>` constructor, COLUMN-major — one `vec2<f64>` argument per
 *  column, the same convention as WGSL's own `mat2x2(col0, col1)`. Pair with {@link transformMat64}
 *  / {@link mulMat64} for f64 matrix·vector and matrix·matrix products (the generic `.mul` rejects
 *  mat operands).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { mat2f64, vec2f64 } from '@xgis/shader-dsl'
 *
 *  const m = mat2f64(vec2f64(1, 2), vec2f64(3, 4))  // Node<'mat2x2<f64>'>
 *  ```
 */
export const mat2f64 = (...cols: [Mat64Col<2>, Mat64Col<2>]): Node<'mat2x2<f64>'> =>
  construct(mat2f64T, cols) as Node<'mat2x2<f64>'>
/** An emulated-double `mat3x3<f64>` constructor, COLUMN-major — the 3×3 sibling of
 *  {@link mat2f64}; see that entry for the column-argument convention and the transform helpers.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { mat3f64, vec3f64 } from '@xgis/shader-dsl'
 *
 *  const m = mat3f64(vec3f64(1, 0, 0), vec3f64(0, 1, 0), vec3f64(0, 0, 1))
 *  ```
 */
export const mat3f64 = (...cols: [Mat64Col<3>, Mat64Col<3>, Mat64Col<3>]): Node<'mat3x3<f64>'> =>
  construct(mat3f64T, cols) as Node<'mat3x3<f64>'>
/** An emulated-double `mat4x4<f64>` constructor, COLUMN-major — the 4×4 sibling of
 *  {@link mat2f64}; see that entry for the column-argument convention and the transform helpers.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { mat4f64, vec4f64 } from '@xgis/shader-dsl'
 *
 *  const m = mat4f64(
 *    vec4f64(1, 0, 0, 0),
 *    vec4f64(0, 1, 0, 0),
 *    vec4f64(0, 0, 1, 0),
 *    vec4f64(0, 0, 0, 1),
 *  )
 *  ```
 */
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
