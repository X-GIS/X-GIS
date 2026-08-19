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
// POSITION fixtures are authored through the real DSL surface (fn / ioStruct / structDecl /
// If+Discard+Switch+Loop), not hand-built IR: the bug is reachable from ordinary authoring,
// and a hand-built module could not prove that. The CALL-GRAPH suite is the one exception —
// it feeds `transitivelyDiscardingFns` hand-built modules (mutual recursion, an unresolvable
// callee, an UNCALLED discarding fn) precisely because the optimizer's `dce-fns` would delete
// those shapes before a real emit ever reached the analysis.

import { describe, it, expect } from 'vitest'
import { emitGlslModule, emitGlslStages, emitModule, compileModule } from '@xgis/shader-dsl'
import { vec4fT, f32T, boolT, arrayT, structT } from '@xgis/shader-dsl'
import type { Expr, FuncDecl, ModuleDecl, ReadonlyNode, Stmt } from '@xgis/shader-dsl'
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
  Loop,
  Switch,
  toI32,
  Var,
} from '@xgis/shader-dsl'
import { inline, obfuscate } from '@xgis/shader-dsl/emit-prod'
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
    expect(g).toContain('OutA _out = OutA(_dh0);')
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
    expect(g).toContain('OutB _out = OutB(_dh0);')
  })

  // inline() substitutes single-return wrappers at their call sites. It now runs BEFORE
  // this pass (the IR-plugin stage precedes legalization), so what this pins is the pass
  // seeing the REBUILT shape and hoisting the substituted callee — and transitivity still
  // covers the wrappers inline() declines to inline, and every wrapper in a plugin-free
  // build.
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
    expect(g).toContain('OutC _out = OutC(_dh0);')
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
    expect(g).toContain('OutG _out = OutG(_dh0, vec4(1.0, 1.0, 1.0, 1.0));')
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
    expect(g).toContain('OutN _out = OutN(helper_n(') // … and left this ctor exactly as emitted
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
    expect(g).toContain('_ret = vec4(helper_e(pos.x), 0.0, 0.0, 1.0);')
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

// ═══ #1840 owner review — the invariant is now stated over EVERY unconditionally
//     evaluated position, control-flow HEADERS included, over the FINAL IR ═══
//
// "After legalization, no unconditionally-evaluated struct-constructor argument contains a
// (transitively) discarding call." The suites below pin each position the sentence covers
// (an expression nested in a call arg / a binop / an index; an `if` arm-0 condition; a
// `switch` scrutinee; a `for` init) and each position it deliberately does NOT (an
// `else if` condition, the `for` cond/update, a `select` arm — the last one is the
// pre-existing guarded-position suite above).

