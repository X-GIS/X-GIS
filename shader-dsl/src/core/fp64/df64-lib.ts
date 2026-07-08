// ═══ Shader DSL — df64 (double-float) emulation library ═══
//
// The two-f32 emulated-double arithmetic the fp64-lower pass (passes/
// fp64-lower.ts) rewrites f64-typed IR into. An f64 value is an unevaluated
// (hi, lo) pair carried as a vec2<f32> — x = hi, y = lo, |lo| ≤ ulp(hi)/2 —
// giving ~48 significand bits at f32 exponent range.
//
// Lineage: DSFUN90 (D. H. Bailey) → the NVIDIA CUDA SDK Mandelbrot sample's
// dsadd/dsmul → Thall, "Extended-Precision Floating-Point Numbers for GPU
// Computation" (twoSum / quickTwoSum / Veltkamp split / twoProd) → luma.gl's
// fp64 GLSL module, whose GUARDED formulation these bodies mirror.
//
// ── The ONE guard (why every body threads a runtime-opaque `one`) ──
// The error-free transformations below are algebraically trivial (e.g.
// `e = b - (s - a)` is 0 in real arithmetic). WGSL §15.7.5 explicitly PERMITS
// reassociation/fusion, Metal defaults to fast-math, and ANGLE's D3D compiler
// reassociates — any of which folds the error terms away and silently
// collapses df64 to f32 precision. Neither WGSL nor GLSL ES 3.00 has a
// `precise` qualifier. The portable defense (luma.gl's
// LUMA_FP64_CODE_ELIMINATION_WORKAROUND lineage) is a runtime-opaque ONE
// (value 1.0) multiplied through the EFT intermediates, so no compiler can
// cancel them at compile time. The value is fetched from a 1×1 TEXTURE (the
// `f64Guard` intrinsic → textureLoad/texelFetch on the injected `_fp64`
// binding), NOT a uniform: uniforms are defeated by drivers that SPECIALIZE
// pipelines on observed uniform values and hot-swap background-reoptimized
// variants (seen in the field on Windows/NVIDIA — the f64 half alternated
// with an f32-collapsed rendering mid-session); no driver constant-folds
// texel values. The binding is AUTO-INJECTED by fp64Lower into any module
// that uses these helpers (pin its slot with `fp64Guard()` when an engine's
// bind-group layout demands it); the host MUST bind a 1×1 texture whose texel
// reads back exactly 1.0 (e.g. RGBA8 255 or R32F 1.0).
// FMA-based twoProd is deliberately NOT used — WGSL fma()'s accuracy is
// "inherited from x*y+z" (fusion not guaranteed).
//
// These fns are injected into a module by fp64-lower (never listed by
// authors); the `df64_` name prefix is reserved (SD0043). Their bodies are
// ordinary IR, but the emit optimizer must keep the calls OPAQUE — see the
// `df64_` skip in passes/auto-inline.ts.

import {
  fn,
  Let,
  Var,
  vec2,
  sqrt,
  floor,
  member,
  construct,
  structT,
  f32T,
  vec2fT,
  vec3fT,
  vec4fT,
  texture2dfT,
  f64GuardOne,
  type Node,
  type ReadonlyNode,
  type StructDecl,
  type BindingDecl,
  type FuncDecl,
  type ShaderType,
} from '../ir'

// ── Host-side split (the packing twin of the shader emulation) ──

/** Split a JS double into its (hi, lo) f32 pair — the value a df64 uniform /
 *  attribute / literal carries on the GPU. hi = f32(x), lo = f32(x − hi);
 *  hi + lo reconstructs x to ~48 significand bits. Same convention as the
 *  tiler's ECEF DSFUN packing (compiler/src/tiler/ecef-packing.ts). */
export function splitF64(x: number): [hi: number, lo: number] {
  const hi = Math.fround(x)
  const lo = Math.fround(x - hi)
  return [hi, lo]
}

// ── The anti-fast-math guard texture ──

export const FP64_GUARD_NAME = '_fp64'
/** The guard binding's type: a 1×1 2D texture whose only texel reads 1.0. */
export const FP64_GUARD_TYPE: ShaderType = texture2dfT

export interface Fp64GuardHandle {
  readonly type: ShaderType
  readonly binding: BindingDecl
}

