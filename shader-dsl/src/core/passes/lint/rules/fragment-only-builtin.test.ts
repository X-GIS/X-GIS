import { describe, it, expect } from 'vitest'
import { lint } from '../engine'
import {
  module,
  fn,
  vec2,
  vec2fT,
  vec4fT,
  vec3uT,
  voidT,
  textureSample,
  textureSampleLevel,
} from '../../../ir'
import { resource, builtin } from '../../../sot'
import { texture2dfT, samplerT } from '../../../ir'
import { emitModule } from '../../../backends/wgsl'
import { ValidationError } from '../../validate'
import { fragmentOnlyBuiltin } from './fragment-only-builtin'

const FIX = 'textureSample is fragment-only in WGSL — use textureSampleLevel(tex, smp, uv, level)'

const tex = resource('fob_tex', texture2dfT, { group: 0, binding: 0 })
const smp = resource('fob_smp', samplerT, { group: 0, binding: 1 })

// leaf → mid: the fragment-only call sits TWO hops below any entry, so a direct-call
// check would miss it (transitive reachability is the point).
const leaf = fn('fob_leaf', { uv: vec2fT }, vec4fT, ({ uv }) =>
  textureSample(tex.node, smp.node, uv),
)
const mid = fn('fob_mid', { uv: vec2fT }, vec4fT, ({ uv }) => leaf({ uv }))
const leafLevel = fn('fob_leaf_level', { uv: vec2fT }, vec4fT, ({ uv }) =>
  textureSampleLevel(tex.node, smp.node, uv, 1),
)

const vsCalling = (callee: typeof mid) =>
  fn('fob_vs', {}, vec4fT, () => callee({ uv: vec2(0, 0) }), {
    stage: 'vertex',
    retAttr: builtin('position', vec4fT),
  })

const run = (m: ReturnType<typeof module>) => lint(m, [fragmentOnlyBuiltin])

describe('fragment-only-builtin (#1650)', () => {
  it('flags textureSample reached TRANSITIVELY from a vertex entry', () => {
    const ds = run(
      module({ bindings: [tex.binding, smp.binding], funcs: [vsCalling(mid), mid, leaf] }),
    )
    expect(ds.map((d) => d.ruleId)).toEqual(['fragment-only-builtin'])
    expect(ds[0]?.message).toBe(FIX)
    expect(ds[0]?.fn).toBe('fob_leaf')
    expect(ds[0]?.code).toBe('SD0109')
  })

  it('flags the same chain reached from a COMPUTE entry', () => {
    const cs = fn(
      'fob_cs',
      { gid: builtin('global_invocation_id', vec3uT) },
      voidT,
      (_p, b) => {
        b.let('sampled', mid({ uv: vec2(0, 0) }))
      },
      { stage: 'compute', workgroupSize: 64 },
    )
    const ds = run(module({ bindings: [tex.binding, smp.binding], funcs: [cs, mid, leaf] }))
    expect(ds.map((d) => d.message)).toEqual([FIX])
  })

  it('stays silent when the SAME helper is reachable only from a fragment entry', () => {
    const fs = fn('fob_fs', {}, vec4fT, () => mid({ uv: vec2(0, 0) }), { stage: 'fragment' })
    expect(run(module({ bindings: [tex.binding, smp.binding], funcs: [fs, mid, leaf] }))).toEqual(
      [],
    )
  })

  it('stays silent for textureSampleLevel in a vertex entry (the sanctioned fix)', () => {
    const m = module({
      bindings: [tex.binding, smp.binding],
      funcs: [vsCalling(leafLevel), leafLevel],
    })
    expect(run(m)).toEqual([])
  })

  it('emitModule THROWS on the vertex violation — the rule is wired into CORE_RULES', () => {
    const m = module({ bindings: [tex.binding, smp.binding], funcs: [vsCalling(mid), mid, leaf] })
    expect(() => emitModule(m)).toThrow(ValidationError)
    expect(() => emitModule(m)).toThrow(/fragment-only in WGSL/)
  })
})