// ── nested EXPRESSION positions — a ctor reached through a call arg / binop / index ──
describe('glsl-legalize — the ctor is reached through a nested expression position', () => {
  it('hoists inside a ctor passed as a CALL argument', () => {
    const OutK = ioStruct('OutK', { color: location(0, vec4fT) })
    const BoxK = structDecl('BoxK', { c: vec4fT })
    const helperK = discardingHelper('helper_k')
    const takeK = fn('take_k', { b: BoxK.type }, vec4fT, ({ b }) => BoxK.of(b).c)
    const fsK = fn(
      'fs_k',
      { pos: builtin('position', vec4fT) },
      OutK.type,
      ({ pos }) => OutK.construct({ color: takeK(BoxK.construct({ c: helperK(pos.x) })) }),
      { stage: 'fragment' },
    )
    const g = emitGlslModule(
      dslModule({ uses: [OutK, BoxK], funcs: [helperK, takeK, fsK] }),
      'fragment',
    )
    expect(g).toContain('vec4 _dh0 = helper_k(pos.x);')
    expect(g).toContain('OutK _out = OutK(take_k(BoxK(_dh0)));')
    expect(ctorSpans(g, ['OutK', 'BoxK']).filter((s) => s.includes('helper_k('))).toEqual([])
  })

  it('hoists the WHOLE argument when the call sits inside a compound binop', () => {
    const OutBin = ioStruct('OutBin', { color: location(0, vec4fT) })
    const helperBin = discardingHelper('helper_bin')
    const fsBin = fn(
      'fs_bin',
      { pos: builtin('position', vec4fT) },
      OutBin.type,
      ({ pos }) =>
        OutBin.construct({
          color: helperBin(pos.x)
            .mul(2)
            .add(vec4(0, 0, 0, 1)),
        }),
      { stage: 'fragment' },
    )
    const g = emitGlslModule(dslModule({ uses: [OutBin], funcs: [helperBin, fsBin] }), 'fragment')
    expect(g).toContain('vec4 _dh0 = ((helper_bin(pos.x) * 2.0) + vec4(0.0, 0.0, 0.0, 1.0));')
    expect(g).toContain('OutBin _out = OutBin(_dh0);')
    expect(ctorSpans(g, ['OutBin']).filter((s) => s.includes('helper_bin('))).toEqual([])
  })

  it('hoists an argument whose discarding call is the INDEX expression', () => {
    const OutX = ioStruct('OutX', { color: location(0, vec4fT) })
    const helperX = fn('helper_x', { v: f32T }, ({ v }) => {
      If(v.lt(0), () => {
        Discard()
      })
      return v.mul(2)
    })
    const fsX = fn(
      'fs_x',
      { pos: builtin('position', vec4fT) },
      OutX.type,
      ({ pos }) => {
        const lut = Var('lut', arrayT(vec4fT, 4))
        lut.at(0, vec4fT).assign(vec4(1, 0, 0, 1))
        lut.at(1, vec4fT).assign(vec4(0, 1, 0, 1))
        return OutX.construct({ color: lut.at(toI32(helperX(pos.x)), vec4fT) })
      },
      { stage: 'fragment' },
    )
    const g = emitGlslModule(dslModule({ uses: [OutX], funcs: [helperX, fsX] }), 'fragment')
    expect(g).toContain('vec4 _dh0 = lut[int(helper_x(pos.x))];')
    expect(g).toContain('OutX _out = OutX(_dh0);')
    expect(ctorSpans(g, ['OutX']).filter((s) => s.includes('helper_x('))).toEqual([])
  })
})

// ── `if` arm 0 is UNCONDITIONALLY evaluated; `else if` is not ──
describe('glsl-legalize — if conditions', () => {
  const GateI = structDecl('GateI', { c: vec4fT })
  const OutI = ioStruct('OutI', { color: location(0, vec4fT) })
  const helperI = discardingHelper('helper_i')
  const gateExpr = (x: ReadonlyNode<'f32'>) =>
    GateI.of(GateI.construct({ c: helperI(x) })).c.x.gt(0)

  const fsI = fn(
    'fs_i',
    { pos: builtin('position', vec4fT) },
    OutI.type,
    ({ pos }) => {
      const acc = Var(vec4(0, 0, 0, 1))
      If(gateExpr(pos.x), () => {
        acc.assign(vec4(1, 1, 1, 1))
      })
      return OutI.construct({ color: acc })
    },
    { stage: 'fragment' },
  )
  const modI = dslModule({ uses: [OutI, GateI], funcs: [helperI, fsI] })

  it('hoists the ctor argument to a local declared BEFORE the if', () => {
    const g = emitGlslModule(modI, 'fragment')
    expect(g).toContain('vec4 _dh0 = helper_i(pos.x);')
    expect(g).toContain('if ((GateI(_dh0).c.x > 0.0)) {')
    expect(ctorSpans(g, ['GateI']).filter((s) => s.includes('helper_i('))).toEqual([])
  })

  // DOCUMENTED UNDER-FIX. An `else if` condition runs only when every prior condition was
  // false; a hoist before the `if` would evaluate it — and its discard — unconditionally.
  it('leaves an ELSE-IF condition inline (guarded position)', () => {
    const fsJ = fn(
      'fs_j',
      { pos: builtin('position', vec4fT) },
      OutI.type,
      ({ pos }) => {
        const acc = Var(vec4(0, 0, 0, 1))
        If(pos.y.gt(0), () => {
          acc.assign(vec4(1, 0, 0, 1))
        }).elif(gateExpr(pos.x), () => {
          acc.assign(vec4(0, 1, 0, 1))
        })
        return OutI.construct({ color: acc })
      },
      { stage: 'fragment' },
    )
    const g = emitGlslModule(dslModule({ uses: [OutI, GateI], funcs: [helperI, fsJ] }), 'fragment')
    expect(g).toContain('} else if ((GateI(helper_i(pos.x)).c.x > 0.0)) {')
    expect(g).not.toContain('_dh')
  })
})