/** OPTIONAL pin for the fp64 guard texture's slot. A module that uses f64
 *  arithmetic gets a `texture_2d<f32>` binding named `_fp64` AUTO-INJECTED by
 *  fp64Lower (deterministically at group 0, first free binding) — authors
 *  declare NOTHING for the default. Use this declarator in
 *  `module({ uses: [...] })` only to pin the (group, binding) to an engine's
 *  fixed bind-group layout. Either way the binding shows up in reflect() as an
 *  ordinary 2D texture, and the host MUST bind a 1×1 texture whose texel
 *  reads back exactly 1.0 (RGBA8 white / R32F 1.0) — the value is
 *  semantically 1.0; it lives in a texture only so downstream shader
 *  compilers can never treat it as a compile-time constant (see the file
 *  header). */
export function fp64Guard(at: { group: number; binding: number }): Fp64GuardHandle {
  return {
    type: FP64_GUARD_TYPE,
    binding: {
      group: at.group,
      binding: at.binding,
      name: FP64_GUARD_NAME,
      space: 'uniform',
      type: FP64_GUARD_TYPE,
    },
  }
}

/** The runtime-opaque 1.0 every helper body threads through its EFT terms —
 *  the `f64Guard` intrinsic (a texel fetch on the GPU, exactly 1 on the CPU
 *  oracle). One shared node; the emit CSE hoists a single fetch per body. */
const one = f64GuardOne() as ReadonlyNode<'f32'>

// ── Error-free transformation primitives ──

/** Knuth two-sum: s + e == a + b exactly, no magnitude precondition. */
const df64_twoSum = fn('df64_twoSum', { a: f32T, b: f32T }, (p) => {
  const s = Let(p.a.add(p.b))
  const v = Let(s.mul(one).sub(p.a).mul(one))
  const e = Let(p.a.sub(s.sub(v).mul(one)).mul(one).mul(one).mul(one).add(p.b.sub(v)))
  return vec2(s, e)
})

/** Dekker fast-two-sum: requires |a| ≥ |b| (renormalization step). */
const df64_quickTwoSum = fn('df64_quickTwoSum', { a: f32T, b: f32T }, (p) => {
  const s = Let(p.a.add(p.b).mul(one))
  const e = Let(p.b.sub(s.sub(p.a).mul(one)))
  return vec2(s, e)
})

/** Veltkamp split by 4097 = 2¹² + 1: a == hi + lo with 12-bit hi, 11-bit lo.
 *  The split constant reaches the shader as `4097 * one` so it can never be
 *  folded. Overflows for |a| > ~2¹¹⁵ (out of geographic range). */
const df64_split = fn('df64_split', { a: f32T }, (p) => {
  const t = Let(p.a.mul(one.mul(4097.0)))
  const hi = Let(t.mul(one).sub(t.sub(p.a)))
  const lo = Let(p.a.mul(one).sub(hi))
  return vec2(hi, lo)
})

/** Split-based two-product: p + e == a * b exactly. (Not FMA-based — see header.) */
const df64_twoProd = fn('df64_twoProd', { a: f32T, b: f32T }, (p) => {
  const prod = Let(p.a.mul(p.b))
  const aS = Let(df64_split({ a: p.a }))
  const bS = Let(df64_split({ a: p.b }))
  const e = Let(
    aS.x.mul(bS.x).sub(prod).add(aS.x.mul(bS.y)).add(aS.y.mul(bS.x)).add(aS.y.mul(bS.y)),
  )
  return vec2(prod, e)
})

/** Two-square: p + e == a * a exactly (the twoProd special case sqrt uses). */
const df64_twoSqr = fn('df64_twoSqr', { a: f32T }, (p) => {
  const prod = Let(p.a.mul(p.a))
  const aS = Let(df64_split({ a: p.a }))
  const e = Let(
    aS.x
      .mul(aS.x)
      .sub(prod)
      .mul(one)
      .add(aS.x.mul(aS.y).mul(2.0).mul(one).mul(one))
      .add(aS.y.mul(aS.y).mul(one).mul(one).mul(one)),
  )
  return vec2(prod, e)
})

// ── df64 arithmetic ──

