// ═══ Shader DSL — INTEGER-DOMAIN df64 EFT primitives (the Apple/Metal flavor) ═══
//
// The float EFT primitives in df64-lib.ts are algebraically trivial identities
// (`e = b − (s − a)`), and every portable source-level defense against a
// downstream shader compiler's fast-math REASSOCIATING them away has been
// refuted on real Apple hardware (probe history: the `·one` value guard, the
// additive `+ONE·0` guard, operand/product laundering, luma.gl's per-cross-term
// renorm, fma — Apple's fma IS fused and the chain still dies — and the bitcast
// round-trip). The one construction that survives (probe dg_imul / dg_ifull /
// dg_imulsq, verified on the macOS Metal oracle in the exact shapes where every
// float form collapses) is arithmetic the float optimizer can never touch:
// compute the EXACT sum/product in INTEGER BIT ARITHMETIC on the IEEE-754
// representation, and only materialise the two rounded f32 words at the end.
// Integer ops are exact — there is nothing to contract, reassociate, or factor.
//
// Same names, same signatures, same (hi, lo) vec2<f32> contract as df64-lib's
// primitives, so every COMPOSITION (df64_add/sub/mul/floor/fract/mix/cmp/…) is
// shared byte-for-byte and binds to these bodies when fp64Lower's integer
// registry is selected. Only the leaves swap:
//   df64_twoSum / df64_quickTwoSum — exact s+e == a+b via aligned integer add
//   df64_twoProd / df64_twoSqr    — exact p+e == a·b via the 24×24→48 product
//   df64_div / df64_sqrt          — the float bodies minus the `one` guard
//                                   (their seeds are lone approximations whose
//                                   error the now-exact int sub/mul corrects)
//   df64_v{2,3,4}_ twoSum/quickTwoSum/twoProd/div — per-lane scalar calls
// The guard disappears entirely: no integer body references f64Guard, so
// fp64Lower injects no `_fp64` binding — integer-flavor modules need NO guard
// texture bound by the host.
//
// Numeric contract (the float flavor's operating envelope, made bit-precise):
//   • round-to-nearest-even wherever a rounding occurs (bit-exact with the f32
//     RNE that the property suite's fround oracle applies);
//   • signed zeros and gradual underflow (denormal results) handled;
//   • ±inf / NaN are OUT OF SCOPE (as for the float flavor — the geographic
//     operating range never produces them; such inputs yield an unspecified
//     finite pattern rather than a guarantee).
//
// Implementation note on select(): the IR select evaluates BOTH arms, so shift
// amounts that would exceed 31 in a DISCARDED arm still execute — u32 shifts
// are defined mod 32 on WGSL/GLSL/the CPU oracle alike, so those arms produce
// well-defined garbage that the select then drops. Shift amounts in the TAKEN
// arm are always in range by construction; comments mark each case.

import {
  fn,
  Let,
  vec2,
  sqrt,
  min,
  u32,
  f32,
  bitcastU32,
  bitcastF32,
  member,
  construct,
  structT,
  f32T,
  u32T,
  vec2fT,
  vec3fT,
  vec4fT,
  type ReadonlyNode,
  type FuncDecl,
  type ShaderType,
} from '../ir'
import { DF64_FNS, DF64_ORDER, DF64_CALLS } from './df64-lib'

type UN = ReadonlyNode<'u32'>
type FN = ReadonlyNode<'f32'>
const M24 = 0xffffff

// ── Integer building blocks (inlined into the fn bodies below) ──

/** 0-based index of the highest set bit of x (x > 0), 5-step staircase. */
const msb32 = (x0: UN): UN => {
  const k4 = Let(x0.ge(u32(0x10000)).select(u32(16), u32(0)))
  const x1 = Let(x0.shr(k4))
  const k3 = Let(x1.ge(u32(0x100)).select(u32(8), u32(0)))
  const x2 = Let(x1.shr(k3))
  const k2 = Let(x2.ge(u32(0x10)).select(u32(4), u32(0)))
  const x3 = Let(x2.shr(k2))
  const k1 = Let(x3.ge(u32(4)).select(u32(2), u32(0)))
  const x4 = Let(x3.shr(k1))
  const k0 = Let(x4.ge(u32(2)).select(u32(1), u32(0)))
  return Let(k4.add(k3).add(k2).add(k1).add(k0))
}

