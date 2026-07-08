// ═══ Shader DSL — fp64 lowering pass (f64 → vec2<f32> + df64_* calls) ═══
//
// The SINGLE authority for f64 semantics. Authoring carries f64 as a first-
// class ShaderType (`a.add(b)`, `sqrt(x)` — byte-identical surface to f32);
// this pre-emit pass rewrites every f64-typed IR node into the two-f32
// emulation (core/fp64/df64-lib.ts) so no backend ever sees the type:
//
//   lit(f64 v)            → vec2<f32>(hi, lo)            (splitF64 at build time)
//   a + - * / b           → df64_add/sub/mul/div(a, b)
//   a < <= > >= == != b   → df64_lt/le/gt/ge/eq/ne(a, b)
//   -a                    → -(vec2 pair)                 (componentwise, exact)
//   sqrt/abs/min/max/mix/floor/fract → df64_*
//   abs/min/max/mix/floor/fract/normalize on vecN<f64> → df64_vN_*
//   f64(x)  (toF64)       → vec2<f32>(x, 0.0)            (exact widen)
//   f32(x)  (toF32 on f64)→ df64_narrow(x)               (hi + lo)
//   f64 param/var/field/binding/const → vec2<f32>        (type map)
//
// A mixed f64∘f32 operand (legal per binResultType) widens the f32 side as
// vec2<f32>(x, 0.0) — the widen authority lives HERE, nowhere else. Every
// OTHER builtin over an f64 operand is SD0041 (fail-loud, never native vec2
// math); an interpolated @location IO field of f64 is SD0044; the injected
// `df64_` name prefix is reserved (SD0043). A module whose lowering used any
// emulation helper additionally gets the `_fp64` guard uniform AUTO-INJECTED
// (see injectGuard below; a conflicting `_fp64`/`Fp64Guard` declaration is
// SD0042) — the host writes 1.0f into it (df64-lib's header explains why the
// guard must be a runtime input).
//
// Wiring: inside lowerForBackend (core/emit.ts), AFTER match-lower and BEFORE
// the backend optimizer — so WGSL, GLSL, and any future backend lower
// identically, and the optimizer only ever sees ordinary vec2/f32 IR plus
// opaque df64_* calls. The CPU oracle (oracle.ts) is deliberately NOT wired:
// it evaluates f64 natively as a JS number (JS numbers ARE f64 — the
// definitional semantics), which makes `oracle(fp64Lower(m)) ≈ oracle(m)` a
// metamorphic gate on this pass. Identity for modules with no f64 anywhere —
// same object out, so non-f64 emits stay byte-identical by construction.

import type {
  Expr,
  Stmt,
  FuncDecl,
  ModuleDecl,
  StructDecl,
  BindingDecl,
  ConstDecl,
  BinOp,
  CmpOp,
} from '../ir/nodes'
import { stageOf } from '../ir/nodes'
import {
  type ShaderType,
  f32T,
  boolT,
  vec2fT,
  isF64,
  isVec64,
  isMat64,
  structT,
  typeKey,
} from '../ir/types'
import { dslError } from '../diagnostics/error'
import {
  DF64_FNS,
  DF64_ORDER,
  DF64_VEC_STRUCTS,
  DF64_MAT_STRUCTS,
  FP64_GUARD_NAME,
  FP64_GUARD_TYPE,
  splitF64,
} from '../fp64/df64-lib'
import { isKnownIntrinsic } from '../intrinsics'

// ── Type mapping ──

/** Does this type contain f64 / vec64 / mat64 anywhere (directly or via arrays)? */
function containsF64(t: ShaderType): boolean {
  if (isF64(t) || isVec64(t) || isMat64(t)) return true
  if (t.kind === 'array') return containsF64(t.elem)
  return false
}

const vec64StructName = (n: 2 | 3 | 4): string => `DF64Vec${n}`
const mat64StructName = (n: 2 | 3 | 4): string => `DF64Mat${n}`
const vecFT = (n: 2 | 3 | 4): ShaderType => ({ kind: 'vec', n, elem: 'f32' })

/** f64 → vec2<f32>, vecN<f64> → DF64VecN, matNxN<f64> → DF64MatN, recursively
 *  through arrays; everything else unchanged. */
function mapType(t: ShaderType): ShaderType {
  if (isF64(t)) return vec2fT
  if (isVec64(t)) return structT(vec64StructName(t.n))
  if (isMat64(t)) return structT(mat64StructName(t.n))
  if (t.kind === 'array' && containsF64(t.elem))
    return {
      kind: 'array',
      elem: mapType(t.elem),
      ...(t.size !== undefined ? { size: t.size } : {}),
    }
  return t
}

