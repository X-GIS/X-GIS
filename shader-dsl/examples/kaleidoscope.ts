// ═══ @xgis/shader-dsl example — kaleidoscope (polar mirror fold) ═══
//
// The kaleidoscope fold: convert to polar, floor-mod the angle into one
// sector, mirror about the sector's midline, convert back — every sector now
// shows the same wedge of pattern, seamlessly. The pattern inside the wedge is
// swirling fbm + concentric rings through a cosine palette. The fold uses
// `mod` (#839), the portable FLOOR-mod, so the negative angles atan2
// produces wrap identically on both targets. WGSL + GLSL ES 3.00 (WebGL2).

import {
  fn,
  module,
  f32,
  vec2,
  vec3,
  vec4,
  sin,
  cos,
  floor,
  fract,
  dot,
  mix,
  abs,
  mod,
  length,
  atan2,
  smoothstep,
  Let,
  f32T,
  vec2fT,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms, screenCoords } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'
const U = fullscreenUniforms({ segments: f32T })

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

const palette = fn('palette', { t: f32T }, ({ t }) => {
  const ph = vec3(0.0, 0.33, 0.67)
  return vec3(0.5).add(cos(t.add(ph).mul(6.283)).mul(0.5))
})

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const t = U.field.time
    const res = U.field.resolution
    const p = screenCoords(vo.uv, res)
    const r = Let(length(p))
    const a0 = Let(atan2(p.y, p.x))
    // fold: floor-mod the angle into one sector, mirror about its midline
    const sector = Let(f32(6.2831853).div(U.field.segments))
    const am = mod(a0, sector)
    const af = Let(abs(am.sub(sector.mul(0.5))))
    const q = vec2(cos(af), sin(af)).mul(r)
    // wedge pattern: swirling fbm + concentric rings
    const v = Let(fbm({ p: q.mul(3).add(vec2(t.mul(0.12), t.mul(0.09).neg())) }))
    const rings = sin(r.mul(9).sub(t.mul(0.8)))
      .mul(0.5)
      .add(0.5)
    const col = palette({ t: v.mul(0.7).add(rings.mul(0.15)).add(r.mul(0.3)).sub(t.mul(0.03)) })
    // the fbm field doubles as a brightness relief so the wedges keep depth
    const relief = v.mul(0.9).add(0.35)
    // vignette so the fold's outer edge fades instead of clipping
    const vig = f32(1).sub(smoothstep(0.55, 1.25, r))
    return vec4(col.mul(relief).mul(vig), 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const kaleidoscopeModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const kaleidoscope: ShaderExample = {
  id: 'kaleidoscope',
  title: 'Kaleidoscope',
  blurb:
    'The polar mirror fold — the angle floor-modded into one sector and mirrored about its midline, so every sector repeats the same wedge of swirling fbm and rings. Segment count is live.',
  category: 'generic',
  file: 'kaleidoscope.ts',
  module: kaleidoscopeModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    segments: { kind: 'slider', label: 'Segments', min: 3, max: 12, step: 1, value: 6 },
  },
}
