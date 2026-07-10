// ═══ shader-dsl — specialization constants (#923) ═══
//
// The pinned contract for `overrideConst`: one authored declarator lowers to a WGSL
// module-scope `override` AND a GLSL `#define`/`#ifndef` permutation seam; its read is
// OPAQUE to the optimizer (a guarded branch survives DEFAULT_PASSES for the driver to
// eliminate); reflect() reports the override set; and BOTH host shapes (the WGSL
// `constants` dict + the GLSL define header) derive mechanically from reflect().

import { describe, it, expect } from 'vitest'
import {
  module,
  fn,
  f32,
  f32T,
  i32T,
  u32T,
  boolT,
  vec4fT,
  If,
  Var,
  overrideConst,
  emitModule,
  emitModuleAt,
  emitGlslModule,
  reflect,
  ShaderDslError,
} from '../src/index.ts'
import { overrideQuality } from './override-quality.ts'

const m = overrideQuality.module

describe('#923 — specialization constants (WGSL override ↔ GLSL #define)', () => {
  // ── 1. WGSL emit: the `override` line + the surviving guarded branch ──
  it('WGSL emits a module-scope `override` with the default and keeps the guarded branch', () => {
    const wgsl = emitModule(m)
    expect(wgsl).toContain('override quality: f32 = 1.0;')
    expect(wgsl).toContain('if ((quality > 1.0)) {')
  })

  // ── 2. GLSL emit: the #ifndef/#define default seam + the surviving guarded branch ──
  it('GLSL emits a #ifndef/#define default seam and keeps the guarded branch', () => {
    const glsl = emitGlslModule(m)
    expect(glsl).toContain('#ifndef quality\n#define quality 1.0\n#endif')
    expect(glsl).toContain('if ((quality > 1.0)) {')
    // no WGSL `override` keyword leaks into GLSL
    expect(glsl).not.toContain('override ')
  })

  // ── 3. Optimizer invariant: the override-guarded branch survives DEFAULT_PASSES ──
  it('the override-guarded branch survives the full O2 (DEFAULT_PASSES) pipeline', () => {
    // emitModule runs the full fixpoint optimizer (O2). The branch is present at O0
    // (naive) AND at O2 → the optimizer did not fold it.
    expect(emitModuleAt(m, 'O0')).toContain('if ((quality > 1.0)) {')
    expect(emitModuleAt(m, 'O2')).toContain('if ((quality > 1.0)) {')
  })

  it('the LITERAL twin IS folded away — proving the invariant is non-vacuous', () => {
    // The SAME branch shape as override-quality, but the condition is a compile-time
    // literal (1 > 1 = false): const-fold + dead-branch remove it, so O2 drops the `if`.
    const litTwin = module({
      funcs: [
        fn('shade', { base: f32T }, ({ base }) => {
          const acc = Var(base)
          If(f32(1).gt(f32(1)), () => {
            acc.assign(acc.mul(f32(2)).add(f32(0.5)))
          })
          return acc
        }),
      ],
    })
    expect(emitModuleAt(litTwin, 'O0')).toContain('if (') // present before optimization
    expect(emitModuleAt(litTwin, 'O2')).not.toContain('if (') // folded away after O2
  })

  // ── 4. Reflection reports the override set (names + types + defaults) ──
  it('reflect() reports the override set for the host', () => {
    expect(reflect(m).overrides).toEqual([{ name: 'quality', type: 'f32', default: 1 }])
  })

  it('a module with no overrides reflects an empty override set (always present)', () => {
    const plain = module({ funcs: [fn('id', { x: f32T }, ({ x }) => x)] })
    expect(reflect(plain).overrides).toEqual([])
  })

  // ── 5. Controls↔reflection-style gate: BOTH host shapes derive from reflect() ──
  it('the WGSL `constants` dict and the GLSL specialized variant both derive from reflect()', () => {
    const overrides = reflect(m).overrides

    // WGSL host shape: createRenderPipeline({ constants: { name: value } }) — WebGPU takes
    // the JS value directly, so the dict derives straight from reflect().
    const wgslConstants = Object.fromEntries(overrides.map((o) => [o.name, o.default]))
    expect(wgslConstants).toEqual({ quality: 1 })
    const wgsl = emitModule(m)
    for (const o of overrides) expect(wgsl).toContain(`override ${o.name}: ${o.type} = `)

    // GLSL host shape: the GLSL twin of WGSL `constants` is a RE-EMIT with `overrideValues`,
    // a dict keyed by the SAME reflect() names. The emitter — not the host — spells the value
    // through the backend literal() and positions the `#define` AFTER the `#version` preamble,
    // so the host can neither mis-place it (a PREPENDED `#define` is invalid GLSL: `#version`
    // must lead the source) nor mis-spell it (a raw-JS int for an f32 would be `2`, not `2.0`).
    const chosen: Record<string, number> = Object.fromEntries(overrides.map((o) => [o.name, 2]))
    const specialized = emitGlslModule(m, undefined, { overrideValues: chosen })
    expect(specialized.startsWith('#version 300 es')).toBe(true) // `#version` still leads
    // f32 override 2 → the real GLSL float literal `2.0`, not the raw int `2`
    expect(specialized).toContain('#define quality 2.0')
    for (const o of overrides) {
      // every reflected name is a hard `#define` in the specialized emit …
      expect(specialized).toContain(`#define ${o.name} `)
      // … the `#ifndef` default is gone (the value is pinned) …
      expect(specialized).not.toContain(`#ifndef ${o.name}`)
      // … and the `#define` lands AFTER `#version`, never before it (valid GLSL).
      expect(specialized.indexOf('#version 300 es')).toBeLessThan(
        specialized.indexOf(`#define ${o.name} `),
      )
    }
    // the override-guarded branch survives into the specialized variant (the driver DCEs it)
    expect(specialized).toContain('if ((quality > 1.0)) {')

    // the DEFAULT emit (no host values) still standalone-compiles via the `#ifndef` guard.
    const base = emitGlslModule(m)
    for (const o of overrides) expect(base).toContain(`#ifndef ${o.name}\n`)
  })

  it('a specialized u32 override is spelled with its `u` suffix (not a raw int)', () => {
    // The type-aware spelling is load-bearing: a raw JS-stringified header would emit
    // `#define count 5`, and the guard `count > 1u` then compares int vs uint — ESSL 3.00
    // has NO int→uint implicit conversion, so the specialized variant would not compile.
    const u = module({
      overrides: [overrideConst('count', u32T, 1).decl],
      funcs: [
        fn('g', { x: f32T }, ({ x }) => {
          const a = Var(x)
          If(overrideConst('count', u32T, 1).node.gt(f32(0)), () => {
            a.assign(a.add(f32(1)))
          })
          return a
        }),
      ],
    })
    expect(emitGlslModule(u)).toContain('#ifndef count\n#define count 1u\n#endif') // default u
    const spec = emitGlslModule(u, undefined, { overrideValues: { count: 5 } })
    expect(spec).toContain('#define count 5u') // pinned u
    expect(spec).not.toMatch(/#define count 5(?!u)/) // never the bare int
  })

  // ── Scalar-type declaration spellings (bool / i32 / u32 / f32) ──
  it('emits every WGSL scalar override spelling', () => {
    const scalars = module({
      overrides: [
        overrideConst('flag', boolT, true).decl,
        overrideConst('level', i32T, 2).decl,
        overrideConst('count', u32T, 3).decl,
        overrideConst('gain', f32T, 1.5).decl,
      ],
      funcs: [fn('nil', {}, () => f32(0))],
    })
    const wgsl = emitModule(scalars)
    expect(wgsl).toContain('override flag: bool = true;')
    expect(wgsl).toContain('override level: i32 = 2;')
    expect(wgsl).toContain('override count: u32 = 3u;')
    expect(wgsl).toContain('override gain: f32 = 1.5;')
  })

  // ── 4 (constraint): reject vec/matrix overrides at authoring (SD0014) ──
  it('rejects a non-scalar (vec) override at authoring with SD0014', () => {
    expect(() => overrideConst('tint', vec4fT, 0)).toThrow(ShaderDslError)
    try {
      overrideConst('tint', vec4fT, 0)
      expect.unreachable('vec override should throw')
    } catch (e) {
      expect((e as ShaderDslError).code).toBe('SD0014')
    }
  })
})