const BINOP_FN: Partial<Record<BinOp, string>> = {
  '+': 'df64_add',
  '-': 'df64_sub',
  '*': 'df64_mul',
  '/': 'df64_div',
}
const CMP_FN: Record<CmpOp, string> = {
  '<': 'df64_lt',
  '>': 'df64_gt',
  '<=': 'df64_le',
  '>=': 'df64_ge',
  '==': 'df64_eq',
  '!=': 'df64_ne',
}
/** Whitelisted builtin ids on f64 operands → their df64 twin. */
const CALL_FN: Record<string, string> = {
  sqrt: 'df64_sqrt',
  abs: 'df64_abs',
  floor: 'df64_floor',
  fract: 'df64_fract',
  min: 'df64_min',
  max: 'df64_max',
  mix: 'df64_mix',
}
/** Whitelisted componentwise builtins on vec64 → their df64_vN_* twin shape. */
const VEC_CALL_KIND: Record<string, 'unary' | 'binary' | 'mix'> = {
  abs: 'unary',
  floor: 'unary',
  fract: 'unary',
  normalize: 'unary',
  min: 'binary',
  max: 'binary',
  mix: 'mix',
}

const litF32 = (v: number): Expr => ({ op: 'lit', type: f32T, value: v })
/** vec2<f32>(hi, lo) — the lowered spelling of an f64 literal. */
const pairLit = (v: number): Expr => {
  const [hi, lo] = splitF64(v)
  return { op: 'construct', type: vec2fT, args: [litF32(hi), litF32(lo)] }
}
/** vec2<f32>(x, 0.0) — the exact f32 → f64 widen. */
const widen = (x: Expr): Expr => ({ op: 'construct', type: vec2fT, args: [x, litF32(0)] })

// ── vec64 expr utilities (post-lowering shapes over the DF64VecN struct) ──

const VEC_BINOP_FN: Partial<Record<BinOp, string>> = {
  '+': 'add',
  '-': 'sub',
  '*': 'mul',
  '/': 'div',
}
/** base.hi / base.lo (base = a LOWERED DF64VecN expr). */
const plane = (base: Expr, n: 2 | 3 | 4, which: 'hi' | 'lo'): Expr => ({
  op: 'member',
  type: vecFT(n),
  base,
  field: which,
})
/** The f64 pair of one lane / a swizzle of lanes, reassembled from the planes.
 *  `base` is a pure lowered expr — it appears in BOTH planes (cse dedupes). */
const laneSwizzle = (base: Expr, n: 2 | 3 | 4, comps: string): Expr => {
  const pick = (which: 'hi' | 'lo'): Expr => ({
    op: 'member',
    type: comps.length === 1 ? f32T : vecFT(comps.length as 2 | 3 | 4),
    base: plane(base, n, which),
    field: comps,
  })
  return comps.length === 1
    ? { op: 'construct', type: vec2fT, args: [pick('hi'), pick('lo')] }
    : {
        op: 'construct',
        type: structT(vec64StructName(comps.length as 2 | 3 | 4)),
        args: [pick('hi'), pick('lo')],
      }
}
/** Splat a lowered f64 PAIR onto n lanes: DF64VecN(vecN(p.x), vecN(p.y)). */
const splatPair = (pair: Expr, n: 2 | 3 | 4): Expr => {
  const comp = (c: 'x' | 'y'): Expr => ({ op: 'member', type: f32T, base: pair, field: c })
  const fill = (c: 'x' | 'y'): Expr => ({ op: 'construct', type: vecFT(n), args: [comp(c)] })
  return { op: 'construct', type: structT(vec64StructName(n)), args: [fill('x'), fill('y')] }
}

// ── The per-module rewriter ──

interface LowerCtx {
  /** df64 helper names the rewrite referenced (pre-closure). */
  readonly used: Set<string>
  /** vec64 lane counts seen anywhere — drives DF64VecN struct injection. */
  readonly vecWidths: Set<2 | 3 | 4>
  /** mat64 dimensions seen — drives DF64MatN struct injection (and forces the
   *  matching DF64VecN, since a DF64MatN nests DF64VecN columns). */
  readonly matWidths: Set<2 | 3 | 4>
}

function callHelper(ctx: LowerCtx, name: string, type: ShaderType, args: Expr[]): Expr {
  ctx.used.add(name)
  return { op: 'call', type, fn: name, args }
}

