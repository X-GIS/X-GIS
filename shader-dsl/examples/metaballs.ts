// ═══ @xgis/shader-dsl example — metaballs (implicit blob field) ═══
//
// The classic 2D metaballs: each ball contributes an inverse-square field
// w = k/d², the fields SUM, and the iso-contour of the summed field is the
// blobby silhouette that merges and splits as the balls orbit. Colour is the
// field-weighted blob index through a cosine palette, so blobs keep their hue
// while blending where they touch. Showcases a Loop accumulator over a
// uniform-driven ball count. WGSL (WebGPU) + GLSL ES 3.00 (WebGL2).

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
  cos,
  dot,
  max,
  mix,
  smoothstep,
  Loop,
  Var,
  Let,
  f32T,
  vec4fT,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms, screenCoords } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'
const U = fullscreenUniforms({ count: f32T, mouse: vec4fT })

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
    // once the pointer has entered (m.w = 1), ball 0 leaves its orbit and
    // follows the cursor — mapped to the same isotropic space as p
    const m = U.field.mouse
    const cursor = Let(screenCoords(vec2(m.x.div(res.x), m.y.div(res.y)), res))
    // sum the inverse-square fields; hue accumulates field-weighted so merged
    // blobs blend their colours in proportion to who dominates the pixel
    const field = Var(f32(0))
    const hue = Var(f32(0))
    Loop(
      u32(0),
      (i) => toF32(i).lt(U.field.count),
      (i) => {
        const fi = toF32(i)
        const orbit = vec2(
          sin(t.mul(fi.mul(0.13).add(0.5)).add(fi.mul(2.4))).mul(0.55),
          cos(t.mul(fi.mul(0.11).add(0.4)).add(fi.mul(1.7))).mul(0.42),
        )
        // ball 0 → cursor when interacted: step(fi, 0.5) selects i == 0
        const follow = f32(1)
          .sub(smoothstep(0.4, 0.6, fi))
          .mul(m.w)
        const ctr = mix(orbit, cursor, follow)
        const d = Let(p.sub(ctr))
        const w = Let(f32(0.055).div(dot(d, d).add(0.003)))
        field.assign(field.add(w))
        hue.assign(hue.add(w.mul(fi)))
      },
    )
    // iso-contour of the summed field = the blob silhouette
    const iso = smoothstep(0.95, 1.15, field)
    const blob = palette({ t: hue.div(max(field, 0.0001)).mul(0.15).add(t.mul(0.03)) })
    // outside: dark bg lit by a faint field glow; inside: the full blob colour
    const bg = vec3(0.03, 0.04, 0.08).add(blob.mul(field.mul(0.08)))
    return vec4(mix(bg, blob, iso), 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const metaballsModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const metaballs: ShaderExample = {
  id: 'metaballs',
  title: 'Metaballs',
  blurb:
    'Implicit blobs — each ball adds an inverse-square field, the fields sum, and the iso-contour merges and splits as they orbit. Move the pointer and one ball follows it into the swarm. Ball count is live.',
  category: 'generic',
  file: 'metaballs.ts',
  module: metaballsModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    count: { kind: 'slider', label: 'Balls', min: 2, max: 6, step: 1, value: 5 },
    mouse: { kind: 'mouse' },
  },
}
