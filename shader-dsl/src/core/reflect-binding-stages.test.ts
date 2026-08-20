import { describe, it, expect } from 'vitest'
import { fn, module, vec4, vec2, toF32, vec4fT, vec2fT, f32T, f64T } from './ir/index.js'
import { uniformStruct, ioStruct, location, builtin } from './sot.js'
import { reflect } from './reflect.js'
import { emitGlslModule } from './backends/glsl.js'

// ═══ #1906 — `BindEntry.stages`: reflection reports which stages reach a binding ═══
//
// A host cannot build a bind group layout from a reflection that omits this:
// `GPUBindGroupLayoutEntry.visibility` is a REQUIRED stage mask, and a WebGL2 host
// assigning UBO points / texture units needs the same fact. Before this every host
// re-declared it by hand beside the binding (32 such sites in one reported consumer),
// and a wrong hand-authored mask does not fail — it produces a silently wrong layout.
//
// The fact is not new: the per-stage GLSL emit has always had to decide which unit
// declares which uniform. What is new is that ONE walk now answers both
// (passes/stage-bindings.ts) — the agreement gate at the bottom of this file is what
// keeps it that way.

const stagesOf = (r: ReturnType<typeof reflect>, name: string): readonly string[] =>
  r.bindGroups.flatMap((g) => g.entries).find((e) => e.name === name)!.stages

/** vertex reads `cam`, fragment reads `tint`, both read `shared`, nobody reads `dead`. */
const VOut = ioStruct('VOut', {
  position: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})
const Cam = uniformStruct('Cam', { group: 0, binding: 0, as: 'cam' }, { mvp: vec4fT })
const Tint = uniformStruct('Tint', { group: 0, binding: 1, as: 'tint' }, { color: vec4fT })
const Shared = uniformStruct('Shared', { group: 0, binding: 2, as: 'shared_u' }, { k: f32T })
const Dead = uniformStruct('Dead', { group: 0, binding: 3, as: 'dead' }, { z: f32T })

const pair = () =>
  module({
    uses: [Cam, Tint, Shared, Dead],
    structs: [VOut.decl],
    funcs: [
      fn(
        'vs',
        { pos: location(0, vec4fT) },
        ({ pos }) => {
          const o = VOut.var()
          o.position.assign(pos.add(Cam.field.mvp).mul(Shared.field.k))
          o.uv.assign(vec2(pos.x, pos.y))
          return o.$
        },
        { stage: 'vertex' },
      ),
      fn('fs', { in: VOut }, (p) => Tint.field.color.mul(Shared.field.k).add(vec4(p.in.uv, 0, 0)), {
        stage: 'fragment',
        retAttr: '@location(0)',
      }),
    ],
  })

describe('#1906 — BindEntry.stages', () => {
  it('reports the stage that actually reaches each binding, not every stage', () => {
    const r = reflect(pair())
    // fail-before: the field did not exist, and a host had to author all four by hand.
    expect(stagesOf(r, 'cam')).toEqual(['vertex'])
    expect(stagesOf(r, 'tint')).toEqual(['fragment'])
    expect(stagesOf(r, 'shared_u')).toEqual(['vertex', 'fragment'])
  })

  it('reports [] for a declared binding no entry reaches — and still lists it', () => {
    // `bindGroups` stays the COMPLETE set of declared bindings; empty is a fact
    // ("no stage reads it"), not a gap a host should paper over with a default mask.
    const r = reflect(pair())
    expect(stagesOf(r, 'dead')).toEqual([])
    expect(r.bindGroups[0]!.entries.map((e) => e.name)).toEqual(['cam', 'tint', 'shared_u', 'dead'])
  })

  it('reports compute for a compute-only module', () => {
    const K = uniformStruct('K', { group: 0, binding: 0, as: 'k' }, { n: f32T })
    const m = module({
      uses: [K],
      funcs: [fn('cs', {}, () => K.field.n.mul(2), { stage: 'compute', workgroupSize: 32 })],
    })
    expect(stagesOf(reflect(m), 'k')).toEqual(['compute'])
  })

  it('reaches a binding through a HELPER call, not just a direct entry reference', () => {
    // The walk is a call-graph closure — a binding read two calls deep is still reached.
    const U = uniformStruct('U', { group: 0, binding: 0, as: 'u' }, { k: f32T })
    const leaf = fn('leaf', {}, () => U.field.k)
    const mid = fn('mid', {}, () => leaf({}))
    const m = module({
      uses: [U],
      funcs: [mid, leaf, fn('fs', {}, () => vec4(mid({}), 0, 0, 1), { stage: 'fragment' })],
    })
    expect(stagesOf(reflect(m), 'u')).toEqual(['fragment'])
  })

  it('reports the INJECTED `_fp64` guard under the stage whose f64 pulled it in (#1724)', () => {
    // The guard is referenced only by an intrinsic's SPELLING (`f64Guard` fetches `_fp64`
    // with no argument node), and only in the module fp64Lower produced — so a walk over
    // the AUTHORED module would report []. It must not: a host that binds nothing there
    // gets a guard reading something other than 1.0 and no error on WebGL2 at all.
    const U = uniformStruct('U', { group: 0, binding: 0, as: 'u' }, { epoch: f64T })
    const m = module({
      uses: [U],
      funcs: [
        fn('fs', {}, () => vec4(toF32(U.field.epoch.add(1.0)), 0, 0, 1), { stage: 'fragment' }),
      ],
    })
    expect(stagesOf(reflect(m), '_fp64')).toEqual(['fragment'])
  })

  // ── The agreement gate ──
  //
  // Two implementations of "which bindings does this stage need" would be worth nothing
  // if they could disagree: a host would build a mask narrower than the shader it runs
  // (WebGPU validation error; on WebGL2, a silently unbound sampler). They share one walk
  // — this asserts the shared result against what the backend ACTUALLY emitted, which is
  // the only statement a future refactor of either side cannot quietly break.
  it('agrees with the per-stage GLSL emit about which stage declares which binding', () => {
    const m = pair()
    const r = reflect(m)
    const declared = (stage: 'vertex' | 'fragment', name: string): boolean =>
      new RegExp(`\\b${name}\\b`).test(emitGlslModule(m, stage))
    for (const e of r.bindGroups.flatMap((g) => g.entries))
      for (const stage of ['vertex', 'fragment'] as const)
        expect({ name: e.name, stage, glsl: declared(stage, e.name) }).toEqual({
          name: e.name,
          stage,
          glsl: e.stages.includes(stage),
        })
  })
})
