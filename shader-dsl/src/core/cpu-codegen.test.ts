// ═══ compileModuleJs — differential + microbench gate (#1162) ═══
//
// GATE A1 (keystone): the js-source backend is BIT-IDENTICAL to the tree-walk
// interpreter over the SAME IR. Every fn below is swept over seeded-random +
// boundary inputs and asserted Object.is-equal (per element) between
// compileModuleJs(m).fns.f and compileModule(m).fns.f. Same op tree ⇒ bit-equal;
// any epsilon means the codegen diverged. Constructs the PROJECTION_MODULE does
// NOT use (for / switch / matchExpr / struct / array-index / assignOp / discard /
// break / continue / overrides / bit-ops) are hand-built here so the codegen's
// every branch is gated; the map package gates the real projection graph.
//
// GATE A2: a microbench (logged, not asserted) — N=100k calls of a representative
// vector fn, interpreter vs codegen.

import { describe, it, expect } from 'vitest'
import type { Expr, Stmt, ModuleDecl, ShaderType, BinOp, CmpOp } from './ir'
import { f32T, i32T, u32T, boolT, vec2fT, vec3fT, vec4fT, structT, arrayT } from './ir'
import { compileModule } from './oracle'
import { compileModuleJs } from './cpu-codegen'

// ── Hand-built IR constructors (explicit Stmt/Expr shapes) ──
const lit = (v: number | boolean, type: ShaderType = f32T): Expr => ({ op: 'lit', type, value: v })
const param = (name: string, type: ShaderType = f32T): Expr => ({ op: 'param', type, name })
const vref = (name: string, type: ShaderType = f32T): Expr => ({ op: 'varref', type, name })
const cref = (name: string, type: ShaderType = f32T): Expr => ({ op: 'constref', type, name })
const oref = (name: string, type: ShaderType = f32T): Expr => ({ op: 'overrideref', type, name })
const bin = (bop: BinOp, a: Expr, b: Expr, type: ShaderType = f32T): Expr => ({
  op: 'binop',
  type,
  bop,
  a,
  b,
})
const neg = (a: Expr, type: ShaderType = f32T): Expr => ({ op: 'unop', type, a })
const cmp = (cop: CmpOp, a: Expr, b: Expr): Expr => ({ op: 'compare', type: boolT, cop, a, b })
const logical = (lop: '&&' | '||', a: Expr, b: Expr): Expr => ({
  op: 'logical',
  type: boolT,
  lop,
  a,
  b,
})
const call = (fn: string, args: Expr[], type: ShaderType = f32T): Expr => ({
  op: 'call',
  type,
  fn,
  args,
})
const member = (base: Expr, field: string, type: ShaderType = f32T): Expr => ({
  op: 'member',
  type,
  base,
  field,
})
const construct = (type: ShaderType, args: Expr[]): Expr => ({ op: 'construct', type, args })
const sel = (cond: Expr, ifTrue: Expr, ifFalse: Expr, type: ShaderType = f32T): Expr => ({
  op: 'select',
  type,
  cond,
  ifTrue,
  ifFalse,
})
const index = (base: Expr, idx: Expr, type: ShaderType = f32T): Expr => ({
  op: 'index',
  type,
  base,
  idx,
})
const matchE = (
  scrutinee: Expr,
  cases: ReadonlyArray<readonly [number, Expr]>,
  dflt: Expr,
  type: ShaderType = f32T,
): Expr => ({ op: 'matchExpr', type, scrutinee, cases, default: dflt })

const ret = (expr?: Expr): Stmt => ({ s: 'return', expr })
const letS = (name: string, expr: Expr): Stmt => ({ s: 'let', name, expr })
const varS = (name: string, type: ShaderType, init?: Expr): Stmt => ({ s: 'var', name, type, init })
const assign = (target: Expr, expr: Expr): Stmt => ({ s: 'assign', target, expr })
const assignOp = (target: Expr, bop: BinOp, expr: Expr): Stmt => ({
  s: 'assignOp',
  target,
  bop,
  expr,
})
const ifS = (arms: ReadonlyArray<{ cond: Expr; body: Stmt[] }>, elseBody?: Stmt[]): Stmt => ({
  s: 'if',
  arms,
  elseBody,
})
const forS = (init: Stmt, cond: Expr, update: Stmt, body: Stmt[]): Stmt => ({
  s: 'for',
  init,
  cond,
  update,
  body,
})
const switchS = (
  scrut: Expr,
  cases: ReadonlyArray<{ value: number; body: Stmt[] }>,
  defaultBody?: Stmt[],
): Stmt => ({ s: 'switch', scrut, cases, defaultBody })

