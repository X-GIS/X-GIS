import { describe, it, expect } from 'vitest'
import { fn, module, f64T, f32T, sqrt, toF32, stageOf } from '../ir/index.js'
import type { Expr, ModuleDecl, ShaderType } from '../ir/index.js'
import { compileModule, type CpuValue } from '../oracle.js'
import { fp64Lower } from './fp64-lower.js'
import { fixpoint, mapModuleExprs } from './opt/index.js'
import { splitF64 } from '../fp64/df64-lib.js'
import { forceInline } from './force-inline.js'
import { forceInline as forceInlinePlugin } from '../../emit-prod.js'
import { emitModule } from '../../index.js'
import type { EmitPlugin } from '../emit.js'

// forceInline unlocks `FuncDecl.opaque` so the df64 library can be inlined and then
// tree-shaken away. The whole question is whether the error-free transforms SURVIVE
// that, so the arms below re-use df64-known-answer's f32-rounding oracle: the ACTUAL
// lowered IR, with every f32 op wrapped in Math.fround, i.e. a correctly-rounding f32
// machine over the same IR the GPU receives. Bit-equality with the un-inlined module is
// the bar — not "it still looks like df64".
//
// WHAT THESE ARMS DISTINGUISH, measured rather than assumed (§12). They separate df64
// from COLLAPSED-TO-f32: each case carries the value plain f32 produces and asserts the
// answer is not it, so an inline that flattened the extended precision fails here.
//
// What they cannot be made red by is OUR optimizer. Folding the runtime-opaque guard to
// the literal 1.0 and re-running the full O2 fixpoint over the force-inlined module was
// tried directly: 0 of 4 vectors moved a bit. That is not a weakness in the vectors, it
// is a fact about the pass set — `algebraic.ts` rewrites only literal-0/1 operands and
// `const-fold.ts` only literal-operand binops, and neither reassociates or distributes,
// so nothing here can cancel an error-free transform even with the guard gone. It is the
// constructive form of the note in the pass header: `opaque` is future-proofing against a
// reassociating pass nobody has written, not protection this optimizer currently needs.
//
// A driver's fast-math is the failure these cannot see, and this file does not claim it —
// that is _fp64-known-answer.spec.ts on a real device.

const isF32ish = (t: ShaderType): boolean =>
  (t.kind === 'scalar' && t.scalar === 'f32') || (t.kind === 'vec' && t.elem === 'f32')

const froundWrap = (e: Expr): Expr => {
  if ((e.op === 'binop' || e.op === 'unop' || e.op === 'call') && isF32ish(e.type)) {
    if (e.op === 'call' && e.fn === '__fround') return e
    return { op: 'call', type: e.type, fn: '__fround', args: [e] }
  }
  return e
}

function f32Oracle(lowered: ModuleDecl): ReturnType<typeof compileModule> {
  const cpu = compileModule(mapModuleExprs(lowered, froundWrap))
  cpu.fns['__fround'] = (x: CpuValue) =>
    Array.isArray(x) ? (x as number[]).map(Math.fround) : Math.fround(x as number)
  return cpu
}

const kernel = module({
  funcs: [
    fn('k_add', { a: f64T, b: f64T }, (p) => p.a.add(p.b)),
    fn('k_mul', { a: f64T, b: f64T }, (p) => p.a.mul(p.b)),
    fn('k_div', { a: f64T, b: f64T }, (p) => p.a.div(p.b)),
    fn('k_sqrt', { a: f64T }, (p) => sqrt(p.a)),
    fn('k_narrow', { a: f64T }, (p) => toF32(p.a)),
  ],
})

// An f64 divide on two PARAMS: neither operand is a helper output, so fp64Lower inserts
// renormForCancel before the cancelling op — the exact shape whose guard must survive.
const guarded = module({
  funcs: [fn('g', { a: f64T, b: f64T }, f32T, (p, bb) => bb.ret(toF32(p.a.div(p.b))))],
})

/** The pinned arithmetic-op count of the force-inlined `guarded` kernel. Measured, and it
 *  is the number a guard-deleting fold moves: a member-of-construct fold takes it to 400. */
const FLATTENED_OPS = 408

const BASE = fixpoint(fp64Lower(kernel))
const SIZE_WIN = forceInline(BASE, 'size-win')
const ALL = forceInline(BASE, 'all')