/** Round-to-nearest-even right shift of v by r ∈ [0, 31]. */
const rne32 = (v: UN, r: UN): UN => {
  const kept = Let(v.shr(r))
  const rz = Let(r.eq(u32(0)))
  const rb1 = Let(rz.select(u32(0), r.sub(1)))
  const rb = Let(rz.select(u32(0), v.shr(rb1).bitAnd(1)))
  const st = Let(v.bitAnd(u32(1).shl(rb1).sub(1)).ne(u32(0)).select(u32(1), u32(0)))
  return Let(kept.add(rb.bitAnd(st.bitOr(kept.bitAnd(1)))))
}

/** Effective (mantissa, exponent) of f32 bits, denormal-aware:
 *  |value| = m · 2^(E−150), m < 2^24, E ≥ 1. */
const unpackBits = (u: UN): { m: UN; E: UN } => {
  const e = Let(u.shr(23).bitAnd(0xff))
  const frac = Let(u.bitAnd(0x7fffff))
  const den = Let(e.eq(u32(0)))
  return { m: Let(den.select(frac, frac.bitOr(0x800000))), E: Let(den.select(u32(1), e)) }
}

// ── df64_ipack: sign / 24-bit mantissa / exponent(+400) → f32 ──
//
// EsP = exponent-field + 400 (the +400 bias keeps every caller's arithmetic
// unsigned — twoProd grids sit far below field 0). m24's msb is at bit 23
// unless the value underflows. isZero forces a zero with sign zsgn (twoSum's
// exact cancellation is +0 per RNE; a product zero keeps the XOR sign).
const df64_ipack = fn(
  'df64_ipack',
  { sgn: u32T, m24: u32T, EsP: u32T, isZero: u32T, zsgn: u32T },
  (p) => {
    // Gradual underflow: field ≤ 0 → shift mantissa right by 1−field with RNE.
    // 401−EsP wraps for EsP > 401 (normal case) — min() then picks 26, and a
    // 24-bit mantissa RNE-shifted by 26 is 0, so the arm is harmless garbage.
    const dSh = Let(min(u32(401).sub(p.EsP), u32(26)))
    const mDen = rne32(p.m24, dSh)
    const den = Let(p.EsP.le(u32(400)))
    const expF = Let(p.EsP.sub(400))
    const normBits = Let(expF.shl(23).bitOr(p.m24.bitAnd(0x7fffff)))
    // Overflow to ±inf — out-of-scope safety net, unreachable in range.
    const body = Let(den.select(mDen, expF.ge(u32(255)).select(u32(0x7f800000), normBits)))
    const z = Let(p.isZero.eq(u32(1)).or(p.m24.eq(u32(0))))
    const bits = Let(z.select(p.zsgn.shl(31), p.sgn.shl(31).bitOr(body)))
    return bitcastF32(bits)
  },
)

