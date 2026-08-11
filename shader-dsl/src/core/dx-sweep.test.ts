import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  f32,
  u32,
  vec3,
  vec4,
  Var,
  Let,
  matchExpr,
  lift,
  f32T,
  u32T,
  vec2fT,
  vec3fT,
  vec4fT,
  texture2dfT,
  texture2dMsfT,
  texture2dArrayfT,
  samplerT,
  dot,
  length,
  smoothstep,
  textureSample,
  textureSampleLevel,
  type ReadonlyNode,
} from './ir'
import { structDecl, uniformStruct, arrayOf, resource } from './sot'
import { emitModule } from './backends/wgsl'
import type { FuncDecl } from './ir'

// ═══ #763 Phase X (part 1) — the small-surface DX sweep, pinned ═══

// FuncDecl, not ReturnType<typeof fn> — a concrete handle's object-call arg map
// is contravariant against the widened FnParamSpec form (the R9 emitOne lesson).
const emitF = (f: FuncDecl): string => emitModule(module({ funcs: { f } }))

describe('#763 X — type-surface sweep', () => {
  it('X5: scalar-node % vec-node broadcasts like the other four ops', () => {
    const g = fn('x5', { t: f32T, v: vec3fT }, ({ t, v }) => t.mod(v).x)
    expect(emitF(g)).toContain('(t % v)')
  })

  it('X6: texture/sampler carry specific keys — a swap is a tsc error', () => {
    const tex = resource('x6_tex', texture2dfT, { group: 0, binding: 0 })
    const smp = resource('x6_smp', samplerT, { group: 0, binding: 1 })
    const g = fn('x6', { uv: vec2fT }, ({ uv }) => {
      // @ts-expect-error — sampler where the texture goes (#763 X6); used to compile
      const bad = textureSample(smp.node, tex.node, uv)
      void bad
      return textureSample(tex.node, smp.node, uv)
    })
    expect(g.decl.name).toBe('x6')
  })

  it('#1650: textureSampleLevel pins the same key constraints, plus the level arg', () => {
    const tex = resource('lvl_tex', texture2dfT, { group: 0, binding: 0 })
    const smp = resource('lvl_smp', samplerT, { group: 0, binding: 1 })
    const ms = resource('lvl_ms', texture2dMsfT, { group: 0, binding: 2 })
    const g = fn('lvl', { uv: vec2fT, uv3: vec3fT }, ({ uv, uv3 }) => {
      // The explicit LOD is REQUIRED (it is the whole point of the intrinsic). Kept in
      // an UNCALLED thunk: omitting it also throws at author time (lift(undefined)),
      // and this probe is about tsc rejecting it, not about the throw.
      // @ts-expect-error — missing the level argument
      const noLevel = () => textureSampleLevel(tex.node, smp.node, uv)
      // @ts-expect-error — sampler where the texture goes
      const swapped = textureSampleLevel(smp.node, tex.node, uv, 0)
      // @ts-expect-error — uv must be vec2<f32>
      const uvRank = textureSampleLevel(tex.node, smp.node, uv3, 0)
      // @ts-expect-error — a multisampled texture has no mip chain (textureLoad only)
      const msTex = textureSampleLevel(ms.node, smp.node, uv, 0)
      void [noLevel, swapped, uvRank, msTex]
      return textureSampleLevel(tex.node, smp.node, uv, 1)
    })
    expect(g.decl.name).toBe('lvl')
  })

  it('#1651: the 2d-array overloads pin the LAYER argument (arity + key)', () => {
    const arr = resource('arr_tex', texture2dArrayfT, { group: 0, binding: 0 })
    const tex = resource('arr_2d', texture2dfT, { group: 0, binding: 1 })
    const smp = resource('arr_smp', samplerT, { group: 0, binding: 2 })
    const g = fn('arr', { uv: vec2fT, uv3: vec3fT, lvl: f32T }, ({ uv, uv3, lvl }) => {
      // The layer is REQUIRED on an array texture — the 3-arg (2d) overload rejects the
      // array key and the 4-arg one rejects the arity, so the diagnostic is the
      // "no overload matches" class. Uncalled thunk: the runtime would also throw.
      // @ts-expect-error — missing the layer argument on an ARRAY texture
      const noLayer = () => textureSample(arr.node, smp.node, uv)
      // @ts-expect-error — a plain 2d texture has NO layer argument (wrong key for the array id)
      const layerOn2d = textureSample(tex.node, smp.node, uv, 0)
      // @ts-expect-error — uv must be vec2<f32> on the array form too
      const uvRank = textureSample(arr.node, smp.node, uv3, 0)
      // @ts-expect-error — an array read needs BOTH the layer and the level
      const noLevel = () => textureSampleLevel(arr.node, smp.node, uv, 0)
      // @ts-expect-error — the layer is an INDEX: an f32-keyed node is not an i32/u32 one
      const f32Layer = textureSample(arr.node, smp.node, uv, lvl)
      void [noLayer, layerOn2d, uvRank, noLevel, f32Layer]
      return textureSample(arr.node, smp.node, uv, 1).add(
        textureSampleLevel(arr.node, smp.node, uv, u32(0), 0),
      )
    })
    expect(g.decl.name).toBe('arr')
  })

  it('X7: dot/length are K-constrained — dot(v2, v3) is a tsc error', () => {
    fn('x7', { a: vec2fT, b: vec3fT }, ({ a, b }) => {
      // @ts-expect-error — mismatched vector keys (#763 X7); used to compile and die at naga
      const bad = dot(a, b)
      void bad
      return dot(a, a).add(length(b))
    })
    expect(true).toBe(true)
  })

  it('X8: a vector comparison is rejected at tsc AND at runtime', () => {
    fn('x8', { v: vec3fT }, ({ v }) => {
      // tsc-level probe INSIDE a never-executed closure — the runtime backstop
      // below would otherwise throw during authoring and kill the fn body.
      void (() =>
        // @ts-expect-error — vec LHS comparison returns vecN<bool> in WGSL, not bool (#763 X8)
        v.lt(1))
      return v.x
    })
    // Runtime backstop for hand-built calls that bypass the `this:` bound.
    const v = vec3(1, 2, 3)
    expect(() => (v as unknown as ReadonlyNode<'f32'>).lt(1)).toThrow(/scalar operands/)
  })

  it('X9: Var(name, init) — named + type-inferred (the missing matrix cell)', () => {
    const g = fn('x9', { t: f32T }, ({ t }) => {
      const acc = Var('acc', t.mul(2))
      acc.assign(acc.add(1))
      return acc
    })
    const w = emitF(g)
    expect(w).toContain('var acc')
    expect(w).toContain('(t * 2.0)')
  })

  it('X10: structDecl gains .var/.construct; uniformStruct gains .decl/.type', () => {
    const Slot = structDecl('X10Slot', { id: u32T, size: f32T })
    const g = fn('x10', {}, () => {
      const s = Slot.var('slot')
      s.id.assign(u32(1))
      const whole = Slot.construct({ id: u32(2), size: f32(3) })
      return Slot.of(Let(whole)).size
    })
    const w = emitModule(module({ structs: [Slot.decl], funcs: { g } }))
    expect(w).toContain('var slot: X10Slot')
    expect(w).toContain('X10Slot(2u, 3.0)')
    const U = uniformStruct('X10U', { group: 0, binding: 0, as: 'xu' }, { t: f32T })
    expect(U.decl).toBe(U.struct)
    expect(U.type).toEqual({ kind: 'struct', name: 'X10U' })
  })

  it('X11: arrayOf(vec4fT, n) uniform fields expose a typed .at(i)', () => {
    const U = uniformStruct(
      'X11U',
      { group: 0, binding: 0, as: 'xu11' },
      {
        dash: arrayOf(vec4fT, 2),
      },
    )
    expect(U.struct.fields[0]!.type).toEqual({ kind: 'array', elem: vec4fT, size: 2 })
    const g = fn('x11', {}, () => U.field.dash.at(1).x)
    const w = emitModule(module({ structs: [U.struct], bindings: [U.binding], funcs: { g } }))
    expect(w).toContain('xu11.dash[1u]') // u32 index lift — `[1.0]` was invalid WGSL
  })

  it('X12: lift returns ReadonlyNode<string>, no longer assignable to every key', () => {
    // @ts-expect-error — lift(3) is ReadonlyNode<string>, not ReadonlyNode<'bool'> (#763 X12)
    const bad: ReadonlyNode<'bool'> = lift(3)
    void bad
    expect(lift(3).type).toEqual(f32T)
  })

  it('X15: smoothstep has a K-preserving vector overload; mixed swizzle sets throw', () => {
    const g = fn('x15', { e: vec2fT, x: vec2fT }, ({ e, x }) => smoothstep(e, e, x).x)
    expect(emitF(g)).toContain('smoothstep(e, e, x)')
    const v = vec4(1, 2, 3, 4)
    expect(() => v.swizzle('xg')).toThrow(/mixes xyzw and rgba/)
  })

  it('X17: matchExpr accepts thunk arms (the when/matchEnum symmetry)', () => {
    const g = fn('x17', { k: u32T }, ({ k }) =>
      matchExpr(
        k,
        [
          [0, () => f32(1)],
          [1, f32(2)],
        ],
        () => f32(9),
      ),
    )
    const w = emitF(g)
    expect(w).toContain('switch')
  })
})