/** Launder a df64 pair through the guard at helper ENTRY. A uniform-sourced df64
 *  (a packed coordinate, a widened f32) otherwise enters an EFT as a compile-time
 *  constant the driver can specialize on — it then const-folds a catastrophic hi
 *  cancellation (twoSum's `a+b`) and drops the surviving lo-word signal. Observed
 *  on Apple GPUs (iOS 18 / Safari): `sub` of a uniform df64 collapsed to 0 while
 *  the byte-identical `add` of a COMPUTED operand survived — same helper body, so
 *  the leak is at the operand, not the algorithm. Multiplying every component by
 *  the opaque texel `one` (value 1) makes the operand data-dependent, so the
 *  cancellation can no longer be folded. Value-exact: one == 1 on GPU and oracle. */
const launder = (v: ReadonlyNode<'vec2<f32>'>): Node<'vec2<f32>'> =>
  vec2(v.x.mul(one), v.y.mul(one))

/** a + b (Thall/QD-style accurate add: two twoSums + double renormalization). */
const df64_add = fn('df64_add', { a: vec2fT, b: vec2fT }, (p) => {
  const a = Let(launder(p.a))
  const b = Let(launder(p.b))
  const s = Var(df64_twoSum({ a: a.x, b: b.x }))
  const t = Let(df64_twoSum({ a: a.y, b: b.y }))
  s.y.assign(s.y.add(t.x))
  s.assign(df64_quickTwoSum({ a: s.x, b: s.y }))
  s.y.assign(s.y.add(t.y))
  s.assign(df64_quickTwoSum({ a: s.x, b: s.y }))
  return s
})

/** a − b == a + (−b); componentwise negation of a df64 pair is exact. */
const df64_sub = fn('df64_sub', { a: vec2fT, b: vec2fT }, (p) => df64_add({ a: p.a, b: p.b.neg() }))

/** a × b: twoProd of the hi words + cross terms + renormalize. */
const df64_mul = fn('df64_mul', { a: vec2fT, b: vec2fT }, (p) => {
  const a = Let(launder(p.a))
  const b = Let(launder(p.b))
  const prod = Var(df64_twoProd({ a: a.x, b: b.x }))
  prod.y.assign(prod.y.add(a.x.mul(b.y)))
  prod.y.assign(prod.y.add(a.y.mul(b.x)))
  return df64_quickTwoSum({ a: prod.x, b: prod.y })
})

/** a ÷ b: f32-reciprocal seed + one Newton-Raphson correction (luma.gl form). */
const df64_div = fn('df64_div', { a: vec2fT, b: vec2fT }, (p) => {
  const xn = Let(one.div(p.b.x))
  const yn = Let(p.a.mul(xn))
  const diff = Let(df64_sub({ a: p.a, b: df64_mul({ a: p.b, b: yn }) }).x)
  const prod = Let(df64_twoProd({ a: xn, b: diff }))
  return df64_add({ a: yn, b: prod })
})

/** √a: f32 rsqrt seed + one Newton-Raphson correction; √0 = 0 exactly.
 *  a < 0 is a domain error (NaN/indeterminate, as with native sqrt). */
const df64_sqrt = fn(
  'df64_sqrt',
  { a: vec2fT },
  (p) => {
    const x = Let(one.div(sqrt(p.a.x)))
    const yn = Let(p.a.x.mul(x))
    const ynSqr = Let(df64_twoSqr({ a: yn }).mul(one))
    const diff = Let(df64_sub({ a: p.a, b: ynSqr }).x)
    const prod = Let(df64_twoProd({ a: x.mul(0.5), b: diff }))
    const res = Let(df64_add({ a: vec2(yn, 0.0), b: prod }))
    return p.a.x.eq(0.0).select(vec2(0.0, 0.0), res)
  },
  { lintDisable: ['no-float-eq'] }, // exact ==0 zero-guard, not a tolerance bug
)

// ── Comparisons (lexicographic: hi decides, lo breaks ties) ──
// The float `==` on the hi/lo words is EXACT pair comparison, not an epsilon
// bug — hence the documented no-float-eq deviations.

