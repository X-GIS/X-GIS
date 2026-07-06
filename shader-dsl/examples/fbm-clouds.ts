// ═══ @xgis/shader-dsl example — fBm clouds (fractal value noise) ═══
//
// Value-noise summed over octaves (fractal Brownian motion): each octave doubles
// the frequency and halves the amplitude, drifting over time. The textbook
// procedural-cloud / terrain primitive. Showcases helper fns + a `Loop`-driven
// octave accumulator. One DSL source → WGSL (WebGPU) + GLSL ES 3.00 (WebGL2).

import {
  fn,
  module,
  u32,
  f32,
  toF32,
  vec2,
  vec3,
  vec4,
  sin,
  floor,
  fract,
  dot,
  mix,
  clamp,
  Loop,
  Let,
  f32T,
  vec2fT,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'
const U = fullscreenUniforms({ octaves: f32T })

// scalar hash of a lattice point → [0,1)
const hash = fn('hash', { p: vec2fT }, ({ p }) =>
  fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)),
)

// bilinear value noise with smootherstep weights.
const noise = fn('noise', { p: vec2fT }, ({ p }) => {
  const i = Let(floor(p))
  const f = Let(fract(p))
  const u = f.mul(f).mul(vec2(3).sub(f.mul(2))) // 3f² − 2f³
  return mix(
    mix(hash({ p: i }), hash({ p: i.add(vec2(1, 0)) }), u.x),
    mix(hash({ p: i.add(vec2(0, 1)) }), hash({ p: i.add(vec2(1, 1)) }), u.x),
    u.y,
  )
})

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const uv = vo.uv
    const q = vec2(uv.x.mul(3), uv.y.mul(3)) // mutable sample point (octave frequency)
    const v = f32(0)
    const amp = f32(0.55)
    Loop(
      u32(0),
      (i) => toF32(i).lt(U.field.octaves),
      () => {
        v.assign(v.add(amp.mul(noise({ p: q.add(vec2(U.field.time.mul(0.08), 0)) }))))
        q.assign(q.mul(2.02))
        amp.assign(amp.mul(0.5))
      },
    )
    // sky → cloud ramp
    const sky = vec3(0.2, 0.42, 0.72)
    const cloud = vec3(0.97, 0.97, 1.0)
    return vec4(mix(sky, cloud, clamp(v, 0, 1)), 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `hash`/`noise` are called via their handles, so module() collects them transitively — funcs lists only the entry points.
const fbmModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const fbmClouds: ShaderExample = {
  id: 'fbm-clouds',
  title: 'fBm clouds',
  blurb:
    'Fractal Brownian motion — value noise summed over octaves of doubling frequency / halving amplitude, drifting over time. The classic procedural cloud field, octave count live-tunable.',
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
