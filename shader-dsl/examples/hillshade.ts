// ═══ @xgis/shader-dsl example — hillshade (shaded relief) ═══
//
// A cartographic shader: procedural terrain + Lambert hillshade, the shaded-relief look
// of a topographic map. A reusable `terrain()` DSL function (called 3× — once for height,
// twice for a finite-difference normal) feeds a sun-lit hypsometric tint. The sun azimuth
// and vertical exaggeration are live uniforms; the terrain drifts over time.

import {
  fn, module, uniformStruct, ioStruct,
  u32, toF32, vec2, vec3, vec4,
  sin, cos, radians, clamp, dot, length, mix, smoothstep, f32,
  location, builtin,
  f32T, vec2fT, vec4fT, u32T,
} from '../src/index.ts'
import type { Node } from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'U' }, {
  time: f32T,
  resolution: vec2fT,
  sun_az: f32T,
  exaggeration: f32T,
})

const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

// normalize() isn't a DSL builtin — it's just v · (1/|v|). The author spells it inline.
const normalize3 = (v: Node<'vec3<f32>'>): Node<'vec3<f32>'> => v.mul(f32(1).div(length(v)))

const vs = fn('vs', { vi: builtin('vertex_index', u32T) }, ({ vi }) => {
  const x = toF32(vi.bitAnd(u32(1))).mul(4).sub(1)
  const y = toF32(vi.shr(u32(1))).mul(4).sub(1)
  return VsOut.construct({ pos: vec4(x, y, 0, 1), uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)) })
}, { stage: 'vertex' })

// Reusable terrain height field, ~[0,1]. Emitted once, called 3× — a real DSL function.
const terrain = fn('terrain', { p: vec2fT, t: f32T }, ({ p, t }) => {
  const h = sin(p.x.mul(3).add(t)).mul(cos(p.y.mul(3)))
    .add(sin(p.x.mul(6.1).sub(t.mul(0.7))).mul(cos(p.y.mul(5.3))).mul(0.5))
    .add(sin(p.x.mul(12.7)).mul(cos(p.y.mul(11.1))).mul(0.25))
  return h.mul(0.28).add(0.5)
})

const fs = fn('fs', { vo: VsOut.type }, ({ vo }) => {
  const uv = VsOut.of(vo).uv
  const t = U.field.time
  const az = radians(U.field.sun_az)
  const ex = U.field.exaggeration
  const p = uv.mul(6)
  const eps = f32(0.015)

  // Height + two neighbours → a finite-difference surface normal.
  const h = terrain({ p, t })
  const hx = terrain({ p: vec2(p.x.add(eps), p.y), t })
  const hy = terrain({ p: vec2(p.x, p.y.add(eps)), t })
  const n = normalize3(vec3(h.sub(hx).mul(ex), h.sub(hy).mul(ex), eps))

  // Sun from the azimuth (fixed elevation) → Lambert term.
  const sun = normalize3(vec3(cos(az).mul(0.6), sin(az).mul(0.6), 0.55))
  const shade = clamp(dot(n, sun), 0, 1)

  // Hypsometric tint: lowland green → upland tan → snow.
  const low = vec3(0.16, 0.32, 0.20)
  const mid = vec3(0.55, 0.49, 0.30)
  const high = vec3(0.93, 0.93, 0.96)
  const base = mix(mix(low, mid, smoothstep(0.3, 0.55, h)), high, smoothstep(0.62, 0.85, h))
  const lit = base.mul(shade.mul(0.8).add(0.3))
  return vec4(lit, 1)
}, { stage: 'fragment', retAttr: '@location(0)' })

const hillshadeModule = module({ structs: [U.struct, VsOut.decl], bindings: [U.binding], funcs: [vs, terrain, fs] })

export const hillshade: ShaderExample = {
  id: 'hillshade',
  title: 'Hillshade',
  blurb: 'Shaded relief — procedural terrain lit by a movable sun, tinted hypsometrically. A reusable terrain() DSL function is called 3× for the height + finite-difference normal.',
  category: 'cartographic',
  file: 'hillshade.ts',
  module: hillshadeModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    sun_az: { kind: 'slider', label: 'Sun azimuth (°)', min: 0, max: 360, step: 1, value: 135 },
    exaggeration: { kind: 'slider', label: 'Exaggeration', min: 0.5, max: 6, step: 0.1, value: 2.5 },
  },
}
