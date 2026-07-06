// ═══ @xgis/shader-dsl example — ocean horizon (fBm water + sun glitter) ═══
//
// A Seascape-style seascape from first principles: a perspective-divided water
// plane below the horizon sampled with octaves of value noise, a warm sky
// gradient with a sun disc above it, and a glitter path where wave crests
// align under the sun. Everything is one fragment — sky and sea are both
// evaluated and blended by a horizon step, no branches on uniform state.
// WGSL (WebGPU) + GLSL ES 3.00 (WebGL2).

import {
  fn,
  module,
  u32,
  f32,
  vec2,
  vec3,
  vec4,
  sin,
  floor,
  fract,
  dot,
  mix,
  max,
  pow,
  exp,
  abs,
  step,
  distance,
  smoothstep,
  clamp,
  Loop,
  Let,
  f32T,
  vec2fT,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'
const U = fullscreenUniforms({ swell: f32T })

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

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const t = U.field.time
    const res = U.field.resolution
    const asp = res.x.div(res.y)
    const x = vo.uv.x.mul(2).sub(1).mul(asp)
    const y = vo.uv.y
    const horizon = f32(0.58)
    const sunX = f32(0.42)

    // ── sky: warm haze at the horizon rising to a deep zenith, plus the sun
    const sky = mix(vec3(0.83, 0.58, 0.38), vec3(0.12, 0.28, 0.48), smoothstep(horizon, 1, y))
    // sun distance in ISOTROPIC coordinates — x spans 2·aspect over the width
    // and y·2−1 spans 2 over the height, so units match and the disc stays round
    const y2 = y.mul(2).sub(1)
    const dSun = Let(distance(vec2(x, y2), vec2(sunX, 0.56)))
    const sun = f32(1).sub(smoothstep(0.035, 0.06, dSun))
    const halo = exp(dSun.mul(4).neg()).mul(0.35)
    const skyCol = sky.add(vec3(1.0, 0.85, 0.6).mul(sun.add(halo)))

    // ── sea: perspective-divide the rows below the horizon into a plane,
    // then sum fBm octaves of value noise drifting with time
    const dpt = Let(max(horizon.sub(y), 0.0008)) // 0 at the horizon
    const wz = Let(f32(0.06).div(dpt)) // world distance along the plane
    const sp = vec2(x.mul(wz).mul(0.6), wz.add(t.mul(0.6))).mul(3)
    // fBm accumulator — 4 octaves, frequency ×2, amplitude ×½
    const h = f32(0)
    const amp = f32(0.5)
    const freq = f32(1)
    Loop(
      u32(0),
      (i) => i.lt(u32(4)),
      () => {
        h.assign(h.add(amp.mul(noise({ p: sp.mul(freq).add(vec2(t.mul(0.12), 0)) }))))
        freq.assign(freq.mul(2.03))
        amp.assign(amp.mul(0.5))
      },
    )
    // fade the wave texture right at the horizon (sub-pixel noise reads as static)
    const wave = h.mul(U.field.swell).mul(smoothstep(0, 0.05, dpt))
    // deep near water lifting to the hazy horizon colour in the distance
    const sea = mix(vec3(0.05, 0.18, 0.28), vec3(0.55, 0.5, 0.45), exp(dpt.mul(7).neg())).add(
      vec3(0.3, 0.38, 0.36).mul(wave),
    )
    // sun-glitter path: bright crests, inside a column under the sun, fading out
    const glint = pow(max(wave.sub(0.32), 0).mul(2.6), 3)
      .mul(exp(abs(x.sub(sunX)).mul(2.2).neg()))
      .mul(exp(dpt.mul(2.5).neg()))
    const seaCol = sea.add(vec3(1.0, 0.85, 0.6).mul(clamp(glint, 0, 1.2)))

    const col = mix(seaCol, skyCol, step(horizon, y))
    return vec4(col, 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const oceanModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const ocean: ShaderExample = {
  id: 'ocean',
  title: 'Ocean horizon',
  blurb:
    'A seascape from first principles — the rows below the horizon perspective-divided into a water plane, waved by fBm value noise, with a sun disc and a glitter path where crests align beneath it. Swell height is live.',
  category: 'generic',
  file: 'ocean.ts',
  module: oceanModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    swell: { kind: 'slider', label: 'Swell', min: 0, max: 1.5, step: 0.05, value: 0.8 },
  },
}
