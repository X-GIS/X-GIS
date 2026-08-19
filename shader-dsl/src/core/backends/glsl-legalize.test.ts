// ═══ GLSL ES 3.00 legalize — discarding-call ctor-arg hoist (#1840) ═══
//
// ANGLE's D3D11 backend miscompiles a GLSL ES 3.00 fragment shader whose STRUCT
// constructor argument contains a call to a function that (transitively) executes
// `discard`. COMPILE_STATUS and LINK_STATUS both report success; the shader dies at the
// FIRST DRAW. A named local for the same value (`vec4 c = inner(v); return Out(c);` —
// #1840's case B) is sufficient, and that is what glsl-legalize.ts synthesises.
//
// The assertions are on the EMITTED TEXT because the emitted text is what the driver
// reads. Two arms guard the two ways this could go wrong: the NEGATIVE suites pin the
// blast radius (a non-discarding callee, a VECTOR ctor, and a guarded position are all
// left byte-identical — the #1840 repro table has C/E/F passing on D3D11, so hoisting
// them would be churn for nothing), and the oracle arm pins that the hoist does not
// change a single value.
//
// Fixtures are authored through the real DSL surface (fn / ioStruct / structDecl /
// If+Discard), not hand-built IR: the bug is reachable from ordinary authoring, and a
// hand-built module could not prove that.

import { describe, it, expect } from 'vitest'
import { emitGlslModule, emitGlslStages, emitModule, compileModule } from '@xgis/shader-dsl'
import { vec4fT, f32T } from '@xgis/shader-dsl'
import {
  fn,
  module as dslModule,
  ioStruct,
  structDecl,
  builtin,
  location,
  vec4,
  If,
  Discard,
  Let,
} from '@xgis/shader-dsl'
import { inline } from '@xgis/shader-dsl/emit-prod'
import { hoistDiscardingCtorArgs, transitivelyDiscardingFns } from './glsl-legalize.js'

// Every balanced `Name(...)` span in `text` for each ctor name — the exact spans ANGLE
// miscompiles when one of them contains a discarding call. A `toContain` on one hand-picked
// spelling only rules out the spelling it names; this rules out the SHAPE, anywhere.
function ctorSpans(text: string, names: readonly string[]): string[] {
  const spans: string[] = []
  for (const n of names) {
    for (let i = text.indexOf(`${n}(`); i >= 0; i = text.indexOf(`${n}(`, i + 1)) {
      let depth = 0
      let j = i + n.length
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++
        else if (text[j] === ')' && --depth === 0) {
          j++
          break
        }
      }
      spans.push(text.slice(i, j))
    }
  }
  return spans
}

// The one fixture shape used by several suites: a helper that discards below zero.
const discardingHelper = (name: string) =>
  fn(name, { v: f32T }, ({ v }) => {
    If(v.lt(0), () => {
      Discard()
    })
    return vec4(v, v, v, 1)
  })

// ── case A — the discarding call IS the sole struct-ctor argument (the shipped
//    fs_line_pattern shape, minimised) ──
const OutA = ioStruct('OutA', { color: location(0, vec4fT) })
const helperA = discardingHelper('helper_a')
const fsA = fn(
  'fs_a',
  { pos: builtin('position', vec4fT) },
  OutA.type,
  ({ pos }) => OutA.construct({ color: helperA(pos.x) }),
  { stage: 'fragment' },
)
const modA = dslModule({ uses: [OutA], funcs: [helperA, fsA] })

describe('glsl-legalize — direct discarding call as a struct ctor arg (#1840 case A)', () => {
  it('hoists the argument into a named local before the return', () => {
    const g = emitGlslModule(modA, 'fragment')
    expect(g).toContain('vec4 _dh0 = helper_a(pos.x);')
    expect(g).toContain('return OutA(_dh0);')
  })

  it('leaves NO struct ctor spelling the discarding call inline', () => {
    const g = emitGlslModule(modA, 'fragment')
    expect(g).not.toContain('OutA(helper_a(')
    expect(ctorSpans(g, ['OutA']).filter((s) => s.includes('helper_a('))).toEqual([])
  })
})