type P = { name: string; type: ShaderType }
const func = (name: string, params: P[], retType: ShaderType, body: Stmt[]) => ({
  name,
  params,
  ret: retType,
  body,
})

// ── The module under test ──
const P_STRUCT = {
  name: 'P',
  fields: [
    { name: 'a', type: f32T },
    { name: 'b', type: f32T },
  ],
}

function buildModule(): ModuleDecl {
  return {
    consts: [
      { name: 'K', type: f32T, wgslValue: 3.14159265, cpuValue: Math.PI },
      { name: 'HALF', type: f32T, wgslValue: 0.5, cpuValue: 0.5 },
      // valueExpr const (vec2) computed through the same op tree.
      {
        name: 'VC',
        type: vec2fT,
        wgslValue: 0,
        cpuValue: 0,
        valueExpr: construct(vec2fT, [lit(1.25), bin('*', cref('HALF'), lit(4))]),
      },
    ],
    structs: [P_STRUCT],
    bindings: [],
    overrides: [{ name: 'OV', type: f32T, default: 7.5 }],
    funcs: [
      // scalar arithmetic: + - * / % + nested calls (floor/sqrt/sin/cos/atan2/abs/sign/min/max)
      func(
        'arith',
        [
          { name: 'a', type: f32T },
          { name: 'b', type: f32T },
          { name: 'c', type: f32T },
        ],
        f32T,
        [
          letS('s', bin('+', bin('*', param('a'), param('b')), bin('-', param('c'), lit(2)))),
          letS('d', bin('/', vref('s'), bin('%', param('a'), lit(3)))),
          ret(
            call('atan2', [
              call('floor', [call('abs', [vref('d')])]),
              bin('+', call('sqrt', [call('abs', [param('a')])]), call('sign', [param('c')])),
            ]),
          ),
        ],
      ),
      // scalar sin/cos/min/max/clamp/mix/mod/radians/degrees
      func(
        'trig',
        [
          { name: 'x', type: f32T },
          { name: 'y', type: f32T },
        ],
        f32T,
        [
          ret(
            call('mix', [
              call('min', [
                call('sin', [call('radians', [param('x')])]),
                call('cos', [param('y')]),
              ]),
              call('max', [call('degrees', [param('x')]), call('mod', [param('y'), lit(2)])]),
              cref('HALF'),
            ]),
          ),
        ],
      ),
      // u32 bit-ops (& | ^ << >>logical)
      func(
        'bits',
        [
          { name: 'a', type: u32T },
          { name: 'b', type: u32T },
        ],
        u32T,
        [
          letS('x', bin('&', param('a', u32T), param('b', u32T), u32T)),
          letS(
            'y',
            bin('|', vref('x', u32T), bin('<<', param('b', u32T), lit(2, u32T), u32T), u32T),
          ),
          letS(
            'z',
            bin('^', vref('y', u32T), bin('>>', param('a', u32T), lit(1, u32T), u32T), u32T),
          ),
          ret(vref('z', u32T)),
        ],
      ),
      // i32 arithmetic shift (>> sign-preserving)
      func(
        'ishift',
        [
          { name: 'a', type: i32T },
          { name: 'b', type: i32T },
        ],
        i32T,
        [ret(bin('>>', param('a', i32T), param('b', i32T), i32T))],
      ),
      // vector component-wise + broadcast + clamp/mix/mod/min/max + normalize/cross
      func(
        'vecops',
        [
          { name: 'p', type: vec3fT },
          { name: 'q', type: vec3fT },
        ],
        vec3fT,
        [
          letS(
            'r',
            bin('+', param('p', vec3fT), bin('*', param('q', vec3fT), lit(2), vec3fT), vec3fT),
          ),
          letS(
            'c',
            call(
              'clamp',
              [vref('r', vec3fT), construct(vec3fT, [lit(-1)]), construct(vec3fT, [lit(1)])],
              vec3fT,
            ),
          ),
          letS(
            'm',
            call(
              'mix',
              [vref('c', vec3fT), call('mod', [param('p', vec3fT), lit(2)], vec3fT), cref('HALF')],
              vec3fT,
            ),
          ),
          ret(
            call(
              'normalize',
              [
                call(
                  'cross',
                  [
                    vref('m', vec3fT),
                    call('max', [param('q', vec3fT), construct(vec3fT, [lit(0.1)])], vec3fT),
                  ],
                  vec3fT,
                ),
              ],
              vec3fT,
            ),
          ),
        ],
      ),
      // scalar reductions: dot / length / distance
      func(
        'reduce',
        [
          { name: 'p', type: vec3fT },
          { name: 'q', type: vec3fT },
        ],
        f32T,
        [
          ret(
            bin(
              '+',
              call('dot', [param('p', vec3fT), param('q', vec3fT)]),
              bin(
                '*',
                call('length', [param('p', vec3fT)]),
                call('distance', [param('p', vec3fT), param('q', vec3fT)]),
              ),
            ),
          ),
        ],
      ),
      // member swizzle (single + multi) and vec construct/splat
      func('swz', [{ name: 'v', type: vec4fT }], vec4fT, [
        letS('xy', member(param('v', vec4fT), 'xy', vec2fT)),
        letS('zw', member(param('v', vec4fT), 'zw', vec2fT)),
        ret(
          construct(vec4fT, [
            member(vref('xy', vec2fT), 'x'),
            member(vref('zw', vec2fT), 'y'),
            member(param('v', vec4fT), 'w'),
            member(param('v', vec4fT), 'z'),
          ]),
        ),
      ]),
      // vecN(scalar) splat + unop (vec + scalar negate)
      func('splatneg', [{ name: 'a', type: f32T }], vec3fT, [
        letS('s', construct(vec3fT, [param('a')])),
        ret(
          bin(
            '+',
            neg(vref('s', vec3fT), vec3fT),
            construct(vec3fT, [neg(param('a')), param('a'), lit(0)]),
            vec3fT,
          ),
        ),
      ]),
      // compare (f32 fround ==) + select + logical short-circuit
      func(
        'cmp',
        [
          { name: 'a', type: f32T },
          { name: 'b', type: f32T },
        ],
        f32T,
        [
          letS('eq', sel(cmp('==', param('a'), param('b')), lit(1), lit(0))),
          letS(
            'ord',
            sel(
              logical('&&', cmp('>', param('a'), lit(0)), cmp('<', param('b'), lit(10))),
              lit(2),
              lit(3),
            ),
          ),
          letS(
            'or',
            sel(
              logical('||', cmp('<=', param('a'), lit(-5)), cmp('>=', param('b'), lit(5))),
              lit(4),
              lit(5),
            ),
          ),
          ret(bin('+', vref('eq'), bin('+', vref('ord'), vref('or')))),
        ],
      ),
      // if / elif / else chain
      func('ctrl', [{ name: 's', type: f32T }], f32T, [
        ifS(
          [
            { cond: cmp('<', param('s'), lit(0)), body: [ret(neg(param('s')))] },
            { cond: cmp('<', param('s'), lit(1)), body: [ret(bin('*', param('s'), lit(10)))] },
          ],
          [ret(bin('+', param('s'), lit(100)))],
        ),
      ]),
      // for-loop with var accumulator + assignOp (scalar)
      func('loopsum', [{ name: 'x', type: f32T }], f32T, [
        varS('acc', f32T, lit(0)),
        forS(
          varS('i', i32T, lit(0, i32T)),
          cmp('<', vref('i', i32T), lit(6, i32T)),
          assignOp(vref('i', i32T), '+', lit(1, i32T)),
          [assignOp(vref('acc'), '+', bin('*', param('x'), call('f32', [vref('i', i32T)])))],
        ),
        ret(vref('acc')),
      ]),
      // for-loop with break + continue
      func('loopbc', [{ name: 'n', type: f32T }], f32T, [
        varS('acc', f32T, lit(0)),
        forS(
          varS('i', i32T, lit(0, i32T)),
          cmp('<', vref('i', i32T), lit(10, i32T)),
          assignOp(vref('i', i32T), '+', lit(1, i32T)),
          [
            ifS([{ cond: cmp('==', vref('i', i32T), lit(1, i32T)), body: [{ s: 'continue' }] }]),
            ifS([{ cond: cmp('==', vref('i', i32T), lit(4, i32T)), body: [{ s: 'break' }] }]),
            assignOp(vref('acc'), '+', bin('+', param('n'), call('f32', [vref('i', i32T)]))),
          ],
        ),
        ret(vref('acc')),
      ]),
      // switch (i32 scrutinee) + default; a case with a mid-body break
      func('sw', [{ name: 's', type: i32T }], f32T, [
        varS('r', f32T, lit(-1)),
        switchS(
          param('s', i32T),
          [
            { value: 0, body: [assign(vref('r'), lit(10)), { s: 'break' }] },
            { value: 1, body: [assign(vref('r'), lit(20))] },
            { value: 2, body: [ret(lit(222))] },
          ],
          [assign(vref('r'), lit(99))],
        ),
        ret(vref('r')),
      ]),
      // matchExpr
      func('matchfn', [{ name: 's', type: i32T }], f32T, [
        ret(
          matchE(
            param('s', i32T),
            [
              [0, lit(1.5)],
              [1, cref('K')],
              [2, bin('*', cref('HALF'), lit(8))],
            ],
            lit(-9),
          ),
        ),
      ]),
      // struct construct + member
      func(
        'structfn',
        [
          { name: 'a', type: f32T },
          { name: 'b', type: f32T },
        ],
        f32T,
        [
          letS('p', construct(structT('P'), [param('a'), bin('+', param('b'), lit(1))])),
          ret(bin('*', member(vref('p', structT('P')), 'a'), member(vref('p', structT('P')), 'b'))),
        ],
      ),
      // array construct + dynamic index
      func('arridx', [{ name: 'i', type: i32T }], f32T, [
        letS('arr', construct(arrayT(f32T, 4), [lit(10), lit(20), lit(30), lit(40)])),
        ret(index(vref('arr', arrayT(f32T, 4)), param('i', i32T))),
      ]),
      // assignOp on a VECTOR target (component-wise) + member-assign aliasing
      func('vecmut', [{ name: 'p', type: vec3fT }], vec3fT, [
        varS('v', vec3fT, param('p', vec3fT)),
        assignOp(vref('v', vec3fT), '+', construct(vec3fT, [lit(1), lit(2), lit(3)])),
        assign(member(vref('v', vec3fT), 'x'), bin('*', member(vref('v', vec3fT), 'x'), lit(2))),
        ret(vref('v', vec3fT)),
      ]),
      // consts (scalar + vec valueExpr) + override
      func('constsfn', [{ name: 'a', type: f32T }], vec2fT, [
        ret(
          bin(
            '+',
            cref('VC', vec2fT),
            construct(vec2fT, [bin('*', cref('K'), param('a')), oref('OV')]),
            vec2fT,
          ),
        ),
      ]),
      // discard (conditional) → undefined, else a value
      func('disc', [{ name: 's', type: f32T }], f32T, [
        ifS([{ cond: cmp('<', param('s'), lit(0)), body: [{ s: 'discard' }] }]),
        ret(bin('+', param('s'), lit(5))),
      ]),
    ],
  }
}