const df64_lt = fn(
  'df64_lt',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.lt(p.b.x).or(p.a.x.eq(p.b.x).and(p.a.y.lt(p.b.y))),
  { lintDisable: ['no-float-eq'] },
)
const df64_gt = fn(
  'df64_gt',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.gt(p.b.x).or(p.a.x.eq(p.b.x).and(p.a.y.gt(p.b.y))),
  { lintDisable: ['no-float-eq'] },
)
const df64_le = fn(
  'df64_le',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.lt(p.b.x).or(p.a.x.eq(p.b.x).and(p.a.y.le(p.b.y))),
  { lintDisable: ['no-float-eq'] },
)
const df64_ge = fn(
  'df64_ge',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.gt(p.b.x).or(p.a.x.eq(p.b.x).and(p.a.y.ge(p.b.y))),
  { lintDisable: ['no-float-eq'] },
)
const df64_eq = fn(
  'df64_eq',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.eq(p.b.x).and(p.a.y.eq(p.b.y)),
  { lintDisable: ['no-float-eq'] },
)
const df64_ne = fn(
  'df64_ne',
  { a: vec2fT, b: vec2fT },
  (p) => p.a.x.ne(p.b.x).or(p.a.y.ne(p.b.y)),
  { lintDisable: ['no-float-eq'] },
)

// ── Componentwise / selection builtins ──

/** |a| — sign decided by hi (a normalized pair with hi = 0 has lo = 0). */
const df64_abs = fn('df64_abs', { a: vec2fT }, (p) => p.a.x.lt(0.0).select(p.a.neg(), p.a))

const df64_min = fn('df64_min', { a: vec2fT, b: vec2fT }, (p) =>
  df64_lt({ a: p.a, b: p.b }).select(p.a, p.b),
)
const df64_max = fn('df64_max', { a: vec2fT, b: vec2fT }, (p) =>
  df64_gt({ a: p.a, b: p.b }).select(p.a, p.b),
)

/** mix(a, b, t) == a + (b − a)·t; the interpolant t stays f32 (widened exactly). */
const df64_mix = fn('df64_mix', { a: vec2fT, b: vec2fT, t: f32T }, (p) =>
  df64_add({ a: p.a, b: df64_mul({ a: df64_sub({ a: p.b, b: p.a }), b: vec2(p.t, 0.0) }) }),
)

/** ⌊a⌋ — floor(hi); when hi is already integral the lo word decides. */
const df64_floor = fn(
  'df64_floor',
  { a: vec2fT },
  (p) => {
    const fhi = Let(floor(p.a.x))
    return fhi.eq(p.a.x).select(df64_quickTwoSum({ a: fhi, b: floor(p.a.y) }), vec2(fhi, 0.0))
  },
  { lintDisable: ['no-float-eq'] }, // exact integrality test, not a tolerance bug
)

/** fract(a) == a − ⌊a⌋. */
const df64_fract = fn('df64_fract', { a: vec2fT }, (p) =>
  df64_sub({ a: p.a, b: df64_floor({ a: p.a }) }),
)

// ── Conversions ──

/** The EXPLICIT precision-losing narrow: f64 → f32 as hi + lo. (The widen
 *  f32 → f64 needs no helper — fp64-lower emits `vec2<f32>(x, 0.0)`.) */
const df64_narrow = fn('df64_narrow', { a: vec2fT }, (p) => p.a.x.add(p.a.y))

// ── Vectorized df64 (vecN<f64> — the DF64VecN hi/lo-plane form) ──
//
// The EFTs are valid PER LANE, so the vector arithmetic runs the exact scalar
// formulas on whole vecN hi/lo planes (one twoSum for all lanes — no unroll).
// A vecN<f64> value lowers to `struct DF64VecN { hi: vecN<f32>, lo: vecN<f32> }`;
// these helpers take/return that struct. dot/length/distance are NOT here —
// they need cross-lane accumulation and are composed from the SCALAR df64 fns
// by the lowering pass (numerically the standard approach anyway).

const VEC_F32_T = { 2: vec2fT, 3: vec3fT, 4: vec4fT } as const

/** DF64VecN struct decls, keyed by lane count — injected by fp64-lower
 *  alongside the helpers whenever a module carries a vecN<f64>. */
export const DF64_VEC_STRUCTS: ReadonlyMap<2 | 3 | 4, StructDecl> = new Map(
  ([2, 3, 4] as const).map((n) => [
    n,
    {
      name: `DF64Vec${n}`,
      fields: [
        { name: 'hi', type: VEC_F32_T[n] },
        { name: 'lo', type: VEC_F32_T[n] },
      ],
    },
  ]),
)