// ── df64_iround: exact 50-bit value → (RNE f32, exact f32 residual) ──
//
// value = ±(H·2^24 + L) · 2^(Gp − 550): H/L are 24-bit limbs (H may carry to
// 2^25 transiently), Gp = grid-exponent + 400 (twoSum: EY + 400; twoProd:
// EA + EB + 250). Returns vec2(s, e) with s = RNE(value) and e = value − s
// EXACTLY (the TwoSum/TwoProd error theorem guarantees e fits an f32).
const df64_iround = fn(
  'df64_iround',
  { H: u32T, L: u32T, Gp: u32T, sgn: u32T, zsgn: u32T },
  (p) => {
    const Vz = Let(p.H.bitOr(p.L).eq(u32(0)).select(u32(1), u32(0)))
    const k = Let(p.H.ne(u32(0)).select(msb32(p.H).add(24), msb32(Let(p.L.bitOr(1)))))
    const big = Let(k.ge(u32(24)))
    // ---- exact path (k ≤ 23: V already fits 24 bits; H = 0) ----
    const shSm = Let(big.select(u32(0), u32(23).sub(k)))
    const mSm = Let(p.L.shl(shSm))
    // ---- rounding path (k ≥ 24) ----
    const r = Let(big.select(k.sub(23), u32(1))) // ∈ [1, 26] when taken
    const rge24 = Let(r.ge(u32(24)))
    const kept = Let(rge24.select(p.H.shr(r.sub(24)), p.H.shl(u32(24).sub(r)).bitOr(p.L.shr(r))))
    const rb1 = Let(r.sub(1)) // ∈ [0, 25]
    const rbBit = Let(
      rb1.ge(u32(24)).select(p.H.shr(rb1.sub(24)).bitAnd(1), p.L.shr(rb1).bitAnd(1)),
    )
    // sticky = any bit below rb1: all of L below min(rb1,24), plus H's bits
    // below rb1−24 when rb1 > 24.
    const stLo = Let(
      p.L.bitAnd(
        u32(1)
          .shl(Let(rb1.ge(u32(24)).select(u32(24), rb1)))
          .sub(1),
      ),
    )
    const stHi = Let(rb1.ge(u32(24)).select(p.H.bitAnd(u32(1).shl(rb1.sub(24)).sub(1)), u32(0)))
    const st = Let(stLo.bitOr(stHi).ne(u32(0)).select(u32(1), u32(0)))
    const inc = Let(rbBit.bitAnd(st.bitOr(kept.bitAnd(1))))
    const mB0 = Let(kept.add(inc))
    const ovf = Let(mB0.shr(24)) // carried to 2^24 → renormalize
    const mBig = Let(ovf.eq(u32(1)).select(u32(0x800000), mB0))
    const kk = Let(k.add(ovf))
    const r2 = Let(kk.sub(23))
    // exact signed residual: err = V − mBig·2^r2, |err| ≤ 2^(r2−1) ≤ 2^25
    const r2ge = Let(r2.ge(u32(24)))
    const bH = Let(r2ge.select(mBig.shl(r2.sub(24)), mBig.shr(u32(24).sub(r2))))
    const bL = Let(r2ge.select(u32(0), mBig.shl(r2).bitAnd(M24)))
    const neg = Let(
      bH
        .gt(p.H)
        .or(bH.eq(p.H).and(bL.gt(p.L)))
        .select(u32(1), u32(0)),
    )
    const AH = Let(neg.eq(u32(1)).select(bH, p.H))
    const AL = Let(neg.eq(u32(1)).select(bL, p.L))
    const BH = Let(neg.eq(u32(1)).select(p.H, bH))
    const BL = Let(neg.eq(u32(1)).select(p.L, bL))
    const bo = Let(AL.lt(BL).select(u32(1), u32(0)))
    const dL = Let(AL.sub(BL).bitAnd(M24))
    const dH = Let(AH.sub(BH).sub(bo))
    const errU = Let(dH.shl(24).bitOr(dL))
    // ---- merge + pack s ----
    const mS = Let(big.select(mBig, mSm))
    const kS = Let(big.select(kk, k))
    const EsP = Let(p.Gp.add(kS).sub(23))
    const s = df64_ipack({ sgn: p.sgn, m24: mS, EsP, isZero: Vz, zsgn: p.zsgn })
    // ---- pack e (zero on the exact path or a zero residual) ----
    const eZ = Let(big.select(errU.eq(u32(0)).select(u32(1), u32(0)), u32(1)))
    const ke = Let(msb32(Let(errU.bitOr(1))))
    const mE = Let(
      ke
        .le(u32(23))
        .select(
          errU.shl(Let(ke.le(u32(23)).select(u32(23).sub(ke), u32(0)))),
          rne32(errU, ke.sub(23)),
        ),
    )
    const EeP = Let(p.Gp.add(ke).sub(23))
    const e = df64_ipack({
      sgn: Let(p.sgn.bitXor(neg)),
      m24: mE,
      EsP: EeP,
      isZero: eZ,
      zsgn: u32(0),
    })
    return vec2(s, e)
  },
)

// ── The EFT primitives, integer-exact ──

/** Exact s + e == a + b: magnitude-order, align (≤ 25-bit shift; larger
 *  separations take the far path where (a, b) already IS the exact pair),
 *  signed 50-bit integer combine, shared RNE round + residual. */