// ── transitive — the ctor arg calls a WRAPPER whose callee discards ──
describe('glsl-legalize — transitively discarding callee', () => {
  const OutB = ioStruct('OutB', { color: location(0, vec4fT) })
  const fDisc = discardingHelper('f_disc')
  const gWrap = fn('g_wrap', { v: f32T }, ({ v }) => fDisc(v))
  const fsB = fn(
    'fs_b',
    { pos: builtin('position', vec4fT) },
    OutB.type,
    ({ pos }) => OutB.construct({ color: gWrap(pos.x) }),
    { stage: 'fragment' },
  )
  const modB = dslModule({ uses: [OutB], funcs: [fDisc, gWrap, fsB] })

  it('the analysis admits the wrapper AND its caller', () => {
    expect([...transitivelyDiscardingFns(modB)].sort()).toEqual(['f_disc', 'fs_b', 'g_wrap'])
  })

  it('hoists the wrapper call out of the ctor', () => {
    const g = emitGlslModule(modB, 'fragment')
    expect(g).toContain('vec4 _dh0 = g_wrap(pos.x);')
    expect(g).toContain('return OutB(_dh0);')
  })

  // inline() runs in the IR-plugin stage, AFTER this pass, and substitutes single-return
  // wrappers at their call sites. A NON-transitive analysis would wave `OutB(g_wrap(x))`
  // through and inline() would rebuild the miscompiled shape — in production builds only.
  it('survives the inline() plugin rebuilding the call site', () => {
    const g = emitGlslModule(modB, 'fragment', { plugins: [inline()] })
    expect(g).toContain('vec4 _dh0 = f_disc(pos.x);')
    expect(g).not.toContain('g_wrap') // the wrapper is gone — the hoist is not
    expect(ctorSpans(g, ['OutB']).filter((s) => s.includes('f_disc('))).toEqual([])
  })
})

// ── deep nesting — the ctor arg CONTAINS the call inside a larger expression ──
describe('glsl-legalize — discarding call nested inside the ctor argument', () => {
  const OutC = ioStruct('OutC', { color: location(0, vec4fT) })
  const helperC = discardingHelper('helper_c')
  const fsC = fn(
    'fs_c',
    { pos: builtin('position', vec4fT) },
    OutC.type,
    ({ pos }) => OutC.construct({ color: vec4(helperC(pos.x).x.mul(2), 0, 0, 1) }),
    { stage: 'fragment' },
  )
  const modC = dslModule({ uses: [OutC], funcs: [helperC, fsC] })

  it('hoists the WHOLE argument, leaving the call inside a legal vector ctor', () => {
    const g = emitGlslModule(modC, 'fragment')
    expect(g).toContain('vec4 _dh0 = vec4((helper_c(pos.x).x * 2.0), 0.0, 0.0, 1.0);')
    expect(g).toContain('return OutC(_dh0);')
    expect(ctorSpans(g, ['OutC']).filter((s) => s.includes('helper_c('))).toEqual([])
  })
})

// ── nested struct ctor (#1840 case D) — only the INNERMOST offending arg hoists ──
describe('glsl-legalize — nested struct constructors', () => {
  const InnerD = structDecl('InnerD', { c: vec4fT })
  const OutD = ioStruct('OutD', { color: location(0, vec4fT) })
  const helperD = discardingHelper('helper_d')
  const mkD = fn('mk_d', { v: f32T }, InnerD.type, ({ v }) => InnerD.construct({ c: helperD(v) }))
  const fsD = fn(
    'fs_d',
    { pos: builtin('position', vec4fT) },
    OutD.type,
    ({ pos }) => OutD.construct({ color: InnerD.of(mkD(pos.x)).c }),
    { stage: 'fragment' },
  )
  const modD = dslModule({ uses: [OutD, InnerD], funcs: [helperD, mkD, fsD] })

  it('binds the inner argument and leaves the inner ctor holding a local', () => {
    const g = emitGlslModule(modD, 'fragment')
    expect(g).toContain('vec4 _dh0 = helper_d(v);')
    expect(g).toContain('return InnerD(_dh0);')
  })

  it('leaves NO struct ctor anywhere holding a call to a discarding fn', () => {
    const g = emitGlslModule(modD, 'fragment')
    const offending = ctorSpans(g, ['InnerD', 'OutD']).filter(
      (s) => s.includes('helper_d(') || s.includes('mk_d('),
    )
    expect(offending).toEqual([])
  })
})