function lowerExpr(e: Expr, ctx: LowerCtx): Expr {
  const walk = (x: Expr): Expr => lowerExpr(x, ctx)
  if (isVec64(e.type)) ctx.vecWidths.add(e.type.n)
  // A DF64MatN nests DF64VecN columns, so a mat width forces its vec width too.
  if (isMat64(e.type)) {
    ctx.matWidths.add(e.type.n)
    ctx.vecWidths.add(e.type.n)
  }
  /** Lower an expr that must land as an f64 PAIR: an f64 operand lowers to its
   *  vec2 form; a (legal) f32 operand widens exactly. Anything else is a gate
   *  bug upstream — binResultType/cmp admit only f64 and f32-scalar here. */
  const pairOperand = (x: Expr): Expr => {
    if (isF64(x.type)) return walk(x)
    if (x.type.kind === 'scalar' && x.type.scalar === 'f32') return widen(walk(x))
    throw dslError('SD0041', `f64 op with a ${typeKey(x.type)} operand`)
  }
  /** Lower an expr that must land as a DF64VecN struct: a vec64 operand lowers
   *  directly; an f64 / f32 scalar broadcasts onto the lanes. */
  const vecOperand = (x: Expr, n: 2 | 3 | 4): Expr => {
    if (isVec64(x.type)) return walk(x)
    return splatPair(pairOperand(x), n)
  }
  /** The f64 pair of lane i of a lowered vec64 expr. */
  const lane = (lowered: Expr, n: 2 | 3 | 4, i: number): Expr => laneSwizzle(lowered, n, 'xyzw'[i]!)

  switch (e.op) {
    case 'lit':
      return isF64(e.type) ? pairLit(e.value as number) : e
    case 'constref':
    case 'param':
    case 'varref':
      return containsF64(e.type) ? { ...e, type: mapType(e.type) } : e
    case 'binop': {
      // mat64 as the LEFT operand: M*v (→ vec64) or M*M (→ mat64). Intercepted
      // on the operand type, not e.type — a matvec RESULT is itself a vec64 and
      // would misroute into the componentwise vec64 branch below.
      if (isMat64(e.a.type)) {
        if (e.bop !== '*')
          throw dslError('SD0041', `binary op '${e.bop}' on ${typeKey(e.a.type)}`)
        const n = e.a.type.n
        if (isMat64(e.b.type))
          return callHelper(ctx, `df64_m${n}_matmul`, structT(mat64StructName(n)), [
            walk(e.a),
            walk(e.b),
          ])
        if (isVec64(e.b.type))
          return callHelper(ctx, `df64_m${n}_matvec`, structT(vec64StructName(n)), [
            walk(e.a),
            walk(e.b),
          ])
        throw dslError('SD0041', `matNxN<f64> '*' with a ${typeKey(e.b.type)} operand`)
      }
      if (isVec64(e.type)) {
        const n = e.type.n
        const op = VEC_BINOP_FN[e.bop]
        if (op === undefined) throw dslError('SD0041', `binary op '${e.bop}' on ${typeKey(e.type)}`)
        return callHelper(ctx, `df64_v${n}_${op}`, structT(vec64StructName(n)), [
          vecOperand(e.a, n),
          vecOperand(e.b, n),
        ])
      }
      if (isF64(e.type)) {
        const fnName = BINOP_FN[e.bop]
        if (fnName === undefined)
          throw dslError('SD0041', `binary op '${e.bop}' on ${typeKey(e.a.type)}`)
        return callHelper(ctx, fnName, vec2fT, [pairOperand(e.a), pairOperand(e.b)])
      }
      return { ...e, a: walk(e.a), b: walk(e.b) }
    }
    case 'unop': {
      // Componentwise negation of a (hi, lo) pair is exact — no helper needed.
      if (isF64(e.type)) return { op: 'unop', type: vec2fT, a: pairOperand(e.a) }
      if (isVec64(e.type)) {
        const n = e.type.n
        const base = walk(e.a)
        const negPlane = (which: 'hi' | 'lo'): Expr => ({
          op: 'unop',
          type: vecFT(n),
          a: plane(base, n, which),
        })
        return {
          op: 'construct',
          type: structT(vec64StructName(n)),
          args: [negPlane('hi'), negPlane('lo')],
        }
      }
      return { ...e, a: walk(e.a) }
    }
    case 'compare':
      if (isF64(e.a.type) || isF64(e.b.type)) {
        return callHelper(ctx, CMP_FN[e.cop], boolT, [pairOperand(e.a), pairOperand(e.b)])
      }
      return { ...e, a: walk(e.a), b: walk(e.b) }
    case 'logical':
      return { ...e, a: walk(e.a), b: walk(e.b) }
    case 'call': {
      // toF64 / the f64() widen call — exact, no helper.
      if (e.fn === 'f64') {
        const a = e.args[0]!
        return isF64(a.type) ? walk(a) : widen(walk(a))
      }
      // f64FromParts(hi, lo) — the pair IS the representation: construct it.
      if (e.fn === 'f64FromParts') {
        return { op: 'construct', type: vec2fT, args: [walk(e.args[0]!), walk(e.args[1]!)] }
      }
      // f64Parts(x) — identity: post-lowering an f64 already is its vec2 pair.
      if (e.fn === 'f64Parts') {
        return walk(e.args[0]!)
      }
      // toF32 on an f64 argument — the explicit narrow (hi + lo).
      if (e.fn === 'f32' && e.args.length === 1 && isF64(e.args[0]!.type)) {
        return callHelper(ctx, 'df64_narrow', f32T, [walk(e.args[0]!)])
      }
      // transpose(M) on a mat64 → df64_mN_transpose (gathers lane i of every
      // old column into new column i — no new numerics, only a reshuffle).
      if (e.fn === 'transpose' && isMat64(e.args[0]!.type)) {
        const n = e.args[0]!.type.n
        return callHelper(ctx, `df64_m${n}_transpose`, structT(mat64StructName(n)), [
          walk(e.args[0]!),
        ])
      }
      // Any OTHER builtin over a mat64 operand is unsupported — fail loud rather
      // than leak a bare `transpose`/`inverse`/… call the backend can't spell.
      if (isMat64(e.type) || e.args.some((a) => isMat64(a.type))) {
        if (isKnownIntrinsic(e.fn)) throw dslError('SD0041', `${e.fn}() on mat64 operands`)
      }
      // Cross-lane reductions on vec64 — composed from the SCALAR df64 fns
      // (dot must accumulate in extended precision anyway). The walked base
      // exprs repeat per lane; they are pure, and cse/the driver dedupe them.
      if (
        (e.fn === 'dot' || e.fn === 'length' || e.fn === 'distance') &&
        isVec64(e.args[0]!.type)
      ) {
        const n = (e.args[0]!.type as Extract<ShaderType, { kind: 'vec64' }>).n
        const sumSquares = (laneAt: (i: number) => Expr): Expr => {
          let acc: Expr | undefined
          for (let i = 0; i < n; i++) {
            const li = laneAt(i)
            const sq = callHelper(ctx, 'df64_mul', vec2fT, [li, li])
            acc = acc === undefined ? sq : callHelper(ctx, 'df64_add', vec2fT, [acc, sq])
          }
          return acc!
        }
        if (e.fn === 'dot') {
          const a = walk(e.args[0]!)
          const b = walk(e.args[1]!)
          let acc: Expr | undefined
          for (let i = 0; i < n; i++) {
            const prod = callHelper(ctx, 'df64_mul', vec2fT, [lane(a, n, i), lane(b, n, i)])
            acc = acc === undefined ? prod : callHelper(ctx, 'df64_add', vec2fT, [acc, prod])
          }
          return acc!
        }
        if (e.fn === 'length') {
          const a = walk(e.args[0]!)
          return callHelper(ctx, 'df64_sqrt', vec2fT, [sumSquares((i) => lane(a, n, i))])
        }
        // distance: √Σ (aᵢ − bᵢ)²  — per-lane scalar subtraction.
        const a = walk(e.args[0]!)
        const b = walk(e.args[1]!)
        return callHelper(ctx, 'df64_sqrt', vec2fT, [
          sumSquares((i) => callHelper(ctx, 'df64_sub', vec2fT, [lane(a, n, i), lane(b, n, i)])),
        ])
      }
      // Componentwise vec64 builtins → their df64_vN_* twins. Each helper
      // composes the verified SCALAR df64 fns lane by lane INSIDE its body
      // (abs/min/max/floor branch per lane — no whole-plane form exists
      // without a per-lane select), so the operand is evaluated exactly once
      // as the call argument.
      if (isVec64(e.type) && VEC_CALL_KIND[e.fn] !== undefined) {
        const n = e.type.n
        const sTy = structT(vec64StructName(n))
        const kind = VEC_CALL_KIND[e.fn]!
        if (kind === 'unary') {
          return callHelper(ctx, `df64_v${n}_${e.fn}`, sTy, [vecOperand(e.args[0]!, n)])
        }
        if (kind === 'binary') {
          return callHelper(ctx, `df64_v${n}_${e.fn}`, sTy, [
            vecOperand(e.args[0]!, n),
            vecOperand(e.args[1]!, n),
          ])
        }
        // mix(a, b, t): a/b are vec64 (or broadcast); t stays a SCALAR f32 —
        // the same contract as the scalar df64_mix (per-lane vec t unsupported).
        const t = e.args[2]!
        if (!(t.type.kind === 'scalar' && t.type.scalar === 'f32')) {
          throw dslError(
            'SD0041',
            `mix() on vec64 needs a scalar f32 interpolant, got ${typeKey(t.type)}`,
          )
        }
        return callHelper(ctx, `df64_v${n}_mix`, sTy, [
          vecOperand(e.args[0]!, n),
          vecOperand(e.args[1]!, n),
          walk(t),
        ])
      }
      // Any OTHER builtin over a vec64 is unsupported — fail loud.
      if (isVec64(e.type) || e.args.some((a) => isVec64(a.type))) {
        if (isKnownIntrinsic(e.fn) || e.fn === 'i32' || e.fn === 'u32' || e.fn === 'f32') {
          throw dslError('SD0041', `${e.fn}() on vec64 operands`)
        }
      }
      const touchesF64 = isF64(e.type) || e.args.some((a) => isF64(a.type))
      if (touchesF64) {
        const mapped = CALL_FN[e.fn]
        if (mapped !== undefined) {
          if (e.fn === 'mix') {
            // mix(a, b, t): a/b are the f64 pair operands; t stays f32.
            const t = e.args[2]!
            if (isF64(t.type))
              throw dslError('SD0041', 'mix() interpolant t must be f32 (narrow it with toF32)')
            return callHelper(ctx, mapped, vec2fT, [
              pairOperand(e.args[0]!),
              pairOperand(e.args[1]!),
              walk(t),
            ])
          }
          const ret = isF64(e.type) ? vec2fT : mapType(e.type)
          return callHelper(ctx, mapped, ret, e.args.map(pairOperand))
        }
        // Any OTHER builtin on f64 is unsupported — fail loud, never emit
        // native vec2 math for it. User/extern fns pass through (their param
        // types are mapped with their decls; the type checker already matched
        // the f64 signature at authoring).
        if (isKnownIntrinsic(e.fn) || e.fn === 'i32' || e.fn === 'u32') {
          throw dslError('SD0041', `${e.fn}() on f64 operands`)
        }
      }
      return { ...e, type: mapType(e.type), args: e.args.map(walk) }
    }
    case 'member':
      // A component / swizzle of a vec64 reassembles from the hi/lo planes:
      // v.x → vec2<f32>(v.hi.x, v.lo.x); v.xy → DF64Vec2(v.hi.xy, v.lo.xy).
      if (isVec64(e.base.type)) {
        return laneSwizzle(walk(e.base), e.base.type.n, e.field)
      }
      return { ...e, type: mapType(e.type), base: walk(e.base) }
    case 'construct': {
      // vecNf64(…) — gather the lowered lane pairs into the two planes:
      // DF64VecN(vecN(p0.x, p1.x, …), vecN(p0.y, p1.y, …)). A single argument
      // splats (WGSL-style) via the same shape.
      if (e.type.kind === 'vec64') {
        const n = e.type.n
        const pairs = e.args.map(pairOperand)
        const planeOf = (c: 'x' | 'y'): Expr => ({
          op: 'construct',
          type: vecFT(n),
          args: pairs.map((pr): Expr => ({ op: 'member', type: f32T, base: pr, field: c })),
        })
        return {
          op: 'construct',
          type: structT(vec64StructName(n)),
          args: [planeOf('x'), planeOf('y')],
        }
      }
      // matNf64(col0, …, col(N-1)) — gather the lowered vec64 columns into a
      // DF64MatN. Each column arg lowers via vecOperand (vec64 direct, scalar
      // broadcast), so the column-major struct is assembled directly.
      if (e.type.kind === 'mat' && e.type.elem === 'f64') {
        const n = e.type.n
        return {
          op: 'construct',
          type: structT(mat64StructName(n)),
          args: e.args.map((a) => vecOperand(a, n)),
        }
      }
      // array<f64, N>(…) and struct constructors may legally take f64 args
      // (the element/field types map alongside); a vec/mat construct with an
      // f64 / vec64 component has no meaning — reject.
      if (
        (e.type.kind === 'vec' || e.type.kind === 'mat') &&
        e.args.some((a) => isF64(a.type) || isVec64(a.type))
      ) {
        throw dslError('SD0041', `${typeKey(e.type)} constructor with an f64 component`)
      }
      return { ...e, type: mapType(e.type), args: e.args.map(walk) }
    }
    case 'select':
      return {
        ...e,
        type: mapType(e.type),
        cond: walk(e.cond),
        ifTrue: walk(e.ifTrue),
        ifFalse: walk(e.ifFalse),
      }
    case 'index':
      return { ...e, type: mapType(e.type), base: walk(e.base), idx: walk(e.idx) }
    case 'matchExpr': {
      // Normally already lowered (match-lower runs first in lowerForBackend);
      // handled anyway so a direct fp64Lower(m) call (tests, oracle
      // metamorphic gate) accepts an authored module.
      if (isF64(e.scrutinee.type))
        throw dslError('SD0041', 'matchExpr scrutinee must be an integer scalar, got f64')
      return {
        ...e,
        type: mapType(e.type),
        scrutinee: walk(e.scrutinee),
        cases: e.cases.map(([v, x]) => [v, walk(x)] as const),
        default: walk(e.default),
      }
    }
  }
}