const df64_i_twoSum = fn('df64_twoSum', { a: f32T, b: f32T }, (p) => {
  const ua = Let(bitcastU32(p.a))
  const ub = Let(bitcastU32(p.b))
  const swap = Let(ua.bitAnd(0x7fffffff).lt(Let(ub.bitAnd(0x7fffffff))))
  const uX = Let(swap.select(ub, ua))
  const uY = Let(swap.select(ua, ub))
  const sX = Let(uX.shr(31))
  const sY = Let(uY.shr(31))
  const X = unpackBits(uX)
  const Y = unpackBits(uY)
  const d = Let(X.E.sub(Y.E)) // ≥ 0 (magnitude order ⇒ EX ≥ EY)
  const far = Let(d.gt(u32(25)))
  // near path: SX = mX << d as limbs on Y's grid (d ≤ 25 in the taken arm;
  // the far arm's wrapped shifts are discarded garbage)
  const dge24 = Let(d.ge(u32(24)))
  const hX = Let(dge24.select(X.m.shl(d.sub(24)), X.m.shr(u32(24).sub(d))))
  const lX = Let(dge24.select(u32(0), X.m.shl(d).bitAnd(M24)))
  const diffSign = Let(sX.bitXor(sY))
  // add: V = SX + mY  |  sub: V = SX − mY (≥ 0 since |X| ≥ |Y|)
  const l0 = Let(lX.add(Y.m))
  const addH = Let(hX.add(l0.shr(24)))
  const addL = Let(l0.bitAnd(M24))
  const bo = Let(lX.lt(Y.m).select(u32(1), u32(0)))
  const subH = Let(hX.sub(bo))
  const subL = Let(lX.sub(Y.m).bitAnd(M24))
  const H = Let(diffSign.eq(u32(1)).select(subH, addH))
  const L = Let(diffSign.eq(u32(1)).select(subL, addL))
  const se = Let(df64_iround({ H, L, Gp: Let(Y.E.add(400)), sgn: sX, zsgn: u32(0) }))
  // far path (d ≥ 26): |Y| < ulp(X)/4 → RNE(a+b) = X and the residual is
  // exactly Y — (X, Y) is already the canonical pair.
  return vec2(Let(far.select(bitcastF32(uX), se.x)), Let(far.select(bitcastF32(uY), se.y)))
})

/** Same exact body as twoSum — the |a| ≥ |b| precondition of the float
 *  quickTwoSum is irrelevant when the sum is computed exactly. */
const df64_i_quickTwoSum = fn('df64_quickTwoSum', { a: f32T, b: f32T }, (p) =>
  df64_i_twoSum({ a: p.a, b: p.b }),
)

/** Exact p + e == a · b: 24×24 → 48-bit integer product (12-bit halves — the
 *  probe-proven prodQ core), shared RNE round + residual. */
const df64_i_twoProd = fn('df64_twoProd', { a: f32T, b: f32T }, (p) => {
  const ua = Let(bitcastU32(p.a))
  const ub = Let(bitcastU32(p.b))
  const sP = Let(ua.bitXor(ub).shr(31))
  const A = unpackBits(ua)
  const B = unpackBits(ub)
  const aH = Let(A.m.shr(12))
  const aL = Let(A.m.bitAnd(0xfff))
  const bH = Let(B.m.shr(12))
  const bL = Let(B.m.bitAnd(0xfff))
  const c0 = Let(aL.mul(bL))
  const c1 = Let(aH.mul(bL).add(aL.mul(bH)))
  const c2 = Let(aH.mul(bH))
  const ploRaw = Let(c0.add(c1.bitAnd(0xfff).shl(12)))
  const H = Let(c2.add(c1.shr(12)).add(ploRaw.shr(24))) // product < 2^48 ⇒ fits
  const L = Let(ploRaw.bitAnd(M24))
  // value = mA·mB · 2^(EA−150+EB−150) = V · 2^((EA+EB−150)−150) → Gp = EA+EB+250
  return df64_iround({ H, L, Gp: Let(A.E.add(B.E).add(250)), sgn: sP, zsgn: sP })
})

/** p + e == a², via the exact product. */
const df64_i_twoSqr = fn('df64_twoSqr', { a: f32T }, (p) => df64_i_twoProd({ a: p.a, b: p.a }))

// ── div / sqrt: the float bodies minus the `one` guard ──
//
// Their seeds are single approximate float ops (one rcp / one rsqrt) whose
// error the caller corrects through df64_sub / df64_mul — which now bottom out
// in the EXACT integer primitives, so no guard is needed anywhere. The by-name
// composition calls (df64_sub / df64_mul / df64_add / df64_twoProd / df64_twoSqr)
// resolve inside the integer registry.

const df64_i_div = fn('df64_div', { a: vec2fT, b: vec2fT }, (p) => {
  const xn = Let(f32(1.0).div(p.b.x))
  const yn = Let(p.a.mul(xn))
  const diff = Let(DF64_CALLS.sub({ a: p.a, b: DF64_CALLS.mul({ a: p.b, b: yn }) }).x)
  const prod = Let(df64_i_twoProd({ a: xn, b: diff }))
  return DF64_CALLS.add({ a: yn, b: prod })
})

