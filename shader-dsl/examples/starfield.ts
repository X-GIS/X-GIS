// ═══ @xgis/shader-dsl example — starfield (hash grid, parallax layers) ═══
//
// The classic star field without a single texture: three grid layers, each
// cell hashing whether it holds a star, where inside the cell it sits, how it
// twinkles — nearer layers drift faster for parallax. A faint diagonal band
// stands in for the Milky Way. Showcases procedural hashing as a data source
// (the same lattice-hash the noise examples build on, used directly).
// WGSL (WebGPU) + GLSL ES 3.00 (WebGL2).

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
  exp,
  step,
  distance,
  smoothstep,
  Loop,
  Var,
  Let,
  f32T,
  vec2fT,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'
const U = fullscreenUniforms({ density: f32T })

// scalar hash of a lattice point → [0,1)
const hash = fn('hash', { p: vec2fT }, ({ p }) =>
  fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)),
)

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const t = U.field.time
    const res = U.field.resolution
    const asp = res.x.div(res.y)
    const p = vec2(vo.uv.x.mul(2).sub(1).mul(asp), vo.uv.y.mul(2).sub(1))
    const col = Var(vec3(0, 0, 0))
    // three parallax layers — nearer (coarser) layers drift faster
    Loop(
      u32(0),
      (i) => i.lt(u32(3)),
      (i) => {
        const fi = toF32(i)
        const scale = fi.mul(14).add(18)
        const drift = fi.mul(0.014).add(0.01)
        const q = vec2(p.x.add(t.mul(drift)), p.y)
          .mul(scale)
          .add(fi.mul(37.7))
        const cell = Let(floor(q))
        const f = fract(q)
        const h = Let(hash({ p: cell }))
        // does this cell hold a star? density raises the hash gate
        const gate = step(f32(0.92).sub(U.field.density.mul(0.25)), h)
        // star position inside the cell (kept off the cell edges)
        const sp = vec2(
          hash({ p: cell.add(vec2(12.3, 45.6)) }),
          hash({ p: cell.add(vec2(78.9, 1.2)) }),
        )
          .mul(0.7)
          .add(0.15)
        const d = distance(f, sp)
        const rad = f32(0.06).sub(fi.mul(0.012)) // far layers are smaller
        const core = Let(f32(1).sub(smoothstep(0, rad, d)))
        const twinkle = sin(t.mul(h.mul(4).add(2)).add(h.mul(40)))
          .mul(0.4)
          .add(0.6)
        const b = core
          .mul(core)
          .mul(twinkle)
          .mul(gate)
          .mul(f32(1).sub(fi.mul(0.25)))
        // colour temperature from the hash: blue-white ↔ warm
        const tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), h)
        col.assign(col.add(tint.mul(b)))
      },
    )
    // a faint diagonal Milky-Way band
    const s = Let(p.y.add(p.x.mul(0.35)))
    const band = exp(s.mul(s).mul(6).neg())
    return vec4(col.add(vec3(0.09, 0.11, 0.16).mul(band)), 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const starfieldModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const starfield: ShaderExample = {
  id: 'starfield',
  title: 'Starfield',
  blurb:
    'A textureless night sky — three hash-grid layers decide per cell whether a star exists, where it sits, and how it twinkles; nearer layers drift faster for parallax. Density is live.',
  category: 'generic',
  file: 'starfield.ts',
  module: starfieldModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    density: { kind: 'slider', label: 'Density', min: 0, max: 1, step: 0.05, value: 0.5 },
  },
}