function lowerStmt(s: Stmt, ctx: LowerCtx): Stmt {
  const walk = (x: Expr): Expr => lowerExpr(x, ctx)
  switch (s.s) {
    case 'let':
      return { ...s, expr: walk(s.expr) }
    case 'var':
      return {
        ...s,
        type: mapType(s.type),
        ...(s.init !== undefined ? { init: walk(s.init) } : {}),
      }
    case 'assign': {
      // A vec64 target takes a vec64 value only (no implicit scalar splat on
      // assignment — WGSL has none either).
      if (isVec64(s.target.type) && !isVec64(s.expr.type)) {
        throw dslError(
          'SD0041',
          `assign of ${typeKey(s.expr.type)} to a ${typeKey(s.target.type)} target`,
        )
      }
      // An f64 target may legally receive an f32 value (ArithArg widen) —
      // wrap it here, the one widen authority.
      if (isF64(s.target.type) && !isF64(s.expr.type)) {
        const value =
          s.expr.type.kind === 'scalar' && s.expr.type.scalar === 'f32'
            ? widen(walk(s.expr))
            : (() => {
                throw dslError('SD0041', `assign of ${typeKey(s.expr.type)} to an f64 target`)
              })()
        return { s: 'assign', target: walk(s.target), expr: value }
      }
      return { ...s, target: walk(s.target), expr: walk(s.expr) }
    }
    case 'assignOp': {
      // `x += v` on a vec64 target — rewrite to `x = df64_vN_add(x, v)`.
      if (isVec64(s.target.type)) {
        const n = s.target.type.n
        const op = VEC_BINOP_FN[s.bop]
        if (op === undefined)
          throw dslError('SD0041', `compound assign '${s.bop}=' on ${typeKey(s.target.type)}`)
        const target = lowerExpr(s.target, ctx)
        ctx.used.add(`df64_v${n}_${op}`)
        const rhs = isVec64(s.expr.type)
          ? lowerExpr(s.expr, ctx)
          : (() => {
              throw dslError('SD0041', `'${s.bop}=' of ${typeKey(s.expr.type)} on vec64`)
            })()
        return {
          s: 'assign',
          target,
          expr: {
            op: 'call',
            type: structT(vec64StructName(n)),
            fn: `df64_v${n}_${op}`,
            args: [target, rhs],
          },
        }
      }
      // `x += v` on an f64 target has no native spelling — rewrite to
      // `x = df64_add(x, v)`.
      if (isF64(s.target.type)) {
        const fnName = BINOP_FN[s.bop]
        if (fnName === undefined) throw dslError('SD0041', `compound assign '${s.bop}=' on f64`)
        const target = walk(s.target)
        const rhs = isF64(s.expr.type)
          ? walk(s.expr)
          : s.expr.type.kind === 'scalar' && s.expr.type.scalar === 'f32'
            ? widen(walk(s.expr))
            : (() => {
                throw dslError('SD0041', `'${s.bop}=' of ${typeKey(s.expr.type)} on f64`)
              })()
        return {
          s: 'assign',
          target,
          expr: { op: 'call', type: vec2fT, fn: fnName, args: [target, rhs] },
        }
      }
      return { ...s, target: walk(s.target), expr: walk(s.expr) }
    }
    case 'return':
      return s.expr !== undefined ? { ...s, expr: walk(s.expr) } : s
    case 'if':
      return {
        ...s,
        arms: s.arms.map((arm) => ({
          cond: walk(arm.cond),
          body: arm.body.map((b) => lowerStmt(b, ctx)),
        })),
        ...(s.elseBody ? { elseBody: s.elseBody.map((b) => lowerStmt(b, ctx)) } : {}),
      }
    case 'for':
      return {
        ...s,
        init: lowerStmt(s.init, ctx),
        cond: walk(s.cond),
        update: lowerStmt(s.update, ctx),
        body: s.body.map((b) => lowerStmt(b, ctx)),
      }
    case 'switch':
      return {
        ...s,
        scrut: walk(s.scrut),
        cases: s.cases.map((c) => ({ ...c, body: c.body.map((b) => lowerStmt(b, ctx)) })),
        ...(s.defaultBody ? { defaultBody: s.defaultBody.map((b) => lowerStmt(b, ctx)) } : {}),
      }
    case 'break':
    case 'continue':
    case 'discard':
    case 'placeholder':
    case 'raw':
      return s
  }
}

