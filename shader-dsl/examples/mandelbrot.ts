// ═══ @xgis/shader-dsl example — Mandelbrot set (smooth escape-time) ═══
//
// The fractal every shader site ports first: iterate z ← z² + c where c is the
// pixel, colour by the SMOOTH iteration count (the fractional remainder from
// log₂ log₂ |z|² kills the discrete banding), and breathe the zoom into the
// seahorse valley. Sibling to julia.ts (fixed plane, orbiting c) — here c is
// the plane and the camera moves. f32 precision bounds the useful zoom depth,
// which is exactly the kind of limit X-GIS's RTC/DSFUN machinery exists to
// beat for map coordinates. WGSL (WebGPU) + GLSL ES 3.00 (WebGL2).

import {
  fn,
  module,
  u32,
  f32,
  vec2,
  vec3,
  vec4,
  sin,
  cos,
  dot,
  exp,
  log2,
  max,
  step,
  Loop,
  If,
  Break,
  Var,
  Let,
  f32T,
  vec4fT,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms, screenCoords } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'
const U = fullscreenUniforms({ zoom: f32T, mouse: vec4fT })

// Iridescent cosine palette: 0.5 + 0.5·cos(2π(t + phase)).
const palette = fn('palette', { t: f32T }, ({ t }) => {
  const ph = vec3(0.0, 0.33, 0.67)
  return vec3(0.5).add(cos(t.add(ph).mul(6.283)).mul(0.5))
})

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const res = U.field.resolution
    const p = screenCoords(vo.uv, res)
    // breathing zoom into the seahorse valley (−0.7453 + 0.1127i)
    const s = Let(
      exp(U.field.zoom.add(sin(U.field.time.mul(0.2)).mul(0.75).add(0.75)).neg()).mul(2.4),
    )
    // pointer pans the view: the pointer maps into the same isotropic space as
    // p and offsets the centre, scaled by the current zoom. mu.w = 0 (never
    // touched) keeps the canonical seahorse-valley framing.
    const mu = U.field.mouse
    const pan = Let(
      screenCoords(vec2(mu.x.div(res.x), mu.y.div(res.y)), res)
        .mul(s)
        .mul(mu.w),
    )
    const c = vec2(p.x.mul(s).sub(0.7453).add(pan.x), p.y.mul(s).add(0.1127).add(pan.y))
    const z = Var(vec2(0, 0))
    const it = Var(f32(0))
    Loop(
      u32(0),
      (i) => i.lt(u32(120)),
      () => {
        If(dot(z, z).gt(16), () => {
          Break()
        }) // escaped
        z.assign(vec2(z.x.mul(z.x).sub(z.y.mul(z.y)).add(c.x), z.x.mul(z.y).mul(2).add(c.y)))
        it.assign(it.add(1))
      },
    )
    // smooth iteration count — subtract the fractional escape overshoot
    const m = Let(dot(z, z))
    const sn = it.sub(log2(max(log2(max(m, 1.0001)), 0.0001))).add(1)
    // interior (never escaped) stays black
    const inside = step(119.5, it)
    const col = palette({ t: sn.mul(0.035).add(U.field.time.mul(0.02)) }).mul(f32(1).sub(inside))
    return vec4(col, 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const mandelbrotModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const mandelbrot: ShaderExample = {
  id: 'mandelbrot',
  title: 'Mandelbrot set',
  blurb:
    'The Mandelbrot set with smooth escape-time colouring — log₂ log₂ |z|² removes the iteration banding — breathing in and out of the seahorse valley. Move the pointer to pan the view; the zoom slider sets how deep the breath goes (f32 bounds the floor).',
  category: 'generic',
  file: 'mandelbrot.ts',
  module: mandelbrotModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    zoom: { kind: 'slider', label: 'Zoom', min: 0, max: 4, step: 0.1, value: 1.5 },
    mouse: { kind: 'mouse' },
  },
}