function defVecHelpers(n: 2 | 3 | 4): FuncDecl[] {
  const vT: ShaderType = VEC_F32_T[n]
  const sT = structT(`DF64Vec${n}`)
  // INTERNAL type-level pinning: the bodies are width-generic (every op is
  // componentwise / a scalar broadcast), but a union-keyed node defeats the
  // method overloads — pin the phantom key to one width; the RUNTIME type is
  // always the true vT carried by the param/member exprs.
  type V = ReadonlyNode<'vec2<f32>'>
  const asV = (x: ReadonlyNode): V => x as unknown as V
  const pair = (hi: ReadonlyNode, lo: ReadonlyNode): Node => construct(sT, [hi, lo])
  const hi = (x: ReadonlyNode): V => asV(member(x, 'hi', vT))
  const lo = (x: ReadonlyNode): V => asV(member(x, 'lo', vT))

  // The scalar EFT formulas verbatim, on vecN operands (broadcast `* one`).
  const twoSum = fn(`df64_v${n}_twoSum`, { a: vT, b: vT }, (raw) => {
    const [a, b] = [asV(raw.a), asV(raw.b)]
    const s = Let(a.add(b))
    const v = Let(s.mul(one).sub(a).mul(one))
    const e = Let(a.sub(s.sub(v).mul(one)).mul(one).mul(one).mul(one).add(b.sub(v)))
    return pair(s, e)
  })
  const quickTwoSum = fn(`df64_v${n}_quickTwoSum`, { a: vT, b: vT }, (raw) => {
    const [a, b] = [asV(raw.a), asV(raw.b)]
    const s = Let(a.add(b).mul(one))
    const e = Let(b.sub(s.sub(a).mul(one)))
    return pair(s, e)
  })
  const split = fn(`df64_v${n}_split`, { a: vT }, (raw) => {
    const a = asV(raw.a)
    const t = Let(a.mul(one.mul(4097.0)))
    const h = Let(t.mul(one).sub(t.sub(a)))
    const l = Let(a.mul(one).sub(h))
    return pair(h, l)
  })
  const twoProd = fn(`df64_v${n}_twoProd`, { a: vT, b: vT }, (raw) => {
    const [a, b] = [asV(raw.a), asV(raw.b)]
    const prod = Let(a.mul(b))
    const aS = Let(split({ a }))
    const bS = Let(split({ a: b }))
    const e = Let(
      hi(aS)
        .mul(hi(bS))
        .sub(prod)
        .add(hi(aS).mul(lo(bS)))
        .add(lo(aS).mul(hi(bS)))
        .add(lo(aS).mul(lo(bS))),
    )
    return pair(prod, e)
  })
  const add = fn(`df64_v${n}_add`, { a: sT, b: sT }, (p) => {
    const s1 = Let(twoSum({ a: hi(p.a), b: hi(p.b) }))
    const t = Let(twoSum({ a: lo(p.a), b: lo(p.b) }))
    const s2 = Let(lo(s1).add(hi(t)))
    const r1 = Let(quickTwoSum({ a: hi(s1), b: s2 }))
    const s3 = Let(lo(r1).add(lo(t)))
    return quickTwoSum({ a: hi(r1), b: s3 })
  })
  const sub = fn(`df64_v${n}_sub`, { a: sT, b: sT }, (p) =>
    add({ a: p.a, b: pair(hi(p.b).neg(), lo(p.b).neg()) }),
  )
  const mul = fn(`df64_v${n}_mul`, { a: sT, b: sT }, (p) => {
    const p0 = Let(twoProd({ a: hi(p.a), b: hi(p.b) }))
    const py = Let(
      lo(p0)
        .add(hi(p.a).mul(lo(p.b)))
        .add(lo(p.a).mul(hi(p.b))),
    )
    return quickTwoSum({ a: hi(p0), b: py })
  })
  const div = fn(`df64_v${n}_div`, { a: sT, b: sT }, (p) => {
    const xn = Let(one.div(hi(p.b)))
    const yn = Let(pair(hi(p.a).mul(xn), lo(p.a).mul(xn)))
    const diff = Let(hi(sub({ a: p.a, b: mul({ a: p.b, b: yn }) })))
    const prod = Let(twoProd({ a: xn, b: diff }))
    return add({ a: yn, b: prod })
  })

  // ── Componentwise builtins with PER-LANE branching ──
  // abs/min/max select a side per lane and floor's integrality test is per
  // lane, so there is no whole-plane EFT form without a per-lane select
  // (which neither WGSL-via-this-IR nor GLSL ES 3.00 gives us). Instead each
  // helper composes the VERIFIED scalar df64 fns lane by lane INSIDE its own
  // body: the struct argument is a param (evaluated once at the call), each
  // lane result is Let-bound once, and the planes gather the components.
  const LANES = 'xyzw'.slice(0, n).split('')
  type P = ReadonlyNode<'vec2<f32>'>
  const laneOf = (x: ReadonlyNode, c: string): P =>
    vec2(member(member(x, 'hi', vT), c, f32T), member(member(x, 'lo', vT), c, f32T)) as P
  const gather = (ls: readonly ReadonlyNode[]): Node =>
    pair(
      construct(
        vT,
        ls.map((l) => member(l, 'x', f32T)),
      ),
      construct(
        vT,
        ls.map((l) => member(l, 'y', f32T)),
      ),
    )

  const vAbs = fn(`df64_v${n}_abs`, { a: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_abs({ a: laneOf(p.a, c) })))),
  )
  const vMin = fn(`df64_v${n}_min`, { a: sT, b: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_min({ a: laneOf(p.a, c), b: laneOf(p.b, c) })))),
  )
  const vMax = fn(`df64_v${n}_max`, { a: sT, b: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_max({ a: laneOf(p.a, c), b: laneOf(p.b, c) })))),
  )
  const vMix = fn(`df64_v${n}_mix`, { a: sT, b: sT, t: f32T }, (p) =>
    gather(LANES.map((c) => Let(df64_mix({ a: laneOf(p.a, c), b: laneOf(p.b, c), t: p.t })))),
  )
  const vFloor = fn(`df64_v${n}_floor`, { a: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_floor({ a: laneOf(p.a, c) })))),
  )
  const vFract = fn(`df64_v${n}_fract`, { a: sT }, (p) =>
    gather(LANES.map((c) => Let(df64_fract({ a: laneOf(p.a, c) })))),
  )
  /** v / |v| — the length accumulates through the SCALAR df64 chain (the same
   *  composition the lowering uses for length()), then each lane divides by it. */
  const vNormalize = fn(`df64_v${n}_normalize`, { a: sT }, (p) => {
    const ls = LANES.map((c) => Let(laneOf(p.a, c)))
    let sq = df64_mul({ a: ls[0]!, b: ls[0]! })
    for (let i = 1; i < n; i++) sq = df64_add({ a: sq, b: df64_mul({ a: ls[i]!, b: ls[i]! }) })
    const len = Let(df64_sqrt({ a: sq }))
    return gather(ls.map((l) => Let(df64_div({ a: l, b: len }))))
  })

  return [
    twoSum.decl,
    quickTwoSum.decl,
    split.decl,
    twoProd.decl,
    add.decl,
    sub.decl,
    mul.decl,
    div.decl,
    vAbs.decl,
    vMin.decl,
    vMax.decl,
    vMix.decl,
    vFloor.decl,
    vFract.decl,
    vNormalize.decl,
  ]
}