// ── Fast identity scan (non-f64 modules must come out the SAME object) ──

function exprHasF64(e: Expr): boolean {
  if (containsF64(e.type)) return true
  switch (e.op) {
    case 'lit':
    case 'constref':
    case 'param':
    case 'varref':
      return false
    case 'binop':
    case 'compare':
    case 'logical':
      return exprHasF64(e.a) || exprHasF64(e.b)
    case 'unop':
      return exprHasF64(e.a)
    case 'call':
    case 'construct':
      return e.args.some(exprHasF64)
    case 'member':
      return exprHasF64(e.base)
    case 'select':
      return exprHasF64(e.cond) || exprHasF64(e.ifTrue) || exprHasF64(e.ifFalse)
    case 'index':
      return exprHasF64(e.base) || exprHasF64(e.idx)
    case 'matchExpr':
      return (
        exprHasF64(e.scrutinee) || e.cases.some(([, v]) => exprHasF64(v)) || exprHasF64(e.default)
      )
  }
}

function stmtHasF64(s: Stmt): boolean {
  switch (s.s) {
    case 'let':
      return exprHasF64(s.expr)
    case 'var':
      return containsF64(s.type) || (s.init !== undefined && exprHasF64(s.init))
    case 'assign':
    case 'assignOp':
      return exprHasF64(s.target) || exprHasF64(s.expr)
    case 'return':
      return s.expr !== undefined && exprHasF64(s.expr)
    case 'if':
      return (
        s.arms.some((a) => exprHasF64(a.cond) || a.body.some(stmtHasF64)) ||
        (s.elseBody?.some(stmtHasF64) ?? false)
      )
    case 'for':
      return (
        stmtHasF64(s.init) || exprHasF64(s.cond) || stmtHasF64(s.update) || s.body.some(stmtHasF64)
      )
    case 'switch':
      return (
        exprHasF64(s.scrut) ||
        s.cases.some((c) => c.body.some(stmtHasF64)) ||
        (s.defaultBody?.some(stmtHasF64) ?? false)
      )
    default:
      return false
  }
}

