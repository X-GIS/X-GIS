import { describe, it, expect } from 'vitest'
import { requiredCaps, assertCaps } from './required-caps'
import { wgslBackend } from '../backends/wgsl'
import { glslEs300Backend, UnsupportedFeatureError } from '../backends/glsl'
import {
  module,
  fn,
  f32,
  f32T,
  u32T,
  arrayT,
  vec3uT,
  voidT,
  texture2dArrayfT,
  texture2duT,
  texture2dArrayiT,
  samplerT,
  bindingRef,
  textureNumLayers,
} from '../ir'
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

  // #1651 — a sampled 2d-ARRAY texture is CORE in both targets (WGSL
  // texture_2d_array<f32>, GLSL ES 3.00 sampler2DArray), so it introduces NO new
  // Capability. Asserted, not assumed: the sibling '2d-ms' dim DOES require one
  // (msaaTextureLoad), so "a texture dim needs a cap" is a live shape here.
  const arrayTexMod = () =>
    module({
      bindings: [
        { group: 0, binding: 0, name: 'atlas', space: 'uniform' as const, type: texture2dArrayfT },
        { group: 0, binding: 1, name: 'atlas_s', space: 'uniform' as const, type: samplerT },
      ],
    })

  it('a 2d-array texture binding requires NOTHING (no new capability)', () => {
    expect(requiredCaps(arrayTexMod())).toEqual([])
  })

  it('assertCaps passes a 2d-array module on the GLSL backend (whose profile has no row for it)', () => {
    expect(() => assertCaps(glslEs300Backend, arrayTexMod())).not.toThrow()
  })

  // #1658 — the layer-COUNT query is core in both targets too (WGSL textureNumLayers,
  // GLSL ES 3.00 textureSize(sampler2DArray, lod).z), so CALLING it adds nothing to the
  // binding-only pin above. requiredCaps derives from bindings/stages/enables, never
  // from call ids — this asserts that stays true for the one array intrinsic that is a
  // query rather than a read.
  const numLayersMod = () =>
    module({
      bindings: [
        { group: 0, binding: 0, name: 'atlas', space: 'uniform' as const, type: texture2dArrayfT },
      ],
      funcs: [
        fn('k', {}, u32T, (_p, b) => {
          b.ret(textureNumLayers(bindingRef('atlas', texture2dArrayfT)))
        }),
      ],
    })

  it('a textureNumLayers CALL requires NOTHING either (no new capability)', () => {
    expect(requiredCaps(numLayersMod())).toEqual([])
  })

  it('assertCaps passes a textureNumLayers module on the EMPTY-caps GLSL backend', () => {
    expect(() => assertCaps(glslEs300Backend, numLayersMod())).not.toThrow()
  })

  // #1703 — an INTEGER sampled texture is core in both targets too (WGSL
  // texture_2d<u32>, GLSL ES 3.00 §4.1.9 usampler2D), so the element axis adds no
  // Capability any more than the dim axis did. Asserted rather than assumed for the
  // same reason as the 2d-array pin above: '2d-ms' proves a texture CAN require one,
  // so an empty result here has to be measured, not presumed.
  const intTexMod = (type: typeof texture2duT | typeof texture2dArrayiT) =>
    module({
      bindings: [{ group: 0, binding: 0, name: 'ids', space: 'uniform' as const, type }],
    })

  it('an integer texture binding requires NOTHING (no new capability)', () => {
    expect(requiredCaps(intTexMod(texture2duT))).toEqual([])
    expect(requiredCaps(intTexMod(texture2dArrayiT))).toEqual([])
  })

  it('assertCaps passes an integer-texture module on the EMPTY-caps GLSL backend', () => {
    expect(() => assertCaps(glslEs300Backend, intTexMod(texture2duT))).not.toThrow()
    expect(() => assertCaps(glslEs300Backend, intTexMod(texture2dArrayiT))).not.toThrow()
  })
})
