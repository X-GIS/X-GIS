import { describe, it, expect } from 'vitest'
import { requiredCaps, assertCaps } from './required-caps'
import { wgslBackend } from '../backends/wgsl'
import { glslEs300Backend, UnsupportedFeatureError } from '../backends/glsl'
import { module, fn, f32, f32T, arrayT, vec3uT, voidT } from '../ir'
import { builtin } from '../sot'

// #9 — the capability model wired into emit. A module declares the GPU features
// it needs (requiredCaps); emit asserts the target backend covers them and fails
// closed (UnsupportedFeatureError) otherwise — never a silent mis-emit.
const storageMod = () =>
  module({
    bindings: [
      {
        group: 0,
        binding: 0,
        name: 'buf',
        space: 'storage' as const,
        access: 'read' as const,
        type: arrayT(f32T),
      },
    ],
  })

describe('capabilities — requiredCaps + assertCaps (#9)', () => {
  it('a storage binding requires storageBuffer', () => {
    expect(requiredCaps(storageMod())).toContain('storageBuffer')
  })

  it('a @compute entry requires compute', () => {
    const m = module({
      funcs: [
        fn(
          'cs',
          { gid: builtin('global_invocation_id', vec3uT) },
          voidT,
          () => {
            /* empty */
          },
          { stage: 'compute', workgroupSize: 64 },
        ),
      ],
    })
    expect(requiredCaps(m)).toContain('compute')
  })

  it('a pure module requires nothing', () => {
    const m = module({
      funcs: [
        fn('k', {}, f32T, (_p, b) => {
          b.ret(f32(1))
        }),
      ],
    })
    expect(requiredCaps(m)).toHaveLength(0)
  })

  it('assertCaps throws UnsupportedFeatureError when the backend lacks a cap', () => {
    expect(() => assertCaps(glslEs300Backend, storageMod())).toThrow(UnsupportedFeatureError)
  })

  it('assertCaps passes when the backend covers all required caps (wgsl)', () => {
    expect(() => assertCaps(wgslBackend, storageMod())).not.toThrow()
  })

  // #628 — opt-in language-feature caps (enables) fold into requiredCaps and gate
  // exactly like the derived resource caps: WGSL covers them, GLSL fails closed.
  const f16Mod = () =>
    module({
      enables: ['f16'],
      funcs: [
        fn('k', {}, f32T, (_p, b) => {
          b.ret(f32(1))
        }),
      ],
    })

  it('an enables:[f16] module requires f16', () => {
    expect(requiredCaps(f16Mod())).toContain('f16')
  })

  it('assertCaps fails closed on GLSL for an f16 module', () => {
    expect(() => assertCaps(glslEs300Backend, f16Mod())).toThrow(UnsupportedFeatureError)
  })

  it('assertCaps passes an f16 module on WGSL (the emitter can spell it)', () => {
    expect(() => assertCaps(wgslBackend, f16Mod())).not.toThrow()
  })
})
