// Survey (browser side): every point of a VARIANT FAMILY, compiled and linked on a real
// WebGL2 driver (#1715 Problem A). The unit test beside `linkVariants` drives the
// aggregation with a recorder and cannot reject bad GLSL; this is the half that can.
//
// The axes are the two failure classes the consumer reported finding only at the pixel-test
// stage, because both are per-variant — the combination that selects the axis is the one
// that breaks, and a single-variant gate never selects it:
//
//   sampled   the fragment reads a texture — the "missing sampler precision" failure
//   varying   the vertex→fragment INTERFACE gains a member, and the fragment reads it —
//             the "interface mismatch between a vertex/fragment pair" failure, which a
//             per-stage COMPILE cannot see and only a LINK can
//
// The family is purpose-built rather than lifted from map/: what is under test is the gate
// entry point plus the two classes, and a real map shader would drag its whole build graph
// into a spec that is about neither.

import { linkVariants, type VariantLinkResult } from '../../shader-dsl/src/core/variant-link'
import { variantFamily } from '../../shader-dsl/src/core/variant-family'
import { builtin, ioStruct, location, resource } from '../../shader-dsl/src/core/sot'
import {
  fn,
  module,
  textureSample,
  u32,
  toF32,
  vec2,
  vec4,
  samplerT,
  texture2dfT,
  u32T,
  vec2fT,
  vec4fT,
} from '../../shader-dsl/src/core/ir'

export interface VariantSurvey {
  readonly keys: readonly string[]
  /** How many of the emitted fragment sources are DISTINCT. A matrix whose variants all
   *  emit the same bytes is one program checked N times; the spec asserts on this so the
   *  gate cannot quietly degrade into that. */
  readonly distinctFragments: number
  readonly rows: readonly VariantLinkResult[]
  readonly renderer: string
}

export function surveyVariantLink(): VariantSurvey {
  const family = variantFamily({
    axes: { sampled: [false, true] as const, varying: [false, true] as const },
    build: ({ sampled, varying }) => {
      const tex = resource('u_tex', texture2dfT, { group: 0, binding: 0 })
      const smp = resource('u_smp', samplerT, { group: 0, binding: 1 })
      const VsOut = varying
        ? ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })
        : ioStruct('VsOut', { pos: builtin('position', vec4fT) })
      // A fullscreen triangle derived from the vertex index — no vertex buffer, the same
      // shape examples/_fullscreen.ts uses.
      const vs = fn(
        'vs',
        { vi: builtin('vertex_index', u32T) },
        ({ vi }) => {
          const x = toF32(vi.bitAnd(u32(1)))
            .mul(4)
            .sub(1)
          const y = toF32(vi.shr(u32(1)))
            .mul(4)
            .sub(1)
          const pos = vec4(x, y, 0, 1)
          return varying
            ? VsOut.construct({ pos, uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)) })
            : VsOut.construct({ pos })
        },
        { stage: 'vertex' },
      )
      const fs = fn(
        'fs',
        { vo: VsOut },
        ({ vo }) => {
          // Reading `vo.uv` is what makes `varying` an INTERFACE change rather than an
          // unused output the linker is free to ignore.
          const uv = varying ? (vo as { uv: ReturnType<typeof vec2> }).uv : vec2(0.5, 0.5)
          return sampled ? textureSample(tex.node, smp.node, uv) : vec4(uv, 0.0, 1.0)
        },
        { stage: 'fragment' },
      )
      return module({
        uses: sampled ? [VsOut, tex, smp] : [VsOut],
        funcs: [vs, fs],
      })
    },
    key: ({ sampled, varying }) => `probe/s=${sampled ? 1 : 0}/v=${varying ? 1 : 0}`,
  })

  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return { keys: family.keys, distinctFragments: 0, rows: [], renderer: 'NO WEBGL2' }

  return {
    keys: family.keys,
    distinctFragments: new Set(family.emit('glsl-es300', { stage: 'fragment' }).values()).size,
    rows: linkVariants(gl, family),
    renderer: String(gl.getParameter(gl.RENDERER)),
  }
}
