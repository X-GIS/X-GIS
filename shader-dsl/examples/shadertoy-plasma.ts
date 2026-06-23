// ═══ @xgis/shader-dsl example — a ShaderToy plasma, authored in the DSL ═══
//
// Ports the classic ShaderToy plasma (sum-of-sines → palette) to the DSL: a
// fullscreen-triangle vertex stage + a fragment stage driven by a {time,
// resolution} uniform. One DSL source emits WGSL (WebGPU) AND GLSL ES 3.00
// (WebGL2) plus its pipeline Reflection — the metadata a host needs to build the
// bind-group layout + pack the uniform. The /shader-dsl site page renders this live.

import {
  fn, module, uniformStruct, ioStruct,
  u32, toF32, vec2, vec3, vec4, sin, location, builtin,
  f32T, vec2fT, vec4fT, u32T,
} from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

// {time, resolution} uniform — std140 layout recovered by reflect().
const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'U' }, { time: f32T, resolution: vec2fT })

// vertex→fragment IO: clip position (builtin) + the screen uv.
const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

// Fullscreen triangle: 3 verts covering the screen, uv in [0,1]. No vertex buffer —
// position is derived from the vertex index alone.
const vs = fn('vs', { vi: builtin('vertex_index', u32T) }, ({ vi }) => {
  const x = toF32(vi.bitAnd(u32(1))).mul(4).sub(1) // -1, 3, -1
  const y = toF32(vi.shr(u32(1))).mul(4).sub(1)    // -1, -1, 3
  return VsOut.construct({ pos: vec4(x, y, 0, 1), uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)) })
}, { stage: 'vertex' })

// `vo` (vertex-out), NOT `in`: `in` is a reserved keyword in GLSL, so naming the
// fragment param `in` would emit `vec4 fs_impl(VsOut in)` — a hard WebGL2 compile error.
const fs = fn('fs', { vo: VsOut.type }, ({ vo }) => {
  const t = U.field.time
  const uv = VsOut.of(vo).uv
  // sum-of-sines plasma field
  const v = sin(uv.x.mul(10).add(t))
    .add(sin(uv.y.mul(10).add(t)))
    .add(sin(uv.x.add(uv.y).mul(10).add(t.mul(0.7))))
  // map the field through an RGB palette
  const col = vec3(sin(v), sin(v.add(2.094)), sin(v.add(4.188))).mul(0.5).add(0.5)
  return vec4(col, 1)
}, { stage: 'fragment', retAttr: '@location(0)' })

const plasmaModule = module({ structs: [U.struct, VsOut.decl], bindings: [U.binding], funcs: [vs, fs] })

export const plasma: ShaderExample = {
  id: 'plasma',
  title: 'Plasma',
  blurb: 'The classic sum-of-sines plasma folded through an RGB palette — the "hello shader". One DSL source, animated by a single time uniform.',
  category: 'generic',
  file: 'shadertoy-plasma.ts',
  module: plasmaModule,
  renderable: true,
  controls: { time: { kind: 'time' }, resolution: { kind: 'resolution' } },
}