// ── Matrix df64 (matNxN<f64> — the DF64MatN column-struct form) ──
//
// A matNxN<f64> lowers to `struct DF64MatN { c0..c(N-1): DF64VecN }` (columns,
// matching GPU column-major). mat·vec / matmul / transpose are the textbook
// linear-algebra compositions of the SCALAR df64 EFTs — result lane i = Σⱼ
// M[i][j] ⊗ v[j], each ⊗/⊕ a df64 twoProd/twoSum — the same extended-precision
// accumulation dot()/length() use, so no new numerics, only new shapes.

/** DF64MatN struct decls, keyed by dimension — injected by fp64-lower alongside
 *  the mat helpers (and the DF64VecN structs they nest). */
export const DF64_MAT_STRUCTS: ReadonlyMap<2 | 3 | 4, StructDecl> = new Map(
  ([2, 3, 4] as const).map((n) => [
    n,
    {
      name: `DF64Mat${n}`,
      fields: Array.from({ length: n }, (_, j) => ({
        name: `c${j}`,
        type: structT(`DF64Vec${n}`),
      })),
    },
  ]),
)

function defMatHelpers(n: 2 | 3 | 4): FuncDecl[] {
  const mT = structT(`DF64Mat${n}`)
  const vT = structT(`DF64Vec${n}`)
  const vecFT: ShaderType = VEC_F32_T[n]
  const LANES = 'xyzw'.slice(0, n).split('')
  type P = ReadonlyNode<'vec2<f32>'>
  const col = (m: ReadonlyNode, j: number): Node => member(m, `c${j}`, vT)
  // lane c of a DF64VecN → the df64 scalar (hi.c, lo.c).
  const laneOf = (v: ReadonlyNode, c: string): P =>
    vec2(member(member(v, 'hi', vecFT), c, f32T), member(member(v, 'lo', vecFT), c, f32T)) as P
  const gatherVec = (ls: readonly ReadonlyNode[]): Node =>
    construct(vT, [
      construct(
        vecFT,
        ls.map((l) => member(l, 'x', f32T)),
      ),
      construct(
        vecFT,
        ls.map((l) => member(l, 'y', f32T)),
      ),
    ])

  // M·v : result lane i = Σⱼ (column j, lane i) ⊗ v[j], accumulated in df64.
  const matVec = fn(`df64_m${n}_matvec`, { m: mT, v: vT }, (p) => {
    const cols = LANES.map((_, j) => Let(col(p.m, j)))
    const vl = LANES.map((c) => Let(laneOf(p.v, c)))
    const out = LANES.map((ci) => {
      let acc: P = df64_mul({ a: laneOf(cols[0]!, ci), b: vl[0]! })
      for (let j = 1; j < n; j++)
        acc = df64_add({ a: acc, b: df64_mul({ a: laneOf(cols[j]!, ci), b: vl[j]! }) })
      return Let(acc)
    })
    return gatherVec(out)
  })
  // A·B : each result column = A · (the matching column of B).
  const matMul = fn(`df64_m${n}_matmul`, { a: mT, b: mT }, (p) =>
    construct(
      mT,
      LANES.map((_, k) => Let(matVec({ m: p.a, v: col(p.b, k) }))),
    ),
  )
  // Mᵀ : new column i gathers lane i of every old column.
  const transpose = fn(`df64_m${n}_transpose`, { m: mT }, (p) =>
    construct(
      mT,
      LANES.map((_, i) => gatherVec(LANES.map((_, j) => Let(laneOf(col(p.m, j), LANES[i]!))))),
    ),
  )
  return [matVec.decl, matMul.decl, transpose.decl]
}