function moduleUsesF64(m: ModuleDecl): boolean {
  return (
    m.consts.some((c) => containsF64(c.type)) ||
    m.structs.some((s) => s.fields.some((f) => containsF64(f.type))) ||
    m.bindings.some((b) => containsF64(b.type)) ||
    m.funcs.some(
      (f) =>
        containsF64(f.ret) || f.params.some((p) => containsF64(p.type)) || f.body.some(stmtHasF64),
    )
  )
}

// ── Helper closure + injection ──

/** df64 helper names called from a helper body (for the transitive closure). */
function helperCallees(d: FuncDecl): string[] {
  const out = new Set<string>()
  const expr = (e: Expr): void => {
    switch (e.op) {
      case 'call':
        if (e.fn.startsWith('df64_')) out.add(e.fn)
        e.args.forEach(expr)
        break
      case 'binop':
      case 'compare':
      case 'logical':
        expr(e.a)
        expr(e.b)
        break
      case 'unop':
        expr(e.a)
        break
      case 'construct':
        e.args.forEach(expr)
        break
      case 'member':
        expr(e.base)
        break
      case 'select':
        expr(e.cond)
        expr(e.ifTrue)
        expr(e.ifFalse)
        break
      case 'index':
        expr(e.base)
        expr(e.idx)
        break
      default:
        break
    }
  }
  const stmt = (s: Stmt): void => {
    switch (s.s) {
      case 'let':
        expr(s.expr)
        break
      case 'var':
        if (s.init) expr(s.init)
        break
      case 'assign':
      case 'assignOp':
        expr(s.target)
        expr(s.expr)
        break
      case 'return':
        if (s.expr) expr(s.expr)
        break
      case 'if':
        s.arms.forEach((a) => {
          expr(a.cond)
          a.body.forEach(stmt)
        })
        s.elseBody?.forEach(stmt)
        break
      case 'for':
        stmt(s.init)
        expr(s.cond)
        stmt(s.update)
        s.body.forEach(stmt)
        break
      case 'switch':
        expr(s.scrut)
        s.cases.forEach((c) => c.body.forEach(stmt))
        s.defaultBody?.forEach(stmt)
        break
      default:
        break
    }
  }
  d.body.forEach(stmt)
  return [...out]
}