// ── seeded RNG + input generation ──
function mulberry32(seed: number): () => number {
  let s = seed
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SCALAR_BOUNDARIES = [
  0,
  1,
  -1,
  0.5,
  -0.5,
  2,
  -2,
  3,
  90,
  -90,
  180,
  -180,
  85.051129,
  -85.051129,
  45,
  1e-7,
  -1e-7,
  1e7,
  100,
  0.25,
  Math.PI,
  -Math.PI,
]
const INT_BOUNDARIES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, -1, -2, 15, 31]

function scalarKind(t: ShaderType): 'f32' | 'i32' | 'u32' | 'other' {
  if (t.kind === 'scalar') return t.scalar === 'bool' ? 'other' : t.scalar
  return 'other'
}

function genScalar(t: ShaderType, rng: () => number, useBoundary: boolean): number {
  const kind = scalarKind(t)
  if (kind === 'i32') {
    return useBoundary
      ? INT_BOUNDARIES[Math.floor(rng() * INT_BOUNDARIES.length)]!
      : Math.floor((rng() - 0.5) * 64)
  }
  if (kind === 'u32') {
    return useBoundary
      ? Math.abs(INT_BOUNDARIES[Math.floor(rng() * INT_BOUNDARIES.length)]!)
      : Math.floor(rng() * 256)
  }
  // f32 / f64
  if (useBoundary) return SCALAR_BOUNDARIES[Math.floor(rng() * SCALAR_BOUNDARIES.length)]!
  return (rng() - 0.5) * 400
}