// ── multi-field ctor (#1840 case G) — only the offending argument moves ──
describe('glsl-legalize — multi-field struct ctor', () => {
  const OutG = ioStruct('OutG', { a: location(0, vec4fT), b: location(1, vec4fT) })
  const helperG = discardingHelper('helper_g')
  const fsG = fn(
    'fs_g',
    { pos: builtin('position', vec4fT) },
    OutG.type,
    ({ pos }) => OutG.construct({ a: helperG(pos.x), b: vec4(1, 1, 1, 1) }),
    { stage: 'fragment' },
  )
  const modG = dslModule({ uses: [OutG], funcs: [helperG, fsG] })

  it('hoists ONLY the argument carrying the discarding call', () => {
    const g = emitGlslModule(modG, 'fragment')
    expect(g).toContain('vec4 _dh0 = helper_g(pos.x);')
    expect(g).toContain('return OutG(_dh0, vec4(1.0, 1.0, 1.0, 1.0));')
    expect(g).not.toContain('_dh1')
  })
})

// ── over-reach guards — the three shapes #1840 measured as PASSING on D3D11 ──
describe('glsl-legalize — leaves the shapes that do not trip ANGLE alone', () => {
  it('a NON-discarding callee in a struct ctor arg is untouched', () => {
    const OutN = ioStruct('OutN', { color: location(0, vec4fT) })
    const plain = fn('helper_n', { v: f32T }, ({ v }) => vec4(v, v, v, 1))
    // A discarding fn IS present in the module (so the pass is active, not short-circuited
    // by the empty-set fast path) — it just does not feed the constructor.
    const kill = fn('helper_nd', { v: f32T }, ({ v }) => {
      If(v.lt(0), () => {
        Discard()
      })
      return v
    })
    const fsN = fn(
      'fs_n',
      { pos: builtin('position', vec4fT) },
      OutN.type,
      ({ pos }) => {
        const k = Let(kill(pos.y))
        return OutN.construct({ color: plain(pos.x.add(k)) })
      },
      { stage: 'fragment' },
    )
    const g = emitGlslModule(dslModule({ uses: [OutN], funcs: [plain, kill, fsN] }), 'fragment')
    expect(g).toContain('helper_nd(pos.y)') // the pass ran over a discarding module …
    expect(g).toContain('return OutN(helper_n(') // … and left this ctor exactly as emitted
    expect(g).not.toContain('_dh')
  })

  it('a VECTOR ctor around a discarding call is untouched (#1840 cases C/E)', () => {
    const helperE = fn('helper_e', { v: f32T }, ({ v }) => {
      If(v.lt(0), () => {
        Discard()
      })
      return v.mul(2)
    })
    const fsE = fn(
      'fs_e',
      { pos: builtin('position', vec4fT) },
      ({ pos }) => vec4(helperE(pos.x), 0, 0, 1),
      { stage: 'fragment', retAttr: location(0, vec4fT) },
    )
    const g = emitGlslModule(dslModule({ funcs: [helperE, fsE] }), 'fragment')
    expect(g).toContain('return vec4(helper_e(pos.x), 0.0, 0.0, 1.0);')
    expect(g).not.toContain('_dh')
  })

  // DOCUMENTED UNDER-FIX. GLSL spells `select` as a short-circuiting ternary, so hoisting an
  // arm would make a CONDITIONAL discard unconditional — strictly worse than the bug. The
  // guarded ctor therefore keeps its inline call, and the emitted bytes do not move.
  it('a struct ctor inside a select ARM is left inline (guarded position)', () => {
    const GuardedS = structDecl('GuardedS', { c: vec4fT })
    const OutS = ioStruct('OutS', { color: location(0, vec4fT) })
    const helperS = discardingHelper('helper_s')
    const pickS = fn('pick_s', { v: f32T }, GuardedS.type, ({ v }) =>
      v
        .gt(0)
        .select(GuardedS.construct({ c: helperS(v) }), GuardedS.construct({ c: vec4(0, 0, 0, 1) })),
    )
    const fsS = fn(
      'fs_s',
      { pos: builtin('position', vec4fT) },
      OutS.type,
      ({ pos }) => {
        const g = Let(pickS(pos.x))
        return OutS.construct({ color: GuardedS.of(g).c })
      },
      { stage: 'fragment' },
    )
    const g = emitGlslModule(
      dslModule({ uses: [OutS, GuardedS], funcs: [helperS, pickS, fsS] }),
      'fragment',
    )
    expect(g).toContain('((v > 0.0) ? GuardedS(helper_s(v)) : GuardedS(vec4(0.0, 0.0, 0.0, 1.0)))')
    expect(g).not.toContain('_dh')
  })
})