/** Expand the directly-referenced helper set to its transitive closure and
 *  return the decls in DF64_ORDER (fixed, dependency-first — byte-stable). */
function helperClosure(used: ReadonlySet<string>): FuncDecl[] {
  const need = new Set(used)
  const queue = [...used]
  while (queue.length) {
    const d = DF64_FNS.get(queue.pop()!)
    if (!d) continue
    for (const callee of helperCallees(d)) {
      if (!need.has(callee)) {
        need.add(callee)
        queue.push(callee)
      }
    }
  }
  return DF64_ORDER.filter((d) => need.has(d.name))
}

// ── Guard auto-injection ──
//
// The df64 helper bodies read a runtime-opaque 1.0 via the `f64Guard`
// intrinsic, which spells as a texel fetch on the `_fp64` TEXTURE binding
// (the anti-fast-math guard — see df64-lib's header for WHY it must be a
// runtime input a driver can never constant-fold; a uniform is defeated by
// uniform-value pipeline specialization). Authors declare NOTHING: any module
// whose lowering used a helper gets the `_fp64` texture_2d<f32> binding
// injected here, at a DETERMINISTIC slot — group 0, first binding index past
// the module's own group-0 bindings — so emit stays byte-stable and can never
// collide with the module's declared bindings. An author who must pin the
// slot to an engine's fixed bind-group layout declares
// `fp64Guard({ group, binding })` in `uses:`, which this function honours
// (matching name + type). A CONFLICTING `_fp64` declaration (wrong type) is
// SD0042 — the emulation would be precision-dead against a mis-shaped guard.

function injectGuard(bindings: BindingDecl[]): void {
  const existing = bindings.find((b) => b.name === FP64_GUARD_NAME)
  if (existing) {
    if (typeKey(existing.type) !== typeKey(FP64_GUARD_TYPE)) {
      throw dslError(
        'SD0042',
        `binding '${FP64_GUARD_NAME}' exists but is ${existing.space} ${typeKey(existing.type)}`,
      )
    }
  } else {
    const g0 = bindings.filter((b) => b.group === 0)
    const slot = g0.length ? Math.max(...g0.map((b) => b.binding)) + 1 : 0
    bindings.push({
      group: 0,
      binding: slot,
      name: FP64_GUARD_NAME,
      space: 'uniform',
      type: FP64_GUARD_TYPE,
    })
  }
}

