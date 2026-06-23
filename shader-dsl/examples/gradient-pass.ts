// ═══ @xgis/shader-dsl example — fullscreen gradient pass ═══
//
// A self-contained render pass authored with the DSL: an oversized fullscreen
// triangle (no vertex buffer) feeds a fragment stage that mixes two colours by
// the screen-space UV, modulated by a uniform. Emits WGSL and prints the
// pipeline reflection (bind groups + std140 uniform layout + entry signatures).
//
// Run WITHOUT the X-GIS runtime:  npx tsx examples/gradient-pass.ts

import {
  fn, module, vec2, vec4, f32, mix,
  f32T, u32T, vec2fT, vec4fT,
  If, reflect, emitModule,
  ioStruct, builtin, location, uniformStruct,
} from '../src/index.ts'

// Uniform block — std140-laid-out by reflect().  `top`/`bottom` are the two
// gradient endpoints; `mix_bias` shifts the blend.
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

// Oversized fullscreen triangle (3 verts, NDC −1..3) — covers the screen from a
// single non-indexed draw with no vertex buffer.
const vsFull = fn('vs_full', { idx: builtin('vertex_index', u32T) }, (p) => {
  const pos = vec2(-1, -1)
  If(p.idx.eq(1), () => { pos.assign(vec2(3, -1)) })
    .elif(p.idx.eq(2), () => { pos.assign(vec2(-1, 3)) })
  return VsOut.construct({
    pos: vec4(pos, 0, 1),
    uv: vec2(pos.x.add(1).mul(0.5), pos.y.add(1).mul(0.5)),
  })
}, { stage: 'vertex' })

// Fragment — vertical gradient between the two uniform colours, biased.
const fsGradient = fn('fs_gradient', { in: VsOut.type }, (p) => {
  const pin = VsOut.of(p.in)
  const t = pin.uv.y.add(U.field.mix_bias)
  const rgb = mix(U.field.bottom.swizzle<'vec3<f32>'>('rgb'), U.field.top.swizzle<'vec3<f32>'>('rgb'), t)
  return vec4(rgb, f32(1))
}, { stage: 'fragment', retAttr: '@location(0)' })

const gradientModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vsFull, fsGradient],
})

console.log('=== WGSL ===')
console.log(emitModule(gradientModule))

console.log('\n=== Reflection ===')
console.log(JSON.stringify(reflect(gradientModule), null, 2))