const df64_i_sqrt = fn(
  'df64_sqrt',
  { a: vec2fT },
  (p) => {
    const x = Let(f32(1.0).div(sqrt(p.a.x)))
    const yn = Let(p.a.x.mul(x))
    const ynSqr = Let(df64_i_twoSqr({ a: yn }))
    const diff = Let(DF64_CALLS.sub({ a: p.a, b: ynSqr }).x)
    const prod = Let(df64_i_twoProd({ a: x.mul(0.5), b: diff }))
    const res = Let(DF64_CALLS.add({ a: vec2(yn, 0.0), b: prod }))
    return p.a.x.eq(0.0).select(vec2(0.0, 0.0), res)
  },
  { lintDisable: ['no-float-eq'] }, // exact ==0 zero-guard, same as the float body
)

// ── Vector twins: per-lane scalar calls (integer ops are scalar; the float
// whole-plane EFT elegance does not translate, so each lane routes through the
// verified scalar primitive and the planes gather the components — the same
// pattern df64-lib's vAbs/vMin/… already use). The vec COMPOSITIONS
// (df64_vN_add/sub/mul) are shared and bind to these by name. ──

const VEC_F32_T = { 2: vec2fT, 3: vec3fT, 4: vec4fT } as const

function defVecIntHelpers(n: 2 | 3 | 4): FuncDecl[] {
  const vT: ShaderType = VEC_F32_T[n]
  const sT = structT(`DF64Vec${n}`)
  const LANES = 'xyzw'.slice(0, n).split('')
  type P = ReadonlyNode<'vec2<f32>'>
  const scalarLane = (x: ReadonlyNode, c: string): FN => member(x, c, f32T) as FN
  const pairLane = (x: ReadonlyNode, c: string): P =>
    vec2(member(member(x, 'hi', vT), c, f32T), member(member(x, 'lo', vT), c, f32T)) as P
  const gather = (ls: readonly ReadonlyNode[]): ReturnType<typeof construct> =>
    construct(sT, [
      construct(
        vT,
        ls.map((l) => member(l, 'x', f32T)),
      ),
      construct(
        vT,
        ls.map((l) => member(l, 'y', f32T)),
      ),
    ])

  const twoSum = fn(`df64_v${n}_twoSum`, { a: vT, b: vT }, (p) =>
    gather(LANES.map((c) => Let(df64_i_twoSum({ a: scalarLane(p.a, c), b: scalarLane(p.b, c) })))),
  )
  const quickTwoSum = fn(`df64_v${n}_quickTwoSum`, { a: vT, b: vT }, (p) =>
    gather(LANES.map((c) => Let(df64_i_twoSum({ a: scalarLane(p.a, c), b: scalarLane(p.b, c) })))),
  )
  const twoProd = fn(`df64_v${n}_twoProd`, { a: vT, b: vT }, (p) =>
    gather(LANES.map((c) => Let(df64_i_twoProd({ a: scalarLane(p.a, c), b: scalarLane(p.b, c) })))),
  )
  const div = fn(`df64_v${n}_div`, { a: sT, b: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_i_div({ a: pairLane(p.a, c), b: pairLane(p.b, c) })))),
  )
  return [twoSum.decl, quickTwoSum.decl, twoProd.decl, div.decl]
}

// ── Registry: the float registry with the primitive leaves swapped ──

const OVERRIDES: readonly FuncDecl[] = [
  df64_i_twoSum.decl,
  df64_i_quickTwoSum.decl,
  df64_i_twoProd.decl,
  df64_i_twoSqr.decl,
  df64_i_div.decl,
  df64_i_sqrt.decl,
  ...defVecIntHelpers(2),
  ...defVecIntHelpers(3),
  ...defVecIntHelpers(4),
]

const INT_MAP = new Map<string, FuncDecl>(DF64_FNS)
for (const d of OVERRIDES) INT_MAP.set(d.name, d)
INT_MAP.set(df64_ipack.decl.name, df64_ipack.decl)
INT_MAP.set(df64_iround.decl.name, df64_iround.decl)

export const DF64_FNS_INT: ReadonlyMap<string, FuncDecl> = INT_MAP

/** Injection order: the two integer-only helpers FIRST (every primitive calls
 *  them — GLSL needs define-before-use), then the float order with the swapped
 *  decls in place. Byte-stable, dependency-first, same as the float registry. */
export const DF64_ORDER_INT: readonly FuncDecl[] = [
  df64_ipack.decl,
  df64_iround.decl,
  ...DF64_ORDER.map((d) => INT_MAP.get(d.name) ?? d),
]