function genArg(t: ShaderType, rng: () => number, useBoundary: boolean): number | number[] {
  if (t.kind === 'vec' || t.kind === 'vec64')
    return Array.from({ length: t.n }, () => genScalar(f32T, rng, useBoundary))
  return genScalar(t, rng, useBoundary)
}

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x)) as unknown as T
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v as object)) o[k] = clone((v as Record<string, unknown>)[k])
    return o as T
  }
  return v
}

function bitEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!bitEqual(a[i], b[i])) return false
    return true
  }
  const ao = a && typeof a === 'object' && !Array.isArray(a)
  const bo = b && typeof b === 'object' && !Array.isArray(b)
  if (ao && bo) {
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    if (ka.length !== kb.length) return false
    for (const k of ka)
      if (!bitEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
        return false
    return true
  }
  return Object.is(a, b)
}

describe('compileModuleJs — differential vs interpreter (GATE A1)', () => {
  const m = buildModule()
  const jsMod = compileModuleJs(m)
  const interpMod = compileModule(m)

  it('every fn is bit-identical over boundary + seeded-random sweeps (Object.is per element)', () => {
    const PER_FN = 400
    let fnCount = 0
    let inputCount = 0
    const divergences: string[] = []

    for (const f of m.funcs) {
      fnCount++
      const jsFn = jsMod.fns[f.name]!
      const interpFn = interpMod.fns[f.name]!
      const rng = mulberry32(
        0x9e3779b9 ^ f.name.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7),
      )
      for (let k = 0; k < PER_FN; k++) {
        const useBoundary = k < PER_FN / 2
        const args = f.params.map((p) => genArg(p.type, rng, useBoundary))
        const a = jsFn(...(clone(args) as never[]))
        const b = interpFn(...(clone(args) as never[]))
        inputCount++
        if (!bitEqual(a, b)) {
          divergences.push(
            `${f.name}(${JSON.stringify(args)}): js=${JSON.stringify(a)} interp=${JSON.stringify(b)}`,
          )
          if (divergences.length > 10) break
        }
      }
    }

    console.log(
      `[GATE A1] ${fnCount} fns × ${inputCount / fnCount} inputs = ${inputCount} exact-equality checks`,
    )
    expect(divergences).toEqual([])
    expect(fnCount).toBe(m.funcs.length)
  })

  it('the js backend runs the SAME preamble (validate + autoVars) and shares CpuModule shape', () => {
    // setBinding is a no-op here (no bindings) but must exist + not throw.
    expect(() => jsMod.setBinding('unused', 0)).not.toThrow()
    expect(Object.keys(jsMod.fns).sort()).toEqual(Object.keys(interpMod.fns).sort())
  })

  it('hybrid fallback: a fn with a raw/placeholder Stmt falls back to the interpreter, rest compile', () => {
    const hybrid: ModuleDecl = {
      consts: [],
      structs: [],
      bindings: [],
      funcs: [
        func('ok', [{ name: 'a', type: f32T }], f32T, [ret(bin('*', param('a'), lit(3)))]),
        // a raw WGSL Stmt has no CPU form → this fn must fall back (and throw at call,
        // exactly as the interpreter does), while `ok` still runs compiled.
        func('bad', [{ name: 'a', type: f32T }], f32T, [
          { s: 'raw', wgsl: 'return a;' },
          ret(param('a')),
        ]),
      ],
    }
    const jm = compileModuleJs(hybrid)
    const im = compileModule(hybrid)
    expect(jm.fns.ok!(4)).toBe(12)
    // `bad` fell back to the interpreter twin → its raw-Stmt throw matches.
    let jThrew = false
    let iThrew = false
    try {
      jm.fns.bad!(1)
    } catch {
      jThrew = true
    }
    try {
      im.fns.bad!(1)
    } catch {
      iThrew = true
    }
    expect(jThrew).toBe(true)
    expect(iThrew).toBe(true)
  })
})

describe('compileModuleJs — microbench (GATE A2, logged not asserted)', () => {
  it('N=100k calls: interpreter vs codegen (representative vector fn)', () => {
    const m = buildModule()
    const jsFn = compileModuleJs(m).fns.vecops!
    const interpFn = compileModule(m).fns.vecops!
    const N = 100_000
    const p = [0.3, -0.7, 1.2]
    const q = [-0.4, 0.9, 0.1]

    // warm up (JIT both)
    for (let i = 0; i < 2000; i++) {
      jsFn([...p], [...q])
      interpFn([...p], [...q])
    }

    const t0 = performance.now()
    for (let i = 0; i < N; i++) interpFn([...p], [...q])
    const tInterp = performance.now() - t0

    const t1 = performance.now()
    for (let i = 0; i < N; i++) jsFn([...p], [...q])
    const tCodegen = performance.now() - t1

    console.log(
      `[GATE A2] vecops ×${N}: interpreter ${tInterp.toFixed(1)}ms · codegen ${tCodegen.toFixed(1)}ms · speedup ${(tInterp / tCodegen).toFixed(2)}×`,
    )
    expect(tCodegen).toBeGreaterThan(0)
  })
})