// ── a `switch` scrutinee is evaluated whenever the switch executes ──
describe('glsl-legalize — switch scrutinee', () => {
  const GateW = structDecl('GateW', { c: vec4fT })
  const OutW = ioStruct('OutW', { color: location(0, vec4fT) })
  const helperW = discardingHelper('helper_w')
  const fsW = fn(
    'fs_w',
    { pos: builtin('position', vec4fT) },
    OutW.type,
    ({ pos }) => {
      const acc = Var('acc', vec4(0, 0, 0, 1))
      Switch(toI32(GateW.of(GateW.construct({ c: helperW(pos.x) })).c.x))
        .case(0, () => {
          acc.assign(vec4(1, 0, 0, 1))
        })
        .default(() => {
          acc.assign(vec4(0, 1, 0, 1))
        })
      return OutW.construct({ color: acc })
    },
    { stage: 'fragment' },
  )

  it('hoists the ctor argument to a local declared BEFORE the switch', () => {
    const g = emitGlslModule(dslModule({ uses: [OutW, GateW], funcs: [helperW, fsW] }), 'fragment')
    expect(g).toContain('vec4 _dh0 = helper_w(pos.x);')
    expect(g).toContain('switch (int(GateW(_dh0).c.x)) {')
    expect(ctorSpans(g, ['GateW']).filter((s) => s.includes('helper_w('))).toEqual([])
  })
})