// ── stage scoping — the hoisted local's TYPE must still reach the emitted declarations ──
describe('glsl-legalize — a hoisted local of struct type keeps its declaration in scope', () => {
  const InnerT = structDecl('InnerT', { c: vec4fT })
  const OuterT = structDecl('OuterT', { inner: InnerT.type })
  const mkInner = fn('make_inner', { v: f32T }, InnerT.type, ({ v }) => {
    If(v.lt(0), () => {
      Discard()
    })
    return InnerT.construct({ c: vec4(v, v, v, 1) })
  })
  const mkOuter = fn('make_outer', { v: f32T }, OuterT.type, ({ v }) =>
    OuterT.construct({ inner: mkInner(v) }),
  )
  const fsT = fn(
    'fs_t',
    { pos: builtin('position', vec4fT) },
    ({ pos }) => InnerT.of(OuterT.of(mkOuter(pos.x)).inner).c,
    { stage: 'fragment', retAttr: location(0, vec4fT) },
  )
  const modT = dslModule({ uses: [InnerT, OuterT], funcs: [mkInner, mkOuter, fsT] })

  it('declares the inner struct the hoisted local is typed by', () => {
    const g = emitGlslModule(modT, 'fragment')
    expect(g).toContain('InnerT _dh0 = make_inner(v);')
    expect(g).toContain('return OuterT(_dh0);')
    expect(g).toContain('struct InnerT {')
    expect(g).toContain('struct OuterT {')
  })
})

// ── WGSL is untouched — the bug is ANGLE/D3D11's, and the WGSL corpus is byte-gated ──
describe('glsl-legalize — WGSL emit is byte-untouched', () => {
  it('keeps the inline call in the struct ctor and mints no local', () => {
    const w = emitModule(modA)
    expect(w).toContain('return OutA(helper_a(pos.x));')
    expect(w).not.toContain('_dh')
  })
})

// ── determinism — one lowering feeds both stages; two emits are the same bytes ──
describe('glsl-legalize — deterministic across emits and across the stages entry', () => {
  it('emits identical fragment bytes twice, and agrees with emitGlslStages', () => {
    const once = emitGlslModule(modA, 'fragment')
    expect(emitGlslModule(modA, 'fragment')).toBe(once)
    expect(emitGlslStages(modA).fragment).toBe(once)
  })
})

// ── VALUE preservation — a hoist that moved a value would be worse than the bug ──
describe('glsl-legalize — CPU oracle differential across the hoist', () => {
  const OutO = ioStruct('OutO', { color: location(0, vec4fT) })
  const helperO = discardingHelper('helper_o')
  const mkO = fn('mk_o', { v: f32T }, OutO.type, ({ v }) => OutO.construct({ color: helperO(v) }))
  const modO = dslModule({ uses: [OutO], funcs: [helperO, mkO] })
  const hoisted = hoistDiscardingCtorArgs(modO)

  it('actually rewrites the fixture (so the differential below is not vacuous)', () => {
    expect([...transitivelyDiscardingFns(modO)].sort()).toEqual(['helper_o', 'mk_o'])
    expect(modO.funcs.find((f) => f.name === 'mk_o')!.body).toHaveLength(1)
    expect(hoisted.funcs.find((f) => f.name === 'mk_o')!.body).toHaveLength(2)
  })

  it('produces identical values on BOTH sides of the discard threshold', () => {
    const before = compileModule(modO)
    const after = compileModule(hoisted)
    // above the threshold — a real struct value, field-for-field identical
    expect(after.fns.mk_o(2)).toEqual({ color: [2, 2, 2, 1] })
    expect(after.fns.mk_o(2)).toEqual(before.fns.mk_o(2))
    // below it — the interpreter's discard signal surfaces as an undefined field on both
    expect((before.fns.mk_o(-1) as Record<string, unknown>).color).toBeUndefined()
    expect(after.fns.mk_o(-1)).toEqual(before.fns.mk_o(-1))
  })
})