// ── The pass ──

/** Lower every f64 in a module to its vec2<f32> / df64_* emulation. Identity
 *  (same object) for modules containing no f64. Run inside lowerForBackend —
 *  after match-lower, before the backend optimizer. */
export function fp64Lower(m: ModuleDecl): ModuleDecl {
  if (!moduleUsesF64(m)) return m

  // The injected names are reserved — an authored collision would silently
  // shadow the emulation.
  for (const f of m.funcs) {
    if (f.name.startsWith('df64_')) throw dslError('SD0043', `fn '${f.name}'`)
  }
  for (const st of m.structs) {
    if (st.name.startsWith('DF64Vec') || st.name.startsWith('DF64Mat'))
      throw dslError('SD0043', `struct '${st.name}'`)
  }

  const ctx: LowerCtx = { used: new Set(), vecWidths: new Set(), matWidths: new Set() }
  const recordWidths = (t: ShaderType): void => {
    if (isVec64(t)) ctx.vecWidths.add(t.n)
    // A mat width forces its vec width — DF64MatN nests DF64VecN columns.
    else if (isMat64(t)) {
      ctx.matWidths.add(t.n)
      ctx.vecWidths.add(t.n)
    } else if (t.kind === 'array') recordWidths(t.elem)
  }

  const consts: ConstDecl[] = m.consts.map((c) => {
    if (!containsF64(c.type)) return c
    recordWidths(c.type)
    // An f64 module const becomes a vec2 pair const. The scalar dual-value
    // form splits its full-precision cpuValue; a valueExpr lowers recursively.
    const valueExpr = c.valueExpr !== undefined ? lowerExpr(c.valueExpr, ctx) : pairLit(c.cpuValue)
    return { name: c.name, type: mapType(c.type), wgslValue: 0, cpuValue: 0, valueExpr }
  })

  const structs: StructDecl[] = m.structs.map((s) => {
    if (!s.fields.some((f) => containsF64(f.type))) return s
    return {
      ...s,
      fields: s.fields.map((f) => {
        if (!containsF64(f.type)) return f
        // Interpolating a (hi, lo) pair is numerically wrong — an f64 varying
        // (an @location IO-struct field) is rejected, not silently averaged.
        if (f.location !== undefined) throw dslError('SD0044', `${s.name}.${f.name}`)
        recordWidths(f.type)
        return { ...f, type: mapType(f.type) }
      }),
    }
  })

  const bindings: BindingDecl[] = m.bindings.map((b) => {
    if (!containsF64(b.type)) return b
    recordWidths(b.type)
    return { ...b, type: mapType(b.type) }
  })

  const funcs: FuncDecl[] = m.funcs.map((f) => {
    const stage = stageOf(f)
    const params = f.params.map((p) => {
      if (!containsF64(p.type)) return p
      // A vertex @location param is an ATTRIBUTE (one vec2<f32> slot — fine
      // for SCALAR f64; a vec64 would need two slots — pass hi/lo lanes as
      // two vecN<f32> @locations and rebuild with f64FromParts per lane);
      // a fragment @location param is an interpolated varying — rejected.
      if (stage === 'fragment' && p.location !== undefined)
        throw dslError('SD0044', `fragment input '${p.name}'`)
      if (p.location !== undefined && isVec64(p.type))
        throw dslError(
          'SD0041',
          `vec64 vertex attribute '${p.name}' — pass hi/lo as two vecN<f32> @locations and rebuild lanes with f64FromParts`,
        )
      recordWidths(p.type)
      return { ...p, type: mapType(p.type) }
    })
    let ret = f.ret
    if (containsF64(f.ret)) {
      // A stage output f64 is a varying / render-target write — meaningless.
      if (stage !== undefined) throw dslError('SD0044', `${stage} entry '${f.name}' return`)
      recordWidths(f.ret)
      ret = mapType(f.ret)
    }
    const body = f.body.map((s) => lowerStmt(s, ctx))
    return { ...f, params, ret, body }
  })

  // DF64VecN struct decls for every lane width the module carries (needed
  // even for type-only pass-through, where no helper fires).
  for (const n of [2, 3, 4] as const) {
    if (ctx.vecWidths.has(n)) structs.push(DF64_VEC_STRUCTS.get(n)!)
  }
  // DF64MatN decls AFTER the vec structs — a DF64MatN nests DF64VecN columns
  // and GLSL needs define-before-use (recordWidths forced the vec width above).
  for (const n of [2, 3, 4] as const) {
    if (ctx.matWidths.has(n)) structs.push(DF64_MAT_STRUCTS.get(n)!)
  }

  const helpers = helperClosure(ctx.used)
  if (helpers.length > 0) injectGuard(bindings)

  return { consts, structs, bindings, funcs: [...funcs, ...helpers] }
}
