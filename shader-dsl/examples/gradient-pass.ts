// ═══ @xgis/shader-dsl example — fullscreen gradient pass ═══
//
// A self-contained render pass: an oversized fullscreen triangle (no vertex buffer)
// feeds a fragment stage that mixes two colours by the screen-space UV, modulated by a
// uniform. Shows the std140 uniform block + the `If/elif` control-flow combinator. The
// /shader-dsl site page packs `top`/`bottom`/`mix_bias` into the UBO from reflect().

import {
  fn, module, vec2, vec4, f32, mix,
  f32T, u32T, vec2fT, vec4fT,
  If, ioStruct, builtin, location, uniformStruct,
} from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

// Uniform block — std140-laid-out by reflect(). `top`/`bottom` are the two gradient
// endpoints; `mix_bias` shifts the blend up or down.
const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' }, {
  top: vec4fT,
  bottom: vec4fT,
  mix_bias: f32T,
})

// Vertex → fragment interface struct.
const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

// Oversized fullscreen triangle (3 verts, NDC −1..3) — covers the screen from a single
// non-indexed draw with no vertex buffer.
const vsFull = fn('vs_full', { idx: builtin('vertex_index', u32T) }, (p) => {
  const pos = vec2(-1, -1)
  If(p.idx.eq(1), () => { pos.assign(vec2(3, -1)) })
    .elif(p.idx.eq(2), () => { pos.assign(vec2(-1, 3)) })
  return VsOut.construct({
    pos: vec4(pos, 0, 1),
    uv: vec2(pos.x.add(1).mul(0.5), pos.y.add(1).mul(0.5)),
  })
}, { stage: 'vertex' })

// Fragment — vertical gradient between the two uniform colours, biased. `vo` (not `in`,
// a GLSL reserved word) is the fragment input.
const fsGradient = fn('fs_gradient', { vo: VsOut }, (p) => {
  const t = p.vo.uv.y.add(U.field.mix_bias)
  const rgb = mix(U.field.bottom.rgb, U.field.top.rgb, t)
  return vec4(rgb, f32(1))
}, { stage: 'fragment', retAttr: '@location(0)' })

const gradientModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vsFull, fsGradient],
})

export const gradient: ShaderExample = {
  id: 'gradient',
  title: 'Gradient pass',
  blurb: 'A two-colour vertical gradient with a biasable blend — the minimal render pass. `top`/`bottom`/`mix_bias` are packed into one std140 uniform block recovered from reflect().',
  category: 'generic',
  file: 'gradient-pass.ts',
  module: gradientModule,
  renderable: true,
  controls: {
    top: { kind: 'const', value: [0.16, 0.5, 0.95, 1] },     // sky blue
    bottom: { kind: 'const', value: [0.02, 0.03, 0.09, 1] }, // near-black
    mix_bias: { kind: 'slider', label: 'Mix bias', min: -0.5, max: 0.5, step: 0.01, value: 0 },
  },
}
