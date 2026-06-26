// ═══ @xgis/shader-dsl example — raymarched sphere (signed-distance field) ═══
//
// A sphere distance-field, sphere-traced from a camera ray, then Blinn-Phong shaded
// with an orbiting light. The "hello world" of raymarching. Showcases the new
// `normalize` builtin (ray + surface normal), `length` (the SDF), `dot`, a `Loop`
// march with early `Break`, and a mutable colour `var`. WGSL + GLSL ES 3.00.

import {
  fn, module, uniformStruct, ioStruct,
  u32, f32, toF32, vec2, vec3, vec4,
  sin, cos, dot, max, pow, normalize, length, location, builtin, Loop, If, Break,
  f32T, vec2fT, vec4fT, u32T,
} from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'U' }, { time: f32T, resolution: vec2fT })

const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

const vs = fn('vs', { vi: builtin('vertex_index', u32T) }, ({ vi }) => {
  const x = toF32(vi.bitAnd(u32(1))).mul(4).sub(1)
  const y = toF32(vi.shr(u32(1))).mul(4).sub(1)
  return VsOut.construct({ pos: vec4(x, y, 0, 1), uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)) })
}, { stage: 'vertex' })

const fs = fn('fs', { vo: VsOut.type }, ({ vo }) => {
  const uv = VsOut.of(vo).uv
  const ndc = vec2(uv.x.mul(2).sub(1), uv.y.mul(2).sub(1))
  const ro = vec3(0, 0, 3) // camera
  const rd = normalize(vec3(ndc.x, ndc.y, -1.5)) // ray direction
  // sphere-trace a unit sphere at the origin: SDF = |p| − 1
  const t = f32(0)
  const hit = f32(0)
  Loop(u32(0), (i) => i.lt(u32(72)), (i) => {
    const p = ro.add(rd.mul(t))
    const d = length(p).sub(1)
    If(d.lt(0.001), () => { hit.assign(1); Break() })
    t.assign(t.add(d))
    If(t.gt(8), () => { Break() })
  })
  // background: a soft vertical gradient
  const col = vec3(0.04, 0.05, 0.09).add(vec3(0.0, 0.04, 0.10).mul(uv.y))
  If(hit.gt(0.5), () => {
    const p = ro.add(rd.mul(t))
    const n = normalize(p)
    const ld = normalize(vec3(cos(U.field.time), 0.75, sin(U.field.time)))
    const diff = max(dot(n, ld), 0)
    const h = normalize(ld.sub(rd)) // Blinn-Phong halfway (view dir = −rd)
    const spec = pow(max(dot(n, h), 0), 48)
    const rim = pow(f32(1).sub(max(dot(n, rd.neg()), 0)), 2)
    col.assign(
      vec3(0.22, 0.48, 0.95).mul(diff.mul(0.85).add(0.12)) // diffuse + ambient
        .add(vec3(1.0).mul(spec.mul(0.6)))                  // specular highlight
        .add(vec3(0.25, 0.35, 0.55).mul(rim.mul(0.5))),     // fresnel rim
    )
  })
  return vec4(col, 1)
}, { stage: 'fragment', retAttr: '@location(0)' })

const raymarchModule = module({ structs: [U.struct, VsOut.decl], bindings: [U.binding], funcs: [vs, fs] })

export const raymarchSphere: ShaderExample = {
  id: 'raymarch-sphere',
  title: 'Raymarched sphere',
  blurb: 'A sphere signed-distance field, sphere-traced from a camera ray and Blinn-Phong shaded with an orbiting light. The "hello world" of raymarching — built on normalize / length / dot + a Loop march.',
  category: 'generic',
  file: 'raymarch-sphere.ts',
  module: raymarchModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
  },
}
