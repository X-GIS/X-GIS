// ═══ @xgis/shader-dsl example — raymarched box field (domain repetition) ═══
//
// One rounded-box SDF + floor-mod domain repetition = an infinite lattice of
// boxes, flown through forever. The step up from raymarch-sphere.ts: a reusable
// scene-SDF helper fn (called by the march AND six more times for the
// finite-difference normal), per-cell hashing for colour, and exponential fog.
// Domain repetition uses `mod` (#839) — the portable FLOOR-mod; WGSL `%` is
// trunc-mod and GLSL `%` is integer-only, so both would break on negatives.
// WGSL (WebGPU) + GLSL ES 3.00 (WebGL2).

import {
  fn,
  module,
  u32,
  f32,
  vec3,
  vec4,
  sin,
  cos,
  floor,
  fract,
  dot,
  max,
  mix,
  abs,
  exp,
  mod,
  normalize,
  length,
  Loop,
  If,
  Break,
  Let,
  f32T,
  vec3fT,
  vec4fT,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms, screenCoords } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'
const U = fullscreenUniforms({ speed: f32T, mouse: vec4fT })

// scene SDF: a rounded box repeated every 2.6 units in all three axes —
// mod's floor-mod keeps WGSL and GLSL agreeing on negative coordinates.
const scene = fn('scene', { p: vec3fT }, ({ p }) => {
  const q = Let(mod(p, 2.6).sub(vec3(1.3)))
  const b = abs(q).sub(vec3(0.62))
  return length(max(b, vec3(0, 0, 0))).sub(0.14)
})

const palette = fn('palette', { t: f32T }, ({ t }) => {
  const ph = vec3(0.0, 0.33, 0.67)
  return vec3(0.5).add(cos(t.add(ph).mul(6.283)).mul(0.5))
})

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const time = U.field.time
    const res = U.field.resolution
    const ndc = screenCoords(vo.uv, res)
    // camera: weaving gently down the corridor BETWEEN the boxes. Boxes are
    // centred at 1.3 + 2.6k per axis and reach ±0.76, so the free corridor is
    // ±0.54 around the axis — a ±0.4 wobble never enters a box.
    const ro = Let(
      vec3(
        sin(time.mul(0.23)).mul(0.4),
        cos(time.mul(0.2)).mul(0.4),
        time.mul(U.field.speed).neg(),
      ),
    )
    const rd0 = Let(normalize(vec3(ndc.x, ndc.y, f32(1.6).neg())))
    // pointer looks around: yaw (about y) from pointer x, pitch (about x) from
    // pointer y. m.w = 0 (never touched) makes both angles exactly 0, so gates
    // and thumbnails see the straight-down-the-corridor view.
    const m = U.field.mouse
    const yaw = Let(m.x.div(res.x).sub(0.5).mul(1.6).mul(m.w))
    const pit = Let(m.y.div(res.y).sub(0.5).mul(m.w))
    const cy = Let(cos(yaw))
    const sy = Let(sin(yaw))
    const cp = Let(cos(pit))
    const sp = Let(sin(pit))
    // rotY(yaw) then rotX(pitch)
    const rx = Let(rd0.x.mul(cy).add(rd0.z.mul(sy)))
    const rz1 = Let(rd0.z.mul(cy).sub(rd0.x.mul(sy)))
    const ry = Let(rd0.y.mul(cp).sub(rz1.mul(sp)))
    const rz = Let(rz1.mul(cp).add(rd0.y.mul(sp)))
    const rd = Let(vec3(rx, ry, rz))
    const t = f32(0)
    const hit = f32(0)
    Loop(
      u32(0),
      (i) => i.lt(u32(90)),
      () => {
        const p = ro.add(rd.mul(t))
        const d = Let(scene({ p }))
        If(d.lt(0.002), () => {
          hit.assign(1)
          Break()
        })
        t.assign(t.add(d.mul(0.9)))
        If(t.gt(30), () => {
          Break()
        })
      },
    )
    const bg = Let(vec3(0.04, 0.05, 0.09).add(vec3(0.02, 0.04, 0.08).mul(vo.uv.y)))
    const col = bg.add(vec3(0, 0, 0))
    If(hit.gt(0.5), () => {
      const p = Let(ro.add(rd.mul(t)))
      // finite-difference normal — six more SDF taps through the helper
      const e = 0.0015
      const n = Let(
        normalize(
          vec3(
            scene({ p: p.add(vec3(e, 0, 0)) }).sub(scene({ p: p.sub(vec3(e, 0, 0)) })),
            scene({ p: p.add(vec3(0, e, 0)) }).sub(scene({ p: p.sub(vec3(0, e, 0)) })),
            scene({ p: p.add(vec3(0, 0, e)) }).sub(scene({ p: p.sub(vec3(0, 0, e)) })),
          ),
        ),
      )
      const ld = normalize(vec3(0.5, 0.8, 0.3))
      const diff = max(dot(n, ld), 0)
      // per-cell tint from the cell id
      const id = floor(p.div(2.6))
      const hcell = fract(
        sin(id.x.mul(12.9898).add(id.y.mul(78.233)).add(id.z.mul(37.719))).mul(43758.5453),
      )
      const surf = palette({ t: hcell }).mul(diff.mul(0.8).add(0.16))
      const fog = exp(t.mul(0.09).neg())
      col.assign(mix(bg, surf, fog))
    })
    return vec4(col, 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const boxesModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const raymarchBoxes: ShaderExample = {
  id: 'raymarch-boxes',
  title: 'Raymarched box field',
  blurb:
    'Domain repetition — one rounded-box SDF floor-modded into an infinite lattice, flown through forever. Move the pointer to look around the corridor; a reusable scene() helper serves the march and the six-tap normal. Fly speed is live.',
  category: 'generic',
  file: 'raymarch-boxes.ts',
  module: boxesModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    speed: { kind: 'slider', label: 'Fly speed', min: 0, max: 3, step: 0.1, value: 1.4 },
    mouse: { kind: 'mouse' },
  },
}