const df64Count = (m: ModuleDecl): number =>
  m.funcs.filter((f) => f.name.startsWith('df64_')).length
const val = (r: CpuValue): number => {
  const [hi, lo] = r as number[]
  return hi! + lo!
}
const P = splitF64

describe('forceInline — unlocking `opaque` removes the df64 library', () => {
  // Without these two the value arms below would pass vacuously: an unchanged module
  // trivially agrees with itself. They assert the mechanism actually fired.
  it("'all' removes EVERY df64 helper declaration", () => {
    expect(df64Count(BASE)).toBeGreaterThan(0)
    expect(df64Count(ALL)).toBe(0)
  })

  it("'size-win' removes some but leaves the multi-call helpers standing", () => {
    expect(df64Count(SIZE_WIN)).toBeLessThan(df64Count(BASE))
    expect(df64Count(SIZE_WIN)).toBeGreaterThan(0)
  })

  it('leaves a module with no opaque helper to plain inlining (identity when nothing inlines)', () => {
    const plain = module({ funcs: [fn('k', { x: f32T }, f32T, ({ x }, b) => b.ret(x.add(1)))] })
    expect(forceInline(plain, 'all')).toBe(plain)
    expect(forceInline(plain, 'size-win')).toBe(plain)
  })
})

// Inlining is not folding. Flattening a df64 body copies its expressions; the
// runtime-opaque ONE travels with them, so the fast-math guard is still there afterwards —
// which is the whole reason forcing the inline is allowed while folding the guarded
// expression is not. The value arms above cannot see this: on a correctly-rounded machine a
// deleted guard changes no value, only what a driver is then free to do.
describe('forceInline — the fast-math guard survives the flattening', () => {
  const wgslOf = (plugins: EmitPlugin[]): string =>
    emitModule(guarded, { parens: 'minimal', plugins })

  const GUARD = /textureLoad\(_fp64/g

  it('the baseline reads the opaque ONE, and the flattened body still does', () => {
    expect(wgslOf([]).match(GUARD)?.length ?? 0).toBeGreaterThan(0)
    expect(
      wgslOf([forceInlinePlugin({ strength: 'all' })]).match(GUARD)?.length ?? 0,
    ).toBeGreaterThan(0)
  })

  it('the df64 call graph is gone, yet the guard binding is not', () => {
    const flat = wgslOf([forceInlinePlugin({ strength: 'all' })])
    expect(flat).not.toMatch(/^fn df64_/m) // every helper inlined away…
    expect(flat).toMatch(/_fp64/) // …and the guard it carried is still read
  })

  // The `_fp64` check above is NOT sufficient, and that was measured rather than assumed:
  // a member-of-construct fold deletes `renormForCancel`'s twoSum (408 arithmetic ops ->
  // 400, `let _v0 = _a0 + _a1` collapsing to `_a0`) while the texel read stays at 1, so the
  // presence check passes through the exact regression it looks like it guards.
  //
  // What DOES see it is the op count. Every df64 error-free transform is arithmetic; a pass
  // that quietly cancels one shows up here as a DROP. So this is a ratchet, in the shape the
  // repo already uses for backend identity: an exact count, and a drop is a finding to
  // explain — "which guard did this delete, and is it one #915 paid for?" — before anyone
  // re-baselines it. A RISE is ordinary (a new helper, a wider lowering) and just re-pins.
  it('pins the flattened arithmetic-op count — a DROP means a guard was optimized away', () => {
    const flat = forceInline(fixpoint(fp64Lower(guarded)), 'all')
    let ops = 0
    const walkE = (e: unknown): void => {
      if (!e || typeof e !== 'object') return
      const x = e as { op?: string; s?: string }
      if (x.op === 'binop' || x.op === 'unop') ops++
      for (const v of Object.values(e as Record<string, unknown>)) {
        if (Array.isArray(v)) v.forEach(walkE)
        else if (v && typeof v === 'object') walkE(v)
      }
    }
    for (const f of flat.funcs) f.body.forEach(walkE)
    expect(ops, 'flattened df64 arithmetic-op count moved — see the header before re-pinning').toBe(
      FLATTENED_OPS,
    )
  })
})

describe('forceInline — df64 known answers survive both strengths, bit for bit', () => {
  const arms: [string, ModuleDecl][] = [
    ['size-win', SIZE_WIN],
    ['all', ALL],
  ]
  const base = f32Oracle(BASE)

  // Each case carries its DISCRIMINATIVE half: what plain f32 produces. If df64 had
  // collapsed to f32 under inlining, the expectation would land on that value instead.
  const cases: [string, (c: ReturnType<typeof f32Oracle>) => number, number][] = [
    ['(2^20 + 2^-20) − 2^20', (c) => val(c.fns.k_add!(P(2 ** 20 + 2 ** -20), P(-(2 ** 20)))), 0],
    ['(1e8 + 0.5) − 1e8', (c) => val(c.fns.k_add!(P(1e8 + 0.5), P(-1e8))), 0],
    ['1e8 · 5e-9', (c) => val(c.fns.k_mul!(P(1e8), P(5e-9))), Number.NaN],
    ['(1 + 2^-30) / 1', (c) => val(c.fns.k_div!(P(1 + 2 ** -30), P(1))), Math.fround(1 + 2 ** -30)],
    ['sqrt(2)', (c) => val(c.fns.k_sqrt!(P(2))), Math.fround(Math.sqrt(2))],
  ]

  for (const [strength, m] of arms) {
    const armOracle = f32Oracle(m)
    for (const [name, run, f32Only] of cases) {
      it(`${strength}: ${name} is bit-identical to the un-inlined module`, () => {
        const want = run(base)
        expect(run(armOracle)).toBe(want)
        // …and df64 is still doing something plain f32 cannot.
        if (!Number.isNaN(f32Only)) expect(want).not.toBe(f32Only)
      })
    }
  }

  it('narrow(a) keeps its DOCUMENTED f32 rounding under both strengths', () => {
    for (const [, m] of arms) {
      expect(f32Oracle(m).fns.k_narrow!(P(1e8 + 0.5))).toBe(Math.fround(1e8 + 0.5))
    }
  })
})

// ── What flattening the WHOLE example corpus leaves standing ────────────────
//
// The render-parity arm in `_force-inline-compile-gate.spec.ts` proves flattening
// does not move pixels. It cannot prove flattening HAPPENED — a no-op renders
// byte-identically too — and its emit-side companion only checks that `df64_*` is
// gone, which says nothing about the shader's OWN helpers. This is the missing
// half: the exact set of non-entry functions that survive, each with the reason.
//
// A NEW NAME HERE IS A FINDING, not a number to re-pin: it means a helper the
// obfuscation pass is supposed to dissolve did not. A name LEAVING is the ordinary
// case (something became inlinable) — re-pin it.
describe('forceInline(all) over the example corpus', () => {
  // name -> why it is allowed to survive.
  const EXPECTED: Record<string, string> = {
    // `discard` is impure, and purity is the entire licence for lifting a body:
    // WGSL `||`/`&&` short-circuit, so a call lifted out of a short-circuited
    // operand would run a discard the original skipped.
    discard_outside_circle: 'contains discard',
    // The module IS this function — no entry point calls it, so there is no call
    // site to inline into and deadFnElim must not strip the module to nothing.
    shade: 'uncalled (the module is the helper)',
  }

  it('leaves exactly the helpers that cannot be inlined, and nothing else', async () => {
    const { examples } = await import('../../../examples/index.js')
    const survivors: Record<string, string> = {}
    for (const ex of examples) {
      const entries = new Set(
        ex.module.funcs.filter((f) => stageOf(f) !== undefined).map((f) => f.name),
      )
      let wgsl: string
      try {
        wgsl = emitModule(ex.module, { plugins: [forceInlinePlugin({ strength: 'all' })] })
      } catch {
        continue // not every example emits standalone; the parity gate covers those
      }
      for (const m of wgsl.match(/^fn ([A-Za-z0-9_]+)/gm) ?? []) {
        const name = m.slice(3)
        if (!entries.has(name)) survivors[name] = ex.id
      }
    }
    expect(
      Object.keys(survivors).sort(),
      `unexpected survivor(s): ${JSON.stringify(survivors)} — a helper the flattening ` +
        `is meant to dissolve did not. Check preludeBlocker before re-pinning.`,
    ).toEqual(Object.keys(EXPECTED).sort())
  })
})