// ── Registry (the fp64-lower pass's injection SoT) ──

/** Every emulation fn, in the FIXED dependency-first order they are appended
 *  to a lowered module — primitives first, then arithmetic, then the rest —
 *  so the emitted helper section is byte-stable across modules and GLSL's
 *  define-before-use holds without forward declarations. */
export const DF64_ORDER: readonly FuncDecl[] = [
  df64_twoSum.decl,
  df64_quickTwoSum.decl,
  df64_split.decl,
  df64_twoProd.decl,
  df64_twoSqr.decl,
  df64_add.decl,
  df64_sub.decl,
  df64_mul.decl,
  df64_div.decl,
  df64_sqrt.decl,
  df64_lt.decl,
  df64_gt.decl,
  df64_le.decl,
  df64_ge.decl,
  df64_eq.decl,
  df64_ne.decl,
  df64_abs.decl,
  df64_min.decl,
  df64_max.decl,
  df64_mix.decl,
  df64_floor.decl,
  df64_fract.decl,
  df64_narrow.decl,
  ...defVecHelpers(2),
  ...defVecHelpers(3),
  ...defVecHelpers(4),
  ...defMatHelpers(2),
  ...defMatHelpers(3),
  ...defMatHelpers(4),
]

/** name → FuncDecl for the lowering pass's used-set closure. */
export const DF64_FNS: ReadonlyMap<string, FuncDecl> = new Map(DF64_ORDER.map((d) => [d.name, d]))
