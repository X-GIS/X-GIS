// ═══ @xgis/shader-dsl example — fBm clouds (fractal value noise) ═══
//
// Value-noise summed over octaves (fractal Brownian motion): each octave doubles
// the frequency and halves the amplitude, drifting over time. The textbook
// procedural-cloud / terrain primitive. Showcases helper fns + a `Loop`-driven
// octave accumulator. One DSL source → WGSL (WebGPU) + GLSL ES 3.00 (WebGL2).

import {
  fn, module, uniformStruct, ioStruct,
  u32, f32, toF32, vec2, vec3, vec4,
  sin, floor, fract, dot, mix, clamp, location, builtin, Loop, Let,
  f32T, vec2fT, vec4fT, u32T,
} from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'U' }, { time: f32T, resolution: vec2fT, octaves: f32T })

const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

const vs = fn('vs', { vi: builtin('vertex_index', u32T) }, ({ vi }) => {
  const x = toF32(vi.bitAnd(u32(1))).mul(4).sub(1)
  const y = toF32(vi.shr(u32(1))).mul(4).sub(1)
  return VsOut.construct({ pos: vec4(x, y, 0, 1), uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)) })
}, { stage: 'vertex' })

// scalar hash of a lattice point → [0,1)
const hash = fn('hash', { p: vec2fT }, ({ p }) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)))

// bilinear value noise with smootherstep weights.
const noise = fn('noise', { p: vec2fT }, ({ p }) => {
  const i = Let(floor(p))
  const f = Let(fract(p))
  const u = f.mul(f).mul(vec2(3).sub(f.mul(2))) // 3f² − 2f³
  return mix(
    mix(hash(i), hash(i.add(vec2(1, 0))), u.x),
    mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), u.x),
    u.y,
  )
})

const fs = fn('fs', { vo: VsOut.type }, ({ vo }) => {
  const uv = VsOut.of(vo).uv
  const q = vec2(uv.x.mul(3), uv.y.mul(3)) // mutable sample point (octave frequency)
  const v = f32(0)
  const amp = f32(0.55)
  Loop(u32(0), (i) => toF32(i).lt(U.field.octaves), (i) => {
    v.assign(v.add(amp.mul(noise(q.add(vec2(U.field.time.mul(0.08), 0))))))
    q.assign(q.mul(2.02))
    amp.assign(amp.mul(0.5))
  })
  // sky → cloud ramp
  const sky = vec3(0.20, 0.42, 0.72)
  const cloud = vec3(0.97, 0.97, 1.0)
  return vec4(mix(sky, cloud, clamp(v, 0, 1)), 1)
}, { stage: 'fragment', retAttr: '@location(0)' })

const fbmModule = module({ structs: [U.struct, VsOut.decl], bindings: [U.binding], funcs: [hash, noise, vs, fs] })

export const fbmClouds: ShaderExample = {
  id: 'fbm-clouds',
  title: 'fBm clouds',
  blurb: 'Fractal Brownian motion — value noise summed over octaves of doubling frequency / halving amplitude, drifting over time. The classic procedural cloud field, octave count live-tunable.',
  category: 'generic',
  file: 'fbm-clouds.ts',
  module: fbmModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    octaves: { kind: 'slider', label: 'Octaves', min: 1, max: 8, step: 1, value: 6 },
  },
}
