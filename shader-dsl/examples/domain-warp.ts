// ═══ @xgis/shader-dsl example — domain warping (fbm of fbm of fbm) ═══
//
// Inigo Quilez's domain-warping construction: instead of colouring by
// fbm(p) directly, feed noise its own output — f(p) = fbm(p + w·fbm(p + fbm(p)))
// — and the lattice melts into marbled, organic flow. The intermediate warp
// vectors q and r double as colour axes. The fbm helper here is a 4-octave
// UNROLLED expression (each octave doubles frequency, halves amplitude), so
// it stays a pure value function. WGSL (WebGPU) + GLSL ES 3.00 (WebGL2).

import {
  fn,
  module,
  vec2,
  vec3,
  vec4,
  sin,
  floor,
  fract,
  dot,
  mix,
  length,
  clamp,
  smoothstep,
  Let,
  f32T,
  vec2fT,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms, screenCoords } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'
const U = fullscreenUniforms({ warp: f32T })

// scalar hash of a lattice point → [0,1)
const hash = fn('hash', { p: vec2fT }, ({ p }) =>
  fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)),
)

// bilinear value noise with smootherstep weights
const noise = fn('noise', { p: vec2fT }, ({ p }) => {
  const i = Let(floor(p))
  const f = Let(fract(p))
  const u = f.mul(f).mul(vec2(3).sub(f.mul(2)))
  return mix(
    mix(hash({ p: i }), hash({ p: i.add(vec2(1, 0)) }), u.x),
    mix(hash({ p: i.add(vec2(0, 1)) }), hash({ p: i.add(vec2(1, 1)) }), u.x),
    u.y,
  )
})

// 4-octave fbm, unrolled so the helper stays a pure value expression
const fbm = fn('fbm', { p: vec2fT }, ({ p }) => {
  return noise({ p })
    .mul(0.5)
    .add(noise({ p: p.mul(2.02) }).mul(0.25))
    .add(noise({ p: p.mul(4.08) }).mul(0.125))
    .add(noise({ p: p.mul(8.2) }).mul(0.0625))
})

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const t = U.field.time
    const res = U.field.resolution
    const p = screenCoords(vo.uv, res).mul(1.8)
    const w = U.field.warp
    // first warp: q = (fbm(p), fbm(p + k₁))
    const q = Let(vec2(fbm({ p }), fbm({ p: p.add(vec2(5.2, 1.3)) })))
    // second warp: r = (fbm(p + w·q + k₂ + drift), fbm(p + w·q + k₃))
    const pq = p.add(q.mul(w))
    const r = Let(
      vec2(
        fbm({ p: pq.add(vec2(1.7, 9.2)).add(vec2(t.mul(0.15), t.mul(0.12))) }),
        fbm({ p: pq.add(vec2(8.3, 2.8)) }),
      ),
    )
    // final field
    const f = Let(fbm({ p: p.add(r.mul(w)) }))
    // colour: base by f², tinted by the warp magnitudes (iq's construction)
    const a = mix(vec3(0.09, 0.12, 0.2), vec3(0.85, 0.83, 0.72), clamp(f.mul(f).mul(2.8), 0, 1))
    const b = mix(a, vec3(0.2, 0.5, 0.55), clamp(length(q).mul(0.9), 0, 1))
    const c = mix(b, vec3(0.66, 0.3, 0.2), clamp(smoothstep(0.4, 1, r.y).mul(0.6), 0, 1))
    return vec4(c.mul(f.mul(1.4).add(0.35)), 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const domainWarpModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const domainWarp: ShaderExample = {
  id: 'domain-warp',
  title: 'Domain warping',
  blurb:
    'fbm fed its own output — f(p) = fbm(p + w·fbm(p + fbm(p))) — melts lattice noise into marbled organic flow; the intermediate warp vectors double as colour axes. Warp strength is live.',
  category: 'generic',
  file: 'domain-warp.ts',
  module: domainWarpModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    warp: { kind: 'slider', label: 'Warp', min: 0, max: 4, step: 0.1, value: 2.4 },
  },
}