// ── a `for` INIT runs exactly once, before the loop; cond/update run per iteration ──
describe('glsl-legalize — for-loop init', () => {
  const GateF = structDecl('GateF', { c: vec4fT })
  const OutF = ioStruct('OutF', { color: location(0, vec4fT) })
  const helperF = discardingHelper('helper_f')
  const fsF = fn(
    'fs_f',
    { pos: builtin('position', vec4fT) },
    OutF.type,
    ({ pos }) => {
      const acc = Var('acc', vec4(0, 0, 0, 1))
      Loop(
        toI32(GateF.of(GateF.construct({ c: helperF(pos.x) })).c.x),
        (i) => i.lt(4),
        () => {
          acc.assign(acc.add(vec4(1, 0, 0, 0)))
        },
      )
      return OutF.construct({ color: acc })
    },
    { stage: 'fragment' },
  )

  it('hoists the init ctor argument to a local declared BEFORE the for', () => {
    const g = emitGlslModule(dslModule({ uses: [OutF, GateF], funcs: [helperF, fsF] }), 'fragment')
    expect(g).toContain('vec4 _dh0 = helper_f(pos.x);')
    expect(g).toMatch(/vec4 _dh0 = helper_f\(pos\.x\);\n\s*for \(int \w+ = int\(GateF\(_dh0\)/)
    expect(ctorSpans(g, ['GateF']).filter((s) => s.includes('helper_f('))).toEqual([])
  })
})

// ── the transitive analysis is a fixed point over the call graph, and it is CONSERVATIVE
//    in exactly one direction: a name it cannot resolve to a module fn is non-discarding ──
describe('glsl-legalize — transitivelyDiscardingFns over hand-built call graphs', () => {
  const noArgCall = (fnName: string): Expr => ({ op: 'call', type: f32T, fn: fnName, args: [] })
  const zero: Expr = { op: 'lit', type: f32T, value: 0 }
  const irFn = (name: string, body: readonly Stmt[]): FuncDecl => ({
    name,
    params: [],
    ret: f32T,
    body,
  })
  const irMod = (...funcs: FuncDecl[]): ModuleDecl => ({
    consts: [],
    structs: [],
    bindings: [],
    funcs,
  })

  it('admits BOTH sides of a mutual recursion when one of them discards', () => {
    const m = irMod(
      irFn('m_a', [{ s: 'return', expr: noArgCall('m_b') }]),
      irFn('m_b', [{ s: 'discard' }, { s: 'return', expr: noArgCall('m_a') }]),
    )
    // Terminating at all is half the assertion: the fixed point iterates until no function
    // is newly admitted, so a cycle cannot spin.
    expect([...transitivelyDiscardingFns(m)].sort()).toEqual(['m_a', 'm_b'])
  })

  it('admits every link of a 3-level wrapper chain', () => {
    const m = irMod(
      irFn('w_d', [{ s: 'discard' }, { s: 'return', expr: zero }]),
      irFn('w_1', [{ s: 'return', expr: noArgCall('w_d') }]),
      irFn('w_2', [{ s: 'return', expr: noArgCall('w_1') }]),
      irFn('w_3', [{ s: 'return', expr: noArgCall('w_2') }]),
    )
    expect([...transitivelyDiscardingFns(m)].sort()).toEqual(['w_1', 'w_2', 'w_3', 'w_d'])
  })

  it('does NOT admit a callee that is no module function (intrinsic / extern / df64)', () => {
    const m = irMod(
      irFn('i_d', [{ s: 'discard' }, { s: 'return', expr: zero }]),
      irFn('i_user', [{ s: 'return', expr: noArgCall('sqrt') }]),
    )
    expect([...transitivelyDiscardingFns(m)]).toEqual(['i_d'])
  })

  it('leaves a ctor argument built only from such calls untouched', () => {
    const S = structT('SI')
    const m = irMod(irFn('i_d', [{ s: 'discard' }, { s: 'return', expr: zero }]), {
      name: 'i_mk',
      params: [],
      ret: S,
      body: [
        {
          s: 'return',
          expr: { op: 'construct', type: S, args: [noArgCall('sqrt')] },
        },
      ],
    })
    // The pass IS active (the discarding set is non-empty) — it simply finds nothing to move.
    expect(transitivelyDiscardingFns(m).size).toBe(1)
    expect(hoistDiscardingCtorArgs(m).funcs.find((f) => f.name === 'i_mk')!.body).toEqual(
      m.funcs.find((f) => f.name === 'i_mk')!.body,
    )
  })

  it('admits an UNCALLED discarding fn, and still hoists nothing in its non-callers', () => {
    const S = structT('SU')
    const m = irMod(
      irFn('orphan_d', [{ s: 'discard' }, { s: 'return', expr: zero }]),
      irFn('plain', [{ s: 'return', expr: zero }]),
      {
        name: 'u_mk',
        params: [],
        ret: S,
        body: [{ s: 'return', expr: { op: 'construct', type: S, args: [noArgCall('plain')] } }],
      },
    )
    expect([...transitivelyDiscardingFns(m)]).toEqual(['orphan_d'])
    expect(hoistDiscardingCtorArgs(m).funcs.find((f) => f.name === 'u_mk')!.body).toEqual(
      m.funcs.find((f) => f.name === 'u_mk')!.body,
    )
  })

  it('admits only the JOIN caller, never the clean sibling it also calls', () => {
    const m = irMod(
      irFn('j_d', [{ s: 'discard' }, { s: 'return', expr: zero }]),
      irFn('j_clean', [{ s: 'return', expr: zero }]),
      irFn('j_caller', [
        { s: 'let', name: 'a', expr: noArgCall('j_d') },
        { s: 'return', expr: noArgCall('j_clean') },
      ]),
    )
    expect([...transitivelyDiscardingFns(m)].sort()).toEqual(['j_caller', 'j_d'])
  })
})

// ── SHORT-CIRCUIT nodes are HALF unconditional: `&&`/`||` evaluate their LHS always and
//    their RHS only if the LHS did not decide; a `select` evaluates its COND always and
//    each arm only if chosen. The unconditional half is legalised, the guarded half is not ──
describe('glsl-legalize — logical (&&) operands', () => {
  const GateL = structDecl('GateL', { c: vec4fT })
  const helperL = discardingHelper('helper_l')
  const gateL = (v: ReadonlyNode<'f32'>) => GateL.of(GateL.construct({ c: helperL(v) })).c.x.gt(0)
  // LHS-offending and RHS-offending probes, same signature — the ONLY difference between the
  // two suites below, so the pair isolates the short-circuit split and nothing else.
  const lhsL = fn('lhs_l', { v: f32T }, boolT, ({ v }) => gateL(v).and(v.gt(0)))
  const rhsL = fn('rhs_l', { v: f32T }, boolT, ({ v }) => v.gt(0).and(gateL(v)))
  const mkMod = (probe: typeof lhsL) =>
    dslModule({
      uses: [GateL],
      funcs: [
        helperL,
        probe,
        fn(
          'fs_l',
          { pos: builtin('position', vec4fT) },
          ({ pos }) => probe(pos.x).select(vec4(1, 1, 1, 1), vec4(0, 0, 0, 1)),
          { stage: 'fragment', retAttr: location(0, vec4fT) },
        ),
      ],
    })

  it('hoists out of the LHS of && (unconditionally evaluated)', () => {
    const g = emitGlslModule(mkMod(lhsL), 'fragment')
    expect(g).toContain('vec4 _dh0 = helper_l(v);')
    expect(g).toContain('return ((GateL(_dh0).c.x > 0.0) && (v > 0.0));')
    expect(ctorSpans(g, ['GateL']).filter((s) => s.includes('helper_l('))).toEqual([])
  })

  // DOCUMENTED UNDER-FIX (the negative twin that keeps the positive above non-vacuous):
  // the RHS runs only when the LHS did not short-circuit, so hoisting it would make a
  // conditional discard unconditional.
  it('leaves the RHS of && inline (short-circuit guarded)', () => {
    const g = emitGlslModule(mkMod(rhsL), 'fragment')
    expect(g).toContain('return ((v > 0.0) && (GateL(helper_l(v)).c.x > 0.0));')
    expect(g).not.toContain('_dh')
  })
})

describe('glsl-legalize — select condition', () => {
  const GateC = structDecl('GateC', { c: vec4fT })
  const helperSc = discardingHelper('helper_sc')
  const pickSc = fn('pick_sc', { v: f32T }, vec4fT, ({ v }) =>
    GateC.of(GateC.construct({ c: helperSc(v) }))
      .c.x.gt(0)
      .select(vec4(1, 0, 0, 1), vec4(0, 1, 0, 1)),
  )
  const fsSc = fn('fs_sc', { pos: builtin('position', vec4fT) }, ({ pos }) => pickSc(pos.x), {
    stage: 'fragment',
    retAttr: location(0, vec4fT),
  })

  // The ARM twin — a ctor inside a select arm stays inline — is the guarded-position suite
  // above ('a struct ctor inside a select ARM is left inline').
  it('hoists out of a select CONDITION (unconditionally evaluated)', () => {
    const g = emitGlslModule(
      dslModule({ uses: [GateC], funcs: [helperSc, pickSc, fsSc] }),
      'fragment',
    )
    expect(g).toContain('vec4 _dh0 = helper_sc(v);')
    expect(g).toContain(
      'return ((GateC(_dh0).c.x > 0.0) ? vec4(1.0, 0.0, 0.0, 1.0) : vec4(0.0, 1.0, 0.0, 1.0));',
    )
    expect(ctorSpans(g, ['GateC']).filter((s) => s.includes('helper_sc('))).toEqual([])
  })
})

// ── an assignment TARGET is not a value, but the INDEX subexpressions inside it are:
//    ordinary r-values, evaluated once and unconditionally when the assignment runs ──
describe('glsl-legalize — assignment target index expressions', () => {
  const GateT = structDecl('GateT', { c: vec4fT })
  const OutT2 = ioStruct('OutT2', { color: location(0, vec4fT) })
  const helperAt = discardingHelper('helper_at')
  const fsAt = fn(
    'fs_at',
    { pos: builtin('position', vec4fT) },
    OutT2.type,
    ({ pos }) => {
      const lut = Var('lut', arrayT(vec4fT, 4))
      lut
        .at(toI32(GateT.of(GateT.construct({ c: helperAt(pos.x) })).c.x), vec4fT)
        .assign(vec4(1, 0, 0, 1))
      return OutT2.construct({ color: lut.at(0, vec4fT) })
    },
    { stage: 'fragment' },
  )

  it('hoists out of an lvalue INDEX, leaving the target a legal lvalue', () => {
    const g = emitGlslModule(
      dslModule({ uses: [OutT2, GateT], funcs: [helperAt, fsAt] }),
      'fragment',
    )
    expect(g).toContain('vec4 _dh0 = helper_at(pos.x);')
    expect(g).toContain('lut[int(GateT(_dh0).c.x)] = vec4(1.0, 0.0, 0.0, 1.0);')
    expect(ctorSpans(g, ['GateT']).filter((s) => s.includes('helper_at('))).toEqual([])
  })

  // No conditional sibling to pin here — the guard is that a target with NO index is left
  // exactly as emitted, i.e. the walk never turns a member chain into a temp (that would
  // stop it being an lvalue at all).
  it('leaves a plain member-chain target byte-untouched', () => {
    const BoxN = structDecl('BoxN', { c: vec4fT })
    const helperN = discardingHelper('helper_mt')
    const mkN = fn('mk_mt', { v: f32T }, BoxN.type, ({ v }) => {
      const o = BoxN.var('o')
      o.c.assign(helperN(v))
      return o.$
    })
    const fsN = fn(
      'fs_mt',
      { pos: builtin('position', vec4fT) },
      ({ pos }) => BoxN.of(mkN(pos.x)).c,
      {
        stage: 'fragment',
        retAttr: location(0, vec4fT),
      },
    )
    const g = emitGlslModule(dslModule({ uses: [BoxN], funcs: [helperN, mkN, fsN] }), 'fragment')
    expect(g).toContain('o.c = helper_mt(v);')
    expect(g).not.toContain('_dh')
  })
})

// ── ORDERING — the pass is the LAST IR step, so the full production plugin stack cannot
//    reintroduce the shape, and the `_dhN` names it mints are past mangle's reach ──
describe('glsl-legalize — runs after the whole IR plugin stack', () => {
  it('keeps the hoist through obfuscate(), with `_dh0` unmangled as the ctor argument', () => {
    const renames = new Map<string, string>()
    const g = emitGlslModule(modA, 'fragment', { plugins: obfuscate({ renames }) })
    // `_dh0` survives verbatim: mangle renames every local it sees, so a `_dh0` in the
    // OUTPUT can only have been minted after mangle already ran.
    expect(g).toContain('_dh0')
    expect(g).toMatch(/\w+\(_dh0\)/) // …and it IS the struct ctor's argument
    // …and no ctor anywhere holds the (now mangled) discarding call.
    const ctor = renames.get('OutA')!
    const call = renames.get('helper_a')!
    expect(ctor).toBeDefined()
    expect(call).toBeDefined()
    expect(ctorSpans(g, [ctor]).filter((s) => s.includes(`${call}(`))).toEqual([])
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
